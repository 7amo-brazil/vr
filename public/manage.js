/* ═══════════════════════════════════════════════════════════
   VR Status LUX — My Account (claim-key protected)
   © 2026 7amo Brazil
   ═══════════════════════════════════════════════════════════ */
"use strict";

const $ = (id) => document.getElementById(id);
let timer = null;
let lastKey = "";

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function timeAgo(t) {
  if (!t) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function statusOf(a) {
  if (!a.enabled) return { cls: "paused", text: "Paused" };
  if (a.cooldown_until && a.cooldown_until > Date.now()) return { cls: "warn", text: "Cooling down" };
  if (a.last_error && /re-authentication required/i.test(a.last_error)) return { cls: "expired", text: "Re-auth needed" };
  if ((a.failures || 0) > 0) return { cls: "warn", text: "Recovering" };
  return { cls: "ok", text: "Active" };
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function render(a) {
  const st = statusOf(a);
  $("a-label").textContent = a.label;
  $("a-id").textContent = a.id;
  $("a-created").textContent = new Date(a.created_at).toLocaleString();
  $("a-session").textContent = a.session || "—";
  $("a-ttl").textContent = fmt(a.tokenTtlMs);
  $("a-beat").textContent = timeAgo(a.last_beat);
  $("a-beats").textContent = a.beats;
  const badge = $("acct-status");
  badge.className = "badge " + st.cls;
  badge.textContent = st.text;
  $("btn-toggle").textContent = a.enabled ? "⏸ Pause my badge" : "▶ Resume my badge";
  const note = $("a-err-note");
  if (a.last_error && st.cls !== "ok") {
    note.classList.remove("hidden");
    note.textContent = "⚠ " + a.last_error;
  } else {
    note.classList.add("hidden");
  }
}

function show(name) {
  for (const s of ["key", "acct", "gone"]) $("screen-" + s).classList.toggle("hidden", s !== name);
}

async function refresh() {
  try {
    const d = await api("/api/claim/status");
    render(d.account);
  } catch {
    show("key");
  }
}

function startAcct() {
  show("acct");
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 10_000);
}

async function verify() {
  const key = $("key-input").value.trim().toUpperCase();
  if (!key) return;
  lastKey = key;
  $("btn-verify").disabled = true;
  try {
    const d = await api("/api/claim/verify", { method: "POST", body: JSON.stringify({ key }) });
    $("err-key").classList.add("hidden");
    render(d.account);
    startAcct();
  } catch (e) {
    const el = $("err-key");
    el.classList.remove("hidden");
    el.textContent = "✖ " + e.message;
  }
  $("btn-verify").disabled = false;
}

async function toggle() {
  const btn = $("btn-toggle");
  btn.disabled = true;
  try {
    const cur = await api("/api/claim/status");
    const d = await api("/api/claim/toggle", { method: "POST", body: JSON.stringify({ enabled: !cur.account.enabled }) });
    render(d.account);
  } catch (e) {
    $("err-acct").textContent = "✖ " + e.message;
    $("err-acct").classList.remove("hidden");
  }
  btn.disabled = false;
}

async function remove() {
  if (!confirm("Remove your VR badge permanently? This wipes your data from the server.")) return;
  const key = prompt("Type your key one last time to confirm:");
  if (!key) return;
  const btn = $("btn-delete");
  btn.disabled = true;
  try {
    await api("/api/claim/delete", { method: "POST", body: JSON.stringify({ key: key.trim().toUpperCase() }) });
    clearInterval(timer);
    show("gone");
  } catch (e) {
    $("err-acct").textContent = "✖ " + e.message;
    $("err-acct").classList.remove("hidden");
    btn.disabled = false;
  }
}

async function lock() {
  clearInterval(timer);
  try { await api("/api/claim/logout", { method: "POST" }); } catch { /* ignore */ }
  $("key-input").value = "";
  show("key");
}

function init() {
  $("btn-verify").addEventListener("click", verify);
  $("key-input").addEventListener("keydown", (e) => { if (e.key === "Enter") verify(); });
  $("btn-toggle").addEventListener("click", toggle);
  $("btn-delete").addEventListener("click", remove);
  $("btn-logout").addEventListener("click", lock);

  // Auto-fill from the "done" screen if available (same browser)
  let saved = "";
  try { saved = sessionStorage.getItem("vr_claim_key") || ""; } catch { /* ignore */ }
  if (saved) {
    $("key-input").value = saved;
    verify();
  } else {
    show("key");
  }
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
