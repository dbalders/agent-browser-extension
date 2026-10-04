# Capabilities and tool reference

This project exposes 39 provider-neutral agent tools through MCP and an authenticated local HTTP bridge. The build generates the machine-readable catalog at `dist/catalog.json` from `src/tools.ts`. The implementation uses public Chrome extension and DevTools Protocol APIs; the table describes this project's own behavior and does not establish parity with another product.

## Tool map

| Task | Tools | Behavior and limits |
| --- | --- | --- |
| Connection and task lifecycle | `browser_status`, `browser_start`, `browser_finish` | Check connection, name a task, then clean up scratch tabs and release user tabs. Independent MCP sessions share one trusted local bridge. |
| Website permissions | `browser_access` | Read this task's access status and pending requests. Only the extension UI can grant access. Ordinary website access and debugging access are separate. |
| Tab activity indicator | `browser_activity` | Owned tabs show 🤖 with an optional explicit activity emoji. Dynamic titles/navigation are preserved; cleanup restores the latest page title. Cosmetic, best effort; does not pause execution. |
| Tab discovery and claiming | `browser_tabs`, `browser_use` | Discover existing tabs automatically, filter by title/URL, and claim a relevant tab. Competing ownership is refused; no manual picker is required. |
| Creating and navigating tabs | `browser_open`, `browser_navigate`, `browser_history` | Open in the background by default; navigate, back, forward, or reload. Top-level navigation accepts HTTP/HTTPS. Read a fresh snapshot after document changes. |
| Ownership and handoff | `browser_release`, `browser_close`, `browser_keep`, `browser_show`, `browser_group` | Release without closing, explicitly close a claimed tab, retain a deliverable/handoff, show a result, or update the task's groups. Closing a user tab requires task authorization. |
| Page and frame structure | `browser_snapshot`, `browser_frames` | Accessibility structure with fresh references and frame discovery. References retain their frame; document changes invalidate them. Cross-origin/nested frames and open shadow roots are supported with limits below. |
| Text and form inspection | `browser_read` | Bounded rendered text, current control value/state and native dropdown options. Omit password/hidden-input values and file paths. Inspect the returned `truncated` flag. |
| Pointer input | `browser_click`, `browser_hover`, `browser_drag` | Unique elements or viewport CSS coordinates. Click supports left/right/middle and double-click. Drag is pointer-driven; native HTML5 drag-and-drop is not guaranteed. |
| Text and keyboard input | `browser_fill`, `browser_type`, `browser_press` | Replace a field, insert text at the caret, or send a key/chord. Some custom editors require their own focus/keyboard sequence. |
| Selection and checked state | `browser_select`, `browser_check` | Native dropdown option values and idempotent checkbox/radio/switch state. A radio can be selected, not cleared. Check verifies the resulting state unless a dialog requires user/agent handling first. |
| Scrolling and readiness | `browser_scroll`, `browser_wait` | Scroll page/element; wait on observable URL, readiness, text and target state. Conditions combine; waits are bounded to 30 seconds. |
| Page JavaScript | `browser_evaluate` | A synchronous expression in the claimed document, returning bounded JSON text. Extraction or interaction must be authorized by the task; asynchronous orchestration and raw CDP passthrough are not exposed. |
| Visual observation | `browser_screenshot` | PNG/JPEG viewport or bounded full-page image, with dimensions and CSS geometry. MCP includes actual image content; client/model image support is still required. |
| File transfer | `browser_upload`, `browser_downloads`, `browser_wait_download` | Set authorized absolute file paths on a file input, list task-attributed downloads, and wait for completion/interruption. Chrome and the bridge run on the same machine. |
| Dialogs | `browser_dialog` | Accept/dismiss JavaScript alert/confirm/prompt dialogs. Operating-system dialogs, browser permission sheets and anti-automation challenges may need the user. |
| Diagnostics | `browser_console`, `browser_network` | Bounded records after debugger attachment; cursor-based reads, clearing and dropped-record counts. No historical replay, request interception or network bodies/headers. |
| Viewport and preferences | `browser_emulate` | Viewport, device scale factor, color scheme and reduced motion for the claimed tab. Resets on release/finish. No touch, user-agent, geolocation, locale or timezone emulation. |
| CPU profiling capability | `browser_profile` | Browser-dependent; unsupported builds return `PROFILE_UNAVAILABLE`. Where permitted, bounded V8 renderer-isolate capture and chunked `.cpuprofile` export; may include other contexts in that isolate. |
| Performance | `browser_performance` | Document timing and renderer counters; start/stop/status/read/clear a selected-document trace exported as Chrome Trace Event JSON. |
| Element inspection | `browser_inspect` | Selected element structure, rectangle, state and allowlisted computed styles. No raw HTML, script bodies, form values or URL-valued CSS properties. |

## Website access and concurrency

New and upgraded installations default to **Ask first**. The popup and connection screen offer **Allow for this task**, **Always allow**, **Block**, and **Revoke access** for exact HTTP/HTTPS origins, including ports. Task grants expire on session completion or extension worker restart; persistent grants survive. **Allow all websites** applies to ordinary access only. Debugging always requires its own grant. Blocks take precedence. Revocation cancels access and detaches affected debugging sessions without closing user tabs.

On `SITE_ACCESS_REQUIRED`, report the pending request to the user and wait for approval in the extension UI. Approval does not replay the failed action. `browser_access` is read-only and cannot grant access. Frame operations require access to the selected frame and ancestors; whole-tab screenshots, accessibility snapshots and input conservatively require access to all discovered frame origins. Captured blank popups inherit their original opener origin. Discovery can still list tab titles and URLs. These controls gate agent operations; they are not a network firewall for webpage scripts, redirects or subresources.

Separate tabs can execute concurrently, including within one MCP session. Commands targeting the same tab remain ordered. Session start/finish and group changes form barriers for that session. Opening a new tab can proceed while another tab waits. Short focus/group/create mutations serialize separately. Finish drains prior work and prevents later commands from crossing cleanup; Stop cancels queued work immediately. Disconnect and deadlines invalidate queued actions. Chrome can still throttle background pages and serialize work sharing a renderer, so scheduling concurrency does not imply parallel CPU execution.

## Targeting

Pass exactly one `ref`, `selector`, or `locator` for an element target. Click/hover and drag endpoints alternatively accept `x`/`y` coordinates. A target must resolve uniquely; ambiguity is an error, not a request to click the first match.

```json
{"tabId": 42, "locator": {"role": "button", "name": "Save"}}
```

Use that target with `browser_click`. Role/name is matched against Chrome's computed accessibility tree. `name` requires a role. Extra criteria narrow the same element:

```json
{"tabId": 42, "locator": {"role": "textbox", "name": "Email", "testId": "contact-email"}, "text": "person@example.com"}
```

Use that target with `browser_fill`. Other locator criteria are `text`, `label`, `placeholder`, and `testId` (`data-testid`). Criteria combine. `exact` defaults to true after whitespace normalization; `exact: false` uses case-insensitive substring matching, except roles always match as roles. Text-only lookup prefers the innermost matching element.

These convenience text/label matches are not a second full accessible-name implementation. Prefer role/name for computed accessibility semantics. Semantic locators search visible elements in the selected document and open shadow roots. They do not cross into another frame without `frameId`. Use a snapshot reference or a narrower selector on very large/deep pages, and CSS selectors for waits on attached/detached or hidden elements.

`browser_frames` returns frame IDs. Pass `frameId` to snapshot/read/target operations for embedded documents; a fresh reference already identifies its frame. Nested frames and positive scaling are supported for pointer actions. Rotation, skew, flipping and perspective transforms are rejected. Closed shadow roots are not traversed.

## Observation and verification

Read the actual result after an action. For example, use `browser_read` on the field after filling it, `browser_check` for an intended boolean state, and `browser_wait` for a confirmation plus the expected URL:

```json
{"tabId": 42, "urlIncludes": "/settings", "text": "Changes saved", "timeoutMs": 10000}
```

The default wait state is `visible`; `hidden` with `text` waits for absence. Target states also include `attached`, `detached`, `enabled`, and `disabled`. Readiness is at least DOM content loaded unless `loadState: "load"` is requested. Text waits inspect a bounded rendered text result, so a narrowly scoped target is more reliable on long documents. This is observable polling, not automatic retries of arbitrary actions.

For visual controls, inspect a new screenshot before using coordinates. Viewport image pixels map to CSS coordinates by `viewport.width / image.width` and `viewport.height / image.height`. Full-page image pixels use `page.width / image.width` and `page.height / image.height`, then subtract `viewport.pageX`/`pageY`. Scroll and capture again if the point lies outside the viewport. Both drag endpoints must be visible.

The HTTP caller deadline and bridge timeout bound each command; the earlier deadline wins. Queued expired work is rejected. A request timeout, Chrome command timeout, or disconnect may happen after a page mutation completed. Inspect the resulting state before retrying a submission. The transport does not replay dispatched actions on reconnect.

## Diagnostics and emulation

Debugger attachment starts observation, usually on the first page inspection. Opening or claiming a tab alone is not a historical trace. Attach before triggering the behavior you want to investigate. Console records include console messages, exceptions and browser log entries; arbitrary page-generated text may contain personal information.

Network records include method, sanitized URL, resource type, status, completion/failure, redirects and bounded timing/size metadata. URL credentials, query strings and fragments are removed; request/response headers and bodies are never retained. URL paths may still contain private data. These privacy reductions apply to diagnostic network URLs, not to all page text or tool results.

Read `entries`, `nextAfter`, `truncated`, `dropped`, and network `droppedPending`. Pass `nextAfter` as the next `after` cursor to fetch subsequent records. Buffers hold at most 200 entries each; a read returns at most 100 entries and 75 KB. `clear: true` returns the selected result and discards the entire remaining buffer; for network records it also clears pending tracking. Release/detach clears that tab's records.

Example responsive inspection:

```json
{"tabId": 42, "viewport": {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": true}, "colorScheme": "dark", "reducedMotion": "reduce"}
```

Pass this to `browser_emulate`, then inspect/screenshot the resulting page. Width/height are 240–3840 CSS pixels, scale is 1–3, and the total image area is limited to 16 million pixels. `mobile` changes viewport behavior, not the user agent or touch input. Use `{"tabId": 42, "reset": true}` to restore defaults; release, finish and Stop also perform cleanup. This does not prove behavior on a real mobile device.

## Profiling, traces and inspection

All three debugging tools require an ordinary website grant and a separate debugging grant. The UI explains the CPU profile's wider renderer scope before approval. Use an isolated profile if other signed-in pages sharing a renderer might contain sensitive activity.

CPU profiling is **browser-dependent**. The release smoke on Chrome for Testing 148.0.7778.96 captured real CPU samples, chunked profiles and automatic profile stop through the extension. A previously tested Chrome 153 build accepted page/runtime/performance commands but returned method-not-found for Profiler. `browser_profile` maps that rejection to `PROFILE_UNAVAILABLE`; status reports `supported: null` before probing, `false` after rejection, or `true` after successful enable. There is no alternate transport or browser security bypass. Use Chrome DevTools directly for CPU profiling on a restricted browser.

The public source distinguishes the extension client's trust level in [Chromium's debugger API](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/debugger/debugger_api.cc), and [V8 registers Profiler only for fully trusted clients](https://github.com/v8/v8/blob/main/src/inspector/v8-inspector-session-impl.cc). A domain appearing in the general CDP catalog is therefore insufficient evidence of availability through this extension.

The optional CPU capture contract, exercised with protocol tests and applicable only where Chrome permits it, is:

```json
{"tabId": 42, "action": "start", "durationMs": 5000, "samplingIntervalUs": 1000}
```

Trigger the behavior, then call `{"tabId":42,"action":"stop"}`. The response includes a summary, `profileId`, format and file name. Read with `action: "read"`, that ID, and `offset: 0`; concatenate `chunk` strings, advancing to `nextOffset` until `done`. Offsets count UTF-16 code units. Write the concatenated string as UTF-8 JSON to the returned `.cpuprofile` file name, then import it into a compatible profiler. Each read returns at most 12,000 code units. URL credentials, query strings and fragments are removed, but function names and paths can contain sensitive data.

When available, CPU sampling uses public CDP Profiler commands. Its scope is the selected renderer's V8 isolate, which may include other same-process contexts. It excludes out-of-process frames, workers, browser and GPU work. Capture duration is 100–30,000 ms (default 10 seconds), sampling interval is 1,000–10,000 microseconds, and at most four CPU captures run concurrently.

`browser_performance` defaults to `action: "snapshot"`, returning document timing entries and selected renderer counters such as script/layout duration and heap use. Renderer counters may include other contexts. To capture a document timeline, use `action: "start"` with an optional `frameId` and duration, trigger the behavior, then stop. Read the returned `traceId` in chunks as above. The export is Chrome Trace Event JSON on a synthetic document track. It contains supported PerformanceObserver entries such as long tasks, resources, marks, measures, paint and layout shifts. It is not a browser/GPU trace or a JavaScript call-stack trace. Up to eight timelines run concurrently; each retains at most 1,000 events and reports dropped events.

Each tab retains at most one CPU artifact and one trace, within a combined 2 MiB cap; all tabs together have an 8 MiB cap. Oversized CPU graphs fail instead of being silently truncated. Navigation, detach, release, Stop and disconnection invalidate artifacts and active captures. Read exports before cleanup. Captures auto-stop at their deadline; `status` and `clear` inspect or discard state.

`browser_inspect` accepts the same unique target forms as other element tools and an optional list of up to 30 supported CSS properties:

```json
{"tabId":42,"locator":{"role":"button","name":"Save"},"properties":["display","color","width","pointer-events"]}
```

It returns the tag, ID/classes, selected attributes, bounding rectangle, computed styles and interaction state. It does not return HTML, scripts, control values, custom CSS properties or URL-valued styles. See the generated tool schema for the property allowlist.

## Scope and evidence

Immediate action-related popups can join the task and its cleanup, including captured `about:blank` pages. Delayed or uncorrelated popups remain unowned. Existing user tabs remain open on finish; temporary agent tabs close unless retained. Browser restarts clear ownership, and force-killed clients may require the extension's Stop control. One Chrome profile connects to each bridge.

The automated suite and isolated Chromium fixtures exercise these contracts. A release still needs a successful run against its exact source candidate. Hosted CI, additional operating systems, complex production sites and host/model integrations are separate evidence layers. Current implementation and tests should not be described as complete commercial-browser parity, Chrome Web Store availability, or proof for every browser/provider.

For installation, see [README](../README.md). For trust boundaries and release gates, see [SECURITY](../SECURITY.md) and [release preparation](release.md).
