import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("extension/manifest.json", root), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("The browser extension must use Manifest V3.");
// Branding changes presentation only. The bridge protocol and provider integrations stay portable.
const displayName = process.env.BROWSER_DISPLAY_NAME?.trim() || manifest.name;
if (displayName.length > 45 || /[\r\n\u0000-\u001f]/u.test(displayName)) throw new Error("BROWSER_DISPLAY_NAME must be a single line of at most 45 characters.");
const brandColor = process.env.BROWSER_BRAND_COLOR || '#b94b16';
if (!/^#[0-9a-f]{6}$/iu.test(brandColor)) throw new Error('BROWSER_BRAND_COLOR must be a six-digit hex color.');
manifest.name = displayName;
manifest.action.default_title = displayName;
manifest.description = `Connect your Chrome tabs to a local ${displayName} bridge.`;
const defaultPrivacyUrl = 'https://github.com/dbalders/agent-browser-extension/blob/main/docs/privacy.md';
let privacyUrl;
try {
  privacyUrl = new URL(process.env.BROWSER_PRIVACY_URL ?? defaultPrivacyUrl);
  if (privacyUrl.protocol !== 'https:' || privacyUrl.username || privacyUrl.password) throw new Error();
} catch {
  throw new Error('BROWSER_PRIVACY_URL must be an absolute HTTPS URL without embedded credentials.');
}
const iconPath = process.env.BROWSER_ICON_PATH;
let icon;
if (iconPath) {
  icon = await readFile(iconPath);
  if (icon.length < 24 || icon.length > 1024 * 1024 || icon.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || icon.readUInt32BE(16) !== 128 || icon.readUInt32BE(20) !== 128) throw new Error('BROWSER_ICON_PATH must point to a 128×128 PNG under 1 MB.');
}
// Validate replacements before discarding the previous build; always rebuild from the source templates.
await rm(new URL("dist/extension/", root), { recursive: true, force: true });
await mkdir(new URL("dist/extension/", root), { recursive: true });
await cp(fileURLToPath(new URL("extension/", root)), fileURLToPath(new URL("dist/extension/", root)), { recursive: true });
for (const file of ['LICENSE', 'NOTICE']) await cp(new URL(file, root), new URL(`dist/extension/${file}`, root));
if (icon) {
  await rm(new URL('dist/extension/icons/', root), { recursive: true, force: true });
  await writeFile(new URL('dist/extension/brand-icon.png', root), icon);
  manifest.icons = { '128': 'brand-icon.png' };
  manifest.action.default_icon = { '128': 'brand-icon.png' };
}
await writeFile(new URL("dist/extension/manifest.json", root), `${JSON.stringify(manifest, null, 2)}\n`);
const escapeHtml = value => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
for (const file of ['options.html', 'popup.html']) {
  const target = new URL(`dist/extension/${file}`, root);
  const html = (await readFile(target, 'utf8'))
    .replaceAll('<title>agent-browser-extension', `<title>${escapeHtml(displayName)}`)
    .replaceAll('<h1>agent-browser-extension</h1>', `<h1>${escapeHtml(displayName)}</h1>`)
    .replaceAll(defaultPrivacyUrl, escapeHtml(privacyUrl.href));
  await writeFile(target, iconPath ? html.replace('src="icons/icon128.png"', 'src="brand-icon.png"') : html);
}
const stylesheet = new URL('dist/extension/ui.css', root);
await writeFile(stylesheet, (await readFile(stylesheet, 'utf8')).replaceAll('#b94b16', brandColor));
const background = new URL('dist/extension/background.js', root);
await writeFile(background, (await readFile(background, 'utf8')).replaceAll('#B94B16', brandColor));
process.stdout.write("Extension packaged in dist/extension\n");
