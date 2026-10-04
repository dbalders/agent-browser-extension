import { describe, expect, it, vi } from 'vitest';
import { BrowserController } from '../extension/controller.js';
import { PageAdapter } from '../extension/pages.js';
import { WebsiteAccess } from '../extension/access.js';
import { installAccessControl } from '../extension/access-control.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://main.test/path', groupId: -1 }]]);
  const trees = new Map([[1, { frame: { id: 'main', url: tabs.get(1).url, loaderId: 'first' } }]]);
  let nextId = 2;
  const chrome = {
    tabs: {
      get: vi.fn(async id => ({ ...tabs.get(id) })), query: vi.fn(async () => [...tabs.values()]),
      create: vi.fn(async args => { const tab = { id: nextId++, windowId: 1, groupId: -1, ...args }; tabs.set(tab.id, tab); return { ...tab }; }),
      update: vi.fn(async (id, args) => { Object.assign(tabs.get(id), args); return { ...tabs.get(id) }; }),
      group: vi.fn(async () => 1), remove: vi.fn(async id => { tabs.delete(id); }),
    },
    tabGroups: { get: vi.fn(async () => ({ id: 1 })), update: vi.fn(async () => ({})) },
    windows: { update: vi.fn(async () => ({})) },
    debugger: {
      attach: vi.fn(async () => {}), detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (target, method) => {
        if (method === 'Page.getFrameTree') return { frameTree: trees.get(target.tabId) };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 20 };
        if (method === 'Runtime.evaluate') return { result: { value: 'visible result' } };
        return {};
      }),
    },
  };
  const pages = new PageAdapter(chrome), controller = new BrowserController(chrome, pages);
  const access = new WebsiteAccess({ onRevoke: change => controller.revokeAccess(change) });
  installAccessControl(controller, pages, access);
  let serial = 0;
  const execute = (id, operation, args = {}, extra = {}) => controller.execute({ type: 'command', id: `c${++serial}`, sessionId: id, operation, args, ...extra });
  const start = (id = 'a') => execute(id, 'session.start', { name: `Task ${id}` });
  const allow = (origin = 'https://main.test', capability = 'ordinary', sessionId, scope = 'always') => access.grant({ origin, capability, sessionId, scope });
  const own = async () => { await start(); await allow(); await execute('a', 'tabs.claim', { tabId: 1 }); };
  const discover = () => execute('a', 'page.frames', { tabId: 1 });
  const child = (url = 'https://child.test/frame') => { trees.get(1).childFrames = [{ frame: { id: 'child', parentId: 'main', url, loaderId: 'child-first' } }]; };
  return { tabs, trees, chrome, pages, controller, access, execute, start, allow, own, discover, child };
}

describe('website access enforcement', () => {
  it('does not let passive marker renewal request revoked website access', async () => {
    const f = fixture(); await f.own(); await f.access.revoke('https://main.test', 'ordinary');
    f.chrome.debugger.sendCommand.mockClear();
    await f.controller.refreshIndicators(1);
    expect(f.access.pending.size).toBe(0);
    expect(f.chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('requires UI approval before claiming or opening and never replays a denied action', async () => {
    const f = fixture(); await f.start();
    await expect(f.execute('a', 'tabs.claim', { tabId: 1 })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    await expect(f.execute('a', 'tabs.open', { url: 'https://main.test/new' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    expect(f.controller.state.tabs).toEqual({}); expect(f.chrome.tabs.create).not.toHaveBeenCalled();
    expect(f.access.snapshot().pending).toEqual([{ origin: 'https://main.test', sessionId: 'a', capability: 'ordinary', taskName: 'Task a' }]);
    await f.allow(); expect(f.chrome.tabs.create).not.toHaveBeenCalled();
    await expect(f.execute('a', 'tabs.claim', { tabId: 1 })).resolves.toMatchObject({ tabId: 1 });
    await expect(f.execute('a', 'tabs.open', { url: 'https://main.test/new' })).resolves.toMatchObject({ tabId: 2 });
  });
  it('checks ownership before generating a request for a competing session', async () => {
    const f = fixture(); await f.start(); await f.start('b'); await f.allow('https://main.test', 'ordinary', 'a', 'once');
    await f.execute('a', 'tabs.claim', { tabId: 1 });
    await expect(f.execute('b', 'tabs.claim', { tabId: 1 })).rejects.toMatchObject({ code: 'TAB_BUSY' });
    expect(f.access.pending.size).toBe(0);
  });
  it('allows only a newly created initial blank document to use its approved pending URL', async () => {
    const f = fixture(); await f.start(); await f.allow();
    f.chrome.tabs.create.mockImplementationOnce(async args => {
      const tab = { id: 2, windowId: 1, groupId: -1, url: 'about:blank', pendingUrl: args.url }; f.tabs.set(2, tab); return { ...tab };
    });
    await expect(f.execute('a', 'tabs.open', { url: 'https://main.test/loading' })).resolves.toMatchObject({ tabId: 2 });
    f.trees.set(2, { frame: { id: 'new', url: 'about:blank' } });
    await expect(f.execute('a', 'page.frames', { tabId: 2 })).resolves.toBeDefined();
    f.tabs.get(2).url = 'https://main.test/loading'; delete f.tabs.get(2).pendingUrl;
    f.trees.get(2).frame.url = f.tabs.get(2).url;
    await f.controller.navigationChanged(2, f.tabs.get(2).url);
    await expect(f.execute('a', 'page.frames', { tabId: 2 })).resolves.toBeDefined();
    f.tabs.set(3, { id: 3, url: 'about:blank', pendingUrl: 'https://main.test/loading' });
    await expect(f.execute('a', 'tabs.claim', { tabId: 3 })).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    expect(f.controller.state.tabs[3]).toBeUndefined();
  });
  it('keeps cleanup and user-visible tab management possible after blocking', async () => {
    const f = fixture(); await f.own(); await f.access.block('https://main.test');
    await expect(f.execute('a', 'tabs.mark', { tabId: 1, disposition: 'handoff' })).resolves.toMatchObject({ disposition: 'handoff' });
    await expect(f.execute('a', 'tabs.show', { tabId: 1 })).resolves.toEqual({ shown: true });
    await expect(f.execute('a', 'tabs.release', { tabId: 1 })).resolves.toEqual({ released: true });
    expect(f.chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it('permits discovery of blocked frames but denies content, whole-page captures and input', async () => {
    const f = fixture(); await f.own(); f.child();
    expect((await f.discover()).frames).toHaveLength(2);
    expect(f.access.pending.size).toBe(0);
    await expect(f.execute('a', 'page.evaluate', { tabId: 1, frameId: 'child', expression: 'document.title' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    for (const method of ['Page.captureScreenshot', 'Input.dispatchKeyEvent', 'Accessibility.getFullAXTree']) {
      await expect(f.pages.rawSend({ tabId: 1 }, method)).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    }
    expect(f.chrome.debugger.sendCommand.mock.calls.some(([, method]) => method === 'Page.captureScreenshot')).toBe(false);
    await f.allow('https://child.test');
    await expect(f.execute('a', 'page.evaluate', { tabId: 1, frameId: 'child', expression: 'document.title' })).resolves.toBeDefined();
  });
  it('inherits blank frame and captured popup origins but requires every non-blank ancestor', async () => {
    const f = fixture(); await f.own(); f.child('about:srcdoc'); await f.discover();
    await expect(f.pages.rawSend({ tabId: 1 }, 'Page.createIsolatedWorld', { frameId: 'child' })).resolves.toEqual({ executionContextId: 20 });
    f.trees.get(1).childFrames[0].childFrames = [{ frame: { id: 'nested', parentId: 'child', url: 'https://nested.test' } }];
    await f.discover(); await f.allow('https://nested.test');
    await expect(f.pages.rawSend({ tabId: 1 }, 'Page.createIsolatedWorld', { frameId: 'nested' })).resolves.toBeDefined();
    f.trees.get(1).childFrames[0].frame.url = 'https://unapproved-parent.test'; await f.discover();
    await expect(f.pages.rawSend({ tabId: 1 }, 'Page.createIsolatedWorld', { frameId: 'nested' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    f.tabs.set(2, { id: 2, windowId: 1, url: 'about:blank', groupId: -1 });
    f.trees.set(2, { frame: { id: 'popup', url: 'about:blank' } });
    f.controller.state.tabs[2] = { sessionId: 'a', created: true, popup: true, openerOrigin: 'https://main.test', disposition: 'temporary' };
    await expect(f.execute('a', 'page.frames', { tabId: 2 })).resolves.toMatchObject({ frames: [{ frameId: 'popup' }] });
  });
  it('requires separate debugging approval including same-renderer child origins', async () => {
    const f = fixture(); await f.own(); f.child(); await f.allow('https://child.test'); await f.discover();
    await expect(f.execute('a', 'page.profile', { tabId: 1, action: 'status' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    await f.allow('https://main.test', 'debug');
    await expect(f.execute('a', 'page.profile', { tabId: 1, action: 'status' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    await f.allow('https://child.test', 'debug');
    await expect(f.execute('a', 'page.profile', { tabId: 1, action: 'status' })).resolves.toMatchObject({ state: 'idle' });
  });
  it.each(['error', 'stopped'])('does not require new child debug access for an inactive %s CPU capture', async phase => {
    const f = fixture(); await f.own(); await f.allow('https://main.test', 'debug'); await f.discover();
    const original = f.chrome.debugger.sendCommand.getMockImplementation();
    f.chrome.debugger.sendCommand.mockImplementation((target, method, args) => {
      if (phase === 'error' && method === 'Profiler.enable') return Promise.reject(new Error(JSON.stringify({ code: -32601, message: "'Profiler.enable' wasn't found" })));
      if (method === 'Profiler.stop') return Promise.resolve({ profile: { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: { functionName: '(root)' } }], samples: [1], timeDeltas: [1000] } });
      return original(target, method, args);
    });
    if (phase === 'error') await expect(f.execute('a', 'page.profile', { tabId: 1, action: 'start' })).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
    else { await f.execute('a', 'page.profile', { tabId: 1, action: 'start' }); await f.execute('a', 'page.profile', { tabId: 1, action: 'stop' }); }
    await f.allow('https://child.test'); f.child();
    f.pages.event({ tabId: 1 }, 'Page.frameNavigated', { frame: f.trees.get(1).childFrames[0].frame });
    expect(f.pages.debugging.profiles.get(1)?.phase).toBe(phase);
    await expect(f.execute('a', 'page.evaluate', { tabId: 1, expression: 'document.title' })).resolves.toBeDefined();
    expect(f.chrome.debugger.detach).not.toHaveBeenCalled();
    expect(f.access.pending.size).toBe(0);
  });
  it('still detaches an active CPU capture when a new same-renderer child lacks debug access', async () => {
    const f = fixture(); await f.own(); await f.allow('https://main.test', 'debug'); await f.discover();
    await f.execute('a', 'page.profile', { tabId: 1, action: 'start' });
    await f.allow('https://child.test'); f.child();
    f.pages.event({ tabId: 1 }, 'Page.frameNavigated', { frame: f.trees.get(1).childFrames[0].frame });
    expect(f.pages.debugging.profiles.has(1)).toBe(false);
    await f.discover();
    expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(f.access.allows('https://main.test', 'a')).toBe(true);
  });
  it('discards an already dispatched Chrome result after revoke, even if immediately regranted', async () => {
    const f = fixture(); await f.own(); await f.discover(); const reply = deferred();
    f.chrome.debugger.sendCommand.mockImplementationOnce(() => reply.promise);
    const pending = f.pages.rawSend({ tabId: 1 }, 'Runtime.evaluate', { expression: 'privateValue' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SITE_ACCESS_REVOKED' });
    await f.access.revoke('https://main.test'); await f.allow(); reply.resolve({ result: { value: 'must not escape' } });
    await rejected; expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 }); expect(f.tabs.has(1)).toBe(true);
  });
  it('invalidates a queued operation on revoke rather than replaying after regrant', async () => {
    const f = fixture(); await f.own(); await f.discover(); const gate = deferred();
    const lock = f.controller.scheduler.schedule({ resources: [['tab:1', 'write']] }, () => gate.promise);
    const pending = f.execute('a', 'page.frames', { tabId: 1 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SITE_ACCESS_REVOKED' });
    await f.access.revoke('https://main.test'); await f.allow(); gate.resolve(); await lock; await rejected;
  });
  it('rechecks approval after waiting for the browser mutation queue', async () => {
    const f = fixture(); await f.start(); await f.allow(); const gate = deferred();
    const lock = f.controller.mutateBrowser(() => gate.promise);
    const pending = f.execute('a', 'tabs.open', { url: 'https://main.test/new' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SITE_ACCESS_REVOKED' });
    await Promise.resolve(); await Promise.resolve(); await f.access.revoke('https://main.test'); await f.allow();
    gate.resolve(); await lock; await rejected; expect(f.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('waits for old detach cleanup before a new command attaches', async () => {
    const f = fixture(); await f.own(); await f.discover(); await f.allow('https://main.test', 'debug');
    const gate = deferred(), started = deferred(); const oldDetach = f.pages.detach.bind(f.pages);
    f.pages.detach = vi.fn(async tabId => { started.resolve(); await gate.promise; return oldDetach(tabId); });
    const revoked = f.access.revoke('https://main.test', 'debug'); await started.promise;
    const attachCount = f.chrome.debugger.attach.mock.calls.length;
    const pending = f.discover(); await Promise.resolve(); await Promise.resolve();
    expect(f.chrome.debugger.attach).toHaveBeenCalledTimes(attachCount);
    gate.resolve(); await revoked; await expect(pending).resolves.toMatchObject({ frames: [{ frameId: 'main' }] });
    expect(f.chrome.debugger.attach).toHaveBeenCalledTimes(attachCount + 1);
    await expect(f.execute('a', 'page.evaluate', { tabId: 1, expression: 'document.title' })).resolves.toBeDefined();
    expect(f.access.pending.size).toBe(0);
  });
  it('checks the explicit back/forward destination before dispatching history navigation', async () => {
    const f = fixture(); await f.own(); await f.discover();
    f.chrome.debugger.sendCommand.mockImplementationOnce(async () => ({ currentIndex: 1, entries: [{ id: 1, url: 'https://previous.test/private' }, { id: 2, url: 'https://main.test/path' }] }));
    await f.pages.rawSend({ tabId: 1 }, 'Page.getNavigationHistory');
    await expect(f.pages.rawSend({ tabId: 1 }, 'Page.navigateToHistoryEntry', { entryId: 1 })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    expect(f.chrome.debugger.sendCommand.mock.calls.some(([, method]) => method === 'Page.navigateToHistoryEntry')).toBe(false);
    await f.allow('https://previous.test');
    await expect(f.pages.rawSend({ tabId: 1 }, 'Page.navigateToHistoryEntry', { entryId: 1 })).resolves.toBeDefined();
  });
  it('checks access after safeTab awaits before recording a prompt or dispatching an action', async () => {
    const f = fixture(); await f.start(); const get = deferred(); f.chrome.tabs.get.mockImplementationOnce(() => get.promise);
    const pending = f.execute('a', 'tabs.claim', { tabId: 1 }); const rejected = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await Promise.resolve(); f.controller.suspend(); get.resolve({ ...f.tabs.get(1) }); await rejected;
    expect(f.access.pending.size).toBe(0); expect(f.controller.state.tabs).toEqual({});
  });
  it('detaches on an unauthorized redirect and refuses subsequent actions', async () => {
    const f = fixture(); await f.own(); await f.discover(); f.tabs.get(1).url = 'https://redirect.test/private';
    await f.controller.navigationChanged(1, f.tabs.get(1).url);
    expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    await expect(f.execute('a', 'page.frames', { tabId: 1 })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    expect(f.access.snapshot().pending.at(-1).origin).toBe('https://redirect.test'); expect(f.tabs.has(1)).toBe(true);
  });
  it('filters child console and network events while retaining allowed document events', async () => {
    const f = fixture(); await f.own(); f.child(); await f.discover();
    f.pages.event({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 5, auxData: { frameId: 'child', isDefault: true } } });
    f.pages.event({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 1, auxData: { frameId: 'main', isDefault: true } } });
    const log = id => f.pages.event({ tabId: 1 }, 'Runtime.consoleAPICalled', { executionContextId: id, args: [{ type: 'string', value: id === 5 ? 'child secret' : 'main log' }] });
    log(5); log(1); log(999);
    f.pages.event({ tabId: 1, sessionId: 'undiscovered-child' }, 'Log.entryAdded', { entry: { text: 'unattributed child data' } });
    f.pages.event({ tabId: 1 }, 'Page.javascriptDialogOpening', { url: 'https://child.test', message: 'unapproved dialog', type: 'alert' });
    expect(f.pages.dialogs.has(1)).toBe(false);
    const request = frameId => f.pages.event({ tabId: 1 }, 'Network.requestWillBeSent', { frameId, requestId: frameId, request: { url: 'https://resource.test/data?secret=omitted', method: 'GET' } });
    request('child'); request('main');
    f.pages.event({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'main', encodedDataLength: 123 });
    expect(f.pages.diagnostics.read(1, 'console').entries.map(entry => entry.text)).toEqual(['main log']);
    expect(f.pages.diagnostics.read(1, 'network').entries).toMatchObject([{ frameId: 'main', state: 'finished', url: 'https://resource.test/data' }]);
  });
  it('clears retained diagnostics when a previously observed origin is revoked after its frame leaves', async () => {
    const f = fixture(); await f.own(); f.child(); await f.allow('https://child.test'); await f.discover();
    f.pages.event({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 5, auxData: { frameId: 'child', isDefault: true } } });
    f.pages.event({ tabId: 1 }, 'Runtime.consoleAPICalled', { executionContextId: 5, args: [{ type: 'string', value: 'child data' }] });
    expect(f.pages.diagnostics.read(1, 'console').entries).toHaveLength(1);
    delete f.trees.get(1).childFrames; await f.discover(); await f.access.revoke('https://child.test');
    expect(f.pages.diagnostics.tabs.has(1)).toBe(false); expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
  });
  it('removes once grants on session end and scopes access status to the requesting task', async () => {
    const f = fixture(); await f.start(); await f.start('b');
    await f.allow('https://main.test', 'ordinary', 'a', 'once'); await f.allow('https://other.test', 'ordinary', 'b', 'once');
    await expect(f.execute('b', 'tabs.open', { url: 'https://pending.test/' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    const status = await f.execute('a', 'access.status'); expect(status.once).toHaveLength(1); expect(status.once[0].sessionId).toBe('a'); expect(status.pending).toEqual([]);
    await f.execute('a', 'session.end'); expect(f.access.allows('https://main.test', 'a')).toBe(false); expect(f.access.allows('https://other.test', 'b')).toBe(true);
  });
  it('bounds access status below the bridge reply budget and reports truncation', async () => {
    const f = fixture(); await f.start();
    const sites = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`https://${'a'.repeat(180)}${i}.test`, { ordinary: 'allow' }]));
    expect(f.access.restore({ version: 1, allowAll: false, sites })).toBe(true);
    const status = await f.execute('a', 'access.status');
    expect(status.truncated).toBe(true); expect(status.sites.length).toBeGreaterThan(0); expect(status.sites.length).toBeLessThan(500);
    expect(new TextEncoder().encode(JSON.stringify(status)).length).toBeLessThan(75000);
  });
});
