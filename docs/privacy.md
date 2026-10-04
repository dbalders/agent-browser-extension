# Privacy and data handling

Effective date: October 3, 2026. Maintainer: David Balderston. Applies to agent-browser-extension and its local bridge.

## What the software accesses

This extension lets an agent you connect use Chrome on your computer. Depending on the commands you authorize, it can discover tab titles and URLs, read website content and form state, capture screenshots, execute page JavaScript, interact with signed-in websites, upload files you specify, and observe task downloads. Debugging tools can capture console messages, network metadata, performance entries, and element styles. Some observations can contain personal or sensitive information.

Website access starts in Ask first mode. You can allow an exact website for a task, save a permission, block it, or revoke access. Debugging needs a separate permission. Tab discovery still returns titles and URLs before a website grant. The controls govern agent commands; they do not control the website's own scripts or network activity.

## Where data goes

The extension connects to a bridge on the same computer over loopback. The project operates no hosted browser service, analytics collector, advertising service, or telemetry endpoint. It does not send browsing data to the maintainer and does not sell that data.

Requested tool results are returned to your connected agent. Its host application may send page content, screenshots, or other results to a model provider or another service you configure. Those recipients, their retention, and their data-use policies depend on your agent setup. Review that setup before granting access to private websites. Actions on a website also communicate with that website in the normal way.

## Local storage and retention

- Chrome local extension storage holds bridge connection settings, the connection credential, and saved website permissions. These settings are not stored with Chrome's sync storage API.
- Task ownership uses Chrome session storage. Task grants and diagnostic captures are temporary; browser restarts clear session ownership. Diagnostic buffers are bounded and captures are discarded when the relevant document changes or the tab detaches.
- The bridge keeps its credential in `~/.agent-browser-extension/connection.json`, or the directory you specify. It persists across restarts so pairing continues to work. POSIX directory/file modes are restricted to 700/600; Windows relies on your account's filesystem permissions.
- Agent transcripts, screenshots saved by a client, exported diagnostics, downloaded files and uploaded source files are controlled by their respective applications and filesystem locations. Ending a browser task does not delete those copies.

## Your controls

Use **Stop all tasks** to revoke running tasks and clean up temporary agent tabs while preserving existing user tabs and retained results. Use **Disconnect** to stop automatic extension reconnection, and stop the bridge to disable API access. Disconnecting keeps the saved connection settings and permissions. Revocation cannot undo a website action already performed.

To remove extension settings, uninstall the extension from Chrome. To remove the bridge credential, first stop the bridge and its clients, disconnect the extension, and delete the configured `connection.json`. Delete client transcripts, saved files or provider data using the controls offered by those applications. See [security](../SECURITY.md) for credential replacement and trust boundaries.

## Contact and changes

For general questions, use [GitHub Issues](https://github.com/dbalders/agent-browser-extension/issues) without including private browsing data. Report security vulnerabilities using the [private reporting form](https://github.com/dbalders/agent-browser-extension/security/advisories/new).

Changes to these practices will be documented here and in release notes. Material changes to data access or sharing will also be disclosed in the extension before the changed behavior is enabled.
