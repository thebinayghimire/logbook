"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ai = require("../commit-ai-engine");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" })
  }).trim();
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-commit-ai-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Logbook Test"]);
  git(repo, ["config", "user.email", "logbook@example.test"]);
  fs.writeFileSync(path.join(repo, "app.js"), "module.exports = true;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function cleanup(repo) {
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
}

test("extractRepoDiffSummary bounds large diffs to 12 KB", async () => {
  const repo = createRepo();
  try {
    fs.writeFileSync(path.join(repo, "app.js"), Array.from({ length: 3000 }, (_, index) => `const line${index} = "changed-${index}";`).join("\n"));
    const result = await ai.extractRepoDiffSummary(repo);
    assert.ok(Buffer.byteLength(result.summary, "utf8") <= ai.MAX_DIFF_BYTES);
    assert.equal(result.truncated, true);
    assert.match(result.summary, /\[DIFF TRUNCATED\]$/);
  } finally {
    cleanup(repo);
  }
});

test("diff preparation omits sensitive files and redacts token-shaped values", async () => {
  const repo = createRepo();
  try {
    const secret = "AKIA1234567890ABCDEF";
    fs.writeFileSync(path.join(repo, "app.js"), `module.exports = "${secret}";\n`);
    fs.writeFileSync(path.join(repo, ".env"), "PASSWORD=never-send-this\n");
    const result = await ai.extractRepoDiffSummary(repo);
    assert.doesNotMatch(result.summary, /never-send-this/);
    assert.doesNotMatch(result.summary, /\.env/);
    assert.doesNotMatch(result.summary, new RegExp(secret));
    assert.match(result.summary, /\[REDACTED\]/);
    assert.equal(result.sensitiveFileCount, 1);
  } finally {
    cleanup(repo);
  }
});

test("offline provider failure always returns three conventional commit suggestions", async () => {
  const repo = createRepo();
  try {
    fs.mkdirSync(path.join(repo, "test"));
    fs.writeFileSync(path.join(repo, "test", "engine.test.js"), "// coverage\n");
    const unavailable = async () => { throw new Error("offline"); };
    const result = await ai.suggestCommitMessages([repo], { providers: [unavailable, unavailable] });
    assert.equal(result.provider, "heuristic");
    assert.equal(result.suggestions.length, 3);
    result.suggestions.forEach((suggestion) => assert.match(suggestion, ai.CONVENTIONAL_COMMIT_RE));
    assert.equal(new Set(result.suggestions).size, 3);
  } finally {
    cleanup(repo);
  }
});

test("safe untracked source excerpts give models code-level context", async () => {
  const repo = createRepo();
  try {
    fs.writeFileSync(path.join(repo, "commit-suggester.js"), "function generateSemanticCommit(diff) {\n  return analyzeChangedSymbols(diff);\n}\n");
    const result = await ai.extractRepoDiffSummary(repo);
    assert.match(result.summary, /New file: commit-suggester\.js/);
    assert.match(result.summary, /generateSemanticCommit/);
    assert.match(result.summary, /analyzeChangedSymbols/);
  } finally {
    cleanup(repo);
  }
});

test("heuristics recognize docs, tests, additions, and mixed structural work", () => {
  const docs = ai.heuristicCommitSuggestions([{ repo: "demo", files: ["docs/guide.md"], changes: [{ status: " M", file: "docs/guide.md" }] }]);
  const tests = ai.heuristicCommitSuggestions([{ repo: "demo", files: ["test/unit.test.js"], changes: [{ status: "??", file: "test/unit.test.js" }] }]);
  const added = ai.heuristicCommitSuggestions([{ repo: "demo", files: ["src/widget.js"], changes: [{ status: "??", file: "src/widget.js" }] }]);
  const mixed = ai.heuristicCommitSuggestions([{ repo: "demo", files: ["src/new.js", "src/old.js"], changes: [{ status: "A ", file: "src/new.js" }, { status: "D ", file: "src/old.js" }] }]);
  assert.match(docs[0], /^docs\(/);
  assert.match(tests[0], /^test\(/);
  assert.match(added[0], /^feat\(/);
  assert.match(mixed[0], /^refactor\(/);
});

test("model responses are reduced to distinct valid conventional commits", () => {
  const content = JSON.stringify({ suggestions: [
    "feat(engine): add local suggestions",
    "feat(engine): add local suggestions",
    "not a commit",
    "fix(server): validate repository paths",
    "docs(readme): explain offline behavior"
  ] });
  assert.deepEqual(ai.parseSuggestions(content), [
    "feat(engine): add local suggestions",
    "fix(server): validate repository paths",
    "docs(readme): explain offline behavior"
  ]);
  const reasoned = '<think>Inspecting changed functions.</think>\n```json\n["feat(engine): analyze untracked source excerpts","fix(parser): remove reasoning before validation","test(ai): cover semantic commit output"]\n```';
  assert.equal(ai.parseSuggestions(reasoned).length, 3);
});

test("local provider requests honor the configured timeout", async () => {
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const started = Date.now();
  await assert.rejects(ai.queryOllama("prompt", { fetch: hangingFetch, timeoutMs: 25 }), /aborted/);
  assert.ok(Date.now() - started < 500);
});

test("OmniRoute uses its OpenAI-compatible gateway without leaking the key into the payload", async () => {
  let request;
  const fakeFetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["feat(engine): analyze changed symbols","fix(api): validate selected repositories","test(ai): cover provider fallback"]' } }] })
    };
  };
  const result = await ai.queryOmniRoute("sanitized prompt", {
    allowCloud: true,
    omniRouteApiKey: "test-secret-key",
    omniRouteModel: "auto/best-coding-fast",
    omniRouteUrl: "http://127.0.0.1:20128/v1",
    fetch: fakeFetch
  });
  assert.equal(result.provider, "omniroute");
  assert.equal(result.model, "auto/best-coding-fast");
  assert.equal(request.url, "http://127.0.0.1:20128/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer test-secret-key");
  assert.doesNotMatch(request.init.body, /test-secret-key/);
  assert.match(request.init.body, /sanitized prompt/);
});
