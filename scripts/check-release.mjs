import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const requiredFiles = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'NOTICE', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json'];
const sourceDirectories = new Map([
  ['src', new Set(['ts'])], ['extension', new Set(['js', 'json', 'html', 'css'])],
  ['tests', new Set(['js', 'ts'])], ['scripts', new Set(['mjs'])],
  ['docs', new Set(['md'])], ['.github/workflows', new Set(['yml', 'yaml'])],
]);
const approvedLicenses = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const sort = values => values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const suspectNames = /(?:^|\/)(?:\.env(?:\..*)?|connection\.json|credentials?(?:\..*)?|.*\.(?:pem|key|p12|pfx|log)|profile|node_modules|test-results|dist)(?:\/|$)/iu;
const checks = [
  ['private-key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['provider credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/u],
  ['literal credential', /(?:["']?(?:token|api[_-]?key|client[_-]?secret|password)["']?\s*[:=]\s*["'])[A-Za-z0-9+/_=-]{32,}["']/iu],
  ['personal absolute path', /(?:\/Users\/|\/home\/|[A-Z]:[\\/]Users[\\/])[^\s/\\"'<>]+[\\/]/u],
  ['credential in URL', /https?:\/\/[^\s/@]+:[^\s/@]+@/iu],
];

export function inspectText(path, data) {
  if (data.includes(0)) return [`${path}: unexpected binary content`];
  const contents = data.toString('utf8');
  return checks.filter(([, pattern]) => pattern.test(contents)).map(([kind]) => `${path}: ${kind}`);
}

async function inspectPath(root, path) {
  // Check every parent as well: a symlinked source directory must never pull in external files.
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const info = await lstat(join(root, ...parts.slice(0, index)));
    if (info.isSymbolicLink()) throw new Error(`${path}: symbolic links are excluded from source releases`);
    if (index < parts.length && !info.isDirectory()) throw new Error(`${path}: invalid parent directory`);
    if (index === parts.length) return info;
  }
}

export async function collectSource(root = projectRoot) {
  const files = [];
  const add = async path => {
    const info = await inspectPath(root, path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error(`${path}: expected a source file below 2 MiB`);
    if (suspectNames.test(path)) throw new Error(`${path}: private or generated filename in source directory`);
    const data = await readFile(join(root, path));
    const findings = inspectText(path, data);
    if (findings.length) throw new Error(findings.join('\n'));
    files.push({ path, data, sha256: sha256(data), size: data.length });
  };
  for (const path of requiredFiles) await add(path);
  for (const [directory, extensions] of sourceDirectories) {
    const walk = async path => {
      if (!(await inspectPath(root, path)).isDirectory()) throw new Error(`${path}: expected a source directory`);
      for (const name of sort(await readdir(join(root, path)))) {
        const child = `${path}/${name}`;
        if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name.startsWith('.') || suspectNames.test(child)) throw new Error(`${directory}: unexpected or private source entry`);
        const info = await inspectPath(root, child);
        if (info.isDirectory()) await walk(child);
        else if (extensions.has(name.split('.').at(-1))) await add(child);
        else throw new Error(`${child}: file type is not in the source release allowlist`);
      }
    };
    await walk(directory);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function inspectDependencies(manifest, lock) {
  if (manifest.license !== 'Apache-2.0') throw new Error('Project license must remain Apache-2.0.');
  if (manifest.private !== true) throw new Error('Source releases retain private: true; npm publication is a separate decision.');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(manifest.version)) throw new Error('Invalid source release version.');
  if (lock.lockfileVersion !== 3 || lock.packages?.['']?.version !== manifest.version || lock.name !== manifest.name) throw new Error('Package metadata and npm v3 lockfile must agree.');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const wanted = manifest[section] ?? {};
    const locked = lock.packages[''][section] ?? {};
    if (JSON.stringify(Object.entries(wanted).sort()) !== JSON.stringify(Object.entries(locked).sort())) throw new Error(`${section}: package.json and package-lock.json disagree`);
  }
  const dependencies = [];
  for (const path of sort(Object.keys(lock.packages).filter(Boolean))) {
    const entry = lock.packages[path];
    const url = new URL(entry.resolved ?? 'file:missing');
    if (entry.link || url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) throw new Error(`${path}: dependency must resolve to the public npm registry without credentials`);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? '')) throw new Error(`${path}: missing SHA-512 package integrity`);
    if (!approvedLicenses.has(entry.license) && !(entry.dev === true && entry.license === 'MPL-2.0')) throw new Error(`${path}: license needs maintainer review`);
    dependencies.push({ path, version: entry.version, license: entry.license, development: entry.dev === true, integrity: entry.integrity });
  }
  return dependencies;
}

export async function checkRelease(root = projectRoot) {
  const files = await collectSource(root);
  const parse = path => {
    const file = files.find(file => file.path === path);
    if (!file) throw new Error(`${path}: required release metadata is missing`);
    return JSON.parse(file.data.toString('utf8'));
  };
  const manifest = parse('package.json');
  const dependencies = inspectDependencies(manifest, parse('package-lock.json'));
  if (parse('extension/manifest.json').version !== manifest.version) throw new Error('Extension and package versions must agree.');
  if (!files.find(file => file.path === 'LICENSE').data.toString('utf8').includes('Apache License')) throw new Error('Missing Apache license text.');
  return { files, report: {
    formatVersion: 1, name: manifest.name, version: manifest.version, license: manifest.license,
    scope: 'Allowlisted current source only; no Git history, generated output, dependencies, or private runtime files.',
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })), dependencies,
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report } = await checkRelease();
    console.log(`Source release check passed: ${report.files.length} files, ${report.dependencies.length} dependency license records (${report.dependencies.filter(item => !item.development).length} runtime).`);
    console.log('Checks cover the source allowlist only. Dependency advisories and repository history require separate review.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
