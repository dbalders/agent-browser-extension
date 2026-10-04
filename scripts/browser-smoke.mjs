// Real extension test. Uses a disposable Chrome for Testing profile, never personal Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startBridge, BrowserClient, createBrowserMcpServer } from '../dist/index.js';
import { startBenchmarkFixture } from './benchmark-fixture.mjs';
import { runBenchmarkDriver } from './benchmark-driver.mjs';

const root = await mkdtemp(join(tmpdir(), 'agent-browser-extension-smoke-'));
const fixture = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://fixture.test').pathname;
  if (pathname === '/diagnostic-resource') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-fixture-response': 'fixture-response-header-secret' });
    res.end(JSON.stringify({ value: 'fixture-response-body-secret' })); return;
  }
  if (pathname === '/semantics') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><title>Semantic browser controls</title><body>
      <h1>Semantic browser controls</h1>
      <label>Work email <input id="email" placeholder="Email for this task" data-testid="email-field"></label>
      <span id="publish-label" hidden>Publish</span><span id="workspace-label" hidden>workspace</span>
      <button id="publish" aria-labelledby="publish-label workspace-label" onclick="document.querySelector('#semantic-result').textContent=document.querySelector('#email').value"><span>Store</span> settings</button>
      <button hidden aria-label="Publish workspace" onclick="throw new Error('Hidden duplicate clicked')">Hidden duplicate</button>
      <button data-testid='reset"draft[0]' onclick="document.querySelector('#semantic-result').textContent='Reset complete'">Reset draft</button>
      <output id="semantic-result" data-testid="semantic-result"></output>
      <button>Duplicate action</button><button>Duplicate action</button>
      <label>Accept local terms <input id="terms" type="checkbox" onchange="window.checkChanges++"></label>
      <label>Private code <input id="private-code" type="password" value="fixture-private-password-value"></label>
      <div id="semantic-shadow"></div>
      <div id="initial-hidden" hidden>Hidden fixture content</div><button id="deferred-button" disabled>Deferred action</button>
      <button id="start-async" onclick="setTimeout(()=>{document.querySelector('#async-result').textContent='Async result ready';document.querySelector('#deferred-button').disabled=false;const n=document.createElement('p');n.id='async-node';n.textContent='Async node attached';document.body.append(n);},250)">Start async</button><output id="async-result"></output>
      <button id="remove-async" onclick="setTimeout(()=>document.querySelector('#async-node').remove(),150)">Remove async</button>
      <button id="diagnose">Run diagnostics fixture</button><output id="diagnostic-result"></output>
      <button id="profile-work" style="color:rgb(12, 34, 56)">Run measured work</button><output id="profile-result"></output>
      <script>
      window.checkChanges=0;
      document.querySelector('#profile-work').onclick=function measuredFixtureWork(){
        performance.mark('fixture-work-start');const until=performance.now()+180;let count=0;
        while(performance.now()<until){count+=Math.sqrt(count+1);}
        performance.mark('fixture-work-end');performance.measure('fixture-work','fixture-work-start','fixture-work-end');
        document.querySelector('#profile-result').textContent='Measured work finished';
      };
      const shadow=document.querySelector('#semantic-shadow').attachShadow({mode:'open'});
      shadow.innerHTML='<label>Shadow field <input></label><button data-testid="shadow-store">Shadow store</button><output data-testid="shadow-result"></output>';
      shadow.querySelector('button').onclick=()=>shadow.querySelector('output').textContent=shadow.querySelector('input').value;
      document.querySelector('#diagnose').onclick=async()=>{
        console.log('semantic smoke console marker');
        setTimeout(()=>{throw new Error('semantic smoke exception marker');},0);
        await fetch('/diagnostic-resource?access_token=fixture-query-secret#fixture-fragment-secret',{method:'POST',headers:{'X-Fixture-Secret':'fixture-request-header-secret'},body:'fixture-request-body-secret'});
        document.querySelector('#diagnostic-result').textContent='Diagnostic request finished';
      };
      </script></body></html>`); return;
  }
  if (pathname === '/advanced') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><title>Advanced browser controls</title><body>
      <h1>Advanced browser controls</h1>
      <label>Plan <select id="plan" onchange="document.querySelector('#planResult').textContent=this.value"><option value="free">Free</option><option value="pro">Pro</option><option value="blocked" disabled>Unavailable</option></select></label><output id="planResult"></output>
      <label>Regions <select id="regions" multiple><option value="west">West</option><option value="east">East</option><option value="north">North</option></select></label>
      <label>Message <input id="message" value="Hello "></label>
      <input id="hidden-input" type="hidden"><fieldset disabled><label>Disabled text <input id="disabled-input"></label></fieldset>
      <div id="menu" style="padding:20px;width:180px;background:#eee" onmouseover="document.querySelector('#submenu').hidden=false">Hover for actions<button id="submenu" hidden onclick="document.querySelector('#hoverResult').textContent='selected'">Choose action</button></div><output id="hoverResult"></output>
      <button id="twice" ondblclick="document.querySelector('#doubleResult').textContent='double'">Double click</button><output id="doubleResult"></output>
      <a id="popup-link" href="/popup" target="_blank" rel="noopener">Open separate result</a><button id="popup-script" onclick="window.open('/popup-script-result','_blank','noopener')">Open scripted result</button><button id="popup-blank">Open blank form</button>
      <canvas id="visual" width="360" height="100" aria-label="Visual controls"></canvas><output id="visualResult"></output>
      <div style="display:flex;gap:160px;margin-top:20px"><div id="drag" style="width:60px;height:60px;background:#39a;user-select:none;touch-action:none">Drag</div><div id="drop" style="width:100px;height:60px;background:#ccc">Drop</div></div><output id="dragResult"></output><div style="margin-top:1800px" id="distant-drop">Off-screen destination</div>
      <script>
      const c=document.querySelector('#visual');const ctx=c.getContext('2d');ctx.fillStyle='#165bcc';ctx.fillRect(40,10,160,70);ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('Continue',60,52);
      c.onclick=e=>{const r=c.getBoundingClientRect();if(e.clientX-r.left>=40&&e.clientX-r.left<=200&&e.clientY-r.top>=10&&e.clientY-r.top<=80)document.querySelector('#visualResult').textContent='clicked';};
      let dragging=false;document.querySelector('#drag').onpointerdown=e=>{dragging=true;e.preventDefault();};document.onpointerup=e=>{const r=document.querySelector('#drop').getBoundingClientRect();if(dragging&&e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)document.querySelector('#dragResult').textContent='dropped';dragging=false;};
      document.querySelector('#popup-blank').onclick=()=>{const popup=window.open('','_blank');popup.document.write('<!doctype html><title>Blank popup form</title><label>Popup name <input id="blankName"></label><button id="blankSave">Save popup</button><output id="blankResult"></output>');popup.document.close();popup.document.querySelector('#blankSave').onclick=()=>popup.document.querySelector('#blankResult').textContent=popup.document.querySelector('#blankName').value;};
      </script></body></html>`); return;
  }
  if (pathname === '/drag-dialogs') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Drag dialogs</title><h1>Drag dialogs</h1>
      <div style="display:flex;gap:120px"><div id="drag-source" style="width:80px;height:80px;background:#39a;touch-action:none">Drag</div><div id="drag-target" style="width:100px;height:80px;background:#ccc">Drop</div></div>
      <button id="probe">Probe released pointer</button>
      <script>
      window.dialogStage='none';window.pointerDowns=0;window.probeClicks=0;
      document.querySelector('#drag-source').onpointerdown=e=>{e.preventDefault();if(dialogStage==='down')confirm('Continue dragging?');};
      document.onpointerup=e=>{if(dialogStage==='release'&&e.target.id==='drag-target')confirm('Apply this move?');};
      document.querySelector('#probe').onpointerdown=()=>window.pointerDowns++;
      document.querySelector('#probe').onclick=()=>window.probeClicks++;
      </script>`); return;
  }
  if (pathname === '/frames') {
    const crossOrigin = `http://localhost:${fixture.address().port}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Frames and shadow roots</title><h1>Frames and shadow roots</h1>
      <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow name <input id="shadowName"></label><button id="shadowSave">Shadow save</button><output id="shadowResult"></output>';const s=document.querySelector('#shadow').shadowRoot;s.querySelector('button').onclick=()=>s.querySelector('output').textContent=s.querySelector('input').value;</script>
      <iframe title="Cross origin form" src="${crossOrigin}/frame-child" style="width:700px;height:350px;margin:35px;transform:scale(.85);transform-origin:top left"></iframe>`); return;
  }
  if (pathname === '/frame-child') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Embedded form</title><label>Embedded name <input id="embeddedName"></label><button id="embeddedSave" onclick="document.querySelector('#embeddedResult').textContent=document.querySelector('#embeddedName').value">Embedded save</button><output id="embeddedResult"></output><iframe title="Nested form" src="/frame-grandchild" style="margin:25px;width:500px;height:140px"></iframe>`); return;
  }
  if (pathname === '/frame-grandchild') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Nested form</title><button id="nested" onclick="document.querySelector('#nestedResult').textContent='nested clicked'">Nested action</button><output id="nestedResult"></output>`); return;
  }
  if (req.url === '/download') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="browser-smoke.txt"' });
    res.end('agent-browser-extension smoke download'); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html lang="en"><title>Browser smoke fixture</title><body>
    <h1>Browser smoke fixture</h1><label>Name <input id="name"></label>
    <button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button>
    <output id="result"></output><label>Upload <input id="upload" type="file"></label>
    <a href="/download">Download report</a>
    <button id="dialog" onclick="document.querySelector('#result').textContent=confirm('Continue?')?'accepted':'dismissed'">Confirm</button>
    <div style="height:1600px"></div><p id="bottom">Bottom of page</p></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
let bridge; let context; let benchmark;
async function until(fn, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
async function stableNativeViewport(page) {
  let previous; let stable = 0;
  await until(async () => {
    const current = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches }));
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0;
    previous = current; return stable >= 3;
  }, 'Chrome native viewport did not settle after its debugger indicator transition', 3000);
  return previous;
}
try {
  await mkdir('test-results/benchmark', { recursive: true });
  await writeFile('test-results/benchmark/latest.json', `${JSON.stringify({ runnerExecution: { status: 'not-started', startedAt: new Date().toISOString(), reason: 'Current smoke run has not reached the benchmark.' } }, null, 2)}\n`);
  benchmark = await startBenchmarkFixture();
  // Embedders may supply any printable non-space token accepted by startBridge.
  // Exercise URL encoding as well as the extension UI's connection validation.
  bridge = await startBridge({ port: 0, token: randomBytes(32).toString('base64') + '?&=#' });
  const client = new BrowserClient(bridge);
  const deviceScale = Number(process.env.SMOKE_DEVICE_SCALE || 1);
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: true, viewport: null,
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${resolve('dist/extension')}`, `--load-extension=${resolve('dist/extension')}`, `--force-device-scale-factor=${deviceScale}`, `--window-size=${1280 * deviceScale},${900 * deviceScale}`],
    acceptDownloads: true,
  });
  // Leave dialogs to the extension under test, instead of Playwright's auto-dismiss.
  context.on('dialog', () => {});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const manifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
  assert.equal(await options.locator('h1').textContent(), manifest.name);
  await options.getByLabel('Port', { exact: true }).fill(String(bridge.port));
  await options.getByLabel('Connection code', { exact: true }).fill(bridge.token);
  await options.getByRole('button', { name: 'Connect', exact: true }).click();
  assert.equal(await options.locator('#error').textContent(), '', 'A valid custom bridge token must pair through the extension UI');
  await until(async () => (await client.status()).connected, 'Extension did not pair');
  console.log('PASS: real extension paired through its connection screen');

  const userPage = await context.newPage();
  await userPage.goto(`${url}?user`); await userPage.bringToFront();
  const call = (op, args = {}, session = 'smoke-main') => client.execute(session, op, args);
  await call('session.start', { name: 'Smoke task' });
  const userTab = (await call('tabs.list')).tabs.find(t => t.url === `${url}?user`);
  assert.ok(userTab, 'Existing tab discovered without picker');
  await assert.rejects(call('tabs.claim', { tabId: userTab.tabId }), e => e.code === 'SITE_ACCESS_REQUIRED');
  await options.locator('#access-requests').getByRole('button', { name: 'Allow for this task', exact: true }).click();
  const claimed = await call('tabs.claim', { tabId: userTab.tabId });
  assert.equal(claimed.indicatorVisible, true, claimed.indicatorWarning);
  await until(async () => await userPage.title() === '🤖 Browser smoke fixture', 'Claim marker missing');
  for (const [activity, prefix] of [['researching', '🤖🔎 '], ['editing', '🤖✍️ '], ['testing', '🤖🧪 '], ['waiting', '🤖⏳ '], ['active', '🤖 ']]) {
    assert.equal((await call('tabs.activity', { tabId: userTab.tabId, activity })).indicatorVisible, true);
    assert.equal(await userPage.title(), prefix + 'Browser smoke fixture');
  }
  await userPage.evaluate(() => { document.title = 'Updated user title'; });
  await until(async () => await userPage.title() === '🤖 Updated user title', 'Dynamic title lost marker');
  await call('session.start', { name: 'Second task' }, 'smoke-other');
  await assert.rejects(call('tabs.claim', { tabId: userTab.tabId }, 'smoke-other'), e => e.code === 'TAB_BUSY');
  await assert.rejects(call('tabs.open', { url }, 'smoke-other'), e => e.code === 'SITE_ACCESS_REQUIRED');
  const allowOrigin = async origin => {
    await options.getByLabel('Website origin', { exact: true }).fill(origin);
    await options.locator('#site-form').getByRole('button', { name: 'Always allow', exact: true }).click();
    await options.locator('#saved-sites .site-card').filter({ has: options.getByText(origin, { exact: true }) }).getByText(/Browser access: Allowed/).waitFor();
  };
  await allowOrigin(new URL(url).origin);
  await assert.rejects(call('tabs.activity', { tabId: userTab.tabId, activity: 'editing' }, 'smoke-other'), e => e.code === 'TAB_NOT_OWNED');
  await call('tabs.release', { tabId: userTab.tabId });
  assert.equal(await userPage.title(), 'Updated user title');
  await userPage.evaluate(() => { document.title = 'After release'; });
  assert.equal(await userPage.title(), 'After release');
  await call('tabs.claim', { tabId: userTab.tabId }, 'smoke-other');
  assert.equal(await userPage.title(), '🤖 After release');
  await call('tabs.release', { tabId: userTab.tabId }, 'smoke-other');
  await call('tabs.claim', { tabId: userTab.tabId });
  await call('tabs.activity', { tabId: userTab.tabId, activity: 'researching' });
  await call('tabs.navigate', { tabId: userTab.tabId, url: `${url}?user-navigated` });
  await until(async () => await userPage.title() === '🤖🔎 Browser smoke fixture', 'Navigation lost activity marker');
  console.log('PASS: tab markers, every activity emoji, dynamic titles, release, competing ownership and navigation');
  console.log('PASS: default website permission denial, trusted UI grant, task-scoped approval and independent-session denial');
  const scratch = await call('tabs.open', { url, background: true });
  assert.equal(scratch.active, false); assert.ok(scratch.groupId >= 0);
  await until(async () => (await worker.evaluate(id => chrome.tabs.get(id), scratch.tabId)).title === '🤖 Browser smoke fixture', 'Background tab marker missing');
  assert.equal((await call('tabs.list')).tabs.find(t => t.tabId === userTab.tabId).active, true);
  await call('groups.update', { title: 'Smoke group', color: 'purple', collapsed: true });
  const group = await worker.evaluate(groupId => chrome.tabGroups.get(groupId), scratch.groupId);
  assert.equal(group.title, 'Smoke group'); assert.equal(group.collapsed, true);
  if (process.env.SMOKE_ARTIFACT_DIR) {
    await mkdir(process.env.SMOKE_ARTIFACT_DIR, { recursive: true });
    await options.locator('#sessions .task').filter({ has: options.getByText('Smoke task', { exact: true }) }).getByText('2 tabs', { exact: true }).waitFor();
    await options.screenshot({ path: join(process.env.SMOKE_ARTIFACT_DIR, 'connection.png'), fullPage: true });
  }
  console.log('PASS: existing tab discovery, ownership isolation, background tabs and groups');

  const tabId = scratch.tabId;
  const snapshot = await call('page.snapshot', { tabId });
  const name = snapshot.refs.find(n => n.role === 'textbox' && n.name.trim() === 'Name');
  const save = snapshot.refs.find(n => n.role === 'button' && n.name === 'Save');
  assert.ok(name?.ref, JSON.stringify(snapshot)); assert.ok(save?.ref);
  await call('page.fill', { tabId, ref: name.ref, text: 'Autonomous Chrome' });
  await call('page.click', { tabId, ref: save.ref });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#result").textContent' })).json), 'Autonomous Chrome');
  await call('page.press', { tabId, selector: '#name', key: 'End' });
  await call('page.press', { tabId, selector: '#name', key: '!' });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#name").value' })).json), 'Autonomous Chrome!');
  const shot = await call('page.screenshot', { tabId });
  assert.equal(shot.mimeType, 'image/jpeg'); assert.ok(shot.data.length > 1000);
  assert.equal((await call('tabs.list')).tabs.find(t => t.tabId === userTab.tabId).active, true);
  await call('page.scroll', { tabId, y: 900 });
  await call('page.wait', { tabId, selector: '#bottom', state: 'visible' });
  const upload = join(root, 'upload.txt'); await writeFile(upload, 'smoke upload');
  await call('page.upload', { tabId, selector: '#upload', files: [upload] });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#upload").files[0].name' })).json), 'upload.txt');
  const largeUpload = join(root, 'large-upload.bin'); await writeFile(largeUpload, Buffer.alloc(8 * 1024 * 1024, 0x5a));
  await call('page.evaluate', { tabId, expression: 'document.querySelector("#upload").hidden=true' });
  await call('page.upload', { tabId, selector: '#upload', files: [largeUpload] });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#upload").files[0].size' })).json), 8 * 1024 * 1024);
  await call('page.click', { tabId, selector: '#dialog' });
  await call('page.dialog', { tabId, accept: true });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#result").textContent' })).json), 'accepted');
  await call('page.click', { tabId, selector: 'a' });
  await until(async () => (await call('downloads.list')).length > 0, 'Download was not attributed');
  const [download] = await call('downloads.list');
  assert.equal((await call('downloads.wait', { downloadId: download.id })).state, 'complete');
  console.log('PASS: accessibility refs, fill/click/keyboard, background screenshot, scroll, upload, dialog and download');

  await call('tabs.navigate', { tabId, url: `${url}advanced` });
  await call('page.wait', { tabId, url: `${url}advanced` });
  await assert.rejects(call('page.click', { tabId, selector: 'button' }), error => error.code === 'AMBIGUOUS_TARGET');
  await call('page.select', { tabId, selector: '#plan', values: ['pro'] });
  await assert.rejects(call('page.select', { tabId, selector: '#plan', values: ['blocked'] }));
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#planResult").textContent' })).json), 'pro');
  await call('page.select', { tabId, selector: '#regions', values: ['west', 'north'] });
  assert.deepEqual(JSON.parse((await call('page.evaluate', { tabId, expression: 'Array.from(document.querySelector("#regions").selectedOptions).map(o=>o.value)' })).json), ['west', 'north']);
  await call('page.press', { tabId, selector: '#message', key: 'End' });
  await call('page.type', { tabId, text: 'world 🌎' });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#message").value' })).json), 'Hello world 🌎');
  await assert.rejects(call('page.type', { tabId, selector: '#hidden-input', text: 'wrong field' }));
  await assert.rejects(call('page.type', { tabId, selector: '#disabled-input', text: 'wrong field' }));
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#message").value' })).json), 'Hello world 🌎');
  await call('page.hover', { tabId, selector: '#menu' });
  await call('page.wait', { tabId, selector: '#submenu' });
  await call('page.click', { tabId, selector: '#submenu' });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#hoverResult").textContent' })).json), 'selected');
  await call('page.click', { tabId, selector: '#twice', clickCount: 2 });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#doubleResult").textContent' })).json), 'double');
  await call('page.evaluate', { tabId, expression: '(()=>{document.querySelector("#visual").scrollIntoView({block:"center",behavior:"instant"});return true;})()' });
  const visual = await call('page.screenshot', { tabId, format: 'png' });
  assert.equal(visual.mimeType, 'image/png'); assert.ok(visual.image.width > 0); assert.ok(visual.viewport.width > 0);
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'devicePixelRatio' })).json), Number(process.env.SMOKE_DEVICE_SCALE || 1));
  // Chrome's screenshot scale can differ from page DPR; use actual image headers.
  assert.equal(visual.image.width / visual.viewport.width, visual.image.height / visual.viewport.height);
  const canvasPoint = JSON.parse((await call('page.evaluate', { tabId, expression: '(()=>{const r=document.querySelector("#visual").getBoundingClientRect();return{x:r.left+100,y:r.top+40};})()' })).json);
  await call('page.click', { tabId, ...canvasPoint });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#visualResult").textContent' })).json), 'clicked');
  await call('page.evaluate', { tabId, expression: '(()=>{document.querySelector("#drag").parentElement.scrollIntoView({block:"center",behavior:"instant"});return true;})()' });
  await call('page.drag', { tabId, from: { selector: '#drag' }, to: { selector: '#drop' } });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#dragResult").textContent' })).json), 'dropped');
  const beforeRejectedDrag = JSON.parse((await call('page.evaluate', { tabId, expression: 'scrollY' })).json);
  await assert.rejects(call('page.drag', { tabId, from: { selector: '#drag' }, to: { selector: '#distant-drop' } }));
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'scrollY' })).json), beforeRejectedDrag);
  await call('page.scroll', { tabId, y: 250 });
  const fullPage = await call('page.screenshot', { tabId, format: 'png', fullPage: true });
  assert.equal(fullPage.fullPage, true); assert.ok(fullPage.viewport.pageY > 0);
  assert.equal(fullPage.image.height / fullPage.page.height, fullPage.image.width / fullPage.page.width);
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'scrollY' })).json), fullPage.viewport.pageY);
  const popup = await call('page.click', { tabId, selector: '#popup-link' });
  assert.equal(popup.openedTabs?.length, 1, JSON.stringify(popup));
  assert.equal(popup.openedTabs[0].createdByAgent, true); assert.ok(popup.openedTabs[0].groupId >= 0);
  assert.equal(popup.openedTabs[0].active, false);
  const middlePopup = await call('page.click', { tabId, selector: '#popup-link', button: 'middle' });
  assert.equal(middlePopup.openedTabs?.length, 1, 'Middle-clicked links must retain agent ownership for automatic cleanup');
  assert.equal(middlePopup.openedTabs[0].createdByAgent, true);
  assert.equal(middlePopup.openedTabs[0].active, false);
  const scriptedPopup = await call('page.click', { tabId, selector: '#popup-script' });
  assert.equal(scriptedPopup.openedTabs?.length, 1, JSON.stringify(scriptedPopup));
  const blankPopup = await call('page.click', { tabId, selector: '#popup-blank' });
  assert.equal(blankPopup.openedTabs?.length, 1, JSON.stringify(blankPopup));
  const blankTabId = blankPopup.openedTabs[0].tabId;
  assert.equal(blankPopup.openedTabs[0].url, 'about:blank');
  assert.ok((await call('tabs.list')).tabs.some(tab => tab.tabId === blankTabId), 'Captured blank popup remains discoverable');
  await until(async () => (await worker.evaluate(id => chrome.tabs.get(id), blankTabId)).title === '🤖 Blank popup form', 'Popup marker missing');
  const blankSnapshot = await call('page.snapshot', { tabId: blankTabId });
  const blankName = blankSnapshot.refs.find(node => node.role === 'textbox' && node.name.trim() === 'Popup name');
  const blankSave = blankSnapshot.refs.find(node => node.role === 'button' && node.name === 'Save popup');
  assert.ok(blankName?.ref, JSON.stringify(blankSnapshot)); assert.ok(blankSave?.ref);
  await call('page.fill', { tabId: blankTabId, ref: blankName.ref, text: 'Blank popup success' });
  await call('page.click', { tabId: blankTabId, ref: blankSave.ref });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId: blankTabId, expression: 'document.querySelector("#blankResult").textContent' })).json), 'Blank popup success');
  assert.equal((await call('tabs.list')).tabs.find(t => t.tabId === userTab.tabId).active, true);
  await call('page.history', { tabId, direction: 'back' }); await call('page.wait', { tabId, url });
  await call('page.history', { tabId, direction: 'forward' }); await call('page.wait', { tabId, url: `${url}advanced` });
  await call('page.history', { tabId, direction: 'reload' }); await call('page.wait', { tabId, url: `${url}advanced` });
  assert.equal((await call('tabs.list')).tabs.find(t => t.tabId === userTab.tabId).active, true);
  console.log('PASS: dropdowns, caret text/Unicode, hover, double-click, screenshot geometry, canvas click, pointer drag and browser history');

  await call('tabs.navigate', { tabId, url: `${url}drag-dialogs` });
  await call('page.wait', { tabId, url: `${url}drag-dialogs` });
  for (const stage of ['down', 'release']) {
    await call('page.evaluate', { tabId, expression: `window.dialogStage=${JSON.stringify(stage)}` });
    const dragged = await call('page.drag', { tabId, from: { selector: '#drag-source' }, to: { selector: '#drag-target' } });
    assert.equal(dragged.dragged, stage === 'release', JSON.stringify(dragged));
    assert.equal(dragged.dialog?.type, 'confirm', JSON.stringify(dragged));
    await call('page.dialog', { tabId, accept: true });
    await call('page.evaluate', { tabId, expression: 'window.dialogStage="none"' });
    await call('page.click', { tabId, selector: '#probe' });
    const probe = JSON.parse((await call('page.evaluate', { tabId, expression: '({downs:window.pointerDowns,clicks:window.probeClicks})' })).json);
    const expected = stage === 'down' ? 1 : 2;
    assert.deepEqual(probe, { downs: expected, clicks: expected }, 'Dialog dismissal must leave the pointer released for the next click');
  }
  console.log('PASS: drag dialogs are returned and the pointer remains usable after dismissal');

  await call('tabs.navigate', { tabId, url: `${url}frames` });
  await call('page.wait', { tabId, url: `${url}frames`, loadState: 'load' });
  await assert.rejects(call('page.screenshot', { tabId }), error => error.code === 'SITE_ACCESS_REQUIRED');
  await allowOrigin(`http://localhost:${fixture.address().port}`);
  const shadowSnapshot = await call('page.snapshot', { tabId });
  const shadowName = shadowSnapshot.refs.find(node => node.role === 'textbox' && node.name.trim() === 'Shadow name');
  assert.ok(shadowName?.ref, `Shadow-root controls appear in accessibility snapshots: ${JSON.stringify(shadowSnapshot)}`);
  await call('page.fill', { tabId, ref: shadowName.ref, text: 'Shadow success' });
  await call('page.click', { tabId, selector: '#shadowSave' });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'document.querySelector("#shadow").shadowRoot.querySelector("#shadowResult").textContent' })).json), 'Shadow success');
  const frames = (await call('page.frames', { tabId })).frames;
  const child = frames.find(frame => frame.url.endsWith('/frame-child'));
  const grandchild = frames.find(frame => frame.url.endsWith('/frame-grandchild'));
  assert.ok(child?.available, JSON.stringify(frames)); assert.ok(grandchild?.available, JSON.stringify(frames));
  const childSnapshot = await call('page.snapshot', { tabId, frameId: child.frameId });
  const embeddedName = childSnapshot.refs.find(node => node.role === 'textbox' && node.name.trim() === 'Embedded name');
  const embeddedSave = childSnapshot.refs.find(node => node.role === 'button' && node.name === 'Embedded save');
  assert.ok(embeddedName?.ref); assert.ok(embeddedSave?.ref);
  await call('page.fill', { tabId, ref: embeddedName.ref, text: 'Cross-origin success' });
  await call('page.click', { tabId, ref: embeddedSave.ref });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, frameId: child.frameId, expression: 'document.querySelector("#embeddedResult").textContent' })).json), 'Cross-origin success');
  await call('page.fill', { tabId, frameId: child.frameId, locator: { role: 'textbox', name: 'Embedded name' }, text: 'Semantic frame success' });
  await call('page.click', { tabId, frameId: child.frameId, locator: { role: 'button', name: 'Embedded save' } });
  assert.equal((await call('page.read', { tabId, frameId: child.frameId, selector: '#embeddedResult' })).text, 'Semantic frame success');
  await assert.rejects(call('page.read', { tabId, locator: { role: 'textbox', name: 'Embedded name' } }), error => error.code === 'ELEMENT_NOT_FOUND');
  await assert.rejects(call('page.fill', { tabId, frameId: grandchild.frameId, ref: embeddedName.ref, text: 'Wrong frame' }), error => error.code === 'FRAME_MISMATCH');
  const nestedSnapshot = await call('page.snapshot', { tabId, frameId: grandchild.frameId });
  const nested = nestedSnapshot.refs.find(node => node.role === 'button' && node.name === 'Nested action');
  assert.ok(nested?.ref); await call('page.click', { tabId, ref: nested.ref });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, frameId: grandchild.frameId, expression: 'document.querySelector("#nestedResult").textContent' })).json), 'nested clicked');
  await call('page.evaluate', { tabId, frameId: child.frameId, expression: 'document.querySelector("#embeddedResult").textContent="unchanged"' });
  await call('page.evaluate', { tabId, expression: 'document.querySelector("iframe").style.scale="-1 1"' });
  await assert.rejects(call('page.click', { tabId, ref: embeddedSave.ref }), error => error.code === 'FRAME_NOT_ACTIONABLE');
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, frameId: child.frameId, expression: 'document.querySelector("#embeddedResult").textContent' })).json), 'unchanged');
  await call('page.evaluate', { tabId, expression: 'document.querySelector("iframe").style.scale="none"' });
  assert.equal((await call('tabs.list')).tabs.find(t => t.tabId === userTab.tabId).active, true);
  console.log('PASS: open shadow roots, cross-origin frames, nested/scaled frame coordinates, mirrored-frame rejection and frame reference isolation');

  await call('tabs.navigate', { tabId, url: `${url}semantics` });
  await call('page.wait', { tabId, urlIncludes: '/semantics', text: 'Semantic browser controls', loadState: 'load' });
  await call('page.snapshot', { tabId });
  await call('page.fill', { tabId, locator: { placeholder: 'Email for this task' }, text: 'initial@example.test' });
  await call('page.fill', { tabId, locator: { label: 'Work email' }, text: 'semantic@example.test' });
  assert.equal((await call('page.read', { tabId, locator: { testId: 'email-field' } })).value, 'semantic@example.test');
  await assert.rejects(call('page.click', { tabId, locator: { role: 'button', name: 'Publish' } }), error => error.code === 'ELEMENT_NOT_FOUND');
  await call('page.click', { tabId, locator: { role: 'button', name: 'Publish workspace' } });
  assert.equal((await call('page.read', { tabId, locator: { testId: 'semantic-result' } })).text, 'semantic@example.test');
  assert.equal((await call('page.read', { tabId, locator: { role: 'button', name: 'WORKSPACE', exact: false } })).text, 'Store settings');
  await assert.rejects(call('page.click', { tabId, locator: { role: 'button', name: 'Duplicate action' } }), error => error.code === 'AMBIGUOUS_TARGET');
  await call('page.click', { tabId, locator: { testId: 'reset"draft[0]' } });
  assert.equal((await call('page.read', { tabId, locator: { text: 'Reset complete' } })).text, 'Reset complete');
  await call('page.fill', { tabId, locator: { label: 'Shadow field' }, text: 'Semantic shadow success' });
  await call('page.click', { tabId, locator: { role: 'button', name: 'Shadow store', testId: 'shadow-store' } });
  assert.equal((await call('page.read', { tabId, locator: { testId: 'shadow-result' } })).text, 'Semantic shadow success');
  assert.deepEqual(await call('page.check', { tabId, locator: { role: 'checkbox', name: 'Accept local terms' }, checked: true }), { checked: true, changed: true });
  assert.deepEqual(await call('page.check', { tabId, locator: { label: 'Accept local terms' }, checked: true }), { checked: true, changed: false });
  assert.equal((await call('page.read', { tabId, selector: '#terms' })).checked, true);
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'window.checkChanges' })).json), 1);
  assert.deepEqual(await call('page.check', { tabId, selector: '#terms', checked: false }), { checked: false, changed: true });
  assert.equal(JSON.parse((await call('page.evaluate', { tabId, expression: 'window.checkChanges' })).json), 2);
  const passwordRead = await call('page.read', { tabId, locator: { label: 'Private code' } });
  assert.equal(passwordRead.valueOmitted, true); assert.ok(!Object.hasOwn(passwordRead, 'value'));
  const documentRead = await call('page.read', { tabId });
  assert.ok(documentRead.text.includes('Semantic shadow success')); assert.ok(!documentRead.text.includes('fixture-private-password-value'));
  assert.ok(!documentRead.text.includes('Hidden fixture content'));
  const shortRead = await call('page.read', { tabId, maxLength: 20 });
  assert.ok(shortRead.text.length <= 20); assert.equal(shortRead.truncated, true);
  console.log('PASS: Chrome role/name and DOM locators, exact/substring matching, hidden duplicates, strict ambiguity, scoped frames and shadow roots, idempotent checkbox, bounded reads and password omission');

  await call('page.wait', { tabId, selector: '#initial-hidden', state: 'attached' });
  await call('page.wait', { tabId, selector: '#initial-hidden', state: 'hidden' });
  await assert.rejects(call('page.wait', { tabId, locator: { testId: 'email-field' }, state: 'detached' }), error => error.code === 'INVALID_ARGUMENT');
  await call('page.wait', { tabId, selector: '#deferred-button', state: 'disabled' });
  await call('page.click', { tabId, locator: { role: 'button', name: 'Start async' } });
  await call('page.wait', { tabId, text: 'Async result ready', timeoutMs: 3000 });
  await call('page.wait', { tabId, locator: { role: 'button', name: 'Deferred action' }, state: 'enabled' });
  await call('page.wait', { tabId, selector: '#async-node', state: 'visible' });
  await call('page.click', { tabId, locator: { role: 'button', name: 'Remove async' } });
  await call('page.wait', { tabId, selector: '#async-node', state: 'detached', timeoutMs: 3000 });
  await assert.rejects(call('page.wait', { tabId, text: 'This content never arrives', timeoutMs: 150 }), error => error.code === 'TIMEOUT');
  console.log('PASS: URL/text waits, asynchronous visible/attached/detached/enabled/disabled states and bounded timeout');

  await call('page.console', { tabId, clear: true }); await call('page.network', { tabId, clear: true });
  await call('page.click', { tabId, locator: { role: 'button', name: 'Run diagnostics fixture' } });
  await call('page.wait', { tabId, selector: '#diagnostic-result', text: 'Diagnostic request finished' });
  let network;
  await until(async () => {
    network = await call('page.network', { tabId, limit: 100 });
    return network.entries.some(entry => entry.url === `${url}diagnostic-resource` && entry.state === 'finished');
  }, 'Post-attachment network diagnostics did not finish');
  const request = network.entries.find(entry => entry.url === `${url}diagnostic-resource`);
  assert.equal(request.method, 'POST'); assert.equal(request.status, 200); assert.equal(request.resourceType, 'Fetch');
  const networkJson = JSON.stringify(network);
  for (const privateValue of ['fixture-query-secret', 'fixture-fragment-secret', 'fixture-request-header-secret', 'fixture-request-body-secret', 'fixture-response-header-secret', 'fixture-response-body-secret']) assert.ok(!networkJson.includes(privateValue), `Network diagnostics leaked ${privateValue}`);
  assert.ok(!Object.hasOwn(request, 'headers')); assert.ok(!Object.hasOwn(request, 'body'));
  let consoleEntries;
  await until(async () => {
    consoleEntries = (await call('page.console', { tabId, limit: 100 })).entries;
    return consoleEntries.some(entry => entry.source === 'console' && entry.text.includes('semantic smoke console marker')) && consoleEntries.some(entry => entry.source === 'exception' && entry.text.includes('semantic smoke exception marker'));
  }, 'Post-attachment console and exception diagnostics were not observed');
  const consoleRead = await call('page.console', { tabId, limit: 1 });
  assert.equal(consoleRead.entries.length, 1); assert.equal(consoleRead.truncated, true);
  assert.ok((await call('page.console', { tabId, after: consoleRead.nextAfter })).entries.every(entry => entry.id > consoleRead.nextAfter));
  await call('page.console', { tabId, clear: true }); assert.deepEqual((await call('page.console', { tabId })).entries, []);
  console.log('PASS: post-attachment console/errors, network status and completion, secret redaction, diagnostic pagination and clearing');

  await assert.rejects(call('page.profile', { tabId, action: 'start' }), error => error.code === 'SITE_ACCESS_REQUIRED');
  await options.locator('#access-requests').getByRole('button', { name: 'Always allow', exact: true }).click();
  const inspected = await call('page.inspect', { tabId, selector: '#profile-work', properties: ['display', 'color'] });
  assert.ok(JSON.stringify(inspected).includes('rgb(12, 34, 56)'), JSON.stringify(inspected));
  let cpuSupported = true;
  try {
    const cpuStart = await call('page.profile', { tabId, action: 'start', durationMs: 5000 });
    assert.equal(cpuStart.state, 'recording'); assert.match(cpuStart.scope, /isolate/);
  } catch (error) {
    assert.equal(error.code, 'PROFILE_UNAVAILABLE'); cpuSupported = false;
    assert.equal((await call('page.profile', { tabId, action: 'status' })).supported, false);
    console.log('VERIFIED LIMIT: this Chrome build restricts CPU Profiler for ordinary extensions; explicit PROFILE_UNAVAILABLE reported');
  }
  await call('page.performance', { tabId, action: 'start', durationMs: 5000 });
  await call('page.click', { tabId, selector: '#profile-work' });
  await call('page.wait', { tabId, selector: '#profile-result', text: 'Measured work finished' });
  const cpuStop = cpuSupported ? await call('page.profile', { tabId, action: 'stop' }) : undefined;
  const traceStop = await call('page.performance', { tabId, action: 'stop' });
  const readArtifact = async (op, idField, id) => {
    let offset = 0; let content = '';
    for (;;) {
      const part = await call(op, { tabId, action: 'read', [idField]: id, offset, length: 1000 });
      assert.equal(part.offset, offset); content += part.chunk;
      if (part.done) { assert.equal(content.length, part.totalLength); return JSON.parse(content); }
      assert.ok(part.nextOffset > offset); offset = part.nextOffset;
    }
  };
  const cpu = cpuSupported ? await readArtifact('page.profile', 'profileId', cpuStop.profileId) : undefined;
  if (cpu) {
    assert.ok(cpu.nodes.some(node => node.callFrame.functionName === 'measuredFixtureWork'), 'CPU profile includes actual fixture work');
    assert.ok(cpu.samples.length > 0);
  }
  const trace = await readArtifact('page.performance', 'traceId', traceStop.traceId);
  assert.ok(trace.traceEvents.some(event => event.name === 'fixture-work' && event.cat === 'document.measure'), JSON.stringify(trace));
  assert.ok(trace.traceEvents.some(event => event.cat === 'document.longtask'), 'Document trace contains the measured long task');
  const performanceSnapshot = await call('page.performance', { tabId });
  assert.ok(performanceSnapshot.metrics.some(metric => metric.name === 'JSHeapUsedSize'));
  if (cpuSupported) {
    await call('page.profile', { tabId, action: 'clear' });
    await assert.rejects(call('page.profile', { tabId, action: 'read', profileId: cpuStop.profileId }), e => e.code === 'DEBUGGING_ARTIFACT_NOT_FOUND');
    await call('page.profile', { tabId, action: 'start', durationMs: 150 });
    await until(async () => (await call('page.profile', { tabId, action: 'status' })).state === 'stopped', 'CPU capture did not stop automatically');
    console.log('PASS: real CPU samples, profile chunks and automatic profile stop');
  }
  await call('page.performance', { tabId, action: 'start', durationMs: 150 });
  await until(async () => (await call('page.performance', { tabId, action: 'status' })).state === 'stopped', 'Document capture did not stop automatically');
  if (process.env.SMOKE_ARTIFACT_DIR) {
    await writeFile(join(process.env.SMOKE_ARTIFACT_DIR, 'document-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
    await writeFile(join(process.env.SMOKE_ARTIFACT_DIR, 'debugging.json'), `${JSON.stringify({ cpuSupported, inspected, performanceSnapshot }, null, 2)}\n`);
    if (cpu) await writeFile(join(process.env.SMOKE_ARTIFACT_DIR, 'renderer.cpuprofile'), `${JSON.stringify(cpu)}\n`);
  }
  console.log('PASS: separate debugging grant, computed styles, document trace events, chunked artifacts, counters and automatic timeline stop');

  const viewportState = '({width:innerWidth,height:innerHeight,dark:matchMedia("(prefers-color-scheme: dark)").matches,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches})';
  // Native viewport plus a browser scale flag keeps the driver from installing
  // conflicting emulation; reset establishes the extension's clean baseline.
  await call('page.emulate', { tabId, reset: true });
  const baselineViewport = JSON.parse((await call('page.evaluate', { tabId, expression: viewportState })).json);
  await call('page.emulate', { tabId, viewport: { width: 900, height: 700 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.deepEqual(JSON.parse((await call('page.evaluate', { tabId, expression: viewportState })).json), { width: 900, height: 700, dark: true, reduced: true });
  const emulatedScreenshot = await call('page.screenshot', { tabId, format: 'png' });
  assert.equal(emulatedScreenshot.viewport.width, 900); assert.equal(emulatedScreenshot.viewport.height, 700);
  assert.equal((await call('page.emulate', { tabId, reset: true })).restored, true);
  assert.deepEqual(JSON.parse((await call('page.evaluate', { tabId, expression: viewportState })).json), baselineViewport);
  console.log('PASS: viewport, dark color scheme and reduced-motion emulation, screenshot dimensions and reset');

  await call('tabs.navigate', { tabId, url: `${url}?next` });
  await call('page.wait', { tabId, url: `${url}?next`, loadState: 'load' });
  await assert.rejects(call('page.click', { tabId, ref: save.ref }), e => e.code === 'STALE_REF');
  const keep = await call('tabs.open', { url: `${url}?keep`, background: true });
  await call('tabs.mark', { tabId: keep.tabId, disposition: 'deliverable' });
  const handoff = await call('tabs.open', { url: `${url}?handoff`, background: true });
  await call('tabs.mark', { tabId: handoff.tabId, disposition: 'handoff' });
  const pairing = { port: bridge.port, token: bridge.token };
  await bridge.close();
  await until(async () => await userPage.title() === 'Browser smoke fixture', 'Disconnect did not restore title');
  bridge = await startBridge(pairing);
  await until(async () => (await client.status()).connected, 'Extension did not reconnect');
  await until(async () => await userPage.title() === '🤖🔎 Browser smoke fixture', 'Reconnect did not restore activity');
  await assert.rejects(call('tabs.claim', { tabId }, 'smoke-other'), e => e.code === 'TAB_BUSY');
  // Read the current non-emulated viewport. Chrome's debugging indicator can
  // itself alter the inner viewport while attached.
  const userViewport = await stableNativeViewport(userPage);
  await call('page.emulate', { tabId: userTab.tabId, viewport: { width: 810, height: 610, deviceScaleFactor: 3 }, colorScheme: 'dark' });
  assert.deepEqual(await stableNativeViewport(userPage), { width: 810, height: 610, scale: 3, dark: true });
  const cleanup = await call('session.end');
  assert.ok(cleanup.closed.includes(tabId)); assert.ok(cleanup.released.includes(userTab.tabId));
  assert.ok(cleanup.closed.includes(popup.openedTabs[0].tabId)); assert.ok(cleanup.closed.includes(scriptedPopup.openedTabs[0].tabId));
  assert.ok(cleanup.closed.includes(middlePopup.openedTabs[0].tabId), 'Middle-clicked scratch tab closes with its session');
  assert.ok(cleanup.closed.includes(blankTabId), 'Captured blank popup closes with its session');
  assert.ok(cleanup.retained.includes(keep.tabId)); assert.ok(cleanup.retained.includes(handoff.tabId));
  assert.equal(await userPage.title(), 'Browser smoke fixture', 'Finish restores user title');
  const retainedTitles = await worker.evaluate(ids => Promise.all(ids.map(id => chrome.tabs.get(id).then(tab => tab.title))), [keep.tabId, handoff.tabId]);
  assert.deepEqual(retainedTitles, ['Browser smoke fixture', 'Browser smoke fixture'], 'Retained outputs lose the marker');
  const releasedViewport = await stableNativeViewport(userPage);
  assert.equal(releasedViewport.width, userViewport.width, 'Release removes the emulated viewport width');
  assert.equal(releasedViewport.scale, userViewport.scale, 'Release restores the native device scale');
  assert.equal(releasedViewport.dark, userViewport.dark, 'Release restores native media preferences');
  // Chrome may retain/dismiss its own debugger infobar on release, changing the
  // native inner height. It must still remove the explicit device metrics.
  assert.notDeepEqual({ width: releasedViewport.width, height: releasedViewport.height }, { width: 810, height: 610 });
  const { tabs: remaining } = await call('tabs.list', {}, 'smoke-other');
  assert.ok(remaining.some(t => t.tabId === userTab.tabId)); assert.ok(!remaining.some(t => t.tabId === tabId));
  console.log('PASS: stale refs, bridge reconnect, scratch cleanup and deliverable/handoff preservation');

  const mcp = createBrowserMcpServer(client);
  const portableAgent = new Client({ name: 'portable-smoke-agent', version: '1' });
  const [agentTransport, browserTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(browserTransport); await portableAgent.connect(agentTransport);
  try {
    const opened = await portableAgent.callTool({ name: 'browser_open', arguments: { url: `${url}semantics` } });
    assert.ok(!opened.isError);
    const mcpTab = JSON.parse(opened.content.find(c => c.type === 'text').text);
    assert.equal(mcpTab.active, false);
    const observed = await portableAgent.callTool({ name: 'browser_snapshot', arguments: { tabId: mcpTab.tabId } });
    assert.ok(!observed.isError);
    const invoke = async (name, args = {}) => {
      const result = await portableAgent.callTool({ name, arguments: { tabId: mcpTab.tabId, ...args } });
      assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
      return JSON.parse(result.content.find(item => item.type === 'text').text);
    };
    await invoke('browser_fill', { locator: { label: 'Work email' }, text: 'mcp@example.test' });
    assert.equal((await invoke('browser_read', { locator: { testId: 'email-field' } })).value, 'mcp@example.test');
    assert.deepEqual(await invoke('browser_check', { locator: { role: 'checkbox', name: 'Accept local terms' }, checked: true }), { checked: true, changed: true });
    assert.equal((await invoke('browser_wait', { urlIncludes: '/semantics', text: 'Semantic browser controls' })).matched, true);
    assert.equal((await invoke('browser_wait', { selector: '#initial-hidden', state: 'attached' })).matched, true);
    assert.ok(Array.isArray((await invoke('browser_console')).entries));
    assert.ok(Array.isArray((await invoke('browser_network')).entries));
    await invoke('browser_emulate', { viewport: { width: 820, height: 620 }, colorScheme: 'dark' });
    assert.deepEqual(JSON.parse((await invoke('browser_evaluate', { expression: '({width:innerWidth,dark:matchMedia("(prefers-color-scheme: dark)").matches})' })).json), { width: 820, dark: true });
    const screenshot = await portableAgent.callTool({ name: 'browser_screenshot', arguments: { tabId: mcpTab.tabId } });
    assert.ok(screenshot.content.some(c => c.type === 'image' && c.data.length > 1000));
    const second = await portableAgent.callTool({ name: 'browser_open', arguments: { url: `${url}semantics` } });
    assert.ok(!second.isError); const parallelTab = JSON.parse(second.content.find(c => c.type === 'text').text).tabId;
    await invoke('browser_evaluate', { expression: "(()=>{window.channel=new BroadcastChannel('smoke-concurrent');channel.onmessage=()=>document.querySelector('#semantic-result').textContent='Concurrent ready';return true})()" });
    const wait = invoke('browser_wait', { selector: '#semantic-result', text: 'Concurrent ready', timeoutMs: 4000 });
    // Both requests go through the same MCP connection and session. A global
    // queue makes the first wait time out before the second tab can release it.
    const release = invoke('browser_evaluate', { tabId: parallelTab, expression: "(()=>{window.channel=new BroadcastChannel('smoke-concurrent');channel.postMessage('release');return true})()" });
    const [waited] = await Promise.all([wait, release]); assert.equal(waited.matched, true);
    if (cpuSupported) {
      const profile = await invoke('browser_profile', { action: 'start', durationMs: 500 }); assert.equal(profile.state, 'recording');
    } else {
      const unavailable = await portableAgent.callTool({ name: 'browser_profile', arguments: { tabId: mcpTab.tabId, action: 'start', durationMs: 500 } });
      assert.equal(unavailable.isError, true); assert.equal(JSON.parse(unavailable.content.find(c => c.type === 'text').text).code, 'PROFILE_UNAVAILABLE');
    }
    assert.ok((await invoke('browser_inspect', { locator: { role: 'button', name: 'Run measured work' } })).tagName);
    await invoke('browser_performance', { action: 'start', durationMs: 5000 });
    const popupOpen = await portableAgent.callTool({ name: 'browser_open', arguments: { url: `${url}advanced` } });
    assert.ok(!popupOpen.isError); const popupOpener = JSON.parse(popupOpen.content.find(c => c.type === 'text').text).tabId;
    await invoke('browser_navigate', { tabId: parallelTab, url: `${url}advanced` });
    await Promise.all([invoke('browser_wait', { tabId: popupOpener, selector: '#popup-script' }), invoke('browser_wait', { tabId: parallelTab, selector: '#popup-script' })]);
    const foreground = (await call('tabs.list', {}, 'smoke-other')).tabs.find(tab => tab.active)?.tabId;
    const parallelPopups = await Promise.all([invoke('browser_click', { tabId: popupOpener, selector: '#popup-script' }), invoke('browser_click', { tabId: parallelTab, selector: '#popup-script' })]);
    for (const [index, result] of parallelPopups.entries()) {
      assert.equal(result.openedTabs?.length, 1, JSON.stringify(result));
      assert.equal(result.openedTabs[0].openerTabId, [popupOpener, parallelTab][index]);
    }
    assert.notEqual(parallelPopups[0].openedTabs[0].tabId, parallelPopups[1].openedTabs[0].tabId);
    assert.equal((await call('tabs.list', {}, 'smoke-other')).tabs.find(tab => tab.active)?.tabId, foreground, 'Concurrent popups restore the original foreground');
    const finished = await portableAgent.callTool({ name: 'browser_finish', arguments: {} });
    assert.ok(!finished.isError);
    assert.ok(JSON.parse(finished.content.find(c => c.type === 'text').text).closed.includes(mcpTab.tabId));
    assert.ok(parallelPopups.every(result => JSON.parse(finished.content.find(c => c.type === 'text').text).closed.includes(result.openedTabs[0].tabId)));
    await allowOrigin(benchmark.origin);
    const benchmarkResult = await runBenchmarkDriver(portableAgent, benchmark).catch(async error => {
      if (error.benchmarkResult) {
        await writeFile('test-results/benchmark/latest.json', `${JSON.stringify(error.benchmarkResult, null, 2)}\n`);
        if (process.env.SMOKE_ARTIFACT_DIR) await writeFile(join(process.env.SMOKE_ARTIFACT_DIR, 'benchmark.json'), `${JSON.stringify(error.benchmarkResult, null, 2)}\n`);
      }
      throw error;
    });
    await writeFile('test-results/benchmark/latest.json', `${JSON.stringify(benchmarkResult, null, 2)}\n`);
    if (process.env.SMOKE_ARTIFACT_DIR) await writeFile(join(process.env.SMOKE_ARTIFACT_DIR, 'benchmark.json'), `${JSON.stringify(benchmarkResult, null, 2)}\n`);
    console.log(`PASS: shared benchmark ${benchmarkResult.results.passed}/${benchmarkResult.results.total}; automated MCP driver with declared oracle, not model/vision parity`);
  } finally { await mcp.dispose(); await portableAgent.close(); await mcp.server.close(); }
  console.log('PASS: generic MCP client uses concurrent background tabs/popups, semantic controls, diagnostics, CPU capability reporting, inspection, screenshot images and capture cleanup');

  const revokeTab = await call('tabs.open', { url, background: true }, 'smoke-other');
  await call('page.snapshot', { tabId: revokeTab.tabId }, 'smoke-other');
  assert.equal((await call('tabs.activity', { tabId: revokeTab.tabId, activity: 'testing' }, 'smoke-other')).indicatorVisible, true);
  const revokedWait = call('page.wait', { tabId: revokeTab.tabId, text: 'Never ready', timeoutMs: 8000 }, 'smoke-other').then(() => ({ unexpected: true }), error => ({ code: error.code }));
  const mainSite = options.locator('#saved-sites .site-card').filter({ has: options.getByText(new URL(url).origin, { exact: true }) });
  await mainSite.getByRole('button', { name: 'Revoke access', exact: true }).click();
  assert.ok(['SITE_ACCESS_REVOKED', 'SITE_ACCESS_REQUIRED'].includes((await revokedWait).code), 'Revocation ends in-flight wait');
  await assert.rejects(call('page.read', { tabId: revokeTab.tabId }, 'smoke-other'), error => error.code === 'SITE_ACCESS_REQUIRED');
  assert.ok((await call('tabs.list', {}, 'smoke-other')).tabs.some(tab => tab.tabId === userTab.tabId), 'Revocation preserves user tabs');
  await until(async () => (await worker.evaluate(id => chrome.tabs.get(id), revokeTab.tabId)).title === 'Browser smoke fixture', 'Revocation left a stale marker');
  await assert.rejects(call('tabs.activity', { tabId: revokeTab.tabId, activity: 'editing' }, 'smoke-other'), error => error.code === 'SITE_ACCESS_REQUIRED');
  await allowOrigin(new URL(url).origin);
  console.log('PASS: UI revocation cancels active work, blocks further access and preserves user tabs');

  const stopTab = await call('tabs.open', { url, background: true }, 'smoke-other');
  await call('tabs.claim', { tabId: userTab.tabId }, 'smoke-other');
  assert.equal(await userPage.title(), '🤖 Browser smoke fixture');
  await options.bringToFront();
  await until(async () => await options.getByRole('button', { name: 'Stop all tasks' }).isEnabled(), 'Stop control not enabled');
  await options.getByRole('button', { name: 'Stop all tasks' }).click();
  await until(async () => !(await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.id === stopTab.tabId), 'Stop did not clean up temporary tab');
  await assert.rejects(call('session.start', { name: 'Cannot restart stopped session' }, 'smoke-other'), e => e.code === 'SESSION_STOPPED');
  await until(async () => await userPage.title() === 'Browser smoke fixture', 'Stop left a user tab marker');
  console.log('PASS: user Stop revokes and cleans up the session');
  console.log('Real Chrome smoke passed.');
} finally {
  await context?.close(); await bridge?.close(); await benchmark?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(root, { recursive: true, force: true });
  console.log('Disposable profile removed.');
}
