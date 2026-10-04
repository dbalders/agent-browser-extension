import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkRelease, projectRoot } from './check-release.mjs';

function tarEntry(path, data) {
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(path) > 100) throw new Error('Source archive paths must fit in a portable tar header.');
  header.write(path, 0, 100);
  const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(data.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
}

export async function buildSourceArchive(root = projectRoot) {
  // Package the exact bytes that passed inspection. Do not re-read source files after validation.
  const { files, report } = await checkRelease(root);
  const directory = `agent-browser-extension-${report.version}`;
  const manifest = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const entries = [...files, { path: 'RELEASE-MANIFEST.json', data: manifest }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const archive = gzipSync(Buffer.concat([...entries.flatMap(file => tarEntry(`${directory}/${file.path}`, file.data)), Buffer.alloc(1024)]), { level: 9 });
  return { archive, report, filename: `${directory}-source.tar.gz`, sha256: createHash('sha256').update(archive).digest('hex') };
}

export async function packageSource(root = projectRoot, output = join(root, 'test-results', 'release')) {
  const result = await buildSourceArchive(root);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, result.filename), result.archive);
  await writeFile(join(output, 'SHA256SUMS'), `${result.sha256}  ${result.filename}\n`);
  await writeFile(join(output, 'RELEASE-MANIFEST.json'), `${JSON.stringify(result.report, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageSource();
    console.log(`Prepared test-results/release/${result.filename} (${result.report.files.length} source files).`);
    console.log(`SHA-256: ${result.sha256}`);
    console.log('Local preparation only. No repository, registry, or store publication was performed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
