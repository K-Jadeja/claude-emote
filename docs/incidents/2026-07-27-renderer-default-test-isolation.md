# Renderer default test-isolation failure

Date: 2026-07-27  
Status: fixed

## Symptom

The complete suite failed every Windows Terminal process test after desktop
mode became the Windows default. Focused launcher tests had passed.

## Root cause

The older terminal suites simulated Windows and supplied a fake `wt.exe`, but
did not explicitly select the terminal renderer. The product correctly chose
the new desktop default, so those tests never invoked their fake terminal.

## Fix and prevention

Renderer-specific process suites now set `CLAUDE_EMOTE_RENDERER=terminal` or
`desktop` explicitly and restore the previous environment afterward. Platform
simulation must select only platform behavior; it must not silently choose the
feature under test. Run the complete suite whenever a default changes because
focused suites may already contain narrower environment seams.
