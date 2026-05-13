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
          _markFreshLogin();  // grace window: cross-tab load should not immediately 401-drop
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
            _markFreshLogin();  // grace window: cross-tab load should not immediately 401-drop
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

// Module-level slot for _loadGroups — assigned by the DOMContentLoaded
// setup block so loadDashboard() (a top-level function) can call it.
// Use _loadGroups?.() at all call sites so it no-ops if setup hasn't run yet.
let _loadGroups = null;

// ── auto-poll ─────────────────────────────────────────────────────────────────
let _pollTimer   = null;
let _lastRefresh = 0;
const POLL_MS    = 5_000;

// Returns true when the user has an active session (API key or cookie-based).
function _isLoggedIn() {
  return !!(apiKey || sessionStorage.getItem("agentid_key") || authMode === "session");
}

async function _lightRefresh() {
  if (!_isLoggedIn()) return;
  if (document.visibilityState === "hidden") return;
  try {
    // Refresh stats counters (cheap overview call)
    const data = await apiFetch(
      isPro() ? "/pro/analytics/overview" : "/pro/keys/me"
    ).catch(() => null);
    if (data) {
      const agentsReg   = Number(data.usage?.agents_registered) || 0;
      const auditEvents = Number(data.usage?.audit_events)      || 0;
      const totalActivity = (data.activity_last_7d || []).reduce((s,r) => s + r.count, 0);
      const el = id => document.getElementById(id);
      if (el("stat-agents"))    el("stat-agents").textContent    = agentsReg;
      if (el("stat-events"))    el("stat-events").textContent    = auditEvents.toLocaleString();
      if (el("stat-active"))    el("stat-active").textContent    = totalActivity.toLocaleString();
      const limit = TIER_LIMITS[String(data.tier || "free")] ?? 100;
      const pct   = limit === Infinity ? 0 : Math.min(100, Math.round((agentsReg / limit) * 100));
      const fill  = el("usage-fill");
      if (fill) {
        fill.style.width = (limit === Infinity ? 2 : pct) + "%";
        fill.style.background = pct > 90 ? "var(--red)" : pct > 70 ? "var(--yellow)" : "var(--accent)";
      }
      if (el("usage-label") && limit !== Infinity)
        el("usage-label").textContent = `${agentsReg.toLocaleString()} / ${limit.toLocaleString()} agents`;
    }
    // Refresh the sections users watch most
    loadAuditLog().catch(e => console.warn("poll loadAuditLog:", e));
    loadAgentsTable().catch(e => console.warn("poll loadAgentsTable:", e));
    _loadTrustScoreWidget().catch(e => console.warn("poll trustScore:", e));
    _tickLiveIndicator();
  } catch (e) { console.warn("_lightRefresh error:", e); }
}

function _tickLiveIndicator() {
  _lastRefresh = Date.now();
  const dot  = document.querySelector("#live-indicator .live-dot");
  const ts   = document.querySelector("#live-indicator .live-ts");
  if (dot) { dot.style.opacity = "1"; setTimeout(() => { if (dot) dot.style.opacity = "0.4"; }, 800); }
  if (ts)  ts.textContent = "just now";
  clearInterval(_tickLiveIndicator._t);
  _tickLiveIndicator._t = setInterval(() => {
    if (!ts) return;
    const s = Math.floor((Date.now() - _lastRefresh) / 1000);
    ts.textContent = s < 60 ? `${s}s ago` : `${Math.floor(s/60)}m ago`;
  }, 5_000);
}

function startPolling() {
  stopPolling();
  _lightRefresh();                              // immediate first tick
  _pollTimer = setInterval(_lightRefresh, POLL_MS);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && _isLoggedIn()) {
    _lightRefresh();
  }
});

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

function _showToast(msg, isError = false) {
  let el = document.getElementById("_toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "_toast";
    Object.assign(el.style, {
      position:"fixed", bottom:"1.5rem", left:"50%", transform:"translateX(-50%)",
      padding:"0.55rem 1.1rem", borderRadius:"8px", fontSize:"0.8rem",
      fontWeight:"600", zIndex:"9999", pointerEvents:"none",
      transition:"opacity 0.3s", opacity:"0",
      boxShadow:"0 4px 16px rgba(0,0,0,0.4)",
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? "#ef4444" : "#22c55e";
  el.style.color = "#fff";
  el.style.opacity = "1";
  clearTimeout(el._tid);
  el._tid = setTimeout(() => { el.style.opacity = "0"; }, 2800);
}

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

  // Auth strategy: session mode uses the cookie only — never add an API key
  // header, even if a stale one is found in storage. Mixing a bad API key
  // with a valid cookie causes backends to reject on the bad key first.
  // API-key mode rehydrates from storage as before.
  const currentAuthMode = authMode || sessionStorage.getItem("agentid_auth_mode") || "session";
  if (currentAuthMode !== "session") {
    const storedKey = apiKey
                    || sessionStorage.getItem("agentid_key")
                    || localStorage.getItem("agentid_persisted_key")
                    || localStorage.getItem("agentid_key");
    if (storedKey) {
      apiKey = storedKey;          // re-hydrate in-memory copy
      if (!sessionStorage.getItem("agentid_key")) {
        sessionStorage.setItem("agentid_key", storedKey);
      }
      headers["x-api-key"] = storedKey;
    }
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
      const raw = j.detail ?? j.message ?? msg;
      msg = typeof raw === "object" ? (raw?.message || raw?.error || JSON.stringify(raw)) : raw;
    } catch (_) {}
    // 401 self-recovery: only trigger a global session drop when the
    // session-validation endpoints specifically reject the credential.
    // NOT for every /auth/* call — /auth/welcome, /auth/keys, /auth/sessions,
    // /auth/change-password etc. can legitimately 401 for feature-access or
    // input-validation reasons and must NOT kill the dashboard session.
    const _coreAuthPath = path === "/auth/me" || path === "/pro/keys/me";
    if (res.status === 401 && _coreAuthPath && _shouldTriggerSessionDrop()) {
      _triggerSessionDrop(msg);
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Raw fetch mirroring apiFetch auth — returns raw Response (for blob/stream callers).
async function _authFetch(path) {
  const key = apiKey || sessionStorage.getItem("agentid_key")
           || localStorage.getItem("agentid_persisted_key")
           || localStorage.getItem("agentid_key") || "";
  const headers = key ? { "x-api-key": key } : {};
  return fetch(`${BASE}${path}`, { credentials: "include", headers });
}

// Wrapper for raw fetch calls that need proper auth (both API key and cookie).
// Merges auth headers into whatever opts.headers is passed; always adds
// credentials: "include" so cookie-auth users work too.
function _fetchAuth(url, opts = {}) {
  const key = apiKey || sessionStorage.getItem("agentid_key")
           || localStorage.getItem("agentid_persisted_key")
           || localStorage.getItem("agentid_key") || "";
  const headers = { ...(opts.headers || {}) };
  if (key) headers["x-api-key"] = key;
  return fetch(url, { ...opts, credentials: "include", headers });
}

let _sessionDropFired = false;
let _loginGraceUntil  = 0;     // wall-clock ms after which we *will* fire a 401 banner

function _shouldTriggerSessionDrop() {
  if (_sessionDropFired) return false;
  if (Date.now() < _loginGraceUntil) return false;
  return true;
}

function _markFreshLogin(graceMs = 15000) {
  _sessionDropFired = false;
  _loginGraceUntil = Date.now() + graceMs;
}

function _triggerSessionDrop(detail) {
  if (_sessionDropFired) return;
  _sessionDropFired = true;
  console.warn("[apiFetch] session dropped — clearing stale auth state.", detail);
  // Clear ALL auth artefacts across EVERY storage layer so the stale key
  // cannot be resurrected by the rehydrate path in apiFetch() on the next call.
  sessionStorage.removeItem("agentid_key");
  sessionStorage.removeItem("agentid_login_ts");
  sessionStorage.removeItem("agentid_auth_mode");
  sessionStorage.removeItem("agentid_owner");
  localStorage.removeItem("agentid_key");
  localStorage.removeItem("agentid_persisted_key");
  localStorage.removeItem("agentid_tab_sync");
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
    // Clear ALL stored keys so apiFetch never rehydrates a stale API key
    // and sends it alongside the valid cookie (which would cause a 401).
    sessionStorage.removeItem("agentid_key");
    localStorage.removeItem("agentid_key");
    localStorage.removeItem("agentid_persisted_key");
    _markFreshLogin();   // 15s grace window — covers Railway cold-start latency

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
    _markFreshLogin();   // 15s grace window — covers Railway cold-start latency

    await loadDashboard();
    scheduleSessionExpiry();
  } catch (e) {
    const msg = String(e.message || "");
    const _authResult = _authMessageForStatus(msg);
    if (typeof _authResult === "object" && _authResult?.html) _showAuthError(_authResult.html, true);
    else _showAuthError(_authResult || msg);
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
    // Write to localStorage so sibling pages (contracts, tasks, messages, my-agents)
    // can pick up the key without re-entering it. Cleared on logout.
    localStorage.setItem("agentid_key", apiKey);
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
  // Clear cross-tab session key
  localStorage.removeItem("agentid_key");
  apiKey = "";
  authMode = "session";   // default for next visit
  clearTimeout(sessionTimer);
  clearInterval(_anomalyTimer);
  stopPolling();
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
  if (me.owner) sessionStorage.setItem('agentid_owner', me.owner);

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

  // ── Defensive normalisation ───────────────────────────────────────────────
  // The analytics endpoint may return a different shape (or null fields) if it
  // is cold-starting or the schema has evolved. Normalise once here so the
  // rendering code below can use plain property access without crashing.
  if (!data || typeof data !== "object") data = {};
  data.owner           = data.owner           || me.owner || "";
  data.tier            = data.tier            || CURRENT_TIER;
  data.usage           = (data.usage && typeof data.usage === "object") ? data.usage : {};
  data.activity_last_7d = Array.isArray(data.activity_last_7d) ? data.activity_last_7d : [];

  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "flex";
  document.getElementById("logout-btn").style.display = "flex";
  _initSidebar();
  _sidebarUpdateUser();
  const cmdkBtn = document.getElementById("cmdk-btn");
  if (cmdkBtn) cmdkBtn.style.display = "inline-flex";
  const notifBtn = document.getElementById("notif-btn");
  if (notifBtn) notifBtn.style.display = "inline-flex";
  loadNotifications();   // populate badge on first load

  const tier = String(data.tier);

  // Apply tier-locked overlays to gated tabs/cards
  applyTierLocks(tier);

  // Header
  const _dashTitle = document.getElementById("dash-title");
  if (_dashTitle) _dashTitle.textContent = data.owner;
  const _dashSub = document.getElementById("dash-sub");
  if (_dashSub) _dashSub.textContent =
    isPro() ? "Pro analytics dashboard" : "Free tier — agent registry";

  const tierEl = document.createElement("span");
  tierEl.className = "tier-badge " + tierClass(tier);
  tierEl.textContent = tier;
  const tierWrap = document.getElementById("tier-badge-wrap");
  if (tierWrap) { tierWrap.textContent = ""; tierWrap.appendChild(tierEl); }

  // Stats — data.usage is guaranteed to be an object (normalised above)
  const agentsReg   = Number(data.usage.agents_registered) || 0;
  const auditEvents = Number(data.usage.audit_events) || 0;
  const totalActivity = data.activity_last_7d.reduce((s, r) => s + r.count, 0);

  // Discovery = resolves + verifies from searches endpoint (load async)
  const _setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  _setText("stat-agents",    agentsReg);
  _setText("stat-events",    auditEvents.toLocaleString());
  _setText("stat-active",    totalActivity.toLocaleString());
  _setText("stat-discovery", "…");

  // ── Premium stat card sparklines / trend chips ──────────────────────────────
  // Build a 7-day activity sparkline using the activity_last_7d data
  const act7 = (data.activity_last_7d || []);
  if (act7.length > 0) {
    // Sum operations per day (activity is {date, operation, count})
    const dayTotals = {};
    act7.forEach(r => { dayTotals[r.date] = (dayTotals[r.date] || 0) + Number(r.count); });
    const days = Object.keys(dayTotals).sort();
    const vals = days.map(d => dayTotals[d]);
    const max  = Math.max(...vals, 1);

    // Inject mini sparkline SVG into the "Active This Week" stat card
    const activeCard = document.getElementById("stat-active")?.closest(".stat-card");
    if (activeCard) {
      const w = 60, h = 20;
      const pts = vals.map((v, i) => {
        const x = i / Math.max(vals.length - 1, 1) * w;
        const y = h - (v / max) * h;
        return `${x},${y}`;
      }).join(" ");
      const svg = `<svg width="${w}" height="${h}" style="display:block;margin-top:0.35rem;opacity:0.6;" viewBox="0 0 ${w} ${h}" fill="none">
        <polyline points="${pts}" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
      const sub = activeCard.querySelector(".stat-sub");
      if (sub) sub.insertAdjacentHTML("afterend", svg);
    }
  }

  // Trend indicator (this week vs prior estimate) — visual chip only
  const _trendChip = (el, value, compareVal) => {
    if (!el || value === 0) return;
    const pct = compareVal > 0 ? Math.round(((value - compareVal) / compareVal) * 100) : 0;
    if (Math.abs(pct) < 2) return;  // skip tiny noise
    const up = pct > 0;
    const chip = document.createElement("span");
    chip.style.cssText = `font-size:0.65rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:999px;margin-left:0.4rem;vertical-align:middle;
      ${up ? "background:#dcfce7;color:#166534;" : "background:#fee2e2;color:#991b1b;"}`;
    chip.textContent = `${up ? "↑" : "↓"}${Math.abs(pct)}%`;
    el.appendChild(chip);
  };
  // Note: stat-caps was replaced by stat-discovery in the HTML

  // Usage meter
  const limit = TIER_LIMITS[tier] ?? 100;
  const pct   = limit === Infinity ? 0 : Math.min(100, Math.round((agentsReg / limit) * 100));

  const _uTierLabel = document.getElementById("usage-tier-label");
  if (_uTierLabel) { _uTierLabel.className = "tier-badge " + tierClass(tier); _uTierLabel.textContent = tier; }
  const _uLabel = document.getElementById("usage-label");
  if (_uLabel) _uLabel.textContent = limit === Infinity
    ? `${agentsReg.toLocaleString()} agents (unlimited)`
    : `${agentsReg.toLocaleString()} / ${limit.toLocaleString()} agents`;
  const _uPct = document.getElementById("usage-pct");
  if (_uPct) _uPct.textContent = limit === Infinity ? "∞" : `${pct}%`;

  const fill = document.getElementById("usage-fill");
  if (fill) {
    fill.style.width = (limit === Infinity ? 2 : pct) + "%";
    fill.style.background = pct > 90 ? "var(--red)" : pct > 70 ? "var(--yellow)" : "var(--accent)";
  }

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
    // Wait for fonts before rendering so Inter metrics are ready and text isn't blurry
    const _doRenderCharts = () => {
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
    };
    (document.fonts?.ready || Promise.resolve()).then(_doRenderCharts);
    try { renderActivity(data.activity_last_7d || []); } catch (e) {
      console.error("renderActivity:", e);
      const actEl = document.getElementById("activity-list");
      if (actEl) actEl.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p style="font-size:0.78rem;color:var(--muted);">Could not render activity: ${esc(String(e?.message || e))}</p></div>`;
    }
    loadAuditLog().catch(e => console.error("loadAuditLog:", e));
    loadSigningActivity().catch(e => console.error("loadSigningActivity:", e));
    loadDiscoveryStats().catch(e => console.error("loadDiscoveryStats:", e));
    loadAnomalies().catch(e => console.error("loadAnomalies:", e));
    _loadGroups?.().catch(e => console.error("loadGroups:", e));
    _initNetworkObserver();

    // Start real-time SSE feed (or restart if already running)
    startSse();

    // Anomaly auto-refresh every 60 s
    clearInterval(_anomalyTimer);
    _anomalyTimer = setInterval(loadAnomalies, 60000);
  }

  // Benchmarks — always attempt; shows upgrade prompt for free tier
  loadPeerBenchmarks();

  // Onboarding checklist — shown until all steps done or dismissed
  _renderOnboarding(data);

  // First-run welcome: if this is a brand-new account with no API keys
  // yet, auto-mint a starter key and surface it with copy-paste snippets.
  // No-op for existing accounts.
  _maybeShowWelcome();

  // Approvals — runs for all tiers (ACP queue is tier-free; review-queue gracefully 403s)
  _loadApprovals().catch(e => console.warn("loadApprovals:", e));

  // Home inbox — load for all tiers (works with free too)
  loadHome().catch(e => console.warn("loadHome:", e));

  // New execution-layer sections (pro only)
  if (isPro()) {
    loadRuns().catch(e => console.warn("loadRuns:", e));
    loadHandoffs().catch(e => console.warn("loadHandoffs:", e));
    loadPolicyDecisions().catch(e => console.warn("loadPolicyDecisions:", e));
    loadBudget().catch(e => console.warn("loadBudget:", e));
    loadDelegation().catch(e => console.warn("loadDelegation:", e));
    loadCredentials().catch(e => console.warn("loadCredentials:", e));
  } else {
    // Free tier — replace static HTML spinners so the page doesn't spin forever
    const _freeMsg = '<div style="padding:1.1rem 1.25rem;color:var(--muted);font-size:0.83rem;">Available on Pro plan.</div>';
    ['runs-list','handoffs-list','policy-list','delegation-list','credentials-list'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = _freeMsg;
    });
    const bd = document.getElementById('budget-daily');
    if (bd) bd.innerHTML = '<span style="font-size:0.82rem;color:var(--muted);">Available on Pro plan.</span>';
    const bp = document.getElementById('budget-risk-policies');
    if (bp) bp.innerHTML = '<span style="font-size:0.8rem;color:var(--muted);">Available on Pro plan.</span>';
  }

  // Start 5s auto-poll after first successful load
  startPolling();
}

// ── HOME / PRIORITY INBOX ────────────────────────────────────────────────────

let _homePollerTimer = null;

async function loadHome() {
  const list  = document.getElementById("home-list");
  const empty = document.getElementById("home-empty");
  const strip = document.getElementById("home-kpi-strip");
  if (!list) return;

  let data;
  try {
    data = await apiFetch("/pro/account/home");
  } catch (e) {
    list.innerHTML = `<li style="padding:0.75rem;color:var(--muted);font-size:0.82rem;">Could not load — ${esc(String(e?.message || e))}</li>`;
    return;
  }

  // KPI strip
  if (strip && data.kpis) {
    const k = data.kpis;
    const trustVal = k.fleet_trust_avg != null ? Math.round(k.fleet_trust_avg) : "—";
    const trustClass = k.fleet_trust_band === "good" ? "good" : k.fleet_trust_band === "warn" ? "warn" : "bad";
    const _trendArrow = (delta, higherIsBad) => {
      if (delta == null) return "";
      const isUp = delta > 0;
      const cls = isUp === !higherIsBad ? "kpi-trend-up" : "kpi-trend-down";
      const sym = isUp ? "↑" : "↓";
      return `<span class="kpi-trend ${cls}">${sym}${Math.abs(delta)}</span>`;
    };
    strip.innerHTML = `
      <button class="kpi-tile" onclick="_scrollToSection('overview')" title="View fleet overview">
        <div class="kpi-tile-label">Fleet Trust</div>
        <div class="kpi-tile-value ${trustClass}">${trustVal}${_trendArrow(k.trust_delta, false)}</div>
        <div class="kpi-tile-sub">avg score across fleet</div>
      </button>
      <button class="kpi-tile" onclick="_scrollToSection('agents')" title="View agents">
        <div class="kpi-tile-label">Agents Online</div>
        <div class="kpi-tile-value accent">${k.agents_online ?? "—"}${_trendArrow(k.agents_delta, false)}<span style="font-size:1rem;font-weight:500;opacity:0.5;"> / ${k.agents_total ?? "—"}</span></div>
        <div class="kpi-tile-sub">active this week</div>
      </button>
      <button class="kpi-tile" onclick="_scrollToSection('approvals')" title="View approvals">
        <div class="kpi-tile-label">Pending Approvals</div>
        <div class="kpi-tile-value ${k.approvals_pending > 0 ? 'bad' : 'good'}">${k.approvals_pending ?? 0}${_trendArrow(k.pending_delta, true)}</div>
        <div class="kpi-tile-sub">awaiting review</div>
      </button>
      <button class="kpi-tile" onclick="_scrollToSection('analytics')" title="View anomalies">
        <div class="kpi-tile-label">Anomalies</div>
        <div class="kpi-tile-value ${k.anomalies_24h > 0 ? 'warn' : 'good'}">${k.anomalies_24h ?? 0}${_trendArrow(k.anomalies_delta, true)}</div>
        <div class="kpi-tile-sub">last 24 h</div>
      </button>`;
  }

  // Inbox list
  const items = data.items || [];
  const agentsTotal = data.kpis?.agents_total ?? 1;

  // Zero-agents: show first-run hero, hide home list
  if (agentsTotal === 0) {
    const hero = document.getElementById("first-run-hero");
    if (hero) hero.style.display = "";
    list.innerHTML = "";
    if (empty) empty.style.display = "none";
    _updateHomeCount(0);
    return;
  }

  if (items.length === 0) {
    list.innerHTML = "";
    if (empty) empty.style.display = "";
    _updateHomeCount(0);
  } else {
    if (empty) empty.style.display = "none";
    list.innerHTML = items.map(item => _renderHomeItem(item)).join("");
    _updateHomeCount(items.length);
  }

  // Tab title badge
  _updateTabTitle(items.length);

  // SSE live dot
  const dot = document.getElementById("home-live-dot");
  if (dot) dot.classList.toggle("active", !!window._sseSource);

  // Polling fallback when SSE is not connected
  clearInterval(_homePollerTimer);
  if (!window._sseSource) {
    const interval = (data.next_poll_after_seconds || 30) * 1000;
    _homePollerTimer = setInterval(() => loadHome().catch(() => {}), interval);
  }
}

function _renderHomeItem(item) {
  const age = _fmtAge(item.age_seconds || 0);
  const iconClass = item.severity === "high" ? "high" : item.severity === "medium" ? "medium" : item.severity === "low" ? "low" : "info";
  const agentLabel = esc(item.agent_name || item.agent_did?.split(":").pop() || "agent");
  const title  = esc(item.title || "");
  const sub    = esc(item.subtitle || "");
  const label  = esc(item.action_label || "Open");
  const link   = esc(item.deep_link || "#");
  return `<li class="home-item">
    <span class="home-item-icon ${iconClass}"></span>
    <div class="home-item-body">
      <div class="home-item-title">${title}</div>
      <div class="home-item-meta">${agentLabel}${sub ? " · " + sub : ""}</div>
    </div>
    <span class="home-item-age">${age}</span>
    <a class="home-item-action" href="${link}">${label}</a>
  </li>`;
}

function _fmtAge(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function _updateHomeCount(n) {
  const el = document.getElementById("home-count");
  if (!el) return;
  if (n > 0) { el.style.display = ""; el.textContent = String(n); }
  else { el.style.display = "none"; }
}

function _updateTabTitle(n) {
  document.title = n > 0 ? `(${n}) AgentID — Home` : "AgentID — Home";
}

// Hash back-compat: #section-overview → #section-analytics for old bookmarks
if (location.hash === "#section-overview") {
  history.replaceState(null, "", "#section-home");
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
      devicePixelRatio: window.devicePixelRatio || 1,
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
      devicePixelRatio: window.devicePixelRatio || 1,
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

  // Fallback: server only sent totals — render a tidy list with clickable rows.
  const opSums = {};
  for (const r of activity) {
    const op = (r.operation || "other").toLowerCase();
    opSums[op] = (opSums[op] || 0) + Number(r.count || 0);
  }
  const max = Math.max(...Object.values(opSums), 1);
  const rows = Object.entries(opSums).sort((a, b) => b[1] - a[1]).map(([op, n]) => {
    const pct = (n / max) * 100;
    const pal = _opPalette(op);
    return `
      <div class="activity-op-row" data-op="${esc(op)}" data-count="${n}"
           style="display:flex;align-items:center;gap:0.6rem;cursor:pointer;padding:0.15rem 0.25rem;
                  border-radius:6px;transition:background 0.1s;" title="View ${esc(op)} events">
        <button class="op-pill ${pal.cls}" style="min-width:64px;justify-content:center;cursor:pointer;border:none;background:inherit;">${esc(op)}</button>
        <div style="flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${pal.bg};"></div>
        </div>
        <span style="font-variant-numeric:tabular-nums;font-weight:600;font-size:0.82rem;min-width:60px;text-align:right;">${esc(n.toLocaleString())}</span>
        <span style="font-size:0.6rem;color:var(--muted);">›</span>
      </div>`;
  }).join("");
  actEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:0.25rem;">${rows}</div>`;
  actEl.querySelectorAll(".activity-op-row").forEach(row => {
    row.addEventListener("click", () => _openActivityDrawer(row.dataset.op, Number(row.dataset.count)));
  });
}

// ── BADGE ─────────────────────────────────────────────────────────────────────

async function loadBadge(owner) {
  try {
    const res = await _fetchAuth(`${BASE}/pro/verified/${encodeURIComponent(owner)}`);
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

      const dotClass = op === "verify" || op === "register" ? "feed-dot-good"
                     : op === "deregister" || op === "revoke" ? "feed-dot-bad"
                     : op === "update" || op === "resolve" ? "feed-dot-mid"
                     : "feed-dot-muted";
      const chipClass = op === "verify" || op === "register" ? "feed-chip-good"
                      : op === "deregister" || op === "revoke" ? "feed-chip-bad"
                      : "feed-chip-muted";
      const statusClass = (r.status === "ok" || r.status === "success") ? "feed-chip-good"
                        : (r.status === "fail" || r.status === "error") ? "feed-chip-bad"
                        : "feed-chip-muted";
      const didParts = did.includes("did:agentid:")
        ? `<span class="did-prefix">did:agentid:</span><span class="did-hash">${esc(did.replace("did:agentid:","").slice(0,14))}…</span>`
        : esc(shortened || "—");
      return `<div class="feed-row">
        <span class="feed-dot ${dotClass}"></span>
        <span class="feed-time">${esc(timeLabel)}</span>
        <div class="feed-body">
          <span class="feed-chip ${chipClass}">${esc(op)}</span>
          <span class="feed-did">${didParts}</span>
        </div>
        <span class="feed-chip ${statusClass}">${esc(r.status || "—")}</span>
      </div>`;
    }).join("");

    el.innerHTML = `<div class="feed-list" style="max-height:340px;overflow:auto;">${rows}</div>`;
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

function _renderAgentCard(a) {
  const capsArr = Array.isArray(a.capabilities) ? a.capabilities : [];
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
  const oversightLevel = a.human_oversight || "none";
  const oversightColors = {
    none:     { border: "var(--border-dark)", bg: "var(--surface2)",    text: "var(--muted)",   label: "🤖 auto"     },
    advisory: { border: "var(--blue)",        bg: "var(--blue-bg)",     text: "var(--blue)",    label: "👁 advisory"  },
    required: { border: "var(--yellow)",      bg: "var(--yellow-bg)",   text: "var(--yellow)",  label: "⏸ required"  },
    always:   { border: "var(--red)",         bg: "var(--red-bg)",      text: "var(--red)",     label: "🔐 always"   },
  };
  const oc = oversightColors[oversightLevel] || oversightColors.none;
  const oversightBtn = `<button
    class="oversight-toggle"
    data-did="${esc(a.did || "")}"
    data-level="${esc(oversightLevel)}"
    title="Human oversight: ${oversightLevel} — click to change"
    style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:5px;cursor:pointer;border:1px solid ${oc.border};background:${oc.bg};color:${oc.text};">
    ${oc.label}
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

  // Agent avatar with initials
  const initials = (a.name || "??").slice(0, 2).toUpperCase();
  const avatarHtml = `<span class="ag-avatar">${initials}</span>`;

  // Styled DID cell: split prefix and hash
  const rawDid = a.did || "";
  let didCellContent;
  if (rawDid.startsWith("did:agentid:")) {
    const afterPrefix = rawDid.slice("did:agentid:".length);
    const shortHash = afterPrefix.length > 20
      ? afterPrefix.slice(0, 14) + "…" + afterPrefix.slice(-6)
      : afterPrefix;
    didCellContent = `<span class="did-prefix">did:agentid:</span><span class="did-hash">${shortHash}</span>`;
  } else {
    didCellContent = esc(shortDid(rawDid));
  }

  // Trust ring — use real trust score if pre-loaded, fall back to health-based
  let ringClass, ringLabel;
  const ts = window._agentTrustScores?.[rawDid];
  if (ts && ts.score != null && ts.band != null) {
    ringClass = "tr-" + (ts.band === "good" ? "good" : ts.band === "warn" ? "mid" : "low");
    ringLabel = String(ts.score);
  } else if (a.last_activity) {
    const ageMs = Date.now() - new Date(a.last_activity).getTime();
    ringClass = ageMs < 86400000      ? "tr-good"
              : ageMs < 86400000 * 7  ? "tr-mid"
              : "tr-low";
    ringLabel = "●";
  } else {
    ringClass = "tr-muted";
    ringLabel = "○";
  }
  const trustRing = `<span class="trust-ring ${ringClass}"><span class="tr-n">${ringLabel}</span></span>`;

  const capChips = capsArr.length
    ? capsArr.slice(0, 4).map(c => `<span class="cap-chip">${esc(String(c))}</span>`).join("") +
      (capsArr.length > 4 ? `<span class="cap-chip" style="color:var(--muted);">+${capsArr.length - 4}</span>` : "")
    : `<span style="font-size:0.72rem;color:var(--muted);">no capabilities</span>`;

  return `<div class="agent-card"
    data-name="${esc((a.name || "").toLowerCase())}"
    data-did="${esc((a.did || "").toLowerCase())}"
    data-caps="${esc(capsArr.join(" ").toLowerCase())}"
    data-raw-did="${esc(rawDid)}">
    <label class="ag-card-sel" title="Select">
      <input type="checkbox" class="agent-row-check" data-did="${esc(a.did||"")}" style="cursor:pointer;" />
    </label>
    <div class="ag-card-head">
      <div class="ag-avatar-lg">${esc(initials)}</div>
      <div class="ag-card-id">
        <div class="ag-card-name">${esc(a.name)}${rotBadge}</div>
        <div class="ag-card-did">${didCellContent}</div>
      </div>
      ${trustRing}
    </div>
    <div class="ag-card-caps">${capChips}</div>
    <div class="ag-card-meta">
      <span>${healthDot} <span class="${lastActiveClass}">${esc(lastActiveStr)}</span></span>
      <span style="color:var(--muted);">📋 ${esc(String(a.audit_events ?? 0))}</span>
    </div>
    <div class="ag-card-footer">
      <button class="agent-action-btn" data-action="details" data-did="${esc(rawDid)}" data-name="${esc(a.name)}" style="flex:1;">Details</button>
      <button class="agent-action-btn" data-action="verify"  data-did="${esc(rawDid)}" data-name="${esc(a.name)}" title="Test verify">Test</button>
      <button class="agent-action-btn" data-action="snippets" data-did="${esc(rawDid)}" data-name="${esc(a.name)}" title="Code snippets">&lt;/&gt;</button>
      ${privacyBtn}
    </div>
  </div>`;
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

  el.innerHTML = `<div class="agent-grid">${slice.map(_renderAgentCard).join("")}</div>`;

  el.querySelectorAll(".agent-row-check").forEach(cb => {
    cb.checked = !!_agSelection[cb.dataset.did];
    cb.addEventListener("change", function() {
      const card = this.closest(".agent-card");
      if (this.checked) {
        _agSelection[this.dataset.did] = _allAgents.find(a => a.did === this.dataset.did);
        card?.classList.add("ag-selected");
      } else {
        delete _agSelection[this.dataset.did];
        card?.classList.remove("ag-selected");
      }
      _updateBulkBar();
    });
    if (cb.checked) cb.closest(".agent-card")?.classList.add("ag-selected");
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
    const res = await _fetchAuth(
      `${BASE}/agents/${encodeURIComponent(did)}/visibility?private=${newPrivate}`,
      { method: "PATCH" }
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

    // Load trust scores concurrently
    let _agentTrustScores = {};
    try {
      const ts = await apiFetch("/pro/trust-scores");
      if (ts && ts.agents) {
        ts.agents.forEach(a => { _agentTrustScores[a.did] = a; });
      }
    } catch (_) { /* trust scores optional */ }
    window._agentTrustScores = _agentTrustScores;

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
            ? (e.verifier_name
                ? '<strong>' + esc(e.verifier_name) + '</strong> · <code style="font-size:0.74rem;">' + esc(e.verifier_did) + '</code>'
                : '<span style="color:var(--muted);font-style:italic;">external</span> · <code style="font-size:0.74rem;">' + esc(e.verifier_did) + '</code>')
            : '<span style="color:var(--muted);font-style:italic;">unknown</span>',
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

// Network graph range selector + refresh
document.getElementById("network-range")?.addEventListener("change", () => {
  clearTimeout(_networkRefreshTimer);
  const label = document.getElementById("network-range-label");
  const val   = document.getElementById("network-range")?.value;
  if (label) label.textContent = val === "1" ? "Last 24 h" : val === "30" ? "Last 30 days" : "Last 7 days";
  loadNetworkGraph().catch(() => {});
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#network-refresh")) {
    clearTimeout(_networkRefreshTimer);
    loadNetworkGraph().catch(() => {});
  }
  if (e.target.closest("#net-zoom-in"))  { _net.zoom = Math.min(8, _net.zoom * 1.3);  _netDraw(); }
  if (e.target.closest("#net-zoom-out")) { _net.zoom = Math.max(0.06, _net.zoom / 1.3); _netDraw(); }
  if (e.target.closest("#net-zoom-fit")) { _netFitView(); _netDraw(); }
});

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
  stopSse();

  // Always try to get a short-lived SSE token via apiFetch — works for BOTH
  // api-key users AND session/cookie-auth (email+password) users because
  // apiFetch sends credentials: "include" plus x-api-key when available.
  // EventSource doesn't support custom headers so we must use a URL token.
  let url = null;

  // Fallback: raw api_key in URL (only when key exists — never expose empty string)
  if (apiKey) {
    url = `${BASE}/pro/stream?api_key=${encodeURIComponent(apiKey)}`;
  }

  try {
    const tok = await apiFetch("/pro/sse-token", { method: "POST" });
    if (tok?.sse_token) {
      url = `${BASE}/pro/stream?sse_token=${encodeURIComponent(tok.sse_token)}`;
    }
  } catch { /* use api_key fallback, or skip SSE if neither is available */ }

  if (!url) return; // No auth available — skip SSE silently

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
    const res = await _fetchAuth(`${BASE}/pro/keys/allowlist`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body:   JSON.stringify({ allowed_ips: val || null }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || res.status); }
    const data = await res.json();
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
    const data = await apiFetch(`/pro/keys/team?${params}`, { method: "POST" });

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
        _fetchAuth(`${BASE}/agents/${encodeURIComponent(a.did)}/rotation`)
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
    const res = await _fetchAuth(`${BASE}/agents/${encodeURIComponent(did)}/rotation`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || res.status); }
    const data = await res.json();
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

// ── Key rotation: browser keygen + dashboard initiate + cleanup ───────────────

/** Generated private key bytes (Uint8Array) — held in memory until downloaded */
let _rotationPrivKeyBytes = null;

/**
 * Generate an Ed25519 key pair in the browser using SubtleCrypto.
 * Fills the public-key input and reveals the private-key download box.
 */
async function _generateRotationKeyPair() {
  const btn  = document.getElementById("rotation-generate-btn");
  const inp  = document.getElementById("rotation-newkey-input");
  const box  = document.getElementById("rotation-privkey-box");
  const hint = document.getElementById("rotation-key-hint");
  if (!btn || !inp) return;

  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    // Ed25519 is supported in Chrome 113+, Firefox 130+, Safari 17+
    const kp = await crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"]
    );

    // Export public key as raw bytes → base64
    const pubRaw  = await crypto.subtle.exportKey("raw", kp.publicKey);
    const pubArr  = new Uint8Array(pubRaw);
    const pubB64  = btoa(String.fromCharCode(...pubArr));

    // Export private key as PKCS8 — store for download
    const privPkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    _rotationPrivKeyBytes = new Uint8Array(privPkcs8);

    inp.value = pubB64;
    inp.style.color = "var(--green)";
    if (hint) hint.textContent = "✓ Key pair generated. Download the private key, then click Initiate Rotation.";
    if (box) box.style.display = "block";
    document.getElementById("rotation-download-confirm").style.display = "none";
  } catch (err) {
    // Fallback message if browser doesn't support Ed25519 SubtleCrypto
    _modalMsg("rotation-msg",
      `Browser key generation failed: ${err.message}. ` +
      "Use the Python SDK instead: agent.generate_rotation_key()", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Generate";
  }
}

/** Trigger download of the generated private key as a PKCS8 .pem file */
function _downloadRotationPrivKey() {
  if (!_rotationPrivKeyBytes) return;
  const b64 = btoa(String.fromCharCode(..._rotationPrivKeyBytes));
  const pem  = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const blob = new Blob([pem], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "agentid_rotation_key.pem" });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const conf = document.getElementById("rotation-download-confirm");
  if (conf) { conf.style.display = "inline"; }
}

/** Copy raw private key bytes (hex) to clipboard */
async function _copyRotationPrivKey() {
  if (!_rotationPrivKeyBytes) return;
  const hex = Array.from(_rotationPrivKeyBytes).map(b => b.toString(16).padStart(2,"0")).join("");
  await navigator.clipboard.writeText(hex).catch(() => {});
  const btn = document.getElementById("rotation-copy-priv-btn");
  if (btn) { const t = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(() => btn.textContent = t, 1800); }
}

/** Dashboard-authenticated rotation initiation — no SDK signature needed */
async function _initiateRotation() {
  const did      = (document.getElementById("rotation-did-input")?.value || "").trim();
  const newKey   = (document.getElementById("rotation-newkey-input")?.value || "").trim();
  const grace    = parseInt(document.getElementById("rotation-grace-input")?.value || "48", 10);
  _modalMsgClear("rotation-msg");

  if (!did)    return _modalMsg("rotation-msg", "Select or enter an agent DID.", "error");
  if (!newKey) return _modalMsg("rotation-msg", "Generate a new key pair first.", "error");
  if (!_rotationPrivKeyBytes)
    return _modalMsg("rotation-msg", "Download your new private key before initiating — you cannot retrieve it later.", "error");

  const btn = document.getElementById("rotation-initiate-btn");
  btn.disabled = true; btn.textContent = "Initiating…";
  try {
    const data = await apiFetch(`/pro/agents/${encodeURIComponent(did)}/rotation/dashboard`, {
      method: "POST",
      body: JSON.stringify({ new_public_key: newKey, grace_hours: grace }),
    });
    _modalMsg("rotation-msg",
      `✓ Rotation staged. Both keys accepted until ${String(data.rotation_expires_at).slice(0,19).replace("T"," ")} UTC. ` +
      "Use your NEW private key to sign future messages. Run agent.confirm_rotation(did) to finalize.", "ok");
    // Clear the in-memory private key — user has been warned
    _rotationPrivKeyBytes = null;
    document.getElementById("rotation-privkey-box").style.display = "none";
    document.getElementById("rotation-newkey-input").value = "";
    document.getElementById("rotation-newkey-input").style.color = "";
    _loadRotationAgentList();
  } catch (e) {
    _modalMsg("rotation-msg", `Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Initiate Rotation";
  }
}

/** Delete registered agents with zero activity older than 10 minutes */
async function _cleanupUnusedAgents() {
  const btn = document.getElementById("rotation-cleanup-btn");
  const res = document.getElementById("rotation-cleanup-result");
  if (!btn || !res) return;
  if (!confirm("This will permanently delete all your registered agents that have never been used (no activity, created more than 10 minutes ago). Continue?")) return;

  btn.disabled = true; btn.textContent = "Cleaning…";
  res.style.display = "none";
  try {
    const data = await apiFetch("/pro/agents/cleanup", { method: "DELETE" });
    res.style.display = "block";
    if (data.deleted === 0) {
      res.innerHTML = `<span style="color:var(--muted);">No unused agents found — nothing deleted.</span>`;
    } else {
      res.innerHTML = `<span style="color:var(--green);font-weight:600;">✓ Deleted ${data.deleted} unused agent${data.deleted !== 1 ? "s" : ""}</span>` +
        (data.dids?.length ? `<div style="margin-top:0.3rem;font-size:0.72rem;color:var(--muted);word-break:break-all;">${data.dids.map(esc).join("<br>")}</div>` : "");
      _loadRotationAgentList();
    }
  } catch (e) {
    res.style.display = "block";
    res.innerHTML = `<span style="color:var(--red);">Error: ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false; btn.textContent = "🗑 Clean up unused";
  }
}

// ── Security tab ──────────────────────────────────────────────────────────────

async function _loadSecuritySessions() {
  const el = document.getElementById("security-sessions-list");
  if (!el) return;
  try {
    const data = await apiFetch("/auth/sessions");
    const sessions = data.sessions || [];
    if (!sessions.length) { el.innerHTML = `<p style="font-size:0.82rem;color:var(--muted);">No active sessions found.</p>`; return; }
    el.innerHTML = sessions.map(s => `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        padding:0.6rem 0;border-bottom:1px solid var(--border);gap:0.75rem;">
        <div style="font-size:0.8rem;">
          <div style="font-weight:600;color:var(--text);">${esc(s.user_agent ? s.user_agent.slice(0,60) : "Unknown browser")}</div>
          <div style="color:var(--muted);font-size:0.72rem;margin-top:0.1rem;">
            ${esc(s.ip || "?")} · ${s.created_at ? String(s.created_at).slice(0,16).replace("T"," ") : ""}
          </div>
        </div>
        <span style="font-size:0.7rem;padding:0.15rem 0.45rem;border-radius:4px;white-space:nowrap;
          background:${s.is_current ? "color-mix(in srgb,var(--green) 15%,transparent)" : "var(--surface2)"};
          color:${s.is_current ? "var(--green)" : "var(--muted)"};">
          ${s.is_current ? "This session" : "Active"}
        </span>
      </div>`).join("");
  } catch {
    el.innerHTML = `<p style="font-size:0.82rem;color:var(--muted);">Could not load sessions.</p>`;
  }
}

async function _secChangePassword() {
  const cur  = document.getElementById("sec-current-pw")?.value || "";
  const np   = document.getElementById("sec-new-pw")?.value || "";
  const cnf  = document.getElementById("sec-confirm-pw")?.value || "";
  _modalMsgClear("sec-pw-msg");
  if (!cur || !np) return _modalMsg("sec-pw-msg", "Fill in both password fields.", "error");
  if (np !== cnf)  return _modalMsg("sec-pw-msg", "New passwords don't match.", "error");
  if (np.length < 8) return _modalMsg("sec-pw-msg", "Password must be at least 8 characters.", "error");
  const btn = document.getElementById("sec-change-pw-btn");
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    await apiFetch("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: cur, new_password: np }),
    });
    _modalMsg("sec-pw-msg", "✓ Password updated.", "ok");
    ["sec-current-pw","sec-new-pw","sec-confirm-pw"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  } catch (e) {
    _modalMsg("sec-pw-msg", `Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Update password";
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
      res = await _fetchAuth(`${BASE}/pro/webhooks/${id}/test`, { method: "POST" });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || res.status); }
      const data = await res.json();
      btn.textContent = data.delivered ? "✓ sent" : "✗ failed";
    } else if (action === "toggle") {
      res = await _fetchAuth(`${BASE}/pro/webhooks/${id}/toggle`, { method: "PATCH" });
      if (!res.ok) throw new Error((await res.json()).detail || res.status);
      await _loadWebhooks();
      return;
    } else if (action === "delete") {
      if (!confirm("Delete this webhook? This cannot be undone.")) { btn.disabled = false; btn.textContent = orig; return; }
      res = await _fetchAuth(`${BASE}/pro/webhooks/${id}`, { method: "DELETE" });
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
    const res = await _fetchAuth(`${BASE}/pro/webhooks`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ url, secret, events }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || res.status); }
    const data = await res.json();

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

// ── INLINE SPLIT-PANE INSPECTOR ───────────────────────────────────────────────

let _inspectorDid = null;

async function _openInspector(did, name) {
  const pane   = document.getElementById("ag-split-pane");
  const body   = document.getElementById("ag-insp-body");
  const title  = document.getElementById("ag-insp-name");
  const fullBtn= document.getElementById("ag-insp-full");
  if (!pane || !body) { _openAgentDetail(did, name); return; }

  // Highlight active card
  document.querySelectorAll(".agent-card.ag-active").forEach(c => c.classList.remove("ag-active"));
  document.querySelector(`.agent-card[data-raw-did="${CSS.escape(did)}"]`)?.classList.add("ag-active");

  _inspectorDid = did;
  if (title) title.textContent = name || did;
  pane.classList.add("inspector-open");
  body.innerHTML = '<div class="loading" style="padding:1.5rem;"><div class="spinner" style="margin:0 auto;"></div></div>';

  if (fullBtn) {
    fullBtn.onclick = () => _openAgentDetail(did, name);
  }

  try {
    const data = await apiFetch("/pro/agents/" + encodeURIComponent(did) + "/control");
    const a = data.agent || {};
    const ts = window._agentTrustScores?.[did];
    const trustScore = ts?.score != null ? ts.score : "—";
    const trustBand  = ts?.band || "muted";
    const ringClass  = trustBand === "good" ? "tr-good" : trustBand === "warn" ? "tr-mid" : trustBand === "bad" ? "tr-low" : "tr-muted";
    const capsArr = Array.isArray(a.capabilities) ? a.capabilities : [];
    const initials = (a.name || "??").slice(0, 2).toUpperCase();
    const rawDid = a.did || did;
    const didDisplay = rawDid.startsWith("did:agentid:")
      ? `<span class="did-prefix">did:agentid:</span><span class="did-hash">${esc(rawDid.slice(12, 26))}…</span>`
      : `<span class="did-hash">${esc(shortDid(rawDid))}</span>`;
    const lastActive = a.last_activity ? timeAgo(a.last_activity) : "Never";
    const created = a.created_at ? new Date(a.created_at).toLocaleDateString("en-US", {month:"short",day:"numeric",year:"numeric"}) : "—";
    const isPrivate = !!a.private;
    const oversight = a.human_oversight || "none";

    body.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:0.65rem;margin-bottom:0.9rem;">
        <div class="ag-avatar-lg" style="width:44px;height:44px;font-size:0.85rem;">${esc(initials)}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.9rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.name || did)}</div>
          <div style="margin-top:0.15rem;">${didDisplay}</div>
        </div>
        <span class="trust-ring ${ringClass}" style="width:42px;height:42px;font-size:0.8rem;"><span class="tr-n">${esc(String(trustScore))}</span></span>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.85rem;">
        ${capsArr.length ? capsArr.map(c => `<span class="cap-chip">${esc(String(c))}</span>`).join("") : '<span style="font-size:0.75rem;color:var(--muted);">no capabilities</span>'}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.85rem;">
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:0.5rem 0.7rem;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);font-weight:700;">Last Active</div>
          <div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-top:0.15rem;">${esc(lastActive)}</div>
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:0.5rem 0.7rem;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);font-weight:700;">Registered</div>
          <div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-top:0.15rem;">${esc(created)}</div>
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:0.5rem 0.7rem;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);font-weight:700;">Visibility</div>
          <div style="font-size:0.82rem;font-weight:600;margin-top:0.15rem;color:${isPrivate ? "var(--yellow)" : "var(--green)"};">${isPrivate ? "🔒 Private" : "🌐 Public"}</div>
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:0.5rem 0.7rem;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);font-weight:700;">Oversight</div>
          <div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-top:0.15rem;">${esc(oversight)}</div>
        </div>
      </div>

      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${esc(rawDid)}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy DID',1500)})">Copy DID</button>
        <button class="btn btn-ghost btn-sm" data-action="verify" data-did="${esc(rawDid)}" data-name="${esc(a.name||"")}">Test Verify</button>
        <button class="btn btn-ghost btn-sm" data-action="snippets" data-did="${esc(rawDid)}" data-name="${esc(a.name||"")}">Code &lt;/&gt;</button>
      </div>
      ${data.recent_activity?.length ? `
      <div style="margin-top:0.9rem;">
        <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);font-weight:700;margin-bottom:0.4rem;">Recent Activity</div>
        <div class="feed-list">
          ${data.recent_activity.slice(0,5).map(r => {
            const op = r.operation || r.event_type || "event";
            const dotCls = (op==="verify"||op==="register") ? "feed-dot-good" : (op==="deregister"||op==="revoke") ? "feed-dot-bad" : "feed-dot-mid";
            const chipCls = (op==="verify"||op==="register") ? "feed-chip-good" : (op==="deregister"||op==="revoke") ? "feed-chip-bad" : "feed-chip-muted";
            return `<div class="feed-row">
              <span class="feed-dot ${dotCls}"></span>
              <span class="feed-time">${esc(r.created_at ? timeAgo(r.created_at) : "—")}</span>
              <div class="feed-body"><span class="feed-chip ${chipCls}">${esc(op)}</span></div>
            </div>`;
          }).join("")}
        </div>
      </div>` : ""}`;
  } catch(e) {
    body.innerHTML = `<div style="padding:1rem;color:var(--red);font-size:0.82rem;">Could not load: ${esc(String(e.message||e))}</div>`;
  }
}

function _closeInspector() {
  const pane = document.getElementById("ag-split-pane");
  pane?.classList.remove("inspector-open");
  document.querySelectorAll(".agent-card.ag-active").forEach(c => c.classList.remove("ag-active"));
  _inspectorDid = null;
}

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
  if (e.target.matches("#ad-close"))         { _closeDrawer();     return; }
  if (e.target.matches("#ts-drawer-close"))  { _closeTsDrawer();   return; }
  if (e.target.matches("#info-drawer-close")){ _closeInfoDrawer(); return; }
  if (e.target.matches(".agent-drawer-backdrop")) {
    const id = e.target.closest("[id]")?.id;
    if (id === "ts-drawer")   _closeTsDrawer();
    else if (id === "info-drawer") _closeInfoDrawer();
    else _closeDrawer();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { _closeDrawer(); _closeTsDrawer(); _closeInfoDrawer(); }
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
  if (!isPro()) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:0.5rem 0;">Upgrade to Pro to see how your agents compare to the network.</div>';
    if (src) src.textContent = "";
    return;
  }
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

// ── AGENT INTERACTION NETWORK GRAPH ──────────────────────────────────────────

const _OP_COLORS = {
  verify:                  "#3b82f6",
  verify_counterparty:     "#3b82f6",
  verify_orchestrator:     "#3b82f6",
  verify_researcher:       "#3b82f6",
  verify_coder:            "#3b82f6",
  verify_reviewer:         "#3b82f6",
  verify_monitor:          "#3b82f6",
  delegate_research:       "#f59e0b",
  task_received:           "#10b981",
  research_complete:       "#10b981",
  research_received:       "#10b981",
  code_complete:           "#8b5cf6",
  code_received:           "#8b5cf6",
  review_complete:         "#ef4444",
  review_result_received:  "#ef4444",
  integrity_report_issued: "#64748b",
};
// ── Infinite-canvas interactive graph state ───────────────────────────────
const _net = {
  canvas: null, ctx: null,
  nodes:  [],   // { did, name, icon, color, x, y, vx, vy, r }
  edges:  [],   // { src, dst, count, lw, color, label }
  tx: 0, ty: 0, zoom: 1,
  drag:   null, // { node, moved }
  pan:    null, // { x0, y0, tx0, ty0 }
  hover:  null,
  animId: null,
  step:   0,
  MAX_STEPS: 200,
};

function _netS2W(sx, sy) {
  return [(sx - _net.tx) / _net.zoom, (sy - _net.ty) / _net.zoom];
}

function _netHit(sx, sy) {
  const [wx, wy] = _netS2W(sx, sy);
  return _net.nodes.find(n => (n.x - wx) ** 2 + (n.y - wy) ** 2 < n.r ** 2) || null;
}

function _netFitView() {
  const c = _net.canvas;
  if (!c || !_net.nodes.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.width / dpr, H = c.height / dpr;
  const pad = 90;
  const xs = _net.nodes.map(n => n.x), ys = _net.nodes.map(n => n.y);
  const bx1 = Math.min(...xs) - pad, bx2 = Math.max(...xs) + pad;
  const by1 = Math.min(...ys) - pad, by2 = Math.max(...ys) + pad;
  const bw = bx2 - bx1 || 1, bh = by2 - by1 || 1;
  const scale = Math.min(W / bw, H / bh, 2.5);
  _net.zoom = scale;
  _net.tx   = W / 2 - (bx1 + bw / 2) * scale;
  _net.ty   = H / 2 - (by1 + bh / 2) * scale;
}

function _netDraw() {
  const c = _net.canvas;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.width / dpr, H = c.height / dpr;
  const ctx = _net.ctx;
  ctx.clearRect(0, 0, W, H);

  // Dot-grid — infinite board feel
  const gs  = Math.max(8, 32 * _net.zoom);
  const gox = ((_net.tx % gs) + gs) % gs;
  const goy = ((_net.ty % gs) + gs) % gs;
  ctx.fillStyle = "rgba(100,116,139,0.13)";
  for (let gx = gox; gx < W; gx += gs)
    for (let gy = goy; gy < H; gy += gs) {
      ctx.beginPath(); ctx.arc(gx, gy, 1, 0, Math.PI * 2); ctx.fill();
    }

  ctx.save();
  ctx.translate(_net.tx, _net.ty);
  ctx.scale(_net.zoom, _net.zoom);

  const nmap = Object.fromEntries(_net.nodes.map(n => [n.did, n]));

  // Stacked-edge offset bookkeeping
  const pairCnt = {}, pairIdx = {};
  _net.edges.forEach(e => {
    const k = [e.src, e.dst].sort().join("|");
    pairCnt[k] = (pairCnt[k] || 0) + 1;
  });

  // Draw edges
  for (const edge of _net.edges) {
    const a = nmap[edge.src], b = nmap[edge.dst];
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;

    const pk = [edge.src, edge.dst].sort().join("|");
    pairIdx[pk] = pairIdx[pk] ?? 0;
    const off = (pairIdx[pk] - (pairCnt[pk] - 1) / 2) * 16;
    pairIdx[pk]++;
    const ox = nx * off, oy = ny * off;

    const sx = a.x + ux * a.r + ox, sy = a.y + uy * a.r + oy;
    const ex = b.x - ux * b.r + ox, ey = b.y - uy * b.r + oy;
    const isHov = a === _net.hover || b === _net.hover;

    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
    ctx.strokeStyle = edge.color;
    ctx.lineWidth   = edge.lw;
    ctx.globalAlpha = isHov ? 0.95 : 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Arrowhead
    const ang = Math.atan2(ey - sy, ex - sx);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 11 * Math.cos(ang - 0.38), ey - 11 * Math.sin(ang - 0.38));
    ctx.lineTo(ex - 11 * Math.cos(ang + 0.38), ey - 11 * Math.sin(ang + 0.38));
    ctx.closePath();
    ctx.fillStyle   = edge.color;
    ctx.globalAlpha = isHov ? 1 : 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Label only on hover
    if (isHov && edge.label) {
      const mx = (sx + ex) / 2 + ox * 0.3, my = (sy + ey) / 2 + oy * 0.3 - 5;
      ctx.font = "9px ui-monospace,monospace";
      ctx.fillStyle   = edge.color;
      ctx.globalAlpha = 0.9;
      ctx.textAlign   = "center";
      ctx.fillText(edge.label, mx, my);
      ctx.globalAlpha = 1;
    }
  }

  // Draw nodes on top
  for (const node of _net.nodes) {
    const isHov = node === _net.hover;
    const r = node.r;

    // Glow
    const g = ctx.createRadialGradient(node.x, node.y, r * 0.2, node.x, node.y, r * 1.6);
    g.addColorStop(0, node.color + (isHov ? "88" : "44"));
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(node.x, node.y, r * 1.6, 0, Math.PI * 2); ctx.fill();

    // Circle
    ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle   = "#1e293b";
    ctx.fill();
    ctx.strokeStyle = node.color;
    ctx.lineWidth   = isHov ? 3.5 : 2.5;
    ctx.stroke();

    // Icon
    ctx.font          = `${Math.round(r * 0.56)}px serif`;
    ctx.textAlign     = "center";
    ctx.textBaseline  = "middle";
    ctx.fillStyle     = "#fff";
    ctx.fillText(node.icon, node.x, node.y - 2);

    // Name
    ctx.font          = `bold ${Math.max(9, Math.round(r * 0.31))}px ui-monospace,monospace`;
    ctx.fillStyle     = isHov ? "#f8fafc" : "#e2e8f0";
    ctx.textBaseline  = "top";
    ctx.fillText(node.name.length > 16 ? node.name.slice(0, 15) + "…" : node.name, node.x, node.y + r + 6);
    ctx.textBaseline  = "alphabetic";
  }

  ctx.restore();
}

function _netSimTick() {
  const nodes = _net.nodes, edges = _net.edges;
  const nmap  = Object.fromEntries(nodes.map(n => [n.did, n]));
  const K_REP = 9000, K_SPR = 0.035, REST = 220, DAMP = 0.82;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
      const d2 = dx * dx + dy * dy + 1, d = Math.sqrt(d2);
      const f  = K_REP / d2;
      nodes[i].vx -= f * dx / d; nodes[i].vy -= f * dy / d;
      nodes[j].vx += f * dx / d; nodes[j].vy += f * dy / d;
    }
  }
  for (const edge of edges) {
    const a = nmap[edge.src], b = nmap[edge.dst];
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d  = Math.sqrt(dx * dx + dy * dy) || 1;
    const f  = K_SPR * (d - REST);
    a.vx += f * dx / d; a.vy += f * dy / d;
    b.vx -= f * dx / d; b.vy -= f * dy / d;
  }
  nodes.forEach(n => { n.vx -= n.x * 0.008; n.vy -= n.y * 0.008; });
  nodes.forEach(n => {
    if (_net.drag?.node === n) return;
    n.vx *= DAMP; n.vy *= DAMP;
    n.x  += n.vx; n.y  += n.vy;
  });
}

function _netAnimate() {
  _netSimTick(); _netDraw(); _net.step++;
  const maxV = _net.nodes.reduce((m, n) => Math.max(m, Math.abs(n.vx) + Math.abs(n.vy)), 0);
  if (maxV > 0.08 && _net.step < _net.MAX_STEPS) {
    _net.animId = requestAnimationFrame(_netAnimate);
  } else {
    _netFitView(); _netDraw(); _net.animId = null;
  }
}

function _netSetupEvents(canvas) {
  if (canvas._netEventsAttached) return;
  canvas._netEventsAttached = true;

  const pos = e => {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const { x, y } = pos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nz = Math.min(8, Math.max(0.06, _net.zoom * factor));
    _net.tx  = x - (x - _net.tx) * (nz / _net.zoom);
    _net.ty  = y - (y - _net.ty) * (nz / _net.zoom);
    _net.zoom = nz;
    _netDraw();
  }, { passive: false });

  canvas.addEventListener("mousedown", e => {
    const { x, y } = pos(e);
    const hit = _netHit(x, y);
    if (hit) {
      _net.drag = { node: hit, moved: false };
      canvas.style.cursor = "grabbing";
    } else {
      _net.pan = { x0: x, y0: y, tx0: _net.tx, ty0: _net.ty };
      canvas.style.cursor = "grabbing";
    }
  });

  window.addEventListener("mousemove", e => {
    if (!_net.canvas) return;
    const rect = _net.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (_net.drag) {
      const [wx, wy] = _netS2W(sx, sy);
      _net.drag.node.x = wx; _net.drag.node.y = wy;
      _net.drag.node.vx = 0; _net.drag.node.vy = 0;
      _net.drag.moved = true;
      _netDraw();
    } else if (_net.pan) {
      _net.tx = _net.pan.tx0 + (sx - _net.pan.x0);
      _net.ty = _net.pan.ty0 + (sy - _net.pan.y0);
      _netDraw();
    } else if (sx >= 0 && sy >= 0 && sx <= rect.width && sy <= rect.height) {
      const hit = _netHit(sx, sy);
      if (hit !== _net.hover) {
        _net.hover = hit;
        _net.canvas.style.cursor = hit ? "pointer" : "grab";
        _netDraw();
      }
    }
  });

  window.addEventListener("mouseup", () => {
    if (_net.drag && !_net.drag.moved && _net.drag.node) {
      _netOpenNode(_net.drag.node);
    }
    _net.drag = null; _net.pan = null;
    if (_net.canvas) _net.canvas.style.cursor = "grab";
  });

  canvas.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    const { x, y } = pos(e);
    const hit = _netHit(x, y);
    if (hit) _net.drag = { node: hit, moved: false };
    else     _net.pan  = { x0: x, y0: y, tx0: _net.tx, ty0: _net.ty };
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchmove", e => {
    if (e.touches.length !== 1) return;
    const { x, y } = pos(e);
    if (_net.drag) {
      const [wx, wy] = _netS2W(x, y);
      _net.drag.node.x = wx; _net.drag.node.y = wy;
      _net.drag.moved = true; _netDraw();
    } else if (_net.pan) {
      _net.tx = _net.pan.tx0 + (x - _net.pan.x0);
      _net.ty = _net.pan.ty0 + (y - _net.pan.y0);
      _netDraw();
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    if (_net.drag && !_net.drag.moved && _net.drag.node) _netOpenNode(_net.drag.node);
    _net.drag = null; _net.pan = null;
  });
}

function _netOpenNode(node) {
  const title  = document.getElementById("info-drawer-title");
  const body   = document.getElementById("info-drawer-body");
  const drawer = document.getElementById("info-drawer");
  if (!body || !drawer) return;
  if (title) title.textContent = `${node.icon} ${node.name}`;
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  drawer.classList.add("open");

  Promise.all([
    _authFetch(`/agents/${encodeURIComponent(node.did)}`).then(r => r.ok ? r.json() : null).catch(() => null),
    _authFetch(`/agents/${encodeURIComponent(node.did)}/trust-score`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([ag, ts]) => {
    const score   = ts?.score ?? "—";
    const level   = ts?.level ?? "—";
    const created = ag?.created_at ? new Date(ag.created_at).toLocaleDateString() : "—";
    const tags    = (ag?.tags || []).map(t =>
      `<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:0.1rem 0.4rem;font-size:0.7rem;">${esc(t)}</span>`
    ).join(" ");
    const bk  = ts?.breakdown || {};
    const bkHtml = Object.entries(bk).map(([k, v]) =>
      `<div style="display:flex;justify-content:space-between;font-size:0.75rem;padding:0.22rem 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--muted);">${esc(k.replace(/_/g, " "))}</span>
        <span style="font-weight:600;">${v?.score ?? v ?? 0} / ${v?.max ?? "?"}</span>
       </div>`
    ).join("");

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">
        <div style="font-size:2rem;">${node.icon}</div>
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:1rem;">${esc(node.name)}</div>
          <div style="font-size:0.63rem;color:var(--muted);word-break:break-all;">${esc(node.did)}</div>
        </div>
      </div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem;">
        ${tags || `<span style="color:var(--muted);font-size:0.75rem;">no tags</span>`}
      </div>
      <div style="display:flex;gap:0.75rem;margin-bottom:1rem;">
        <div style="background:var(--surface2);border-radius:8px;padding:0.6rem 1rem;flex:1;text-align:center;">
          <div style="font-size:1.5rem;font-weight:700;">${score}</div>
          <div style="font-size:0.63rem;color:var(--muted);">Trust score</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:0.6rem 1rem;flex:1;text-align:center;">
          <div style="font-size:1rem;font-weight:700;text-transform:capitalize;">${esc(String(level))}</div>
          <div style="font-size:0.63rem;color:var(--muted);">Level</div>
        </div>
      </div>
      ${bkHtml ? `<div style="font-size:0.65rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:0.4rem;">Breakdown</div>${bkHtml}` : ""}
      <div style="margin-top:0.75rem;font-size:0.72rem;color:var(--muted);">Created ${created}</div>`;
  });
}

// Role → {color, icon} for well-known agent names
const _ROLE_META = {
  orchestrator: { color: "#f59e0b", icon: "🎯" },
  researcher:   { color: "#10b981", icon: "🔍" },
  coder:        { color: "#8b5cf6", icon: "💻" },
  reviewer:     { color: "#ef4444", icon: "🔎" },
  monitor:      { color: "#64748b", icon: "📡" },
};

function _roleMeta(name) {
  return _ROLE_META[(name || "").toLowerCase()] || { color: "#3b82f6", icon: "🤖" };
}

function _opColor(op) {
  if (!op) return "#64748b";
  if (_OP_COLORS[op]) return _OP_COLORS[op];
  if (op.startsWith("verify")) return "#3b82f6";
  return "#64748b";
}

let _networkRefreshTimer = null;

// Load network graph lazily — fire when card scrolls into view so offsetWidth
// is always valid (avoids blank canvas on cold load before first paint).
let _netObserver = null;
function _initNetworkObserver() {
  const card = document.getElementById("network-graph-card");
  if (!card) return;
  if (_netObserver) { _netObserver.disconnect(); _netObserver = null; }
  // root: dash-main (the actual scroll container) — viewport root doesn't
  // fire when content scrolls inside an overflow:auto pane, not the window
  const scrollRoot = document.getElementById("dash-main") || null;
  _netObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      _netObserver.disconnect(); _netObserver = null;
      loadNetworkGraph().catch(e => console.error("loadNetworkGraph:", e));
    }
  }, { threshold: 0, root: scrollRoot });
  _netObserver.observe(card);
  // Fallback: if observer doesn't fire within 3s (card already visible), load directly
  setTimeout(() => {
    if (_netObserver) {
      _netObserver.disconnect(); _netObserver = null;
      loadNetworkGraph().catch(e => console.error("loadNetworkGraph:", e));
    }
  }, 3000);
}

async function loadNetworkGraph() {
  const canvas      = document.getElementById("network-canvas");
  const pill        = document.getElementById("network-live-pill");
  const agentListEl = document.getElementById("network-agent-list");
  const evListEl    = document.getElementById("network-event-list");
  const evCountEl   = document.getElementById("network-event-count");
  const emptyEl     = document.getElementById("network-empty");
  if (!canvas) return;

  const days = parseInt(document.getElementById("network-range")?.value || "7", 10);
  if (pill) { pill.className = "status-pill status-pill-muted"; pill.textContent = "loading…"; }

  // Cancel running simulation
  if (_net.animId) { cancelAnimationFrame(_net.animId); _net.animId = null; }

  // ── Fetch ─────────────────────────────────────────────────────────────────
  let agents = [], logs = [], logsAccessible = true;
  try {
    const [ar, lr] = await Promise.all([
      _authFetch("/agents?mine=true&limit=500"),
      _authFetch("/pro/audit-log/json?limit=500"),
    ]);
    if (ar.ok) agents = (await ar.json()) || [];
    if (lr.ok) {
      logs = ((await lr.json()).logs) || [];
    } else {
      // 403 = free tier or missing feature; still show agent nodes, note no edge data
      logsAccessible = (lr.status !== 403);
    }
  } catch (_) {
    if (pill) { pill.className = "status-pill status-pill-red"; pill.textContent = "error"; }
    return;
  }

  const didToAgent = Object.fromEntries(agents.map(a => [a.did, a]));
  const cutoff     = Date.now() - days * 86400000;
  const windowLogs = logs.filter(ev => {
    const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
    return !ts || ts >= cutoff;
  });

  // Build edges
  const edgeMap = {};
  for (const ev of windowLogs) {
    if (!ev.did || !ev.counterparty) continue;
    const key = ev.did + "|" + ev.counterparty;
    if (!edgeMap[key]) edgeMap[key] = { src: ev.did, dst: ev.counterparty, count: 0, ops: {} };
    edgeMap[key].count++;
    const op = ev.operation || ev.action || "?";
    edgeMap[key].ops[op] = (edgeMap[key].ops[op] || 0) + 1;
  }
  const rawEdges  = Object.values(edgeMap).sort((a, b) => b.count - a.count);
  const maxCount  = rawEdges[0]?.count || 1;

  // Only owned agents + counterparties that interacted with owned agents
  const ownedDids = new Set(agents.map(a => a.did));
  const filteredEdges = rawEdges.filter(e => ownedDids.has(e.src) || ownedDids.has(e.dst));
  const edgeDids = new Set();
  filteredEdges.forEach(e => { edgeDids.add(e.src); edgeDids.add(e.dst); });
  const nodeDids = edgeDids.size > 0 ? Array.from(edgeDids) : Array.from(ownedDids);

  // ── HiDPI canvas setup ────────────────────────────────────────────────────
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement?.offsetWidth || canvas.offsetWidth || 700;
  const H   = 560;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + "px";
  canvas.style.height = H + "px";

  _net.canvas = canvas;
  _net.ctx    = canvas.getContext("2d");
  _net.ctx.scale(dpr, dpr);

  if (nodeDids.length === 0) {
    if (emptyEl) emptyEl.style.display = "flex";
    if (pill) { pill.className = "status-pill status-pill-muted"; pill.textContent = "no agents"; }
    _netDraw();
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  // ── Build node objects (jittered circle start) ────────────────────────────
  const r0 = Math.min(W, H) * 0.28;
  _net.nodes = nodeDids.map((did, i) => {
    const ag = didToAgent[did];
    const { color, icon } = _roleMeta(ag?.name);
    const angle = (2 * Math.PI * i / nodeDids.length) - Math.PI / 2;
    const jit = (Math.random() - 0.5) * 50;
    return {
      did, name: ag?.name || did.slice(-10), icon, color,
      x: r0 * Math.cos(angle) + jit,
      y: r0 * Math.sin(angle) + jit,
      vx: 0, vy: 0, r: 36,
    };
  });

  // ── Build edge objects ────────────────────────────────────────────────────
  _net.edges = filteredEdges.map(e => {
    const topOp = Object.entries(e.ops).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    return {
      src: e.src, dst: e.dst, count: e.count,
      lw:    1 + (e.count / maxCount) * 3.5,
      color: _opColor(topOp),
      label: topOp.replace(/_/g, " "),
    };
  });

  // Reset transform to center
  _net.tx = W / 2; _net.ty = H / 2; _net.zoom = 1;
  _net.hover = null; _net.drag = null; _net.pan = null;
  _net.step  = 0;
  _net.MAX_STEPS = Math.min(250, 60 + nodeDids.length * 3);

  _netSetupEvents(canvas);

  // ── Sidebar: agents ───────────────────────────────────────────────────────
  if (agentListEl) {
    agentListEl.innerHTML = nodeDids.map(did => {
      const ag = didToAgent[did];
      const { color } = _roleMeta(ag?.name);
      const name = ag?.name || did.slice(-10);
      const shortDid = did.length > 34 ? did.slice(0, 33) + "…" : did;
      return `<div class="network-agent-row">
        <div style="width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0;"></div>
        <span style="font-weight:700;">${esc(name)}</span>
        <span class="network-agent-did" title="${esc(did)}">${esc(shortDid)}</span>
      </div>`;
    }).join("");
  }

  // ── Sidebar: event log ────────────────────────────────────────────────────
  if (evListEl) {
    if (evCountEl) evCountEl.textContent = `(${windowLogs.length})`;
    evListEl.innerHTML = windowLogs.slice(0, 120).map(ev => {
      const op    = ev.operation || ev.action || "?";
      const color = _opColor(op);
      const src   = didToAgent[ev.did]?.name || (ev.did || "?").slice(-10);
      const dst   = ev.counterparty ? (didToAgent[ev.counterparty]?.name || ev.counterparty.slice(-10)) : null;
      const ts    = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
      return `<div class="network-ev-row">
        <span class="network-ev-op" style="background:${color}22;color:${color};border:1px solid ${color}44;">${esc(op)}</span>
        <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:65px;white-space:nowrap;">${esc(src)}</span>
        ${dst ? `<span style="color:var(--muted);flex-shrink:0;">→</span><span style="overflow:hidden;text-overflow:ellipsis;max-width:55px;white-space:nowrap;">${esc(dst)}</span>` : ""}
        <span class="network-ev-ts">${ts}</span>
      </div>`;
    }).join("");
  }

  // ── Pill ──────────────────────────────────────────────────────────────────
  if (pill) {
    if (!logsAccessible) {
      pill.className   = "status-pill status-pill-muted";
      pill.textContent = `${nodeDids.length} agent${nodeDids.length !== 1 ? "s" : ""} · interaction history requires Pro`;
    } else {
      pill.className   = "status-pill status-pill-green";
      pill.textContent = `${windowLogs.length} events · ${nodeDids.length} agents`;
    }
  }

  // ── Run force simulation → animate ───────────────────────────────────────
  _net.animId = requestAnimationFrame(_netAnimate);

  // ── Auto-refresh every 60 s ───────────────────────────────────────────────
  clearTimeout(_networkRefreshTimer);
  _networkRefreshTimer = setTimeout(() => loadNetworkGraph().catch(() => {}), 60000);
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
        credentials: "include",
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

function openSettings(tab) {
  document.getElementById("settings-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
  // Always reload account info when modal opens
  _loadAccountInfo();
  _loadAccountKeys();
  _initPreferencesPanel();
  _loadSessionHistory();
  // Switch to requested tab (or restore default)
  const targetTab = tab || document.querySelector(".modal-tab.active")?.dataset.tab || "account";
  _switchSettingsTab(targetTab);
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
              <td style="padding:0.45rem 0.5rem;font-weight:600;">
                ${esc(k.label || "(unlabelled)")}
                ${k.permanent ? '<span title="Permanent owner key — cannot be revoked" style="margin-left:0.35rem;font-size:0.72rem;opacity:0.7;">🔒</span>' : ""}
              </td>
              <td style="padding:0.45rem 0.5rem;color:var(--text-2);">${esc(k.scopes || "(full)")}</td>
              <td style="padding:0.45rem 0.5rem;color:var(--muted);font-size:0.74rem;">${esc(_relativeTime(k.created_at) || "—")}</td>
              <td style="padding:0.45rem 0.5rem;color:var(--muted);font-size:0.74rem;">${esc(_relativeTime(k.last_used) || "never")}</td>
              <td style="padding:0.45rem 0.5rem;text-align:right;">
                ${k.permanent
                  ? '<span style="font-size:0.72rem;color:var(--muted);">permanent</span>'
                  : `<button class="btn btn-outline ak-revoke-btn" data-label="${esc(k.label)}" style="font-size:0.72rem;padding:0.25rem 0.6rem;color:var(--red);border-color:var(--red);">Revoke</button>`}
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
  // Restore the active section hash so the URL stays meaningful after close.
  // If no section is active yet, just clear the settings fragment.
  const activeNav = document.querySelector(".dsb-item.active[data-nav]")?.dataset.nav;
  history.replaceState(null, "", activeNav ? "#section-" + activeNav : location.pathname + location.search);
}

function _switchSettingsTab(tab) {
  document.querySelectorAll(".modal-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  document.querySelectorAll(".modal-panel").forEach(p =>
    p.classList.toggle("active", p.id === `tab-${tab}`)
  );
  // Persist tab in URL hash so a refresh reopens the same tab
  history.replaceState(null, "", `#settings/${tab}`);
  // Lazy-load heavy tabs only when opened
  if (tab === "key-rotation") _loadRotationAgentList();
  if (tab === "webhooks") { _initWebhookEventGrid(); _loadWebhooks(); _initTelegramSection(); }
  if (tab === "sandbox") _loadSandboxStatus();
  if (tab === "preferences") _initPreferencesPanel();
  if (tab === "security") { _loadSecuritySessions(); _loadSessionHistory(); }
  if (tab === "eu-compliance") _euLoadAll();
  if (tab === "footprint") _initFootprintTab();
  if (tab === "sub-accounts") _loadSubAccounts();
}

// ── Preferences panel ─────────────────────────────────────────────────────────

const PREF_DEFAULTS = {
  "compact-mode":      false,
  "animate-cards":     true,
  "sparklines":        true,
  "browser-notifs":    false,
  "sound-notifs":      false,
  "anomaly-alert":     true,
  "remember-section":  true,
  "refresh-interval":  "60",
  "default-visibility":"public",
};

function _loadPrefs() {
  try { return JSON.parse(localStorage.getItem("agentid_prefs") || "{}"); }
  catch { return {}; }
}

function _savePrefs(prefs) {
  localStorage.setItem("agentid_prefs", JSON.stringify(prefs));
}

function _getPref(key) {
  const prefs = _loadPrefs();
  return key in prefs ? prefs[key] : PREF_DEFAULTS[key];
}

function _applyPrefs() {
  // Compact mode
  document.body.classList.toggle("pref-compact", _getPref("compact-mode"));
  // Animation
  document.body.classList.toggle("pref-no-animate", !_getPref("animate-cards"));
  // Auto-refresh (restart on next load — stored in memory for current session)
  const interval = parseInt(_getPref("refresh-interval")) || 0;
  if (window._prefRefreshTimer) clearInterval(window._prefRefreshTimer);
  if (interval > 0 && typeof refreshDashboard === "function") {
    window._prefRefreshTimer = setInterval(() => {
      try { refreshDashboard(); } catch (e) {}
    }, interval * 1000);
  }
}

let _prefsInited = false;
function _initPreferencesPanel() {
  const panel = document.getElementById("tab-preferences");
  if (!panel) return;

  const prefs = _loadPrefs();

  // Sync toggle switches
  panel.querySelectorAll(".pref-toggle-track").forEach(track => {
    const key = track.dataset.pref;
    if (!key) return;
    const input = document.getElementById(`pref-${key}`);
    if (!input) return;
    const val = key in prefs ? prefs[key] : PREF_DEFAULTS[key];
    input.checked = !!val;

    if (!_prefsInited) {
      input.addEventListener("change", () => {
        const p = _loadPrefs();
        p[key] = input.checked;
        _savePrefs(p);
        _applyPrefs();
        // Browser notification permission
        if (key === "browser-notifs" && input.checked && "Notification" in window) {
          Notification.requestPermission();
        }
      });
    }
  });

  // Sync selects
  const refreshSel = document.getElementById("pref-refresh-interval");
  const visSel     = document.getElementById("pref-default-visibility");
  if (refreshSel) {
    refreshSel.value = _getPref("refresh-interval") || "60";
    if (!_prefsInited) {
      refreshSel.addEventListener("change", () => {
        const p = _loadPrefs(); p["refresh-interval"] = refreshSel.value; _savePrefs(p); _applyPrefs();
      });
    }
  }
  if (visSel) {
    visSel.value = _getPref("default-visibility") || "public";
    if (!_prefsInited) {
      visSel.addEventListener("change", () => {
        const p = _loadPrefs(); p["default-visibility"] = visSel.value; _savePrefs(p);
      });
    }
  }

  // Save & reset
  if (!_prefsInited) {
    const saveBtn  = document.getElementById("pref-save-btn");
    const resetBtn = document.getElementById("pref-reset-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        _applyPrefs();
        saveBtn.textContent = "Saved ✓";
        saveBtn.style.background = "var(--green)";
        setTimeout(() => { saveBtn.textContent = "Save preferences"; saveBtn.style.background = ""; }, 1800);
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        localStorage.removeItem("agentid_prefs");
        _initPreferencesPanel();
        _applyPrefs();
      });
    }
  }

  _prefsInited = true;
}

// ── Trust Score Fleet Widget ─────────────────────────────────────────────────

const _tsBreakdownCache = {};   // did → full breakdown data (survives re-renders)
let   _tsAllAgents      = [];   // full agent list from last /pro/trust-scores call

async function _loadTrustScoreWidget() {
  const card    = document.getElementById("trust-score-card");
  const list    = document.getElementById("trust-score-list");
  const distRow = document.getElementById("trust-dist-row");
  if (!card || !list) return;

  try {
    const data = await apiFetch("/pro/trust-scores");
    if (!data || !data.agents || data.agents.length === 0) {
      card.style.display = "none";
      return;
    }

    card.style.display = "";
    _tsAllAgents = data.agents;   // cache for level-filter sidebar

    // Distribution summary — buttons that open a filtered agent list
    const dist = data.distribution || {};
    const levels = [
      { key: "excellent", label: "Excellent", cls: "trust-level-excellent" },
      { key: "good",      label: "Good",      cls: "trust-level-good"      },
      { key: "moderate",  label: "Moderate",  cls: "trust-level-moderate"  },
      { key: "low",       label: "Low",       cls: "trust-level-low"       },
    ];
    distRow.innerHTML = levels.map(l => {
      const count = dist[l.key] || 0;
      return `<button class="trust-dist-pill ${l.cls}" data-level="${l.key}"
                style="cursor:pointer;border:none;background:inherit;"
                title="View ${l.label.toLowerCase()} agents">${l.label} <strong>${count}</strong></button>`;
    }).join("") + `<span style="margin-left:auto;font-size:0.78rem;color:var(--muted);">Fleet avg: <strong>${(data.average_score || 0).toFixed(1)}</strong></span>`;

    distRow.querySelectorAll(".trust-dist-pill[data-level]").forEach(btn => {
      btn.addEventListener("click", () => _openTrustLevelDrawer(btn.dataset.level));
    });

    // Per-agent rows — click opens the trust-score detail panel
    const COLOR = { excellent: "#22c55e", good: "#3b82f6", moderate: "#f59e0b", low: "#ef4444" };
    list.innerHTML = data.agents.map(a => {
      const pct   = Math.round(a.score);
      const color = COLOR[a.level] || "#94a3b8";
      const name  = esc(a.name || a.did.slice(0, 28) + "…");
      return `
        <div class="ts-agent-row" data-did="${esc(a.did)}" data-name="${name}"
             data-score="${pct}" data-level="${esc(a.level)}"
             style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;
                    border-bottom:1px solid var(--border);cursor:pointer;user-select:none;
                    transition:background 0.1s;" title="Click for score breakdown">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                 title="${esc(a.did)}">${name}</div>
            ${a.top_3_issues && a.top_3_issues.length
              ? `<div style="font-size:0.68rem;color:#f59e0b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(a.top_3_issues.join(' · '))}">⚠ ${esc(a.top_3_issues[0])}</div>`
              : `<div style="font-size:0.68rem;color:#22c55e;">✓ No issues</div>`}
          </div>
          <div class="trust-score-bar-wrap" style="width:140px;flex-shrink:0;">
            <div style="height:6px;border-radius:999px;background:var(--surface2);overflow:hidden;">
              <div class="trust-score-bar" style="width:${pct}%;background:${color};height:100%;"></div>
            </div>
            <span style="font-size:0.78rem;font-weight:700;color:${color};min-width:28px;text-align:right;">${pct}</span>
          </div>
          <span class="trust-level-badge trust-level-${a.level}" style="flex-shrink:0;">${esc(a.level)}</span>
          <span style="font-size:0.6rem;color:var(--muted);">›</span>
        </div>`;
    }).join("");

    // Open panel on row click
    list.querySelectorAll(".ts-agent-row").forEach(row => {
      row.addEventListener("click", () => {
        _openTrustScorePanel(row.dataset.did, row.dataset.name,
                             Number(row.dataset.score), row.dataset.level);
      });
    });

  } catch (e) {
    // Silently skip if endpoint unavailable (feature gate)
  }
}

// D1-D5 dimension definitions — match the backend's weighted scoring model.
// Weights: D1=20%, D2=25%, D3=20%, D4=20%, D5=15%, D6=capability trust (unweighted).
const _TS_DIMENSIONS = [
  { key: "identity_integrity",      label: "D1 · Identity Integrity",      color: "#6366f1", weight: 20,
    hint: "DID consistency, key rotation, signing compliance, deprecation/revocation status" },
  { key: "operational_reliability", label: "D2 · Operational Reliability",  color: "#10b981", weight: 25,
    hint: "Verification rate & volume, liveness, SLA compliance, uptime, task completion" },
  { key: "network_reputation",      label: "D3 · Network Reputation",       color: "#f59e0b", weight: 20,
    hint: "Peer attestations, complaint density, PageRank-based network standing" },
  { key: "behavioral_history",      label: "D4 · Behavioral History",       color: "#3b82f6", weight: 20,
    hint: "Scope violations, accountability, interaction scoring, trajectory decay" },
  { key: "governance",              label: "D5 · Governance",               color: "#8b5cf6", weight: 15,
    hint: "Verified badge tier, published & validated capability contracts, POLP compliance" },
];

function _renderTrustBreakdown(el, data) {
  const totalScore = typeof data.score === "number" ? data.score : 0;
  const level      = data.level || "low";
  const dims       = data.dimensions || {};
  const issues     = data.top_3_issues || [];

  const levelColor = { excellent: "#22c55e", good: "#3b82f6", moderate: "#f59e0b", low: "#ef4444" }[level] || "#94a3b8";

  // ── Top-issues banner ──────────────────────────────────────────────────────
  const issuesBanner = issues.length ? `
    <div style="background:rgba(120,53,15,0.25);border:1px solid #78350f;border-radius:6px;padding:0.5rem 0.75rem;margin-bottom:0.65rem;">
      <div style="font-size:0.65rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.3rem;">⚠ Top Issues</div>
      ${issues.map(i => `<div style="font-size:0.71rem;color:#fcd34d;line-height:1.45;">${esc(i)}</div>`).join("")}
    </div>` : "";

  // ── D1-D5 dimension rows ───────────────────────────────────────────────────
  // Backend returns dimensions as plain numbers (legacy) or {score, trend_30d} objects.
  function _dScore(v) {
    if (v == null) return null;
    if (typeof v === "object") return typeof v.score === "number" ? v.score : null;
    return typeof v === "number" ? v : null;
  }
  function _dTrend(v) {
    if (v == null || typeof v !== "object") return null;
    return typeof v.trend_30d === "number" ? v.trend_30d : null;
  }

  const dimRows = _TS_DIMENSIONS.map(d => {
    const raw   = dims[d.key];
    const score = _dScore(raw);
    const trend = _dTrend(raw);
    const pct   = score != null ? Math.min(100, Math.max(0, Math.round(score))) : 0;
    const color = pct >= 75 ? "#22c55e" : pct >= 45 ? "#f59e0b" : "#ef4444";
    const trendHtml = trend != null ? `<span style="font-size:0.63rem;color:${trend >= 0 ? "#22c55e" : "#ef4444"};margin-left:4px;">${trend >= 0 ? "↑" : "↓"}${Math.abs(trend).toFixed(1)}</span>` : "";
    const wt = d.weight ? `<span style="font-size:0.6rem;color:var(--muted);margin-left:auto;">${d.weight}%</span>` : "";
    return `
      <div style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:0.3rem;margin-bottom:4px;">
          <span style="font-size:0.75rem;font-weight:600;color:${d.color};">${esc(d.label)}</span>
          ${trendHtml}
          ${wt}
          <span style="font-size:0.72rem;font-weight:700;margin-left:6px;color:${color};">${score != null ? pct : "—"}</span>
        </div>
        <div style="height:4px;background:var(--surface3,#2a2a2a);border-radius:999px;overflow:hidden;margin-bottom:3px;">
          <div style="width:${pct}%;height:100%;background:${d.color};border-radius:999px;transition:width 0.4s;"></div>
        </div>
        <div style="font-size:0.63rem;color:var(--muted);">${esc(d.hint)}</div>
      </div>`;
  }).join("");

  // ── Capability trust row (D6, unweighted) ─────────────────────────────────
  const capRaw  = dims.capability_trust;
  let   capHtml = "";
  if (capRaw != null) {
    let capScore = null;
    if (typeof capRaw === "number") { capScore = Math.round(capRaw); }
    else if (typeof capRaw === "object") {
      if (typeof capRaw.score === "number") { capScore = Math.round(capRaw.score); }
      else {
        const vals = Object.values(capRaw).filter(v => typeof v === "number");
        capScore = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      }
    }
    if (capScore != null) {
      const pct = Math.min(100, Math.max(0, capScore));
      const col = pct >= 75 ? "#22c55e" : pct >= 45 ? "#f59e0b" : "#ef4444";
      capHtml = `
        <div style="padding:0.4rem 0;">
          <div style="display:flex;align-items:center;gap:0.3rem;margin-bottom:4px;">
            <span style="font-size:0.75rem;font-weight:600;color:#ec4899;">D6 · Capability Trust</span>
            <span style="font-size:0.72rem;font-weight:700;margin-left:auto;color:${col};">${capScore}</span>
          </div>
          <div style="height:4px;background:var(--surface3,#2a2a2a);border-radius:999px;overflow:hidden;margin-bottom:3px;">
            <div style="width:${pct}%;height:100%;background:#ec4899;border-radius:999px;"></div>
          </div>
          <div style="font-size:0.63rem;color:var(--muted);">Average capability contract trust score across all published capabilities</div>
        </div>`;
    }
  }

  // ── Formula note ──────────────────────────────────────────────────────────
  const formulaNote = `<div style="margin-top:0.5rem;font-size:0.63rem;color:var(--muted);line-height:1.5;">
    Total = D1×20% + D2×25% + D3×20% + D4×20% + D5×15%
  </div>`;

  el.innerHTML = `
    <div style="padding:0.75rem 1rem 0.5rem;background:var(--surface2,#1c1c1c);border-radius:0 0 0.5rem 0.5rem;">
      ${issuesBanner}
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.65rem;">
        <span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);">Trust Dimensions</span>
        <span style="margin-left:auto;font-size:0.75rem;font-weight:700;color:${levelColor};">${totalScore.toFixed(1)} pts — ${level}</span>
      </div>
      ${dimRows}
      ${capHtml}
      ${formulaNote}
    </div>`;
}

function _fmtTrustVal(key, val) {
  if (key === "verified_badge")  return val === "True" ? "✓ yes" : "✗ no";
  if (key === "not_deprecated")  return val === "True" ? "✓ active" : "⚠ deprecated";
  if (key === "not_revoked")     return val === "True" ? "✓ active" : "⚠ revoked";
  if (key === "liveness") {
    return { online: "● online", stale: "◑ stale", offline: "○ offline", never_pinged: "— never pinged" }[val] || val;
  }
  if (key === "verification_rate" && val === "no_data") return "— no data";
  return val || "—";
}

function _trustValColor(key, val) {
  if (key === "liveness") {
    if (val === "online")  return "#22c55e";
    if (val === "stale")   return "#f59e0b";
    return "#ef4444";
  }
  if (key === "verified_badge" || key === "not_deprecated" || key === "not_revoked") {
    return val === "True" ? "#22c55e" : "#ef4444";
  }
  return "var(--fg)";
}

// ── Generic Info Drawer ───────────────────────────────────────────────────────

function _closeInfoDrawer() {
  document.getElementById("info-drawer")?.classList.remove("open");
}

function _openInfoDrawer(title, bodyHtml) {
  const drawer = document.getElementById("info-drawer");
  if (!drawer) return;
  document.getElementById("info-drawer-title").textContent = title;
  document.getElementById("info-drawer-body").innerHTML = bodyHtml;
  drawer.classList.add("open");
}

function _openTrustLevelDrawer(level) {
  const COLOR = { excellent: "#22c55e", good: "#3b82f6", moderate: "#f59e0b", low: "#ef4444" };
  const agents = _tsAllAgents.filter(a => a.level === level).sort((a, b) => b.score - a.score);
  const label  = level.charAt(0).toUpperCase() + level.slice(1);
  const color  = COLOR[level] || "#94a3b8";

  if (!agents.length) {
    _openInfoDrawer(`${label} agents (0)`,
      `<div class="empty"><div class="empty-icon">✅</div><p>No agents in this category.</p></div>`);
    return;
  }

  const rows = agents.map(a => {
    const pct  = Math.round(a.score);
    const name = esc(a.name || a.did.slice(0, 28) + "…");
    return `
      <div style="display:flex;align-items:center;gap:0.6rem;padding:0.45rem 0;
                  border-bottom:1px solid var(--border);cursor:pointer;"
           class="info-ts-row"
           data-did="${esc(a.did)}" data-name="${name}" data-score="${pct}" data-level="${esc(a.level)}">
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
               title="${esc(a.did)}">${name}</div>
          <div style="font-size:0.7rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(a.did)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
          <div style="width:80px;height:5px;background:var(--surface2);border-radius:999px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${color};"></div>
          </div>
          <span style="font-size:0.78rem;font-weight:700;color:${color};min-width:24px;text-align:right;">${pct}</span>
        </div>
        <span style="font-size:0.6rem;color:var(--muted);">›</span>
      </div>`;
  }).join("");

  _openInfoDrawer(`${label} agents (${agents.length})`,
    `<div style="font-size:0.75rem;color:var(--muted);margin-bottom:0.75rem;">Click an agent to see its full score breakdown.</div>${rows}`);

  document.getElementById("info-drawer-body").querySelectorAll(".info-ts-row").forEach(row => {
    row.addEventListener("click", () => {
      _closeInfoDrawer();
      _openTrustScorePanel(row.dataset.did, row.dataset.name, Number(row.dataset.score), row.dataset.level);
    });
  });
}

async function _openActivityDrawer(op, count) {
  const pal = _opPalette(op);
  _openInfoDrawer(`${op} events (${count.toLocaleString()})`,
    `<div class="loading"><div class="spinner"></div> Loading recent events…</div>`);

  try {
    const res  = await _authFetch(`/pro/audit-log/json?operation=${encodeURIComponent(op)}&limit=100`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const logs = data.logs || [];

    if (!logs.length) {
      document.getElementById("info-drawer-body").innerHTML =
        `<div class="empty"><div class="empty-icon">📭</div><p>No recent ${esc(op)} events.</p></div>`;
      return;
    }

    const rows = logs.map(e => {
      const ts  = e.timestamp ? new Date(e.timestamp).toLocaleString() : "—";
      const did = e.did || "—";
      return `
        <div style="padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.78rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.15rem;">
            <span class="op-pill ${pal.cls}" style="font-size:0.7rem;">${esc(e.operation || op)}</span>
            ${_statusPill(e.status)}
            <span style="margin-left:auto;color:var(--muted);font-size:0.7rem;">${esc(ts)}</span>
          </div>
          <div style="color:var(--muted);font-size:0.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
               title="${esc(did)}">${esc(did)}</div>
        </div>`;
    }).join("");

    document.getElementById("info-drawer-body").innerHTML =
      `<div style="font-size:0.75rem;color:var(--muted);margin-bottom:0.75rem;">Showing ${logs.length} most recent events.</div>${rows}`;
  } catch (e) {
    document.getElementById("info-drawer-body").innerHTML =
      `<div style="color:var(--red);font-size:0.85rem;">Could not load events: ${esc(e.message)}</div>`;
  }
}

// ── Trust Score Panel ────────────────────────────────────────────────────────

function _closeTsDrawer() {
  document.getElementById("ts-drawer")?.classList.remove("open");
}

async function _openTrustScorePanel(did, name, score, level) {
  const drawer   = document.getElementById("ts-drawer");
  const body     = document.getElementById("ts-drawer-body");
  const nameEl   = document.getElementById("ts-drawer-name");
  const levelEl  = document.getElementById("ts-drawer-level");
  const didEl    = document.getElementById("ts-drawer-did");
  const fill     = document.getElementById("ts-drawer-score-fill");
  const scoreNum = document.getElementById("ts-drawer-score-num");
  if (!drawer) return;

  const COLOR = { excellent: "#22c55e", good: "#3b82f6", moderate: "#f59e0b", low: "#ef4444" };
  const color = COLOR[level] || "#94a3b8";

  nameEl.textContent  = name || did.slice(0, 28) + "…";
  didEl.textContent   = did;
  levelEl.textContent = level;
  levelEl.className   = `trust-level-badge trust-level-${level}`;
  fill.style.width      = score + "%";
  fill.style.background = color;
  scoreNum.textContent  = score + " pts";
  scoreNum.style.color  = color;

  body.innerHTML = `<div class="loading"><div class="spinner"></div> Loading breakdown…</div>`;
  drawer.classList.add("open");

  if (_tsBreakdownCache[did]) {
    _renderTrustBreakdown(body, _tsBreakdownCache[did]);
    return;
  }

  try {
    // Use the pro endpoint which always returns the full breakdown.
    // Public endpoint needs ?detailed=true; pro endpoint always includes it.
    const data = await apiFetch(`/pro/agents/${encodeURIComponent(did)}/trust-score`);
    _tsBreakdownCache[did] = data;
    _renderTrustBreakdown(body, data);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red);font-size:0.85rem;">Could not load breakdown: ${esc(e.message)}</div>`;
  }
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  _initSigningPager();   // one-time — survives every table redraw
  _initSigningSearch();  // one-time — survives every table redraw

  // Apply saved preferences immediately (before first render)
  _applyPrefs();

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

  // URL-fragment driven flows: #settings/{tab} — restore settings modal on refresh
  (function _restoreSettingsFromHash() {
    const m = location.hash.match(/^#settings(?:\/([a-z0-9-]+))?$/);
    if (!m) return;
    const tab = m[1] || "account";
    // Wait for auth to complete before opening modal
    const tryOpen = (attempts) => {
      if (attempts <= 0) return;
      if (apiKey || sessionStorage.getItem("agentid_key") || localStorage.getItem("agentid_persisted_key")) {
        openSettings(tab);
      } else {
        setTimeout(() => tryOpen(attempts - 1), 300);
      }
    };
    setTimeout(() => tryOpen(10), 500);
  })();

  // Runtime hashchange handler — fires when sidebar Settings link is clicked.
  // The IIFE above only handles the initial page load; this catches navigations.
  window.addEventListener("hashchange", () => {
    const m = location.hash.match(/^#settings(?:\/([a-z0-9-]+))?$/);
    if (!m) return;
    const tab = m[1] || "account";
    openSettings(tab);
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

  // Delete account — inline confirmation form
  document.getElementById("delete-account-btn")?.addEventListener("click", () => {
    // Build inline confirmation panel directly below the button row
    const existingPanel = document.getElementById("delete-confirm-panel");
    if (existingPanel) { existingPanel.remove(); return; } // toggle off

    const panel = document.createElement("div");
    panel.id = "delete-confirm-panel";
    panel.style.cssText = [
      "margin-top:1rem",
      "padding:1rem 1.1rem",
      "border:1px solid var(--red)",
      "border-radius:8px",
      "background:color-mix(in srgb, var(--red) 8%, var(--surface))",
      "display:flex",
      "flex-direction:column",
      "gap:0.75rem",
    ].join(";");

    panel.innerHTML = `
      <div style="font-size:0.84rem;font-weight:600;color:var(--red);">Confirm account deletion</div>
      <div style="font-size:0.78rem;color:var(--text);line-height:1.5;">
        This permanently deletes your account, all registered agents, all API keys, and all associated data.
        This action <strong>cannot be undone</strong>.
      </div>
      <div style="display:flex;flex-direction:column;gap:0.35rem;">
        <label style="font-size:0.75rem;color:var(--muted);">Type <strong style="color:var(--text);">DELETE</strong> to confirm</label>
        <input id="del-confirm-word" type="text" placeholder="DELETE"
          style="font-size:0.82rem;padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:6px;background:var(--input-bg,var(--surface));color:var(--text);width:100%;box-sizing:border-box;" />
      </div>
      <div style="display:flex;flex-direction:column;gap:0.35rem;">
        <label style="font-size:0.75rem;color:var(--muted);">Your permanent owner API key (<code style="font-size:0.73rem;">sk-...</code>)</label>
        <input id="del-confirm-key" type="password" placeholder="sk-..."
          style="font-size:0.82rem;padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:6px;background:var(--input-bg,var(--surface));color:var(--text);width:100%;box-sizing:border-box;font-family:monospace;" />
      </div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
        <button id="del-cancel-btn" class="btn btn-outline" style="font-size:0.78rem;padding:0.3rem 0.75rem;">Cancel</button>
        <button id="del-submit-btn" class="btn" style="font-size:0.78rem;padding:0.3rem 0.75rem;background:var(--red);color:#fff;border-color:var(--red);">Delete my account</button>
      </div>
      <div id="del-error-msg" style="font-size:0.77rem;color:var(--red);display:none;"></div>
    `;

    // Insert after the button row inside the danger-zone section
    const btn = document.getElementById("delete-account-btn");
    btn.closest(".modal-section").appendChild(panel);

    document.getElementById("del-cancel-btn").addEventListener("click", () => panel.remove());

    document.getElementById("del-submit-btn").addEventListener("click", async () => {
      const word = document.getElementById("del-confirm-word").value.trim();
      const key  = document.getElementById("del-confirm-key").value.trim();
      const errEl = document.getElementById("del-error-msg");

      if (word !== "DELETE") {
        errEl.textContent = "You must type DELETE exactly.";
        errEl.style.display = "block";
        return;
      }
      if (!key.startsWith("agentid_")) {
        errEl.textContent = "Enter your permanent owner API key (starts with agentid_).";
        errEl.style.display = "block";
        return;
      }

      const submitBtn = document.getElementById("del-submit-btn");
      submitBtn.disabled = true;
      submitBtn.textContent = "Deleting…";
      errEl.style.display = "none";

      try {
        await apiFetch("/auth/delete-account", {
          method: "DELETE",
          body: JSON.stringify({ confirmation: "DELETE", api_key: key }),
        });
        panel.remove();
        logout();
      } catch (e) {
        errEl.textContent = e.message || "Could not delete account. Check your API key.";
        errEl.style.display = "block";
        submitBtn.disabled = false;
        submitBtn.textContent = "Delete my account";
      }
    });
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
  document.getElementById("rotation-generate-btn").addEventListener("click", _generateRotationKeyPair);
  document.getElementById("rotation-initiate-btn").addEventListener("click", _initiateRotation);
  document.getElementById("rotation-cleanup-btn").addEventListener("click", _cleanupUnusedAgents);
  document.getElementById("rotation-download-btn").addEventListener("click", _downloadRotationPrivKey);
  document.getElementById("rotation-copy-priv-btn").addEventListener("click", _copyRotationPrivKey);

  // Security tab
  document.getElementById("sec-change-pw-btn")?.addEventListener("click", _secChangePassword);
  document.getElementById("sec-revoke-all-btn")?.addEventListener("click", async function () {
    if (!confirm("Sign out all other sessions? You'll stay logged in here.")) return;
    this.disabled = true;
    try {
      await apiFetch("/auth/logout-all", { method: "POST" });
      _modalMsg("sec-session-msg", "✓ All other sessions signed out.", "ok");
      _loadSecuritySessions();
    } catch (e) {
      _modalMsg("sec-session-msg", `Error: ${e.message}`, "error");
    } finally { this.disabled = false; }
  });

  // Webhooks tab
  document.getElementById("wh-create-btn").addEventListener("click", _createWebhook);
  document.getElementById("webhooks-refresh-btn").addEventListener("click", _loadWebhooks);
  document.getElementById("wh-secret-copy-btn").addEventListener("click", function () {
    const val = document.getElementById("wh-secret-value")?.textContent || "";
    navigator.clipboard.writeText(val).catch(() => {});
    this.textContent = "Copied!";
    setTimeout(() => { this.textContent = "Copy secret"; }, 1800);
  });

  // Telegram integration tab buttons
  document.getElementById("tg-save-btn").addEventListener("click", _saveTelegram);
  document.getElementById("tg-test-btn").addEventListener("click", _testTelegram);
  document.getElementById("tg-toggle-btn").addEventListener("click", _toggleTelegram);
  document.getElementById("tg-delete-btn").addEventListener("click", _deleteTelegram);
  document.getElementById("tg-events-all-btn").addEventListener("click", () => {
    document.querySelectorAll("#tg-events-grid input[type='checkbox']").forEach(cb => cb.checked = true);
  });
  document.getElementById("tg-events-none-btn").addEventListener("click", () => {
    document.querySelectorAll("#tg-events-grid input[type='checkbox']").forEach(cb => cb.checked = false);
  });

  // ── Export CSV ──────────────────────────────────────────────────────────────
  document.getElementById("csv-btn").addEventListener("click", async function () {
    const btn = this;
    const original = btn.textContent;
    btn.textContent = "Exporting…";
    btn.disabled = true;
    try {
      const res = await _authFetch("/pro/audit-log/csv");
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
    const btn = this;
    const original = btn.textContent;
    btn.textContent = "Exporting…";
    btn.disabled = true;
    try {
      const res = await _authFetch("/pro/audit-log/json");
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
  document.getElementById("pdf-btn").addEventListener("click", function () {
    _openReportModal();
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
      const res = await _fetchAuth(`${BASE}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const res = await _fetchAuth(`${BASE}/agents/${encodeURIComponent(_verifyDid)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  // ── Agent card action delegation ─────────────────────────────────────────────
  document.getElementById("agents-table")?.addEventListener("click", e => {
    const btn = e.target.closest(".agent-action-btn");
    if (!btn) return;
    const { action, did, name } = btn.dataset;
    if (action === "details")  _openInspector(did, name);
    if (action === "verify")   _openTestVerify(did, name);
    if (action === "snippets") _openSnippets(did, name);
  });

  // ── Inspector pane action delegation ─────────────────────────────────────────
  document.getElementById("ag-insp-body")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, did, name } = btn.dataset;
    if (action === "verify")   _openTestVerify(did, name);
    if (action === "snippets") _openSnippets(did, name);
  });

  // Inspector close button
  document.getElementById("ag-insp-close")?.addEventListener("click", _closeInspector);

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
        const pgHeaders = {};
        const rawBody = document.getElementById("pg-body")?.value?.trim();
        if ((method === "POST" || method === "PATCH") && rawBody) {
          pgHeaders["Content-Type"] = "application/json";
        }
        const res = await _fetchAuth(BASE + path, {
          method,
          headers: pgHeaders,
          ...(rawBody && (method === "POST" || method === "PATCH") ? { body: rawBody } : {}),
        });
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

  // Assign to module-level slot so loadDashboard() can call it
  _loadGroups = async function _loadGroupsFn() {
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
    let sessionOk = false;
    try {
      const r = await fetch(BASE + "/auth/me", { credentials: "include" });
      if (r.ok) {
        authMode = "session";
        sessionStorage.setItem("agentid_auth_mode", "session");
        sessionStorage.setItem("agentid_login_ts",
          sessionStorage.getItem("agentid_login_ts") || String(Date.now()));
        // Clear any stale API key so it never gets sent alongside the cookie
        apiKey = "";
        sessionStorage.removeItem("agentid_key");
        localStorage.removeItem("agentid_key");
        localStorage.removeItem("agentid_persisted_key");
        _markFreshLogin();
        sessionOk = true;
      } else if (previouslyLoggedIn) {
        _showSessionExpiredBanner("Your session has expired");
      }
    } catch (_) { /* network failure */ }

    if (sessionOk) {
      // loadDashboard errors must NOT show the login screen — the user IS
      // authenticated. But we must not leave spinners hanging forever either.
      try {
        await loadDashboard();
        scheduleSessionExpiry();
      } catch (e) {
        console.warn("loadDashboard error (session auth):", e);
        // Replace any lingering spinners with a visible error + retry button
        document.querySelectorAll('.loading').forEach(el => {
          el.innerHTML = '<span style="color:var(--muted);font-size:0.82rem;">Failed to load — <button onclick="location.reload()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.82rem;font-family:inherit;padding:0;">retry</button></span>';
        });
        // Show a yellow warning banner — NOT the red "session dropped" banner.
        // A dashboard load failure is often a transient network/cold-start issue,
        // not a real auth problem. Using "session dropped" misleads the user into
        // thinking they need to re-login when a simple refresh would fix it.
        const _existing = document.getElementById("load-warn-banner");
        if (!_existing) {
          const _b = document.createElement("div");
          _b.id = "load-warn-banner";
          _b.style.cssText = [
            "position:fixed;top:0;left:0;right:0;",
            "background:#fef3c7;color:#92400e;",
            "padding:0.75rem 1.4rem;font-size:0.87rem;",
            "border-bottom:1px solid #fde68a;z-index:10000;",
            "display:flex;align-items:center;gap:0.85rem;justify-content:center;",
            "box-shadow:0 2px 6px rgba(0,0,0,0.05);",
          ].join("");
          _b.innerHTML = [
            "<strong>⚠ Dashboard could not fully load.</strong>",
            `<span style="opacity:0.85;">${e?.message || "Network error"} — try refreshing.</span>`,
            '<button onclick="location.reload()" style="background:#92400e;color:white;border:none;',
            'border-radius:5px;padding:0.4rem 0.9rem;font-size:0.82rem;cursor:pointer;font-weight:600;">',
            "Reload</button>",
            '<button id="lwb-dismiss" style="background:none;border:none;cursor:pointer;',
            'color:#92400e;opacity:0.6;font-size:1rem;">✕</button>',
          ].join("");
          document.body.appendChild(_b);
          document.getElementById("lwb-dismiss")?.addEventListener("click", () => _b.remove());
        }
      }
      return;
    }

    // No valid session found — show login screen
    document.getElementById("login-screen").style.display = "flex";
  })();
});


const _NAV_SECTIONS = ['home','overview','agents','analytics','network','audit','signing','playground','approvals','runs','handoffs','policy','budget','delegation','credentials'];

function _scrollToSection(nav) {
  const main = document.getElementById('dash-main');
  const el   = document.getElementById('section-' + nav);
  if (!el || !main) return;
  // offsetTop is stable even when async content changes heights above this
  // element, unlike getBoundingClientRect which shifts during loading.
  main.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
}

function _initSidebar() {
  // Click handlers
  document.querySelectorAll('.dsb-item[data-nav]').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      _scrollToSection(item.dataset.nav);
      _setSidebarActive(item.dataset.nav);
    });
  });
  // Scroll spy
  const main = document.getElementById('dash-main');
  if (main) main.addEventListener('scroll', _sidebarScrollSpy, { passive: true });
  // Populate footer with user info
  _sidebarUpdateUser();

  // Restore section from URL hash on refresh (e.g. #section-analytics)
  // Fallback: sessionStorage["agentid_last_nav"] written by _setSidebarActive.
  // Settings hash (#settings/...) is handled separately — skip it here.
  const sectionM = location.hash.match(/^#section-([a-z0-9-]+)$/);
  const savedNav = sessionStorage.getItem('agentid_last_nav');
  const nav = (sectionM && _NAV_SECTIONS.includes(sectionM[1]))
    ? sectionM[1]
    : (savedNav && _NAV_SECTIONS.includes(savedNav)) ? savedNav : 'home';

  if (nav) {
    // Highlight immediately so there's no flash of the wrong active item
    _setSidebarActive(nav);
    // Delay scroll until the page has rendered all section heights.
    // Two-step: 300ms positions the scroll, 900ms re-confirms in case
    // async content (charts, tables) shifted sections after first scroll.
    setTimeout(() => {
      _scrollToSection(nav);
      setTimeout(() => _scrollToSection(nav), 600);
    }, 300);
  }
}

function _setSidebarActive(nav) {
  document.querySelectorAll('.dsb-item[data-nav]').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === nav);
  });
  // Keep URL hash in sync so a page refresh lands on the same section.
  // Don't overwrite #settings/... while the settings modal is open.
  if (!location.hash.startsWith('#settings')) {
    history.replaceState(null, '', '#section-' + nav);
  }
  // Also mirror to sessionStorage as a belt-and-suspenders backup for
  // cases where location.hash gets clobbered before _initSidebar reads it.
  sessionStorage.setItem('agentid_last_nav', nav);
}

function _sidebarScrollSpy() {
  const main = document.getElementById('dash-main');
  if (!main) return;
  const scrollTop = main.scrollTop + 100;
  let current = 'home';
  for (const s of _NAV_SECTIONS) {
    const el = document.getElementById('section-' + s);
    if (el && el.offsetTop <= scrollTop) current = s;
  }
  _setSidebarActive(current);
}

function _sidebarUpdateUser() {
  const footer = document.getElementById('dsb-footer-user');
  if (!footer) return;
  const email = sessionStorage.getItem('agentid_owner') ||
                sessionStorage.getItem('agentid_email') || '';
  const tier  = (typeof CURRENT_TIER !== 'undefined' && CURRENT_TIER) ? CURRENT_TIER : '';

  // Avatar initials
  const initials = email ? email.slice(0, 2).toUpperCase() : '?';

  // Tier chip color
  const tierChipStyle = tier === 'enterprise'
    ? 'background:linear-gradient(135deg,#fef3c7,#fde68a);color:#92400e;'
    : tier === 'pro'
    ? 'background:var(--accent-light);color:var(--accent);border:1px solid var(--accent-border);'
    : 'background:var(--surface2);color:var(--muted);border:1px solid var(--border);';

  footer.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.65rem;">
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#f97316);color:#fff;
                  display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;flex-shrink:0;
                  box-shadow:0 2px 6px rgba(194,65,12,0.25);">${esc(initials)}</div>
      <div style="flex:1;min-width:0;">
        ${email ? `<div style="font-size:0.75rem;font-weight:600;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(email)}">${esc(email)}</div>` : ''}
        ${tier ? `<div style="margin-top:0.2rem;">
          <span style="font-size:0.62rem;font-weight:700;padding:0.12rem 0.5rem;border-radius:999px;text-transform:capitalize;${tierChipStyle}">${esc(tier)}</span>
        </div>` : ''}
      </div>
    </div>`;
}

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

// ═══════════════════════════════════════════════════════════════════════════
// ENTERPRISE FOOTPRINT TAB
// ═══════════════════════════════════════════════════════════════════════════

const _fp = {
  page: 1,
  limit: 50,
  hasMore: false,
  total: 0,
};

const _FP_CAT_COLORS = {
  auth: "#6366f1", agent: "#10b981", verify: "#3b82f6", sign: "#8b5cf6",
  message: "#06b6d4", task: "#f59e0b", contract: "#ec4899", invocation: "#14b8a6",
  complaint: "#ef4444", attestation: "#84cc16", webhook: "#f97316",
  trust: "#eab308", mcp: "#a855f7", violation: "#dc2626", export: "#64748b",
};

function _fpCatBadge(cat) {
  const col = _FP_CAT_COLORS[cat] || "#64748b";
  return `<span style="background:${col}22;color:${col};border:1px solid ${col}44;font-size:0.68rem;padding:0.1rem 0.35rem;border-radius:4px;font-weight:600;">${esc(cat)}</span>`;
}

function _fpStatusBadge(status) {
  if (!status) return "—";
  const isOk = ["ok","active","verified","challenge_passed","succeeded"].includes((status||"").toLowerCase());
  const isErr = ["error","failed","violation","rejected","open","breach"].includes((status||"").toLowerCase());
  const col = isOk ? "#10b981" : isErr ? "#ef4444" : "#64748b";
  return `<span style="color:${col};font-weight:600;">${esc(status)}</span>`;
}

function _fpDetailSummary(detail) {
  if (!detail || typeof detail !== "object") return "—";
  const keys = Object.keys(detail).filter(k => detail[k] != null);
  if (!keys.length) return "—";
  return keys.slice(0, 3).map(k => `<span style="color:var(--muted);">${esc(k)}:</span> ${esc(String(detail[k]).slice(0,40))}`).join("  ");
}

async function _fpLoadSummary() {
  try {
    const d = await apiFetch("/pro/account/footprint/summary");
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("fp-total-events",   d.total_audit_events?.toLocaleString() ?? "—");
    set("fp-active-sessions", d.active_sessions ?? "—");
    set("fp-total-requests", d.total_api_requests?.toLocaleString() ?? "—");
    set("fp-wh-rate",        d.webhook_success_rate_7d != null ? d.webhook_success_rate_7d + "%" : "n/a");
    set("fp-open-complaints", d.open_complaints ?? "0");
    set("fp-violations",     d.scope_violations_30d ?? "0");
  } catch(_) { /* silently ignore — pro endpoint, may not be authed */ }
}

async function _fpLoad() {
  const body = document.getElementById("fp-timeline-body");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="7" style="padding:1rem;text-align:center;"><div class="spinner" style="margin:auto;"></div></td></tr>`;

  const cat    = document.getElementById("fp-cat-filter")?.value || "";
  const did    = document.getElementById("fp-did-filter")?.value.trim() || "";
  const fromD  = document.getElementById("fp-from-filter")?.value || "";
  const toD    = document.getElementById("fp-to-filter")?.value || "";

  const params = new URLSearchParams({ page: _fp.page, limit: _fp.limit });
  if (cat)   params.set("category", cat);
  if (did)   params.set("did", did);
  if (fromD) params.set("from_ts", fromD + "T00:00:00Z");
  if (toD)   params.set("to_ts",   toD   + "T23:59:59Z");

  try {
    const d = await apiFetch("/pro/account/footprint?" + params);
    _fp.total   = d.total;
    _fp.hasMore = d.has_more;

    const events = d.events || [];
    if (!events.length) {
      body.innerHTML = `<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--muted);">No events found for these filters.</td></tr>`;
    } else {
      body.innerHTML = events.map(e => `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:0.35rem 0.6rem;white-space:nowrap;font-size:0.72rem;color:var(--muted);">${e.ts ? new Date(e.ts).toLocaleString() : "—"}</td>
          <td style="padding:0.35rem 0.5rem;">${_fpCatBadge(e.category)}</td>
          <td style="padding:0.35rem 0.5rem;font-size:0.74rem;font-family:monospace;">${esc(e.operation||"—")}</td>
          <td style="padding:0.35rem 0.5rem;font-size:0.7rem;font-family:monospace;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(e.did||"")}">${e.did ? esc(e.did.slice(0,28)+"…") : "—"}</td>
          <td style="padding:0.35rem 0.5rem;font-size:0.74rem;">${_fpStatusBadge(e.status)}</td>
          <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--muted);">${e.ip ? esc(e.ip) : "—"}</td>
          <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--text-2);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_fpDetailSummary(e.detail)}</td>
        </tr>
      `).join("");
    }

    const label = document.getElementById("fp-count-label");
    if (label) label.textContent = `${_fp.total.toLocaleString()} total · page ${_fp.page}`;

    const prev = document.getElementById("fp-prev-btn");
    const next = document.getElementById("fp-next-btn");
    if (prev) prev.disabled = _fp.page <= 1;
    if (next) next.disabled = !_fp.hasMore;
  } catch(err) {
    body.innerHTML = `<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--red);">Error loading footprint: ${esc(String(err))}</td></tr>`;
  }
}

let _fpTabInited = false;
function _initFootprintTab() {
  // Guard: attach click listeners only once (tab can be opened multiple times)
  if (!_fpTabInited) {
    _fpTabInited = true;

    const loadBtn = document.getElementById("fp-load-btn");
    const prevBtn = document.getElementById("fp-prev-btn");
    const nextBtn = document.getElementById("fp-next-btn");
    if (loadBtn) loadBtn.addEventListener("click", () => { _fp.page = 1; _fpLoad(); });
    if (prevBtn) prevBtn.addEventListener("click", () => { if (_fp.page > 1) { _fp.page--; _fpLoad(); } });
    if (nextBtn) nextBtn.addEventListener("click", () => { if (_fp.hasMore) { _fp.page++; _fpLoad(); } });

    document.getElementById("fp-export-json-btn")?.addEventListener("click", () => {
      window.open(BASE + "/pro/account/export?fmt=json&" + _fpExportParams(), "_blank");
    });
    document.getElementById("fp-export-csv-btn")?.addEventListener("click", () => {
      window.open(BASE + "/pro/account/export?fmt=csv&" + _fpExportParams(), "_blank");
    });

    // Webhook log fail-filter toggle
    document.querySelectorAll(".fp-wh-filter-btn").forEach(btn => {
      btn.addEventListener("click", function() {
        document.querySelectorAll(".fp-wh-filter-btn").forEach(b => b.classList.remove("active"));
        this.classList.add("active");
        _fpLoadWebhookLog(this.dataset.fail === "1");
      });
    });
  }

  // Always refresh summary cards and supplemental sections on tab open
  _fpLoadSummary();
  _fpLoadSessions();
  _fpLoadKeyUsage();
  _fpLoadWebhookLog(false);
}

// ── Footprint: Session History ────────────────────────────────────────────────
async function _fpLoadSessions() {
  const body = document.getElementById("fp-sessions-body");
  const countEl = document.getElementById("fp-session-count");
  if (!body) return;
  try {
    const d = await apiFetch("/pro/account/sessions?limit=50");
    const sessions = d.sessions || [];
    if (countEl) countEl.textContent = `${d.total ?? sessions.length} total`;
    if (!sessions.length) {
      body.innerHTML = `<tr><td colspan="5" style="padding:0.75rem;text-align:center;color:var(--muted);">No sessions found.</td></tr>`;
      return;
    }
    body.innerHTML = sessions.map(s => {
      const active = s.active;
      const ua = s.user_agent || "—";
      // trim UA to readable browser/OS hint
      const uaShort = ua.length > 60 ? ua.slice(0, 57) + "…" : ua;
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:0.35rem 0.6rem;white-space:nowrap;font-size:0.72rem;color:var(--muted);">${s.created_at ? new Date(s.created_at).toLocaleString() : "—"}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.74rem;font-family:monospace;">${esc(s.ip || "—")}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--text-2);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(ua)}">${esc(uaShort)}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--muted);">${s.expires_at ? new Date(s.expires_at).toLocaleDateString() : "—"}</td>
        <td style="padding:0.35rem 0.5rem;">
          ${active
            ? `<span style="color:#10b981;font-weight:600;font-size:0.72rem;">● Active</span>`
            : `<span style="color:var(--muted);font-size:0.72rem;">Expired</span>`}
        </td>
      </tr>`;
    }).join("");
  } catch(e) {
    body.innerHTML = `<tr><td colspan="5" style="padding:0.75rem;text-align:center;color:var(--red);">Could not load sessions.</td></tr>`;
  }
}

// ── Footprint: API Key Usage ──────────────────────────────────────────────────
async function _fpLoadKeyUsage() {
  const grid = document.getElementById("fp-keys-grid");
  if (!grid) return;
  try {
    const d = await apiFetch("/pro/account/keys/usage");
    const keys = d.keys || [];
    if (!keys.length) {
      grid.innerHTML = `<div style="color:var(--muted);font-size:0.77rem;">No API keys found.</div>`;
      return;
    }
    grid.innerHTML = keys.map(k => {
      const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never";
      const created  = k.created_at  ? new Date(k.created_at).toLocaleDateString() : "—";
      const reqCount = (k.request_count ?? 0).toLocaleString();
      const scopeStr = k.scopes ? k.scopes : "full access";
      return `
        <div style="display:flex;align-items:center;gap:0.75rem;padding:0.55rem 0.75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface2);">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.2rem;">
              <span style="font-size:0.82rem;font-weight:600;">${esc(k.label || "Unnamed")}</span>
              ${k.permanent ? `<span style="font-size:0.65rem;padding:0.1rem 0.4rem;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);border-radius:4px;font-weight:600;">OWNER</span>` : ""}
              <span style="font-size:0.65rem;padding:0.1rem 0.4rem;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);">${esc(k.tier||"free")}</span>
            </div>
            <div style="font-size:0.71rem;color:var(--muted);">Scopes: ${esc(scopeStr)} · Created ${created}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:0.88rem;font-weight:700;">${reqCount}</div>
            <div style="font-size:0.68rem;color:var(--muted);">requests</div>
          </div>
          <div style="text-align:right;flex-shrink:0;min-width:130px;">
            <div style="font-size:0.73rem;color:var(--muted);">Last used</div>
            <div style="font-size:0.74rem;">${esc(lastUsed)}</div>
          </div>
        </div>`;
    }).join("");
  } catch(e) {
    grid.innerHTML = `<div style="color:var(--red);font-size:0.77rem;">Could not load key usage.</div>`;
  }
}

// ── Footprint: Webhook Delivery Log ───────────────────────────────────────────
async function _fpLoadWebhookLog(failOnly = false) {
  const body = document.getElementById("fp-webhook-body");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="6" style="padding:0.75rem;text-align:center;"><div class="spinner" style="margin:auto;"></div></td></tr>`;
  try {
    const params = new URLSearchParams({ limit: 50 });
    if (failOnly) params.set("fail_only", "true");
    const d = await apiFetch("/pro/account/webhook-log?" + params);
    const deliveries = d.deliveries || [];
    if (!deliveries.length) {
      body.innerHTML = `<tr><td colspan="6" style="padding:0.75rem;text-align:center;color:var(--muted);">${failOnly ? "No failures found." : "No webhook deliveries yet."}</td></tr>`;
      return;
    }
    body.innerHTML = deliveries.map(w => {
      const ok = w.success;
      const statusColor = ok ? "#10b981" : "#ef4444";
      const statusText  = ok ? "✓ Success" : "✗ Failed";
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:0.35rem 0.6rem;white-space:nowrap;font-size:0.72rem;color:var(--muted);">${w.attempted_at ? new Date(w.attempted_at).toLocaleString() : "—"}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.74rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(w.webhook_url||"")}">${esc((w.webhook_url||"—").replace(/^https?:\/\//,"").slice(0,30))}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.73rem;font-family:monospace;">${esc(w.event_type || "—")}</td>
        <td style="padding:0.35rem 0.5rem;font-weight:600;font-size:0.73rem;color:${statusColor};">${statusText}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.73rem;color:var(--muted);">${w.status_code ?? "—"}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--red);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(w.error||"")}">${esc(w.error ? String(w.error).slice(0,60) : "—")}</td>
      </tr>`;
    }).join("");
  } catch(e) {
    body.innerHTML = `<tr><td colspan="6" style="padding:0.75rem;text-align:center;color:var(--red);">Could not load webhook log.</td></tr>`;
  }
}

function _fpExportParams() {
  const fromD = document.getElementById("fp-from-filter")?.value || "";
  const toD   = document.getElementById("fp-to-filter")?.value || "";
  const p = new URLSearchParams();
  if (fromD) p.set("from_ts", fromD + "T00:00:00Z");
  if (toD)   p.set("to_ts",   toD   + "T23:59:59Z");
  return p.toString();
}

// Load session history into Account tab
async function _loadSessionHistory() {
  const list = document.getElementById("session-history-list");
  if (!list) return;
  try {
    const d = await apiFetch("/pro/account/sessions?limit=10");
    const sessions = d.sessions || [];
    if (!sessions.length) {
      list.innerHTML = '<div style="color:var(--muted);">No sessions recorded.</div>';
      return;
    }
    list.innerHTML = sessions.map(s => {
      const active = s.active;
      const dot = active
        ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;margin-right:5px;"></span>`
        : `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--muted);margin-right:5px;"></span>`;
      const ua = (s.user_agent||"").slice(0, 60);
      return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0.5rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;">
        ${dot}
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.76rem;font-weight:500;">${esc(s.ip||"unknown ip")}${active?" <em style='color:#10b981;font-style:normal;'>(active)</em>":""}</div>
          <div style="font-size:0.68rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(ua)}</div>
        </div>
        <div style="font-size:0.68rem;color:var(--muted);white-space:nowrap;">${s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}</div>
      </div>`;
    }).join("");
  } catch(_) { list.innerHTML = '<div style="color:var(--muted);font-size:0.77rem;">Sign in with session auth to view session history.</div>'; }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTERPRISE SETTINGS TAB
// ═══════════════════════════════════════════════════════════════════════════

async function _loadEnterpriseSettings() {
  try {
    const d = await apiFetch("/pro/account/settings");

    const slider = (id, val) => {
      const el = document.getElementById(id);
      if (el) { el.value = val; el.dispatchEvent(new Event("input")); }
    };
    const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const sel   = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    slider("ent-trust-min",   d.trust_alert_min  ?? 0.6);
    slider("ent-trust-drop",  d.trust_drop_threshold ?? 10);
    slider("ent-retention",   d.data_retention_days  ?? 365);
    check("ent-notify-complaint",  d.notify_on_complaint);
    check("ent-notify-trust-drop", d.notify_on_trust_drop);
    check("ent-notify-violation",  d.notify_on_violation);
    check("ent-mfa-required",      d.mfa_required);
    sel("ent-default-visibility",  d.default_visibility || "public");
    sel("ent-export-format",       d.export_format || "json");
  } catch(_) { /* not enterprise — panel locked */ }
}

async function _loadKeyUsage() {
  const list = document.getElementById("ent-key-usage-list");
  if (!list) return;
  try {
    const d = await apiFetch("/pro/account/keys/usage");
    const keys = d.keys || [];
    if (!keys.length) { list.innerHTML = '<div style="color:var(--muted);">No API keys.</div>'; return; }
    list.innerHTML = keys.map(k => `
      <div style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0.5rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.78rem;font-weight:600;">${esc(k.label)}</div>
          <div style="font-size:0.7rem;color:var(--muted);">
            ${(k.scopes||[]).join(", ")||"no scopes"} ·
            ${k.tier} tier ·
            ${k.request_count?.toLocaleString()||"0"} requests
          </div>
        </div>
        <div style="font-size:0.7rem;color:var(--muted);white-space:nowrap;">
          Last: ${k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "never"}
        </div>
      </div>
    `).join("");
  } catch(_) { list.innerHTML = '<div style="color:var(--muted);">Could not load key usage.</div>'; }
}

async function _saveEnterpriseSettings() {
  const status = document.getElementById("ent-save-status");
  const btn    = document.getElementById("ent-save-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  if (status) status.textContent = "";

  try {
    const body = {
      trust_alert_min:      parseFloat(document.getElementById("ent-trust-min")?.value),
      trust_drop_threshold: parseFloat(document.getElementById("ent-trust-drop")?.value),
      data_retention_days:  parseInt(document.getElementById("ent-retention")?.value),
      notify_on_complaint:  document.getElementById("ent-notify-complaint")?.checked,
      notify_on_trust_drop: document.getElementById("ent-notify-trust-drop")?.checked,
      notify_on_violation:  document.getElementById("ent-notify-violation")?.checked,
      mfa_required:         document.getElementById("ent-mfa-required")?.checked,
      default_visibility:   document.getElementById("ent-default-visibility")?.value,
      export_format:        document.getElementById("ent-export-format")?.value,
    };
    await apiFetch("/pro/account/settings", { method: "PATCH", body: JSON.stringify(body) });
    if (status) { status.style.color = "var(--green)"; status.textContent = "✓ Saved"; }
    toast("Enterprise settings saved", "ok");
  } catch(err) {
    if (status) { status.style.color = "var(--red)"; status.textContent = "Error: " + String(err).slice(0, 60); }
    toast("Save failed: " + String(err), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save enterprise settings"; }
  }
}

function _initEnterpriseTab() {
  // Live-update slider labels
  document.getElementById("ent-trust-min")?.addEventListener("input", e => {
    const el = document.getElementById("ent-trust-min-val");
    if (el) el.textContent = parseFloat(e.target.value).toFixed(2);
  });
  document.getElementById("ent-trust-drop")?.addEventListener("input", e => {
    const el = document.getElementById("ent-trust-drop-val");
    if (el) el.textContent = e.target.value + " pts";
  });
  document.getElementById("ent-retention")?.addEventListener("input", e => {
    const el = document.getElementById("ent-retention-val");
    if (el) {
      const days = parseInt(e.target.value);
      el.textContent = days >= 365 ? Math.round(days/365*10)/10 + " yr" : days + " days";
    }
  });
  document.getElementById("ent-save-btn")?.addEventListener("click", _saveEnterpriseSettings);
}

// Hook into the existing tab-switch event so data loads when tabs activate
(function _patchTabSwitch() {
  const orig = typeof _switchSettingsTab === "function" ? _switchSettingsTab : null;
  if (!orig) return;
  window._switchSettingsTab = function(tab) {
    orig(tab);
    if (tab === "footprint") {
      _fpLoadSummary();
      // don't auto-load events — wait for the Load button
    }
    if (tab === "eu-compliance") {
      _euLoadAll();
    }
    if (tab === "enterprise-settings") {
      _loadEnterpriseSettings();
      _loadKeyUsage();
    }
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// EU AI ACT COMPLIANCE TAB
// ═══════════════════════════════════════════════════════════════════════════

const _euRiskColors = {
  minimal_risk: "#10b981",
  limited_risk: "#f59e0b",
  high_risk:    "#ef4444",
  unclassified: "var(--muted)",
};
const _euRiskLabel = {
  minimal_risk: "Minimal",
  limited_risk: "Limited",
  high_risk:    "High",
};

function _initEuComplianceTab() {
  // Toggle compliance mode
  document.getElementById("eu-compliance-toggle")?.addEventListener("change", async function() {
    try {
      await apiFetch("/pro/compliance/eu-ai-act", {
        method: "POST",
        body: JSON.stringify({ enabled: this.checked }),
      });
      _euLoadSummary();
    } catch(e) {
      alert("Could not update compliance mode: " + e.message);
      this.checked = !this.checked;
    }
  });

  // Review queue filter buttons
  document.querySelectorAll(".eu-rq-filter").forEach(btn => {
    btn.addEventListener("click", function() {
      document.querySelectorAll(".eu-rq-filter").forEach(b => b.classList.remove("active"));
      this.classList.add("active");
      _euLoadReviewQueue(this.dataset.status);
    });
  });

  // Report download buttons — must use apiFetch / raw fetch with auth headers
  // (window.open can't send x-api-key, so downloads fail with 401)
  document.getElementById("eu-report-json-btn")?.addEventListener("click", async function() {
    const days = document.getElementById("eu-report-days")?.value || "30";
    this.disabled = true; this.textContent = "Downloading…";
    try {
      const data = await apiFetch(`/pro/compliance/eu-ai-act/report?days=${days}&format=json`);
      const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {href: url, download: `eu-compliance-${days}d.json`});
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) { alert("JSON download failed: " + e.message); }
    this.disabled = false; this.textContent = "↓ JSON report";
  });

  document.getElementById("eu-report-pdf-btn")?.addEventListener("click", async function() {
    const days = document.getElementById("eu-report-days")?.value || "30";
    this.disabled = true; this.textContent = "Generating PDF…";
    try {
      const storedKey = apiKey || sessionStorage.getItem("agentid_key")
                     || localStorage.getItem("agentid_persisted_key")
                     || localStorage.getItem("agentid_key");
      const resp = await fetch(BASE + `/pro/compliance/eu-ai-act/report?days=${days}&format=pdf`, {
        credentials: "include",
        headers: storedKey ? {"x-api-key": storedKey} : {},
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error(t); }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {href: url, download: `eu-compliance-${days}d.pdf`});
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) { alert("PDF download failed: " + e.message); }
    this.disabled = false; this.textContent = "↓ PDF report";
  });

  document.getElementById("eu-monthly-export-btn")?.addEventListener("click", async function() {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    this.disabled = true; this.textContent = "Downloading…";
    try {
      const data = await apiFetch(`/pro/compliance/monthly-export?month=${month}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {href: url, download: `eu-monthly-${month}.json`});
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) { alert("Monthly export failed: " + e.message); }
    this.disabled = false; this.textContent = "↓ Monthly export";
  });
}

async function _euLoadAll() {
  await _euLoadSummary();
  _euLoadReviewQueue("pending");
  _euLoadPublishedContracts();
}

async function _euLoadSummary() {
  try {
    const d = await apiFetch("/pro/compliance/eu-ai-act");

    // Update compliance mode toggle
    const toggle = document.getElementById("eu-compliance-toggle");
    if (toggle) toggle.checked = !!d.enabled;
    const track = document.querySelector("[data-pref='eu-compliance-mode']");
    if (track) track.classList.toggle("on", !!d.enabled);

    // Status badge
    const badge = document.getElementById("eu-compliance-status-badge");
    if (badge) {
      if (!d.enabled) {
        badge.textContent = "⚪ Disabled";
        badge.style.background = "var(--surface2)";
        badge.style.color = "var(--muted)";
        badge.style.borderColor = "var(--border)";
      } else if (d.compliance_ready) {
        badge.textContent = "✅ Compliant";
        badge.style.background = "color-mix(in srgb,#10b981 12%,transparent)";
        badge.style.color = "#10b981";
        badge.style.borderColor = "#10b981";
      } else {
        badge.textContent = "⚠ Action required";
        badge.style.background = "color-mix(in srgb,#f59e0b 12%,transparent)";
        badge.style.color = "#f59e0b";
        badge.style.borderColor = "#f59e0b";
      }
    }

    // Tier stats
    const ts = d.tier_summary || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? "0"; };
    set("eu-stat-unclassified", ts.unclassified ?? "0");
    set("eu-stat-minimal",      ts.minimal_risk ?? "0");
    set("eu-stat-limited",      ts.limited_risk ?? "0");
    set("eu-stat-high",         ts.high_risk ?? "0");
    set("eu-stat-reviews",      d.pending_reviews ?? "0");

    // Agent table
    const tbody = document.getElementById("eu-agents-body");
    if (tbody) {
      const agents = d.agents || [];
      if (!agents.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:1rem;text-align:center;color:var(--muted);">No agents found. Register an agent first.</td></tr>`;
      } else {
        tbody.innerHTML = agents.map(a => {
          const tier = a.risk_tier || "unclassified";
          const color = _euRiskColors[tier] || "var(--muted)";
          const label = _euRiskLabel[tier] || "Unclassified";
          const readyIcon = a.ready ? `<span style="color:#10b981;">✓ Ready</span>` : `<span style="color:#ef4444;">⚠ Needs action</span>`;
          const contractIcon = a.has_contract ? `<span style="color:#10b981;">✓</span>` : `<span style="color:var(--muted);">—</span>`;
          const shortDid = a.did ? a.did.slice(0, 28) + "…" : "—";
          return `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:0.35rem 0.6rem;font-size:0.78rem;font-weight:500;">${esc(a.name || "Unnamed")}</td>
            <td style="padding:0.35rem 0.5rem;font-size:0.7rem;font-family:monospace;color:var(--muted);" title="${esc(a.did||"")}">${esc(shortDid)}</td>
            <td style="padding:0.35rem 0.5rem;">
              <select class="eu-tier-select" data-did="${esc(a.did||"")}" style="font-size:0.73rem;padding:0.2rem 0.4rem;border:1px solid ${color};border-radius:5px;background:var(--surface2);color:${color};font-weight:600;">
                <option value="" ${!a.risk_tier ? "selected" : ""}>Unclassified</option>
                <option value="minimal_risk" ${tier==="minimal_risk"?"selected":""}>Minimal risk</option>
                <option value="limited_risk" ${tier==="limited_risk"?"selected":""}>Limited risk</option>
                <option value="high_risk"    ${tier==="high_risk"?"selected":""}>High risk</option>
              </select>
            </td>
            <td style="padding:0.35rem 0.5rem;text-align:center;">${contractIcon}</td>
            <td style="padding:0.35rem 0.5rem;font-size:0.73rem;">${readyIcon}</td>
            <td style="padding:0.35rem 0.5rem;">
              <button class="btn-sm eu-tier-save" data-did="${esc(a.did||"")}" style="font-size:0.7rem;padding:0.15rem 0.5rem;">Save</button>
            </td>
          </tr>`;
        }).join("");

        // Wire up save buttons
        tbody.querySelectorAll(".eu-tier-save").forEach(btn => {
          btn.addEventListener("click", async function() {
            const did = this.dataset.did;
            const row = this.closest("tr");
            const sel = row?.querySelector(".eu-tier-select");
            const tier = sel?.value || "";
            if (!did || !tier) return;
            this.disabled = true;
            this.textContent = "…";
            try {
              await apiFetch(`/pro/agents/${encodeURIComponent(did)}/risk-tier`, {
                method: "POST",
                body: JSON.stringify({ risk_tier: tier }),
              });
              this.textContent = "✓";
              setTimeout(() => { this.textContent = "Save"; this.disabled = false; }, 1500);
              _euLoadSummary();
            } catch(e) {
              this.textContent = "Error";
              this.disabled = false;
            }
          });
        });
      }
    }
  } catch(e) {
    const badge = document.getElementById("eu-compliance-status-badge");
    if (badge) { badge.textContent = "Not available"; badge.style.color = "var(--muted)"; }
  }
}

async function _euLoadReviewQueue(status = "pending") {
  const tbody = document.getElementById("eu-review-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="padding:0.75rem;text-align:center;"><div class="spinner" style="margin:auto;"></div></td></tr>`;
  try {
    const d = await apiFetch(`/pro/compliance/eu-ai-act/review-queue?status=${status}&limit=25`);

    // Update filter tab count badges
    const counts = d.counts || {};
    const total  = Object.values(counts).reduce((s, n) => s + n, 0);
    const setCount = (id, n) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (n > 0) { el.textContent = n; el.style.display = ""; }
      else        { el.style.display = "none"; }
    };
    setCount("eu-rq-cnt-pending",  counts.pending  || 0);
    setCount("eu-rq-cnt-approved", counts.approved || 0);
    setCount("eu-rq-cnt-rejected", counts.rejected || 0);
    setCount("eu-rq-cnt-all", total);

    const items = d.items || [];
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--muted);">No ${status === "all" ? "" : status + " "}review items.</td></tr>`;
      return;
    }

    const schemaStr = obj => { const k = Object.keys(obj||{}); return k.length ? k.join(", ") : "—"; };

    const rows = [];
    items.forEach(item => {
      const statusColor = {pending:"#f59e0b",approved:"#10b981",rejected:"#ef4444",expired:"var(--muted)"}[item.status] || "var(--muted)";
      const isPending = item.status === "pending";
      const agentLabel = esc(item.agent_name || (item.agent_did||"").slice(0,20));

      // Parse payload_summary
      let payload = null;
      let payloadRaw = item.payload_summary || "";
      try { payload = JSON.parse(payloadRaw || "null"); } catch(_) {}
      const hasPayload = (payload && typeof payload === "object") || payloadRaw.trim().length > 0;

      // Main row
      rows.push(`<tr class="eu-rq-row" data-id="${item.id}" style="border-bottom:1px solid var(--border);cursor:${hasPayload ? "pointer" : "default"};">
        <td style="padding:0.35rem 0.6rem;font-size:0.72rem;color:var(--muted);">
          ${hasPayload ? `<span class="eu-rq-toggle" style="margin-right:0.3rem;font-size:0.65rem;color:var(--accent);">▶</span>` : ""}#${item.id}
        </td>
        <td style="padding:0.35rem 0.5rem;font-size:0.74rem;font-weight:500;">${agentLabel}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.73rem;font-family:monospace;">${esc(item.operation||"—")}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.72rem;color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(item.reason||"")}">${esc((item.reason||"—").slice(0,60))}</td>
        <td style="padding:0.35rem 0.5rem;font-weight:600;font-size:0.73rem;color:${statusColor};">${esc(item.status)}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--muted);white-space:nowrap;">${item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</td>
        <td style="padding:0.35rem 0.5rem;">
          ${isPending ? `
            <div style="display:flex;gap:0.3rem;">
              <button class="btn-sm eu-approve-btn" data-id="${item.id}" style="font-size:0.7rem;padding:0.15rem 0.45rem;background:#10b981;color:#fff;border-color:#10b981;" title="Approve">✓</button>
              <button class="btn-sm eu-reject-btn"  data-id="${item.id}" style="font-size:0.7rem;padding:0.15rem 0.45rem;color:var(--red);border-color:var(--red);" title="Reject — will ask for reason">✗</button>
            </div>`
          : item.reviewed_by ? `<span style="font-size:0.68rem;color:var(--muted);" title="Reviewed by ${esc(item.reviewed_by)} at ${item.reviewed_at ? new Date(item.reviewed_at).toLocaleString() : ''}">${esc(item.reviewed_by.split("@")[0])}</span>`
          : "—"}
        </td>
      </tr>`);

      // Expandable detail row
      if (hasPayload) {
        let contractDetail = "";
        if (payload && typeof payload === "object") {
          const p = payload;
          contractDetail = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem 1.5rem;font-size:0.76rem;">
              <div>
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Capability</div>
                <div style="font-weight:600;font-family:monospace;">${esc(p.capability||"—")}</div>
              </div>
              <div>
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Version · Challenge mode</div>
                <div>${esc(p.version||"1.0")} · <span style="color:var(--accent);">${esc(p.challenge_mode||"liveness")}</span></div>
              </div>
              <div style="grid-column:1/-1;">
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Description</div>
                <div style="line-height:1.5;color:var(--text-2);">${esc(p.description||"—")}</div>
              </div>
              <div>
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">SLA</div>
                <div style="font-family:monospace;font-size:0.72rem;">${esc(JSON.stringify(p.sla||{}))}</div>
              </div>
              <div>
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Pricing</div>
                <div style="font-family:monospace;font-size:0.72rem;">${esc(JSON.stringify(p.pricing||{}))}</div>
              </div>
              <div>
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Input schema fields</div>
                <div style="font-size:0.72rem;">${esc(schemaStr((p.input_schema||{}).properties))}</div>
              </div>
              <div>
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Output schema fields</div>
                <div style="font-size:0.72rem;">${esc(schemaStr((p.output_schema||{}).properties))}</div>
              </div>
              ${(p.example_inputs||[]).length ? `<div style="grid-column:1/-1;">
                <div style="font-size:0.7rem;color:var(--muted);margin-bottom:0.2rem;">Example inputs</div>
                <pre style="font-size:0.7rem;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:0.4rem 0.6rem;overflow-x:auto;margin:0;">${esc(JSON.stringify(p.example_inputs, null, 2))}</pre>
              </div>` : ""}
            </div>`;
        } else {
          contractDetail = `<pre style="font-size:0.73rem;white-space:pre-wrap;word-break:break-word;margin:0;color:var(--text-2);">${esc(payloadRaw)}</pre>`;
        }

        // Reviewer info block (shown for resolved items)
        const reviewerBlock = !isPending && item.reviewed_by ? `
          <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem 1rem;font-size:0.75rem;">
            <div>
              <div style="font-size:0.68rem;color:var(--muted);margin-bottom:0.1rem;">Verdict</div>
              <div style="font-weight:600;color:${item.verdict==="approved"?"#10b981":"#ef4444"};">${esc(item.verdict||"—")}</div>
            </div>
            <div>
              <div style="font-size:0.68rem;color:var(--muted);margin-bottom:0.1rem;">Reviewed by</div>
              <div style="font-family:monospace;font-size:0.72rem;">${esc(item.reviewed_by||"—")}</div>
            </div>
            <div>
              <div style="font-size:0.68rem;color:var(--muted);margin-bottom:0.1rem;">Reviewed at</div>
              <div style="font-size:0.72rem;">${item.reviewed_at ? new Date(item.reviewed_at).toLocaleString() : "—"}</div>
            </div>
            ${item.notes ? `<div style="grid-column:1/-1;">
              <div style="font-size:0.68rem;color:var(--muted);margin-bottom:0.1rem;">Rejection reason</div>
              <div style="color:var(--red);font-size:0.73rem;">${esc(item.notes)}</div>
            </div>` : ""}
          </div>` : "";

        rows.push(`<tr class="eu-rq-detail" data-for="${item.id}" style="display:none;background:color-mix(in srgb,var(--accent) 4%,var(--surface));">
          <td colspan="7" style="padding:0.75rem 1rem 1rem;">${contractDetail}${reviewerBlock}</td>
        </tr>`);
      }
    });
    tbody.innerHTML = rows.join("");

    // Wire expand/collapse on clickable rows
    tbody.querySelectorAll(".eu-rq-row[data-id]").forEach(row => {
      row.addEventListener("click", function(e) {
        if (e.target.closest(".eu-approve-btn,.eu-reject-btn")) return;
        const id = this.dataset.id;
        const detail = tbody.querySelector(`.eu-rq-detail[data-for="${id}"]`);
        if (!detail) return;
        const toggle = this.querySelector(".eu-rq-toggle");
        const isOpen = detail.style.display !== "none";
        detail.style.display = isOpen ? "none" : "table-row";
        if (toggle) toggle.textContent = isOpen ? "▶" : "▼";
      });
    });

    // Wire approve buttons
    tbody.querySelectorAll(".eu-approve-btn").forEach(btn => {
      btn.addEventListener("click", async function(e) {
        e.stopPropagation();
        const id = this.dataset.id;
        this.disabled = true; this.textContent = "…";
        try {
          await apiFetch(`/pro/compliance/eu-ai-act/review/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ verdict: "approved", notes: "" }),
          });
          _euLoadReviewQueue(document.querySelector(".eu-rq-filter.active")?.dataset.status || "pending");
          _euLoadSummary();
          _euLoadPublishedContracts();
        } catch(err) {
          this.disabled = false; this.textContent = "✓";
          alert("Could not approve: " + err.message);
        }
      });
    });

    // Wire reject buttons — show inline reason form
    tbody.querySelectorAll(".eu-reject-btn").forEach(btn => {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        _euShowRejectModal(this.dataset.id);
      });
    });

  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:0.75rem;text-align:center;color:var(--red);">Could not load review queue.</td></tr>`;
  }
}

/** Show rejection reason modal overlay */
function _euShowRejectModal(reviewId) {
  // Remove any existing modal
  document.getElementById("eu-reject-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "eu-reject-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;";
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.5rem;width:min(420px,90vw);box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <div style="font-size:0.9rem;font-weight:700;margin-bottom:0.3rem;">Reject Review #${esc(reviewId)}</div>
      <div style="font-size:0.77rem;color:var(--muted);margin-bottom:1rem;">Please provide a reason for rejection. This will be recorded and shown to the requester.</div>
      <textarea id="eu-reject-reason" placeholder="Enter rejection reason…" style="width:100%;min-height:90px;resize:vertical;font-size:0.82rem;padding:0.6rem 0.75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface2);color:var(--text);box-sizing:border-box;"></textarea>
      <div id="eu-reject-err" style="font-size:0.75rem;color:var(--red);min-height:1.2rem;margin-top:0.25rem;"></div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem;">
        <button id="eu-reject-cancel" class="btn btn-outline" style="font-size:0.8rem;">Cancel</button>
        <button id="eu-reject-confirm" class="btn" style="font-size:0.8rem;background:#ef4444;border-color:#ef4444;color:#fff;">Confirm rejection</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.getElementById("eu-reject-cancel").addEventListener("click", close);

  document.getElementById("eu-reject-confirm").addEventListener("click", async function() {
    const reason = document.getElementById("eu-reject-reason").value.trim();
    const errEl  = document.getElementById("eu-reject-err");
    if (!reason) { errEl.textContent = "A reason is required before rejecting."; return; }
    this.disabled = true; this.textContent = "Rejecting…";
    try {
      await apiFetch(`/pro/compliance/eu-ai-act/review/${reviewId}`, {
        method: "PATCH",
        body: JSON.stringify({ verdict: "rejected", notes: reason }),
      });
      close();
      _euLoadReviewQueue(document.querySelector(".eu-rq-filter.active")?.dataset.status || "pending");
      _euLoadSummary();
      _euLoadPublishedContracts();
    } catch(err) {
      this.disabled = false; this.textContent = "Confirm rejection";
      errEl.textContent = "Error: " + err.message;
    }
  });
}

/** Load published capability contracts table */
async function _euLoadPublishedContracts() {
  const tbody = document.getElementById("eu-contracts-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="padding:0.6rem;text-align:center;"><div class="spinner" style="margin:auto;width:16px;height:16px;"></div></td></tr>`;
  try {
    const d = await apiFetch("/pro/compliance/eu-ai-act/published-contracts");
    const contracts = d.contracts || [];
    if (!contracts.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--muted);">No capability contracts published yet.</td></tr>`;
      return;
    }
    const contractStatusColor = {
      challenge_passed:      "#10b981",
      pending_verification:  "#f59e0b",
      verified:              "#6366f1",
      pending_review:        "#f59e0b",
      inactive:              "var(--muted)",
    };
    const reviewColor = { approved:"#10b981", rejected:"#ef4444", pending:"#f59e0b" };
    tbody.innerHTML = contracts.map(c => {
      const csc = contractStatusColor[c.status] || "var(--muted)";
      const rsc = reviewColor[c.review_status] || "var(--muted)";
      const reviewedBy = c.reviewed_by ? esc(c.reviewed_by) : "—";
      const reviewBadge = c.review_status
        ? `<span style="font-size:0.68rem;font-weight:600;color:${rsc};">${esc(c.verdict || c.review_status)}</span>`
        : `<span style="color:var(--muted);font-size:0.72rem;">none</span>`;
      const notesTip = c.notes ? ` title="${esc(c.notes)}"` : "";
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:0.35rem 0.6rem;font-size:0.75rem;font-weight:500;">${esc(c.agent_name||"—")}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.73rem;font-family:monospace;">${esc(c.capability||"—")}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.72rem;color:var(--muted);">${esc(c.version||"1.0")}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.72rem;font-weight:600;color:${csc};">${esc(c.status||"—").replace(/_/g," ")}</td>
        <td style="padding:0.35rem 0.5rem;"${notesTip}>${reviewBadge}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.72rem;color:var(--muted);font-family:monospace;" title="${reviewedBy}">${c.reviewed_by ? esc(c.reviewed_by.split("@")[0]) : "—"}</td>
        <td style="padding:0.35rem 0.5rem;font-size:0.7rem;color:var(--muted);white-space:nowrap;">${c.created_at ? new Date(c.created_at).toLocaleString() : "—"}</td>
      </tr>`;
    }).join("");
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:0.6rem;text-align:center;color:var(--red);">Could not load contracts.</td></tr>`;
  }
}

// Init on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  _initFootprintTab();
  _initEnterpriseTab();
  _initEuComplianceTab();
  _initApprovalsSection();
  _initAcpTabs();
  _initAcpPolicyModal();
  _initOversightButtons();
});

// ── ACP APPROVALS ─────────────────────────────────────────────────────────────
function _initApprovalsSection() {
  const refreshBtn = document.getElementById("approvals-refresh-btn");
  const statusFilter = document.getElementById("approvals-status-filter");
  if (refreshBtn)    refreshBtn.addEventListener("click", _loadApprovals);
  if (statusFilter)  statusFilter.addEventListener("change", _loadApprovals);
  // Do NOT call _loadApprovals() here — DOMContentLoaded fires before auth.
  // loadDashboard() calls it once the API key is confirmed valid.
}

async function _loadApprovals() {
  const listEl = document.getElementById("approvals-list");
  const countEl = document.getElementById("approvals-count-label");
  const badgeEl = document.getElementById("approvals-badge");
  if (!listEl) return;

  const status = document.getElementById("approvals-status-filter")?.value || "pending";
  listEl.innerHTML = `<div style="text-align:center;color:var(--muted);padding:2rem 0;font-size:0.85rem;">Loading…</div>`;

  try {
    const params = new URLSearchParams({ limit: 50 });
    if (status) params.set("status", status);

    // Fetch ACP queue and human-review queue in parallel
    const [acpRes, rqRes] = await Promise.all([
      apiFetch(`/pro/acp/queue?${params}`).catch(() => null),
      apiFetch(`/pro/review-queue?${params}`).catch(() => null),
    ]);

    const acpItems = acpRes
      ? (acpRes.items || acpRes.approvals || (Array.isArray(acpRes) ? acpRes : []))
          .map(i => ({ ...i, _source: "acp" }))
      : [];

    const rqItems = rqRes
      ? (rqRes.items || (Array.isArray(rqRes) ? rqRes : []))
          .map(i => ({
            ...i,
            _source: "review-queue",
            // normalise fields to match ACP shape
            action_category: i.operation || i.reason || "human_review",
            action_payload:  i.payload_summary || "",
            reviewer_note:   i.notes || "",
            resolved_at:     i.reviewed_at || null,
          }))
      : [];

    const items = [...acpItems, ...rqItems]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    if (countEl) countEl.textContent = `${items.length} item${items.length !== 1 ? "s" : ""}`;

    // Update sidebar badge for pending
    if (badgeEl && status === "pending") {
      if (items.length > 0) {
        badgeEl.textContent = items.length > 99 ? "99+" : String(items.length);
        badgeEl.style.display = "inline-block";
      } else {
        badgeEl.style.display = "none";
      }
    }

    if (!items.length) {
      const msg = status === "pending"
        ? "No pending approvals. Your agents are running within policy."
        : `No ${status} approvals found.`;
      listEl.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2.5rem 1rem;gap:0.5rem;">
        <div style="font-size:2rem;">✅</div>
        <div style="font-weight:600;font-size:0.9rem;">No pending approvals</div>
        <div style="font-size:0.8rem;color:var(--muted);">Your agents are running within policy.</div>
      </div>`;
      return;
    }

    listEl.innerHTML = items.map(item => {
      const ts = item.created_at ? new Date(item.created_at).toLocaleString() : "—";
      const resolvedAt = item.resolved_at ? new Date(item.resolved_at).toLocaleString() : null;
      const statusColor = item.status === "approved" ? "var(--green)" : (item.status === "rejected" || item.status === "denied") ? "var(--red)" : item.status === "expired" ? "var(--muted)" : "var(--yellow)";
      const statusLabel = item.status === "approved" ? "✓ Approved" : (item.status === "rejected" || item.status === "denied") ? "✗ Rejected" : item.status === "expired" ? "✕ Expired" : "⏳ Pending";
      const category = item.action_category || "—";
      const sourceTag = item._source === "review-queue"
        ? `<span style="font-size:0.66rem;font-weight:600;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(59,130,246,0.15);color:#60a5fa;">EU AI Act</span>`
        : "";
      let payloadPreview = "";
      try {
        const p = typeof item.action_payload === "string" ? JSON.parse(item.action_payload) : item.action_payload;
        payloadPreview = p ? JSON.stringify(p, null, 2) : String(item.action_payload || "");
      } catch(_) {
        payloadPreview = String(item.action_payload || "");
      }

      const agentShort = (item.agent_did || "").slice(-20);
      const isPending = item.status === "pending";
      const src = esc(item._source || "acp");

      return `<div style="border-bottom:1px solid var(--border);padding:1rem 1.25rem;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.35rem;flex-wrap:wrap;">
              <span style="font-size:0.82rem;font-weight:700;color:var(--text);">${esc(category)}</span>
              ${sourceTag}
              <span style="font-size:0.72rem;font-weight:700;color:${statusColor};">${esc(statusLabel)}</span>
              <span style="font-size:0.72rem;color:var(--muted);font-family:'JetBrains Mono',monospace;">…${esc(agentShort)}</span>
            </div>
            ${payloadPreview ? `<details style="margin-bottom:0.4rem;">
              <summary style="font-size:0.76rem;color:var(--accent);cursor:pointer;user-select:none;">View payload</summary>
              <pre style="margin-top:0.35rem;font-size:0.72rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:0.5rem 0.65rem;overflow:auto;max-height:160px;white-space:pre-wrap;word-break:break-word;color:var(--text-2);">${esc(payloadPreview)}</pre>
            </details>` : ""}
            ${item.reviewer_note ? `<div style="font-size:0.78rem;color:var(--text-2);margin-bottom:0.2rem;"><b>Note:</b> ${esc(item.reviewer_note)}</div>` : ""}
            <div style="font-size:0.71rem;color:var(--muted);">Requested ${esc(ts)}${resolvedAt ? ` · Resolved ${esc(resolvedAt)}` : ""}</div>
          </div>
          ${isPending ? `
          <div style="display:flex;flex-direction:column;gap:0.35rem;flex-shrink:0;min-width:120px;">
            <textarea id="note-${esc(item.id)}" rows="2" placeholder="Optional reviewer note…" style="width:100%;padding:0.35rem 0.55rem;border:1px solid var(--border-dark);border-radius:6px;font-size:0.76rem;font-family:inherit;background:var(--surface);color:var(--text);outline:none;resize:none;box-sizing:border-box;"></textarea>
            <button data-approve data-id="${esc(item.id)}" data-src="${src}" style="padding:0.3rem 0.7rem;border-radius:6px;border:1px solid var(--green);background:var(--green-bg);color:var(--green);font-size:0.76rem;font-weight:600;cursor:pointer;font-family:inherit;">✓ Approve</button>
            <button data-deny data-id="${esc(item.id)}" data-src="${src}" style="padding:0.3rem 0.7rem;border-radius:6px;border:1px solid var(--red);background:var(--red-bg);color:var(--red);font-size:0.76rem;font-weight:600;cursor:pointer;font-family:inherit;">✗ Deny</button>
          </div>` : ""}
        </div>
      </div>`;
    }).join("");

    // Delegated listener — CSP blocks inline onclick attributes in dynamically built HTML
    listEl.addEventListener("click", _approvalsListClick, { once: true });
  } catch(e) {
    listEl.innerHTML = `<div style="text-align:center;color:var(--red);padding:2rem 1rem;font-size:0.85rem;">${esc(String(e))}</div>`;
  }
}

function _approvalsListClick(e) {
  const approveBtn = e.target.closest("[data-approve]");
  const denyBtn    = e.target.closest("[data-deny]");
  if (approveBtn) {
    _approveAction(approveBtn.dataset.id, approveBtn.dataset.src);
  } else if (denyBtn) {
    _denyAction(denyBtn.dataset.id, denyBtn.dataset.src);
  } else {
    const listEl = document.getElementById("approvals-list");
    if (listEl) listEl.addEventListener("click", _approvalsListClick, { once: true });
  }
}

async function _approveAction(id, source) {
  const note = document.getElementById(`note-${id}`)?.value?.trim() || "";
  try {
    if (source === "review-queue") {
      await apiFetch(`/pro/review-queue/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ verdict: "approved", notes: note }),
      });
    } else {
      await apiFetch(`/pro/approvals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewer_note: note }),
      });
    }
    _loadApprovals();
    loadHome().catch(() => {});
  } catch(e) { alert("Error approving: " + e.message); }
}

async function _denyAction(id, source) {
  const note = document.getElementById(`note-${id}`)?.value?.trim() || "";
  try {
    if (source === "review-queue") {
      await apiFetch(`/pro/review-queue/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ verdict: "rejected", notes: note }),
      });
    } else {
      await apiFetch(`/pro/approvals/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewer_note: note }),
      });
    }
    _loadApprovals();
    loadHome().catch(() => {});
  } catch(e) { alert("Error denying: " + e.message); }
}

// ── ACP TABS ──────────────────────────────────────────────────────────────────

function _initAcpTabs() {
  document.querySelectorAll(".acp-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      // Style tabs
      document.querySelectorAll(".acp-tab").forEach(t => {
        const active = t.dataset.tab === tab;
        t.style.color       = active ? "var(--accent)" : "var(--muted)";
        t.style.fontWeight  = active ? "600" : "500";
        t.style.borderBottom= active ? "2px solid var(--accent)" : "2px solid transparent";
        t.classList.toggle("acp-tab-active", active);
      });
      // Show/hide panels
      document.getElementById("acp-panel-queue").style.display    = tab === "queue"    ? "" : "none";
      document.getElementById("acp-panel-policies").style.display = tab === "policies" ? "" : "none";
      if (tab === "policies") _loadAcpPolicies();
    });
  });
}

// ── ACP POLICIES ──────────────────────────────────────────────────────────────

const _CATEGORY_LABELS = {
  message_broadcast: "Message Broadcast",
  high_value_task:   "High Value Task",
  contract_publish:  "Contract Publish",
  external_call:     "External Call",
  file_upload:       "File Upload",
  capability_invoke: "Capability Invoke",
};

const _OP_LABELS = { always: "always", gt: "> ", gte: "≥ ", eq: "= " };

async function _loadAcpPolicies() {
  const listEl  = document.getElementById("acp-policies-list");
  const countEl = document.getElementById("acp-policies-count");
  if (!listEl) return;
  listEl.innerHTML = `<div style="text-align:center;color:var(--muted);padding:2rem 0;font-size:0.85rem;">Loading…</div>`;

  try {
    // Fetch all agents, then load policies for each
    const agents = _allAgents || [];
    if (!agents.length) {
      listEl.innerHTML = `<div style="text-align:center;color:var(--muted);padding:2rem 0;font-size:0.85rem;">No agents registered yet.</div>`;
      return;
    }

    // Load policies per agent in parallel
    const results = await Promise.all(
      agents.map(async a => {
        try {
          const d = await apiFetch(`/pro/agents/${encodeURIComponent(a.did)}/acp-policies`);
          return (d.policies || []).map(p => ({ ...p, agent_name: a.name, agent_did: a.did }));
        } catch(_) { return []; }
      })
    );
    const all = results.flat();

    if (countEl) countEl.textContent = `${all.length} polic${all.length !== 1 ? "ies" : "y"} across ${agents.length} agent${agents.length !== 1 ? "s" : ""}`;

    if (!all.length) {
      listEl.innerHTML = `<div style="text-align:center;color:var(--muted);padding:2rem 1rem;font-size:0.85rem;">
        No policies yet. Click <b>+ Add Policy</b> to define when an agent should pause and wait for your approval.
      </div>`;
      return;
    }

    listEl.innerHTML = all.map(p => {
      const catLabel  = _CATEGORY_LABELS[p.action_category] || p.action_category;
      const opLabel   = _OP_LABELS[p.threshold_op] || p.threshold_op;
      const threshold = p.threshold_op === "always"
        ? ""
        : ` when <code style="font-size:0.75rem;background:var(--surface2);padding:0.1rem 0.3rem;border-radius:3px;">${esc(p.threshold_field)}</code> ${opLabel}${p.threshold_value ?? ""}`;
      const isActive  = !!p.is_active;
      const statusCol = isActive ? "var(--green)" : "var(--muted)";
      // Use data-* attributes instead of inline onclick — CSP blocks inline handlers
      return `<div style="border-bottom:1px solid var(--border);padding:0.75rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.2rem;flex-wrap:wrap;">
            <span style="font-size:0.82rem;font-weight:700;color:var(--text);">${esc(catLabel)}</span>
            <span style="font-size:0.72rem;color:${statusCol};font-weight:600;">${isActive ? "● Active" : "○ Paused"}</span>
          </div>
          <div style="font-size:0.78rem;color:var(--text-2);">
            <b>${esc(p.agent_name)}</b>${threshold ? ` — triggers${threshold}` : " — triggers on every action"}
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;flex-shrink:0;">
          <button data-acp-toggle data-did="${esc(p.agent_did)}" data-pid="${esc(p.id)}" data-active="${!isActive}"
            style="font-size:0.75rem;padding:0.2rem 0.6rem;border-radius:5px;cursor:pointer;border:1px solid var(--border-dark);background:var(--surface2);color:var(--text-2);font-family:inherit;">
            ${isActive ? "Pause" : "Enable"}
          </button>
          <button data-acp-delete data-did="${esc(p.agent_did)}" data-pid="${esc(p.id)}"
            style="font-size:0.75rem;padding:0.2rem 0.6rem;border-radius:5px;cursor:pointer;border:1px solid var(--red,#dc2626);background:var(--red-bg,#fef2f2);color:var(--red,#dc2626);font-family:inherit;">
            Delete
          </button>
        </div>
      </div>`;
    }).join("");

    // Event delegation — CSP blocks inline onclick, so we attach one listener to the container
    listEl.addEventListener("click", _acpPolicyListClick, { once: true });

  } catch(e) {
    listEl.innerHTML = `<div style="text-align:center;color:var(--red);padding:2rem 1rem;font-size:0.85rem;">${esc(String(e))}</div>`;
  }
}

function _acpPolicyListClick(e) {
  const toggleBtn = e.target.closest("[data-acp-toggle]");
  const deleteBtn = e.target.closest("[data-acp-delete]");
  if (toggleBtn) {
    const did    = toggleBtn.dataset.did;
    const pid    = toggleBtn.dataset.pid;
    const active = toggleBtn.dataset.active === "true";
    _toggleAcpPolicy(did, pid, active);
  } else if (deleteBtn) {
    const did = deleteBtn.dataset.did;
    const pid = deleteBtn.dataset.pid;
    _deleteAcpPolicy(did, pid);
  } else {
    // Click was not on a button — re-attach listener for next interaction
    const listEl = document.getElementById("acp-policies-list");
    if (listEl) listEl.addEventListener("click", _acpPolicyListClick, { once: true });
  }
}

async function _toggleAcpPolicy(did, pid, isActive) {
  try {
    await apiFetch(`/pro/agents/${encodeURIComponent(did)}/acp-policies/${encodeURIComponent(pid)}?is_active=${isActive}`, { method: "PATCH" });
    _loadAcpPolicies();
  } catch(e) { alert("Error updating policy: " + e.message); }
}

async function _deleteAcpPolicy(did, pid) {
  if (!confirm("Delete this policy? Actions of this type will no longer be held for approval.")) return;
  try {
    await apiFetch(`/pro/agents/${encodeURIComponent(did)}/acp-policies/${encodeURIComponent(pid)}`, { method: "DELETE" });
    _loadAcpPolicies();
  } catch(e) { alert("Error deleting policy: " + e.message); }
}

function _initAcpPolicyModal() {
  const modal    = document.getElementById("modal-acp-policy");
  const opSel    = document.getElementById("acp-policy-op");
  const threshRow= document.getElementById("acp-threshold-row");
  const agentSel = document.getElementById("acp-policy-agent");

  document.getElementById("acp-add-policy-btn")?.addEventListener("click", () => {
    // Populate agent dropdown from cached list
    const agents = _allAgents || [];
    agentSel.innerHTML = `<option value="">— select an agent —</option>` +
      agents.map(a => `<option value="${esc(a.did)}">${esc(a.name)}</option>`).join("");
    document.getElementById("acp-policy-err").style.display = "none";
    // Reset op to "always" so threshold row is hidden by default
    opSel.value = "always";
    threshRow.style.display = "none";
    document.getElementById("acp-policy-value").value = "";
    _updateAcpThresholdHint();
    modal.style.display = "flex";
  });

  const closeModal = () => { modal.style.display = "none"; };
  document.getElementById("acp-policy-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("acp-policy-cancel")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", e => { if (e.target === modal) closeModal(); });

  // Per-category defaults: [threshold_field, label, hint, placeholder]
  const _ACP_CAT_HINTS = {
    message_broadcast: ["recipient_count", "Number of recipients",
      "Pause when the agent tries to send to more than N recipients at once. Example: set 10 to require approval for any broadcast to 11+ people.",
      "e.g. 10"],
    high_value_task:   ["cost_usd", "Cost threshold (USD)",
      "Pause when the estimated task cost exceeds this amount in US dollars. Example: set 50 to approve anything above $50.",
      "e.g. 50"],
    contract_publish:  ["count", "Number of contracts",
      "Pause when the agent tries to publish this many or more capability contracts. Set 1 to approve every publish.",
      "e.g. 1"],
    external_call:     ["count", "Number of calls",
      "Pause when the agent makes this many external HTTP calls in a single flow. Set 1 to approve every outbound request.",
      "e.g. 1"],
    file_upload:       ["size_mb", "File size (MB)",
      "Pause when the uploaded file exceeds this size in megabytes. Example: set 10 to approve files larger than 10 MB.",
      "e.g. 10"],
    capability_invoke: ["count", "Number of invocations",
      "Pause when the agent invokes another agent's capability this many times in one flow. Set 1 to approve every invocation.",
      "e.g. 1"],
  };

  function _updateAcpThresholdHint() {
    const cat = document.getElementById("acp-policy-category")?.value;
    const info = _ACP_CAT_HINTS[cat] || ["value", "Threshold", "Enter the numeric threshold that triggers the approval gate.", "e.g. 1"];
    document.getElementById("acp-policy-field").value = info[0];
    const lbl = document.getElementById("acp-threshold-label");
    if (lbl) lbl.textContent = info[1];
    const hint = document.getElementById("acp-threshold-hint");
    if (hint) hint.textContent = info[2];
    const val = document.getElementById("acp-policy-value");
    if (val) val.placeholder = info[3];
  }

  document.getElementById("acp-policy-category")?.addEventListener("change", _updateAcpThresholdHint);

  // Show/hide threshold row based on op
  opSel?.addEventListener("change", () => {
    const show = opSel.value !== "always";
    threshRow.style.display = show ? "block" : "none";
    if (show) _updateAcpThresholdHint();
  });

  document.getElementById("acp-policy-save")?.addEventListener("click", async () => {
    const errEl    = document.getElementById("acp-policy-err");
    const savBtn   = document.getElementById("acp-policy-save");
    const did      = document.getElementById("acp-policy-agent")?.value;
    const category = document.getElementById("acp-policy-category")?.value;
    const op       = document.getElementById("acp-policy-op")?.value;
    const field    = document.getElementById("acp-policy-field")?.value?.trim() || "value";
    const valRaw   = document.getElementById("acp-policy-value")?.value?.trim();

    errEl.style.display = "none";
    if (!did)      { errEl.textContent = "Please select an agent."; errEl.style.display = ""; return; }
    if (!category) { errEl.textContent = "Please select an action category."; errEl.style.display = ""; return; }
    if (op !== "always" && !valRaw) {
      errEl.textContent = "Please enter a threshold value."; errEl.style.display = ""; return;
    }

    const body = { action_category: category, threshold_op: op, threshold_field: field };
    if (op !== "always") body.threshold_value = parseFloat(valRaw);

    savBtn.disabled = true;
    savBtn.textContent = "Saving…";
    try {
      await apiFetch(`/pro/agents/${encodeURIComponent(did)}/acp-policies`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      closeModal();
      // Switch to policies tab and reload
      document.querySelector(".acp-tab[data-tab='policies']")?.click();
    } catch(e) {
      errEl.textContent = e.message || "Failed to create policy.";
      errEl.style.display = "";
    } finally {
      savBtn.disabled = false;
      savBtn.textContent = "Create Policy";
    }
  });
}

// ── HUMAN OVERSIGHT TOGGLE ────────────────────────────────────────────────────

const _OVERSIGHT_CYCLE = ["none", "advisory", "required", "always"];
const _OVERSIGHT_LABELS = {
  none:     "🤖 auto — fully autonomous",
  advisory: "👁 advisory — notified but proceeds",
  required: "⏸ required — pauses on policy match",
  always:   "🔐 always — every action reviewed",
};

async function _setOversightLevel(did, level) {
  try {
    await apiFetch(`/pro/agents/${encodeURIComponent(did)}/oversight?level=${encodeURIComponent(level)}`, { method: "PATCH" });
    // Update cached agent data
    const ag = (_allAgents || []).find(a => a.did === did);
    if (ag) ag.human_oversight = level;
    _renderAgPage();
  } catch(e) { alert("Error updating oversight: " + e.message); }
}

function _initOversightButtons() {
  // Delegated click handler for oversight buttons
  document.getElementById("agents-table")?.addEventListener("click", e => {
    const btn = e.target.closest(".oversight-toggle");
    if (!btn) return;
    const did   = btn.dataset.did;
    const cur   = btn.dataset.level || "none";
    const idx   = _OVERSIGHT_CYCLE.indexOf(cur);
    const next  = _OVERSIGHT_CYCLE[(idx + 1) % _OVERSIGHT_CYCLE.length];
    // Show picker dropdown
    _showOversightPicker(btn, did, cur);
  });
}

function _showOversightPicker(anchor, did, current) {
  // Remove any existing picker
  document.getElementById("oversight-picker")?.remove();

  const rect   = anchor.getBoundingClientRect();
  const picker = document.createElement("div");
  picker.id    = "oversight-picker";
  // Use CSS variables so the popup inherits the active theme automatically
  picker.style.cssText = [
    "position:fixed",
    "z-index:9999",
    "background:var(--surface)",
    "border:1px solid var(--border-dark)",
    "border-radius:10px",
    "box-shadow:0 4px 24px rgba(0,0,0,0.22)",
    "padding:0.35rem 0",
    "min-width:240px",
    `top:${rect.bottom + 4}px`,
    `left:${Math.min(rect.left, window.innerWidth - 250)}px`,
  ].join(";");

  picker.innerHTML = _OVERSIGHT_CYCLE.map(level => {
    const isCur = level === current;
    return `<div data-level="${esc(level)}"
      style="padding:0.5rem 0.9rem;font-size:0.82rem;cursor:pointer;
             color:${isCur ? "var(--accent)" : "var(--text)"};
             font-weight:${isCur ? "700" : "400"};
             display:flex;align-items:center;gap:0.5rem;
             border-radius:6px;margin:0 0.25rem;
             transition:background 0.1s;">
      <span style="width:1rem;flex-shrink:0;color:var(--accent);">${isCur ? "✓" : ""}</span>
      ${esc(_OVERSIGHT_LABELS[level])}
    </div>`;
  }).join("");

  // Hover highlight using JS (works in both themes)
  picker.querySelectorAll("[data-level]").forEach(row => {
    row.addEventListener("mouseenter", () => { row.style.background = "var(--surface2)"; });
    row.addEventListener("mouseleave", () => { row.style.background = ""; });
  });

  picker.addEventListener("click", async e => {
    const row = e.target.closest("[data-level]");
    if (!row) return;
    const level = row.dataset.level;
    picker.remove();
    if (level !== current) await _setOversightLevel(did, level);
  });

  document.body.appendChild(picker);
  // Close on outside click
  const close = e => {
    if (!picker.contains(e.target) && e.target !== anchor) {
      picker.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true), 10);
}

// ── SUB-ACCOUNTS / TEAM MEMBERS ───────────────────────────────────────────────

// Load sub-accounts whenever the "sub-accounts" tab is opened
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest('.modal-tab[data-tab="sub-accounts"]')) {
      _loadSubAccounts();
    }
  });
});

const _ROLE_PERMISSIONS = {
  Owner:     { agents: "all", features: ["tasks","messages","contracts","approvals","analytics","bootstrap","missions","trust_scores","audit","keys"] },
  Admin:     { agents: "all", features: ["tasks","messages","contracts","approvals","analytics","trust_scores","audit","keys"] },
  Developer: { agents: "all", features: ["tasks","messages","contracts","trust_scores"] },
  Auditor:   { agents: "all", features: ["analytics","trust_scores","audit"] },
  Viewer:    { agents: "all", features: ["analytics","trust_scores"] },
};

function _roleFromPermissions(perms) {
  const feats = (perms.features || []).slice().sort().join(",");
  for (const [role, def] of Object.entries(_ROLE_PERMISSIONS)) {
    if (def.features.slice().sort().join(",") === feats) return role;
  }
  // Best-effort heuristic
  const f = perms.features || [];
  if (f.includes("audit") && f.includes("keys")) return "Admin";
  if (f.includes("tasks")) return "Developer";
  if (f.includes("audit")) return "Auditor";
  return "Viewer";
}

function _roleChip(role) {
  const cls = { Owner:"role-owner", Admin:"role-admin", Developer:"role-developer", Auditor:"role-auditor", Viewer:"role-viewer" }[role] || "role-viewer";
  return `<span class="member-role-chip ${cls}">${esc(role)}</span>`;
}

async function _loadSubAccounts() {
  const listEl = document.getElementById("sub-accounts-list");
  if (!listEl) return;
  listEl.innerHTML = `<div style="text-align:center;padding:1.5rem 0;color:var(--muted);font-size:0.82rem;"><div class="spinner" style="margin:0 auto 0.5rem;"></div>Loading…</div>`;
  try {
    const data = await apiFetch("/pro/account/members");
    const members = data.members || [];
    if (!members.length) {
      listEl.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--muted);font-size:0.85rem;">No team members yet.<br><span style="font-size:0.78rem;">Click "Invite Member" to get started.</span></div>`;
      return;
    }
    listEl.innerHTML = members.map(m => {
      const initials = (m.email || "?").slice(0,2).toUpperCase();
      const perms = m.permissions || {};
      const role = _roleFromPermissions(perms);
      const lastUsed = m.last_used_at ? timeAgo(m.last_used_at) : "Never";
      const dotColor = m.is_active ? "var(--green)" : "var(--border-dark)";
      return `<div class="member-row" data-mid="${esc(m.id)}">
        <div class="member-avatar">${esc(initials)}</div>
        <div class="member-info">
          <div class="member-email">${esc(m.email)}</div>
          <div class="member-meta">
            <span class="member-status-dot" style="background:${dotColor};"></span>
            ${m.is_active ? "Active" : "Disabled"}
            &middot; Last used: ${esc(lastUsed)}
          </div>
          <div class="member-action-err" style="font-size:0.74rem;color:var(--red);min-height:0;margin-top:0.15rem;"></div>
        </div>
        ${_roleChip(role)}
        <div class="member-actions">
          <button class="btn btn-ghost btn-sm" onclick="_rotateMemberKey('${esc(m.id)}')" title="Rotate API key">↻ Key</button>
          <button class="btn btn-ghost btn-sm" onclick="_toggleMember(this,'${esc(m.id)}',${!m.is_active})">${m.is_active ? "Disable" : "Enable"}</button>
          <button class="btn btn-danger btn-sm" onclick="_confirmRemoveMember(this,'${esc(m.id)}')">Remove</button>
        </div>
      </div>`;
    }).join("");
    // Wire data-mid onto each row so event-delegated handlers can find it
    listEl.querySelectorAll('.member-row').forEach((row, i) => {
      row._memberData = members[i];
    });
  } catch(e) {
    if (listEl) listEl.innerHTML = `<div style="text-align:center;padding:1rem;color:var(--red);font-size:0.82rem;">${esc(String(e))}</div>`;
  }
}

function _openAddMember() {
  document.getElementById("add-member-form").style.display = "block";
  document.getElementById("add-member-msg").textContent = "";
  document.getElementById("new-member-email").value = "";
  document.getElementById("new-member-role").value = "Admin";
  document.getElementById("new-member-key-box").style.display = "none";
}

async function _submitAddMember() {
  const email   = document.getElementById("new-member-email").value.trim();
  const roleVal = document.getElementById("new-member-role").value;
  const msgEl   = document.getElementById("add-member-msg");
  const btn     = document.getElementById("add-member-submit-btn");
  if (!email) { msgEl.textContent = "Email is required."; return; }
  const permissions = _ROLE_PERMISSIONS[roleVal] || _ROLE_PERMISSIONS.Viewer;
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const data = await apiFetch("/pro/account/members", {
      method: "POST",
      body: JSON.stringify({ email, label: roleVal, permissions }),
    });
    document.getElementById("add-member-form").style.display = "none";
    const keyBox = document.getElementById("new-member-key-box");
    document.getElementById("new-member-key-value").textContent = data.api_key || "";
    keyBox.style.display = "block";
    await _loadSubAccounts();
  } catch(e) {
    msgEl.textContent = e.message || "Failed to create sub-account.";
  } finally {
    btn.disabled = false; btn.textContent = "Send Invite";
  }
}

async function _rotateMemberKey(id) {
  const btn = document.querySelector(`.member-row[data-mid="${CSS.escape(id)}"] [title="Rotate API key"]`);
  if (!btn) return;
  const orig = btn.textContent;
  // Inline confirm: first click arms, second click fires
  if (btn.dataset.armed) {
    btn.disabled = true; btn.textContent = "Rotating…";
    try {
      const data = await apiFetch(`/pro/account/members/${encodeURIComponent(id)}/rotate-key`, { method: "POST" });
      const keyBox = document.getElementById("new-member-key-box");
      document.getElementById("new-member-key-value").textContent = data.api_key || "";
      keyBox.style.display = "block";
      keyBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch(e) {
      _showMemberErr(id, "Key rotation failed: " + e.message);
    } finally {
      btn.disabled = false; btn.textContent = orig; delete btn.dataset.armed;
    }
  } else {
    btn.dataset.armed = "1"; btn.textContent = "Confirm?";
    setTimeout(() => { if (btn.dataset.armed) { btn.textContent = orig; delete btn.dataset.armed; } }, 3000);
  }
}

async function _toggleMember(btn, id, setActive) {
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = setActive ? "Enabling…" : "Disabling…";
  _showMemberErr(id, "");
  try {
    await apiFetch(`/pro/account/members/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: setActive }),
    });
    await _loadSubAccounts();
  } catch(e) {
    btn.disabled = false;
    btn.textContent = origText;
    _showMemberErr(id, e.message || "Failed to update");
  }
}

function _confirmRemoveMember(btn, id) {
  const actionsEl = btn.closest('.member-actions');
  _showMemberErr(id, "");
  actionsEl.innerHTML = `
    <span style="font-size:0.75rem;color:var(--red);font-weight:600;white-space:nowrap;">Sure?</span>
    <button class="btn btn-danger btn-sm" id="confirm-remove-yes-${esc(id)}">Yes, Remove</button>
    <button class="btn btn-outline btn-sm" id="confirm-remove-no-${esc(id)}">Cancel</button>
  `;
  document.getElementById(`confirm-remove-yes-${id}`).addEventListener("click", () => _deleteMember(id, actionsEl));
  document.getElementById(`confirm-remove-no-${id}`).addEventListener("click", () => _loadSubAccounts());
}

async function _deleteMember(id, actionsEl) {
  const yesBtn = actionsEl?.querySelector(`#confirm-remove-yes-${id}`);
  if (yesBtn) { yesBtn.disabled = true; yesBtn.textContent = "Removing…"; }
  try {
    await apiFetch(`/pro/account/members/${encodeURIComponent(id)}`, { method: "DELETE" });
    await _loadSubAccounts();
  } catch(e) {
    _showMemberErr(id, e.message || "Remove failed");
    await _loadSubAccounts();
  }
}

function _showMemberErr(id, msg) {
  const row = document.querySelector(`.member-row[data-mid="${CSS.escape(id)}"]`);
  if (!row) return;
  const errEl = row.querySelector('.member-action-err');
  if (errEl) errEl.textContent = msg;
}

// ── PDF Report Modal ─────────────────────────────────────────────────────────

const _REPORT_SECTIONS = [
  { id: "agents",       label: "Agents",         desc: "Registry: DID, name, trust score, capabilities" },
  { id: "trust_scores", label: "Trust Scores",    desc: "Full D1–D5 dimension breakdown per agent" },
  { id: "contracts",    label: "Contracts",       desc: "Published capability contracts per agent" },
  { id: "tasks",        label: "Tasks",           desc: "Recent task request history" },
  { id: "messages",     label: "Messages",        desc: "Recent message activity summary" },
  { id: "approvals",    label: "Approvals",       desc: "ACP approval queue history" },
  { id: "analytics",    label: "Analytics",       desc: "Discovery stats, signing activity, search summary" },
];

async function _openReportModal() {
  const mo = document.getElementById("report-modal");
  if (!mo) return;
  mo.style.display = "flex";
  // reset
  document.getElementById("rpt-select-all").checked = true;
  _REPORT_SECTIONS.forEach(s => {
    const cb = document.getElementById(`rpt-sec-${s.id}`);
    if (cb) cb.checked = true;
  });
  document.getElementById("rpt-agents-all").checked = true;
  document.getElementById("rpt-agent-list").style.display = "none";
  document.getElementById("rpt-title").value = "";
  document.getElementById("rpt-date-start").value = "";
  document.getElementById("rpt-date-end").value = "";
  document.getElementById("rpt-error").textContent = "";
  // populate agent list
  await _loadReportAgentList();
}

function _closeReportModal() {
  const mo = document.getElementById("report-modal");
  if (mo) mo.style.display = "none";
}

// Wire report modal interactions once DOM is ready (same pattern as settings-modal)
document.addEventListener("DOMContentLoaded", () => {
  const mo = document.getElementById("report-modal");
  if (!mo) return;

  // Backdrop click (click on the dim overlay itself, not the card) → close
  mo.addEventListener("click", (e) => {
    if (e.target === mo) _closeReportModal();
  });

  // X and Cancel buttons
  document.getElementById("rpt-close-btn")?.addEventListener("click", _closeReportModal);
  document.getElementById("rpt-cancel-btn")?.addEventListener("click", _closeReportModal);

  // Download button
  document.getElementById("rpt-download-btn")?.addEventListener("click", _submitReportDownload);

  // "Select all sections" checkbox
  document.getElementById("rpt-select-all")?.addEventListener("change", function() {
    _rptToggleAll(this.checked);
  });

  // Agent scope radio buttons — also handled here so inline onchange is a fallback only
  document.getElementById("rpt-agents-all")?.addEventListener("change", () => _rptToggleAgentScope("all"));
  document.getElementById("rpt-agents-specific")?.addEventListener("change", () => _rptToggleAgentScope("specific"));

  // Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mo.style.display !== "none") _closeReportModal();
  });
});

async function _loadReportAgentList() {
  const wrap = document.getElementById("rpt-agent-checkboxes");
  if (!wrap) return;
  wrap.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Loading…</span>';
  try {
    const data = await apiFetch("/agents?mine=true&limit=200");
    const agents = data.agents || data.items || (Array.isArray(data) ? data : []);
    if (!agents.length) {
      wrap.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">No agents registered yet.</span>';
      return;
    }
    wrap.innerHTML = agents.map(a => {
      const did = a.did || "";
      const name = (a.name || did).replace(/</g,"&lt;");
      const safeDid = did.replace(/</g,"&lt;");
      return `<label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;padding:0.2rem 0;">
        <input type="checkbox" class="rpt-agent-cb" value="${safeDid}" checked style="accent-color:var(--accent);">
        <span>${name}</span>
        <span style="font-size:0.7rem;color:var(--muted);font-family:monospace;">${safeDid.slice(0,30)}…</span>
      </label>`;
    }).join("");
  } catch(e) {
    const msg = (e && e.message) ? e.message : "unknown error";
    console.error("[AgentID] _loadReportAgentList failed:", msg);
    wrap.innerHTML = `<span style="color:var(--red);font-size:0.8rem;">Could not load agents: ${msg}</span>`;
  }
}

function _rptToggleAll(checked) {
  _REPORT_SECTIONS.forEach(s => {
    const cb = document.getElementById(`rpt-sec-${s.id}`);
    if (cb) cb.checked = checked;
  });
}

function _rptToggleAgentScope(scope) {
  document.getElementById("rpt-agent-list").style.display = scope === "specific" ? "block" : "none";
}

async function _submitReportDownload() {
  const btn = document.getElementById("rpt-download-btn");
  const errEl = document.getElementById("rpt-error");
  errEl.textContent = "";

  // Collect sections
  const sections = _REPORT_SECTIONS
    .filter(s => document.getElementById(`rpt-sec-${s.id}`)?.checked)
    .map(s => s.id);

  if (!sections.length) {
    errEl.textContent = "Select at least one section to include.";
    return;
  }

  // Collect agents
  let agent_dids = "all";
  if (document.getElementById("rpt-agents-specific")?.checked) {
    const checked = Array.from(document.querySelectorAll(".rpt-agent-cb:checked")).map(cb => cb.value);
    if (!checked.length) {
      errEl.textContent = "Select at least one agent, or choose 'All agents'.";
      return;
    }
    agent_dids = checked;
  }

  // Optional fields
  const title = document.getElementById("rpt-title")?.value.trim() || undefined;
  const start = document.getElementById("rpt-date-start")?.value;
  const end   = document.getElementById("rpt-date-end")?.value;
  const date_range = (start || end) ? { start: start || undefined, end: end || undefined } : undefined;

  btn.disabled = true;
  btn.textContent = "Generating…";

  // 120-second timeout — PDF generation can take a while for large accounts
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    // _fetchAuth handles the full auth chain (API key + session cookie)
    // and always adds credentials: "include" so both auth modes work.
    const res = await _fetchAuth(BASE + "/pro/reports/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections, agent_dids, title, date_range }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 403) throw new Error("PDF reports require a Pro or Enterprise plan.");
    if (!res.ok) {
      let msg = `Server error ${res.status}`;
      try { const j = await res.json(); msg = j.detail || msg; } catch(_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const cd   = res.headers.get("Content-Disposition") || "";
    const match = cd.match(/filename="([^"]+)"/);
    a.download = match ? match[1] : "agentid_report.pdf";
    a.href = url; a.click();
    URL.revokeObjectURL(url);
    _closeReportModal();
  } catch(e) {
    clearTimeout(timeoutId);
    const msg = e.name === "AbortError"
      ? "Request timed out — PDF generation took too long. Try fewer sections."
      : (e.message || "Download failed. Please try again.");
    console.error("[AgentID] PDF download error:", msg);
    errEl.textContent = msg;
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download PDF";
  }
}

// ── TELEGRAM INTEGRATION ──────────────────────────────────────────────────────

const _TG_EVENTS = [
  { key: "agent.registered",       label: "Agent Registered" },
  { key: "agent.deregistered",     label: "Agent Deregistered" },
  { key: "agent.updated",          label: "Agent Updated" },
  { key: "verification.failed",    label: "Verification Failed" },
  { key: "verification.succeeded", label: "Verification Succeeded" },
  { key: "key.created",            label: "Key Created" },
  { key: "key.revoked",            label: "Key Revoked" },
  { key: "anomaly.detected",       label: "Anomaly Detected" },
  { key: "task.created",           label: "Task Created" },
  { key: "task.accepted",          label: "Task Accepted" },
  { key: "task.completed",         label: "Task Completed" },
  { key: "task.failed",            label: "Task Failed" },
  { key: "task.expired",           label: "Task Expired" },
  { key: "task.rejected",          label: "Task Rejected" },
  { key: "approval.pending",       label: "Approval Needed 🔔" },
  { key: "approval.decided",       label: "Review Decision Made 📋" },
];

let _tgInitialized = false;

function _initTelegramSection() {
  // Build event checkboxes once
  if (!_tgInitialized) {
    _tgInitialized = true;
    const grid = document.getElementById("tg-events-grid");
    if (grid && grid.children.length === 0) {
      _TG_EVENTS.forEach(ev => {
        const label = document.createElement("label");
        label.style.cssText = "display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = ev.key;
        cb.id = `tg-ev-${ev.key.replace(/\./g, "-")}`;
        cb.checked = true;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(ev.label));
        grid.appendChild(label);
      });
    }
  }
  _loadTelegramConfig();
}

async function _loadTelegramConfig() {
  const badge = document.getElementById("tg-status-badge");
  const currentDiv = document.getElementById("tg-current-config");
  const setupForm = document.getElementById("tg-setup-form");
  const details = document.getElementById("tg-config-details");

  try {
    const data = await apiFetch("/pro/integrations/telegram");
    if (!data.configured) {
      badge.textContent = "Not configured";
      badge.style.background = "var(--surface2)";
      badge.style.color = "var(--muted)";
      currentDiv.style.display = "none";
      setupForm.style.display = "";
      return;
    }

    // Show current config
    badge.textContent = data.is_active ? "Active" : "Disabled";
    badge.style.background = data.is_active ? "rgba(16,185,129,0.15)" : "var(--surface2)";
    badge.style.color = data.is_active ? "#10b981" : "var(--muted)";

    const evList = (data.enabled_events || []).map(e => {
      const found = _TG_EVENTS.find(t => t.key === e);
      return found ? found.label : e;
    }).join(", ") || "All events";

    details.innerHTML = `
      <div>Bot token: <code>${_esc(data.bot_token)}</code></div>
      <div>Chat ID: <code>${_esc(data.chat_id)}</code></div>
      <div>Events: ${_esc(evList)}</div>
      ${data.last_sent_at ? `<div>Last sent: ${_esc(new Date(data.last_sent_at).toLocaleString())}</div>` : ""}
      ${data.messages_sent ? `<div>Messages sent: ${data.messages_sent}</div>` : ""}
      ${data.last_error ? `<div style="color:var(--red);">Last error: ${_esc(data.last_error.slice(0, 120))}</div>` : ""}
    `;

    const toggleBtn = document.getElementById("tg-toggle-btn");
    if (toggleBtn) toggleBtn.textContent = data.is_active ? "Disable" : "Enable";

    currentDiv.style.display = "";
    setupForm.style.display = "none";

    // Pre-fill form with existing values for editing
    const tokenInput = document.getElementById("tg-token-input");
    const chatIdInput = document.getElementById("tg-chat-id-input");
    if (tokenInput) tokenInput.placeholder = data.bot_token + " (enter new token to update)";
    if (chatIdInput && data.chat_id) chatIdInput.value = data.chat_id;

    // Check the saved events
    const enabled = new Set(data.enabled_events || []);
    document.querySelectorAll("#tg-events-grid input[type='checkbox']").forEach(cb => {
      cb.checked = data.enabled_events.length === 0 || enabled.has(cb.value);
    });

  } catch(e) {
    badge.textContent = "Error";
    badge.style.color = "var(--red)";
    console.warn("[telegram] load config error:", e);
  }
}

async function _saveTelegram() {
  const btn = document.getElementById("tg-save-btn");
  const spinner = document.getElementById("tg-save-spinner");
  const msg = document.getElementById("tg-msg");
  const token = document.getElementById("tg-token-input")?.value?.trim();
  const chatId = document.getElementById("tg-chat-id-input")?.value?.trim();

  if (!token || !chatId) {
    msg.textContent = "Bot token and Chat ID are required.";
    msg.className = "modal-msg error";
    return;
  }

  const enabledEvents = [];
  document.querySelectorAll("#tg-events-grid input[type='checkbox']:checked").forEach(cb => {
    enabledEvents.push(cb.value);
  });

  btn.disabled = true;
  if (spinner) spinner.style.display = "inline-block";
  msg.textContent = "Validating and saving…";
  msg.className = "modal-msg";

  try {
    const data = await apiFetch("/pro/integrations/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_token: token, chat_id: chatId, enabled_events: enabledEvents }),
    });
    msg.textContent = data.message || "Telegram integration saved!";
    msg.className = "modal-msg success";
    document.getElementById("tg-token-input").value = "";
    await _loadTelegramConfig();
    // Show the current config panel, hide form
    document.getElementById("tg-current-config").style.display = "";
    document.getElementById("tg-setup-form").style.display = "none";
  } catch(e) {
    msg.textContent = e.message || "Failed to save Telegram integration.";
    msg.className = "modal-msg error";
  } finally {
    btn.disabled = false;
    if (spinner) spinner.style.display = "none";
  }
}

async function _testTelegram() {
  const btn = document.getElementById("tg-test-btn");
  const msg = document.getElementById("tg-msg");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const data = await apiFetch("/pro/integrations/telegram/test", { method: "POST" });
    msg.textContent = data.message || "Test message sent!";
    msg.className = "modal-msg success";
  } catch(e) {
    msg.textContent = e.message || "Test failed.";
    msg.className = "modal-msg error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Test";
  }
}

async function _toggleTelegram() {
  const btn = document.getElementById("tg-toggle-btn");
  const msg = document.getElementById("tg-msg");
  btn.disabled = true;
  try {
    const data = await apiFetch("/pro/integrations/telegram/toggle", { method: "PATCH" });
    msg.textContent = data.message || "Updated.";
    msg.className = "modal-msg success";
    await _loadTelegramConfig();
  } catch(e) {
    msg.textContent = e.message || "Failed to toggle.";
    msg.className = "modal-msg error";
  } finally {
    btn.disabled = false;
  }
}

async function _deleteTelegram() {
  const msg = document.getElementById("tg-msg");
  if (!confirm("Remove Telegram integration? You won't receive any more notifications.")) return;
  try {
    await apiFetch("/pro/integrations/telegram", { method: "DELETE" });
    msg.textContent = "Telegram integration removed.";
    msg.className = "modal-msg success";
    _tgInitialized = false; // reset so form rebuilds on next open
    await _loadTelegramConfig();
    document.getElementById("tg-current-config").style.display = "none";
    document.getElementById("tg-setup-form").style.display = "";
  } catch(e) {
    msg.textContent = e.message || "Failed to remove.";
    msg.className = "modal-msg error";
  }
}

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── RUNS ─────────────────────────────────────────────────────────────────────

async function loadRuns() {
  const list  = document.getElementById('runs-list');
  const count = document.getElementById('runs-count');
  if (!list) return;
  list.innerHTML = '<div class="loading" style="padding:1rem;"><div class="spinner"></div> Loading…</div>';
  try {
    const data = await apiFetch('/pro/runs?limit=25');
    const runs = data.runs || [];
    if (count) count.textContent = data.total ?? runs.length;
    if (!runs.length) {
      list.innerHTML = '<div style="padding:1.1rem 1.25rem;color:var(--muted);font-size:0.83rem;">No runs yet.</div>';
      return;
    }
    const statusColor = s => s === 'completed' ? 'var(--green)' : s === 'running' ? 'var(--accent)' : s === 'failed' ? 'var(--red)' : 'var(--muted)';
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:0.75rem;">
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Run ID</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Agent</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Capability</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Status</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Started</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;"></th>
      </tr></thead>
      <tbody>${runs.map((r, i) => `
        <tr style="${i % 2 ? 'background:var(--surface2,var(--surface));' : ''}border-bottom:1px solid var(--border);">
          <td style="padding:0.5rem 1rem;font-family:'JetBrains Mono',monospace;font-size:0.73rem;color:var(--muted);">${_esc((r.run_id||r.id||'')?.slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;font-size:0.8rem;">${_esc(r.agent_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;">${_esc(r.capability || '—')}</td>
          <td style="padding:0.5rem 1rem;"><span style="color:${statusColor(r.status)};font-weight:600;">${_esc(r.status || '—')}</span></td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;">${r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
          <td style="padding:0.5rem 1rem;"><button class="btn btn-outline" style="font-size:0.72rem;padding:0.2rem 0.55rem;" onclick="_viewRunEvidence('${_esc(r.run_id||r.id||'')}')">Evidence</button></td>
        </tr>`).join('')}
      </tbody></table>`;
  } catch(e) {
    list.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:0.82rem;">Could not load runs — ${_esc(String(e?.message || e))}</div>`;
  }
}

async function _viewRunEvidence(runId) {
  const modal = document.getElementById('run-evidence-modal');
  const body  = document.getElementById('run-evidence-body');
  if (!modal || !body) return;
  modal.style.display = 'flex';
  body.textContent = 'Loading evidence pack…';
  try {
    const data = await apiFetch(`/pro/runs/${runId}/evidence`);
    body.textContent = JSON.stringify(data, null, 2);
    const dlBtn = document.getElementById('run-evidence-dl-btn');
    if (dlBtn) dlBtn.onclick = () => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `run_evidence_${runId.slice(0,8)}.json`;
      a.click();
    };
  } catch(e) {
    body.textContent = `Error: ${e?.message || e}`;
  }
}

// ── HANDOFFS ─────────────────────────────────────────────────────────────────

async function loadHandoffs() {
  const list  = document.getElementById('handoffs-list');
  const count = document.getElementById('handoffs-count');
  if (!list) return;
  list.innerHTML = '<div class="loading" style="padding:1rem;"><div class="spinner"></div> Loading…</div>';
  try {
    const direction = document.getElementById('handoff-role-filter')?.value || '';
    const status    = document.getElementById('handoff-status-filter')?.value || '';
    let qs = '/pro/handoffs?limit=25';
    if (direction) qs += `&direction=${direction}`;
    if (status)    qs += `&status=${status}`;
    const data     = await apiFetch(qs);
    const handoffs = data.handoffs || [];
    if (count) count.textContent = data.total ?? handoffs.length;
    if (!handoffs.length) {
      list.innerHTML = '<div style="padding:1.1rem 1.25rem;color:var(--muted);font-size:0.83rem;">No handoffs found.</div>';
      return;
    }
    const statusColor = s => s === 'acknowledged' ? 'var(--green)' : s === 'pending' ? 'var(--accent)' : s === 'rejected' ? 'var(--red)' : 'var(--muted)';
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:0.75rem;">
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">From</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">To</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Status</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Run</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Initiated</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Reason</th>
      </tr></thead>
      <tbody>${handoffs.map((h, i) => `
        <tr style="${i % 2 ? 'background:var(--surface2,var(--surface));' : ''}border-bottom:1px solid var(--border);">
          <td style="padding:0.5rem 1rem;font-size:0.78rem;font-family:'JetBrains Mono',monospace;">${_esc(h.from_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;font-size:0.78rem;font-family:'JetBrains Mono',monospace;">${_esc(h.to_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;"><span style="color:${statusColor(h.status)};font-weight:600;">${_esc(h.status || '—')}</span></td>
          <td style="padding:0.5rem 1rem;font-size:0.72rem;font-family:'JetBrains Mono',monospace;color:var(--muted);">${_esc((h.run_id||'—')?.slice(0,8))}${h.run_id?'…':''}</td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;">${h.initiated_at ? new Date(h.initiated_at).toLocaleString() : '—'}</td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(h.stop_reason || '—')}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } catch(e) {
    list.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:0.82rem;">Could not load handoffs — ${_esc(String(e?.message || e))}</div>`;
  }
}

// ── POLICY DECISIONS ─────────────────────────────────────────────────────────

async function loadPolicyDecisions() {
  const list  = document.getElementById('policy-list');
  const count = document.getElementById('policy-count');
  if (!list) return;
  list.innerHTML = '<div class="loading" style="padding:1rem;"><div class="spinner"></div> Loading…</div>';
  try {
    const decision = document.getElementById('policy-decision-filter')?.value || '';
    let qs = '/pro/policy/decisions?limit=30';
    if (decision) qs += `&decision=${decision}`;
    const data      = await apiFetch(qs);
    const decisions = data.decisions || [];
    if (count) count.textContent = data.total ?? decisions.length;
    if (!decisions.length) {
      list.innerHTML = '<div style="padding:1.1rem 1.25rem;color:var(--muted);font-size:0.83rem;">No policy decisions recorded yet.</div>';
      return;
    }
    const decColor = d => d === 'allow' ? 'var(--green)' : d === 'deny' ? 'var(--red)' : d === 'require_approval' ? 'var(--accent)' : 'var(--muted)';
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:0.75rem;">
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Agent</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Capability</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Decision</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Reason</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">When</th>
      </tr></thead>
      <tbody>${decisions.map((d, i) => `
        <tr style="${i % 2 ? 'background:var(--surface2,var(--surface));' : ''}border-bottom:1px solid var(--border);">
          <td style="padding:0.5rem 1rem;font-size:0.78rem;font-family:'JetBrains Mono',monospace;">${_esc(d.agent_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;">${_esc(d.capability || '—')}</td>
          <td style="padding:0.5rem 1rem;"><span style="color:${decColor(d.decision)};font-weight:700;">${_esc(d.decision || '—')}</span></td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(d.reason||'')}">${_esc((d.reason||'—').slice(0,60))}</td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;">${d.decided_at ? new Date(d.decided_at).toLocaleString() : '—'}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } catch(e) {
    list.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:0.82rem;">Could not load decisions — ${_esc(String(e?.message || e))}</div>`;
  }
}

function _openPolicyCheck() {
  document.getElementById('policy-check-modal').style.display = 'flex';
  document.getElementById('pc-result').style.display = 'none';
  document.getElementById('pc-error').textContent = '';
}

async function _submitPolicyCheck() {
  const btn = document.getElementById('pc-submit-btn');
  const resultEl = document.getElementById('pc-result');
  const errorEl  = document.getElementById('pc-error');
  btn.disabled = true;
  errorEl.textContent = '';
  resultEl.style.display = 'none';
  try {
    const body = {
      agent_did:        document.getElementById('pc-did').value.trim(),
      capability:       document.getElementById('pc-capability').value.trim(),
      tool:             document.getElementById('pc-tool').value.trim() || undefined,
      budget_remaining: document.getElementById('pc-budget').value ? Number(document.getElementById('pc-budget').value) : undefined,
      data_sensitivity: document.getElementById('pc-sensitivity').value || undefined,
      run_id:           document.getElementById('pc-run-id').value.trim() || undefined,
    };
    if (!body.agent_did || !body.capability) { errorEl.textContent = 'Agent DID and capability are required.'; return; }
    const data = await apiFetch('/pro/policy/check', { method: 'POST', body: JSON.stringify(body) });
    resultEl.textContent = JSON.stringify(data, null, 2);
    resultEl.style.display = 'block';
    loadPolicyDecisions();
  } catch(e) {
    errorEl.textContent = e?.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

// ── BUDGET ───────────────────────────────────────────────────────────────────

async function loadBudget() {
  const daily    = document.getElementById('budget-daily');
  const policies = document.getElementById('budget-risk-policies');

  // Daily usage
  if (daily) {
    try {
      const data = await apiFetch('/pro/budget/daily-usage');
      const agents = data.agents || [];
      if (!agents.length) {
        daily.innerHTML = '<span style="font-size:0.82rem;color:var(--muted);">No budget activity today.</span>';
      } else {
        daily.innerHTML = agents.map(a => {
          const pct = a.daily_cap ? Math.min(100, Math.round(100 * a.total_spent / a.daily_cap)) : null;
          return `<div style="min-width:160px;">
            <div style="font-size:0.72rem;color:var(--muted);margin-bottom:2px;">${_esc(a.agent_did?.split(':').pop().slice(0,10))}…</div>
            <div style="font-size:1.05rem;font-weight:700;">$${Number(a.total_spent).toFixed(2)}</div>
            <div style="font-size:0.72rem;color:var(--muted);">of ${a.daily_cap != null ? '$'+Number(a.daily_cap).toFixed(2) : '∞'} daily cap${pct != null ? ' · '+pct+'%' : ''}</div>
            ${pct != null ? `<div style="height:4px;background:var(--border);border-radius:3px;margin-top:4px;"><div style="height:4px;width:${pct}%;background:${pct>80?'var(--red)':'var(--accent)'};border-radius:3px;"></div></div>` : ''}
          </div>`;
        }).join('');
      }
    } catch(e) {
      if (daily) daily.innerHTML = `<span style="font-size:0.82rem;color:var(--muted);">Could not load — ${_esc(String(e?.message||e))}</span>`;
    }
  }

  // Risk policies
  if (policies) {
    try {
      const data = await apiFetch('/pro/budget/risk-policy');
      const ps   = data.policies || [];
      if (!ps.length) {
        policies.innerHTML = '<span style="font-size:0.8rem;color:var(--muted);">No risk-band caps set. Click "Edit caps" to configure.</span>';
      } else {
        policies.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.8rem;margin-bottom:0.5rem;">
          <thead><tr style="color:var(--muted);font-size:0.72rem;">
            <th style="text-align:left;padding:0.3rem 0.5rem;">Band</th>
            <th style="text-align:left;padding:0.3rem 0.5rem;">Per run</th>
            <th style="text-align:left;padding:0.3rem 0.5rem;">Per day</th>
            <th style="text-align:left;padding:0.3rem 0.5rem;">Per capability</th>
            <th style="text-align:left;padding:0.3rem 0.5rem;">Hard cap</th>
          </tr></thead>
          <tbody>${ps.map(p => `<tr style="border-top:1px solid var(--border);">
            <td style="padding:0.35rem 0.5rem;font-weight:600;">${_esc(p.risk_band)}</td>
            <td style="padding:0.35rem 0.5rem;">${p.max_budget_per_run != null ? '$'+p.max_budget_per_run : '—'}</td>
            <td style="padding:0.35rem 0.5rem;">${p.max_budget_per_day != null ? '$'+p.max_budget_per_day : '—'}</td>
            <td style="padding:0.35rem 0.5rem;">${p.max_spend_per_capability != null ? '$'+p.max_spend_per_capability : '—'}</td>
            <td style="padding:0.35rem 0.5rem;">${p.enforce_hard_cap ? '✓' : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      }
    } catch(e) {
      if (policies) policies.innerHTML = `<span style="font-size:0.8rem;color:var(--muted);">Could not load — ${_esc(String(e?.message||e))}</span>`;
    }
  }
}

function _openBudgetPolicyEditor() {
  document.getElementById('budget-policy-modal').style.display = 'flex';
  document.getElementById('bp-msg').textContent = '';
}

async function _saveBudgetPolicy() {
  const msgEl = document.getElementById('bp-msg');
  msgEl.textContent = '';
  try {
    const body = {
      risk_band:                document.getElementById('bp-band').value,
      max_budget_per_run:       document.getElementById('bp-per-run').value ? Number(document.getElementById('bp-per-run').value) : null,
      max_budget_per_day:       document.getElementById('bp-per-day').value ? Number(document.getElementById('bp-per-day').value) : null,
      max_spend_per_capability: document.getElementById('bp-per-cap').value ? Number(document.getElementById('bp-per-cap').value) : null,
      enforce_hard_cap:         document.getElementById('bp-hard-cap').checked,
    };
    await apiFetch('/pro/budget/risk-policy', { method: 'PUT', body: JSON.stringify(body) });
    msgEl.textContent = 'Saved.';
    msgEl.style.color = 'var(--green)';
    setTimeout(() => { document.getElementById('budget-policy-modal').style.display = 'none'; loadBudget(); }, 800);
  } catch(e) {
    msgEl.textContent = e?.message || String(e);
    msgEl.style.color = 'var(--red)';
  }
}

// ── DELEGATION TOKENS ─────────────────────────────────────────────────────────

async function loadDelegation() {
  const list  = document.getElementById('delegation-list');
  const count = document.getElementById('delegation-count');
  if (!list) return;
  list.innerHTML = '<div class="loading" style="padding:1rem;"><div class="spinner"></div> Loading…</div>';
  try {
    const data   = await apiFetch('/pro/delegation?per_page=25');
    const tokens = data.tokens || [];
    if (count) count.textContent = data.total ?? tokens.length;
    if (!tokens.length) {
      list.innerHTML = '<div style="padding:1.1rem 1.25rem;color:var(--muted);font-size:0.83rem;">No delegation tokens issued yet.</div>';
      return;
    }
    const statusColor = s => s === 'active' ? 'var(--green)' : s === 'revoked' ? 'var(--red)' : 'var(--muted)';
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:0.75rem;">
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Delegator</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Delegate</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Capabilities</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Budget cap</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Status</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Expires</th>
        <th style="padding:0.55rem 1rem;"></th>
      </tr></thead>
      <tbody>${tokens.map((t, i) => `
        <tr style="${i % 2 ? 'background:var(--surface2,var(--surface));' : ''}border-bottom:1px solid var(--border);">
          <td style="padding:0.5rem 1rem;font-size:0.75rem;font-family:'JetBrains Mono',monospace;">${_esc(t.delegator_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;font-size:0.75rem;font-family:'JetBrains Mono',monospace;">${_esc(t.delegate_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;font-size:0.78rem;">${t.allowed_capabilities?.length ? _esc(t.allowed_capabilities.slice(0,2).join(', ')) + (t.allowed_capabilities.length > 2 ? '…' : '') : '<span style="color:var(--muted)">Any</span>'}</td>
          <td style="padding:0.5rem 1rem;">${t.budget_cap != null ? '$'+t.budget_cap : '—'}</td>
          <td style="padding:0.5rem 1rem;"><span style="color:${statusColor(t.status)};font-weight:600;">${_esc(t.status)}</span></td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;">${t.expires_at ? new Date(t.expires_at).toLocaleString() : '—'}</td>
          <td style="padding:0.5rem 1rem;">${t.status === 'active' ? `<button class="btn btn-outline" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:var(--red);border-color:var(--red);" onclick="_revokeToken('delegation','${_esc(t.jti)}')">Revoke</button>` : ''}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } catch(e) {
    list.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:0.82rem;">Could not load — ${_esc(String(e?.message || e))}</div>`;
  }
}

// ── TASK CREDENTIALS ─────────────────────────────────────────────────────────

async function loadCredentials() {
  const list  = document.getElementById('credentials-list');
  const count = document.getElementById('credentials-count');
  if (!list) return;
  list.innerHTML = '<div class="loading" style="padding:1rem;"><div class="spinner"></div> Loading…</div>';
  try {
    const data  = await apiFetch('/pro/task-identity?per_page=25');
    const creds = data.credentials || [];
    if (count) count.textContent = data.total ?? creds.length;
    if (!creds.length) {
      list.innerHTML = '<div style="padding:1.1rem 1.25rem;color:var(--muted);font-size:0.83rem;">No task credentials issued yet.</div>';
      return;
    }
    const statusColor = s => s === 'active' ? 'var(--green)' : s === 'revoked' ? 'var(--red)' : 'var(--muted)';
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:0.75rem;">
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Agent</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Run ID</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Sensitivity</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Status</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Issued</th>
        <th style="padding:0.55rem 1rem;text-align:left;font-weight:600;">Expires</th>
        <th style="padding:0.55rem 1rem;"></th>
      </tr></thead>
      <tbody>${creds.map((c, i) => `
        <tr style="${i % 2 ? 'background:var(--surface2,var(--surface));' : ''}border-bottom:1px solid var(--border);">
          <td style="padding:0.5rem 1rem;font-size:0.75rem;font-family:'JetBrains Mono',monospace;">${_esc(c.agent_did?.split(':').pop().slice(0,8))}…</td>
          <td style="padding:0.5rem 1rem;font-size:0.75rem;font-family:'JetBrains Mono',monospace;">${c.run_id ? _esc(c.run_id.slice(0,8))+'…' : '—'}</td>
          <td style="padding:0.5rem 1rem;font-size:0.78rem;">${_esc(c.data_sensitivity || '—')}</td>
          <td style="padding:0.5rem 1rem;"><span style="color:${statusColor(c.status)};font-weight:600;">${_esc(c.status)}</span></td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;">${c.issued_at ? new Date(c.issued_at).toLocaleString() : '—'}</td>
          <td style="padding:0.5rem 1rem;color:var(--muted);font-size:0.78rem;">${c.expires_at ? new Date(c.expires_at).toLocaleString() : '—'}</td>
          <td style="padding:0.5rem 1rem;">${c.status === 'active' ? `<button class="btn btn-outline" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:var(--red);border-color:var(--red);" onclick="_revokeToken('task-identity','${_esc(c.jti)}')">Revoke</button>` : ''}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } catch(e) {
    list.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:0.82rem;">Could not load — ${_esc(String(e?.message || e))}</div>`;
  }
}

async function _revokeToken(type, jti) {
  if (!confirm('Revoke this token? This cannot be undone.')) return;
  try {
    await apiFetch(`/pro/${type}/${jti}`, { method: 'DELETE' });
    if (type === 'delegation') loadDelegation();
    else loadCredentials();
  } catch(e) {
    alert(e?.message || String(e));
  }
}

// ── CSP-safe wiring: replace all inline onclick/onchange in dashboard.html ───
// script-src has no 'unsafe-inline', so onclick= attributes are silently blocked
// by the browser. All wiring must go through addEventListener here.
document.addEventListener("DOMContentLoaded", () => {
  // Sub-accounts / team members
  document.getElementById("add-member-open-btn")?.addEventListener("click", _openAddMember);
  document.getElementById("add-member-submit-btn")?.addEventListener("click", _submitAddMember);
  document.getElementById("add-member-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("add-member-form").style.display = "none";
  });
  document.getElementById("new-member-key-copy-btn")?.addEventListener("click", function () {
    const val = document.getElementById("new-member-key-value")?.textContent || "";
    navigator.clipboard.writeText(val).then(() => {
      this.textContent = "Copied!";
      setTimeout(() => { this.textContent = "Copy"; }, 1500);
    }).catch(() => {});
  });
  document.getElementById("new-member-key-dismiss-btn")?.addEventListener("click", () => {
    const box = document.getElementById("new-member-key-box");
    if (box) box.style.display = "none";
    _loadSubAccounts();
  });

  // Execution Runs
  document.getElementById("runs-refresh-btn")?.addEventListener("click", () => loadRuns());
  document.getElementById("run-evidence-close-x")?.addEventListener("click", () => {
    document.getElementById("run-evidence-modal").style.display = "none";
  });
  document.getElementById("run-evidence-close-btn")?.addEventListener("click", () => {
    document.getElementById("run-evidence-modal").style.display = "none";
  });

  // Agent Handoffs
  document.getElementById("handoffs-refresh-btn")?.addEventListener("click", () => loadHandoffs());
  document.getElementById("handoff-role-filter")?.addEventListener("change", () => loadHandoffs());
  document.getElementById("handoff-status-filter")?.addEventListener("change", () => loadHandoffs());

  // Policy Decisions
  document.getElementById("policy-refresh-btn")?.addEventListener("click", () => loadPolicyDecisions());
  document.getElementById("policy-decision-filter")?.addEventListener("change", () => loadPolicyDecisions());
  document.getElementById("policy-check-btn")?.addEventListener("click", _openPolicyCheck);
  document.getElementById("policy-modal-close-x")?.addEventListener("click", () => {
    document.getElementById("policy-check-modal").style.display = "none";
  });
  document.getElementById("policy-modal-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("policy-check-modal").style.display = "none";
  });
  document.getElementById("pc-submit-btn")?.addEventListener("click", _submitPolicyCheck);

  // Budget
  document.getElementById("budget-refresh-btn")?.addEventListener("click", () => loadBudget());
  document.getElementById("budget-edit-caps-btn")?.addEventListener("click", _openBudgetPolicyEditor);
  document.getElementById("budget-modal-close-x")?.addEventListener("click", () => {
    document.getElementById("budget-policy-modal").style.display = "none";
  });
  document.getElementById("budget-modal-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("budget-policy-modal").style.display = "none";
  });
  document.getElementById("bp-save-btn")?.addEventListener("click", _saveBudgetPolicy);

  // Delegation & Credentials
  document.getElementById("delegation-refresh-btn")?.addEventListener("click", () => loadDelegation());
  document.getElementById("credentials-refresh-btn")?.addEventListener("click", () => loadCredentials());

  // Audit log "View all" — scroll the audit list into view
  document.getElementById("audit-open-full")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("audit-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Report builder — select-all checkbox and agent scope radio buttons
  document.getElementById("rpt-select-all")?.addEventListener("change", function () {
    _rptToggleAll(this.checked);
  });
  document.getElementById("rpt-agents-all")?.addEventListener("change", () => _rptToggleAgentScope("all"));
  document.getElementById("rpt-agents-specific")?.addEventListener("change", () => _rptToggleAgentScope("specific"));

  // Group Runs
  loadGroupRuns();
  document.getElementById("group-runs-refresh-btn")?.addEventListener("click", () => loadGroupRuns());
  document.getElementById("grd-close-btn")?.addEventListener("click", _closeRunDrilldown);
  document.getElementById("grd-workspace-btn")?.addEventListener("click", () => {
    const btn = document.getElementById("grd-workspace-btn");
    const runId = btn?.dataset?.runId;
    const groupId = btn?.dataset?.groupId;
    if (!runId || !groupId) return;
    window.location.href = `team-workspace.html?group_id=${encodeURIComponent(groupId)}&run_id=${encodeURIComponent(runId)}`;
  });
  document.getElementById("group-run-drilldown")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) _closeRunDrilldown();
  });
});

// ── GROUP RUNS ────────────────────────────────────────────────────────────────

const _RUN_STATUS_COLORS = {
  planning:        { bg:"#ede9fe", color:"#7c3aed" },
  running:         { bg:"#dbeafe", color:"#2563eb" },
  synthesizing:    { bg:"#fef3c7", color:"#d97706" },
  completed:       { bg:"#d1fae5", color:"#059669" },
  failed:          { bg:"#fee2e2", color:"#dc2626" },
  cancelled:       { bg:"#f3f4f6", color:"#6b7280" },
  paused_for_user: { bg:"#fef3c7", color:"#b45309" },
};

function _runStatusBadge(status) {
  const s = _RUN_STATUS_COLORS[status] || { bg:"#f3f4f6", color:"#6b7280" };
  const label = (status || "unknown").replace(/_/g," ");
  return `<span style="display:inline-flex;align-items:center;font-size:0.65rem;font-weight:700;padding:0.1rem 0.45rem;border-radius:999px;background:${s.bg};color:${s.color};text-transform:uppercase;letter-spacing:0.03em;white-space:nowrap;">${_esc(label)}</span>`;
}

async function loadGroupRuns() {
  const container = document.getElementById("group-runs-list");
  if (!container) return;

  try {
    // Load all groups first, then pull recent runs for each
    const groupsData = await apiFetch("/pro/groups?limit=50");
    const groups = groupsData.groups || [];

    if (!groups.length) {
      container.innerHTML = `<div style="padding:1rem 1.25rem;font-size:0.85rem;color:var(--muted);">No groups yet — create a group first to run coordinated tasks.</div>`;
      return;
    }

    // Fetch recent runs for all groups in parallel (limit 5 each)
    const runResults = await Promise.allSettled(
      groups.map(g =>
        apiFetch(`/pro/groups/${g.id}/runs?limit=5`)
          .then(d => ({ group: g, runs: d.runs || [] }))
      )
    );

    const allRows = [];
    runResults.forEach(res => {
      if (res.status !== "fulfilled") return;
      const { group, runs } = res.value;
      runs.forEach(r => allRows.push({ ...r, _group: group }));
    });

    // Sort newest first
    allRows.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));

    if (!allRows.length) {
      container.innerHTML = `<div style="padding:1rem 1.25rem;font-size:0.85rem;color:var(--muted);">No runs yet — go to <a href="messages.html" style="color:var(--accent);">Messages → Teams</a> to start one.</div>`;
      return;
    }

    const rows = allRows.slice(0, 30).map(r => {
      const t   = r.started_at ? new Date(r.started_at).toLocaleString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
      const dur = (r.started_at && r.completed_at)
        ? `${Math.round((new Date(r.completed_at) - new Date(r.started_at)) / 1000)}s`
        : "—";
      const task = (r.user_task || "").slice(0, 70) + ((r.user_task || "").length > 70 ? "…" : "");
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer;" class="grr-row" data-run-id="${_esc(r.id)}" data-group-id="${r._group.id}">
        <td style="padding:0.55rem 0.75rem;font-size:0.8rem;font-weight:600;white-space:nowrap;">${_esc(r._group.name)}</td>
        <td style="padding:0.55rem 0.75rem;font-size:0.8rem;color:var(--text-2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(task)}</td>
        <td style="padding:0.55rem 0.75rem;">${_runStatusBadge(r.status)}</td>
        <td style="padding:0.55rem 0.75rem;font-size:0.75rem;color:var(--muted);white-space:nowrap;">${_esc(t)}</td>
        <td style="padding:0.55rem 0.75rem;font-size:0.75rem;color:var(--muted);white-space:nowrap;">${_esc(dur)}</td>
        <td style="padding:0.55rem 0.75rem;"><button class="agent-action-btn" style="white-space:nowrap;">Details →</button></td>
      </tr>`;
    }).join("");

    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;padding:0.45rem 0.75rem;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Team</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Task</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Status</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Started</th>
            <th style="text-align:left;padding:0.45rem 0.75rem;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Duration</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    container.querySelectorAll(".grr-row").forEach(row => {
      row.addEventListener("click", () => openRunDrilldown(row.dataset.runId, +row.dataset.groupId));
    });

  } catch(e) {
    container.innerHTML = `<div style="padding:1rem 1.25rem;font-size:0.85rem;color:var(--red);">Could not load group runs: ${_esc(e.message)}</div>`;
  }
}

// ── Run Drilldown panel ───────────────────────────────────────────────────────

async function openRunDrilldown(runId, groupId) {
  const panel = document.getElementById("group-run-drilldown");
  const body  = document.getElementById("grd-body");
  const title = document.getElementById("grd-title");
  const meta  = document.getElementById("grd-meta");
  const workspaceBtn = document.getElementById("grd-workspace-btn");
  if (!panel || !body) return;

  _stopDrilldownSSE();
  panel.style.display = "flex";
  body.innerHTML = `<div style="text-align:center;padding:3rem 1rem;"><div style="width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;margin:0 auto 0.75rem;"></div><div style="font-size:0.85rem;color:var(--muted);">Loading run…</div></div>`;
  title.textContent = "Run Detail";
  meta.textContent  = "";

  try {
    const run = await apiFetch(`/pro/groups/runs/${runId}`);
    // preserve groupId across reloads triggered by SSE terminal event
    if (groupId != null) run._groupId = groupId;
    const workspaceGroupId = run.group_id || run._groupId || groupId || "";
    if (workspaceBtn) {
      workspaceBtn.dataset.runId = runId;
      workspaceBtn.dataset.groupId = String(workspaceGroupId || "");
      workspaceBtn.style.display = workspaceGroupId ? "inline-flex" : "none";
    }

    title.textContent = run.user_task ? run.user_task.slice(0, 60) + (run.user_task.length > 60 ? "…" : "") : "Run Detail";
    const startedAt = run.started_at ? new Date(run.started_at).toLocaleString() : "";
    meta.textContent = `${run.status} · ${startedAt}`;

    // Assignments section — data-agent-did + class names for live updates
    const assignments = run.assignments || [];
    const assignmentRows = assignments.map(a => {
      const score = a.quality_score != null ? `${Math.round(a.quality_score * 100)}%` : "—";
      const scoreColor = a.quality_score != null && a.quality_score >= 0.6 ? "var(--green)" : "var(--yellow)";
      const trustStr = a.trust_score_at_assignment != null ? `${Math.round(a.trust_score_at_assignment)}/100` : "—";
      const riskLevel = a.risk_level || "medium";
      const riskColors = { low: "#065f46", medium: "#92400e", high: "#991b1b" };
      const riskBgs    = { low: "#d1fae5", medium: "#fef3c7", high: "#fee2e2" };
      const riskBadge = `<span style="display:inline-block;font-size:0.58rem;font-weight:700;padding:0.05rem 0.3rem;border-radius:999px;background:${riskBgs[riskLevel]||riskBgs.medium};color:${riskColors[riskLevel]||riskColors.medium};text-transform:uppercase;">${_esc(riskLevel)}</span>`;
      // Build causality sub-rows: rationale, rejection reason, context trail
      const extraRows = [];
      if (a.rationale) {
        extraRows.push(`<tr data-agent-did="${_esc(a.agent_did||"")}">
          <td colspan="7" style="padding:0.15rem 0.6rem 0.3rem 2rem;font-size:0.72rem;color:var(--muted);font-style:italic;">
            💬 ${_esc(a.rationale)}</td></tr>`);
      }
      if (a.rejection_reason) {
        extraRows.push(`<tr data-agent-did="${_esc(a.agent_did||"")}">
          <td colspan="7" style="padding:0.15rem 0.6rem 0.3rem 2rem;font-size:0.72rem;color:#b45309;">
            ⚠ Rejected: ${_esc(a.rejection_reason)}</td></tr>`);
      }
      if (a.contributing_context && typeof a.contributing_context === "object") {
        const ctxEntries = Object.entries(a.contributing_context);
        if (ctxEntries.length) {
          const ctxLines = ctxEntries.map(([k, v]) => {
            const val = v?.value || v;
            const preview = typeof val === "object" ? (val?.result || val?.subtask || JSON.stringify(val)).slice(0,80) : String(val).slice(0,80);
            const by = v?.by ? v.by.slice(-12) : "";
            return `<span style="display:block;padding:0.1rem 0;"><span style="color:var(--muted);font-weight:600;">${_esc(k)}${by ? ` (${_esc(by)})` : ""}:</span> ${_esc(preview)}…</span>`;
          }).join("");
          extraRows.push(`<tr data-agent-did="${_esc(a.agent_did||"")}">
            <td colspan="7" style="padding:0.15rem 0.6rem 0.4rem 2rem;font-size:0.7rem;color:var(--text-2);">
              <details><summary style="cursor:pointer;color:var(--muted);font-size:0.68rem;list-style:none;user-select:none;">▸ Context seen (${ctxEntries.length} item${ctxEntries.length>1?"s":""})</summary>
              <div style="margin-top:0.2rem;padding:0.3rem 0.4rem;background:var(--surface2);border-radius:5px;">${ctxLines}</div></details>
            </td></tr>`);
        }
      }
      const hasExtra = extraRows.length > 0;
      return `<tr style="border-bottom:${hasExtra ? "none" : "1px solid var(--border)"};" data-agent-did="${_esc(a.agent_did || "")}">
        <td style="padding:0.45rem 0.6rem;font-size:0.78rem;font-weight:600;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc((a.agent_did || "").slice(-14))}</td>
        <td style="padding:0.45rem 0.6rem;font-size:0.78rem;color:var(--text-2);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(a.subtask || "")}</td>
        <td style="padding:0.45rem 0.6rem;" class="grd-status-cell">${_runStatusBadge(a.status)}</td>
        <td style="padding:0.45rem 0.6rem;">${riskBadge}</td>
        <td style="padding:0.45rem 0.6rem;font-size:0.75rem;color:var(--muted);">${_esc(trustStr)}</td>
        <td style="padding:0.45rem 0.6rem;font-size:0.78rem;font-weight:700;color:${scoreColor};" class="grd-quality-cell">${_esc(score)}</td>
        <td style="padding:0.45rem 0.6rem;font-size:0.72rem;color:var(--muted);">${a.retry_count > 0 ? `${a.retry_count} retr${a.retry_count > 1 ? "ies" : "y"}` : "—"}</td>
      </tr>${extraRows.join("")}${hasExtra ? `<tr><td colspan="7" style="border-bottom:1px solid var(--border);padding:0;"></td></tr>` : ""}`;
    }).join("");

    // Events timeline — container gets stable ID for live appending
    const events = (run.events || []).slice(-50);
    const eventRows = events.map(ev => {
      const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit", second:"2-digit" }) : "";
      const col = _GRD_EVENT_COLORS[ev.event_type] || "#6b7280";
      const label = (ev.event_type || "").replace(/_/g, " ");
      const ed = ev.event_data || {};
      // Build detail line: rejection reason, quality score, clarification question, etc.
      let detail = ev.agent_did ? `<span style="font-size:0.7rem;color:var(--muted);">${_esc(ev.agent_did.slice(-14))}</span>` : "";
      if (ed.reason)          detail += ` <span style="font-size:0.7rem;color:#b45309;">— ${_esc(String(ed.reason).slice(0,80))}</span>`;
      if (ed.score != null)   detail += ` <span style="font-size:0.7rem;color:var(--muted);">score: ${Math.round(ed.score*100)}%</span>`;
      if (ed.pause_question)  detail += ` <span style="font-size:0.7rem;color:#1d4ed8;font-style:italic;">"${_esc(String(ed.pause_question).slice(0,60))}"</span>`;
      if (ed.output_preview)  detail += ` <span style="font-size:0.7rem;color:var(--muted);">${_esc(String(ed.output_preview).slice(0,60))}…</span>`;
      // Context snapshot: show count of context entries at this moment
      const snap = ev.context_snapshot;
      const ctxCount = snap && typeof snap === "object" ? Object.keys(snap).length : 0;
      const ctxTag = ctxCount > 0
        ? ` <details style="display:inline;"><summary style="display:inline;cursor:pointer;font-size:0.65rem;color:var(--muted);list-style:none;">▸ ${ctxCount} ctx</summary>
            <span style="display:block;margin-top:0.2rem;padding:0.25rem 0.4rem;background:var(--surface2);border-radius:5px;font-size:0.68rem;color:var(--text-2);">
              ${Object.keys(snap).map(k => _esc(k)).join(", ")}
            </span></details>` : "";
      return `<div style="padding:0.3rem 0;border-bottom:1px solid var(--border);">
        <div style="display:flex;gap:0.6rem;align-items:flex-start;">
          <span style="font-size:0.65rem;color:var(--muted);white-space:nowrap;flex-shrink:0;min-width:56px;">${_esc(ts)}</span>
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0;margin-top:0.25rem;"></span>
          <span style="font-size:0.75rem;font-weight:600;color:${col};flex-shrink:0;min-width:150px;">${_esc(label)}</span>
          <span style="font-size:0.72rem;flex:1;line-height:1.4;">${detail}${ctxTag}</span>
        </div>
      </div>`;
    }).join("");

    // Performance section
    let perfHtml = "";
    try {
      const perf = await apiFetch(`/pro/groups/${groupId}/performance`);
      const agents = perf.agents || [];
      if (agents.length) {
        const perfRows = agents.map(a => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:0.4rem 0.6rem;font-size:0.78rem;font-weight:600;">${_esc(a.name || a.did.slice(-14))}</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.78rem;text-align:center;">${a.total_assigned}</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.78rem;text-align:center;color:var(--green);">${a.total_completed}</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.78rem;text-align:center;color:var(--yellow);">${a.total_rejected}</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.78rem;text-align:center;">${a.avg_quality_score != null ? Math.round(a.avg_quality_score * 100) + "%" : "—"}</td>
          </tr>`).join("");
        perfHtml = `
          <div style="margin-top:1.5rem;">
            <div style="font-size:0.8rem;font-weight:700;color:var(--text-2);margin-bottom:0.5rem;">Team performance (all runs)</div>
            <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;">
              <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
                <thead><tr style="background:var(--surface2);border-bottom:1px solid var(--border);">
                  <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Agent</th>
                  <th style="text-align:center;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Assigned</th>
                  <th style="text-align:center;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Done</th>
                  <th style="text-align:center;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Rejected</th>
                  <th style="text-align:center;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Avg quality</th>
                </tr></thead>
                <tbody>${perfRows}</tbody>
              </table>
            </div>
          </div>`;
      }
    } catch(_) {}

    // Fetch cross-run analytics for this group
    let analyticsHtml = "";
    try {
      const analyticsBase = `${window.BASE || ""}/pro/groups/${run._groupId}/analytics`;
      const an = await apiFetch(`/pro/groups/${run._groupId}/analytics`);
      const ar = an.runs || {};
      const aa = an.assignments || {};
      const compRate = ar.completion_rate != null ? Math.round(ar.completion_rate * 100) : null;
      const accRate  = aa.acceptance_rate  != null ? Math.round(aa.acceptance_rate  * 100) : null;
      const avgQ     = aa.avg_quality      != null ? Math.round(aa.avg_quality      * 100) : null;
      const avgDur   = ar.avg_duration_sec != null ? (ar.avg_duration_sec < 60
        ? `${Math.round(ar.avg_duration_sec)}s`
        : `${Math.floor(ar.avg_duration_sec/60)}m ${Math.round(ar.avg_duration_sec%60)}s`) : "—";
      const statCell = (label, val, sub) =>
        `<div style="text-align:center;padding:0.5rem 0.3rem;">
           <div style="font-size:1rem;font-weight:800;color:var(--text);">${val}</div>
           <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);font-weight:600;">${label}</div>
           ${sub ? `<div style="font-size:0.62rem;color:var(--muted);">${sub}</div>` : ""}
         </div>`;
      // Per-agent reliability table
      const anAgents = an.agents || [];
      const relRows = anAgents.map(a => {
        const rejRate = a.rejection_rate != null ? Math.round(a.rejection_rate * 100) : null;
        const relScore = a.reliability_score != null ? Math.round(a.reliability_score) : null;
        const avgQStr  = a.avg_quality != null ? Math.round(a.avg_quality * 100) + "%" : "—";
        // Reliability bar colour
        const relCol = relScore == null ? "var(--muted)"
          : relScore >= 80 ? "#10b981" : relScore >= 50 ? "#f59e0b" : "#ef4444";
        const relBar = relScore != null
          ? `<div style="display:flex;align-items:center;gap:0.3rem;">
               <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden;">
                 <div style="width:${relScore}%;height:100%;background:${relCol};border-radius:3px;"></div>
               </div>
               <span style="font-size:0.7rem;font-weight:700;color:${relCol};">${relScore}</span>
             </div>` : `<span style="color:var(--muted);">—</span>`;
        const rejBadge = rejRate != null
          ? `<span style="font-size:0.7rem;font-weight:700;color:${rejRate === 0 ? "var(--green)" : rejRate < 30 ? "var(--text)" : "#b45309"};">${rejRate}%</span>`
          : "—";
        return `<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:0.38rem 0.6rem;font-size:0.77rem;font-weight:600;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(a.name || (a.did||"").slice(-14))}</td>
          <td style="padding:0.38rem 0.6rem;font-size:0.77rem;text-align:center;">${a.assigned}</td>
          <td style="padding:0.38rem 0.6rem;font-size:0.77rem;text-align:center;color:var(--green);">${a.completed}</td>
          <td style="padding:0.38rem 0.6rem;text-align:center;">${rejBadge}</td>
          <td style="padding:0.38rem 0.6rem;font-size:0.77rem;text-align:center;">${avgQStr}</td>
          <td style="padding:0.38rem 0.6rem;min-width:90px;">${relBar}</td>
        </tr>`;
      }).join("");

      analyticsHtml = `
        <div style="margin-bottom:1.25rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
            <div style="font-size:0.8rem;font-weight:700;color:var(--text-2);">Team analytics (all runs)</div>
            <span style="font-size:0.72rem;color:var(--muted);">${ar.total} run${ar.total === 1 ? "" : "s"} total</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:0.3rem;border:1px solid var(--border);border-radius:8px;padding:0.4rem;background:var(--surface);margin-bottom:0.75rem;">
            ${statCell("Completion", compRate != null ? compRate + "%" : "—", `${ar.completed} done`)}
            ${statCell("Avg duration", avgDur, "")}
            ${statCell("Acceptance", accRate != null ? accRate + "%" : "—", `${aa.accepted} accepted`)}
            ${statCell("Avg quality", avgQ != null ? avgQ + "%" : "—", "")}
            ${statCell("Trust-routed", aa.trust_influenced != null ? aa.trust_influenced : "—", "assignments")}
          </div>
          ${relRows ? `
          <div style="font-size:0.74rem;font-weight:700;color:var(--text-2);margin-bottom:0.3rem;">Agent reliability across all runs</div>
          <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;">
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr style="background:var(--surface2);border-bottom:1px solid var(--border);">
                <th style="text-align:left;padding:0.35rem 0.6rem;font-size:0.63rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Agent</th>
                <th style="text-align:center;padding:0.35rem 0.6rem;font-size:0.63rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Assigned</th>
                <th style="text-align:center;padding:0.35rem 0.6rem;font-size:0.63rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Done</th>
                <th style="text-align:center;padding:0.35rem 0.6rem;font-size:0.63rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Rej.%</th>
                <th style="text-align:center;padding:0.35rem 0.6rem;font-size:0.63rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Avg Q</th>
                <th style="padding:0.35rem 0.6rem;font-size:0.63rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Reliability</th>
              </tr></thead>
              <tbody>${relRows}</tbody>
            </table>
          </div>` : ""}
        </div>`;
    } catch(_) {}

    body.innerHTML = `
      ${run.final_output ? `
        <div style="background:var(--green-bg);border:1px solid #6ee7b7;border-radius:10px;padding:0.85rem 1rem;margin-bottom:1rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
            <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--green);">✨ Final Answer</div>
            <button onclick="_downloadRunReport('${runId}')"
               style="font-size:0.72rem;font-weight:600;color:var(--accent);background:none;cursor:pointer;border:1px solid var(--accent);border-radius:6px;padding:0.15rem 0.5rem;font-family:inherit;">📄 Download .md</button>
          </div>
          <div style="font-size:0.84rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;">${_esc(run.final_output)}</div>
          ${run.run_summary ? `<div style="margin-top:0.5rem;font-size:0.72rem;color:var(--muted);font-style:italic;border-top:1px solid #a7f3d0;padding-top:0.4rem;">${_esc(run.run_summary)}</div>` : ""}
        </div>` : ""}

      ${analyticsHtml}

      ${(() => {
        const contribs = run.contributions || [];
        if (!contribs.length) return "";
        const medals = ["🥇","🥈","🥉"];
        const barRows = contribs.map((c, i) => {
          const agentName = (() => {
            const a = assignments.find(x => x.agent_did === c.did);
            return a ? (a.agent_did || c.did).slice(-14) : (c.did || "").slice(-14);
          })();
          const medal = medals[i] || `#${c.rank}`;
          // Stacked bar segments: quality / reuse / reliability / completion
          const maxRaw = contribs[0].raw_score || 1;
          const qW  = (c.quality_pts      / maxRaw * 100).toFixed(1);
          const rW  = (c.reuse_pts        / maxRaw * 100).toFixed(1);
          const rlW = (c.reliability_pts  / maxRaw * 100).toFixed(1);
          const cpW = (c.completion_pts   / maxRaw * 100).toFixed(1);
          const reuseNote = c.reuse_count > 0
            ? `<span style="font-size:0.65rem;color:#2563eb;margin-left:0.35rem;">↑ used by ${c.reuse_count} agent${c.reuse_count>1?"s":""}</span>` : "";
          return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;border-bottom:1px solid var(--border);">
            <span style="font-size:0.78rem;min-width:20px;text-align:center;">${medal}</span>
            <span style="font-size:0.78rem;font-weight:600;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(c.did)}">${_esc(agentName)}</span>
            <div style="flex:1;height:14px;border-radius:3px;overflow:hidden;display:flex;background:var(--border);">
              <div style="width:${qW}%;background:#6366f1;" title="Quality: ${c.quality_pts}pts"></div>
              <div style="width:${rW}%;background:#2563eb;" title="Reuse: ${c.reuse_pts}pts"></div>
              <div style="width:${rlW}%;background:#10b981;" title="Reliability: ${c.reliability_pts}pts"></div>
              <div style="width:${cpW}%;background:#f59e0b;" title="Completion: ${c.completion_pts}pts"></div>
            </div>
            <span style="font-size:0.8rem;font-weight:800;min-width:36px;text-align:right;color:var(--text);">${c.score}%</span>
            ${reuseNote}
          </div>`;
        }).join("");
        return `<div style="margin-bottom:1.25rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
            <div style="font-size:0.8rem;font-weight:700;color:var(--text-2);">🏆 Run Contribution Ranking</div>
            <div style="display:flex;gap:0.6rem;font-size:0.62rem;color:var(--muted);">
              <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#6366f1;margin-right:2px;"></span>Quality</span>
              <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#2563eb;margin-right:2px;"></span>Reuse</span>
              <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#10b981;margin-right:2px;"></span>Reliability</span>
              <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#f59e0b;margin-right:2px;"></span>Completion</span>
            </div>
          </div>
          <div style="border:1px solid var(--border);border-radius:8px;padding:0.3rem 0.75rem;">
            ${barRows}
          </div>
        </div>`;
      })()}

      ${assignments.length ? `
        <div style="margin-bottom:1.25rem;">
          <div style="font-size:0.8rem;font-weight:700;color:var(--text-2);margin-bottom:0.5rem;">Assignments (${assignments.length})</div>
          <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;">
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr style="background:var(--surface2);border-bottom:1px solid var(--border);">
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Agent</th>
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Subtask</th>
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Status</th>
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Risk</th>
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Trust</th>
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Quality</th>
                <th style="text-align:left;padding:0.4rem 0.6rem;font-size:0.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Retries</th>
              </tr></thead>
              <tbody id="grd-assignments-body">${assignmentRows}</tbody>
            </table>
          </div>
        </div>` : ""}

      ${eventRows !== undefined ? `
        <div style="margin-bottom:1.25rem;">
          <div style="font-size:0.8rem;font-weight:700;color:var(--text-2);margin-bottom:0.5rem;">Event timeline</div>
          <div id="grd-events-list" style="border:1px solid var(--border);border-radius:8px;padding:0.4rem 0.75rem;max-height:320px;overflow-y:auto;">
            ${eventRows}
          </div>
        </div>` : ""}

      ${perfHtml}`;

    // Start live SSE stream if run is still active
    if (!_GRD_TERMINAL.has(run.status)) {
      _startDrilldownSSE(runId);
    }

  } catch(e) {
    if (workspaceBtn) workspaceBtn.style.display = "none";
    body.innerHTML = `<div style="color:var(--red);font-size:0.85rem;">Could not load run: ${_esc(e.message)}</div>`;
  }
}

function _closeRunDrilldown() {
  _stopDrilldownSSE();
  const panel = document.getElementById("group-run-drilldown");
  const workspaceBtn = document.getElementById("grd-workspace-btn");
  if (panel) panel.style.display = "none";
  if (workspaceBtn) {
    workspaceBtn.style.display = "none";
    delete workspaceBtn.dataset.runId;
    delete workspaceBtn.dataset.groupId;
  }
}

async function _downloadRunReport(runId) {
  try {
    const res = await _authFetch(`${BASE}/pro/groups/runs/${runId}/report`);
    if (!res.ok) { alert("Report not available yet."); return; }
    const text = await res.text();
    const blob = new Blob([text], { type: "text/markdown" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `agentid_run_${runId.slice(0,8)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) {
    alert("Failed to download report: " + e.message);
  }
}

// ── Drilldown live SSE ────────────────────────────────────────────────────────

let _drilldownSSE = null;  // { close() }
const _GRD_TERMINAL = new Set(["completed","failed","cancelled"]);

const _GRD_EVENT_COLORS = {
  orchestrator_plan:"#7c3aed", agent_assigned:"#2563eb", agent_started:"#2563eb",
  agent_completed:"#059669", orchestrator_rejected:"#d97706", agent_reassigned:"#d97706",
  context_written:"#6b7280", clarification_requested:"#b45309", clarification_received:"#b45309",
  synthesis_started:"#0891b2", synthesis_completed:"#059669",
  run_completed:"#059669", run_failed:"#dc2626", run_cancelled:"#6b7280",
};

function _stopDrilldownSSE() {
  if (_drilldownSSE) { _drilldownSSE.close(); _drilldownSSE = null; }
  const badge = document.getElementById("grd-live-badge");
  if (badge) badge.style.display = "none";
}

function _startDrilldownSSE(runId) {
  _stopDrilldownSSE();
  let cancelled = false;
  const controller = new AbortController();
  _drilldownSSE = { close: () => { cancelled = true; controller.abort(); } };

  const badge = document.getElementById("grd-live-badge");
  if (badge) badge.style.display = "flex";

  const key = apiKey || sessionStorage.getItem("agentid_key") || "";

  fetch(`${BASE}/pro/groups/runs/${runId}/stream`, {
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    credentials: "include",
    signal: controller.signal,
  }).then(async res => {
    if (!res.ok || !res.body) { _stopDrilldownSSE(); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done || cancelled) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          _grdHandleEvent(ev, runId);
        } catch(_) {}
      }
    }
    _stopDrilldownSSE();
  }).catch(() => _stopDrilldownSSE());
}

function _grdHandleEvent(ev, runId) {
  if (!ev || !ev.event_type) return;

  // Append to event timeline
  const list = document.getElementById("grd-events-list");
  if (list) {
    const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString(undefined,
      { hour:"2-digit", minute:"2-digit", second:"2-digit" }) : "";
    const col = _GRD_EVENT_COLORS[ev.event_type] || "#6b7280";
    const label = (ev.event_type || "").replace(/_/g, " ");
    const agentLabel = ev.agent_did ? _esc(ev.agent_did.slice(-14)) : "";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.6rem;align-items:flex-start;padding:0.35rem 0;border-bottom:1px solid var(--border);";
    row.innerHTML = `
      <span style="font-size:0.65rem;color:var(--muted);white-space:nowrap;flex-shrink:0;padding-top:0.05rem;min-width:56px;">${_esc(ts)}</span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0;margin-top:0.2rem;"></span>
      <span style="font-size:0.75rem;font-weight:600;color:${col};flex-shrink:0;min-width:160px;">${_esc(label)}</span>
      <span style="font-size:0.72rem;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${agentLabel}</span>`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }

  // Update assignment badge in place
  const agentDid = ev.agent_did;
  if (agentDid) {
    const tbody = document.getElementById("grd-assignments-body");
    if (tbody) {
      const rows = tbody.querySelectorAll("tr[data-agent-did]");
      rows.forEach(tr => {
        if (!tr.dataset.agentDid.endsWith(agentDid.slice(-14)) &&
            tr.dataset.agentDid !== agentDid) return;
        const badgeCell = tr.querySelector(".grd-status-cell");
        if (!badgeCell) return;
        if (ev.event_type === "agent_completed") {
          badgeCell.innerHTML = _runStatusBadge("completed");
          const qCell = tr.querySelector(".grd-quality-cell");
          const score = ev.data?.score ?? ev.data?.quality_score;
          if (qCell && score != null) {
            const pct = Math.round(score * 100);
            const c = score >= 0.6 ? "var(--green)" : "var(--yellow)";
            qCell.innerHTML = `<span style="font-weight:700;color:${c};">${pct}%</span>`;
          }
        } else if (ev.event_type === "orchestrator_rejected") {
          badgeCell.innerHTML = _runStatusBadge("rejected");
        } else if (ev.event_type === "agent_reassigned") {
          badgeCell.innerHTML = _runStatusBadge("reassigned");
        } else if (ev.event_type === "agent_started") {
          badgeCell.innerHTML = _runStatusBadge("running");
        }
      });
    }
  }

  // Update run-level status in header meta
  const terminalMap = {
    run_completed: "completed", run_failed: "failed", run_cancelled: "cancelled",
    synthesis_started: "synthesizing",
  };
  if (terminalMap[ev.event_type]) {
    const meta = document.getElementById("grd-meta");
    if (meta) {
      const parts = meta.textContent.split(" · ");
      parts[0] = terminalMap[ev.event_type];
      meta.textContent = parts.join(" · ");
    }
  }

  // On terminal event: stop SSE and reload the full drilldown to show final answer
  if (ev.event_type === "stream_end" || _GRD_TERMINAL.has(ev.event_type?.replace("run_", "") || "")) {
    if (_GRD_TERMINAL.has(ev.event_type === "run_completed" ? "completed"
        : ev.event_type === "run_failed" ? "failed"
        : ev.event_type === "run_cancelled" ? "cancelled" : "")) {
      _stopDrilldownSSE();
      // Reload drilldown after short delay so DB has final data
      setTimeout(() => openRunDrilldown(runId, null), 800);
    } else if (ev.event_type === "stream_end") {
      _stopDrilldownSSE();
      setTimeout(() => openRunDrilldown(runId, null), 800);
    }
  }
}
