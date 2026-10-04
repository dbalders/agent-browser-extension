import { describe, expect, it, vi } from 'vitest';
import { captureScreenshot, clickInteraction, runInteraction } from '../extension/interactions.js';

function fixture() {
  const commands = [];
  const adapter = {
    sendInput: vi.fn(async (_tabId, method, args) => {
      commands.push({ method, args });
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 100, scale: 1 }, cssContentSize: { width: 800, height: 1200 } };
      return {};
    }),
    pointerTarget: vi.fn(async (_id, args) => args.ref === 'from' ? { x: 50, y: 50 } : { x: 100, y: 100 }),
    call: vi.fn(), invalidate: vi.fn(),
  };
  return { adapter, commands };
}

describe('visual browser actions', () => {
  it('rejects screenshot points outside the viewport and ambiguous frame/element coordinates before input', async () => {
    const { adapter, commands } = fixture();
    for (const args of [{ x: 800, y: 1 }, { x: 1, y: 600 }, { x: -1, y: 1 }, { x: NaN, y: 1 }, { x: 1 }, { x: 10, y: 20, ref: 'old' }, { x: 10, y: 20, frameId: 'child' }]) {
      await expect(clickInteraction(adapter, 1, args)).rejects.toBeDefined();
    }
    expect(commands.some(command => command.method.startsWith('Input.'))).toBe(false);
  });
  it('performs a real double-click sequence and leaves no button pressed', async () => {
    const { adapter, commands } = fixture();
    expect(await clickInteraction(adapter, 1, { x: 300, y: 200, clickCount: 2 })).toEqual({ clicked: true });
    const mouse = commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.args);
    expect(mouse.filter(event => event.type === 'mousePressed').map(event => event.clickCount)).toEqual([1, 2]);
    expect(mouse.filter(event => event.type === 'mouseReleased').map(event => event.clickCount)).toEqual([1, 2]);
    expect(mouse.at(-1)).toMatchObject({ buttons: 0, x: 300, y: 200 });
  });
  it('stops double-clicking if the first click opens a dialog', async () => {
    const { adapter, commands } = fixture();
    const original = adapter.sendInput.getMockImplementation();
    adapter.sendInput.mockImplementation(async (...params) => {
      const result = await original(...params);
      if (params[2]?.type === 'mouseReleased') return { dialogOpened: true, dialog: { type: 'confirm' } };
      return result;
    });
    expect(await clickInteraction(adapter, 1, { ref: 'button', clickCount: 2 })).toMatchObject({ dialog: { type: 'confirm' } });
    expect(commands.filter(command => command.args?.type === 'mousePressed')).toHaveLength(1);
  });
  it('releases a pressed pointer if dragging is interrupted', async () => {
    const { adapter, commands } = fixture();
    const original = adapter.sendInput.getMockImplementation();
    adapter.sendInput.mockImplementation(async (...params) => {
      const result = await original(...params);
      if (params[2]?.type === 'mouseMoved' && params[2]?.buttons === 1) throw new Error('Page target vanished');
      return result;
    });
    await expect(runInteraction(adapter, 1, 'page.drag', { from: { ref: 'from' }, to: { ref: 'to' } })).rejects.toThrow('Page target vanished');
    expect(commands.at(-1).args).toMatchObject({ type: 'mouseReleased', buttons: 0 });
  });
  it.each(['mouseMoved', 'mousePressed', 'dragMove'])('reports a dialog that interrupts drag at %s without continuing the drag', async stage => {
    const { adapter, commands } = fixture(); const original = adapter.sendInput.getMockImplementation();
    const dialog = { type: 'confirm', message: 'Continue dragging?' }; let opened = false;
    adapter.sendInput.mockImplementation(async (...params) => {
      // PageAdapter refuses input while a dialog is open. A best-effort release
      // may be attempted, but must never hide the dialog result or continue moves.
      if (opened) throw new Error('DIALOG_OPEN');
      const result = await original(...params); const event = params[2];
      if (stage === 'dragMove' ? event?.type === 'mouseMoved' && event.buttons === 1 : event?.type === stage) {
        opened = true; return { dialogOpened: true, dialog };
      }
      return result;
    });
    expect(await runInteraction(adapter, 1, 'page.drag', { from: { ref: 'from' }, to: { ref: 'to' } })).toMatchObject({ dragged: false, dialog });
    expect(commands.filter(command => command.args?.type === 'mouseMoved' && command.args.buttons === 1)).toHaveLength(stage === 'dragMove' ? 1 : 0);
    expect(commands.filter(command => command.args?.type === 'mousePressed')).toHaveLength(stage === 'mouseMoved' ? 0 : 1);
  });
  it('returns the dialog opened by a completed drag release without repeating the release', async () => {
    const { adapter, commands } = fixture(); const original = adapter.sendInput.getMockImplementation();
    const dialog = { type: 'confirm', message: 'Apply this move?' };
    adapter.sendInput.mockImplementation(async (...params) => {
      const result = await original(...params);
      return params[2]?.type === 'mouseReleased' ? { dialogOpened: true, dialog } : result;
    });
    expect(await runInteraction(adapter, 1, 'page.drag', { from: { ref: 'from' }, to: { ref: 'to' } })).toEqual({ dragged: true, dialog });
    expect(commands.filter(command => command.args?.type === 'mouseReleased')).toHaveLength(1);
  });
  it('does not navigate back to a browser internal page', async () => {
    const { adapter, commands } = fixture();
    adapter.sendInput.mockResolvedValue({ currentIndex: 1, entries: [{ id: 0, url: 'chrome://settings' }, { id: 1, url: 'https://example.test' }] });
    await expect(runInteraction(adapter, 1, 'page.history', { direction: 'back' })).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' });
    expect(adapter.invalidate).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });
  it('includes actual image dimensions separately from viewport CSS coordinates', async () => {
    const { adapter } = fixture(); const original = adapter.sendInput.getMockImplementation();
    // A JPEG SOF header for a 1600x1200 image captured from an 800x600 CSS viewport.
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 4, 176, 6, 64, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString('base64');
    adapter.sendInput.mockImplementation(async (...params) => params[1] === 'Page.captureScreenshot' ? { data } : original(...params));
    expect(await captureScreenshot(adapter, 1, {})).toMatchObject({ image: { width: 1600, height: 1200 }, viewport: { width: 800, height: 600, pageY: 100 }, fullPage: false });
  });
  it('rejects huge full pages before Chrome captures them', async () => {
    const { adapter } = fixture();
    adapter.sendInput.mockResolvedValue({ cssContentSize: { width: 2000, height: 100000 } });
    await expect(captureScreenshot(adapter, 1, { fullPage: true })).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' });
    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
  });
});
