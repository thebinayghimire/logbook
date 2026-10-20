"use strict";

const crypto = require("crypto");

const GITHUB_API = "https://api.github.com";
const MAX_DEEP_REPOS = 100;
const CONCURRENCY = 6;

class SyncEngine {
  constructor(store) {
    this.store = store;
    this.running = new Map();
  }

  enqueue(session, force) {
    const accountId = String(session.profile.id);
    const active = this.running.get(accountId);
    if (active) return active.public;
    const now = Date.now();
    const job = {
      id: crypto.randomUUID(), accountId, state: "queued", phase: "queued",
      progress: 0, error: null, createdAt: now, updatedAt: now
    };
    const entry = { job, public: publicJob(job), cancelled: false };
    this.running.set(accountId, entry);
    this.store.saveJob(job);
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
  }

  async run(entry, session, force) {
    const id = entry.job.accountId;
    try {
      this.update(entry, { state: "scanning", phase: "profile", progress: 5 });
      const oldRecord = force ? null : this.store.get(id);
      const old = oldRecord && oldRecord.payload;
      const api = githubClient(session.token);
      const profile = await api.get("/user");
      const repos = await api.all("/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=pushed&direction=desc");
      const deep = repos.filter((r) => !r.fork && !r.archived).slice(0, MAX_DEEP_REPOS);

      // Commit a small, renderable snapshot as soon as profile and repository totals arrive.
      const summary = emptyPayload(profile.login, profile, repos, deep);
      if (old) mergeExistingDetail(summary, old, deep);
      summary.fetchedAt = Date.now();
      summary.loading = true;
      this.store.put(id, profile.login, summary);
      this.update(entry, { phase: "repositories", progress: 20 });

      const oldRepos = new Map(((old && old.repos) || []).map((r) => [r.full_name, r]));
      const changed = deep.filter((repo) => force || repoChanged(repo, oldRepos.get(repo.full_name)));
      const unchanged = new Set(deep.filter((repo) => !changed.includes(repo)).map((repo) => repo.full_name));
      const oldCommits = groupCommits((old && old.commits) || []);
      const oldLanguages = (old && old.repoLanguages) || {};

      let completed = 0;
      const details = await mapLimit(changed, CONCURRENCY, async (repo) => {
        if (entry.cancelled) throw new Error("sync cancelled");
        const previous = oldCommits.get(repo.full_name) || [];
        const since = !force && previous[0] && previous[0].iso ? "&since=" + encodeURIComponent(previous[0].iso) : "";
        const base = "/repos/" + repo.full_name.split("/").map(encodeURIComponent).join("/");
        let fresh = [];
        try { fresh = repo.size ? await api.get(base + "/commits?per_page=100" + since) : []; }
        catch (error) { if (error.status !== 409) throw error; }
        const commits = normalizeCommits(repo, fresh).concat(previous);
        const unique = Array.from(new Map(commits.map((c) => [c.fullSha, c])).values()).slice(0, 100);
        const languages = repo.size ? await api.get(base + "/languages") : {};
        completed++;
        this.update(entry, { phase: "history", progress: 20 + Math.round((completed / Math.max(1, changed.length)) * 55) });
        return { repo, commits: unique, languages };
      });

      const byName = new Map(details.filter((d) => !d.__error).map((d) => [d.repo.full_name, d]));
      if (entry.cancelled) return;
      const payload = emptyPayload(profile.login, profile, repos, deep);
      payload.partial = details.some((d) => d.__error);
      payload.failedRepos = details.filter((d) => d.__error).length;
      payload.repoLanguages = {};
      for (const repo of deep) {
        const detail = byName.get(repo.full_name);
        const commits = detail ? detail.commits : (unchanged.has(repo.full_name) ? (oldCommits.get(repo.full_name) || []) : []);
        const languages = detail ? detail.languages : (oldLanguages[repo.full_name] || {});
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
      payload.fetchedAt = Date.now();
      payload.loading = false;
      this.store.put(id, profile.login, payload);
      this.update(entry, { state: payload.partial ? "partial" : "current", phase: "complete", progress: 100 });
    } catch (error) {
      this.update(entry, { state: "failed", phase: "failed", error: String(error.message || error), progress: entry.job.progress });
    } finally {
      this.running.delete(id);
    }
  }
}

function emptyPayload(login, profile, repos, deep) {
  return {
    username: login, fetchedAt: Date.now(), partial: false, failedRepos: 0,
    profile, repos, deepRepos: deep, commits: [], repoCommits: {}, repoLanguages: {},
    langTotals: {}, langRepos: {}, account: { orgs: [], starred: [], gists: [], followers: [], following: [] },
    privateRepos: repos.filter((r) => r.private).length,
    publicRepos: repos.filter((r) => !r.private).length,
    prs: 0, issues: 0, reviews: 0
  };
}

function mergeExistingDetail(target, old, deep) {
  const names = new Set(deep.map((r) => r.full_name));
  target.commits = (old.commits || []).filter((c) => names.has(c.repoFullName));
  target.repoCommits = old.repoCommits || {};
  target.repoLanguages = old.repoLanguages || {};
  target.langTotals = old.langTotals || {};
  target.langRepos = old.langRepos || {};
  target.account = old.account || target.account;
  target.prs = old.prs || 0; target.issues = old.issues || 0; target.reviews = old.reviews || 0;
}

function repoChanged(repo, old) {
  return !old || ["pushed_at", "updated_at", "size", "default_branch", "archived"].some((key) => repo[key] !== old[key]);
}

function groupCommits(commits) {
  const grouped = new Map();
  for (const commit of commits) {
    const list = grouped.get(commit.repoFullName) || [];
    list.push(commit); grouped.set(commit.repoFullName, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => String(b.iso).localeCompare(String(a.iso)));
  return grouped;
}

function normalizeCommits(repo, commits) {
  return commits.map((c) => {
    const iso = c.commit && ((c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date));
    return iso && {
      sha: String(c.sha || "").slice(0, 7), fullSha: c.sha, repo: repo.name, repoFullName: repo.full_name,
      owner: repo.owner && repo.owner.login || "", branch: repo.default_branch || "main", iso,
      msg: String(c.commit && c.commit.message || "").split("\n")[0].trim(),
      author: c.author && c.author.login || c.commit && c.commit.author && c.commit.author.name || "",
      add: 0, del: 0, filesCount: 0
    };
  }).filter(Boolean);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { out[index] = await fn(items[index], index); }
      catch (error) { out[index] = { __error: String(error.message || error) }; }
    }
  });
  await Promise.all(workers); return out;
}

function githubClient(token) {
  async function get(apiPath) {
    const response = await fetch(GITHUB_API + apiPath, {
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token,
        "User-Agent": "Logbook/4.14", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) { const error = new Error("GitHub " + response.status + " for " + apiPath); error.status = response.status; throw error; }
    return response.json();
  }
  async function all(apiPath, maxPages = 20) {
    const allItems = []; const separator = apiPath.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const items = await get(apiPath + separator + "per_page=100&page=" + page);
      if (!Array.isArray(items)) break;
      allItems.push(...items); if (items.length < 100) break;
    }
    return allItems;
  }
  return { get, all };
}

function publicJob(job) {
  return { id: job.id, state: job.state, phase: job.phase, progress: job.progress,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

module.exports = { SyncEngine };
