"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { SessionStore } = require("../session-store");
const { digest } = require("../security");

function makeStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-sessions-"));
  const store = new SessionStore({ dataDir, key: crypto.randomBytes(32) });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}

function profile(id, login) {
  return { id, login };
}

function createSession(store, options = {}) {
  return store.create({
    token: options.token || "gho_test_token_value",
    mode: options.mode || "oauth",
    profile: options.profile || profile(1, "alice"),
    login: (options.profile || profile(1, "alice")).login,
    scopes: options.scopes || "repo read:user",
    userAgent: options.userAgent || "Test Browser",
    ip: options.ip || "127.0.0.1"
  });
}

test("sessions round-trip the encrypted token and derived CSRF secret", (t) => {
  const store = makeStore(t);
  const created = createSession(store);
  const session = store.get(created.id);

  assert.ok(session);
  assert.equal(session.token, "gho_test_token_value");
  assert.equal(session.publicId, created.publicId);
  assert.equal(session.login, "alice");
  assert.equal(session.profile.id, 1);
  assert.equal(session.mode, "oauth");
  assert.equal(session.scopes, "repo read:user");
  assert.equal(store.verifyCsrf(session, created.csrfToken), true);
  assert.equal(store.verifyCsrf(session, "wrong-token"), false);
  assert.equal(store.verifyCsrf(session, ""), false);
  assert.equal(store.verifyCsrf(null, created.csrfToken), false);
});

test("the database never stores the raw session id or GitHub token", (t) => {
  const store = makeStore(t);
  const created = createSession(store, { token: "ghp_plaintext_must_not_appear" });
  const row = store.db.prepare("SELECT * FROM sessions").get();

  const ciphertext = Buffer.from(row.token_ciphertext);
  assert.equal(row.sid_hash, digest(created.id));
  assert.notEqual(row.sid_hash, created.id);
  assert.equal(ciphertext.includes(Buffer.from("ghp_plaintext_must_not_appear")), false);
  assert.equal(ciphertext.toString("utf8").includes("ghp_plaintext_must_not_appear"), false);
  assert.equal(row.csrf_hash, digest(created.csrfToken));
  assert.notEqual(row.csrf_hash, created.csrfToken);
});

test("list returns public ids and marks only the current session", (t) => {
  const store = makeStore(t);
  const first = createSession(store, { userAgent: "Device One" });
  const second = createSession(store, { userAgent: "Device Two" });

  const list = store.list(1, second.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((entry) => entry.id).sort(), [first.publicId, second.publicId].sort());
  assert.equal(list.find((entry) => entry.id === second.publicId).current, true);
  assert.equal(list.find((entry) => entry.id === first.publicId).current, false);
  assert.equal(list.some((entry) => entry.id === second.id), false);
});

test("revocation scopes sessions to their owning account", (t) => {
  const store = makeStore(t);
  const alice = createSession(store, { profile: profile(1, "alice") });
  const aliceOther = createSession(store, { profile: profile(1, "alice") });
  const mallory = createSession(store, { profile: profile(2, "mallory") });

  assert.equal(store.revokePublic(2, alice.publicId), false);
  assert.ok(store.get(alice.id));
  assert.equal(store.revokeOthers(1, alice.id), 1);
  assert.equal(store.get(aliceOther.id), null);
  assert.ok(store.get(alice.id));
  assert.ok(store.get(mallory.id));

  assert.equal(store.revokePublic(1, alice.publicId), true);
  assert.equal(store.get(alice.id), null);

  assert.equal(store.revokeAll(1), 0);
  assert.equal(store.revokeAll(2), 1);
  assert.equal(store.get(mallory.id), null);
});

test("expired sessions are removed when read", (t) => {
  const store = makeStore(t);
  const created = createSession(store);
  store.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid_hash = ?")
    .run(Date.now() - 1000, digest(created.id));

  assert.equal(store.get(created.id), null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(store.revoke(created.id), false);
});

test("preferences round-trip strings and bounded UI structures", (t) => {
  const store = makeStore(t);
  const values = {
    theme: "dark",
    density: "compact",
    range: "30D",
    activeView: "QA view",
    savedViews: [{ name: "QA view", filters: { lang: "TypeScript" } }]
  };
  store.putPreferences(1, values);
  const stored = store.getPreferences(1);
  assert.deepEqual(stored.values, values);
  assert.ok(stored.updatedAt > 0);

  store.putPreferences(1, { theme: "light" });
  assert.deepEqual(store.getPreferences(1).values, { theme: "light" });
});

test("deleteAccount removes sessions, preferences, and audit rows only for that account", (t) => {
  const store = makeStore(t);
  const alice = createSession(store, { profile: profile(1, "alice") });
  const mallory = createSession(store, { profile: profile(2, "mallory") });
  store.putPreferences(1, { theme: "dark" });
  store.putPreferences(2, { theme: "light" });
  store.audit("session.create", { accountId: 1, login: "alice", ip: "127.0.0.1" });
  store.audit("session.create", { accountId: 2, login: "mallory", ip: "127.0.0.1" });

  const deleted = store.deleteAccount(1);
  assert.deepEqual(deleted, { sessions: 1 });
  assert.equal(store.get(alice.id), null);
  assert.ok(store.get(mallory.id));
  assert.equal(store.getPreferences(1), null);
  assert.deepEqual(store.getPreferences(2).values, { theme: "light" });
  assert.equal(store.recentAudit(1).length, 0);
  assert.equal(store.recentAudit(2).length, 1);
});

test("audit and stats report bounded, ordered activity", (t) => {
  const store = makeStore(t);
  createSession(store);
  store.audit("one", { accountId: 1, login: "alice" });
  store.audit("two", { accountId: 1, login: "alice" });

  assert.deepEqual(store.recentAudit(1, 2).map((row) => row.action), ["two", "one"]);
  assert.equal(store.recentAudit(1, 1).length, 1);
  assert.equal(store.stats().activeSessions, 1);
  assert.equal(store.health(), true);
});
