import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { ACTIVITY_PREFIXES, TabIndicators, updateTitleIndicator } from '../extension/tab-indicators.js';
import { BrowserController } from '../extension/controller.js';

function documentFixture(title = 'Project') {
  let callback; const listeners = new Map();
  const document = { title, head: {}, documentElement: {} };
  const context = createContext({ document, Date, setInterval, clearInterval,
    MutationObserver: class { constructor(fn) { callback = fn; } observe() {} disconnect() { callback = undefined; } },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
  });
  const update = prefix => runInContext(`(${updateTitleIndicator.toString()})(${JSON.stringify(prefix)})`, context);
  return { document, update, mutate: value => { document.title = value; callback?.(); }, flush: () => callback?.(), listeners };
}
afterEach(() => vi.useRealTimers());

describe('tab title indicator document lifecycle', () => {
  it('changes phases without stacking markers and restores the latest site title', () => {
    vi.useFakeTimers(); const f = documentFixture();
    for (const prefix of Object.values(ACTIVITY_PREFIXES)) { f.update(prefix); f.flush(); expect(f.document.title).toBe(prefix + 'Project'); }
    f.mutate('Project (2 new messages)'); expect(f.document.title).toBe('🤖⏳ Project (2 new messages)');
    f.update(null); expect(f.document.title).toBe('Project (2 new messages)');
    f.mutate('Later'); expect(f.document.title).toBe('Later'); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves a site-owned robot prefix and title updates pending at release', () => {
    vi.useFakeTimers(); const f = documentFixture('🤖 Robot site');
    f.update('🤖 '); f.update('🤖🔎 '); f.update(null);
    expect(f.document.title).toBe('🤖 Robot site');
    f.update('🤖 '); f.document.title = 'New title before observer'; f.update(null);
    expect(f.document.title).toBe('New title before observer');
  });
  it('handles a site appending to the current title without preserving our prefix on release', () => {
    vi.useFakeTimers(); const f = documentFixture(); f.update('🤖 ');
    f.mutate(f.document.title + ' - Saved'); f.update('🤖🧪 ');
    expect(f.document.title).toBe('🤖🧪 Project - Saved'); f.update(null);
    expect(f.document.title).toBe('Project - Saved');
  });
  it('renews a single observer/lease and expires after an unexpected disconnect', () => {
    vi.useFakeTimers(); const f = documentFixture(); f.update('🤖 ');
    vi.advanceTimersByTime(40000); f.update('🤖🔎 ');
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(40000);
    expect(f.document.title).toBe('🤖🔎 Project'); vi.advanceTimersByTime(21000);
    expect(f.document.title).toBe('Project'); expect(vi.getTimerCount()).toBe(0); expect(f.listeners.size).toBe(0);
  });
  it('restores an expired marker when a frozen document resumes', () => {
    vi.useFakeTimers(); const f = documentFixture(); f.update('🤖 ');
    vi.setSystemTime(Date.now() + 61000); f.listeners.get('pageshow')(); expect(f.document.title).toBe('Project');
  });
});

describe('tab indicator ownership and cancellation', () => {
  function fixture() {
    const tabs = new Map([[1, { id: 1, url: 'https://example.test/', title: 'Page' }]]);
    const pages = { setActivity: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
    const controller = new BrowserController({ tabs: { get: async id => tabs.get(id) } }, pages);
    const run = (sessionId, operation, args = {}) => controller.execute({ type: 'command', id: 'test', sessionId, operation, args });
    return { pages, controller, run };
  }
  it('marks on claim, retains phases across repeated claims, and rejects foreign/invalid updates', async () => {
    const f = fixture(); await f.run('one', 'session.start', { name: 'Research' }); await f.run('two', 'session.start', { name: 'Other' });
    expect(await f.run('one', 'tabs.claim', { tabId: 1 })).toMatchObject({ indicatorVisible: true });
    expect(f.pages.setActivity.mock.calls.at(-1).slice(0, 2)).toEqual([1, 'active']);
    await f.run('one', 'tabs.activity', { tabId: 1, activity: 'researching' });
    await f.run('one', 'tabs.claim', { tabId: 1 });
    expect(f.pages.setActivity.mock.calls.at(-1).slice(0, 2)).toEqual([1, 'researching']);
    await expect(f.run('two', 'tabs.activity', { tabId: 1, activity: 'editing' })).rejects.toMatchObject({ code: 'TAB_NOT_OWNED' });
    for (const activity of ['__proto__', ['active'], {}, null]) await expect(f.run('one', 'tabs.activity', { tabId: 1, activity })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await f.run('one', 'tabs.release', { tabId: 1 }); await f.controller.refreshIndicators(1);
    await f.run('two', 'tabs.claim', { tabId: 1 }); expect(f.pages.setActivity.mock.calls.at(-1).slice(0, 2)).toEqual([1, 'active']);
  });
  it('reports cosmetic failures without abandoning ownership or reviving stopped work', async () => {
    const f = fixture(); await f.run('one', 'session.start', { name: 'Research' });
    f.pages.setActivity.mockRejectedValue(new Error('Debugger unavailable'));
    expect(await f.run('one', 'tabs.claim', { tabId: 1 })).toMatchObject({ indicatorVisible: false, indicatorWarning: 'Debugger unavailable' });
    expect(f.controller.state.tabs[1].sessionId).toBe('one');
    await f.controller.stop('one'); f.pages.setActivity.mockClear(); await f.controller.refreshIndicators();
    expect(f.pages.setActivity).not.toHaveBeenCalled(); expect(f.pages.detach).toHaveBeenCalled();
  });
  it('does not install an indicator when detachment races debugger attachment', async () => {
    let resume; const attach = new Promise(resolve => { resume = resolve; });
    const adapter = { attach: () => attach, rawSend: vi.fn(), chrome: { debugger: { sendCommand: vi.fn() } } };
    const indicators = new TabIndicators(adapter);
    const pending = indicators.set(1, 'active', () => {}); const rejected = expect(pending).rejects.toThrow('cancelled');
    await indicators.clear(1); resume(); await rejected; expect(adapter.rawSend).not.toHaveBeenCalled();
  });
});
