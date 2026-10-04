# Contributing

agent-browser-extension is an independent, provider-neutral browser extension and local bridge. Contributions must be original work or use dependencies with licenses compatible with the project. Do not copy proprietary plugins, prompts, branding, assets, or implementation code. Contributions are made under [Apache-2.0](LICENSE); retain applicable third-party notices.

## Development

Use a supported Node version from `package.json`. Install the exact dependency graph with `npm ci`, then run:

```sh
npm run check
npm test
npm run build
npm run check:release
npx playwright install chromium
npm run test:browser
```

The browser smoke creates a disposable profile and local web fixtures. It must never attach to a developer's personal browser. Use `CHROME_EXECUTABLE` only for a separate Chrome for Testing executable; the profile remains temporary. On Linux, install browser system dependencies with `npx playwright install --with-deps chromium`.

Start the bridge and load the unpacked extension using the [setup instructions](README.md#local-setup). Use a separate browser profile for manual tests. No model account or paid API is needed for the test suite.

## Design rules

- Discover existing tabs automatically. A manual tab picker must never be required.
- Separate user tabs from agent scratch tabs. Cleanup releases user tabs and closes only unretained scratch tabs.
- Require session ownership before controlling a tab. Preserve revocation, deadlines, and isolation between competing sessions.
- Keep browser control on the user's machine. Never expand network binding or origin acceptance without a threat-model review.
- Use public Chrome extension and DevTools Protocol APIs. Keep the bridge protocol independent of model providers and host applications.
- Return explicit limitations and errors. Do not silently choose among ambiguous targets or reuse stale references after navigation.

For a new tool, update its schema/catalog entry, protocol validation, implementation, relevant behavioral tests, and documentation together. Test both successful actions and failures that could affect another tab or session. Real-browser verification matters for focus, accessibility, frames, dialogs, screenshots, and downloads; mocks alone cannot prove those behaviors.

## Reviewable changes

Describe the user-visible trigger and resulting behavior, test evidence, and known limits. Keep changes scoped enough to review. For a bug report, include browser/OS/Node versions and a minimal public page or local fixture; omit private URLs, credentials, profile files, screenshots with personal data, and full agent transcripts.

`dist/`, `test-results/`, profiles, connection files, and dependency directories are local artifacts. The source-release checks reject unexpected file types or private material inside the source allowlist. See [release preparation](docs/release.md) before adding new file types or dependencies.

Report suspected security vulnerabilities using [SECURITY.md](SECURITY.md), rather than an issue containing exploit details or credentials.
