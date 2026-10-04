import { BrowserFault } from './controller.js';

const CAPABILITIES = new Set(['ordinary', 'debug']);
const DECISIONS = new Set(['ask', 'allow', 'block']);
const MAX_SITES = 500;
const MAX_PENDING = 100;
const MAX_ONCE = 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new BrowserFault(code, message); };
const emptyPolicy = () => ({ version: 1, allowAll: false, sites: Object.create(null) });
const clone = value => JSON.parse(JSON.stringify(value));

export function siteOrigin(value, originOnly = false) {
  if (typeof value !== 'string' || value.length > 16384) fail('INVALID_ORIGIN', 'Use a complete HTTP or HTTPS site origin.');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ORIGIN', 'Use a complete HTTP or HTTPS site origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') fail('INVALID_ORIGIN', 'Site access supports only HTTP and HTTPS origins without embedded credentials.');
  if (originOnly && (url.pathname !== '/' || url.search || url.hash)) fail('INVALID_ORIGIN', 'Enter only the scheme, hostname and optional port; omit paths, queries and fragments.');
  if (url.origin.length > 2048) fail('INVALID_ORIGIN', 'The website origin is too long.');
  return url.origin;
}

function capability(value) {
  if (!CAPABILITIES.has(value)) fail('INVALID_ARGUMENT', 'Access capability must be ordinary or debug.');
  return value;
}

function sessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('INVALID_ARGUMENT', 'A current browser task ID is required.');
  return value;
}

export function trustedAccessSender(sender, runtime) {
  if (!record(sender) || sender.id !== runtime.id || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  // Content scripts also share the extension ID. Accept only our two top-level UI documents.
  return typeof sender.url === 'string' && ['popup.html', 'options.html'].some(page => sender.url === runtime.getURL(page));
}

export class WebsiteAccess {
  constructor({ save = async () => {}, onRevoke = () => {} } = {}) {
    this.save = save; this.onRevoke = onRevoke;
    this.policy = emptyPolicy(); this.once = new Map(); this.pending = new Map();
    this.tail = Promise.resolve(); this.warning = ''; this.revision = 0;
    this.restrictionRevision = 0; this.sessionGenerations = new Map();
  }

  restore(saved) {
    this.policy = emptyPolicy(); this.once.clear(); this.pending.clear(); this.sessionGenerations.clear(); this.warning = ''; this.revision++; this.restrictionRevision++;
    if (saved === undefined) return true;
    try {
      if (!record(saved) || !['version', 'allowAll', 'sites'].every(key => Object.hasOwn(saved, key)) || saved.version !== 1 || typeof saved.allowAll !== 'boolean' || !record(saved.sites) || Object.keys(saved).some(key => !['version', 'allowAll', 'sites'].includes(key))) throw new Error();
      if (Object.keys(saved.sites).length > MAX_SITES) throw new Error();
      const next = emptyPolicy(); next.allowAll = saved.allowAll;
      for (const [origin, decisions] of Object.entries(saved.sites)) {
        if (siteOrigin(origin, true) !== origin || !record(decisions) || !Object.keys(decisions).length) throw new Error();
        for (const [kind, decision] of Object.entries(decisions)) if (!CAPABILITIES.has(kind) || !DECISIONS.has(decision)) throw new Error();
        next.sites[origin] = { ...decisions };
      }
      this.policy = next;
      return true;
    } catch {
      this.warning = 'Saved website permissions were invalid. Access now requires approval.';
      return false;
    }
  }

  decision(origin, id, kind) {
    const site = this.policy.sites[origin];
    if (site?.ordinary === 'block' || site?.[kind] === 'block') return 'block';
    if (site?.[kind] === 'allow' || this.once.get(id)?.get(origin)?.has(kind)) return 'allow';
    if (kind === 'ordinary' && site?.ordinary === undefined && this.policy.allowAll) return 'allow';
    return 'ask';
  }

  allows(value, id, kind = 'ordinary') {
    try {
      const origin = siteOrigin(value); sessionId(id); capability(kind);
      return this.decision(origin, id, 'ordinary') === 'allow' && this.decision(origin, id, kind) === 'allow';
    } catch { return false; }
  }

  check(value, id, kind = 'ordinary', taskName = 'Browser task') {
    const origin = siteOrigin(value); sessionId(id); capability(kind);
    // Debugging can reveal substantially more data and never replaces ordinary website approval.
    const ordinary = this.decision(origin, id, 'ordinary');
    const required = ordinary === 'allow' ? kind : 'ordinary';
    const decision = required === 'ordinary' ? ordinary : this.decision(origin, id, kind);
    if (decision === 'block') fail('SITE_BLOCKED', `${origin} is blocked for ${required === 'debug' ? 'debugging' : 'browser access'}. Only the user can change this in the extension.`);
    if (decision === 'allow') return origin;
    const key = JSON.stringify([id, origin, required]);
    if (!this.pending.has(key) && this.pending.size < MAX_PENDING) this.pending.set(key, {
      origin, sessionId: id, capability: required,
      taskName: typeof taskName === 'string' ? taskName.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80) || 'Browser task' : 'Browser task',
    });
    fail('SITE_ACCESS_REQUIRED', `${origin} needs user approval for ${required === 'debug' ? 'debugging' : 'browser access'} in the extension. Approval does not replay this action; inspect the page before deciding whether to try again.`);
  }

  snapshot() {
    const once = [];
    for (const [id, sites] of this.once) for (const [origin, kinds] of sites) for (const kind of kinds) once.push({ origin, sessionId: id, capability: kind });
    return {
      version: 1, allowAll: this.policy.allowAll, revision: this.revision, warning: this.warning,
      sites: Object.entries(this.policy.sites).sort(([a], [b]) => a.localeCompare(b)).map(([origin, decisions]) => ({ origin, ordinary: decisions.ordinary ?? 'ask', debug: decisions.debug ?? 'ask' })),
      once, pending: [...this.pending.values()].map(item => ({ ...item })),
    };
  }

  serialize(task) { const next = this.tail.then(task, task); this.tail = next.catch(() => {}); return next; }

  beginRestriction(next, change) {
    // A user revoke must win even while an earlier permission write is waiting
    // on storage. Only persistence is queued; agent access changes immediately.
    this.policy = next; this.revision++; this.restrictionRevision++;
    try { return Promise.resolve(this.onRevoke(change)).then(() => undefined, error => error); }
    catch (error) { return Promise.resolve(error); }
  }

  assertGrantCurrent(restrictionRevision, id, generation) {
    if (restrictionRevision !== this.restrictionRevision) fail('ACCESS_CHANGED', 'Website permissions changed while this grant was pending. No new access was granted. Review the current settings before trying again.');
    if (id !== undefined && this.sessionGenerations.get(id) !== generation) fail('SESSION_INACTIVE', 'This browser task ended while its permission grant was queued. No access was granted.');
  }

  async persist(next, restrictive, restrictionRevision, revoked = Promise.resolve()) {
    try {
      await this.save(clone(next));
    } catch {
      if (restrictive) this.warning = 'Access is restricted for this browser session, but saving failed. Retry before restarting Chrome.';
      await revoked;
      fail('ACCESS_SAVE_FAILED', 'Website permissions could not be saved. No new access was granted.');
    }
    if (!restrictive) {
      // An older save may complete after a synchronous revoke. It must never
      // reinstall its stale policy; the queued restrictive save repairs storage.
      this.assertGrantCurrent(restrictionRevision);
      this.policy = next; this.revision++;
    }
    this.warning = '';
    const revocationError = await revoked;
    if (revocationError) fail('ACCESS_CLEANUP_FAILED', 'Website access was restricted, but existing browser activity could not be fully detached. Stop the affected task.');
  }

  nextSite(origin) {
    const next = clone(this.policy);
    if (!Object.hasOwn(next.sites, origin) && Object.keys(next.sites).length >= MAX_SITES) fail('ACCESS_LIMIT', 'Too many saved website permissions. Remove an unused entry before adding another.');
    next.sites[origin] = { ...next.sites[origin] };
    return next;
  }

  removeTransient(origin, kind, id) {
    for (const [owner, sites] of this.once) {
      if (id !== undefined && owner !== id) continue;
      const kinds = sites.get(origin);
      if (kind === 'ordinary') sites.delete(origin);
      else { kinds?.delete(kind); if (!kinds?.size) sites.delete(origin); }
      if (!sites.size) this.once.delete(owner);
    }
    for (const [key, request] of this.pending) if (request.origin === origin && (id === undefined || request.sessionId === id) && (kind === 'ordinary' || request.capability === kind)) this.pending.delete(key);
  }

  grant({ origin: value, sessionId: id, capability: kind = 'ordinary', scope } = {}) {
    const origin = siteOrigin(value, true); capability(kind);
    if (!['once', 'always'].includes(scope)) fail('INVALID_ARGUMENT', 'Access scope must be once or always.');
    if (scope === 'once') sessionId(id);
    const restrictionRevision = this.restrictionRevision;
    let generation;
    if (scope === 'once') {
      generation = this.sessionGenerations.get(id) || {};
      this.sessionGenerations.set(id, generation);
    }
    return this.serialize(async () => {
      this.assertGrantCurrent(restrictionRevision, scope === 'once' ? id : undefined, generation);
      if (kind === 'debug' && (scope === 'once' ? this.decision(origin, id, 'ordinary') !== 'allow' : this.policy.sites[origin]?.ordinary !== 'allow' && !(this.policy.allowAll && this.policy.sites[origin]?.ordinary === undefined))) fail('SITE_ACCESS_REQUIRED', 'Allow ordinary website access before enabling debugging.');
      if (scope === 'once') {
        if (this.policy.sites[origin]?.ordinary === 'block' || this.policy.sites[origin]?.[kind] === 'block') fail('SITE_BLOCKED', 'Remove the saved block before granting temporary access.');
        let count = 0; for (const sites of this.once.values()) for (const kinds of sites.values()) count += kinds.size;
        if (count >= MAX_ONCE && !this.once.get(id)?.get(origin)?.has(kind)) fail('ACCESS_LIMIT', 'Too many temporary website permissions. End an unused task first.');
        const sites = this.once.get(id) || new Map(); const kinds = sites.get(origin) || new Set(); kinds.add(kind); sites.set(origin, kinds); this.once.set(id, sites); this.revision++;
      } else {
        const next = this.nextSite(origin); next.sites[origin][kind] = 'allow'; await this.persist(next, false, restrictionRevision);
      }
      for (const [key, request] of this.pending) if (request.origin === origin && request.capability === kind && (scope === 'always' || request.sessionId === id)) this.pending.delete(key);
      return this.snapshot();
    });
  }

  restrict(value, kind, decision) {
    const origin = siteOrigin(value, true); capability(kind);
    const next = this.nextSite(origin); next.sites[origin][kind] = decision;
    if (kind === 'ordinary') next.sites[origin].debug = 'ask';
    this.removeTransient(origin, kind);
    const revoked = this.beginRestriction(next, { origin, capability: kind });
    return this.serialize(async () => {
      // Save the latest restrictions, including any newer revoke that arrived
      // while this persistence task was queued.
      await this.persist(this.policy, true, undefined, revoked);
      return this.snapshot();
    });
  }
  block(origin, kind = 'ordinary') { return this.restrict(origin, kind, 'block'); }
  revoke(origin, kind = 'ordinary') { return this.restrict(origin, kind, 'ask'); }

  setAllowAll(enabled) {
    if (typeof enabled !== 'boolean') fail('INVALID_ARGUMENT', 'Allow all websites must be an explicit boolean.');
    if (!enabled) {
      const next = clone(this.policy); next.allowAll = false;
      const revoked = this.beginRestriction(next, { origin: null, capability: 'ordinary' });
      return this.serialize(async () => { await this.persist(this.policy, true, undefined, revoked); return this.snapshot(); });
    }
    const restrictionRevision = this.restrictionRevision;
    return this.serialize(async () => {
      this.assertGrantCurrent(restrictionRevision);
      if (this.policy.allowAll === enabled) return this.snapshot();
      const next = clone(this.policy); next.allowAll = enabled;
      await this.persist(next, false, restrictionRevision);
      if (enabled) for (const [key, request] of this.pending) if (request.capability === 'ordinary' && this.decision(request.origin, request.sessionId, 'ordinary') === 'allow') this.pending.delete(key);
      return this.snapshot();
    });
  }

  endSession(id) {
    sessionId(id); this.once.delete(id); this.sessionGenerations.delete(id);
    for (const [key, request] of this.pending) if (request.sessionId === id) this.pending.delete(key);
    this.revision++;
  }
}
