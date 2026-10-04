import { describe, expect, it, vi } from 'vitest';
import { WebsiteAccess, siteOrigin, trustedAccessSender } from '../extension/access.js';

function fixture() {
  const save = vi.fn(async () => {}); const onRevoke = vi.fn(async () => {});
  return { access: new WebsiteAccess({ save, onRevoke }), save, onRevoke };
}
const grant = (access, origin = 'https://example.test', extra = {}) => access.grant({ origin, scope: 'always', ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('website origin permissions', () => {
  it('asks by default, including loopback, and records only the exact origin and task label', () => {
    const { access, save } = fixture();
    expect(access.restore(undefined)).toBe(true);
    for (const url of ['https://example.test/private/path?auth=PRIVATE#secret', 'http://127.0.0.1:43123/test']) {
      expect(() => access.check(url, 'task-1', 'ordinary', 'Research\n task')).toThrow(expect.objectContaining({ code: 'SITE_ACCESS_REQUIRED' }));
    }
    const result = access.snapshot();
    expect(result.allowAll).toBe(false); expect(result.pending).toHaveLength(2);
    expect(result.pending[0]).toEqual({ origin: 'https://example.test', sessionId: 'task-1', capability: 'ordinary', taskName: 'Research task' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(save).not.toHaveBeenCalled();
  });

  it('matches canonical origins exactly, respecting scheme, subdomain, ports and lookalikes', async () => {
    const { access } = fixture(); await grant(access, 'https://EXAMPLE.test:443/');
    expect(access.check('https://example.test/anything?q=value', 'task-1')).toBe('https://example.test');
    for (const url of ['http://example.test', 'https://example.test:444', 'https://sub.example.test', 'https://example.test.evil.invalid', 'https://evil-example.test']) {
      expect(access.allows(url, 'task-1')).toBe(false);
      expect(() => access.check(url, 'task-1')).toThrow(expect.objectContaining({ code: 'SITE_ACCESS_REQUIRED' }));
    }
    await grant(access, 'http://[::1]:8099');
    expect(access.allows('http://[::1]:8099/path', 'task-1')).toBe(true);
    expect(access.allows('http://[::1]:8100/path', 'task-1')).toBe(false);
  });

  it('rejects credentials, unsupported schemes and non-origin grant inputs without echoing input', () => {
    const secret = ['https://', 'private-user', ':', 'private-password', '@example.test/'].join('');
    for (const value of [secret, 'file:///private/file', 'chrome://settings', 'about:blank', 'data:text/plain,hello', '//example.test', 12]) {
      expect(() => siteOrigin(value)).toThrow(expect.objectContaining({ code: 'INVALID_ORIGIN' }));
      try { siteOrigin(value); } catch (error) { expect(error.message).not.toContain('private-password'); }
    }
    const { access } = fixture();
    for (const value of ['https://example.test/path', 'https://example.test/?key=secret', 'https://example.test/#secret']) expect(() => grant(access, value)).toThrow(expect.objectContaining({ code: 'INVALID_ORIGIN' }));
    expect(access.snapshot().sites).toEqual([]);
  });

  it('persists an always decision, clears corresponding requests, and never replays actions', async () => {
    const { access, save, onRevoke } = fixture();
    expect(() => access.check('https://example.test', 'task-1')).toThrow();
    await grant(access);
    expect(save).toHaveBeenCalledWith({ version: 1, allowAll: false, sites: { 'https://example.test': { ordinary: 'allow' } } });
    expect(access.snapshot().pending).toEqual([]); expect(onRevoke).not.toHaveBeenCalled();
    const restored = new WebsiteAccess();
    expect(restored.restore(save.mock.calls[0][0])).toBe(true);
    expect(restored.allows('https://example.test/path', 'another-task')).toBe(true);
  });

  it('keeps one-task grants out of durable storage and removes them on task completion', async () => {
    const { access, save } = fixture();
    expect(() => access.check('https://example.test', 'task-1')).toThrow();
    expect(() => access.check('https://example.test', 'task-2')).toThrow();
    await grant(access, 'https://example.test', { scope: 'once', sessionId: 'task-1' });
    expect(access.allows('https://example.test/path', 'task-1')).toBe(true);
    expect(access.allows('https://example.test/path', 'task-2')).toBe(false);
    expect(access.snapshot().pending.map(item => item.sessionId)).toEqual(['task-2']);
    expect(save).not.toHaveBeenCalled();
    access.endSession('task-1'); expect(access.allows('https://example.test', 'task-1')).toBe(false);
    access.endSession('task-2'); expect(access.snapshot().pending).toEqual([]);
    expect(access.snapshot().once).toEqual([]);
  });

  it('makes global browsing permission explicit and preserves block and revoke overrides', async () => {
    const { access } = fixture();
    await access.setAllowAll(true);
    expect(access.allows('https://unlisted.test/path', 'task-1')).toBe(true);
    expect(access.allows('https://unlisted.test/path', 'task-1', 'debug')).toBe(false);
    await access.block('https://example.test');
    expect(() => access.check('https://example.test/path', 'task-1')).toThrow(expect.objectContaining({ code: 'SITE_BLOCKED' }));
    await access.revoke('https://unlisted.test');
    expect(access.allows('https://unlisted.test', 'task-1')).toBe(false);
    expect(() => access.check('https://unlisted.test', 'task-1')).toThrow(expect.objectContaining({ code: 'SITE_ACCESS_REQUIRED' }));
    await access.setAllowAll(false);
    expect(access.allows('https://other.test', 'task-1')).toBe(false);
  });

  it('requires ordinary access first and an independent debugging opt-in', async () => {
    const { access } = fixture();
    expect(() => access.check('https://example.test', 'task-1', 'debug')).toThrow(expect.objectContaining({ code: 'SITE_ACCESS_REQUIRED' }));
    expect(access.snapshot().pending[0].capability).toBe('ordinary');
    await expect(grant(access, 'https://example.test', { capability: 'debug' })).rejects.toMatchObject({ code: 'SITE_ACCESS_REQUIRED' });
    await grant(access);
    expect(() => access.check('https://example.test', 'task-1', 'debug')).toThrow(expect.objectContaining({ code: 'SITE_ACCESS_REQUIRED' }));
    expect(access.snapshot().pending[0].capability).toBe('debug');
    await grant(access, 'https://example.test', { capability: 'debug', scope: 'once', sessionId: 'task-1' });
    expect(access.allows('https://example.test', 'task-1', 'debug')).toBe(true);
    expect(access.allows('https://example.test', 'task-2', 'debug')).toBe(false);
    await access.block('https://example.test', 'debug');
    expect(access.allows('https://example.test', 'task-1')).toBe(true);
    expect(() => access.check('https://example.test', 'task-1', 'debug')).toThrow(expect.objectContaining({ code: 'SITE_BLOCKED' }));
  });

  it('revokes ordinary and debugging grants immediately before asynchronous persistence or detach completes', async () => {
    const { access, save, onRevoke } = fixture(); await grant(access); await grant(access, 'https://example.test', { capability: 'debug' });
    await grant(access, 'https://example.test', { scope: 'once', sessionId: 'task-1' });
    let completeSave; const pendingSave = new Promise(resolve => { completeSave = resolve; }); save.mockImplementationOnce(() => pendingSave);
    const revoked = access.revoke('https://example.test');
    await Promise.resolve();
    expect(access.allows('https://example.test', 'task-1')).toBe(false); expect(access.allows('https://example.test', 'task-1', 'debug')).toBe(false);
    expect(onRevoke).toHaveBeenCalledWith({ origin: 'https://example.test', capability: 'ordinary' });
    expect(access.snapshot().once).toEqual([]);
    completeSave(); await revoked;
  });

  it('revokes synchronously behind an older save and prevents that delayed grant from restoring access', async () => {
    const { access, save, onRevoke } = fixture(); await grant(access);
    const entered = deferred(), release = deferred();
    save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const delayed = grant(access, 'https://other.test');
    const rejected = expect(delayed).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await entered.promise;
    const revoked = access.revoke('https://example.test');
    // No microtask or storage completion is needed for the restriction or detach.
    expect(access.allows('https://example.test', 'task-1')).toBe(false);
    expect(onRevoke).toHaveBeenCalledWith({ origin: 'https://example.test', capability: 'ordinary' });
    expect(access.allows('https://other.test', 'task-1')).toBe(false);
    release.resolve(); await rejected; await revoked;
    expect(access.allows('https://example.test', 'task-1')).toBe(false);
    expect(access.allows('https://other.test', 'task-1')).toBe(false);
    const restored = new WebsiteAccess(); restored.restore(save.mock.calls.at(-1)[0]);
    expect(restored.allows('https://example.test', 'task-1')).toBe(false);
    expect(restored.allows('https://other.test', 'task-1')).toBe(false);
  });

  it('cancels grants queued before a restriction and persists all later restrictions', async () => {
    const { access, save } = fixture(); await grant(access); await grant(access, 'https://second.test');
    const entered = deferred(), release = deferred();
    save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const first = grant(access, 'https://unrelated.test'); const firstRejected = expect(first).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await entered.promise;
    const queued = grant(access, 'https://example.test'); const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    const blocked = access.block('https://example.test'); const revoked = access.revoke('https://second.test');
    expect(access.allows('https://example.test', 'task-1')).toBe(false); expect(access.allows('https://second.test', 'task-1')).toBe(false);
    release.resolve(); await Promise.all([firstRejected, queuedRejected, blocked, revoked]);
    expect(save.mock.calls.at(-1)[0].sites).toEqual({ 'https://example.test': { ordinary: 'block', debug: 'ask' }, 'https://second.test': { ordinary: 'ask', debug: 'ask' } });
    await grant(access); expect(access.allows('https://example.test', 'task-1')).toBe(true);
  });

  it('does not resurrect a queued one-task grant after the task ends or its ID is reused', async () => {
    const { access, save } = fixture(); const entered = deferred(), release = deferred();
    save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const saving = grant(access, 'https://unrelated.test'); await entered.promise;
    const stale = grant(access, 'https://stale.test', { scope: 'once', sessionId: 'task-1' });
    const rejected = expect(stale).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    access.endSession('task-1');
    const fresh = grant(access, 'https://fresh.test', { scope: 'once', sessionId: 'task-1' });
    release.resolve(); await Promise.all([saving, rejected, fresh]);
    expect(access.allows('https://stale.test', 'task-1')).toBe(false);
    expect(access.allows('https://fresh.test', 'task-1')).toBe(true);
    expect(access.snapshot().once).toEqual([{ origin: 'https://fresh.test', sessionId: 'task-1', capability: 'ordinary' }]);
  });

  it('turns off global access while another save is pending and cancels delayed enable', async () => {
    const { access, save, onRevoke } = fixture(); const entered = deferred(), release = deferred();
    save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const enabling = access.setAllowAll(true); const rejected = expect(enabling).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await entered.promise;
    const disabled = access.setAllowAll(false);
    expect(access.allows('https://unlisted.test', 'task-1')).toBe(false);
    expect(onRevoke).toHaveBeenCalledWith({ origin: null, capability: 'ordinary' });
    release.resolve(); await Promise.all([rejected, disabled]);
    expect(access.snapshot().allowAll).toBe(false); expect(save.mock.calls.at(-1)[0].allowAll).toBe(false);
  });

  it('fails closed on malformed saved policy including inherited and prototype-looking keys', () => {
    const { access } = fixture();
    const invalid = [null, {}, { version: 1, allowAll: 'yes', sites: {} }, { version: 2, allowAll: true, sites: {} },
      { version: 1, allowAll: true, sites: { 'https://example.test/path': { ordinary: 'allow' } } },
      { version: 1, allowAll: true, sites: { 'https://example.test': { ordinary: 'sometimes' } } },
      { version: 1, allowAll: true, sites: { 'https://example.test': { arbitrary: 'allow' } } },
      { version: 1, allowAll: true, sites: JSON.parse('{"__proto__":{"ordinary":"allow"}}') },
      Object.assign(Object.create({ allowAll: true }), { version: 1, sites: {} }),
      { version: 1, allowAll: true, sites: {}, token: 'unexpected private field' },
    ];
    for (const value of invalid) {
      expect(access.restore(value)).toBe(false); expect(access.snapshot().allowAll).toBe(false);
      expect(access.allows('https://example.test', 'task-1')).toBe(false);
      expect(access.snapshot().warning).toContain('invalid');
    }
  });

  it('does not install new permissions when storage fails and retains restrictions when saving a revoke fails', async () => {
    const { access, save } = fixture(); save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(grant(access)).rejects.toMatchObject({ code: 'ACCESS_SAVE_FAILED' });
    expect(access.allows('https://example.test', 'task-1')).toBe(false);
    await grant(access); save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(access.revoke('https://example.test')).rejects.toMatchObject({ code: 'ACCESS_SAVE_FAILED' });
    expect(access.allows('https://example.test', 'task-1')).toBe(false);
    expect(access.snapshot().warning).toContain('saving failed');
    await access.revoke('https://example.test'); expect(access.snapshot().warning).toBe('');
  });

  it('surfaces failed cleanup without rolling back a restriction', async () => {
    const { access, onRevoke } = fixture(); await grant(access);
    onRevoke.mockRejectedValueOnce(new Error('cannot detach'));
    await expect(access.block('https://example.test')).rejects.toMatchObject({ code: 'ACCESS_CLEANUP_FAILED' });
    expect(access.allows('https://example.test', 'task-1')).toBe(false);
  });

  it('keeps nonmutating access checks and bounded duplicate requests safe for navigation/event filtering', () => {
    const { access } = fixture();
    for (let i = 0; i < 200; i++) expect(access.allows(`https://site${i}.test`, 'task-1')).toBe(false);
    expect(access.snapshot().pending).toEqual([]);
    for (let i = 0; i < 110; i++) expect(() => access.check(`https://site${i}.test/path`, 'task-1')).toThrow();
    expect(access.snapshot().pending).toHaveLength(100);
    expect(() => access.check('https://site0.test/other', 'task-1')).toThrow();
    expect(access.snapshot().pending).toHaveLength(100);
    expect(access.allows('about:blank', 'task-1')).toBe(false);
    expect(access.allows('https://example.test', '__proto__')).toBe(false);
  });
});

describe('trusted extension UI senders', () => {
  const runtime = { id: 'a'.repeat(32), getURL: file => `chrome-extension://${'a'.repeat(32)}/${file}` };
  it('accepts only known top-level popup and options documents from this extension', () => {
    for (const page of ['popup.html', 'options.html']) expect(trustedAccessSender({ id: runtime.id, url: runtime.getURL(page), frameId: 0 }, runtime)).toBe(true);
    expect(trustedAccessSender({ id: runtime.id, url: runtime.getURL('popup.html') }, runtime)).toBe(true);
    for (const sender of [
      { id: runtime.id, url: 'https://example.test/', frameId: 0 },
      { id: runtime.id, url: runtime.getURL('options.html'), frameId: 3 },
      { id: 'b'.repeat(32), url: runtime.getURL('options.html'), frameId: 0 },
      { id: runtime.id, url: runtime.getURL('background.js'), frameId: 0 },
      { id: runtime.id, url: runtime.getURL('options.html') + '?embedded=true', frameId: 0 },
      { id: runtime.id, origin: runtime.getURL(''), frameId: 0 },
    ]) expect(trustedAccessSender(sender, runtime)).toBe(false);
  });
});
