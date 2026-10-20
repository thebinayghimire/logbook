"use strict";

/**
 * Background account scanner.
 *
 * Scans run outside the request lifecycle. A scan writes a small summary
 * snapshot as soon as the profile and repository list are known, then folds in
 * commit and language detail for repositories that changed since the previous
 * successful scan. The previous snapshot is the source of truth for unchanged
 * repositories, so a refresh is incremental rather than a full re-crawl.
 *
 * Correctness rules:
 *   - only commits attributed to the authorized GitHub identity are counted;
 *   - bot and merge commits are excluded by default;
 *   - analytics use each repository's default branch (documented in the scope);
 *   - a failed scan never replaces the last known good snapshot;
 *   - pagination and per-repository caps are recorded instead of silently
 *     presenting incomplete data as complete.
 */

const crypto = require("crypto");
const {
  buildAuthorIdentity,
  normalizeCommits
} = require("./identity");

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const MAX_DEEP_REPOS = 100;
const MAX_COMMITS_PER_REPO = 100;
const CONCURRENCY = 6;

class SyncEngine {
  constructor(store, options = {}) {
    this.store = store;
    this.running = new Map();
    this.subscribers = new Map();
    this.includeBots = options.includeBots === true;
    this.includeMergeCommits = options.includeMergeCommits === true;
  }

  subscribe(accountId, listener) {
    const id = String(accountId);
    const set = this.subscribers.get(id) || new Set();
    set.add(listener);
    this.subscribers.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.subscribers.delete(id);
    };
  }

  publish(entry, extra = {}) {
    const set = this.subscribers.get(String(entry.job.accountId));
    if (!set || !set.size) return;
    const payload = Object.assign(publicJob(entry.job), {
      snapshotAt: this.snapshotAt(entry.job.accountId)
    }, extra);
    for (const listener of set) {
      try { listener(payload); } catch (error) { /* a closed SSE stream must not break a scan */ }
    }
  }

  snapshotAt(accountId) {
    const head = this.store.head(accountId);
    return head ? head.updatedAt : null;
  }

  enqueue(session, force) {
    const accountId = String(session.profile.id);
    const active = this.running.get(accountId);
    if (active) return publicJob(active.job);

    const now = Date.now();
    const job = {
      id: crypto.randomUUID(), accountId, state: "queued", phase: "queued",
      progress: 0, error: null, createdAt: now, updatedAt: now
    };
    const entry = { job, public: publicJob(job), cancelled: false };
    this.running.set(accountId, entry);
    this.store.saveJob(job);
    this.publish(entry);
    setImmediate(() => this.run(entry, session, force).catch(() => {}));
    return entry.public;
  }

  status(accountId) {
    const active = this.running.get(String(accountId));
    return active ? publicJob(active.job) : this.store.latestJob(accountId);
  }

  cancel(accountId) {
    const entry = this.running.get(String(accountId));
    if (!entry) return false;
    entry.cancelled = true;
    this.update(entry, { state: "cancelled", phase: "cancelled" });
    return true;
  }

  update(entry, patch) {
    Object.assign(entry.job, patch, { updatedAt: Date.now() });
    entry.public = publicJob(entry.job);
    this.store.saveJob(entry.job);
    this.publish(entry);
  }

  async run(entry, session, force) {
    const id = entry.job.accountId;
    const login = session.login;
    try {
      this.update(entry, { state: "scanning", phase: "profile", progress: 5 });
      // Keep the previous snapshot even on a forced refresh: force controls
      // which repositories are re-fetched, not whether the screen goes blank.
      const oldRecord = this.store.get(id);
      const old = oldRecord && oldRecord.payload;
      // Schema 3 introduced verified-identity attribution. Older snapshots
      // counted every commit in an accessible repository, so they must be
      // re-indexed rather than incrementally patched.
      const effectiveForce = force || !old || Number(old.schemaVersion || 0) < 3;
      const oldCommits = groupCommits((old && old.commits) || []);
      const oldLanguages = (old && old.repoLanguages) || {};

      const api = githubClient(session.token);
      const profile = await api.get("/user");
      const identity = await fetchIdentity(api, profile);
      const repoPage = await api.allWithMeta("/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=pushed&direction=desc");
      const allRepos = repoPage.items;
      const deep = allRepos.filter((repo) => !repo.fork && !repo.archived).slice(0, MAX_DEEP_REPOS);

      // Commit a small, renderable snapshot as soon as profile and repository
      // totals arrive so the dashboard shell can paint immediately.
      const summary = emptyPayload(profile.login, profile, allRepos, deep);
      mergeExistingDetail(summary, old, deep);
      summary.limits.repositories = {
        fetched: allRepos.length,
        pages: repoPage.pages,
        truncated: repoPage.truncated,
        maxPages: repoPage.maxPages
      };
      summary.partial = summary.partial || repoPage.truncated;
      summary.loading = true;
      summary.syncing = true;
      summary.syncStartedAt = entry.job.createdAt;
      summary.attribution = attributionSummary(identity, this);
      this.store.put(id, profile.login, summary);
      this.update(entry, { phase: "repositories", progress: 20 });

      const previousByName = new Map(((old && old.repos) || []).map((repo) => [repo.full_name, repo]));
      const changed = deep.filter((repo) => effectiveForce || repoChanged(repo, previousByName.get(repo.full_name)));

      let completed = 0;
      const commitTruncations = [];
      const details = await mapLimit(changed, CONCURRENCY, async (repo) => {
        if (entry.cancelled) throw new Error("sync cancelled");
        const previous = oldCommits.get(repo.full_name) || [];
        // Only ask GitHub for commits newer than the newest indexed commit,
        // unless this repository was never indexed or a full refresh is forced.
        const sinceParam = !effectiveForce && previous[0] && previous[0].iso
          ? "?since=" + encodeURIComponent(previous[0].iso)
          : "";
        const base = "/repos/" + repo.full_name.split("/").map(encodeURIComponent).join("/");

        let fresh = [];
        if (repo.size) {
          try {
            fresh = await api.all(base + "/commits" + sinceParam, sinceParam ? 3 : 1);
          } catch (error) {
            if (error.status !== 409) throw error;
          }
        }

        if (!effectiveForce && sinceParam && fresh.length >= 300) commitTruncations.push(repo.full_name);
        const normalized = normalizeCommits(repo, fresh, identity, {
          includeBots: this.includeBots,
          includeMergeCommits: this.includeMergeCommits
        });
        const combined = normalized.concat(previous);
        const unique = Array.from(new Map(combined.map((commit) => [commit.fullSha, commit])).values())
          .filter((commit) => commit.included)
          .sort((a, b) => String(b.iso).localeCompare(String(a.iso)))
          .slice(0, MAX_COMMITS_PER_REPO);
        if (combined.filter((commit) => commit.included).length > MAX_COMMITS_PER_REPO) {
          commitTruncations.push(repo.full_name);
        }

        let languages = oldLanguages[repo.full_name] || {};
        let languageWarning = null;
        // Language totals are expensive to re-fetch (one call per repository).
        // Reuse them unless the repository is new, its size/language changed,
        // or a full refresh was requested.
        const previousRepo = previousByName.get(repo.full_name);
        const languageCouldChange = effectiveForce || !previousRepo || !oldLanguages[repo.full_name] ||
          repo.size !== previousRepo.size || repo.language !== previousRepo.language;
        if (repo.size && languageCouldChange) {
          try { languages = await api.get(base + "/languages"); }
          catch (error) { if (error.status !== 409) languageWarning = String(error.message || error); }
        }

        completed++;
        this.update(entry, {
          phase: "history",
          progress: 20 + Math.round((completed / Math.max(1, changed.length)) * 55)
        });
        return {
          repo, commits: unique, languages, languageWarning,
          scanCount: normalized.length,
          rawCount: fresh.length
        };
      });

      if (entry.cancelled) {
        this.markSnapshotFailed(id, login, new Error("sync cancelled"), true);
        return;
      }
      const byName = new Map(details.filter((detail) => !detail.__error).map((detail) => [detail.repo.full_name, detail]));
      const failures = details.filter((detail) => detail.__error);

      const payload = emptyPayload(profile.login, profile, allRepos, deep);
      payload.limits.repositories = summary.limits.repositories;
      payload.partial = failures.length > 0 || repoPage.truncated;
      payload.failedRepos = failures.length;
      payload.failedRepoNames = failures.map((failure) => failure.__name || "unknown");
      payload.attribution = attributionSummary(identity, this);
      payload.repoLanguages = {};
      for (const repo of deep) {
        const detail = byName.get(repo.full_name);
        // A failed repository keeps its last successfully indexed commits and
        // languages instead of disappearing from the ledger.
        const commits = detail ? detail.commits : (oldCommits.get(repo.full_name) || []);
        const languages = detail ? detail.languages : (oldLanguages[repo.full_name] || {});
        if (detail && detail.languageWarning) {
          payload.partial = true;
          payload.languageWarnings = (payload.languageWarnings || []).concat(repo.full_name + ": " + detail.languageWarning);
        }
        payload.commits.push(...commits);
        payload.repoCommits[repo.full_name] = commits.length;
        payload.repoLanguages[repo.full_name] = languages;
        for (const [language, bytes] of Object.entries(languages)) {
          payload.langTotals[language] = (payload.langTotals[language] || 0) + bytes;
          payload.langRepos[language] = (payload.langRepos[language] || 0) + 1;
        }
      }
      payload.commits.sort((a, b) => String(b.iso).localeCompare(String(a.iso)));

      this.update(entry, { phase: "account", progress: 80 });
      const searches = await Promise.all([
        api.get("/search/issues?q=" + encodeURIComponent("author:" + profile.login + " type:pr") + "&per_page=1").catch(() => ({ total_count: 0 })),
        api.get("/search/issues?q=" + encodeURIComponent("author:" + profile.login + " type:issue") + "&per_page=1").catch(() => ({ total_count: 0 })),
        api.get("/search/issues?q=" + encodeURIComponent("is:pr reviewed-by:" + profile.login) + "&per_page=1").catch(() => ({ total_count: 0 }))
      ]);
      payload.prs = searches[0].total_count || 0;
      payload.issues = searches[1].total_count || 0;
      payload.reviews = searches[2].total_count || 0;
      const extras = await Promise.all([
        api.all("/user/orgs").catch(() => []), api.all("/user/starred").catch(() => []),
        api.all("/gists").catch(() => []), api.all("/user/followers").catch(() => []),
        api.all("/user/following").catch(() => [])
      ]);
      payload.account = { orgs: extras[0], starred: extras[1], gists: extras[2], followers: extras[3], following: extras[4] };

      // Official GitHub contribution calendar, when GraphQL is available.
      // If it is not, the client clearly labels the locally derived heatmap.
      const contributions = await fetchContributionCalendar(api);
      if (contributions) {
        payload.contributionCalendar = contributions;
        payload.contributionSource = "github-graphql";
      } else {
        payload.contributionSource = "local-scan";
      }

      payload.scope = {
        branches: "default",
        attribution: "verified-identity",
        bots: this.includeBots ? "included" : "excluded",
        mergeCommits: this.includeMergeCommits ? "included" : "excluded",
        forks: "excluded-from-detail",
        archived: "excluded-from-detail",
        timezone: "UTC",
        scansRunAt: Date.now()
      };
      if (commitTruncations.length) {
        payload.partial = true;
        payload.limits.commitScanTruncated = Array.from(new Set(commitTruncations));
      }

      payload.fetchedAt = Date.now();
      payload.loading = false;
      payload.syncing = false;
      this.store.put(id, profile.login, payload);
      this.update(entry, {
        state: payload.partial ? "partial" : "current",
        phase: "complete",
        progress: 100
      });
    } catch (error) {
      const cancelled = entry.cancelled || String(error.message || error) === "sync cancelled";
      // Never replace valid data with a failed scan. The summary written above
      // (or the previous snapshot) stays readable; we only flag it.
      this.markSnapshotFailed(id, login, error, cancelled);
      this.update(entry, {
        state: cancelled ? "cancelled" : "failed",
        phase: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : String(error.message || error)
      });
    } finally {
      this.running.delete(id);
    }
  }

  markSnapshotFailed(accountId, login, error, cancelled) {
    try {
      const record = this.store.get(accountId);
      if (!record) return;
      const payload = record.payload;
      payload.loading = false;
      payload.syncing = false;
      if (!cancelled) payload.syncError = String(error.message || error);
      this.store.put(accountId, payload.username || login, payload);
    } catch (patchError) {
      console.error("[logbook] could not flag failed snapshot:", patchError.message);
    }
  }
}

function attributionSummary(identity, engine) {
  return {
    author: identity && identity.login ? "@" + identity.login : "unknown",
    method: "github-login-or-verified-email",
    verifiedEmails: identity ? identity.emails.size : 0,
    bots: engine.includeBots ? "included" : "excluded",
    mergeCommits: engine.includeMergeCommits ? "included" : "excluded"
  };
}

async function fetchIdentity(api, profile) {
  let emails = [];
  try { emails = await api.get("/user/emails"); } catch (error) { /* scope may be absent */ }
  if (!Array.isArray(emails)) emails = [];
  return buildAuthorIdentity(profile, emails.filter((entry) => entry && entry.verified !== false));
}

async function fetchContributionCalendar(api) {
  if (typeof api.graphql !== "function") return null;
  const currentYear = new Date().getUTCFullYear();
  const years = {};
  let ok = false;
  for (let offset = 0; offset < 3; offset++) {
    const year = currentYear - offset;
    const query = `query($from: DateTime!, $to: DateTime!) {
      viewer {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`;
    try {
      const data = await api.graphql(query, {
        from: `${year}-01-01T00:00:00Z`,
        to: `${year}-12-31T23:59:59Z`
      });
      const calendar = data && data.viewer && data.viewer.contributionsCollection &&
        data.viewer.contributionsCollection.contributionCalendar;
      if (!calendar) continue;
      const days = {};
      for (const week of calendar.weeks || []) {
        for (const day of week.contributionDays || []) {
          if (day && day.date) days[day.date] = Number(day.contributionCount) || 0;
        }
      }
      years[String(year)] = { total: Number(calendar.totalContributions) || 0, days };
      ok = true;
    } catch (error) {
      // GraphQL may be unavailable for the token type or organization policy.
      // The local heatmap is a clearly labeled fallback.
    }
  }
  return ok ? { source: "github-graphql", fetchedAt: Date.now(), years } : null;
}

function emptyPayload(login, profile, repos, deep) {
  return {
    schemaVersion: 3,
    username: login,
    fetchedAt: 0,
    loading: false,
    syncing: false,
    partial: false,
    failedRepos: 0,
    failedRepoNames: [],
    profile,
    repos: repos.map(leanRepo),
    deepRepos: deep.map(leanDeepRepo),
    limits: {
      deepRepositories: {
        included: deep.length,
        discovered: repos.filter((repo) => !repo.fork && !repo.archived).length,
        cap: MAX_DEEP_REPOS
      },
      commitsPerRepository: MAX_COMMITS_PER_REPO
    },
    commits: [],
    repoCommits: {},
    repoLanguages: {},
    langTotals: {},
    langRepos: {},
    account: { orgs: [], starred: [], gists: [], followers: [], following: [] },
    privateRepos: repos.filter((repo) => repo.private).length,
    publicRepos: repos.filter((repo) => !repo.private).length,
    prs: 0,
    issues: 0,
    reviews: 0,
    attribution: null,
    contributionSource: "local-scan",
    contributionCalendar: null,
    scope: null
  };
}

function mergeExistingDetail(target, old, deep) {
  if (!old) return target;
  const names = new Set(deep.map((repo) => repo.full_name));
  target.commits = (old.commits || []).filter((commit) => names.has(commit.repoFullName));
  target.repoCommits = old.repoCommits || {};
  target.repoLanguages = old.repoLanguages || {};
  target.langTotals = old.langTotals || {};
  target.langRepos = old.langRepos || {};
  target.account = old.account || target.account;
  target.prs = old.prs || 0;
  target.issues = old.issues || 0;
  target.reviews = old.reviews || 0;
  target.partial = Boolean(old.partial);
  target.failedRepos = old.failedRepos || 0;
  target.failedRepoNames = old.failedRepoNames || [];
  target.fetchedAt = old.fetchedAt || 0;
  target.attribution = old.attribution || target.attribution;
  target.contributionCalendar = old.contributionCalendar || null;
  target.contributionSource = old.contributionSource || "local-scan";
  target.scope = old.scope || null;
  target.limits = Object.assign({}, old.limits || {}, target.limits || {});
  return target;
}

/**
 * The dashboard reads a handful of repository fields. GitHub's repository
 * objects are ~6 KB each because they embed every related URL, so storing and
 * shipping the raw objects made the repository list roughly 80% of a snapshot.
 */
function leanRepo(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner ? { login: repo.owner.login, avatar_url: repo.owner.avatar_url } : null,
    html_url: repo.html_url,
    description: repo.description || "",
    fork: Boolean(repo.fork),
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
    language: repo.language || null,
    default_branch: repo.default_branch || "main",
    stargazers_count: repo.stargazers_count || 0,
    forks_count: repo.forks_count || 0,
    open_issues_count: repo.open_issues_count || 0,
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 20) : [],
    license: repo.license && repo.license.spdx_id ? { spdx_id: repo.license.spdx_id } : null,
    size: repo.size || 0,
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    updated_at: repo.updated_at
  };
}

function leanDeepRepo(repo) {
  return {
    name: repo.name,
    full_name: repo.full_name,
    language: repo.language || null
  };
}

function repoChanged(repo, old) {
  return !old || ["pushed_at", "updated_at", "size", "default_branch", "archived", "fork"].some((key) => repo[key] !== old[key]);
}

function groupCommits(commits) {
  const grouped = new Map();
  for (const commit of commits) {
    const list = grouped.get(commit.repoFullName) || [];
    list.push(commit);
    grouped.set(commit.repoFullName, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => String(b.iso).localeCompare(String(a.iso)));
  return grouped;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        out[index] = await fn(items[index], index);
      } catch (error) {
        out[index] = { __error: String(error.message || error), __name: items[index].full_name };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function githubClient(token) {
  async function request(url, options = {}, attempt = 0) {
    const response = await fetch(url, Object.assign({
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "User-Agent": "Logbook/4.14",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(60000)
    }, options));
    if (!response.ok) {
      // Transient upstream failures get two exponential-backoff retries.
      // Permission, not-found, and validation errors are terminal.
      if (attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
        await sleep(retryDelayMs(response, attempt));
        return request(url, options, attempt + 1);
      }
      const error = new Error("GitHub " + response.status + " for " + requestPath(url));
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after");
      error.rateLimitReset = response.headers.get("x-ratelimit-reset");
      throw error;
    }
    return response.json();
  }

  async function get(apiPath, attempt = 0) {
    return request(GITHUB_API + apiPath, {}, attempt);
  }

  async function allWithMeta(apiPath, maxPages = 20) {
    const items = [];
    const separator = apiPath.includes("?") ? "&" : "?";
    let pages = 0;
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const batch = await get(apiPath + separator + "per_page=100&page=" + page);
      if (!Array.isArray(batch)) break;
      pages = page;
      items.push(...batch);
      if (batch.length < 100) break;
      if (page === maxPages) truncated = true;
    }
    return { items, pages, truncated, maxPages };
  }

  async function all(apiPath, maxPages = 20) {
    const result = await allWithMeta(apiPath, maxPages);
    return result.items;
  }

  async function graphql(query, variables) {
    const response = await fetch(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "Logbook/4.14"
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error("GitHub GraphQL " + response.status);
    const body = await response.json();
    if (body.errors && body.errors.length) throw new Error(body.errors[0].message || "GraphQL error");
    return body.data;
  }

  return { get, all, allWithMeta, graphql };
}

function requestPath(url) {
  try { return new URL(url).pathname; } catch (error) { return "unknown"; }
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number.parseFloat(response.headers.get("retry-after") || "0");
  const base = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : 500 * Math.pow(2, attempt);
  return Math.min(15000, base + Math.floor(Math.random() * 250));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicJob(job) {
  return {
    id: job.id, state: job.state, phase: job.phase, progress: job.progress,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt
  };
}

module.exports = { SyncEngine, fetchContributionCalendar };
