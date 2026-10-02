# Preserved terminal-focus work

This branch preserves the uncommitted terminal-focus implementation found on
2026-10-02. It is a work-in-progress snapshot, not the supported release branch.
The original local checkout was preserved without changes.

Do not use the focus button yet. The implementation incorrectly treats
`WT_SESSION` as a Windows Terminal window identifier and always selects tab 0.
The session GUID identifies a pane; it does not identify a window. Passing it
as `wt -w` can create a new named window instead of returning to the intended
session. The fake Windows Terminal tests accept this assumption and therefore
do not prove real targeting.

Sources:

- [Windows Terminal window targeting](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments#options-and-commands)
- [Session targeting request](https://github.com/microsoft/terminal/issues/19783)

Before merging, establish and test an actual originating-window/tab/pane
mapping, return honest focus results, and repeat the native multi-window test.
Do not substitute the most recent window or tab 0 and claim exact targeting.

The tested GitHub beta and publication fixes are on `main`. This preservation
branch retains the previous dependency and plugin-name versions as evidence.
