# Logbook

An interactive GitHub archival telemetry folio — a single-file, zero-build dashboard that reads **live** from the GitHub REST API.

**Live:** https://thebinayghimire.github.io/logbook/

Open it and it automatically loads `@thebinayghimire` — no configuration, no build step, no backend.

## How the data works

Everything on the page is fetched from `api.github.com` at load time. Nothing is hardcoded.

| Section | Source |
|---|---|
| Profile / avatar | `GET /users/:user` |
| Repository ledger | `GET /users/:user/repos?per_page=100&sort=pushed` |
| Commit history (hero, push log, heatmap, punch card) | `GET /repos/:owner/:repo/commits?per_page=100` for every non-fork, non-archived repo |
| Language composition & code volume | `GET /repos/:owner/:repo/languages` (byte totals) |
| Pull requests authored | `GET /search/issues?q=author:USER+type:pr` |
| Issues authored | `GET /search/issues?q=author:USER+type:issue` |
| Reviews submitted | `GET /search/issues?q=is:pr+reviewed-by:USER` |
| Commit patches on expand | `GET /repos/:owner/:repo/commits/:sha` (lazy, per click) |
| File tree & README in the inspector | `GET /repos/:owner/:repo/git/trees/:branch?recursive=1` + `GET /repos/:owner/:repo/readme` (lazy) |

### What is derived, not fetched

- **Contribution heatmap** — GitHub's official contribution graph (which includes private + org contributions) is only exposed through GraphQL. This folio buckets the actual commit timestamps it fetches instead, so the grid reflects commits inside the scanned repositories.
- **Punch card** — weekday × hour buckets from the same commit timestamps.
- **KPI sparklines** — commit counts binned across the selected window.
- **"Code volume"** — sum of language byte totals, not a `git diff` line count.

## Rate limits

Unauthenticated GitHub API access allows **60 requests/hour per IP**. One full load costs roughly `5 + 2 × (repos scanned)` requests — about 30 for a 13-repo account.

- Payloads are cached in `localStorage` for 20 minutes, so repeat visits cost 0 requests.
- If the limit is hit, a banner appears; the counter in the footer shows remaining budget and reset time.
- A **personal access token** raises this to 5,000/hour and unlocks **private repositories**. Add one via the `@handle` button in the header. It is kept in `sessionStorage` for that tab only and is never written into the page or committed.

## Sections

| # | Section | Contents |
|---|---------|----------|
| 01 | **Now** | Latest push hero, 24-hour radix timeline, last-7-days bars, live diff inspector |
| 02 | **Pulse** | Six KPI cards with scrubable sparklines and drill-down ledger |
| 03 | **Rhythm** | Contribution heatmap (3 years), punch-card clock matrix, focus bars |
| 04 | **Repositories** | Full ledger + lifespans Gantt + live file/README inspector |
| 05 | **Languages** | Segmented composition bar, ranked breakdown, quarterly small multiples |
| 06 | **Push Log** | Chronological timeline with lazily fetched inline patches |

## Features

- Light / dark theming with CSS custom properties
- Command palette (`⌘K` / `Ctrl+K`) over sections, repos, and actions
- Keyboard navigation: `J`/`K` rows, `Enter` inspect, `1`–`5` timeframe, `T` theme, `/` search, `Esc` clear
- Web Audio tactile click/tick feedback (mutable)
- CSV / JSON export of the filtered repository ledger
- Print stylesheet for a physical folio
- Fully responsive; heatmap and punch card scroll horizontally on narrow viewports

## Run locally

```powershell
python -m http.server 8080
# http://localhost:8080
```

Serving over HTTP is recommended — `localStorage` caching and the token session behave differently on `file://`.

## Deployment

GitHub Pages, `main` branch root. A push to `main` republishes within about a minute.

## License

MIT
