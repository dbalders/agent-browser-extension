import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { resolveLocator, semanticQuery, validateLocator } from '../extension/locators.js';

function element(tag, attributes = {}, ...children) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attributes, childNodes: [], isConnected: true,
    hidden: false, inert: false, labels: [], boxes: [{ width: 100, height: 25 }],
    style: { display: 'inline', visibility: 'visible', contentVisibility: 'visible' },
    getAttribute(name) { return this.attributes[name] ?? null; },
    getClientRects() { return this.boxes; },
    getRootNode() { let current = this; while (current.parentNode) current = current.parentNode; return current; },
  };
  for (const child of children) append(node, typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child);
  return node;
}
function append(parent, child) {
  parent.childNodes.push(child); child.parentNode = parent; child.parentElement = parent.nodeType === 1 ? parent : null; return child;
}
function root(...children) {
  const node = { nodeType: 11, childNodes: [], querySelectorAll() {
    const result = []; const walk = item => { for (const child of item.childNodes || []) if (child.nodeType === 1) { result.push(child); walk(child); } };
    walk(this); return result;
  }, getElementById(id) { return this.querySelectorAll('*').find(item => item.getAttribute('id') === id) || null; } };
  for (const child of children) append(node, child);
  return node;
}
function shadow(host, ...children) { const tree = root(...children); tree.host = host; host.shadowRoot = tree; return tree; }
const getComputedStyle = node => node.style;
function query(document, locator, candidate) { return runInNewContext(`(${semanticQuery.toString()})(locator, candidate)`, { document, locator, candidate, getComputedStyle }); }

function transport(document, entries) {
  const calls = []; const objects = new Map(); let nextId = 1;
  const send = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'Accessibility.getFullAXTree') return { nodes: entries.map(({ element: _element, ...node }) => node) };
    if (method === 'DOM.resolveNode') {
      const node = entries.find(item => item.backendDOMNodeId === params.backendNodeId)?.element;
      if (!node) return {};
      const objectId = `object-${nextId++}`; objects.set(objectId, node); return { object: { objectId } };
    }
    if (method === 'Runtime.releaseObject') { objects.delete(params.objectId); return {}; }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: entries.find(item => item.element === objects.get(params.objectId))?.backendDOMNodeId } };
    try {
      if (method === 'Runtime.callFunctionOn') return { result: { value: runInNewContext(`(${params.functionDeclaration}).apply(element, args)`, { element: objects.get(params.objectId), args: params.arguments.map(item => item.value), document, getComputedStyle }) } };
      if (method === 'Runtime.evaluate') {
        const node = runInNewContext(params.expression, { document, getComputedStyle });
        if (!node) return { result: { subtype: 'null' } };
        const objectId = `object-${nextId++}`; objects.set(objectId, node); return { result: { objectId, subtype: 'node' } };
      }
    } catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
    throw new Error(`Unexpected CDP method ${method}`);
  };
  return { send, calls, objects };
}
const ax = (id, element, role = 'button', name = '', extra = {}) => ({ backendDOMNodeId: id, role: { value: role }, name: { value: name }, element, ...extra });

describe('semantic locator validation', () => {
  it('rejects malformed, excessive, unknown, and incomplete criteria', () => {
    for (const locator of [null, [], 'button', {}, { exact: true }, { name: 'Save' }, { role: '' }, { text: '  ' }, { text: 1 }, { role: 'x'.repeat(81) }, { text: 'x'.repeat(2001) }, { text: 'Save', exact: 'yes' }, { text: 'Save', nth: 0 }]) expect(() => validateLocator(locator)).toThrow('locator');
  });
  it('supports combined criteria without constructing CSS selectors', () => {
    const locator = { role: 'button', name: 'Save "draft"', testId: 'id[0]\\"', exact: false };
    expect(validateLocator(locator)).toBe(locator);
  });
});

describe('browser-computed role and accessible name targeting', () => {
  it('uses Chrome names for labelled controls instead of guessing from DOM text', async () => {
    const button = element('button', {}, 'DOM text differs'); const document = root(button);
    const f = transport(document, [ax(7, button, 'button', 'Name computed from hidden aria-labelledby reference')]);
    expect(await resolveLocator(f.send, { role: 'button', name: 'Name computed from hidden aria-labelledby reference' })).toBe(7);
    expect(f.calls[0].method).toBe('Accessibility.getFullAXTree'); expect(f.objects.size).toBe(0);
    await expect(resolveLocator(f.send, { role: 'button', name: 'DOM text differs' })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
  });
  it('defaults to exact normalized case-sensitive names and permits case-insensitive substrings explicitly', async () => {
    const button = element('button'); const f = transport(root(button), [ax(1, button, 'button', 'Save\n  changes')]);
    expect(await resolveLocator(f.send, { role: 'button', name: 'Save changes' })).toBe(1);
    await expect(resolveLocator(f.send, { role: 'button', name: 'save changes' })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
    expect(await resolveLocator(f.send, { role: 'button', name: 'CHANG', exact: false })).toBe(1);
    await expect(resolveLocator(f.send, { role: 'but', name: 'CHANG', exact: false })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
  });
  it('excludes ignored and unrendered duplicates, deduplicates AX nodes, and leaves disabled controls to actionability', async () => {
    const active = element('button'); active.disabled = true;
    const hidden = element('button'); hidden.style.display = 'none';
    const ignored = element('button'); const f = transport(root(active, hidden, ignored), [ax(1, active, 'button', 'Save'), ax(1, active, 'button', 'Save'), ax(2, hidden, 'button', 'Save'), ax(3, ignored, 'button', 'Save', { ignored: true })]);
    expect(await resolveLocator(f.send, { role: 'button', name: 'Save' })).toBe(1); expect(f.objects.size).toBe(0);
  });
  it('fails on ambiguous names and releases remote objects even on failure', async () => {
    const one = element('button'); const two = element('button'); const f = transport(root(one, two), [ax(1, one, 'button', 'Save'), ax(2, two, 'button', 'Save')]);
    await expect(resolveLocator(f.send, { role: 'button', name: 'Save' })).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
    expect(f.objects.size).toBe(0);
  });
  it('ignores non-element AX nodes instead of treating their text nodes as actionable targets', async () => {
    const text = { nodeType: 3, nodeValue: 'Save' }; const button = element('button', {}, text);
    const f = transport(root(button), [ax(1, text, 'StaticText', 'Save')]);
    await expect(resolveLocator(f.send, { role: 'StaticText', name: 'Save' })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
    expect(f.objects.size).toBe(0);
  });
  it('intersects role/name with DOM attributes and composed text', async () => {
    const one = element('button', { 'data-testid': 'save-draft' }, element('span', {}, 'Save draft'));
    const two = element('button', { 'data-testid': 'save-final' }, 'Save final'); const f = transport(root(one, two), [ax(1, one, 'button', 'Save'), ax(2, two, 'button', 'Save')]);
    expect(await resolveLocator(f.send, { role: 'button', name: 'Save', testId: 'save-draft', text: 'Save draft' })).toBe(1);
    await expect(resolveLocator(f.send, { role: 'button', name: 'Save', testId: 'save-draft', text: 'Save final' })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
  });
  it('caps oversized accessibility scans and candidate resolution', async () => {
    await expect(resolveLocator(async () => ({ nodes: Array(30001).fill({}) }), { role: 'button' })).rejects.toMatchObject({ code: 'TARGET_SEARCH_LIMIT' });
    await expect(resolveLocator(async () => ({ nodes: Array.from({ length: 1001 }, (_, index) => ax(index + 1, null)) }), { role: 'button' })).rejects.toMatchObject({ code: 'TARGET_SEARCH_LIMIT' });
  });
});

describe('serialized DOM semantic targeting', () => {
  it('targets the innermost visible text match while retaining ambiguity between independent controls', () => {
    const span = element('span', {}, 'Save'); const button = element('button', {}, span); const document = root(element('main', {}, button));
    expect(query(document, { text: 'Save' })).toBe(span);
    append(document, element('button', {}, 'Save'));
    expect(() => query(document, { text: 'Save' })).toThrow('AMBIGUOUS_TARGET');
  });
  it('matches nested and whitespace-normalized text and explicit substrings', () => {
    const button = element('button', {}, 'Save ', element('span', {}, 'all'), '\n changes'); const document = root(button);
    expect(query(document, { text: 'Save all changes' })).toBe(button);
    expect(query(document, { text: 'save all changes' })).toBeNull();
    expect(query(document, { text: 'ALL CHANGES', exact: false })).toBe(button);
  });
  it('excludes hidden, inert, aria-hidden, disconnected and zero-box matches, including shadow hosts', () => {
    const active = element('button', {}, 'Save'); const document = root(active);
    const hidden = element('button', {}, 'Save'); hidden.hidden = true; append(document, hidden);
    const inert = element('div', {}, element('button', {}, 'Save')); inert.inert = true; append(document, inert);
    append(document, element('div', { 'aria-hidden': 'true' }, element('button', {}, 'Save')));
    const noBox = element('button', {}, 'Save'); noBox.boxes = []; append(document, noBox);
    const detached = element('button', {}, 'Save'); detached.isConnected = false; append(document, detached);
    const host = element('x-widget'); host.style.visibility = 'hidden'; const shadowButton = element('button', {}, 'Save'); shadowButton.style.visibility = 'hidden'; shadow(host, shadowButton); append(document, host);
    expect(query(document, { text: 'Save' })).toBe(active);
  });
  it('supports visible descendants inside display:contents ancestors', () => {
    const button = element('button', {}, 'Save'); const parent = element('div', {}, button); parent.style.display = 'contents'; parent.boxes = [];
    expect(query(root(parent), { text: 'Save' })).toBe(button);
  });
  it('honors a descendant overriding inherited CSS visibility', () => {
    const button = element('button', {}, 'Save'); const parent = element('div', {}, button); parent.style.visibility = 'hidden';
    expect(query(root(parent), { text: 'Save' })).toBe(button);
  });
  it('searches nested open shadow roots and composes slotted text', () => {
    const host = element('x-outer'); const inner = element('x-inner'); const button = element('button', { 'data-testid': 'nested' }, 'Nested action');
    shadow(inner, button); shadow(host, inner); const document = root(host);
    expect(query(document, { testId: 'nested' })).toBe(button);
    expect(query(document, { text: 'Nested action' })).toBe(button);
    const light = element('span', {}, 'Slotted label'); append(host, light);
    const slot = element('slot'); slot.assignedNodes = () => [light]; light.assignedSlot = slot;
    inner.shadowRoot.childNodes = []; append(inner.shadowRoot, slot);
    expect(query(document, { text: 'Slotted label' })).toBe(light);
  });
  it('supports native labels and aria-labelledby references scoped to their shadow root, including hidden references', () => {
    const nativeLabel = element('label', {}, 'Email ', element('strong', {}, 'address'));
    const input = element('input'); input.labels = [nativeLabel]; const document = root(nativeLabel, input);
    expect(query(document, { label: 'Email address' })).toBe(input);
    const host = element('x-form'); append(document, host);
    const first = element('span', { id: 'first' }, 'Delivery'); first.hidden = true;
    const last = element('span', { id: 'last' }, 'address'); const field = element('input', { 'aria-labelledby': 'first last', 'aria-label': 'Wrong fallback' });
    shadow(host, first, last, field);
    append(document, element('span', { id: 'first' }, 'Wrong outer label'));
    expect(query(document, { label: 'Delivery address' })).toBe(field);
    expect(query(document, { label: 'Wrong fallback' })).toBeNull();
  });
  it('matches aria-label and falls back when aria-labelledby has no valid references', () => {
    const input = element('input', { 'aria-labelledby': 'missing', 'aria-label': 'Email address' }); const document = root(input);
    expect(query(document, { label: 'Email address' })).toBe(input);
    expect(query(document, { label: 'ADDRESS', exact: false })).toBe(input);
  });
  it('matches wrapping select labels in open shadow roots without including option text', () => {
    const select = element('select', { 'data-testid': 'color' }, element('option', {}, 'Amber'), element('option', {}, 'Teal'), element('option', {}, 'Violet'));
    select.value = 'Teal';
    const label = element('label', {}, 'Preferred ', element('strong', {}, 'color'), select);
    select.labels = [label]; const host = element('x-preferences'); shadow(host, label); const document = root(host);
    expect(query(document, { label: 'Preferred color' })).toBe(select);
    expect(query(document, { label: 'COLOR', exact: false })).toBe(select);
    expect(query(document, { label: 'Preferred color AmberTealViolet' })).toBeNull();
    // The label-only exclusion must not change text filters on the control.
    expect(query(document, { label: 'Preferred color', text: 'AmberTealViolet' })).toBe(select);
    expect(query(document, { testId: 'color', text: 'AmberTealViolet' })).toBe(select);
  });
  it('omits textarea contents and current native input values while retaining surrounding label text', () => {
    const textarea = element('textarea', { 'data-testid': 'description' }, 'Initial draft contents'); textarea.value = 'Current private draft';
    const description = element('label', {}, 'Description ', element('span', {}, textarea), ' ', element('em', {}, '(optional)'));
    textarea.labels = [description];
    const input = element('input'); input.type = 'text'; input.value = 'Current input value';
    const name = element('label', {}, 'Display name ', input); input.labels = [name];
    const submit = element('input'); submit.type = 'submit'; submit.value = 'Send now';
    const action = element('label', {}, 'Action ', submit); submit.labels = [action];
    const document = root(description, name, action);
    expect(query(document, { label: 'Description (optional)' })).toBe(textarea);
    expect(query(document, { label: 'Display name' })).toBe(input);
    expect(query(document, { label: 'Action' })).toBe(submit);
    expect(query(document, { label: 'Description Initial draft contents (optional)' })).toBeNull();
    expect(query(document, { label: 'Action Send now' })).toBeNull();
    expect(query(document, { label: 'Description (optional)', text: 'Initial draft contents' })).toBe(textarea);
    expect(query(document, { label: 'Action', text: 'Send now' })).toBe(submit);
  });
  it('compares placeholder/test ID values literally without CSS escaping or script interpretation', async () => {
    const literal = 'a["\\] ` ${globalThis.hacked = true}';
    const input = element('input', { placeholder: literal, 'data-testid': literal }); const document = root(input);
    expect(query(document, { placeholder: literal, testId: literal })).toBe(input);
    const f = transport(document, [ax(15, input, 'textbox')]);
    expect(await resolveLocator(f.send, { placeholder: literal, testId: literal })).toBe(15); expect(f.objects.size).toBe(0);
  });
  it('never reads text from frame documents and requires a unique element in the selected document', () => {
    const embedded = element('button', {}, 'Frame action'); const frame = element('iframe'); frame.contentDocument = root(embedded);
    expect(query(root(frame), { text: 'Frame action' })).toBeNull();
    expect(query(frame.contentDocument, { text: 'Frame action' })).toBe(embedded);
  });
  it('returns clear errors for missing and ambiguous DOM matches', async () => {
    const one = element('input', { placeholder: 'Email' }); const two = element('input', { placeholder: 'Email' }); const f = transport(root(one, two), [ax(1, one), ax(2, two)]);
    await expect(resolveLocator(f.send, { placeholder: 'Email' })).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
    await expect(resolveLocator(f.send, { testId: 'missing' })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
    expect(f.objects.size).toBe(0);
  });
  it('bounds large DOM and shadow-root scans instead of silently returning a partial match', () => {
    const button = element('button', { 'data-testid': 'action' }); const document = { querySelectorAll: () => Array(30001).fill(button) };
    expect(() => query(document, { testId: 'action' })).toThrow('TARGET_SEARCH_LIMIT');
    const hosts = Array.from({ length: 256 }, () => { const host = element('x-widget'); shadow(host); return host; });
    expect(() => query(root(...hosts), { testId: 'missing' })).toThrow('TARGET_SEARCH_LIMIT');
  });
});
