"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
} = require("../security");

test("digest is stable and URL-safe", () => {
  assert.equal(digest("logbook"), digest("logbook"));
  assert.notEqual(digest("logbook"), digest("Logbook"));
  assert.match(digest("logbook"), /^[A-Za-z0-9_-]{43}$/);
});

test("randomToken returns the requested amount of URL-safe entropy", () => {
  const token = randomToken(16);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(token, randomToken(16));
});

test("pkceChallenge matches the RFC 7636 S256 example", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("timingSafeEqual handles equal, different, and empty values", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcdef"), false);
  assert.equal(timingSafeEqual("", ""), false);
  assert.equal(timingSafeEqual(null, undefined), false);
});

test("sanitizeReturnTo only permits same-origin paths", () => {
  assert.equal(sanitizeReturnTo("/settings?tab=security#tokens"), "/settings?tab=security#tokens");
  assert.equal(sanitizeReturnTo("  /repos  "), "/repos");
  assert.equal(sanitizeReturnTo("//evil.example"), "/");
  assert.equal(sanitizeReturnTo("/\\evil.example"), "/");
  assert.equal(sanitizeReturnTo("https://evil.example/x"), "/");
  assert.equal(sanitizeReturnTo("javascript:alert(1)"), "/");
  assert.equal(sanitizeReturnTo("/auth/github/callback?code=x"), "/");
  assert.equal(sanitizeReturnTo("/path\nSet-Cookie: x"), "/");
  assert.equal(sanitizeReturnTo("/" + "a".repeat(1024)), "/");
  assert.equal(sanitizeReturnTo(""), "/");
  assert.equal(sanitizeReturnTo(null), "/");
});

test("sanitizeReturnTo strips one-time OAuth parameters", () => {
  assert.equal(
    sanitizeReturnTo("/?code=abc&state=xyz&auth_error=denied&keep=1#top"),
    "/?keep=1#top"
  );
});

test("parseCookies decodes values and ignores malformed pairs", () => {
  assert.deepEqual(parseCookies("a=1; b=hello%20world; broken; =empty; c=%E0%A4%A"), {
    a: "1",
    b: "hello world"
  });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test("clientIp only trusts forwarded headers when explicitly enabled", () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "198.51.100.2" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(clientIp(req, false), "127.0.0.1");
  assert.equal(clientIp(req, true), "203.0.113.9");
  assert.equal(clientIp({ headers: {}, socket: {} }, true), "unknown");
});

test("RateLimiter allows up to the limit and resets after the window", () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
    assert.deepEqual(
      Object.fromEntries(Object.entries(limiter.check("a")).filter(([key]) => ["allowed", "remaining"].includes(key))),
      { allowed: true, remaining: 1 }
    );
    const denied = limiter.check("a", 2);
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.equal(denied.retryAfter, 1);

    now += 1001;
    const reset = limiter.check("a");
    assert.equal(reset.allowed, true);
    assert.equal(reset.remaining, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("RateLimiter prune removes expired buckets", () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
    limiter.check("a");
    assert.equal(limiter.buckets.has("a"), true);
    now += 1001;
    limiter.prune(now);
    assert.equal(limiter.buckets.has("a"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("buildCsp includes the request nonce and only upgrades secure responses", () => {
  const csp = buildCsp("nonce-123");
  assert.match(csp, /script-src 'self' 'nonce-nonce-123'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(buildCsp("nonce-123", { secure: false }), /upgrade-insecure-requests/);
});

test("injectCspNonce annotates only scripts that lack one", () => {
  const html = '<script>one()</script><script nonce="keep">two()</script><SCRIPT>three()</SCRIPT>';
  const output = injectCspNonce(html, "abc123");
  assert.equal(
    output,
    '<script nonce="abc123">one()</script><script nonce="keep">two()</script><SCRIPT nonce="abc123">three()</SCRIPT>'
  );
});

test("isSecureRequest recognizes TLS sockets and trusted proxy headers", () => {
  assert.equal(isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
  assert.equal(isSecureRequest({ socket: {}, headers: { "x-forwarded-proto": "https, http" } }), true);
  assert.equal(isSecureRequest({ socket: {}, headers: { "x-forwarded-proto": "http" } }), false);
  assert.equal(isSecureRequest({ socket: {}, headers: {} }), false);
});
