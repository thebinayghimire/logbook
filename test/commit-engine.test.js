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

function cloneRepo(remote, dir) {
  execFileSync("git", ["clone", remote, dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" })
  });
  git(dir, ["config", "user.name", "Logbook Test"]);
  git(dir, ["config", "user.email", "logbook@example.test"]);
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
    assert.equal(dirty.actionable, false);
    assert.equal(dirty.skipReason, "sensitive_files");
    assert.equal(dirty.action, "none");
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
  assert.equal(engine.isLikelySecret("dev.env"), true);
  assert.equal(engine.isLikelySecret("prod.env.local"), true);
  assert.equal(engine.isLikelySecret(".git-credentials"), true);
  assert.equal(engine.isLikelySecret("client_secret.json"), true);
  assert.equal(engine.isLikelySecret("client_secret_12345.apps.googleusercontent.com.json"), true);
  assert.equal(engine.isLikelySecret("id_rsa"), true);
  assert.equal(engine.isLikelySecret("id_rsa.pub"), false);
  assert.equal(engine.isLikelySecret("server.pem"), true);
  assert.equal(engine.isLikelySecret("bundle.der"), true);
  assert.equal(engine.isLikelySecret("bundle.pkcs12"), true);
  assert.equal(engine.isLikelySecret("vault.kdbx"), true);
  assert.equal(engine.isLikelySecret("office.ovpn"), true);
  assert.equal(engine.isLikelySecret("README.md"), false);
});

test("runCommit supports commit_local mode without pushing", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "local-mode-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "local.txt"), "local only\n");
    const result = await engine.runCommit(repo, { mode: "commit_local", message: "chore: local only" });
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.status, "committed_no_remote");
  } finally {
    cleanup(root);
  }
});

test("runCommit excludes suspicious untracked artifacts like unexpanded env paths", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "artifact-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "good.txt"), "keep this\n");
    fs.mkdirSync(path.join(repo, "%SystemDrive%", "cache"), { recursive: true });
    fs.writeFileSync(path.join(repo, "%SystemDrive%", "cache", "temp.db"), "binary\n");

    const scan = await engine.scanProjects(repo);
    const repoInfo = scan.repos.find((entry) => entry.name === "artifact-repo");
    assert.equal(repoInfo.actionable, true);
    assert.ok(repoInfo.artifacts.some((item) => item.file.includes("%SystemDrive%")));

    const result = await engine.runCommit(repo, { message: "chore: safe commit" });
    assert.equal(result.committed, true);
    assert.equal(git(repo, ["log", "-1", "--pretty=%s"]), "chore: safe commit");
    const status = git(repo, ["status", "--porcelain"]);
    assert.ok(status.includes("%SystemDrive%"));
    assert.equal(status.includes("good.txt"), false);
  } finally {
    cleanup(root);
  }
});

test("runCommit blocks repositories with likely secret changes", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "secret-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "new.txt"), "hello\n");
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=not-a-real-token\n");

    const result = await engine.runCommit(repo, { message: "chore: must not commit" });
    assert.equal(result.committed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.status, "blocked_sensitive");
    assert.equal(git(repo, ["log", "-1", "--pretty=%s"]), "initial");
    assert.ok(git(repo, ["status", "--porcelain"]).includes(".env"));
  } finally {
    cleanup(root);
  }
});

test("runCommit blocks staged suspicious artifacts", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "staged-artifact-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "cache.db"), "binary\n");
    git(repo, ["add", "cache.db"]);
    fs.writeFileSync(path.join(repo, "good.txt"), "safe\n");

    const result = await engine.runCommit(repo, { message: "chore: must not commit" });
    assert.equal(result.committed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.status, "blocked_artifacts");
    assert.equal(git(repo, ["log", "-1", "--pretty=%s"]), "initial");
  } finally {
    cleanup(root);
  }
});

test("runCommit excludes oversized untracked test output", async () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "large-artifact-repo");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "good.txt"), "safe\n");
    fs.writeFileSync(path.join(repo, "check.html"), "x".repeat(300 * 1024));

    const result = await engine.runCommit(repo, { message: "chore: safe commit" });
    assert.equal(result.committed, true);
    assert.equal(result.failed, false);
    assert.ok(result.excluded.includes("check.html"));
    assert.equal(git(repo, ["ls-files", "check.html"]), "");
    assert.ok(git(repo, ["status", "--porcelain"]).includes("check.html"));
    assert.equal(git(repo, ["log", "-1", "--pretty=%s"]), "chore: safe commit");
  } finally {
    cleanup(root);
  }
});

test("runCommit defers pushing when the branch is behind its upstream", async () => {
  const root = tempRoot();
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const local = path.join(root, "local");
    const other = path.join(root, "other");

    execFileSync("git", ["init", "--bare", remote], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    initRepo(seed);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);

    cloneRepo(remote, local);
    cloneRepo(remote, other);
    fs.writeFileSync(path.join(other, "remote.txt"), "remote change\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-m", "remote change"]);
    git(other, ["push", "origin", "main"]);
    git(local, ["fetch", "origin"]);

    fs.writeFileSync(path.join(local, "local.txt"), "local change\n");
    const scan = await engine.scanProjects(local);
    const repoInfo = scan.repos.find((repo) => repo.name === "local");
    assert.equal(repoInfo.behind, 1);
    assert.equal(repoInfo.actionable, true);
    assert.equal(repoInfo.pushDeferred, true);

    const result = await engine.runCommit(local, { message: "chore: local only for now" });
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.failed, false);
    assert.equal(result.status, "committed_behind_remote");
    assert.match(result.detail, /Pull or rebase/);
    assert.notEqual(git(local, ["rev-parse", "HEAD"]), git(remote, ["rev-parse", "refs/heads/main"]));
    assert.equal(git(local, ["log", "-1", "--pretty=%s"]), "chore: local only for now");
  } finally {
    cleanup(root);
  }
});

test("normalizeCommitMessage trims, removes NULs, and caps length", () => {
  assert.equal(engine.normalizeCommitMessage("  hello\r\nworld  "), "hello\nworld");
  assert.equal(engine.normalizeCommitMessage("a\0b"), "ab");
  assert.equal(engine.normalizeCommitMessage("x".repeat(300)).length, 200);
  assert.equal(engine.normalizeCommitMessage(null), "");
});

test("normalizeUserPath expands tilde correctly", () => {
  const home = os.homedir();
  assert.equal(engine.normalizeUserPath("~"), home);
  assert.equal(engine.normalizeUserPath("~/Projects"), path.join(home, "Projects"));
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
