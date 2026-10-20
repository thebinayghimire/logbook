"use strict";

/**
 * Security primitives shared by the HTTP bridge and the test-suite.
 *
 * Keeping these in a module (rather than inside server.js) makes the
 * security-sensitive behavior directly testable: return-URL validation,
 * CSRF comparison, rate limiting, cookie parsing and CSP generation.
 */

const crypto = require("crypto");

const MAX_RETURN_TO_LENGTH = 1024;

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time comparison that also tolerates missing values. */
function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Only relative, same-origin paths may be used as a post-OAuth destination.
 * This blocks open redirects such as `//evil.example`, `/\evil.example`,
 * absolute URLs, control characters, and the OAuth callback itself.
 */
function sanitizeReturnTo(value) {
  if (typeof value !== "string") return "/";
  const raw = value.trim();
  if (!raw || raw.length > MAX_RETURN_TO_LENGTH) return "/";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  if (raw.includes("\\") || !raw.startsWith("/") || raw.startsWith("//")) return "/";

  let url;
  try {
    url = new URL(raw, "https://logbook.invalid");
  } catch (error) {
    return "/";
  }
  if (url.origin !== "https://logbook.invalid") return "/";
  if (url.pathname.startsWith("/auth/")) return "/";

  // Strip one-time OAuth parameters so a refreshed page cannot replay them.
  for (const key of ["code", "state", "auth_error", "authorized", "error", "error_description"]) {
    url.searchParams.delete(key);
  }
  return url.pathname + (url.search ? url.search : "") + (url.hash && url.hash.length < 256 ? url.hash : "");
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (error) {
      // Ignore malformed cookie encodings instead of failing the request.
    }
  });
  return out;
}

function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

/**
 * Fixed-window limiter. In a multi-instance deployment this would move to
 * Redis; the interface is intentionally small so that swap is mechanical.
 */
class RateLimiter {
  constructor(options = {}) {
    this.windowMs = Math.max(1000, options.windowMs || 60_000);
    this.max = Math.max(1, options.max || 120);
    this.buckets = new Map();
    this.lastPrune = 0;
  }

  check(key, cost = 1) {
    const now = Date.now();
    const id = String(key || "unknown");
    let bucket = this.buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(id, bucket);
    }
    bucket.count += cost;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - bucket.count),
      limit: this.max,
      resetAt: bucket.resetAt,
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  prune(now = Date.now()) {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Nonce-based CSP. Inline style attributes are used by the existing design,
 * so style-src keeps 'unsafe-inline'; scripts do not.
 */
function buildCsp(nonce, options = {}) {
  const secure = options.secure !== false;
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.tailwindcss.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.githubusercontent.com https://github.com",
    "connect-src 'self' https://api.github.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "manifest-src 'self'"
  ];
  if (secure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function injectCspNonce(html, nonce) {
  return String(html).replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

function isSecureRequest(req) {
  return Boolean(req.socket && req.socket.encrypted) ||
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

module.exports = {
  MAX_RETURN_TO_LENGTH,
  digest,
  randomToken,
  timingSafeEqual,
  sanitizeReturnTo,
  parseCookies,
  clientIp,
  RateLimiter,
  buildCsp,
  injectCspNonce,
  isSecureRequest
};
