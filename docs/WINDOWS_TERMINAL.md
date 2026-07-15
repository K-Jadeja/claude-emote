# Windows Terminal Integration

claude-emote V1 is built for Windows Terminal. This page explains how
it interacts with WT and what to do when WT is unavailable.

## What claude-emote does

When you run `claude-emote`, the launcher:

1. Verifies that `claude` is on `PATH`.
2. Checks for the `WT_SESSION` environment variable to confirm we're
   running inside Windows Terminal.
3. Probes `wt --help` to see which split-pane flags the installed
   version supports.
4. Picks a free localhost port and a random instance ID.
5. Spawns the avatar in a narrow right-side pane via `wt -F split-pane -V`.
6. Waits for the avatar server's `/health` endpoint to respond.
7. Sets `CLAUDE_EMOTE_INSTANCE_ID`, `CLAUDE_EMOTE_ENDPOINT`, and
   `CLAUDE_EMOTE_PARENT_PID` on the `claude` process and runs it with
   the original argv.
8. On `claude` exit, lets the avatar shut down (it watches the parent
   PID) and forwards Claude's exit code.

## Pane geometry

The launcher requests a vertical split with `--size 0.25` (about 25 %
of the terminal width). This is a default; you can override the
emote-set directory by setting `CLAUDE_EMOTE_EMOTE_DIR` before
launching.

## Feature detection

The launcher never hard-codes WT split syntax. It always reads
`wt --help` first and adapts to the capabilities it sees:

| Capability                | Probe                                                |
| ------------------------- | ---------------------------------------------------- |
| `wt` exists on PATH       | Tries `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` first, then `where wt`. |
| `split-pane` supported    | `wt --help` output contains "split-pane".           |
| `-F` (force) supported    | `wt --help` output contains "-f" or "--full".        |

If any capability is missing, the launcher prints a clear warning and
falls back to a `start` console window.

## When WT is unavailable

If `WT_SESSION` is not set, the launcher:

- prints a warning
- launches the avatar in a separate `cmd /c start` console window
- continues starting Claude normally

The avatar still works — you just don't get the inline pane.

## Sixel rendering

For the avatar to render in colour, Windows Terminal must be
configured to enable Sixel support. As of the most recent Windows
Terminal releases this is enabled by default for new installs. To
verify:

1. Open Windows Terminal.
2. Click the down arrow next to the tab → Settings.
3. In the left pane click your profile, then click "Advanced".
4. Find the experimental "Enable Sixel" toggle and turn it on if it
   exists. (Newer WT versions expose this as "Automatically detect"
   under the rendering section.)
5. Save and reopen the tab.

If Sixel is not enabled, the avatar falls back to ASCII automatically
— the launcher probes the terminal capabilities and picks the best
renderer.

## Chafa

Sixel rendering requires the [Chafa](https://hpjansson.org/chafa/)
executable. Install options:

```powershell
# winget (preferred)
winget install Chafa.Chafa

# Or download a release binary
# https://github.com/hpjansson/chafa/releases
# Extract chafa.exe somewhere on PATH (e.g. C:\Windows)
```

Set `CLAUDE_EMOTE_CHAFA_PATH` to the full path of `chafa.exe` to
override auto-detection. `PI_EMOTE_CHAFA_PATH` is also honoured for
backwards compatibility with the upstream pi-emote.

## Cursor behaviour

The standalone render host:

- Hides the cursor with `\x1b[?25l` on startup.
- Positions the cursor at the pane home (`\x1b[H`) before every redraw.
- Erases the prior frame's text lines with `\x1b[NM` to prevent
  ghosting.
- Restores the cursor with `\x1b[?25h` on shutdown, signal exit, or
  parent disappearance.

The host never clears the entire Windows Terminal window — only the
text rows the current frame occupies.

## Cleanup guarantees

The avatar process exits 0 and restores the cursor in every one of
these cases:

- `SessionEnd` hook fires
- Claude exits (parent-PID watcher fires after 500 ms)
- User presses Ctrl+C in the avatar pane (SIGINT)
- User runs `taskkill /F /PID <avatar-pid>` (SIGTERM)
- The avatar's HTTP server is closed by the OS
- The avatar process itself crashes (uncaughtException handler)

The standalone render host is the single owner of cursor visibility —
no other component writes `\x1b[?25l` or `\x1b[?25h`.
