# Logbook Windows-to-cloud patch series

Windows `main` is at `d887a6a` and is diverged from `origin/main` (`1587f5f`).
Do not reset or force-push either branch. Apply these patches on a new branch.

## Fresh cloud base: cloud-reconciled

Base: `1587f5f` (`fix: repair commit engine exports`)

```bash
git switch -c reconcile/commit-ai 1587f5f
git am patches/cloud-reconciled/*.patch
npm test
```

This series preserves the cloud export repair (`artifactReasonLabel`) and restores
`undoLastCommit`, because the new `/api/commit/undo` endpoint calls it. It applies
cleanly to `1587f5f`; the only conflict during preparation was that exports block.

Files:

| Patch | SHA-256 |
|---|---|
| `0001-chore-checkpoint-2026-10-21-18-10.patch` | `12E3CFDFE14206A63715E81637E71E30F7347759813DD5FDF139DE338C5E7290` |
| `0002-chore-checkpoint-2026-10-21-18-26.patch` | `82FE117A5E881BA6343E9D19A5EB906ADDAA96764927833763CFD38D0E1419DF` |
| `0003-fix-repair-remote-labels-and-commit-suggestions.patch` | `AD5678354F1B25EE9F43ADDC6EBD020BF3C79C1D4A1D092A31058913F39184FF` |

Validation already performed on Windows:

- clean `git am` on a fresh `1587f5f` worktree: exit `0`
- full suite: **67 passed, 0 failed** (exit `0`)
- focused AI + commit-engine suite after fresh apply: **30 passed, 0 failed** (exit `0`)
- `git diff --check` reports two inherited whitespace issues: a trailing blank
  line at EOF of `commit-engine.js` and trailing whitespace in `index.html`.
  They came from the original checkpoints and do not affect tests or runtime.
- Linux execution is still pending on the cloud runner. This Windows host has no
  usable Linux Node runtime (WSL has no Node, Docker is unavailable).

## Existing 59-test cloud tree: cloud-ai-only

Base content: `1587f5f` plus the remote-label fix and two remote-label tests
already present in the cloud's 59-test tree. This series deliberately omits those
duplicate changes. It contains only the commit-AI feature, its UI follow-up, and
the AI fallback fix.

```bash
# On the clean, committed 59-test branch:
git am patches/cloud-ai-only/*.patch
npm test
```

Files:

| Patch | SHA-256 |
|---|---|
| `0001-chore-checkpoint-2026-10-21-18-10.patch` | `98E16171C6991D3E5113E7B867E9B6BA0E93612342170D717C217889135C9C70` |
| `0002-chore-checkpoint-2026-10-21-18-26.patch` | `DD59CC951616DE2D9A2503F3EA16FD5DF8020238E9CF103A9DA79F67A7D3476E` |
| `0003-fix-repair-commit-suggestion-fallback.patch` | `059D133BA225F6F7C509E5913F696D8E52B050E64974048296C467B1D9B74DCB` |

Validation performed on a reconstruction of the cloud's 59-test state:

- baseline (without the AI feature): **59 passed, 0 failed**
- fresh `git am` of all three patches: exit `0`
- after the series: **67 passed, 0 failed** (exit `0`)

This is the minimal series to use when the existing 59-test branch must be kept.
Use `cloud-reconciled` instead when starting from a fresh `1587f5f`.

## Historical: windows-exact

Base: `9d08661` (merge base)

These are the exact three local commits, for review only:

| Patch | SHA-256 |
|---|---|
| `0001-chore-checkpoint-2026-10-21-18-10.patch` | `8456DE3CB0780335D079E502F7F9F611A10698188BC13778FFEA4404899F2184` |
| `0002-chore-checkpoint-2026-10-21-18-26.patch` | `7829270B81B457555B879EF48734C8458530EB686DBDED94D9A00EBF3717A44E` |
| `0003-fix-repair-remote-labels-and-commit-suggestions.patch` | `CE68D020EA9A337DDD54E3A01AED96D562756716B446EB2E5FBB841C843FCC50` |

Patch `0001` conflicts with `1587f5f` in `commit-engine.js` exports. Use the
reconciled series for cloud validation. Use the exact series only to inspect the
original commits or to reproduce them from `9d08661`.

## OAuth validation status

The local server was started with `ALLOW_LOCAL_AUTH=0` and
`ENABLE_COMMIT_NOW=0`. The real authorization redirect reached:

`https://github.com/login?...` — title `Sign in to GitHub`

There was no authenticated GitHub browser session, so no credentials were entered,
no consent was approved, and no authenticated session was created. After the attempt:

- `/api/session`: `authorized: false`
- `/api/snapshot`: `401`

Snapshot loading, sync, and logout remain unverified. Do not publish the cloud
environment configuration as fully validated until those steps succeed.
