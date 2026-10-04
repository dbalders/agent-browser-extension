# Security policy

This is pre-release software. Security fixes target the current maintained source; no older-version support schedule or response-time guarantee has been established.

## Reporting

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/dbalders/agent-browser-extension/security/advisories/new). This route is for security issues; use [GitHub Issues](https://github.com/dbalders/agent-browser-extension/issues) for ordinary bugs and setup questions. Do not publish secrets or exploit details in a public issue.

Include the affected version, operating system and Chrome version, minimal reproduction using a disposable profile, expected boundary, observed result, and likely impact. Redact connection tokens, cookies, private URLs, page content, and filesystem paths. A reproducible local fixture is preferable to access to a real account.

## Trust boundaries

The extension controls the Chrome profile where it is installed. An authorized agent may read pages, use authenticated sessions, execute page JavaScript, upload specified local files, and trigger downloads. The connection code is a credential granting this control. Session IDs coordinate trusted clients; they are not independent authentication credentials or an isolation boundary against another client holding the same connection code.

The bridge binds to loopback. HTTP calls require a bearer token and accepted local host/origin; the extension WebSocket requires a token and a Chrome-compatible extension origin. This prevents ordinary websites from freely using the bridge, but does not defend against malware or an untrusted process running as the same operating-system user. On POSIX, the connection directory/file require modes 700/600; Windows protection relies on the current user's filesystem permissions.

There is no hosted browser service or project telemetry collector. A connected agent or model provider may receive tool results, page text, screenshot images, or other data requested by the task. Its retention and privacy behavior is outside this project's control. Use a separate browser profile when evaluating agents you do not fully trust.

Page content is untrusted. Prompt-injection defenses and authorization for purchases, messages, account changes, or sharing data belong to the agent host and user workflow. Tab ownership and cleanup are not a policy engine for deciding which website actions are appropriate.

## Stopping access

Website access defaults to ask-first and is configured only through the extension popup or connection screen. Grants cover exact origins, with separate debugging permission. Task grants are memory-only; persistent grants are stored locally. Revoking access invalidates in-flight result delivery and detaches affected tabs. A mutation already delivered to Chrome may have taken effect before revocation; it cannot be undone by the gate. Session IDs do not isolate mutually untrusted clients sharing the bridge credential.

These controls gate the provided agent commands, not the website's own scripts, redirects, subresource traffic or same-origin reach. Tab discovery still returns titles and URLs. Whole-tab observations and input conservatively require grants for discovered frame origins, but permission checks are not a browser process sandbox. A CPU profile may include other contexts sharing the selected renderer's V8 isolate. Debugging requires explicit approval even when ordinary access is allowed globally. Use an isolated browser profile when that wider scope is inappropriate.

Use **Stop all tasks** to revoke running sessions and clean up unretained agent tabs. Use **Disconnect** to disable extension reconnection, and stop the local bridge to disable API access. To replace a possibly exposed connection code, stop all bridge/client processes, disconnect the extension, remove the configured `connection.json`, start the bridge, and pair again. Do not remove the file while a bridge process is still running. Existing user tabs and retained deliverables stay open.

## Extension permissions

| Permission | Purpose |
| --- | --- |
| `tabs`, `tabGroups` | Discover, create, group, and track task tabs |
| `debugger` | Snapshots, input, screenshots, page execution, and other public CDP operations |
| `storage`, `alarms` | Local connection/session state and reconnect scheduling |
| `downloads` | Observe and attribute downloads initiated by agent actions |
| `webNavigation` | Track document changes and invalidate stale references |
| Loopback host permission | Connect to the local bridge |

The debugger permission is powerful, even though the extension's host permission is limited to loopback. Chrome shows its own attachment indicator. The supported operation catalog, website controls, tab ownership, and protocol validation constrain the provided agent interface; arbitrary CDP passthrough is not exposed. CPU captures and document traces have bounded duration and memory, and are discarded on navigation/detach. Diagnostic URL sanitization does not remove secrets from arbitrary console text, performance mark names, function names or URL paths.

## Release checks and limits

The local source checker inspects only files eligible for the source archive, without sending source or credentials to a scanning service. It checks known secret patterns, personal absolute paths, unexpected files, symlinks, package metadata, and lockfile license/integrity records. Pattern checks do not establish that all secrets are absent. They do not inspect repository history, dependencies' source, generated output, vulnerability advisories, or a live deployment. Review those separately as appropriate to the distribution being released.
