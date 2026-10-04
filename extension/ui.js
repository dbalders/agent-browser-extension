const $ = id => document.getElementById(id);
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The extension is unavailable.');
  return response.value;
}
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
let lastRender = '';
let lastAccessRender = '';
function actionButton(label, message, style = 'secondary') {
  const button = document.createElement('button'); button.type = 'button'; button.className = style; button.textContent = label;
  button.addEventListener('click', async () => { button.disabled = true; await perform(message); button.disabled = false; });
  return button;
}
function accessCard(origin, description) {
  const card = document.createElement('div'); card.className = 'task site-card';
  const heading = document.createElement('strong'); heading.textContent = origin;
  const detail = document.createElement('p'); detail.textContent = description;
  const actions = document.createElement('div'); actions.className = 'actions'; card.append(heading, detail, actions);
  return { card, actions };
}
function renderAccess(state) {
  const access = state.access;
  if (!access) return;
  $('allow-all-sites').checked = access.allowAll;
  $('access-warning').textContent = access.warning || ''; $('access-warning').hidden = !access.warning;
  const next = JSON.stringify([access, state.sessions.map(session => [session.sessionId, session.name])]);
  if (next === lastAccessRender) return; lastAccessRender = next;
  $('access-requests').replaceChildren(); $('saved-sites').replaceChildren(); $('temporary-sites').replaceChildren();
  $('requests-empty').hidden = access.pending.length > 0;
  $('sites-empty').hidden = access.sites.length > 0;
  $('temporary-title').hidden = !access.once.length;
  for (const request of access.pending) {
    const kind = request.capability === 'debug' ? 'debugging access' : 'browser access';
    const { card, actions } = accessCard(request.origin, `${request.taskName} requests ${kind}. Approving lets the agent try again; it does not repeat the blocked action.`);
    const common = { origin: request.origin, sessionId: request.sessionId, capability: request.capability };
    actions.append(
      actionButton('Allow for this task', { type: 'access.grant', ...common, scope: 'once' }, ''),
      actionButton('Always allow', { type: 'access.grant', ...common, scope: 'always' }),
      actionButton('Block', { type: 'access.block', ...common }, 'danger'),
    );
    if (request.capability === 'debug') {
      const explanation = document.createElement('p'); explanation.className = 'hint'; explanation.textContent = 'Debugging can expose sensitive page activity. CPU profiles can include other contexts sharing this page’s renderer. Use an isolated browser profile for sensitive work.'; card.insertBefore(explanation, actions);
    }
    $('access-requests').append(card);
  }
  for (const site of access.sites) {
    const ordinary = { allow: 'Allowed', block: 'Blocked', ask: 'Ask first' }[site.ordinary];
    const debug = { allow: 'allowed', block: 'blocked', ask: 'ask first' }[site.debug];
    const { card, actions } = accessCard(site.origin, `Browser access: ${ordinary}. Debugging: ${debug}.`);
    if (site.ordinary !== 'allow') actions.append(actionButton('Allow browsing', { type: 'access.grant', origin: site.origin, scope: 'always', capability: 'ordinary' }));
    if (site.ordinary !== 'block') actions.append(actionButton('Block site', { type: 'access.block', origin: site.origin }, 'danger'));
    if (site.ordinary !== 'ask' || site.debug !== 'ask') actions.append(actionButton('Revoke access', { type: 'access.revoke', origin: site.origin }, 'danger'));
    if (site.ordinary === 'allow' && site.debug !== 'allow') actions.append(actionButton('Allow debugging', { type: 'access.grant', origin: site.origin, scope: 'always', capability: 'debug' }));
    if (site.debug === 'allow') actions.append(actionButton('Revoke debugging', { type: 'access.revoke', origin: site.origin, capability: 'debug' }, 'danger'));
    $('saved-sites').append(card);
  }
  const temporary = new Map();
  for (const grant of access.once) {
    const entry = temporary.get(grant.origin) || new Set();
    const task = state.sessions.find(session => session.sessionId === grant.sessionId)?.name || 'Browser task';
    entry.add(`${task} (${grant.capability === 'debug' ? 'debugging' : 'browsing'})`); temporary.set(grant.origin, entry);
  }
  for (const [origin, tasks] of temporary) {
    const { card, actions } = accessCard(origin, [...tasks].join('; '));
    actions.append(actionButton('Revoke access', { type: 'access.revoke', origin }, 'danger')); $('temporary-sites').append(card);
  }
}
function render(state) {
  $('status').textContent = state.state === 'connected' ? `Connected · localhost:${state.port}` : state.state === 'connecting' ? 'Connecting to local bridge…' : 'Bridge disconnected';
  if (state.error) error(state.error);
  $('stop-all').disabled = !state.sessions.length;
  renderAccess(state);
  const next = JSON.stringify(state.sessions); if (next === lastRender) return; lastRender = next;
  $('sessions').replaceChildren();
  if (!state.sessions.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No active tasks. Agents open or reuse the tabs they need.'; $('sessions').append(empty); }
  for (const session of state.sessions) {
    const card = document.createElement('div'); card.className = 'task';
    const name = document.createElement('strong'); name.textContent = session.name;
    const info = document.createElement('p'); info.textContent = `${session.tabs.length} ${session.tabs.length === 1 ? 'tab' : 'tabs'}`;
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [label, type] of [['Show', 'show'], ['Stop', 'stop']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = type === 'stop' ? 'danger' : 'secondary'; button.textContent = label;
      button.disabled = type === 'show' && !session.tabs.length;
      button.addEventListener('click', () => perform({ type, sessionId: session.sessionId })); actions.append(button);
    }
    card.append(name, info, actions); $('sessions').append(card);
  }
}
async function perform(message) { try { error(''); render(await request(message)); } catch (failure) { error(failure.message); } }
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); await perform({ type: 'connect', port: Number($('port').value), token: $('token').value }); $('token').value = '';
});
$('disconnect').addEventListener('click', () => perform({ type: 'disconnect' }));
$('stop-all').addEventListener('click', () => perform({ type: 'stop' }));
$('site-form').addEventListener('submit', async event => {
  event.preventDefault(); await perform({ type: 'access.grant', origin: $('site-origin').value.trim(), capability: 'ordinary', scope: 'always' });
});
$('block-origin').addEventListener('click', () => perform({ type: 'access.block', origin: $('site-origin').value.trim() }));
$('allow-all-sites').addEventListener('change', () => perform({ type: 'access.allowAll', enabled: $('allow-all-sites').checked }));
try {
  const settings = await request({ type: 'settings' }); $('port').value = settings.port;
  if (settings.paired) { $('token').placeholder = 'Saved · leave blank to reuse'; $('token-hint').textContent = 'A pairing token is saved on this computer.'; }
  render(await request({ type: 'status' }));
} catch (failure) { error(failure.message); }
setInterval(() => { request({ type: 'status' }).then(render).catch(failure => error(failure.message)); }, 1500);
