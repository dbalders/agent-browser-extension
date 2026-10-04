# Browser task benchmark

This fixture measures six small browser tasks against server-observed application state. It is original, provider-neutral code and can be used with agent-browser-extension, another browser tool, or a human operator. It does not establish feature parity with Codex Browser or reliability across the web.

The repository's deterministic integration driver is an **automated driver**, not an agent/model evaluation. A Codex baseline has not been run. Result documents therefore contain `comparison.codexBaseline: "not-run"` and `comparison.parityScore: null`; there is no parity percentage.

## Start an agent run

```sh
node scripts/benchmark-serve.mjs \
  --runner-kind actual-agent \
  --provider YOUR_PROVIDER \
  --model YOUR_MODEL \
  --tool-surface YOUR_BROWSER_TOOLS
```

The command prints a loopback URL, a common task prompt, the read-only results URL, and an evidence directory. It serves the fixture without opening or automating a browser. Give the printed prompt to the agent and retain its tool transcript. The provider/model labels are operator declarations, not independently verified identities.

The default evidence directory is a new directory under the system temporary directory. `--output-dir PATH` selects another location; choose one outside the checkout. Files are `manifest.json`, `prompt.txt`, and `results.json`. Results are refreshed every second and saved again on Ctrl+C. The directory and files are created with restrictive permissions. Do not put real credentials, private browsing data, or confidential model inputs in runner labels or the fixture.

Use `--help` for all options. Omitting runner information produces an `unrecorded` run. An `actual-agent` run requires both `--provider` and `--model`. Each server start creates a fresh run; the homepage can also create a new unrecorded run. Runs and task IDs are random, in-memory, isolated from each other, and expire after one hour by default. Restarting the server resets all state.

## Tasks and verification

| Task | Browser work | Server verifies |
| --- | --- | --- |
| Semantic form | Fill a labelled input, select a value inside an open shadow root, and fill an embedded frame | The requested name, color, and frame value were saved |
| Duplicate controls | Select the Maple account's `Save row` button among three identical names | Maple was saved; Orchid and Cedar were never saved |
| Document replacement | Inspect a record, refresh into a new document, then inspect and confirm the current record | A replacement revision was confirmed with its current token |
| Visual challenge | Take a screenshot, read four rasterized digits, and click the colored shape matching a silhouette | The submitted digits and clicked canvas coordinates match the generated image |
| Two documents | Open producer and consumer in background tabs, publish a message, wait, and confirm receipt | Two different document instances published and acknowledged the current requested message |
| Asynchronous result | Start a calculation, wait for its displayed result, and submit that total | The calculation completed and its actual generated total was submitted |

The visual answer is generated as a PNG and drawn onto a canvas. Its digits and target shape are absent from the page's text, accessible names, and client script. An agent run must use screenshot pixels, without inspecting fixture source, decoding an answer through an evaluator, or using the test oracle. The verifier checks the outcome; only a retained tool transcript can establish how the answer was obtained.

Likewise, the document task cannot prove stale-reference recovery by itself, and the handoff task cannot prove simultaneous tabs. A runner must retain evidence of stale-reference rejection/recovery, overlapping work in separate tabs, ownership, and cleanup. User-owned tab release, competing-session isolation, and scratch-tab closure are runner/browser checks, not fixture-scored tasks. They must not be counted as passed merely because all six application outcomes passed.

Task pages submit narrowly defined application actions. The results endpoint reads server state and has no API for setting a task to “passed.” Unknown fields, invalid document capabilities, cross-run documents, stale revisions, and action/document mismatches are rejected. This prevents accidental claimed-success records; it does not prevent a client with fixture access from bypassing the UI. Direct action endpoint use is allowed in fixture unit tests only, and is prohibited in the common agent prompt.

## Reproduce the MCP integration baseline

After installing dependencies and satisfying the isolated Chrome setup in the project testing instructions, run:

```sh
npm run test:browser
```

The browser smoke suite runs `scripts/benchmark-driver.mjs` through the extension's MCP tools in a disposable Chrome profile. It writes the latest baseline to `test-results/benchmark/latest.json`. Each smoke run first replaces any older pass with a `not-started` marker; driver failures save the observed partial outcomes and `runnerExecution.status: "failed"`. Successful driver runs report `runnerExecution.status: "passed"`. The driver records tool names, timing, expected ambiguous/stale errors, background tab creation, a consumer wait released by the producer, screenshot delivery, and scratch-tab cleanup.

The driver uses `getTestOracle()` for deterministic synthetic input and visual answers, so its result explicitly records `runner.kind: "automated-driver"`, `oracleUsed: true`, and `visionReasoningVerified: false`. Screenshot delivery and coordinate input are exercised; model visual reasoning is not. Fixture unit tests also use synthetic answers and direct HTTP actions. Neither is an actual agent benchmark.

An integration driver may inspect DOM geometry when mapping a known canvas point to viewport coordinates. An actual-agent visual comparison should record any such use and must obtain the answer itself from the screenshot.

## Compare actual agents

1. Create a fresh `actual-agent` run for each attempt. Use the same fixture version, common prompt, browser viewport, time budget, tool policy, and cleanup requirements. Random synthetic values differ across runs; task structure is identical.
2. Record the actual model/version and browser tool surface, transcript, elapsed time, all errors and retries, screenshots used, and any operator intervention. Keep unsuccessful attempts.
3. Save the final server results beside the runner evidence. Treat `pending` at the deadline as incomplete; report failed or incomplete tasks, not just successful ones. A wrong duplicate-row action makes that task failed for the rest of its run.
4. Report fixture outcomes separately from tool provenance, visual reasoning, concurrency, and ownership/cleanup evidence. Do not turn an automated driver result into an agent score.
5. Run and retain a real Codex baseline before making a comparison involving Codex. Record that comparison in a separate report linking both original run artifacts. The fixture itself does not compute or update a parity score.

## Programmatic fixture API

```js
import { startBenchmarkFixture } from './scripts/benchmark-fixture.mjs';

const fixture = await startBenchmarkFixture({ port: 0 });
try {
  const run = fixture.createRun({
    runner: { kind: 'actual-agent', provider: 'example', model: 'example-v1' },
  });
  console.log(run.url, run.prompt);
  // Run the browser agent separately, then read observed application outcomes.
  console.log(fixture.getResults(run.runId));
  fixture.closeRun(run.runId);
} finally {
  await fixture.close();
}
```

`startBenchmarkFixture({port, ttlMs, maxRuns})` returns `origin`, `createRun`, `getResults`, `getTestOracle`, `closeRun`, and async `close`. Defaults are a random available port, one-hour expiry, and 32 active runs. `getTestOracle(runId)` is an in-process test facility available only for `automated-driver` runs; calling it permanently marks `oracleUsed: true`. It is not exposed over HTTP.

Each manifest contains `schemaVersion`, `fixtureVersion`, `runId`, `runner`, task IDs/URLs/prompts, and a common `prompt`. Each result contains those version identifiers, declared runner metadata, timestamps, per-task outcomes and safe observations, aggregate counts, oracle use, and bounded action events. Events contain task ID, recognized action name, elapsed time, acceptance, and a reason code; submitted values, document capabilities, request headers, and visual answers are omitted. Only the latest 200 events are retained, with explicit truncation/count fields.

HTTP readback is available at `/api/runs/:runId/manifest` and `/api/runs/:runId/results`. `POST /api/runs` creates a new run with optional runner metadata. Writes require the exact fixture Origin, JSON, and a body no larger than 4 KiB. The server listens only on `127.0.0.1`, validates the Host header, rejects cross-origin writes, and sends no CORS permission. It is a local test fixture, not an authenticated service for untrusted shared hosts.
