import { describe, expect, it, vi } from 'vitest';
import { BrowserController, webUrl } from '../extension/controller.js';
import { PageAdapter } from '../extension/pages.js';

function fixture() {
  const tabs = new Map([[1, { id: 1, windowId: 10, groupId: -1, url: 'https://example.test/account', title: 'Existing work', active: true }]]);
  const groups = new Map(); let nextTab = 2; let nextGroup = 1;
  const chrome = {
    tabs: {
      get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('No tab with this ID'); return { ...tabs.get(id) }; }),
      query: vi.fn(async () => [...tabs.values()].map(tab => ({ ...tab }))),
      create: vi.fn(async properties => { const tab = { id: nextTab++, windowId: 10, groupId: -1, title: '', ...properties }; tabs.set(tab.id, tab); return { ...tab }; }),
      remove: vi.fn(async id => { if (!tabs.delete(id)) throw new Error('No tab with this ID'); }),
      update: vi.fn(async (id, properties) => { const tab = tabs.get(id); if (!tab) throw new Error('Missing tab'); Object.assign(tab, properties); return { ...tab }; }),
      group: vi.fn(async ({ tabIds, groupId = nextGroup++ }) => { groups.set(groupId, { id: groupId }); for (const id of tabIds) tabs.get(id).groupId = groupId; return groupId; })
    },
    tabGroups: { get: vi.fn(async id => { if (!groups.has(id)) throw new Error('Missing group'); return groups.get(id); }), update: vi.fn(async (id, properties) => { const group = groups.get(id); if (!group) throw new Error('Missing group'); Object.assign(group, properties); return { ...group }; }) },
    windows: { update: vi.fn(async () => ({})) },
    downloads: { search: vi.fn(async ({ id }) => [{ id, state: 'complete', filename: '/tmp/example.txt' }]) }
  };
  const pages = { detach: vi.fn(async () => {}), invalidate: vi.fn(), execute: vi.fn(async () => ({ ok: true })) };
  const save = vi.fn(async () => {}); const controller = new BrowserController(chrome, pages, save);
  let commandId = 0;
  const execute = (sessionId, operation, args = {}) => controller.execute({ type: 'command', id: `c${++commandId}`, sessionId, operation, args });
  const start = (id = 'a') => execute(id, 'session.start', { name: `Task ${id}` });
  return { tabs, chrome, pages, save, controller, execute, start };
}

describe('extension session ownership and lifecycle', () => {
  it('discovers user tabs without a manual picker and claims without regrouping', async () => {
    const f = fixture(); await f.start();
    expect(await f.execute('a', 'tabs.list')).toMatchObject({ tabs: [{ tabId: 1, createdByAgent: false }], total: 1, truncated: false });
    await f.execute('a', 'tabs.claim', { tabId: 1 });
    expect(f.chrome.tabs.group).not.toHaveBeenCalled();
    expect(f.tabs.get(1).active).toBe(true);
    expect(await f.execute('a', 'page.snapshot', { tabId: 1 })).toEqual({ ok: true });
  });
  it('serializes competing claims and prevents interaction through another session', async () => {
    const f = fixture(); await f.start('a'); await f.start('b');
    const claims = await Promise.allSettled([f.execute('a', 'tabs.claim', { tabId: 1 }), f.execute('b', 'tabs.claim', { tabId: 1 })]);
    expect(claims[0].status).toBe('fulfilled'); expect(claims[1].reason.code).toBe('TAB_BUSY');
    await expect(f.execute('b', 'page.click', { tabId: 1, selector: 'button' })).rejects.toMatchObject({ code: 'TAB_NOT_OWNED' });
    expect(f.pages.execute).not.toHaveBeenCalled();
  });
  it('creates grouped background tabs without focusing the user window', async () => {
    const f = fixture(); await f.start();
    const first = await f.execute('a', 'tabs.open', { url: 'https://example.test/search' });
    const second = await f.execute('a', 'tabs.open', { url: 'https://example.test/result' });
    expect(f.chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.test/search', active: false });
    expect(first.groupId).toBe(second.groupId);
    expect(f.chrome.windows.update).not.toHaveBeenCalled(); expect(f.tabs.get(1).active).toBe(true);
  });
  it('cleanup closes only temporary agent tabs and preserves user tabs and retained outputs', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    const scratch = await f.execute('a', 'tabs.open', { url: 'https://example.test/scratch' });
    const output = await f.execute('a', 'tabs.open', { url: 'https://example.test/output' });
    const handoff = await f.execute('a', 'tabs.open', { url: 'https://example.test/login' });
    await f.execute('a', 'tabs.mark', { tabId: output.tabId, disposition: 'deliverable' });
    await f.execute('a', 'tabs.mark', { tabId: handoff.tabId, disposition: 'handoff' });
    const result = await f.execute('a', 'session.end');
    expect(result.closed).toEqual([scratch.tabId]); expect(result.released).toEqual([1]); expect(result.retained).toEqual([output.tabId, handoff.tabId]);
    expect([...f.tabs.keys()]).toEqual([1, output.tabId, handoff.tabId]); expect(f.controller.state.tabs).toEqual({});
    expect(f.pages.detach).toHaveBeenCalledTimes(4);
  });
  it('release keeps an agent tab open and allows another session to claim it', async () => {
    const f = fixture(); await f.start('a'); await f.start('b');
    const tab = await f.execute('a', 'tabs.open', { url: 'https://example.test/' });
    await f.execute('a', 'tabs.release', { tabId: tab.tabId });
    await f.execute('b', 'tabs.claim', { tabId: tab.tabId }); await f.execute('a', 'session.end');
    expect(f.tabs.has(tab.tabId)).toBe(true); expect(f.controller.state.tabs[tab.tabId].sessionId).toBe('b');
  });
  it('retains ownership if group creation fails, allowing later cleanup', async () => {
    const f = fixture(); await f.start(); f.chrome.tabs.group.mockRejectedValueOnce(new Error('Grouping unavailable'));
    const tab = await f.execute('a', 'tabs.open', { url: 'https://example.test/' });
    expect(tab.groupingWarning).toBe('Grouping unavailable');
    await f.execute('a', 'session.end'); expect(f.tabs.has(tab.tabId)).toBe(false);
  });
  it('persists and restores ownership across worker restarts', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    const restored = new BrowserController(f.chrome, f.pages); restored.restore(f.save.mock.calls.at(-1)[0]);
    await expect(restored.execute({ type: 'command', id: 'restored', sessionId: 'b', operation: 'session.start', args: { name: 'Another task' } })).resolves.toBeDefined();
    await expect(restored.execute({ type: 'command', id: 'claim', sessionId: 'b', operation: 'tabs.claim', args: { tabId: 1 } })).rejects.toMatchObject({ code: 'TAB_BUSY' });
    // A fresh browser run starts from empty storage.session, not persisted tab IDs.
    expect(new BrowserController(f.chrome, f.pages).state.tabs).toEqual({});
  });
  it('stops an in-progress wait and prevents a stopped session from being resurrected', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    let entered; const began = new Promise(resolve => { entered = resolve; });
    f.pages.execute.mockImplementation(async (_tab, _op, _args, assertOwned) => { entered(); await new Promise(resolve => setTimeout(resolve, 5)); assertOwned(); });
    const pending = f.execute('a', 'page.wait', { tabId: 1 }); await began;
    const stopped = f.controller.stop('a');
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_STOPPED' }); await stopped;
    expect(f.tabs.has(1)).toBe(true);
    await expect(f.start()).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await expect(f.execute('a', 'tabs.list')).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await expect(f.execute('new-session', 'tabs.list')).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
  });
  it('pauses action on disconnect without losing ownership needed for reconnect', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 }); f.controller.paused = true;
    await expect(f.execute('a', 'page.fill', { tabId: 1, selector: 'input', text: 'value' })).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(f.controller.state.tabs[1].sessionId).toBe('a'); f.controller.paused = false;
    await expect(f.execute('a', 'page.snapshot', { tabId: 1 })).resolves.toEqual({ ok: true });
  });
  it('does not revive old queued commands after the bridge reconnects', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    let release; let entered; const began = new Promise(resolve => { entered = resolve; });
    f.pages.execute.mockImplementation(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const first = f.execute('a', 'page.snapshot', { tabId: 1 }); await began;
    const queued = f.execute('a', 'tabs.navigate', { tabId: 1, url: 'https://example.test/stale-command' });
    const rejected = expect(queued).rejects.toMatchObject({ code: 'DISCONNECTED' });
    f.controller.suspend(); f.controller.paused = false; release({}); await first; await rejected;
    expect(f.chrome.tabs.update).not.toHaveBeenCalled();
  });
  it('checks command expiration inside the queue before a delayed mutation starts', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    let release; let entered; const began = new Promise(resolve => { entered = resolve; });
    f.pages.execute.mockImplementation(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const first = f.execute('a', 'page.snapshot', { tabId: 1 }); await began;
    const expired = f.controller.execute({ type: 'command', id: 'expired', sessionId: 'a', operation: 'tabs.close', args: { tabId: 1 }, deadlineMs: Date.now() - 1 });
    const rejected = expect(expired).rejects.toMatchObject({ code: 'COMMAND_EXPIRED' }); release({}); await first; await rejected;
    expect(f.chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it.each(['tabs.navigate', 'tabs.show', 'tabs.claim'])('revokes %s while Chrome is resolving the tab', async operation => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    const get = f.chrome.tabs.get.getMockImplementation();
    f.chrome.tabs.get.mockImplementation(async id => { const tab = await get(id); f.controller.suspend(); f.controller.paused = false; return tab; });
    await expect(f.execute('a', operation, { tabId: 1, url: 'https://example.test/revoked' })).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(f.chrome.tabs.update).not.toHaveBeenCalled(); expect(f.chrome.windows.update).not.toHaveBeenCalled();
  });
  it('does not focus a window after Stop interrupts a tab-show operation', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    let stopped;
    f.chrome.tabs.update.mockImplementation(async id => { stopped = f.controller.stop('a'); return f.tabs.get(id); });
    await expect(f.execute('a', 'tabs.show', { tabId: 1 })).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await stopped; expect(f.chrome.windows.update).not.toHaveBeenCalled(); expect(f.tabs.has(1)).toBe(true);
  });
  it('does not group a new tab after disconnect, but retains its cleanup ownership', async () => {
    const f = fixture(); await f.start(); const create = f.chrome.tabs.create.getMockImplementation();
    f.chrome.tabs.create.mockImplementation(async props => { const tab = await create(props); f.controller.suspend(); return tab; });
    const opened = await f.execute('a', 'tabs.open', { url: 'https://example.test/' });
    expect(opened.groupingWarning).toBeTruthy(); expect(f.chrome.tabs.group).not.toHaveBeenCalled();
    f.controller.paused = false;
    expect((await f.execute('a', 'session.end')).closed).toContain(opened.tabId);
  });
  it.each(['toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'])('requires a real started session for inherited name %s', async sessionId => {
    const f = fixture();
    await expect(f.execute(sessionId, 'tabs.claim', { tabId: 1 })).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    await f.start(sessionId); await f.execute(sessionId, 'tabs.claim', { tabId: 1 });
    expect(Object.hasOwn(f.controller.state.sessions, sessionId)).toBe(true);
    await f.controller.stop(); expect(f.controller.state.tabs).toEqual({});
  });
  it('does not attribute a download when an unowned user tab shares the same initiating URL', async () => {
    const f = fixture(); await f.start(); await f.execute('a', 'tabs.claim', { tabId: 1 });
    f.tabs.set(2, { id: 2, url: f.tabs.get(1).url });
    await f.controller.downloaded({ id: 99, referrer: f.tabs.get(1).url });
    expect(await f.execute('a', 'downloads.list')).toEqual([]);
  });

  it('bounds tab discovery and allows queries to find tabs beyond the first page', async () => {
    const f = fixture(); await f.start();
    for (let id = 2; id <= 200; id++) f.tabs.set(id, { id, windowId: 10, url: `https://example.test/${id}`, title: id === 200 ? 'Needle project' : 'Long title '.repeat(200) });
    const listing = await f.execute('a', 'tabs.list');
    expect(listing.truncated).toBe(true); expect(listing.total).toBe(200); expect(new TextEncoder().encode(JSON.stringify(listing)).length).toBeLessThan(80000);
    expect(await f.execute('a', 'tabs.list', { query: 'needle' })).toMatchObject({ tabs: [{ tabId: 200 }], total: 1, truncated: false });
  });
  it('does not expose unrelated or ambiguously attributed downloads', async () => {
    const f = fixture(); await f.start(); await f.controller.downloaded({ id: 10, referrer: 'https://example.test/account' });
    expect(await f.execute('a', 'downloads.list')).toEqual([]);
    await f.execute('a', 'tabs.claim', { tabId: 1 }); await f.controller.downloaded({ id: 11, referrer: 'https://example.test/account' });
    expect(await f.execute('a', 'downloads.list')).toMatchObject([{ id: 11 }]);
    await expect(f.execute('a', 'downloads.wait', { downloadId: 10 })).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_OWNED' });
  });
  it('rejects browser-internal URLs and malformed commands before creating tabs', async () => {
    const f = fixture(); await f.start();
    for (const url of ['chrome://settings', 'file:///private/data', 'javascript:alert(1)', ['https://', 'user', ':', 'pass', '@example.test/'].join('')]) await expect(f.execute('a', 'tabs.open', { url })).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' });
    for (const sessionId of ['__proto__', 'constructor', '']) await expect(f.execute(sessionId, 'session.start', { name: 'bad' })).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    expect(f.chrome.tabs.create).not.toHaveBeenCalled(); expect(() => webUrl('not a url')).toThrow();
  });
});

describe('page observations and stale references', () => {
  function pageFixture() {
    let loader = 'loader-1'; const commands = [];
    const chrome = {
      tabs: { get: vi.fn(async () => ({ id: 1, url: 'https://example.test/', title: 'Test' })) },
      debugger: {
        attach: vi.fn(async () => {}), detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async (_target, method, args) => {
          commands.push({ method, args });
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', url: 'https://example.test/', loaderId: loader } } };
          if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 50 }] };
          if (method === 'DOM.resolveNode') return { object: { objectId: 'node-50' } };
          if (method === 'Runtime.evaluate') return { result: { value: { ready: 'complete', url: 'https://example.test/' } } };
          if (method === 'Page.captureScreenshot') return { data: 'aW1hZ2U=' };
          return {};
        })
      }
    };
    return { chrome, pages: new PageAdapter(chrome), commands, changeLoader() { loader = 'loader-2'; } };
  }
  it('collects diagnostics only during attachment and reads them while a dialog is open', async () => {
    const f = pageFixture(); await f.pages.execute(1, 'page.snapshot', {});
    expect(f.commands.map(command => command.method)).toEqual(expect.arrayContaining(['Network.enable', 'Log.enable']));
    f.pages.event({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'warn', args: [{ type: 'string', value: 'fixture warning' }] });
    f.pages.event({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Review' });
    expect(await f.pages.execute(1, 'page.console', {})).toMatchObject({ entries: [{ text: 'fixture warning' }] });
    await f.pages.detach(1);
    expect(() => f.pages.diagnostics.read(1, 'console')).toThrow('Diagnostics starts');
    await f.pages.attach(1);
    expect(await f.pages.execute(1, 'page.console', {})).toMatchObject({ entries: [] });
  });
  it('keeps revocation guards installed while emulation commands are pending', async () => {
    const f = pageFixture(); await f.pages.attach(1);
    let release; let entered; let revoked = false;
    const barrier = new Promise(resolve => { entered = resolve; });
    const original = f.chrome.debugger.sendCommand.getMockImplementation();
    f.chrome.debugger.sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'Emulation.setDeviceMetricsOverride') {
        entered(); return new Promise(resolve => { release = resolve; });
      }
      return original(...args);
    });
    const guard = () => { if (revoked) throw new Error('Ownership revoked'); };
    const running = f.pages.execute(1, 'page.emulate', { viewport: { width: 500, height: 700 }, colorScheme: 'dark' }, guard);
    await barrier;
    expect(f.pages.guards.get(1)).toBe(guard);
    revoked = true; release({});
    await expect(running).rejects.toThrow('Ownership revoked');
    expect(f.commands.some(command => command.method === 'Emulation.setEmulatedMedia')).toBe(false);
    expect(f.pages.guards.has(1)).toBe(false);
  });
  it('restores emulated preferences during cleanup after ownership is revoked', async () => {
    const f = pageFixture();
    await f.pages.execute(1, 'page.emulate', { viewport: { width: 500, height: 700 }, colorScheme: 'dark' });
    f.pages.guards.set(1, () => { throw new Error('revoked'); });
    f.commands.length = 0;
    await f.pages.detach(1);
    expect(f.commands).toEqual(expect.arrayContaining([
      { method: 'Emulation.clearDeviceMetricsOverride', args: undefined },
      { method: 'Emulation.setEmulatedMedia', args: { features: [] } },
    ]));
    expect(f.pages.emulations.size).toBe(0); expect(f.chrome.debugger.detach).toHaveBeenCalled();
  });
  it('still detaches when restoring emulation receives no Chrome response', async () => {
    const f = pageFixture(); await f.pages.attach(1);
    f.pages.emulations.set(1, { colorScheme: 'dark' });
    f.chrome.debugger.sendCommand.mockImplementation(async () => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const cleanup = f.pages.detach(1);
      await vi.advanceTimersByTimeAsync(2000);
      await cleanup;
      expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
      expect(f.pages.emulations.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('rejects competing target mechanisms without resolving or acting on either', async () => {
    const f = pageFixture();
    await expect(f.pages.target(1, { selector: '#save', locator: { role: 'button', name: 'Save' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.commands).toEqual([]);
  });
  it('rejects a reference after navigation even without receiving an invalidation event', async () => {
    const f = pageFixture(); const snapshot = await f.pages.execute(1, 'page.snapshot', {});
    expect(snapshot.refs[0]).toMatchObject({ role: 'button', name: 'Save' }); f.changeLoader();
    await expect(f.pages.execute(1, 'page.click', { ref: snapshot.refs[0].ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(f.commands.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(false);
  });
  it('invalidates refs on document replacement and on debugger detach', async () => {
    const f = pageFixture(); const snapshot = await f.pages.execute(1, 'page.snapshot', {});
    f.pages.event({ tabId: 1 }, 'DOM.documentUpdated', {});
    await expect(f.pages.target(1, { ref: snapshot.refs[0].ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    await f.pages.execute(1, 'page.snapshot', {}); await f.pages.detach(1);
    expect(f.pages.snapshots.size).toBe(0); expect(f.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
  });
  it('captures the target page without any tab activation', async () => {
    const f = pageFixture(); expect(await f.pages.execute(1, 'page.screenshot', {})).toMatchObject({ mimeType: 'image/jpeg', data: 'aW1hZ2U=' });
    expect(f.commands.some(command => command.method === 'Page.bringToFront')).toBe(false);
  });
  it('supports load readiness waits without requiring an element selector', async () => {
    const f = pageFixture(); expect(await f.pages.execute(1, 'page.wait', { loadState: 'load', url: 'https://example.test/' })).toEqual({ ready: true, url: 'https://example.test/' });
  });
  it('bounds very large accessibility observations and reports truncation', async () => {
    const f = pageFixture(); const original = f.chrome.debugger.sendCommand.getMockImplementation();
    f.chrome.debugger.sendCommand.mockImplementation(async (...args) => args[1] === 'Accessibility.getFullAXTree' ? { nodes: Array.from({ length: 1000 }, (_, index) => ({ role: { value: 'button' }, name: { value: '😀'.repeat(250) }, backendDOMNodeId: index + 1 })) } : original(...args));
    const result = await f.pages.execute(1, 'page.snapshot', {});
    expect(result.truncated).toBe(true); expect(result.refs.length).toBeLessThan(800); expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(80000);
  });
  it('does not click when the intended element is covered by an overlay', async () => {
    const f = pageFixture(); const original = f.chrome.debugger.sendCommand.getMockImplementation();
    f.chrome.debugger.sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'DOM.getContentQuads') return { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] };
      if (args[1] === 'Runtime.callFunctionOn') return { result: { value: false } };
      return original(...args);
    });
    const snapshot = await f.pages.execute(1, 'page.snapshot', {});
    await expect(f.pages.execute(1, 'page.click', { ref: snapshot.refs[0].ref })).rejects.toMatchObject({ code: 'ELEMENT_NOT_ACTIONABLE' });
    expect(f.commands.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(false);
  });
  it('exposes an open dialog without attempting a blocked page evaluation', async () => {
    const f = pageFixture(); await f.pages.attach(1); f.pages.event({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Review this' });
    f.commands.length = 0;
    expect(await f.pages.execute(1, 'page.snapshot', {})).toMatchObject({ dialog: { type: 'alert', message: 'Review this' }, refs: [] });
    expect(f.commands).toEqual([]);
  });
  it('returns from a click as soon as it opens a dialog, allowing a later dialog command', async () => {
    const f = pageFixture(); const original = f.chrome.debugger.sendCommand.getMockImplementation();
    f.chrome.debugger.sendCommand.mockImplementation(async (...args) => {
      if (args[1] === 'DOM.getContentQuads') return { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] };
      if (args[1] === 'Runtime.callFunctionOn') return { result: { value: { ok: true, x: 50, y: 25 } } };
      if (args[1] === 'Input.dispatchMouseEvent' && args[2].type === 'mouseReleased') {
        f.pages.event({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
        return new Promise(() => {});
      }
      if (args[1] === 'Page.handleJavaScriptDialog') { f.pages.event({ tabId: 1 }, 'Page.javascriptDialogClosed', {}); return {}; }
      return original(...args);
    });
    const snapshot = await f.pages.execute(1, 'page.snapshot', {});
    expect(await f.pages.execute(1, 'page.click', { ref: snapshot.refs[0].ref })).toEqual({ clicked: true, dialog: { type: 'confirm', message: 'Continue?' } });
    expect(await f.pages.execute(1, 'page.dialog', { accept: true })).toEqual({ handled: true });
    expect(f.pages.dialogs.size).toBe(0);
  });
  it('bounds stalled debugger calls so later dialog or Stop actions can proceed', async () => {
    vi.useFakeTimers();
    try {
      const f = pageFixture(); f.chrome.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));
      const action = f.pages.send(1, 'Runtime.evaluate', { expression: 'alert("test")' });
      const rejected = expect(action).rejects.toMatchObject({ code: 'CDP_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10001); await rejected;
    } finally { vi.useRealTimers(); }
  });
});
