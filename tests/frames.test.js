import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { FrameRouter, framePoint, pointerProbe, shadowQuery } from '../extension/frame-router.js';
import { PageAdapter } from '../extension/pages.js';

const frame = (id, parentId, url = `https://${id}.test/`) => ({ id, parentId, url, loaderId: `loader-${id}` });
const tree = (item, ...children) => ({ frame: item, ...(children.length ? { childFrames: children } : {}) });

function routerFixture() {
  const trees = new Map([['', tree(frame('main'), tree(frame('same', 'main')))]]);
  const commands = []; const failures = new Set(); let onAutoAttach = () => {};
  const send = vi.fn(async (target, method, params = {}) => {
    commands.push({ target, method, params });
    if (failures.has(target.sessionId || '')) throw new Error('Temporary target swap');
    if (method === 'Target.setAutoAttach') onAutoAttach(target);
    if (method === 'Page.getFrameTree') return { frameTree: trees.get(target.sessionId || '') };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 70 };
    return {};
  });
  const router = new FrameRouter(send);
  return { router, send, commands, trees, failures, autoAttach(fn) { onAutoAttach = fn; },
    context(frameId, id, sessionId) { router.event({ tabId: 1, ...(sessionId ? { sessionId } : {}) }, 'Runtime.executionContextCreated', { context: { id, auxData: { isDefault: true, frameId } } }); },
    attach(sessionId, sourceSessionId) { router.event({ tabId: 1, ...(sourceSessionId ? { sessionId: sourceSessionId } : {}) }, 'Target.attachedToTarget', { sessionId, targetInfo: { type: 'iframe' } }); },
  };
}

describe('frame discovery and debugger routing', () => {
  it('routes same-process children through their own default context and never the main world', async () => {
    const f = routerFixture(); await f.router.enable(1); f.context('same', 22);
    expect(await f.router.select(1, 'same')).toMatchObject({ frameId: 'same', target: { tabId: 1 }, executionContextId: 22 });
    expect(await f.router.list(1)).toMatchObject({ frames: [{ frameId: 'main', mainFrame: true }, { frameId: 'same', parentFrameId: 'main', mainFrame: false }] });
    expect(f.commands.some(command => command.method === 'Page.createIsolatedWorld')).toBe(false);
  });

  it('creates a frame-specific isolated world if Chrome did not expose its default context', async () => {
    const f = routerFixture(); await f.router.enable(1);
    expect(await f.router.select(1, 'same')).toMatchObject({ target: { tabId: 1 }, executionContextId: 70 });
    expect(f.commands.find(command => command.method === 'Page.createIsolatedWorld')).toMatchObject({ target: { tabId: 1 }, params: { frameId: 'same' } });
    await f.router.select(1, 'same');
    expect(f.commands.filter(command => command.method === 'Page.createIsolatedWorld')).toHaveLength(1);
    f.router.event({ tabId: 1 }, 'Runtime.executionContextDestroyed', { executionContextId: 70 });
    f.send.mockImplementation(async (_target, method) => method === 'Page.getFrameTree' ? { frameTree: f.trees.get('') } : {});
    await expect(f.router.select(1, 'same')).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
  });

  it('recursively attaches cross-site child targets using flat Chrome debugger sessions', async () => {
    const f = routerFixture();
    f.trees.set('', tree(frame('main'), tree(frame('remote', 'main'))));
    f.trees.set('remote-session', tree(frame('remote', 'main'), tree(frame('nested', 'remote'))));
    f.trees.set('nested-session', tree(frame('nested', 'remote')));
    f.autoAttach(target => {
      if (!target.sessionId) f.attach('remote-session');
      if (target.sessionId === 'remote-session') f.attach('nested-session', 'remote-session');
    });
    await f.router.enable(1); f.context('remote', 31, 'remote-session'); f.context('nested', 42, 'nested-session');
    expect(await f.router.select(1, 'remote')).toMatchObject({ target: { tabId: 1, sessionId: 'remote-session' }, executionContextId: 31 });
    expect(await f.router.select(1, 'nested')).toMatchObject({ target: { tabId: 1, sessionId: 'nested-session' }, executionContextId: 42, parentFrameId: 'remote' });
    expect(f.commands.filter(command => command.method === 'Target.setAutoAttach').map(command => command.target.sessionId)).toEqual([undefined, 'remote-session', 'nested-session']);
    f.router.event({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'remote-session' });
    expect([...f.router.tabs.get(1).sessions.keys()]).toEqual(['']);
    expect(f.router.tabs.get(1).contexts.size).toBe(0);
  });

  it('prunes detached frames and old execution contexts even when an event was missed', async () => {
    const f = routerFixture(); await f.router.enable(1); f.context('same', 22);
    f.trees.set('', tree(frame('main')));
    await expect(f.router.select(1, 'same')).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND' });
    expect(f.router.tabs.get(1).contexts.has('same')).toBe(false);
    f.trees.set('', tree(frame('main'), tree(frame('same', 'main')))); f.context('same', 22);
    await f.router.select(1, 'same');
    f.trees.get('').childFrames[0].frame.loaderId = 'new-document';
    expect(await f.router.select(1, 'same')).toMatchObject({ executionContextId: 70 });
  });

  it('recovers a child target after a transient initialization failure', async () => {
    const f = routerFixture(); await f.router.enable(1);
    f.trees.set('remote-session', tree(frame('remote', 'main'))); f.failures.add('remote-session'); f.attach('remote-session');
    await f.router.list(1);
    f.failures.delete('remote-session'); f.context('remote', 31, 'remote-session');
    expect(await f.router.select(1, 'remote')).toMatchObject({ target: { tabId: 1, sessionId: 'remote-session' }, executionContextId: 31 });
  });

  it('does not target restricted documents or revive a detached tab', async () => {
    const f = routerFixture(); await f.router.enable(1);
    f.trees.set('', tree(frame('main'), tree(frame('restricted', 'main', 'chrome://settings/'))));
    expect((await f.router.list(1)).frames.find(item => item.frameId === 'restricted')).toMatchObject({ available: false });
    await expect(f.router.select(1, 'restricted')).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
    f.router.clear(1);
    await expect(f.router.select(1)).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
  });

  it('translates a nested cross-site point through each parent document and releases temporary objects', async () => {
    const f = routerFixture();
    f.trees.set('', tree(frame('main'), tree(frame('remote', 'main'))));
    f.trees.set('remote-session', tree(frame('remote', 'main'), tree(frame('nested', 'remote'))));
    await f.router.enable(1); f.attach('remote-session'); f.context('remote', 31, 'remote-session'); f.context('nested', 42, 'remote-session');
    const original = f.send.getMockImplementation();
    f.send.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate') return { result: { value: { width: 200, height: 100 } } };
      if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId === 'nested' ? 101 : 102 };
      if (method === 'DOM.resolveNode') return { object: { objectId: `owner-${params.backendNodeId}` } };
      if (method === 'Runtime.callFunctionOn') {
        const point = params.arguments[0].value;
        return { result: { value: { ok: true, x: point.x * .5 + 100, y: point.y * .5 + 80 } } };
      }
      return original(target, method, params);
    });
    const selected = await f.router.select(1, 'nested');
    expect(await f.router.rootPoint(1, selected, { x: 40, y: 20 })).toEqual({ x: 160, y: 125 });
    const owners = f.send.mock.calls.filter(call => call[1] === 'DOM.getFrameOwner');
    expect(owners.map(call => [call[0], call[2].frameId])).toEqual([[{ tabId: 1, sessionId: 'remote-session' }, 'nested'], [{ tabId: 1 }, 'remote']]);
    expect(f.send.mock.calls.filter(call => call[1] === 'Runtime.releaseObject').map(call => call[2].objectId)).toEqual(['owner-101', 'owner-102']);
  });
});

function pageFixture() {
  const calls = []; let childLoader = 'child-loader';
  const chrome = {
    tabs: { get: async () => ({ id: 1, title: 'Top page', url: 'https://main.test/' }) },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: vi.fn(async (target, method, params = {}) => {
      calls.push({ target, method, params });
      if (method === 'Page.getFrameTree') return { frameTree: tree(frame('main'), tree({ ...frame('child', 'main'), loaderId: childLoader })) };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 23 };
      if (method === 'Runtime.evaluate') return { result: { value: { ready: 'complete', url: 'https://child.test/' } } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: params.frameId === 'child' ? 'Child action' : 'Root action' }, backendDOMNodeId: params.frameId === 'child' ? 50 : 60 }] };
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true, x: 20, y: 30 } } };
      return {};
    }) },
  };
  const pages = new PageAdapter(chrome);
  return { pages, calls, chrome, async attach() { await pages.attach(1); pages.event({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 22, auxData: { isDefault: true, frameId: 'child' } } }); }, changeLoader() { childLoader = 'changed-loader'; } };
}

describe('frame-scoped observations and actions', () => {
  it('scopes snapshot and evaluation to the requested child while keeping root observations', async () => {
    const f = pageFixture(); await f.attach();
    const main = await f.pages.execute(1, 'page.snapshot', {});
    const child = await f.pages.execute(1, 'page.snapshot', { frameId: 'child' });
    expect(child).toMatchObject({ frameId: 'child', refs: [{ name: 'Child action' }] });
    expect(f.pages.referenceSnapshot(1, main.refs[0].ref)).toMatchObject({ frameId: 'main' });
    expect(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').at(-1)).toMatchObject({ target: { tabId: 1 }, params: { frameId: 'child' } });
    await f.pages.execute(1, 'page.evaluate', { frameId: 'child', expression: 'document.title' });
    expect(f.calls.filter(call => call.method === 'Runtime.evaluate').at(-1).params.contextId).toBe(22);
  });

  it('infers frame from an element ref and sends mouse input only to the root tab', async () => {
    const f = pageFixture(); await f.attach();
    const child = await f.pages.execute(1, 'page.snapshot', { frameId: 'child' });
    f.pages.frames.rootPoint = vi.fn(async (_tabId, scope, point) => { expect(scope.frameId).toBe('child'); return { x: point.x + 100, y: point.y + 200 }; });
    await f.pages.execute(1, 'page.click', { ref: child.refs[0].ref });
    expect(f.calls.find(call => call.method === 'DOM.resolveNode')).toMatchObject({ params: { backendNodeId: 50, executionContextId: 22 } });
    const mouse = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
    expect(mouse).toHaveLength(3);
    expect(mouse.every(call => call.target.tabId === 1 && call.target.sessionId === undefined && call.params.x === 120 && call.params.y === 230)).toBe(true);
    await expect(f.pages.execute(1, 'page.click', { frameId: 'main', ref: child.refs[0].ref })).rejects.toMatchObject({ code: 'FRAME_MISMATCH' });
  });

  it('rejects child references after a document replacement without clicking', async () => {
    const f = pageFixture(); await f.attach();
    const child = await f.pages.execute(1, 'page.snapshot', { frameId: 'child' }); f.changeLoader();
    await expect(f.pages.execute(1, 'page.click', { ref: child.refs[0].ref })).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(f.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('resolves drag endpoints in different frames and restores the operation scope', async () => {
    const f = pageFixture(); await f.attach();
    const main = await f.pages.execute(1, 'page.snapshot', {}), child = await f.pages.execute(1, 'page.snapshot', { frameId: 'child' });
    const observed = [];
    f.pages.frames.rootPoint = vi.fn(async (_tabId, scope) => { observed.push(scope.frameId); return scope.frameId === 'child' ? { x: 100, y: 100 } : { x: 20, y: 20 }; });
    await expect(f.pages.execute(1, 'page.drag', { from: { ref: child.refs[0].ref }, to: { ref: main.refs[0].ref } })).resolves.toEqual({ dragged: true });
    expect(observed).toEqual(['child', 'main', 'child']);
    expect(f.pages.scopes.size).toBe(0);
  });
});

const inPage = (fn, context, args = []) => runInNewContext(`(${fn.toString()}).apply(element, args)`, { ...context, args });

describe('open shadow-root selection and visible geometry', () => {
  it('finds nested shadow controls, rejects ambiguous matches, and bounds traversal', () => {
    const button = {}; const root = (matches, children = []) => ({ querySelectorAll: selector => selector === '*' ? children : matches });
    const inner = root([button]), outer = root([], [{ shadowRoot: inner }]);
    const document = root([], [{ shadowRoot: outer }]);
    expect(inPage(shadowQuery, { element: null, document }, ['button'])).toBe(button);
    document.querySelectorAll = selector => selector === '*' ? [{ shadowRoot: outer }] : [{}];
    expect(() => inPage(shadowQuery, { element: null, document }, ['button'])).toThrow('AMBIGUOUS_TARGET');
    expect(() => inPage(shadowQuery, { element: null, document: { querySelectorAll() { throw new Error(); } } }, ['['])).toThrow('INVALID_SELECTOR');
    const large = root([], Array.from({ length: 30001 }, () => ({})));
    expect(() => inPage(shadowQuery, { element: null, document: large }, ['button'])).toThrow('TARGET_SEARCH_LIMIT');
  });

  it('hit-tests through open shadow roots and rejects controls covered by overlays', () => {
    const target = { isConnected: true, matches: () => false, getAttribute: () => null, getRootNode: () => ({}), getBoundingClientRect: () => ({ left: 10, top: 20, right: 110, bottom: 60 }) };
    const shadowChild = { parentNode: target };
    const host = { shadowRoot: { elementFromPoint: () => shadowChild } };
    const context = { element: target, innerWidth: 800, innerHeight: 600, document: { elementFromPoint: () => host } };
    expect(inPage(pointerProbe, context)).toEqual({ ok: true, x: 60, y: 40 });
    context.document.elementFromPoint = () => ({ getRootNode: () => ({}) });
    expect(inPage(pointerProbe, context)).toEqual({ ok: false });
    context.document.elementFromPoint = () => target; target.matches = () => true;
    expect(inPage(pointerProbe, context)).toEqual({ ok: false });
    target.matches = () => false; target.getRootNode = () => ({ host: { inert: true } });
    expect(inPage(pointerProbe, context)).toEqual({ ok: false });
  });

  it('maps scaled iframe content coordinates including borders and rejects unsafe transforms', () => {
    const element = { isConnected: true, offsetWidth: 204, offsetHeight: 104, clientWidth: 200, clientHeight: 100, clientLeft: 2, clientTop: 2, getBoundingClientRect: () => ({ left: 100, top: 80, width: 102, height: 52 }), getRootNode: () => ({}) };
    const context = { element, innerWidth: 800, innerHeight: 600, document: { elementFromPoint: () => element }, getComputedStyle: () => ({ transform: 'matrix(.5,0,0,.5,0,0)', rotate: 'none', perspective: 'none' }), DOMMatrixReadOnly: class { constructor() { this.is2D = true; this.a = .5; this.d = .5; this.b = 0; this.c = 0; } } };
    expect(inPage(framePoint, context, [{ x: 50, y: 30 }, { width: 200, height: 100 }])).toEqual({ ok: true, x: 126, y: 96 });
    context.getComputedStyle = () => ({ rotate: '45deg' });
    expect(inPage(framePoint, context, [{ x: 50, y: 30 }, { width: 200, height: 100 }])).toMatchObject({ ok: false });
    context.getComputedStyle = () => ({ transform: 'none' }); context.document.elementFromPoint = () => ({});
    expect(inPage(framePoint, context, [{ x: 50, y: 30 }, { width: 200, height: 100 }])).toMatchObject({ ok: false });
  });

  it('rejects individual CSS scale reflections on frames and their shadow hosts', () => {
    const host = { getRootNode: () => ({}) };
    const element = { isConnected: true, offsetWidth: 200, offsetHeight: 100, clientWidth: 200, clientHeight: 100, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }), getRootNode: () => ({ host }) };
    let reflected = element, scale = '-1 1';
    const context = { element, innerWidth: 800, innerHeight: 600, document: { elementFromPoint: () => element }, getComputedStyle: node => ({ transform: 'none', rotate: 'none', perspective: 'none', scale: node === reflected ? scale : 'none' }) };
    // The content's x=10 appears at root x=190 after reflection. Accepting
    // x=10 would click another control while still passing the parent hit test.
    for (const target of [element, host]) {
      reflected = target;
      for (const value of ['-1 1', '1 -1', '-1', '0 1']) {
        scale = value;
        expect(inPage(framePoint, context, [{ x: 10, y: 20 }, { width: 200, height: 100 }])).toMatchObject({ ok: false });
      }
    }
    scale = '.5 .5'; element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 });
    expect(inPage(framePoint, context, [{ x: 10, y: 20 }, { width: 200, height: 100 }])).toEqual({ ok: true, x: 5, y: 10 });
  });
});
