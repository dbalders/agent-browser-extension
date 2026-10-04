import { TabIndicators } from './tab-indicators.js';
import { BrowserFault } from './controller.js';
import { FrameRouter, shadowQuery, pointerProbe } from './frame-router.js';
import { clickInteraction, runInteraction, captureScreenshot } from './interactions.js';
import { resolveLocator } from './locators.js';
import { PageDiagnostics } from './diagnostics.js';
import { readPage, waitForPage, checkControl, emulatePage } from './page-utilities.js';
import { PageDebugging, inspectTarget } from './debugging.js';

const fault = (code, message) => { throw new BrowserFault(code, message); };
const bounded = (value, limit = 30000) => String(value ?? '').slice(0, limit);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class PageAdapter {
  constructor(chromeApi) {
    this.chrome = chromeApi; this.attached = new Set(); this.snapshots = new Map(); this.sequence = 0; this.dialogs = new Map(); this.guards = new Map(); this.dialogWaiters = new Map();
    this.indicators = new TabIndicators(this);
    this.diagnostics = new PageDiagnostics(); this.emulations = new Map(); this.debugging = new PageDebugging(this);
    this.scopes = new Map(); this.dialogTargets = new Map(); this.frames = new FrameRouter((target, method, params) => this.rawSend(target, method, params));
  }
  invalidate(tabId) { for (const [key, snapshot] of this.snapshots) if (snapshot.tabId === tabId) this.snapshots.delete(key); }
  event(source, method, params) {
    this.frames.event(source, method, params); this.diagnostics.event(source, method, params); this.debugging.event(source, method, params);
    if (['DOM.documentUpdated', 'Page.frameNavigated', 'Page.frameDetached', 'Target.detachedFromTarget'].includes(method)) this.invalidate(source.tabId);
    if (method === 'Page.javascriptDialogOpening') {
      const dialog = { type: params.type, message: bounded(params.message, 1000) };
      this.dialogs.set(source.tabId, dialog);
      this.dialogTargets.set(source.tabId, source);
      for (const resolve of this.dialogWaiters.get(source.tabId) || []) resolve({ dialogOpened: true, dialog });
    }
    if (method === 'Page.javascriptDialogClosed') { this.dialogs.delete(source.tabId); this.dialogTargets.delete(source.tabId); }
  }
  setActivity(tabId, activity, guard) { return this.indicators.set(tabId, activity, guard); }
  detached(tabId) { this.indicators.forget(tabId); this.debugging.forget(tabId); this.diagnostics.clear(tabId); this.emulations.delete(tabId); this.attached.delete(tabId); this.invalidate(tabId); this.dialogs.delete(tabId); this.dialogTargets.delete(tabId); this.frames.clear(tabId); this.scopes.delete(tabId); }
  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    try { await this.chrome.debugger.attach({ tabId }, '1.3'); }
    catch (error) { fault('DEBUGGER_UNAVAILABLE', `Chrome could not attach to this page: ${bounded(error.message, 500)}`); }
    this.attached.add(tabId); this.diagnostics.start(tabId);
    try { await this.frames.enable(tabId); }
    catch (error) { await this.detach(tabId); throw error; }
  }
  async detach(tabId) {
    const indicatorCleanup = this.indicators.clear(tabId);
    const debugCleanup = this.debugging.dispose(tabId);
    this.diagnostics.clear(tabId);
    if (this.emulations.delete(tabId) && this.attached.has(tabId)) {
      // Cleanup must run even when the operation ownership guard was revoked.
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([
            this.chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'),
            this.chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedMedia', { features: [] })
          ]),
          new Promise(resolve => { timer = setTimeout(resolve, 2000); })
        ]);
      } finally { clearTimeout(timer); }
    }
    await Promise.all([debugCleanup, indicatorCleanup]);
    this.invalidate(tabId); this.dialogs.delete(tabId); this.dialogTargets.delete(tabId); this.frames.clear(tabId); this.scopes.delete(tabId);
    if (this.attached.delete(tabId)) { try { await this.chrome.debugger.detach({ tabId }); } catch { /* A closed tab is already detached. */ } }
  }
  async disconnect() { await Promise.all([...this.attached].map(tabId => this.detach(tabId))); }
  async send(tabId, method, args = {}, mutation = false) {
    const scope = this.scopes.get(tabId);
    if (method.startsWith('Input.')) return this.sendInput(tabId, method, args);
    if (method === 'Runtime.evaluate' && scope?.executionContextId !== undefined) args = { ...args, contextId: scope.executionContextId };
    if (method === 'DOM.resolveNode' && scope?.executionContextId !== undefined) args = { ...args, executionContextId: scope.executionContextId };
    if (method === 'Accessibility.getFullAXTree' && scope?.frameId) args = { ...args, frameId: scope.frameId };
    return this.rawSend(method === 'Page.handleJavaScriptDialog' ? this.dialogTargets.get(tabId) || { tabId } : scope?.target || { tabId }, method, args, mutation);
  }
  async sendInput(tabId, method, args = {}) {
    const mutation = (method === 'Input.dispatchMouseEvent' && args.type === 'mousePressed') || (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown'].includes(args.type));
    return this.rawSend({ tabId }, method, args, mutation);
  }
  async rawSend(target, method, args = {}, mutation = false) {
    const tabId = target.tabId;
    this.guards.get(tabId)?.();
    let timer; let waiter;
    const dialogSensitive = ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Runtime.evaluate', 'Runtime.callFunctionOn'].includes(method);
    if (dialogSensitive && this.dialogs.has(tabId)) fault('DIALOG_OPEN', 'Respond to the open JavaScript dialog with page.dialog before continuing.');
    if (mutation) this.beforeMutation?.(tabId);
    try {
      const waiting = [];
      if (dialogSensitive) waiting.push(new Promise(resolve => {
        waiter = resolve;
        const waiters = this.dialogWaiters.get(tabId) || new Set(); waiters.add(resolve); this.dialogWaiters.set(tabId, waiters);
      }));
      return await Promise.race([
        this.chrome.debugger.sendCommand(target, method, args),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserFault('CDP_TIMEOUT', 'Chrome did not complete this action. Inspect for a page dialog, or stop this task.')), 10000); }),
        ...waiting
      ]) || {};
    } catch (error) { if (error instanceof BrowserFault) throw error; fault('BROWSER_ACTION_FAILED', bounded(error.message || error, 1000)); }
    finally { clearTimeout(timer); if (waiter) this.dialogWaiters.get(tabId)?.delete(waiter); }
  }
  async loader(tabId) { return this.frames.loader(tabId, this.scopes.get(tabId)?.frameId); }
  async waitReady(tabId, args = {}, assertOwned = () => {}) {
    const deadline = Date.now() + Math.min(30000, Math.max(100, Number(args.timeoutMs) || 10000));
    do {
      assertOwned(); const tab = await this.chrome.tabs.get(tabId);
      try {
        const current = this.scopes.get(tabId);
        if (current) this.scopes.set(tabId, await this.frames.select(tabId, current.frameId));
        const { result } = await this.send(tabId, 'Runtime.evaluate', { expression: '({ready:document.readyState,url:location.href})', returnByValue: true, timeout: 1000 });
        const page = result?.value;
        const scope = this.scopes.get(tabId); const childFrame = scope && scope.frameId !== scope.mainFrameId;
        if (page && (childFrame || !tab.pendingUrl) && /^(https?:|about:(blank|srcdoc)$)/.test(page.url) && (args.loadState === 'load' ? page.ready === 'complete' : ['interactive', 'complete'].includes(page.ready)) && (!args.url || page.url === args.url)) return { ready: true, url: page.url };
      } catch (error) { if (!['BROWSER_ACTION_FAILED'].includes(error.code)) throw error; }
      await delay(100);
    } while (Date.now() < deadline);
    fault('TIMEOUT', 'The page did not reach the requested URL or loading state.');
  }
  async target(tabId, args) {
    if (['ref', 'selector', 'locator'].filter(key => args[key] !== undefined).length !== 1) fault('INVALID_ARGUMENT', 'Provide exactly one ref, selector, or locator.');
    if (args.locator !== undefined) return resolveLocator((method, params) => this.send(tabId, method, params), args.locator);
    if (typeof args.ref === 'string') {
      const snapshot = this.referenceSnapshot(tabId, args.ref);
      if (!snapshot) fault('STALE_REF', 'This page reference expired. Take a new page snapshot.');
      if ((args.frameId && args.frameId !== snapshot.frameId) || (this.scopes.get(tabId) && this.scopes.get(tabId).frameId !== snapshot.frameId)) fault('FRAME_MISMATCH', 'This reference belongs to a different frame. Use its original frame or a new snapshot.');
      let loader;
      try { loader = await this.frames.loader(tabId, snapshot.frameId); }
      catch (error) { if (error.code === 'FRAME_NOT_FOUND') fault('STALE_REF', 'This frame has gone away. Take a new snapshot.'); throw error; }
      if (snapshot.loader !== loader) fault('STALE_REF', 'This page reference expired. Take a new page snapshot.');
      return snapshot.refs.get(args.ref);
    }
    if (typeof args.selector === 'string' && args.selector.length > 0 && args.selector.length <= 2000) {
      const result = await this.send(tabId, 'Runtime.evaluate', { expression: `(${shadowQuery.toString()})(${JSON.stringify(args.selector)})`, returnByValue: false, timeout: 2000 });
      if (result.exceptionDetails) {
        const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '';
        const code = ['AMBIGUOUS_TARGET', 'INVALID_SELECTOR', 'TARGET_SEARCH_LIMIT'].find(value => message.includes(value)) || 'ELEMENT_ACTION_FAILED';
        fault(code, bounded(message, 500));
      }
      if (!result.result?.objectId || result.result.subtype === 'null') fault('ELEMENT_NOT_FOUND', 'No element matches this selector in the selected frame or its open shadow roots.');
      const objectId = result.result.objectId;
      try {
        const { node } = await this.send(tabId, 'DOM.describeNode', { objectId });
        if (!node?.backendNodeId) fault('ELEMENT_NOT_FOUND', 'The selected element no longer exists.');
        return node.backendNodeId;
      } finally { await this.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
    }
    fault('INVALID_ARGUMENT', 'Provide a ref from the current snapshot, a CSS selector, or a semantic locator.');
  }
  referenceSnapshot(tabId, ref) { return [...this.snapshots.values()].find(snapshot => snapshot.tabId === tabId && snapshot.refs.has(ref)); }
  async object(tabId, args) {
    const backendNodeId = await this.target(tabId, args);
    try {
      const { object } = await this.send(tabId, 'DOM.resolveNode', { backendNodeId });
      if (!object?.objectId) fault('STALE_REF', 'The element no longer exists. Take another snapshot.');
      return object.objectId;
    } catch (error) { if (args.ref && ['BROWSER_ACTION_FAILED', 'FRAME_NOT_FOUND'].includes(error.code)) fault('STALE_REF', 'The element changed. Take another snapshot.'); throw error; }
  }
  async call(tabId, args, functionDeclaration, values = []) {
    const objectId = await this.object(tabId, args);
    try {
      const result = await this.send(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: values.map(value => ({ value })), returnByValue: true, awaitPromise: false });
      if (result.exceptionDetails) fault('ELEMENT_ACTION_FAILED', bounded(result.exceptionDetails.exception?.description || result.exceptionDetails.text, 1000));
      return result.result?.value;
    } finally { await this.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
  }
  async snapshot(tabId) {
    const scope = this.scopes.get(tabId);
    const loader = await this.loader(tabId); const { nodes = [] } = await this.send(tabId, 'Accessibility.getFullAXTree');
    const snapshotId = `s${Date.now().toString(36)}-${++this.sequence}`; const refs = new Map(); const items = []; let bytes = 0; let truncated = false;
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = bounded(node.role?.value, 80); const name = bounded(node.name?.value, 350);
      if (!name && ['generic', 'none'].includes(role)) continue;
      const item = { role, name };
      if (node.backendDOMNodeId) item.ref = `${snapshotId}:${items.length + 1}`;
      for (const prop of node.properties || []) if (['disabled', 'checked', 'expanded', 'selected', 'required', 'level'].includes(prop.name)) item[prop.name] = prop.value?.value;
      // Password values are deliberately omitted from the observation.
      if (node.value?.value && role !== 'textbox') item.value = bounded(node.value.value, 200);
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (items.length >= 800 || bytes + size > 75000) { truncated = true; break; }
      items.push(item); bytes += size; if (item.ref) refs.set(item.ref, node.backendDOMNodeId);
    }
    if (loader !== await this.loader(tabId)) fault('PAGE_CHANGED', 'The page navigated while taking a snapshot. Try again.');
    this.snapshots.set(`${tabId}:${scope.frameId}`, { tabId, frameId: scope.frameId, loader, refs });
    const tab = await this.chrome.tabs.get(tabId);
    return { snapshotId, frameId: scope.frameId, url: bounded(scope.url || tab.url, 8192), title: bounded(tab.title, 300), refs: items, truncated, scope: 'Selected frame accessibility tree. Use browser_frames to discover other frames. CSS selectors also search open shadow roots.' };
  }
  async pointerTarget(tabId, args, options = {}) {
    const previous = this.scopes.get(tabId);
    const requestedFrameId = args.frameId ?? (args.ref ? this.referenceSnapshot(tabId, args.ref)?.frameId : undefined);
    try {
      if (requestedFrameId && requestedFrameId !== previous?.frameId) this.scopes.set(tabId, await this.frames.select(tabId, requestedFrameId));
      const backendNodeId = await this.target(tabId, args);
      if (options.scroll !== false) await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
      const point = await this.call(tabId, args, pointerProbe.toString());
      if (!point?.ok) fault('ELEMENT_NOT_ACTIONABLE', 'The element is disabled, outside the viewport, or covered by another element. Inspect the page before clicking.');
      return await this.frames.rootPoint(tabId, this.scopes.get(tabId), { x: point.x, y: point.y });
    } finally { if (previous) this.scopes.set(tabId, previous); else this.scopes.delete(tabId); }
  }
  async click(tabId, args) { return clickInteraction(this, tabId, args); }
  async press(tabId, args) {
    if (args.ref || args.selector || args.locator) await this.send(tabId, 'DOM.focus', { backendNodeId: await this.target(tabId, args) });
    if (typeof args.key !== 'string' || args.key.length > 80) fault('INVALID_ARGUMENT', 'key is required, for example Enter or Control+a.');
    const parts = args.key.split('+'); const raw = parts.pop(); let modifiers = 0;
    for (const modifier of parts) {
      const value = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 }[modifier];
      if (!value) fault('INVALID_ARGUMENT', `Unsupported key modifier: ${modifier}`); modifiers |= value;
    }
    const special = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'] };
    if (!special[raw] && raw.length !== 1) fault('INVALID_ARGUMENT', 'Unsupported key.');
    const key = raw === 'Space' ? ' ' : raw; const virtualKey = special[raw]?.[0] || raw.toUpperCase().charCodeAt(0);
    const keyCode = special[raw]?.[1] || (/^[a-z]$/i.test(raw) ? `Key${raw.toUpperCase()}` : /^[0-9]$/.test(raw) ? `Digit${raw}` : '');
    const text = !(modifiers & 7) ? (raw === 'Enter' ? '\r' : key.length === 1 ? key : undefined) : undefined;
    const pressed = await this.send(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: keyCode, modifiers, windowsVirtualKeyCode: virtualKey, ...(text ? { text, unmodifiedText: text } : {}) });
    if (pressed.dialogOpened) return { pressed: args.key, dialog: pressed.dialog };
    const released = await this.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: keyCode, modifiers, windowsVirtualKeyCode: virtualKey });
    return { pressed: args.key, ...(released.dialogOpened ? { dialog: released.dialog } : {}) };
  }
  async execute(tabId, operation, args, assertOwned = () => {}) {
    this.guards.set(tabId, assertOwned);
    try {
      assertOwned(); await this.attach(tabId); assertOwned();
      if (operation === 'page.frames') return await this.frames.list(tabId);
      if (operation === 'page.console' || operation === 'page.network') return this.diagnostics.read(tabId, operation.slice(5), args);
      if (operation === 'page.emulate') return await emulatePage(this, tabId, args);
      if (operation === 'page.profile') return await this.debugging.profile(tabId, args);
      if (operation === 'page.performance' && ['stop', 'status', 'read', 'clear'].includes(args.action)) return await this.debugging.performance(tabId, args);
      if (operation === 'page.snapshot' && this.dialogs.has(tabId)) return { dialog: this.dialogs.get(tabId), refs: [], scope: 'A JavaScript dialog is open. Use page.dialog to respond.' };
      if (operation !== 'page.dialog') {
        const snapshot = args.ref ? this.referenceSnapshot(tabId, args.ref) : undefined;
        this.scopes.set(tabId, await this.frames.select(tabId, args.frameId ?? snapshot?.frameId));
      }
      return await this.runOperation(tabId, operation, args, assertOwned);
    } finally { this.guards.delete(tabId); this.scopes.delete(tabId); }
  }
  async runOperation(tabId, operation, args, assertOwned = () => {}) {
    assertOwned(); await this.attach(tabId); assertOwned();
    if (['page.hover', 'page.drag', 'page.select', 'page.type', 'page.history'].includes(operation)) return runInteraction(this, tabId, operation, args);
    if (operation === 'page.snapshot') {
      if (this.dialogs.has(tabId)) return { dialog: this.dialogs.get(tabId), refs: [], scope: 'A JavaScript dialog is open. Use page.dialog to respond.' };
      await this.waitReady(tabId, args, assertOwned); return this.snapshot(tabId);
    }
    if (operation === 'page.read') return readPage(this, tabId, args);
    if (operation === 'page.inspect') return inspectTarget(this, tabId, args);
    if (operation === 'page.performance') return this.debugging.performance(tabId, args, this.scopes.get(tabId));
    if (operation === 'page.check') return checkControl(this, tabId, args);
    if (operation === 'page.click') return this.click(tabId, args);
    if (operation === 'page.fill') {
      if (typeof args.text !== 'string' || args.text.length > 100000) fault('INVALID_ARGUMENT', 'text must be a string of at most 100000 characters.');
      await this.call(tabId, args, `function(text) {
        if (!this.isConnected || this.matches(':disabled') || this.readOnly || this.closest('[inert]')) throw new Error('This element cannot be edited.');
        for (let node=this;node;node=node.parentElement||node.getRootNode()?.host) if (node.inert) throw new Error('This element is inert.');
        this.focus();
        if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
          if (this.type === 'file') throw new Error('Use page.upload for file inputs.');
          if (['hidden','button','submit','reset','image','checkbox','radio'].includes(this.type)) throw new Error('This input is not a text-editable field.');
          const base = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(base, 'value').set.call(this, text);
        } else if (this.isContentEditable) { this.textContent = text; }
        else throw new Error('This element is not an editable field.');
        this.dispatchEvent(new Event('input', {bubbles:true,composed:true})); this.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      }`, [args.text]);
      return { filled: true, ...(this.dialogs.has(tabId) ? { dialog: this.dialogs.get(tabId) } : {}) };
    }
    if (operation === 'page.press') return this.press(tabId, args);
    if (operation === 'page.scroll') {
      const x = Number(args.x ?? 0); const y = Number(args.y ?? 600);
      if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) fault('INVALID_ARGUMENT', 'Scroll offsets must be finite and bounded.');
      if (args.ref || args.selector || args.locator) await this.call(tabId, args, 'function(x,y) { this.scrollBy({left:x,top:y,behavior:"instant"}); return true; }', [x, y]);
      else await this.send(tabId, 'Runtime.evaluate', { expression: `window.scrollBy({left:${x},top:${y},behavior:"instant"})`, returnByValue: true });
      return { scrolled: true };
    }
    if (operation === 'page.screenshot') {
      return captureScreenshot(this, tabId, args);
    }
    if (operation === 'page.evaluate') {
      if (typeof args.expression !== 'string' || args.expression.length > 20000) fault('INVALID_ARGUMENT', 'expression must be a JavaScript expression under 20000 characters.');
      // Evaluation is an explicit powerful operation; normal page actions use bounded element APIs.
      const expression = `(() => { const v = (${args.expression}); if (v && typeof v.then === 'function') throw new Error('Promise results are unsupported; use page.wait.'); let s; try { s = JSON.stringify(v); } catch { s = String(v); } return {json:(s ?? 'null').slice(0,30000),truncated:(s?.length ?? 0)>30000}; })()`;
      const result = await this.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, timeout: 5000 }, true);
      if (result.dialogOpened) return { pending: true, dialog: result.dialog, message: 'Evaluation opened a dialog. Respond with page.dialog; do not repeat this evaluation.' };
      if (result.exceptionDetails) fault('EVALUATION_FAILED', bounded(result.exceptionDetails.exception?.description || result.exceptionDetails.text, 1000));
      return result.result?.value;
    }
    if (operation === 'page.wait') return waitForPage(this, tabId, args, assertOwned);
    if (operation === 'page.upload') {
      if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 20 || args.files.some(file => typeof file !== 'string' || file.length > 4096 || !/^(\/|[A-Za-z]:[\\/])/.test(file))) fault('INVALID_ARGUMENT', 'files must contain 1–20 absolute local file paths.');
      await this.send(tabId, 'DOM.setFileInputFiles', { backendNodeId: await this.target(tabId, args), files: args.files }); return { uploaded: args.files.length };
    }
    if (operation === 'page.dialog') {
      if (typeof args.accept !== 'boolean') fault('INVALID_ARGUMENT', 'accept must be a boolean.');
      await this.send(tabId, 'Page.handleJavaScriptDialog', { accept: args.accept, ...(typeof args.promptText === 'string' ? { promptText: args.promptText.slice(0, 10000) } : {}) }); return { handled: true };
    }
    fault('UNKNOWN_OPERATION', `Unsupported page operation: ${operation}`);
  }
}
