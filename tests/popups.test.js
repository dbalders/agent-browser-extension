import { describe, expect, it, vi } from 'vitest';
import { BrowserController } from '../extension/controller.js';
import { PageAdapter } from '../extension/pages.js';

function fixture() {
  const tabs = new Map([
    [1, { id: 1, windowId: 10, groupId: -1, url: 'https://source.test/', active: false }],
    [9, { id: 9, windowId: 10, groupId: -1, url: 'https://user.test/', active: true }],
  ]);
  const groups = new Map(); let nextGroup = 20; let focusedWindow = 10;
  const chrome = {
    tabs: {
      get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('No such tab'); return { ...tabs.get(id) }; }),
      query: vi.fn(async filter => [...tabs.values()].filter(tab => Object.entries(filter).every(([key, value]) => tab[key] === value)).map(tab => ({ ...tab }))),
      update: vi.fn(async (id, properties) => {
        const tab = tabs.get(id); if (!tab) throw new Error('No such tab');
        if (properties.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
        Object.assign(tab, properties); return { ...tab };
      }),
      remove: vi.fn(async id => { tabs.delete(id); }),
      group: vi.fn(async ({ tabIds, groupId = nextGroup++ }) => {
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId });
        for (const id of tabIds) tabs.get(id).groupId = groupId; return groupId;
      }),
    },
    tabGroups: { get: async id => { if (!groups.has(id)) throw new Error('Missing group'); return groups.get(id); }, update: vi.fn(async (id, properties) => Object.assign(groups.get(id), properties)) },
    windows: { getLastFocused: vi.fn(async () => ({ id: focusedWindow, focused: true })), update: vi.fn(async (id) => { focusedWindow = id; return { id, focused: true }; }) },
  };
  const pages = { execute: vi.fn(async () => ({ clicked: true })), detach: vi.fn(async () => {}), invalidate: vi.fn() };
  const save = vi.fn(async () => {}); const controller = new BrowserController(chrome, pages, save);
  const run = (operation, args = {}, sessionId = 'task') => controller.execute({ type: 'command', id: 'command', sessionId, operation, args });
  return { tabs, groups, chrome, pages, controller, run, save,
    action(fn) { pages.execute.mockImplementation(async (tabId, ...args) => { pages.beforeMutation?.(tabId); return fn(tabId, ...args); }); },
    async start() { await run('session.start', { name: 'Popup research' }); await run('tabs.claim', { tabId: 1 }); },
    create(tabId = 2, properties = {}) {
      const tab = { id: tabId, windowId: 10, groupId: -1, url: 'https://destination.test/', active: true, ...properties };
      if (tab.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
      tabs.set(tabId, tab); focusedWindow = tab.windowId; return tab;
    },
    signal(url = 'https://destination.test/', sourceTabId = 1) { controller.windowOpened({ tabId: sourceTabId }, { url }); },
    target(tabId = 2, url = 'https://destination.test/', sourceTabId = 1) { controller.navigationTarget({ tabId, sourceTabId, url }); },
  };
}

describe('agent-action popup ownership', () => {
  it.each(['creation first', 'navigation first'])('owns middle-click tabs using matching Chrome events (%s)', async order => {
    const f = fixture(); await f.start();
    f.action(async () => {
      // Chrome may assign the selected user tab as openerTabId for a background
      // middle click. The navigation event identifies the actual source tab.
      const tab = f.create(2, { active: false, openerTabId: 9 });
      if (order === 'creation first') { f.controller.created(tab); f.target(); }
      else { f.target(); f.controller.created(tab); }
      return { clicked: true };
    });
    const result = await f.run('page.click', { tabId: 1, button: 'middle' });
    expect(result).toMatchObject({ openedTabs: [{ tabId: 2, createdByAgent: true, active: false, openerTabId: 1 }] });
    expect(f.tabs.get(9).active).toBe(true);
    expect(await f.run('session.end')).toMatchObject({ closed: [2], released: [1] });
    expect(f.tabs.has(9)).toBe(true);
  });

  it.each(['left click', 'wrong source', 'different URL', 'no creation', 'no navigation'])('does not adopt unrelated new tabs (%s)', async kind => {
    const f = fixture(); await f.start();
    f.action(async () => {
      const tab = f.create(2, { active: false });
      if (kind !== 'no creation') f.controller.created(tab);
      if (kind !== 'no navigation') f.target(2, kind === 'different URL' ? 'https://other.test/' : tab.url, kind === 'wrong source' ? 9 : 1);
      return { clicked: true };
    });
    expect(await f.run('page.click', { tabId: 1, button: kind === 'left click' ? 'left' : 'middle' })).not.toHaveProperty('openedTabs');
    await f.run('session.end'); expect(f.tabs.has(2)).toBe(true);
  });

  it.each(['same session', 'different sessions'])('correlates concurrent middle clicks to the same URL by tab identity (%s)', async kind => {
    const f = fixture(); await f.start();
    const other = kind === 'same session' ? 'task' : 'other';
    f.create(3, { active: false, url: 'https://second-source.test/' });
    if (other !== 'task') await f.run('session.start', { name: 'Other task' }, other);
    await f.run('tabs.claim', { tabId: 3 }, other);
    const pending = new Map(); let bothEntered;
    const entered = new Promise(resolve => { bothEntered = resolve; });
    f.action(tabId => new Promise(resolve => { pending.set(tabId, resolve); if (pending.size === 2) bothEntered(); }));
    const first = f.run('page.click', { tabId: 1, button: 'middle' });
    const second = f.run('page.click', { tabId: 3, button: 'middle' }, other);
    await entered;
    f.controller.created(f.create(2, { active: false, openerTabId: 9 }));
    f.controller.created(f.create(4, { active: false, openerTabId: 9 }));
    f.target(4, 'https://destination.test/', 3); f.target(2, 'https://destination.test/', 1);
    pending.get(1)({ clicked: true }); pending.get(3)({ clicked: true });
    expect(await first).toMatchObject({ openedTabs: [{ tabId: 2, openerTabId: 1, ownerSessionId: 'task' }] });
    expect(await second).toMatchObject({ openedTabs: [{ tabId: 4, openerTabId: 3, ownerSessionId: other }] });
    expect(f.tabs.get(9).active).toBe(true);
  });

  it.each(['tab', 'window'])('preserves the user focus baseline when a second action starts during another popup adoption (%s)', async kind => {
    const f = fixture(); await f.start(); f.create(3, { active: false, url: 'https://second-source.test/' });
    await f.run('tabs.claim', { tabId: 3 });
    let entered; let release; let secondOpened; let blocked = false;
    const adopting = new Promise(resolve => { entered = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const secondReady = new Promise(resolve => { secondOpened = resolve; });
    f.save.mockImplementation(async state => {
      if (state.tabs[2] && !blocked) { blocked = true; entered(); await resume; }
    });
    f.action(async tabId => {
      const popupId = tabId === 1 ? 2 : 4;
      f.create(popupId, kind === 'window' ? { windowId: tabId === 1 ? 11 : 12 } : {}); f.signal('https://destination.test/', tabId); f.target(popupId, 'https://destination.test/', tabId);
      if (tabId === 3) secondOpened();
      return {};
    });
    const first = f.run('page.click', { tabId: 1 }); await adopting;
    const second = f.run('page.click', { tabId: 3 }); await secondReady;
    release(); await Promise.all([first, second]);
    expect(f.tabs.get(9).active).toBe(true);
    if (kind === 'window') expect(f.chrome.windows.update).toHaveBeenLastCalledWith(10, { focused: true });
    else { expect(f.tabs.get(2).active).toBe(false); expect(f.tabs.get(4).active).toBe(false); }
  });
  it.each(['same session', 'different sessions'])('correlates simultaneous opener actions independently (%s)', async kind => {
    const f = fixture(); await f.start();
    const other = kind === 'same session' ? 'task' : 'other';
    f.create(3, { active: false, url: 'https://second-source.test/' });
    if (other !== 'task') await f.run('session.start', { name: 'Second task' }, other);
    await f.run('tabs.claim', { tabId: 3 }, other);
    const entered = new Map(); const release = new Map();
    for (const id of [1, 3]) { let ready; let done; const started = new Promise(resolve => { ready = resolve; }); const finished = new Promise(resolve => { done = resolve; }); entered.set(id, { started, ready }); release.set(id, { finished, done }); }
    f.action(async tabId => { entered.get(tabId).ready(); await release.get(tabId).finished; return { clicked: true }; });
    const first = f.run('page.click', { tabId: 1 }); const second = f.run('page.click', { tabId: 3 }, other);
    await Promise.all([...entered.values()].map(item => item.started));
    expect(f.controller.popupActions.size).toBe(2);
    f.create(2); f.create(4);
    f.signal('https://destination.test/', 1); f.target(4, 'https://destination.test/', 3);
    f.signal('https://destination.test/', 3); f.target(2, 'https://destination.test/', 1);
    release.get(1).done(); release.get(3).done();
    expect(await first).toMatchObject({ openedTabs: [{ tabId: 2, openerTabId: 1, ownerSessionId: 'task' }] });
    expect(await second).toMatchObject({ openedTabs: [{ tabId: 4, openerTabId: 3, ownerSessionId: other }] });
    expect(f.controller.popupActions.size).toBe(0);
    if (other === 'task') {
      expect(f.tabs.get(2).groupId).toBe(f.tabs.get(4).groupId);
      expect(await f.run('session.end')).toMatchObject({ closed: [2, 4] });
    } else {
      expect(f.tabs.get(2).groupId).not.toBe(f.tabs.get(4).groupId);
      expect(await f.run('session.end')).toMatchObject({ closed: [2] }); expect(f.tabs.has(4)).toBe(true);
      expect(await f.run('session.end', {}, other)).toMatchObject({ closed: [4] });
    }
  });

  it.each(['debugger-first', 'navigation-first'])('correlates both event orders, groups the popup, and restores the selected user tab (%s)', async order => {
    const f = fixture(); await f.start();
    f.action(async () => {
      f.create();
      if (order === 'debugger-first') { f.signal(); f.target(); } else { f.target(); f.signal(); }
      return { clicked: true };
    });
    const result = await f.run('page.click', { tabId: 1, selector: 'a[target="_blank"]' });
    expect(result).toMatchObject({ clicked: true, openedTabs: [{ tabId: 2, openerTabId: 1, ownerSessionId: 'task', createdByAgent: true, disposition: 'temporary', active: false }] });
    expect(f.tabs.get(9).active).toBe(true);
    expect(f.groups.get(f.tabs.get(2).groupId)).toMatchObject({ title: 'Popup research', color: 'blue', collapsed: true });
    expect(f.chrome.windows.update).not.toHaveBeenCalled();
    const end = await f.run('session.end');
    expect(end).toMatchObject({ closed: [2], released: [1] }); expect([...f.tabs.keys()]).toEqual([1, 9]);
  });

  it('handles a noopener child without tabs.openerTabId, and preserves a marked output', async () => {
    const f = fixture(); await f.start();
    f.action(async () => { f.create(); f.signal(); f.target(); return { json: 'null' }; });
    expect(await f.run('page.evaluate', { tabId: 1, expression: 'window.open(url,"_blank","noopener")' })).toMatchObject({ openedTabs: [{ tabId: 2 }] });
    await f.run('tabs.mark', { tabId: 2, disposition: 'handoff' });
    expect(await f.run('session.end')).toMatchObject({ closed: [], retained: [2] }); expect(f.tabs.has(2)).toBe(true);
  });

  it('can discover and use an attributed blank popup without allowing unrelated blank or internal tabs', async () => {
    const f = fixture(); await f.start();
    f.action(async () => { f.create(2, { url: 'about:blank' }); f.signal(''); f.target(2, 'about:blank'); return {}; });
    expect(await f.run('page.click', { tabId: 1 })).toMatchObject({ openedTabs: [{ tabId: 2, url: 'about:blank' }] });
    expect((await f.run('tabs.list')).tabs.map(tab => tab.tabId)).toContain(2);
    f.pages.execute.mockResolvedValue({ refs: [{ name: 'Popup content' }] });
    expect(await f.run('page.snapshot', { tabId: 2 })).toMatchObject({ refs: [{ name: 'Popup content' }] });
    f.create(3, { url: 'about:blank' });
    await expect(f.run('tabs.claim', { tabId: 3 })).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' });
    expect((await f.run('tabs.list')).tabs.map(tab => tab.tabId)).not.toContain(3);
    f.tabs.get(2).pendingUrl = 'chrome://settings/';
    await expect(f.run('page.snapshot', { tabId: 2 })).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' });
    delete f.tabs.get(2).pendingUrl;
    await f.run('tabs.navigate', { tabId: 2, url: 'https://destination.test/' });
    expect(f.tabs.get(2).url).toBe('https://destination.test/');
    expect(await f.run('session.end')).toMatchObject({ closed: [2], released: [1] });
    expect(f.tabs.has(3)).toBe(true);
  });

  it('captures an opener origin before navigation and passes it through nested blank popups', async () => {
    const f = fixture(); await f.start();
    f.action(async sourceTabId => {
      const tabId = sourceTabId === 1 ? 2 : 4;
      if (sourceTabId === 1) f.tabs.get(1).url = 'https://later-origin.test/';
      f.create(tabId, { url: 'about:blank' }); f.signal('about:blank', sourceTabId); f.target(tabId, 'about:blank', sourceTabId); return {};
    });
    await f.run('page.click', { tabId: 1 });
    expect(f.controller.state.tabs[2]).toMatchObject({ openerTabId: 1, openerOrigin: 'https://source.test' });
    await f.run('page.click', { tabId: 2 });
    expect(f.controller.state.tabs[4]).toMatchObject({ openerTabId: 2, openerOrigin: 'https://source.test' });
  });

  it('does not claim a user tab merely because its opener is owned, or because the URL matches', async () => {
    const f = fixture(); await f.start();
    f.create(2, { openerTabId: 1 }); f.target(); f.signal();
    f.action(async () => {
      f.create(3, { openerTabId: 1 }); f.target(3);
      f.create(4); f.signal('https://destination.test/', 9); f.target(4, 'https://destination.test/', 9);
      f.create(5, { url: 'https://other.test/' }); f.signal('https://unmatched.test/'); f.target(5, 'https://other.test/');
      return {};
    });
    expect(await f.run('page.click', { tabId: 1 })).toEqual({});
    expect(Object.keys(f.controller.state.tabs)).toEqual(['1']);
    await f.run('session.end'); expect([...f.tabs.keys()]).toEqual([1, 9, 2, 3, 4, 5]);
  });

  it('never claims pre-existing named windows or targets already owned by another task', async () => {
    const f = fixture(); await f.start(); f.create(2, { active: false });
    await f.run('session.start', { name: 'Other' }, 'other'); await f.run('tabs.claim', { tabId: 2 }, 'other');
    f.action(async () => { f.signal(); f.target(); return {}; });
    expect(await f.run('page.press', { tabId: 1, key: 'Enter' })).toEqual({});
    expect(f.controller.state.tabs[2]).toMatchObject({ sessionId: 'other', created: false });
    expect(f.chrome.tabs.group).not.toHaveBeenCalled();
  });

  it('allows a short cross-API event drain, then stops observing the opener', async () => {
    const f = fixture(); await f.start();
    f.action(async () => {
      f.create(); f.signal(); setTimeout(() => f.target(), 10); return {};
    });
    expect(await f.run('page.click', { tabId: 1 })).toMatchObject({ openedTabs: [{ tabId: 2 }] });
    f.create(3); f.signal(); f.target(3);
    expect(f.controller.state.tabs[3]).toBeUndefined(); expect(f.controller.popupActions.size).toBe(0);
  });

  it('does not attribute popups during read-only page operations', async () => {
    const f = fixture(); await f.start();
    f.action(async () => { f.create(); f.signal(); f.target(); return { refs: [] }; });
    expect(await f.run('page.snapshot', { tabId: 1 })).toEqual({ refs: [] });
    expect(f.controller.state.tabs[2]).toBeUndefined();
  });

  it('ignores same-source popups during target resolution before the actual mutation is armed', async () => {
    const f = fixture(); await f.start();
    f.pages.execute.mockImplementation(async tabId => {
      f.create(2); f.signal(); f.target(2);
      f.pages.beforeMutation(tabId);
      f.create(3, { url: 'https://agent-opened.test/' }); f.signal('https://agent-opened.test/'); f.target(3, 'https://agent-opened.test/');
      return {};
    });
    expect(await f.run('page.click', { tabId: 1 })).toMatchObject({ openedTabs: [{ tabId: 3 }] });
    expect(f.controller.state.tabs[2]).toBeUndefined();
  });

  it('arms PageAdapter only at mouse/key mutations or explicit evaluate, never internal page evaluation', async () => {
    const chrome = { debugger: { sendCommand: vi.fn(async () => ({ result: { value: null } })) } };
    const pages = new PageAdapter(chrome); pages.beforeMutation = vi.fn(); pages.attach = async () => {};
    await pages.send(1, 'Runtime.evaluate', { expression: 'document.querySelector("a")' });
    await pages.sendInput(1, 'Input.dispatchMouseEvent', { type: 'mouseMoved' });
    expect(pages.beforeMutation).not.toHaveBeenCalled();
    pages.dialogs.set(1, { type: 'alert' });
    await expect(pages.sendInput(1, 'Input.dispatchMouseEvent', { type: 'mousePressed' })).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
    expect(pages.beforeMutation).not.toHaveBeenCalled(); pages.dialogs.clear();
    await pages.sendInput(1, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
    await pages.sendInput(1, 'Input.dispatchKeyEvent', { type: 'rawKeyDown' });
    await pages.runOperation(1, 'page.evaluate', { expression: 'window.open("https://example.test/")' });
    expect(pages.beforeMutation.mock.calls).toEqual([[1], [1], [1]]);
  });

  it('waits briefly if a new navigation target reaches the worker before its tab is queryable', async () => {
    const f = fixture(); await f.start(); const get = f.chrome.tabs.get.getMockImplementation(); let pending = true;
    f.chrome.tabs.get.mockImplementation(async id => { if (id === 2 && pending) { pending = false; throw new Error('Tab creation pending'); } return get(id); });
    f.action(async () => { f.create(); f.signal(); f.target(); return {}; });
    expect(await f.run('page.click', { tabId: 1 })).toMatchObject({ openedTabs: [{ tabId: 2 }] });
  });

  it('preserves an independent user tab selection made while the action opens a child', async () => {
    const f = fixture(); await f.start();
    f.action(async () => {
      f.create(); f.signal(); f.target();
      f.create(8, { url: 'https://independent-user.test/' }); return {};
    });
    await f.run('page.click', { tabId: 1 });
    expect(f.tabs.get(8).active).toBe(true); expect(f.chrome.tabs.update).not.toHaveBeenCalled();
    expect(f.controller.state.tabs[8]).toBeUndefined();
  });

  it('restores a Chrome window only when an attributed new popup window took its focus', async () => {
    const f = fixture(); await f.start();
    f.action(async () => { f.create(2, { windowId: 11 }); f.signal(); f.target(); return {}; });
    await f.run('page.click', { tabId: 1 });
    expect(f.chrome.windows.update).toHaveBeenCalledWith(10, { focused: true });
  });

  it('keeps cleanup ownership if grouping fails or the originating page action later throws', async () => {
    const f = fixture(); await f.start(); f.chrome.tabs.group.mockRejectedValueOnce(new Error('This is a popup window'));
    f.action(async () => { f.create(); f.signal(); f.target(); return {}; });
    expect(await f.run('page.click', { tabId: 1 })).toMatchObject({ openedTabs: [{ tabId: 2, groupingWarning: 'This is a popup window' }] });
    f.action(async () => { f.create(3); f.signal(); f.target(3); throw new Error('Action failed after opening'); });
    await expect(f.run('page.evaluate', { tabId: 1, expression: 'window.open(url);throw new Error()' })).rejects.toThrow('Action failed after opening');
    expect(await f.run('session.end')).toMatchObject({ closed: [2, 3] });
  });

  it('retains cleanup bookkeeping for a matched popup if disconnect interrupts its tab lookup', async () => {
    const f = fixture(); await f.start(); const get = f.chrome.tabs.get.getMockImplementation();
    f.chrome.tabs.get.mockImplementation(async id => { if (id === 2) f.controller.suspend(); return get(id); });
    f.action(async () => { f.create(); f.signal(); f.target(); return {}; });
    await f.run('page.click', { tabId: 1 });
    expect(f.controller.state.tabs[2]).toMatchObject({ sessionId: 'task', created: true }); expect(f.chrome.tabs.group).not.toHaveBeenCalled(); expect(f.chrome.tabs.update).not.toHaveBeenCalled();
    f.controller.paused = false; f.create(3); f.signal(); f.target(3); expect(f.controller.state.tabs[3]).toBeUndefined();
    expect(await f.run('session.end')).toMatchObject({ closed: [2] });
  });

  it('cleans a matched popup if the user stops while its new tab is becoming available', async () => {
    const f = fixture(); await f.start(); const get = f.chrome.tabs.get.getMockImplementation(); let stopped;
    f.chrome.tabs.get.mockImplementation(async id => { if (id === 2 && !stopped) stopped = f.controller.stop('task'); return get(id); });
    f.action(async () => { f.create(); f.signal(); f.target(); return {}; });
    await f.run('page.click', { tabId: 1 }); await stopped;
    expect(f.tabs.has(2)).toBe(false); expect(f.tabs.has(1)).toBe(true);
    expect(f.chrome.tabs.group).not.toHaveBeenCalled(); expect(f.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('does not accept new popup evidence after the user stops the task', async () => {
    const f = fixture(); await f.start(); let stopped;
    f.action(async () => { stopped = f.controller.stop('task'); f.create(); f.signal(); f.target(); return {}; });
    await f.run('page.click', { tabId: 1 }); await stopped;
    expect(f.controller.state.tabs[2]).toBeUndefined(); expect(f.tabs.has(2)).toBe(true); expect(f.chrome.tabs.group).not.toHaveBeenCalled();
  });
});
