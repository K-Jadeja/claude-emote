# GitHub visuals

Created and inspected on 2026-10-02. All final assets are in `docs/assets/`.

| Asset | Source |
| --- | --- |
| `github-cover.png` | AI-generated promotional artwork; built-in imagegen, with the existing Aza sprite as the character reference |
| `demo-gallery.png` | Browser screenshot of four instances of the actual built demo UI, presented in a documentation wrapper |
| `demo-cycle.gif` | 45 screenshots of the actual demo UI, encoded as a nine-second looping GIF |
| `native-ready.png` | Unedited screenshot of the packaged Windows application in its ready demo state |
| `native-thinking.png` | Unedited screenshot of the packaged Windows application in its thinking demo state |

The cover is illustrative, not a screenshot. The demo captures use synthetic
events and make no Claude model calls. Character artwork and the underlying
sprite animation retain the upstream attribution in `THIRD_PARTY_NOTICES.md`.

## Visual QA

- Native window visible, sprite and caption fit within the window.
- Native pause/resume label changes and next-pose button verified.
- Native ready/thinking captures inspected for clipping and incorrect labels.
- Browser demo checked through all nine poses, with images decoded and no fatal
  UI state. The GIF includes greeting, idle, thinking, reading, writing, tools,
  response, compaction, and failure.
- Gallery inspected at 1280 pixels: no clipping, browser chrome, or scrollbars.
- Native drag gestures did not change the reported origin; this remains an
  explicit acceptance item in `GITHUB_PUBLICATION.md`.

## Reproduce the app captures

```powershell
npm run build
npm run overlay:package
node scripts/smoke-native-overlay.mjs
node scripts/preview-github-visuals.mjs
```

The preview prints a loopback URL. Open it in a browser at a 1400x700 viewport.
The wrapper loads the unmodified `desktop/resources/` UI in four 272x324 frames.
Use each frame's real Pause and Next pose controls to select thinking, reading,
writing, and resting. Click the wrapper heading to remove button focus, move
the pointer away, and capture the wrapper's `main` element.

For the animated capture, pause one frame and step through the nine poses with
the Next pose control. Capture five frames per pose at 200 ms intervals, then
encode the PNG sequence:

```powershell
ffmpeg -framerate 5 -i '.tmp/demo-frames/frame-%03d.png' -filter_complex 'split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none' -loop 0 'docs/assets/demo-cycle.gif'
```

Use native window capture for native QA screenshots. Keep screenshots limited
to the pet window so private desktop content does not enter repository assets.

## Cover-generation prompt

Tool: built-in `image_gen` (no API/CLI fallback).
Reference: `emotes/default/hi/hi1.png`.

> Use case: ads-marketing. Create a polished wide GitHub README cover illustration for the open-source developer project named exactly "claude-emote". Use the attached image only as a character identity and pixel-art style reference: Aza, the teal bob-haired character with a tiny gold hair clip and dark plum high-collared outfit. Preserve recognizable hair, face, and outfit. This is promotional artwork, NOT a fake application screenshot. A sophisticated, calm retro-computing editorial banner, wide landscape approximately 3:1. Deep ink/navy canvas inspired by the reference, fine sparse terminal-grid lines, restrained warm amber accents and teal character colors. Large carefully typeset lowercase title exactly "claude-emote", smaller readable line exactly "A little company while you code.". Character is joyfully waving beside the typography, integrated with crisp intentional pixel art; a subtle amber frame motif echoes an always-on-top desktop companion. Plenty of breathing room. Beautiful visual hierarchy, premium indie open-source personality, legible at GitHub README width. No extra copy, no claims or badges, no logos of Anthropic or OpenAI, no fake terminal output, no watermarks. Only the two requested text strings.
