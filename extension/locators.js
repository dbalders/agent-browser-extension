import { BrowserFault } from './controller.js';

const criteria = ['role', 'name', 'text', 'label', 'placeholder', 'testId'];
const fail = (code, message) => { throw new BrowserFault(code, message); };
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const matches = (actual, expected, exact) => exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());

export function validateLocator(locator) {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) fail('INVALID_ARGUMENT', 'locator must be an object.');
  if (Object.keys(locator).some(key => ![...criteria, 'exact'].includes(key))) fail('INVALID_ARGUMENT', 'Unknown locator property.');
  if (!criteria.some(key => locator[key] !== undefined)) fail('INVALID_ARGUMENT', 'Provide at least one locator criterion.');
  for (const key of criteria) if (locator[key] !== undefined && (typeof locator[key] !== 'string' || !normalize(locator[key]) || locator[key].length > (key === 'role' ? 80 : 2000))) fail('INVALID_ARGUMENT', `locator.${key} must be a nonempty string of at most ${key === 'role' ? 80 : 2000} characters.`);
  if (locator.exact !== undefined && typeof locator.exact !== 'boolean') fail('INVALID_ARGUMENT', 'locator.exact must be a boolean.');
  if (locator.name !== undefined && locator.role === undefined) fail('INVALID_ARGUMENT', 'locator.name requires a role; use text to match visible text.');
  return locator;
}

function evaluationValue(result) {
  if (!result.exceptionDetails) return result.result;
  const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '';
  const code = ['AMBIGUOUS_TARGET', 'TARGET_SEARCH_LIMIT', 'INVALID_ARGUMENT'].find(value => message.includes(value)) || 'ELEMENT_ACTION_FAILED';
  fail(code, message.slice(0, 500));
}

// send is already scoped to the chosen frame/debugger session. Chrome computes
// roles and accessible names; we deliberately do not recreate the AccName spec.
export async function resolveLocator(send, input) {
  const locator = validateLocator(input);
  if (locator.role !== undefined) {
    const { nodes = [] } = await send('Accessibility.getFullAXTree', {});
    if (nodes.length > 30000) fail('TARGET_SEARCH_LIMIT', 'The accessibility tree is too large. Use a snapshot reference or CSS selector.');
    const ids = new Set();
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId || normalize(node.role?.value).toLowerCase() !== normalize(locator.role).toLowerCase()) continue;
      if (locator.name !== undefined && !matches(node.name?.value, locator.name, locator.exact !== false)) continue;
      ids.add(node.backendDOMNodeId);
    }
    if (ids.size > 1000) fail('TARGET_SEARCH_LIMIT', 'Too many role matches. Add an accessible name or use a snapshot reference.');
    let found;
    for (const backendNodeId of ids) {
      const { object } = await send('DOM.resolveNode', { backendNodeId });
      if (!object?.objectId) continue;
      try {
        const result = await send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function(locator) { return (${semanticQuery.toString()})(locator, this); }`,
          arguments: [{ value: locator }], returnByValue: true,
        });
        if (evaluationValue(result)?.value !== true) continue;
        if (found !== undefined) fail('AMBIGUOUS_TARGET', 'More than one visible element matches the locator. Add a criterion or use a snapshot reference.');
        found = backendNodeId;
      } finally { await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
    }
    if (found !== undefined) return found;
  } else {
    const result = await send('Runtime.evaluate', {
      expression: `(${semanticQuery.toString()})(${JSON.stringify(locator)})`, returnByValue: false, timeout: 2000,
    });
    const object = evaluationValue(result);
    if (object?.objectId && object.subtype !== 'null') {
      try {
        const { node } = await send('DOM.describeNode', { objectId: object.objectId });
        if (node?.backendNodeId) return node.backendNodeId;
      } finally { await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
    }
  }
  fail('ELEMENT_NOT_FOUND', 'No visible element matches the locator in the selected frame or its open shadow roots.');
}

// This function is serialized into the selected frame. It uses no outside
// bindings. With candidate it filters one AX node; otherwise it returns a unique
// DOM match. Text/label matching is intentionally a DOM convenience, not a second
// accessible-name implementation. Prefer role + name for Chrome's computed name.
export function semanticQuery(locator, candidate) {
  const normalized = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const match = (actual, expected) => locator.exact !== false ? normalized(actual) === normalized(expected) : normalized(actual).toLowerCase().includes(normalized(expected).toLowerCase());
  let work = 0;
  const charge = () => { if (++work > 120000) throw new Error('TARGET_SEARCH_LIMIT: The page is too complex. Use a snapshot reference.'); };
  const parent = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host;
  const visibility = new Map(); const texts = [new Map(), new Map()];
  const visible = node => {
    // Visibility is inherited but can be overridden by a descendant. Check the
    // candidate's computed value separately from ancestor subtree suppression.
    if (['hidden', 'collapse'].includes(getComputedStyle(node).visibility)) return false;
    if (visibility.has(node)) return visibility.get(node);
    const ancestors = []; let result = true;
    for (let current = node; current; current = parent(current)) {
      charge();
      if (visibility.has(current)) { result = visibility.get(current); break; }
      ancestors.push(current);
      const style = getComputedStyle(current);
      if (!current.isConnected || current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.contentVisibility === 'hidden') { result = false; break; }
    }
    // Only cache ancestor CSS visibility here. A display:contents ancestor can
    // have no box even when its descendants are visible and actionable.
    for (const ancestor of ancestors) visibility.set(ancestor, result);
    return result;
  };
  const rendered = node => visible(node) && [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
  const text = (node, includeHidden = false, depth = 0, excludedNode, cache = texts[includeHidden ? 1 : 0]) => {
    if (node === excludedNode) return '';
    if (cache.has(node)) return cache.get(node);
    charge();
    if (depth > 512) throw new Error('TARGET_SEARCH_LIMIT: The page is nested too deeply. Use a snapshot reference.');
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    if (node.nodeType === 1 && (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(node.tagName) || (!includeHidden && !visible(node)))) return '';
    if (node.tagName === 'BR') return ' ';
    if (node.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(node.type)) return node.value || '';
    let children = node.shadowRoot?.childNodes || node.childNodes;
    if (node.tagName === 'SLOT') { const assigned = node.assignedNodes({ flatten: true }); if (assigned.length) children = assigned; }
    let value = '';
    for (const child of children || []) {
      const content = text(child, includeHidden, depth + 1, excludedNode, cache);
      const block = child.nodeType === 1 && /^(block|flex|grid|list-item|table)/.test(getComputedStyle(child).display);
      value += block ? ` ${content} ` : content;
    }
    cache.set(node, value); return value;
  };
  const label = node => {
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = node.getRootNode(); const references = labelledBy.trim().split(/\s+/).map(id => root.getElementById?.(id)).filter(Boolean);
      if (references.length) return references.map(reference => text(reference, true)).join(' ');
    }
    const ariaLabel = node.getAttribute('aria-label');
    if (ariaLabel !== null && normalized(ariaLabel)) return ariaLabel;
    // A wrapping native label describes its control; the control's option text,
    // textarea contents or button value are not part of that label. Keep this
    // traversal separate from ordinary text and aria-labelledby caches.
    const labels = [...(node.labels || [])]; const nativeTexts = new Map();
    return labels.map(item => text(item, true, 0, node, nativeTexts)).join(' ');
  };
  const accept = node => {
    if (node?.nodeType !== 1) return false;
    if (!rendered(node)) return false;
    if (locator.testId !== undefined && !match(node.getAttribute('data-testid'), locator.testId)) return false;
    if (locator.placeholder !== undefined && !match(node.getAttribute('placeholder'), locator.placeholder)) return false;
    if (locator.label !== undefined && !match(label(node), locator.label)) return false;
    if (locator.text !== undefined && !match(text(node), locator.text)) return false;
    return true;
  };
  if (candidate) return accept(candidate);
  const roots = [document]; const found = new Set(); let visited = 0;
  for (let index = 0; index < roots.length; index++) {
    if (index >= 256) throw new Error('TARGET_SEARCH_LIMIT: Too many open shadow roots. Use a snapshot reference.');
    for (const node of roots[index].querySelectorAll('*')) {
      if (++visited > 30000) throw new Error('TARGET_SEARCH_LIMIT: The page is too large. Use a snapshot reference.');
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (accept(node)) found.add(node);
    }
  }
  // A text-only search resolves the innermost matching element rather than also
  // treating each matching wrapper as a separate target.
  if (locator.text !== undefined && !['label', 'placeholder', 'testId'].some(key => locator[key] !== undefined)) {
    for (const node of [...found]) for (let ancestor = parent(node); ancestor; ancestor = parent(ancestor)) { charge(); found.delete(ancestor); }
  }
  if (found.size > 1) throw new Error('AMBIGUOUS_TARGET: More than one visible element matches. Add a criterion or use a snapshot reference.');
  return found.values().next().value || null;
}
