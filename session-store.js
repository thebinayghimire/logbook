"use strict";

/**
 * Durable session store.
 *
 * Sessions survive a bridge restart and can be listed or revoked by the
 * account owner. The browser only ever receives an opaque session id in an
 * HttpOnly cookie; the database stores a hash of that id and an encrypted
 * copy of the GitHub token. Session ids and CSRF secrets are never logged.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { digest, randomToken } = require("./security");

class SessionStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, "data");
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.dbPath = options.dbPath || path.join(this.dataDir, "logbook.sqlite");
    this.key = options.key;
    if (!this.key || this.key.length !== 32) throw new Error("SessionStore requires a 32-byte key");
    this.ttlMs = Math.max(60_000, options.ttlMs || 12 * 60 * 60 * 1000);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        sid_hash TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        login TEXT NOT NULL,
        mode TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        token_ciphertext BLOB NOT NULL,
        token_iv BLOB NOT NULL,
        token_tag BLOB NOT NULL,
        csrf_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id, last_used_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        login TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_account_idx ON audit_log(account_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS preferences (
        account_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.insert = this.db.prepare(`
      INSERT INTO sessions(
        sid_hash, public_id, account_id, login, mode, scopes,
        token_ciphertext, token_iv, token_tag, csrf_hash,
        created_at, last_used_at, expires_at, user_agent, ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.select = this.db.prepare("SELECT * FROM sessions WHERE sid_hash = ?");
    this.selectPublic = this.db.prepare("SELECT * FROM sessions WHERE public_id = ? AND account_id = ?");
    this.touch = this.db.prepare("UPDATE sessions SET last_used_at = ? WHERE sid_hash = ?");
    this.remove = this.db.prepare("DELETE FROM sessions WHERE sid_hash = ?");
    this.removePublic = this.db.prepare("DELETE FROM sessions WHERE public_id = ? AND account_id = ?");
    this.removeOthers = this.db.prepare("DELETE FROM sessions WHERE account_id = ? AND sid_hash <> ?");
    this.removeAccount = this.db.prepare("DELETE FROM sessions WHERE account_id = ?");
    this.listStmt = this.db.prepare(`
      SELECT public_id, account_id, login, mode, scopes, created_at, last_used_at, expires_at, user_agent, ip
        FROM sessions WHERE account_id = ? ORDER BY last_used_at DESC
    `);
    this.pruneStmt = this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
    this.auditStmt = this.db.prepare(`
      INSERT INTO audit_log(account_id, login, action, detail, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.auditListStmt = this.db.prepare(`
      SELECT action, detail, created_at FROM audit_log
       WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    this.pruneAuditStmt = this.db.prepare("DELETE FROM audit_log WHERE created_at < ?");
    this.getPrefsStmt = this.db.prepare("SELECT payload, updated_at FROM preferences WHERE account_id = ?");
    this.putPrefsStmt = this.db.prepare(`
      INSERT INTO preferences(account_id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `);
    this.deletePrefsStmt = this.db.prepare("DELETE FROM preferences WHERE account_id = ?");
    this.deleteAuditStmt = this.db.prepare("DELETE FROM audit_log WHERE account_id = ?");
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?");
    this.prune();
  }

  /**
   * CSRF tokens are derived from the (server-only) session id with a
   * keyed HMAC, so they are not stored in the browser or database and can be
   * reissued to the same session without rotating the session itself.
   */
  csrfFor(sid) {
    return crypto.createHmac("sha256", this.key)
      .update("logbook-csrf:" + String(sid))
      .digest("base64url");
  }

  verifyCsrf(session, token) {
    if (!session || !token) return false;
    const expected = this.csrfFor(session.sid);
    const left = Buffer.from(String(token));
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  create(input) {
    const now = Date.now();
    const sid = randomToken(32);
    const csrfToken = this.csrfFor(sid);
    const publicId = randomToken(12);
    const accountId = String(input.profile.id);
    const expiresAt = now + this.ttlMs;
    const encrypted = encryptToken(this.key, input.token, publicId);
    this.insert.run(
      digest(sid), publicId, accountId, String(input.profile.login || input.login || "").toLowerCase(),
      input.mode || "oauth", input.scopes || "",
      encrypted.ciphertext, encrypted.iv, encrypted.tag, digest(csrfToken),
      now, now, expiresAt,
      String(input.userAgent || "").slice(0, 300), String(input.ip || "").slice(0, 100)
    );
    return { id: sid, csrfToken, publicId, accountId, expiresAt };
  }

  get(sid) {
    if (!sid) return null;
    const sidHash = digest(sid);
    const row = this.select.get(sidHash);
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at <= now) {
      this.remove.run(sidHash);
      return null;
    }
    let token;
    try {
      token = decryptToken(this.key, row, row.public_id);
    } catch (error) {
      console.error("[logbook] could not decrypt a session token; revoking that session");
      this.remove.run(sidHash);
      return null;
    }
    // Avoid a write on every request; 30 seconds is accurate enough for the
    // session-management screen and keeps SQLite contention low.
    if (now - row.last_used_at > 30_000) this.touch.run(now, sidHash);
    return {
      sid,
      publicId: row.public_id,
      token,
      mode: row.mode,
      login: row.login,
      profile: { id: Number(row.account_id), login: row.login },
      scopes: row.scopes,
      createdAt: row.created_at,
      lastUsed: Math.max(row.last_used_at, now),
      expiresAt: row.expires_at
    };
  }

  list(accountId, currentSid) {
    const currentHash = currentSid ? digest(currentSid) : "";
    const currentRow = currentHash ? this.select.get(currentHash) : null;
    return this.listStmt.all(String(accountId)).map((row) => ({
      id: row.public_id,
      current: Boolean(currentRow) && currentRow.public_id === row.public_id,
      mode: row.mode,
      scopes: row.scopes,
      createdAt: row.created_at,
      lastUsed: row.last_used_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent || "",
      ip: row.ip || ""
    }));
  }

  revoke(sid) {
    if (!sid) return false;
    const result = this.remove.run(digest(sid));
    return Number(result.changes) > 0;
  }

  revokePublic(accountId, publicId) {
    const result = this.removePublic.run(String(publicId), String(accountId));
    return Number(result.changes) > 0;
  }

  revokeOthers(accountId, currentSid) {
    if (!currentSid) return 0;
    const result = this.removeOthers.run(String(accountId), digest(currentSid));
    return Number(result.changes);
  }

  revokeAll(accountId) {
    const result = this.removeAccount.run(String(accountId));
    return Number(result.changes);
  }

  deleteAccount(accountId) {
    const id = String(accountId);
    const sessions = Number(this.removeAccount.run(id).changes);
    this.deletePrefsStmt.run(id);
    this.deleteAuditStmt.run(id);
    return { sessions };
  }

  getPreferences(accountId) {
    const row = this.getPrefsStmt.get(String(accountId));
    if (!row) return null;
    try {
      return { values: JSON.parse(row.payload), updatedAt: row.updated_at };
    } catch (error) {
      return null;
    }
  }

  putPreferences(accountId, values) {
    const payload = JSON.stringify(values);
    if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("preferences_too_large");
    this.putPrefsStmt.run(String(accountId), payload, Date.now());
    return { updatedAt: Date.now() };
  }

  audit(action, input = {}) {
    const detail = input.detail ? String(input.detail).slice(0, 500) : null;
    this.auditStmt.run(
      input.accountId != null ? String(input.accountId) : null,
      input.login ? String(input.login).slice(0, 100) : null,
      String(action).slice(0, 80), detail,
      String(input.ip || "").slice(0, 100), String(input.userAgent || "").slice(0, 300),
      Date.now()
    );
  }

  recentAudit(accountId, limit = 20) {
    return this.auditListStmt.all(String(accountId), Math.min(100, Math.max(1, limit)));
  }

  prune(now = Date.now()) {
    const expired = this.pruneStmt.run(now);
    this.pruneAuditStmt.run(now - 90 * 24 * 60 * 60 * 1000);
    return Number(expired.changes);
  }

  stats() {
    return { activeSessions: Number(this.countStmt.get(Date.now()).n) };
  }

  health() {
    try {
      this.db.prepare("SELECT 1 AS ok").get();
      return true;
    } catch (error) {
      return false;
    }
  }

  close() {
    try { this.db.close(); } catch (error) { /* already closed */ }
  }
}

function encryptToken(key, token, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const ciphertext = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptToken(key, row, aad) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, row.token_iv);
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(row.token_tag);
  return Buffer.concat([decipher.update(row.token_ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { SessionStore };
