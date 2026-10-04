export const ACTIVITY_PREFIXES = Object.freeze({ active: '🤖 ', researching: '🤖🔎 ', editing: '🤖✍️ ', testing: '🤖🧪 ', waiting: '🤖⏳ ' });

// Runs only in our named isolated world in the top document. No page globals,
// prototype patches, all-site content scripts or future-navigation injection.
export function updateTitleIndicator(prefix) {
  const key = '__agentBrowserTabIndicator';
  let state = globalThis[key];
  if (prefix === null) { state?.stop(); return; }
  if (!document.head) return false;
  if (!state) {
    state = { prefix, base: document.title, rendered: undefined, expires: 0 };
    const capture = () => {
      const current = document.title;
      if (current !== state.rendered) state.base = state.rendered !== undefined && current.startsWith(state.prefix) ? current.slice(state.prefix.length) : current;
    };
    state.sync = () => {
      capture();
      state.rendered = state.prefix + state.base;
      if (document.title !== state.rendered) document.title = state.rendered;
    };
    state.stop = () => {
      capture(); state.observer.disconnect(); clearInterval(state.timer);
      removeEventListener('pageshow', state.resume);
      if (document.title === state.rendered || document.title.startsWith(state.prefix)) document.title = state.base;
      delete globalThis[key];
    };
    state.resume = () => { if (Date.now() >= state.expires) state.stop(); else state.sync(); };
    state.observer = new MutationObserver(state.resume);
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    // Fail closed after a worker/browser-bridge failure or unexpected debugger
    // detachment. Background/frozen pages clean up when their timers resume.
    state.timer = setInterval(() => { if (Date.now() >= state.expires) state.stop(); }, 1000);
    addEventListener('pageshow', state.resume);
    globalThis[key] = state;
  }
  state.expires = Date.now() + 60000;
  state.sync(); state.prefix = prefix; state.sync();
  return true;
}

const expression = prefix => `(${updateTitleIndicator.toString()})(${JSON.stringify(prefix)})`;

export class TabIndicators {
  constructor(adapter) { this.adapter = adapter; this.contexts = new Map(); this.epochs = new Map(); }
  forget(tabId) { this.contexts.delete(tabId); this.epochs.set(tabId, (this.epochs.get(tabId) || 0) + 1); }
  async set(tabId, activity, guard) {
    const epoch = this.epochs.get(tabId) || 0;
    const check = () => { guard(); if ((this.epochs.get(tabId) || 0) !== epoch) throw new Error('Tab indicator was cancelled.'); };
    check(); await this.adapter.attach(tabId); check();
    const { frameTree } = await this.adapter.rawSend({ tabId }, 'Page.getFrameTree'); check();
    if (!frameTree?.frame?.id) throw new Error('Tab document is not ready.');
    const { executionContextId } = await this.adapter.rawSend({ tabId }, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'agent-browser-tab-indicator' }); check();
    if (!Number.isInteger(executionContextId)) throw new Error('Tab indicator context is unavailable.');
    this.contexts.set(tabId, executionContextId);
    const result = await this.adapter.rawSend({ tabId }, 'Runtime.evaluate', { contextId: executionContextId, expression: expression(ACTIVITY_PREFIXES[activity]), returnByValue: true, timeout: 1000 });
    check();
    if (result.exceptionDetails || result.result?.value !== true) throw new Error('Tab indicator could not update this document.');
  }
  async clear(tabId) {
    const contextId = this.contexts.get(tabId); this.forget(tabId);
    if (contextId === undefined) return;
    let timer;
    try {
      // Fixed cleanup in our own isolated world must work after Stop/revocation.
      // Never attach to a new document just to clean up an old one.
      await Promise.race([
        this.adapter.chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { contextId, expression: expression(null), returnByValue: true, timeout: 1000 }),
        new Promise(resolve => { timer = setTimeout(resolve, 1200); }),
      ]);
    } catch { /* Closed/navigated/detached pages have no reachable old context. */ }
    finally { clearTimeout(timer); }
  }
}
