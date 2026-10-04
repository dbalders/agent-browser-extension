# Pocket agent

Pocket agent is the selected logo and mascot for **agent-browser-extension**, maintained by David Balderston. The project name stays `agent-browser-extension`; the mascot name is not a product rename.

![Pocket agent](pocket-agent.png)

## Assets

- `pocket-agent.png`: the selected transparent 1254×1254 master, preserved unchanged from the approved concept.
- `../../extension/icons/icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`: PNG exports used by Chrome and the extension screens.
- Default interface accent: burnt orange `#b94b16`. The artwork retains its apricot, cream, and brown palette.

The full character is used at every size to preserve the selected design. Fine face and body details become less visible at 16 pixels; the browser-head shape and orange silhouette carry the small icon. The toolbar exports remove excess transparent space so the character fills more of the small canvas; the 128-pixel icon retains more padding for the store. Do not change the character's proportions or add a colored tile behind it.

## Exporting

The committed icon files are ready to use; ordinary builds need no image tools. These exports were made with macOS `sips`, cropping only transparent space and scaling the selected PNG without redrawing the character:

```sh
for size in 16 32 48 128; do
  canvas=940
  if [ "$size" = 128 ]; then canvas=1096; fi
  sips -c "$canvas" "$canvas" docs/brand/pocket-agent.png \
    --out "extension/icons/icon${size}.png"
  sips -z "$size" "$size" "extension/icons/icon${size}.png"
done
```

The release checker accepts only these exact image paths and reviewed SHA-256 digests. Re-exported or edited artwork must be visually checked before updating `scripts/check-release.mjs`. Other PNGs and screenshots remain excluded from source releases. Review on both light and dark backgrounds and at native toolbar sizes.

Chrome's [icon declarations](https://developer.chrome.com/docs/extensions/reference/manifest/icons) and [store image guidance](https://developer.chrome.com/docs/webstore/images) describe the intended sizes and transparent padding. Use `extension/icons/icon128.png` for the store icon.

## Provenance

Created for this project with the built-in imagegen tool and selected by the maintainer on 2026-10-03. Export resizing uses the selected artwork unchanged. This is a PNG master; no vector master is claimed.

Generation prompt:

> Use case: logo-brand. Design one original gently cute robot mascot logo for agent-browser-extension, a local browser automation agent. A very small squat helper bot with an OVERSIZED BROWSER WINDOW for its head, a tiny rounded body and two short rounded feet. Browser head is warm apricot with a deep brown outline, two raised browser tabs, and a thin cream browser toolbar containing one short address-bar dash. The screen-face below the toolbar is cream, with two simple small dark dot eyes and one confident tiny curved smile; restrained rosy cheeks. One short mitten arm is lifted in a small friendly wave, other arm rests at its side. On the tiny body is ONE simple puzzle-piece-shaped cream badge, a subtle cue to browser extensions. Keep head around 75 percent of the total character, everything compact. This is an original useful little agent, appealing and capable, not a baby, not a known character. Flat clean 2D logo, bold simple shapes, softly squared corners, no fussy fingers, no antenna, no separate accessories. Palette apricot orange, warm cream, deep brown. Single centered character on true transparent square background with clear padding. No words, initials, watermarks, sparkles, gradients, lighting, shadow, texture or 3D. Browser framing and face must read clearly at 32px.
