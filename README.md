# Logbook

An interactive GitHub archival telemetry folio — a single-file, zero-build dashboard for exploring commit history, contribution rhythm, repository portfolio, language composition, and push logs.

**Live:** https://thebinayghimire.github.io/logbook/

## What it is

A self-contained `index.html` (Tailwind via CDN, no bundler, no backend) that renders an editorial "rag paper / carbon night" almanac of a developer's git history.

Sections:

| # | Section | Contents |
|---|---------|----------|
| 01 | **Now** | Latest push hero, 24-hour radix timeline, last-7-days bars, diff inspector |
| 02 | **Pulse** | Six KPI cards with scrubable sparklines and drill-down ledgers |
| 03 | **Rhythm** | 53×7 contribution heatmap (2024–2026), punch-card clock matrix, focus bars |
| 04 | **Repositories** | 38-repo ledger + lifespans Gantt + file/source inspector |
| 05 | **Languages** | Segmented composition bar, ranked breakdown, quarterly small multiples |
| 06 | **Push Log** | Chronological timeline with inline expandable diffs |

## Live GitHub data

The folio can read real public telemetry without any key. Click the `@handle` pill in the header, enter a GitHub username, and hit **Fetch Live** — it queries:

```
https://api.github.com/users/{username}/repos?sort=pushed&per_page=38
```

and re-hydrates the repository ledger, hero commit, and inspector from the response. Unauthenticated calls are rate-limited to 60 requests/hour per IP, so heavy use may need a token.

## Features

- Light / dark theming with CSS custom properties
- Command palette (`⌘K` / `Ctrl+K`) with fuzzy section, repo, and action search
- Keyboard navigation: `J`/`K` rows, `Enter` inspect, `1`–`5` timeframe, `T` theme, `/` search, `Esc` clear
- Web Audio tactile click/tick feedback (mutable)
- CSV / JSON export of the filtered repository ledger
- Print stylesheet for a physical folio
- Fully responsive; heatmap and punch card scroll horizontally on narrow viewports

## Run locally

No build step. Open `index.html` directly, or serve it:

```powershell
python -m http.server 8080
# then visit http://localhost:8080
```

## Deployment

Hosted with GitHub Pages from the `main` branch root. Any push to `main` republishes the site within about a minute.

## Notes

All bundled dataset values (repositories, commits, language splits) are illustrative sample data. Use the live GitHub fetch to replace them with real telemetry.

## License

MIT
