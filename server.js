#!/usr/bin/env node
"use strict";

/* ═══════════════════════════════════════════════════════════════
     DISCORD VR STATUS — FOREVER EDITION (LUX)
   ─────────────────────────────────────────────────────────────
   v5.0.0 — Persistent 24/7 badge engine • hardened security
   Author   : 7amo Brazil
   License  : MIT — © 2026 7amo Brazil. All rights reserved.
   Requires : Node.js 18+ — zero dependencies

   Security model:
     • Each account gets a personal claim key (shown ONCE) — only its
       holder (or the admin) can pause/remove that account.
     • Claim keys are stored hashed (SHA-256), never in plain text.
     • Admin: scrypt-hashed password (min 10 chars), httpOnly
       SameSite=Strict cookies, CSRF double-submit, per-IP lockout.
     • Per-IP rate limiting on connect/claim/login, honeypot on connect.
     • Security headers on every response (CSP, HSTS, DENY frames...).
     • Append-only audit log (last 2000 events), visible in /admin.
     • Tokens never leave the server in plain text — masked everywhere.
   ═══════════════════════════════════════════════════════════════ */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APP = {
  name: "Discord VR Status — Forever Edition",
  codename: "LUX",
  version: "5.0.0",
  author: "7amo Brazil",
};

/* ── Configuration ───────────────────────────────────────── */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "sessions.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 60_000;
const FAST_RETRY_MS = 15_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const COOLDOWN_MS = 10 * 60_000;      // engine rest after 5 straight failures
const MIN_ADMIN_PASSWORD = 10;

const META_APP_ID = "1417273808645259344"; // Meta's official app (whitelisted for activities.write)
const META_REDIRECT_URL = "https://oculus.com/oauth_account_linking/login_redirect";
const TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const API_BASE = "https://discord.com/api/v10/users/@me";
const PUBLIC_DIR = path.join(__dirname, "public");

/* ── Storage (atomic writes, 0600) ───────────────────────── */

let db = { version: 2, users: {} };
const timers = new Map(); // id -> timeout handle
const bootAt = Date.now();

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("[store] save failed:", e.message);
  }
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}
function saveDbNow() {
  clearTimeout(saveTimer);
  persist();
}

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!raw || typeof raw.users !== "object") throw new Error("bad shape");
    db = { version: 2, users: {} };
    for (const [id, u] of Object.entries(raw.users)) {
      if (!u || typeof u !== "object" || !u.id || !u.access_token) continue; // drop corrupt entries
      db.users[id] = {
        id: u.id,
        label: String(u.label || "account").slice(0, 40),
        created_at: Number(u.created_at) || Date.now(),
        key_hash: typeof u.key_hash === "string" ? u.key_hash : null,
        access_token: u.access_token,
        refresh_token: u.refresh_token || null,
        expires: Number(u.expires) || 0,
        session_token: u.session_token || null,
        enabled: u.enabled !== false,
        cooldown_until: Number(u.cooldown_until) || 0,
        stats: {
          beats: Number(u?.stats?.beats) || 0,
          last_beat: Number(u?.stats?.last_beat) || null,
          failures: Number(u?.stats?.failures) || 0,
          last_error: u?.stats?.last_error || null,
        },
      };
    }
  } catch {
    db = { version: 2, users: {} };
  }
}

const mask = (t) => {
  const s = String(t || "");
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
};

/* ── Audit log (append-only JSONL, trimmed to 2000) ──────── */

function audit(action, ip, actor, target, ok, detail) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(), ip: ip || "?", actor: actor || "?",
      action, target: target || null, ok: !!ok, detail: detail || null,
    });
    fs.appendFileSync(AUDIT_FILE, line + "\n", { mode: 0o600 });
    const lines = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length > 2000) {
      fs.writeFileSync(AUDIT_FILE, lines.slice(-2000).join("\n") + "\n", { mode: 0o600 });
    }
  } catch {
    /* auditing must never crash the engine */
  }
}

function readAudit(limit = 50) {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/* ── Admin auth (scrypt + cookie + CSRF + lockout) ───────── */

function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < MIN_ADMIN_PASSWORD) {
      console.error(`[security] ADMIN_PASSWORD is too short (<${MIN_ADMIN_PASSWORD} chars). Set a strong one and restart.`);
      process.exit(1);
    }
    return process.env.ADMIN_PASSWORD;
  }
  const gen = crypto.randomBytes(15).toString("base64url"); // 20 chars
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "admin.key"), `ADMIN_PASSWORD=${gen}\n`, { mode: 0o600 });
    console.log(`[admin] ADMIN_PASSWORD not set — generated: ${gen}`);
    console.log(`[admin] Saved to ${path.join(DATA_DIR, "admin.key")} — or set the env var (min ${MIN_ADMIN_PASSWORD} chars).`);
  } catch {
    console.log(`[admin] ADMIN_PASSWORD not set — using ephemeral: ${gen}`);
  }
  return gen;
}

const SALT = "7amo-brazil-lux-v5";
const scryptHash = (pw) => crypto.scryptSync(String(pw), SALT, 32);
const ADMIN_EXPECTED = scryptHash(resolveAdminPassword());
const scryptSafe = (pw) => {
  const a = scryptHash(pw);
  return a.length === ADMIN_EXPECTED.length && crypto.timingSafeEqual(a, ADMIN_EXPECTED);
};

const adminSessions = new Map(); // cookie -> { csrf, exp }
const claimSessions = new Map(); // cookie -> { id, exp }

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  const c = parseCookies(req).vr_admin;
  if (!c) return false;
  const s = adminSessions.get(c);
  if (!s || s.exp < Date.now()) { adminSessions.delete(c); return false; }
  return s;
}

function adminCsrfValid(req, session) {
  return !!session && req.headers["x-csrf-token"] === session.csrf;
}

/* Login lockout: 5 failures / 15 min → 15 min lock */
const loginLocks = new Map(); // ip -> { fails, windowStart, lockedUntil }
function loginLockCheck(ip) {
  const rec = loginLocks.get(ip);
  if (!rec) return true;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return false;
  if (!rec.lockedUntil && Date.now() - rec.windowStart > 15 * 60_000) {
    loginLocks.delete(ip);
    return true;
  }
  return true;
}
function loginLockFail(ip) {
  let rec = loginLocks.get(ip);
  if (!rec || Date.now() - rec.windowStart > 15 * 60_000) rec = { fails: 0, windowStart: Date.now(), lockedUntil: 0 };
  rec.fails++;
  if (rec.fails >= 5) rec.lockedUntil = Date.now() + 15 * 60_000;
  loginLocks.set(ip, rec);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of loginLocks) if (r.lockedUntil && r.lockedUntil < now) loginLocks.delete(k);
}, 10 * 60_000).unref();

/* ── Generic rate limiter (per IP) ───────────────────────── */

const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > 10 * 60_000) hits.delete(k);
}, 10 * 60_000).unref();

/* ── Claim keys (per-account personal security) ──────────── */

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — unambiguous
function generateClaimKey() {
  const b = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += KEY_ALPHABET[b[i] % KEY_ALPHABET.length];
  return `7AMO-${s.slice(0, 8)}-${s.slice(8)}`;
}
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

function findByClaimKey(key) {
  if (typeof key !== "string") return null;
  const h = sha256hex(key.trim().toUpperCase());
  for (const u of Object.values(db.users)) if (u.key_hash === h) return u;
  return null;
}

function publicAccountInfo(u) {
  return {
    id: u.id,
    label: u.label,
    created_at: u.created_at,
    enabled: u.enabled,
    session: mask(u.session_token),
    hasRefresh: !!u.refresh_token,
    tokenTtlMs: Math.max(0, u.expires - Date.now()),
    beats: u.stats.beats,
    last_beat: u.stats.last_beat,
    failures: u.stats.failures,
    last_error: u.stats.last_error,
    cooldown_until: u.cooldown_until || 0,
  };
}

/* ── Discord API helpers ─────────────────────────────────── */

async function discordToken(params) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function activityPayload() {
  return {
    activities: [
      {
        application_id: META_APP_ID,
        name: "~~",             // strikethrough → empty activity name
        type: 6,                // "HANG" — keeps custom status intact
        platform: "meta_quest", // <- makes Discord show the VR badge
      },
    ],
  };
}

async function discordSession(method, accessToken, p, body) {
  const r = await fetch(`${API_BASE}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" && body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/* ── The engine: adaptive 24/7 keep-alive per user ───────── */

function nextInterval(u) {
  if (u.cooldown_until && u.cooldown_until > Date.now()) return u.cooldown_until - Date.now();
  return (u.stats && (u.stats.failures || 0) === 0) ? KEEPALIVE_MS : Math.min(KEEPALIVE_MS, FAST_RETRY_MS);
}

function schedule(id, ms) {
  const u = db.users[id];
  if (!u || !u.enabled) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => beat(id), ms));
}

async function ensureFresh(u) {
  if (u.expires - Date.now() >= EXPIRY_MARGIN_MS) return;
  if (!u.refresh_token) {
    if (u.expires >= Date.now()) return; // still valid
    u.enabled = false;
    u.stats.last_error = "Token expired and no refresh token — re-authentication required.";
    const e = new Error(u.stats.last_error);
    e.fatal = true;
    throw e;
  }
  const t = await discordToken({
    grant_type: "refresh_token",
    refresh_token: u.refresh_token,
    client_id: META_APP_ID,
  });
  if (t.status !== 200) {
    if (/invalid_grant/i.test(JSON.stringify(t.data))) {
      u.enabled = false;
      u.stats.last_error = "Refresh token rejected (invalid_grant) — re-authentication required.";
      const e = new Error(u.stats.last_error);
      e.fatal = true;
      saveDbNow();
      throw e;
    }
    throw new Error(`Token refresh failed (HTTP ${t.status})`);
  }
  u.access_token = t.data.access_token;
  u.refresh_token = t.data.refresh_token || u.refresh_token;
  u.expires = Date.now() + (t.data.expires_in ?? 3600) * 1000;
  console.log(`[engine] ${u.id} (${u.label}) — token refreshed`);
}

async function doUpdate(u) {
  return discordSession(
    "POST",
    u.access_token,
    "/headless-sessions",
    { ...activityPayload(), ...(u.session_token ? { token: u.session_token } : {}) }
  );
}

async function beat(id) {
  const u = db.users[id];
  if (!u || !u.enabled) return;
  let fatal = false;
  try {
    await ensureFresh(u);
    let r = await doUpdate(u);
    if (r.status === 401 && u.refresh_token) {
      u.expires = 0; // force refresh
      await ensureFresh(u);
      r = await doUpdate(u);
    }
    if (r.status === 200) {
      if (r.data.token) u.session_token = r.data.token;
      u.stats.failures = 0;
      u.stats.last_beat = Date.now();
      u.stats.beats = (u.stats.beats || 0) + 1;
      u.stats.last_error = null;
      u.cooldown_until = 0; // healed
    } else {
      u.stats.failures = (u.stats.failures || 0) + 1;
      u.stats.last_error = `Update failed (HTTP ${r.status}): ${r.data.message || JSON.stringify(r.data)}`;
      if (u.stats.failures >= 5 && !u.cooldown_until) {
        u.cooldown_until = Date.now() + COOLDOWN_MS;
        u.stats.last_error += " — cooling down 10m to protect the account.";
      }
      console.warn(`[engine] ${u.id} (${u.label}) — ${u.stats.last_error}`);
    }
  } catch (e) {
    fatal = e.fatal === true;
    u.stats.failures = (u.stats.failures || 0) + 1;
    u.stats.last_error = fatal ? e.message : `Beat error: ${e.message}`;
    console.warn(`[engine] ${u.id} (${u.label}) — ${u.stats.last_error}`);
  }
  if (fatal) saveDbNow();
  else saveDb();
  if (u.enabled) schedule(id, nextInterval(u));
}

const activeCount = () => Object.values(db.users).filter((u) => u.enabled).length;

/* ── HTTP helpers & security headers ─────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function securityHeaders(req, res) {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Server", "7amo-brazil-lux");
  if (req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function json(res, status, obj, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers));
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  if (p === "/admin") p = "/admin.html";
  if (p === "/me") p = "/manage.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, "index.html")) {
    return json(res, 403, { error: "Forbidden" });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

/* ── Public API: connect ─────────────────────────────────── */

async function apiConnect(req, res, ip) {
  if (!rateLimit("connect:" + ip, 6, 10 * 60_000)) {
    return json(res, 429, { error: "Too many attempts — please wait a few minutes." });
  }
  const body = await readBody(req);
  if (body.website) {
    // Honeypot: bots fill hidden fields — silently pretend success, create nothing.
    return json(res, 200, { ok: true, id: "00000", label: "", key: "7AMO-00000000-0000", bot: true });
  }
  if (!body.code || !body.code_verifier) return json(res, 400, { error: "Missing code or code_verifier" });

  const t = await discordToken({
    grant_type: "authorization_code",
    code: body.code,
    code_verifier: body.code_verifier,
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URL,
  });
  if (t.status !== 200) {
    if (t.status === 400 && /invalid_grant/i.test(JSON.stringify(t.data))) {
      return json(res, 410, { error: "Authorization code expired — open the link again, click Authorize, and try again." });
    }
    return json(res, 400, { error: t.data.error_description || t.data.message || "Token exchange failed" });
  }

  const s = await discordSession("POST", t.data.access_token, "/headless-sessions", activityPayload());
  if (s.status !== 200) {
    return json(res, 502, { error: `Discord session creation failed (HTTP ${s.status})` });
  }

  const id = crypto.randomBytes(5).toString("base64url");
  const key = generateClaimKey();
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.users[id] = {
    id,
    label: String(body.label || "").trim().slice(0, 40) || `account-${when}`,
    created_at: Date.now(),
    key_hash: sha256hex(key),
    access_token: t.data.access_token,
    refresh_token: t.data.refresh_token || null,
    expires: Date.now() + (t.data.expires_in ?? 3600) * 1000,
    session_token: s.data.token || null,
    enabled: true,
    cooldown_until: 0,
    stats: { beats: 1, last_beat: Date.now(), failures: 0, last_error: null },
  };
  saveDbNow();
  schedule(id, KEEPALIVE_MS);
  audit("connect", ip, "visitor", id, true, db.users[id].label);
  console.log(`[connect] new session ${id} (${db.users[id].label})`);
  json(res, 200, { ok: true, id, label: db.users[id].label, key, session: mask(s.data.token) });
}

/* ── Claim API (the account's own owner, by key) ─────────── */

async function apiClaim(req, res, pathname, method, ip) {
  if (method !== "POST" && method !== "GET") return json(res, 405, { error: "Method not allowed" });

  if (pathname === "/api/claim/verify") {
    if (!rateLimit("claim:" + ip, 10, 10 * 60_000)) return json(res, 429, { error: "Too many attempts" });
    const { key } = await readBody(req);
    const u = findByClaimKey(key);
    if (!u) {
      audit("claim-verify", ip, "claimant", null, false, "bad key");
      return json(res, 401, { error: "Invalid key" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    claimSessions.set(token, { id: u.id, exp: Date.now() + 12 * 3600_000 });
    res.setHeader("Set-Cookie", `vr_claim=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    audit("claim-verify", ip, "claimant", u.id, true, u.label);
    return json(res, 200, { ok: true, account: publicAccountInfo(u) });
  }

  // Everything below requires a valid claim cookie
  const c = parseCookies(req).vr_claim;
  const s = c && claimSessions.get(c);
  const u = s && db.users[s.id];
  if (!s || s.exp < Date.now() || !u) {
    if (s) claimSessions.delete(c);
    return json(res, 401, { error: "Please verify your key first" });
  }

  if (pathname === "/api/claim/status" && method === "GET") {
    return json(res, 200, { ok: true, account: publicAccountInfo(u) });
  }

  if (pathname === "/api/claim/toggle" && method === "POST") {
    if (!rateLimit("claimact:" + ip, 20, 10 * 60_000)) return json(res, 429, { error: "Slow down" });
    const { enabled } = await readBody(req);
    u.enabled = !!enabled;
    if (u.enabled) {
      u.stats.last_error = null;
      u.stats.failures = 0;
      u.cooldown_until = 0;
      schedule(u.id, 1000);
    } else {
      clearTimeout(timers.get(u.id));
      timers.delete(u.id);
      u.stats.last_error = "Paused by owner.";
    }
    saveDbNow();
    audit("claim-toggle", ip, "owner", u.id, true, u.enabled ? "resume" : "pause");
    return json(res, 200, { ok: true, account: publicAccountInfo(u) });
  }

  if (pathname === "/api/claim/delete" && method === "POST") {
    if (!rateLimit("claimdel:" + ip, 5, 10 * 60_000)) return json(res, 429, { error: "Slow down" });
    const { key } = await readBody(req); // double protection: cookie + correct key
    if (!findByClaimKey(key)) {
      audit("claim-delete", ip, "owner", u.id, false, "key mismatch");
      return json(res, 403, { error: "Key verification failed — enter your key exactly." });
    }
    clearTimeout(timers.get(u.id));
    timers.delete(u.id);
    try {
      if (u.session_token) await discordSession("POST", u.access_token, "/headless-sessions/delete", { token: u.session_token });
    } catch { /* best effort */ }
    delete db.users[u.id];
    saveDbNow();
    audit("claim-delete", ip, "owner", u.id, true, u.label);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/claim/logout" && method === "POST") {
    claimSessions.delete(c);
    res.setHeader("Set-Cookie", "vr_claim=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "Not found" });
}

/* ── Admin API ───────────────────────────────────────────── */

async function apiAdmin(req, res, pathname, method, ip) {
  if (pathname === "/api/admin/login" && method === "POST") {
    if (!loginLockCheck(ip)) {
      audit("admin-login", ip, "attacker?", null, false, "locked out");
      return json(res, 423, { error: "Too many failed attempts — locked for 15 minutes." });
    }
    const { password } = await readBody(req);
    if (!password || !scryptSafe(password, ADMIN_EXPECTED)) {
      loginLockFail(ip);
      audit("admin-login", ip, "?", null, false, "bad password");
      return json(res, 401, { error: "Invalid password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const csrf = crypto.randomBytes(24).toString("hex");
    adminSessions.set(token, { csrf, exp: Date.now() + 24 * 3600_000 });
    res.setHeader("Set-Cookie", `vr_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    loginLocks.delete(ip);
    audit("admin-login", ip, "admin", null, true);
    return json(res, 200, { ok: true }, { "X-CSRF-Token": csrf });
  }

  const session = isAdmin(req);

if (!session) {
  return json(res, 401, {
    error: "Admin authentication required",
  });
}

const safeMethod =
  method === "GET" ||
  method === "HEAD" ||
  method === "OPTIONS";

if (!safeMethod && !adminCsrfValid(req, session)) {
  audit(
    "admin-csrf",
    ip,
    "admin",
    pathname,
    false,
    "csrf mismatch"
  );

  return json(res, 403, {
    error: "CSRF token invalid — refresh the panel.",
  });
}

  if (pathname === "/api/admin/logout" && method === "POST") {
    const c = parseCookies(req).vr_admin;
    adminSessions.delete(c);
    res.setHeader("Set-Cookie", "vr_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    audit("admin-logout", ip, "admin", null, true);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/admin/sessions" && method === "GET") {
    return json(res, 200, {
      server: { name: APP.name, codename: APP.codename, version: APP.version, author: APP.author, uptime: Math.floor((Date.now() - bootAt) / 1000) },
      security: {
        "csrf": true, "hsts": "via proxy", "rate-limit": true,
        "lockout": true, "audit-log": true, "claim-keys": true,
      },
      sessions: Object.values(db.users).map(publicAccountInfo).sort((a, b) => b.created_at - a.created_at),
    });
  }

  if (pathname === "/api/admin/audit" && method === "GET") {
    return json(res, 200, { events: readAudit(50) });
  }

  if (pathname === "/api/admin/toggle" && method === "POST") {
    const { id, enabled } = await readBody(req);
    const u = db.users[id];
    if (!u) return json(res, 404, { error: "Session not found" });
    u.enabled = !!enabled;
    if (u.enabled) {
      u.stats.last_error = null;
      u.stats.failures = 0;
      u.cooldown_until = 0;
      schedule(u.id, 1000);
    } else {
      clearTimeout(timers.get(u.id));
      timers.delete(u.id);
      u.stats.last_error = "Paused by admin.";
    }
    saveDbNow();
    audit("admin-toggle", ip, "admin", u.id, true, u.enabled ? "resume" : "pause");
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/admin/delete" && method === "POST") {
    const { id } = await readBody(req);
    const u = db.users[id];
    if (!u) return json(res, 404, { error: "Session not found" });
    clearTimeout(timers.get(u.id));
    timers.delete(u.id);
    try {
      if (u.session_token) await discordSession("POST", u.access_token, "/headless-sessions/delete", { token: u.session_token });
    } catch { /* best effort */ }
    delete db.users[u.id];
    saveDbNow();
    audit("admin-delete", ip, "admin", u.id, true, u.label);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "Not found" });
}

/* ── Router & server ─────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(req, res);
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const ip = req.socket.remoteAddress || "unknown";

    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/connect" && req.method === "POST") {
      return await apiConnect(req, res, ip);
    }
    if (url.pathname.startsWith("/api/claim/")) {
      return await apiClaim(req, res, url.pathname, req.method, ip);
    }
    if (url.pathname.startsWith("/api/admin/")) {
      return await apiAdmin(req, res, url.pathname, req.method, ip);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res, url.pathname);
    }
    return json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[http] error:", e.message);
    try { json(res, 500, { error: "Internal server error" }); } catch { /* gone */ }
  }
});

/* ── Startup & shutdown ──────────────────────────────────── */

function shutdown(code) {
  console.log("\n[lux] Shutting down — saving state...");
  for (const h of timers.values()) clearTimeout(h);
  try { persist(); } catch { /* best effort */ }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (e) => {
  console.error("[lux] uncaught:", e.message);
  shutdown(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[lux] unhandled rejection:", e?.message || e);
});

function main() {
  loadDb();
  const active = Object.values(db.users).filter((u) => u.enabled);

  console.log("─".repeat(62));
  console.log(`  🎮  ${APP.name}  [${APP.codename}]`);
  console.log(`  v${APP.version} • Persistent 24/7 badge engine • hardened`);
  console.log(`  © 2026 ${APP.author} — All rights reserved`);
  console.log("─".repeat(62));
  console.log(`[lux] Data file : ${DATA_FILE}`);
  console.log(`[lux] Resuming  : ${active.length} active session(s) of ${Object.keys(db.users).length} total`);

  active.forEach((u, i) => schedule(u.id, 1500 + i * 750 + Math.floor(Math.random() * 2000)));

  server.listen(PORT, HOST, () => {
    console.log(`[lux] Listening on http://${HOST}:${PORT}`);
    console.log(`[lux] Public site : http://<your-server>:${PORT}/`);
    console.log(`[lux] My account  : http://<your-server>:${PORT}/me`);
    console.log(`[lux] Admin panel : http://<your-server>:${PORT}/admin`);
    console.log(`[lux] Security    : CSP+HSTS+CSRF+lockout+audit+claim-keys ✔`);
  });
}

main();
