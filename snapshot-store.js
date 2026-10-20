"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

class SnapshotStore {
  constructor(options) {
    this.dataDir = options.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.key = loadKey(this.dataDir, options.encryptionKey);
    this.db = new DatabaseSync(path.join(this.dataDir, "logbook.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS snapshots (
        account_id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        section_hashes TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_login_idx ON snapshots(login);
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress INTEGER NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_jobs_account_idx ON sync_jobs(account_id, updated_at DESC);
    `);
    this.upsertSnapshot = this.db.prepare(`
      INSERT INTO snapshots(account_id, login, ciphertext, iv, auth_tag, content_hash, section_hashes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        login=excluded.login, ciphertext=excluded.ciphertext, iv=excluded.iv,
        auth_tag=excluded.auth_tag, content_hash=excluded.content_hash,
        section_hashes=excluded.section_hashes, updated_at=excluded.updated_at
    `);
    this.selectSnapshot = this.db.prepare("SELECT * FROM snapshots WHERE account_id = ?");
    this.upsertJob = this.db.prepare(`
      INSERT INTO sync_jobs(id, account_id, state, phase, progress, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, phase=excluded.phase,
        progress=excluded.progress, error=excluded.error, updated_at=excluded.updated_at
    `);
    this.selectLatestJob = this.db.prepare("SELECT * FROM sync_jobs WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1");
  }

  get(accountId) {
    const row = this.selectSnapshot.get(String(accountId));
    if (!row) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAAD(Buffer.from(String(accountId)));
    decipher.setAuthTag(row.auth_tag);
    const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    return {
      payload: JSON.parse(plaintext.toString("utf8")),
      contentHash: row.content_hash,
      sectionHashes: JSON.parse(row.section_hashes),
      updatedAt: row.updated_at
    };
  }

  put(accountId, login, payload) {
    const id = String(accountId);
    const normalized = JSON.stringify(payload);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const contentHash = digest(normalized);
    const sectionHashes = hashSections(payload);
    const updatedAt = Date.now();
    this.upsertSnapshot.run(id, String(login || "").toLowerCase(), ciphertext, iv, authTag,
      contentHash, JSON.stringify(sectionHashes), updatedAt);
    return { contentHash, sectionHashes, updatedAt };
  }

  saveJob(job) {
    this.upsertJob.run(job.id, String(job.accountId), job.state, job.phase, job.progress,
      job.error || null, job.createdAt, job.updatedAt);
  }

  latestJob(accountId) {
    const row = this.selectLatestJob.get(String(accountId));
    if (!row) return null;
    return {
      id: row.id, state: row.state, phase: row.phase, progress: row.progress,
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function hashSections(payload) {
  return {
    profile: digest(JSON.stringify([payload.profile, payload.privateRepos, payload.publicRepos])),
    repositories: digest(JSON.stringify([payload.repos, payload.deepRepos, payload.repoCommits])),
    commits: digest(JSON.stringify([payload.commits, payload.prs, payload.issues, payload.reviews])),
    languages: digest(JSON.stringify([payload.langTotals, payload.langRepos])),
    account: digest(JSON.stringify(payload.account))
  };
}

function loadKey(dataDir, configured) {
  if (configured) {
    const raw = String(configured).trim();
    const key = /^[a-f\d]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("SNAPSHOT_ENCRYPTION_KEY must decode to exactly 32 bytes");
    return key;
  }
  const keyPath = path.join(dataDir, ".snapshot-key");
  try {
    const existing = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
    if (existing.length === 32) return existing;
  } catch (_) {}
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated.toString("base64"), { mode: 0o600, flag: "wx" });
  console.warn("[logbook] SNAPSHOT_ENCRYPTION_KEY is unset; generated a development key in data/.snapshot-key");
  return generated;
}

module.exports = { SnapshotStore, hashSections };
