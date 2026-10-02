# Public source publication - October 3, 2026

The owner explicitly requested public visibility for `K-Jadeja/claude-emote` and the separate `K-Jadeja/mcode-emote` repository. This Claude update changes the README opening to the owner's casual first-person style, links to the MCode version, and clarifies that public source remains a Windows beta.

The Claude runtime is unchanged. Its October 2 validation remains documented in `docs/GITHUB_PUBLICATION.md`; do not imply that a paid Claude session was tested during publication. Existing WIP branches remain identified as unfinished. Other dirty worktrees and local audit artifacts are preserved.

Before changing visibility, inspect all exposed refs and scan source/history for secrets, verify licensing and README links, and confirm owner-linked commit attribution. Use explicit file staging, push the reviewed docs commit to `main`, then verify repository visibility and CI. Gitleaks 8.30.1 found no leaks in the 78-commit local history/ref scan shared with the MCode checkout. No Claude model calls are required for this workflow.
