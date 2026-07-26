# Diagnostics

Run:

```powershell
claude-emote --emote-doctor
```

The command checks the current platform, real Claude executable, compiled
semantic host, and native overlay package. It does not start Claude or a pet.
It never prints the per-session capability.

For launcher lifecycle detail:

```powershell
$env:CLAUDE_EMOTE_DEBUG = "1"
claude-emote --resume
```

Debug output may include process kinds, ports, instance IDs, and failure
statuses. It must never include prompts, hook payloads, or capability tokens.
It also never includes the full working directory or configured session label;
the default pet label contains only the final directory name.

Use `--emote-doctor` rather than a bare `doctor` subcommand so a current or
future `claude doctor` argument remains available to the real Claude CLI.
