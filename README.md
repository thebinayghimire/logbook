# Logbook

An interactive GitHub archival telemetry folio. The frontend is a single HTML file with no build step. The Node bridge provides a username-first GitHub OAuth flow and keeps access tokens out of the browser.

## Authorization first

Nothing is fetched from GitHub until the visitor explicitly authorizes. The entry flow is:

1. Enter a GitHub username.
2. Continue to GitHub's OAuth consent screen.
3. Logbook verifies that the authorizing GitHub account matches the entered username.
4. The authorized account's telemetry is fetched and displayed.

The app does not offer an unauthenticated public-data bypass on the entry screen. A Node deployment with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` is required; a static-only host cannot complete this flow.

After authorization, the account dossier shows the authenticated profile, accessible/private/public repository counts, the private repository ledger, organizations, starred repositories, gists, followers, and following. The main ledger includes **all repositories the token can access** — owner, collaborator, and organization-member repositories, public and private.

The bridge only makes read-only `GET` requests to the GitHub API. It never writes to GitHub.

After authorization, the dashboard paints the encrypted snapshot immediately. If the snapshot is older than `SNAPSHOT_FRESH_MS` (default 60 seconds), an incremental scan starts in the background; a fresh snapshot skips the load-time scan. The dashboard also performs a silent conditional repository check every five seconds while the tab is visible. Unchanged `304 Not Modified` responses do not consume the authenticated primary rate limit. A background scan runs only when the repository signature changes; background checks do not show spinners, banners, or toast notifications. Rate-limit responses trigger an automatic backoff.

The first authorized account scan is stored as an encrypted, account-partitioned snapshot in `data/logbook.sqlite`. The browser paints that snapshot immediately on every later visit, then revalidates it in the background. A scan writes a small profile + repository summary first and fills in commit and language detail per repository, so the dashboard shell does not wait for the full crawl. Unchanged repositories are reused and only commits newer than the last indexed commit are requested.

Snapshots are AES-256-GCM encrypted at rest with `SNAPSHOT_ENCRYPTION_KEY` (or a generated development key), keyed by the immutable GitHub account ID. Signing out removes the session that can read them. The scan queue exposes progress, retries transient upstream failures, deduplicates concurrent scans per account, survives page navigation, and marks interrupted jobs as failed on restart. Snapshots are normalized (not raw GitHub payloads), Brotli-compressed, and support cursor pagination for large ledgers.

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

## Data sources

All values are fetched live from the GitHub REST API.

| Data | Endpoint |
|---|---|
| Authenticated identity | `GET /user` |
| Public profile | `GET /users/:user` |
| All accessible repositories | `GET /user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=pushed` |
| Public-only repositories | `GET /users/:user/repos?sort=pushed` |
| Commits | `GET /repos/:owner/:repo/commits?per_page=100` |
| Language bytes | `GET /repos/:owner/:repo/languages` |
| Newest-commit diff stats | `GET /repos/:owner/:repo/commits/:sha` |
| Authored PRs / issues / reviews | `GET /search/issues?q=...` |
| Orgs, stars, gists, followers, following | `GET /user/orgs`, `/user/starred`, `/gists`, `/user/followers`, `/user/following` |
| Lazy file tree / README / patch | Repository, tree, readme, and commit endpoints, fetched only when a row is opened |

The first 100 non-fork, non-archived repositories are scanned for commit and language detail. Pagination is followed for repository and account lists. Empty repositories return `409` from the commits endpoint and are skipped.

### Derived, not fetched

- **Contribution heatmap** — GitHub's official contribution graph includes private/org contributions and is only exposed through GraphQL. This folio buckets the commit timestamps it actually fetched, so the grid reflects scanned repositories.
- **Punch card** — weekday × hour buckets from those commit timestamps.
- **KPI sparklines** — commit counts binned across the selected window.
- **Code volume** — sum of language byte totals, not a `git diff` line count.

## Run locally

Requires Node.js 18 or newer. There are no npm dependencies.

```powershell
npm start
# http://127.0.0.1:8080
```

`npm start` runs the zero-dependency bridge in `server.js`, serves the static folio, and enables the authorization gate. Use `PORT` and `HOST` to change the listener.

### GitHub OAuth app (required)

1. Create an OAuth app at <https://github.com/settings/developers>.
2. Set the homepage URL to your site, for example `http://127.0.0.1:8080`.
3. Set the authorization callback URL to `http://127.0.0.1:8080/auth/github/callback`.
4. Create `.env` from `.env.example` and fill in the client ID and secret.
5. Restart `npm start`.

The callback URL must match `GITHUB_CALLBACK_URL` exactly, and the hostname must match the one you open in the browser: OAuth state cookies are scoped to `localhost` or `127.0.0.1`, not both. On a public deployment use an HTTPS callback and set `ALLOW_LOCAL_AUTH=0`.

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
| `ALLOW_LOCAL_AUTH` | enabled only on loopback | Adopt the local `gh` token |
| `SESSION_TTL_HOURS` | `12` | In-memory server session lifetime |
| `SNAPSHOT_FRESH_MS` | `60000` | Skip a page-load rescan when the stored snapshot is newer than this; explicit refreshes and detected changes still scan |
| `SNAPSHOT_ENCRYPTION_KEY` | generated under `data/` for development | 32 bytes (base64 or 64 hex chars) used to encrypt snapshots at rest; required in production |
| `LOGBOOK_DATA_DIR` | `./data` | Directory for `logbook.sqlite` and the development key |

## Security model

- **No token in the page for server sessions.** OAuth and local `gh` tokens live in the bridge's in-memory session map. The browser receives only an `HttpOnly`, `SameSite=Lax` session cookie.
- **Authorization before any fetch.** The page probes `/api/session` and shows the username-first consent gate before requesting GitHub account data.
- **Account binding.** The requested username is stored with the one-time OAuth state. The callback rejects authorization when the GitHub account that consented does not match that username.
- **No private payload persistence in the browser.** Private accounts and repository payloads are never written to `localStorage` or `sessionStorage`. Only public telemetry is cached in the browser, for up to six hours.
- **Encrypted server snapshots.** Normalized private snapshots live in SQLite encrypted with AES-256-GCM and authenticated against the GitHub account ID. Rotate `SNAPSHOT_ENCRYPTION_KEY` by clearing `data/` or re-scanning after re-encryption.
- **OAuth state + PKCE.** The bridge stores a one-time `state` and PKCE verifier, sets an `HttpOnly` state cookie, verifies both on callback, and exchanges the code server-side.
- **Read-only proxy.** `/api/gh/*` accepts `GET` only and forwards a GitHub token from the server session. It is not an open proxy: a valid session is required.
- **Mutation guard.** Local authorization and logout require the `X-Logbook-Auth: 1` header and a same-origin `Origin` when one is present.
- **Header hygiene.** Responses set `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`. Static serving blocks `.env`, `.git`, `node_modules`, `server.js`, dot-segment traversal, and non-whitelisted file types.
- **Scope caveat.** GitHub's classic OAuth app scopes do not offer a read-only private-repository scope. The default `repo` scope technically grants write capability, even though Logbook only issues `GET` requests. For least privilege, use a read-only fine-grained personal access token or a dedicated account.

The bridge is intentionally small and single-process: sessions are in memory and are lost on restart, while encrypted account snapshots are persisted under `LOGBOOK_DATA_DIR`. For a multi-user production deployment, use HTTPS, set `ALLOW_LOCAL_AUTH=0`, keep `GITHUB_CLIENT_SECRET` server-side, and put the process behind a reverse proxy or process manager. If you need sessions to survive restarts or scale across processes, replace the in-memory maps with a shared session store.

**Reverse-proxy warning:** local `gh` authorization adopts the server owner's token. It is enabled automatically only when `HOST` is a loopback address, which is convenient for local development but dangerous if you expose that loopback listener through a public reverse proxy. Set `ALLOW_LOCAL_AUTH=0` on any proxied or shared host; the example `.env` starts with it disabled.

## Deployment

### Static hosting (GitHub Pages)

Static hosting can run the folio, but not the Node bridge. If no bridge answers and no token is stored, the page opens the public-only ledger automatically. Open the account dossier to add a personal access token or reopen the authorization gate; OAuth and local `gh` authorization remain unavailable. Unauthenticated GitHub requests are limited to 60/hour per IP, and only public data is available.

### Node hosting

Serve the repository root with `npm start` (or `node server.js`) behind HTTPS. Set the OAuth callback and `GITHUB_CALLBACK_URL` to the public HTTPS URL, set `HOST=0.0.0.0` if the reverse proxy connects over the network, and set `ALLOW_LOCAL_AUTH=0`. The frontend uses absolute `/api` and `/auth` paths, so serve it at the origin root unless you adapt those paths.

The real OAuth token exchange requires a registered OAuth app; it cannot be completed from GitHub Pages or from a static file server.

## Rate limits and caching

- Unauthenticated: **60 requests/hour per IP**.
- A token or bridge session: **5,000 requests/hour**.
- One cold authenticated load costs roughly `10 + 2 × repositories scanned` requests: profile, repository pages, two calls per deep repository (commits + languages), newest-commit detail, three search counts, and account extras. Incremental scans cost one repository-list call plus two calls only for repositories whose `pushed_at`, `size`, branch, or archive state changed.
- Public payloads are cached in the browser for **6 hours**. Private payloads are stored only as encrypted server snapshots. Repeat polls compare the snapshot timestamp and `ETag`, so an unchanged snapshot costs one indexed SQLite lookup and no decryption.
- The footer shows the remaining request budget and reset time when GitHub reports it.
- `MAX_DEEP_REPOS = 100` and `CONCURRENCY = 6` bound the scan.

## Verified locally

- Local `gh` session: **43 accessible repositories** — **29 private**, **14 public** — with private collaborator and organization repositories included; 204 commits indexed.
- Public-only mode: **13 owned public repositories** load without private data; 14 public repositories are accessible in total when collaborator repositories are included.
- Sign-out destroys the server session and returns to the gate.
- An invalid token is rejected with `401` and is not stored.
- OAuth redirect generation, state cookie, PKCE challenge, callback routing, and error handling were exercised with placeholder credentials. A real code exchange requires a registered OAuth app.

## Features

- Light / dark theming with CSS custom properties
- Command palette (`⌘K` / `Ctrl+K`) over sections, repositories, and actions
- Keyboard navigation: `J`/`K` rows, `Enter` inspect, `1`–`5` timeframe, `T` theme, `/` search, `Esc` clear
- Web Audio tactile click/tick feedback (mutable)
- CSV / JSON export of the filtered repository ledger
- Print stylesheet for a physical folio
- Responsive layout; heatmap and punch card scroll horizontally on narrow viewports

## License

MIT
