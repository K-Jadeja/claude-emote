# Publication readiness findings — 2026-10-02

## Strict plugin naming

Claude Code 2.1.287 rejected `claude-emote` in strict plugin validation because
third-party plugin names cannot start with `claude-`. The bundled plugin identity
is now `emote-companion`; the launcher command and repository remain
`claude-emote`. Hook loading uses `--plugin-dir`, so its path remains unchanged.
No provider, billing, credential, or fallback behavior changes.

The regression test checks the bundled manifest, and actual strict validation
passed in the checkout and in an installed tarball. This is a validation failure;
the current upstream docs say runtime loading may still accept reserved names.

Source: [Claude plugin manifest names](https://code.claude.com/docs/en/plugins-reference#name).

## Dependency findings

The runtime audit found high-severity advisories in `adm-zip@0.6.0`; upgrading to
0.6.1 cleared the runtime audit. The development audit also exposed patched
Vitest/mocker, nanoid, and brace-expansion advisories. Vitest is now pinned to
4.1.11 and compatible transitive patches are locked. The final full audit has
two moderate findings under the pinned Neutralino packaging CLI.

Keep the CLI compatibility constraint documented in `SECURITY.md`; do not force
upgrade it without validating the existing CommonJS/ESM regression.

## Test portability and timing

The Neutralino subprocess had a 10-second deadline while its enclosing test
used Vitest's 5-second default. An 8.4-second successful startup could fail the
outer test. The enclosing deadline is now 15 seconds; the child deadline stays
10 seconds and assertions still require successful CLI output.

The desktop launcher test hard-coded the local directory name
`claudecodeavatar`. It now compares the actual checkout basename, matching the
privacy-safe product label and allowing fresh clones/worktrees.

## Unfinished focus branch

The original uncommitted changes used `WT_SESSION` as `wt -w`'s window ID and
selected tab 0. This confuses pane identity with window identity. An unknown
window name can create a new window. Mock tests accepted the same incorrect
assumption. Preserve this work separately rather than treating mock success as
native acceptance. No focus feature was included on the publication branch.

Source: [Windows Terminal window targeting](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments#options-and-commands).

See `GITHUB_PUBLICATION.md` for exact passing checks and remaining acceptance.
