/* ═══════════════════════════════════════════════════════════
   VR Status LUX — Admin client (CSRF-aware)
   © 2026 7amo Brazil
   ═══════════════════════════════════════════════════════════ */
"use strict";

const $ = (id) => document.getElementById(id);
let timer = null;
let csrf = "";

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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (csrf && (opts.method || "GET") !== "GET") headers["X-CSRF-Token"] = csrf;
  const r = await fetch(path, {
    credentials: "same-origin",
    headers,
    ...opts,
    headers,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

function statusOf(s) {
  if (!s.enabled) return { cls: "paused", text: "Paused" };
  if (s.cooldown_until && s.cooldown_until > Date.now()) return { cls: "warn", text: "Cooling down" };
  if (s.last_error && /re-authentication required/i.test(s.last_error)) return { cls: "expired", text: "Re-auth needed" };
  if ((s.failures || 0) > 0) return { cls: "warn", text: "Recovering" };
  return { cls: "ok", text: "Active" };
}

async function loadSessions() {
  const { server, sessions } = await api("/api/admin/sessions");
  $("srv-meta").textContent = `v${server.version} ${server.codename} • uptime ${fmt(server.uptime * 1000)} • by ${server.author}`;
  $("s-total").textContent = sessions.length;
  $("s-active").textContent = sessions.filter((s) => s.enabled).length;
  $("s-uptime").textContent = fmt(server.uptime * 1000);

  const rows = $("rows");
  if (!sessions.length) {
    rows.innerHTML = `<tr><td colspan="7" class="empty">No accounts yet — share the site link to activate badges.</td></tr>`;
    return;
  }
  rows.innerHTML = sessions.map((s) => {
    const st = statusOf(s);
    return `
      <tr>
        <td><b>${esc(s.label)}</b><br><span class="tiny mono">${esc(s.id)}</span></td>
        <td><span class="badge ${st.cls}">${st.text}</span></td>
        <td class="tiny">${new Date(s.created_at).toLocaleString()}</td>
        <td>${fmt(s.tokenTtlMs)}</td>
        <td class="tiny">${timeAgo(s.last_beat)}</td>
        <td>${s.beats}</td>
        <td class="acts">
          <button class="btn ghost small" data-act="toggle" data-id="${esc(s.id)}" data-en="${s.enabled ? 0 : 1}">
            ${s.enabled ? "Pause" : "Resume"}
          </button>
          <button class="btn ghost small danger-btn" data-act="delete" data-id="${esc(s.id)}" data-label="${esc(s.label)}">✕</button>
        </td>
      </tr>`;
  }).join("");

  for (const b of rows.querySelectorAll("button[data-act]")) {
    b.addEventListener("click", async () => {
      const { act, id } = b.dataset;
      try {
        if (act === "toggle") {
          await api("/api/admin/toggle", { method: "POST", body: JSON.stringify({ id, enabled: b.dataset.en === "1" }) });
        } else if (act === "delete") {
          if (!confirm(`Remove the VR badge for "${b.dataset.label}"?`)) return;
          await api("/api/admin/delete", { method: "POST", body: JSON.stringify({ id }) });
        }
        await loadAll();
      } catch (e) {
        if (e.status === 403 && /CSRF/i.test(e.message)) {
          alert("Session expired — please log in again.");
          showLogin();
        } else {
          alert(e.message);
        }
      }
    });
  }
}

async function loadAudit() {
  try {
    const { events } = await api("/api/admin/audit");
    const rows = $("audit-rows");
    if (!events.length) {
      rows.innerHTML = `<tr><td colspan="6" class="empty">No events yet.</td></tr>`;
      return;
    }
    rows.innerHTML = events.map((e) => `
      <tr>
        <td class="tiny mono">${new Date(e.ts).toLocaleString()}</td>
        <td><b>${esc(e.action)}</b></td>
        <td class="tiny">${esc(e.actor)}</td>
        <td class="tiny mono">${esc(e.target || "—")}</td>
        <td class="tiny mono">${esc(e.ip)}</td>
        <td><span class="badge ${e.ok ? "ok" : "expired"}">${e.ok ? "OK" : "FAIL"}</span></td>
      </tr>`).join("");
  } catch { /* non-critical */ }
}

async function loadAll() {
  await loadSessions();
  loadAudit();
}

function startDashboard() {
  $("screen-login").classList.add("hidden");
  $("screen-dash").classList.remove("hidden");
  loadAll().catch(() => showLogin());
  clearInterval(timer);
  timer = setInterval(() => loadAll().catch(() => {}), 10_000);
}

function showLogin() {
  clearInterval(timer);
  csrf = "";
  $("screen-dash").classList.add("hidden");
  $("screen-login").classList.remove("hidden");
}

async function tryLogin() {
  const pw = $("pw-input").value;
  $("btn-login").disabled = true;
  $("err-login").classList.add("hidden");
  try {
    const r = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: pw }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    csrf = r.headers.get("X-CSRF-Token") || "";
    $("pw-input").value = "";
    startDashboard();
  } catch (e) {
    const el = $("err-login");
    el.classList.remove("hidden");
    el.textContent = "✖ " + e.message;
  }
  $("btn-login").disabled = false;
}

async function init() {
  $("btn-login").addEventListener("click", tryLogin);
  $("pw-input").addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });
  $("btn-logout").addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST" }); } catch { /* ignore */ }
    showLogin();
  });

  try {
    await api("/api/admin/sessions");
    startDashboard();
  } catch {
    showLogin();
  }
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
