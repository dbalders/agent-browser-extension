import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temporary = [];
const source = fileURLToPath(new URL('../', import.meta.url));
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-branding-test-'));
  temporary.push(root);
  await cp(join(source, 'extension'), join(root, 'extension'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  for (const file of ['scripts/package-extension.mjs', 'LICENSE', 'NOTICE']) await cp(join(source, file), join(root, file));
  return root;
}
function build(root, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BROWSER_')));
  return spawnSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
}
const read = (root, path) => readFile(join(root, 'dist/extension', path), 'utf8');

describe('white-label extension builds', () => {
  it('replaces visible branding, links, and icons without changing source templates; a default rebuild restores the upstream brand', async () => {
    const root = await fixture();
    const before = await readFile(join(root, 'extension/popup.html'), 'utf8');
    const icon = join(source, 'extension/icons/icon128.png');
    const result = build(root, {
      BROWSER_DISPLAY_NAME: 'Example & "Co" Browser', BROWSER_BRAND_COLOR: '#123456', BROWSER_ICON_PATH: icon,
      BROWSER_PRIVACY_URL: 'https://example.com/privacy?product=browser&language=en',
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await read(root, 'manifest.json'));
    expect(manifest.name).toBe('Example & "Co" Browser');
    expect(manifest.action.default_title).toBe(manifest.name);
    expect(manifest.description).toContain(manifest.name);
    expect(manifest.description).not.toContain('agent-browser-extension');
    expect(manifest.icons).toEqual({ 128: 'brand-icon.png' });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(await readFile(join(root, 'dist/extension/brand-icon.png'))).toEqual(await readFile(icon));
    expect(await readdir(join(root, 'dist/extension'))).not.toContain('icons');
    for (const page of ['popup.html', 'options.html']) {
      const html = await read(root, page);
      expect(html).toContain('<h1>Example &amp; &quot;Co&quot; Browser</h1>');
      expect(html).toContain('<title>Example &amp; &quot;Co&quot; Browser');
      expect(html).toContain('src="brand-icon.png"');
      expect(html).not.toContain('icons/icon128.png');
      expect(html).toContain('href="https://example.com/privacy?product=browser&amp;language=en"');
      expect(html).not.toContain('github.com/dbalders');
    }
    expect(await read(root, 'ui.css')).toContain('#123456');
    expect(await read(root, 'background.js')).toContain('#123456');
    for (const file of ['LICENSE', 'NOTICE']) expect(await read(root, file)).toBe(await readFile(join(source, file), 'utf8'));
    expect(await readFile(join(root, 'extension/popup.html'), 'utf8')).toBe(before);
    expect(build(root).status).toBe(0);
    expect(JSON.parse(await read(root, 'manifest.json')).name).toBe('agent-browser-extension');
    expect(await readdir(join(root, 'dist/extension'))).not.toContain('brand-icon.png');
    expect(await read(root, 'popup.html')).toContain('src="icons/icon128.png"');
    expect(await read(root, 'ui.css')).toContain('#b94b16');
  });

  it('keeps the default privacy link intact when only the name is changed', async () => {
    const root = await fixture();
    expect(build(root, { BROWSER_DISPLAY_NAME: 'Example Browser' }).status).toBe(0);
    expect(await read(root, 'popup.html')).toContain('href="https://github.com/dbalders/agent-browser-extension/blob/main/docs/privacy.md"');
  });

  it('rejects invalid replacements before removing the last successful build', async () => {
    const root = await fixture();
    expect(build(root).status).toBe(0);
    const before = await read(root, 'manifest.json');
    for (const overrides of [
      { BROWSER_DISPLAY_NAME: 'a'.repeat(46) }, { BROWSER_BRAND_COLOR: 'red' },
      { BROWSER_PRIVACY_URL: 'javascript:alert(1)' }, { BROWSER_PRIVACY_URL: ['https://', 'name', ':', 'pass', '@example.com/privacy'].join('') },
      { BROWSER_ICON_PATH: join(source, 'extension/icons/icon16.png') },
    ]) {
      expect(build(root, overrides).status).not.toBe(0);
      expect(await read(root, 'manifest.json')).toBe(before);
    }
  });
});
