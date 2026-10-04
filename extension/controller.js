import { ACTIVITY_PREFIXES } from './tab-indicators.js';

export class BrowserFault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new BrowserFault(code, message); };
const colors = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const popupOperations = new Set(['page.click', 'page.check', 'page.press', 'page.evaluate']);
const popupUrl = value => { try { return value === '' || value === 'about:blank' ? 'about:blank' : webUrl(value); } catch { return undefined; } };
export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) fail('INVALID_ARGUMENT', 'A valid HTTP or HTTPS URL is required.');
  let url; try { url = new URL(value); } catch { fail('INVALID_ARGUMENT', 'A valid HTTP or HTTPS URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('UNSUPPORTED_URL', 'Only HTTP and HTTPS pages without embedded credentials are supported.');
  return url.href;
}
function tabNumber(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_ARGUMENT', 'tabId must be a nonnegative integer.');
  return value;
}
function title(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', 'A session or group name is required.');
  return value.trim().slice(0, 80);
}
export class BrowserController {
  constructor(chromeApi, pages, save = async () => {}) {
    this.chrome = chromeApi; this.pages = pages; this.save = save;
    this.state = { sessions: Object.create(null), tabs: {}, downloads: {} }; this.scheduler = new CommandScheduler(); this.browserTail = Promise.resolve(); this.saveTail = Promise.resolve(); this.generation = 0;
    this.popupActions = new Map(); this.indicatorRefresh = new Set();
    this.pages.beforeMutation = tabId => this.armPopupCapture(tabId);
  }
  restore(state) {
    if (state && typeof state.sessions === 'object' && typeof state.tabs === 'object') {
      this.state = { sessions: Object.assign(Object.create(null), state.sessions), tabs: state.tabs, downloads: state.downloads || {} };
    }
  }
  mutateBrowser(task) { const result = this.browserTail.then(task); this.browserTail = result.catch(() => {}); return result; }
  sessionResources(id, exclusive = false) {
    return [[`session:${id}`, exclusive ? 'write' : 'read'], ...(exclusive ? Object.entries(this.state.tabs).filter(([, tab]) => tab.sessionId === id).map(([tabId]) => [`tab:${tabId}`, 'write']) : [])];
  }
  persist() { const state = structuredClone(this.state); const task = this.saveTail.then(() => this.save(state)); this.saveTail = task.catch(() => {}); return task; }
  suspend() { this.paused = true; this.generation++; this.scheduler.cancel(() => true, new BrowserFault('DISCONNECTED', 'This command belongs to a previous bridge connection.')); }
  current(generation) { if (generation !== this.generation) fail('DISCONNECTED', 'This command belongs to a previous bridge connection.'); }
  deadline(value) { if (value !== undefined && Date.now() > value) fail('COMMAND_EXPIRED', 'This browser command expired before it could complete.'); }
  storedSession(id) { return Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : undefined; }
  session(id) {
    if (this.paused) fail('DISCONNECTED', 'The local browser bridge is disconnected.');
    const session = this.storedSession(id);
    if (session?.stopped) fail('SESSION_STOPPED', 'The user stopped this session. Start a new session with a new ID.');
    if (!session || session.ended) fail('SESSION_INACTIVE', 'Start a browser session before using its tabs.');
    return session;
  }
  owned(id, tabId) {
    this.session(id); tabNumber(tabId);
    const record = this.state.tabs[tabId];
    if (!record || record.sessionId !== id) fail('TAB_NOT_OWNED', 'Claim this tab in the current session before interacting with it.');
    return record;
  }
  async safeTab(tabId) {
    const tab = await this.chrome.tabs.get(tabNumber(tabId));
    if (tab.incognito) fail('UNSUPPORTED_TAB', 'Private browsing tabs are not supported.');
    const url = tab.pendingUrl || tab.url;
    // A captured popup may build its document before navigating to a web URL.
    if (!(url === 'about:blank' && this.state.tabs[tabId]?.popup)) webUrl(url);
    return tab;
  }
  describe(tab) {
    const record = this.state.tabs[tab.id];
    return { tabId: tab.id, windowId: tab.windowId, title: tab.title || '', url: tab.pendingUrl || tab.url || '', active: !!tab.active, groupId: tab.groupId, ownerSessionId: record?.sessionId, createdByAgent: record?.created || false, disposition: record?.disposition, ...(record ? { activity: record.activity || 'active' } : {}) };
  }
  async taskGroup(id, windowId, assertCurrent = () => this.session(id)) {
    const session = this.session(id); const groupId = session.groups[windowId];
    if (groupId === undefined) return undefined;
    let group;
    try { group = await this.chrome.tabGroups.get(groupId); }
    catch { delete session.groups[windowId]; return undefined; }
    assertCurrent();
    const members = (await this.chrome.tabs.query({ groupId })).filter(tab => tab.groupId === groupId);
    assertCurrent();
    const own = members.filter(tab => this.state.tabs[tab.id]?.sessionId === id && this.state.tabs[tab.id]?.created);
    if (own.length === 0) { delete session.groups[windowId]; return undefined; }
    if (own.length === members.length) return groupId;
    // A released tab or a user-added tab makes the group shared. Split only our
    // created tabs before changing its appearance; leave other tasks' tabs alone.
    const isolated = await this.chrome.tabs.group({ tabIds: own.map(tab => tab.id) });
    session.groups[windowId] = isolated;
    assertCurrent();
    await this.chrome.tabGroups.update(isolated, { title: group.title, color: group.color, collapsed: group.collapsed });
    return isolated;
  }
  async groupCreatedTab(id, tab, background = true, assertCurrent = () => this.session(id)) {
    assertCurrent(); const session = this.session(id); let groupId = await this.taskGroup(id, tab.windowId, assertCurrent);
    assertCurrent(); const newGroup = groupId === undefined;
    groupId = await this.chrome.tabs.group({ tabIds: [tab.id], ...(newGroup ? {} : { groupId }) });
    session.groups[tab.windowId] = groupId; assertCurrent();
    if (newGroup) await this.chrome.tabGroups.update(groupId, { title: session.name, color: 'blue', collapsed: background });
    else if (!background) await this.chrome.tabGroups.update(groupId, { collapsed: false });
  }
  async updateIndicator(id, tabId, assertCurrent) {
    if (!this.pages.setActivity) return {};
    try {
      assertCurrent(); this.owned(id, tabId); await this.safeTab(tabId); assertCurrent();
      await this.pages.setActivity(tabId, this.state.tabs[tabId].activity || 'active', () => { assertCurrent(); this.owned(id, tabId); });
      return { indicatorVisible: true };
    } catch (error) { return { indicatorVisible: false, indicatorWarning: String(error.message || error).slice(0, 300) }; }
  }
  refreshIndicators(tabId) {
    const ids = tabId === undefined ? Object.keys(this.state.tabs).map(Number) : [tabId];
    return Promise.all(ids.map(async key => {
      const record = this.state.tabs[key], session = record && this.storedSession(record.sessionId);
      if (this.paused || !session || session.ended || session.stopped || this.indicatorRefresh.has(key)) return;
      this.indicatorRefresh.add(key);
      try {
        if (this.indicatorAllowed && !await this.indicatorAllowed(key)) return;
        // Use the same per-tab queue and access checks as explicit agent work.
        await this.execute({ type: 'command', id: `indicator:${key}`, sessionId: record.sessionId, operation: 'tabs.activity', args: { tabId: key }, deadlineMs: Date.now() + 5000 });
      } catch { /* Cosmetic renewal never interrupts the task. */ }
      finally { this.indicatorRefresh.delete(key); }
    }));
  }
  popupContext(sourceTabId) {
    const action = this.popupActions.get(sourceTabId);
    if (!action || !action.armed || !action.accepting || action.tabId !== sourceTabId || Date.now() > action.expiresAt) return undefined;
    try { action.assertCurrent(); return action; } catch { return undefined; }
  }
  armPopupCapture(tabId) {
    const action = this.popupActions.get(tabId);
    if (!action || action.tabId !== tabId || !action.accepting || action.armed) return;
    action.assertCurrent(); action.armed = true;
    action.expiresAt = Math.min(action.deadlineMs ?? Infinity, Date.now() + 10000);
  }
  windowOpened(source, details) {
    const action = this.popupContext(source.tabId); const url = popupUrl(details?.url);
    if (!action || !url || action.signals.length >= 20) return;
    action.signals.push({ url, matched: false }); this.matchPopups(action);
  }
  created(tab) {
    const url = popupUrl(tab.pendingUrl || tab.url);
    if (!url || !Number.isInteger(tab.id) || tab.id < 0 || tab.incognito) return;
    // Browser-handled middle clicks do not emit Page.windowOpen. Pair the new
    // tab's identity/URL with onCreatedNavigationTarget's actual source instead.
    // Chrome's openerTabId can refer to the selected user tab in this case.
    for (const id of this.popupActions.keys()) {
      const action = this.popupContext(id);
      if (!action?.middleClick || action.existing.has(tab.id) || action.signals.length >= 20) continue;
      action.signals.push({ url, tabId: tab.id, matched: false }); this.matchPopups(action);
    }
  }
  navigationTarget(details) {
    const action = this.popupContext(details.sourceTabId); const url = popupUrl(details.url);
    if (!action || !url || !Number.isInteger(details.tabId) || details.tabId < 0 || action.existing.has(details.tabId) || action.targets.has(details.tabId) || action.targets.size >= 20) return;
    action.targets.set(details.tabId, { tabId: details.tabId, url, matched: false }); this.matchPopups(action);
  }
  matchPopups(action) {
    // Both public Chrome events are required. Opener ownership alone is never
    // sufficient, and their delivery order is not assumed.
    for (const target of action.targets.values()) {
      if (target.matched) continue;
      const signal = action.signals.find(item => !item.matched && item.url === target.url && (item.tabId === undefined || item.tabId === target.tabId));
      if (!signal) continue;
      signal.matched = true; target.matched = true;
      action.tail = action.tail.then(() => this.adoptPopup(action, target)).catch(() => {});
    }
  }
  async adoptPopup(action, target) {
    // A matched pair was observed before revocation. Keep its cleanup record
    // even if Stop/disconnect arrives while Chrome is making the new tab visible.
    // No focus or grouping mutation may continue after revocation.
    if (this.popupActions.get(action.tabId) !== action || !this.storedSession(action.sessionId) || this.storedSession(action.sessionId).ended) return;
    let tab;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { tab = await this.chrome.tabs.get(target.tabId); break; }
      catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    return this.mutateBrowser(async () => {
      if (this.popupActions.get(action.tabId) !== action || this.storedSession(action.sessionId)?.ended) return;
      if (tab.incognito || this.state.tabs[tab.id] || !popupUrl(tab.pendingUrl || tab.url || 'about:blank')) return;
      if (Object.values(this.state.tabs).filter(item => item.sessionId === action.sessionId).length >= 100) return;
      // Record ownership before any grouping or focus operation can fail.
      this.state.tabs[tab.id] = { sessionId: action.sessionId, created: true, disposition: 'temporary', popup: true, openerTabId: action.tabId, ...(action.openerOrigin ? { openerOrigin: action.openerOrigin } : {}) };
      const opened = { tabId: tab.id, openerTabId: action.tabId }; action.opened.set(tab.id, opened);
      await this.persist();
      try { await this.restorePopupFocus(action, tab); } catch { /* Best effort; never steal focus from a different user tab. */ }
      try { await this.groupCreatedTab(action.sessionId, tab, true, action.assertCurrent); }
      catch (error) { opened.groupingWarning = String(error.message || error).slice(0, 500); }
      await this.updateIndicator(action.sessionId, tab.id, action.assertCurrent);
      await this.persist();
    });
  }
  async restorePopupFocus(action, popup) {
    action.assertCurrent();
    const priorTabId = action.activeTabs.get(popup.windowId);
    if (priorTabId !== undefined) {
      const active = (await this.chrome.tabs.query({ active: true, windowId: popup.windowId })).find(tab => tab.active && tab.windowId === popup.windowId);
      action.assertCurrent();
      if (active && action.opened.has(active.id)) {
        const prior = await this.chrome.tabs.get(priorTabId); action.assertCurrent();
        if (prior.windowId === popup.windowId) await this.chrome.tabs.update(priorTabId, { active: true });
      }
    }
    if (action.focusedWindow?.focused && popup.windowId !== action.focusedWindow.id && this.chrome.windows?.getLastFocused) {
      const focused = await this.chrome.windows.getLastFocused(); action.assertCurrent();
      const active = (await this.chrome.tabs.query({ active: true, windowId: popup.windowId })).find(tab => tab.active && tab.windowId === popup.windowId);
      action.assertCurrent();
      if (focused.focused && focused.id === popup.windowId && active && action.opened.has(active.id)) await this.chrome.windows.update(action.focusedWindow.id, { focused: true });
    }
  }
  async pageAction(id, tab, operation, args, assertCurrent, deadlineMs) {
    if (!popupOperations.has(operation)) return this.pages.execute(tab.id, operation, args, assertCurrent);
    const existing = await this.chrome.tabs.query({}); assertCurrent();
    const activeTabs = new Map(existing.filter(item => item.active).map(item => [item.windowId, item.id]));
    const focusBaselines = new Map();
    // An overlapping action can observe a just-opened agent popup before its
    // adoption restores focus. Carry forward that action's user baseline, so
    // finishing the newer popup never restores focus to the older popup.
    for (const [windowId, currentId] of activeTabs) {
      let priorId = currentId; const seen = new Set();
      for (;;) {
        const priorAction = [...this.popupActions.values()].find(action => action.opened.has(priorId) || action.targets.get(priorId)?.matched);
        if (!priorAction || seen.has(priorAction)) break;
        seen.add(priorAction);
        if (priorAction.focusedWindow) focusBaselines.set(windowId, priorAction.focusedWindow);
        priorId = priorAction.activeTabs.get(windowId);
        if (priorId === undefined) { activeTabs.delete(windowId); break; }
        activeTabs.set(windowId, priorId);
      }
    }
    let focusedWindow;
    try { focusedWindow = await this.chrome.windows?.getLastFocused?.(); } catch { /* Window focus is optional. */ }
    if (focusedWindow?.focused && focusBaselines.has(focusedWindow.id)) focusedWindow = focusBaselines.get(focusedWindow.id);
    assertCurrent();
    let openerOrigin = this.state.tabs[tab.id]?.openerOrigin;
    try { const source = new URL(tab.url || tab.pendingUrl); if (['http:', 'https:'].includes(source.protocol)) openerOrigin = source.origin; } catch { /* An owned blank popup inherits its captured opener origin. */ }
    const action = { sessionId: id, tabId: tab.id, openerOrigin, middleClick: operation === 'page.click' && args.button === 'middle', assertCurrent, deadlineMs, accepting: true, armed: false, expiresAt: 0, existing: new Set(existing.map(item => item.id)), activeTabs, focusedWindow, signals: [], targets: new Map(), opened: new Map(), tail: Promise.resolve() };
    this.popupActions.set(tab.id, action);
    let result;
    try { result = await this.pages.execute(tab.id, operation, args, assertCurrent); }
    finally {
      // Allow already-emitted cross-API events to drain, without keeping an
      // opener watched after the agent action. Async popups after this bound
      // remain ordinary unowned browser tabs.
      if (action.armed) {
        action.expiresAt = Math.min(action.expiresAt, Date.now() + 120);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, action.expiresAt - Date.now())));
      }
      action.accepting = false; await action.tail;
      if (this.popupActions.get(tab.id) === action) this.popupActions.delete(tab.id);
    }
    const openedTabs = [];
    for (const opened of action.opened.values()) {
      try {
        const item = this.describe(await this.chrome.tabs.get(opened.tabId));
        openedTabs.push({ ...item, title: item.title.slice(0, 300), url: item.url.slice(0, 2048), ...opened });
      }
      catch { /* A page can close its own popup immediately. */ }
    }
    return openedTabs.length ? { ...result, openedTabs } : result;
  }
  async listTabs(args = {}) {
    const tabs = await this.chrome.tabs.query({});
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 1000)) fail('INVALID_ARGUMENT', 'query must be a string under 1000 characters.');
    const query = args.query?.toLowerCase() || ''; const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
    const matching = tabs.filter(tab => !tab.incognito && (/^https?:\/\//.test(tab.pendingUrl || tab.url || '') || ((tab.pendingUrl || tab.url) === 'about:blank' && this.state.tabs[tab.id]?.popup)) && (!query || `${tab.title} ${tab.pendingUrl || tab.url}`.toLowerCase().includes(query)));
    const result = []; let bytes = 0;
    for (const tab of matching) {
      const item = this.describe(tab); item.title = item.title.slice(0, 300); item.url = item.url.slice(0, 8192);
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (result.length >= limit || bytes + size > 75000) break;
      result.push(item); bytes += size;
    }
    return { tabs: result, total: matching.length, truncated: result.length < matching.length };
  }
  async execute(command) {
    if (!command || command.type !== 'command' || typeof command.id !== 'string' || typeof command.sessionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(command.sessionId) || ['__proto__', 'prototype', 'constructor'].includes(command.sessionId) || typeof command.operation !== 'string' || !command.args || Array.isArray(command.args) || typeof command.args !== 'object') fail('INVALID_COMMAND', 'Malformed browser command.');
    if (command.deadlineMs !== undefined && (typeof command.deadlineMs !== 'number' || !Number.isFinite(command.deadlineMs))) fail('INVALID_COMMAND', 'deadlineMs must be a finite timestamp.');
    const generation = this.generation;
    const { sessionId, operation, args } = command;
    const barrier = ['session.start', 'session.end', 'groups.update'].includes(operation);
    const observation = ['status', 'session.list'].includes(operation);
    const tabOperation = operation.startsWith('page.') || (operation.startsWith('tabs.') && !['tabs.list', 'tabs.open'].includes(operation));
    const tabId = tabOperation ? tabNumber(args.tabId) : undefined;
    return this.scheduler.schedule({
      ...(observation ? {} : { sessionId }),
      resources: () => observation ? [] : [...this.sessionResources(sessionId, barrier), ...(tabId === undefined ? [] : [[`tab:${tabId}`, 'write']])],
    }, () => { this.current(generation); this.deadline(command.deadlineMs); return this.run(sessionId, operation, args, generation, command.deadlineMs); });
  }
  async run(id, operation, args, generation = this.generation, deadlineMs) {
    if (operation === 'status') return { browser: 'Chrome', connected: true, sessions: Object.values(this.state.sessions).filter(s => !s.ended).length };
    if (operation === 'session.list') return Object.entries(this.state.sessions).map(([sessionId, session]) => ({ sessionId, ...session, tabCount: Object.values(this.state.tabs).filter(t => t.sessionId === sessionId).length }));
    if (operation === 'session.start') {
      const old = this.storedSession(id);
      if (old?.stopped) fail('SESSION_STOPPED', 'The user stopped this session. Start a new session with a new ID.');
      if (Object.values(this.state.sessions).filter(s => !s.ended).length >= 32 && (!old || old.ended)) fail('SESSION_LIMIT', 'Too many active browser sessions.');
      if (Object.keys(this.state.sessions).length >= 256 && !old) fail('SESSION_LIMIT', 'This browser connection has reached its session limit. Restart Chrome to clear completed sessions.');
      this.state.sessions[id] = old && !old.ended ? { ...old, name: title(args.name) } : { name: title(args.name), startedAt: Date.now(), groups: {} };
      await this.persist(); return { sessionId: id, ...this.state.sessions[id] };
    }
    if (operation === 'session.end') return this.end(id);
    const assertCurrent = () => { this.current(generation); this.deadline(deadlineMs); return this.session(id); };
    assertCurrent();
    if (operation === 'tabs.list') return this.listTabs(args);
    if (operation === 'tabs.open') return this.mutateBrowser(async () => {
      assertCurrent();
      if (Object.values(this.state.tabs).filter(tab => tab.sessionId === id).length >= 100) fail('TAB_LIMIT', 'This task already owns 100 tabs. Release or close tabs before opening more.');
      const url = webUrl(args.url);
      const tab = await this.chrome.tabs.create({ url, active: args.background === false });
      this.state.tabs[tab.id] = { sessionId: id, created: true, disposition: 'temporary' };
      await this.persist();
      // A failed grouping operation never loses ownership of an already-created tab.
      let groupingWarning;
      try {
        await this.groupCreatedTab(id, tab, args.background !== false, assertCurrent);
      } catch (error) { groupingWarning = String(error.message || error); }
      const indicator = await this.updateIndicator(id, tab.id, assertCurrent);
      await this.persist(); return { ...this.describe(await this.chrome.tabs.get(tab.id)), ...indicator, ...(groupingWarning ? { groupingWarning } : {}) };
    });
    if (operation === 'tabs.claim') {
      const tab = await this.safeTab(args.tabId);
      return this.mutateBrowser(async () => {
        assertCurrent(); const owner = this.state.tabs[tab.id];
        if (owner && owner.sessionId !== id) fail('TAB_BUSY', 'Another browser session owns this tab.');
        this.state.tabs[tab.id] ||= { sessionId: id, created: false, disposition: 'temporary' };
        await this.persist(); const indicator = await this.updateIndicator(id, tab.id, assertCurrent);
        return { ...this.describe(tab), ...indicator };
      });
    }
    if (operation === 'groups.update') return this.mutateBrowser(async () => {
      assertCurrent();
      const update = {};
      if (args.title !== undefined) update.title = title(args.title);
      if (args.color !== undefined) { if (!colors.has(args.color)) fail('INVALID_ARGUMENT', 'Unsupported tab group color.'); update.color = args.color; }
      if (args.collapsed !== undefined) { if (typeof args.collapsed !== 'boolean') fail('INVALID_ARGUMENT', 'collapsed must be a boolean.'); update.collapsed = args.collapsed; }
      const groups = [];
      for (const windowId of Object.keys(this.session(id).groups)) {
        this.current(generation); this.deadline(deadlineMs);
        const groupId = await this.taskGroup(id, windowId, assertCurrent);
        assertCurrent();
        if (groupId !== undefined) groups.push(await this.chrome.tabGroups.update(groupId, update));
      }
      await this.persist();
      return groups;
    });
    if (operation.startsWith('downloads.')) return this.downloads(id, operation, args, generation, deadlineMs);
    const record = this.owned(id, args.tabId);
    if (operation === 'tabs.activity') return this.mutateBrowser(async () => {
      assertCurrent(); this.owned(id, args.tabId);
      if (args.activity !== undefined && (typeof args.activity !== 'string' || !Object.hasOwn(ACTIVITY_PREFIXES, args.activity))) fail('INVALID_ARGUMENT', 'Unsupported tab activity.');
      if (args.activity !== undefined && record.activity !== args.activity) { record.activity = args.activity; await this.persist(); }
      const indicator = await this.updateIndicator(id, args.tabId, assertCurrent);
      return { tabId: args.tabId, activity: record.activity || 'active', ...indicator };
    });
    if (operation === 'tabs.release') return this.mutateBrowser(async () => {
      assertCurrent(); this.owned(id, args.tabId);
      await this.pages.detach(args.tabId); delete this.state.tabs[args.tabId]; await this.persist(); return { released: true };
    });
    if (operation === 'tabs.close') return this.mutateBrowser(async () => {
      assertCurrent(); this.owned(id, args.tabId);
      // Explicit close may target a claimed user tab; automatic cleanup never does.
      await this.chrome.tabs.remove(args.tabId); delete this.state.tabs[args.tabId]; await this.pages.detach(args.tabId); await this.persist(); return { closed: true };
    });
    if (operation === 'tabs.mark') {
      if (!['temporary', 'deliverable', 'handoff'].includes(args.disposition)) fail('INVALID_ARGUMENT', 'Invalid tab disposition.');
      record.disposition = args.disposition; await this.persist(); return { tabId: args.tabId, disposition: record.disposition };
    }
    const tab = await this.safeTab(args.tabId); assertCurrent(); this.owned(id, tab.id);
    if (operation === 'tabs.show') return this.mutateBrowser(async () => {
      assertCurrent(); this.owned(id, tab.id);
      if (tab.groupId >= 0) await this.chrome.tabGroups.update(tab.groupId, { collapsed: false });
      assertCurrent(); await this.chrome.tabs.update(tab.id, { active: true });
      assertCurrent(); await this.chrome.windows.update(tab.windowId, { focused: true }); return { shown: true };
    });
    if (operation === 'tabs.navigate') {
      this.pages.invalidate(tab.id); await this.chrome.tabs.update(tab.id, { url: webUrl(args.url) }); return { navigating: true };
    }
    if (operation.startsWith('page.')) return this.pageAction(id, tab, operation, args, () => { this.current(generation); this.deadline(deadlineMs); return this.owned(id, tab.id); }, deadlineMs);
    fail('UNKNOWN_OPERATION', `Unsupported operation: ${operation}`);
  }
  async end(id) {
    const session = this.storedSession(id);
    if (!session) return { closed: [], released: [], retained: [] };
    session.ended = true; const result = { closed: [], released: [], retained: [], errors: [] };
    for (const [key, record] of Object.entries(this.state.tabs)) {
      if (record.sessionId !== id) continue;
      const tabId = Number(key);
      try {
        await this.pages.detach(tabId);
        if (record.created && record.disposition === 'temporary') {
          await this.mutateBrowser(() => this.chrome.tabs.remove(tabId)); result.closed.push(tabId);
        } else if (record.created) result.retained.push(tabId);
        else result.released.push(tabId);
        delete this.state.tabs[key];
      } catch (error) {
        // Missing tabs are already clean; preserve failed live cleanup for retry.
        try { await this.chrome.tabs.get(tabId); result.errors.push({ tabId, message: String(error.message || error) }); }
        catch { delete this.state.tabs[key]; }
      }
    }
    await this.persist(); return result;
  }
  stop(id) {
    const scheduledIds = this.scheduler.sessionIds();
    const ids = id ? [id] : [...new Set([...Object.keys(this.state.sessions), ...scheduledIds])];
    for (const key of ids) {
      if (!this.storedSession(key) && scheduledIds.has(key)) this.state.sessions[key] = { name: 'Stopped task', startedAt: Date.now(), ended: true, groups: {} };
      if (this.storedSession(key)) this.state.sessions[key].stopped = true;
    }
    this.scheduler.cancel(job => ids.includes(job.sessionId), new BrowserFault('SESSION_STOPPED', 'The user stopped this session. Start a new session with a new ID.'));
    // Detach immediately to interrupt blocked page scripts or modal dialogs.
    for (const [tabId, tab] of Object.entries(this.state.tabs)) if (ids.includes(tab.sessionId)) void this.pages.detach(Number(tabId));
    void this.persist();
    // Revoke ownership checks immediately, even if a wait command is running.
    return Promise.all(ids.map(key => this.scheduler.schedule({ sessionId: key, cancelable: false, resources: () => this.sessionResources(key, true) }, () => this.end(key))));
  }
  removed(tabId) { delete this.state.tabs[tabId]; this.pages.invalidate(tabId); return this.persist(); }
  async downloaded(item) {
    if (!item.referrer) return;
    // Attribute only exact initiating URLs, and never return unrelated browser downloads.
    const tabs = await this.chrome.tabs.query({});
    const matches = tabs.filter(tab => tab.url === item.referrer);
    if (!matches.length || matches.some(tab => !this.state.tabs[tab.id] || this.storedSession(this.state.tabs[tab.id].sessionId)?.ended)) return;
    const owners = new Set(matches.map(tab => this.state.tabs[tab.id].sessionId));
    if (owners.size === 1) { this.state.downloads[item.id] = { sessionId: [...owners][0], createdAt: Date.now() }; await this.persist(); }
  }
  async downloads(id, operation, args, generation = this.generation, deadlineMs) {
    const own = Object.entries(this.state.downloads).filter(([, record]) => record.sessionId === id).map(([key]) => Number(key));
    if (args.downloadId !== undefined && !own.includes(args.downloadId)) fail('DOWNLOAD_NOT_OWNED', 'This download is not attributed to the current session.');
    const select = args.downloadId === undefined ? own.slice(-100) : [args.downloadId];
    const list = async () => (await Promise.all(select.map(downloadId => this.chrome.downloads.search({ id: downloadId })))).flat().map(item => ({ id: item.id, filename: item.filename, url: item.url, state: item.state, error: item.error, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes }));
    if (operation === 'downloads.list') return list();
    if (operation !== 'downloads.wait') fail('UNKNOWN_OPERATION', 'Unknown download operation.');
    if (args.downloadId === undefined) fail('INVALID_ARGUMENT', 'downloads.wait requires downloadId from downloads.list.');
    const timeout = Math.min(30000, Math.max(100, Number(args.timeoutMs) || 15000)); const deadline = Date.now() + timeout;
    do {
      this.current(generation); this.deadline(deadlineMs); this.session(id); const [item] = await list();
      if (item?.state === 'complete') return item;
      if (item?.state === 'interrupted') fail('DOWNLOAD_INTERRUPTED', item.error || 'The download was interrupted.');
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    fail('TIMEOUT', 'The download is still pending.');
  }
}
import { CommandScheduler } from './scheduler.js';
