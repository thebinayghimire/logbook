"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { SnapshotStore, hashSections } = require("../snapshot-store");

function makeStore(t, dataDir) {
  const ownedDir = dataDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), "logbook-snapshots-"));
  const store = new SnapshotStore({
    dataDir: dataDir || ownedDir,
    encryptionKey: crypto.randomBytes(32).toString("base64")
  });
  t.after(() => {
    store.close();
    if (ownedDir) fs.rmSync(ownedDir, { recursive: true, force: true });
  });
  return store;
}

function payload(marker = "safe") {
  return {
    schemaVersion: 3,
    username: "alice",
    profile: { id: 1, login: "alice", name: marker },
    repos: [{ full_name: "alice/" + marker, name: marker }],
    commits: [{ fullSha: "abc", repo: marker }],
    contributionCalendar: { source: "github-graphql", years: { 2026: { total: 1, days: { "2026-10-20": 1 } } } },
    attribution: { author: "@alice", method: "verified-email" },
    scope: { defaultBranchOnly: true }
  };
}

test("snapshots round-trip encrypted payloads with metadata", (t) => {
  const store = makeStore(t);
  const input = payload("logbook");
  const meta = store.put(1, "Alice", input);

  assert.match(meta.contentHash, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(meta.sectionHashes, hashSections(input));
  assert.ok(meta.updatedAt > 0);
  assert.deepEqual(store.head(1), { contentHash: meta.contentHash, updatedAt: meta.updatedAt });

  const record = store.get(1);
  assert.deepEqual(record.payload, input);
  assert.equal(record.contentHash, meta.contentHash);
  assert.equal(record.updatedAt, meta.updatedAt);
  assert.deepEqual(record.sectionHashes, meta.sectionHashes);
  assert.equal(store.stats().snapshots, 1);
});

test("snapshots are scoped to an account id", (t) => {
  const store = makeStore(t);
  store.put(1, "alice", payload("one"));
  store.put(2, "mallory", payload("two"));

  assert.equal(store.get(1).payload.profile.name, "one");
  assert.equal(store.get(2).payload.profile.name, "two");
  assert.equal(store.get(3), null);
  assert.equal(store.head(3), null);
});

test("snapshot ciphertext does not contain private payload text", (t) => {
  const store = makeStore(t);
  const marker = "private-repository-name-do-not-leak";
  store.put(1, "alice", payload(marker));
  const row = store.db.prepare("SELECT ciphertext FROM snapshots WHERE account_id = ?").get("1");
  const ciphertext = Buffer.from(row.ciphertext);
  assert.equal(ciphertext.toString("utf8").includes(marker), false);
});

test("deleteAccount removes snapshots and jobs only for that account", (t) => {
  const store = makeStore(t);
  store.put(1, "alice", payload("one"));
  store.put(2, "mallory", payload("two"));
  store.saveJob({ id: "a", accountId: 1, state: "current", phase: "complete", progress: 100, createdAt: 1, updatedAt: 2 });
  store.saveJob({ id: "b", accountId: 2, state: "current", phase: "complete", progress: 100, createdAt: 1, updatedAt: 2 });

  assert.deepEqual(store.deleteAccount(1), { snapshots: 1, jobs: 1 });
  assert.equal(store.get(1), null);
  assert.equal(store.latestJob(1), null);
  assert.ok(store.get(2));
  assert.ok(store.latestJob(2));
});

test("latestJob returns the most recently updated job", (t) => {
  const store = makeStore(t);
  store.saveJob({ id: "old", accountId: 1, state: "failed", phase: "failed", progress: 10, error: "old", createdAt: 1, updatedAt: 10 });
  store.saveJob({ id: "new", accountId: 1, state: "current", phase: "complete", progress: 100, createdAt: 2, updatedAt: 20 });

  const job = store.latestJob(1);
  assert.equal(job.id, "new");
  assert.equal(job.state, "current");
  assert.equal(store.latestJob(9), null);
});

test("stale queued and scanning jobs are failed on the next boot", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-snapshots-"));
  const key = crypto.randomBytes(32).toString("base64");
  const first = new SnapshotStore({ dataDir, encryptionKey: key });
  first.saveJob({ id: "interrupted", accountId: 1, state: "scanning", phase: "commits", progress: 40, createdAt: 1, updatedAt: 2 });
  first.close();

  const second = new SnapshotStore({ dataDir, encryptionKey: key });
  t.after(() => {
    second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const job = second.latestJob(1);
  assert.equal(job.state, "failed");
  assert.equal(job.phase, "failed");
  assert.match(job.error, /restarted before the scan completed/);
});

test("hashSections changes when the official contribution calendar changes", () => {
  const left = payload("one");
  const right = payload("one");
  right.contributionCalendar.years[2026].days["2026-10-21"] = 5;

  const leftHashes = hashSections(left);
  const rightHashes = hashSections(right);
  assert.notEqual(leftHashes.commits, rightHashes.commits);
  assert.equal(leftHashes.profile, rightHashes.profile);
  assert.equal(leftHashes.repositories, rightHashes.repositories);
  assert.equal(leftHashes.languages, rightHashes.languages);
});

test("loadKey generates and then reuses a development key", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-snapshots-"));
  const first = new SnapshotStore({ dataDir });
  const keyFile = path.join(dataDir, ".snapshot-key");
  assert.equal(fs.existsSync(keyFile), true);
  const firstKey = Buffer.from(first.key).toString("base64");
  first.close();

  const second = new SnapshotStore({ dataDir });
  t.after(() => {
    second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal(Buffer.from(second.key).toString("base64"), firstKey);
  assert.equal(second.health(), true);
});
