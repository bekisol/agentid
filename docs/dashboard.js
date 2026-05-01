const BASE = "https://api.agentid-protocol.com";

// ── SECURE KEY STORAGE ────────────────────────────────────────────────────────
// Key lives in sessionStorage (tab-scoped, cleared on browser close, not
// readable across origins). A short-lived localStorage pulse lets new tabs
// inherit an active session without permanently storing the raw key.
// Bootstrap chain: this-tab session → cross-restart localStorage ("stay signed in") → empty.
// localStorage is opt-in via the welcome modal's "Stay signed in" checkbox.
let apiKey = sessionStorage.getItem("agentid_key")
          || localStorage.getItem("agentid_persisted_key")
          || "";
if (apiKey && !sessionStorage.getItem("agentid_key")) {
  // Mirror to sessionStorage so the rest of the app finds it where it expects.
  sessionStorage.setItem("agentid_key", apiKey);
  // If we restored from localStorage, we're functionally in apikey mode.
  if (!sessionStorage.getItem("agentid_auth_mode")) {
    sessionStorage.setItem("agentid_auth_mode", "apikey");
  }
}

// ── CROSS-TAB SESSION SYNC ────────────────────────────────────────────────────
// BroadcastChannel is preferred: messages are never persisted to disk/storage.
// The API key is transmitted only in memory, in-process, between same-origin tabs.
// localStorage fallback is used on browsers without BroadcastChannel (rare in 2026).
//
// Security properties:
//   - BroadcastChannel: key never touches localStorage/sessionStorage; invisible
//     to DevTools Application tab; not accessible to extensions that read storage.
//   - localStorage fallback: key written for ≤1 animation frame then deleted;
//     origin field is verified on receipt; ignored if key already present.

(function _setupTabSync() {
  if (typeof BroadcastChannel !== "undefined") {
    // ── BroadcastChannel path (no localStorage exposure) ──────────────────
    const bc = new BroadcastChannel("agentid_session");

    // Request from sibling tabs if we have no key
    if (!apiKey) bc.postMessage({ type: "request" });

    bc.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "request" && apiKey) {
        // A new tab is asking — respond with our key
        bc.postMessage({ type: "response", key: apiKey, ts: Date.now() });
      }
      if (msg.type === "response" && !apiKey) {
        const { key, ts } = msg;
        if (key && Date.now() - ts < 2000) {
          apiKey = key;
          sessionStorage.setItem("agentid_key", key);
          sessionStorage.setItem("agentid_login_ts",
            sessionStorage.getItem("agentid_login_ts") || String(ts));
          loadDashboard().then(() => scheduleSessionExpiry());
        }
      }
    };

    // Export so login() can notify siblings
    window._bcTabSync = bc;

  } else {
    // ── localStorage fallback (key present for ≤1 frame then removed) ──────
    const _TAB_ORIGIN = location.origin;

    if (!apiKey) {
      // Signal new tab; key never written here — only sibling writes sync
      localStorage.setItem("agentid_tab_ping", String(Date.now()));
      // Remove immediately so nothing persists
      localStorage.removeItem("agentid_tab_ping");
    }

    window.addEventListener("storage", (ev) => {
      if (ev.key === "agentid_tab_sync" && ev.newValue) {
        try {
          const { key, ts, origin } = JSON.parse(ev.newValue);
          if (origin !== _TAB_ORIGIN) return;          // wrong origin — ignore
          if (key && Date.now() - ts < 2000 && !apiKey) {
            apiKey = key;
            sessionStorage.setItem("agentid_key", key);
            sessionStorage.setItem("agentid_login_ts",
              sessionStorage.getItem("agentid_login_ts") || String(ts));
            loadDashboard().then(() => scheduleSessionExpiry());
          }
        } catch { /* malformed — ignore */ }
      }
      if (ev.key === "agentid_tab_ping" && apiKey) {
        const payload = JSON.stringify({ key: apiKey, ts: Date.now(), origin: _TAB_ORIGIN });
        localStorage.setItem("agentid_tab_sync", payload);
        // Delete after one tick — key is in localStorage for ≤1 animation frame
        setTimeout(() => localStorage.removeItem("agentid_tab_sync"), 0);
      }
    });
  }
}());

let trendChart, capChart;
let _anomalyTimer = null;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
let sessionTimer = null;

function getSessionAge() {
  const ts = sessionStorage.getItem("agentid_login_ts");
  // If no timestamp (e.g. logged in before this feature), treat as fresh
  return ts ? Date.now() - Number(ts) : 0;
}

function scheduleSessionExpiry() {
  clearTimeout(sessionTimer);
  const remaining = SESSION_TTL_MS - getSessionAge();
  if (remaining <= 0) { expireSession(); return; }
  sessionTimer = setTimeout(expireSession, remaining);
}

function expireSession() {
  // Clear ALL auth artefacts so we can never end up in the half-state
  // "auth_mode = apikey but no key in storage" that confuses the next
  // page load.
  sessionStorage.removeItem("agentid_key");
  sessionStorage.removeItem("agentid_login_ts");
  sessionStorage.removeItem("agentid_auth_mode");
  apiKey = "";
  authMode = "session";
  clearTimeout(sessionTimer);
  clearInterval(_anomalyTimer);
  stopSse();
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("logout-btn").style.display = "none";
  const apiInput = document.getElementById("api-key-input");
  if (apiInput) apiInput.value = "";
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (capChart)   { capChart.destroy();   capChart = null; }
  const err = document.getElementById("error-msg");
  if (err) {
    err.textContent = "Your session expired. Please sign in again.";
    err.style.display = "block";
  }
}

// Tier agent limits
const TIER_LIMITS = { free: 100, pro: 10000, enterprise: Infinity };

// SEC: HTML escape — all API strings pass through before innerHTML
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const OP_CLASS = {
  register:   "op-register",
  resolve:    "op-resolve",
  verify:     "op-verify",
  deregister: "op-deregister",
  update:     "op-update",
};

function opClass(op) { return OP_CLASS[String(op)] || ""; }

function shortDid(did) {
  if (!did) return "—";
  const s = String(did);
  return s.length > 26 ? s.slice(0, 14) + "…" + s.slice(-8) : s;
}

function tierClass(tier) {
  return { enterprise: "tier-enterprise", pro: "tier-pro", free: "tier-free" }[String(tier)] || "tier-free";
}

function timeAgo(isoStr) {
  if (!isoStr) return "—";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// Auth mode:
//   "session" — logged in via /auth/login, server identifies us by cookie
//   "apikey"  — legacy: raw key in sessionStorage, sent as x-api-key header
let authMode = sessionStorage.getItem("agentid_auth_mode") || (apiKey ? "apikey" : "session");

async function apiFetch(path, options = {}) {
  const headers = { ...options.headers };

  // Belt-and-suspenders auth: send WHATEVER credentials we have, regardless
  // of the declared authMode. The server tries session cookie first, then
  // x-api-key — so passing both costs nothing and recovers cleanly when
  // the cookie is missing (cross-subdomain edge cases) or when the
  // session has expired but a stored API key is still valid.
  // Fallback chain: in-memory → sessionStorage (this tab) → localStorage
  // (set by "stay signed in" toggle, persists across refresh + close).
  const storedKey = apiKey
                  || sessionStorage.getItem("agentid_key")
                  || localStorage.getItem("agentid_persisted_key");
  if (storedKey) {
    apiKey = storedKey;            // re-hydrate in-memory copy
    if (!sessionStorage.getItem("agentid_key")) {
      sessionStorage.setItem("agentid_key", storedKey);
    }
    headers["x-api-key"] = storedKey;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  // 30-second hard timeout so slow/cold-starting Railway responses never
  // leave a section stuck on "Loading..." forever.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let res;
  try {
    res = await fetch(BASE + path, {
      ...options,
      credentials: "include",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    let msg = res.status;
    try {
      const j = await res.json();
      msg = j.detail || j.message || msg;
    } catch (_) {}
    // 401 self-recovery: surface a session-drop banner — but only after
    // we've confirmed there's actually nothing the user can do. Skip it
    // during a 5-second grace window after login (so background requests
    // racing with cookie propagation don't spam a "session dropped"
    // banner on what is in fact a brand-new session).
    if (res.status === 401 && _shouldTriggerSessionDrop()) {
      _triggerSessionDrop(msg);
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

let _sessionDropFired = false;
let _loginGraceUntil  = 0;     // wall-clock ms after which we *will* fire a 401 banner

function _shouldTriggerSessionDrop() {
  if (_sessionDropFired) return false;
  if (Date.now() < _loginGraceUntil) return false;
  return true;
}

function _markFreshLogin(graceMs = 5000) {
  _sessionDropFired = false;
  _loginGraceUntil = Date.now() + graceMs;
}

function _triggerSessionDrop(detail) {
  if (_sessionDropFired) return;
  _sessionDropFired = true;
  console.warn("[apiFetch] session dropped — clearing stale auth state.", detail);
  // Clear ALL auth artefacts so the next page load can never repeat this.
  sessionStorage.removeItem("agentid_key");
  sessionStorage.removeItem("agentid_login_ts");
  sessionStorage.removeItem("agentid_auth_mode");
  apiKey = "";
  authMode = "session";
  // If the dashboard is currently visible, slide a banner across the top
  // so the user sees what's happening instead of a silent failure cascade.
  if (document.getElementById("dashboard")?.style.display !== "none") {
    _showInlineSessionBanner(detail);
  }
}

function _showInlineSessionBanner(detail) {
  if (document.getElementById("inline-session-banner")) return;
  const b = document.createElement("div");
  b.id = "inline-session-banner";
  b.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0;
    background: #fbe2e2; color: #9b1f1f;
    padding: 0.85rem 1.4rem; font-size: 0.88rem;
    border-bottom: 1px solid #f5c0c0; z-index: 10000;
    display: flex; align-items: center; gap: 0.85rem; justify-content: center;
    box-shadow: 0 2px 6px rgba(0,0,0,0.06);
  `;
  b.innerHTML = `
    <strong>⚠ Your session has dropped.</strong>
    <span style="opacity:0.85;">Some requests are failing. Click below to sign in again.</span>
    <button id="banner-relogin" style="background:#9b1f1f;color:white;border:none;border-radius:5px;padding:0.4rem 0.9rem;font-size:0.82rem;cursor:pointer;font-weight:600;">Re-login</button>
    <button id="banner-dismiss" style="background:none;border:none;cursor:pointer;color:#9b1f1f;opacity:0.6;font-size:1rem;">✕</button>`;
  document.body.appendChild(b);
  document.getElementById("banner-relogin")?.addEventListener("click", () => logout());
  document.getElementById("banner-dismiss")?.addEventListener("click", () => b.remove());
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────

function _showAuthError(text, html = false) {
  const err = document.getElementById("error-msg");
  if (!err) return;
  if (html) err.innerHTML = text; else err.textContent = text;
  err.style.display = "block";
}

function _clearAuthError() {
  const err = document.getElementById("error-msg");
  if (err) err.style.display = "none";
}

function _authMessageForStatus(msg) {
  const isTierError = msg.toLowerCase().includes("tier");
  if (msg === "401") return "Invalid email or password.";
  if (msg === "403" || isTierError) {
    return {
      html: "This dashboard requires a <strong>Pro</strong> or <strong>Enterprise</strong> account. " +
            "You're on the free tier. " +
            '<a href="https://agentid-protocol.com/pricing" target="_blank" style="color:#c9532f;text-decoration:underline">Upgrade →</a>'
    };
  }
  if (msg === "409") return "An account with that email already exists.";
  if (msg === "429") return "Too many attempts — please wait a moment.";
  if (msg.toLowerCase().includes("password")) return msg;  // surface server password complaints
  if (msg.toLowerCase().includes("email"))    return msg;
  return "Could not connect — try again shortly.";
}

/**
 * Account login: POST /auth/login → server sets the agentid_session cookie.
 * After this, every apiFetch carries the cookie automatically.
 */
async function accountLogin() {
  const email = document.getElementById("login-email").value.trim();
  const pw    = document.getElementById("login-password").value;
  const btn   = document.getElementById("account-login-btn");

  _clearAuthError();
  if (!email || !pw) {
    _showAuthError("Please enter your email and password.");
    return;
  }
  btn.textContent = "Signing in…";
  btn.disabled = true;
  try {
    const r = await fetch(BASE + "/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: pw }),
    });
    if (!r.ok) {
      let msg = String(r.status);
      try { const j = await r.json(); msg = j.detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    // Cookie is now set; switch the dashboard into "session" auth mode.
    authMode = "session";
    sessionStorage.setItem("agentid_auth_mode", "session");
    sessionStorage.setItem("agentid_login_ts", String(Date.now()));
    apiKey = "";   // we don't carry a raw key in this mode
    sessionStorage.removeItem("agentid_key");
    _markFreshLogin();   // 5s grace window so racing 401s don't spam a banner

    await loadDashboard();
    scheduleSessionExpiry();
  } catch (e) {
    const msg = String(e.message || "");
    const result = _authMessageForStatus(msg);
    if (typeof result === "object" && result.html) _showAuthError(result.html, true);
    else _showAuthError(result || msg);
  } finally {
    btn.textContent = "Sign in";
    btn.disabled = false;
  }
}

/**
 * Account signup: POST /auth/signup → server creates user, sets cookie.
 */
async function accountSignup() {
  const email = document.getElementById("signup-email").value.trim();
  const pw    = document.getElementById("signup-password").value;
  const btn   = document.getElementById("account-signup-btn");

  _clearAuthError();
  if (!email || !pw) {
    _showAuthError("Please enter your email and password.");
    return;
  }
  if (pw.length < 8) {
    _showAuthError("Password must be at least 8 characters.");
    return;
  }
  btn.textContent = "Creating account…";
  btn.disabled = true;
  try {
    const r = await fetch(BASE + "/auth/signup", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: pw }),
    });
    if (!r.ok) {
      let msg = String(r.status);
      try { const j = await r.json(); msg = j.detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    authMode = "session";
    sessionStorage.setItem("agentid_auth_mode", "session");
    sessionStorage.setItem("agentid_login_ts", String(Date.now()));
    apiKey = "";
    sessionStorage.removeItem("agentid_key");
    _markFreshLogin();   // 5s grace window so racing 401s don't spam a banner

    await loadDashboard();
    scheduleSessionExpiry();
  } catch (e) {
    const msg = String(e.message || "");
    _showAuthError(_authMessageForStatus(msg) || msg);
  } finally {
    btn.textContent = "Create account";
    btn.disabled = false;
  }
}

/**
 * Legacy API-key login — same flow as before, but now auto-sets authMode.
 */
async function login() {
  const input = document.getElementById("api-key-input");
  const btn   = document.getElementById("login-btn");
  _clearAuthError();

  apiKey = input.value.trim();
  if (!apiKey) {
    _showAuthError("Please enter your API key.");
    return;
  }

  btn.textContent = "Connecting…";
  btn.disabled = true;
  try {
    authMode = "apikey";
    sessionStorage.setItem("agentid_auth_mode", "apikey");
    _markFreshLogin();
    await loadDashboard();
    sessionStorage.setItem("agentid_key", apiKey);
    sessionStorage.setItem("agentid_login_ts", String(Date.now()));
    if (window._bcTabSync) {
      window._bcTabSync.postMessage({ type: "response", key: apiKey, ts: Date.now() });
    } else {
      const sync = JSON.stringify({ key: apiKey, ts: Date.now(), origin: location.origin });
      localStorage.setItem("agentid_tab_sync", sync);
      setTimeout(() => localStorage.removeItem("agentid_tab_sync"), 0);
    }
    scheduleSessionExpiry();
  } catch (e) {
    const msg = String(e.message || "");
    const result = _authMessageForStatus(msg);
    if (typeof result === "object" && result.html) _showAuthError(result.html, true);
    else _showAuthError(result === "Invalid email or password." ? "Invalid API key — please check and try again." : (result || msg));
    apiKey = "";
  } finally {
    btn.textContent = "Connect";
    btn.disabled = false;
  }
}

async function logout() {
  // If we're in session mode, tell the server to revoke the cookie.
  if (authMode === "session") {
    try {
      await fetch(BASE + "/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (_) { /* network failure — local cleanup still happens */ }
  }
  sessionStorage.removeItem("agentid_key");
  sessionStorage.removeItem("agentid_login_ts");
  sessionStorage.removeItem("agentid_auth_mode");
  // Also wipe the "stay signed in" persisted key so logout means logout.
  localStorage.removeItem("agentid_persisted_key");
  apiKey = "";
  authMode = "session";   // default for next visit
  clearTimeout(sessionTimer);
  clearInterval(_anomalyTimer);
  stopSse();
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("logout-btn").style.display = "none";
  const cmdkBtn = document.getElementById("cmdk-btn");
  if (cmdkBtn) cmdkBtn.style.display = "none";
  const notifBtn = document.getElementById("notif-btn");
  if (notifBtn) notifBtn.style.display = "none";
  const apiInput = document.getElementById("api-key-input");
  if (apiInput) apiInput.value = "";
  ["login-email","login-password","signup-email","signup-password"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (capChart)   { capChart.destroy();   capChart = null; }
}

// ── TIER LOCKS ────────────────────────────────────────────────────────────────

const _TIER_RANK = { free: 0, pro: 1, enterprise: 2 };

function _meetsTier(actual, required) {
  return (_TIER_RANK[actual] ?? 0) >= (_TIER_RANK[required] ?? 0);
}

/**
 * Walk every element with [data-min-tier]; if the user's tier is below it,
 * inject a locked-overlay CTA. Removes any existing overlay first so this
 * is safe to call multiple times (e.g. after key swap).
 */
function applyTierLocks(tier) {
  const elements = document.querySelectorAll("[data-min-tier]");
  elements.forEach(el => {
    // clean up previous run
    el.classList.remove("tier-locked");
    el.removeAttribute("data-locked");
    el.querySelectorAll(":scope > .tier-lock-overlay").forEach(o => o.remove());

    const required = el.getAttribute("data-min-tier");
    if (_meetsTier(tier, required)) return;

    // Tabs (e.g. Settings → Team Keys) — just dim + add lock icon, don't overlay.
    // The corresponding panel will get the overlay treatment when shown.
    if (el.classList.contains("modal-tab") || el.classList.contains("nav-tab")) {
      el.setAttribute("data-locked", "1");
      return;
    }

    const feature = el.getAttribute("data-lock-feature") || "this feature";
    const tierLabel = required === "enterprise" ? "Enterprise" : "Pro";
    const cta = required === "enterprise"
      ? '<a class="lock-cta" href="https://agentid-protocol.com/contact" target="_blank">Contact sales</a>'
      : '<a class="lock-cta" href="https://agentid-protocol.com/pricing" target="_blank">Upgrade to Pro →</a>';

    el.classList.add("tier-locked");
    // Position relative is required for absolute overlay
    if (getComputedStyle(el).position === "static") {
      el.style.position = "relative";
    }
    const overlay = document.createElement("div");
    overlay.className = "tier-lock-overlay";
    overlay.innerHTML =
      '<div class="lock-icon">🔒</div>' +
      `<div class="lock-title">${feature} requires ${tierLabel}</div>` +
      `<div class="lock-sub">You're on the <strong>${tier}</strong> plan. Upgrade to unlock this view, real-time updates, and the full Pro API.</div>` +
      cta;
    el.appendChild(overlay);
  });
}

// ── MAIN DASHBOARD LOAD ───────────────────────────────────────────────────────

// Tier helpers — set on every login so feature loaders can branch off them
let CURRENT_TIER = "free";
const isPro        = () => CURRENT_TIER === "pro" || CURRENT_TIER === "enterprise";
const isEnterprise = () => CURRENT_TIER === "enterprise";

async function loadDashboard() {
  // First call — works for any tier including free. Validates the credential
  // (cookie or API key) and returns owner + tier so we know what to render.
  // Session mode: hit /auth/me; API-key mode: hit /pro/keys/me (returns label etc.)
  const meRaw = authMode === "session"
    ? await apiFetch("/auth/me")
    : await apiFetch("/pro/keys/me");
  const me = authMode === "session"
    ? { owner: meRaw.email, tier: meRaw.tier }
    : meRaw;
  CURRENT_TIER = String(me.tier || "free");
  console.log("[dash] authMode:", authMode, "tier:", CURRENT_TIER, "isPro:", isPro());

  // Pro/Enterprise users get the full analytics payload. Free tier skips it.
  let data;
  if (isPro()) {
    try {
      data = await apiFetch("/pro/analytics/overview");
    } catch (_) {
      data = { owner: me.owner, tier: CURRENT_TIER, usage: {}, activity_last_7d: [] };
    }
  } else {
    data = { owner: me.owner, tier: CURRENT_TIER, usage: {}, activity_last_7d: [] };
  }

  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("logout-btn").style.display = "flex";
  const cmdkBtn = document.getElementById("cmdk-btn");
  if (cmdkBtn) cmdkBtn.style.display = "inline-flex";
  const notifBtn = document.getElementById("notif-btn");
  if (notifBtn) notifBtn.style.display = "inline-flex";
  loadNotifications();   // populate badge on first load

  const tier = String(data.tier);

  // Apply tier-locked overlays to gated tabs/cards
  applyTierLocks(tier);

  // Header
  document.getElementById("dash-title").textContent = data.owner;
  document.getElementById("dash-sub").textContent =
    isPro() ? "Pro analytics dashboard" : "Free tier — agent registry";

  const tierEl = document.createElement("span");
  tierEl.className = "tier-badge " + tierClass(tier);
  tierEl.textContent = tier;
  const tierWrap = document.getElementById("tier-badge-wrap");
  tierWrap.textContent = "";
  tierWrap.appendChild(tierEl);

  // Stats
  const agentsReg   = Number(data.usage.agents_registered) || 0;
  const auditEvents = Number(data.usage.audit_events) || 0;
  const totalActivity = (data.activity_last_7d || []).reduce((s, r) => s + r.count, 0);

  // Discovery = resolves + verifies from searches endpoint (load async)
  document.getElementById("stat-agents").textContent = agentsReg;
  document.getElementById("stat-events").textContent = auditEvents.toLocaleString();
  document.getElementById("stat-active").textContent = totalActivity.toLocaleString();
  document.getElementById("stat-discovery").textContent = "…";
  // Note: stat-caps was replaced by stat-discovery in the HTML

  // Usage meter
  const limit = TIER_LIMITS[tier] ?? 100;
  const pct   = limit === Infinity ? 0 : Math.min(100, Math.round((agentsReg / limit) * 100));

  document.getElementById("usage-tier-label").className = "tier-badge " + tierClass(tier);
  document.getElementById("usage-tier-label").textContent = tier;
  document.getElementById("usage-label").textContent =
    limit === Infinity
      ? `${agentsReg.toLocaleString()} agents (unlimited)`
      : `${agentsReg.toLocaleString()} / ${limit.toLocaleString()} agents`;
  document.getElementById("usage-pct").textContent = limit === Infinity ? "∞" : `${pct}%`;

  const fill = document.getElementById("usage-fill");
  fill.style.width = (limit === Infinity ? 2 : pct) + "%";
  fill.style.background = pct > 90 ? "var(--red)" : pct > 70 ? "var(--yellow)" : "var(--accent)";

  // ROI framing — ~2 min saved per verification vs manual
  const verifyCount = (data.activity_last_7d || []).find(r => r.operation === "verify");
  const verifies = Number(verifyCount?.count || 0);
  const hrsSaved = Math.round((verifies * 2) / 60 * 10) / 10;
  const roiEl = document.getElementById("usage-roi");
  if (roiEl && verifies > 0) {
    roiEl.textContent = `⏱ ~${hrsSaved}h of manual verification saved this week (${verifies.toLocaleString()} verifications × 2 min avg)`;
  }

  // Upgrade prompt — show when free tier and >70% full
  const upgradeEl = document.getElementById("upgrade-prompt");
  if (upgradeEl) {
    upgradeEl.style.display = (tier === "free" && pct >= 70) ? "" : "none";
  }

  // Badge + agents always load (work for any tier — public/CRUD endpoints)
  loadBadge(data.owner);
  loadAgentsTable();

  // Trust scores — always attempt; the widget hides itself if the API returns nothing
  _loadTrustScoreWidget();

  // Pro-only loaders — free tier sees locked overlays instead
  if (isPro()) {
    try { renderCharts(data); } catch (e) {
      console.warn("Charts:", e);
      ["trend-chart", "cap-chart"].forEach(id => {
        const c = document.getElementById(id);
        if (c) {
          const wrap = c.closest(".chart-wrap");
          if (wrap) wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:0.8rem;">Chart unavailable</div>`;
        }
      });
    }
    try { renderActivity(data.activity_last_7d || []); } catch (e) {
      console.error("renderActivity:", e);
      const actEl = document.getElementById("activity-list");
      if (actEl) actEl.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p style="font-size:0.78rem;color:var(--muted);">Could not render activity: ${esc(String(e?.message || e))}</p></div>`;
    }
    loadAuditLog().catch(e => console.error("loadAuditLog:", e));
    loadSigningActivity().catch(e => console.error("loadSigningActivity:", e));
    loadDiscoveryStats().catch(e => console.error("loadDiscoveryStats:", e));
    loadAnomalies().catch(e => console.error("loadAnomalies:", e));
    _loadGroups().catch?.(e => console.error("loadGroups:", e));
    loadPeerBenchmarks();

    // Start real-time SSE feed (or restart if already running)
    startSse();

    // Anomaly auto-refresh every 60 s
    clearInterval(_anomalyTimer);
    _anomalyTimer = setInterval(loadAnomalies, 60000);
  }

  // Onboarding checklist — shown until all steps done or dismissed
  _renderOnboarding(data);

  // First-run welcome: if this is a brand-new account with no API keys
  // yet, auto-mint a starter key and surface it with copy-paste snippets.
  // No-op for existing accounts.
  _maybeShowWelcome();
}

// ── ONBOARDING CHECKLIST ──────────────────────────────────────────────────────

const _ONBOARDING_KEY = "agentid_onboarding_dismissed";

// ── FIRST-RUN HERO (shown when zero agents) ──────────────────────────────────
const _FIRST_RUN_KEY = "agentid_first_run_dismissed";

function _renderFirstRun(data) {
  const hero = document.getElementById("first-run-hero");
  if (!hero) return false;
  const agentCount = Number(data.usage?.agents_registered) || 0;
  const dismissed  = localStorage.getItem(_FIRST_RUN_KEY) === "1";
  if (agentCount > 0 || dismissed) {
    hero.style.display = "none";
    return false;
  }
  hero.style.display = "";

  // Tab switching for code samples
  hero.querySelectorAll(".fr-tab").forEach(t => {
    t.onclick = () => {
      const lang = t.getAttribute("data-fr-lang");
      hero.querySelectorAll(".fr-tab").forEach(x => x.classList.toggle("active", x === t));
      hero.querySelectorAll(".fr-code").forEach(c =>
        c.style.display = c.getAttribute("data-fr-panel") === lang ? "" : "none");
    };
  });

  // Buttons
  document.getElementById("fr-open-keys").onclick = () => {
    document.getElementById("settings-btn")?.click();
    setTimeout(() => document.querySelector(".modal-tab[data-tab='api-keys']")?.click(), 200);
    _markFirstRunStep(1, true);
  };
  document.getElementById("fr-copy-snippet").onclick = () => {
    const visible = hero.querySelector(".fr-code:not([style*='display: none'])");
    if (visible) {
      navigator.clipboard.writeText(visible.textContent).catch(() => {});
      const btn = document.getElementById("fr-copy-snippet");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy snippet"; }, 1500);
      _markFirstRunStep(2, true);
    }
  };
  document.getElementById("fr-refresh").onclick = () => {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    if (capChart)   { capChart.destroy();   capChart = null; }
    loadDashboard();
  };
  document.getElementById("first-run-dismiss").onclick = () => {
    localStorage.setItem(_FIRST_RUN_KEY, "1");
    hero.style.display = "none";
  };
  document.getElementById("fr-show-checklist").onclick = (e) => {
    e.preventDefault();
    localStorage.setItem(_FIRST_RUN_KEY, "1");
    hero.style.display = "none";
    // Force the checklist back if it was previously dismissed
    localStorage.removeItem(_ONBOARDING_KEY);
    _renderOnboarding(data);
  };

  return true;   // signal to skip the regular checklist
}

function _markFirstRunStep(n, done) {
  const step  = document.querySelector(`.fr-step:nth-of-type(${n})`);
  const stat  = document.querySelector(`.fr-step-status[data-step="${n}"]`);
  if (step && done) step.classList.add("done");
  if (stat && done) stat.textContent = "✓";
}

function _renderOnboarding(data) {
  // First-run hero takes priority for brand-new accounts
  if (_renderFirstRun(data)) return;

  const card = document.getElementById("onboarding-card");
  if (!card) return;
  if (localStorage.getItem(_ONBOARDING_KEY) === "1") return;

  const agentCount   = Number(data.usage?.agents_registered) || 0;
  const hasWebhooks  = false; // will be refreshed async below
  const tier         = String(data.tier || "free");

  const steps = [
    {
      id: "register-agent",
      done: agentCount > 0,
      icon: "🤖",
      label: "Register your first agent",
      action: () => document.getElementById("register-agent-btn")?.click(),
      actionLabel: "Register now",
    },
    {
      id: "set-webhook",
      done: false,  // async check
      icon: "🔔",
      label: "Set up a webhook to receive real-time events",
      action: () => {
        document.getElementById("settings-btn")?.click();
        setTimeout(() => document.querySelector(".modal-tab[data-tab='webhooks']")?.click(), 200);
      },
      actionLabel: "Add webhook",
    },
    {
      id: "invite-team",
      done: false,  // no easy check without extra API call
      icon: "👥",
      label: "Invite a team member with a scoped API key",
      action: () => {
        document.getElementById("settings-btn")?.click();
        setTimeout(() => document.querySelector(".modal-tab[data-tab='team-keys']")?.click(), 200);
      },
      actionLabel: "Invite teammate",
    },
    {
      id: "download-export",
      done: false,
      icon: "📥",
      label: "Download your audit log (CSV or JSON)",
      action: () => document.getElementById("csv-btn")?.click(),
      actionLabel: "Download CSV",
    },
  ];

  // Async: check if any webhooks exist
  apiFetch("/pro/webhooks").then(whs => {
    if (whs && whs.length > 0) {
      const whStep = steps.find(s => s.id === "set-webhook");
      if (whStep) whStep.done = true;
      _reRenderSteps(card, steps);
    }
  }).catch(() => {});

  _reRenderSteps(card, steps);
  card.style.display = "";

  document.getElementById("onboarding-dismiss")?.addEventListener("click", () => {
    localStorage.setItem(_ONBOARDING_KEY, "1");
    card.style.display = "none";
  });
}

function _reRenderSteps(card, steps) {
  const stepsEl = document.getElementById("onboarding-steps");
  const progEl  = document.getElementById("onboarding-progress");
  if (!stepsEl) return;

  const done = steps.filter(s => s.done).length;
  stepsEl.innerHTML = steps.map(s => `
    <div style="display:flex;align-items:center;gap:0.6rem;font-size:0.84rem;${s.done ? "opacity:0.5;" : ""}">
      <span style="font-size:1rem;flex-shrink:0;">${s.done ? "✅" : s.icon}</span>
      <span style="flex:1;${s.done ? "text-decoration:line-through;color:var(--muted);" : ""}">${s.label}</span>
      ${!s.done ? `<button class="agent-action-btn onboarding-action" data-step="${s.id}" style="white-space:nowrap;">${s.actionLabel}</button>` : ""}
    </div>`).join("");

  if (progEl) progEl.textContent = `${done} of ${steps.length} completed`;

  stepsEl.querySelectorAll(".onboarding-action").forEach(btn => {
    const step = steps.find(s => s.id === btn.dataset.step);
    if (step?.action) btn.addEventListener("click", step.action);
  });

  // Auto-hide once all done
  if (done === steps.length) {
    setTimeout(() => {
      localStorage.setItem(_ONBOARDING_KEY, "1");
      card.style.display = "none";
    }, 2000);
  }
}

// ── CHARTS ────────────────────────────────────────────────────────────────────

function renderCharts(data) {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded — charts skipped");
    return;
  }

  const GRID  = "#F2F0EC";
  const TICK  = "#78716C";
  const TICK2 = "#44403C";
  const FONT  = { family: "Inter", size: 11 };

  const trendLabels = (data.registration_trend_30d || []).map(r =>
    new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  );
  const trendData = (data.registration_trend_30d || []).map(r => Number(r.count) || 0);
  const hasData   = trendData.some(v => v > 0);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById("trend-chart"), {
    type: "line",
    data: {
      labels: trendLabels.length ? trendLabels : ["No data"],
      datasets: [{
        data: hasData ? trendData : [0],
        fill: true,
        tension: 0.4,
        borderColor: "rgba(194,65,12,0.9)",
        borderWidth: 2,
        backgroundColor: (ctx) => {
          const h = ctx.chart.height;
          if (!h) return "rgba(194,65,12,0.12)";
          const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, h);
          gradient.addColorStop(0, "rgba(194,65,12,0.18)");
          gradient.addColorStop(1, "rgba(194,65,12,0.01)");
          return gradient;
        },
        pointBackgroundColor: "rgba(194,65,12,0.9)",
        pointRadius: 3,
        pointHoverRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1C1917", titleColor: "#F9F7F4",
          bodyColor: "#D6D3D1", cornerRadius: 6, padding: 10,
          callbacks: { title: items => items[0].label, label: item => `${item.raw} registration${item.raw !== 1 ? "s" : ""}` }
        }
      },
      scales: {
        x: {
          ticks: { color: TICK, font: FONT, maxRotation: 0, maxTicksLimit: 7 },
          grid: { color: GRID }, border: { color: "#E5E2DB" }
        },
        y: {
          ticks: { color: TICK, font: FONT, stepSize: 1, precision: 0 },
          grid: { color: GRID }, border: { color: "#E5E2DB" }, beginAtZero: true
        }
      }
    }
  });

  // PNG export — use onclick to avoid stacking listeners on re-render
  const exportTrendBtn = document.getElementById("export-trend-png");
  if (exportTrendBtn) exportTrendBtn.onclick = () => {
    const a = document.createElement("a");
    a.download = "registrations.png";
    a.href = trendChart.toBase64Image("image/png", 1);
    a.click();
  };

  const capLabels = (data.top_capabilities || []).map(c => String(c.capability));
  const capData   = (data.top_capabilities || []).map(c => Number(c.agent_count) || 0);
  const PALETTE   = [
    "#C2410C","#059669","#2563EB","#D97706","#7C3AED","#DB2777","#0891B2","#65A30D"
  ];

  if (capChart) capChart.destroy();
  capChart = new Chart(document.getElementById("cap-chart"), {
    type: "bar",
    data: {
      labels: capLabels.length ? capLabels : ["No data"],
      datasets: [{
        data: capData.length ? capData : [0],
        backgroundColor: capLabels.map((_, i) => PALETTE[i % PALETTE.length] + "CC"),
        borderColor:     capLabels.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
      }]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1C1917", titleColor: "#F9F7F4",
          bodyColor: "#D6D3D1", cornerRadius: 6, padding: 10,
          callbacks: { label: item => `${item.raw} agent${item.raw !== 1 ? "s" : ""}` }
        }
      },
      scales: {
        x: { ticks: { color: TICK, font: FONT, stepSize: 1, precision: 0 }, grid: { color: GRID }, border: { color: "#E5E2DB" }, beginAtZero: true },
        y: { ticks: { color: TICK2, font: { ...FONT, size: 12 } }, grid: { display: false }, border: { display: false } }
      }
    }
  });

  const exportCapBtn = document.getElementById("export-cap-png");
  if (exportCapBtn) exportCapBtn.onclick = () => {
    const a = document.createElement("a");
    a.download = "capabilities.png";
    a.href = capChart.toBase64Image("image/png", 1);
    a.click();
  };
}

// ── ACTIVITY ──────────────────────────────────────────────────────────────────

// Map an operation name → consistent color token + pretty pill class.
function _opPalette(op) {
  const k = (op || "").toLowerCase();
  if (k === "register")   return { cls: "op-pill-register",   bg: "var(--op-register-bg)",   fg: "var(--op-register-fg)" };
  if (k === "verify")     return { cls: "op-pill-verify",     bg: "var(--op-verify-bg)",     fg: "var(--op-verify-fg)" };
  if (k === "resolve")    return { cls: "op-pill-resolve",    bg: "var(--op-resolve-bg)",    fg: "var(--op-resolve-fg)" };
  if (k === "update")     return { cls: "op-pill-update",     bg: "var(--op-update-bg)",     fg: "var(--op-update-fg)" };
  if (k === "deregister") return { cls: "op-pill-deregister", bg: "var(--op-deregister-bg)", fg: "var(--op-deregister-fg)" };
  return { cls: "op-pill-other", bg: "var(--op-other-bg)", fg: "var(--op-other-fg)" };
}

/**
 * Render the "Activity — last 7 days" card.
 *
 * Server returns a flat list:  [{operation, count}, ...]   (operation totals)
 * or                           [{date, operation, count}, ...]  (per-day breakdown)
 *
 * We probe for a 'date'/'day' field and render either:
 *   • a stacked-bar chart with one column per day, segments per operation
 *   • or, if only totals are available, a clean per-operation list
 */
function renderActivity(activity) {
  const actEl = document.getElementById("activity-list");
  const totalEl = document.getElementById("activity-total");
  console.log("[dash] renderActivity actEl:", !!actEl, "rows:", activity.length);
  if (!actEl) return;
  if (!activity.length) {
    actEl.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>No activity in the last 7 days</p></div>';
    if (totalEl) totalEl.textContent = "0";
    return;
  }

  const totalAll = activity.reduce((s, r) => s + Number(r.count || 0), 0);
  if (totalEl) {
    totalEl.textContent = totalAll.toLocaleString() + " events";
    totalEl.className = "status-pill " + (totalAll > 0 ? "status-pill-info" : "status-pill-muted");
  }

  // If the server gave us per-day rows, build the 7-day stacked grid.
  const hasDay = activity.some(r => r.date || r.day || r.bucket);
  const ops = Array.from(new Set(activity.map(r => (r.operation || "other").toLowerCase()))).sort();

  if (hasDay) {
    // bucket by day
    const byDay = {};
    for (const r of activity) {
      const d = String(r.date || r.day || r.bucket).slice(0, 10);
      byDay[d] = byDay[d] || {};
      byDay[d][(r.operation || "other").toLowerCase()] =
        (byDay[d][(r.operation || "other").toLowerCase()] || 0) + Number(r.count || 0);
    }
    // ensure 7 days even if some are empty
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const dayTotals = days.map(d => Object.values(byDay[d] || {}).reduce((s, n) => s + n, 0));
    const peak = Math.max(...dayTotals, 1);

    const cells = days.map((d, i) => {
      const total = dayTotals[i];
      const heightPct = (total / peak) * 100;
      const segs = ops.map(op => {
        const v = (byDay[d] || {})[op] || 0;
        if (!v || total === 0) return "";
        const segH = (v / total) * 100;
        return `<div title="${esc(op)} ${v.toLocaleString()}" style="height:${segH}%;background:${_opPalette(op).bg};"></div>`;
      }).join("");
      const dow = new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short" });
      return `
        <div class="activity-day" title="${esc(d)} · ${total.toLocaleString()} events">
          <span class="day-total">${total > 0 ? total.toLocaleString() : ""}</span>
          <div class="day-bars" style="height:${heightPct}%;min-height:${total > 0 ? 4 : 0}px;">${segs}</div>
          <span class="day-label">${esc(dow)}</span>
        </div>`;
    }).join("");

    const legend = ops.map(op =>
      `<span><span class="legend-swatch" style="background:${_opPalette(op).bg};"></span>${esc(op)}</span>`
    ).join("");

    actEl.innerHTML =
      `<div class="activity-week">${cells}</div>
       <div class="activity-legend">${legend}</div>`;
    return;
  }

  // Fallback: server only sent totals — render a tidy list.
  const opSums = {};
  for (const r of activity) {
    const op = (r.operation || "other").toLowerCase();
    opSums[op] = (opSums[op] || 0) + Number(r.count || 0);
  }
  const max = Math.max(...Object.values(opSums), 1);
  actEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0.5rem;">
      ${Object.entries(opSums).sort((a,b) => b[1]-a[1]).map(([op, n]) => {
        const pct = (n / max) * 100;
        const pal = _opPalette(op);
        return `
          <div style="display:flex;align-items:center;gap:0.6rem;">
            <span class="op-pill ${pal.cls}" style="min-width:64px;justify-content:center;">${esc(op)}</span>
            <div style="flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;">
              <div style="width:${pct}%;height:100%;background:${pal.bg};"></div>
            </div>
            <span style="font-variant-numeric:tabular-nums;font-weight:600;font-size:0.82rem;min-width:60px;text-align:right;">${esc(n.toLocaleString())}</span>
          </div>`;
      }).join("")}
    </div>`;
}

// ── BADGE ─────────────────────────────────────────────────────────────────────

async function loadBadge(owner) {
  try {
    const res = await fetch(`${BASE}/pro/verified/${encodeURIComponent(owner)}`);
    const section = document.getElementById("badge-section");
    if (res.ok) {
      const b = await res.json();
      section.innerHTML = `
        <div class="verified-banner">
          <div class="verified-icon">✅</div>
          <div class="verified-text">
            <h3>${esc(b.company_name)} <span style="margin-left:0.5rem;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--yellow);background:var(--yellow-bg);border:1px solid #FDE68A;padding:0.15rem 0.5rem;border-radius:999px;">${esc(b.badge_level)}</span></h3>
            <p>Verified owner · since ${esc(String(b.verified_at).slice(0, 10))}</p>
          </div>
        </div>`;
    } else {
      section.innerHTML = "";
    }
  } catch { document.getElementById("badge-section").innerHTML = ""; }
}

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────

function _statusPill(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ok" || s === "valid")
    return '<span class="status-pill status-pill-good"><span class="dot"></span>' + esc(s) + '</span>';
  if (s === "invalid" || s === "failed" || s === "error")
    return '<span class="status-pill status-pill-bad"><span class="dot"></span>' + esc(s) + '</span>';
  if (s === "revoked" || s === "deprecated")
    return '<span class="status-pill status-pill-warn"><span class="dot"></span>' + esc(s) + '</span>';
  return '<span class="status-pill status-pill-muted">' + esc(s || "—") + '</span>';
}

async function loadAuditLog() {
  const el = document.getElementById("audit-list");
  const countEl = document.getElementById("audit-count");
  if (el) el.innerHTML = '<div class="loading"><div class="spinner"></div> Requesting…</div>';
  console.log("[dash] loadAuditLog starting");
  try {
    const data = await apiFetch("/pro/audit-log/json?limit=15");
    const logs = (data.logs || []).slice(0, 15);
    if (countEl) {
      countEl.textContent = (data.count != null ? data.count : logs.length).toLocaleString() + " total";
      countEl.className = "status-pill status-pill-info";
    }
    if (!logs.length) {
      el.innerHTML = '<div class="empty" style="padding:1.25rem;"><div class="empty-icon">📋</div><p>No audit events yet</p></div>';
      return;
    }

    const rows = logs.map(r => {
      const ts = r.timestamp || "";
      const dt = new Date(ts);
      const hh = String(dt.getUTCHours()).padStart(2, "0");
      const mm = String(dt.getUTCMinutes()).padStart(2, "0");
      const ss = String(dt.getUTCSeconds()).padStart(2, "0");
      const day = dt.toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const timeLabel = day === today ? `${hh}:${mm}:${ss}` : `${day} ${hh}:${mm}`;

      const op = (r.operation || "other").toLowerCase();
      const pal = _opPalette(op);
      const did = r.did || "";
      const shortened = did.length > 32 ? did.slice(0, 22) + "…" + did.slice(-6) : did;
      return `
        <tr>
          <td class="audit-time" title="${esc(ts)}">${esc(timeLabel)}</td>
          <td><span class="op-pill ${pal.cls}">${esc(op)}</span></td>
          <td class="audit-did" title="${esc(did)}">${esc(shortened || "—")}</td>
          <td>${_statusPill(r.status)}</td>
          <td style="color:var(--muted);font-size:0.72rem;font-variant-numeric:tabular-nums;">${esc(r.ip || "—")}</td>
        </tr>`;
    }).join("");

    el.innerHTML = `
      <div style="max-height:340px;overflow:auto;">
        <table class="audit-log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Operation</th>
              <th>DID</th>
              <th>Status</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch {
    if (countEl) {
      countEl.textContent = "error";
      countEl.className = "status-pill status-pill-bad";
    }
    el.innerHTML = '<div class="empty" style="padding:1.25rem;"><div class="empty-icon">⚠️</div><p>Could not load audit log</p></div>';
  }
}

// ── AGENTS TABLE ──────────────────────────────────────────────────────────────

let _allAgents  = [];   // full list from API
let _agFiltered = [];   // after search filter
let _agPage     = 1;
const _AG_PER_PAGE = 20;
let _agSelection = {};  // did → agent object for checked rows

function _updateBulkBar() {
  const selected = Object.values(_agSelection).filter(Boolean);
  const bar   = document.getElementById("agents-bulk-bar");
  const label = document.getElementById("bulk-bar-label");
  if (!bar) return;
  if (selected.length === 0) {
    bar.classList.remove("active");
  } else {
    bar.classList.add("active");
    label.textContent = `${selected.length} agent${selected.length !== 1 ? "s" : ""} selected`;
  }
}

function _initBulkActions() {
  document.getElementById("bulk-clear-sel")?.addEventListener("click", () => {
    _agSelection = {};
    document.querySelectorAll(".agent-row-check").forEach(cb => cb.checked = false);
    const all = document.getElementById("ag-select-all");
    if (all) all.checked = false;
    _updateBulkBar();
  });

  document.getElementById("bulk-make-private")?.addEventListener("click", async () => {
    await _bulkVisibility(true);
  });
  document.getElementById("bulk-make-public")?.addEventListener("click", async () => {
    await _bulkVisibility(false);
  });
  document.getElementById("bulk-export-json")?.addEventListener("click", () => {
    const agents = Object.values(_agSelection).filter(Boolean);
    const blob = new Blob([JSON.stringify(agents, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `agents-export-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
  });
  document.getElementById("bulk-deregister")?.addEventListener("click", async () => {
    const agents = Object.values(_agSelection).filter(Boolean);
    if (!agents.length) return;
    if (!confirm(`Deregister ${agents.length} agent${agents.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    const btn = document.getElementById("bulk-deregister");
    btn.disabled = true; btn.textContent = "Deregistering…";
    try {
      const res = await apiFetch("/pro/agents/bulk", {
        method: "DELETE",
        body: JSON.stringify({ dids: agents.map(a => a.did) }),
      });
      _agSelection = {};
      _updateBulkBar();
      await loadAgentsTable();
      _showToast(`Deregistered ${res.count} agent${res.count !== 1 ? "s" : ""}.`);
    } catch(e) {
      alert("Bulk deregister failed: " + e.message);
    } finally { btn.disabled = false; btn.textContent = "Deregister selected"; }
  });
}

async function _bulkVisibility(makePrivate) {
  const agents = Object.values(_agSelection).filter(Boolean);
  if (!agents.length) return;
  const btn = makePrivate
    ? document.getElementById("bulk-make-private")
    : document.getElementById("bulk-make-public");
  if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  try {
    const res = await apiFetch("/pro/agents/bulk-visibility", {
      method: "PATCH",
      body: JSON.stringify({ dids: agents.map(a => a.did), private: makePrivate }),
    });
    _agSelection = {};
    _updateBulkBar();
    await loadAgentsTable();
    _showToast(`Updated visibility for ${res.updated} agent${res.updated !== 1 ? "s" : ""}.`);
  } catch(e) {
    alert("Bulk visibility update failed: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = makePrivate ? "🔒 Make private" : "🌐 Make public"; }
  }
}

function _renderAgentRow(a) {
  const capsArr = Array.isArray(a.capabilities) ? a.capabilities : [];
  const caps = capsArr.length
    ? `<div class="caps-scroll">${capsArr.map(c => `<span class="cap-pill">${esc(String(c))}</span>`).join("")}</div>`
    : "";
  const lastActiveStr   = a.last_activity ? timeAgo(a.last_activity) : "—";
  const lastActiveClass = a.last_activity &&
    (Date.now() - new Date(a.last_activity).getTime()) < 86400000 * 7
    ? "last-active-fresh" : "last-active-old";
  const createdStr = a.created_at
    ? new Date(a.created_at).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" })
    : "—";
  const isPrivate = !!a.private;
  const privacyBtn = `<button
    class="privacy-toggle"
    data-did="${esc(a.did || "")}"
    data-private="${isPrivate}"
    title="${isPrivate ? "Private — click to make public" : "Public — click to make private"}"
    style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:5px;cursor:pointer;border:1px solid ${isPrivate ? "var(--yellow)" : "var(--border-dark)"};background:${isPrivate ? "var(--yellow-bg)" : "var(--surface2)"};color:${isPrivate ? "var(--yellow)" : "var(--muted)"};">
    ${isPrivate ? "🔒 private" : "🌐 public"}
  </button>`;
  const rotBadge = a.rotation_pending
    ? `<span title="Key rotation in progress" style="margin-left:0.35rem;font-size:0.68rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--yellow-bg,#fff8e1);color:var(--yellow,#b45309);border:1px solid var(--yellow,#b45309);vertical-align:middle;">⟳ rotation</span>`
    : "";

  // Health dot based on last_activity
  let healthDot = "";
  if (a.last_activity) {
    const ageMs = Date.now() - new Date(a.last_activity).getTime();
    const cls = ageMs < 86400000      ? "health-dot-green"   // < 1 day  → green
              : ageMs < 86400000 * 7  ? "health-dot-yellow"  // < 7 days → amber
              : "health-dot-grey";                            // older    → grey
    healthDot = `<span class="health-dot ${cls}" title="Last active ${timeAgo(a.last_activity)}"></span>`;
  } else {
    healthDot = `<span class="health-dot health-dot-grey" title="Never active"></span>`;
  }
  return `<tr
    data-name="${esc(a.name.toLowerCase())}"
    data-did="${esc((a.did || "").toLowerCase())}"
    data-caps="${esc(capsArr.join(" ").toLowerCase())}"
    data-raw-did="${esc(a.did || "")}">
    <td style="width:2rem;text-align:center;"><input type="checkbox" class="agent-row-check" data-did="${esc(a.did||"")}" style="cursor:pointer;" /></td>
    <td class="agent-name" style="display:flex;align-items:center;gap:0;">${healthDot}${esc(a.name)}${rotBadge}</td>
    <td class="did-mono" title="${esc(a.did || "")}">${esc(shortDid(a.did))}</td>
    <td>${caps || '<span style="color:var(--muted);font-size:0.8rem;">none</span>'}</td>
    <td style="text-align:center;font-weight:600;">${esc(String(a.audit_events ?? 0))}</td>
    <td class="${lastActiveClass}">${esc(lastActiveStr)}</td>
    <td style="color:var(--muted);font-size:0.78rem;">${esc(createdStr)}</td>
    <td>${privacyBtn}</td>
    <td style="white-space:nowrap;">
      <button class="agent-action-btn" data-action="details" data-did="${esc(a.did||"")}" data-name="${esc(a.name)}" title="View agent details, trust graph, recent activity">Details</button>
      <button class="agent-action-btn" data-action="verify" data-did="${esc(a.did||"")}" data-name="${esc(a.name)}" title="Test verify a signed payload against this agent" style="margin-left:0.3rem;">Test</button>
      <button class="agent-action-btn" data-action="snippets" data-did="${esc(a.did||"")}" data-name="${esc(a.name)}" title="Copy-paste code snippets for this agent" style="margin-left:0.3rem;">&lt;/&gt;</button>
    </td>
  </tr>`;
}

function _buildAgFiltered() {
  const q    = (document.getElementById("agent-search")?.value || "").trim().toLowerCase();
  const mode = document.querySelector("#agent-search-tags .search-tag-active")?.dataset.mode || "all";
  _agFiltered = !q ? [..._allAgents] : _allAgents.filter(a => {
    const name = (a.name || "").toLowerCase();
    const did  = (a.did  || "").toLowerCase();
    const caps = (Array.isArray(a.capabilities) ? a.capabilities : []).join(" ").toLowerCase();
    return mode === "name" ? name.includes(q)
         : mode === "did"  ? did.includes(q)
         : mode === "cap"  ? caps.split(" ").some(c => c.includes(q))
         : name.includes(q) || did.includes(q) || caps.includes(q);
  });
}

function _renderAgPage() {
  const el     = document.getElementById("agents-table");
  const label  = document.getElementById("agents-count-label");
  const status = document.getElementById("agent-search-status");
  const q      = (document.getElementById("agent-search")?.value || "").trim();
  const total  = _agFiltered.length;
  const pages  = Math.max(1, Math.ceil(total / _AG_PER_PAGE));
  _agPage      = Math.min(_agPage, pages);
  const start  = (_agPage - 1) * _AG_PER_PAGE;
  const slice  = _agFiltered.slice(start, start + _AG_PER_PAGE);

  if (q) {
    label.textContent  = `${total} of ${_allAgents.length} agent${_allAgents.length !== 1 ? "s" : ""}`;
    status.textContent = total === 0 ? `No agents match "${q}" — try a different term or switch filter` : `${total} result${total !== 1 ? "s" : ""} for "${q}"`;
  } else {
    label.textContent  = `${_allAgents.length} agent${_allAgents.length !== 1 ? "s" : ""}`;
    status.textContent = "";
  }

  el.innerHTML = `
    <div style="overflow:auto;">
      <table class="agents-table">
        <thead><tr>
          <th style="width:2rem;text-align:center;"><input type="checkbox" id="ag-select-all" title="Select all on this page" style="cursor:pointer;" /></th>
          <th>Name</th><th>DID</th><th>Capabilities</th>
          <th>Audit Events</th><th>Last Active</th><th>Registered</th>
          <th>Visibility</th><th></th>
        </tr></thead>
        <tbody>${slice.map(_renderAgentRow).join("")}</tbody>
      </table>
    </div>`;

  // Select-all for current page
  document.getElementById("ag-select-all")?.addEventListener("change", function() {
    el.querySelectorAll(".agent-row-check").forEach(cb => {
      cb.checked = this.checked;
      _agSelection[cb.dataset.did] = this.checked ? _allAgents.find(a => a.did === cb.dataset.did) : undefined;
      if (!this.checked) delete _agSelection[cb.dataset.did];
    });
    _updateBulkBar();
  });
  el.querySelectorAll(".agent-row-check").forEach(cb => {
    cb.checked = !!_agSelection[cb.dataset.did];
    cb.addEventListener("change", function() {
      if (this.checked) _agSelection[this.dataset.did] = _allAgents.find(a => a.did === this.dataset.did);
      else delete _agSelection[this.dataset.did];
      _updateBulkBar();
    });
  });

  // Pager
  const pagerEl = document.getElementById("agents-pager-wrap");
  if (!pagerEl) return;
  if (pages <= 1) { pagerEl.innerHTML = ""; return; }
  const end = Math.min(_agPage * _AG_PER_PAGE, total);
  pagerEl.innerHTML = `
    <div class="signing-pager">
      <button class="pager-btn" id="ag-pager-prev" ${_agPage <= 1 ? "disabled" : ""}>&#8592;</button>
      <span class="pager-label">
        <strong>${_agPage}</strong> of <strong>${pages}</strong>
        <span class="pager-range">(${start + 1}–${end} of ${total})</span>
      </span>
      <button class="pager-btn" id="ag-pager-next" ${_agPage >= pages ? "disabled" : ""}>&#8594;</button>
    </div>`;
  document.getElementById("ag-pager-prev")?.addEventListener("click", () => { _agPage--; _renderAgPage(); });
  document.getElementById("ag-pager-next")?.addEventListener("click", () => { _agPage++; _renderAgPage(); });
}

function _applyAgentSearch() {
  _agPage = 1;
  _buildAgFiltered();
  _renderAgPage();
}

function _initAgentSearch() {
  const input = document.getElementById("agent-search");
  const tags  = document.querySelectorAll("#agent-search-tags .search-tag");
  if (!input) return;

  input.addEventListener("input", _applyAgentSearch);

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; _applyAgentSearch(); input.blur(); }
  });

  tags.forEach(tag => {
    tag.addEventListener("click", () => {
      tags.forEach(t => t.classList.remove("search-tag-active"));
      tag.classList.add("search-tag-active");
      _applyAgentSearch();
      input.focus();
    });
  });
}

function _applyPrivacyResult(btn, newPrivate) {
  btn.dataset.private  = String(newPrivate);
  btn.title            = newPrivate ? "Private — click to make public" : "Public — click to make private";
  btn.style.border     = `1px solid ${newPrivate ? "var(--yellow)" : "var(--border-dark)"}`;
  btn.style.background = newPrivate ? "var(--yellow-bg)" : "var(--surface2)";
  btn.style.color      = newPrivate ? "var(--yellow)" : "var(--muted)";
  btn.textContent      = newPrivate ? "🔒 private" : "🌐 public";
  btn.disabled         = false;
}

async function _doPrivacyChange(btn, did, newPrivate) {
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await fetch(
      `${BASE}/agents/${encodeURIComponent(did)}/visibility?private=${newPrivate}`,
      { method: "PATCH", headers: { "x-api-key": apiKey } }
    );
    if (!res.ok) throw new Error((await res.json()).detail || res.status);
    _applyPrivacyResult(btn, newPrivate);
  } catch (e) {
    btn.textContent = "error";
    setTimeout(() => { _applyPrivacyResult(btn, !newPrivate); }, 1500);
  }
}

function _initPrivacyToggles() {
  const el = document.getElementById("agents-table");
  if (!el) return;
  el.addEventListener("click", (ev) => {
    // Confirm step: clicking "Confirm" after key entry
    const confirmBtn = ev.target.closest(".privacy-confirm-yes");
    if (confirmBtn) {
      const wrapper  = confirmBtn.closest(".privacy-confirm-wrap");
      const keyInput = wrapper?.querySelector(".privacy-key-input");
      const errEl    = wrapper?.querySelector(".privacy-key-error");
      const entered  = (keyInput?.value || "").trim();
      if (!entered) {
        if (errEl) { errEl.textContent = "Enter your API key."; errEl.style.display = ""; }
        keyInput?.focus();
        return;
      }
      if (entered !== apiKey) {
        if (errEl) { errEl.textContent = "Incorrect API key."; errEl.style.display = ""; }
        keyInput?.select();
        return;
      }
      const did = confirmBtn.dataset.did;
      const btn = wrapper?._origBtn;
      if (btn) { confirmBtn.closest("td").replaceChild(btn, wrapper); _doPrivacyChange(btn, did, false); }
      return;
    }

    // Cancel step
    const cancelBtn = ev.target.closest(".privacy-confirm-no");
    if (cancelBtn) {
      const wrapper = cancelBtn.closest(".privacy-confirm-wrap");
      const btn = wrapper?._origBtn;
      if (btn) cancelBtn.closest("td").replaceChild(btn, wrapper);
      return;
    }

    // Initial toggle click
    const btn = ev.target.closest(".privacy-toggle");
    if (!btn) return;
    const did       = btn.dataset.did;
    const isPrivate = btn.dataset.private === "true";

    if (isPrivate) {
      // private → public: show inline confirm
      const wrapper = document.createElement("span");
      wrapper.className = "privacy-confirm-wrap";
      wrapper._origBtn  = btn;
      wrapper.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.3rem;min-width:200px;">
          <span style="font-size:0.72rem;color:var(--text-2);font-weight:600;">Make public? Enter API key to confirm:</span>
          <div style="display:flex;gap:0.3rem;align-items:center;">
            <input class="privacy-key-input" type="password" placeholder="agentid_…" autocomplete="off" spellcheck="false"
              style="font-size:0.72rem;padding:0.2rem 0.45rem;border-radius:4px;border:1px solid var(--border-dark);font-family:inherit;flex:1;outline:none;min-width:0;" />
            <button class="privacy-confirm-yes" data-did="${esc(did)}"
              style="font-size:0.72rem;padding:0.2rem 0.5rem;border-radius:4px;border:1px solid var(--green);background:var(--green-bg);color:var(--green);cursor:pointer;font-family:inherit;white-space:nowrap;">Confirm</button>
            <button class="privacy-confirm-no"
              style="font-size:0.72rem;padding:0.2rem 0.45rem;border-radius:4px;border:1px solid var(--border-dark);background:var(--surface2);color:var(--muted);cursor:pointer;font-family:inherit;">✕</button>
          </div>
          <span class="privacy-key-error" style="font-size:0.7rem;color:var(--red);display:none;"></span>
        </div>`;
      btn.parentNode.replaceChild(wrapper, btn);
    } else {
      // public → private: no confirmation needed
      _doPrivacyChange(btn, did, true);
    }
  });
}

async function loadAgentsTable() {
  const el = document.getElementById("agents-table");
  try {
    const data = await apiFetch("/pro/analytics/agents");
    _allAgents = data.agents || [];

    if (!_allAgents.length) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">🤖</div><p>No agents registered yet</p></div>';
      document.getElementById("agents-count-label").textContent = "0 agents";
      document.getElementById("agents-pager-wrap").innerHTML = "";
      return;
    }

    _agPage = 1;
    _buildAgFiltered();
    _renderAgPage();

    // Init search, privacy controls, and bulk actions once per full load
    _initAgentSearch();
    _initPrivacyToggles();
    _initBulkActions();

  } catch {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load agents</p></div>';
  }
}

// ── SIGNING ACTIVITY ──────────────────────────────────────────────────────────

const _signing = { page: 1, pages: 1, total: 0, perPage: 20, didQuery: "", status: "", fromDate: "", toDate: "" };

function _relativeTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)    return Math.round(diff) + "s ago";
    if (diff < 3600)  return Math.round(diff / 60) + "m ago";
    if (diff < 86400) return Math.round(diff / 3600) + "h ago";
    return Math.round(diff / 86400) + "d ago";
  } catch { return ""; }
}

function _formatBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  return (n / 1024).toFixed(1) + " KB";
}

/**
 * Build the full-width expanded panel for a signing event.
 * Layout: a stacked vertical sequence of sections, each spanning the
 * full table width.  Each section has a heading row with a copy button
 * where useful.
 */
function _signingDetailPanel(e, i, payloadObj, payloadJson, sigFull, summary) {
  const innerMessage = payloadObj && (payloadObj.message || payloadObj.reason || payloadObj.action);
  const nonce        = payloadObj && payloadObj.nonce;
  const payloadTs    = payloadObj && payloadObj.timestamp;
  const sigBytes     = e.signature ? Math.floor(e.signature.length * 3 / 4) : null; // base64 → bytes

  // Drift between client-signed timestamp and the server-stored audit ts.
  let drift = "";
  if (payloadTs && e.timestamp) {
    try {
      const d = (new Date(e.timestamp).getTime() / 1000) - Number(payloadTs);
      drift = (d >= 0 ? "+" : "") + d.toFixed(1) + "s";
    } catch {}
  }

  const isValid = e.status === "valid";
  const statusBadge = isValid
    ? '<span style="background:#d1f4dd;color:#107a3a;font-size:0.72rem;font-weight:600;padding:0.15rem 0.55rem;border-radius:4px;">✓ valid</span>'
    : '<span style="background:#fbe2e2;color:#a82828;font-size:0.72rem;font-weight:600;padding:0.15rem 0.55rem;border-radius:4px;">✗ invalid</span>';

  const tsAbs = e.timestamp || "";
  const tsRel = _relativeTime(e.timestamp);

  const heading = (icon, label, copyText, copyKey) =>
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.3rem;">' +
      '<span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);">' +
        icon + ' ' + label +
      '</span>' +
      (copyText
        ? '<button data-copy-text="' + esc(copyText) + '" data-copy-key="' + copyKey + '" ' +
              'style="background:none;border:1px solid var(--border-dark);border-radius:4px;padding:0.05rem 0.45rem;' +
              'font-size:0.68rem;cursor:pointer;color:var(--muted);">copy</button>'
        : '') +
    '</div>';

  const sigCopy = e.signature
    ? '<button data-copy-text="' + esc(e.signature) + '" data-copy-key="sig-' + i + '" ' +
          'style="background:none;border:1px solid var(--border-dark);border-radius:4px;padding:0.05rem 0.45rem;' +
          'font-size:0.68rem;cursor:pointer;color:var(--muted);">copy</button>'
    : '';

  const detailRow = (label, value, mono) =>
    '<div style="display:flex;align-items:baseline;gap:0.6rem;font-size:0.78rem;padding:0.18rem 0;">' +
      '<span style="color:var(--muted);min-width:130px;">' + label + '</span>' +
      '<span style="' + (mono ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.74rem;' : '') +
        'color:var(--text);word-break:break-all;flex:1;">' + value + '</span>' +
    '</div>';

  return (
    '<div class="signing-detail" style="padding:0.85rem 1.1rem;display:flex;flex-direction:column;gap:0.85rem;">' +

      // ─── Verification metadata ─────────────────────────────────────
      '<div>' +
        heading('🔍', 'Verification') +
        detailRow('Result', statusBadge + (isValid ? '' :
          ' <span style="color:var(--muted);font-size:0.72rem;">— signature did not match the agent\'s public key</span>')) +
        detailRow('Recorded at', esc(tsAbs) + (tsRel ? ' <span style="color:var(--muted);">· ' + esc(tsRel) + '</span>' : '')) +
        (e.ip ? detailRow('Source IP', '<code style="font-size:0.74rem;">' + esc(e.ip) + '</code>', false) : '') +
      '</div>' +

      // ─── Parties ───────────────────────────────────────────────────
      '<div>' +
        heading('👥', 'Parties') +
        detailRow('Signer',
          (e.signer_name ? '<strong>' + esc(e.signer_name) + '</strong> · ' : '') +
          '<code style="font-size:0.74rem;">' + esc(e.signer_did || '—') + '</code>',
          false) +
        detailRow('Verifier',
          e.verifier_did
            ? (e.verifier_name ? '<strong>' + esc(e.verifier_name) + '</strong> · ' : '') +
              '<code style="font-size:0.74rem;">' + esc(e.verifier_did) + '</code>'
            : '<span style="color:var(--muted);font-style:italic;">external (not in your registry)</span>',
          false) +
      '</div>' +

      // ─── Message + payload internals ───────────────────────────────
      '<div>' +
        heading('💬', 'Message',
          innerMessage ? String(innerMessage) : null,
          'msg-' + i) +
        '<div style="font-size:0.82rem;color:var(--text);background:var(--surface);border:1px solid var(--border);' +
          'border-radius:4px;padding:0.45rem 0.6rem;line-height:1.45;word-break:break-word;">' +
          (innerMessage ? esc(String(innerMessage)) : '<span style="color:var(--muted);font-style:italic;">' + (summary || 'no message field') + '</span>') +
        '</div>' +
        (nonce || payloadTs ?
          '<div style="margin-top:0.45rem;display:flex;flex-wrap:wrap;gap:0.4rem 1.5rem;font-size:0.73rem;color:var(--muted);">' +
            (nonce ? '<span><strong>Nonce:</strong> <code>' + esc(String(nonce).slice(0,16)) + (String(nonce).length > 16 ? '…' : '') + '</code></span>' : '') +
            (payloadTs ? '<span><strong>Payload TS:</strong> ' + esc(new Date(Number(payloadTs)*1000).toISOString().slice(0,19) + 'Z') +
              (drift ? ' <span style="color:var(--muted);">(drift ' + esc(drift) + ')</span>' : '') + '</span>' : '') +
          '</div>' : '') +
      '</div>' +

      // ─── Signed payload (full JSON) ────────────────────────────────
      '<div>' +
        heading('📋', 'Signed payload (full)',
          payloadObj ? JSON.stringify(payloadObj) : null,
          'payload-' + i) +
        '<pre style="background:var(--surface);border:1px solid var(--border);border-radius:4px;' +
          'padding:0.6rem 0.75rem;font-size:0.72rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
          'color:var(--text);white-space:pre-wrap;line-height:1.5;margin:0;max-height:240px;overflow:auto;">' +
          payloadJson +
        '</pre>' +
      '</div>' +

      // ─── Signature ─────────────────────────────────────────────────
      '<div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.3rem;">' +
          '<span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);">' +
            '🔏 Signature ' +
            (e.signature ? '<span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);">' +
              '· Ed25519 · ' + _formatBytes(sigBytes) + ' (base64)</span>' : '') +
          '</span>' +
          sigCopy +
        '</div>' +
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;' +
          'padding:0.55rem 0.7rem;font-size:0.72rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
          'color:var(--text);word-break:break-all;line-height:1.5;">' + sigFull + '</div>' +
      '</div>' +

    '</div>'
  );
}

function payloadSummary(payload) {
  if (!payload) return "—";
  const msg = payload.reason || payload.message || payload.action || null;
  if (msg) return String(msg).slice(0, 80) + (String(msg).length > 80 ? "…" : "");
  const skip = new Set(["timestamp","nonce","action","did"]);
  for (const [k, v] of Object.entries(payload)) {
    if (!skip.has(k)) return `${k}: ${String(v).slice(0, 60)}`;
  }
  return "signed payload";
}

function _signingRows(events) {
  return events.map((e, i) => {
    const signerCell = e.signer_name
      ? `<span class="agent-name">${esc(e.signer_name)}</span>
         <div class="did-mono" style="font-size:0.7rem;">${esc(shortDid(e.signer_did))}</div>`
      : `<span class="did-mono">${esc(shortDid(e.signer_did))}</span>`;

    const verifierCell = e.verifier_name
      ? `<span class="agent-name">${esc(e.verifier_name)}</span>
         <div class="did-mono" style="font-size:0.7rem;">${esc(shortDid(e.verifier_did))}</div>`
      : e.verifier_did
        ? `<span class="did-mono">${esc(shortDid(e.verifier_did))}</span>`
        : `<span style="color:var(--muted);font-size:0.8rem;font-style:italic;">external</span>`;

    const isValid     = e.status === "valid";
    const statusCls   = isValid ? "status-ok" : "status-invalid";
    const statusLbl   = isValid ? "✓ valid" : "✗ invalid";
    const timeStr     = e.timestamp ? String(e.timestamp).slice(0, 19).replace("T"," ") : "—";

    // Payload may arrive as a dict (psycopg2 auto-deserialised JSONB) or as a
    // raw JSON string (older psycopg2 without JSONB casting) — normalise to object.
    let payloadObj = e.payload;
    if (typeof payloadObj === "string") {
      try { payloadObj = JSON.parse(payloadObj); } catch { payloadObj = null; }
    }

    const summary     = esc(payloadSummary(payloadObj));
    const payloadJson = payloadObj
      ? esc(JSON.stringify(payloadObj, null, 2))
      : '<span style="color:var(--muted);font-style:italic;">Not recorded — this event pre-dates payload logging</span>';
    const sigFull     = e.signature
      ? esc(e.signature)
      : '<span style="color:var(--muted);font-style:italic;">Not recorded — this event pre-dates signature logging</span>';

    const signerToken   = `${(e.signer_name||"").toLowerCase()} ${(e.signer_did||"").toLowerCase()}`;
    const verifierToken = `${(e.verifier_name||"").toLowerCase()} ${(e.verifier_did||"").toLowerCase()}`;
    const msgToken      = payloadSummary(payloadObj).toLowerCase();
    const statusToken   = (e.status || "").toLowerCase();

    return `
      <tr data-idx="${i}" style="cursor:pointer;user-select:none;"
          data-signer="${esc(signerToken)}"
          data-verifier="${esc(verifierToken)}"
          data-msg="${esc(msgToken)}"
          data-status="${esc(statusToken)}">
        <td class="time-cell">${esc(timeStr)}</td>
        <td>${signerCell}</td>
        <td style="text-align:center;color:var(--muted);font-size:1rem;">→</td>
        <td>${verifierCell}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8rem;color:var(--muted);">${summary}</td>
        <td>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span class="${statusCls}" style="font-size:0.8rem;">${statusLbl}</span>
            <span class="expand-btn" style="font-size:0.85rem;color:var(--muted);padding:0.1rem 0.3rem;">▸</span>
          </div>
        </td>
      </tr>
      <tr data-detail="${i}" style="display:none;background:var(--surface2);">
        <td colspan="6" style="padding:0;border-bottom:1px solid var(--border);">
          ${_signingDetailPanel(e, i, payloadObj, payloadJson, sigFull, summary)}
        </td>
      </tr>`;
  }).join("");
}

function _updatePager() {
  const wrap = document.getElementById("signing-pager-wrap");
  if (!wrap) return;
  const { page, pages, total, perPage } = _signing;
  if (pages <= 1) { wrap.innerHTML = ""; return; }
  const start = (page - 1) * perPage + 1;
  const end   = Math.min(page * perPage, total);
  wrap.innerHTML = `
    <div class="signing-pager">
      <button class="pager-btn" data-sign-nav="prev" ${page <= 1 ? "disabled" : ""}>&#8592;</button>
      <span class="pager-label">
        <strong>${page}</strong> of <strong>${pages}</strong>
        <span class="pager-range">(${start}–${end} of ${total})</span>
      </span>
      <button class="pager-btn" data-sign-nav="next" ${page >= pages ? "disabled" : ""}>&#8594;</button>
    </div>`;
}

function _initSigningPager() {
  // One permanent delegated listener on the static wrapper — survives table redraws
  const wrap = document.getElementById("signing-pager-wrap");
  if (!wrap) return;
  wrap.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-sign-nav]");
    if (!btn || btn.disabled || btn.hasAttribute("disabled")) return;
    const dir = btn.dataset.signNav;
    if (dir === "prev" && _signing.page > 1)            { _signing.page--; loadSigningActivity(); }
    if (dir === "next" && _signing.page < _signing.pages){ _signing.page++; loadSigningActivity(); }
  });
}

function _attachRowListeners() {
  // Expand/copy — re-attached each page load since tbody is rebuilt
  const tbody = document.getElementById("signing-tbody");
  if (!tbody) return;
  tbody.addEventListener("click", function (ev) {
    // New: generic per-section copy buttons inside the detail panel.
    const copyTextBtn = ev.target.closest("[data-copy-text]");
    if (copyTextBtn) {
      ev.stopPropagation();
      const txt = copyTextBtn.getAttribute("data-copy-text") || "";
      navigator.clipboard.writeText(txt).catch(() => {});
      const orig = copyTextBtn.textContent;
      copyTextBtn.textContent = "copied!";
      setTimeout(() => { copyTextBtn.textContent = orig; }, 1500);
      return;
    }
    // Legacy signature copy (still used elsewhere)
    const copyBtn = ev.target.closest("[data-copy]");
    if (copyBtn) {
      ev.stopPropagation();
      const sigEl = this.querySelector(`[data-sig="${copyBtn.dataset.copy}"]`);
      if (sigEl) navigator.clipboard.writeText(sigEl.textContent).catch(() => {});
      copyBtn.textContent = "copied!";
      setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
      return;
    }
    const mainRow = ev.target.closest("tr[data-idx]");
    if (!mainRow) return;
    const idx       = mainRow.dataset.idx;
    const detailRow = this.querySelector(`tr[data-detail="${idx}"]`);
    const btn       = mainRow.querySelector(".expand-btn");
    if (!detailRow) return;
    const nowOpen = detailRow.style.display === "none" || detailRow.style.display === "";
    detailRow.style.display = nowOpen ? "table-row" : "none";
    if (btn) btn.textContent = nowOpen ? "▾" : "▸";
  });
}

let _didSearchTimer = null;

function _applySigningSearch() {
  const rawQ   = (document.getElementById("signing-search")?.value || "").trim();
  const q      = rawQ.toLowerCase();
  const mode   = document.querySelector(".search-tag-active[data-smode]")?.dataset.smode || "all";
  const status = document.getElementById("signing-search-status");
  const tbody  = document.getElementById("signing-tbody");

  // DID mode OR query that looks like a DID (starts with "did:") → server-side search
  // across all pages so the user doesn't have to know to click the DID pill first.
  const looksLikeDid = rawQ.toLowerCase().startsWith("did:");
  if (mode === "did" || looksLikeDid) {
    clearTimeout(_didSearchTimer);
    _didSearchTimer = setTimeout(() => {
      if (rawQ === _signing.didQuery) return; // no change
      _signing.didQuery = rawQ;
      _signing.page = 1;           // reset to page 1 for new search
      loadSigningActivity();
    }, 350); // 350ms debounce
    if (status) status.textContent = rawQ ? "Searching across all pages…" : "";
    return;
  }

  // For non-DID modes: if a server-side DID search was active, clear it first
  if (_signing.didQuery) {
    _signing.didQuery = "";
    _signing.page = 1;
    loadSigningActivity();
    return;
  }

  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll("tr[data-idx]"));
  let visible = 0;

  rows.forEach(row => {
    const detail = tbody.querySelector(`tr[data-detail="${row.dataset.idx}"]`);
    let match = false;

    if (mode === "invalid") {
      match = row.dataset.status === "invalid";
      if (q) match = match && (
        row.dataset.signer.includes(q) ||
        row.dataset.verifier.includes(q) ||
        row.dataset.msg.includes(q)
      );
    } else if (!q) {
      match = true;
    } else if (mode === "all") {
      match = row.dataset.signer.includes(q) || row.dataset.verifier.includes(q) || row.dataset.msg.includes(q);
    } else if (mode === "signer") {
      match = row.dataset.signer.includes(q);
    } else if (mode === "verifier") {
      match = row.dataset.verifier.includes(q);
    } else if (mode === "msg") {
      match = row.dataset.msg.includes(q);
    }

    row.classList.toggle("agent-row-hidden", !match);
    row.classList.toggle("agent-row-highlight", match && (q.length > 0 || mode === "invalid"));
    if (detail) detail.classList.toggle("agent-row-hidden", !match);
    if (match) visible++;
  });

  const total = rows.length;
  if (q || mode === "invalid") {
    if (status) status.textContent = visible === 0
      ? `No events match — try a different term or filter`
      : `${visible} of ${total} events on this page`;
  } else {
    if (status) status.textContent = "";
  }
}

function _initSigningSearch() {
  const input = document.getElementById("signing-search");
  const tags  = document.querySelectorAll(".search-tag[data-smode]");
  if (!input) return;

  input.addEventListener("input", _applySigningSearch);
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      input.value = "";
      // Also clear any active server-side DID search
      if (_signing.didQuery) {
        _signing.didQuery = "";
        _signing.page = 1;
        loadSigningActivity();
      } else {
        _applySigningSearch();
      }
      input.blur();
    }
  });

  tags.forEach(tag => {
    tag.addEventListener("click", () => {
      tags.forEach(t => t.classList.remove("search-tag-active"));
      tag.classList.add("search-tag-active");
      _applySigningSearch();
      if (tag.dataset.smode !== "invalid" && tag.dataset.smode !== "did") input.focus();
      if (tag.dataset.smode === "did") input.focus();
    });
  });
}

async function loadSigningActivity() {
  const el    = document.getElementById("signing-table");
  const label = document.getElementById("signing-count-label");
  console.log("[dash] loadSigningActivity starting");
  try {
    const params = new URLSearchParams({
      page:     _signing.page,
      per_page: _signing.perPage,
    });
    if (_signing.didQuery)  params.set("q",       _signing.didQuery);
    if (_signing.status)    params.set("status",  _signing.status);
    if (_signing.fromDate)  params.set("from_ts", _signing.fromDate);
    if (_signing.toDate)    params.set("to_ts",   _signing.toDate);
    const data = await apiFetch(`/pro/analytics/signing?${params}`);
    const events = data.events || [];

    // Sync pagination state from server response
    _signing.total  = data.total  ?? events.length;
    _signing.pages  = data.pages  ?? 1;
    _signing.page   = data.page   ?? _signing.page;

    label.textContent = `${_signing.total} event${_signing.total !== 1 ? "s" : ""}`;

    // Update search status after DID search resolves
    const statusEl = document.getElementById("signing-search-status");
    if (statusEl && _signing.didQuery) {
      statusEl.textContent = _signing.total === 0
        ? `No events found for DID "${_signing.didQuery}"`
        : `${_signing.total} event${_signing.total !== 1 ? "s" : ""} matching DID "${_signing.didQuery}" (all pages)`;
    } else if (statusEl) {
      statusEl.textContent = "";
    }

    if (!events.length && _signing.page === 1) {
      el.innerHTML = `<div class="empty">
        <div class="empty-icon">🤝</div>
        <p>No signing events yet</p>
        <p style="font-size:0.78rem;margin-top:0.25rem;">
          Pass <code style="background:var(--surface2);padding:0.1rem 0.35rem;border-radius:4px;font-size:0.75rem;">verifier_did=agent.did</code>
          to <code style="background:var(--surface2);padding:0.1rem 0.35rem;border-radius:4px;font-size:0.75rem;">Agent.verify_from_did()</code>
          to log relationships here.
        </p>
      </div>`;
      return;
    }

    el.innerHTML = `
      <div style="overflow:auto;">
        <table class="agents-table" style="width:100%;">
          <thead><tr>
            <th>Time</th><th>Signer</th>
            <th style="color:var(--muted);">→</th>
            <th>Verified By</th><th>Message</th><th>Result</th>
          </tr></thead>
          <tbody id="signing-tbody">${_signingRows(events)}</tbody>
        </table>
      </div>`;

    _updatePager();
    _attachRowListeners();
    _applySigningSearch();   // re-apply active filter on new page

  } catch {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load signing activity</p></div>';
  }
}

// ── DISCOVERY STATS ───────────────────────────────────────────────────────────

async function loadDiscoveryStats() {
  try {
    const data = await apiFetch("/pro/analytics/searches");
    const stats = data.discovery_stats || [];
    const total = stats.reduce((s, r) => s + r.count, 0);
    document.getElementById("stat-discovery").textContent = total.toLocaleString();
  } catch {
    document.getElementById("stat-discovery").textContent = "—";
  }
}

// ── ANOMALY DETECTION ─────────────────────────────────────────────────────────

function _formatAnomalyTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60)        return Math.round(diff) + "s ago";
    if (diff < 3600)      return Math.round(diff / 60) + "m ago";
    if (diff < 86400)     return Math.round(diff / 3600) + "h ago";
    return d.toLocaleString();
  } catch { return iso; }
}

function _renderAnomalyDetail(a) {
  // Build the expanded view: metric table + DID list (when present) + meta.
  const m = a.metric || {};
  const rows = [];
  const fmt = v => {
    if (typeof v === "number") return v.toLocaleString(undefined, {maximumFractionDigits: 2});
    return String(v);
  };

  // Pretty labels for known metric keys
  const LABELS = {
    this_hour:         "Verifies this hour",
    avg_per_hour:      "7-day hourly average",
    ratio:             "Ratio (this hour / avg)",
    total:             "Total verify events (24h)",
    failed:            "Invalid verifies (24h)",
    rate_pct:          "Invalid rate (%)",
  };
  for (const [k, v] of Object.entries(m)) {
    if (k === "new_verifier_dids") continue;   // handled separately
    rows.push(
      '<div class="anomaly-metric-row">' +
        '<span class="anomaly-metric-label">' + esc(LABELS[k] || k) + '</span>' +
        '<span class="anomaly-metric-value">' + esc(fmt(v)) + '</span>' +
      '</div>'
    );
  }

  // New-verifier specific: list the DIDs as a vertical scrollable block
  let didsHtml = "";
  if (Array.isArray(m.new_verifier_dids) && m.new_verifier_dids.length) {
    didsHtml =
      '<div class="anomaly-dids-wrap">' +
        '<div class="anomaly-dids-title">New verifier DIDs (' +
          m.new_verifier_dids.length + ')</div>' +
        '<div class="anomaly-dids-list">' +
          m.new_verifier_dids.map(did =>
            '<div class="anomaly-did-row" title="Click to copy">' +
              '<code>' + esc(did) + '</code>' +
              '<button class="anomaly-did-copy" data-did="' + esc(did) +
                '" aria-label="Copy DID">⎘</button>' +
            '</div>'
          ).join("") +
        '</div>' +
      '</div>';
  }

  const detectedAt = a.detected_at ? _formatAnomalyTime(a.detected_at) : "";
  return (
    '<div class="anomaly-detail">' +
      (rows.length ? '<div class="anomaly-metrics">' + rows.join("") + '</div>' : "") +
      didsHtml +
      (detectedAt ? '<div class="anomaly-meta">Detected ' + esc(detectedAt) + '</div>' : "") +
    '</div>'
  );
}

async function loadAnomalies() {
  const el = document.getElementById("anomaly-list");
  const pill = document.getElementById("anomaly-status-pill");
  const stamp = document.getElementById("anomaly-last-updated");
  if (!el) return;
  el.innerHTML = '<div class="loading"><div class="spinner"></div> Requesting…</div>';
  console.log("[dash] loadAnomalies starting");
  try {
    const data = await apiFetch("/pro/anomalies");
    const anomalies = data.anomalies || [];

    // Header pill: summarise severity + count
    if (pill) {
      if (!anomalies.length) {
        pill.textContent = "all clear";
        pill.className = "status-pill status-pill-good";
      } else {
        const counts = anomalies.reduce((acc, a) => {
          const s = a.severity || "low";
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});
        const worst = counts.high ? "bad" : counts.medium ? "warn" : "info";
        const label = anomalies.length + " active" +
          (counts.high   ? " · " + counts.high   + " high"   : "") +
          (counts.medium ? " · " + counts.medium + " medium" : "") +
          (counts.low    ? " · " + counts.low    + " low"    : "");
        pill.textContent = label;
        pill.className = "status-pill status-pill-" + worst;
      }
    }
    if (stamp) stamp.textContent = "updated " + (new Date()).toLocaleTimeString();

    if (!anomalies.length) {
      el.innerHTML = `<div class="anomaly-clear" style="display:flex;align-items:center;gap:0.5rem;color:var(--text-2);font-size:0.85rem;padding:0.5rem 0;">
        <span style="font-size:1.1rem;">✓</span>
        <span>No anomalies detected · all signal patterns within expected bounds</span>
      </div>`;
      return;
    }
    el.innerHTML = anomalies.map((a, i) => {
      const sev = a.severity || "low";
      const sevColor = sev === "high" ? "var(--red)" : sev === "medium" ? "var(--yellow)" : "var(--blue)";
      const sevBg    = sev === "high" ? "var(--red-bg)" : sev === "medium" ? "var(--yellow-bg)" : "var(--blue-bg)";
      return (
        '<div class="anomaly-card" data-anomaly-idx="' + i + '" ' +
              'style="border-left:3px solid ' + sevColor + ';background:' + sevBg +
              ';border-radius:6px;padding:0.6rem 0.9rem;margin-bottom:0.5rem;cursor:pointer;">' +
          '<div class="anomaly-summary" style="display:flex;align-items:center;gap:0.5rem;">' +
            '<span class="anomaly-chevron" style="font-size:0.7rem;color:var(--muted);transition:transform 0.15s;">▶</span>' +
            '<span style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:' +
              sevColor + ';border:1px solid ' + sevColor +
              ';border-radius:999px;padding:0.1rem 0.45rem;">' + esc(sev) + '</span>' +
            '<span style="font-weight:600;font-size:0.88rem;">' + esc(a.title) + '</span>' +
            '<span style="font-size:0.72rem;color:var(--muted);margin-left:auto;">' +
              esc(_formatAnomalyTime(a.detected_at)) + '</span>' +
          '</div>' +
          '<p style="font-size:0.8rem;color:var(--text-2);margin:0.3rem 0 0 1.2rem;">' +
            esc(a.description) + '</p>' +
          _renderAnomalyDetail(a) +
        '</div>'
      );
    }).join("");

    // Expand/collapse handler
    el.querySelectorAll(".anomaly-card").forEach(card => {
      card.addEventListener("click", (e) => {
        // Don't toggle when clicking the copy button on a DID row
        if (e.target.closest(".anomaly-did-copy")) return;
        card.classList.toggle("expanded");
        const chev = card.querySelector(".anomaly-chevron");
        if (chev) chev.style.transform = card.classList.contains("expanded") ? "rotate(90deg)" : "rotate(0deg)";
      });
    });

    // DID copy handlers
    el.querySelectorAll(".anomaly-did-copy").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const did = btn.getAttribute("data-did");
        try {
          await navigator.clipboard.writeText(did);
          const orig = btn.textContent;
          btn.textContent = "✓";
          setTimeout(() => { btn.textContent = orig; }, 1200);
        } catch {}
      });
    });
  } catch (err) {
    console.error("[anomaly] load failed:", err);
    if (pill) {
      pill.textContent = "error";
      pill.className = "status-pill status-pill-bad";
    }
    if (el) {
      const msg = (err && err.message) ? String(err.message) : "unknown error";
      el.innerHTML = `<div class="anomaly-clear" style="color:var(--muted);font-size:0.8rem;padding:0.5rem 0;display:flex;flex-direction:column;gap:0.4rem;">
        <span>Could not load anomaly data</span>
        <code style="font-size:0.7rem;color:var(--red);background:var(--surface2);padding:0.2rem 0.4rem;border-radius:3px;display:inline-block;max-width:fit-content;">${esc(msg)}</code>
        <span style="font-size:0.7rem;">Check the browser console for full details.</span>
      </div>`;
    }
  }
}

// Wire the manual refresh button (delegated, attaches once on first load)
document.addEventListener("click", (e) => {
  if (e.target.closest("#anomaly-refresh")) {
    e.preventDefault();
    const btn = e.target.closest("#anomaly-refresh");
    btn.style.transform = "rotate(360deg)";
    btn.style.transition = "transform 0.5s";
    setTimeout(() => {
      btn.style.transform = "";
      btn.style.transition = "";
    }, 600);
    loadAnomalies();
  }
});

// ── REAL-TIME SSE ─────────────────────────────────────────────────────────────

let _sseSource = null;
let _sseReconnectTimer = null;
const SSE_TOAST_MAX = 5;   // max toasts shown at once

function _showSseToast(ev) {
  const container = document.getElementById("sse-toasts");
  if (!container) return;

  // Limit visible toasts
  while (container.children.length >= SSE_TOAST_MAX) {
    container.removeChild(container.firstChild);
  }

  const opCls = opClass(ev.operation || "");
  const toast = document.createElement("div");
  toast.className = "sse-toast";
  toast.innerHTML = `
    <span class="op-pill ${opCls}" style="font-size:0.7rem;">${esc(ev.operation || "event")}</span>
    <span style="font-size:0.78rem;color:var(--text-2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(shortDid(ev.did))}</span>
    <span class="${ev.status === "valid" || ev.status === "ok" ? "status-ok" : ev.status === "invalid" ? "status-invalid" : ""}" style="font-size:0.75rem;">${esc(ev.status || "")}</span>
  `;
  container.appendChild(toast);

  // Fade out and remove after 6 s
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.4s";
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

function _setSseDot(connected) {
  const dot = document.getElementById("sse-dot");
  if (!dot) return;
  dot.title = connected ? "Live — real-time events connected" : "Offline — reconnecting…";
  dot.style.background = connected ? "var(--green)" : "var(--muted)";
}

async function startSse() {
  if (!apiKey) return;
  stopSse();

  // Exchange the real API key for a short-lived SSE token so the API key
  // never appears in the EventSource URL (browser history, access logs).
  let url = `${BASE}/pro/stream?api_key=${encodeURIComponent(apiKey)}`;
  try {
    const tok = await apiFetch("/pro/sse-token", { method: "POST" });
    if (tok && tok.sse_token) {
      url = `${BASE}/pro/stream?sse_token=${encodeURIComponent(tok.sse_token)}`;
    }
  } catch { /* fall back to api_key param */ }

  _sseSource = new EventSource(url);

  _sseSource.addEventListener("connected", () => {
    _setSseDot(true);
  });

  _sseSource.addEventListener("audit", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      _showSseToast(data);
      // Refresh audit log silently in the background
      loadAuditLog();
      if (data.operation === "verify") loadSigningActivity();
    } catch { /* ignore parse errors */ }
  });

  _sseSource.addEventListener("timeout", () => {
    // Server closed the connection intentionally — reconnect in 2 s
    _setSseDot(false);
    stopSse();
    _sseReconnectTimer = setTimeout(startSse, 2000);
  });

  _sseSource.onerror = () => {
    _setSseDot(false);
    stopSse();
    // Exponential back-off: try again in 10 s
    _sseReconnectTimer = setTimeout(startSse, 10000);
  };
}

function stopSse() {
  clearTimeout(_sseReconnectTimer);
  if (_sseSource) {
    _sseSource.close();
    _sseSource = null;
  }
  _setSseDot(false);
}

// ── SETTINGS MODAL ───────────────────────────────────────────────────────────

function _modalMsg(id, text, type /* "ok" | "error" */) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `modal-msg ${type}`;
  el.style.display = "block";
}
function _modalMsgClear(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

// ── Account tab ───────────────────────────────────────────────────────────────

async function _loadAccountInfo() {
  try {
    // Fetch both key info and session/me info in parallel
    const [keyData, meData] = await Promise.allSettled([
      apiFetch("/pro/keys/me"),
      apiFetch("/auth/me"),
    ]);
    const key = keyData.status === "fulfilled" ? keyData.value : null;
    const me  = meData.status  === "fulfilled" ? meData.value  : null;

    const email = me?.email || key?.owner || "—";
    const tier  = me?.tier  || key?.tier  || "free";
    const authKind = me?.auth_kind || (key ? "api-key" : "unknown");

    // Avatar initials
    const avatar = document.getElementById("account-avatar");
    if (avatar) avatar.textContent = email.slice(0, 1).toUpperCase();

    // Email
    const emailEl = document.getElementById("account-email-display");
    if (emailEl) emailEl.textContent = email;

    // Tier badge
    const tierBadge = document.getElementById("account-tier-badge");
    if (tierBadge) {
      const tierColors = { enterprise: "#059669", pro: "#2563EB", free: "#78716C" };
      const tierLabels = { enterprise: "Enterprise ✓", pro: "Pro ✓", free: "Free" };
      tierBadge.textContent = tierLabels[tier] || tier;
      tierBadge.style.background = "transparent";
      tierBadge.style.color  = tierColors[tier] || "var(--muted)";
      tierBadge.style.border = `1px solid ${tierColors[tier] || "var(--border)"}`;
    }

    // Auth kind
    const authEl = document.getElementById("account-auth-kind");
    if (authEl) authEl.textContent = authKind === "session" ? "signed in with " + (me?.email?.includes("@") ? "email / OAuth" : "OAuth") : "API key";

    // Show/hide change-password section (only for session auth)
    const changePwSection = document.getElementById("change-pw-section");
    if (changePwSection) changePwSection.style.display = authKind === "session" ? "block" : "none";

    // Pre-fill allowlist
    const ta = document.getElementById("allowlist-input");
    if (ta && key?.allowed_ips) ta.value = key.allowed_ips;

    // Usage section — fetch agent count
    try {
      const agents = await apiFetch("/agents?limit=1");
      const total  = agents?.total ?? agents?.length ?? null;
      const tierLimits = { free: 100, pro: 10000, enterprise: null };
      const max = tierLimits[tier];
      const usageSection = document.getElementById("account-usage-section");
      const usageRows    = document.getElementById("account-usage-rows");
      if (usageSection && usageRows && total !== null) {
        usageSection.style.display = "block";
        const pct = max ? Math.min(100, Math.round(100 * total / max)) : 0;
        usageRows.innerHTML = `
          <div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:0.3rem;">
              <span>Agents registered</span>
              <span style="font-weight:600;">${total}${max ? " / " + max : " / unlimited"}</span>
            </div>
            <div style="height:6px;background:var(--border);border-radius:99px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${pct > 80 ? "var(--red)" : "var(--accent)"};border-radius:99px;transition:width 0.4s;"></div>
            </div>
            ${max && pct > 80 ? '<div style="font-size:0.72rem;color:var(--red);margin-top:0.2rem;">Approaching limit — consider upgrading</div>' : ""}
          </div>`;
      }
    } catch (_) {}

  } catch (err) {
    const emailEl = document.getElementById("account-email-display");
    if (emailEl) emailEl.textContent = "Could not load account info";
  }
}

async function _saveAllowlist() {
  const btn = document.getElementById("allowlist-save-btn");
  const val = (document.getElementById("allowlist-input")?.value || "").trim();
  _modalMsgClear("allowlist-msg");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const res = await fetch(`${BASE}/pro/keys/allowlist`, {
      method:  "PATCH",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body:    JSON.stringify({ allowed_ips: val || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.status);
    _modalMsg("allowlist-msg", data.message || "Allowlist updated.", "ok");
    // Refresh the info rows
    _loadAccountInfo();
  } catch (e) {
    _modalMsg("allowlist-msg", `Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Allowlist";
  }
}

// ── Team Keys tab ─────────────────────────────────────────────────────────────

async function _createTeamKey() {
  const btn    = document.getElementById("team-key-create-btn");
  const label  = (document.getElementById("team-key-label")?.value || "").trim();
  const boxes  = document.querySelectorAll("#tab-team-keys .scope-option input[type='checkbox']");
  const scopes = Array.from(boxes).filter(b => b.checked).map(b => b.value);

  _modalMsgClear("team-key-msg");
  document.getElementById("team-key-reveal").style.display = "none";

  if (!label) {
    _modalMsg("team-key-msg", "Please enter a label for the team key.", "error");
    return;
  }
  if (!scopes.length) {
    _modalMsg("team-key-msg", "Select at least one scope.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const params = new URLSearchParams({ label, scopes: scopes.join(",") });
    const res = await fetch(`${BASE}/pro/keys/team?${params}`, {
      method:  "POST",
      headers: { "x-api-key": apiKey },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.status);

    // Show key once
    document.getElementById("team-key-value").textContent = data.key;
    document.getElementById("team-key-scopes-display").textContent =
      `Scopes: ${data.scopes}`;
    document.getElementById("team-key-reveal").style.display = "block";
    document.getElementById("team-key-label").value = "";
    boxes.forEach(b => { b.checked = b.value === "read"; }); // reset to default

  } catch (e) {
    _modalMsg("team-key-msg", `Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Team Key";
  }
}

// ── Key Rotation tab ──────────────────────────────────────────────────────────

async function _loadRotationAgentList() {
  const wrap = document.getElementById("rotation-agent-list");
  if (!wrap) return;
  try {
    const data = await apiFetch("/pro/analytics/agents");
    const agents = (data.agents || []).slice(0, 20); // cap at 20 for UI
    if (!agents.length) {
      wrap.innerHTML = `<p style="font-size:0.82rem;color:var(--muted);">No agents registered yet.</p>`;
      return;
    }
    // Fetch rotation status for each in parallel (best-effort)
    const statuses = await Promise.allSettled(
      agents.map(a =>
        fetch(`${BASE}/agents/${encodeURIComponent(a.did)}/rotation`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );

    wrap.innerHTML = agents.map((a, i) => {
      const st = statuses[i].status === "fulfilled" ? statuses[i].value : null;
      const pending = st && st.rotation_pending;
      const badgeCls = pending ? "pending" : "none";
      const badgeTxt = pending ? "rotation pending" : "no rotation";
      const expiry   = pending && st.rotation_expires_at
        ? `expires ${String(st.rotation_expires_at).slice(0, 10)}`
        : "";
      return `<div class="rotation-agent-row">
        <div>
          <div style="font-size:0.82rem;font-weight:600;">${esc(a.name)}</div>
          <div class="did-mono" style="font-size:0.7rem;">${esc(shortDid(a.did))}</div>
        </div>
        <div style="text-align:right;">
          <span class="rotation-badge ${badgeCls}">${badgeTxt}</span>
          ${expiry ? `<div style="font-size:0.68rem;color:var(--muted);margin-top:0.2rem;">${esc(expiry)}</div>` : ""}
          ${pending
            ? `<button class="btn btn-outline" data-cancel-did="${esc(a.did)}"
                style="font-size:0.7rem;padding:0.2rem 0.5rem;margin-top:0.3rem;color:var(--red);border-color:var(--red);">
                Cancel</button>`
            : `<button class="btn btn-outline" data-prefill-did="${esc(a.did)}"
                style="font-size:0.7rem;padding:0.2rem 0.5rem;margin-top:0.3rem;">
                Rotate</button>`}
        </div>
      </div>`;
    }).join("");

    // Wire up quick-fill buttons
    wrap.querySelectorAll("[data-prefill-did]").forEach(btn => {
      btn.addEventListener("click", () => {
        const input = document.getElementById("rotation-did-input");
        if (input) { input.value = btn.dataset.prefillDid; input.focus(); }
      });
    });

    // Wire up cancel buttons (informational only — full cancel requires signed payload via SDK)
    wrap.querySelectorAll("[data-cancel-did]").forEach(btn => {
      btn.addEventListener("click", () => {
        _modalMsg("rotation-msg",
          "Cancelling a rotation requires a signed payload from your SDK. "
          + `Use: agent.cancel_rotation('${btn.dataset.cancelDid}')`,
          "error");
      });
    });

  } catch {
    wrap.innerHTML = `<p style="font-size:0.82rem;color:var(--muted);">Could not load agents.</p>`;
  }
}

async function _checkRotationStatus() {
  const did = (document.getElementById("rotation-did-input")?.value || "").trim();
  const box = document.getElementById("rotation-status-box");
  _modalMsgClear("rotation-msg");
  if (!did) {
    _modalMsg("rotation-msg", "Enter an agent DID to check.", "error");
    return;
  }
  try {
    const res = await fetch(`${BASE}/agents/${encodeURIComponent(did)}/rotation`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.status);
    box.style.display = "block";
    if (data.rotation_pending) {
      box.innerHTML = `
        <span style="color:var(--yellow);font-weight:600;">⏳ Rotation pending</span><br>
        Grace period expires: <strong>${esc(String(data.rotation_expires_at).slice(0, 19).replace("T"," "))}</strong><br>
        <span style="color:var(--muted);font-size:0.75rem;margin-top:0.35rem;display:block;">
          Call <code style="background:var(--surface);padding:0.1rem 0.3rem;border-radius:4px;">agent.confirm_rotation(did)</code> signed with the new key to complete.
        </span>`;
    } else {
      box.innerHTML = `<span style="color:var(--green);font-weight:600;">✓ No pending rotation</span>
        ${data.note ? `<span style="color:var(--muted);font-size:0.75rem;margin-left:0.5rem;">(${esc(data.note)})</span>` : ""}`;
    }
  } catch (e) {
    _modalMsg("rotation-msg", `Error: ${e.message}`, "error");
    box.style.display = "none";
  }
}

// ── Webhooks tab ─────────────────────────────────────────────────────────────

const WH_EVENTS = [
  "agent.registered", "agent.deregistered", "agent.updated",
  "verification.succeeded", "verification.failed",
  "key.created", "key.revoked",
];

function _initWebhookEventGrid() {
  const grid = document.getElementById("wh-events-grid");
  if (!grid || grid.children.length) return; // already populated
  grid.innerHTML = WH_EVENTS.map(ev => `
    <label class="scope-option" style="font-size:0.78rem;">
      <input type="checkbox" value="${esc(ev)}" />
      <span style="font-size:0.76rem;color:var(--text);">${esc(ev)}</span>
    </label>`).join("");
}

async function _loadWebhooks() {
  const el = document.getElementById("webhooks-list");
  if (!el) return;
  try {
    const data = await apiFetch("/pro/webhooks");
    if (!data.length) {
      el.innerHTML = `<p style="font-size:0.82rem;color:var(--muted);">No webhooks yet — add one below.</p>`;
      return;
    }
    el.innerHTML = data.map(wh => {
      const evList = (wh.events || []).map(e => `<span style="font-size:0.68rem;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:0.1rem 0.35rem;">${esc(e)}</span>`).join(" ");
      const lastFired = wh.last_fired_at ? timeAgo(wh.last_fired_at) : "never";
      const statusColor = wh.active ? "var(--green)" : "var(--red)";
      const statusTxt   = wh.active ? "active" : "disabled";
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:0.7rem 0.9rem;margin-bottom:0.5rem;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.8rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(wh.url)}">${esc(wh.url)}</div>
            <div style="margin-top:0.3rem;display:flex;flex-wrap:wrap;gap:0.25rem;">${evList}</div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:0.3rem;">Last fired: ${esc(lastFired)} · Failures: ${esc(String(wh.failure_count))}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.3rem;align-items:flex-end;">
            <span style="font-size:0.7rem;font-weight:700;color:${statusColor};border:1px solid ${statusColor};border-radius:999px;padding:0.1rem 0.45rem;">${statusTxt}</span>
            <div style="display:flex;gap:0.3rem;flex-wrap:wrap;">
              <button class="btn btn-outline" data-wh-logs="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Logs</button>
              <button class="btn btn-outline" data-wh-test="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Test</button>
              <button class="btn btn-outline" data-wh-toggle="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;">${wh.active ? "Disable" : "Enable"}</button>
              <button class="btn btn-outline" data-wh-delete="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;color:var(--red);border-color:var(--red);">Delete</button>
            </div>
          </div>
        </div>
        <div id="wh-logs-${wh.id}" style="display:none;margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.65rem;"></div>
      </div>`;
    }).join("");

    // Wire up action buttons
    el.querySelectorAll("[data-wh-logs]").forEach(btn => {
      btn.addEventListener("click", () => _toggleDeliveryLog(Number(btn.dataset.whLogs), btn));
    });
    el.querySelectorAll("[data-wh-test]").forEach(btn => {
      btn.addEventListener("click", () => _webhookAction("test", Number(btn.dataset.whTest), btn));
    });
    el.querySelectorAll("[data-wh-toggle]").forEach(btn => {
      btn.addEventListener("click", () => _webhookAction("toggle", Number(btn.dataset.whToggle), btn));
    });
    el.querySelectorAll("[data-wh-delete]").forEach(btn => {
      btn.addEventListener("click", () => _webhookAction("delete", Number(btn.dataset.whDelete), btn));
    });
  } catch {
    el.innerHTML = `<p style="font-size:0.82rem;color:var(--red);">Could not load webhooks.</p>`;
  }
}

async function _toggleDeliveryLog(id, btn) {
  const panel = document.getElementById(`wh-logs-${id}`);
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  if (isOpen) {
    panel.style.display = "none";
    btn.textContent = "Logs";
    return;
  }
  btn.textContent = "Loading…"; btn.disabled = true;
  panel.style.display = "";
  panel.innerHTML = `<div style="font-size:0.75rem;color:var(--muted);">Loading delivery log…</div>`;
  try {
    const data = await apiFetch(`/pro/webhooks/${id}/deliveries?limit=50`);
    const rows = data.deliveries || [];
    if (!rows.length) {
      panel.innerHTML = `<p style="font-size:0.78rem;color:var(--muted);">No deliveries recorded yet.</p>`;
    } else {
      panel.innerHTML = `
        <div style="font-size:0.72rem;font-weight:600;color:var(--muted);margin-bottom:0.4rem;text-transform:uppercase;letter-spacing:0.04em;">Last ${rows.length} deliveries</div>
        <div style="overflow:auto;max-height:260px;">
          <table style="width:100%;border-collapse:collapse;font-size:0.75rem;">
            <thead>
              <tr style="background:var(--surface2);">
                <th style="padding:0.3rem 0.5rem;text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);">Time</th>
                <th style="padding:0.3rem 0.5rem;text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);">Event</th>
                <th style="padding:0.3rem 0.5rem;text-align:center;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);">Status</th>
                <th style="padding:0.3rem 0.5rem;text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);">Details</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const ok = r.success;
                const ts = r.attempted_at ? new Date(r.attempted_at).toLocaleString() : "—";
                const statusHtml = ok
                  ? `<span style="color:var(--green);font-weight:700;">✓ ${r.status_code ?? "2xx"}</span>`
                  : `<span style="color:var(--red);font-weight:700;">✗ ${r.status_code ?? "err"}</span>`;
                const detail = r.error ? esc(r.error) : (ok ? "—" : "no response");
                return `<tr style="border-bottom:1px solid var(--border);">
                  <td style="padding:0.3rem 0.5rem;color:var(--muted);white-space:nowrap;">${esc(ts)}</td>
                  <td style="padding:0.3rem 0.5rem;font-family:'JetBrains Mono',monospace;">${esc(r.event_type || "—")}</td>
                  <td style="padding:0.3rem 0.5rem;text-align:center;">${statusHtml}</td>
                  <td style="padding:0.3rem 0.5rem;color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.error||"")}">${detail}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`;
    }
  } catch(e) {
    panel.innerHTML = `<p style="font-size:0.78rem;color:var(--red);">Could not load logs: ${esc(e.message)}</p>`;
  }
  btn.textContent = "Hide logs"; btn.disabled = false;
}

async function _webhookAction(action, id, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    let res;
    if (action === "test") {
      res = await fetch(`${BASE}/pro/webhooks/${id}/test`, { method: "POST", headers: { "x-api-key": apiKey } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.status);
      btn.textContent = data.delivered ? "✓ sent" : "✗ failed";
    } else if (action === "toggle") {
      res = await fetch(`${BASE}/pro/webhooks/${id}/toggle`, { method: "PATCH", headers: { "x-api-key": apiKey } });
      if (!res.ok) throw new Error((await res.json()).detail || res.status);
      await _loadWebhooks();
      return;
    } else if (action === "delete") {
      if (!confirm("Delete this webhook? This cannot be undone.")) { btn.disabled = false; btn.textContent = orig; return; }
      res = await fetch(`${BASE}/pro/webhooks/${id}`, { method: "DELETE", headers: { "x-api-key": apiKey } });
      if (!res.ok) throw new Error(res.status);
      await _loadWebhooks();
      return;
    }
  } catch (e) {
    btn.textContent = "error";
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
}

async function _createWebhook() {
  const btn    = document.getElementById("wh-create-btn");
  const url    = (document.getElementById("wh-url-input")?.value || "").trim();
  const secret = (document.getElementById("wh-secret-input")?.value || "").trim() || null;
  const events = Array.from(
    document.querySelectorAll("#wh-events-grid input[type='checkbox']:checked")
  ).map(cb => cb.value);

  _modalMsgClear("wh-create-msg");
  document.getElementById("wh-secret-reveal").style.display = "none";

  if (!url) { _modalMsg("wh-create-msg", "Enter a webhook URL.", "error"); return; }
  if (!events.length) { _modalMsg("wh-create-msg", "Select at least one event type.", "error"); return; }

  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const res = await fetch(`${BASE}/pro/webhooks`, {
      method:  "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body:    JSON.stringify({ url, secret, events }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.status);

    // Show secret once
    document.getElementById("wh-secret-value").textContent = data.secret;
    document.getElementById("wh-secret-reveal").style.display = "block";

    // Reset form
    document.getElementById("wh-url-input").value = "";
    document.getElementById("wh-secret-input").value = "";
    document.querySelectorAll("#wh-events-grid input").forEach(cb => { cb.checked = false; });

    // Reload list
    await _loadWebhooks();
  } catch (e) {
    _modalMsg("wh-create-msg", `Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Webhook";
  }
}

// ── Modal open / close / tab switching ───────────────────────────────────────

// ── AGENT DETAIL DRAWER ──────────────────────────────────────────────────────

// ── AGENT CONTROL PANEL DRAWER ───────────────────────────────────────────────
// Four tabs. Loaded one-shot from /pro/agents/{did}/control, then refreshed
// per-tab as needed. Built so the user feels in control: every action lives
// here, not buried in separate modals.

let _adState = { did: null, data: null, tab: "overview" };

async function _openAgentDetail(did, name) {
  const drawer = document.getElementById("agent-drawer");
  const body   = document.getElementById("ad-body");
  if (!drawer) return;
  document.getElementById("ad-name").textContent = name || "(unnamed)";
  document.getElementById("ad-did").textContent  = did;
  drawer.classList.add("open");
  body.innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>';
  _adState = { did, data: null, tab: "overview" };

  try {
    const data = await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/control");
    _adState.data = data;
    _adRender();
  } catch (e) {
    const msg = String(e.message || "");
    // 401 from server = auth dropped. Diagnose & guide the user to recovery.
    if (msg.toLowerCase().includes("api key") || msg === "401") {
      const hasKey   = !!(apiKey || sessionStorage.getItem("agentid_key"));
      const hasMode  = sessionStorage.getItem("agentid_auth_mode") || "(unset)";
      body.innerHTML = `
        <div style="padding:1.4rem;">
          <div style="color:var(--red);font-weight:600;margin-bottom:0.55rem;">Session has dropped — please sign in again</div>
          <div style="font-size:0.82rem;color:var(--text-2);line-height:1.55;margin-bottom:1rem;">
            Your authentication didn't reach the server. The session cookie or API key is missing or expired.
          </div>
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:0.75rem 0.9rem;font-size:0.78rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;margin-bottom:1rem;">
            <div>auth mode  : <strong>${esc(hasMode)}</strong></div>
            <div>API key in storage: <strong>${hasKey ? "yes" : "no"}</strong></div>
            <div>server reply: <strong>${esc(msg)}</strong></div>
          </div>
          <div style="display:flex;gap:0.5rem;">
            <button class="btn btn-primary" id="ad-relogin">Sign out and sign in again</button>
            <button class="btn btn-outline" id="ad-hardrefresh">Hard refresh</button>
          </div>
        </div>`;
      document.getElementById("ad-relogin")?.addEventListener("click", () => logout());
      document.getElementById("ad-hardrefresh")?.addEventListener("click", () => location.reload(true));
    } else {
      body.innerHTML = `<div style="padding:1rem;color:var(--red);font-size:0.85rem;">
        Could not load agent: ${esc(msg)}<br>
        <span style="color:var(--muted);font-size:0.78rem;">Hard-refresh the dashboard if Railway recently redeployed.</span>
      </div>`;
    }
  }
}

function _adRender() {
  const body = document.getElementById("ad-body");
  if (!body || !_adState.data) return;

  // Tab nav
  const tabs = ["overview", "activity", "settings", "danger"];
  const labels = { overview: "Overview", activity: "Activity", settings: "Settings", danger: "Danger" };

  body.innerHTML = `
    <div class="ad-tabs">
      ${tabs.map(t => `
        <button class="ad-tab ${_adState.tab === t ? 'active' : ''}" data-ad-tab="${t}">
          ${labels[t]}
          ${t === 'danger' ? '<span style="color:var(--red);margin-left:0.25rem;">●</span>' : ''}
        </button>`).join("")}
    </div>
    <div id="ad-tab-content" style="padding:1rem 1.4rem;">
      ${_adRenderTab(_adState.tab)}
    </div>`;

  body.querySelectorAll(".ad-tab").forEach(b => b.addEventListener("click", () => {
    _adState.tab = b.getAttribute("data-ad-tab");
    _adRender();
  }));
  _adWireTabActions();
}

function _adRenderTab(tab) {
  const d = _adState.data;
  if (!d) return "<div>Loading…</div>";
  if (tab === "overview") return _adTabOverview(d);
  if (tab === "activity") return _adTabActivity(d);
  if (tab === "settings") return _adTabSettings(d);
  if (tab === "danger")   return _adTabDanger(d);
  return "";
}

function _adTabOverview(d) {
  const a = d.agent;
  const s = d.stats;
  const t = d.trust;
  const totalSign = s.sign_valid + s.sign_invalid;
  const failPct   = totalSign > 0 ? Math.round(100 * s.sign_invalid / totalSign) : 0;

  // Status line — most important thing first
  const statusParts = [];
  if (t.compromised)
    statusParts.push(`<span class="status-pill status-pill-bad">⚠ ${esc(t.severity || "compromised")}</span>`);
  else
    statusParts.push('<span class="status-pill status-pill-good">✓ trusted</span>');
  if (d.deprecation)
    statusParts.push('<span class="status-pill status-pill-warn">deprecated</span>');
  statusParts.push(a.private
    ? '<span class="status-pill status-pill-warn">private</span>'
    : '<span class="status-pill status-pill-good">public</span>');

  // Mini activity feed — last 3 events
  const recentEvents = (d.activity || []).slice(0, 3);
  const miniActivity = recentEvents.length
    ? recentEvents.map(e => {
        const pill = e.status === "valid"
          ? '<span class="status-pill status-pill-good" style="font-size:0.65rem;padding:0.1rem 0.4rem;">valid</span>'
          : '<span class="status-pill status-pill-bad"  style="font-size:0.65rem;padding:0.1rem 0.4rem;">invalid</span>';
        const who = e.is_self_signer
          ? (e.verifier_name || (e.verifier_did ? e.verifier_did.slice(-8) : "external"))
          : (e.signer_name   || (e.signer_did   ? e.signer_did.slice(-8)   : "external"));
        const arrow = e.is_self_signer ? "signed →" : "verified by ←";
        return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;border-bottom:1px solid var(--border);font-size:0.78rem;">
          ${pill}
          <span style="color:var(--muted);flex:1;">${esc(arrow)} <strong style="color:var(--text-2);">${esc(who)}</strong></span>
          <span style="color:var(--muted);font-size:0.72rem;white-space:nowrap;">${esc(_relativeTime(e.ts))}</span>
        </div>`;
      }).join("")
    : `<div style="color:var(--muted);font-size:0.78rem;padding:0.5rem 0;">No activity yet — sign or verify a message to see it here.</div>`;

  return `
    <!-- Identity header -->
    <div class="ad-section" style="padding-bottom:0;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;margin-bottom:0.55rem;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:1rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.name)}</div>
          <div style="font-size:0.7rem;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:0.15rem;">${esc(a.did)}</div>
        </div>
        <div style="display:flex;gap:0.35rem;flex-wrap:wrap;flex-shrink:0;">${statusParts.join("")}</div>
      </div>

      <!-- Capabilities -->
      <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.55rem;">
        ${(a.capabilities||[]).map(c => `<span class="op-pill op-pill-other">${esc(c)}</span>`).join("") || '<span style="color:var(--muted);font-size:0.78rem;">no capabilities</span>'}
        ${(d.tags||[]).map(tg => `<span class="status-pill status-pill-info">${esc(tg)}</span>`).join("")}
      </div>

      <div style="font-size:0.75rem;color:var(--muted);">
        Created ${esc(_relativeTime(a.created_at) || a.created_at || "—")}
        ${s.last_seen ? " · last active " + esc(_relativeTime(s.last_seen)) : " · never active"}
      </div>
    </div>

    <!-- Mini stats row -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin:0.85rem 0;">
      ${[
        [s.sign_valid + s.sign_invalid, "Signed",     `${s.sign_valid}✓ ${s.sign_invalid}✗`],
        [s.verif_valid + s.verif_invalid,"Verified",  `${s.verif_valid}✓ ${s.verif_invalid}✗`],
        [failPct + "%",                  "Fail rate",  failPct > 20 ? "⚠ high" : "normal"],
        [s.sign_24h,                     "Last 24h",   s.last_seen ? _relativeTime(s.last_seen) : "—"],
      ].map(([n,l,sub]) => `
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.6rem 0.7rem;text-align:center;">
          <div style="font-size:1.05rem;font-weight:700;color:var(--text);">${n}</div>
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:0.1rem 0;">${l}</div>
          <div style="font-size:0.65rem;color:var(--muted);">${sub}</div>
        </div>`).join("")}
    </div>

    <!-- Recent activity -->
    <div class="ad-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
        <h4 style="margin:0;">Recent activity</h4>
        <button class="btn btn-outline" data-ad-action="full-activity" style="font-size:0.72rem;padding:0.2rem 0.55rem;">See all →</button>
      </div>
      ${miniActivity}
    </div>

    <!-- Quick actions -->
    <div class="ad-section">
      <h4>Actions</h4>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button class="btn btn-outline" data-ad-action="test"     style="font-size:0.78rem;padding:0.3rem 0.7rem;">Test verify</button>
        <button class="btn btn-outline" data-ad-action="snippets" style="font-size:0.78rem;padding:0.3rem 0.7rem;">Code snippets</button>
        <button class="btn btn-outline" data-copy-trust-badge="${esc(a.did)}" style="font-size:0.78rem;padding:0.3rem 0.7rem;">Copy badge</button>
        <button class="btn btn-outline" data-ad-action="copy-did" style="font-size:0.78rem;padding:0.3rem 0.7rem;">Copy DID</button>
      </div>
    </div>

    <!-- Expandable: identity detail -->
    <details class="ad-section" style="cursor:pointer;">
      <summary style="font-size:0.8rem;font-weight:600;color:var(--muted);list-style:none;display:flex;align-items:center;gap:0.35rem;">
        <span>▸</span> Full identity &amp; keys
      </summary>
      <div class="ad-kv" style="margin-top:0.6rem;">
        <span class="k">Owner</span><span class="v">${esc(a.owner)}</span>
        <span class="k">Public key</span><span class="v"><code style="font-size:0.7rem;word-break:break-all;">${esc(a.public_key)}</code></span>
        <span class="k">DID</span><span class="v"><code style="font-size:0.7rem;word-break:break-all;">${esc(a.did)}</code></span>
        ${d.deprecation ? `<span class="k">Deprecated</span><span class="v">${esc(d.deprecation.reason)}</span>` : ""}
      </div>
    </details>`;
}

function _adTabActivity(d) {
  const events = d.activity || [];
  if (!events.length) {
    return `<div class="ad-section"><div class="empty" style="padding:2rem;color:var(--muted);text-align:center;">
      No activity recorded yet for this agent.<br>
      <span style="font-size:0.78rem;">Sign and verify a message and it'll appear here within seconds.</span>
    </div></div>`;
  }
  const formatEv = e => {
    const cp = e.is_self_signer ? e.verifier_did : e.signer_did;
    const cpName = e.is_self_signer ? e.verifier_name : e.signer_name;
    const arrow = e.is_self_signer ? '→' : '←';
    const statusPill = e.status === 'valid'
      ? '<span class="status-pill status-pill-good">valid</span>'
      : e.status === 'invalid'
        ? '<span class="status-pill status-pill-bad">invalid</span>'
        : `<span class="status-pill status-pill-info">${esc(e.status || '?')}</span>`;
    return `
      <div class="ad-event">
        <div class="ad-event-time">${esc(_relativeTime(e.ts))}</div>
        <div class="ad-event-arrow">${arrow}</div>
        <div class="ad-event-cp">
          ${cpName ? '<strong>' + esc(cpName) + '</strong>' : '<em style="color:var(--muted);">external</em>'}
          ${cp ? `<div style="font-size:0.7rem;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(cp.slice(0, 28) + '…' + cp.slice(-6))}</div>` : ''}
        </div>
        <div>${statusPill}</div>
        <div style="color:var(--muted);font-size:0.7rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(e.ip || '—')}</div>
      </div>`;
  };
  return `
    <div class="ad-section">
      <h4>Recent activity (last ${events.length})</h4>
      <div class="ad-events">${events.map(formatEv).join("")}</div>
      <div style="text-align:center;margin-top:0.85rem;">
        <button class="btn btn-outline" data-ad-action="full-activity" style="font-size:0.78rem;padding:0.3rem 0.7rem;">Open full activity log →</button>
      </div>
    </div>`;
}

function _adTabSettings(d) {
  const a = d.agent;
  const tagsCsv = (d.tags || []).join(", ");
  const metaJson = JSON.stringify(a.metadata || {}, null, 2);
  return `
    <div class="ad-section">
      <h4>Identity & display</h4>
      <label class="field-label">Name</label>
      <input class="auth-input" id="ads-name" value="${esc(a.name || '')}" />
      <label class="field-label" style="margin-top:0.6rem;">Capabilities (comma-separated)</label>
      <input class="auth-input" id="ads-caps" value="${esc((a.capabilities || []).join(', '))}" placeholder="chat, search, code" />
      <label class="field-label" style="margin-top:0.6rem;">Visibility</label>
      <select class="auth-input" id="ads-private">
        <option value="false" ${!a.private ? 'selected' : ''}>Public — listed in the public registry</option>
        <option value="true"  ${ a.private ? 'selected' : ''}>Private — only your account can see it</option>
      </select>
      <button class="btn btn-primary" data-ad-action="save-identity" style="margin-top:0.85rem;">Save changes</button>
      <div id="ads-identity-msg" class="modal-msg"></div>
    </div>

    <div class="ad-section">
      <h4>Metadata</h4>
      <p style="font-size:0.78rem;color:var(--muted);margin:0 0 0.4rem 0;">Free-form JSON object stored alongside the agent. Used for whatever your stack needs — env, region, model, customer ID, etc.</p>
      <textarea id="ads-metadata" class="auth-input" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.78rem;min-height:120px;">${esc(metaJson)}</textarea>
      <button class="btn btn-primary" data-ad-action="save-metadata" style="margin-top:0.6rem;">Save metadata</button>
      <div id="ads-metadata-msg" class="modal-msg"></div>
    </div>

    <div class="ad-section">
      <h4>Tags</h4>
      <p style="font-size:0.78rem;color:var(--muted);margin:0 0 0.4rem 0;">Quick-filter labels — e.g. <code>production</code>, <code>customer-support</code>, <code>v2</code>.</p>
      <input class="auth-input" id="ads-tags" value="${esc(tagsCsv)}" placeholder="comma, separated, list" />
      <button class="btn btn-primary" data-ad-action="save-tags" style="margin-top:0.6rem;">Save tags</button>
      <div id="ads-tags-msg" class="modal-msg"></div>
    </div>

    <div class="ad-section">
      <h4>Notifications & webhooks</h4>
      <p style="font-size:0.78rem;color:var(--muted);margin:0 0 0.4rem 0;">Webhooks fire on this agent's events when subscribed to verification.* or agent.* topics.</p>
      ${(d.related_webhooks || []).length ? d.related_webhooks.map(w => `
        <div style="display:flex;gap:0.5rem;align-items:center;font-size:0.78rem;padding:0.4rem 0;border-bottom:1px solid var(--border);">
          <span class="status-pill ${w.active ? 'status-pill-good' : 'status-pill-muted'}">${w.active ? 'active' : 'paused'}</span>
          <code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.74rem;">${esc(w.url)}</code>
          <span style="color:var(--muted);font-size:0.7rem;">${(w.events||[]).length} events</span>
        </div>`).join("") : '<div style="color:var(--muted);font-size:0.78rem;">No webhooks targeting this agent. Add one in Settings → Webhooks.</div>'}
      <button class="btn btn-outline" data-ad-action="open-webhooks" style="margin-top:0.6rem;font-size:0.78rem;padding:0.3rem 0.7rem;">Manage webhooks →</button>
    </div>`;
}

function _adTabDanger(d) {
  const a = d.agent;
  const isDeprecated = !!d.deprecation;
  return `
    <div class="ad-section">
      <h4>Mark deprecated</h4>
      <p style="font-size:0.78rem;color:var(--muted);margin:0 0 0.5rem 0;">
        Deprecated agents stay registered, but every verify response includes a
        <code>deprecated: true</code> warning so callers know to migrate.
        Optionally point to a successor DID.
      </p>
      ${isDeprecated ? `
        <div style="background:var(--yellow-bg);padding:0.6rem 0.85rem;border-radius:6px;font-size:0.82rem;margin-bottom:0.6rem;">
          <strong>Currently deprecated:</strong> ${esc(d.deprecation.reason)}
          ${d.deprecation.successor_did ? '<br>Successor: <code>'+esc(d.deprecation.successor_did)+'</code>' : ''}
        </div>
        <button class="btn btn-outline" data-ad-action="undeprecate" style="font-size:0.78rem;padding:0.3rem 0.7rem;">Remove deprecation</button>
      ` : `
        <input class="auth-input" id="ad-deprecate-reason" placeholder="Reason (e.g. replaced by v2)" />
        <input class="auth-input" id="ad-successor-did" placeholder="Successor DID (optional)" style="margin-top:0.4rem;" />
        <button class="btn btn-outline" data-ad-action="deprecate" style="margin-top:0.6rem;font-size:0.78rem;padding:0.3rem 0.7rem;color:var(--yellow);border-color:var(--yellow);">Mark as deprecated</button>
      `}
    </div>

    <div class="ad-section">
      <h4>Report compromised</h4>
      <p style="font-size:0.78rem;color:var(--muted);margin:0 0 0.5rem 0;">
        Files an entry in the Trust Network compromised feed. Other customers'
        verify paths flag this DID within seconds across the entire network.
      </p>
      <button class="btn btn-outline" data-ad-action="report" style="font-size:0.78rem;padding:0.3rem 0.7rem;color:var(--red);border-color:var(--red);">Report compromised…</button>
    </div>

    <div class="ad-section">
      <h4 style="color:var(--red);">Permanent deregister</h4>
      <p style="font-size:0.78rem;color:var(--muted);margin:0 0 0.5rem 0;">
        Removes the agent from your registry. The DID becomes resolvable as a
        tombstone. Audit history is retained.
      </p>
      <button class="btn btn-outline" data-ad-action="deregister" style="font-size:0.78rem;padding:0.3rem 0.7rem;color:var(--red);border-color:var(--red);">Deregister this agent…</button>
    </div>`;
}

function _adWireTabActions() {
  const body = document.getElementById("ad-body");
  const did  = _adState.did;
  const data = _adState.data;
  if (!body || !did || !data) return;

  body.querySelectorAll("[data-copy-trust-badge]").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(`<img src="${BASE}/trust/badge/${encodeURIComponent(did)}.svg" alt="AgentID trust badge" />`).catch(()=>{});
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy <img>"; }, 1500);
    });
  });

  body.querySelectorAll("[data-ad-action]").forEach(btn => {
    btn.addEventListener("click", () => _adRunAction(btn.getAttribute("data-ad-action")));
  });
}

async function _adRunAction(action) {
  const did = _adState.did;
  const a   = _adState.data?.agent;
  const name = a?.name;

  if (action === "test")     { _closeDrawer(); _openTestVerify(did, name); return; }
  if (action === "snippets") { _closeDrawer(); _openSnippets(did, name);   return; }
  if (action === "badge")    { window.open(`${BASE}/trust/badge/${encodeURIComponent(did)}.svg`, "_blank"); return; }
  if (action === "copy-did") {
    navigator.clipboard.writeText(did).catch(()=>{});
    _showToast?.("DID copied to clipboard");
    return;
  }
  if (action === "open-webhooks") {
    _closeDrawer();
    document.getElementById("settings-btn")?.click();
    setTimeout(() => document.querySelector(".modal-tab[data-tab='webhooks']")?.click(), 200);
    return;
  }
  if (action === "full-activity") {
    _closeDrawer();
    const search = document.getElementById("signing-search");
    if (search) {
      search.value = did;
      search.dispatchEvent(new Event("input"));
      document.querySelector('#signing-table')?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  if (action === "save-identity")   { return _adSaveIdentity(); }
  if (action === "save-metadata")   { return _adSaveMetadata(); }
  if (action === "save-tags")       { return _adSaveTags(); }
  if (action === "deprecate")       { return _adDeprecate(); }
  if (action === "undeprecate")     { return _adUndeprecate(); }
  if (action === "report")          { return _openReportCompromised(did); }
  if (action === "deregister")      { return _adDeregister(); }
}

async function _adSaveIdentity() {
  const did   = _adState.did;
  const name  = document.getElementById("ads-name").value.trim();
  const caps  = document.getElementById("ads-caps").value.split(",").map(s => s.trim()).filter(Boolean);
  const priv  = document.getElementById("ads-private").value === "true";
  const msg   = document.getElementById("ads-identity-msg");
  msg.textContent = "Saving…"; msg.className = "modal-msg";
  try {
    await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/control", {
      method: "PATCH",
      body: JSON.stringify({ name, capabilities: caps, private: priv }),
    });
    msg.textContent = "Saved ✓"; msg.className = "modal-msg modal-msg-success";
    // Refresh underlying data
    _adState.data.agent.name = name;
    _adState.data.agent.capabilities = caps;
    _adState.data.agent.private = priv;
    document.getElementById("ad-name").textContent = name;
    setTimeout(() => { msg.textContent = ""; }, 2000);
    if (typeof loadAgentsTable === "function") loadAgentsTable();
  } catch (e) {
    msg.textContent = "Failed: " + (e.message || ""); msg.className = "modal-msg modal-msg-error";
  }
}

async function _adSaveMetadata() {
  const did = _adState.did;
  const raw = document.getElementById("ads-metadata").value;
  const msg = document.getElementById("ads-metadata-msg");
  let parsed;
  try { parsed = JSON.parse(raw || "{}"); }
  catch { msg.textContent = "Invalid JSON — fix syntax first"; msg.className = "modal-msg modal-msg-error"; return; }
  msg.textContent = "Saving…"; msg.className = "modal-msg";
  try {
    await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/control", {
      method: "PATCH",
      body: JSON.stringify({ metadata: parsed }),
    });
    msg.textContent = "Saved ✓"; msg.className = "modal-msg modal-msg-success";
    _adState.data.agent.metadata = parsed;
    setTimeout(() => { msg.textContent = ""; }, 2000);
  } catch (e) {
    msg.textContent = "Failed: " + (e.message || ""); msg.className = "modal-msg modal-msg-error";
  }
}

async function _adSaveTags() {
  const did = _adState.did;
  const raw = document.getElementById("ads-tags").value;
  const tags = raw.split(",").map(s => s.trim()).filter(Boolean);
  const msg = document.getElementById("ads-tags-msg");
  msg.textContent = "Saving…"; msg.className = "modal-msg";
  try {
    await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/tags", {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
    msg.textContent = "Saved ✓"; msg.className = "modal-msg modal-msg-success";
    _adState.data.tags = tags;
    setTimeout(() => { msg.textContent = ""; }, 2000);
  } catch (e) {
    msg.textContent = "Failed: " + (e.message || ""); msg.className = "modal-msg modal-msg-error";
  }
}

async function _adDeprecate() {
  const did = _adState.did;
  const reason = document.getElementById("ad-deprecate-reason").value.trim();
  const successor = document.getElementById("ad-successor-did").value.trim();
  if (!reason) { alert("Reason is required"); return; }
  if (!confirm(`Mark this agent as deprecated?\n\nVerify responses will include a deprecation warning. The agent stays registered and signing still works.`)) return;
  try {
    await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/deprecate", {
      method: "POST",
      body: JSON.stringify({ reason, successor_did: successor || null }),
    });
    _adState.data.deprecation = { reason, successor_did: successor };
    _adRender();
  } catch (e) { alert("Failed: " + (e.message || "")); }
}

async function _adUndeprecate() {
  const did = _adState.did;
  if (!confirm("Remove the deprecation flag from this agent?")) return;
  try {
    await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/deprecate", { method: "DELETE" });
    _adState.data.deprecation = null;
    _adRender();
  } catch (e) { alert("Failed: " + (e.message || "")); }
}

async function _adDeregister() {
  const did = _adState.did;
  const name = _adState.data?.agent?.name;
  if (!confirm(`Permanently deregister "${name}"?\n\nThis cannot be undone. Audit history is retained, but the agent will no longer resolve to a public key.\n\nType "delete" to confirm in the next prompt.`)) return;
  const conf = prompt('Type "delete" to confirm:');
  if (conf !== "delete") return;
  try {
    await apiFetch("/pro/agents/bulk", {
      method: "DELETE",
      body: JSON.stringify({ dids: [did] }),
    });
    _closeDrawer();
    if (typeof loadAgentsTable === "function") loadAgentsTable();
  } catch (e) { alert("Failed: " + (e.message || "")); }
}

function _closeDrawer() {
  document.getElementById("agent-drawer")?.classList.remove("open");
}

async function _openReportCompromised(did) {
  const reason = prompt("Why is this DID compromised? (key leak, impersonation, malicious behavior, deprecated)\n\nProvide a short explanation:");
  if (!reason) return;
  const kindRaw = prompt("Kind — one of: key_leak | impersonation | malicious_behavior | deprecated", "key_leak");
  if (!kindRaw) return;
  try {
    await apiFetch("/trust/report", {
      method: "POST",
      body: JSON.stringify({ did, kind: kindRaw, reason, severity: "high" }),
    });
    alert("Report filed. Other customers' verify paths will start flagging this DID within seconds.");
    _closeDrawer();
  } catch (e) {
    alert("Failed: " + (e.message || ""));
  }
}

// Drawer close handlers (one-time wiring)
document.addEventListener("click", (e) => {
  if (e.target.matches("#ad-close, .agent-drawer-backdrop")) _closeDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") _closeDrawer();
});

// ── PEER BENCHMARKS (FOMO seed) ──────────────────────────────────────────────

function _toneClass(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("better") || s.includes("above") && !s.includes("worse")) return "bm-tone-good";
  if (s.includes("worse") || s.includes("below") || s.includes("investigate")) return "bm-tone-bad";
  return "bm-tone-meh";
}

async function loadPeerBenchmarks() {
  const list = document.getElementById("benchmarks-list");
  const src  = document.getElementById("benchmarks-source");
  if (!list) return;
  list.innerHTML = '<div class="loading"><div class="spinner"></div> Requesting…</div>';
  console.log("[dash] loadPeerBenchmarks starting");
  try {
    const data = await apiFetch("/pro/benchmarks");
    const metrics = data.metrics || [];
    if (src) src.textContent = data.source === "seeded-network-median"
      ? "Network median (industry-seeded — switching to live aggregates soon)"
      : "Network median · live";

    if (!metrics.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:0.5rem 0;">No data yet — check back after some agents register and verify.</div>';
      return;
    }

    list.innerHTML = metrics.map(m => {
      const has = m.you !== null && m.you !== undefined;
      // Bar maths: scale longest of (you, net*2) to 100%
      const max = Math.max((m.you ?? 0), (m.network ?? 0) * 2, 1);
      const youPct = has ? Math.min(100, (m.you / max) * 100) : 0;
      const netPct = Math.min(100, (m.network / max) * 100);
      return `<div class="bm-row">
        <div class="bm-label">
          <span class="bm-label-title">${esc(m.label)}</span>
          <span class="bm-label-desc">${esc(m.description)}</span>
        </div>
        <div class="bm-bar-wrap" title="You: ${esc(String(m.you ?? '—'))}${esc(m.unit||'')} · network median: ${esc(String(m.network))}${esc(m.unit||'')}">
          <div class="bm-bar-you" style="width:${youPct}%;${has ? '' : 'opacity:0.2;'}"></div>
          <div class="bm-bar-net" style="left:${netPct}%;"></div>
        </div>
        <div class="bm-values">
          <span class="bm-you-val">${has ? esc(String(m.you)) + esc(m.unit||"") : '—'}</span>
          <span class="bm-tone ${_toneClass(m.tone)}">${esc(m.tone)}</span>
          <span style="font-size:0.7rem;color:var(--muted);">network: ${esc(String(m.network))}${esc(m.unit||'')}</span>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    list.innerHTML = `<div style="color:var(--muted);font-size:0.8rem;padding:0.5rem 0;">Could not load benchmarks: ${esc(String(e.message || ""))}</div>`;
  }
}

// ── NOTIFICATION CENTER ──────────────────────────────────────────────────────

const _NOTIF_READ_KEY = "agentid_notif_read_ids";
let   _notifs = [];

function _getReadIds() {
  try { return new Set(JSON.parse(localStorage.getItem(_NOTIF_READ_KEY) || "[]")); }
  catch { return new Set(); }
}
function _setReadIds(set) {
  try { localStorage.setItem(_NOTIF_READ_KEY, JSON.stringify(Array.from(set))); } catch {}
}

async function loadNotifications() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  try {
    // For now: anomalies = the only system-pushed notifications.
    // Audit log + webhook deliveries can be merged in later.
    const data = await apiFetch("/pro/anomalies");
    const anomalies = data.anomalies || [];

    _notifs = anomalies.map(a => ({
      id:    `${a.type}-${a.detected_at}`,
      kind:  "anomaly",
      severity: a.severity,
      title:    a.title,
      desc:     a.description,
      time:     a.detected_at,
      action:   () => {
        const card = document.getElementById("anomaly-card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    }));

    _renderNotifs();
  } catch (_) {
    list.innerHTML = '<div class="notif-empty">Could not load notifications</div>';
  }
}

function _renderNotifs() {
  const list  = document.getElementById("notif-list");
  const badge = document.getElementById("notif-badge");
  if (!list) return;

  const read = _getReadIds();
  const unread = _notifs.filter(n => !read.has(n.id));

  if (badge) {
    if (unread.length > 0) {
      badge.style.display = "inline-block";
      badge.textContent = unread.length > 9 ? "9+" : String(unread.length);
    } else {
      badge.style.display = "none";
    }
  }

  if (!_notifs.length) {
    list.innerHTML = '<div class="notif-empty">✓ All clear — no notifications</div>';
    return;
  }
  list.innerHTML = _notifs.map(n => {
    const isUnread = !read.has(n.id);
    return `<div class="notif-row" data-notif-id="${esc(n.id)}" style="${isUnread ? "background: rgba(201,83,47,0.04);" : ""}">
      <div class="notif-title">
        <span class="notif-sev-dot ${esc(n.severity || "low")}"></span>
        ${esc(n.title)}
      </div>
      <div class="notif-desc">${esc(n.desc || "")}</div>
      <div class="notif-time">${esc(_relativeTime(n.time))}</div>
    </div>`;
  }).join("");

  list.querySelectorAll(".notif-row").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-notif-id");
      const set = _getReadIds();
      set.add(id);
      _setReadIds(set);
      const n = _notifs.find(x => x.id === id);
      if (n?.action) n.action();
      _renderNotifs();
      document.getElementById("notif-panel")?.classList.remove("open");
    });
  });
}

function _initNotifications() {
  const btn   = document.getElementById("notif-btn");
  const panel = document.getElementById("notif-panel");
  const clear = document.getElementById("notif-clear");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) loadNotifications();
  });
  clear?.addEventListener("click", () => {
    const set = _getReadIds();
    _notifs.forEach(n => set.add(n.id));
    _setReadIds(set);
    _renderNotifs();
  });
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && !btn.contains(e.target)) {
      panel.classList.remove("open");
    }
  });
  // Refresh count every 60 s
  setInterval(() => {
    if (apiKey || authMode === "session") loadNotifications();
  }, 60000);
}

// ── WELCOME MODAL — first-run choose-your-path ──────────────────────────────

async function _maybeShowWelcome() {
  if (authMode !== "session") return;
  const currentEmail = document.getElementById("dash-title")?.textContent || "";

  let r;
  try { r = await apiFetch("/auth/welcome"); }
  catch (_) { return; }

  // Dedup logic:
  //  - If account already has keys, skip the modal forever (server-of-truth).
  //  - If account has NO keys, only skip when the user has explicitly opted
  //    out via "Don't show again" (localStorage flag, persists across logins).
  //    Otherwise show the modal again on every login so they're not stuck
  //    without a key by accident.
  if (!r) return;
  if (r.has_key) return;

  const optedOut = localStorage.getItem("agentid_welcome_dismissed_" + currentEmail.toLowerCase()) === "1";
  if (optedOut) {
    _showInlineWelcomePrompt(r);   // small banner with a re-open link
    return;
  }
  _showWelcomeChoose(r);
}

function _showInlineWelcomePrompt(info) {
  // Tiny, unobtrusive banner shown when the user has previously dismissed
  // the welcome modal but still hasn't created a key. Lets them re-open it.
  if (document.getElementById("nokey-banner")) return;
  const b = document.createElement("div");
  b.id = "nokey-banner";
  b.style.cssText = `
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; padding: 0.65rem 0.95rem;
    margin: 0.85rem 1.25rem; font-size: 0.84rem;
    display: flex; align-items: center; gap: 0.85rem;
  `;
  b.innerHTML = `
    <span>🔑</span>
    <span style="flex:1;color:var(--text-2);">
      You don't have an API key yet — you'll need one to use the SDK.
    </span>
    <button id="nokey-setup" class="btn btn-primary" style="font-size:0.78rem;padding:0.35rem 0.75rem;">Set one up</button>
    <button id="nokey-hide" class="btn btn-ghost" style="font-size:0.74rem;padding:0.25rem 0.45rem;">✕</button>`;
  const dash = document.getElementById("dashboard");
  if (dash) dash.insertBefore(b, dash.firstChild);
  document.getElementById("nokey-setup")?.addEventListener("click", () => {
    b.remove();
    _showWelcomeChoose(info);
  });
  document.getElementById("nokey-hide")?.addEventListener("click", () => b.remove());
}

function _welcomeShowStep(name) {
  const modal = document.getElementById("welcome-modal");
  modal.querySelector("#welcome-step-choose").style.display   = name === "choose"   ? "" : "none";
  modal.querySelector("#welcome-step-key").style.display      = name === "key"      ? "" : "none";
  modal.querySelector("#welcome-step-existing").style.display = name === "existing" ? "" : "none";
  modal.querySelector("#welcome-links").style.display = (name === "key" || name === "existing") ? "" : "none";
  modal.querySelector("#welcome-back").style.display    = name === "choose" ? "none" : "";
  modal.querySelector("#welcome-dismiss").style.display = name === "choose" ? "none" : "";

  // Step-specific subtitle
  const sub = document.getElementById("welcome-subtitle");
  if (sub) {
    if (name === "choose")        sub.textContent = "Your account is ready. How would you like to start?";
    else if (name === "key")      sub.textContent = "Here's your starter API key + a copy-paste snippet.";
    else if (name === "existing") sub.textContent = "Use your existing API key directly with the SDK.";
  }
}

function _showWelcomeChoose(info) {
  const modal = document.getElementById("welcome-modal");
  if (!modal) return;

  // Subtitle with email + tier
  const sub = document.getElementById("welcome-subtitle");
  if (sub) {
    sub.innerHTML = `Signed in as <strong>${esc(info.owner)}</strong> on the <strong>${esc(info.tier)}</strong> tier. How would you like to start?`;
  }
  // Reset the "don't show again" checkbox
  const dontShow = document.getElementById("welcome-dont-show-again");
  if (dontShow) dontShow.checked = false;

  // Wire choice buttons
  modal.querySelectorAll("[data-welcome-choice]").forEach(btn => {
    btn.onclick = async () => {
      const choice = btn.getAttribute("data-welcome-choice");
      _maybeSetWelcomeOptOut(info);   // honour the checkbox regardless of path
      if (choice === "generate") return _welcomeGenerate(info);
      if (choice === "existing") return _welcomeShowExisting(info);
      if (choice === "skip")     return _closeWelcome();
    };
  });

  // Wire footer buttons
  document.getElementById("welcome-back").onclick    = () => _welcomeShowStep("choose");
  document.getElementById("welcome-dismiss").onclick = () => {
    _maybeSetWelcomeOptOut(info);
    _closeWelcome();
  };
  document.getElementById("welcome-register-cta").onclick = (e) => {
    e.preventDefault();
    _closeWelcome();
    document.getElementById("register-agent-btn")?.click();
  };

  _welcomeShowStep("choose");
  modal.classList.add("open");
}

function _maybeSetWelcomeOptOut(info) {
  const cb = document.getElementById("welcome-dont-show-again");
  if (cb && cb.checked && info?.owner) {
    localStorage.setItem("agentid_welcome_dismissed_" + info.owner.toLowerCase(), "1");
  }
}

async function _welcomeGenerate(info) {
  const choice = document.querySelector('[data-welcome-choice="generate"]');
  if (choice) {
    choice.disabled = true;
    choice.querySelector(".welcome-choice-title").textContent = "Generating…";
  }
  let resp;
  try {
    resp = await apiFetch("/auth/welcome/generate", {
      method: "POST",
      body: JSON.stringify({ label: "starter" }),
    });
  } catch (e) {
    alert("Could not generate key: " + (e.message || ""));
    if (choice) {
      choice.disabled = false;
      choice.querySelector(".welcome-choice-title").textContent = "Generate a starter API key";
    }
    return;
  }
  // Stash the key for the "stay signed in" toggle below to read.
  _adState_pendingNewKey = resp.key;
  // Show key in step 2a
  document.getElementById("welcome-key-value").textContent = resp.key;
  ["python", "node", "curl", "go"].forEach(lang => {
    const el = document.getElementById("welcome-snippet-" + lang);
    if (el) el.textContent = el.textContent.replace(/YOUR_KEY/g, resp.key);
  });

  const modal = document.getElementById("welcome-modal");
  modal.querySelectorAll("[data-welcome-lang]").forEach(t => {
    t.onclick = () => {
      const lang = t.getAttribute("data-welcome-lang");
      modal.querySelectorAll("[data-welcome-lang]").forEach(x => x.classList.toggle("active", x === t));
      modal.querySelectorAll("[data-welcome-panel]").forEach(c =>
        c.style.display = c.getAttribute("data-welcome-panel") === lang ? "" : "none");
    };
  });
  document.getElementById("welcome-copy-key").onclick = () => {
    navigator.clipboard.writeText(resp.key).catch(()=>{});
    const b = document.getElementById("welcome-copy-key");
    b.textContent = "✓ Copied";
    setTimeout(() => { b.textContent = "📋 Copy"; }, 1500);
  };
  document.getElementById("welcome-copy-snippet").onclick = () => {
    const visible = modal.querySelector("[data-welcome-panel]:not([style*='display: none'])");
    if (!visible) return;
    navigator.clipboard.writeText(visible.textContent).catch(()=>{});
    const b = document.getElementById("welcome-copy-snippet");
    b.textContent = "✓ Copied";
    setTimeout(() => { b.textContent = "📋 Copy snippet"; }, 1500);
  };
  _welcomeShowStep("key");
}

function _welcomeShowExisting(info) {
  const owner = document.getElementById("welcome-existing-owner");
  if (owner) owner.textContent = info.owner || "your email";
  const modal  = document.getElementById("welcome-modal");
  const input  = document.getElementById("welcome-existing-input");
  const verify = document.getElementById("welcome-existing-verify");
  const status = document.getElementById("welcome-existing-status");
  const snips  = document.getElementById("welcome-existing-snippets");
  // Reset state every time the panel opens
  if (input)  input.value = "";
  if (status) { status.textContent = ""; status.style.color = ""; }
  if (snips)  snips.style.display  = "none";

  // Tab switcher for the snippets within this panel
  modal.querySelectorAll("[data-welcome-elang]").forEach(t => {
    t.onclick = () => {
      const lang = t.getAttribute("data-welcome-elang");
      modal.querySelectorAll("[data-welcome-elang]").forEach(x => x.classList.toggle("active", x === t));
      modal.querySelectorAll("[data-welcome-epanel]").forEach(c =>
        c.style.display = c.getAttribute("data-welcome-epanel") === lang ? "" : "none");
    };
  });

  const doVerify = async () => {
    const key = (input.value || "").trim();
    if (!key) {
      status.textContent = "Paste your agentid_… key first.";
      status.style.color = "var(--muted)";
      return;
    }
    if (!/^agentid_/.test(key)) {
      status.textContent = "Doesn't look right — keys start with `agentid_`.";
      status.style.color = "var(--red)";
      return;
    }
    verify.disabled = true; verify.textContent = "Verifying…";
    status.textContent = "Checking the key against the API…";
    status.style.color = "var(--muted)";

    let info2;
    try {
      const r = await fetch(BASE + "/pro/keys/me", {
        headers: { "x-api-key": key },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${r.status}`);
      }
      info2 = await r.json();
    } catch (e) {
      status.innerHTML = '<strong style="color:var(--red);">✗ Invalid key.</strong> ' + esc(String(e.message || ""));
      verify.disabled = false; verify.textContent = "Verify";
      snips.style.display = "none";
      return;
    } finally {
      verify.disabled = false; verify.textContent = "Verify";
    }

    const sameOwner = info2.owner && info.owner && info2.owner.toLowerCase() === info.owner.toLowerCase();
    if (sameOwner) {
      status.innerHTML =
        `<strong style="color:#107a3a;">✓ Key works for this account.</strong> ` +
        `Tier <strong>${esc(info2.tier)}</strong>, label “<strong>${esc(info2.label || "(unlabelled)")}</strong>”.` +
        ` Snippets below are pre-filled with your key.`;
    } else {
      status.innerHTML =
        `<strong style="color:#8a4a00;">⚠ Key is valid but for a different account.</strong> ` +
        `Owner <code>${esc(info2.owner || "—")}</code> ≠ <code>${esc(info.owner)}</code>. ` +
        `That's a separate account. Either sign in via the <em>API key</em> login tab to manage it, ` +
        `or use this key directly in your code without changing your dashboard login.`;
    }

    // Inject the key into the snippet code blocks
    ["python", "node", "curl", "go"].forEach(lang => {
      const el = document.getElementById("welcome-esnip-" + lang);
      if (el) el.textContent = el.textContent.replace(/YOUR_KEY/g, key);
    });
    snips.style.display = "";
  };

  verify.onclick = doVerify;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doVerify(); } };

  // Copy snippet
  const copyBtn = document.getElementById("welcome-existing-copy");
  if (copyBtn) copyBtn.onclick = () => {
    const visible = snips.querySelector("[data-welcome-epanel]:not([style*='display: none'])");
    if (!visible) return;
    navigator.clipboard.writeText(visible.textContent).catch(()=>{});
    copyBtn.textContent = "✓ Copied";
    setTimeout(() => { copyBtn.textContent = "📋 Copy snippet"; }, 1500);
  };

  _welcomeShowStep("existing");
}

// Set when /auth/welcome/generate returns a key, so close-time logic can
// honour the "stay signed in" checkbox even though the user never typed
// the key themselves.
let _adState_pendingNewKey = null;

function _closeWelcome() {
  // If a starter key was just generated and the user wants to stay signed
  // in on this device, persist the key into localStorage so a refresh
  // (which can drop the session cookie on Safari/3p-cookie-blocking
  // browsers) still authenticates via x-api-key fallback.
  const stayCb = document.getElementById("welcome-stay-signed-in");
  if (_adState_pendingNewKey && stayCb && stayCb.checked) {
    localStorage.setItem("agentid_persisted_key", _adState_pendingNewKey);
    sessionStorage.setItem("agentid_key", _adState_pendingNewKey);
    apiKey = _adState_pendingNewKey;
  }
  _adState_pendingNewKey = null;
  document.getElementById("welcome-modal")?.classList.remove("open");
}

// ── THEME TOGGLE (light / dark / auto) ───────────────────────────────────────

const _THEME_KEY = "agentid_theme";

function _applyTheme(mode /* "light" | "dark" | "auto" */) {
  const html = document.documentElement;
  if (mode === "auto") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", mode);
  }
  // Sync the icon
  const sun  = document.getElementById("theme-icon-sun");
  const moon = document.getElementById("theme-icon-moon");
  if (sun && moon) {
    const isDark = mode === "dark" ||
      (mode === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    sun.style.display  = isDark ? "none" : "";
    moon.style.display = isDark ? "" : "none";
  }
}

function _initTheme() {
  const saved = localStorage.getItem(_THEME_KEY) || "auto";
  _applyTheme(saved);
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const cur = localStorage.getItem(_THEME_KEY) || "auto";
    // 3-way cycle: auto → dark → light → auto
    const next = cur === "auto" ? "dark" : (cur === "dark" ? "light" : "auto");
    localStorage.setItem(_THEME_KEY, next);
    _applyTheme(next);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if ((localStorage.getItem(_THEME_KEY) || "auto") === "auto") _applyTheme("auto");
  });
}

// ── KEYBOARD CHEAT SHEET + GLOBAL SHORTCUTS ──────────────────────────────────

function _kbdShow()  { document.getElementById("kbd-cheatsheet")?.classList.add("open"); }
function _kbdHide()  { document.getElementById("kbd-cheatsheet")?.classList.remove("open"); }

function _initKeyboardShortcuts() {
  document.getElementById("kbd-cheatsheet")?.addEventListener("click", (e) => {
    if (e.target.id === "kbd-cheatsheet") _kbdHide();
  });
  document.addEventListener("keydown", (e) => {
    // Don't trigger global shortcuts while typing in inputs
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;

    // ? — open cheat sheet
    if ((e.key === "?" || (e.key === "/" && e.shiftKey)) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const panel = document.getElementById("kbd-cheatsheet");
      panel?.classList.toggle("open");
      return;
    }
    // Esc — close cheat sheet
    if (e.key === "Escape") _kbdHide();

    // Cmd/Ctrl+Shift+D — toggle dark mode
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      const cur = localStorage.getItem(_THEME_KEY) || "auto";
      const next = cur === "dark" ? "light" : "dark";
      localStorage.setItem(_THEME_KEY, next);
      _applyTheme(next);
      return;
    }
    // Cmd/Ctrl+Shift+Q — sign out
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "q" || e.key === "Q")) {
      e.preventDefault();
      logout();
      return;
    }

    // Single-key shortcuts (only when dashboard visible)
    const dashVisible = document.getElementById("dashboard")?.style.display !== "none";
    if (!dashVisible) return;

    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      document.getElementById("refresh-btn")?.click();
    }
    if (e.key === "n" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("register-agent-btn")?.click();
    }
    if (e.key === "N" && e.shiftKey) {
      e.preventDefault();
      document.getElementById("notif-btn")?.click();
    }
    if (e.key === ",") {
      e.preventDefault();
      document.getElementById("settings-btn")?.click();
    }
  });
}

// ── COMMAND PALETTE / GLOBAL SEARCH ──────────────────────────────────────────

const _cmdk = { open: false, items: [], cursor: 0, lastQuery: "" };

function cmdkOpen() {
  if (!apiKey && authMode !== "session") return;
  const overlay = document.getElementById("cmdk-overlay");
  const input   = document.getElementById("cmdk-input");
  if (!overlay) return;
  overlay.classList.add("open");
  _cmdk.open = true;
  input.value = "";
  _cmdk.cursor = 0;
  _cmdkRender([
    { kind: "tip", icon: "💡", label: "Type to search agents, groups, capabilities, audit events…" },
  ]);
  setTimeout(() => input.focus(), 30);
}

function cmdkClose() {
  document.getElementById("cmdk-overlay")?.classList.remove("open");
  _cmdk.open = false;
}

function _cmdkRender(items) {
  const list = document.getElementById("cmdk-results");
  if (!list) return;
  _cmdk.items = items;
  if (!items.length) {
    list.innerHTML = '<div class="cmdk-empty">No results — try a different query</div>';
    return;
  }
  list.innerHTML = items.map((it, i) => {
    if (it.kind === "section") {
      return `<div class="cmdk-section-title">${esc(it.label)}</div>`;
    }
    if (it.kind === "tip") {
      return `<div class="cmdk-row" style="cursor:default;"><span class="cmdk-icon">${esc(it.icon)}</span><span class="cmdk-label">${esc(it.label)}</span></div>`;
    }
    return `<div class="cmdk-row ${i === _cmdk.cursor ? "active" : ""}" data-cmdk-idx="${i}">
      <span class="cmdk-icon">${esc(it.icon || "•")}</span>
      <span class="cmdk-label">${esc(it.label)}</span>
      ${it.meta ? `<span class="cmdk-meta">${esc(it.meta)}</span>` : ""}
    </div>`;
  }).join("");
  list.querySelectorAll(".cmdk-row[data-cmdk-idx]").forEach(row => {
    row.addEventListener("click", () => _cmdkActivate(Number(row.dataset.cmdkIdx)));
  });
}

function _cmdkActivate(idx) {
  const it = _cmdk.items[idx];
  if (!it || !it.action) return;
  cmdkClose();
  it.action();
}

let _cmdkSearchTimer = null;
async function _cmdkSearch(q) {
  q = q.trim();
  if (!q) {
    _cmdkRender([
      { kind: "section", label: "Quick actions" },
      { kind: "row", icon: "🤖", label: "Register agent",       action: () => document.getElementById("register-agent-btn")?.click() },
      { kind: "row", icon: "🔑", label: "Manage API keys",      action: () => { document.getElementById("settings-btn")?.click(); setTimeout(() => document.querySelector(".modal-tab[data-tab='api-keys']")?.click(), 200); } },
      { kind: "row", icon: "📥", label: "Download audit log (CSV)", action: () => document.getElementById("csv-btn")?.click() },
      { kind: "row", icon: "📊", label: "Refresh dashboard",    action: () => document.getElementById("refresh-btn")?.click() },
      { kind: "row", icon: "🚪", label: "Sign out",             action: () => logout() },
    ]);
    return;
  }
  _cmdk.lastQuery = q;
  _cmdkRender([{ kind: "tip", icon: "🔍", label: "Searching…" }]);
  try {
    const data = await apiFetch("/pro/search?q=" + encodeURIComponent(q) + "&per_page=8");
    if (q !== _cmdk.lastQuery) return;   // newer query in flight
    const agents = data.agents || [];
    if (!agents.length) {
      _cmdkRender([{ kind: "tip", icon: "🚫", label: `No agents matched "${q}"` }]);
      return;
    }
    const items = [{ kind: "section", label: `Agents (${data.total})` }];
    agents.forEach(a => {
      items.push({
        kind: "row",
        icon: "🤖",
        label: a.name + (a.private ? "  · private" : ""),
        meta:  shortDid(a.did),
        action: () => {
          // Open agent detail drawer (or just scroll to the table for now)
          const rowEl = document.querySelector(`[data-did="${a.did}"]`);
          if (rowEl) {
            rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
            rowEl.style.background = "var(--accent-bg)";
            setTimeout(() => { rowEl.style.background = ""; }, 1500);
          }
        },
      });
    });
    _cmdkRender(items);
  } catch (e) {
    _cmdkRender([{ kind: "tip", icon: "⚠️", label: "Search failed: " + (e.message || "unknown") }]);
  }
}

function _cmdkInit() {
  const overlay = document.getElementById("cmdk-overlay");
  const input   = document.getElementById("cmdk-input");
  if (!overlay || !input) return;

  document.getElementById("cmdk-btn")?.addEventListener("click", cmdkOpen);

  // ⌘K / Ctrl-K from anywhere
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      _cmdk.open ? cmdkClose() : cmdkOpen();
    }
    if (e.key === "Escape" && _cmdk.open) {
      cmdkClose();
    }
    if (_cmdk.open && e.key === "ArrowDown") {
      e.preventDefault();
      _cmdk.cursor = Math.min(_cmdk.items.length - 1, _cmdk.cursor + 1);
      _cmdkRender(_cmdk.items);
    }
    if (_cmdk.open && e.key === "ArrowUp") {
      e.preventDefault();
      _cmdk.cursor = Math.max(0, _cmdk.cursor - 1);
      _cmdkRender(_cmdk.items);
    }
    if (_cmdk.open && e.key === "Enter") {
      e.preventDefault();
      _cmdkActivate(_cmdk.cursor);
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cmdkClose();
  });

  input.addEventListener("input", () => {
    clearTimeout(_cmdkSearchTimer);
    _cmdkSearchTimer = setTimeout(() => _cmdkSearch(input.value), 180);
  });
}

function openSettings() {
  document.getElementById("settings-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
  // Always reload account info when modal opens
  _loadAccountInfo();
  _loadAccountKeys();
}

// ── ACCOUNT-SCOPED API KEYS (Settings → API Keys tab) ─────────────────────────

async function _loadAccountKeys() {
  const list = document.getElementById("ak-list");
  if (!list) return;
  // Only meaningful when signed in via session — API-key login already shows
  // its own key info in the Account tab.
  if (authMode !== "session") {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.78rem;padding:0.5rem 0;">Sign in with your email to manage account-scoped API keys.</div>';
    return;
  }
  list.innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>';
  try {
    const data = await apiFetch("/auth/keys");
    const keys = data.keys || [];
    if (!keys.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:0.78rem;padding:0.5rem 0;">No keys yet — create one above.</div>';
      return;
    }
    list.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
        <thead>
          <tr>
            <th style="text-align:left;padding:0.4rem 0.5rem;color:var(--muted);font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);">Label</th>
            <th style="text-align:left;padding:0.4rem 0.5rem;color:var(--muted);font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);">Scopes</th>
            <th style="text-align:left;padding:0.4rem 0.5rem;color:var(--muted);font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);">Created</th>
            <th style="text-align:left;padding:0.4rem 0.5rem;color:var(--muted);font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);">Last used</th>
            <th style="border-bottom:1px solid var(--border);"></th>
          </tr>
        </thead>
        <tbody>
          ${keys.map(k => `
            <tr>
              <td style="padding:0.45rem 0.5rem;font-weight:600;">${esc(k.label || "(unlabelled)")}</td>
              <td style="padding:0.45rem 0.5rem;color:var(--text-2);">${esc(k.scopes || "(full)")}</td>
              <td style="padding:0.45rem 0.5rem;color:var(--muted);font-size:0.74rem;">${esc(_relativeTime(k.created_at) || "—")}</td>
              <td style="padding:0.45rem 0.5rem;color:var(--muted);font-size:0.74rem;">${esc(_relativeTime(k.last_used) || "never")}</td>
              <td style="padding:0.45rem 0.5rem;text-align:right;">
                <button class="btn btn-outline ak-revoke-btn" data-label="${esc(k.label)}" style="font-size:0.72rem;padding:0.25rem 0.6rem;color:var(--red);border-color:var(--red);">Revoke</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    // Wire revoke buttons
    list.querySelectorAll(".ak-revoke-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const label = btn.getAttribute("data-label");
        if (!confirm(`Revoke key "${label}"?\n\nAny code using this key will immediately stop working.`)) return;
        btn.textContent = "Revoking…";
        btn.disabled = true;
        try {
          await apiFetch("/auth/keys/" + encodeURIComponent(label), { method: "DELETE" });
          _loadAccountKeys();
        } catch (e) {
          btn.textContent = "Revoke";
          btn.disabled = false;
          alert("Could not revoke: " + e.message);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--red);font-size:0.78rem;padding:0.5rem 0;">Could not load keys: ${esc(String(e.message || ""))}</div>`;
  }
}

async function _createAccountKey() {
  const label  = document.getElementById("ak-label").value.trim();
  const scopes = document.getElementById("ak-scopes").value;
  const msg    = document.getElementById("ak-create-msg");
  const btn    = document.getElementById("ak-create-btn");
  const box    = document.getElementById("ak-new-key-box");
  const code   = document.getElementById("ak-new-key-value");
  if (!label) {
    msg.textContent = "Label is required.";
    msg.className = "modal-msg modal-msg-error";
    return;
  }
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const r = await apiFetch("/auth/keys", {
      method: "POST",
      body: JSON.stringify({ label, scopes }),
    });
    code.textContent = r.key;
    box.style.display = "block";
    msg.textContent = "";
    msg.className = "modal-msg";
    document.getElementById("ak-label").value = "";
    _loadAccountKeys();
  } catch (e) {
    msg.textContent = "Failed: " + (e.message || "unknown error");
    msg.className = "modal-msg modal-msg-error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Create key";
  }
}

function closeSettings() {
  document.getElementById("settings-modal").style.display = "none";
  document.body.style.overflow = "";
}

function _switchSettingsTab(tab) {
  document.querySelectorAll(".modal-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  document.querySelectorAll(".modal-panel").forEach(p =>
    p.classList.toggle("active", p.id === `tab-${tab}`)
  );
  // Lazy-load heavy tabs only when opened
  if (tab === "key-rotation") _loadRotationAgentList();
  if (tab === "webhooks") { _initWebhookEventGrid(); _loadWebhooks(); }
  if (tab === "sandbox") _loadSandboxStatus();
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  _initSigningPager();   // one-time — survives every table redraw
  _initSigningSearch();  // one-time — survives every table redraw

  _initTheme();
  _initKeyboardShortcuts();
  _cmdkInit();
  _initNotifications();
  document.getElementById("login-btn")?.addEventListener("click", login);
  document.getElementById("logout-btn")?.addEventListener("click", logout);
  document.getElementById("api-key-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });

  // Account auth (email + password)
  document.getElementById("account-login-btn")?.addEventListener("click", accountLogin);
  document.getElementById("account-signup-btn")?.addEventListener("click", accountSignup);
  ["login-email","login-password"].forEach(id => {
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") accountLogin();
    });
  });
  ["signup-email","signup-password"].forEach(id => {
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") accountSignup();
    });
  });

  // Forgot-password — request a reset link
  document.getElementById("forgot-password-link")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim()
                || prompt("Enter the email associated with your account:");
    if (!email) return;
    try {
      await fetch(BASE + "/auth/request-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      _showAuthError(`If an account exists for ${email}, a reset link has been sent.`);
    } catch (_) {
      _showAuthError("Could not send reset link — try again shortly.");
    }
  });

  // URL-fragment driven flows: #reset-password=TOKEN  or  #verify-email=TOKEN
  (function _handleAuthFragment() {
    const m = location.hash.match(/^#(reset-password|verify-email)=([\w-]+)/);
    if (!m) return;
    const kind = m[1], token = m[2];
    if (kind === "reset-password") {
      const pw = prompt("Enter a new password (8+ characters):");
      if (!pw) return;
      fetch(BASE + "/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      }).then(r => r.ok
        ? alert("Password updated! Please sign in with your new password.")
        : r.json().then(j => alert("Failed: " + (j.detail || "invalid token")))
      ).finally(() => { location.hash = ""; });
    }
    if (kind === "verify-email") {
      fetch(BASE + "/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).then(r => r.ok
        ? alert("Email verified ✓")
        : r.json().then(j => alert("Failed: " + (j.detail || "invalid token")))
      ).finally(() => { location.hash = ""; });
    }
  })();

  // Tab switcher inside the email-and-password pane (Sign in / Sign up)
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.getAttribute("data-auth-tab");
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".auth-panel").forEach(p =>
        p.classList.toggle("active", p.getAttribute("data-auth-panel") === target));
      _clearAuthError();
    });
  });

  document.getElementById("refresh-btn").addEventListener("click", () => {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    if (capChart)   { capChart.destroy();   capChart = null; }
    loadDashboard();
  });

  // ── Settings modal ──────────────────────────────────────────────────────────
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);

  // ── API Keys tab handlers ───────────────────────────────────────────────────
  document.getElementById("ak-create-btn")?.addEventListener("click", _createAccountKey);
  document.getElementById("ak-refresh-btn")?.addEventListener("click", _loadAccountKeys);
  document.getElementById("ak-copy-new-btn")?.addEventListener("click", () => {
    const code = document.getElementById("ak-new-key-value");
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      const btn = document.getElementById("ak-copy-new-btn");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    }).catch(() => {});
  });

  // Close on backdrop click
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("settings-modal")) closeSettings();
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("settings-modal").style.display !== "none") {
      closeSettings();
    }
  });

  // Tab switching
  document.querySelectorAll(".modal-tab").forEach(tab => {
    tab.addEventListener("click", () => _switchSettingsTab(tab.dataset.tab));
  });

  // ── Account tab actions ────────────────────────────────────────────────────

  document.getElementById("allowlist-save-btn").addEventListener("click", _saveAllowlist);

  // Theme buttons
  document.querySelectorAll(".theme-opt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const val = btn.getAttribute("data-theme-val");
      localStorage.setItem(_THEME_KEY, val);
      _applyTheme(val === "auto" ? null : val);
      _highlightThemeBtn();
    });
  });

  function _highlightThemeBtn() {
    const cur = localStorage.getItem(_THEME_KEY) || "auto";
    document.querySelectorAll(".theme-opt-btn").forEach(b => {
      const active = b.getAttribute("data-theme-val") === cur;
      b.style.background     = active ? "var(--accent)"  : "";
      b.style.color          = active ? "#fff"           : "";
      b.style.borderColor    = active ? "var(--accent)"  : "";
    });
  }
  _highlightThemeBtn();

  // Change password toggle
  document.getElementById("change-pw-toggle-btn")?.addEventListener("click", () => {
    const form = document.getElementById("change-pw-form");
    if (form) form.style.display = form.style.display === "none" ? "block" : "none";
  });
  document.getElementById("change-pw-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("change-pw-form").style.display = "none";
    ["change-pw-current","change-pw-new","change-pw-confirm"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    _modalMsgClear("change-pw-msg");
  });
  document.getElementById("change-pw-save-btn")?.addEventListener("click", async () => {
    const cur     = document.getElementById("change-pw-current")?.value || "";
    const next    = document.getElementById("change-pw-new")?.value     || "";
    const confirm = document.getElementById("change-pw-confirm")?.value  || "";
    const btn     = document.getElementById("change-pw-save-btn");
    _modalMsgClear("change-pw-msg");
    if (!cur || !next) { _modalMsg("change-pw-msg", "Fill in all fields.", "error"); return; }
    if (next.length < 8) { _modalMsg("change-pw-msg", "New password must be at least 8 characters.", "error"); return; }
    if (next !== confirm) { _modalMsg("change-pw-msg", "Passwords do not match.", "error"); return; }
    btn.disabled = true; btn.textContent = "Updating…";
    try {
      // Re-auth with current password then set new one via request-reset flow
      // Simplest: call a dedicated change-password endpoint if available,
      // otherwise use the reset flow with current password verification
      const res = await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: cur, new_password: next }),
      });
      _modalMsg("change-pw-msg", "Password updated successfully.", "ok");
      document.getElementById("change-pw-form").style.display = "none";
      ["change-pw-current","change-pw-new","change-pw-confirm"].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = "";
      });
    } catch (e) {
      _modalMsg("change-pw-msg", e.message || "Failed to update password.", "error");
    } finally {
      btn.disabled = false; btn.textContent = "Update password";
    }
  });

  // Sign out everywhere
  document.getElementById("signout-all-btn")?.addEventListener("click", async () => {
    if (!confirm("Sign out of all devices and browsers?\n\nYou'll need to sign in again everywhere.")) return;
    const btn = document.getElementById("signout-all-btn");
    btn.disabled = true; btn.textContent = "Signing out…";
    try {
      await apiFetch("/auth/logout-all", { method: "POST" });
    } catch (_) {}
    logout();
  });

  // Delete account
  document.getElementById("delete-account-btn")?.addEventListener("click", () => {
    const confirmed = prompt(
      'This permanently deletes your account, all agents, and all data.\n\n' +
      'Type DELETE to confirm:'
    );
    if (confirmed !== "DELETE") return;
    apiFetch("/auth/delete-account", { method: "DELETE" })
      .then(() => logout())
      .catch(e => alert("Could not delete account: " + e.message));
  });

  // Team Keys tab
  document.getElementById("team-key-create-btn").addEventListener("click", _createTeamKey);
  document.getElementById("team-key-copy-btn").addEventListener("click", function () {
    const val = document.getElementById("team-key-value")?.textContent || "";
    navigator.clipboard.writeText(val).catch(() => {});
    this.textContent = "Copied!";
    setTimeout(() => { this.textContent = "Copy key"; }, 1800);
  });

  // Key Rotation tab
  document.getElementById("rotation-status-btn").addEventListener("click", _checkRotationStatus);

  // Webhooks tab
  document.getElementById("wh-create-btn").addEventListener("click", _createWebhook);
  document.getElementById("webhooks-refresh-btn").addEventListener("click", _loadWebhooks);
  document.getElementById("wh-secret-copy-btn").addEventListener("click", function () {
    const val = document.getElementById("wh-secret-value")?.textContent || "";
    navigator.clipboard.writeText(val).catch(() => {});
    this.textContent = "Copied!";
    setTimeout(() => { this.textContent = "Copy secret"; }, 1800);
  });

  // ── Export CSV ──────────────────────────────────────────────────────────────
  document.getElementById("csv-btn").addEventListener("click", async function () {
    if (!apiKey) return;
    const btn = this;
    const original = btn.textContent;
    btn.textContent = "Exporting…";
    btn.disabled = true;
    try {
      const res = await fetch(`${BASE}/pro/audit-log/csv`, { headers: { "x-api-key": apiKey } });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "audit-log.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch { alert("Could not export CSV — please try again."); }
    finally { btn.textContent = original; btn.disabled = false; }
  });

  // ── Export JSON ──────────────────────────────────────────────────────────────
  document.getElementById("json-btn").addEventListener("click", async function () {
    if (!apiKey) return;
    const btn = this;
    const original = btn.textContent;
    btn.textContent = "Exporting…";
    btn.disabled = true;
    try {
      const res = await fetch(`${BASE}/pro/audit-log/json`, { headers: { "x-api-key": apiKey } });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "audit-log.json"; a.click();
      URL.revokeObjectURL(url);
    } catch { alert("Could not export JSON — please try again."); }
    finally { btn.textContent = original; btn.disabled = false; }
  });

  // ── PDF Report ───────────────────────────────────────────────────────────────
  document.getElementById("pdf-btn").addEventListener("click", async function () {
    if (!apiKey) return;
    const btn = this;
    const original = btn.textContent;
    btn.textContent = "Generating…";
    btn.disabled = true;
    try {
      const res = await fetch(`${BASE}/pro/analytics/report.pdf`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      const cd   = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match ? match[1] : "agentid-analytics.pdf";
      a.href = url; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (e.message === "403") alert("PDF reports require a Pro or Enterprise plan.");
      else alert("Could not generate PDF — please try again.");
    } finally { btn.textContent = original; btn.disabled = false; }
  });

  // ── Signing filters ──────────────────────────────────────────────────────────
  function _applySigningFilters() {
    _signing.status   = document.getElementById("signing-status-filter")?.value || "";
    _signing.fromDate = document.getElementById("signing-from-date")?.value || "";
    _signing.toDate   = document.getElementById("signing-to-date")?.value || "";
    _signing.page = 1;
    loadSigningActivity();
  }
  document.getElementById("signing-status-filter")?.addEventListener("change", _applySigningFilters);
  document.getElementById("signing-from-date")?.addEventListener("change", _applySigningFilters);
  document.getElementById("signing-to-date")?.addEventListener("change", _applySigningFilters);
  document.getElementById("signing-filter-clear")?.addEventListener("click", function () {
    document.getElementById("signing-status-filter").value = "";
    document.getElementById("signing-from-date").value = "";
    document.getElementById("signing-to-date").value = "";
    _signing.status = ""; _signing.fromDate = ""; _signing.toDate = "";
    _signing.page = 1;
    loadSigningActivity();
  });

  // ── Register Agent modal ─────────────────────────────────────────────────────
  const _reg = { kp: null, did: null, pubB64: null, seedB64: null, capsArr: [], downloaded: false };

  function _base58Encode(bytes) {
    const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt("0x" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join(""));
    let out = "";
    while (n > 0n) { out = ALPHA[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = ALPHA[0] + out; }
    return out;
  }

  function _canonicalJSON(obj) {
    if (typeof obj !== "object" || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return "[" + obj.map(_canonicalJSON).join(",") + "]";
    return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + _canonicalJSON(obj[k])).join(",") + "}";
  }

  async function _generateKeyPair() {
    const kp      = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubRaw  = await crypto.subtle.exportKey("raw", kp.publicKey);
    const pubBytes = new Uint8Array(pubRaw);
    const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const seedB64url = privJwk.d;
    const seedB64 = seedB64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      seedB64url.length + (4 - seedB64url.length % 4) % 4, "="
    );
    const did   = "did:agentid:" + _base58Encode(pubBytes);
    const pubB64 = btoa(String.fromCharCode(...pubBytes));
    return { kp, did, pubB64, seedB64, pubBytes };
  }

  async function _signPayload(kp, payload) {
    const msg = new TextEncoder().encode(_canonicalJSON(payload));
    const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, msg);
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  function _renderCapPills() {
    const wrap = document.getElementById("reg-caps-pills");
    if (!wrap) return;
    wrap.innerHTML = _reg.capsArr.map((c, i) => `
      <span class="cap-pill-removable">${esc(c)}
        <button data-cap-idx="${i}" title="Remove">×</button>
      </span>`).join("");
    wrap.querySelectorAll("button[data-cap-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        _reg.capsArr.splice(Number(btn.dataset.capIdx), 1);
        _renderCapPills();
      });
    });
  }

  function _regAddCap() {
    const input = document.getElementById("reg-caps-input");
    const val = (input?.value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!val || _reg.capsArr.includes(val)) { if (input) input.value = ""; return; }
    _reg.capsArr.push(val);
    if (input) input.value = "";
    _renderCapPills();
  }

  function _regReset() {
    _reg.kp = null; _reg.did = null; _reg.pubB64 = null; _reg.seedB64 = null;
    _reg.capsArr = []; _reg.downloaded = false;
    document.getElementById("reg-step-1").style.display = "";
    document.getElementById("reg-step-2").style.display = "none";
    document.getElementById("reg-name").value = "";
    document.getElementById("reg-caps-input").value = "";
    document.getElementById("reg-private").checked = false;
    document.getElementById("reg-caps-pills").innerHTML = "";
    document.getElementById("reg-step1-msg").textContent = "";
    document.getElementById("reg-step2-msg").textContent = "";
    document.getElementById("reg-success").style.display = "none";
    document.getElementById("reg-download-warning").style.display = "none";
    const regBtn = document.getElementById("reg-register-btn");
    if (regBtn) regBtn.style.display = "";
  }

  document.getElementById("register-agent-btn")?.addEventListener("click", () => {
    _regReset();
    document.getElementById("register-modal").style.display = "flex";
  });
  document.getElementById("register-modal-close")?.addEventListener("click", () => {
    document.getElementById("register-modal").style.display = "none";
  });
  document.getElementById("register-modal")?.addEventListener("click", function (e) {
    if (e.target === this) this.style.display = "none";
  });

  document.getElementById("reg-caps-add-btn")?.addEventListener("click", _regAddCap);
  document.getElementById("reg-caps-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); _regAddCap(); }
  });
  document.getElementById("reg-back-btn")?.addEventListener("click", () => {
    document.getElementById("reg-step-1").style.display = "";
    document.getElementById("reg-step-2").style.display = "none";
  });

  document.getElementById("reg-generate-btn")?.addEventListener("click", async function () {
    const name = (document.getElementById("reg-name")?.value || "").trim();
    const msgEl = document.getElementById("reg-step1-msg");
    msgEl.textContent = "";
    if (!name) { msgEl.textContent = "Agent name is required."; msgEl.style.color = "var(--red)"; return; }
    this.textContent = "Generating…"; this.disabled = true;
    try {
      const keypair = await _generateKeyPair();
      _reg.kp = keypair.kp; _reg.did = keypair.did;
      _reg.pubB64 = keypair.pubB64; _reg.seedB64 = keypair.seedB64;
      document.getElementById("reg-did-display").textContent = keypair.did;
      document.getElementById("reg-step-1").style.display = "none";
      document.getElementById("reg-step-2").style.display = "";
      document.getElementById("reg-success").style.display = "none";
      document.getElementById("reg-register-btn").style.display = "";
    } catch (e) {
      msgEl.textContent = "Key generation failed — your browser may not support Ed25519. Try Chrome 113+ or Firefox 130+.";
      msgEl.style.color = "var(--red)";
    } finally { this.textContent = "Generate Keys & Preview"; this.disabled = false; }
  });

  document.getElementById("reg-download-key-btn")?.addEventListener("click", function () {
    if (!_reg.did) return;
    const name = (document.getElementById("reg-name")?.value || "").trim();
    const payload = JSON.stringify({
      did:              _reg.did,
      name:             name,
      public_key_b64:   _reg.pubB64,
      private_key_b64:  _reg.seedB64,
      created_at:       new Date().toISOString(),
      warning:          "Keep this file secret. Anyone with your private key can sign as this agent.",
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "agentid-key-" + _reg.did.slice(-12) + ".json";
    a.click();
    URL.revokeObjectURL(url);
    _reg.downloaded = true;
    document.getElementById("reg-download-warning").style.display = "none";
    this.textContent = "⬇ Downloaded ✓";
    this.style.borderColor = "var(--green)";
    this.style.color = "var(--green)";
  });

  document.getElementById("reg-register-btn")?.addEventListener("click", async function () {
    if (!_reg.did) return;
    if (!_reg.downloaded) {
      document.getElementById("reg-download-warning").style.display = "";
      return;
    }
    const name      = (document.getElementById("reg-name")?.value || "").trim();
    const isPrivate = document.getElementById("reg-private")?.checked || false;
    const owner     = document.getElementById("dash-title")?.textContent || "";
    const msgEl     = document.getElementById("reg-step2-msg");
    msgEl.textContent = "";
    this.textContent = "Registering…"; this.disabled = true;

    try {
      const createdAt = new Date().toISOString();
      const payload = {
        did:          _reg.did,
        name,
        capabilities: [..._reg.capsArr],
        owner,
        public_key:   _reg.pubB64,
        created_at:   createdAt,
        metadata:     {},
        private:      isPrivate,
      };
      const proof = await _signPayload(_reg.kp, payload);
      const res = await fetch(`${BASE}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ ...payload, proof }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.status);

      document.getElementById("reg-register-btn").style.display = "none";
      document.getElementById("reg-success").style.display = "";
      document.getElementById("reg-success-did").textContent = _reg.did;
      document.getElementById("reg-view-btn").onclick = () => {
        window.open(`agent.html?did=${encodeURIComponent(_reg.did)}`, "_blank");
      };
      document.getElementById("reg-another-btn").onclick = () => {
        _regReset();
      };
      loadAgentsTable();  // refresh the agents table
    } catch (e) {
      msgEl.textContent = "Registration failed: " + e.message;
      msgEl.style.color = "var(--red)";
    } finally { this.textContent = "Register Agent"; this.disabled = false; }
  });

  // ── Team key invite link ─────────────────────────────────────────────────────
  document.getElementById("team-invite-btn")?.addEventListener("click", async function () {
    const label  = (document.getElementById("team-key-label")?.value || "").trim();
    const expiry = document.getElementById("team-key-expiry")?.value || "48";
    const scopes = [...document.querySelectorAll("#tab-team-keys input[type=checkbox]:checked")]
      .map(cb => cb.value).join(",");
    const msgEl = document.getElementById("team-key-msg");
    msgEl.textContent = "";
    document.getElementById("team-invite-reveal").style.display = "none";
    document.getElementById("team-key-reveal").style.display = "none";

    if (!scopes) { msgEl.textContent = "Select at least one scope."; msgEl.style.color = "var(--red)"; return; }
    this.textContent = "Creating…"; this.disabled = true;
    try {
      const res = await apiFetch("/pro/keys/invite", {
        method: "POST",
        body: JSON.stringify({ scopes, label, expires_in_hours: Number(expiry) || 48 }),
      });
      const inviteUrl = `${location.origin}${location.pathname.replace("dashboard.html","accept-invite.html")}?token=${encodeURIComponent(res.token)}`;
      document.getElementById("team-invite-url").textContent = inviteUrl;
      document.getElementById("team-invite-meta").textContent =
        `Scopes: ${res.scopes} · Expires ${new Date(res.expires_at).toLocaleString()}`;
      document.getElementById("team-invite-reveal").style.display = "";
      document.getElementById("team-invite-copy-btn").onclick = function () {
        navigator.clipboard.writeText(inviteUrl).catch(() => {});
        this.textContent = "Copied!";
        setTimeout(() => { this.textContent = "Copy link"; }, 1800);
      };
    } catch (e) {
      msgEl.textContent = "Failed to create invite: " + (e.message || "unknown error");
      msgEl.style.color = "var(--red)";
    } finally { this.textContent = "🔗 Create Invite Link"; this.disabled = false; }
  });

  // ── Test Verify modal ────────────────────────────────────────────────────────
  let _verifyDid = "";
  document.getElementById("verify-modal-close")?.addEventListener("click", () => {
    document.getElementById("verify-modal").style.display = "none";
  });
  document.getElementById("verify-modal")?.addEventListener("click", function(e) {
    if (e.target === this) this.style.display = "none";
  });

  function _openTestVerify(did, name) {
    _verifyDid = did;
    document.getElementById("verify-modal-name").textContent = name;
    document.getElementById("verify-payload-input").value = JSON.stringify({ action: "approve", timestamp: new Date().toISOString() }, null, 2);
    document.getElementById("verify-sig-input").value = "";
    document.getElementById("verify-result").style.display = "none";
    document.getElementById("verify-run-btn").textContent = "Run Verification";
    document.getElementById("verify-modal").style.display = "flex";
  }

  document.getElementById("verify-run-btn")?.addEventListener("click", async function () {
    const rawPayload = document.getElementById("verify-payload-input").value.trim();
    const sig        = document.getElementById("verify-sig-input").value.trim();
    const resultEl   = document.getElementById("verify-result");
    resultEl.style.display = "none";
    if (!rawPayload || !sig) {
      resultEl.style.cssText = "display:block;padding:0.85rem 1rem;border-radius:8px;font-size:0.85rem;font-weight:600;background:var(--red-bg);border:1px solid var(--red);color:var(--red);margin-bottom:1rem;";
      resultEl.textContent = "Both payload and signature are required."; return;
    }
    let payload;
    try { payload = JSON.parse(rawPayload); }
    catch { resultEl.style.cssText = "display:block;padding:0.85rem 1rem;border-radius:8px;font-size:0.85rem;font-weight:600;background:var(--red-bg);border:1px solid var(--red);color:var(--red);margin-bottom:1rem;";
      resultEl.textContent = "Payload is not valid JSON."; return; }

    this.textContent = "Verifying…"; this.disabled = true;
    try {
      const res = await fetch(`${BASE}/agents/${encodeURIComponent(_verifyDid)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ payload, signature: sig }),
      });
      const data = await res.json();
      const valid = data.status === "valid";
      resultEl.style.cssText = `display:block;padding:0.85rem 1rem;border-radius:8px;font-size:0.85rem;font-weight:600;background:${valid ? "var(--green-bg)" : "var(--red-bg)"};border:1px solid ${valid ? "var(--green)" : "var(--red)"};color:${valid ? "var(--green)" : "var(--red)"};margin-bottom:1rem;`;
      resultEl.textContent = valid ? "✓ Valid — signature verified successfully." : "✗ Invalid — signature does not match this agent's public key.";
    } catch(e) {
      resultEl.style.cssText = "display:block;padding:0.85rem 1rem;border-radius:8px;font-size:0.85rem;font-weight:600;background:var(--red-bg);border:1px solid var(--red);color:var(--red);margin-bottom:1rem;";
      resultEl.textContent = "Error: " + e.message;
    } finally { this.textContent = "Run Verification"; this.disabled = false; }
  });

  // ── Code Snippets modal ───────────────────────────────────────────────────────
  const _snippetTemplates = {
    python: (did) =>
`from agentid import Agent

# Load your agent using the private key you downloaded
agent = Agent.from_file("agentid-key.json")

# Sign a payload
payload = {"action": "approve", "timestamp": "2026-01-01T00:00:00Z"}
signature = agent.sign(payload)

# Verify against ${did}
result = Agent.verify_from_did(
    did="${did}",
    payload=payload,
    signature=signature,
)
print(result.status)   # "valid" or "invalid"`,

    js: (did) =>
`const BASE = "https://api.agentid-protocol.com";

// Verify a signed payload against ${did}
const res = await fetch(\`\${BASE}/agents/${did}/verify\`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "YOUR_API_KEY",
  },
  body: JSON.stringify({
    payload:   { action: "approve", timestamp: new Date().toISOString() },
    signature: "BASE64_SIGNATURE_HERE",
  }),
});
const { status } = await res.json();
console.log(status);  // "valid" or "invalid"`,

    curl: (did) =>
`# Resolve agent
curl https://api.agentid-protocol.com/agents/${did}

# Verify a signed payload
curl -X POST https://api.agentid-protocol.com/agents/${did}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "payload":   {"action":"approve","timestamp":"2026-01-01T00:00:00Z"},
    "signature": "BASE64_SIGNATURE_HERE"
  }'`,
  };

  let _activeSnippetTab = "python";
  let _currentSnippetDid = "";

  document.getElementById("snippets-modal-close")?.addEventListener("click", () => {
    document.getElementById("snippets-modal").style.display = "none";
  });
  document.getElementById("snippets-modal")?.addEventListener("click", function(e) {
    if (e.target === this) this.style.display = "none";
  });

  function _renderSnippet() {
    const code = _snippetTemplates[_activeSnippetTab]?.(_currentSnippetDid) || "";
    document.getElementById("snippets-code").textContent = code;
  }

  function _openSnippets(did, name) {
    _currentSnippetDid = did;
    document.getElementById("snippets-modal-name").textContent = name;
    _activeSnippetTab = "python";
    document.querySelectorAll("[data-stab]").forEach(t => t.classList.toggle("active", t.dataset.stab === "python"));
    _renderSnippet();
    document.getElementById("snippets-modal").style.display = "flex";
  }

  document.getElementById("snippets-tabs")?.addEventListener("click", e => {
    const tab = e.target.closest("[data-stab]");
    if (!tab) return;
    _activeSnippetTab = tab.dataset.stab;
    document.querySelectorAll("[data-stab]").forEach(t => t.classList.toggle("active", t === tab));
    _renderSnippet();
  });

  document.getElementById("snippets-copy-btn")?.addEventListener("click", function () {
    const code = document.getElementById("snippets-code").textContent;
    navigator.clipboard.writeText(code).catch(() => {});
    this.textContent = "copied!";
    setTimeout(() => { this.textContent = "copy"; }, 1800);
  });

  // ── Agent row action delegation ───────────────────────────────────────────────
  document.getElementById("agents-table")?.addEventListener("click", e => {
    const btn = e.target.closest(".agent-action-btn");
    if (!btn) return;
    const { action, did, name } = btn.dataset;
    if (action === "details")  _openAgentDetail(did, name);
    if (action === "verify")   _openTestVerify(did, name);
    if (action === "snippets") _openSnippets(did, name);
  });

  // ── API Playground ───────────────────────────────────────────────────────────
  (function _initPlayground() {
    const methodSel = document.getElementById("pg-method");
    const pathInput = document.getElementById("pg-path");
    const bodyWrap  = document.getElementById("pg-body-wrap");
    const runBtn    = document.getElementById("pg-run-btn");
    const respEl    = document.getElementById("pg-response");
    const statusEl  = document.getElementById("pg-status-line");
    const bodyEl    = document.getElementById("pg-response-body");
    const copyBtn   = document.getElementById("pg-copy-btn");
    if (!runBtn) return;

    function toggleBody() {
      const m = methodSel?.value;
      if (bodyWrap) bodyWrap.style.display = (m === "POST" || m === "PATCH") ? "" : "none";
    }
    methodSel?.addEventListener("change", toggleBody);
    toggleBody();

    document.querySelectorAll(".pg-preset").forEach(btn => {
      btn.addEventListener("click", () => {
        methodSel.value = btn.dataset.method;
        pathInput.value = btn.dataset.path;
        toggleBody();
        pathInput.focus();
      });
    });

    runBtn.addEventListener("click", async function() {
      const method = methodSel.value;
      const path   = (pathInput.value || "").trim();
      if (!path) return;
      this.disabled = true; this.textContent = "Running…";
      respEl.style.display = "";
      statusEl.textContent = "…";
      bodyEl.textContent   = "";
      const t0 = Date.now();
      try {
        const opts = { method, headers: { "x-api-key": apiKey } };
        const rawBody = document.getElementById("pg-body")?.value?.trim();
        if ((method === "POST" || method === "PATCH") && rawBody) {
          opts.headers["Content-Type"] = "application/json";
          opts.body = rawBody;
        }
        const res = await fetch(BASE + path, opts);
        const ms  = Date.now() - t0;
        const text = await res.text();
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
        const color = res.ok ? "var(--green)" : "var(--red)";
        statusEl.innerHTML = `<span style="color:${color};font-weight:700;">HTTP ${res.status}</span> · ${ms}ms · ${text.length} bytes`;
        bodyEl.textContent = pretty;
      } catch(e) {
        statusEl.innerHTML = `<span style="color:var(--red);">Network error</span>`;
        bodyEl.textContent = e.message;
      }
      this.disabled = false; this.textContent = "▶ Run";
    });

    copyBtn?.addEventListener("click", function() {
      navigator.clipboard.writeText(bodyEl.textContent).catch(() => {});
      this.textContent = "copied!"; setTimeout(() => { this.textContent = "copy"; }, 1800);
    });
  })();

  // ── Admin re-auth gate ────────────────────────────────────────────────────────
  document.querySelector('#tab-team-keys input[value="admin"]')?.addEventListener("change", function () {
    const gate = document.getElementById("admin-reauth-gate");
    if (gate) gate.style.display = this.checked ? "" : "none";
    if (!this.checked && document.getElementById("admin-reauth-input"))
      document.getElementById("admin-reauth-input").value = "";
  });

  // Patch team key create to enforce re-auth when admin is checked
  const _origCreateTeamKey = window._createTeamKey;
  document.getElementById("team-key-create-btn")?.addEventListener("click", function(e) {
    const adminChecked = document.querySelector('#tab-team-keys input[value="admin"]')?.checked;
    if (adminChecked) {
      const reauth = (document.getElementById("admin-reauth-input")?.value || "").trim();
      if (!reauth || reauth !== apiKey) {
        const msgEl = document.getElementById("team-key-msg");
        if (msgEl) { msgEl.textContent = "Re-enter your API key to confirm admin scope."; msgEl.style.color = "var(--red)"; }
        return;
      }
    }
  }, true);   // capture phase so it fires before the existing handler

  // ── Trust Score Fleet Widget ─────────────────────────────────────────────────

  async function _loadTrustScoreWidget() {
    const card = document.getElementById("trust-score-card");
    const list = document.getElementById("trust-score-list");
    const distRow = document.getElementById("trust-dist-row");
    if (!card || !list) return;

    try {
      const data = await apiFetch("/pro/trust-scores");
      if (!data || !data.agents || data.agents.length === 0) {
        card.style.display = "none";
        return;
      }

      card.style.display = "";

      // Distribution badges
      const dist = data.distribution || {};
      const levels = [
        { key: "excellent", label: "Excellent", cls: "trust-level-excellent" },
        { key: "good",      label: "Good",      cls: "trust-level-good"      },
        { key: "moderate",  label: "Moderate",  cls: "trust-level-moderate"  },
        { key: "low",       label: "Low",       cls: "trust-level-low"       },
      ];
      distRow.innerHTML = levels.map(l => {
        const count = dist[l.key] || 0;
        return `<span class="trust-dist-pill ${l.cls}">${l.label} <strong>${count}</strong></span>`;
      }).join("") + `<span style="margin-left:auto;font-size:0.78rem;color:var(--muted);">Fleet avg: <strong>${(data.average_score || 0).toFixed(1)}</strong></span>`;

      // Per-agent rows
      const COLOR = { excellent: "#22c55e", good: "#3b82f6", moderate: "#f59e0b", low: "#ef4444" };
      list.innerHTML = data.agents.map(a => {
        const pct = Math.round(a.score);
        const color = COLOR[a.level] || "#94a3b8";
        return `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${a.did}">${a.name || a.did.slice(0, 28) + "…"}</div>
            <div style="font-size:0.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.did}</div>
          </div>
          <div class="trust-score-bar-wrap" style="width:140px;flex-shrink:0;">
            <div style="height:6px;border-radius:999px;background:var(--surface2);flex:1;overflow:hidden;">
              <div class="trust-score-bar" style="width:${pct}%;background:${color};height:100%;"></div>
            </div>
            <span style="font-size:0.78rem;font-weight:700;color:${color};min-width:28px;text-align:right;">${pct}</span>
          </div>
          <span class="trust-level-badge trust-level-${a.level}" style="flex-shrink:0;">${a.level}</span>
        </div>`;
      }).join("");
    } catch (e) {
      // Silently skip if endpoint unavailable (feature gate)
    }
  }

  // ── Sandbox ──────────────────────────────────────────────────────────────────

  async function _loadSandboxStatus() {
    const dot  = document.getElementById("sandbox-status-dot");
    const text = document.getElementById("sandbox-status-text");
    const usage = document.getElementById("sandbox-usage");
    if (!dot) return;
    try {
      const data = await apiFetch("/pro/sandbox/status");
      if (data.sandbox_mode) {
        dot.style.background  = "var(--green, #22c55e)";
        text.textContent = "Sandbox mode is ACTIVE";
        usage.style.display = "block";
        usage.textContent = `${data.agent_count} / ${data.agent_cap} agents used`;
      } else {
        dot.style.background = "var(--muted)";
        text.textContent = "Sandbox mode is disabled";
        usage.style.display = "none";
      }
    } catch(e) {
      text.textContent = "Could not fetch sandbox status";
    }
  }

  function _sbMsg(msg, ok = true) {
    const el = document.getElementById("sandbox-msg");
    if (!el) return;
    el.textContent = msg;
    el.style.background = ok ? "var(--green-bg, #dcfce7)" : "var(--red-bg, #fef2f2)";
    el.style.color = ok ? "var(--green, #15803d)" : "var(--red)";
    el.style.display = "block";
    setTimeout(() => { el.style.display = "none"; }, 4000);
  }

  document.getElementById("sandbox-enable-btn")?.addEventListener("click", async () => {
    try {
      await apiFetch("/pro/sandbox/enable", { method: "POST" });
      _sbMsg("Sandbox mode enabled! Use did:sandbox: prefix for test agents.");
      await _loadSandboxStatus();
    } catch(e) { _sbMsg(e.message, false); }
  });

  document.getElementById("sandbox-reset-btn")?.addEventListener("click", async () => {
    if (!confirm("Reset sandbox? All sandbox agents and logs will be permanently deleted.")) return;
    try {
      const res = await apiFetch("/pro/sandbox/reset", { method: "POST" });
      _sbMsg(`Sandbox reset — ${res.agents_deleted} agent${res.agents_deleted !== 1 ? "s" : ""} deleted.`);
      await _loadSandboxStatus();
    } catch(e) { _sbMsg(e.message, false); }
  });

  // ── Agent Groups ─────────────────────────────────────────────────────────────

  let _editingGroupId = null;

  async function _loadGroups() {
    const container = document.getElementById("groups-list");
    const empty     = document.getElementById("groups-empty");
    if (!container) return;
    try {
      const data = await apiFetch("/pro/groups");
      const groups = data.groups || [];
      container.innerHTML = "";
      if (!groups.length) {
        empty && (empty.style.display = "block");
        return;
      }
      empty && (empty.style.display = "none");
      const tbl = document.createElement("table");
      tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:0.85rem;";
      tbl.innerHTML = `
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;padding:0.5rem 0.75rem;font-weight:600;color:var(--muted);font-size:0.75rem;">NAME</th>
            <th style="text-align:left;padding:0.5rem 0.75rem;font-weight:600;color:var(--muted);font-size:0.75rem;">DESCRIPTION</th>
            <th style="text-align:center;padding:0.5rem 0.75rem;font-weight:600;color:var(--muted);font-size:0.75rem;">AGENTS</th>
            <th style="padding:0.5rem 0.75rem;"></th>
          </tr>
        </thead>`;
      const tbody = document.createElement("tbody");
      groups.forEach(g => {
        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid var(--border)";
        tr.innerHTML = `
          <td style="padding:0.6rem 0.75rem;font-weight:600;">${_esc(g.name)}</td>
          <td style="padding:0.6rem 0.75rem;color:var(--muted);font-size:0.82rem;">${_esc(g.description || "—")}</td>
          <td style="padding:0.6rem 0.75rem;text-align:center;">
            <span style="background:var(--accent-bg);color:var(--accent);border-radius:12px;padding:0.15rem 0.6rem;font-size:0.75rem;font-weight:600;">${g.member_count}</span>
          </td>
          <td style="padding:0.6rem 0.75rem;text-align:right;white-space:nowrap;">
            <button class="agent-action-btn grp-members-btn" data-id="${g.id}" data-name="${_esc(g.name)}">Members</button>
            <button class="agent-action-btn grp-edit-btn" data-id="${g.id}" data-name="${_esc(g.name)}" data-desc="${_esc(g.description || "")}">Edit</button>
            <button class="agent-action-btn danger grp-delete-btn" data-id="${g.id}" style="color:var(--red);">Delete</button>
          </td>`;
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      container.appendChild(tbl);

      container.querySelectorAll(".grp-members-btn").forEach(btn =>
        btn.addEventListener("click", () => _openGroupMembers(+btn.dataset.id, btn.dataset.name))
      );
      container.querySelectorAll(".grp-edit-btn").forEach(btn =>
        btn.addEventListener("click", () => _openGroupEdit(+btn.dataset.id, btn.dataset.name, btn.dataset.desc))
      );
      container.querySelectorAll(".grp-delete-btn").forEach(btn =>
        btn.addEventListener("click", () => _deleteGroup(+btn.dataset.id, btn.dataset.name))
      );
    } catch(e) {
      container.innerHTML = `<p style="font-size:0.83rem;color:var(--red);padding:0.5rem 0;">Could not load groups: ${e.message}</p>`;
    }
  }

  function _openGroupModal(title, name = "", desc = "", id = null) {
    _editingGroupId = id;
    document.getElementById("group-modal-title").textContent = title;
    document.getElementById("group-name-input").value = name;
    document.getElementById("group-desc-input").value = desc;
    document.getElementById("group-modal-error").style.display = "none";
    document.getElementById("group-modal-save").textContent = id ? "Save changes" : "Create group";
    document.getElementById("group-modal").style.display = "flex";
    document.getElementById("group-name-input").focus();
  }

  function _openGroupEdit(id, name, desc) {
    _openGroupModal("Edit Group", name, desc, id);
  }

  document.getElementById("create-group-btn")?.addEventListener("click", () =>
    _openGroupModal("Create Group")
  );
  document.getElementById("group-modal-close")?.addEventListener("click", () => {
    document.getElementById("group-modal").style.display = "none";
  });

  document.getElementById("group-modal-save")?.addEventListener("click", async () => {
    const name = (document.getElementById("group-name-input").value || "").trim();
    const desc = (document.getElementById("group-desc-input").value || "").trim();
    const errEl = document.getElementById("group-modal-error");
    if (!name) { errEl.textContent = "Group name is required."; errEl.style.display = "block"; return; }
    errEl.style.display = "none";
    try {
      if (_editingGroupId) {
        await apiFetch(`/pro/groups/${_editingGroupId}`, { method: "PATCH", body: JSON.stringify({ name, description: desc }) });
        _showToast("Group updated.");
      } else {
        await apiFetch("/pro/groups", { method: "POST", body: JSON.stringify({ name, description: desc }) });
        _showToast("Group created.");
      }
      document.getElementById("group-modal").style.display = "none";
      _loadGroups();
    } catch(e) {
      errEl.textContent = e.message || "Failed to save group.";
      errEl.style.display = "block";
    }
  });

  async function _deleteGroup(id, name) {
    if (!confirm(`Delete group "${name}"? Agents will not be removed.`)) return;
    try {
      await apiFetch(`/pro/groups/${id}`, { method: "DELETE" });
      _showToast(`Group "${name}" deleted.`);
      _loadGroups();
    } catch(e) {
      _showToast(`Error: ${e.message}`, true);
    }
  }

  // ── Group Members modal ───────────────────────────────────────────────────────

  let _currentGroupId = null;

  async function _openGroupMembers(id, name) {
    _currentGroupId = id;
    document.getElementById("gmm-title").textContent = `Members — ${name}`;
    document.getElementById("group-members-modal").style.display = "flex";
    await _loadGroupMembers(id);

    // Populate agent select from _allAgents
    const sel = document.getElementById("gmm-agent-select");
    sel.innerHTML = '<option value="">— pick an agent —</option>';
    (_allAgents || []).forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.did;
      opt.textContent = `${a.name} (${a.did.slice(0, 24)}…)`;
      sel.appendChild(opt);
    });
  }

  async function _loadGroupMembers(id) {
    const el = document.getElementById("gmm-members-list");
    if (!el) return;
    try {
      const data = await apiFetch(`/pro/groups/${id}`);
      const members = data.members || [];
      if (!members.length) {
        el.innerHTML = '<p style="font-size:0.83rem;color:var(--muted);">No members yet.</p>';
        return;
      }
      el.innerHTML = members.map(m => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0.45rem 0;border-bottom:1px solid var(--border);">
          <div>
            <span style="font-weight:600;font-size:0.85rem;">${_esc(m.name || m.did)}</span>
            <span style="font-size:0.75rem;color:var(--muted);margin-left:0.5rem;">${m.did.slice(0, 32)}…</span>
          </div>
          <button class="agent-action-btn danger gmm-remove-btn" data-did="${_esc(m.did)}" style="font-size:0.78rem;color:var(--red);">Remove</button>
        </div>`).join("");
      el.querySelectorAll(".gmm-remove-btn").forEach(btn =>
        btn.addEventListener("click", async () => {
          try {
            await apiFetch(`/pro/groups/${_currentGroupId}/members`, {
              method: "DELETE",
              body: JSON.stringify({ dids: [btn.dataset.did] }),
            });
            await _loadGroupMembers(_currentGroupId);
            _loadGroups();
          } catch(e) { _showToast(`Error: ${e.message}`, true); }
        })
      );
    } catch(e) {
      el.innerHTML = `<p style="color:var(--red);font-size:0.83rem;">${e.message}</p>`;
    }
  }

  document.getElementById("gmm-close")?.addEventListener("click", () => {
    document.getElementById("group-members-modal").style.display = "none";
  });

  document.getElementById("gmm-add-btn")?.addEventListener("click", async () => {
    const did = document.getElementById("gmm-agent-select").value;
    if (!did) return;
    try {
      await apiFetch(`/pro/groups/${_currentGroupId}/members`, {
        method: "POST",
        body: JSON.stringify({ dids: [did] }),
      });
      await _loadGroupMembers(_currentGroupId);
      _loadGroups();
    } catch(e) { _showToast(`Error: ${e.message}`, true); }
  });

  // ── Trust Score Fleet Widget ──────────────────────────────────────────────
  document.getElementById("trust-score-refresh")?.addEventListener("click", _loadTrustScoreWidget);

  // Auto-login on page load.
  //   1. If we have a raw API key in sessionStorage → resume API-key mode
  //   2. Otherwise probe /auth/me — if the server still has a session
  //      cookie for us, log straight in. The browser handles the cookie;
  //      JS never sees it.
  //   3. If neither works, show the login screen (no banner).
  //   4. If we WERE previously logged in (stored auth_mode) but auth has
  //      now dropped, surface a "session expired" banner so the user
  //      knows to re-authenticate instead of being silently logged out.
  (async () => {
    const previouslyLoggedIn = !!sessionStorage.getItem("agentid_auth_mode");

    // Detect the half-state: auth_mode says "apikey" but no key is present.
    // This happens when the session-expiry timer fired, the key was cleared,
    // but auth_mode wasn't (older bug). Clean it up so we don't try a doomed
    // apikey-mode load.
    if (sessionStorage.getItem("agentid_auth_mode") === "apikey" && !apiKey) {
      sessionStorage.removeItem("agentid_auth_mode");
      authMode = "session";
    }

    if (apiKey) {
      if (getSessionAge() >= SESSION_TTL_MS) {
        expireSession();
        return;
      }
      authMode = "apikey";
      sessionStorage.setItem("agentid_auth_mode", "apikey");
      _markFreshLogin();
      try {
        await loadDashboard();
        scheduleSessionExpiry();
        return;
      } catch (e) {
        sessionStorage.removeItem("agentid_key");
        sessionStorage.removeItem("agentid_login_ts");
        apiKey = "";
        if (previouslyLoggedIn) _showSessionExpiredBanner(String(e.message || ""));
        return;
      }
    }

    // No raw key — try the cookie path silently.
    try {
      const r = await fetch(BASE + "/auth/me", { credentials: "include" });
      if (r.ok) {
        authMode = "session";
        sessionStorage.setItem("agentid_auth_mode", "session");
        sessionStorage.setItem("agentid_login_ts",
          sessionStorage.getItem("agentid_login_ts") || String(Date.now()));
        _markFreshLogin();
        await loadDashboard();
        scheduleSessionExpiry();
        return;
      }
      if (previouslyLoggedIn) _showSessionExpiredBanner("Your session has expired");
    } catch (_) { /* network failure — leave login screen */ }
  })();
});

// Visible banner shown on the login screen when a previously-authenticated
// user's session has dropped, so they don't sit confused on the login page.
function _showSessionExpiredBanner(detail) {
  const screen = document.getElementById("login-screen");
  if (!screen) return;
  let b = document.getElementById("session-expired-banner");
  if (!b) {
    b = document.createElement("div");
    b.id = "session-expired-banner";
    b.style.cssText = "background:#fff1d6;border:1px solid #f5d696;color:#8a4a00;padding:0.85rem 1.2rem;border-radius:8px;margin-bottom:1.25rem;font-size:0.88rem;line-height:1.55;max-width:420px;";
    const wrap = screen.querySelector(".login-wrap") || screen;
    wrap.insertBefore(b, wrap.firstChild);
  }
  b.innerHTML = `
    <strong>⚠ Your session has expired.</strong> Please sign in again to continue.
    <div style="font-size:0.74rem;color:#a86515;margin-top:0.4rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(detail).slice(0, 140)}
    </div>`;
}
