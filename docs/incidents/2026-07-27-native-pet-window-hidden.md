# Native pet process running but window hidden

Date: 2026-07-27  
Status: fixed

## User-visible symptom

Running `claude-emote` started Claude Code and showed the pet icon in the
taskbar, but no avatar was visible. Neutralino printed a missing
`/resources/favicon.ico` warning.

## Root causes

The launcher passed `windowsHide: true` when spawning the Neutralino GUI. On
Windows this sets hidden-window startup state for the native child. Neutralino
could still create its WebView, taskbar entry, and authenticated readiness
request while the actual window stayed hidden.

After that was removed, production-shaped testing exposed a second visibility
failure: `useSavedState` could restore a position near the display edge, then
the shell enlarged the native surface for high-DPI rendering. The resized
window could end up mostly or entirely outside the available display.

The favicon warning was independent but misleading. WebView2 requested the
conventional resource even though the app icon was a valid PNG elsewhere.

## Fix

- Native GUI children explicitly use `windowsHide: false`.
- The shell calls `window.show()` and verifies `window.isVisible()` before
  connecting the session.
- Saved positions are preserved when valid and clamped after DPI-aware sizing
  when they would leave the pet outside the current screen.
- The resource build creates a standards-compliant ICO containing the
  configured PNG and links it from the document.

## Regression coverage

Tests prove the overlay spawn cannot regress to hidden-window startup, the
native allow-list and show/visibility calls remain present, high-DPI
right/bottom and top/left positions are repaired exactly, and each resource
build emits a valid ICO header with an embedded PNG.

## Repeatable rule

Process health is not visual readiness. A desktop companion is ready only after
its native window is shown, reported visible, positioned on-screen, connected
to authoritative state, and has decoded its current frame.
