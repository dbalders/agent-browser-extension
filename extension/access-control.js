import { BrowserFault } from './controller.js';
import { siteOrigin } from './access.js';

const fail = (code, message) => { throw new BrowserFault(code, message); };
const discovery = new Set(['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable', 'Log.enable', 'Target.setAutoAttach', 'Page.getFrameTree']);
const debugOperations = new Set(['page.profile', 'page.performance', 'page.inspect']);
const inherited = value => value === 'about:blank' || value === 'about:srcdoc';
const canonical = value => { try { return siteOrigin(value); } catch { return inherited(value) ? value : 'unsupported:'; } };

// This gates agent operations, not page-initiated requests or JavaScript. Public
// Chrome APIs do not provide a document-isolated CPU profiler or a site firewall.
export function installAccessControl(controller, pages, access) {
  const tops = new Map(), versions = new Map(), epochs = new Map(), active = new Map();
  const tokens = new WeakMap(), admissions = new WeakMap(), contexts = new Map(), objects = new Map(), detaching = new Map();
  const initialNavigation = new Map(), history = new Map(), observed = new Map();
  let revision = 0;
  const epoch = tabId => epochs.get(tabId) || 0;
  const original = {
    current: controller.current.bind(controller), run: controller.run.bind(controller), execute: controller.execute.bind(controller),
    safeTab: controller.safeTab.bind(controller), end: controller.end.bind(controller), removed: controller.removed.bind(controller),
    pageExecute: pages.execute.bind(pages), rawSend: pages.rawSend.bind(pages), event: pages.event.bind(pages),
  };
  controller.access = access; pages.access = access;
  const observe = (tabId, urls) => {
    const origins = observed.get(tabId) || new Set(); observed.set(tabId, origins);
    for (const url of urls) if (origins.size < 512) origins.add(url); else origins.add('*');
  };
  const stateFor = tabId => pages.frames.tabs.get(tabId);
  const ownerFor = tabId => {
    const owner = controller.state.tabs[tabId];
    if (!owner) fail('TAB_NOT_OWNED', 'Claim this tab in the current session before interacting with it.');
    controller.owned(owner.sessionId, tabId); return owner;
  };
  const topUrls = tabId => {
    const urls = [...(tops.get(tabId) || [])];
    const state = stateFor(tabId), frame = state?.frames.get(state.mainFrameId);
    if (frame?.url && !inherited(frame.url)) initialNavigation.delete(tabId);
    if (frame?.url && !(frame.url === 'about:blank' && initialNavigation.has(tabId))) urls.push(canonical(frame.url));
    if (!urls.length) fail('SITE_ACCESS_REQUIRED', 'Refresh this tab before requesting website access.');
    return [...new Set(urls.map(url => inherited(url) ? controller.state.tabs[tabId]?.openerOrigin || 'unsupported:' : url))];
  };
  const checkUrl = (url, id, capability = 'ordinary', prompt = true) => {
    if (prompt) return access.check(url, id, capability, controller.storedSession(id)?.name);
    if (!access.allows(url, id, capability)) fail('SITE_ACCESS_REQUIRED', 'Website access is not allowed.');
  };
  const checkTop = (tabId, id, prompt = true) => { const urls = topUrls(tabId); for (const url of urls) checkUrl(url, id, 'ordinary', prompt); observe(tabId, urls); };
  const frameUrls = (tabId, frameId) => {
    const state = stateFor(tabId); const urls = []; const seen = new Set();
    let frame = state?.frames.get(frameId);
    if (!frame) fail('FRAME_UNAVAILABLE', 'The frame must be discovered before accessing its document.');
    while (frame) {
      if (seen.has(frame.frameId) || seen.size >= 64) fail('FRAME_UNAVAILABLE', 'The frame ancestry could not be verified.');
      seen.add(frame.frameId);
      if (!inherited(frame.url)) urls.push(canonical(frame.url));
      if (!frame.parentFrameId) break;
      frame = state.frames.get(frame.parentFrameId);
      if (!frame) fail('FRAME_UNAVAILABLE', 'The frame ancestry could not be verified.');
    }
    return [...new Set([...urls, ...topUrls(tabId)])];
  };
  const checkFrame = (tabId, frameId, id, capability = 'ordinary', prompt = true) => {
    checkTop(tabId, id, prompt);
    if (frameId === undefined) {
      for (const url of topUrls(tabId)) checkUrl(url, id, capability, prompt);
      return;
    }
    const urls = frameUrls(tabId, frameId);
    for (const url of urls) checkUrl(url, id, 'ordinary', prompt);
    // A blank frame inherits the first non-blank ancestor's origin.
    checkUrl(urls[0], id, capability, prompt);
    observe(tabId, urls);
  };
  const checkAll = (tabId, id, capability = 'ordinary', rendererOnly = false, prompt = true) => {
    checkTop(tabId, id, prompt);
    for (const frame of stateFor(tabId)?.frames.values() || []) {
      if (!rendererOnly || frame.sessionKey === '') checkFrame(tabId, frame.frameId, id, capability, prompt);
    }
    if (capability === 'debug') for (const url of topUrls(tabId)) checkUrl(url, id, 'debug', prompt);
  };
  const remember = (map, tabId, key, value) => {
    const entries = map.get(tabId) || new Map(); map.set(tabId, entries);
    entries.set(key, value); if (entries.size > 2048) entries.delete(entries.keys().next().value);
  };
  const contextKey = (target, id) => JSON.stringify([target.sessionId || '', id]);
  const resolveFrame = (target, args = {}) => {
    const state = stateFor(target.tabId);
    if (args.frameId !== undefined) return args.frameId;
    const contextId = args.contextId ?? args.executionContextId;
    if (contextId !== undefined) {
      const cached = contexts.get(target.tabId)?.get(contextKey(target, contextId));
      if (cached) return cached;
      for (const [id, context] of state?.contexts || []) if (context.executionContextId === contextId && context.sessionKey === (target.sessionId || '')) return id;
      fail('FRAME_UNAVAILABLE', 'The execution context could not be associated with an approved frame.');
    }
    if (args.objectId !== undefined) {
      const frame = objects.get(target.tabId)?.get(contextKey(target, args.objectId));
      if (frame) return frame;
    }
    const scope = pages.scopes.get(target.tabId);
    if (scope && (scope.target.sessionId || '') === (target.sessionId || '')) return scope.frameId;
    if (target.sessionId) {
      const candidates = [...(state?.frames.values() || [])].filter(frame => frame.sessionKey === target.sessionId);
      const frame = candidates.find(item => !candidates.some(parent => parent.frameId === item.parentFrameId));
      if (!frame) fail('FRAME_UNAVAILABLE', 'The child target must be discovered before accessing its document.');
      return frame.frameId;
    }
    return state?.mainFrameId;
  };
  const selected = (tabId, operation, args) => {
    if (operation === 'page.performance' && ['stop', 'status', 'read', 'clear'].includes(args.action)) {
      const retained = pages.debugging.timelines.get(tabId)?.frameId ?? pages.debugging.artifacts.get(`${tabId}:trace`)?.metadata.frameId;
      if (retained) return retained;
    }
    return args.frameId ?? (args.ref ? pages.referenceSnapshot(tabId, args.ref)?.frameId : undefined) ?? stateFor(tabId)?.mainFrameId;
  };
  const makeGuard = (id, tabId, generation, deadlineMs, expectedEpoch = epoch(tabId)) => () => {
    original.current(generation); controller.deadline(deadlineMs); controller.session(id);
    if (tabId !== undefined) {
      controller.owned(id, tabId);
      if (epoch(tabId) !== expectedEpoch) fail('SITE_ACCESS_REVOKED', 'Website access changed during this command. Inspect the task and explicitly retry if appropriate.');
      checkTop(tabId, id);
    }
  };
  const detach = tabId => {
    if (detaching.has(tabId)) return detaching.get(tabId);
    // Mark revoked synchronously; cleanup may need bounded unguarded CDP calls.
    epochs.set(tabId, epoch(tabId) + 1); contexts.delete(tabId); objects.delete(tabId); history.delete(tabId);
    const task = Promise.resolve(pages.detach(tabId)).finally(() => { if (detaching.get(tabId) === task) detaching.delete(tabId); });
    detaching.set(tabId, task); return task;
  };

  controller.current = value => {
    const token = tokens.get(value);
    if (token) { original.current(token.generation); token.guard(); }
    else original.current(value);
  };
  controller.safeTab = async tabId => {
    const version = versions.get(tabId) || 0; const tab = await original.safeTab(tabId);
    if ((versions.get(tabId) || 0) === version) {
      // Only a newly-created agent tab can use its approved initial pending URL
      // while Chrome still reports the empty initial document. User tabs and
      // captured popups retain their ordinary URL/inherited-origin rules.
      const initial = initialNavigation.get(tabId);
      const waiting = initial && (!tab.url || tab.url === 'about:blank') && canonical(tab.pendingUrl) === initial;
      if (!waiting && !/^https?:/.test(tab.url || '')) initialNavigation.delete(tabId);
      tops.set(tabId, [...new Set((waiting ? [tab.pendingUrl] : [tab.url, tab.pendingUrl]).filter(Boolean).map(canonical))]);
    }
    return tab;
  };
  controller.execute = async command => {
    if (!command?.args || typeof command.args !== 'object' || Array.isArray(command.args)) return original.execute(command);
    const args = { ...command.args };
    admissions.set(args, { epoch: epoch(args.tabId), revision });
    try { return await original.execute({ ...command, args }); }
    finally { admissions.delete(args); }
  };
  controller.run = async (id, operation, args, generation = controller.generation, deadlineMs) => {
    if (operation === 'access.status') {
      original.current(generation); controller.deadline(deadlineMs); controller.session(id);
      const snapshot = access.snapshot();
      const result = { ...snapshot, sites: [], once: [], pending: [], truncated: false };
      const encoder = new TextEncoder(); let bytes = encoder.encode(JSON.stringify(result)).length;
      for (const kind of ['pending', 'once', 'sites']) {
        for (const item of snapshot[kind]) {
          if (kind !== 'sites' && item.sessionId !== id) continue;
          const size = encoder.encode(JSON.stringify(item)).length + 1;
          if (bytes + size > 74000) { result.truncated = true; break; }
          result[kind].push(item); bytes += size;
        }
      }
      return result;
    }
    const guarded = operation === 'tabs.activity' || operation === 'tabs.open' || operation === 'tabs.claim' || operation === 'tabs.navigate' || operation.startsWith('page.');
    if (!guarded) return original.run(id, operation, args, generation, deadlineMs);
    original.current(generation); controller.deadline(deadlineMs); controller.session(id);
    const tabId = operation === 'tabs.open' ? undefined : args.tabId;
    const admission = admissions.get(args);
    const unownedClaim = operation === 'tabs.claim' && !controller.state.tabs[tabId];
    if (admission && ((tabId === undefined || unownedClaim) ? admission.revision !== revision : admission.epoch !== epoch(tabId))) fail('SITE_ACCESS_REVOKED', 'Website access changed while this command was queued. Explicitly retry if appropriate.');
    if (operation === 'tabs.claim') {
      const owner = controller.state.tabs[tabId];
      if (owner && owner.sessionId !== id) fail('TAB_BUSY', 'Another browser session owns this tab.');
    } else if (tabId !== undefined) controller.owned(id, tabId);
    const expectedEpoch = epoch(tabId), expectedRevision = revision;
    if (tabId !== undefined) await controller.safeTab(tabId);
    // safeTab is asynchronous. Stop, disconnect, deadlines and policy changes
    // must win before a pending request is created or any mutation is dispatched.
    const check = () => {
      original.current(generation); controller.deadline(deadlineMs); controller.session(id);
      if ((tabId === undefined || unownedClaim) && revision !== expectedRevision) fail('SITE_ACCESS_REVOKED', 'Website access changed during this command. Explicitly retry if appropriate.');
      if (epoch(tabId) !== expectedEpoch) fail('SITE_ACCESS_REVOKED', 'Website access changed during this command. Explicitly retry if appropriate.');
      if (operation === 'tabs.claim') {
        const owner = controller.state.tabs[tabId];
        if (owner && owner.sessionId !== id) fail('TAB_BUSY', 'Another browser session owns this tab.');
      } else if (tabId !== undefined) controller.owned(id, tabId);
      if (tabId !== undefined) checkTop(tabId, id);
      if (operation === 'tabs.open' || operation === 'tabs.navigate') checkUrl(args.url, id);
    };
    check(); const token = {}; tokens.set(token, { generation, guard: check });
    if (tabId !== undefined) active.set(tabId, { id, generation, deadlineMs, epoch: expectedEpoch, operation, args });
    try {
      const result = await original.run(id, operation, args, token, deadlineMs);
      check();
      if (operation === 'tabs.open' && result?.tabId !== undefined) {
        initialNavigation.set(result.tabId, canonical(args.url));
        await controller.safeTab(result.tabId); check(); checkTop(result.tabId, id);
      }
      return result;
    } finally { if (tabId !== undefined) active.delete(tabId); tokens.delete(token); }
  };
  pages.execute = async (tabId, operation, args, assertOwned = () => {}) => {
    const operationState = active.get(tabId), id = ownerFor(tabId).sessionId;
    const guard = makeGuard(id, tabId, operationState?.generation ?? controller.generation, operationState?.deadlineMs, operationState?.epoch ?? epoch(tabId));
    const check = () => { assertOwned(); guard(); };
    const contentCheck = () => {
      if (operation === 'page.profile') checkAll(tabId, id, 'debug', true);
      else if (debugOperations.has(operation)) checkFrame(tabId, selected(tabId, operation, args), id, 'debug');
      else if (operation === 'page.snapshot' || operation === 'page.screenshot' || operation === 'page.dialog') checkAll(tabId, id);
      else if (!['page.frames', 'page.console', 'page.network', 'page.emulate'].includes(operation)) checkFrame(tabId, selected(tabId, operation, args), id);
    };
    check(); if (detaching.has(tabId)) { await detaching.get(tabId); check(); }
    // Frame selection may first require discovery, which is safe with the main
    // site's grant. All content CDP calls below are checked independently.
    if (stateFor(tabId)?.frames.size || operation === 'page.profile') contentCheck();
    const result = await original.pageExecute(tabId, operation, args, check);
    check(); contentCheck(); return result;
  };
  pages.rawSend = async (target, method, args = {}, mutation = false) => {
    const tabId = target.tabId, running = active.get(tabId), id = ownerFor(tabId).sessionId;
    const guard = makeGuard(id, tabId, running?.generation ?? controller.generation, running?.deadlineMs, running?.epoch ?? epoch(tabId));
    let frameId;
    const check = () => {
      guard();
      if (discovery.has(method)) return;
      frameId = resolveFrame(target, args);
      const capability = debugOperations.has(running?.operation) || method.startsWith('Profiler.') || method.startsWith('Performance.') ? 'debug' : 'ordinary';
      checkFrame(tabId, frameId, id, capability);
      if (method.startsWith('Input.') || ['Page.captureScreenshot', 'Accessibility.getFullAXTree', 'Page.handleJavaScriptDialog'].includes(method)) checkAll(tabId, id);
      if (method.startsWith('Profiler.')) checkAll(tabId, id, 'debug', true);
      if (method === 'Page.navigateToHistoryEntry') {
        const url = history.get(tabId)?.get(args.entryId);
        if (!url) fail('SITE_ACCESS_REQUIRED', 'Read the current navigation history before selecting an entry.');
        checkUrl(url, id); observe(tabId, [canonical(url)]);
      }
    };
    check(); if (detaching.has(tabId)) { await detaching.get(tabId); check(); }
    const result = await original.rawSend(target, method, args, mutation); check();
    if (method === 'Page.getNavigationHistory') history.set(tabId, new Map((result.entries || []).filter(entry => Number.isInteger(entry.id) && typeof entry.url === 'string').map(entry => [entry.id, entry.url])));
    if (method === 'Page.createIsolatedWorld' && Number.isInteger(result.executionContextId)) remember(contexts, tabId, contextKey(target, result.executionContextId), frameId);
    const objectId = result.object?.objectId || result.result?.objectId;
    if (objectId && frameId) remember(objects, tabId, contextKey(target, objectId), frameId);
    if (method === 'Runtime.releaseObject') objects.get(tabId)?.delete(contextKey(target, args.objectId));
    return result;
  };

  controller.indicatorAllowed = async tabId => {
    try {
      await controller.safeTab(tabId);
      checkTop(tabId, ownerFor(tabId).sessionId, false); return true;
    } catch { return false; } // Passive renewal must not request new website access.
  };

  controller.navigationChanged = async (tabId, url) => {
    versions.set(tabId, (versions.get(tabId) || 0) + 1); tops.set(tabId, [canonical(url)]);
    const owner = controller.state.tabs[tabId]; if (!owner) return;
    try { controller.session(owner.sessionId); checkTop(tabId, owner.sessionId, false); }
    catch { await detach(tabId); }
  };
  controller.revokeAccess = async change => {
    revision++;
    const affected = [];
    for (const key of Object.keys(controller.state.tabs)) {
      const tabId = Number(key); let matches = change.origin === null || observed.get(tabId)?.has(change.origin) || observed.get(tabId)?.has('*');
      try {
        const urls = [...topUrls(tabId)];
        for (const frame of stateFor(tabId)?.frames.values() || []) urls.push(...frameUrls(tabId, frame.frameId));
        matches ||= urls.includes(change.origin);
      } catch { matches = true; }
      if (matches) affected.push(detach(tabId));
      // Do not close tabs or change ownership: the user can inspect and release
      // them, and explicit later commands still require fresh access checks.
    }
    await Promise.all(affected);
  };
  controller.end = async id => { try { return await original.end(id); } finally { access.endSession(id); } };
  controller.removed = tabId => { tops.delete(tabId); versions.delete(tabId); epochs.set(tabId, epoch(tabId) + 1); contexts.delete(tabId); objects.delete(tabId); history.delete(tabId); observed.delete(tabId); initialNavigation.delete(tabId); return original.removed(tabId); };

  const eventAllowed = (source, method, params) => {
    try {
      const id = ownerFor(source.tabId).sessionId; checkTop(source.tabId, id, false);
      const contextId = params.executionContextId ?? params.exceptionDetails?.executionContextId;
      let frameId = params.frameId;
      if (contextId !== undefined) frameId = resolveFrame(source, { contextId });
      if (method === 'Network.requestWillBeSent' && frameId === undefined) return false;
      if (method.startsWith('Network.') && method !== 'Network.requestWillBeSent') {
        const request = pages.diagnostics.tabs.get(source.tabId)?.network.pending.get(JSON.stringify([source.sessionId || '', params.requestId]));
        if (!request) return false;
        frameId ??= request.entry.frameId;
      }
      if (frameId === undefined && source.sessionId) frameId = resolveFrame(source);
      if (frameId !== undefined) checkFrame(source.tabId, frameId, id, 'ordinary', false);
      else {
        const url = params.entry?.url || params.exceptionDetails?.url || (method === 'Page.javascriptDialogOpening' ? params.url : undefined);
        if (!url) return false;
        if (!inherited(url)) { checkUrl(url, id, 'ordinary', false); observe(source.tabId, [canonical(url)]); }
        // Events without a document identity may concern any embedded context.
        checkAll(source.tabId, id, 'ordinary', false, false);
      }
      return true;
    } catch { return false; }
  };
  pages.event = (source, method, params = {}) => {
    if (method === 'Runtime.executionContextCreated' && typeof params.context?.auxData?.frameId === 'string') remember(contexts, source.tabId, contextKey(source, params.context.id), params.context.auxData.frameId);
    if (method === 'Runtime.executionContextDestroyed') contexts.get(source.tabId)?.delete(contextKey(source, params.executionContextId));
    if (method === 'Runtime.executionContextsCleared') { contexts.delete(source.tabId); objects.delete(source.tabId); }
    const dataEvent = ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded', 'Page.javascriptDialogOpening'].includes(method) || method.startsWith('Network.');
    if (dataEvent && !eventAllowed(source, method, params)) return;
    original.event(source, method, params);
    if (method === 'Page.frameNavigated' && !params.frame?.parentId && !source.sessionId && params.frame?.url) void controller.navigationChanged(source.tabId, params.frame.url).catch(() => {});
    const profile = pages.debugging.profiles.get(source.tabId);
    if (['Page.frameNavigated', 'Target.attachedToTarget', 'Runtime.executionContextCreated'].includes(method) && profile && !profile.cancelled && ['starting', 'recording', 'stopping'].includes(profile.phase)) {
      try { checkAll(source.tabId, ownerFor(source.tabId).sessionId, 'debug', true, false); }
      catch { void detach(source.tabId).catch(() => {}); }
    }
  };
  return { navigationChanged: controller.navigationChanged, revokeAccess: controller.revokeAccess };
}
