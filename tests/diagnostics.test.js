import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageDiagnostics } from '../extension/diagnostics.js';

afterEach(() => vi.useRealTimers());
const source = { tabId: 1 };
function credentialUrl(value) {
  const url = new URL(value);
  url.username = 'fixture-user'; url.password = 'fixture-password';
  return url.href;
}
function request(diagnostics, requestId, url = 'https://example.test/resource', extra = {}, target = source) {
  diagnostics.event(target, 'Network.requestWillBeSent', { requestId, type: 'Fetch', request: { url, method: 'GET' }, ...extra });
}
function log(diagnostics, message, target = source) {
  diagnostics.event(target, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: message }] });
}

describe('in-memory page diagnostics', () => {
  it('captures only attached tabs and erases their history on detach', () => {
    const diagnostics = new PageDiagnostics();
    log(diagnostics, 'before attachment');
    diagnostics.start(1); diagnostics.start(2);
    log(diagnostics, 'first tab'); log(diagnostics, 'second tab', { tabId: 2 });
    expect(diagnostics.read(1, 'console').entries.map(entry => entry.text)).toEqual(['first tab']);
    expect(diagnostics.read(2, 'console').entries.map(entry => entry.text)).toEqual(['second tab']);
    const oldCursor = diagnostics.read(1, 'console').nextAfter;
    diagnostics.clear(1); log(diagnostics, 'after detach');
    expect(() => diagnostics.read(1, 'console')).toThrow(expect.objectContaining({ code: 'DIAGNOSTICS_UNAVAILABLE' }));
    diagnostics.start(1); log(diagnostics, 'after reattachment');
    expect(diagnostics.read(1, 'console', { after: oldCursor }).entries.map(entry => entry.text)).toEqual(['after reattachment']);
    expect(diagnostics.read(2, 'console').entries).toHaveLength(1);
  });

  it('collects primitive console output and bounded object descriptions without inspecting properties', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    const remote = { type: 'object', description: 'Object', value: { secret: 'DO-NOT-INSPECT' }, get preview() { throw new Error('Must not inspect remote object preview'); } };
    diagnostics.event(source, 'Runtime.consoleAPICalled', {
      type: 'warning', args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }, { type: 'boolean', value: false }, remote],
      stackTrace: { callFrames: [{ functionName: 'render', url: credentialUrl('https://example.test/app.js?token=SECRET#private'), lineNumber: 2, columnNumber: 3 }] },
    });
    diagnostics.event(source, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { type: 'object', description: 'TypeError: invalid value' }, url: 'https://example.test/app.js?key=SECRET', lineNumber: 4, columnNumber: 5 } });
    diagnostics.event({ tabId: 1, sessionId: 'child' }, 'Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'A resource failed', url: 'https://example.test/image?token=SECRET', lineNumber: 6 } });
    const entries = diagnostics.read(1, 'console').entries;
    expect(entries[0]).toMatchObject({ source: 'console', level: 'warning', text: 'hello 42 false Object', stack: 'render@https://example.test/app.js:3:4' });
    expect(entries[1]).toMatchObject({ source: 'exception', level: 'error', text: 'TypeError: invalid value', url: 'https://example.test/app.js', line: 5, column: 6 });
    expect(entries[2]).toMatchObject({ source: 'network', level: 'error', targetSessionId: 'child', url: 'https://example.test/image' });
    expect(JSON.stringify(entries)).not.toMatch(/SECRET|DO-NOT-INSPECT|password/);
    log(diagnostics, 'x'.repeat(5000));
    expect(diagnostics.read(1, 'console').entries.at(-1).text).toHaveLength(1000);
  });

  it('rejects console and log history replayed by domain enable before this attachment', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    const before = Date.now() - 1;
    diagnostics.event(source, 'Runtime.consoleAPICalled', { timestamp: before, args: [{ type: 'string', value: 'OLD' }] });
    diagnostics.event(source, 'Runtime.exceptionThrown', { timestamp: before, exceptionDetails: { text: 'OLD' } });
    diagnostics.event(source, 'Log.entryAdded', { entry: { timestamp: before, text: 'OLD' } });
    request(diagnostics, 'old', undefined, { wallTime: before / 1000 });
    expect(diagnostics.read(1, 'console').entries).toEqual([]);
    expect(diagnostics.read(1, 'network').entries).toEqual([]);
    diagnostics.event(source, 'Log.entryAdded', { entry: { timestamp: Date.now(), text: 'current' } });
    expect(diagnostics.read(1, 'console').entries.map(entry => entry.text)).toEqual(['current']);
    vi.setSystemTime(Date.now() + 1);
    diagnostics.read(1, 'console', { clear: true });
    diagnostics.event(source, 'Log.entryAdded', { entry: { timestamp: before + 1, text: 'replayed after clear' } });
    expect(diagnostics.read(1, 'console').entries).toEqual([]);
  });

  it('retains request metadata without URL credentials, query strings, headers or bodies', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    request(diagnostics, 'request-1', undefined, {
      frameId: 'main-frame',
      request: { url: credentialUrl('https://example.test/api/item?token=SECRET#SECRET'), method: 'POST', headers: { Authorization: 'SECRET', Cookie: 'SECRET' }, postData: 'SECRET-BODY', postDataEntries: [{ bytes: 'SECRET' }] },
    });
    const initial = diagnostics.read(1, 'network');
    expect(JSON.stringify([...diagnostics.tabs.get(1).network.pending])).not.toContain('SECRET');
    diagnostics.event(source, 'Network.responseReceived', {
      requestId: 'request-1', response: { status: 201, mimeType: 'application/json', protocol: 'h2', fromDiskCache: false, headers: { 'set-cookie': 'SECRET' }, securityDetails: { issuer: 'SECRET' } },
    });
    diagnostics.event(source, 'Network.responseReceivedExtraInfo', { requestId: 'request-1', headers: { 'set-cookie': 'SECRET' } });
    diagnostics.event(source, 'Network.loadingFinished', { requestId: 'request-1', encodedDataLength: 123 });
    const result = diagnostics.read(1, 'network', { after: initial.nextAfter });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ url: 'https://example.test/api/item', method: 'POST', resourceType: 'Fetch', state: 'finished', status: 201, mimeType: 'application/json', protocol: 'h2', encodedBytes: 123, frameId: 'main-frame' });
    expect(result.entries[0].id).toBeGreaterThan(initial.nextAfter);
    expect(JSON.stringify(diagnostics.tabs.get(1))).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|headers|postData|securityDetails|alice/);
    expect(diagnostics.tabs.get(1).network.pending.size).toBe(0);
  });

  it('omits the payload of non-web URL schemes', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    for (const [id, url] of ['data:text/plain,SECRET', 'blob:https://example.test/SECRET', 'file:///private/SECRET', 'not a url SECRET'].entries()) request(diagnostics, String(id), url);
    const entries = diagnostics.read(1, 'network').entries;
    expect(entries.map(entry => entry.url)).toEqual(['data:', 'blob:', 'file:', '[invalid URL]']);
    expect(JSON.stringify(entries)).not.toContain('SECRET');
  });

  it('separates reused request IDs across child targets and retains each redirect hop', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    request(diagnostics, 'same', 'https://example.test/start?secret=first');
    request(diagnostics, 'same', 'https://child.test/frame', {}, { tabId: 1, sessionId: 'child-target' });
    request(diagnostics, 'same', 'https://example.test/final?secret=second', { redirectResponse: { status: 302, headers: { location: 'SECRET' } } });
    diagnostics.event(source, 'Network.responseReceived', { requestId: 'same', response: { status: 200 } });
    diagnostics.event(source, 'Network.loadingFinished', { requestId: 'same', encodedDataLength: 10 });
    diagnostics.event({ tabId: 1, sessionId: 'child-target' }, 'Network.loadingFailed', { requestId: 'same', errorText: 'net::ERR_CONNECTION_REFUSED' });
    const entries = diagnostics.read(1, 'network').entries;
    expect(entries).toHaveLength(3);
    expect(entries.find(entry => entry.url.endsWith('/start'))).toMatchObject({ state: 'redirected', status: 302, redirectCount: 0 });
    expect(entries.find(entry => entry.url.endsWith('/final'))).toMatchObject({ state: 'finished', status: 200, redirectCount: 1 });
    expect(entries.find(entry => entry.url.endsWith('/frame'))).toMatchObject({ state: 'failed', targetSessionId: 'child-target', error: 'net::ERR_CONNECTION_REFUSED', redirectCount: 0 });
    expect(diagnostics.tabs.get(1).network.pending.size).toBe(0);
  });

  it('uses local timestamps and reports failures and elapsed time without extra response data', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    request(diagnostics, 'failed', undefined, { timestamp: -999999 });
    vi.setSystemTime(new Date('2026-10-03T12:00:00.125Z'));
    diagnostics.event(source, 'Network.loadingFailed', { requestId: 'failed', timestamp: 1, errorText: 'net::ERR_BLOCKED_BY_CLIENT', canceled: true, blockedReason: 'inspector', corsErrorStatus: { corsError: 'InvalidResponse', failedParameter: 'SECRET' } });
    expect(diagnostics.read(1, 'network').entries[0]).toMatchObject({ timestamp: '2026-10-03T12:00:00.125Z', state: 'failed', durationMs: 125, canceled: true, error: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector', corsError: 'InvalidResponse' });
    expect(JSON.stringify(diagnostics.read(1, 'network'))).not.toContain('SECRET');
  });

  it('bounds rolling observations, pending requests, and encoded response bytes', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    for (let index = 0; index < 420; index++) {
      log(diagnostics, `${index} ${'😀'.repeat(1000)}`);
      request(diagnostics, String(index), `https://example.test/pending/${index}`);
    }
    const consoleResult = diagnostics.read(1, 'console', { limit: 100 });
    expect(consoleResult.dropped).toBe(220);
    expect(consoleResult.truncated).toBe(true);
    expect(consoleResult.entries[0].text).toMatch(/^220 /);
    expect(new TextEncoder().encode(JSON.stringify(consoleResult)).length).toBeLessThan(76000);
    expect(diagnostics.tabs.get(1).console.entries).toHaveLength(200);
    expect(diagnostics.tabs.get(1).network.entries).toHaveLength(200);
    expect(diagnostics.tabs.get(1).network.pending.size).toBe(200);
    expect(diagnostics.read(1, 'network')).toMatchObject({ droppedPending: 220, truncated: true });
    diagnostics.event(source, 'Network.loadingFinished', { requestId: '0', encodedDataLength: 100 });
    expect(diagnostics.read(1, 'network', { limit: 100 }).entries.some(entry => entry.requestId === '0')).toBe(false);
  });

  it('returns cursor pages and clears only the requested diagnostic kind', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    for (const item of ['one', 'two', 'three']) log(diagnostics, item);
    request(diagnostics, 'pending');
    const first = diagnostics.read(1, 'console', { tabId: 1, limit: 2 });
    expect(first.entries.map(entry => entry.text)).toEqual(['one', 'two']);
    expect(first.truncated).toBe(true);
    const last = diagnostics.read(1, 'console', { after: first.nextAfter, clear: true });
    expect(last.entries.map(entry => entry.text)).toEqual(['three']);
    expect(diagnostics.read(1, 'console').entries).toEqual([]);
    expect(diagnostics.read(1, 'network').entries).toHaveLength(1);
    log(diagnostics, 'after clear');
    expect(diagnostics.read(1, 'console', { after: last.nextAfter }).entries.map(entry => entry.text)).toEqual(['after clear']);
    expect(diagnostics.read(1, 'network', { clear: true }).entries).toHaveLength(1);
    expect(diagnostics.tabs.get(1).network.pending.size).toBe(0);
    diagnostics.event(source, 'Network.loadingFinished', { requestId: 'pending' });
    expect(diagnostics.read(1, 'network').entries).toEqual([]);
    expect(diagnostics.read(1, 'console').entries).toHaveLength(1);
  });

  it('rejects invalid direct-client arguments and ignores malformed or untracked events', () => {
    const diagnostics = new PageDiagnostics(); diagnostics.start(1);
    for (const args of [null, [], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: -1 }, { after: Infinity }, { after: '1' }, { clear: 1 }, { tabId: 2 }, { headers: true }, { since: 1 }]) {
      expect(() => diagnostics.read(1, 'console', args)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(() => diagnostics.read(1, 'cookies')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => diagnostics.start(-1)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    diagnostics.event(null, 'Runtime.consoleAPICalled', {});
    diagnostics.event(source, 'Network.requestWillBeSent', { requestId: 1, request: {} });
    diagnostics.event(source, 'Network.requestWillBeSent', { requestId: 'empty' });
    diagnostics.event(source, 'Runtime.exceptionThrown', {});
    diagnostics.event(source, 'Log.entryAdded', { entry: null });
    diagnostics.event(source, 'Network.responseReceived', { requestId: 'unknown', response: { status: 200 } });
    expect(diagnostics.read(1, 'console').entries).toEqual([]);
    expect(diagnostics.read(1, 'network').entries).toEqual([]);
  });
});
