# agent-browser-extension

An independent, provider-neutral Chrome extension and local browser bridge for autonomous agent tasks.

Use only original code, public Chrome APIs, and appropriately licensed dependencies. Do not copy proprietary browser plugins, prompts, assets, or implementation code.

The agent discovers existing tabs and creates its own background tabs. A manual tab picker must never be required. Keep user-owned tabs separate from agent-created scratch tabs. Session completion releases the former and closes only unretained scratch tabs. Browser control stays on the user's machine.

Use `npm run check`, `npm test`, and `npm run build`. Tests should exercise behavior, including competing sessions, disconnection, malformed requests, stale page references, cleanup, and authentication failures. Keep test profiles and test browsers isolated from the user's browser.

Keep credentials, connection files, browser profiles, generated builds, and screenshots out of Git. Document actual setup and limitations. A public source release is not a Chrome Web Store publication.
