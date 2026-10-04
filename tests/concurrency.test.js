import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserController } from '../extension/controller.js';

afterEach(() => vi.useRealTimers());
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture() {
  const tabs = new Map([1, 2, 3].map(id => [id, { id, windowId: 10, groupId: -1, url: `https://example.test/${id}`, active: id === 3 }]));
  const groups = new Map(); let nextTab = 100; let nextGroup = 10;
  const chrome = {
    tabs: {
      get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('Missing tab'); return { ...tabs.get(id) }; }),
      query: vi.fn(async filter => [...tabs.values()].filter(tab => Object.entries(filter).every(([key, value]) => tab[key] === value)).map(tab => ({ ...tab }))),
      create: vi.fn(async properties => { const tab = { id: nextTab++, windowId: 10, groupId: -1, ...properties }; tabs.set(tab.id, tab); return { ...tab }; }),
      update: vi.fn(async (id, properties) => Object.assign(tabs.get(id), properties)),
      remove: vi.fn(async id => { if (!tabs.delete(id)) throw new Error('Missing tab'); }),
      group: vi.fn(async ({ tabIds, groupId = nextGroup++ }) => { if (!groups.has(groupId)) groups.set(groupId, { id: groupId }); for (const id of tabIds) tabs.get(id).groupId = groupId; return groupId; }),
    },
    tabGroups: { get: vi.fn(async id => groups.get(id)), update: vi.fn(async (id, properties) => Object.assign(groups.get(id), properties)) },
    windows: { update: vi.fn(async () => ({})), getLastFocused: vi.fn(async () => ({ id: 10, focused: true })) },
  };
  const pages = { execute: vi.fn(async () => ({ observed: true })), detach: vi.fn(async () => {}), invalidate: vi.fn() };
  const controller = new BrowserController(chrome, pages); let sequence = 0;
  const run = (sessionId, operation, args = {}, deadlineMs) => controller.execute({ type: 'command', id: String(++sequence), sessionId, operation, args, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
  const start = async (sessionId, tabIds = []) => { await run(sessionId, 'session.start', { name: sessionId }); for (const tabId of tabIds) await run(sessionId, 'tabs.claim', { tabId }); };
  return { tabs, groups, chrome, pages, controller, run, start };
}

describe('per-tab scheduling and session barriers', () => {
  it.each(['same session', 'different sessions'])('runs another tab while the first waits (%s)', async kind => {
    const f = fixture(); const other = kind === 'same session' ? 'a' : 'b';
    await f.start('a', kind === 'same session' ? [1, 2] : [1]);
    if (other === 'b') await f.start('b', [2]);
    const entered = deferred(); const release = deferred(); let completed = false;
    f.pages.execute.mockImplementation(async tabId => { if (tabId === 1) { entered.resolve(); await release.promise; completed = true; } return { tabId }; });
    const first = f.run('a', 'page.wait', { tabId: 1 }); await entered.promise;
    expect(await f.run(other, 'page.snapshot', { tabId: 2 })).toEqual({ tabId: 2 });
    expect(completed).toBe(false);
    release.resolve(); await first;
  });

  it('serializes operations for the same tab without blocking another tab', async () => {
    const f = fixture(); await f.start('a', [1, 2]);
    const entered = deferred(); const release = deferred(); const calls = [];
    f.pages.execute.mockImplementation(async (tabId, operation) => { calls.push(`${tabId}:${operation}`); if (tabId === 1 && operation === 'page.wait') { entered.resolve(); await release.promise; } return {}; });
    const first = f.run('a', 'page.wait', { tabId: 1 }); await entered.promise;
    const queued = f.run('a', 'page.fill', { tabId: 1, selector: 'input', text: 'next' });
    await f.run('a', 'page.snapshot', { tabId: 2 });
    expect(calls).toEqual(['1:page.wait', '2:page.snapshot']);
    release.resolve(); await Promise.all([first, queued]);
    expect(calls).toEqual(['1:page.wait', '2:page.snapshot', '1:page.fill']);
  });

  it('opens independent tabs during a same-session wait and reuses one task group', async () => {
    const f = fixture(); await f.start('a', [1]);
    const entered = deferred(); const release = deferred();
    f.pages.execute.mockImplementation(async () => { entered.resolve(); await release.promise; return {}; });
    const waiting = f.run('a', 'page.wait', { tabId: 1 }); await entered.promise;
    const opened = await Promise.all([f.run('a', 'tabs.open', { url: 'https://example.test/new-one' }), f.run('a', 'tabs.open', { url: 'https://example.test/new-two' })]);
    expect(opened.map(tab => tab.tabId)).toEqual([100, 101]);
    expect(opened[0].groupId).toBe(opened[1].groupId); expect(f.groups.size).toBe(1);
    release.resolve(); await waiting;
  });

  it('keeps the tab limit atomic when independent open requests arrive together', async () => {
    const f = fixture(); await f.start('a', [1]);
    for (let tabId = 2; tabId <= 99; tabId++) f.controller.state.tabs[tabId] = { sessionId: 'a', created: false, disposition: 'temporary' };
    const results = await Promise.allSettled([f.run('a', 'tabs.open', { url: 'https://example.test/last' }), f.run('a', 'tabs.open', { url: 'https://example.test/excess' })]);
    expect(results[0].status).toBe('fulfilled'); expect(results[1].reason.code).toBe('TAB_LIMIT');
    expect(f.chrome.tabs.create).toHaveBeenCalledTimes(1); expect(Object.keys(f.controller.state.tabs)).toHaveLength(100);
  });

  it('keeps competing claims atomic even when resolving the first tab is slow', async () => {
    const f = fixture(); await f.start('a'); await f.start('b');
    const entered = deferred(); const release = deferred(); const get = f.chrome.tabs.get.getMockImplementation();
    f.chrome.tabs.get.mockImplementation(async id => { if (id === 1) { entered.resolve(); await release.promise; } return get(id); });
    const first = f.run('a', 'tabs.claim', { tabId: 1 }); await entered.promise;
    const competing = f.run('b', 'tabs.claim', { tabId: 1 });
    const rejected = expect(competing).rejects.toMatchObject({ code: 'TAB_BUSY' });
    await f.run('b', 'tabs.claim', { tabId: 2 });
    expect(f.chrome.tabs.get.mock.calls.filter(([id]) => id === 1)).toHaveLength(1);
    release.resolve(); await first; await rejected;
    expect(f.controller.state.tabs[1].sessionId).toBe('a');
  });

  it('does not let a discovered new tab be claimed while its creation is still completing', async () => {
    const f = fixture(); await f.start('a'); await f.start('b');
    const created = deferred(); const release = deferred(); const create = f.chrome.tabs.create.getMockImplementation();
    f.chrome.tabs.create.mockImplementation(async properties => { const tab = await create(properties); created.resolve(tab); await release.promise; return tab; });
    const opened = f.run('a', 'tabs.open', { url: 'https://example.test/created' });
    const tab = await created.promise;
    const claimed = f.run('b', 'tabs.claim', { tabId: tab.id }); const rejected = expect(claimed).rejects.toMatchObject({ code: 'TAB_BUSY' });
    release.resolve(); await opened; await rejected;
    expect(f.controller.state.tabs[tab.id]).toMatchObject({ sessionId: 'a', created: true });
  });

  it('locks tabs created by an earlier in-flight open for the entire cleanup barrier', async () => {
    const f = fixture(); await f.start('a'); await f.start('b');
    const created = deferred(); const createRelease = deferred(); const create = f.chrome.tabs.create.getMockImplementation();
    const cleaning = deferred(); const cleanupRelease = deferred();
    f.chrome.tabs.create.mockImplementation(async properties => { const tab = await create(properties); created.resolve(tab); await createRelease.promise; return tab; });
    f.pages.detach.mockImplementation(async tabId => { if (tabId === 100) { cleaning.resolve(); await cleanupRelease.promise; } });
    const opened = f.run('a', 'tabs.open', { url: 'https://example.test/new' }); await created.promise;
    const finish = f.run('a', 'session.end');
    createRelease.resolve(); await opened; await cleaning.promise;
    const callsBeforeClaim = f.chrome.tabs.get.mock.calls.length;
    const competing = f.run('b', 'tabs.claim', { tabId: 100 }); const gone = expect(competing).rejects.toThrow('Missing tab');
    await f.run('b', 'tabs.list');
    expect(f.chrome.tabs.get).toHaveBeenCalledTimes(callsBeforeClaim);
    cleanupRelease.resolve(); expect(await finish).toMatchObject({ closed: [100] }); await gone;
    expect(f.controller.state.tabs[100]).toBeUndefined();
  });

  it('finishes only after its own tab work drains, without waiting for another session', async () => {
    const f = fixture(); await f.start('a', [1, 2]); await f.start('b', [3]);
    const entered = new Map([1, 2, 3].map(id => [id, deferred()])); const release = new Map([1, 2, 3].map(id => [id, deferred()]));
    f.pages.execute.mockImplementation(async tabId => { entered.get(tabId).resolve(); await release.get(tabId).promise; return {}; });
    const running = [f.run('a', 'page.wait', { tabId: 1 }), f.run('a', 'page.wait', { tabId: 2 }), f.run('b', 'page.wait', { tabId: 3 })];
    await Promise.all([...entered.values()].map(value => value.promise));
    let ended = false;
    const finish = f.run('a', 'session.end').then(value => { ended = true; return value; });
    const later = f.run('a', 'page.snapshot', { tabId: 1 }); const inactive = expect(later).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    release.get(1).resolve(); await running[0]; await f.run('b', 'tabs.list');
    expect(ended).toBe(false); expect(f.pages.detach).not.toHaveBeenCalled();
    release.get(2).resolve(); await running[1];
    expect(await finish).toMatchObject({ released: [1, 2] }); await inactive;
    expect(f.controller.state.tabs[3]).toMatchObject({ sessionId: 'b' });
    expect(f.pages.detach.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    release.get(3).resolve(); await running[2];
  });

  it.each(['session.start', 'groups.update'])('holds later same-session work behind a %s barrier', async operation => {
    const f = fixture(); await f.start('a', [1, 2]); await f.start('b', [3]);
    const entered = deferred(); const release = deferred(); const calls = [];
    f.pages.execute.mockImplementation(async tabId => { calls.push(tabId); if (tabId === 1) { entered.resolve(); await release.promise; } return {}; });
    const waiting = f.run('a', 'page.wait', { tabId: 1 }); await entered.promise;
    const barrier = f.run('a', operation, operation === 'session.start' ? { name: 'Renamed' } : { title: 'New group title' });
    const later = f.run('a', 'page.snapshot', { tabId: 2 });
    await f.run('b', 'page.snapshot', { tabId: 3 }); expect(calls).toEqual([1, 3]);
    release.resolve(); await Promise.all([waiting, barrier, later]); expect(calls).toEqual([1, 3, 2]);
  });

  it('stops one session immediately and drains it without interrupting another tab wait', async () => {
    const f = fixture(); await f.start('a', [1]); await f.start('b', [2]);
    const entered = new Map([1, 2].map(id => [id, deferred()])); const release = new Map([1, 2].map(id => [id, deferred()])); let bFinished = false;
    f.pages.execute.mockImplementation(async (tabId, _operation, _args, guard) => { entered.get(tabId).resolve(); await release.get(tabId).promise; guard(); if (tabId === 2) bFinished = true; return {}; });
    f.pages.detach.mockImplementation(async tabId => { if (tabId === 1) release.get(1).resolve(); });
    const first = f.run('a', 'page.wait', { tabId: 1 }); const stopped = expect(first).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    const second = f.run('b', 'page.wait', { tabId: 2 }); await Promise.all([...entered.values()].map(value => value.promise));
    await f.controller.stop('a'); await stopped;
    expect(bFinished).toBe(false); expect(f.controller.state.tabs[1]).toBeUndefined(); expect(f.controller.state.tabs[2].sessionId).toBe('b');
    expect(f.pages.detach.mock.calls.every(([id]) => id === 1)).toBe(true);
    release.get(2).resolve(); await second;
  });

  it('cancels a queued claim so Stop never waits for a foreign session to release its busy tab', async () => {
    const f = fixture(); await f.start('a', [1]); await f.start('b', [2]);
    const entered = deferred(); const release = deferred(); let bFinished = false;
    f.pages.execute.mockImplementation(async () => { entered.resolve(); await release.promise; bFinished = true; return {}; });
    const other = f.run('b', 'page.wait', { tabId: 2 }); await entered.promise;
    const queued = f.run('a', 'tabs.claim', { tabId: 2 }); const stopped = expect(queued).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await f.controller.stop('a'); await stopped;
    expect(bFinished).toBe(false); expect(f.controller.state.tabs[2].sessionId).toBe('b');
    release.resolve(); await other;
  });

  it('Stop All includes a just-submitted session start and prevents it from resurrecting', async () => {
    const f = fixture();
    const starting = f.run('new-task', 'session.start', { name: 'Pending startup' });
    const stopped = expect(starting).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await f.controller.stop(); await stopped;
    expect(f.controller.state.sessions['new-task']).toMatchObject({ stopped: true, ended: true });
    await expect(f.start('new-task')).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
  });

  it('rejects a queued mutation that expires while other tabs continue', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start('a', [1, 2]);
    const entered = deferred(); const release = deferred();
    f.pages.execute.mockImplementation(async tabId => { if (tabId === 1) { entered.resolve(); await release.promise; } return {}; });
    const waiting = f.run('a', 'page.wait', { tabId: 1 }); await entered.promise;
    const queued = f.run('a', 'tabs.navigate', { tabId: 1, url: 'https://example.test/expired' }, Date.now() + 100);
    const expired = expect(queued).rejects.toMatchObject({ code: 'COMMAND_EXPIRED' });
    await f.run('a', 'page.snapshot', { tabId: 2 }); vi.setSystemTime(Date.now() + 200);
    release.resolve(); await waiting; await expired; expect(f.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('removes queued old-generation work on disconnect and accepts only new work after reconnect', async () => {
    const f = fixture(); await f.start('a', [1]);
    const entered = deferred(); const release = deferred();
    f.pages.execute.mockImplementation(async () => { entered.resolve(); await release.promise; return {}; });
    const first = f.run('a', 'page.wait', { tabId: 1 }); await entered.promise;
    const old = f.run('a', 'tabs.navigate', { tabId: 1, url: 'https://example.test/old' }); const disconnected = expect(old).rejects.toMatchObject({ code: 'DISCONNECTED' });
    f.controller.suspend(); await disconnected; f.controller.paused = false;
    const fresh = f.run('a', 'tabs.navigate', { tabId: 1, url: 'https://example.test/fresh' });
    release.resolve(); await first; await fresh;
    expect(f.chrome.tabs.update.mock.calls).toEqual([[1, { url: 'https://example.test/fresh' }]]);
  });
});
