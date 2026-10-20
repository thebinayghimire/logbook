# Logbook Feature Roadmap

This document defines the important, convenient, and high-end features that can turn Logbook from a personal GitHub dashboard into a fast, trustworthy, production-grade developer intelligence product.

## Priority legend

| Priority | Meaning |
|---|---|
| **P0 — Required** | Must exist before a safe public launch |
| **P1 — Important** | Strongly recommended for a complete, dependable product |
| **P2 — Convenient** | Improves everyday usefulness and user experience |
| **P3 — High-end** | Advanced differentiation after the foundation is stable |

## Product principles

1. Ask for the minimum access required.
2. Never imply that OAuth itself contains GitHub account data.
3. Show cached data immediately, then update it safely in the background.
4. Be honest about freshness, incomplete scans, rate limits, and inaccessible repositories.
5. Keep GitHub tokens on the server and private data out of browser persistence.
6. Prefer webhooks and incremental updates over frequent full-account scans.
7. Make every dashboard useful with a mouse, keyboard, touch screen, or screen reader.
8. Treat metrics as explanations of developer activity, not judgments of developer quality.

---

## Current foundation

The project already includes several valuable foundations:

- Username-first GitHub OAuth onboarding.
- Verification that the entered username matches the account that authorized.
- Server-side OAuth token storage with an `HttpOnly` session cookie.
- A read-only GitHub API proxy.
- Public and accessible private repository discovery.
- Repository, commit, language, issue, pull-request, and account telemetry.
- A private in-memory account snapshot for fast repeat loads.
- Silent five-second conditional checks using ETags.
- Automatic rate-limit backoff.
- Responsive editorial dashboard, command palette, keyboard controls, filters, and exports.

These are a strong prototype foundation, but the items below are needed for a durable multi-user product.

---

# 1. Launch-critical features

## 1.1 Authentication and account lifecycle — P0

- **Use a GitHub App for production.**
  - Prefer fine-grained, read-only permissions over the broad OAuth `repo` scope.
  - Let users choose which repositories or organizations Logbook may access.
  - Use short-lived access tokens and refresh them securely.
  - Receive installation and permission-change webhooks.
- **Keep OAuth state, PKCE, and account-match verification.**
- **Production session store.**
  - Replace the in-memory session map with Redis or a database-backed session store.
  - Support multiple application instances and deployments without signing everyone out.
- **Session management screen.**
  - Show the current account, authorization type, granted permissions, creation time, and expiration.
  - Allow “Sign out everywhere” and revoke GitHub access.
- **Account switching.**
  - Sign out before authorizing a different account.
  - Never mix cached data from two GitHub identities.
- **Authorization recovery.**
  - Handle expired, revoked, or organization-blocked authorization with a clear recovery path.
- **Secure return URLs.**
  - Preserve the requested dashboard location through OAuth without allowing open redirects.

### Acceptance criteria

- A user cannot view another user’s private snapshot.
- Tokens never appear in HTML, URLs, logs, browser storage, or client-side JavaScript.
- Signing out invalidates the server session and makes its cached private snapshot inaccessible.
- Revoked access leads to reauthorization instead of a broken dashboard.

## 1.2 Fast data loading — P0

- **Persistent encrypted snapshots.**
  - Store normalized dashboard snapshots in a database instead of process memory.
  - Encrypt sensitive snapshot fields at rest.
  - Partition every record by the authenticated GitHub account ID.
- **Stale-while-revalidate loading.**
  - Render the last known snapshot immediately.
  - Validate freshness in the background.
  - Replace only the sections whose data changed.
- **Progressive first load.**
  - Load profile and repository totals first.
  - Render the main dashboard shell immediately.
  - Stream or progressively unlock commits, languages, account details, and file inspection.
- **Background jobs.**
  - Move expensive account scans out of the web request lifecycle.
  - Use a queue with job progress, retries, deduplication, and cancellation.
- **Incremental repository sync.**
  - Fetch only repositories changed since the previous successful sync.
  - Fetch only commits newer than the last indexed commit per branch or repository.
  - Avoid rescanning languages unless a repository changed.
- **Request deduplication.**
  - One GitHub account should never have multiple identical scans running simultaneously.
- **Payload optimization.**
  - Return normalized dashboard data rather than raw GitHub responses.
  - Enable Brotli or gzip compression.
  - Paginate large ledgers instead of sending everything on first load.

### Suggested performance targets

| Experience | Target |
|---|---:|
| Cached dashboard usable | Under 500 ms |
| Initial profile and repository summary | Under 2 seconds |
| Background refresh begins | Without blocking first paint |
| Interaction response | Under 100 ms |
| Layout shift | Near zero |

## 1.3 Reliable synchronization — P0

- **Replace broad five-second polling with webhooks where possible.**
  - Push events.
  - Repository creation, deletion, archival, transfer, and visibility changes.
  - Pull-request and issue events.
  - Installation and permission events.
- **Retain conditional polling as a fallback.**
  - Respect ETags, `Last-Modified`, rate-limit headers, and server-provided polling intervals.
  - Pause when the tab is hidden or the user is inactive.
- **Server-to-browser updates.**
  - Use Server-Sent Events for lightweight one-way updates.
  - Use WebSockets only if bidirectional realtime behavior becomes necessary.
- **Sync state machine.**
  - `queued`, `scanning`, `partial`, `current`, `stale`, `rate_limited`, and `failed` states.
- **Retry policy.**
  - Exponential backoff with jitter.
  - Respect `Retry-After` and GitHub rate-limit reset time.
  - Stop retrying permanent permission and not-found errors.
- **Last-known-good snapshot.**
  - Never replace valid data with a failed or incomplete scan.

## 1.4 Data correctness — P0

- **Correct contribution attribution.**
  - Match commits by verified GitHub identity and email rules.
  - Avoid counting every repository commit as authored by the signed-in user.
- **Complete pagination.**
  - Explicitly show when repository, commit, follower, star, gist, issue, or PR limits are reached.
- **Branch strategy.**
  - Define whether analytics use the default branch, all branches, or authored commits across branches.
- **Contribution calendar accuracy.**
  - Use GitHub GraphQL contribution collections when permissions allow.
  - Label locally derived heatmaps when official contribution data is unavailable.
- **Timezone settings.**
  - Let users choose GitHub timezone, browser timezone, or UTC.
  - Use the selected timezone consistently in streaks, hourly activity, and dates.
- **Bot and automation filtering.**
  - Separate human commits from Dependabot, bots, generated changes, and mirrored repositories.
- **Fork and archive handling.**
  - Make inclusion rules visible and configurable.
- **Partial-data indicators.**
  - Every metric should know its source, scan time, scope, and completeness.
- **Metric definitions.**
  - Provide a glossary explaining commits, active days, streaks, reviews, code volume, and repository activity.

## 1.5 Essential UX states — P0

- First-time onboarding.
- OAuth consent explanation.
- Initial indexing progress with an honest estimate.
- Cached-data view while revalidation runs.
- Empty account and empty repository states.
- No private repositories state.
- GitHub outage state.
- Rate-limited state with next retry time.
- Partial scan state listing affected repositories.
- Revoked authorization state.
- Deleted, renamed, transferred, or inaccessible repository state.
- Mobile and narrow-screen navigation.
- Offline fallback using the last safe snapshot.

---

# 2. Important product features

## 2.1 Dashboard customization — P1

- Drag-and-drop dashboard sections.
- Collapse, expand, hide, and reorder cards.
- Save a preferred default date range.
- Choose visible metrics.
- Compact, comfortable, and presentation density modes.
- Light, dark, and system themes.
- Persist preferences per account on the server.
- Reset layout to defaults.

## 2.2 Powerful filtering — P1

- Filter by organization, owner, repository, visibility, language, topic, and repository status.
- Filter by date range with presets and a custom date picker.
- Include or exclude forks, archived repositories, bots, merge commits, and generated files.
- Combine filters with AND/OR rules.
- Display active filters as removable chips.
- Encode filters in the URL for bookmarking and sharing.
- Save named filter presets such as “Work,” “Open source,” or “TypeScript projects.”

## 2.3 Search and navigation — P1

- Global fuzzy search across repositories, commits, languages, organizations, and files.
- Command palette actions for every major navigation and filtering operation.
- Recent searches.
- Keyboard-first table navigation.
- Deep links to a repository, commit, chart selection, or date range.
- Browser back/forward support for filters and opened inspectors.

## 2.4 Repository intelligence — P1

- Repository overview page.
- README preview with safe Markdown rendering.
- Default branch, license, topics, release, and dependency summary.
- Commit velocity and recency.
- Contributor breakdown.
- Open issue and pull-request summary.
- Release cadence.
- Repository health indicators.
- Branch and tag explorer.
- File tree with lazy loading.
- Code ownership and high-change file hotspots.
- Repository comparison view.

## 2.5 Activity timeline — P1

- Unified chronological feed for commits, PRs, reviews, issues, releases, and repository changes.
- Group related events to reduce noise.
- Filter by event type and repository.
- Infinite scroll with stable pagination.
- Direct links to the corresponding GitHub activity.
- Expandable commit diffs with safe size limits.

## 2.6 Export and portability — P1

- CSV export for tables.
- JSON export for normalized account data.
- PNG and SVG export for individual charts.
- Print-optimized report.
- PDF report generation on the server.
- Date-range-aware exports.
- Include metadata describing filters, freshness, and incomplete data.
- User-controlled deletion and export of all stored Logbook data.

## 2.7 Accessibility — P1

- WCAG 2.2 AA contrast and interaction targets.
- Complete keyboard navigation.
- Visible focus indicators.
- Semantic headings, landmarks, buttons, tables, and forms.
- Screen-reader descriptions for charts and heatmaps.
- Text or table alternatives for every visualization.
- Reduced-motion support.
- High-contrast mode.
- No information communicated through color alone.
- Correct live-region behavior without announcing silent background refreshes.
- Automated and manual accessibility testing.

---

# 3. Convenience features

## 3.1 Everyday usability — P2

- Remember the last open section and scroll position.
- Recently viewed repositories.
- Favorite or pin repositories.
- Quick-copy buttons for repository URL, clone URL, branch name, and commit SHA.
- Open in GitHub, GitHub Desktop, or VS Code.
- Friendly relative dates with exact timestamps on hover or focus.
- Density controls for long tables and timelines.
- Column chooser and resizable table columns.
- Sort by multiple columns.
- Undo for reversible UI actions.
- Helpful tooltips with keyboard access.
- Context menus for repositories and commits.

## 3.2 Saved views — P2

- Save the current filters, columns, sort, and date range as a named view.
- Pin saved views to the header.
- Set a default view.
- Duplicate, rename, reorder, and delete views.
- Generate a shareable read-only link with explicit privacy controls.

## 3.3 Notifications — P2

- Optional notifications for:
  - New release.
  - Pull request opened, merged, or awaiting review.
  - Failed workflow.
  - New issue.
  - Repository archived or transferred.
  - Unusual activity spike.
- Per-repository notification controls.
- In-app notification center.
- Email or browser notifications only after explicit opt-in.
- Quiet hours and digest frequency.

## 3.4 Personal annotations — P2

- Private notes on repositories, commits, and time periods.
- Tags such as “portfolio,” “learning,” “client,” or “maintenance.”
- Personal project goals and milestones.
- Bookmarks to important commits or releases.
- Notes remain private and are exportable/deletable.

## 3.5 Installable experience — P2

- Progressive Web App manifest.
- Installable desktop/mobile experience.
- Offline access to the last approved snapshot.
- Background update notification.
- App icons, shortcuts, and native share integration.

---

# 4. High-end analytics

## 4.1 Contribution intelligence — P3

- Week-over-week, month-over-month, and year-over-year comparisons.
- Rolling averages and seasonality.
- Contribution streak quality rather than streak length alone.
- Focus time and context-switch estimates based on repository transitions.
- Work-hour distribution with timezone awareness.
- Burst, consistency, and maintenance patterns.
- New work versus maintenance work.
- Personal, organization, and open-source activity separation.
- Repository lifecycle classification: active, maintained, dormant, archived.

## 4.2 Code-change intelligence — P3

- Additions, deletions, and files changed over time.
- Churn by repository, directory, and file.
- High-change hotspots.
- Language migration trends.
- Test-to-source change ratio.
- Documentation activity.
- Dependency update activity.
- Large-change and risky-change detection.
- Generated-file and vendored-code exclusion.

## 4.3 Collaboration analytics — P3

- PR authoring, review, and merge activity.
- Median time to first review.
- Median time to merge.
- Review participation by repository.
- Issue response and closure trends.
- Collaboration network visualization.
- Organization and team breakdowns where permissions allow.
- Avoid competitive “developer scoring”; present context and uncertainty.

## 4.4 Engineering health — P3

- Workflow success rate and duration.
- Release frequency.
- Change failure indicators where deployment data is available.
- Mean recovery indicators where incidents can be linked safely.
- Dependabot and security alert summaries with explicit permissions.
- Stale PR and issue detection.
- Repository hygiene checklist.
- Missing license, README, code owners, tests, or branch protection indicators.

## 4.5 Comparative views — P3

- Compare two date ranges.
- Compare repositories.
- Compare languages or organizations.
- Overlay current year and previous year.
- Explain meaningful changes rather than only displaying deltas.
- Clearly label comparisons that use incomplete or differently scoped data.

---

# 5. High-end presentation features

## 5.1 Interactive visualizations — P3

- Zoomable contribution timeline.
- Repository lifecycle Gantt chart.
- Language evolution streamgraph.
- Commit-hour radial clock.
- Repository relationship map.
- Churn hotspot treemap.
- Drill-down from every chart into the underlying records.
- Cross-filtering: selecting one chart filters the rest of the dashboard.
- Accessible table equivalents for every visualization.

## 5.2 Portfolio mode — P3

- User-selected public repositories only.
- Custom biography and project descriptions.
- Featured work and pinned case studies.
- Public share page with no private-data leakage.
- Custom domain and social preview cards.
- Downloadable résumé/project report.
- Hide vanity metrics or sensitive activity periods.

## 5.3 Presentation and kiosk mode — P3

- Full-screen, distraction-free dashboard.
- Automatic section rotation.
- Large-display typography.
- Read-only public display tokens.
- Configurable refresh cadence.
- No private repository names or metadata unless explicitly allowed.

---

# 6. AI-assisted features

AI features should be optional, evidence-linked, and disabled by default for private code.

## 6.1 Useful AI capabilities — P3

- Natural-language query: “What did I work on last month?”
- Weekly or monthly activity summary.
- Repository onboarding summary.
- Explain an unusual activity spike.
- Group related commits into themes.
- Draft release notes from selected commits.
- Summarize open issues and PRs.
- Suggest useful saved views based on activity patterns.
- Generate a portfolio narrative from repositories explicitly selected by the user.

## 6.2 AI safety requirements — P0 before enabling AI

- Never send private source or metadata to a model without explicit opt-in.
- Show exactly which records will be processed.
- Allow public-only, metadata-only, and fully disabled modes.
- Do not train on user data without separate explicit consent.
- Link every generated claim to underlying GitHub evidence.
- Label uncertainty and incomplete context.
- Provide deletion and retention controls.
- Defend against prompt injection contained in repository files, issues, and READMEs.

---

# 7. Privacy and security

## 7.1 Required controls — P0

- HTTPS-only production deployment.
- Secure, `HttpOnly`, `SameSite` cookies.
- CSRF protection for every state-changing endpoint.
- Strict Content Security Policy without unrestricted inline scripts.
- Secure secret management; never production secrets in `.env` files committed or copied into images.
- Encryption at rest for snapshots and account metadata.
- Key rotation procedure.
- Token refresh and revocation handling.
- Input validation and output encoding.
- Safe Markdown rendering and HTML sanitization.
- SSRF protection for server-side URL fetching.
- Request-body and response-size limits.
- Per-user and per-IP rate limits.
- Audit logs for authorization, export, deletion, and administrative access.
- Dependency and secret scanning in CI.
- Security headers and origin validation.
- Automated session expiration and cleanup.
- “Delete my Logbook data” workflow.
- Privacy policy and clear data-retention policy.

## 7.2 Permission transparency — P1

- Explain every GitHub permission in plain language.
- Show why private-repository access is requested.
- Display repositories currently accessible to Logbook.
- Warn when organization policy blocks data.
- Notify users when permissions change.
- Provide a direct link to revoke access on GitHub.

---

# 8. Reliability and operations

## 8.1 Production infrastructure — P0

- Managed relational database for users, installations, snapshots, preferences, and audit data.
- Redis for sessions, locks, rate-limit coordination, and short-lived cache.
- Background job queue for indexing.
- Horizontal scaling without duplicate scans.
- Health, readiness, and liveness endpoints.
- Graceful shutdown and job handoff.
- Database migrations and rollback procedures.
- Automated encrypted backups with restoration tests.
- Separate development, staging, and production environments.

## 8.2 Observability — P1

- Structured logs with request and sync IDs.
- Never log access tokens, secrets, private file contents, or complete private payloads.
- Metrics for page latency, cache-hit rate, GitHub calls, rate-limit usage, sync duration, and failures.
- Distributed tracing across web request, queue job, and GitHub calls.
- Error monitoring with privacy-safe context.
- Alerts for OAuth failures, webhook failures, elevated latency, queue backlog, and GitHub rate limiting.
- Internal status dashboard.

## 8.3 Cost and quota controls — P1

- Per-account scan budget.
- Repository and history limits appropriate to the subscription tier.
- Shared request deduplication.
- Adaptive sync frequency based on activity.
- Backpressure during GitHub incidents.
- Storage retention and compaction.
- Admin visibility into expensive accounts and endpoints.

---

# 9. Testing and quality

## 9.1 Automated testing — P0

- Unit tests for metric builders and date calculations.
- OAuth state, PKCE, username-match, expiration, and revocation tests.
- Session isolation tests.
- Snapshot ownership and deletion tests.
- GitHub API pagination and rate-limit tests.
- Conditional request and `304` tests.
- Partial repository failure tests.
- UI component and interaction tests.
- End-to-end authorization and dashboard tests using a dedicated test account.
- Responsive tests at common phone, tablet, laptop, and ultrawide sizes.
- Accessibility checks in CI.
- Visual regression screenshots for major sections.
- Load tests for concurrent users and large GitHub accounts.

## 9.2 Manual release checklist — P0

- New authorization works.
- Existing session restores instantly.
- Account mismatch is rejected.
- Sign-out destroys the session and snapshot.
- Private names never appear after sign-out.
- Cached data updates after a webhook or conditional change.
- Rate limiting does not create a retry storm.
- Mobile layout has no horizontal breakout.
- Keyboard-only navigation works.
- Dark and light themes remain readable.
- Exports match the selected filters and date range.

---

# 10. Recommended architecture

```text
Browser
  ├─ OAuth/session cookie
  ├─ Fast dashboard snapshot request
  └─ Server-Sent Events for completed updates

Web application
  ├─ Authentication/session service
  ├─ Dashboard API
  ├─ Permission and privacy enforcement
  └─ Static application delivery

Sync workers
  ├─ GitHub REST/GraphQL clients
  ├─ Incremental repository indexer
  ├─ Rate-limit coordinator
  └─ Snapshot builder

GitHub App webhooks
  └─ Deduplicated queue events

Storage
  ├─ PostgreSQL: accounts, preferences, normalized metrics
  ├─ Object storage: optional large exports
  └─ Redis: sessions, locks, queue, short-lived cache
```

---

# 11. Recommended delivery phases

## Phase 1 — Safe public launch

- GitHub App migration or hardened OAuth deployment.
- Persistent session store.
- Encrypted persistent snapshots.
- Background job queue.
- Progressive loading and complete error states.
- Correct contribution attribution.
- Accessibility baseline.
- Automated auth, session, and snapshot tests.
- HTTPS, CSP, CSRF protection, rate limiting, monitoring, and deletion controls.

## Phase 2 — Fast and dependable synchronization

- Webhook ingestion.
- Incremental repository and commit indexing.
- Server-Sent Events.
- Request deduplication and distributed locks.
- Freshness metadata and sync history.
- Pagination and virtualized large tables.

## Phase 3 — Everyday product quality

- Saved views and URL-backed filters.
- Dashboard customization.
- Better global search.
- Repository detail pages.
- Export improvements.
- PWA and offline last-snapshot access.
- Notification preferences.

## Phase 4 — Differentiating intelligence

- Trend comparisons.
- Code churn and hotspot analysis.
- Collaboration and engineering-health analytics.
- Portfolio mode.
- Advanced cross-filtered visualizations.
- Carefully permissioned AI summaries.

---

# 12. Features to avoid or treat carefully

- **Full account scans every five seconds.** They are slow and risk GitHub rate limits; use webhooks, ETags, and incremental jobs.
- **Persisting private payloads in `localStorage`.** Any script running on the origin can read them.
- **Exposing OAuth tokens to browser JavaScript.** Keep tokens server-side.
- **Claiming classic OAuth `repo` scope is read-only.** The application may only issue reads, but that scope itself is broad.
- **Developer productivity scores.** Commit counts and code volume lack sufficient context and can encourage harmful comparisons.
- **Public sharing by default.** Sharing must be explicit and must exclude private metadata unless separately confirmed.
- **Silent destructive actions.** Revocation, deletion, and account replacement need explicit confirmation.
- **Unbounded repository scans.** Large accounts need queues, pagination, budgets, and incremental indexing.
- **AI processing of private repositories by default.** Require explicit, granular consent.

---

# 13. Definition of a production-ready Logbook

Logbook is ready for a broad public launch when:

- Authorization is least-privilege, secure, revocable, and recoverable.
- Every user and snapshot is isolated by immutable GitHub account ID.
- Cached dashboards load quickly and refresh incrementally.
- Webhooks handle common updates, with conditional polling only as a fallback.
- Metrics are correct, documented, timezone-aware, and visibly scoped.
- Partial and stale data are clearly identified.
- Mobile, keyboard, screen-reader, reduced-motion, light, and dark experiences work.
- Users can export and delete their data.
- Tests cover OAuth, isolation, pagination, rate limits, synchronization, and responsive UI.
- Monitoring can detect broken OAuth, delayed jobs, stale snapshots, and API exhaustion.
- Private data and secrets never appear in logs, client storage, public exports, or another user’s session.

