import { BrowserFault } from './controller.js';

const fail = (code, message) => { throw new BrowserFault(code, message); };
const hasTarget = args => args.ref !== undefined || args.selector !== undefined || args.locator !== undefined;

// Serialized beside readContent; include every field in the JSON byte budget,
// including escaped control characters and multi-byte text. Keep field names and
// state booleans intact, shortening the largest text fields until the result fits.
export function boundReadResult(value) {
  const result = { ...value, ...(value.options ? { options: value.options.map(option => ({ ...option })) } : {}) };
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  let size = bytes(result);
  if (size <= 75000) return result;
  result.truncated = true;
  const fields = [];
  for (const object of [result, ...(result.options || [])]) {
    for (const key of Object.keys(object)) if (typeof object[key] === 'string') fields.push({ object, key });
  }
  size = bytes(result);
  while (size > 75000) {
    let largest; let largestBytes = 0;
    for (const field of fields) {
      const count = bytes(field.object[field.key]);
      if (count > largestBytes && field.object[field.key]) { largest = field; largestBytes = count; }
    }
    if (!largest) break;
    const original = largest.object[largest.key];
    const targetBytes = Math.max(2, largestBytes - (size - 75000));
    let low = 0; let high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (bytes(original.slice(0, middle)) <= targetBytes) low = middle;
      else high = middle - 1;
    }
    // Avoid introducing half of a Unicode surrogate pair while shortening text.
    if (low > 0 && /[\uD800-\uDBFF]/.test(original[low - 1])) low--;
    largest.object[largest.key] = original.slice(0, low);
    size = bytes(result);
  }
  return result;
}

// Serialized into the selected document. Walk the rendered composed tree so
// shadow-root text is useful without returning script, markup or password values.
export function readContent(root, maxLength = 30000) {
  const parts = []; let length = 0; let visited = 0; let truncated = false;
  const stack = [root];
  while (stack.length) {
    if (++visited > 30000 || length >= maxLength) { truncated = true; break; }
    const node = stack.pop();
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) { const value = text.slice(0, maxLength - length); parts.push(value); length += value.length + 1; if (value.length < text.length) truncated = true; }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(node.tagName)) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || node.hidden) continue;
    }
    const children = node.tagName === 'SLOT' && node.assignedNodes().length ? node.assignedNodes({ flatten: true }) : (node.shadowRoot || node).childNodes;
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  const result = { text: parts.join(' ').slice(0, maxLength), truncated, tagName: root.tagName?.toLowerCase() };
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement || root instanceof HTMLSelectElement) {
    result.disabled = root.matches(':disabled'); result.readOnly = !!root.readOnly;
    if (root.type === 'password' || root.type === 'hidden') result.valueOmitted = true;
    else if (root.type !== 'file') { result.value = String(root.value).slice(0, maxLength); result.truncated ||= String(root.value).length > maxLength; }
    if (['checkbox', 'radio'].includes(root.type)) result.checked = root.checked;
    if (root instanceof HTMLSelectElement) {
      result.truncated ||= root.options.length > 100;
      result.options = Array.from({ length: Math.min(100, root.options.length) }, (_, index) => root.options[index]).map(option => {
        result.truncated ||= option.value.length > 200 || option.label.length > 200;
        return { value: option.value.slice(0, 200), label: option.label.slice(0, 200), selected: option.selected, disabled: option.disabled || !!option.closest('optgroup[disabled]') };
      });
    }
  }
  if (root.isContentEditable) result.editable = true;
  if (root instanceof HTMLAnchorElement) { result.href = root.href.slice(0, 8192); result.truncated ||= root.href.length > 8192; }
  for (const key of ['aria-checked', 'aria-expanded', 'aria-selected']) if (root.hasAttribute?.(key)) { const value = root.getAttribute(key); result[key] = value.slice(0, 300); result.truncated ||= value.length > 300; }
  return result;
}

export function elementState() {
  const rect = this.getBoundingClientRect(); let hidden = false; let disabled = this.matches(':disabled');
  for (let node = this; node; node = node.parentElement || node.getRootNode()?.host) {
    const style = getComputedStyle(node);
    hidden ||= style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || node.hidden;
    disabled ||= !!node.inert || node.getAttribute('aria-disabled') === 'true';
  }
  return { attached: this.isConnected, visible: this.isConnected && rect.width > 0 && rect.height > 0 && !hidden, enabled: !disabled };
}

export async function readPage(adapter, tabId, args) {
  const maxLength = args.maxLength ?? 30000;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 60000) fail('INVALID_ARGUMENT', 'maxLength must be an integer from 1 to 60000.');
  if (hasTarget(args)) return adapter.call(tabId, args, `function(limit) { return (${boundReadResult.toString()})((${readContent.toString()})(this, limit)); }`, [maxLength]);
  const result = await adapter.send(tabId, 'Runtime.evaluate', { expression: `(() => { const content = (${readContent.toString()})(document.body || document.documentElement, ${maxLength}); content.title = document.title.slice(0,300); content.url = location.href.slice(0,8192); content.truncated ||= document.title.length > 300 || location.href.length > 8192; return (${boundReadResult.toString()})(content); })()`, returnByValue: true, timeout: 3000 });
  if (result.exceptionDetails) fail('READ_FAILED', 'The document changed while being read. Wait for readiness and retry.');
  return result.result?.value;
}

export async function waitForPage(adapter, tabId, args, assertOwned) {
  const states = ['visible', 'hidden', 'attached', 'detached', 'enabled', 'disabled'];
  if (args.state !== undefined && !states.includes(args.state)) fail('INVALID_ARGUMENT', 'Unsupported element wait state.');
  if (args.loadState !== undefined && !['domcontentloaded', 'load'].includes(args.loadState)) fail('INVALID_ARGUMENT', 'loadState must be domcontentloaded or load.');
  for (const name of ['text', 'url', 'urlIncludes']) if (args[name] !== undefined && (typeof args[name] !== 'string' || !args[name] || args[name].length > 8192)) fail('INVALID_ARGUMENT', `${name} must be a nonempty bounded string.`);
  const timeout = args.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) fail('INVALID_ARGUMENT', 'timeoutMs must be 100–30000.');
  const deadline = Date.now() + timeout; const state = args.state || 'visible'; const target = hasTarget(args);
  if (!target && ['attached', 'detached', 'enabled', 'disabled'].includes(state)) fail('INVALID_ARGUMENT', `${state} requires an element target.`);
  if (args.locator !== undefined && ['attached', 'detached'].includes(state)) fail('INVALID_ARGUMENT', 'Semantic locators match visible elements. Use a CSS selector to wait for attached or detached state.');
  do {
    assertOwned();
    try {
      const original = args.frameId ?? (args.ref ? adapter.referenceSnapshot(tabId, args.ref)?.frameId : undefined);
      adapter.scopes.set(tabId, await adapter.frames.select(tabId, original));
      const { result } = await adapter.send(tabId, 'Runtime.evaluate', { expression: '({ready:document.readyState,url:location.href})', returnByValue: true, timeout: 1000 });
      const page = result?.value;
      const scope = adapter.scopes.get(tabId);
      const tab = await adapter.chrome.tabs.get(tabId);
      const navigating = scope.frameId === scope.mainFrameId && !!tab.pendingUrl;
      let matches = !navigating && !!page && (args.loadState === 'load' ? page.ready === 'complete' : ['interactive', 'complete'].includes(page.ready));
      if (args.url) matches &&= page?.url === args.url;
      if (args.urlIncludes) matches &&= !!page?.url.includes(args.urlIncludes);
      if (target) {
        try {
          const observed = await adapter.call(tabId, args, elementState.toString());
          matches &&= state === 'visible' ? observed.visible : state === 'hidden' ? !observed.visible : state === 'attached' ? observed.attached : state === 'detached' ? !observed.attached : state === 'enabled' ? observed.visible && observed.enabled : !observed.enabled;
        } catch (error) {
          if (error.code !== 'ELEMENT_NOT_FOUND') throw error;
          matches &&= ['hidden', 'detached'].includes(state);
        }
      }
      if (matches && args.text) {
        let content;
        try { content = await readPage(adapter, tabId, { ...args, maxLength: 60000 }); }
        catch (error) { if (error.code !== 'ELEMENT_NOT_FOUND') throw error; content = { text: '' }; }
        const contains = !!content?.text.includes(args.text);
        if (['hidden', 'detached'].includes(state) && !contains && content?.truncated) fail('WAIT_CONTENT_TRUNCATED', 'Text absence cannot be verified from truncated content. Narrow the target with a CSS selector.');
        matches &&= ['hidden', 'detached'].includes(state) ? !contains : contains;
      }
      if (matches) { assertOwned(); return { ...(!target && !args.text ? { ready: true } : { matched: true }), url: page.url }; }
    } catch (error) {
      if (!['BROWSER_ACTION_FAILED', 'READ_FAILED'].includes(error.code)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  fail('TIMEOUT', 'The requested page, text, or element conditions were not reached.');
}

export async function checkControl(adapter, tabId, args) {
  if (typeof args.checked !== 'boolean') fail('INVALID_ARGUMENT', 'checked must be a boolean.');
  const read = `function() {
    if (this instanceof HTMLInputElement && ['checkbox','radio'].includes(this.type)) return { checked:this.checked, radio:this.type==='radio' };
    if (['checkbox','radio','switch'].includes(this.getAttribute('role'))) return { checked:this.getAttribute('aria-checked')==='true', radio:this.getAttribute('role')==='radio' };
    throw new Error('Target must be a checkbox, radio button, or switch.');
  }`;
  const before = await adapter.call(tabId, args, read);
  if (before.checked === args.checked) return { checked: args.checked, changed: false };
  if (before.radio && !args.checked) fail('INVALID_ARGUMENT', 'A radio button can be selected, not cleared. Select another radio in its group.');
  const clicked = await adapter.click(tabId, args);
  if (clicked.dialog) return { pending: true, dialog: clicked.dialog, message: 'Respond to the dialog, then read the control state before repeating this action.' };
  const after = await adapter.call(tabId, args, read);
  if (after.checked !== args.checked) fail('STATE_NOT_CHANGED', 'The control did not reach the requested checked state. Inspect the page before retrying.');
  return { checked: after.checked, changed: true };
}

export async function emulatePage(adapter, tabId, args) {
  if (args.reset !== undefined && typeof args.reset !== 'boolean') fail('INVALID_ARGUMENT', 'reset must be boolean.');
  if (args.reset && (args.viewport !== undefined || args.colorScheme !== undefined || args.reducedMotion !== undefined)) fail('INVALID_ARGUMENT', 'Use reset alone to restore the browser defaults.');
  if (args.colorScheme !== undefined && !['light', 'dark', 'system'].includes(args.colorScheme)) fail('INVALID_ARGUMENT', 'colorScheme must be light, dark, or system.');
  if (args.reducedMotion !== undefined && !['reduce', 'no-preference', 'system'].includes(args.reducedMotion)) fail('INVALID_ARGUMENT', 'Unsupported reducedMotion value.');
  let viewport;
  if (args.viewport !== undefined) {
    const value = args.viewport;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['width', 'height', 'deviceScaleFactor', 'mobile'].includes(key))) fail('INVALID_ARGUMENT', 'viewport must contain width and height, with optional scale and mobile.');
    viewport = { width: value.width, height: value.height, deviceScaleFactor: value.deviceScaleFactor ?? 1, mobile: value.mobile ?? false };
    if (![viewport.width, viewport.height].every(value => Number.isInteger(value) && value >= 240 && value <= 3840) || typeof viewport.mobile !== 'boolean' || !Number.isFinite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor < 1 || viewport.deviceScaleFactor > 3 || viewport.width * viewport.height * viewport.deviceScaleFactor ** 2 > 16000000) fail('INVALID_ARGUMENT', 'Viewport must be 240–3840 CSS pixels, scale 1–3, and at most 16 million image pixels.');
  }
  if (!args.reset && !viewport && args.colorScheme === undefined && args.reducedMotion === undefined) fail('INVALID_ARGUMENT', 'Provide viewport, colorScheme, reducedMotion, or reset.');
  const previous = adapter.emulations.get(tabId) || {};
  if (previous.uncertain && !args.reset) fail('EMULATION_UNCERTAIN', 'A previous emulation change did not complete. Reset emulation before applying another change.');
  // Record potential changes before sending, so release/Stop can always restore.
  const next = args.reset ? {} : { ...previous, ...(viewport ? { viewport } : {}), ...(args.colorScheme === undefined ? {} : { colorScheme: args.colorScheme }), ...(args.reducedMotion === undefined ? {} : { reducedMotion: args.reducedMotion }) };
  const pending = { ...next, uncertain: true };
  adapter.emulations.set(tabId, pending);
  if (args.reset) await adapter.sendInput(tabId, 'Emulation.clearDeviceMetricsOverride');
  else if (viewport) await adapter.sendInput(tabId, 'Emulation.setDeviceMetricsOverride', viewport);
  const features = [];
  if (next.colorScheme && next.colorScheme !== 'system') features.push({ name: 'prefers-color-scheme', value: next.colorScheme });
  if (next.reducedMotion && next.reducedMotion !== 'system') features.push({ name: 'prefers-reduced-motion', value: next.reducedMotion });
  await adapter.sendInput(tabId, 'Emulation.setEmulatedMedia', { features });
  if (adapter.emulations.get(tabId) !== pending) fail('EMULATION_CANCELED', 'Emulation was cleared while the action was running.');
  adapter.emulations.set(tabId, next);
  adapter.invalidate(tabId);
  return { emulated: next, restored: !!args.reset };
}
