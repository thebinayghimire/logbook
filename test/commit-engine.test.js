"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const engine = require("../commit-engine");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" })
  }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Logbook Test"]);
  git(dir, ["config", "user.email", "logbook@example.test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# " + path.basename(dir) + "\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "logbook-commit-"));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

test("scanProjects finds nested repos, skips dependency folders, and flags secrets", async () => {
  const root = tempRoot();
  try {
    initRepo(path.join(root, "repo-a"));
    initRepo(path.join(root, "nested", "repo-b"));
    initRepo(path.join(root, "node_modules", "ignored-repo"));

    fs.writeFileSync(path.join(root, "nested", "repo-b", "new.txt"), "hello\n");
    fs.writeFileSync(path.join(root, "nested", "repo-b", ".env"), "SECRET=1\n");

    const scan = await engine.scanProjects(root);
    assert.equal(scan.ok, true);
    assert.equal(scan.repos.length, 2);
    assert.deepEqual(scan.repos.map((repo) => repo.name).sort(), ["repo-a", "repo-b"]);

    const clean = scan.repos.find((repo) => repo.name === "repo-a");
    assert.equal(clean.changed, false);
    assert.equal(clean.actionable, false);
    assert.equal(clean.skipReason, "clean_no_upstream");

    const dirty = scan.repos.find((repo) => repo.name === "repo-b");
    assert.equal(dirty.changed, true);
    assert.equal(dirty.actionable, true);
    assert.equal(dirty.action, "commit");
    assert.equal(dirty.changeCount, 2);
    assert.ok(dirty.secrets.includes(".env"));
    assert.equal(dirty.secrets.includes("new.txt"), false);
  } finally {
    cleanup(root);
  }
});

test("scanProjects stops at a repository boundary", async () => {
  const root = tempRoot();
  try {
    const outer = path.join(root, "outer");
    initRepo(outer);
    initRepo(path.join(outer, "inner"));

    const scan = await engine.scanProjects(root);
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.repos.map((repo) => repo.name), ["outer"]);
  } finally {
    cleanup(root);
  }
});

test("runCommit commits all changes with the supplied message and reports no remote", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "local-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "new.txt"), "hello\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# changed\n");

    const message = "chore: checkpoint 2026-10-21 14:30";
    const result = await engine.runCommit(repo, { message });

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.failed, false);
    assert.equal(result.status, "committed_no_remote");
    assert.ok(result.commit);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(git(repo, ["log", "-1", "--pretty=%s"]), message);
  } finally {
    cleanup(root);
  }
});

test("runCommits continues after a bad path and streams every result", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "good-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "new.txt"), "hello\n");
    const seen = [];
    const message = "chore: checkpoint 2026-10-21 14:30";

    const results = await engine.runCommits([path.join(root, "missing-repo"), repo], {
      message,
      onResult: (result) => seen.push(result.name + ":" + result.failed)
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].failed, true);
    assert.equal(results[1].committed, true);
    assert.deepEqual(seen, ["missing-repo:true", "good-repo:false"]);
  } finally {
    cleanup(root);
  }
});

test("runCommit skips a clean repository", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "clean-repo");
    initRepo(repo);

    const result = await engine.runCommit(repo, {});
    assert.equal(result.skipped, true);
    assert.equal(result.committed, false);
    assert.equal(result.pushed, false);
    assert.equal(result.failed, false);
    assert.equal(result.status, "skipped");
    assert.match(result.detail, /Clean/);
  } finally {
    cleanup(root);
  }
});

test("listDirectories marks git repos and hides dependency folders", async () => {
  const root = tempRoot();
  try {
    initRepo(path.join(root, "repo-a"));
    initRepo(path.join(root, "node_modules", "ignored-repo"));
    fs.mkdirSync(path.join(root, "plain-folder"), { recursive: true });

    const listing = await engine.listDirectories(root);
    assert.equal(listing.ok, true);
    assert.ok(listing.entries.some((entry) => entry.name === "repo-a" && entry.isRepo === true));
    assert.ok(listing.entries.some((entry) => entry.name === "plain-folder" && entry.isRepo === false));
    assert.equal(listing.entries.some((entry) => entry.name === "node_modules"), false);
    assert.equal(listing.parent, path.dirname(fs.realpathSync.native(root)));
  } finally {
    cleanup(root);
  }
});

test("isPathInside accepts descendants and rejects siblings", () => {
  const root = path.join(os.tmpdir(), "logbook-root");
  assert.equal(engine.isPathInside(root, path.join(root, "repo")), true);
  assert.equal(engine.isPathInside(root, root), true);
  assert.equal(engine.isPathInside(root, path.join(os.tmpdir(), "logbook-root-other")), false);
});

test("scanProjects skips repositories with an in-progress merge", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "merging-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");

    const scan = await engine.scanProjects(repo);
    assert.equal(scan.ok, true);
    assert.equal(scan.repos.length, 1);
    assert.equal(scan.repos[0].actionable, false);
    assert.equal(scan.repos[0].skipReason, "merge_in_progress");
  } finally {
    cleanup(root);
  }
});

test("scanProjects skips a detached HEAD", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "detached-repo");
    initRepo(repo);
    git(repo, ["checkout", "--detach"]);

    const scan = await engine.scanProjects(repo);
    assert.equal(scan.repos.length, 1);
    assert.equal(scan.repos[0].actionable, false);
    assert.equal(scan.repos[0].skipReason, "detached_head");
  } finally {
    cleanup(root);
  }
});

test("secret detection ignores public examples and public keys", () => {
  assert.equal(engine.isLikelySecret(".env"), true);
  assert.equal(engine.isLikelySecret(".env.local"), true);
  assert.equal(engine.isLikelySecret(".env.example"), false);
  assert.equal(engine.isLikelySecret("id_rsa"), true);
  assert.equal(engine.isLikelySecret("id_rsa.pub"), false);
  assert.equal(engine.isLikelySecret("server.pem"), true);
  assert.equal(engine.isLikelySecret("README.md"), false);
});

test("remoteLabel shortens local remotes and keeps hosted labels", () => {
  assert.equal(engine.remoteLabel("C:\\Projects\\foo.git"), "local · foo.git");
  assert.equal(engine.remoteLabel("file:///C:/Projects/foo.git"), "local · foo.git");
  assert.equal(engine.remoteLabel("/home/me/foo.git"), "local · foo.git");
  assert.equal(engine.remoteLabel("git@github.com:owner/repo.git"), "github.com/owner/repo");
  assert.equal(engine.remoteLabel("https://github.com/owner/repo.git"), "github.com/owner/repo");
});

test("defaultCommitMessage uses the checkpoint format", () => {
  const message = engine.defaultCommitMessage(new Date(2026, 9, 21, 14, 30));
  assert.equal(message, "chore: checkpoint 2026-10-21 14:30");
});
