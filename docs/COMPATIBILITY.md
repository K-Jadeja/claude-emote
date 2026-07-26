# Claude Code Compatibility and Updates

## Product contract

Claude Code and Claude Emote have separate installation and update lifecycles.

Claude Emote:

- does not install, replace, patch, or pin Claude Code;
- resolves the current `claude` executable from `PATH` on every launch;
- passes user arguments to that executable;
- loads its bundled plugin for that launched session;
- treats the companion as observational and non-blocking.

A user can update Claude Code normally. The next `claude-emote` launch should
use the updated executable.

## Updating Claude Code

Anthropic's native installation checks for updates on startup and periodically
while running. A downloaded update takes effect the next time Claude Code
starts. To request an immediate native update:

```powershell
claude update
```

For other supported installation methods:

```powershell
# Windows Package Manager
winget upgrade Anthropic.ClaudeCode

# npm
npm install -g @anthropic-ai/claude-code@latest
```

Do not recommend `npm update -g` for Claude Code. Its existing semantic-version
range may not select the latest release.

The official update instructions are:
<https://code.claude.com/docs/en/installation#update-claude-code>.

## Updating Claude Emote

During repository development:

```powershell
git pull
npm ci
npm run build
npm link
```

The intended published-package update is:

```powershell
npm install -g claude-emote@latest
```

A signed installer may later provide its own application update channel. That
channel must update only Claude Emote and its native overlay resources.

## Compatibility boundary

Claude Emote relies on two documented Claude Code contracts:

1. `--plugin-dir` loads a plugin directory for a session.
2. Plugin command hooks receive lifecycle JSON through stdin.

The hook bridge forwards the payload to the launcher-owned loopback host. The
event mapper reads only fields needed to choose a semantic state.

Current forward-compatibility behavior:

- additional JSON fields are accepted and ignored;
- unknown hook event names map to no visual change instead of throwing;
- malformed known events map to no visual change;
- bridge and host failures do not block or alter Claude;
- the desktop protocol remains a separate strict five-field schema.

This means an additive Claude Code update should usually require no Claude
Emote change.

## What can break

A Claude Code release can require a Claude Emote update if it:

- removes or renames a lifecycle hook used by the plugin;
- changes a required field's name or type;
- changes plugin discovery or `--plugin-dir`;
- changes command-hook execution or environment propagation;
- stops emitting a lifecycle point that the UI depends on.

These failures must not be disguised with invented animation. Missing events
should lead to stale-state detection, a disconnected status, and a clear local
diagnostic while Claude continues normally.

## Duplicate Claude installations

The most common apparent "wrong version" problem is more than one `claude`
executable on `PATH`.

On Windows:

```powershell
Get-Command claude
where.exe claude
claude --version
```

Claude Emote launches the first compatible executable resolved by its normal
launcher rules. Users should remove stale duplicate installations rather than
pinning Claude Emote to a hidden path. An explicit executable override remains
a diagnostic and test seam, not the normal setup.

## Release gates

Before publishing a Claude Emote release:

1. Install the current Claude Code stable channel in a clean environment.
2. Validate the bundled plugin strictly.
3. Start `claude-emote` and exercise session start, prompt, read, write,
   generic tool, permission, compaction, stop, failure, and session end.
4. Confirm the overlay protocol still contains exactly the five allowed
   semantic fields.
5. Repeat against Claude Code's latest channel.
6. Run the complete automated suite and packaged native smoke test.
7. Record any incompatibility and minimum supported Claude version in release
   notes.

CI should eventually run plugin validation and hook fixtures against both the
stable and latest Claude Code channels. A release must not claim compatibility
based only on TypeScript compilation.

## Recovery policy

When a Claude Code update is incompatible:

1. Claude itself still starts.
2. Claude Emote reports that its integration is incompatible or disconnected.
3. The diagnostic includes both Claude and Claude Emote versions.
4. The user updates Claude Emote independently.
5. Downgrading Claude is an optional temporary user choice, never the primary
   product fix.

The planned `claude-emote doctor` command should automate executable discovery,
version reporting, plugin validation, host startup, overlay startup, and one
synthetic privacy-safe state round trip.
