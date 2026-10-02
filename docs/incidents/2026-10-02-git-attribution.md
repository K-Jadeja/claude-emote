# Git author attribution repair — 2026-10-02

## Cause

Repository-local Git configuration overrode the owner's correct global identity
with `claude-emote` and an unlinked placeholder email. Historical commits used
`claude-emote@example.com` or `claude-emote@example.local`. GitHub returned a null
account for both author and committer, so those commits did not credit K-Jadeja.
The first publication failed to check this before committing and pushing.

## Repair

The user requested contribution attribution to their account. GitHub's
authenticated user API verified login `K-Jadeja` and account ID `113630783`.
Repository-local identity is now:

```text
K-Jadeja <113630783+K-Jadeja@users.noreply.github.com>
```

Both published branches were rewritten in an isolated mirror. Only the two
placeholder identities were replaced. All 37 original commit trees, messages,
author/committer dates, and parent topology were checked and preserved. No
contribution dates were invented. Third-party source licenses and attribution
were untouched. This documentation commit records the repair separately.

A verified full-history bundle and old/new commit map are retained locally in
`../claude-emote-attribution-20261002.git/before-attribution.bundle` and
`../claude-emote-attribution-20261002.git/attribution-audit.json`. Existing local
source branches and dirty files are preserved. The remote update uses atomic
push with explicit leases for the two previously verified branch tips.

## Prevention and verification

Before committing, inspect effective identity, including local overrides:

```powershell
git config --show-origin --get-regexp '^user\.'
git var GIT_AUTHOR_IDENT
gh api user --jq '{login,id}'
```

After pushing, query the commit's GitHub `author.login` and `committer.login`.
Do not infer attribution from the repository owner or display name alone.
For a future repair, first snapshot refs and worktrees, retain a complete bundle,
rewrite only verified placeholder identities in an isolated repository, compare
every tree/date/message/topology, and force-push only explicit refs with leases.
Other existing clones should use a fresh branch based on the corrected remote;
merging the old history back would restore the placeholder commits.

GitHub counts eligible commits on the default branch using their original
dates. Its contribution graph can take up to 24 hours to refresh. A private
repository's anonymous counts can be shown through the profile's
**Contribution settings → Private contributions** option.

Sources: [commit email attribution](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address),
[contribution requirements and refresh](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions).
