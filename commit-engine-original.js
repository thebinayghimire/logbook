"use strict";

/**
 * Local commit engine.
 *
 * This module is intentionally separate from the read-only GitHub bridge. It
 * only runs when the bridge is started with ENABLE_COMMIT_NOW=1 on a loopback
 * listener. All filesystem paths are resolved and validated before a git
 * process starts, and every git call is made with execFile (no shell).
 */

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_MAX_DEPTH = 3;
const MAX_SCAN_MS = 8000;
const MAX_SCAN_ENTRIES = 6000;
const MAX_REPOS = 200;
const MAX_LIST_ENTRIES = 500;
const GIT_TIMEOUT_MS = 20000;
const PUSH_TIMEOUT_MS = 90000;
const MAX_STATUS_BUFFER = 12 * 1024 * 1024;

// Dependency, build, cache and system folders that should never be walked.
// Dot-directories are skipped separately, so .git/.venv/.next are covered.
const SKIP_DIRS = new Set([
  "node_modules",
  "venv",
  "env",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "vendor",
  "coverage",
  "__pycache__",
  "appdata",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
  "pods",
  "deriveddata"
]);

const SECRET_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.htpasswd$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(?:\..+)?$/i,
  /^secrets?(?:\..+)?$/i,
  /^(?:service[-_]?account|firebase[-_]?adminsdk)(?:[-_.].*)?\.json$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i
];

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: options.timeout || GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: options.maxBuffer || MAX_STATUS_BUFFER,
        encoding: "utf8",
        env: Object.assign({}, process.env, {
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
          LC_ALL: process.env.LC_ALL || "C",
          LANG: process.env.LANG || "C"
        }, options.env || {})
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === "number" ? error.code : (error ? 1 : 0),
          timedOut: Boolean(error && error.killed),
          stdout: stdout || "",
          stderr: stderr || (error && error.message ? error.message : "")
        });
      }
    );
    child.on("error", (error) => {
      resolve({ ok: false, code: 1, timedOut: false, stdout: "", stderr: error.message });
    });
  });
}

function normalizeUserPath(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > 4096 || value.indexOf("\0") !== -1) return null;
  // On Windows, "C:" means the current directory on that drive, not the root.
  if (process.platform === "win32" && /^[a-zA-Z]:$/.test(value)) value += "\\";
  return path.resolve(value);
}

async function resolveDirectory(input) {
  const resolved = normalizeUserPath(input);
  if (!resolved) return { ok: false, error: "invalid_path" };
  let real;
  try {
    real = await fsp.realpath(resolved);
  } catch (error) {
    return { ok: false, error: error.code === "EACCES" ? "permission_denied" : "not_found" };
  }
  let stat;
  try {
    stat = await fsp.stat(real);
  } catch (error) {
    return { ok: false, error: "not_found" };
  }
  if (!stat.isDirectory()) return { ok: false, error: "not_a_directory" };
  return { ok: true, path: real };
}

function samePath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isPathInside(root, target) {
  let base = path.resolve(String(root));
  let candidate = path.resolve(String(target));
  if (process.platform === "win32") {
    base = base.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldSkipDirectory(name) {
  if (!name || name.startsWith(".")) return true;
  return SKIP_DIRS.has(name.toLowerCase());
}

function shortcutList(current) {
  const shortcuts = [];
  const seen = new Set();
  function add(label, value) {
    if (!value) return;
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    try {
      if (!fs.statSync(resolved).isDirectory()) return;
    } catch (error) {
      return;
    }
    seen.add(key);
    shortcuts.push({ label, path: resolved });
  }
  add("Home", os.homedir());
  add("Workspace", process.cwd());
  const driveRoot = path.parse(current).root;
  if (driveRoot) add("Drive root", driveRoot);
  // A conventional projects folder is offered when it exists, but it is never
  // assumed to be the selected root.
  const conventional = path.join(path.parse(os.homedir()).root, "Projects");
  add("Projects", conventional);
  return shortcuts;
}

async function listDirectories(input) {
  const requested = input || os.homedir();
  const resolved = await resolveDirectory(requested);
  if (!resolved.ok) return resolved;
  const dir = resolved.path;
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: error.code === "EACCES" ? "permission_denied" : "not_found" };
  }

  const entries = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    if (shouldSkipDirectory(name)) continue;
    const full = path.join(dir, name);
    let isRepo = false;
    try {
      isRepo = fs.existsSync(path.join(full, ".git"));
    } catch (error) {
      isRepo = false;
    }
    entries.push({ name, path: full, isRepo });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parent = path.dirname(dir);
  return {
    ok: true,
    path: dir,
    parent: parent && parent !== dir ? parent : null,
    isRepo: fs.existsSync(path.join(dir, ".git")),
    entries: entries.slice(0, MAX_LIST_ENTRIES),
    truncated: entries.length > MAX_LIST_ENTRIES,
    shortcuts: shortcutList(dir)
  };
}

function detectOperation(gitDir) {
  const checks = [
    ["MERGE_HEAD", "merge_in_progress"],
    ["CHERRY_PICK_HEAD", "cherry_pick_in_progress"],
    ["REVERT_HEAD", "revert_in_progress"],
    ["BISECT_LOG", "bisect_in_progress"]
  ];
  for (const [file, reason] of checks) {
    try {
      if (fs.existsSync(path.join(gitDir, file))) return reason;
    } catch (error) {
      // A git dir that disappeared is handled by the caller.
    }
  }
  try {
    if (fs.existsSync(path.join(gitDir, "rebase-merge"))) return "rebase_in_progress";
    if (fs.existsSync(path.join(gitDir, "rebase-apply"))) return "rebase_in_progress";
  } catch (error) {
    // Ignore a transient stat failure.
  }
  return "";
}

function parseStatus(stdout) {
  const entries = [];
  const parts = String(stdout || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 3) continue;
    const code = part.slice(0, 2);
    const file = part.slice(3);
    if (!file) continue;
    entries.push({ code, file });
    // Rename/copy records carry the original path in the next NUL field.
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return entries;
}

function isConflictCode(code) {
  return code === "DD" || code === "AA" || code === "AU" || code === "UA" ||
    code === "DU" || code === "UD" || code === "UU" ||
    code[0] === "U" || code[1] === "U";
}

function isLikelySecret(file) {
  const base = path.basename(String(file || ""));
  if (!base) return false;
  if (/\.(?:example|sample|template|dist|pub)$/i.test(base)) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(base));
}

function findSecrets(changes) {
  const found = [];
  for (const entry of changes) {
    if (!isLikelySecret(entry.file)) continue;
    if (found.indexOf(entry.file) === -1) found.push(entry.file);
  }
  return found.slice(0, 12);
}

function remoteLabel(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  // Local path remotes and file:// URLs have no host. Show a short, stable
  // label instead of turning the drive letter into a fake hostname.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/") ||
      raw.startsWith("./") || raw.startsWith("../") || /^file:\/\//i.test(raw)) {
    let localPath = raw.replace(/^file:\/\//i, "").replace(/[\\/]+$/, "");
    try { localPath = decodeURIComponent(localPath); } catch (error) {}
    const localName = path.basename(localPath) || "repository";
    const localLabel = "local · " + localName;
    return localLabel.length > 90 ? localLabel.slice(0, 87) + "..." : localLabel;
  }
  let host = "";
  let repoPath = "";
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      host = parsed.hostname;
      repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    } else {
      const match = raw.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+)$/);
      if (match) {
        host = match[1];
        repoPath = match[2].replace(/^\/+/, "").replace(/\.git$/i, "");
      }
    }
  } catch (error) {
    host = "";
  }
  const label = host ? host.replace(/^www\./i, "") + (repoPath ? "/" + repoPath : "") : raw.replace(/\/\/[^@/]+@/, "//");
  return label.length > 90 ? label.slice(0, 87) + "..." : label;
}

function skipReasonLabel(reason) {
  const labels = {
    detached_head: "Detached HEAD; checkout a branch first.",
    merge_in_progress: "Merge in progress; finish it first.",
    rebase_in_progress: "Rebase in progress; finish it first.",
    cherry_pick_in_progress: "Cherry-pick in progress; finish it first.",
    revert_in_progress: "Revert in progress; finish it first.",
    bisect_in_progress: "Bisect in progress; finish it first.",
    merge_conflict: "Unmerged paths; resolve conflicts first.",
    submodule: "Submodule checkout; commit it from its parent repository.",
    bare_repo: "Bare repository; no working tree to commit.",
    clean: "Clean; already up to date.",
    clean_no_upstream: "Clean; no upstream branch.",
    behind_remote: "Clean; remote has newer commits.",
    diverged: "Clean; local and remote branches have diverged.",
    status_failed: "Could not read git status.",
    not_a_repo: "Not a Git repository."
  };
  return labels[reason] || "Skipped.";
}

async function inspectRepo(dir) {
  const name = path.basename(dir);
  const topLevel = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return { ok: false, path: dir, name, reason: "not_a_repo", message: sanitizeGitOutput(topLevel.stderr) || "Not a Git repository." };
  }
  // Status and commit operate on the resolved top-level so a directory that
  // points into a worktree never gets treated as a separate repository.
  const top = path.resolve(topLevel.stdout.trim() || dir);

  const bare = await runGit(top, ["rev-parse", "--is-bare-repository"]);
  if (bare.ok && bare.stdout.trim() === "true") {
    return { ok: true, path: top, name, branch: "", actionable: false, skipReason: "bare_repo", skipLabel: skipReasonLabel("bare_repo"), changed: false, changeCount: 0, ahead: 0, behind: 0, secrets: [], remoteName: "", remoteUrl: "", remoteLabel: "", upstream: "", changes: [] };
  }

  const superproject = await runGit(top, ["rev-parse", "--show-superproject-working-tree"]);
  if (superproject.ok && superproject.stdout.trim()) {
    return { ok: true, path: top, name, branch: "", actionable: false, skipReason: "submodule", skipLabel: skipReasonLabel("submodule"), changed: false, changeCount: 0, ahead: 0, behind: 0, secrets: [], remoteName: "", remoteUrl: "", remoteLabel: "", upstream: "", changes: [] };
  }

  const gitDirResult = await runGit(top, ["rev-parse", "--absolute-git-dir"]);
  const gitDir = gitDirResult.ok ? gitDirResult.stdout.trim() : path.join(top, ".git");
  const operation = detectOperation(gitDir);
  if (operation) {
    return { ok: true, path: top, name, branch: "", actionable: false, skipReason: operation, skipLabel: skipReasonLabel(operation), changed: false, changeCount: 0, ahead: 0, behind: 0, secrets: [], remoteName: "", remoteUrl: "", remoteLabel: "", upstream: "", changes: [] };
  }

  const branchResult = await runGit(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.ok ? branchResult.stdout.trim() : "";
  if (!branch) {
    return { ok: true, path: top, name, branch: "", actionable: false, skipReason: "detached_head", skipLabel: skipReasonLabel("detached_head"), changed: false, changeCount: 0, ahead: 0, behind: 0, secrets: [], remoteName: "", remoteUrl: "", remoteLabel: "", upstream: "", changes: [] };
  }

  const remoteResult = await runGit(top, ["remote"]);
  const remotes = remoteResult.ok
    ? remoteResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
  const remoteName = remotes.indexOf("origin") !== -1 ? "origin" : (remotes[0] || "");
  let remoteUrl = "";
  if (remoteName) {
    const urlResult = await runGit(top, ["remote", "get-url", remoteName]);
    if (urlResult.ok) remoteUrl = urlResult.stdout.trim();
  }

  const upstreamResult = await runGit(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() : "";
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runGit(top, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (counts.ok) {
      const parts = counts.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
      behind = parts[0] || 0;
      ahead = parts[1] || 0;
    }
  }

  const statusResult = await runGit(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!statusResult.ok) {
    return { ok: true, path: top, name, branch, actionable: false, skipReason: "status_failed", skipLabel: skipReasonLabel("status_failed"), changed: false, changeCount: 0, ahead, behind, secrets: [], remoteName, remoteUrl, remoteLabel: remoteLabel(remoteUrl), upstream, changes: [] };
  }
  const changes = parseStatus(statusResult.stdout);
  const conflicts = changes.filter((entry) => isConflictCode(entry.code));
  if (conflicts.length) {
    return { ok: true, path: top, name, branch, actionable: false, skipReason: "merge_conflict", skipLabel: skipReasonLabel("merge_conflict"), changed: true, changeCount: changes.length, ahead, behind, secrets: [], remoteName, remoteUrl, remoteLabel: remoteLabel(remoteUrl), upstream, changes: changes.slice(0, 20) };
  }

  const changed = changes.length > 0;
  const secrets = findSecrets(changes);
  let skipReason = "";
  if (!changed) {
    if (!upstream) skipReason = "clean_no_upstream";
    else if (behind > 0 && ahead > 0) skipReason = "diverged";
    else if (behind > 0) skipReason = "behind_remote";
    else if (ahead === 0) skipReason = "clean";
  }
  const canPushOnly = !changed && Boolean(upstream) && ahead > 0 && behind === 0;
  const actionable = changed || canPushOnly;

  return {
    ok: true,
    path: top,
    name,
    branch,
    actionable,
    action: changed ? "commit" : (canPushOnly ? "push" : "none"),
    skipReason,
    skipLabel: skipReason ? skipReasonLabel(skipReason) : "",
    changed,
    changeCount: changes.length,
    changes: changes.slice(0, 20),
    secrets,
    remoteName,
    remoteUrl,
    remoteLabel: remoteLabel(remoteUrl),
    upstream,
    ahead,
    behind
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

async function scanProjects(root, options = {}) {
  const resolved = await resolveDirectory(root);
  if (!resolved.ok) return resolved;
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeBudgetMs || MAX_SCAN_MS);
  const maxDepth = Math.min(Math.max(Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH, 0), 6);
  const found = [];
  const seen = new Set();
  let visited = 0;
  let truncated = false;

  async function realKey(dir) {
    try {
      const real = await fsp.realpath(dir);
      return process.platform === "win32" ? real.toLowerCase() : real;
    } catch (error) {
      const resolvedDir = path.resolve(dir);
      return process.platform === "win32" ? resolvedDir.toLowerCase() : resolvedDir;
    }
  }

  async function walk(dir, depth) {
    if (truncated) return;
    if (Date.now() > deadline || visited >= MAX_SCAN_ENTRIES || found.length >= MAX_REPOS) {
      truncated = true;
      return;
    }
    visited += 1;
    let isRepo = false;
    try {
      isRepo = fs.existsSync(path.join(dir, ".git"));
    } catch (error) {
      isRepo = false;
    }
    if (isRepo) {
      const key = await realKey(dir);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(dir);
      }
      // Treat a repository as a boundary. Descending into it could discover
      // nested repos that the parent would also stage as gitlinks.
      return;
    }
    if (depth >= maxDepth) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const dirent of dirents) {
      if (truncated) return;
      if (!dirent.isDirectory()) continue;
      if (shouldSkipDirectory(dirent.name)) continue;
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      await walk(path.join(dir, dirent.name), depth + 1);
    }
  }

  await walk(resolved.path, 0);

  const inspected = await mapLimit(found, 4, async (dir) => inspectRepo(dir));
  const repos = inspected.filter(Boolean);
  repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return {
    ok: true,
    root: resolved.path,
    scannedAt: Date.now(),
    repos,
    truncated,
    stats: {
      visited,
      found: found.length,
      elapsedMs: Date.now() - startedAt
    }
  };
}

function formatTimestamp(date) {
  const value = date instanceof Date ? date : new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return value.getFullYear() + "-" + pad(value.getMonth() + 1) + "-" + pad(value.getDate()) +
    " " + pad(value.getHours()) + ":" + pad(value.getMinutes());
}

function defaultCommitMessage(date) {
  return "chore: checkpoint " + formatTimestamp(date);
}

function sanitizeGitOutput(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/https?:\/\/[^@\s/]+@/gi, "https://")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, "[token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function resultBase(repo, message) {
  return {
    name: repo.name,
    path: repo.path,
    branch: repo.branch || "",
    remoteLabel: repo.remoteLabel || "",
    message: message || "",
    committed: false,
    pushed: false,
    skipped: false,
    failed: false,
    status: "",
    detail: "",
    commit: ""
  };
}

async function runCommit(repoOrPath, options = {}) {
  const repoPath = typeof repoOrPath === "string" ? repoOrPath : repoOrPath.path;
  const message = options.message || defaultCommitMessage();
  const inspected = await inspectRepo(repoPath);
  const base = resultBase(inspected.ok ? inspected : { name: path.basename(repoPath), path: repoPath, branch: "", remoteLabel: "" }, message);

  if (!inspected.ok) {
    return Object.assign(base, {
      failed: true,
      status: "failed",
      detail: inspected.message || inspected.reason || "Could not inspect repository."
    });
  }
  if (!inspected.actionable) {
    return Object.assign(base, {
      branch: inspected.branch || "",
      remoteLabel: inspected.remoteLabel || "",
      skipped: true,
      status: "skipped",
      detail: inspected.skipLabel || "Nothing to commit or push."
    });
  }

  let committed = false;
  let commitHash = "";
  if (inspected.changed) {
    const nameResult = await runGit(inspected.path, ["config", "user.name"]);
    const emailResult = await runGit(inspected.path, ["config", "user.email"]);
    if (!nameResult.ok || !emailResult.ok || !nameResult.stdout.trim() || !emailResult.stdout.trim()) {
      return Object.assign(base, {
        failed: true,
        status: "failed",
        detail: "Git user.name / user.email is not configured for this repository."
      });
    }

    const addResult = await runGit(inspected.path, ["add", "-A"], { timeout: 30000 });
    if (!addResult.ok) {
      return Object.assign(base, {
        failed: true,
        status: "failed",
        detail: "git add failed: " + (sanitizeGitOutput(addResult.stderr) || "unknown error")
      });
    }

    const commitResult = await runGit(inspected.path, ["commit", "-m", message], { timeout: 60000 });
    if (!commitResult.ok) {
      return Object.assign(base, {
        failed: true,
        status: "failed",
        detail: "git commit failed: " + (sanitizeGitOutput(commitResult.stderr || commitResult.stdout) || "unknown error")
      });
    }
    committed = true;
    const hashResult = await runGit(inspected.path, ["rev-parse", "--short", "HEAD"]);
    if (hashResult.ok) commitHash = hashResult.stdout.trim();
  }

  if (!inspected.remoteName) {
    return Object.assign(base, {
      committed,
      commit: commitHash,
      status: committed ? "committed_no_remote" : "skipped",
      skipped: !committed,
      detail: committed
        ? "Committed locally; no Git remote is configured."
        : "No changes to push."
    });
  }

  const pushArgs = inspected.upstream
    ? ["push"]
    : ["push", "-u", inspected.remoteName, inspected.branch];
  const pushResult = await runGit(inspected.path, pushArgs, { timeout: PUSH_TIMEOUT_MS });
  if (!pushResult.ok) {
    return Object.assign(base, {
      committed,
      commit: commitHash,
      failed: true,
      status: committed ? "committed_push_failed" : "push_failed",
      detail: "git push failed: " + (sanitizeGitOutput(pushResult.stderr || pushResult.stdout) || "unknown error")
    });
  }

  return Object.assign(base, {
    committed,
    pushed: true,
    commit: commitHash,
    status: committed ? "committed_pushed" : "pushed",
    detail: committed
      ? "Committed and pushed to " + (inspected.remoteLabel || inspected.remoteName) + "."
      : "Pushed existing commits to " + (inspected.remoteLabel || inspected.remoteName) + "."
  });
}

function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    total: list.length,
    committed: list.filter((item) => item.committed).length,
    pushed: list.filter((item) => item.pushed).length,
    skipped: list.filter((item) => item.skipped).length,
    failed: list.filter((item) => item.failed).length
  };
}

async function runCommits(paths, options = {}) {
  const message = options.message || defaultCommitMessage();
  const results = [];
  for (const repoPath of paths) {
    let result;
    try {
      result = await runCommit(repoPath, { message });
    } catch (error) {
      result = {
        name: path.basename(repoPath),
        path: repoPath,
        branch: "",
        remoteLabel: "",
        message,
        committed: false,
        pushed: false,
        skipped: false,
        failed: true,
        status: "failed",
        detail: sanitizeGitOutput(error && error.message ? error.message : error),
        commit: ""
      };
    }
    results.push(result);
    if (typeof options.onResult === "function") options.onResult(result);
  }
  return results;
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  defaultCommitMessage,
  formatTimestamp,
  inspectRepo,
  isLikelySecret,
  isPathInside,
  listDirectories,
  normalizeUserPath,
  parseStatus,
  remoteLabel,
  resolveDirectory,
  runCommit,
  runCommits,
  samePath,
  sanitizeGitOutput,
  scanProjects,
  skipReasonLabel,
  summarize
};
