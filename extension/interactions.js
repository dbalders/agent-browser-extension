import { BrowserFault } from './controller.js';

const fail = (code, message) => { throw new BrowserFault(code, message); };
const buttons = { left: 1, right: 2, middle: 4 };

function imageSize(data, format) {
  // Image headers are near the start; do not decode the multi-megabyte payload twice.
  const bytes = Uint8Array.from(atob(data.slice(0, 349524)), character => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (format === 'png' && bytes.length >= 24 && view.getUint32(0) === 0x89504e47) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (format === 'jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      if (marker === 0xd9 || marker === 0xda) break;
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return undefined;
}

export async function pointerPoint(adapter, tabId, args, scroll = true) {
  const coordinate = args.x !== undefined || args.y !== undefined;
  if (!coordinate) return adapter.pointerTarget(tabId, args, { scroll });
  if (args.ref || args.selector || args.locator || args.frameId) fail('INVALID_ARGUMENT', 'Use either an element target or full-tab viewport coordinates, not both.');
  if (![args.x, args.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) fail('INVALID_ARGUMENT', 'x and y must be finite, nonnegative CSS pixel coordinates from the latest screenshot.');
  const metrics = await adapter.sendInput(tabId, 'Page.getLayoutMetrics');
  const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport;
  if (!viewport || args.x >= viewport.clientWidth || args.y >= viewport.clientHeight) fail('POINT_OUTSIDE_VIEWPORT', 'The point is outside the visible tab viewport. Take a fresh screenshot or scroll first.');
  return { x: args.x, y: args.y };
}

export async function clickInteraction(adapter, tabId, args) {
  const button = args.button ?? 'left'; const count = args.clickCount ?? 1;
  if (!Object.hasOwn(buttons, button) || ![1, 2].includes(count)) fail('INVALID_ARGUMENT', 'Use left, right, or middle button and clickCount 1 or 2.');
  const point = await pointerPoint(adapter, tabId, args);
  await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    const pressed = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, buttons: buttons[button], clickCount });
    if (pressed.dialogOpened) return { clicked: true, dialog: pressed.dialog };
    const released = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, buttons: 0, clickCount });
    if (released.dialogOpened) return { clicked: true, dialog: released.dialog };
  }
  return { clicked: true };
}

export async function runInteraction(adapter, tabId, operation, args) {
  if (operation === 'page.hover') {
    const point = await pointerPoint(adapter, tabId, args);
    const result = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    return { hovered: true, ...(result.dialogOpened ? { dialog: result.dialog } : {}) };
  }
  if (operation === 'page.drag') {
    if (!args.from || !args.to || typeof args.from !== 'object' || typeof args.to !== 'object') fail('INVALID_ARGUMENT', 'Provide from and to element targets or viewport points.');
    const from = await pointerPoint(adapter, tabId, { frameId: args.frameId, ...args.from }, false);
    const to = await pointerPoint(adapter, tabId, { frameId: args.frameId, ...args.to }, false);
    // Neither probe scrolls; recheck the source in case page layout changed asynchronously.
    const start = await pointerPoint(adapter, tabId, { frameId: args.frameId, ...args.from }, false);
    if (Math.abs(start.x - from.x) > 1 || Math.abs(start.y - from.y) > 1) fail('DRAG_TARGETS_NOT_VISIBLE', 'Both drag targets must fit in the viewport. Scroll them into view before dragging.');
    const interrupted = result => ({ dragged: false, dialog: result.dialog, message: 'A dialog interrupted dragging; inspect the page after responding.' });
    const moved = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    if (moved.dialogOpened) return interrupted(moved);
    let pressed = false;
    try {
      const down = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
      pressed = true;
      if (down.dialogOpened) return interrupted(down);
      for (let step = 1; step <= 12; step++) {
        const result = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (to.x - start.x) * step / 12, y: start.y + (to.y - start.y) * step / 12, button: 'left', buttons: 1 });
        if (result.dialogOpened) return interrupted(result);
      }
      const released = await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
      return { dragged: true, ...(released.dialogOpened ? { dialog: released.dialog } : {}) };
    } finally {
      if (pressed) await adapter.sendInput(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
    }
  }
  if (operation === 'page.select') {
    if (!Array.isArray(args.values) || args.values.length > 100 || args.values.some(value => typeof value !== 'string' || value.length > 1000)) fail('INVALID_ARGUMENT', 'values must be an array of at most 100 option values.');
    return adapter.call(tabId, args, `function(values) {
      if (!(this instanceof HTMLSelectElement) || !this.isConnected || this.matches(':disabled') || this.closest('[inert]')) throw new Error('Target must be an enabled native select.');
      if (!this.multiple && values.length !== 1) throw new Error('A single-select requires exactly one option value.');
      const wanted = new Set(values); const options = Array.from(this.options);
      for (const value of wanted) if (!options.some(option => option.value === value && !option.disabled && !option.closest('optgroup[disabled]'))) throw new Error('An option is missing or disabled: ' + value);
      this.focus();
      for (const option of options) option.selected = wanted.has(option.value) && !option.disabled && !option.closest('optgroup[disabled]');
      this.dispatchEvent(new Event('input', {bubbles:true,composed:true}));
      this.dispatchEvent(new Event('change', {bubbles:true}));
      return {selected:Array.from(this.selectedOptions).map(option => ({value:option.value,label:option.label}))};
    }`, [args.values]);
  }
  if (operation === 'page.type') {
    if (typeof args.text !== 'string' || args.text.length > 100000) fail('INVALID_ARGUMENT', 'text must contain at most 100000 characters.');
    if (args.ref || args.selector || args.locator) {
      await adapter.call(tabId, args, `function() {
        if (!this.isConnected || this.matches(':disabled') || this.readOnly) throw new Error('This element cannot be edited.');
        for (let node=this;node;node=node.parentElement||node.getRootNode()?.host) if (node.inert) throw new Error('This element is inert.');
        const textInput=this instanceof HTMLInputElement && ['text','search','tel','url','email','password','number'].includes(this.type);
        if (!(textInput || this instanceof HTMLTextAreaElement || this.isContentEditable)) throw new Error('Target must be an editable text control.');
        this.focus();
        let active=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
        if (active!==this && !(this.isContentEditable && this.contains(active))) throw new Error('The requested element did not receive focus.');
        return true;
      }`);
    }
    const result = await adapter.sendInput(tabId, 'Input.insertText', { text: args.text });
    return { typed: true, ...(result.dialogOpened ? { dialog: result.dialog } : {}) };
  }
  if (operation === 'page.history') {
    if (!['back', 'forward', 'reload'].includes(args.direction)) fail('INVALID_ARGUMENT', 'direction must be back, forward, or reload.');
    if (args.frameId) fail('INVALID_ARGUMENT', 'History navigation applies to the whole tab.');
    if (args.direction === 'reload') {
      adapter.invalidate(tabId); await adapter.sendInput(tabId, 'Page.reload'); return { navigating: true };
    }
    const history = await adapter.sendInput(tabId, 'Page.getNavigationHistory');
    const entry = history.entries[history.currentIndex + (args.direction === 'back' ? -1 : 1)];
    if (!entry) return { navigating: false, reason: 'No history entry in that direction.' };
    if (!/^https?:\/\//.test(entry.url)) fail('UNSUPPORTED_URL', 'History entry is not an HTTP or HTTPS page.');
    adapter.invalidate(tabId); await adapter.sendInput(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    return { navigating: true, url: entry.url };
  }
  fail('UNKNOWN_OPERATION', `Unsupported interaction: ${operation}`);
}

export async function captureScreenshot(adapter, tabId, args) {
  const format = args.format ?? 'jpeg';
  if (!['png', 'jpeg'].includes(format)) fail('INVALID_ARGUMENT', 'Screenshot format must be png or jpeg.');
  if (args.frameId) fail('INVALID_ARGUMENT', 'Screenshots capture the whole tab. Coordinates are top-level viewport CSS pixels.');
  if (args.fullPage !== undefined && typeof args.fullPage !== 'boolean') fail('INVALID_ARGUMENT', 'fullPage must be a boolean.');
  const metrics = await adapter.sendInput(tabId, 'Page.getLayoutMetrics');
  const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport;
  const content = metrics.cssContentSize;
  let clip;
  if (args.fullPage) {
    if (!content || content.width * content.height > 16000000 || content.width > 16000 || content.height > 16000) fail('OUTPUT_TOO_LARGE', 'The full page is too large. Use viewport screenshots and scroll.');
    clip = { x: 0, y: 0, width: content.width, height: content.height, scale: 1 };
  }
  const { data } = await adapter.sendInput(tabId, 'Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 80 } : {}), captureBeyondViewport: !!args.fullPage, ...(clip ? { clip } : {}) });
  if (!data || data.length > 6000000) fail('OUTPUT_TOO_LARGE', 'Screenshot exceeds the transport limit. Use a viewport screenshot.');
  const pixels = imageSize(data, format);
  return { mimeType: `image/${format}`, data, coordinateSpace: args.fullPage ? 'top-level document CSS pixels; subtract viewport page offset before clicking' : 'top-level viewport CSS pixels', fullPage: !!args.fullPage, ...(pixels ? { image: pixels } : {}), ...(viewport ? { viewport: { width: viewport.clientWidth, height: viewport.clientHeight, pageX: viewport.pageX, pageY: viewport.pageY, scale: viewport.scale } } : {}), ...(clip ? { page: { width: clip.width, height: clip.height } } : {}) };
}
