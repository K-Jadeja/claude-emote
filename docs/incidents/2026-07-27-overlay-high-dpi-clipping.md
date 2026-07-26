# Overlay High-DPI Clipping

Date: 2026-07-27

## Impact

The first native overlay run clipped the activity label, session line, and
controls on a Windows display set to 125% scaling.

## Root cause

Neutralino created the configured 272 by 324 window in physical pixels.
WebView2 reported a 1.25 device-pixel ratio and therefore exposed a smaller CSS
viewport. The UI correctly occupied 272 by 324 CSS pixels, but the native
surface could display only roughly 218 by 259 of them.

## Fix

After the native API becomes ready, the shell sets the physical window size to
the design dimensions multiplied by `window.devicePixelRatio`. The view stays
272 by 324 CSS pixels at 100%, 125%, and 150% scaling.

The permission allowlist explicitly contains `window.getSize` and
`window.setSize`; the Neutralino client reads the existing size before applying
a partial size update.

## Regression coverage

`tests/unit/desktop-shell-source.test.ts` locks the design dimensions,
device-pixel-ratio calculation, and native API permissions. Native visual QA
must still be repeated at more than one Windows display scale before release.

