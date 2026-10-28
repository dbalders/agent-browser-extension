import { describe, expect, it, vi } from 'vitest';

describe('extension connection lifecycle', () => {
  it('cancels a stale connection attempt after Disconnect and allows a new explicit connection', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const token = 'x'.repeat(32);
    let settings = { enabled: true, port: 43187, token };
    let releaseSettings; const staleSettings = new Promise(resolve => { releaseSettings = resolve; });
    let settingsRead; const began = new Promise(resolve => { settingsRead = resolve; });
    let reads = 0; let messageListener;
    const event = () => ({ addListener: vi.fn() });
    const chrome = {
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        local: {
          get: vi.fn(key => {
            if (key !== 'bridgeSettings') return Promise.resolve({});
            if (++reads === 1) { settingsRead(); return staleSettings; }
            return Promise.resolve({ bridgeSettings: { ...settings } });
          }),
          set: vi.fn(async value => { if (value.bridgeSettings) settings = { ...value.bridgeSettings }; }),
        },
      },
      runtime: {
        id: 'a'.repeat(32), getURL: file => `chrome-extension://${'a'.repeat(32)}/${file}`,
        onMessage: { addListener: listener => { messageListener = listener; } },
        onInstalled: event(), onStartup: event(),
      },
      action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
      alarms: { create: vi.fn(async () => {}), onAlarm: event() },
      tabs: { onCreated: event(), onRemoved: event(), onUpdated: event() },
      debugger: { onEvent: event(), onDetach: event() },
      webNavigation: { onCreatedNavigationTarget: event() },
      downloads: { onCreated: event() },
    };
    const sockets = [];
    class Socket {
      static OPEN = 1; static CONNECTING = 0;
      constructor() { this.readyState = Socket.CONNECTING; this.sent = []; sockets.push(this); }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; this.onclose?.(); }
      open() { this.readyState = Socket.OPEN; this.onopen(); }
    }
    const send = message => new Promise(resolve => messageListener(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('options.html') }, resolve));
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('WebSocket', Socket);
    try {
      await import('../extension/background.js');
      await began;
      const stale = { ...settings };
      expect(await send({ type: 'disconnect' })).toMatchObject({ ok: true, value: { state: 'disconnected' } });
      expect(settings.enabled).toBe(false);
      releaseSettings({ bridgeSettings: stale });
      await staleSettings;
      expect(sockets).toHaveLength(0);
      expect(await send({ type: 'status' })).toMatchObject({ ok: true, value: { state: 'disconnected' } });

      expect(await send({ type: 'connect', port: 43187, token })).toMatchObject({ ok: true, value: { state: 'connecting' } });
      expect(sockets).toHaveLength(1);
      sockets[0].open();
      await sockets[0].onmessage({ data: JSON.stringify({ type: 'command', id: 'new-task', sessionId: 'new-task', operation: 'session.start', args: { name: 'New task' } }) });
      expect(sockets[0].sent.at(-1)).toMatchObject({ type: 'result', id: 'new-task', result: { sessionId: 'new-task' } });
      expect(await send({ type: 'disconnect' })).toMatchObject({ ok: true, value: { state: 'disconnected' } });
    } finally {
      vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules();
    }
  });
});
