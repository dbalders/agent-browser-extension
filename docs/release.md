# Release process

The current deliverable is buildable source for an unpacked extension and a local bridge. The public repository is [dbalders/agent-browser-extension](https://github.com/dbalders/agent-browser-extension). Preparing a source archive does not itself create a GitHub release, publish an npm package, or submit a Chrome Web Store listing. `package.json` remains private to prevent accidental npm publication.

## Reproducible local candidate

Run the project checks from the intended source directory:

```sh
npm ci
npm run check
npm test
npm run build
npm run check:release
npx playwright install chromium
npm run test:browser
npm run package:source
```

The source packager writes these local artifacts under the ignored `test-results/release/` directory:

- `agent-browser-extension-<version>-source.tar.gz`: allowlisted source, tests, docs, CI, package metadata, license and notice.
- `SHA256SUMS`: archive digest for transfer verification.
- `RELEASE-MANIFEST.json`: every included source path, byte count, SHA-256 digest, and locked dependency version/license/integrity record. The manifest is also inside the archive.

The archive has sorted entries, fixed timestamps, normalized file modes and no machine-specific ownership. Re-running it on identical source bytes and the same Node/zlib implementation produces the same digest. It packages the bytes that passed inspection, so subsequent file changes cannot slip into that candidate. No Git command is executed and no history is included.

The allowlist contains explicit top-level project files and these text-only directories: `src/`, `extension/`, `tests/`, `scripts/`, `docs/`, and `.github/workflows/`. Credentials, profiles, screenshots, logs, dependency folders and build output outside this list are never read or copied. Unexpected files and symlinks inside the allowlist fail the check. Adding a new source format requires a reviewed allowlist change in `scripts/check-release.mjs`.

Unpack the archive into a new directory and repeat install, check, tests, build, and isolated browser smoke there. This proves the published source can work without unrelated files from the development checkout. Keep the resulting command output and archive digest with the private release evidence until the owner approves distribution. Review the candidate's contents before sharing.

## Dependency and provenance review

The project retains Apache-2.0 and its `NOTICE`. The source candidate does not vendor `node_modules` or browser binaries. `npm ci` installs packages with their own licenses. The checker requires public npm registry URLs, SHA-512 integrity and an explicit license decision for every locked dependency. Current accepted runtime licenses are MIT, ISC, BSD-2-Clause, BSD-3-Clause and Apache-2.0. MPL-2.0 is permitted for development-only packages; currently it comes from Lightning CSS and platform packages. Unknown or changed licenses stop packaging for review.

The dependency inventory is not a vulnerability scan or a legal opinion. A binary bundle or vendored distribution needs its own third-party license texts/notices and dependency review. Independently confirm rights to contributed source and any optional logos before publication. Do not use proprietary browser implementation code or imply endorsement by browser/model vendors.

## CI scope

The workflow checks supported Node majors on Linux, with additional macOS and Windows jobs. It installs the lockfile, type-checks, runs tests, builds, and checks release hygiene. A separate Linux job runs the real extension with Playwright's isolated Chromium profile, then creates and independently extracts a source archive for install/check/test/build verification. The workflow requests read-only repository access, persists no checkout credential, and publishes no artifacts or packages.

Actions are pinned to verified release commits: [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) and [setup-node v7.0.0](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020). [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) explains immutable pins and minimal permissions. The headless extension smoke follows [Playwright's Chromium extension guidance](https://playwright.dev/docs/chrome-extensions). Update pins deliberately and rerun CI when dependencies or runner environments change.

CI configuration is not evidence of a successful hosted run. Local macOS success does not establish Windows/Linux browser behavior. Record the exact runtime, platform, and browser used for each release's evidence.

## Publication checklist

1. Use the public name `agent-browser-extension` and the personal repository `dbalders/agent-browser-extension`. Do not use third-party branding without authorization.
2. Verify [private vulnerability reporting](https://github.com/dbalders/agent-browser-extension/security/advisories/new) is enabled and [Issues](https://github.com/dbalders/agent-browser-extension/issues) is available for support.
3. Review the source candidate, dependency inventory and every Git object being published. The initial release uses a fresh source snapshot; private development history and local checkpoint refs are not published.
4. Require passing hosted checks for the exact release commit. The workflow exercises Node 22, 24 and 26 on Linux and Node 24 on macOS/Windows; real-browser smoke runs on Linux. Record additional local browser evidence separately.
5. Create a version tag and GitHub prerelease with the inspected source archive, `RELEASE-MANIFEST.json`, `SHA256SUMS`, setup instructions and release notes. Read back public visibility, tag commit and downloaded asset checksums.
6. Store submission and npm publication are separate operations. The first source release does not claim a Chrome Web Store listing or published npm package. See [store preparation](chrome-web-store.md).

Feature claims must describe observed behavior. Tool count, unit tests, or a successful local smoke do not prove parity with every commercial browser agent or compatibility with every model provider.
