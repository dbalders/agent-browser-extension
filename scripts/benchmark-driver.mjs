import assert from 'node:assert/strict';

// Deterministic integration driver, explicitly not a model/vision benchmark.
// The fixture marks oracle use in its result so this cannot become agent proof.
export async function runBenchmarkDriver(client, fixture) {
  const run = fixture.createRun({ runner: { kind: 'automated-driver', label: 'agent-browser-extension MCP integration', toolSurface: 'MCP' } });
  const answers = fixture.getTestOracle(run.runId);
  const startedAt = Date.now(); const calls = [];
  const invoke = async (name, args = {}, expectedError) => {
    const call = { name, ...(args.tabId === undefined ? {} : { tabId: args.tabId }), startedMs: Date.now() - startedAt };
    calls.push(call);
    const result = await client.callTool({ name, arguments: args });
    call.finishedMs = Date.now() - startedAt; call.isError = result.isError === true;
    const output = result.content.find(item => item.type === 'text');
    const value = output ? JSON.parse(output.text) : undefined;
    if (expectedError) { assert.equal(value?.code, expectedError); call.expectedError = expectedError; }
    else assert.ok(!result.isError, `${name}: ${JSON.stringify(value)}`);
    return name === 'browser_screenshot' ? result : value;
  };
  const opened = [];
  const open = async url => { const tab = await invoke('browser_open', { url }); opened.push(tab.tabId); assert.equal(tab.active, false); await invoke('browser_wait', { tabId: tab.tabId, loadState: 'load' }); return tab.tabId; };
  try {
    for (const task of run.tasks) {
      const tabId = await open(task.url);
      const target = locator => ({ tabId, locator });
      if (task.type === 'form') {
        await invoke('browser_fill', { ...target({ label: 'Display name' }), text: answers.form.displayName });
        await invoke('browser_select', { ...target({ label: 'Preferred color' }), values: [answers.form.color] });
        await invoke('browser_click', target({ role: 'button', name: 'Save profile' }));
        await invoke('browser_wait', { tabId, text: 'Profile saved.' });
        const frame = (await invoke('browser_frames', { tabId })).frames.find(item => item.url.endsWith('/frame'));
        assert.ok(frame?.frameId);
        await invoke('browser_fill', { tabId, frameId: frame.frameId, locator: { label: 'Access code' }, text: answers.form.accessCode });
        await invoke('browser_click', { tabId, frameId: frame.frameId, locator: { role: 'button', name: 'Save access code' } });
        await invoke('browser_wait', { tabId, frameId: frame.frameId, text: 'Access code saved.' });
      } else if (task.type === 'ambiguity') {
        await invoke('browser_click', target({ role: 'button', name: 'Save row' }), 'AMBIGUOUS_TARGET');
        await invoke('browser_click', { tabId, selector: 'section[aria-label="Maple account"] button' });
        await invoke('browser_wait', { tabId, text: 'maple saved.' });
      } else if (task.type === 'dynamic') {
        const initial = await invoke('browser_snapshot', { tabId });
        const stale = initial.refs.find(item => item.role === 'button' && item.name === 'Confirm current record');
        assert.ok(stale?.ref);
        await invoke('browser_click', target({ role: 'button', name: 'Refresh record' }));
        await invoke('browser_wait', { tabId, urlIncludes: '?revision=2', text: 'Record revision 2', loadState: 'load' });
        await invoke('browser_click', { tabId, ref: stale.ref }, 'STALE_REF');
        const fresh = await invoke('browser_snapshot', { tabId });
        await invoke('browser_click', { tabId, ref: fresh.refs.find(item => item.role === 'button' && item.name === 'Confirm current record').ref });
        await invoke('browser_wait', { tabId, text: 'Current record confirmed.' });
      } else if (task.type === 'visual') {
        await invoke('browser_wait', { tabId, text: 'Challenge ready.' });
        const screenshot = await invoke('browser_screenshot', { tabId });
        assert.ok(screenshot.content.some(item => item.type === 'image' && item.data.length > 1000));
        await invoke('browser_fill', { ...target({ label: 'Code seen in picture' }), text: answers.visual.code });
        const bounds = JSON.parse((await invoke('browser_evaluate', { tabId, expression: '(()=>{const box=document.querySelector("canvas").getBoundingClientRect();return {x:box.left,y:box.top,width:box.width,height:box.height}})()' })).json);
        await invoke('browser_click', { tabId, x: bounds.x + answers.visual.point.x * bounds.width / 560, y: bounds.y + answers.visual.point.y * bounds.height / 240 });
        await invoke('browser_click', target({ role: 'button', name: 'Submit visual answer' }));
        await invoke('browser_wait', { tabId, text: 'Visual answer verified.' });
      } else if (task.type === 'tabs') {
        const producer = await open(`${task.url}/producer`); const consumer = await open(`${task.url}/consumer`);
        await invoke('browser_fill', { tabId: producer, locator: { label: 'Message to publish' }, text: answers.tabs.message });
        const waiting = invoke('browser_wait', { tabId: consumer, text: answers.tabs.message, timeoutMs: 4000 });
        const publishing = invoke('browser_click', { tabId: producer, locator: { role: 'button', name: 'Publish message' } });
        await Promise.all([waiting, publishing]);
        await invoke('browser_click', { tabId: consumer, locator: { role: 'button', name: 'Confirm receipt' } });
        await invoke('browser_wait', { tabId: consumer, text: 'Current message acknowledged.' });
      } else if (task.type === 'wait') {
        await invoke('browser_click', target({ role: 'button', name: 'Start calculation' }));
        await invoke('browser_wait', { tabId, selector: '#calculation', text: 'Calculation ready:', timeoutMs: 4000 });
        const observed = await invoke('browser_read', { tabId, selector: '#calculation' });
        const total = observed.text.match(/total (\d+)/)?.[1]; assert.ok(total);
        await invoke('browser_fill', { ...target({ label: 'Computed total' }), text: total });
        await invoke('browser_click', target({ role: 'button', name: 'Submit total' }));
        await invoke('browser_wait', { tabId, text: 'Computed total verified.' });
      }
    }
    const result = fixture.getResults(run.runId);
    assert.equal(result.oracleUsed, true); assert.equal(result.results.allPassed, true, JSON.stringify(result));
    const cleanup = await invoke('browser_finish');
    assert.ok(opened.every(tabId => cleanup.closed.includes(tabId)), 'Finish closes every benchmark scratch tab');
    return { ...result, runnerExecution: { status: 'passed' }, runnerEvidence: { calls, scratchTabsOpened: opened.length, scratchTabsClosed: cleanup.closed.length, backgroundOpenVerified: true, concurrentWaitReleasedByOtherTab: true, screenshotContentDelivered: true, visionReasoningVerified: false } };
  } catch (error) {
    error.benchmarkResult = { ...fixture.getResults(run.runId), runnerExecution: { status: 'failed', message: String(error.message).slice(0, 1000) }, runnerEvidence: { calls, scratchTabsOpened: opened.length, visionReasoningVerified: false } };
    throw error;
  } finally {
    await invoke('browser_finish').catch(() => {});
  }
}
