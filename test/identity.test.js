"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAuthorIdentity,
  classifyCommit,
  normalizeCommit,
  normalizeCommits,
  authoredCommits,
  isBotCommit,
  isMergeCommit,
  availableContributions
} = require("../identity");

const profile = {
  id: 4242,
  login: "Alice",
  email: "Alice@Example.com"
};

const emails = [
  { email: "alice@work.example", verified: true, visibility: "public" },
  { email: "alice-private@work.example", verified: true, visibility: "private" },
  { email: "alice-unverified@work.example", verified: false, visibility: "public" }
];

function makeCommit(options = {}) {
  const {
    sha = "abcdef1234567890",
    login = "alice",
    name = "Alice",
    email = "alice@example.com",
    type,
    message = "feat: add a ledger",
    date = "2026-10-20T10:00:00Z",
    parents = ["parent-1"]
  } = options;
  return {
    sha,
    author: login ? { login, type } : null,
    commit: {
      message,
      author: { name, email, date },
      committer: { name, email, date }
    },
    parents: parents.map((parent) => ({ sha: parent }))
  };
}

test("buildAuthorIdentity collects only verified addresses and noreply aliases", () => {
  const identity = buildAuthorIdentity(profile, emails);
  assert.equal(identity.login, "alice");
  assert.equal(identity.id, 4242);
  assert.equal(identity.emails.has("alice@example.com"), true);
  assert.equal(identity.emails.has("alice@work.example"), true);
  assert.equal(identity.emails.has("alice-private@work.example"), true);
  assert.equal(identity.emails.has("alice-unverified@work.example"), false);
  assert.equal(identity.emails.has("4242+alice@users.noreply.github.com"), true);
  assert.equal(identity.emails.has("alice@users.noreply.github.com"), true);
});

test("a linked GitHub login is authoritative for attribution", () => {
  const identity = buildAuthorIdentity(profile, emails);
  assert.equal(classifyCommit(makeCommit({ login: "alice" }), identity).mine, true);
  assert.equal(
    classifyCommit(makeCommit({ login: "mallory", email: "alice@example.com" }), identity).mine,
    false
  );
});

test("unlinked commits are attributed only through verified email", () => {
  const identity = buildAuthorIdentity(profile, emails);
  assert.equal(
    classifyCommit(makeCommit({ login: null, email: "alice@work.example" }), identity).mine,
    true
  );
  assert.equal(
    classifyCommit(makeCommit({ login: null, email: "alice-unverified@work.example" }), identity).mine,
    false
  );
  assert.equal(
    classifyCommit(makeCommit({ login: null, email: "someone@else.example" }), identity).mine,
    false
  );
});

test("bot commits are detected by login, email, name, and type", () => {
  const identity = buildAuthorIdentity(profile, emails);
  const byLogin = makeCommit({ login: "dependabot[bot]", name: "Dependabot", email: "bot@dependabot.com" });
  const byEmail = makeCommit({ login: null, name: "Renovate", email: "renovate@example.com" });
  const byName = makeCommit({ login: null, name: "github-actions", email: "ci@example.com" });
  const byType = makeCommit({ login: "alice", type: "Bot" });

  assert.equal(isBotCommit(byLogin), true);
  assert.equal(isBotCommit(byEmail), true);
  assert.equal(isBotCommit(byName), true);
  assert.equal(isBotCommit(byType), true);
  assert.equal(classifyCommit(byLogin, identity).included, false);
  assert.equal(classifyCommit(byType, identity, { includeBots: true }).included, true);
});

test("merge commits are excluded unless explicitly requested", () => {
  const identity = buildAuthorIdentity(profile, emails);
  const merge = makeCommit({ parents: ["one", "two"] });
  assert.equal(isMergeCommit(merge), true);
  assert.equal(classifyCommit(merge, identity).merge, true);
  assert.equal(classifyCommit(merge, identity).included, false);
  assert.equal(classifyCommit(merge, identity, { includeMergeCommits: true }).included, true);
});

test("normalizeCommit exposes the decision without leaking email addresses", () => {
  const identity = buildAuthorIdentity(profile, emails);
  const repo = {
    name: "logbook",
    full_name: "alice/logbook",
    owner: { login: "alice" },
    default_branch: "main"
  };
  const normalized = normalizeCommit(repo, makeCommit({ message: "fix: one\n\nbody" }), identity);
  assert.equal(normalized.sha, "abcdef1");
  assert.equal(normalized.fullSha, "abcdef1234567890");
  assert.equal(normalized.repo, "logbook");
  assert.equal(normalized.repoFullName, "alice/logbook");
  assert.equal(normalized.owner, "alice");
  assert.equal(normalized.branch, "main");
  assert.equal(normalized.msg, "fix: one");
  assert.equal(normalized.author, "alice");
  assert.equal(normalized.included, true);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "email"), false);
});

test("normalizeCommits skips entries without an author date", () => {
  const identity = buildAuthorIdentity(profile, emails);
  const repo = { name: "r", full_name: "alice/r", owner: { login: "alice" }, default_branch: "main" };
  const commits = normalizeCommits(repo, [
    makeCommit({ sha: "a" }),
    { sha: "b", author: null, commit: { message: "no date" }, parents: [] },
    makeCommit({ sha: "c", login: "someone-else" })
  ], identity);
  assert.equal(commits.length, 2);
  assert.deepEqual(authoredCommits(commits).map((commit) => commit.fullSha), ["a"]);
});

test("availableContributions requires a non-empty official calendar", () => {
  assert.equal(availableContributions(null), false);
  assert.equal(availableContributions({}), false);
  assert.equal(availableContributions({ contributionCalendar: { years: {} } }), false);
  assert.equal(availableContributions({ contributionCalendar: { years: { 2026: { days: {} } } } }), true);
});
