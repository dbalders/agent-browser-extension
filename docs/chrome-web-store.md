# Chrome Web Store preparation (deferred)

Chrome Web Store publication is deferred. The current release path is public GitHub source, an unpacked Chrome extension, and the local bridge. The drafts below are retained for a future store launch; they are not part of the active release checklist.

This deferral applies to the upstream project. Forks can use [branded builds](branding.md) and adapt these drafts for their own publisher account, product name, logo and privacy policy.

The source release and store publication are separate. No Chrome Web Store listing or approval is claimed by these files.

## Listing draft

- Name: **agent-browser-extension**
- Owner: **David Balderston**
- Short description: **Connect AI agents to your Chrome tabs through a local browser bridge.**
- Single purpose: **Let a user-authorized agent perform browser tasks in the user's Chrome profile through an authenticated local bridge, with website approvals, task visibility and Stop controls.**
- Support: <https://github.com/dbalders/agent-browser-extension/issues>
- Privacy: <https://github.com/dbalders/agent-browser-extension/blob/main/docs/privacy.md>

Suggested description:

> Connect an MCP-compatible agent or HTTP client to Chrome on your computer. Agents can discover existing tabs, open background task tabs, read pages, interact with forms, capture screenshots and return results. Website access starts with your approval, debugging needs a separate grant, and visible task controls let you stop work. Cleanup preserves your existing tabs and results marked to keep.
>
> Requires a separate local Node.js bridge and compatible agent application. The extension does not include an AI model. Connected agents may send requested page content and screenshots to their configured model providers. Read the setup and privacy guides before connecting private accounts.

## Permission justifications

| Permission | Purpose |
| --- | --- |
| `tabs` | Discover existing tabs and track their ownership, titles and URLs for authorized tasks. |
| `tabGroups` | Group agent-created tabs by task and keep them separate from user tabs. |
| `debugger` | Use public Chrome DevTools Protocol operations for snapshots, input, screenshots, page execution and bounded diagnostics on task-owned tabs. |
| `storage` | Keep pairing settings and saved website grants locally, and task ownership in session storage. |
| `alarms` | Schedule reconnection to the user's running local bridge. |
| `downloads` | Observe and attribute downloads initiated by agent tasks. |
| `webNavigation` | Invalidate stale document references and attribute navigation-created task tabs. |
| `http://127.0.0.1/*` | Reach the authenticated browser bridge on the same computer. |

The extension accepts agent-provided page JavaScript through the local bridge and executes it using the Debugger API. Explain this accurately in the remote-code declaration, including how bundled command handlers, ownership and website controls constrain the interface. The [Manifest V3 policy](https://developer.chrome.com/docs/webstore/program-policies/policies#additional-requirements-for-manifest-v3) has a scoped Debugger API exception; it is not a guarantee of approval.

Data declarations must account for tab URLs/titles, website content, screenshots, user-requested files and diagnostic data passed to the connected agent. The absence of a maintainer-operated telemetry service does not mean the extension handles no user data. Review declarations against [privacy and data handling](privacy.md) and the final shipping build.

## Reviewer setup

1. Install a supported Node.js version and download the source archive matching the submitted extension version.
2. Run `npm ci`, `npm run build`, and `node dist/cli.js serve`. Leave the bridge running locally.
3. In a second terminal, run `node dist/cli.js pair`; use the printed port and connection code in the submitted extension's connection screen. A maintainer account, model subscription or shared credential is not required.
4. Run `node dist/cli.js status` to confirm the connection. Run `node dist/cli.js setup` to get an MCP client configuration if reviewing with a compatible agent.
5. For automated feature verification without an AI provider, run `npx playwright install chromium` and `npm run test:browser`. The test creates a separate browser profile and local fixtures; it never uses personal browser data.
6. Test website approval, a task-created tab, Stop and Disconnect. Do not send reviewers a personal connection credential or a browser profile.

## Selected brand assets

The selected logo is **Pocket agent**, the orange browser-window helper. The project name remains **agent-browser-extension**. The default build includes the approved mascot in the popup and connection page and in its 16, 32, 48 and 128-pixel extension icons. Use `extension/icons/icon128.png` for the store icon. See [brand assets](brand/README.md) for the original artwork and export instructions.

## Only if store publication is resumed

- Produce store screenshots and the required 440×280 promotional image from the shipping interface.
- Package only the built extension directory as a ZIP, with `manifest.json` at its root; inspect the archive contents.
- Configure the publisher account and required account verification; complete accurate privacy, permission, remote-code and distribution fields.
- Test the exact ZIP and published bridge download on a clean machine/profile, including pairing, restart, Stop, uninstall and update instructions.
- Submit only the selected final candidate after the owner requests store submission.

Official references: [publication](https://developer.chrome.com/docs/webstore/publish), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), and [images](https://developer.chrome.com/docs/webstore/images).
