import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBenchmarkFixture } from './benchmark-fixture.mjs';

export function parseBenchmarkArgs(args) {
  const options = { port: 0, runner: { kind: 'unrecorded' } };
  const values = { '--port': 'port', '--output-dir': 'outputDir', '--runner-kind': 'kind', '--provider': 'provider', '--model': 'model', '--label': 'label', '--tool-surface': 'toolSurface' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') return { help: true };
    const key = values[args[index]];
    if (!key || args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${args[index]}`);
    const value = args[++index];
    if (key === 'port') { if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be 0–65535.'); options.port = Number(value); }
    else if (key === 'outputDir') options.outputDir = resolve(value);
    else options.runner[key] = value;
  }
  return options;
}

export async function runBenchmarkServer(args = process.argv.slice(2)) {
  const options = parseBenchmarkArgs(args);
  if (options.help) {
    process.stdout.write('Usage: node scripts/benchmark-serve.mjs [--port 0] [--output-dir PATH] [--runner-kind unrecorded|automated-driver|actual-agent] [--provider NAME --model NAME] [--label NAME] [--tool-surface NAME]\nThe server binds 127.0.0.1, creates one isolated benchmark run, and writes sanitized evidence. It does not automate a browser.\n');
    return;
  }
  const outputDir = options.outputDir || await mkdtemp(join(tmpdir(), 'agent-browser-extension-benchmark-'));
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const fixture = await startBenchmarkFixture({ port: options.port });
  let run;
  try { run = fixture.createRun({ runner: options.runner }); }
  catch (error) { await fixture.close(); throw error; }
  const resultsPath = join(outputDir, 'results.json');
  let pendingWrite = Promise.resolve(); let closing = false; let interval;
  const writeResults = () => {
    pendingWrite = pendingWrite.then(async () => {
      const result = fixture.getResults(run.runId);
      await writeFile(`${resultsPath}.tmp`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      await rename(`${resultsPath}.tmp`, resultsPath);
    });
    return pendingWrite;
  };
  try {
    await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(outputDir, 'prompt.txt'), `${run.prompt}\n`, { mode: 0o600 });
    await writeResults();
  } catch (error) { await fixture.close(); throw error; }
  const close = async () => {
    if (closing) return; closing = true; clearInterval(interval);
    process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
    try { await writeResults(); } catch (error) { process.stderr.write(`Could not save final benchmark evidence: ${error.message}\n`); }
    await fixture.close();
  };
  interval = setInterval(() => { void writeResults().catch(error => { clearInterval(interval); process.stderr.write(`Benchmark evidence update stopped: ${error.message}\n`); }); }, 1000);
  process.once('SIGINT', close); process.once('SIGTERM', close);
  process.stdout.write(`Benchmark: ${run.url}\nResults: ${run.resultsUrl}\nEvidence directory: ${outputDir}\nResults file: ${resultsPath}\nRunner: ${options.runner.kind}\n\n${run.prompt}\n\nPress Ctrl+C to stop the local fixture and save final results.\n`);
  return { fixture, run, outputDir, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runBenchmarkServer(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
