# Logbook 📡📖

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-green.svg?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/Version-4.14.0-blue.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Architecture-Zero--Build_Frontend-6C5CE7.svg)](index.html)
[![Storage](https://img.shields.io/badge/Storage-SQLite_%2B_AES--256--GCM-003B57.svg?logo=sqlite)](data/)
[![Realtime](https://img.shields.io/badge/Streaming-Server--Sent_Events-orange.svg)](server.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Maintainer](https://img.shields.io/badge/Maintainer-thebinayghimire-blueviolet.svg)](https://github.com/thebinayghimire)

An interactive GitHub archival telemetry folio. The frontend is a single HTML file with no build step. The Node bridge provides a username-first GitHub OAuth flow, persistent encrypted sessions, and background snapshot sync while keeping GitHub tokens out of the browser.

## Authorization first

Nothing is fetched from GitHub until the visitor explicitly authorizes. The entry flow is:

1. Enter a GitHub username.
2. Continue to GitHub's OAuth consent screen.
3. Logbook verifies that the authorizing GitHub account matches the entered username.
4. The authorized account's telemetry is fetched and displayed.

The app does not offer an unauthenticated public-data bypass on the entry screen. A Node deployment with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` is required; a static-only host cannot complete this flow.

After authorization, the account dossier shows the authenticated profile, accessible/private/public repository counts, the private repository ledger, organizations, starred repositories, gists, followers, and following. The main ledger includes **all repositories the token can access** — owner, collaborator, and organization-member repositories, public and private.

The bridge only issues read-only GitHub requests: REST `GET` calls plus a GraphQL query for the official contribution calendar. It never writes to GitHub with the Logbook token. The optional **Commit Now** feature is separate: it runs local `git commit` and `git push` against repositories on the bridge machine, using that machine's existing git credentials. It is disabled by default and cannot be enabled off a loopback listener.

After authorization, the dashboard paints the encrypted snapshot immediately. If the snapshot is older than `SNAPSHOT_FRESH_MS` (default 60 seconds), an incremental scan starts in the background; a fresh snapshot skips the load-time scan. Sync progress streams over Server-Sent Events (`/api/events`). A visible tab also runs a silent conditional repository check every 60 seconds as a fallback, using ETags and a repository signature. Unchanged `304 Not Modified` responses do not consume the authenticated primary rate limit. A background scan runs only when the repository signature changes; background checks do not show spinners, banners, or toast notifications. Rate-limit responses trigger an automatic backoff.

The first authorized account scan is stored as an encrypted, account-partitioned snapshot in `data/logbook.sqlite`. The browser paints that snapshot immediately on every later visit, then revalidates it in the background. A scan writes a small profile + repository summary first and fills in commit and language detail per repository, so the dashboard shell does not wait for the full crawl. Unchanged repositories are reused and only commits newer than the last indexed commit are requested.

Sessions, encrypted GitHub tokens, server-side preferences, and audit records live in the same SQLite database. Snapshots and session tokens are AES-256-GCM encrypted at rest with `SNAPSHOT_ENCRYPTION_KEY` (or a generated development key), and snapshots are bound to the immutable GitHub account ID. Signing out revokes the session that can read the snapshot; deleting the account removes the snapshot entirely. The scan queue exposes progress, retries transient upstream failures, deduplicates concurrent scans per account, survives page navigation, and marks interrupted jobs as failed on restart. Snapshots are normalized (not raw GitHub payloads), compressed for transport, and support cursor pagination for large ledgers.

## What the dashboard shows

| Section | Contents |
|---|---|
| 01 **Now** | Latest push hero, 24-hour history, last-7-days bars, live patch inspector |
| 02 **Pulse** | Six KPI cards, scrubable sparklines, drill-down ledger, authored PR/issue/review counts |
| 03 **Rhythm** | Three-year contribution heatmap, punch-card clock matrix, repository focus bars |
| 04 **Repositories** | Full accessible ledger, visibility/type/language filters, lifespan Gantt view, file tree and README inspector |
| 05 **Languages** | Byte-weighted composition, ranked breakdown, quarterly small multiples |
| 06 **Push Log** | Chronological commit timeline with lazily fetched inline patches |

The header account dossier (`@handle`) is the private-data view: identity, bio, location, website, join date, counts, private repositories, orgs, stars, gists, followers, and following. It also has the sign-out control.

Filters are mirrored in the URL for bookmarking and reloads. Named saved views store the current filter set per account. The footer and filter bar open a metric glossary that explains commit attribution, active days, streaks, code volume, reviews, scan limits, and partial data.

## Data sources

Most dashboard values are fetched from the GitHub REST API. The contribution calendar uses a read-only GraphQL query when the token permits it.

| Data | Endpoint |
|---|---|
| Authenticated identity | `GET /user` |
| Public profile | `GET /users/:user` |
| Verified emails for commit attribution | `GET /user/emails` |
| All accessible repositories | `GET /user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=pushed` |
| Public-only repositories | `GET /users/:user/repos?sort=pushed` |
| Commits | `GET /repos/:owner/:repo/commits?per_page=100` |
| Language bytes | `GET /repos/:owner/:repo/languages` |
| Newest-commit diff stats | `GET /repos/:owner/:repo/commits/:sha` |
| Authored PRs / issues / reviews | `GET /search/issues?q=...` |
| Orgs, stars, gists, followers, following | `GET /user/orgs`, `/user/starred`, `/gists`, `/user/followers`, `/user/following` |
| Official contribution calendar | `POST /graphql` → `viewer.contributionsCollection.contributionCalendar` |
| Lazy file tree / README / patch | Repository, tree, readme, and commit endpoints, fetched only when a row is opened |

Commits are attributed to the authorized account by linked GitHub login, or by a verified email when no GitHub account is linked. Unverified addresses are never used. Merge commits and bot/automation commits are excluded by default. Analytics use the default branch of each repository. The first 100 non-fork, non-archived repositories are scanned for commit and language detail; pagination is followed for repository and account lists, and truncation is reported in the snapshot metadata. Empty repositories return `409` from the commits endpoint and are skipped.

### Derived, not fetched

- **Contribution heatmap** — uses GitHub's official GraphQL contribution calendar when available, which reflects private and organization contributions when the account has enabled them. If GraphQL is unavailable, the UI clearly labels a locally derived fallback built from scanned commit timestamps.
- **Punch card** — weekday × hour buckets from attributed commit timestamps.
- **KPI sparklines** — commit counts binned across the selected window.
- **Code volume** — sum of language byte totals, not a `git diff` line count.
- **Active days and streaks** — calendar days with at least one attributed contribution, computed in UTC.

## Run locally

Requires Node.js 22.13 or newer. There are no npm dependencies.

```powershell
npm start
# http://127.0.0.1:8080
```

`npm start` runs the zero-dependency bridge in `server.js`, serves the static folio, and enables the authorization gate. Use `PORT` and `HOST` to change the listener.

Run the test suite with:

```powershell
npm test
```

The tests use Node's built-in `node:test` runner and cover OAuth helpers, session isolation and revocation, snapshot ownership and deletion, commit attribution, and the local Commit Now engine.

### GitHub OAuth app (required)

1. Create an OAuth app at <https://github.com/settings/developers>.
2. Set the homepage URL to your site, for example `http://127.0.0.1:8080`.
3. Set the authorization callback URL to `http://127.0.0.1:8080/auth/github/callback`.
4. Create `.env` from `.env.example` and fill in the client ID and secret.
5. Restart `npm start`.

The callback URL must match `GITHUB_CALLBACK_URL` exactly, and the hostname must match the one you open in the browser: OAuth state cookies are scoped to `localhost` or `127.0.0.1`, not both. On a public deployment use an HTTPS callback and set `ALLOW_LOCAL_AUTH=0`.

## Commit Now (local only)

Commit Now is an opt-in write path for this machine. It lets an authenticated Logbook session choose a projects folder, preview uncommitted work, and commit and push selected repositories without leaving the dashboard. It is off by default and is forced off unless the bridge listens on a loopback address:

```dotenv
ENABLE_COMMIT_NOW=1
HOST=127.0.0.1
```

After restarting the bridge, sign in and click **Commit now** in the header. The button only appears when `/api/session` reports `features.commitNow: true`. If a projects root was saved before, the modal opens straight into a fresh scan. Otherwise it opens an in-app folder browser backed by the bridge process; the chosen root is stored per account as the `commitRoot` preference.

The preview is read-only. Select the repositories you want, optionally adjust the commit message and execution mode, then confirm. For every selected repository, Logbook:

- scans up to three directory levels for `.git` entries, stops descending at a repository boundary, and skips dot-directories plus common dependency, build, cache, and system folders such as `node_modules`, `.venv`, `dist`, `build`, `target`, and `vendor`;
- stages tracked modifications with `git add -u`, then stages ordinary untracked files. `.gitignore` is honored;
- excludes suspicious untracked artifacts from staging: binary/cache extensions such as `.db` and `.exe`, unexpanded environment paths such as `%SystemDrive%`, untracked folders, and files over 256 KB. Excluded files stay in the working tree and are reported in the preview and result;
- blocks any repository with likely secret files that are **not** ignored (for example `.env`/`dev.env`, `.git-credentials`, `client_secret*.json`, credentials JSON, private keys, certificates, and keystores) and unchecks it by default;
- blocks a repository when a suspicious artifact is already staged, because `git commit` would include it;
- commits with `chore: checkpoint YYYY-MM-DD HH:MM` by default, or an optional custom message capped at 200 characters, using the repository's configured `user.name` and `user.email`;
- pushes the current branch, creating the upstream on the selected remote when one is missing, and pushes clean repositories that are already ahead;
- commits locally but **defers the push** when the branch is behind its upstream, so a non-fast-forward rejection cannot discard the local checkpoint. Pull or rebase, then push manually;
- reports per-repository progress over an NDJSON stream and records a `commit_now` audit event with repository names and result counts.

It deliberately does **not** pull, rebase, merge, force-push, or resolve conflicts. A failed push leaves the local commit in place and reports the failure. Repositories are skipped when they are detached, bare, submodules, mid-merge/rebase/cherry-pick/revert/bisect, contain unmerged paths, or lack a git identity. There is no undo in the UI: use git's local reflog for a bad local commit, and revert or amend on the remote as you would normally.

Commit Now uses the `git` CLI and the machine's existing credential helper or SSH agent, with terminal prompts and SSH batch prompts disabled. The Logbook OAuth token is never passed to git and is never used for writes. The selected root is the trust boundary: every requested repository path is resolved (including symlinks) and must stay inside it. A run is globally serialized; a second run receives `409 commit_in_progress`.

The folder browser can read any directory the bridge process can read. Keep this feature on a private, loopback-only instance. `HOST=127.0.0.1` does **not** protect a loopback listener exposed through a reverse proxy: leave `ENABLE_COMMIT_NOW=0` on any proxied deployment. Anyone who can use the authenticated browser session can invoke a run, so sign out when you leave the machine.

## Configuration

Copy `.env.example` to `.env`; `.env` is ignored by git.

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_CLIENT_ID` | — | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | — | OAuth app client secret; server-side only |
| `GITHUB_CALLBACK_URL` | `http://127.0.0.1:$PORT/auth/github/callback` (or the configured `HOST`) | Must match the OAuth app callback exactly; use the same hostname in the browser |
| `GITHUB_SCOPE` | `repo read:org read:user user:email gist` | OAuth scopes; `repo` is required for private repositories |
| `PORT` | `8080` | Bridge listener port |
| `HOST` | `127.0.0.1` | Bridge listener address |
| `ALLOW_LOCAL_AUTH` | enabled only on loopback | Adopt the local `gh` token; set to `0` on shared or proxied hosts |
| `ENABLE_COMMIT_NOW` | `0` | Enable the local Commit Now picker and commit/push endpoints; forced off unless `HOST` is loopback. Never enable on a shared, proxied, or public host |
| `SESSION_TTL_HOURS` | `12` | Fixed lifetime of a persistent server session |
| `SNAPSHOT_FRESH_MS` | `60000` | Skip a page-load rescan when the stored snapshot is newer than this; explicit refreshes and detected changes still scan |
| `SNAPSHOT_ENCRYPTION_KEY` | generated under `data/` for development | 32 bytes (base64 or 64 hex chars) used to encrypt snapshots and session tokens; required in production |
| `LOGBOOK_DATA_DIR` | `./data` | Directory for `logbook.sqlite` and the development key |
| `TRUST_PROXY` | `0` | Set to `1` only behind a trusted reverse proxy so client IPs and rate limits use `X-Forwarded-For` |
| `CSP_ENABLED` | `1` | Nonce-based Content Security Policy; set to `0` only for local debugging |
| `INCLUDE_BOTS` | `0` | Include bot/automation commits in analytics |
| `INCLUDE_MERGE_COMMITS` | `0` | Include merge commits in analytics |
| `NODE_ENV` | unset | Set to `production` to enable production startup warnings |

## Security model

- **No token in the page for server sessions.** OAuth and local `gh` tokens are stored only on the server, encrypted with AES-256-GCM. The browser receives an `HttpOnly`, `SameSite=Lax` session cookie (with `Secure` on HTTPS). Session IDs are stored as hashes.
- **Authorization before any fetch.** The page probes `/api/session` and shows the username-first consent gate before requesting GitHub account data.
- **Account binding.** The requested username is stored with the one-time OAuth state. The callback rejects authorization when the GitHub account that consented does not match that username. Authorizing a different account explicitly revokes the current bridge session first.
- **OAuth state + PKCE.** The bridge stores a one-time `state` and PKCE verifier, sets an `HttpOnly` state cookie, verifies both on callback, and exchanges the code server-side. Return URLs are validated to prevent open redirects.
- **CSRF and origin checks.** Every authenticated state-changing API call requires a session-derived `X-Logbook-CSRF` header, `X-Logbook-Auth: 1`, and a same-origin `Origin`/`Sec-Fetch-Site` when present. Cross-origin mutations are rejected. Local `gh` authorization, which has no session yet, uses the same origin/header guard.
- **Opt-in local writes.** Commit Now is disabled unless `ENABLE_COMMIT_NOW=1` and `HOST` is a loopback address. Its endpoints require the normal authenticated session, CSRF token, and origin check. Repository paths are resolved and confined to the selected root, symlinks are followed before that check, and only one run may execute at a time. Likely secret files block their repository, and suspicious untracked artifacts are never staged automatically. Git commands use `execFile` (no shell), run with `GIT_TERMINAL_PROMPT=0` and SSH batch mode, and use the machine's credentials rather than the Logbook OAuth token. The feature is not a GitHub write proxy and does not make the `/api/gh/*` route writable.
- **No private payload persistence in the browser.** Private accounts and repository payloads are never written to `localStorage` or `sessionStorage`. Only public telemetry is cached in the browser, for up to six hours. Preferences for bridge sessions are stored server-side and partitioned by GitHub account; browser `localStorage` preferences are used only in public/static mode.
- **Encrypted server snapshots.** Normalized private snapshots live in SQLite encrypted with AES-256-GCM and authenticated against the GitHub account ID. Responses use ETags so unchanged polls do not decrypt the snapshot.
- **Security headers.** Responses set CSP with per-request script nonces, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, and `X-Robots-Tag`. HTTPS requests also receive HSTS. Static serving blocks `.env`, `.git`, `node_modules`, `server.js`, dot-segment traversal, and non-whitelisted file types.
- **Rate limits.** The bridge limits API requests per IP, authorization attempts per IP, sync requests per account, and exports per account. SSE connections are capped at four tabs per account.
- **Audit and data controls.** Login, logout, mismatches, revocation, and export events are recorded in an account audit log (retained 90 days). Accounts can export all stored data or permanently delete it from the UI. Deletion removes snapshots, sync jobs, sessions, preferences, and audit records; the deletion event itself is written to structured server logs rather than the account audit table.
- **Read-only proxy.** `/api/gh/*` accepts `GET` only and forwards a GitHub token from the server session. It is not an open proxy: a valid session is required.
- **Scope caveat.** GitHub's classic OAuth app scopes do not offer a read-only private-repository scope. The default `repo` scope technically grants write capability, even though Logbook only issues reads and a read-only GraphQL query. For least privilege, use a read-only fine-grained personal access token or a dedicated account.

### Account deletion

The footer's **Sessions & data controls** panel can delete the current account's Logbook data. The action requires typing `DELETE` in the confirmation dialog. It removes:

- the encrypted snapshot and sync-job history,
- all sessions for the account,
- server-side preferences and saved views,
- audit records for the account,
- the session cookie in the current browser.

Deletion removes Logbook's copy of the data but does **not** revoke the OAuth app authorization on GitHub. Revoke the app separately at <https://github.com/settings/applications> if you want to remove that grant. A later authorization creates a fresh session and snapshot.

## Bridge API

| Route | Purpose |
|---|---|
| `GET /healthz`, `GET /livez` | Liveness probe |
| `GET /readyz` | Readiness probe; checks SQLite storage |
| `GET /api/session` | Public session state, CSRF token, scopes, session metadata |
| `GET /api/sessions` | List sessions for the current account |
| `POST /api/sessions/revoke` | Revoke one session, all other sessions, or every session |
| `GET /api/preferences`, `PUT /api/preferences` | Read or write account-scoped UI preferences |
| `GET /api/export` | Download the normalized snapshot as JSON with export metadata |
| `DELETE /api/account` | Permanently delete all Logbook data for the account |
| `GET /api/status` | Version, session, snapshot, sync, and recent audit status |
| `GET /api/events` | Server-Sent Events stream for sync progress |
| `GET /api/snapshot` | Normalized snapshot; supports `commit_limit` and `cursor` |
| `POST /api/sync`, `GET /api/sync`, `DELETE /api/sync` | Queue, inspect, or cancel an account scan |
| `GET /api/commit/folders?path=` | List subfolders for the Commit Now picker (local commit mode only) |
| `POST /api/commit/scan` | Scan a selected root and return a read-only repository preview |
| `POST /api/commit/run` | Commit and push selected repositories; streams NDJSON progress |
| `GET /api/gh/*` | Read-only GitHub REST proxy |
| `POST /api/auth/local` | Adopt a local `gh` token when enabled |
| `POST /api/logout` | Revoke the current session |
| `GET /auth/github`, `GET /auth/github/callback` | OAuth start and callback |
| `GET /auth/logout`, `GET /logout` | Cookie-based session logout |

Authenticated mutating routes require the CSRF and origin headers described above. Health probes are intentionally unauthenticated. The three `/api/commit/*` routes return `403 commit_disabled` when local commit mode is off, and `POST /api/commit/run` returns `application/x-ndjson` events with `start`, `result`, `done`, and `error` types.

## Deployment

### Static hosting (GitHub Pages)

Static hosting can run the folio, but not the Node bridge. If no bridge answers and no token is stored, the page opens the public-only ledger automatically. Open the account dossier to add a personal access token or reopen the authorization gate; OAuth and local `gh` authorization remain unavailable. The personal access token is held in `sessionStorage` only. Unauthenticated GitHub requests are limited to 60/hour per IP, and only public data is available.

### Node hosting

Serve the repository root with `npm start` (or `node server.js`) behind HTTPS. Set the OAuth callback and `GITHUB_CALLBACK_URL` to the public HTTPS URL, set `HOST=0.0.0.0` if the reverse proxy connects over the network, and set `ALLOW_LOCAL_AUTH=0`. The frontend uses absolute `/api` and `/auth` paths, so serve it at the origin root unless you adapt those paths.

For production:

1. Set `NODE_ENV=production` and provide a stable `SNAPSHOT_ENCRYPTION_KEY`.
2. Mount `LOGBOOK_DATA_DIR` on a persistent volume and back up `logbook.sqlite` (plus its WAL files) with the service stopped or using SQLite's backup API.
3. Set `ALLOW_LOCAL_AUTH=0`, leave `ENABLE_COMMIT_NOW=0`, and use an HTTPS callback.
4. Set `TRUST_PROXY=1` only when every request arrives through a trusted reverse proxy that overwrites `X-Forwarded-For`; otherwise clients can spoof rate-limit identities.
5. Probe `/healthz` for liveness and `/readyz` for readiness.
6. Send `SIGTERM` for graceful shutdown; the listener, SSE clients, and SQLite handles close cleanly.

The bridge is intentionally single-process. SQLite in WAL mode supports the web process and its background scan jobs, but there is no shared job queue or cross-process session lock. For horizontal scaling, replace the SQLite session/snapshot stores and in-process scan queue with shared services. Running multiple bridge processes against the same `logbook.sqlite` is not recommended.

Changing `SNAPSHOT_ENCRYPTION_KEY` makes existing sessions and snapshots unreadable. There is no in-place re-encryption tool: stop the service, remove the SQLite files (or restore a backup encrypted with the old key), and let accounts re-authorize and re-scan.

**Reverse-proxy warning:** local `gh` authorization adopts the server owner's token, and Commit Now can commit and push repositories on the host. Both are gated by a loopback `HOST`, which is convenient for local development but dangerous if you expose that loopback listener through a public reverse proxy. Set `ALLOW_LOCAL_AUTH=0` and keep `ENABLE_COMMIT_NOW=0` on any proxied or shared host; the example `.env` starts with both disabled.

The real OAuth token exchange requires a registered OAuth app; it cannot be completed from GitHub Pages or from a static file server.

## Rate limits and caching

GitHub:

- Unauthenticated: **60 requests/hour per IP**.
- A token or bridge session: **5,000 requests/hour**.

Bridge guards:

- **300 API requests/minute per IP**.
- **20 authorization attempts/minute per IP**.
- **20 sync requests/minute per account**.
- **10 exports/minute per account**.
- **120 Commit Now folder listings/minute per account**.
- **20 Commit Now scans/minute per account**.
- **6 Commit Now runs/minute per account**, with one run in flight globally.

A cold authenticated load costs roughly `10 + 2 × repositories scanned` requests: profile, repository pages, verified emails, two calls per deep repository (commits + languages), newest-commit detail, three search counts, account extras, and up to three GraphQL calendar years. Incremental scans cost one repository-list call plus two calls only for repositories whose `pushed_at`, `size`, default branch, or archive state changed.

- Public payloads are cached in the browser for **6 hours**. Private payloads are stored only as encrypted server snapshots.
- Repeat polls compare the snapshot ETag and the repository-list signature, so an unchanged snapshot costs one indexed SQLite lookup and no decryption.
- The visible tab performs a conditional repository check every **60 seconds**; SSE carries sync progress while connected.
- The footer shows the remaining GitHub request budget and reset time when GitHub reports it.
- `MAX_DEEP_REPOS = 100` and `CONCURRENCY = 6` bound the scan. Incremental commit scans stop at 300 fresh commits per repository and mark the history as truncated.

## Verified locally

- Local `gh` session: **43 accessible repositories** — **29 private**, **14 public** — with private collaborator and organization repositories included; 204 commits indexed.
- Public-only mode: **13 owned public repositories** load without private data; 14 public repositories are accessible in total when collaborator repositories are included.
- Sign-out destroys the server session and returns to the gate.
- An invalid token is rejected with `401` and is not stored.
- OAuth redirect generation, state cookie, PKCE challenge, callback routing, and error handling were exercised with placeholder credentials. A real code exchange requires a registered OAuth app.
- All **57** automated tests pass under Node's `node:test` runner, including commit-engine scanning, secret detection, path confinement, artifact exclusion, behind-remote handling, and commit/push behavior against temporary repositories.
- Commit Now was exercised end-to-end through the bridge and dashboard with temporary repositories and a local bare remote: folder browsing, preview, NDJSON progress, checkpoint commit, push-only repo, secret warning, CSRF rejection, and root-confinement rejection.

## Features

- Light / dark / system theming with CSS custom properties, persisted per account
- Comfortable / compact density, persisted per account
- Named saved views for filter sets, plus URL-backed filter state
- Session manager with device metadata, per-session revocation, and “sign out other sessions”
- Account data export and explicit account deletion
- Live sync via SSE with a 60-second conditional polling fallback
- Opt-in local **Commit Now**: folder picker, repository preview, checkpoint commit, and push using the machine's git credentials
- Metric glossary covering definitions, attribution, scope, and limits
- Command palette (`⌘K` / `Ctrl+K`) over sections, repositories, and actions
- Keyboard navigation: `J`/`K` rows, `Enter` inspect, `1`–`5` timeframe, `T` theme, `/` search, `Esc` clear
- Web Audio tactile click/tick feedback (mutable)
- CSV / JSON export of the filtered repository ledger
- Print stylesheet for a physical folio
- Responsive layout; heatmap and punch card scroll horizontally on narrow viewports
- Accessible heatmap cells, dialogs with focus handling, and reduced-motion support

## License

MIT
