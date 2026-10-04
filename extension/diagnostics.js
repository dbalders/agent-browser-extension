import { BrowserFault } from './controller.js';

const BUFFER_LIMIT = 200;
const PENDING_LIMIT = 200;
const READ_BYTE_LIMIT = 75000;
const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fail = (code, message) => { throw new BrowserFault(code, message); };

// Never retain credentials, queries, fragments, data URLs, headers or bodies in
// network observations. URL paths and page-generated console text can be private.
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 65536) return '[URL omitted]';
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return url.protocol;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.slice(0, 2048);
  } catch { return '[invalid URL]'; }
}

function describe(value) {
  if (!record(value)) return '';
  if (value.type === 'string') return text(value.value);
  if (value.type === 'undefined') return 'undefined';
  if (value.subtype === 'null') return 'null';
  if (['number', 'boolean', 'bigint'].includes(value.type)) {
    if (typeof value.value === 'number' || typeof value.value === 'boolean') return String(value.value);
    return text(value.unserializableValue, 100);
  }
  // CDP supplies descriptions for remote objects. Never fetch their properties
  // or serialize previews, which can be large or require evaluating getters.
  return text(value.description || value.type);
}

function argumentText(args) {
  if (!Array.isArray(args)) return '';
  let result = '';
  for (const arg of args.slice(0, 20)) {
    result += `${result ? ' ' : ''}${describe(arg)}`;
    if (result.length >= 1000) break;
  }
  return result.slice(0, 1000);
}

function stackText(stack) {
  if (!record(stack) || !Array.isArray(stack.callFrames)) return '';
  return stack.callFrames.slice(0, 8).filter(record).map(frame => {
    const location = typeof frame.url === 'string' ? safeUrl(frame.url).slice(0, 300) : '';
    const line = integer(frame.lineNumber) ? `:${frame.lineNumber + 1}` : '';
    const column = integer(frame.columnNumber) ? `:${frame.columnNumber + 1}` : '';
    return `${text(frame.functionName, 80) || '(anonymous)'}@${location}${line}${column}`;
  }).join('\n').slice(0, 1000);
}

function sourceFields(source) {
  return typeof source.sessionId === 'string' && source.sessionId ? { targetSessionId: text(source.sessionId, 200) } : {};
}

function responseFields(response) {
  if (!record(response)) return {};
  return {
    ...(Number.isInteger(response.status) && response.status >= 0 && response.status <= 999 ? { status: response.status } : {}),
    ...(typeof response.mimeType === 'string' ? { mimeType: text(response.mimeType, 100) } : {}),
    ...(typeof response.protocol === 'string' ? { protocol: text(response.protocol, 40) } : {}),
    fromCache: response.fromDiskCache === true || response.fromPrefetchCache === true,
    fromServiceWorker: response.fromServiceWorker === true,
  };
}

export class PageDiagnostics {
  constructor() { this.tabs = new Map(); this.sequence = 0; }

  start(tabId) {
    if (!integer(tabId)) fail('INVALID_ARGUMENT', 'tabId must be a nonnegative integer.');
    this.tabs.set(tabId, {
      console: { entries: [], dropped: 0, sinceMs: Date.now() },
      network: { entries: [], dropped: 0, sinceMs: Date.now(), pending: new Map(), droppedPending: 0 },
    });
  }

  clear(tabId) { this.tabs.delete(tabId); }

  append(tab, kind, entry, previousId) {
    const buffer = tab[kind];
    if (previousId !== undefined) {
      const old = buffer.entries.findIndex(item => item.id === previousId);
      if (old >= 0) buffer.entries.splice(old, 1);
    }
    const current = { ...entry, id: ++this.sequence, timestamp: new Date().toISOString() };
    buffer.entries.push(current);
    if (buffer.entries.length > BUFFER_LIMIT) { buffer.entries.shift(); buffer.dropped++; }
    return current;
  }

  updateRequest(tab, request, changes) {
    request.entry = this.append(tab, 'network', { ...request.entry, ...changes, durationMs: Math.max(0, Date.now() - request.startedAt) }, request.entry.id);
  }

  event(source, method, params) {
    if (!record(source) || !integer(source.tabId) || !record(params)) return;
    const tab = this.tabs.get(source.tabId);
    if (!tab) return;
    if (source.sessionId !== undefined && (typeof source.sessionId !== 'string' || !source.sessionId || source.sessionId.length > 200)) return;
    const context = sourceFields(source);
    // Enabling Log can replay entries collected before debugger attachment.
    // Runtime timestamps are wall-clock milliseconds; Network.wallTime is seconds.
    const loggedAt = method === 'Log.entryAdded' ? params.entry?.timestamp : params.timestamp;
    if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(method) && finite(loggedAt) && loggedAt < tab.console.sinceMs) return;
    if (method === 'Runtime.consoleAPICalled') {
      const stack = stackText(params.stackTrace);
      this.append(tab, 'console', { ...context, source: 'console', level: text(params.type, 40) || 'log', text: argumentText(params.args), ...(stack ? { stack } : {}) });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      if (!record(details)) return;
      const stack = stackText(details.stackTrace);
      this.append(tab, 'console', {
        ...context, source: 'exception', level: 'error', text: describe(details.exception) || text(details.text),
        ...(typeof details.url === 'string' ? { url: safeUrl(details.url) } : {}),
        ...(integer(details.lineNumber) ? { line: details.lineNumber + 1 } : {}),
        ...(integer(details.columnNumber) ? { column: details.columnNumber + 1 } : {}),
        ...(stack ? { stack } : {}),
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry;
      if (!record(entry)) return;
      const stack = stackText(entry.stackTrace);
      this.append(tab, 'console', {
        ...context, source: text(entry.source, 40) || 'log', level: text(entry.level, 40) || 'info', text: text(entry.text),
        ...(typeof entry.url === 'string' ? { url: safeUrl(entry.url) } : {}),
        ...(integer(entry.lineNumber) ? { line: entry.lineNumber + 1 } : {}),
        ...(stack ? { stack } : {}),
      });
      return;
    }
    if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return;
    if (typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 256) return;
    const key = JSON.stringify([source.sessionId || '', params.requestId]);
    const network = tab.network;
    let request = network.pending.get(key);
    if (method === 'Network.requestWillBeSent') {
      if (!record(params.request)) return;
      if (finite(params.wallTime) && params.wallTime * 1000 < network.sinceMs) return;
      let redirectCount = 0;
      if (request) {
        redirectCount = request.entry.redirectCount + 1;
        this.updateRequest(tab, request, { ...responseFields(params.redirectResponse), state: record(params.redirectResponse) ? 'redirected' : 'replaced' });
        network.pending.delete(key);
      }
      if (network.pending.size >= PENDING_LIMIT) {
        const oldestKey = network.pending.keys().next().value;
        const oldest = network.pending.get(oldestKey);
        this.updateRequest(tab, oldest, { state: 'untracked', error: 'Pending request tracking limit reached.' });
        network.pending.delete(oldestKey); network.droppedPending++;
      }
      request = {
        startedAt: Date.now(),
        entry: this.append(tab, 'network', {
          ...context, requestId: params.requestId, redirectCount, url: safeUrl(params.request.url),
          method: text(params.request.method, 20), resourceType: text(params.type, 40), state: 'pending',
          ...(typeof params.frameId === 'string' ? { frameId: text(params.frameId, 200) } : {}),
        }),
      };
      network.pending.set(key, request);
      return;
    }
    if (!request) return;
    if (method === 'Network.responseReceived') {
      this.updateRequest(tab, request, { ...responseFields(params.response), state: 'response' });
    } else if (method === 'Network.loadingFinished') {
      this.updateRequest(tab, request, { state: 'finished', ...(finite(params.encodedDataLength) ? { encodedBytes: params.encodedDataLength } : {}) });
      network.pending.delete(key);
    } else if (method === 'Network.loadingFailed') {
      this.updateRequest(tab, request, {
        state: 'failed', error: text(params.errorText, 300), canceled: params.canceled === true,
        ...(typeof params.blockedReason === 'string' ? { blockedReason: text(params.blockedReason, 80) } : {}),
        ...(typeof params.corsErrorStatus?.corsError === 'string' ? { corsError: text(params.corsErrorStatus.corsError, 80) } : {}),
      });
      network.pending.delete(key);
    }
  }

  read(tabId, kind, args = {}) {
    if (!integer(tabId) || !['console', 'network'].includes(kind) || !record(args) ||
      Object.keys(args).some(key => !['tabId', 'limit', 'after', 'clear'].includes(key)) ||
      (args.tabId !== undefined && args.tabId !== tabId) ||
      (args.limit !== undefined && (!integer(args.limit) || args.limit < 1 || args.limit > 100)) ||
      (args.after !== undefined && !integer(args.after)) ||
      (args.clear !== undefined && typeof args.clear !== 'boolean')) {
      fail('INVALID_ARGUMENT', 'Diagnostics accepts tabId, limit from 1 to 100, a nonnegative integer after cursor, and boolean clear.');
    }
    const tab = this.tabs.get(tabId);
    if (!tab) fail('DIAGNOSTICS_UNAVAILABLE', 'Diagnostics starts when this task attaches to the tab.');
    const buffer = tab[kind];
    const matching = buffer.entries.filter(entry => entry.id > (args.after ?? 0));
    const entries = []; let bytes = 0;
    for (const entry of matching) {
      const size = new TextEncoder().encode(JSON.stringify(entry)).length;
      if (entries.length >= (args.limit ?? 50) || bytes + size > READ_BYTE_LIMIT) break;
      entries.push({ ...entry }); bytes += size;
    }
    const result = {
      entries, dropped: buffer.dropped, truncated: entries.length < matching.length,
      nextAfter: entries.at(-1)?.id ?? args.after ?? 0,
      ...(kind === 'network' ? { droppedPending: buffer.droppedPending } : {}),
    };
    if (args.clear === true) {
      buffer.entries = []; buffer.dropped = 0; buffer.sinceMs = Date.now();
      if (kind === 'network') { buffer.pending.clear(); buffer.droppedPending = 0; }
    }
    return result;
  }
}
