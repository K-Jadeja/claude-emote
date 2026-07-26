# Overlay Control Click Started a Window Drag

Date: 2026-07-27

## Impact

Clicking the pause control during native visual QA moved the pet window instead
of reliably activating the button.

## Root cause

The native draggable-region listener is attached to the pet root. Although the
controls were supplied as a Neutralino exclusion, the pointerdown still reached
the root in the tested WebView2 path and started `window.beginDrag`.

## Fix

The controls explicitly stop `pointerdown` propagation before the event can
reach the draggable root. Click still fires normally on the target button.

## Regression coverage

`tests/unit/pointer-guard.test.ts` captures the installed pointer listener and
requires it to call `stopPropagation()` for the exact event that previously
started a window drag.

## Prevention

Every interactive child added inside the draggable surface must live inside the
guarded controls region or install the same pointerdown guard.

