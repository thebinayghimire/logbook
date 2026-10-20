"use strict";

/**
 * Logbook authorization bridge.
 *
 * A zero-dependency Node server that:
 *   1. Serves the static Logbook folio.
 *   2. Runs the GitHub OAuth web flow (PKCE + state) when credentials are set.
 *   3. Can adopt an existing GitHub CLI session for local development.
 *   4. Proxies read-only GitHub API calls so the browser never receives a token.
 *   5. Persists encrypted, account-partitioned sessions and snapshots.
 *
 * Run: node server.js  (or npm start)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { SnapshotStore } = require("./snapshot-store");
const { SessionStore } = require("./session-store");
const { SyncEngine } = require("./sync-engine");
const {
  digest,
  randomToken,
  pkceChallenge,
  timingSafeEqual,
  sanitizeReturnTo,
  parseCookies,
  clientIp,
  RateLimiter,
  buildCsp,
  injectCspNonce,
  isSecureRequest
} = require("./security");
const { version: VERSION } = require("./package.json");

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
const SNAPSHOT_FRESH_MS = Math.max(0, Number.parseFloat(process.env.SNAPSHOT_FRESH_MS || "60000"));
const SESSION_COOKIE = "logbook_sid";
const STATE_COOKIE = "logbook_oauth_state";
const IS_LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const ALLOW_LOCAL_AUTH = process.env.ALLOW_LOCAL_AUTH === "1" || (process.env.ALLOW_LOCAL_AUTH !== "0" && IS_LOOPBACK);
const OAUTH_CONFIGURED = Boolean(CLIENT_ID && CLIENT_SECRET);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const CSP_ENABLED = process.env.CSP_ENABLED !== "0";
const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const DATA_DIR = path.resolve(process.env.LOGBOOK_DATA_DIR || path.join(ROOT, "data"));
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROXY_BYTES = 12 * 1024 * 1024;
const PRODUCTION = process.env.NODE_ENV === "production";

const snapshotStore = new SnapshotStore({
  dataDir: DATA_DIR,
  encryptionKey: process.env.SNAPSHOT_ENCRYPTION_KEY
});
const sessionStore = new SessionStore({
  dataDir: DATA_DIR,
  dbPath: snapshotStore.dbPath,
  key: snapshotStore.key,
  ttlMs: SESSION_TTL_MS
});
const syncEngine = new SyncEngine(snapshotStore, {
  includeBots: process.env.INCLUDE_BOTS === "1",
  includeMergeCommits: process.env.INCLUDE_MERGE_COMMITS === "1"
});

const apiLimiter = new RateLimiter({ windowMs: 60_000, max: 300 });
const authLimiter = new RateLimiter({ windowMs: 60_000, max: 20 });
const syncLimiter = new RateLimiter({ windowMs: 60_000, max: 20 });
const exportLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });

/** @type {Map<string, {verifier:string, expectedLogin:string, returnTo:string, createdAt:number}>} */
const pendingOAuth = new Map();
const localGh = { available: false, login: null, scopes: null, checkedAt: 0 };
const sseClients = new Map(); // accountId -> Set<{res, close}>

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

refreshLocalGh().finally(() => {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const requestId = randomToken(6);
    req.logbookId = requestId;
    res.setHeader("X-Logbook-Request-Id", requestId);
    res.on("finish", () => {
      // Structured request logs deliberately exclude cookies, query strings,
      // tokens, and private payloads.
      const entry = {
        at: new Date().toISOString(),
        level: res.statusCode >= 500 ? "error" : "info",
        event: "http.request",
        requestId,
        method: req.method,
        path: String(req.url || "").split("?")[0],
        status: res.statusCode,
        durationMs: Date.now() - started,
        ip: clientIp(req, TRUST_PROXY)
      };
      console.log(JSON.stringify(entry));
    });
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
    console.log(`  Sessions         SQLite · ${Math.round(SESSION_TTL_MS / 3600000)}h TTL`);
    console.log(`  Snapshots        AES-256-GCM · ${DATA_DIR}`);
    console.log(`  CSP              ${CSP_ENABLED ? "enabled (nonce scripts)" : "disabled"}`);
    console.log("  ─────────────────────────────────────────────");
    if (PRODUCTION && !process.env.SNAPSHOT_ENCRYPTION_KEY) {
      console.warn("  [warn] NODE_ENV=production requires SNAPSHOT_ENCRYPTION_KEY; generated keys are for development only.");
    }
    if (PRODUCTION && !CALLBACK_URL.startsWith("https://")) {
      console.warn("  [warn] NODE_ENV=production should use an HTTPS GITHUB_CALLBACK_URL.");
    }
    if (PRODUCTION && ALLOW_LOCAL_AUTH) {
      console.warn("  [warn] ALLOW_LOCAL_AUTH is enabled in production. Set ALLOW_LOCAL_AUTH=0.");
    }
    console.log("");
  });

  const prune = setInterval(() => {
    const now = Date.now();
    sessionStore.prune(now);
    apiLimiter.prune(now);
    authLimiter.prune(now);
    syncLimiter.prune(now);
    exportLimiter.prune(now);
    for (const [state, p] of pendingOAuth) {
      if (now - p.createdAt > 10 * 60 * 1000) pendingOAuth.delete(state);
    }
  }, 5 * 60 * 1000);
  prune.unref();

  const shutdown = (signal) => {
    console.log(`[logbook] ${signal} received; closing listener`);
    for (const [, clients] of sseClients) {
      for (const client of clients) client.close();
    }
    server.close(() => {
      sessionStore.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const nonce = randomToken(18);
  res.logbookNonce = nonce;
  setSecurityHeaders(req, res, nonce);
  req.logbookIp = clientIp(req, TRUST_PROXY);

  // Unauthenticated health probes are intentionally outside the API limiter.
  if (pathname === "/healthz" || pathname === "/livez") {
    return sendJson(res, 200, { ok: true, status: "live", uptime: Math.round(process.uptime()), version: VERSION });
  }
  if (pathname === "/readyz") {
    const ready = snapshotStore.health() && sessionStore.health();
    return sendJson(res, ready ? 200 : 503, {
      ok: ready,
      status: ready ? "ready" : "not_ready",
      storage: ready,
      uptime: Math.round(process.uptime()),
      version: VERSION
    });
  }

  if (pathname.startsWith("/api/")) {
    const verdict = apiLimiter.check("ip:" + req.logbookIp);
    applyRateHeaders(res, verdict);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfter));
      return sendJson(res, 429, {
        error: "rate_limited",
        message: "Too many bridge requests. Wait a moment and try again.",
        retryAfter: verdict.retryAfter
      });
    }
  }

  if (pathname === "/api/session" && req.method === "GET") {
    await ensureLocalGhFresh();
    return sendJson(res, 200, publicSessionState(req));
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    return listSessions(req, res);
  }

  if (pathname === "/api/sessions/revoke" && req.method === "POST") {
    return revokeSessions(req, res);
  }

  if (pathname === "/api/account" && req.method === "DELETE") {
    return deleteAccount(req, res);
  }

  if (pathname === "/api/preferences" && req.method === "GET") {
    return getPreferences(req, res);
  }

  if (pathname === "/api/preferences" && req.method === "PUT") {
    return putPreferences(req, res);
  }

  if (pathname === "/api/export" && req.method === "GET") {
    return exportAccount(req, res);
  }

  if (pathname === "/api/status" && req.method === "GET") {
    return accountStatus(req, res);
  }

  if (pathname === "/api/events" && req.method === "GET") {
    return eventStream(req, res);
  }

  if (pathname === "/api/auth/local" && req.method === "POST") {
    return authorizeLocal(req, res);
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    return logout(req, res);
  }

  if (pathname === "/api/snapshot" && req.method === "GET") {
    return getSnapshot(req, res, url);
  }

  if (pathname === "/api/sync" && req.method === "POST") {
    return startSync(req, res, url);
  }

  if (pathname === "/api/sync" && req.method === "GET") {
    return getSyncStatus(req, res);
  }

  if (pathname === "/api/sync" && req.method === "DELETE") {
    return cancelSync(req, res);
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
    destroySession(req, res, { allDevices: false });
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
    const snapshot = snapshotStore.head(session.profile.id);
    return {
      authorized: true,
      mode: session.mode,
      login: session.login,
      profile: session.profile,
      scopes: session.scopes,
      permissions: explainScopes(session.scopes),
      snapshotAvailable: Boolean(snapshot),
      snapshotAt: snapshot ? snapshot.updatedAt : null,
      sync: syncEngine.status(session.profile.id),
      createdAt: session.createdAt,
      lastUsed: session.lastUsed,
      expiresAt: session.expiresAt,
      sessionId: session.publicId,
      csrfToken: sessionStore.csrfFor(session.sid)
    };
  }
  return {
    authorized: false,
    oauthConfigured: OAUTH_CONFIGURED,
    oauthScopes: OAUTH_CONFIGURED ? OAUTH_SCOPE : null,
    permissions: OAUTH_CONFIGURED ? explainScopes(OAUTH_SCOPE) : [],
    callbackUrl: CALLBACK_URL,
    localAvailable: ALLOW_LOCAL_AUTH && localGh.available,
    localLogin: ALLOW_LOCAL_AUTH ? localGh.login : null,
    localScopes: ALLOW_LOCAL_AUTH ? localGh.scopes : null,
    sessionTtlHours: Math.round(SESSION_TTL_MS / 3600000)
  };
}

function explainScopes(scopes) {
  const descriptions = {
    repo: "Read and write access to private repositories. Logbook only issues GET requests.",
    public_repo: "Read access to public repositories.",
    "read:org": "Read organization membership and teams.",
    "read:user": "Read profile information.",
    "user:email": "Read email addresses so commits can be attributed to you.",
    gist: "Read gists."
  };
  return String(scopes || "").split(/[,\s]+/).filter(Boolean).map((scope) => ({
    scope,
    description: descriptions[scope] || "GitHub permission requested by the configured OAuth scope."
  }));
}

function listSessions(req, res) {
  const session = requireApi(req, res);
  if (!session) return;
  return sendJson(res, 200, {
    sessions: sessionStore.list(session.profile.id, session.sid),
    currentSessionId: session.publicId,
    account: { login: session.login, id: session.profile.id }
  });
}

async function revokeSessions(req, res) {
  const session = requireApi(req, res, { csrf: true });
  if (!session) return;
  let body = {};
  try { body = await readJsonBody(req, res); } catch (error) { return sendJson(res, error.status || 400, { error: error.code || "bad_request" }); }
  const accountId = session.profile.id;
  let revoked = 0;
  let signedOut = false;
  if (body && body.all === true) {
    revoked = sessionStore.revokeAll(accountId);
    signedOut = true;
  } else if (body && body.id) {
    const target = sessionStore.list(accountId, session.sid).find((entry) => entry.id === String(body.id));
    if (target) {
      revoked = sessionStore.revokePublic(accountId, target.id) ? 1 : 0;
      if (target.current) signedOut = true;
    }
  } else {
    revoked = sessionStore.revokeOthers(accountId, session.sid);
  }
  audit("session.revoke", session, { detail: "revoked=" + revoked + (signedOut ? " all" : ""), req });
  if (signedOut) res.setHeader("Set-Cookie", sessionCookie(req, ""));
  return sendJson(res, 200, { ok: true, revoked, signedOut });
}

async function deleteAccount(req, res) {
  const session = requireApi(req, res, { csrf: true });
  if (!session) return;
  let body = {};
  try { body = await readJsonBody(req, res); } catch (error) { return sendJson(res, error.status || 400, { error: error.code || "bad_request" }); }
  if (!body || body.confirm !== "DELETE") {
    return sendJson(res, 400, {
      error: "confirmation_required",
      message: "Send {\"confirm\":\"DELETE\"} to permanently delete Logbook data for this account."
    });
  }
  const accountId = session.profile.id;
  syncEngine.cancel(accountId);
  const snapshots = snapshotStore.deleteAccount(accountId);
  const sessions = sessionStore.deleteAccount(accountId);
  console.warn(JSON.stringify({ event: "account.delete", accountId: String(accountId), snapshots, sessions, at: new Date().toISOString() }));
  res.setHeader("Set-Cookie", sessionCookie(req, ""));
  return sendJson(res, 200, {
    ok: true,
    deleted: { snapshots: snapshots.snapshots, jobs: snapshots.jobs, sessions: sessions.sessions },
    message: "Logbook data for this account was deleted. Revoke the OAuth app on GitHub to remove its authorization record."
  });
}

function getPreferences(req, res) {
  const session = requireApi(req, res);
  if (!session) return;
  return sendJson(res, 200, sessionStore.getPreferences(session.profile.id) || { values: {}, updatedAt: null });
}

async function putPreferences(req, res) {
  const session = requireApi(req, res, { csrf: true });
  if (!session) return;
  let body;
  try { body = await readJsonBody(req, res); } catch (error) { return sendJson(res, error.status || 400, { error: error.code || "bad_request" }); }
  const values = body && body.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return sendJson(res, 400, { error: "invalid_preferences" });
  }
  // Preferences are UI state only. Reject anything that looks like a secret or
  // a private payload before it reaches disk.
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(key)) continue;
    if (typeof value === "string") {
      if (value.length > 2000) continue;
      clean[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      clean[key] = value;
      continue;
    }
    // Saved views and other small UI structures are allowed, but only as
    // bounded plain JSON. This keeps preference writes from becoming a
    // side-channel for private payloads or oversized blobs.
    if (typeof value === "object") {
      let serialized;
      try { serialized = JSON.stringify(value); } catch (error) { continue; }
      if (!serialized || serialized.length > 16_000) continue;
      try { clean[key] = JSON.parse(serialized); } catch (error) { continue; }
    }
  }
  try {
    const saved = sessionStore.putPreferences(session.profile.id, clean);
    return sendJson(res, 200, { ok: true, updatedAt: saved.updatedAt });
  } catch (error) {
    return sendJson(res, 413, { error: "preferences_too_large" });
  }
}

function exportAccount(req, res) {
  const session = requireApi(req, res);
  if (!session) return;
  const verdict = exportLimiter.check("account:" + session.profile.id);
  applyRateHeaders(res, verdict);
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    return sendJson(res, 429, { error: "rate_limited" });
  }
  const record = snapshotStore.get(session.profile.id);
  if (!record) return sendJson(res, 404, { error: "snapshot_missing" });
  const payload = Object.assign({}, record.payload, {
    export: {
      generatedAt: Date.now(),
      generatedBy: "Logbook " + VERSION,
      account: { login: session.login, id: session.profile.id },
      snapshotAt: record.updatedAt,
      schemaVersion: record.payload.schemaVersion,
      partial: Boolean(record.payload.partial),
      attribution: record.payload.attribution || null,
      scope: record.payload.scope || null,
      limits: record.payload.limits || null,
      contributionSource: record.payload.contributionSource || "local-scan"
    }
  });
  audit("data.export", session, { detail: "snapshot_json", req });
  return sendCompressedJson(req, res, 200, payload, {
    "Content-Disposition": `attachment; filename="logbook-${safeFilename(session.login)}-${new Date().toISOString().slice(0, 10)}.json"`,
    "X-Logbook-Snapshot-At": String(record.updatedAt)
  });
}

function accountStatus(req, res) {
  const session = requireApi(req, res);
  if (!session) return;
  const head = snapshotStore.head(session.profile.id);
  return sendJson(res, 200, {
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    account: { login: session.login, id: String(session.profile.id) },
    session: {
      mode: session.mode,
      scopes: session.scopes,
      createdAt: session.createdAt,
      lastUsed: session.lastUsed,
      expiresAt: session.expiresAt,
      active: sessionStore.list(session.profile.id, session.sid).length
    },
    snapshot: head ? { updatedAt: head.updatedAt, contentHash: head.contentHash } : null,
    sync: syncEngine.status(session.profile.id) || null,
    audit: sessionStore.recentAudit(session.profile.id, 10)
  });
}

function eventStream(req, res) {
  const session = requireApi(req, res);
  if (!session) return;
  const accountId = String(session.profile.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const client = {
    res,
    close() {
      try { res.end(); } catch (error) { /* already closed */ }
    }
  };
  const clients = sseClients.get(accountId) || new Set();
  // Bound one account's fan-out so a tab loop cannot exhaust file handles.
  while (clients.size >= 4) {
    const oldest = clients.values().next().value;
    clients.delete(oldest);
    oldest.close();
  }
  clients.add(client);
  sseClients.set(accountId, clients);

  const send = (job) => {
    try {
      res.write("event: sync\ndata: " + JSON.stringify(job) + "\n\n");
    } catch (error) {
      cleanup();
    }
  };
  send(Object.assign({ state: "idle", phase: "idle", progress: 0 }, syncEngine.status(accountId) || {}, {
    snapshotAt: snapshotStore.head(accountId) ? snapshotStore.head(accountId).updatedAt : null
  }));
  const unsubscribe = syncEngine.subscribe(accountId, send);
  const heartbeat = setInterval(() => {
    try { res.write(": ping " + Date.now() + "\n\n"); } catch (error) { cleanup(); }
  }, 25_000);
  heartbeat.unref();

  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
    clients.delete(client);
    if (!clients.size) sseClients.delete(accountId);
    try { res.end(); } catch (error) { /* closed */ }
  }
  req.on("close", cleanup);
  req.on("error", cleanup);
}

async function authorizeLocal(req, res) {
  if (!ALLOW_LOCAL_AUTH) {
    return sendJson(res, 403, {
      error: "local_disabled",
      message: "Local GitHub CLI authorization is disabled. Set ALLOW_LOCAL_AUTH=1 only on a private machine."
    });
  }
  const verdict = authLimiter.check("ip:" + req.logbookIp);
  applyRateHeaders(res, verdict);
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    return sendJson(res, 429, { error: "rate_limited" });
  }
  if (!isTrustedRequest(req)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  try {
    const token = (await runGh(["auth", "token", "--hostname", "github.com"], 10000)).trim();
    if (!token) throw new Error("gh returned an empty token");
    const profile = await githubProfile(token);
    const created = createSession(req, token, "local", profile, localGh.scopes || "");
    const response = {
      authorized: true,
      mode: "local",
      login: profile.login,
      profile,
      scopes: created.scopes,
      permissions: explainScopes(created.scopes),
      csrfToken: created.csrfToken,
      expiresAt: created.expiresAt
    };
    res.setHeader("Set-Cookie", sessionCookie(req, created.id));
    audit("auth.login", { profile, req }, { detail: "local" });
    return sendJson(res, 200, response);
  } catch (err) {
    console.error("[logbook] local auth failed:", err.message);
    return sendJson(res, 401, {
      error: "gh_auth_failed",
      message: "No working GitHub CLI session was found. Run `gh auth login` in a terminal, then try again."
    });
  }
}

function logout(req, res) {
  const session = requireApi(req, res, { csrf: true });
  if (!session) return;
  audit("auth.logout", session, { req });
  destroySession(req, res);
  return sendJson(res, 200, { ok: true });
}

function getSnapshot(req, res, url) {
  const session = requireApi(req, res);
  if (!session) return;

  // Check the stored hash before decrypting so a conditional poll costs one
  // indexed SQLite lookup instead of a full decrypt, serialise and compress.
  const head = snapshotStore.head(session.profile.id);
  if (!head) return sendJson(res, 404, { error: "snapshot_missing" });
  const etag = `"${head.contentHash}"`;
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, {
      ETag: etag,
      "Cache-Control": "no-store",
      "X-Logbook-Snapshot-At": String(head.updatedAt)
    });
    return res.end();
  }

  const record = snapshotStore.get(session.profile.id);
  if (!record) return sendJson(res, 404, { error: "snapshot_missing" });

  const payload = { ...record.payload };
  const rawLimit = Number.parseInt(url.searchParams.get("commit_limit") || "0", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(10000, rawLimit) : 0;
  const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0);
  if (limit && Array.isArray(payload.commits)) {
    const total = payload.commits.length;
    payload.commits = payload.commits.slice(cursor, cursor + limit);
    payload.commitTotal = total;
    payload.pagination = {
      cursor,
      limit,
      total,
      nextCursor: cursor + limit < total ? cursor + limit : null
    };
  } else if (Array.isArray(payload.commits)) {
    payload.commitTotal = payload.commits.length;
  }

  return sendCompressedJson(req, res, 200, payload, {
    ETag: etag,
    "X-Logbook-Snapshot-At": String(record.updatedAt),
    "X-Logbook-Sync-State": payload.loading ? "syncing" : (payload.syncError ? "failed" : "idle"),
    "X-Logbook-Sections": Buffer.from(JSON.stringify(record.sectionHashes)).toString("base64url")
  });
}

function etagMatches(header, etag) {
  if (!header) return false;
  return String(header).split(",").map((value) => value.trim()).some((value) => value === etag || value === "*");
}

function startSync(req, res, url) {
  const session = requireApi(req, res, { csrf: true });
  if (!session) return;
  const accountId = String(session.profile.id);
  const verdict = syncLimiter.check("account:" + accountId);
  applyRateHeaders(res, verdict);
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    return sendJson(res, 429, { error: "rate_limited", retryAfter: verdict.retryAfter });
  }
  const force = url.searchParams.get("force") === "1";
  const skipIfFresh = url.searchParams.get("skip_if_fresh") === "1";
  const current = syncEngine.status(accountId);

  // Page loads ask to skip a scan when the stored snapshot is still fresh.
  // Explicit refreshes, live-change detection, and failed/interrupted jobs
  // always enqueue.
  if (!force && skipIfFresh && current && !["queued", "scanning", "failed"].includes(current.state)) {
    const head = snapshotStore.head(accountId);
    if (head && Date.now() - head.updatedAt < SNAPSHOT_FRESH_MS) {
      return sendJson(res, 200, {
        ...current,
        state: "current",
        phase: "complete",
        progress: 100,
        skipped: true,
        snapshotAt: head.updatedAt
      });
    }
  }

  const job = syncEngine.enqueue(session, force);
  return sendJson(res, 202, { ...job, snapshotAt: snapshotAt(session) });
}

function getSyncStatus(req, res) {
  const session = requireApi(req, res);
  if (!session) return;
  const job = syncEngine.status(session.profile.id) || { state: "idle", phase: "idle", progress: 0 };
  return sendJson(res, 200, { ...job, snapshotAt: snapshotAt(session) });
}

function snapshotAt(session) {
  const head = snapshotStore.head(session.profile.id);
  return head ? head.updatedAt : null;
}

function cancelSync(req, res) {
  const session = requireApi(req, res, { csrf: true });
  if (!session) return;
  return sendJson(res, 200, { ok: syncEngine.cancel(session.profile.id) });
}

function beginOAuth(req, res, url) {
  if (!OAUTH_CONFIGURED) {
    return sendHtml(res, 503, "<h1>GitHub OAuth is not configured</h1><p>Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, then restart the server.</p>");
  }
  const verdict = authLimiter.check("ip:" + req.logbookIp);
  applyRateHeaders(res, verdict);
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    return sendJson(res, 429, { error: "rate_limited" });
  }

  const expectedLogin = String(url.searchParams.get("username") || "").trim().replace(/^@/, "");
  if (!isValidGitHubLogin(expectedLogin)) {
    res.writeHead(302, { Location: "/?auth_error=invalid_username" });
    return res.end();
  }
  const returnTo = sanitizeReturnTo(url.searchParams.get("return_to") || "/");

  // Account switching is explicit: authorizing a new identity invalidates the
  // current bridge session instead of silently keeping both alive.
  const existing = getSession(req);
  if (existing) sessionStore.revoke(existing.sid);

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = pkceChallenge(verifier);
  pendingOAuth.set(state, {
    verifier,
    expectedLogin: expectedLogin.toLowerCase(),
    returnTo,
    createdAt: Date.now()
  });

  const authorize = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", CALLBACK_URL);
  authorize.searchParams.set("scope", OAUTH_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("login", expectedLogin);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");

  const cookies = [stateCookie(req, state, 600)];
  if (existing) cookies.push(sessionCookie(req, ""));
  res.setHeader("Set-Cookie", cookies);
  res.writeHead(302, { Location: authorize.toString() });
  res.end();
}

async function finishOAuth(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const oauthError = url.searchParams.get("error") || "";
  const cookieState = parseCookies(req)[STATE_COOKIE] || "";
  const pending = pendingOAuth.get(state);
  const returnTo = sanitizeReturnTo(pending ? pending.returnTo : "/");

  const fail = (reason) => {
    res.setHeader("Set-Cookie", clearCookie(req, STATE_COOKIE));
    res.writeHead(302, { Location: withQuery(returnTo, "auth_error", reason) });
    res.end();
  };

  if (oauthError) {
    if (oauthError === "access_denied") {
      // Common when an organization blocks the OAuth app or the user declines.
      return fail("access_denied");
    }
    return fail(oauthError);
  }
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
        "User-Agent": "Logbook/" + VERSION
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
      sessionStore.audit("auth.mismatch", {
        login: profile.login || null,
        detail: "requested @" + pending.expectedLogin,
        ip: req.logbookIp,
        userAgent: req.headers["user-agent"]
      });
      return fail("account_mismatch");
    }
    const created = createSession(
      req,
      tokenJson.access_token,
      "oauth",
      profile,
      tokenJson.scope || OAUTH_SCOPE
    );
    const cookies = [clearCookie(req, STATE_COOKIE), sessionCookie(req, created.id)];
    res.setHeader("Set-Cookie", cookies);
    audit("auth.login", { profile, req }, { detail: "oauth" });
    console.log(`[logbook] authorized @${profile.login} via OAuth`);
    res.writeHead(302, { Location: withQuery(returnTo, "authorized", "1") });
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
      "User-Agent": "Logbook/" + VERSION,
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
  const session = requireApi(req, res);
  if (!session) return;

  if (!apiPath.startsWith("/") || apiPath.includes("..") || apiPath.includes("\\") || apiPath.length > 8192) {
    return sendJson(res, 400, { error: "bad_path" });
  }
  if (apiPath.startsWith("/graphql")) {
    return sendJson(res, 405, { error: "graphql_not_proxied" });
  }

  const headers = {
    Accept: req.headers.accept || "application/vnd.github+json",
    Authorization: `Bearer ${session.token}`,
    "User-Agent": "Logbook/" + VERSION,
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
    audit("auth.revoked", session, { detail: "github_401", req });
    destroySession(req, res);
    return sendJson(res, 401, { error: "github_token_invalid", code: "reauth_required" });
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
  if (buffer.length > MAX_PROXY_BYTES) {
    return sendJson(res, 502, { error: "github_response_too_large" });
  }
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
    let body = data;
    if (ext === ".html" && CSP_ENABLED) {
      // Inline scripts are permitted only with this request's nonce.
      body = Buffer.from(injectCspNonce(data.toString("utf8"), res.logbookNonce), "utf8");
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext],
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end();
    res.end(body);
  });
}

// ---------------------------------------------------------------------------
// Helpers: sessions, cookies, requests
// ---------------------------------------------------------------------------

function createSession(req, token, mode, profile, scopes) {
  const created = sessionStore.create({
    token,
    mode,
    profile,
    login: profile.login,
    scopes: scopes || "",
    userAgent: req.headers["user-agent"],
    ip: req.logbookIp
  });
  return {
    id: created.id,
    csrfToken: created.csrfToken,
    publicId: created.publicId,
    expiresAt: created.expiresAt,
    mode,
    login: profile.login,
    profile,
    scopes: scopes || ""
  };
}

function getSession(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  return sessionStore.get(sid);
}

function requireApi(req, res, options = {}) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "unauthorized", code: "session_expired" });
    return null;
  }
  if (options.csrf) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: "forbidden", code: "origin_rejected" });
      return null;
    }
    if (!sessionStore.verifyCsrf(session, req.headers["x-logbook-csrf"])) {
      sendJson(res, 403, { error: "csrf_failed", code: "csrf" });
      return null;
    }
  }
  return session;
}

function destroySession(req, res, options = {}) {
  const session = getSession(req);
  if (session) {
    if (options.allDevices) sessionStore.revokeAll(session.profile.id);
    else sessionStore.revoke(session.sid);
  }
  res.setHeader("Set-Cookie", sessionCookie(req, ""));
}

function sessionCookie(req, value) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? Math.floor(SESSION_TTL_MS / 1000) : 0}${secure}`;
}

function stateCookie(req, value, maxAge) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(req, name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureRequest(req) ? "; Secure" : ""}`;
}

function isTrustedRequest(req) {
  if (req.headers["x-logbook-auth"] !== "1") return false;
  const fetchSite = String(req.headers["sec-fetch-site"] || "");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function withQuery(returnTo, key, value) {
  try {
    const url = new URL(sanitizeReturnTo(returnTo), "https://logbook.invalid");
    url.searchParams.set(key, value);
    return url.pathname + (url.search ? url.search : "") + (url.hash || "");
  } catch (error) {
    return "/?" + encodeURIComponent(key) + "=" + encodeURIComponent(value);
  }
}

function applyRateHeaders(res, verdict) {
  res.setHeader("X-Logbook-RateLimit-Limit", String(verdict.limit));
  res.setHeader("X-Logbook-RateLimit-Remaining", String(verdict.remaining));
  res.setHeader("X-Logbook-RateLimit-Reset", String(Math.ceil(verdict.resetAt / 1000)));
}

function audit(action, input = {}, extra = {}) {
  try {
    const profile = input.profile || input;
    sessionStore.audit(action, {
      accountId: profile && profile.id != null ? profile.id : null,
      login: profile && profile.login ? profile.login : null,
      ip: extra.req ? extra.req.logbookIp : input.ip,
      userAgent: extra.req ? extra.req.headers["user-agent"] : input.userAgent,
      detail: extra.detail
    });
  } catch (error) {
    console.error("[logbook] audit write failed:", error.message);
  }
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        if (size - chunk.length <= MAX_REQUEST_BYTES) {
          const error = new Error("request_too_large");
          error.status = 413;
          error.code = "request_too_large";
          reject(error);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new Error("too large");
        resolve(JSON.parse(text));
      } catch (error) {
        reject(Object.assign(new Error("invalid_json"), { status: 400, code: "invalid_json" }));
      }
    });
    req.on("error", (error) => reject(Object.assign(error, { status: 400, code: "bad_request" })));
  });
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

function safeFilename(value) {
  return String(value || "account").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "account";
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

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function sendCompressedJson(req, res, status, body, headers) {
  const raw = Buffer.from(JSON.stringify(body));
  const accepted = String(req.headers["accept-encoding"] || "");
  let data = raw;
  let encoding = "";
  if (raw.length > 1024 && accepted.includes("br")) {
    data = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
    });
    encoding = "br";
  } else if (raw.length > 1024 && accepted.includes("gzip")) {
    data = zlib.gzipSync(raw, { level: 6 });
    encoding = "gzip";
  }
  const out = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding"
  }, headers || {});
  if (encoding) out["Content-Encoding"] = encoding;
  res.writeHead(status, out);
  res.end(data);
}

function sendHtml(res, status, body) {
  const data = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Logbook</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length });
  res.end(data);
}

function setSecurityHeaders(req, res, nonce) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (CSP_ENABLED) {
    res.setHeader("Content-Security-Policy", buildCsp(nonce, { secure: isSecureRequest(req) }));
  }
  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}
