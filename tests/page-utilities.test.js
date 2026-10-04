import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { BrowserFault } from '../extension/controller.js';
import { readPage, waitForPage, checkControl, emulatePage } from '../extension/page-utilities.js';

afterEach(() => vi.useRealTimers());

class Element {
  constructor(tagName = 'DIV') {
    Object.assign(this, { tagName, nodeType: 1, childNodes: [], attributes: {}, style: { display: 'block', visibility: 'visible' }, isConnected: true, value: '', type: '' });
  }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') child = { nodeType: 3, textContent: child };
      child.parentElement = this; this.childNodes.push(child);
    }
    return this;
  }
  matches() { return !!this.disabled; }
  hasAttribute(name) { return name in this.attributes; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getRootNode() { return this.parentElement ? this.parentElement.getRootNode() : this; }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
}
class Input extends Element { constructor() { super('INPUT'); } }
class Textarea extends Element { constructor() { super('TEXTAREA'); } }
class Select extends Element { constructor() { super('SELECT'); this.options = []; } }
class Anchor extends Element { constructor() { super('A'); this.href = ''; } }

function readFixture(root, properties = {}) {
  const environment = {
    document: { body: root, title: properties.title || '' }, location: { href: properties.url || 'https://example.test/' },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 },
    HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLSelectElement: Select, HTMLAnchorElement: Anchor,
    TextEncoder, getComputedStyle: node => node.style,
  };
  return {
    send: vi.fn(async (_tabId, _method, args) => ({ result: { value: runInNewContext(args.expression, environment) } })),
    call: vi.fn(async (_tabId, _args, functionDeclaration, values) => runInNewContext(`(${functionDeclaration}).apply(target, values)`, { ...environment, target: root, values })),
  };
}

function waitFixture() {
  const page = { ready: 'complete', url: 'https://example.test/current' };
  const scope = { frameId: 'main', mainFrameId: 'main' };
  const tab = {};
  const content = { text: 'Finished', truncated: false };
  const adapter = {
    scopes: new Map(), chrome: { tabs: { get: vi.fn(async () => tab) } }, frames: { select: vi.fn(async () => scope) },
    send: vi.fn(async (_id, _method, args) => ({ result: { value: args.expression.includes('ready:document.readyState') ? page : content } })),
    call: vi.fn(async () => ({ attached: true, visible: true, enabled: true })),
  };
  return { adapter, page, scope, tab, content };
}

describe('bounded content reads', () => {
  it('extracts composed text and live field state while excluding script and password data', async () => {
    const root = new Element().append('Visible', new Element('SCRIPT').append('secret script'));
    const hidden = new Element().append('hidden'); hidden.style.display = 'none'; root.append(hidden);
    const host = new Element('CUSTOM-FIELD'); host.shadowRoot = { nodeType: 11, childNodes: [{ nodeType: 3, textContent: 'Shadow content' }] }; root.append(host);
    expect(await readPage(readFixture(root), 1, {})).toMatchObject({ text: 'Visible Shadow content', truncated: false });
    const password = new Input(); password.type = 'password'; password.value = 'private field value';
    const result = await readPage(readFixture(password), 1, { selector: '#password' });
    expect(result).toMatchObject({ valueOmitted: true }); expect(result.value).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private field value');
    const field = new Input(); field.value = 'current value';
    expect(await readPage(readFixture(field), 1, { selector: '#input', maxLength: 7 })).toMatchObject({ value: 'current', truncated: true });
  });

  it('bounds full document Unicode text and URL/title metadata by actual JSON bytes', async () => {
    const root = new Element().append('界'.repeat(60000));
    const result = await readPage(readFixture(root, { title: '😀'.repeat(300), url: `https://example.test/${'界'.repeat(8200)}` }), 1, { maxLength: 60000 });
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(75000);
    expect(result.truncated).toBe(true); expect(result.text.length).toBeLessThanOrEqual(60000);
    expect(result.title.length).toBeLessThanOrEqual(300); expect(result.url.length).toBeLessThanOrEqual(8192);
  });

  it('budgets combined select options, value and aria properties even with maxLength one', async () => {
    const root = new Select(); root.value = 'choice'; root.attributes['aria-expanded'] = 'x'.repeat(10000);
    root.options = Array.from({ length: 120 }, () => ({ value: '界'.repeat(1000), label: '😀'.repeat(1000), selected: false, disabled: false, closest: () => null }));
    const result = await readPage(readFixture(root), 1, { selector: 'select', maxLength: 1 });
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(75000);
    expect(result.options).toHaveLength(100); expect(result.value.length).toBeLessThanOrEqual(1);
    expect(result.truncated).toBe(true); expect(result['aria-expanded'].length).toBeLessThanOrEqual(300);
    expect(result.options.every(option => typeof option.selected === 'boolean' && typeof option.disabled === 'boolean')).toBe(true);
  });

  it('accounts for JSON escaping and rejects unbounded or malformed read budgets', async () => {
    const field = new Input(); field.value = '\u0000'.repeat(60000);
    const result = await readPage(readFixture(field), 1, { selector: 'input', maxLength: 60000 });
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(75000);
    expect(result.truncated).toBe(true);
    for (const maxLength of [0, 60001, Infinity, '10', 1.5]) await expect(readPage(readFixture(field), 1, { maxLength })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('page and element waits', () => {
  it('waits for pending top-document navigation before accepting complete state', async () => {
    vi.useFakeTimers();
    const f = waitFixture(); f.tab.pendingUrl = 'https://example.test/new';
    let complete = false;
    const waiting = waitForPage(f.adapter, 1, { loadState: 'load', timeoutMs: 1000 }, () => {}).then(value => { complete = true; return value; });
    await vi.advanceTimersByTimeAsync(0); expect(complete).toBe(false);
    delete f.tab.pendingUrl; f.page.url = 'https://example.test/new';
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toEqual({ ready: true, url: 'https://example.test/new' });
  });

  it('allows a ready child frame and preserves the original readiness response shape', async () => {
    const f = waitFixture(); f.scope.frameId = 'child'; f.tab.pendingUrl = 'https://example.test/top';
    expect(await waitForPage(f.adapter, 1, { frameId: 'child' }, () => {})).toEqual({ ready: true, url: f.page.url });
    expect(await waitForPage(f.adapter, 1, { frameId: 'child', text: 'Finished' }, () => {})).toEqual({ matched: true, url: f.page.url });
  });

  it('rejects states that cannot be observed without a target or through visible-only locators', async () => {
    const f = waitFixture();
    for (const state of ['attached', 'detached', 'enabled', 'disabled']) await expect(waitForPage(f.adapter, 1, { state }, () => {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    for (const state of ['attached', 'detached']) await expect(waitForPage(f.adapter, 1, { state, locator: { text: 'Save' } }, () => {})).rejects.toThrow('CSS selector');
    expect(f.adapter.frames.select).not.toHaveBeenCalled();
  });

  it('accepts a missing selector as detached, and never proves text absence from a truncated read', async () => {
    const f = waitFixture();
    f.adapter.call.mockRejectedValue(new BrowserFault('ELEMENT_NOT_FOUND', 'Missing selector'));
    expect(await waitForPage(f.adapter, 1, { selector: '#gone', state: 'detached' }, () => {})).toMatchObject({ matched: true });
    f.content.truncated = true;
    await expect(waitForPage(f.adapter, 1, { text: 'outside the observed prefix', state: 'hidden' }, () => {})).rejects.toMatchObject({ code: 'WAIT_CONTENT_TRUNCATED' });
    expect(await waitForPage(f.adapter, 1, { text: 'Finished' }, () => {})).toMatchObject({ matched: true });
  });

  it('rechecks cancellation before reporting a successful observation', async () => {
    const f = waitFixture(); let stopped = false;
    f.adapter.chrome.tabs.get.mockImplementation(async () => { stopped = true; return {}; });
    await expect(waitForPage(f.adapter, 1, {}, () => { if (stopped) throw new BrowserFault('SESSION_STOPPED', 'Stopped'); })).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
  });
});

describe('checked controls', () => {
  it('does not toggle an already-correct value and verifies a changed value without replaying clicks', async () => {
    const adapter = { call: vi.fn().mockResolvedValue({ checked: true, radio: false }), click: vi.fn().mockResolvedValue({ clicked: true }) };
    expect(await checkControl(adapter, 1, { selector: 'input', checked: true })).toEqual({ checked: true, changed: false });
    expect(adapter.click).not.toHaveBeenCalled();
    adapter.call.mockResolvedValueOnce({ checked: false, radio: false }).mockResolvedValueOnce({ checked: true, radio: false });
    expect(await checkControl(adapter, 1, { selector: 'input', checked: true })).toEqual({ checked: true, changed: true });
    expect(adapter.click).toHaveBeenCalledTimes(1);
    adapter.call.mockResolvedValue({ checked: false, radio: false });
    await expect(checkControl(adapter, 1, { selector: 'input', checked: true })).rejects.toMatchObject({ code: 'STATE_NOT_CHANGED' });
    expect(adapter.click).toHaveBeenCalledTimes(2);
  });

  it('does not clear a selected radio or continue reading while a dialog blocks the page', async () => {
    const adapter = { call: vi.fn().mockResolvedValue({ checked: true, radio: true }), click: vi.fn() };
    await expect(checkControl(adapter, 1, { selector: 'input', checked: false })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(adapter.click).not.toHaveBeenCalled();
    adapter.call.mockClear().mockResolvedValue({ checked: false, radio: false });
    adapter.click.mockResolvedValue({ dialog: { type: 'confirm', message: 'Continue?' } });
    expect(await checkControl(adapter, 1, { selector: 'input', checked: true })).toMatchObject({ pending: true, dialog: { type: 'confirm' } });
    expect(adapter.call).toHaveBeenCalledTimes(1);
  });
});

describe('viewport and media emulation', () => {
  function fixture() { return { emulations: new Map(), sendInput: vi.fn(async () => ({})), invalidate: vi.fn() }; }

  it('preserves media preferences between updates and resets metrics and media together', async () => {
    const adapter = fixture();
    await emulatePage(adapter, 1, { viewport: { width: 800, height: 600 }, colorScheme: 'dark' });
    expect(adapter.sendInput).toHaveBeenCalledWith(1, 'Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await emulatePage(adapter, 1, { reducedMotion: 'reduce' });
    expect(adapter.sendInput).toHaveBeenLastCalledWith(1, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await emulatePage(adapter, 1, { reset: true })).toEqual({ emulated: {}, restored: true });
    expect(adapter.sendInput).toHaveBeenCalledWith(1, 'Emulation.clearDeviceMetricsOverride');
    expect(adapter.sendInput).toHaveBeenLastCalledWith(1, 'Emulation.setEmulatedMedia', { features: [] });
  });

  it('requires reset after a partial failure and retains bookkeeping for cleanup', async () => {
    const adapter = fixture();
    adapter.sendInput.mockResolvedValueOnce({}).mockRejectedValueOnce(new BrowserFault('CDP_TIMEOUT', 'Unknown completion'));
    await expect(emulatePage(adapter, 1, { viewport: { width: 800, height: 600 }, colorScheme: 'dark' })).rejects.toMatchObject({ code: 'CDP_TIMEOUT' });
    expect(adapter.emulations.get(1)).toMatchObject({ viewport: { width: 800 }, uncertain: true });
    await expect(emulatePage(adapter, 1, { reducedMotion: 'reduce' })).rejects.toMatchObject({ code: 'EMULATION_UNCERTAIN' });
    expect(adapter.sendInput).toHaveBeenCalledTimes(2);
    await expect(emulatePage(adapter, 1, { reset: true })).resolves.toEqual({ emulated: {}, restored: true });
    expect(adapter.emulations.get(1)).toEqual({});
  });

  it('does not revive emulation state if detach clears it during a pending command', async () => {
    const adapter = fixture(); adapter.sendInput.mockImplementation(async () => { adapter.emulations.delete(1); return {}; });
    await expect(emulatePage(adapter, 1, { colorScheme: 'dark' })).rejects.toMatchObject({ code: 'EMULATION_CANCELED' });
    expect(adapter.emulations.has(1)).toBe(false);
  });

  it('rejects invalid and excessive viewport requests before making browser changes', async () => {
    const adapter = fixture();
    for (const args of [{}, { reset: true, colorScheme: 'dark' }, { colorScheme: 'blue' }, { viewport: { width: 1, height: 600 } }, { viewport: { width: 3840, height: 3840, deviceScaleFactor: 3 } }, { viewport: { width: 800, height: 600, surprise: true } }, { viewport: { width: '800', height: 600 } }]) await expect(emulatePage(adapter, 1, args)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(adapter.sendInput).not.toHaveBeenCalled(); expect(adapter.emulations.size).toBe(0);
  });
});
