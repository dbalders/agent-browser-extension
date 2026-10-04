import { BrowserFault } from './controller.js';

const fail = (code, message) => { throw new BrowserFault(code, message); };
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit = 256) => typeof value === 'string' ? value.slice(0, limit) : '';
const CPU_SCOPE = 'Selected tab renderer V8 isolate, including other contexts sharing that isolate. Not document-only. Out-of-process frames, workers, browser and GPU are not included.';
const TRACE_SCOPE = 'Selected document PerformanceObserver entries only. Synthetic trace track; not a browser, GPU, network-payload or JavaScript-stack trace.';
const TAB_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
export const INSPECT_PROPERTIES = ['display', 'visibility', 'opacity', 'position', 'z-index', 'top', 'right', 'bottom', 'left', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'box-sizing', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-radius', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'overflow', 'overflow-x', 'overflow-y', 'white-space', 'flex-direction', 'align-items', 'justify-content', 'gap', 'grid-template-columns', 'grid-template-rows', 'transform', 'pointer-events'];
const DEFAULT_PROPERTIES = ['display', 'visibility', 'position', 'width', 'height', 'box-sizing', 'color', 'background-color', 'font-family', 'font-size', 'line-height', 'overflow', 'pointer-events'];

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return url.protocol;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.slice(0, 1024);
  } catch { return '[URL omitted]'; }
}

function validate(args, kind) {
  const actions = kind === 'profile' ? ['start', 'stop', 'status', 'read', 'clear'] : ['snapshot', 'start', 'stop', 'status', 'read', 'clear'];
  const action = args?.action ?? (kind === 'profile' ? 'status' : 'snapshot');
  const id = kind === 'profile' ? 'profileId' : 'traceId';
  const allowed = ['tabId', 'action', id, 'offset', 'length', 'durationMs', ...(kind === 'profile' ? ['samplingIntervalUs'] : ['frameId', 'limit'])];
  if (!isRecord(args) || Object.keys(args).some(key => !allowed.includes(key)) || !actions.includes(action)) fail('INVALID_ARGUMENT', 'Unsupported debugging action or argument.');
  if (args.tabId !== undefined && !integer(args.tabId)) fail('INVALID_ARGUMENT', 'tabId must be a nonnegative integer.');
  if (args.frameId !== undefined && (typeof args.frameId !== 'string' || !args.frameId || args.frameId.length > 200)) fail('INVALID_ARGUMENT', 'frameId must be a nonempty bounded string.');
  for (const [key, low, high] of [['durationMs', 100, 30000], ['samplingIntervalUs', 1000, 10000], ['limit', 1, 100], ['offset', 0, 2 * 1024 * 1024], ['length', 1, 12000]]) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < low || args[key] > high)) fail('INVALID_ARGUMENT', `${key} must be an integer from ${low} to ${high}.`);
  }
  if (args[id] !== undefined && (typeof args[id] !== 'string' || !/^[a-z0-9-]{1,100}$/.test(args[id]))) fail('INVALID_ARGUMENT', `${id} must be a valid capture identifier.`);
  if (action !== 'start' && ['durationMs', 'samplingIntervalUs'].some(key => args[key] !== undefined)) fail('INVALID_ARGUMENT', 'Capture timing options apply only to start.');
  if (action !== 'read' && [id, 'offset', 'length'].some(key => args[key] !== undefined)) fail('INVALID_ARGUMENT', 'Artifact identifiers and chunk options apply only to read.');
  if (action === 'read' && args[id] === undefined) fail('INVALID_ARGUMENT', `${id} is required when reading an artifact.`);
  if (args.limit !== undefined && action !== 'snapshot') fail('INVALID_ARGUMENT', 'limit applies only to a performance snapshot.');
  return action;
}

function valueOf(result) {
  if (result.exceptionDetails) fail('DEBUGGING_CONTEXT_LOST', 'The document or debugging context changed. Start a new capture.');
  return result.result?.value;
}

function isolatedContext(result) {
  const id = result?.executionContextId;
  if (!Number.isSafeInteger(id) || id <= 0) fail('DEBUGGING_UNAVAILABLE', 'Chrome did not provide an isolated performance execution context.');
  return id;
}

function profileFailure(error) {
  let detail = error;
  try { const parsed = JSON.parse(error.message); if (isRecord(parsed)) detail = parsed; } catch { /* Chrome may return a plain message. */ }
  if (detail.code === -32601 && /Profiler\./.test(detail.message || '')) {
    return new BrowserFault('PROFILE_UNAVAILABLE', 'Chrome does not expose CPU profiling to this extension debugger connection. Use browser_performance for document timings and traces, or capture a CPU profile manually in Chrome DevTools.');
  }
  return error;
}

// Preserve the public CDP Profile shape so concatenated chunks can be saved as
// .cpuprofile. Reject invalid/oversized graphs rather than silently corrupt them.
export function sanitizeProfile(input) {
  if (!isRecord(input) || !Array.isArray(input.nodes) || !input.nodes.length || !finite(input.startTime) || !finite(input.endTime) || input.endTime < input.startTime) fail('INVALID_PROFILE', 'Chrome returned an invalid CPU profile.');
  const samples = input.samples ?? []; const deltas = input.timeDeltas ?? [];
  if (!Array.isArray(samples) || !Array.isArray(deltas) || samples.length !== deltas.length) fail('INVALID_PROFILE', 'Chrome returned inconsistent CPU profile samples.');
  if (input.nodes.length > 20000 || samples.length > 60000) fail('PROFILE_TOO_LARGE', 'CPU capture exceeded 20000 nodes or 60000 samples. Retry with a shorter capture or longer sampling interval.');
  const ids = new Set();
  for (const node of input.nodes) {
    if (!isRecord(node) || !Number.isSafeInteger(node.id) || node.id < 1 || ids.has(node.id) || !isRecord(node.callFrame)) fail('INVALID_PROFILE', 'Chrome returned an invalid CPU profile node.');
    ids.add(node.id);
  }
  const nodes = input.nodes.map(node => {
    const frame = node.callFrame;
    if (node.children !== undefined && (!Array.isArray(node.children) || node.children.some(id => !ids.has(id)))) fail('INVALID_PROFILE', 'CPU profile contains an invalid child reference.');
    return {
      id: node.id,
      callFrame: { functionName: text(frame.functionName), scriptId: text(frame.scriptId, 80), url: safeUrl(frame.url), lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber : -1, columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber : -1 },
      ...(integer(node.hitCount) ? { hitCount: node.hitCount } : {}),
      ...(node.children ? { children: [...node.children] } : {}),
      ...(typeof node.deoptReason === 'string' ? { deoptReason: text(node.deoptReason) } : {}),
    };
  });
  const parents = new Map();
  for (const node of nodes) for (const child of node.children || []) {
    if (parents.has(child)) fail('INVALID_PROFILE', 'CPU profile nodes must form a tree with one parent per child.');
    parents.set(child, node.id);
  }
  const roots = nodes.filter(node => !parents.has(node.id));
  if (roots.length !== 1) fail('INVALID_PROFILE', 'CPU profile must contain exactly one root.');
  const byId = new Map(nodes.map(node => [node.id, node])); const visited = new Set(); const pending = [roots[0].id];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) fail('INVALID_PROFILE', 'CPU profile contains a cycle.');
    visited.add(id); pending.push(...(byId.get(id).children || []));
  }
  if (visited.size !== nodes.length) fail('INVALID_PROFILE', 'CPU profile contains disconnected or cyclic nodes.');
  if (samples.some(id => !ids.has(id)) || deltas.some(delta => !integer(delta))) fail('INVALID_PROFILE', 'CPU profile contains invalid sample references or timing.');
  return { nodes, startTime: input.startTime, endTime: input.endTime, samples: [...samples], timeDeltas: [...deltas] };
}

// Original wrapper around public Profiler/Performance commands. Some Chrome
// builds restrict Profiler to trusted DevTools clients, so start must probe and
// report unavailability. No alternate transport bypasses that restriction:
// https://raw.githubusercontent.com/v8/v8/main/src/inspector/v8-inspector-session-impl.cc
// No browser-wide Tracing is enabled. CPU profiles have no context filter:
// https://raw.githubusercontent.com/v8/v8/main/src/inspector/v8-profiler-agent-impl.cc
export class PageDebugging {
  constructor(adapter) { this.adapter = adapter; this.profiles = new Map(); this.timelines = new Map(); this.artifacts = new Map(); this.pending = new Map(); this.sequence = 0; }
  id(prefix) { return `${prefix}-${Date.now().toString(36)}-${++this.sequence}`; }
  async direct(target, method, params = {}) {
    let timer;
    try { return await Promise.race([this.adapter.chrome.debugger.sendCommand(target, method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserFault('DEBUGGING_TIMEOUT', 'Chrome did not finish the debugging command.')), 2000); })]) || {}; }
    finally { clearTimeout(timer); }
  }
  current(map, state) { if (state.cancelled || map.get(state.tabId) !== state) fail('DEBUGGING_CANCELLED', 'The capture was cancelled or its document changed.'); }
  track(state, kind, task) {
    // Navigation/clear remove public state immediately, but a new capture must
    // still wait for the previous stop/disable or object release to finish.
    const key = `${state.tabId}:${kind}`; const settled = task.then(() => {}, () => {});
    this.pending.set(key, settled);
    void settled.then(() => { if (this.pending.get(key) === settled) this.pending.delete(key); });
    return task;
  }
  metadata(state, kind) {
    const artifact = this.artifacts.get(`${state.tabId}:${kind}`);
    return { state: state.phase, scope: kind === 'profile' ? CPU_SCOPE : TRACE_SCOPE, ...(kind === 'profile' ? { supported: state.supported ?? null } : {}), ...(state.frameId ? { frameId: state.frameId } : {}), startedAt: state.startedAt, deadline: state.deadline, ...(state.error ? { error: state.error } : {}), ...(artifact && artifact.id === state.id ? artifact.metadata : {}) };
  }
  artifact(state, kind, content, summary) {
    const serialized = JSON.stringify(content); const size = bytes(serialized); const key = `${state.tabId}:${kind}`;
    let tabSize = size; let total = size;
    for (const [existingKey, item] of this.artifacts) if (existingKey !== key) { total += item.bytes; if (item.tabId === state.tabId) tabSize += item.bytes; }
    if (tabSize > TAB_BYTES || total > TOTAL_BYTES) fail('DEBUGGING_STORAGE_LIMIT', 'Capture artifacts exceed the 2 MiB per-tab or 8 MiB total memory limit. Clear an artifact or capture less work.');
    const idKey = kind === 'profile' ? 'profileId' : 'traceId';
    const metadata = { [idKey]: state.id, scope: kind === 'profile' ? CPU_SCOPE : TRACE_SCOPE, ...(kind === 'profile' ? { supported: true } : {}), ...(state.frameId ? { frameId: state.frameId } : {}), format: kind === 'profile' ? 'cpuprofile' : 'chrome-trace', fileName: `${state.id}.${kind === 'profile' ? 'cpuprofile' : 'json'}`, totalLength: serialized.length, bytes: size, summary };
    this.artifacts.set(key, { id: state.id, tabId: state.tabId, data: serialized, bytes: size, metadata });
    return metadata;
  }
  read(tabId, kind, args) {
    const artifact = this.artifacts.get(`${tabId}:${kind}`); const id = args[kind === 'profile' ? 'profileId' : 'traceId'];
    if (!artifact || artifact.id !== id) fail('DEBUGGING_ARTIFACT_NOT_FOUND', 'This artifact is no longer retained by this owned tab. Capture again.');
    const offset = args.offset ?? 0;
    if (offset > artifact.data.length) fail('INVALID_ARGUMENT', 'offset exceeds the artifact length.');
    const chunk = artifact.data.slice(offset, offset + (args.length ?? 12000));
    return { ...artifact.metadata, summary: undefined, offset, nextOffset: offset + chunk.length, done: offset + chunk.length === artifact.data.length, chunk, offsetUnits: 'UTF-16 code units; concatenate chunk strings before writing UTF-8 JSON.' };
  }
  async profile(tabId, args) {
    const action = validate(args, 'profile');
    if (args.tabId !== undefined && args.tabId !== tabId) fail('INVALID_ARGUMENT', 'tabId does not match the owned tab.');
    if (action === 'read') return this.read(tabId, 'profile', args);
    while (action === 'start' && this.pending.has(`${tabId}:profile`)) await this.pending.get(`${tabId}:profile`);
    const existing = this.profiles.get(tabId);
    if (action === 'status') return existing ? this.metadata(existing, 'profile') : { state: 'idle', scope: CPU_SCOPE, supported: null };
    if (action === 'clear') { this.artifacts.delete(`${tabId}:profile`); if (existing) { existing.cancelled = true; this.profiles.delete(tabId); await this.stopProfile(existing, true).catch(() => {}); } return { cleared: true, scope: CPU_SCOPE, supported: existing?.supported ?? null }; }
    if (action === 'stop') { if (!existing) fail('PROFILE_NOT_RUNNING', 'There is no CPU capture for this tab.'); return this.stopProfile(existing); }
    if (existing && ['starting', 'recording', 'stopping'].includes(existing.phase)) fail('PROFILE_BUSY', 'A CPU capture is already active in this tab.');
    if ([...this.profiles.values()].filter(state => ['starting', 'recording', 'stopping'].includes(state.phase)).length >= 4) fail('PROFILE_BUSY', 'At most four CPU captures may run concurrently.');
    const durationMs = args.durationMs ?? 10000;
    const state = { tabId, target: { tabId }, id: this.id('cpu'), phase: 'starting', startedAt: Date.now(), deadline: Date.now() + durationMs, cancelled: false };
    this.profiles.set(tabId, state);
    state.startTask = (async () => {
      try {
        await this.adapter.rawSend(state.target, 'Profiler.enable'); state.enabled = true; state.supported = true; this.current(this.profiles, state);
        await this.adapter.rawSend(state.target, 'Profiler.setSamplingInterval', { interval: args.samplingIntervalUs ?? 1000 }); this.current(this.profiles, state);
        await this.adapter.rawSend(state.target, 'Profiler.start'); state.running = true; this.current(this.profiles, state);
        state.phase = 'recording'; state.startedAt = Date.now(); state.deadline = state.startedAt + durationMs;
        state.timer = setTimeout(() => { void this.stopProfile(state).catch(() => {}); }, durationMs);
        return this.metadata(state, 'profile');
      } catch (error) {
        error = profileFailure(error);
        if (error.code === 'PROFILE_UNAVAILABLE') state.supported = false;
        state.phase = 'error'; state.error = { code: error.code || 'DEBUGGING_FAILED', message: text(error.message, 500) };
        if (state.enabled || error.code !== 'PROFILE_UNAVAILABLE') await this.direct(state.target, 'Profiler.disable').catch(() => {});
        state.enabled = false; throw error;
      }
    })();
    return this.track(state, 'profile', state.startTask);
  }
  async stopProfile(state, discard = false) {
    if (state.stopTask) return state.stopTask;
    if (['stopped', 'error'].includes(state.phase)) return this.metadata(state, 'profile');
    clearTimeout(state.timer);
    state.stopTask = (async () => {
      await state.startTask?.catch(() => {}); clearTimeout(state.timer); state.phase = 'stopping';
      try {
        const result = state.running ? await this.direct(state.target, 'Profiler.stop') : {};
        state.running = false;
        if (!discard) {
          this.current(this.profiles, state);
          const profile = sanitizeProfile(result.profile);
          const counts = new Map(); for (let i = 0; i < profile.samples.length; i++) counts.set(profile.samples[i], (counts.get(profile.samples[i]) || 0) + profile.timeDeltas[i]);
          const hottest = profile.nodes.map(node => ({ functionName: node.callFrame.functionName, url: node.callFrame.url, lineNumber: node.callFrame.lineNumber, sampledMs: (counts.get(node.id) || 0) / 1000 })).sort((a, b) => b.sampledMs - a.sampledMs).slice(0, 10);
          this.artifact(state, 'profile', profile, { nodes: profile.nodes.length, samples: profile.samples.length, durationMs: (profile.endTime - profile.startTime) / 1000, hottest, urlCredentialsQueriesAndFragmentsRemoved: true });
        }
        state.phase = 'stopped'; return this.metadata(state, 'profile');
      } catch (error) { state.phase = 'error'; state.error = { code: error.code || 'DEBUGGING_FAILED', message: text(error.message, 500) }; if (!discard) throw error; }
      finally { await this.direct(state.target, 'Profiler.disable').catch(() => {}); state.enabled = false; }
    })();
    return this.track(state, 'profile', state.stopTask);
  }
  async performance(tabId, args, scope) {
    const action = validate(args, 'performance');
    if (args.tabId !== undefined && args.tabId !== tabId) fail('INVALID_ARGUMENT', 'tabId does not match the owned tab.');
    if (action === 'read') return this.read(tabId, 'trace', args);
    while (action === 'start' && this.pending.has(`${tabId}:trace`)) await this.pending.get(`${tabId}:trace`);
    const existing = this.timelines.get(tabId);
    if (action === 'status') return existing ? this.metadata(existing, 'trace') : { state: 'idle', scope: TRACE_SCOPE };
    if (action === 'clear') { this.artifacts.delete(`${tabId}:trace`); if (existing) { existing.cancelled = true; this.timelines.delete(tabId); await this.stopTimeline(existing, true).catch(() => {}); } return { cleared: true, scope: TRACE_SCOPE }; }
    if (action === 'stop') { if (!existing) fail('TRACE_NOT_RUNNING', 'There is no document timeline capture for this tab.'); return this.stopTimeline(existing); }
    if (!scope?.frameId) fail('FRAME_UNAVAILABLE', 'Select an available frame before collecting performance data.');
    if (action === 'snapshot') return this.performanceSnapshot(tabId, args, scope);
    if (existing && ['starting', 'recording', 'stopping'].includes(existing.phase)) fail('TRACE_BUSY', 'A document timeline is already active in this tab.');
    if ([...this.timelines.values()].filter(state => ['starting', 'recording', 'stopping'].includes(state.phase)).length >= 8) fail('TRACE_BUSY', 'At most eight document timelines may run concurrently.');
    const durationMs = args.durationMs ?? 10000;
    const state = { tabId, target: { ...scope.target }, frameId: scope.frameId, id: this.id('trace'), phase: 'starting', startedAt: Date.now(), deadline: Date.now() + durationMs, cancelled: false };
    this.timelines.set(tabId, state);
    state.startTask = (async () => {
      try {
        const executionContextId = isolatedContext(await this.adapter.rawSend(state.target, 'Page.createIsolatedWorld', { frameId: state.frameId, worldName: 'agent-browser-extension-performance' }));
        this.current(this.timelines, state); state.contextId = executionContextId;
        const result = await this.adapter.rawSend(state.target, 'Runtime.evaluate', { contextId: executionContextId, expression: `(${createTimeline.toString()})(${durationMs})`, returnByValue: false, timeout: 2000 });
        if (result.exceptionDetails || !result.result?.objectId) fail('DEBUGGING_UNAVAILABLE', 'Chrome could not start the document PerformanceObserver.');
        state.objectId = result.result.objectId; this.current(this.timelines, state);
        state.phase = 'recording'; state.startedAt = Date.now(); state.deadline = state.startedAt + durationMs;
        state.timer = setTimeout(() => { void this.stopTimeline(state).catch(() => {}); }, durationMs);
        return this.metadata(state, 'trace');
      } catch (error) {
        state.phase = 'error'; state.error = { code: error.code || 'DEBUGGING_FAILED', message: text(error.message, 500) };
        if (state.objectId) {
          await this.direct(state.target, 'Runtime.callFunctionOn', { objectId: state.objectId, functionDeclaration: 'function() { return this.stop(); }', returnByValue: true }).catch(() => {});
          await this.direct(state.target, 'Runtime.releaseObject', { objectId: state.objectId }).catch(() => {}); state.objectId = undefined;
        }
        throw error;
      }
    })();
    return this.track(state, 'trace', state.startTask);
  }
  async stopTimeline(state, discard = false) {
    if (state.stopTask) return state.stopTask;
    if (['stopped', 'error'].includes(state.phase)) return this.metadata(state, 'trace');
    clearTimeout(state.timer);
    state.stopTask = (async () => {
      await state.startTask?.catch(() => {}); clearTimeout(state.timer); state.phase = 'stopping';
      try {
        const result = state.objectId ? await this.direct(state.target, 'Runtime.callFunctionOn', { objectId: state.objectId, functionDeclaration: 'function() { return this.stop(); }', returnByValue: true }) : {};
        if (!discard) {
          this.current(this.timelines, state); const timeline = valueOf(result);
          if (!isRecord(timeline) || !Array.isArray(timeline.entries) || timeline.entries.length > 1000) fail('INVALID_TRACE', 'Chrome returned an invalid document timeline.');
          const traceEvents = [{ name: 'process_name', ph: 'M', pid: 1, tid: 1, args: { name: 'Selected document' } }, { name: 'thread_name', ph: 'M', pid: 1, tid: 1, args: { name: 'PerformanceObserver (synthetic track)' } }];
          for (const entry of timeline.entries) traceEvents.push({ name: entry.name, cat: `document.${entry.entryType}`, ph: entry.duration > 0 ? 'X' : 'i', ...(entry.duration > 0 ? { dur: entry.duration * 1000 } : { s: 't' }), ts: entry.startTime * 1000, pid: 1, tid: 1, args: entry });
          const summary = { entries: timeline.entries.length, dropped: timeline.dropped, supportedTypes: timeline.supportedTypes, durationMs: timeline.durationMs, timeOrigin: timeline.timeOrigin, truncated: timeline.dropped > 0 };
          this.artifact(state, 'trace', { traceEvents, displayTimeUnit: 'ms', metadata: { scope: TRACE_SCOPE, frameId: state.frameId, ...summary } }, summary);
        }
        state.phase = 'stopped'; return this.metadata(state, 'trace');
      } catch (error) { state.phase = 'error'; state.error = { code: error.code || 'DEBUGGING_CONTEXT_LOST', message: text(error.message, 500) }; if (!discard) throw error; }
      finally { if (state.objectId) await this.direct(state.target, 'Runtime.releaseObject', { objectId: state.objectId }).catch(() => {}); state.objectId = undefined; }
    })();
    return this.track(state, 'trace', state.stopTask);
  }
  async performanceSnapshot(tabId, args, scope) {
    let metrics = [];
    try {
      await this.adapter.rawSend(scope.target, 'Performance.enable', { timeDomain: 'timeTicks' });
      const result = await this.adapter.rawSend(scope.target, 'Performance.getMetrics');
      const names = ['Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize', 'DomContentLoaded', 'NavigationStart'];
      metrics = (result.metrics || []).filter(metric => names.includes(metric.name) && finite(metric.value)).map(metric => ({ name: metric.name, value: metric.value }));
    } finally { await this.direct(scope.target, 'Performance.disable').catch(() => {}); }
    const contextId = isolatedContext(await this.adapter.rawSend(scope.target, 'Page.createIsolatedWorld', { frameId: scope.frameId, worldName: 'agent-browser-extension-performance' }));
    const result = await this.adapter.rawSend(scope.target, 'Runtime.evaluate', { contextId, expression: `(${snapshotPerformance.toString()})(${args.limit ?? 50})`, returnByValue: true, timeout: 2000 });
    const timeline = valueOf(result);
    if (!isRecord(timeline)) fail('DEBUGGING_CONTEXT_LOST', 'The document changed while reading its performance data.');
    const output = { frameId: scope.frameId, scope: 'Document timing plus selected renderer target counters. Counters may include same-process contexts; snapshot excludes observer-only long tasks and layout shifts.', metrics, timeline };
    while (bytes(output) > 75000 && timeline.entries?.length) { timeline.entries.pop(); timeline.truncated = true; }
    return output;
  }
  event(source, method, params = {}) {
    const tabId = source.tabId; const timeline = this.timelines.get(tabId); const profile = this.profiles.get(tabId);
    const sameTarget = timeline && (source.sessionId || '') === (timeline.target.sessionId || '');
    const mainNavigation = method === 'Page.frameNavigated' && !source.sessionId && params.frame && !params.frame.parentId;
    const lost = timeline && ((method === 'Page.frameNavigated' && params.frame?.id === timeline.frameId) || (method === 'Page.frameDetached' && params.frameId === timeline.frameId) || (sameTarget && method === 'Runtime.executionContextDestroyed' && params.executionContextId === timeline.contextId) || (sameTarget && method === 'Runtime.executionContextsCleared') || (method === 'Target.detachedFromTarget' && params.sessionId === timeline.target.sessionId));
    if (mainNavigation && profile) { profile.cancelled = true; profile.error = { code: 'DEBUGGING_CONTEXT_LOST', message: 'Navigation invalidated the CPU capture.' }; this.profiles.delete(tabId); void this.stopProfile(profile, true).catch(() => {}); }
    if (lost || mainNavigation) {
      if (timeline) { timeline.cancelled = true; this.timelines.delete(tabId); void this.stopTimeline(timeline, true).catch(() => {}); }
      this.artifacts.delete(`${tabId}:trace`);
    }
    if (mainNavigation) this.artifacts.delete(`${tabId}:profile`);
  }
  forget(tabId) {
    for (const map of [this.profiles, this.timelines]) { const state = map.get(tabId); if (state) { state.cancelled = true; clearTimeout(state.timer); map.delete(tabId); } }
    this.artifacts.delete(`${tabId}:profile`); this.artifacts.delete(`${tabId}:trace`);
  }
  async dispose(tabId) {
    const profile = this.profiles.get(tabId); const timeline = this.timelines.get(tabId); this.forget(tabId);
    let timer;
    try { await Promise.race([Promise.allSettled([profile ? this.stopProfile(profile, true) : undefined, timeline ? this.stopTimeline(timeline, true) : undefined]), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  }
}

// Serialized into an isolated world for one document. Each observer and its
// bounded ring live in a returned remote object, never a page-global property.
export function createTimeline(durationMs) {
  const types = ['longtask', 'resource', 'mark', 'measure', 'paint', 'layout-shift', 'largest-contentful-paint', 'navigation'];
  const supportedTypes = types.filter(type => PerformanceObserver.supportedEntryTypes.includes(type));
  if (!supportedTypes.length) throw new Error('PerformanceObserver is unavailable.');
  const start = performance.now(); const deadline = start + durationMs; const entries = []; let dropped = 0; let recording = true; let ended = start; let timer;
  const url = value => {
    try { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol)) return parsed.protocol; parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; return parsed.href.slice(0, 512); } catch { return '[URL omitted]'; }
  };
  const capture = batch => {
    const from = Math.max(0, batch.length - 2000); dropped += from;
    for (let index = from; index < batch.length; index++) {
      const entry = batch[index];
      if (!supportedTypes.includes(entry.entryType) || !Number.isFinite(entry.startTime) || entry.startTime < start || entry.startTime > deadline) continue;
      const result = { entryType: entry.entryType, name: ['resource', 'navigation'].includes(entry.entryType) ? url(entry.name) : String(entry.name || '').slice(0, 256), startTime: entry.startTime, duration: Math.max(0, Number(entry.duration) || 0) };
      for (const key of ['transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStart', 'responseEnd', 'requestStart', 'value', 'renderTime', 'loadTime', 'size']) if (Number.isFinite(entry[key])) result[key] = entry[key];
      if (typeof entry.hadRecentInput === 'boolean') result.hadRecentInput = entry.hadRecentInput;
      if (entry.initiatorType) result.initiatorType = String(entry.initiatorType).slice(0, 40);
      if (entry.url) result.url = url(entry.url);
      if (entries.length >= 1000) { entries.shift(); dropped++; }
      entries.push(result);
    }
  };
  const observer = new PerformanceObserver(list => { if (!recording) return; capture(list.getEntries()); if (performance.now() >= deadline) stop(); });
  observer.observe({ entryTypes: supportedTypes });
  function stop() {
    if (recording) { capture(observer.takeRecords()); observer.disconnect(); recording = false; ended = performance.now(); clearTimeout(timer); }
    return { entries: [...entries].sort((a, b) => a.startTime - b.startTime), dropped, supportedTypes, durationMs: ended - start, timeOrigin: performance.timeOrigin };
  }
  timer = setTimeout(stop, durationMs);
  return { stop };
}

export function snapshotPerformance(limit) {
  const types = ['navigation', 'resource', 'mark', 'measure', 'paint'];
  const url = value => { try { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol)) return parsed.protocol; parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; return parsed.href.slice(0, 512); } catch { return '[URL omitted]'; } };
  const all = performance.getEntries().filter(entry => types.includes(entry.entryType));
  const entries = all.slice(-limit).map(entry => {
    const result = { entryType: entry.entryType, name: ['resource', 'navigation'].includes(entry.entryType) ? url(entry.name) : String(entry.name || '').slice(0, 256), startTime: entry.startTime, duration: entry.duration };
    for (const key of ['transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStart', 'responseEnd', 'requestStart', 'domInteractive', 'domContentLoadedEventEnd', 'loadEventEnd']) if (Number.isFinite(entry[key])) result[key] = entry[key];
    if (entry.initiatorType) result.initiatorType = String(entry.initiatorType).slice(0, 40);
    return result;
  });
  return { timeOrigin: performance.timeOrigin, now: performance.now(), entries, truncated: all.length > entries.length, supportedTypes: types };
}

export async function inspectTarget(adapter, tabId, args) {
  if (!isRecord(args) || Object.keys(args).some(key => !['tabId', 'frameId', 'ref', 'selector', 'locator', 'properties'].includes(key))) fail('INVALID_ARGUMENT', 'Unsupported DOM inspection argument.');
  const properties = args.properties ?? DEFAULT_PROPERTIES;
  if (!Array.isArray(properties) || !properties.length || properties.length > 30 || new Set(properties).size !== properties.length || properties.some(property => !INSPECT_PROPERTIES.includes(property))) fail('INVALID_ARGUMENT', 'properties must contain 1–30 distinct supported CSS property names.');
  return adapter.call(tabId, args, `function(properties) { return (${inspectElement.toString()})(this, properties); }`, [properties]);
}

export function inspectElement(element, properties) {
  if (!element || element.nodeType !== 1 || !element.isConnected) throw new Error('The inspected element is no longer attached.');
  let truncated = false;
  const clip = (value, limit) => { if (value.length > limit) truncated = true; return value.slice(0, limit); };
  const style = getComputedStyle(element); const box = element.getBoundingClientRect(); const styles = {};
  for (const property of properties) styles[property] = clip(style.getPropertyValue(property), 512);
  const attributes = {};
  for (const key of ['role', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected', 'type', 'name', 'disabled', 'readonly', 'required', 'placeholder', 'title']) if (element.hasAttribute(key)) attributes[key] = clip(element.getAttribute(key), 256);
  const classNames = [];
  for (const value of element.classList) { if (classNames.length === 20) { truncated = true; break; } classNames.push(clip(value, 100)); }
  let inert = false; for (let node = element; node; node = node.parentElement || node.getRootNode()?.host) if (node.inert) inert = true;
  const output = {
    tagName: clip(element.tagName.toLowerCase(), 100), id: clip(element.id, 256), classNames, attributes,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height }, styles,
    states: { attached: element.isConnected, disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true', inert, readOnly: !!element.readOnly, editable: !!element.isContentEditable, hasOpenShadowRoot: !!element.shadowRoot },
    childElementCount: element.childElementCount, formValuesOmitted: true, truncated,
  };
  // JSON escaping can turn one control character into six output bytes. Bound
  // the complete serialized result, not just individual CSS character counts.
  const strings = [[output, 'tagName'], [output, 'id'], ...classNames.map((_, index) => [classNames, index]), ...Object.keys(attributes).map(key => [attributes, key]), ...Object.keys(styles).map(key => [styles, key])];
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(output)).length > 75000) {
    strings.sort((a, b) => b[0][b[1]].length - a[0][a[1]].length);
    const [object, key] = strings[0]; object[key] = object[key].slice(0, Math.floor(object[key].length / 2)); output.truncated = true;
  }
  return output;
}
