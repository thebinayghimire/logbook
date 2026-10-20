"use strict";

/**
 * Logbook authorization bridge.
 *
 * A zero-dependency Node server that:
 *   1. Serves the static Logbook folio.
 *   2. Runs the GitHub OAuth web flow (PKCE + state) when credentials are set.
 *   3. Can adopt an existing GitHub CLI session for local development.
 *   4. Proxies read-only GitHub API calls so the browser never receives a token.
 *
 * Run: node server.js  (or npm start)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

loadDotEnv();

const ROOT = __dirname;
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_ID = (process.env.GITHUB_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.GITHUB_CLIENT_SECRET || "").trim();
// Keep the default callback on the same hostname the bridge prints at startup.
// OAuth state cookies are host-scoped, so localhost and 127.0.0.1 are not interchangeable.
const CALLBACK_HOST = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : (HOST === "::1" ? "[::1]" : HOST);
const CALLBACK_URL = (process.env.GITHUB_CALLBACK_URL || `http://${CALLBACK_HOST}:${PORT}/auth/github/callback`).trim();
const OAUTH_SCOPE = (process.env.GITHUB_SCOPE || "repo read:org read:user user:email gist").trim();
const SESSION_TTL_MS = Math.max(1, Number.parseFloat(process.env.SESSION_TTL_HOURS || "12")) * 60 * 60 * 1000;
const SESSION_COOKIE = "logbook_sid";
const STATE_COOKIE = "logbook_oauth_state";
const IS_LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const ALLOW_LOCAL_AUTH = process.env.ALLOW_LOCAL_AUTH === "1" || (process.env.ALLOW_LOCAL_AUTH !== "0" && IS_LOOPBACK);
const OAUTH_CONFIGURED = Boolean(CLIENT_ID && CLIENT_SECRET);
const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";

/** @type {Map<string, {token:string, mode:string, login:string, profile:object, scopes:string, createdAt:number, lastUsed:number}>} */
const sessions = new Map();
/** @type {Map<string, {verifier:string, expectedLogin:string, createdAt:number}>} */
const pendingOAuth = new Map();
const localGh = { available: false, login: null, scopes: null, checkedAt: 0 };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

refreshLocalGh().finally(() => {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[logbook] unhandled:", err && err.message ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    console.log("");
    console.log("  LOGBOOK AUTHORIZATION BRIDGE");
    console.log("  ─────────────────────────────────────────────");
    console.log(`  URL              http://${HOST}:${PORT}`);
    console.log(`  OAuth app        ${OAUTH_CONFIGURED ? "configured" : "not configured (set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)"}`);
    console.log(`  Local gh session ${localGh.available ? "@" + localGh.login + " [" + (localGh.scopes || "no scopes") + "]" : "not available"}`);
    console.log(`  Local auth       ${ALLOW_LOCAL_AUTH ? "enabled" : "disabled"}`);
    console.log("  ─────────────────────────────────────────────");
    console.log("");
  });

  const prune = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(sid);
    }
    for (const [state, p] of pendingOAuth) {
      if (now - p.createdAt > 10 * 60 * 1000) pendingOAuth.delete(state);
    }
  }, 5 * 60 * 1000);
  prune.unref();
});

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  setSecurityHeaders(res);

  if (pathname === "/api/session" && req.method === "GET") {
    await ensureLocalGhFresh();
    return sendJson(res, 200, publicSessionState(req));
  }

  if (pathname === "/api/auth/local" && req.method === "POST") {
    return authorizeLocal(req, res);
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    return logout(req, res);
  }

  if (pathname.startsWith("/api/gh/") && req.method === "GET") {
    return proxyGitHub(req, res, pathname.slice("/api/gh".length) + url.search);
  }

  if (pathname === "/auth/github" && req.method === "GET") {
    return beginOAuth(req, res, url);
  }

  if (pathname === "/auth/github/callback" && req.method === "GET") {
    return finishOAuth(req, res, url);
  }

  if ((pathname === "/auth/logout" || pathname === "/logout") && req.method === "GET") {
    destroySession(req, res);
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "not_found" });
  }

  return serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------------------
// Session / auth endpoints
// ---------------------------------------------------------------------------

function publicSessionState(req) {
  const session = getSession(req);
  if (session) {
    return {
      authorized: true,
      mode: session.mode,
      login: session.login,
      profile: session.profile,
      scopes: session.scopes,
      expiresAt: session.createdAt + SESSION_TTL_MS
    };
  }
  return {
    authorized: false,
    oauthConfigured: OAUTH_CONFIGURED,
    oauthScopes: OAUTH_CONFIGURED ? OAUTH_SCOPE : null,
    callbackUrl: CALLBACK_URL,
    localAvailable: ALLOW_LOCAL_AUTH && localGh.available,
    localLogin: ALLOW_LOCAL_AUTH ? localGh.login : null,
    localScopes: ALLOW_LOCAL_AUTH ? localGh.scopes : null
  };
}

async function authorizeLocal(req, res) {
  if (!ALLOW_LOCAL_AUTH) {
    return sendJson(res, 403, {
      error: "local_disabled",
      message: "Local GitHub CLI authorization is disabled. Set ALLOW_LOCAL_AUTH=1 only on a private machine."
    });
  }
  if (!isTrustedRequest(req)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  try {
    const token = (await runGh(["auth", "token", "--hostname", "github.com"], 10000)).trim();
    if (!token) throw new Error("gh returned an empty token");
    const profile = await githubProfile(token);
    const session = createSession(token, "local", profile, localGh.scopes || "");
    res.setHeader("Set-Cookie", sessionCookie(req, session.id));
    return sendJson(res, 200, {
      authorized: true,
      mode: "local",
      login: profile.login,
      profile,
      scopes: session.scopes
    });
  } catch (err) {
    console.error("[logbook] local auth failed:", err.message);
    return sendJson(res, 401, {
      error: "gh_auth_failed",
      message: "No working GitHub CLI session was found. Run `gh auth login` in a terminal, then try again."
    });
  }
}

function logout(req, res) {
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
  destroySession(req, res);
  return sendJson(res, 200, { ok: true });
}

function beginOAuth(req, res, url) {
  if (!OAUTH_CONFIGURED) {
    return sendHtml(res, 503, "<h1>GitHub OAuth is not configured</h1><p>Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, then restart the server.</p>");
  }

  const expectedLogin = String(url.searchParams.get("username") || "").trim().replace(/^@/, "");
  if (!isValidGitHubLogin(expectedLogin)) {
    res.writeHead(302, { Location: "/?auth_error=invalid_username" });
    return res.end();
  }

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pendingOAuth.set(state, { verifier, expectedLogin: expectedLogin.toLowerCase(), createdAt: Date.now() });

  const authorize = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", CALLBACK_URL);
  authorize.searchParams.set("scope", OAUTH_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("login", expectedLogin);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");

  res.setHeader("Set-Cookie", stateCookie(req, state, 600));
  res.writeHead(302, { Location: authorize.toString() });
  res.end();
}

async function finishOAuth(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const oauthError = url.searchParams.get("error") || "";
  const cookieState = parseCookies(req)[STATE_COOKIE] || "";
  const pending = pendingOAuth.get(state);

  const fail = (reason) => {
    res.setHeader("Set-Cookie", clearCookie(req, STATE_COOKIE));
    res.writeHead(302, { Location: `/?auth_error=${encodeURIComponent(reason)}` });
    res.end();
  };

  if (oauthError) return fail(oauthError);
  if (!state || !pending || state !== cookieState || !code) return fail("invalid_state");
  pendingOAuth.delete(state);

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: pending.verifier
    });
    const tokenRes = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Logbook/4.13"
      },
      body,
      signal: AbortSignal.timeout(20000)
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error("[logbook] oauth exchange:", tokenJson.error || tokenRes.status);
      return fail(tokenJson.error || "token_exchange_failed");
    }

    const profile = await githubProfile(tokenJson.access_token);
    if (String(profile.login || "").toLowerCase() !== pending.expectedLogin) {
      console.warn(`[logbook] OAuth account mismatch: requested @${pending.expectedLogin}, authorized @${profile.login || "unknown"}`);
      return fail("account_mismatch");
    }
    const session = createSession(
      tokenJson.access_token,
      "oauth",
      profile,
      tokenJson.scope || OAUTH_SCOPE
    );
    const cookies = [stateCookie(req, "", 0), sessionCookie(req, session.id)];
    res.setHeader("Set-Cookie", cookies);
    res.writeHead(302, { Location: "/?authorized=1" });
    res.end();
  } catch (err) {
    console.error("[logbook] oauth callback:", err.message);
    return fail("oauth_failed");
  }
}

async function githubProfile(token) {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Logbook/4.13",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`GitHub profile ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// GitHub proxy (read-only)
// ---------------------------------------------------------------------------

async function proxyGitHub(req, res, apiPath) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: "unauthorized" });

  if (!apiPath.startsWith("/") || apiPath.includes("..") || apiPath.includes("\\")) {
    return sendJson(res, 400, { error: "bad_path" });
  }

  const headers = {
    Accept: req.headers.accept || "application/vnd.github+json",
    Authorization: `Bearer ${session.token}`,
    "User-Agent": "Logbook/4.13",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (req.headers["if-none-match"]) headers["If-None-Match"] = req.headers["if-none-match"];

  let upstream;
  try {
    upstream = await fetch(GITHUB_API + apiPath, {
      headers,
      signal: AbortSignal.timeout(60000),
      redirect: "follow"
    });
  } catch (err) {
    return sendJson(res, 502, { error: "github_unreachable", message: err.message });
  }

  if (upstream.status === 401) {
    destroySession(req, res);
    return sendJson(res, 401, { error: "github_token_invalid" });
  }

  const outHeaders = {};
  for (const name of [
    "content-type", "content-length", "link", "etag", "last-modified", "cache-control",
    "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
    "x-ratelimit-used", "x-ratelimit-resource", "x-github-request-id"
  ]) {
    const value = upstream.headers.get(name);
    if (value) outHeaders[name] = value;
  }
  if (!outHeaders["content-type"]) outHeaders["content-type"] = "application/json; charset=utf-8";

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, outHeaders);
  res.end(buffer);
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });

  let rel = pathname === "/" ? "/index.html" : pathname;
  try { rel = decodeURIComponent(rel); } catch (e) { return sendJson(res, 400, { error: "bad_path" }); }

  if (rel.includes("\0") || rel.includes("..") || /(^|\/)(\.env|\.git|node_modules|server\.js|package-lock\.json)(\/|$)/.test(rel)) {
    return sendJson(res, 404, { error: "not_found" });
  }

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return sendJson(res, 404, { error: "not_found" });

  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) return sendJson(res, 404, { error: "not_found" });

  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not_found" });
    res.writeHead(200, {
      "Content-Type": MIME[ext],
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end();
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Helpers: sessions, cookies, requests
// ---------------------------------------------------------------------------

function createSession(token, mode, profile, scopes) {
  const sid = randomToken(32);
  const now = Date.now();
  const session = {
    token,
    mode,
    login: profile.login,
    profile,
    scopes: scopes || "",
    createdAt: now,
    lastUsed: now
  };
  sessions.set(sid, session);
  return { id: sid, mode: session.mode, login: session.login, profile: session.profile, scopes: session.scopes };
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  session.lastUsed = Date.now();
  return session;
}

function destroySession(req, res) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
}

function sessionCookie(req, value) {
  const secure = isSecure(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? Math.floor(SESSION_TTL_MS / 1000) : 0}${secure}`;
}

function stateCookie(req, value, maxAge) {
  const secure = isSecure(req) ? "; Secure" : "";
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(req, name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? "; Secure" : ""}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (e) {
      // Ignore malformed cookie encodings rather than failing the request.
    }
  });
  return out;
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
}

function isTrustedRequest(req) {
  if (req.headers["x-logbook-auth"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers: GitHub CLI
// ---------------------------------------------------------------------------

async function refreshLocalGh() {
  try {
    const stdout = await runGh(["auth", "status", "--json", "hosts"], 6000);
    const data = JSON.parse(stdout);
    const hosts = data.hosts && data.hosts["github.com"];
    const active = Array.isArray(hosts) ? hosts.find((h) => h.active) || hosts[0] : null;
    localGh.available = Boolean(active && active.state === "success");
    localGh.login = active ? active.login : null;
    localGh.scopes = active ? active.scopes : null;
    localGh.checkedAt = Date.now();
  } catch (err) {
    localGh.available = false;
    localGh.login = null;
    localGh.scopes = null;
    localGh.checkedAt = Date.now();
  }
}

async function ensureLocalGhFresh() {
  if (Date.now() - localGh.checkedAt > 60000) await refreshLocalGh();
}

function runGh(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}${stderr ? " — " + stderr.trim() : ""}`;
        return reject(err);
      }
      resolve(String(stdout || ""));
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers: misc
// ---------------------------------------------------------------------------

function isValidGitHubLogin(value) {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(String(value || ""));
}

function loadDotEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return; }
  text.split(/\r?\n/).forEach((line) => {
    if (!line || /^\s*#/.test(line)) return;
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) return;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  });
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function sendHtml(res, status, body) {
  const data = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Logbook</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length });
  res.end(data);
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
