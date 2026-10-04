import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checkRelease, collectSource, inspectDependencies, inspectText } from '../scripts/check-release.mjs';
import { buildSourceArchive, packageSource } from '../scripts/package-source.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-source-test-'));
  temporary.push(root);
  const manifest = { name: 'agent-browser-extension', version: '0.1.0', private: true, license: 'Apache-2.0', dependencies: { example: '1.0.0' } };
  const lock = { name: manifest.name, lockfileVersion: 3, packages: {
    '': { version: manifest.version, dependencies: manifest.dependencies },
    'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), license: 'MIT' },
  } };
  const files = {
    'AGENTS.md': 'Public project instructions', 'README.md': 'Public README', 'CONTRIBUTING.md': 'Contributing',
    'SECURITY.md': 'Security', 'LICENSE': 'Apache License', 'NOTICE': 'Copyright contributors', '.gitignore': 'dist/\nnode_modules/\n',
    'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock), 'tsconfig.json': '{}',
    'src/index.ts': 'export const example = 1;\n', 'extension/manifest.json': JSON.stringify({ version: manifest.version }),
    'tests/example.test.js': '// example test', 'scripts/build.mjs': '// example build', 'docs/release.md': 'Release', '.github/workflows/check.yml': 'name: Check',
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return { root, manifest, lock };
}

function unpack(archive) {
  const tar = gunzipSync(archive);
  const entries = new Map();
  let offset = 0;
  while (tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    const declaredChecksum = parseInt(header.subarray(148, 156).toString(), 8);
    const calculatedChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    expect(calculatedChecksum).toBe(declaredChecksum);
    expect(header.subarray(257, 263).toString()).toBe('ustar\0');
    expect(header[156]).toBe('0'.charCodeAt(0));
    expect(name.startsWith('agent-browser-extension-0.1.0/')).toBe(true);
    expect(name.split('/')).not.toContain('..');
    entries.set(name.replace('agent-browser-extension-0.1.0/', ''), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(tar.subarray(offset).length).toBe(1024);
  expect(tar.subarray(offset).every(byte => byte === 0)).toBe(true);
  return entries;
}

describe('source release boundaries', () => {
  it('packages deterministic inspected source and independently verifiable hashes without reading runtime files', async () => {
    const { root } = await fixture();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'private.json'), '{"runtime":true}');
    await writeFile(join(root, 'connection.json'), '{"runtime":true}');
    await writeFile(join(root, '.env'), 'private environment');
    const first = await packageSource(root);
    const second = await buildSourceArchive(root);
    expect(first.archive).toEqual(second.archive);
    const entries = unpack(first.archive);
    expect([...entries.keys()]).not.toContain('connection.json');
    expect([...entries.keys()].some(path => path.startsWith('dist/') || path.startsWith('test-results/'))).toBe(false);
    const report = JSON.parse(entries.get('RELEASE-MANIFEST.json'));
    expect(entries.size).toBe(report.files.length + 1);
    for (const file of report.files) {
      expect(entries.get(file.path)).toEqual(await readFile(join(root, file.path)));
      expect(entries.get(file.path).length).toBe(file.size);
      expect(createHash('sha256').update(entries.get(file.path)).digest('hex')).toBe(file.sha256);
    }
    expect(await readFile(join(root, 'test-results/release/SHA256SUMS'), 'utf8')).toBe(`${first.sha256}  ${first.filename}\n`);
    await writeFile(join(root, 'src/index.ts'), 'export const example = 2;\n');
    expect((await buildSourceArchive(root)).sha256).not.toBe(first.sha256);
  });

  it('fails closed for credentials and unexpected assets inside source directories', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'src', 'connection.json'), '{}');
    await expect(collectSource(root)).rejects.toThrow(/private source entry/);
    await rm(join(root, 'src', 'connection.json'));
    await writeFile(join(root, 'extension', 'capture.png'), Buffer.from([0, 1, 2]));
    await expect(collectSource(root)).rejects.toThrow(/allowlist/);
  });

  it('rejects symlinked files and source parent directories', async () => {
    const { root } = await fixture();
    await symlink(join(root, 'README.md'), join(root, 'src', 'linked.ts'));
    await expect(collectSource(root)).rejects.toThrow(/symbolic links/);
    await rm(join(root, 'src', 'linked.ts'));
    await rm(join(root, '.github'), { recursive: true });
    await symlink(join(root, 'docs'), join(root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(collectSource(root)).rejects.toThrow(/symbolic links/);
  });

  it('reports the path and category without echoing a suspected secret', () => {
    const secret = 'gh' + 'p_' + 'A'.repeat(36);
    const findings = inspectText('src/example.ts', Buffer.from(`export const value = '${secret}';`));
    expect(findings).toEqual(['src/example.ts: provider credential']);
    expect(JSON.stringify(findings)).not.toContain(secret);
    const personal = ['/', 'Users', '/', 'example-person', '/', 'private'].join('');
    expect(inspectText('README.md', Buffer.from(personal))).toEqual(['README.md: personal absolute path']);
    const credential = ['token', ': "', 'q'.repeat(43), '"'].join('');
    expect(inspectText('src/config.ts', Buffer.from(credential))).toEqual(['src/config.ts: literal credential']);
    expect(inspectText('src/file.ts', Buffer.from([0]))).toEqual(['src/file.ts: unexpected binary content']);
  });

  it('fails for unreviewed dependency licenses, missing integrity, and private registry locations', async () => {
    const { manifest, lock } = await fixture();
    const entry = lock.packages['node_modules/example'];
    expect(inspectDependencies(manifest, lock)).toHaveLength(1);
    entry.license = 'UNKNOWN';
    expect(() => inspectDependencies(manifest, lock)).toThrow(/license needs/);
    entry.license = 'MPL-2.0';
    expect(() => inspectDependencies(manifest, lock)).toThrow(/license needs/);
    entry.dev = true;
    expect(inspectDependencies(manifest, lock)).toHaveLength(1);
    entry.integrity = undefined;
    expect(() => inspectDependencies(manifest, lock)).toThrow(/integrity/);
    entry.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
    entry.resolved = 'https://packages.example.invalid/example.tgz';
    expect(() => inspectDependencies(manifest, lock)).toThrow(/public npm registry/);
  });

  it('requires matching manifest, extension and lockfile metadata and a source-only publication guard', async () => {
    const { root, manifest, lock } = await fixture();
    manifest.dependencies.example = '2.0.0';
    // Detach the fixture's shared object before checking lockfile drift.
    lock.packages[''].dependencies = { example: '1.0.0' };
    expect(() => inspectDependencies(manifest, lock)).toThrow(/disagree/);
    manifest.dependencies.example = '1.0.0';
    manifest.private = false;
    expect(() => inspectDependencies(manifest, lock)).toThrow(/private: true/);
    await writeFile(join(root, 'extension/manifest.json'), JSON.stringify({ version: '0.2.0' }));
    await expect(checkRelease(root)).rejects.toThrow(/versions must agree/);
  });
});
