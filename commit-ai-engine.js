"use strict";

/**
 * Semantic Conventional Commit suggestion engine.
 *
 * Diffs are collected and scrubbed locally. Cloud-backed OmniRoute or Gemini
 * calls are unreachable unless the operator explicitly enables cloud AI and
 * configures the corresponding server-side key.
 */

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const MAX_DIFF_BYTES = 6 * 1024;
const PROVIDER_TIMEOUT_MS = 4_000;
const CONVENTIONAL_COMMIT_RE = /^(feat|fix|refactor|docs|chore|test|perf|style)(\([a-z0-9][a-z0-9._/-]*\))?: [^\r\n]+$/;
const ALLOWED_TYPES = new Set(["feat", "fix", "refactor", "docs", "chore", "test", "perf", "style"]);
const SECRET_FILE_RE = /(^|\/)(?:\.env(?:\.[^/]*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|client[_-]?secret[^/]*|service[-_]?account[^/]*|firebase[-_]?adminsdk[^/]*|[^/]*(?:token|apikey|api_key)[^/]*)$/i;
const SECRET_EXTENSION_RE = /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx|der|pkcs12|ovpn|mobileprovision)$/i;
const MODEL_PREFERENCE = ["qwen2.5-coder", "llama3.2", "codellama", "mistral"];
const SAFE_SOURCE_EXTENSION_RE = /\.(?:c|cc|cpp|cs|css|go|graphql|h|hpp|html|java|js|jsx|json|kt|kts|md|mjs|php|prisma|py|rb|rs|scss|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|ya?ml)$/i;

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = execFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout || 10_000,
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        LC_ALL: process.env.LC_ALL || "C",
        LANG: process.env.LANG || "C"
      })
    }, (error, stdout, stderr) => finish({
      ok: !error,
      stdout: stdout || "",
      stderr: stderr || (error && error.message) || ""
    }));
    child.on("error", (error) => finish({ ok: false, stdout: "", stderr: error.message }));
  });
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSensitivePath(value) {
  const clean = normalizePath(value).replace(/^a\//, "").replace(/^b\//, "");
  return SECRET_FILE_RE.test(clean) || SECRET_EXTENSION_RE.test(clean);
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]")
    .replace(/\b(?:[A-Za-z0-9+/]{40,}={0,2})\b/g, "[REDACTED]")
    .replace(/(^|\n)([+\- ]?\s*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*)([^\r\n]+)/gi, "$1$2[REDACTED]");
}

function diffSectionPath(section) {
  const header = section.match(/^diff --git\s+"?a\/(.+?)"?\s+"?b\/(.+?)"?(?:\r?\n|$)/);
  return header ? header[2] : "";
}

function scrubDiff(diff) {
  const source = String(diff || "").replace(/\r\n/g, "\n");
  const parts = source.split(/(?=^diff --git )/m);
  const kept = [];
  for (const part of parts) {
    if (!part) continue;
    const file = diffSectionPath(part);
    if (file && isSensitivePath(file)) {
      kept.push("diff --git [REDACTED SENSITIVE FILE]\n");
      continue;
    }
    kept.push(part);
  }
  return redactSecrets(kept.join(""));
}

function scrubStat(stat) {
  return String(stat || "").split(/\r?\n/).filter((line) => {
    const file = line.split("|")[0].trim();
    return !file || !isSensitivePath(file);
  }).join("\n");
}

function truncateUtf8(value, maxBytes = MAX_DIFF_BYTES) {
  const input = String(value || "");
  const buffer = Buffer.from(input, "utf8");
  if (buffer.length <= maxBytes) return { text: input, truncated: false, bytes: buffer.length };
  let text = buffer.subarray(0, Math.max(0, maxBytes - 30)).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  text += "\n[DIFF TRUNCATED]";
  return { text, truncated: true, bytes: Buffer.byteLength(text, "utf8") };
}

function parsePorcelain(text) {
  const entries = [];
  const records = String(text || "").split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    let file = normalizePath(record.slice(3));
    if ((status.includes("R") || status.includes("C")) && records[i + 1]) {
      file = normalizePath(records[i + 1]);
      i += 1;
    }
    entries.push({ status, file, sensitive: isSensitivePath(file) });
  }
  return entries;
}

async function readUntrackedExcerpts(repoPath, files, options = {}) {
  const excerpts = [];
  const maxFileBytes = options.maxUntrackedFileBytes || 128 * 1024;
  const maxExcerptBytes = options.maxUntrackedExcerptBytes || 3 * 1024;
  for (const file of files.slice(0, 12)) {
    if (!SAFE_SOURCE_EXTENSION_RE.test(file) || isSensitivePath(file)) continue;
    const absolute = path.resolve(repoPath, file);
    const relative = path.relative(repoPath, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const stat = await fs.promises.stat(absolute);
      if (!stat.isFile() || stat.size > maxFileBytes) continue;
      const handle = await fs.promises.open(absolute, "r");
      try {
        const buffer = Buffer.alloc(Math.min(maxExcerptBytes, Math.max(1, stat.size)));
        const read = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, read.bytesRead).toString("utf8");
        if (content.includes("\0")) continue;
        excerpts.push("New file: " + file + "\n" + redactSecrets(content));
      } finally {
        await handle.close();
      }
    } catch (error) {}
  }
  return excerpts;
}

async function extractRepoDiffSummary(repoPath, options = {}) {
  const git = options.runGit || runGit;
  const [statusResult, stagedStat, stagedDiff, workStat, workDiff] = await Promise.all([
    git(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(repoPath, ["diff", "--cached", "--stat", "--no-color"]),
    git(repoPath, ["diff", "--cached", "-U1", "--no-color"]),
    git(repoPath, ["diff", "--stat", "--no-color"]),
    git(repoPath, ["diff", "-U1", "--no-color"])
  ]);
  if (!statusResult.ok) throw new Error("Could not read Git status for " + path.basename(repoPath));

  const entries = parsePorcelain(statusResult.stdout);
  const visible = entries.filter((entry) => !entry.sensitive);
  const sensitiveFiles = entries.filter((entry) => entry.sensitive).map((entry) => entry.file);
  const untracked = visible.filter((entry) => entry.status === "??").map((entry) => entry.file);
  const untrackedExcerpts = await readUntrackedExcerpts(repoPath, untracked, options);
  const statusLines = visible.map((entry) => entry.status + " " + entry.file).join("\n");
  const body = [
    "Repository: " + path.basename(repoPath),
    statusLines ? "Status:\n" + statusLines : "Status: clean",
    untrackedExcerpts.length ? "Safe untracked source excerpts:\n" + untrackedExcerpts.join("\n\n") : "",
    scrubStat(stagedStat.stdout) ? "Staged stat:\n" + scrubStat(stagedStat.stdout) : "",
    scrubDiff(stagedDiff.stdout) ? "Staged diff:\n" + scrubDiff(stagedDiff.stdout) : "",
    scrubStat(workStat.stdout) ? "Working tree stat:\n" + scrubStat(workStat.stdout) : "",
    scrubDiff(workDiff.stdout) ? "Working tree diff:\n" + scrubDiff(workDiff.stdout) : "",
    untracked.length ? "Untracked files (names only):\n" + untracked.join("\n") : "",
    sensitiveFiles.length ? "Sensitive files omitted: " + sensitiveFiles.length : ""
  ].filter(Boolean).join("\n\n");
  const bounded = truncateUtf8(redactSecrets(body), options.maxBytes || MAX_DIFF_BYTES);
  return {
    repo: path.basename(repoPath),
    path: repoPath,
    summary: bounded.text,
    bytes: bounded.bytes,
    truncated: bounded.truncated,
    files: visible.map((entry) => entry.file),
    changes: visible,
    sensitiveFileCount: sensitiveFiles.length
  };
}

function buildPrompt(diffSummary) {
  const text = Array.isArray(diffSummary)
    ? diffSummary.map((item) => item.summary || String(item)).join("\n\n---\n\n")
    : (diffSummary && diffSummary.summary) || String(diffSummary || "");
  return [
    "You are a conventional commit generator.",
    "Analyze the sanitized git change summary below.",
    "Return ONLY a JSON array containing exactly 3 distinct strings.",
    "Every string must match: <type>(<scope>): <imperative summary>",
    "Allowed types: feat, fix, refactor, docs, chore, test, perf, style.",
    "Use a short lowercase scope and a concise present-tense imperative summary.",
    "Name the concrete behavior, endpoint, component, or symbol changed in the code.",
    "Avoid generic summaries such as update behavior, update files, make changes, or improve code.",
    "Option 1: primary functional change. Option 2: architectural perspective. Option 3: minimal summary.",
    "Do not use markdown, explanations, issue numbers, or trailing periods.",
    "\nSANITIZED LOCAL CHANGES\n" + text
  ].join("\n");
}

function scopeFromFiles(files, summaries) {
  const list = (files || []).map(normalizePath).filter(Boolean);
  const roots = list.map((file) => {
    const bits = file.split("/").filter(Boolean);
    if (bits.length > 1 && !["src", "lib", "app", "packages"].includes(bits[0].toLowerCase())) return bits[0];
    if (bits.length > 1) return bits[1].replace(/\.[^.]+$/, "");
    return bits[0] ? bits[0].replace(/\.[^.]+$/, "") : "repo";
  });
  if (!roots.length && summaries && summaries.length === 1) roots.push(summaries[0].repo || "repo");
  const counts = new Map();
  for (const root of roots) counts.set(root, (counts.get(root) || 0) + 1);
  const selected = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return String(selected ? selected[0] : "workspace").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "workspace";
}

function heuristicCommitSuggestions(input) {
  const summaries = Array.isArray(input) ? input : [input || {}];
  const changes = summaries.flatMap((item) => item.changes || []);
  const files = summaries.flatMap((item) => item.files || []);
  const scope = scopeFromFiles(files, summaries);
  const lowerFiles = files.map((file) => normalizePath(file).toLowerCase());
  const allDocs = lowerFiles.length > 0 && lowerFiles.every((file) => /(^|\/)(docs?\/|readme(?:\.|$)|[^/]+\.md$)/.test(file));
  const allTests = lowerFiles.length > 0 && lowerFiles.every((file) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(?:test|spec)\.[^/]+$/.test(file));
  const hasAdded = changes.some((entry) => entry.status.includes("A") || entry.status === "??");
  const hasDeleted = changes.some((entry) => entry.status.includes("D"));
  let primaryType = "fix";
  let primarySummary = "update changed behavior";
  if (allDocs) {
    primaryType = "docs";
    primarySummary = "update project documentation";
  } else if (allTests) {
    primaryType = "test";
    primarySummary = "expand automated coverage";
  } else if (hasAdded && !changes.some((entry) => entry.status !== "??" && !entry.status.includes("A"))) {
    primaryType = "feat";
    primarySummary = "introduce new functionality";
  } else if (hasAdded && hasDeleted) {
    primaryType = "refactor";
    primarySummary = "streamline the implementation";
  } else if (hasDeleted && !hasAdded) {
    primaryType = "refactor";
    primarySummary = "remove obsolete implementation";
  }
  const options = [
    `${primaryType}(${scope}): ${primarySummary}`,
    `refactor(${scope}): clarify the change structure`,
    `chore(${scope}): update repository files`
  ];
  if (primaryType === "refactor") options[1] = `fix(${scope}): align changed behavior`;
  if (primaryType === "chore") options[2] = `fix(${scope}): align changed behavior`;
  return options;
}

function pickModel(models) {
  const names = (models || []).map((model) => typeof model === "string" ? model : (model && (model.name || model.id))).filter(Boolean);
  for (const preferred of MODEL_PREFERENCE) {
    const found = names.find((name) => name.toLowerCase().includes(preferred));
    if (found) return found;
  }
  return names[0] || "";
}

function pickOmniRouteModel(models) {
  const names = (models || []).map((model) => typeof model === "string" ? model : (model && (model.id || model.name))).filter(Boolean);
  const preferred = [
    "auto/best-coding-fast",
    "auto/best-coding",
    "auto/pro-coding",
    "auto/coding",
    "auto/coding:reliable",
    "auto/coding:fast"
  ];
  for (const id of preferred) {
    const exact = names.find((name) => name.toLowerCase() === id);
    if (exact) return exact;
  }
  return names.find((name) => /(?:coding|coder|code)/i.test(name)) || names[0] || "";
}

async function fetchJson(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || PROVIDER_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const response = await fetchImpl(url, Object.assign({}, init, { signal: controller.signal }));
    if (!response.ok) throw new Error("Provider returned HTTP " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryOllama(prompt, options = {}) {
  const baseUrl = options.baseUrl || "http://127.0.0.1:11434";
  const tags = await fetchJson(baseUrl + "/api/tags", {}, options);
  const model = options.model || pickModel(tags.models);
  if (!model) throw new Error("No Ollama model is installed");
  const result = await fetchJson(baseUrl + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, format: "json", options: { temperature: 0.2 } })
  }, options);
  return { provider: "ollama", model, content: result.response || "" };
}

async function queryLocalOpenAI(prompt, options = {}) {
  const baseUrl = options.baseUrl || "http://127.0.0.1:1234/v1";
  const models = await fetchJson(baseUrl + "/models", {}, options);
  const model = options.model || pickModel(models.data);
  if (!model) throw new Error("No LM Studio model is loaded");
  const result = await fetchJson(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "Return JSON only." }, { role: "user", content: prompt }]
    })
  }, options);
  const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  return { provider: "lm-studio", model, content: content || "" };
}

async function queryOmniRoute(prompt, options = {}) {
  const allowed = options.allowCloud === true || process.env.ALLOW_CLOUD_AI === "1";
  const apiKey = options.omniRouteApiKey || process.env.OMNIROUTE_API_KEY;
  if (!allowed || !apiKey) throw new Error("OmniRoute cloud routing is disabled");
  const baseUrl = String(options.omniRouteUrl || process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/+$/, "");
  const requestOptions = Object.assign({}, options, { timeoutMs: options.omniRouteTimeoutMs || 30_000 });
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };
  let model = options.omniRouteModel || process.env.OMNIROUTE_MODEL || "";
  if (!model) {
    const models = await fetchJson(baseUrl + "/models", { headers }, requestOptions);
    model = pickOmniRouteModel(models.data);
  }
  if (!model) throw new Error("No OmniRoute chat model is available");
  const result = await fetchJson(baseUrl + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.15,
      max_tokens: 1200,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "Generate precise Conventional Commit messages from code diffs. Return JSON only." },
        { role: "user", content: prompt }
      ]
    })
  }, requestOptions);
  const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  return { provider: "omniroute", model, content: content || "" };
}

async function queryGemini(prompt, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const allowed = options.allowCloud === true || process.env.ALLOW_CLOUD_AI === "1";
  if (!allowed || !apiKey) throw new Error("Cloud AI is disabled");
  const model = options.model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const result = await fetchJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
    })
  }, options);
  const content = result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts && result.candidates[0].content.parts[0] && result.candidates[0].content.parts[0].text;
  return { provider: "gemini", model, content: content || "" };
}

function parseSuggestions(content) {
  let value = content;
  if (typeof value === "string") {
    const clean = value.trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```/g, "")
      .trim();
    try { value = JSON.parse(clean); } catch (error) {
      let extracted = null;
      for (let start = clean.indexOf("["); start !== -1; start = clean.indexOf("[", start + 1)) {
        const end = clean.lastIndexOf("]");
        if (end <= start) break;
        try {
          const candidate = JSON.parse(clean.slice(start, end + 1));
          if (Array.isArray(candidate)) { extracted = candidate; break; }
        } catch (parseError) {}
      }
      value = extracted || clean.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ""));
    }
  }
  if (value && !Array.isArray(value) && typeof value === "object") {
    value = value.suggestions || value.commits || value.messages || Object.values(value);
  }
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter((item) => {
    const match = item.match(CONVENTIONAL_COMMIT_RE);
    if (!match) return false;
    const type = match[1];
    if (!ALLOWED_TYPES.has(type) || seen.has(item)) return false;
    seen.add(item);
    return true;
  }).slice(0, 3);
}

function completeSuggestions(candidate, fallback) {
  const output = [];
  for (const item of [...parseSuggestions(candidate), ...fallback]) {
    if (CONVENTIONAL_COMMIT_RE.test(item) && !output.includes(item)) output.push(item);
    if (output.length === 3) break;
  }
  return output;
}

async function suggestCommitMessages(repoPaths, options = {}) {
  const paths = Array.isArray(repoPaths) ? repoPaths : [repoPaths];
  const summaries = [];
  let remaining = options.maxBytes || MAX_DIFF_BYTES;
  for (const repoPath of paths) {
    if (remaining <= 0) break;
    const summary = await extractRepoDiffSummary(repoPath, Object.assign({}, options, { maxBytes: remaining }));
    summaries.push(summary);
    remaining -= summary.bytes;
  }
  const fallback = heuristicCommitSuggestions(summaries);
  const prompt = buildPrompt(summaries);
  const providers = options.providers || [queryOllama, queryLocalOpenAI, queryOmniRoute, queryGemini];
  for (const provider of providers) {
    if ((provider === queryOmniRoute || provider === queryGemini) && !(options.allowCloud === true || process.env.ALLOW_CLOUD_AI === "1")) continue;
    try {
      const result = await provider(prompt, options);
      const suggestions = completeSuggestions(result.content, fallback);
      
      if (suggestions.length === 3) {
        const res = Object.assign({}, result, { suggestions });
        suggestionCache.set(cacheKey, { at: Date.now(), result: res });
        return res;
      }

    } catch (error) {
      // Provider discovery is best effort. The deterministic fallback below is
      // part of the product contract, not an error state.
    }
  }
  
  const res = { provider: "heuristic", model: null, suggestions: fallback };
  suggestionCache.set(cacheKey, { at: Date.now(), result: res });
  return res;

}

async function getLocalAiStatus(options = {}) {
  try {
    const tags = await fetchJson((options.ollamaUrl || "http://127.0.0.1:11434") + "/api/tags", {}, options);
    const model = pickModel(tags.models);
    if (model) return { available: true, provider: "ollama", model, offline: true };
  } catch (error) {}
  try {
    const models = await fetchJson((options.lmStudioUrl || "http://127.0.0.1:1234/v1") + "/models", {}, options);
    const model = pickModel(models.data);
    if (model) return { available: true, provider: "lm-studio", model, offline: true };
  } catch (error) {}
  const cloudAllowed = options.allowCloud === true || process.env.ALLOW_CLOUD_AI === "1";
  const omniRouteApiKey = options.omniRouteApiKey || process.env.OMNIROUTE_API_KEY;
  if (cloudAllowed && omniRouteApiKey) {
    try {
      const baseUrl = String(options.omniRouteUrl || process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/+$/, "");
      const models = await fetchJson(baseUrl + "/models", {
        headers: { Authorization: "Bearer " + omniRouteApiKey }
      }, options);
      const configured = options.omniRouteModel || process.env.OMNIROUTE_MODEL || "";
      const model = configured || pickOmniRouteModel(models.data);
      if (model) return { available: true, provider: "omniroute", model, offline: false };
    } catch (error) {}
  }
  return { available: false, provider: "heuristic", model: null, offline: true };
}

module.exports = {
  CONVENTIONAL_COMMIT_RE,
  MAX_DIFF_BYTES,
  buildPrompt,
  extractRepoDiffSummary,
  getLocalAiStatus,
  heuristicCommitSuggestions,
  isSensitivePath,
  parseSuggestions,
  queryGemini,
  queryLocalOpenAI,
  queryOllama,
  queryOmniRoute,
  redactSecrets,
  scrubDiff,
  suggestCommitMessages,
  truncateUtf8
};
