# 🎮 Discord VR Status — LUX Forever Edition

<p align="center"><b>Authorize once. The badge runs 24/7 — protected by personal keys.</b></p>
<p align="center"><b>© 2026 7amo Brazil — All rights reserved</b></p>

The **persistent, hardened** edition of the Discord VR (Meta Quest) badge tool. A visitor opens your link, authorizes **once** (~30s), and the engine keeps the badge alive **around the clock**. Premium black/purple UI, custom emoji design, and a **deep security layer** so every person's account is theirs alone.

> 💬 نسخة مختصرة: شخص يدخل الرابط → يوافق مرة وحدة → يلصق الرابط → بياخد **مفتاح شخصي** والشارة تظل شغالة 24/7 من المحرك. يدير حسابه من `/me` بالمفتاح، والأدمن يدير الكل من `/admin` مع سجل تدقيق كامل.

---

## 🛡️ The security layer (v5 — "حماية كبيرة")

| Layer | What it does |
|---|---|
| 🔑 **Personal claim keys** | Every account gets a key (`7AMO-XXXXXXXX-XXXX`) shown **once**. Only its holder (or admin) can pause/remove it. Keys stored **hashed** (SHA-256) — even the admin can't read them. |
| 🏠 **Self-service dashboard** `/me` | Account owners manage their own badge (live status, pause/resume, permanent removal with key re-entry). |
| 🛡 **Admin hardening** | scrypt-hashed password (**min 10 chars** — server refuses weaker), `HttpOnly`+`SameSite=Strict` cookies, **CSRF double-submit** on all mutations, **per-IP lockout** (5 fails → 15 min). |
| 🚦 **Rate limiting** | connect (6/10min), claim verify (10/10min), claim actions, logins — all per-IP. |
| 🪤 **Honeypot** | Bots filling the hidden connect field get a silent fake success — nothing is created, event is untraceable to them. |
| 📜 **Audit log** | Append-only JSONL (last 2000 events): who/what/when/IP/result — live view in `/admin`. |
| 📡 **Security headers** | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS (behind HTTPS), hidden server fingerprint. |
| 🔒 **Data protection** | `sessions.json` 0600 + atomic writes; raw tokens **never** exposed to any UI (masked only); data dir never served; path-traversal-safe static hosting; body size limits. |
| 🧊 **Engine protection** | After 5 straight failures an account enters a 10-min cooldown — the engine never hammers Discord. |

## ⚡ How it achieves "forever"

Serverless platforms can't run 24/7 loops, so LUX is a **single persistent Node process** (zero dependencies):

1. Serves the site (public + `/me` + `/admin`) — no build step.
2. **Adaptive keep-alive engine**: 60s heartbeat when healthy → 15s after a failure → back to 60s when healed → 10-min cooldown after 5 straight failures.
3. **Proactive token refresh** (before the ~10 min expiry) + forced refresh on 401 — no re-auth for days.
4. **Persistence**: state in `data/sessions.json` (0600, atomic) → survives restarts/reboots; boot auto-resumes every active session.
5. **systemd** restarts the process on boot and after crashes.

```
Visitor's browser        LUX server (24/7)                  Discord
─────────────────        ─────────────────────              ───────
PKCE (Web Crypto)  ──┐
Authorize (1x)       │
paste URL ───────────┼──►  /api/connect ──► OAuth exchange + session create
honeypot checked     │      rate-limited     returns personal key (shown once)
"Save your key"      │
                     │──►  engine: per-account adaptive heartbeat
/my (by key)  ◄──────      proactive refresh • 401 recovery • cooldown
/admin (pw+CSRF) ◄──       audit log • claim keys (hashed)
```

## 📁 Structure

```
discord-vr-status-forever/
├── server.js             ← engine + APIs + security + static hosting (zero deps)
├── public/
│   ├── index.html        ← visitor site (LUX purple/black, custom emoji)
│   ├── app.js
│   ├── manage.html       ← /me — owner dashboard (key-protected)
│   ├── manage.js
│   ├── admin.html        ← /admin — control room + audit log
│   ├── admin.js
│   └── style.css         ← premium black + purple theme
├── data/                 ← runtime (sessions.json, audit.jsonl, admin.key) — gitignored
├── forever.service       ← systemd unit (24/7 + auto-start on boot)
├── deploy/Caddyfile.example  ← automatic HTTPS
├── package.json
├── LICENSE               ← MIT © 7amo Brazil
└── README.md
```

## 🖥️ Run it

```bash
node server.js
```

```
──────────────────────────────────────────────────────────────
  🎮  Discord VR Status — Forever Edition  [LUX]
  v5.0.0 • Persistent 24/7 badge engine • hardened
  © 2026 7amo Brazil — All rights reserved
──────────────────────────────────────────────────────────────
[lux] Security    : CSP+HSTS+CSRF+lockout+audit+claim-keys ✔
```

- Site: `/` • My account: `/me` • Admin: `/admin` • Health: `/healthz`

### Environment

| Variable | Description | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Admin password (**min 10 chars** — enforced) | generated → `data/admin.key` |
| `PORT` | Listen port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `DATA_DIR` | State directory | `./data` |
| `KEEPALIVE_MS` | Heartbeat interval | `60000` |

## ☁️ Deploy FREE & FOREVER — Oracle Cloud Always Free

1. **Always Free VM** (Ubuntu, ARM) at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/).
2. Install Node 20:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
3. Copy the project:
   ```bash
   sudo mkdir -p /opt/discord-vr-forever
   sudo cp -r discord-vr-status-forever/* /opt/discord-vr-forever/
   sudo chown -R ubuntu:ubuntu /opt/discord-vr-forever
   ```
4. Run under systemd (24/7 + auto-start + crash restart):
   ```bash
   sudo sed -i 's/CHANGE_ME_STRONG_PASSWORD/YourStrongPass123!/' forever.service
   sudo cp forever.service /etc/systemd/system/discord-vr-forever.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now discord-vr-forever
   sudo journalctl -u discord-vr-forever -f
   ```
5. Firewall: `sudo ufw allow 3000/tcp` (or close it once HTTPS is on).

Any VPS works identically (Hetzner ~€4/mo, DO, Vultr…).

### 🔒 Domain + automatic HTTPS (recommended before sharing)

```bash
sudo apt install -y caddy
# /etc/caddy/Caddyfile → your-domain.com { reverse_proxy 127.0.0.1:3000 }
sudo systemctl restart caddy
```

Then close port 3000 and keep 80/443 only. HSTS activates automatically behind HTTPS.

## ⚠️ Honest limits (professional disclosure)

- **"Forever" = as long as the server runs** (free Oracle VM + systemd = very long) **and Discord keeps the feature** (undocumented endpoint — can change).
- When a refresh token is finally rejected, the dashboard shows **Re-auth needed** — the owner re-pastes a fresh authorization (30s). The tool reports this clearly instead of silently dying.
- The badge may not appear on the **owner's own** Discord client (known quirk) — everyone else sees it.
- Unofficial personal tool. Use on your own accounts, responsibly. **Never share claim keys or the admin password.**

## 📜 Credits & License

- LUX Forever Edition & all engineering: **© 2026 7amo Brazil** — MIT.
- Original research & mechanism: [DaXcess/discord-vr-status](https://github.com/DaXcess/discord-vr-status) (MIT).
- Sibling editions: `discord-vr-status` (CLI) • `discord-vr-status-web` (Vercel demo).

<p align="center">Built with ❤️ & precision — <b>7amo Brazil</b> 🇧</p>
