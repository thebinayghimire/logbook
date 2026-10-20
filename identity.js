"use strict";

/**
 * Contribution attribution.
 *
 * A repository's commit list is not the signed-in user's contribution list.
 * Only commits whose linked GitHub account, verified email, or GitHub noreply
 * address matches the authorized account are counted as authored activity.
 * Bots and generated accounts are excluded by default.
 */

const BOT_LOGIN_RE = /(?:\[bot\]$|-bot$|^bot-)/i;
const BOT_EMAIL_RE = /(?:\[bot\]|bot@|dependabot|renovate|github-actions|greenkeeper|snyk-bot)/i;
const KNOWN_BOTS = new Set([
  "dependabot",
  "dependabot-preview",
  "renovate",
  "github-actions",
  "codecov",
  "greenkeeper",
  "snyk-bot",
  "mergify",
  "imgbot",
  "pre-commit-ci"
]);

function buildAuthorIdentity(profile, emails = []) {
  const login = String((profile && profile.login) || "").toLowerCase();
  const id = Number(profile && profile.id) || null;
  const verified = new Set();
  for (const entry of Array.isArray(emails) ? emails : []) {
    const email = typeof entry === "string" ? entry : entry && entry.email;
    const isVerified = typeof entry === "object" && entry ? entry.visibility !== "private" || entry.verified !== false : true;
    if (email && isVerified) verified.add(String(email).toLowerCase());
  }
  if (profile && profile.email) verified.add(String(profile.email).toLowerCase());
  if (login) {
    if (id) verified.add(`${id}+${login}@users.noreply.github.com`);
    verified.add(`${login}@users.noreply.github.com`);
  }
  return { login, id, emails: verified };
}

function commitLogin(commit) {
  const author = commit && commit.author;
  return String((author && author.login) || "").toLowerCase();
}

function commitEmail(commit) {
  const inner = (commit && commit.commit) || {};
  const author = inner.author || {};
  const committer = inner.committer || {};
  return String(author.email || committer.email || "").toLowerCase();
}

function isBotCommit(commit) {
  const login = commitLogin(commit);
  const email = commitEmail(commit);
  const type = String(((commit && commit.author) || {}).type || "").toLowerCase();
  if (type === "bot") return true;
  if (login && (BOT_LOGIN_RE.test(login) || KNOWN_BOTS.has(login))) return true;
  if (email && BOT_EMAIL_RE.test(email)) return true;
  const name = String((((commit && commit.commit) || {}).author || {}).name || "").toLowerCase();
  if (name && (KNOWN_BOTS.has(name) || BOT_LOGIN_RE.test(name))) return true;
  return false;
}

function isMergeCommit(commit) {
  return Array.isArray(commit && commit.parents) && commit.parents.length > 1;
}

/**
 * Returns `{ mine, bot, merge }` without exposing commit email addresses to
 * callers that only need the decision.
 */
function classifyCommit(commit, identity, options = {}) {
  const bot = isBotCommit(commit);
  const login = commitLogin(commit);
  const email = commitEmail(commit);
  let mine = false;
  if (login) {
    // A linked GitHub account is authoritative. Do not let a shared email
    // attribute a commit to the wrong identity.
    mine = Boolean(identity && identity.login) && login === identity.login;
  } else if (email && identity) {
    mine = identity.emails.has(email);
  }
  const merge = isMergeCommit(commit);
  const included = mine &&
    (options.includeBots === true || !bot) &&
    (options.includeMergeCommits === true || !merge);
  return { mine, bot, merge, included };
}

function normalizeCommit(repo, commit, identity, options = {}) {
  const inner = (commit && commit.commit) || {};
  const iso = (inner.author && inner.author.date) || (inner.committer && inner.committer.date);
  if (!iso) return null;
  const classification = classifyCommit(commit, identity, options);
  return {
    sha: String(commit.sha || "").slice(0, 7),
    fullSha: commit.sha,
    repo: repo.name,
    repoFullName: repo.full_name,
    owner: (repo.owner && repo.owner.login) || "",
    branch: repo.default_branch || "main",
    iso,
    msg: String(inner.message || "").split("\n")[0].trim(),
    author: (commit.author && commit.author.login) || (inner.author && inner.author.name) || "",
    add: 0,
    del: 0,
    filesCount: 0,
    mine: classification.mine,
    bot: classification.bot,
    merge: classification.merge,
    included: classification.included
  };
}

function normalizeCommits(repo, commits, identity, options = {}) {
  if (!Array.isArray(commits)) return [];
  return commits
    .map((commit) => normalizeCommit(repo, commit, identity, options))
    .filter(Boolean);
}

/**
 * Keep only commits attributed to the account. The `included` flag is already
 * decided by the branch/merge/bot policy; keeping the explicit filter here
 * makes the invariant obvious at the call site.
 */
function authoredCommits(commits) {
  return commits.filter((commit) => commit && commit.included);
}

function availableContributions(payload) {
  const calendar = payload && payload.contributionCalendar;
  if (!calendar || !calendar.years) return false;
  return Object.keys(calendar.years).length > 0;
}

module.exports = {
  buildAuthorIdentity,
  classifyCommit,
  normalizeCommit,
  normalizeCommits,
  authoredCommits,
  isBotCommit,
  isMergeCommit,
  commitEmail,
  commitLogin,
  availableContributions
};
