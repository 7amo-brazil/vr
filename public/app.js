/* ═══════════════════════════════════════════════════════════
   VR Status LUX (client) — © 2026 7amo Brazil
   PKCE in the browser + smart paste + /api/connect.
   After that, the SERVER engine keeps the badge alive 24/7.
   ═══════════════════════════════════════════════════════════ */
"use strict";

const META_APP_ID = "1417273808645259344";
const META_REDIRECT_URL = "https://oculus.com/oauth_account_linking/login_redirect";
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

/* ── Crypto / PKCE (Web Crypto) ──────────────────────────── */

const enc = new TextEncoder();

function toBase64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function sha256(input) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

async function buildAuthUrl() {
  const verifier = toBase64url(await randomBytes(48));
  const challenge = toBase64url(await sha256(verifier));
  const state = toBase64url(await randomBytes(16));
  const p = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URL,
    response_type: "code",
    scope: "identify activities.read activities.write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE_URL}?${p.toString()}`, verifier, state };
}

/* ── Smart paste ─────────────────────────────────────────── */

function extractUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[),.;]+$/, "") : null;
}

/* ── UI ──────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const SCREENS = ["start", "paste", "done"];

function showScreen(name) {
  for (const s of SCREENS) $("screen-" + s).classList.toggle("hidden", s !== name);
}

function setError(id, msg) {
  const el = $(id);
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.textContent = "✖ " + msg;
}

let pkce = null;

/* ── Step 1 — open Discord authorization ─────────────────── */

async function startAuth() {
  pkce = await buildAuthUrl();
  $("auth-url-box").textContent = pkce.url;
  $("paste-input").value = "";
  $("hp").value = "";
  $("btn-activate").disabled = true;
  setError("err-paste", null);
  showScreen("paste");
  window.open(pkce.url, "discord-auth", "width=560,height=760");
}

/* ── Step 2 — validate paste ─────────────────────────────── */

function validatePaste() {
  const raw = extractUrl($("paste-input").value);
  let ok = false;
  setError("err-paste", null);
  if (raw && pkce) {
    try {
      const u = new URL(raw);
      const hasState = u.searchParams.get("state") === pkce.state;
      const hasCode = !!u.searchParams.get("code");
      ok = hasState && hasCode;
      if (hasState && !hasCode) setError("err-paste", "That URL has no 'code' — did you click Authorize?");
      else if (!hasState) setError("err-paste", "That URL is from a different run — press “Reopen” and use the newest link.");
    } catch { ok = false; }
  }
  $("btn-activate").disabled = !ok;
}

/* ── Step 3 — hand the code to the server → 24/7 + key ───── */

async function activate() {
  const raw = extractUrl($("paste-input").value);
  const u = new URL(raw);
  const code = u.searchParams.get("code");
  const btn = $("btn-activate");
  btn.disabled = true;
  setError("err-paste", null);
  try {
    const r = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pkce.verifier,
        label: $("label-input").value.trim(),
        website: $("hp").value, // honeypot — humans leave it empty
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    $("done-key").textContent = data.key;
    $("done-label").textContent = data.label || "—";
    $("done-id").textContent = data.id;
    try { sessionStorage.setItem("vr_claim_key", data.key); } catch { /* ignore */ }
    pkce = null;
    showScreen("done");
  } catch (e) {
    setError("err-paste", e.message);
    btn.disabled = false;
  }
}

/* ── Init ────────────────────────────────────────────────── */

function init() {
  $("btn-start").addEventListener("click", startAuth);
  $("btn-reopen").addEventListener("click", () => {
    if (pkce) window.open(pkce.url, "discord-auth", "width=560,height=760");
  });
  $("paste-input").addEventListener("input", validatePaste);
  $("btn-activate").addEventListener("click", activate);
  $("btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("done-key").textContent);
      $("btn-copy").textContent = "✔ Copied";
      setTimeout(() => ($("btn-copy").textContent = "⧉ Copy key"), 1800);
    } catch { /* user copies manually */ }
  });
  $("btn-mine").addEventListener("click", () => (location.href = "/me"));
  showScreen("start");
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractUrl, toBase64url, buildAuthUrl };
}
