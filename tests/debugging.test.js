import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { PageDebugging, createTimeline, snapshotPerformance, sanitizeProfile, inspectTarget, INSPECT_PROPERTIES } from '../extension/debugging.js';
import { PageAdapter } from '../extension/pages.js';

afterEach(() => vi.useRealTimers());
const scope = (tabId = 1, frameId = 'main', sessionId) => ({ frameId, target: { tabId, ...(sessionId ? { sessionId } : {}) } });
const credentialUrl = value => { const url = new URL(value); url.username = 'user'; url.password = 'password'; return url.href; };
const sampleProfile = () => ({ startTime: 1000, endTime: 5000, nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] }, { id: 2, hitCount: 3, callFrame: { functionName: 'work界', scriptId: '5', url: credentialUrl('https://example.test/work.js?access_token=SECRET#private'), lineNumber: 3, columnNumber: 2 } }], samples: [2, 2, 2], timeDeltas: [1000, 1000, 1000] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const calls = []; const objects = new Map(); const observers = []; let clock = 0; let profile = sampleProfile(); let nextObject = 0;
  class Observer {
    static supportedEntryTypes = ['longtask', 'resource', 'mark', 'measure', 'paint', 'layout-shift'];
    constructor(callback) { this.callback = callback; this.pending = []; this.connected = true; observers.push(this); }
    observe(options) { this.options = options; }
    takeRecords() { return this.pending.splice(0); }
    disconnect() { this.connected = false; }
    emit(entries) { if (this.connected) this.callback({ getEntries: () => entries }); }
  }
  const performance = { now: () => clock, timeOrigin: 100000, getEntries: () => [] };
  const environment = { PerformanceObserver: Observer, performance, URL, setTimeout, clearTimeout };
  const sendCommand = vi.fn(async (target, method, params = {}) => {
    calls.push({ target, method, params });
    if (method === 'Profiler.stop') return { profile };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: target.tabId * 10 };
    if (method === 'Runtime.evaluate') {
      try {
        const result = runInNewContext(params.expression, environment);
        if (params.returnByValue) return { result: { value: result } };
        const objectId = `timeline-${++nextObject}`; objects.set(objectId, result); return { result: { objectId } };
      } catch (error) { return { exceptionDetails: { text: error.message } }; }
    }
    if (method === 'Runtime.callFunctionOn') {
      const result = runInNewContext(`(${params.functionDeclaration}).call(object)`, { object: objects.get(params.objectId) });
      return { result: { value: result } };
    }
    if (method === 'Runtime.releaseObject') { objects.delete(params.objectId); return {}; }
    if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Nodes', value: 24 }, { name: 'JSHeapUsedSize', value: 2048 }, { name: 'Unknown', value: 5 }, { name: 'TaskDuration', value: Infinity }] };
    return {};
  });
  const adapter = { chrome: { debugger: { sendCommand } }, rawSend: sendCommand, send: (tabId, method, params) => sendCommand({ tabId }, method, params) };
  const debugging = new PageDebugging(adapter);
  return { debugging, adapter, calls, sendCommand, observers, objects, performance, environment, clock(value) { clock = value; }, setProfile(value) { profile = value; } };
}

async function artifact(debugging, tabId, kind, id, length = 11) {
  let offset = 0; let result = '';
  while (true) {
    const args = { action: 'read', [kind === 'profile' ? 'profileId' : 'traceId']: id, offset, length };
    const part = kind === 'profile' ? await debugging.profile(tabId, args) : await debugging.performance(tabId, args);
    expect(part.scope).toContain(kind === 'profile' ? 'isolate' : 'Selected document');
    expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(120000);
    result += part.chunk; offset = part.nextOffset;
    if (part.done) return JSON.parse(result);
  }
}

describe('bounded renderer CPU profiling', () => {
  it('reports unsupported extension Profiler access without inventing a capture or using another transport', async () => {
    const f = fixture(); const original = f.sendCommand.getMockImplementation();
    f.sendCommand.mockImplementation((target, method, params) => {
      if (method === 'Profiler.enable') return Promise.reject(new Error(JSON.stringify({ code: -32601, message: "'Profiler.enable' wasn't found" })));
      return original(target, method, params);
    });
    expect(await f.debugging.profile(1, { action: 'status' })).toMatchObject({ state: 'idle', supported: null });
    await expect(f.debugging.profile(1, { action: 'start' })).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE', message: expect.stringContaining('browser_performance') });
    expect(await f.debugging.profile(1, { action: 'status' })).toMatchObject({ state: 'error', supported: false, error: { code: 'PROFILE_UNAVAILABLE' }, scope: expect.stringContaining('isolate') });
    expect(f.sendCommand.mock.calls.map(([, method]) => method)).toEqual(['Profiler.enable']);
    expect(f.debugging.artifacts.size).toBe(0);
    expect(await f.debugging.profile(1, { action: 'clear' })).toMatchObject({ cleared: true, supported: false });
    expect(await f.debugging.performance(1, { action: 'snapshot' }, scope())).toMatchObject({ timeline: { entries: [] } });
  });
  it('records, sanitizes and exports a reconstructable cpuprofile without using browser-global Tracing', async () => {
    const f = fixture(); const started = await f.debugging.profile(1, { action: 'start', durationMs: 500, samplingIntervalUs: 2000 });
    expect(started).toMatchObject({ state: 'recording', supported: true, scope: expect.stringContaining('isolate') });
    expect(f.calls.map(call => call.method)).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
    expect(f.calls[1].params).toEqual({ interval: 2000 });
    const stopped = await f.debugging.profile(1, { action: 'stop' });
    expect(stopped).toMatchObject({ state: 'stopped', format: 'cpuprofile', summary: { nodes: 2, samples: 3, durationMs: 4 } });
    const profile = await artifact(f.debugging, 1, 'profile', stopped.profileId);
    expect(profile.nodes[1].callFrame).toMatchObject({ functionName: 'work界', url: 'https://example.test/work.js' });
    expect(profile.samples).toEqual([2, 2, 2]); expect(profile.timeDeltas).toEqual([1000, 1000, 1000]);
    expect(JSON.stringify(profile)).not.toMatch(/SECRET|password|access_token|private/);
    expect(f.calls.at(-1).method).toBe('Profiler.disable');
    expect(f.calls.every(call => call.target.tabId === 1 && !call.method.startsWith('Tracing.'))).toBe(true);
    expect((await f.debugging.profile(1, { action: 'stop' })).profileId).toBe(stopped.profileId);
  });

  it('automatically stops at the requested deadline and isolates concurrent owned tabs', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.debugging.profile(1, { action: 'start', durationMs: 100 }); await f.debugging.profile(2, { action: 'start', durationMs: 500 });
    await expect(f.debugging.profile(1, { action: 'start' })).rejects.toMatchObject({ code: 'PROFILE_BUSY' });
    await vi.advanceTimersByTimeAsync(100);
    expect(await f.debugging.profile(1, { action: 'status' })).toMatchObject({ state: 'stopped', profileId: expect.any(String) });
    expect(await f.debugging.profile(2, { action: 'status' })).toMatchObject({ state: 'recording' });
    await f.debugging.dispose(2); expect(f.calls.some(call => call.target.tabId === 2 && call.method === 'Profiler.stop')).toBe(true);
    expect(await f.debugging.profile(2, { action: 'status' })).toMatchObject({ state: 'idle' });
  });

  it('rejects malformed and action-inappropriate arguments before issuing commands', async () => {
    const f = fixture();
    for (const args of [null, [], { action: 'trace' }, { action: 'start', frameId: 'child' }, { action: 'start', durationMs: 99 }, { action: 'start', durationMs: 30001 }, { action: 'start', samplingIntervalUs: 0 }, { action: 'start', samplingIntervalUs: 10001 }, { action: 'start', samplingIntervalUs: 1.5 }, { action: 'stop', durationMs: 100 }, { action: 'read' }, { action: 'read', profileId: '../file' }, { action: 'read', profileId: 'cpu-1', offset: -1 }, { action: 'read', profileId: 'cpu-1', length: 12001 }, { action: 'status', profileId: 'cpu-1' }, { action: 'status', tabId: 2 }]) await expect(f.debugging.profile(1, args)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.calls).toEqual([]);
  });

  it('never returns another tab artifact and clears retained data and active resources', async () => {
    const f = fixture(); await f.debugging.profile(1, { action: 'start' }); const stopped = await f.debugging.profile(1, { action: 'stop' });
    await expect(f.debugging.profile(2, { action: 'read', profileId: stopped.profileId })).rejects.toMatchObject({ code: 'DEBUGGING_ARTIFACT_NOT_FOUND' });
    await expect(f.debugging.profile(1, { action: 'read', profileId: stopped.profileId, offset: stopped.totalLength + 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await f.debugging.profile(1, { action: 'clear' })).toMatchObject({ cleared: true, scope: expect.stringContaining('isolate') });
    await expect(f.debugging.profile(1, { action: 'read', profileId: stopped.profileId })).rejects.toMatchObject({ code: 'DEBUGGING_ARTIFACT_NOT_FOUND' });
    await f.debugging.profile(1, { action: 'start' }); await f.debugging.dispose(1);
    expect(f.debugging.profiles.size).toBe(0); expect(f.debugging.artifacts.size).toBe(0);
  });

  it('disables profiling after a stop failure and bounds cleanup even if Chrome hangs', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.debugging.profile(1, { action: 'start' });
    const original = f.sendCommand.getMockImplementation();
    f.sendCommand.mockImplementation((target, method, params) => method === 'Profiler.stop' ? new Promise(() => {}) : original(target, method, params));
    const disposing = f.debugging.dispose(1); await vi.advanceTimersByTimeAsync(2000); await disposing;
    expect(f.debugging.profiles.size).toBe(0); expect(f.debugging.artifacts.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls.some(call => call.method === 'Profiler.disable')).toBe(true);
  });

  it('cancels an in-flight start before it can install a leaked profiler after release', async () => {
    const f = fixture(); let resolveEnable;
    const original = f.sendCommand.getMockImplementation();
    f.sendCommand.mockImplementation((target, method, params) => method === 'Profiler.enable' ? new Promise(resolve => { resolveEnable = resolve; }) : original(target, method, params));
    const starting = f.debugging.profile(1, { action: 'start' }).catch(error => error);
    const disposing = f.debugging.dispose(1); resolveEnable({}); await disposing;
    expect(await starting).toMatchObject({ code: 'DEBUGGING_CANCELLED' });
    expect(f.calls.some(call => call.method === 'Profiler.start')).toBe(false); expect(f.debugging.profiles.size).toBe(0);
  });

  it('invalidates captures and artifacts on main document navigation', async () => {
    const f = fixture(); await f.debugging.profile(1, { action: 'start' });
    f.debugging.event({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'replacement' } });
    await Promise.resolve(); await Promise.resolve();
    expect(await f.debugging.profile(1, { action: 'status' })).toMatchObject({ state: 'idle' });
    expect(f.debugging.artifacts.size).toBe(0);
  });

  it.each(['deadline', 'navigation', 'clear'])('waits for old profiler cleanup before a replacement capture after %s', async trigger => {
    vi.useFakeTimers(); const f = fixture(); const entered = deferred(); const release = deferred();
    await f.debugging.profile(1, { action: 'start', durationMs: 100 });
    const original = f.sendCommand.getMockImplementation(); let delayed = false;
    f.sendCommand.mockImplementation(async (target, method, params) => {
      if (target.tabId === 1 && method === 'Profiler.disable' && !delayed) { delayed = true; entered.resolve(); await release.promise; }
      return original(target, method, params);
    });
    let clearing;
    try {
      if (trigger === 'deadline') await vi.advanceTimersByTimeAsync(100);
      else if (trigger === 'navigation') f.debugging.event({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'next' } });
      else clearing = f.debugging.profile(1, { action: 'clear' });
      await entered.promise;
      const replacement = f.debugging.profile(1, { action: 'start' });
      await f.debugging.profile(2, { action: 'start' });
      expect(f.calls.filter(call => call.target.tabId === 1 && call.method === 'Profiler.start')).toHaveLength(1);
      release.resolve(); await clearing;
      expect(await replacement).toMatchObject({ state: 'recording' });
      const methods = f.calls.filter(call => call.target.tabId === 1).map(call => call.method);
      expect(methods.lastIndexOf('Profiler.disable')).toBeLessThan(methods.lastIndexOf('Profiler.start'));
      const stopped = await f.debugging.profile(1, { action: 'stop' });
      expect(await artifact(f.debugging, 1, 'profile', stopped.profileId, 12000)).toMatchObject({ samples: [2, 2, 2] });
    } finally { release.resolve(); await f.debugging.dispose(1); await f.debugging.dispose(2); }
  });

  it('rejects oversized or malformed profiles instead of exporting broken graphs', () => {
    for (const profile of [{}, { ...sampleProfile(), samples: [99], timeDeltas: [1] }, { ...sampleProfile(), samples: [2], timeDeltas: [] }, { ...sampleProfile(), nodes: [{ ...sampleProfile().nodes[0], children: [99] }] }, { ...sampleProfile(), endTime: -1 }]) expect(() => sanitizeProfile(profile)).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE' }));
    expect(() => sanitizeProfile({ ...sampleProfile(), samples: Array(60001).fill(2), timeDeltas: Array(60001).fill(1) })).toThrow(expect.objectContaining({ code: 'PROFILE_TOO_LARGE' }));
    const f = fixture();
    expect(() => f.debugging.artifact({ tabId: 1, id: 'cpu-big' }, 'profile', { payload: 'x'.repeat(2 * 1024 * 1024) }, {})).toThrow(expect.objectContaining({ code: 'DEBUGGING_STORAGE_LIMIT' }));
    expect(f.debugging.artifacts.size).toBe(0);
  });
  it('rejects cyclic, disconnected and multiply-parented CPU graphs', () => {
    const profile = sampleProfile();
    for (const nodes of [
      [{ ...profile.nodes[0], children: [1, 2] }, profile.nodes[1]],
      [{ ...profile.nodes[0], children: [] }, profile.nodes[1]],
      [{ ...profile.nodes[0], children: [2, 2] }, profile.nodes[1]],
      [...profile.nodes, { ...profile.nodes[1], id: 3, children: [4] }, { ...profile.nodes[1], id: 4, children: [3] }],
    ]) expect(() => sanitizeProfile({ ...profile, nodes })).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE' }));
    expect(sanitizeProfile({ ...profile, nodes: [...profile.nodes].reverse() }).nodes).toHaveLength(2);
  });
});

describe('document-scoped timeline traces and performance snapshots', () => {
  it('records an isolated selected frame and exports actual PerformanceObserver entries as Chrome Trace Event JSON', async () => {
    const f = fixture(); await f.debugging.performance(1, { action: 'start', durationMs: 1000 }, scope(1, 'child', 'child-session'));
    f.clock(50);
    f.observers[0].emit([{ entryType: 'measure', name: 'render work', startTime: 10, duration: 25, detail: { secret: 'DETAIL-SECRET' } }, { entryType: 'resource', name: credentialUrl('https://example.test/data?token=URL-SECRET#private'), startTime: 20, duration: 15, transferSize: 80, initiatorType: 'fetch' }, { entryType: 'layout-shift', name: '', startTime: 40, duration: 0, value: 0.1, hadRecentInput: false }]);
    const stopped = await f.debugging.performance(1, { action: 'stop' });
    expect(stopped).toMatchObject({ state: 'stopped', frameId: 'child', summary: { entries: 3, dropped: 0 } });
    const trace = await artifact(f.debugging, 1, 'trace', stopped.traceId, 12000);
    expect(trace.traceEvents.find(entry => entry.name === 'render work')).toMatchObject({ ph: 'X', ts: 10000, dur: 25000, cat: 'document.measure' });
    expect(trace.traceEvents.find(entry => entry.cat === 'document.layout-shift')).toMatchObject({ ph: 'i', s: 't', args: { value: 0.1 } });
    expect(JSON.stringify(trace)).not.toMatch(/DETAIL-SECRET|URL-SECRET|password|private/);
    expect(f.calls.every(call => call.target.sessionId === 'child-session' && !call.method.startsWith('Tracing.'))).toBe(true);
    expect(f.observers[0].connected).toBe(false); expect(f.objects.size).toBe(0);
  });

  it('bounds the observer ring, reports drops, ignores pre-start entries, and drains queued records on stop', () => {
    vi.useFakeTimers(); const f = fixture(); f.clock(100);
    const recorder = runInNewContext(`(${createTimeline.toString()})(1000)`, f.environment);
    f.observers[0].emit([{ entryType: 'mark', name: 'before', startTime: 99, duration: 0 }]);
    f.clock(200); f.observers[0].emit(Array.from({ length: 1100 }, (_, index) => ({ entryType: 'mark', name: `mark-${index}`, startTime: 101 + index / 100, duration: 0 })));
    f.observers[0].pending.push({ entryType: 'longtask', name: 'self', startTime: 150, duration: 60 });
    const result = recorder.stop(); expect(result.entries).toHaveLength(1000); expect(result.dropped).toBe(101);
    expect(result.entries.some(entry => entry.name === 'before')).toBe(false);
    expect(result.entries.some(entry => entry.entryType === 'longtask')).toBe(true);
    f.observers[0].emit([{ entryType: 'mark', name: 'after', startTime: 201, duration: 0 }]);
    expect(recorder.stop().entries.some(entry => entry.name === 'after')).toBe(false);
  });

  it('auto-stops observation and discards data on context loss or external detach', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.debugging.performance(1, { action: 'start', durationMs: 100 }, scope());
    await vi.advanceTimersByTimeAsync(100);
    const stopped = await f.debugging.performance(1, { action: 'status' }); expect(stopped).toMatchObject({ state: 'stopped', traceId: expect.any(String) });
    f.debugging.event({ tabId: 1 }, 'Runtime.executionContextDestroyed', { executionContextId: 10 });
    await expect(f.debugging.performance(1, { action: 'read', traceId: stopped.traceId })).rejects.toMatchObject({ code: 'DEBUGGING_ARTIFACT_NOT_FOUND' });
    await f.debugging.performance(1, { action: 'start' }, scope()); f.debugging.forget(1);
    expect(await f.debugging.performance(1, { action: 'status' })).toMatchObject({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(30000); expect(f.observers.at(-1).connected).toBe(false);
  });

  it('validates actions, frame selection and arguments before recording', async () => {
    const f = fixture();
    for (const args of [{ action: 'start', samplingIntervalUs: 1000 }, { action: 'start', durationMs: 0 }, { action: 'snapshot', limit: 101 }, { action: 'stop', limit: 2 }, { action: 'read' }, { action: 'read', traceId: 'trace-id', offset: -1 }, { action: 'snapshot', frameId: '' }, { action: 'snapshot', format: 'raw' }]) await expect(f.debugging.performance(1, args, scope())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(f.debugging.performance(1, { action: 'start' })).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
    await f.debugging.performance(1, { action: 'start' }, scope());
    await expect(f.debugging.performance(1, { action: 'start' }, scope())).rejects.toMatchObject({ code: 'TRACE_BUSY' });
    await f.debugging.dispose(1);
  });

  it('returns document timing plus an allowlisted metrics snapshot and always disables metrics', async () => {
    const f = fixture(); f.performance.getEntries = () => [{ entryType: 'resource', name: 'https://example.test/api?secret=HIDDEN', startTime: 1, duration: 2, transferSize: 42, detail: 'HIDDEN' }, { entryType: 'mark', name: 'rendered', startTime: 4, duration: 0 }];
    const result = await f.debugging.performance(1, { action: 'snapshot', limit: 1 }, scope());
    expect(result.metrics).toEqual([{ name: 'Nodes', value: 24 }, { name: 'JSHeapUsedSize', value: 2048 }]);
    expect(result.timeline).toMatchObject({ truncated: true, entries: [{ entryType: 'mark', name: 'rendered' }] });
    expect(f.calls.map(call => call.method)).toContain('Performance.disable');
    const snapshot = runInNewContext(`(${snapshotPerformance.toString()})(10)`, f.environment);
    expect(snapshot.entries[0].name).toBe('https://example.test/api'); expect(JSON.stringify(snapshot)).not.toContain('HIDDEN');
    expect(f.calls.find(call => call.method === 'Runtime.evaluate').params.contextId).toBe(10);
  });

  it.each(['start', 'snapshot'])('fails closed when Chrome omits or malforms the isolated context for %s', async action => {
    for (const executionContextId of [undefined, null, 0, -1, 1.5, '10']) {
      const f = fixture(); const original = f.sendCommand.getMockImplementation();
      f.sendCommand.mockImplementation((target, method, params) => method === 'Page.createIsolatedWorld' ? Promise.resolve({ executionContextId }) : original(target, method, params));
      await expect(f.debugging.performance(1, { action }, scope())).rejects.toMatchObject({ code: 'DEBUGGING_UNAVAILABLE' });
      expect(f.calls.some(call => call.method === 'Runtime.evaluate')).toBe(false);
      expect(f.observers).toEqual([]);
    }
  });

  it('releases a returned observer object if detachment races timeline startup', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred(); const original = f.sendCommand.getMockImplementation();
    f.sendCommand.mockImplementation(async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === 'Runtime.evaluate' && !params.returnByValue) { entered.resolve(); await release.promise; }
      return result;
    });
    const starting = f.debugging.performance(1, { action: 'start' }, scope());
    const rejected = expect(starting).rejects.toMatchObject({ code: 'DEBUGGING_CANCELLED' });
    await entered.promise; f.debugging.forget(1); release.resolve(); await rejected;
    expect(f.objects.size).toBe(0); expect(f.observers[0].connected).toBe(false);
    expect(f.debugging.artifacts.size).toBe(0);
  });

  it('uses separate observers and artifact identities for independent tabs', async () => {
    const f = fixture(); await f.debugging.performance(1, { action: 'start' }, scope(1)); await f.debugging.performance(2, { action: 'start' }, scope(2));
    f.observers[0].emit([{ entryType: 'mark', name: 'first tab', startTime: 1, duration: 0 }]);
    f.observers[1].emit([{ entryType: 'mark', name: 'second tab', startTime: 1, duration: 0 }]);
    const first = await f.debugging.performance(1, { action: 'stop' }); const second = await f.debugging.performance(2, { action: 'stop' });
    expect(first.traceId).not.toBe(second.traceId);
    expect(JSON.stringify(await artifact(f.debugging, 1, 'trace', first.traceId, 12000))).not.toContain('second tab');
    await expect(f.debugging.performance(1, { action: 'read', traceId: second.traceId })).rejects.toMatchObject({ code: 'DEBUGGING_ARTIFACT_NOT_FOUND' });
  });
});

describe('structural DOM and computed-style inspection', () => {
  function inspectedFixture() {
    const attributes = { type: 'password', name: 'login', 'aria-label': 'Private code', 'data-secret': 'ATTRIBUTE-SECRET', value: 'PASSWORD-SECRET' };
    const element = { nodeType: 1, isConnected: true, tagName: 'INPUT', id: 'password', classList: ['field'], childElementCount: 0, value: 'PASSWORD-SECRET', outerHTML: 'HTML-SECRET', attributes,
      hasAttribute: name => name in attributes, getAttribute: name => attributes[name] ?? null, matches: () => false, getRootNode: () => ({}), getBoundingClientRect: () => ({ x: 5, y: 10, width: 200, height: 30 }) };
    const styles = { color: 'rgb(1, 2, 3)', width: '200px', display: 'block' };
    const adapter = { call: vi.fn(async (_tab, _args, fn, values) => runInNewContext(`(${fn}).apply(element, values)`, { element, values, TextEncoder, getComputedStyle: () => ({ getPropertyValue: key => styles[key] || '' }) })) };
    return { adapter, element, styles };
  }
  it('returns selected computed properties, geometry and structure without reading HTML, arbitrary attributes or input values', async () => {
    const f = inspectedFixture(); const result = await inspectTarget(f.adapter, 1, { selector: '#password', properties: ['width', 'color'] });
    expect(result).toMatchObject({ tagName: 'input', id: 'password', attributes: { type: 'password', name: 'login' }, styles: { width: '200px', color: 'rgb(1, 2, 3)' }, rect: { width: 200, height: 30 }, formValuesOmitted: true });
    expect(JSON.stringify(result)).not.toMatch(/PASSWORD-SECRET|ATTRIBUTE-SECRET|HTML-SECRET/);
  });
  it('rejects arbitrary properties, custom variables, duplicate/oversized lists and unknown arguments', async () => {
    const f = inspectedFixture();
    for (const args of [{ selector: 'input', properties: ['--token'] }, { selector: 'input', properties: ['background-image'] }, { selector: 'input', properties: ['color', 'color'] }, { selector: 'input', properties: [] }, { selector: 'input', properties: INSPECT_PROPERTIES.slice(0, 31) }, { selector: 'input', includeHTML: true }]) await expect(inspectTarget(f.adapter, 1, args)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.adapter.call).not.toHaveBeenCalled();
  });
  it.each(['\u0001', '界'])('bounds the complete escaped UTF-8 inspection output for %j', async character => {
    const f = inspectedFixture(); const properties = INSPECT_PROPERTIES.slice(0, 30);
    for (const property of properties) f.styles[property] = character.repeat(512);
    for (const key of ['role', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected', 'type', 'name', 'disabled', 'readonly', 'required', 'placeholder', 'title']) f.element.attributes[key] = character.repeat(256);
    f.element.id = character.repeat(256); f.element.classList = Array(21).fill(character.repeat(100));
    const result = await inspectTarget(f.adapter, 1, { selector: 'input', properties });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(75000);
    expect(result.truncated).toBe(true); expect(result.classNames).toHaveLength(20);
    expect(result.states.attached).toBe(true); expect(Object.keys(result.styles)).toEqual(properties);
  });
  it('integrates profiler cleanup into PageAdapter release even when ownership guards are revoked', async () => {
    const f = fixture(); const chrome = { debugger: { sendCommand: f.sendCommand, detach: vi.fn(async () => {}) } };
    const pages = new PageAdapter(chrome); pages.attached.add(1);
    await pages.execute(1, 'page.profile', { action: 'start', durationMs: 1000 });
    pages.guards.set(1, () => { throw new Error('revoked'); });
    await pages.detach(1);
    expect(f.calls.map(call => call.method)).toEqual(expect.arrayContaining(['Profiler.stop', 'Profiler.disable']));
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 }); expect(pages.debugging.profiles.size).toBe(0);
  });
});
