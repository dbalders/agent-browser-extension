# Branded builds for forks

The upstream project is `agent-browser-extension`, maintained by David Balderston, with Pocket agent as its default mascot. A fork can give the packaged extension its own product name, logo, colors and privacy link, then distribute it through its own publisher account. No organization-specific code or model-provider integration is required.

## Build settings

| Environment variable | Changes | Default |
| --- | --- | --- |
| `BROWSER_DISPLAY_NAME` | Extension name, description, toolbar title, popup and connection-page headings and titles. One line, at most 45 characters. | `agent-browser-extension` |
| `BROWSER_ICON_PATH` | Extension and screen logo. Path to a valid 128×128 PNG under 1 MB; relative paths resolve from the build command's working directory. | Pocket agent icons |
| `BROWSER_BRAND_COLOR` | Buttons, checkbox accent and toolbar badge. A six-digit hex color. | `#b94b16` |
| `BROWSER_PRIVACY_URL` | Privacy link in the popup and connection page. An absolute HTTPS URL without embedded credentials. | Upstream privacy document |

Only name and logo are needed for a basic rebrand. Color and privacy link can be supplied for the publisher's deployment. The build preserves the upstream privacy URL when only a name is changed.

Keep a fork's input logo outside `dist/`, which is rebuilt from scratch. The examples assume a supplied file at `branding/logo.png`.

macOS or Linux:

```sh
npm ci
BROWSER_DISPLAY_NAME="Example Browser" \
BROWSER_ICON_PATH="./branding/logo.png" \
BROWSER_BRAND_COLOR="#4353d8" \
BROWSER_PRIVACY_URL="https://example.com/privacy" \
npm run build
```

PowerShell:

```powershell
npm ci
$env:BROWSER_DISPLAY_NAME = "Example Browser"
$env:BROWSER_ICON_PATH = "./branding/logo.png"
$env:BROWSER_BRAND_COLOR = "#4353d8"
$env:BROWSER_PRIVACY_URL = "https://example.com/privacy"
npm run build
```

The output is `dist/extension/`. A custom-logo build uses `brand-icon.png` and excludes the default mascot icon directory. Both screen headers and both manifest icon declarations point to the custom image. Chrome scales the supplied 128-pixel image for smaller contexts; inspect its toolbar rendering. The package includes the project's `LICENSE` and `NOTICE` files.

Branding does not modify source templates, the npm package name, the bridge command, its private connection-directory location, the MCP tool names, or browser-control behavior. Builds remain compatible with the common local bridge. Users still need that bridge even when the extension is installed from a store.

## Verify and package

1. Load `dist/extension` through Chrome's **Load unpacked** action in a test profile. Check the toolbar, popup, connection screen, privacy link, pairing, website approval and Stop controls.
2. Run `npm run test:browser` with the same branding variables. This command rebuilds before testing, so omitting the overrides would test the default brand. The test uses a disposable browser profile and local fixtures.
3. Create a fresh ZIP containing the contents of `dist/extension`. Its root must contain `manifest.json`, rather than a surrounding `extension` directory.

macOS or Linux, from the repository root:

```sh
test ! -e dist/extension.zip &&
  (cd dist/extension && zip -r ../extension.zip .)
```

PowerShell, from the repository root:

```powershell
Compress-Archive -Path dist/extension/* -DestinationPath dist/extension.zip
```

Use a fresh output filename or move an existing ZIP aside first; the commands above refuse to overwrite one. Updating a ZIP in place can retain assets from a previous brand. Inspect the fresh ZIP and test its extracted contents before distributing it. A fork's store listing, screenshots, privacy declarations and publisher account are managed separately; see the [store preparation reference](chrome-web-store.md). Building a ZIP does not submit or publish it.

The upstream source-archive allowlist covers the upstream source and reviewed Pocket agent assets. A fork that also distributes a source archive containing additional branding files should explicitly review and add those files to its own source-release allowlist.

## Restore the default build

Unset the four branding environment variables, then run `npm run build`. The clean build restores Pocket agent and removes the previous custom logo. The one-command macOS/Linux example scopes its variables to that invocation; in PowerShell they remain set until removed:

```powershell
Remove-Item Env:BROWSER_DISPLAY_NAME, Env:BROWSER_ICON_PATH, Env:BROWSER_BRAND_COLOR, Env:BROWSER_PRIVACY_URL -ErrorAction SilentlyContinue
npm run build
```
