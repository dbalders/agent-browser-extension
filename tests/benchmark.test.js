import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBenchmarkFixture } from '../scripts/benchmark-fixture.mjs';
import { parseBenchmarkArgs, runBenchmarkServer } from '../scripts/benchmark-serve.mjs';

const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function fixture(options) { const server = await startBenchmarkFixture(options); servers.push(server); return server; }
const driver = { kind: 'automated-driver', label: 'fixture unit tests', toolSurface: 'direct fixture HTTP' };
function configFrom(html) { return JSON.parse(html.match(/<script type="application\/json" id="benchmark-config">([\s\S]*?)<\/script>/)[1]); }
async function documentFor(run, type, view = '') { const task = run.tasks.find(item => item.type === type); const response = await fetch(`${task.url}${view ? `/${view}` : ''}`); expect(response.status).toBe(200); const html = await response.text(); return { ...configFrom(html), html, task }; }
async function action(server, document, action, values = {}, headers = {}) {
  const response = await fetch(document.actionUrl, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ clientId: document.clientId, action, ...values }) });
  return { status: response.status, body: await response.json() };
}
const resultTask = (server, run, type) => server.getResults(run.runId).tasks.find(task => task.type === type);
async function readyState(document) {
  const deadline = Date.now() + 2000;
  do { const result = await (await fetch(document.stateUrl)).json(); if (result.phase === 'ready') return result; await new Promise(resolve => setTimeout(resolve, 15)); } while (Date.now() < deadline);
  throw new Error('Fixture calculation did not become ready');
}

describe('provider-neutral browser benchmark fixture', () => {
  it('creates independent ephemeral task runs with explicit provenance and no unrun parity score', async () => {
    const server = await fixture(); const one = server.createRun({ runner: driver }); const two = server.createRun({ runner: { kind: 'actual-agent', provider: 'example-provider', model: 'example-model', toolSurface: 'browser tools' } });
    expect(one.runId).not.toBe(two.runId); expect(one.tasks).toHaveLength(6);
    expect(one.tasks.every(task => !two.tasks.some(other => other.taskId === task.taskId))).toBe(true);
    expect(one.prompt).toContain('Do not call fixture action endpoints directly'); expect(one.prompt).toContain('take a screenshot');
    const result = server.getResults(two.runId);
    expect(result.runner).toMatchObject({ kind: 'actual-agent', provider: 'example-provider', model: 'example-model', declaredByOperator: true });
    expect(result.results).toEqual({ passed: 0, total: 6, allPassed: false });
    expect(result.comparison).toEqual({ codexBaseline: 'not-run', parityScore: null });
    expect(result.unverified.join(' ')).toContain('ownership');
    expect(() => server.getTestOracle(two.runId)).toThrow(expect.objectContaining({ code: 'ORACLE_NOT_ALLOWED' }));
    server.getTestOracle(one.runId); expect(server.getResults(one.runId).oracleUsed).toBe(true);
    expect(server.getResults(two.runId).oracleUsed).toBe(false);
  });

  it('verifies all six tasks from actual application state transitions', async () => {
    const server = await fixture(); const run = server.createRun({ runner: driver }); const answers = server.getTestOracle(run.runId);
    const form = await documentFor(run, 'form'); const frame = await documentFor(run, 'form', 'frame');
    expect(form.html).toContain('attachShadow'); expect(form.html).toContain('Embedded access form');
    expect((await action(server, form, 'form.save', { displayName: answers.form.displayName, color: answers.form.color })).body.accepted).toBe(true);
    expect(resultTask(server, run, 'form').status).toBe('pending');
    await action(server, frame, 'form.frame', { accessCode: answers.form.accessCode });
    expect(resultTask(server, run, 'form').status).toBe('passed');

    const ambiguous = await documentFor(run, 'ambiguity');
    expect(ambiguous.html.match(/>Save row</g)).toHaveLength(3);
    await action(server, ambiguous, 'row.save', { row: 'maple' });

    const initial = await documentFor(run, 'dynamic');
    expect((await action(server, initial, 'dynamic.confirm', { token: initial.token })).status).toBe(409);
    const advanced = await action(server, initial, 'dynamic.refresh');
    const replacement = configFrom(await (await fetch(advanced.body.nextUrl)).text());
    expect(replacement.token).not.toBe(initial.token);
    expect((await action(server, initial, 'dynamic.confirm', { token: initial.token })).body.code).toBe('STALE_RECORD');
    await action(server, replacement, 'dynamic.confirm', { token: replacement.token });

    const visual = await documentFor(run, 'visual');
    const image = await fetch(`${visual.task.url}/image.png`); const png = Buffer.from(await image.arrayBuffer());
    expect(image.headers.get('content-type')).toBe('image/png'); expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(560); expect(png.readUInt32BE(20)).toBe(240);
    expect(visual.html).not.toContain(`CODE ${answers.visual.code}`); expect(visual.html).not.toContain(`"code":"${answers.visual.code}"`);
    await action(server, visual, 'visual.pick', answers.visual.point);
    await action(server, visual, 'visual.submit', { code: answers.visual.code });

    const producer = await documentFor(run, 'tabs', 'producer'); const consumer = await documentFor(run, 'tabs', 'consumer');
    expect(producer.clientId).not.toBe(consumer.clientId);
    expect((await action(server, consumer, 'tabs.ack', { revision: 'not-published' })).status).toBe(409);
    await action(server, producer, 'tabs.publish', { message: answers.tabs.message });
    const message = await (await fetch(consumer.stateUrl)).json();
    expect(message.message).toBe(answers.tabs.message);
    await action(server, consumer, 'tabs.ack', { revision: message.revision });

    const waiting = await documentFor(run, 'wait');
    await action(server, waiting, 'wait.start');
    expect((await action(server, waiting, 'wait.submit', { total: answers.wait.total })).body.code).toBe('CALCULATION_NOT_READY');
    const ready = await readyState(waiting); await action(server, waiting, 'wait.submit', { total: ready.total });
    const results = await (await fetch(run.resultsUrl)).json();
    expect(results.results).toEqual({ passed: 6, total: 6, allPassed: true });
    expect(results.events.some(event => event.accepted === false && event.reason === 'STALE_RECORD')).toBe(true);
    expect(results.oracleUsed).toBe(true); expect(results.runner.kind).toBe('automated-driver');
  });

  it('rejects claimed success, unknown fields and forged document identity without changing verified state', async () => {
    const server = await fixture(); const run = server.createRun({ runner: driver }); const answers = server.getTestOracle(run.runId);
    const row = await documentFor(run, 'ambiguity');
    expect((await action(server, row, 'row.save', { row: 'maple', passed: true })).status).toBe(400);
    expect(resultTask(server, run, 'ambiguity')).toMatchObject({ status: 'pending', observed: { savedRows: { orchid: 0, maple: 0, cedar: 0 } } });
    const response = await fetch(run.resultsUrl, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ passed: 6, allPassed: true }) });
    expect(response.status).toBe(404);
    const form = await documentFor(run, 'form');
    expect((await action(server, form, 'form.save', { displayName: answers.form.displayName, color: 42 })).status).toBe(400);
    expect(resultTask(server, run, 'form').observed).toEqual({ nameMatches: false, colorMatches: false, frameMatches: false });
    expect((await action(server, { ...row, clientId: 'forged' }, 'row.save', { row: 'maple' })).status).toBe(403);
    expect(server.getResults(run.runId).results.passed).toBe(0);
  });

  it('enforces run/document separation and preserves incorrect-row evidence when a run is reset', async () => {
    const server = await fixture(); const one = server.createRun({ runner: driver }); const two = server.createRun({ runner: driver });
    const first = await documentFor(one, 'ambiguity'); const second = await documentFor(two, 'ambiguity');
    expect((await action(server, { ...second, clientId: first.clientId }, 'row.save', { row: 'maple' })).status).toBe(403);
    await action(server, first, 'row.save', { row: 'orchid' }); await action(server, first, 'row.save', { row: 'maple' });
    expect(resultTask(server, one, 'ambiguity').status).toBe('failed');
    expect(resultTask(server, two, 'ambiguity').status).toBe('pending');
    const producer = await documentFor(one, 'tabs', 'producer');
    expect((await action(server, producer, 'tabs.ack', { revision: 'anything' })).status).toBe(400);
    expect(server.getResults(two.runId).results).toEqual({ passed: 0, total: 6, allPassed: false });
  });

  it('rejects cross-origin or non-JSON writes and malformed/oversized bodies', async () => {
    const server = await fixture(); const run = server.createRun({ runner: driver }); const row = await documentFor(run, 'ambiguity');
    expect((await action(server, row, 'row.save', { row: 'maple' }, { Origin: 'https://hostile.test' })).status).toBe(403);
    expect((await action(server, row, 'row.save', { row: 'maple' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await action(server, row, 'row.save', { row: 'maple' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    const noOrigin = await fetch(row.actionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); expect(noOrigin.status).toBe(403);
    const invalid = await fetch(row.actionUrl, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: '{' }); expect(invalid.status).toBe(400);
    const large = await fetch(row.actionUrl, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: 'x'.repeat(4097) }) }); expect(large.status).toBe(413);
    const get = await fetch(run.resultsUrl, { headers: { Origin: 'https://hostile.test' } }); expect(get.headers.get('access-control-allow-origin')).toBeNull();
    expect(server.getResults(run.runId).results.passed).toBe(0);
  });

  it('keeps raw submitted values, secrets and visual answers out of result evidence', async () => {
    const server = await fixture(); const run = server.createRun({ runner: driver }); const row = await documentFor(run, 'ambiguity'); const producer = await documentFor(run, 'tabs', 'producer');
    await action(server, row, 'TOKEN-SECRET-ACTION');
    await action(server, producer, 'tabs.publish', { message: 'PRIVATE-SUBMITTED-VALUE' });
    const answers = server.getTestOracle(run.runId);
    const results = JSON.stringify(server.getResults(run.runId));
    expect(results).not.toMatch(/TOKEN-SECRET-ACTION|PRIVATE-SUBMITTED-VALUE/);
    expect(results).not.toContain(`"code":"${answers.visual.code}"`);
    expect(results).not.toContain('clientId'); expect(results).not.toContain('token');
  });

  it('does not allow submitting a shape name instead of image coordinates or accepting an empty visual answer', async () => {
    const server = await fixture(); const run = server.createRun({ runner: driver }); const visual = await documentFor(run, 'visual');
    expect((await action(server, visual, 'visual.pick', { shape: 'circle', x: 220, y: 154 })).status).toBe(400);
    expect((await action(server, visual, 'visual.pick', { x: -1, y: 154 })).status).toBe(400);
    expect((await action(server, visual, 'visual.submit', { code: '' })).status).toBe(400);
    await action(server, visual, 'visual.pick', { x: 10, y: 10 });
    expect(resultTask(server, run, 'visual')).toMatchObject({ status: 'pending', observed: { shapeMatches: false } });
  });

  it('bounds event evidence and expires or closes runs without preserving private state', async () => {
    const server = await fixture({ maxRuns: 1 }); const run = server.createRun({ runner: driver });
    expect(() => server.createRun()).toThrow(expect.objectContaining({ code: 'RUN_LIMIT' }));
    const row = await documentFor(run, 'ambiguity');
    for (let index = 0; index < 205; index++) await action(server, row, 'row.save', { row: 'maple' });
    const result = server.getResults(run.runId);
    expect(result.events).toHaveLength(200); expect(result.eventsDropped).toBe(5); expect(result.events[0].sequence).toBe(6);
    server.closeRun(run.runId); expect(() => server.getResults(run.runId)).toThrow(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    expect(server.createRun().runId).not.toBe(run.runId);
    const short = await fixture({ ttlMs: 100 }); const expired = short.createRun(); await new Promise(resolve => setTimeout(resolve, 110));
    expect(() => short.getResults(expired.runId)).toThrow(expect.objectContaining({ code: 'RUN_EXPIRED' }));
  });

  it('validates runner identities, server options, and CLI arguments', async () => {
    const server = await fixture();
    for (const runner of [{ kind: 'actual-agent' }, { kind: 'pretend-success' }, { kind: 'automated-driver', secret: 'not-allowed' }, { kind: 'actual-agent', provider: 'p', model: 'x'.repeat(121) }]) expect(() => server.createRun({ runner })).toThrow(expect.objectContaining({ code: 'INVALID_RUNNER' }));
    await expect(startBenchmarkFixture({ port: -1 })).rejects.toThrow('Invalid benchmark server limits');
    await expect(startBenchmarkFixture({ ttlMs: 99 })).rejects.toThrow('Invalid benchmark server limits');
    expect(parseBenchmarkArgs(['--runner-kind', 'actual-agent', '--provider', 'example', '--model', 'test', '--port', '0'])).toEqual({ port: 0, runner: { kind: 'actual-agent', provider: 'example', model: 'test' } });
    expect(() => parseBenchmarkArgs(['--port', 'no'])).toThrow('--port'); expect(() => parseBenchmarkArgs(['--unknown', 'value'])).toThrow('Unknown option'); expect(() => parseBenchmarkArgs(['--provider'])).toThrow('missing value');
  });

  it('writes CLI manifest, common prompt and final observed results and removes shutdown listeners', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-browser-benchmark-cli-test-'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const listeners = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    let running;
    try {
      running = await runBenchmarkServer(['--output-dir', outputDir, '--runner-kind', 'automated-driver', '--label', 'CLI lifecycle test']);
      const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
      expect(manifest.runId).toBe(running.run.runId);
      expect(await readFile(join(outputDir, 'prompt.txt'), 'utf8')).toBe(`${manifest.prompt}\n`);
      expect(stdout.mock.calls.map(call => call[0]).join('')).toContain(running.run.url);
      const row = await documentFor(running.run, 'ambiguity');
      await action(running.fixture, row, 'row.save', { row: 'maple' });
      await running.close();
      const result = JSON.parse(await readFile(join(outputDir, 'results.json'), 'utf8'));
      expect(result.results.passed).toBe(1); expect(result.runner.kind).toBe('automated-driver');
      expect(process.listenerCount('SIGINT')).toBe(listeners.SIGINT); expect(process.listenerCount('SIGTERM')).toBe(listeners.SIGTERM);
      await expect(fetch(running.run.resultsUrl)).rejects.toThrow();
    } finally {
      await running?.close(); stdout.mockRestore(); await rm(outputDir, { recursive: true, force: true });
    }
  });
});
