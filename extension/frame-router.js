import { BrowserFault } from './controller.js';

const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] };
const fail = (code, message) => { throw new BrowserFault(code, message); };

// Uses Chrome 125's public flat debugger sessions for out-of-process frames.
// https://developer.chrome.com/docs/extensions/reference/api/debugger#work-with-frames
export class FrameRouter {
  constructor(send) { this.send = send; this.tabs = new Map(); }
  clear(tabId) { this.tabs.delete(tabId); }
  async enable(tabId) {
    const state = { tabId, frames: new Map(), sessions: new Map(), contexts: new Map(), mainFrameId: undefined };
    this.tabs.set(tabId, state);
    const root = { key: '', target: { tabId }, parentKey: undefined };
    state.sessions.set('', root);
    root.ready = this.initialize(state, root);
    await root.ready;
  }
  ingest(state, tree, key, parentId) {
    if (!tree?.frame?.id) return;
    const frame = tree.frame; const previous = state.frames.get(frame.id) || state.previousFrames?.get(frame.id);
    let owner = key;
    // A parent target can also report a placeholder for a remote child. Keep the
    // child's attached debugger session as its owner, including nested OOPIFs.
    for (let session = state.sessions.get(previous?.sessionKey); session?.parentKey !== undefined; session = state.sessions.get(session.parentKey)) {
      if (session.parentKey === key) { owner = previous.sessionKey; break; }
    }
    state.frames.set(frame.id, {
      frameId: frame.id, parentFrameId: frame.parentId || parentId || previous?.parentFrameId,
      loaderId: frame.loaderId, url: frame.url || previous?.url || '', name: frame.name || '', sessionKey: owner,
    });
    if (key === '' && !parentId && !frame.parentId) state.mainFrameId = frame.id;
    for (const child of tree.childFrames || []) this.ingest(state, child, key, frame.id);
  }
  async initialize(state, session) {
    for (const [method, params] of [['Page.enable', {}], ['DOM.enable', {}], ['Runtime.enable', {}], ['Network.enable', {}], ['Log.enable', {}], ['Target.setAutoAttach', autoAttach]]) {
      if (this.tabs.get(state.tabId) !== state) return;
      await this.send(session.target, method, params);
    }
    if (this.tabs.get(state.tabId) !== state) return;
    const { frameTree } = await this.send(session.target, 'Page.getFrameTree', {});
    if (this.tabs.get(state.tabId) !== state || state.sessions.get(session.key) !== session) return;
    this.ingest(state, frameTree, session.key);
    session.initialized = true; session.error = undefined;
  }
  event(source, method, params = {}) {
    const state = this.tabs.get(source.tabId); if (!state) return;
    const key = source.sessionId || '';
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe' && typeof params.sessionId === 'string') {
      if (state.sessions.size >= 64 || state.sessions.has(params.sessionId)) return;
      const child = { key: params.sessionId, target: { tabId: source.tabId, sessionId: params.sessionId }, parentKey: key };
      state.sessions.set(child.key, child);
      child.ready = this.initialize(state, child).catch(error => { child.error = error; });
    }
    if (method === 'Target.detachedFromTarget') {
      const removed = new Set([params.sessionId]);
      for (const session of state.sessions.values()) if (removed.has(session.parentKey)) removed.add(session.key);
      for (const sessionKey of removed) state.sessions.delete(sessionKey);
      for (const [frameId, frame] of state.frames) if (removed.has(frame.sessionKey)) { state.frames.delete(frameId); state.contexts.delete(frameId); }
    }
    if (method === 'Runtime.executionContextCreated' && params.context?.auxData?.isDefault && typeof params.context.auxData.frameId === 'string') {
      state.contexts.set(params.context.auxData.frameId, { sessionKey: key, executionContextId: params.context.id });
    }
    if (method === 'Runtime.executionContextDestroyed') {
      for (const [frameId, context] of state.contexts) if (context.sessionKey === key && context.executionContextId === params.executionContextId) state.contexts.delete(frameId);
    }
    if (method === 'Runtime.executionContextsCleared') {
      for (const [frameId, context] of state.contexts) if (context.sessionKey === key) state.contexts.delete(frameId);
    }
    if (method === 'Page.frameDetached') {
      const removed = new Set([params.frameId]);
      for (const frame of state.frames.values()) if (removed.has(frame.parentFrameId)) removed.add(frame.frameId);
      for (const frameId of removed) { state.frames.delete(frameId); state.contexts.delete(frameId); }
    }
    if (method === 'Page.frameNavigated') {
      state.contexts.delete(params.frame?.id);
      this.ingest(state, { frame: params.frame }, key, params.frame?.parentId);
    }
  }
  async refresh(tabId) {
    const state = this.tabs.get(tabId);
    if (!state) fail('FRAME_UNAVAILABLE', 'The browser debugger is not attached.');
    // Auto-attach events may introduce a nested child while its parent enables discovery.
    for (let pass = 0; pass < 8; pass++) {
      const size = state.sessions.size;
      await Promise.all([...state.sessions.values()].map(session => session.ready));
      if (state.sessions.size === size) break;
    }
    const trees = [];
    for (const session of state.sessions.values()) {
      try {
        if (!session.initialized) await this.initialize(state, session);
        const { frameTree } = await this.send(session.target, 'Page.getFrameTree', {});
        if (state.sessions.get(session.key) !== session) continue;
        trees.push({ session, frameTree }); session.error = undefined;
      } catch (error) {
        if (session.key === '') throw error;
        session.error = error;
      }
    }
    if (this.tabs.get(tabId) !== state) fail('FRAME_UNAVAILABLE', 'The browser debugger disconnected.');
    // Fresh frame trees are authoritative even if a detach event was missed.
    state.previousFrames = state.frames; state.frames = new Map();
    for (const { session, frameTree } of trees) if (state.sessions.get(session.key) === session) this.ingest(state, frameTree, session.key);
    for (const frameId of state.contexts.keys()) {
      const current = state.frames.get(frameId), previous = state.previousFrames.get(frameId);
      if (!current || (previous && current.loaderId !== previous.loaderId)) state.contexts.delete(frameId);
    }
    state.previousFrames = undefined;
    return state;
  }
  async list(tabId) {
    const state = await this.refresh(tabId);
    return { frames: [...state.frames.values()].slice(0, 200).map(frame => ({
      frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url.slice(0, 2048), name: frame.name.slice(0, 200),
      mainFrame: frame.frameId === state.mainFrameId, available: state.sessions.has(frame.sessionKey) && !state.sessions.get(frame.sessionKey).error && /^(https?:|about:(blank|srcdoc)$)/.test(frame.url),
    })), truncated: state.frames.size > 200 };
  }
  async select(tabId, requestedFrameId) {
    if (requestedFrameId !== undefined && (typeof requestedFrameId !== 'string' || !requestedFrameId || requestedFrameId.length > 256)) fail('INVALID_ARGUMENT', 'frameId must come from browser_frames.');
    const state = await this.refresh(tabId);
    const frameId = requestedFrameId ?? state.mainFrameId;
    const frame = state.frames.get(frameId);
    if (!frame) fail('FRAME_NOT_FOUND', 'This frame is no longer present. Read browser_frames again.');
    if (!/^(https?:|about:(blank|srcdoc)$)/.test(frame.url)) fail('FRAME_UNAVAILABLE', 'This frame is not an accessible web document.');
    const session = state.sessions.get(frame.sessionKey);
    if (!session || session.error) fail('FRAME_UNAVAILABLE', 'Chrome could not attach to this frame. Refresh browser_frames and retry.');
    let context = state.contexts.get(frameId);
    if (context?.sessionKey !== session.key) context = undefined;
    // The main target's default world is sufficient when no context event was needed.
    // A same-process child must have its own context; never fall back to the top document.
    if (!context && frameId !== state.mainFrameId) {
      const { executionContextId } = await this.send(session.target, 'Page.createIsolatedWorld', { frameId, worldName: 'agent-browser-frame' });
      if (!Number.isInteger(executionContextId)) fail('FRAME_UNAVAILABLE', 'Chrome did not expose an execution context for this frame.');
      context = { sessionKey: session.key, executionContextId };
      if (this.tabs.get(tabId) === state && state.frames.get(frameId)?.loaderId === frame.loaderId) state.contexts.set(frameId, context);
    }
    return { ...frame, mainFrameId: state.mainFrameId, target: session.target, executionContextId: context?.executionContextId };
  }
  async loader(tabId, frameId) {
    const state = await this.refresh(tabId);
    const frame = state.frames.get(frameId ?? state.mainFrameId);
    if (!frame) fail('FRAME_NOT_FOUND', 'This frame is no longer present. Read browser_frames again.');
    return frame.loaderId;
  }
  async rootPoint(tabId, selected, point) {
    let frame = selected; let current = { ...point };
    for (let depth = 0; frame.parentFrameId; depth++) {
      if (depth >= 32) fail('FRAME_UNAVAILABLE', 'The frame nesting depth exceeds the interaction limit.');
      const viewport = await this.send(frame.target, 'Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', returnByValue: true, ...(frame.executionContextId === undefined ? {} : { contextId: frame.executionContextId }) });
      const parent = await this.select(tabId, frame.parentFrameId);
      const { backendNodeId } = await this.send(parent.target, 'DOM.getFrameOwner', { frameId: frame.frameId });
      const { object } = await this.send(parent.target, 'DOM.resolveNode', { backendNodeId, ...(parent.executionContextId === undefined ? {} : { executionContextId: parent.executionContextId }) });
      if (!object?.objectId) fail('FRAME_UNAVAILABLE', 'Chrome could not resolve this frame in its parent.');
      try {
        const result = await this.send(parent.target, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: framePoint.toString(), arguments: [{ value: current }, { value: viewport.result?.value }], returnByValue: true });
        if (result.exceptionDetails || !result.result?.value?.ok) fail('FRAME_NOT_ACTIONABLE', result.result?.value?.reason || 'This frame is covered or has an unsupported transform.');
        current = { x: result.result.value.x, y: result.result.value.y };
      } finally { await this.send(parent.target, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
      frame = parent;
    }
    return current;
  }
}

// Executed in a parent frame, with `this` bound to its iframe element.
export function framePoint(point, viewport) {
  if (!this.isConnected || !viewport?.width || !viewport?.height) return { ok: false, reason: 'The frame changed during targeting.' };
  for (let ancestor = this; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode()?.host) {
    const style = getComputedStyle(ancestor);
    if ((style.rotate && style.rotate !== 'none') || (style.perspective && style.perspective !== 'none')) return { ok: false, reason: 'Rotated or perspective-transformed frames are not supported.' };
    // Individual transforms are not included in the computed `transform`
    // matrix. A negative scale reflects content while keeping a positive
    // bounding box, so the normal coordinate mapping would hit the wrong item.
    if (style.scale && style.scale !== 'none') {
      const scale = style.scale.trim().split(/\s+/).map(value => Number.parseFloat(value));
      if (!scale.length || scale.some(value => !Number.isFinite(value) || value <= 0)) return { ok: false, reason: 'Flipped or collapsed frames are not supported.' };
    }
    if (style.transform && style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return { ok: false, reason: 'Rotated, skewed or flipped frames are not supported.' };
    }
  }
  const rect = this.getBoundingClientRect();
  if (!this.offsetWidth || !this.offsetHeight) return { ok: false, reason: 'The frame has no visible layout.' };
  const x = rect.left + (this.clientLeft + point.x * this.clientWidth / viewport.width) * rect.width / this.offsetWidth;
  const y = rect.top + (this.clientTop + point.y * this.clientHeight / viewport.height) * rect.height / this.offsetHeight;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
  if (hit !== this || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, reason: 'The frame is outside the viewport or covered by another element.' };
  return { ok: true, x, y };
}

// Return one unique CSS match across the selected document and its open shadow roots.
export function shadowQuery(selector) {
  const roots = [document]; const found = new Set(); let visited = 0;
  for (let index = 0; index < roots.length; index++) {
    if (index >= 256) throw new Error('TARGET_SEARCH_LIMIT: Narrow the selector or use a snapshot reference.');
    let matches;
    try { matches = roots[index].querySelectorAll(selector); } catch { throw new Error('INVALID_SELECTOR: Invalid CSS selector.'); }
    for (const node of matches) { found.add(node); if (found.size > 1) throw new Error('AMBIGUOUS_TARGET: More than one element matches. Use a unique selector or snapshot reference.'); }
    for (const node of roots[index].querySelectorAll('*')) {
      if (++visited > 30000) throw new Error('TARGET_SEARCH_LIMIT: Narrow the page with a snapshot reference.');
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  return found.values().next().value || null;
}

// Executed on a resolved element, in its document's coordinate system.
export function pointerProbe() {
  if (!this.isConnected || this.disabled || this.matches(':disabled')) return { ok: false };
  for (let ancestor = this; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode()?.host) {
    if (ancestor.inert || ancestor.getAttribute('aria-disabled') === 'true') return { ok: false };
  }
  const rect = this.getBoundingClientRect();
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return { ok: false };
  const x = (left + right) / 2, y = (top + bottom) / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
  for (let node = hit; node; node = node.parentNode || node.getRootNode()?.host) if (node === this) return { ok: true, x, y };
  return { ok: false };
}
