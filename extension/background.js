import { BrowserController, BrowserFault } from './controller.js';
import { PageAdapter } from './pages.js';
import { WebsiteAccess, trustedAccessSender } from './access.js';
import { installAccessControl } from './access-control.js';

const STATE_KEY = 'browserState'; const SETTINGS_KEY = 'bridgeSettings'; const ACCESS_KEY = 'websiteAccess';
const pages = new PageAdapter(chrome);
const controller = new BrowserController(chrome, pages, state => chrome.storage.session.set({ [STATE_KEY]: state }));
const access = new WebsiteAccess({
  save: policy => chrome.storage.local.set({ [ACCESS_KEY]: policy }),
  onRevoke: change => controller.revokeAccess?.(change),
});
installAccessControl(controller, pages, access);
controller.paused = true;
const ready = Promise.all([
  chrome.storage.session.get(STATE_KEY).then(saved => controller.restore(saved[STATE_KEY])),
  chrome.storage.local.get(ACCESS_KEY).then(saved => access.restore(saved[ACCESS_KEY])),
]);
let socket; let reconnectTimer; let heartbeat; let connectionState = 'disconnected'; let lastError = ''; let configuredPort = 43187;

function connectionInfo() {
  return { state: connectionState, port: configuredPort, error: lastError, access: access.snapshot(), sessions: Object.entries(controller.state.sessions).filter(([, session]) => !session.ended).map(([sessionId, session]) => ({ sessionId, name: session.name, stopped: !!session.stopped, tabs: Object.entries(controller.state.tabs).filter(([, tab]) => tab.sessionId === sessionId).map(([tabId, tab]) => ({ tabId: Number(tabId), created: tab.created, disposition: tab.disposition })) })) };
}
async function badge() {
  const count = connectionInfo().sessions.length;
  const requests = access.pending.size;
  await chrome.action.setBadgeText({ text: connectionState === 'connected' ? (requests ? '?' : count ? String(count) : 'ON') : '' });
  await chrome.action.setBadgeBackgroundColor({ color: requests ? '#996000' : '#B94B16' });
}
function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => { void connect(); }, 5000); }
async function connect() {
  await ready;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const { bridgeSettings: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!settings?.enabled || !settings.token) { connectionState = 'disconnected'; return; }
  configuredPort = settings.port || 43187; connectionState = 'connecting';
  const candidate = new WebSocket(`ws://127.0.0.1:${configuredPort}/extension?token=${encodeURIComponent(settings.token)}`);
  socket = candidate;
  candidate.onopen = () => {
    if (socket !== candidate) { candidate.close(); return; }
    connectionState = 'connected'; lastError = ''; controller.paused = false;
    candidate.send(JSON.stringify({ type: 'hello', version: 1, browser: 'Chrome' }));
    clearInterval(heartbeat);
    heartbeat = setInterval(() => { if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify({ type: 'ping' })); }, 20000);
    void controller.refreshIndicators(); void badge();
  };
  candidate.onmessage = async event => {
    if (candidate !== socket || typeof event.data !== 'string' || event.data.length > 1000000) return;
    let command;
    try {
      command = JSON.parse(event.data);
      if (command.type === 'ping') { candidate.send(JSON.stringify({ type: 'pong' })); return; }
      if (command.type === 'pong') return;
      const result = await controller.execute(command);
      if (candidate === socket && candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify({ type: 'result', id: command.id, result }));
    } catch (error) {
      if (command && typeof command.id === 'string' && candidate === socket && candidate.readyState === WebSocket.OPEN) {
        candidate.send(JSON.stringify({ type: 'result', id: command.id, error: { code: error instanceof BrowserFault ? error.code : 'BROWSER_ERROR', message: String(error.message || error).slice(0, 1000) } }));
      }
    }
    void badge();
  };
  candidate.onerror = () => { lastError = 'Cannot reach the local bridge. Check that it is running and the pairing token matches.'; };
  candidate.onclose = () => {
    if (candidate !== socket) return;
    clearInterval(heartbeat); socket = undefined; connectionState = 'disconnected'; controller.suspend();
    void pages.disconnect(); void badge(); scheduleReconnect();
  };
}
async function disconnect() {
  clearTimeout(reconnectTimer); clearInterval(heartbeat); controller.suspend();
  const old = socket; socket = undefined; old?.close(); connectionState = 'disconnected';
  await pages.disconnect(); await badge();
}
async function handleMessage(message) {
  await ready;
  if (message?.type === 'status') return connectionInfo();
  if (message?.type === 'settings') {
    const { bridgeSettings: settings } = await chrome.storage.local.get(SETTINGS_KEY);
    return { port: settings?.port || 43187, enabled: !!settings?.enabled, paired: !!settings?.token };
  }
  if (message?.type === 'access.grant') {
    if (message.scope === 'once') {
      const session = Object.hasOwn(controller.state.sessions, message.sessionId) && controller.state.sessions[message.sessionId];
      if (!session || session.ended || session.stopped) throw new Error('This browser task has ended.');
    }
    await access.grant({ origin: message.origin, sessionId: message.sessionId, capability: message.capability, scope: message.scope });
    await badge();
    return connectionInfo();
  }
  if (message?.type === 'access.block') { await access.block(message.origin, message.capability); await badge(); return connectionInfo(); }
  if (message?.type === 'access.revoke') { await access.revoke(message.origin, message.capability); await badge(); return connectionInfo(); }
  if (message?.type === 'access.allowAll') { await access.setAllowAll(message.enabled); await badge(); return connectionInfo(); }
  if (message?.type === 'connect') {
    const port = Number(message.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');
    const { bridgeSettings: old } = await chrome.storage.local.get(SETTINGS_KEY);
    const token = typeof message.token === 'string' && message.token.trim() ? message.token.trim() : old?.token;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Paste the pairing token printed by the local bridge.');
    await disconnect(); await chrome.storage.local.set({ [SETTINGS_KEY]: { port, token, enabled: true } });
    await connect(); return connectionInfo();
  }
  if (message?.type === 'disconnect') {
    const { bridgeSettings: settings } = await chrome.storage.local.get(SETTINGS_KEY);
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, enabled: false } });
    await disconnect(); await controller.stop(); return connectionInfo();
  }
  if (message?.type === 'stop') { await controller.stop(message.sessionId); await badge(); return connectionInfo(); }
  if (message?.type === 'show') {
    const session = controller.state.sessions[message.sessionId];
    if (!session || session.ended) throw new Error('This task has ended.');
    const [tabId] = Object.entries(controller.state.tabs).find(([, tab]) => tab.sessionId === message.sessionId) || [];
    if (tabId === undefined) throw new Error('This task has no open tabs.');
    const tab = await chrome.tabs.get(Number(tabId));
    if (tab.groupId >= 0) await chrome.tabGroups.update(tab.groupId, { collapsed: false });
    await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return connectionInfo();
  }
  throw new Error('Unsupported extension request.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trustedAccessSender(sender, chrome.runtime)) {
    respond({ ok: false, error: 'Open the extension popup or connection screen to change browser settings.' });
    return false;
  }
  handleMessage(message).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-reconnect') void connect(); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 }); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 }); void connect(); });
chrome.tabs.onCreated.addListener(tab => controller.created(tab));
chrome.tabs.onRemoved.addListener(tabId => { void ready.then(() => controller.removed(tabId)); });
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'complete') void ready.then(() => controller.refreshIndicators(tabId));
  if (changes.url || changes.status === 'loading') pages.invalidate(tabId);
  if (changes.url) void ready.then(() => controller.navigationChanged?.(tabId, changes.url)).catch(() => {
    controller.suspend(); lastError = 'Website access could not be verified after navigation. Disconnect and reconnect before continuing.';
    void pages.disconnect(); void badge();
  });
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  pages.event(source, method, params);
  if (method === 'Page.windowOpen') controller.windowOpened(source, params);
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(details => controller.navigationTarget(details));
chrome.debugger.onDetach.addListener((source, reason) => {
  const unexpected = pages.attached.has(source.tabId);
  pages.detached(source.tabId);
  if (unexpected && reason === 'canceled_by_user') {
    const owner = controller.state.tabs[source.tabId];
    if (owner) void controller.stop(owner.sessionId).then(badge);
  }
});
chrome.downloads.onCreated.addListener(item => { void ready.then(() => controller.downloaded(item)); });
void chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
// Renew the document-side lease only while the bridge and task are active.
setInterval(() => { void ready.then(() => controller.refreshIndicators()); }, 20000);
void connect();
