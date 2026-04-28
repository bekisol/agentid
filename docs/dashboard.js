const BASE = "https://api.agentid-protocol.com";

// ── SECURE KEY STORAGE ────────────────────────────────────────────────────────
// Key lives in sessionStorage (tab-scoped, cleared on browser close, not
// readable across origins). A short-lived localStorage pulse lets new tabs
// inherit an active session without permanently storing the raw key.
let apiKey = sessionStorage.getItem("agentid_key") || "";

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
  sessionStorage.removeItem("agentid_key");
  sessionStorage.removeItem("agentid_login_ts");
  apiKey = "";
  clearTimeout(sessionTimer);
  clearInterval(_anomalyTimer);
  stopSse();
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("logout-btn").style.display = "none";
  document.getElementById("api-key-input").value = "";
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (capChart)   { capChart.destroy();   capChart = null; }
  const err = document.getElementById("error-msg");
  err.textContent = "Your session expired after 8 hours. Please sign in again.";
  err.style.display = "block";
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

async function apiFetch(path) {
  const res = await fetch(BASE + path, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────

async function login() {
  const input = document.getElementById("api-key-input");
  const btn   = document.getElementById("login-btn");
  const err   = document.getElementById("error-msg");

  apiKey = input.value.trim();
  err.style.display = "none";

  if (!apiKey) {
    err.textContent = "Please enter your API key.";
    err.style.display = "block";
    return;
  }

  btn.textContent = "Connecting…";
  btn.disabled = true;

  try {
    await loadDashboard();
    sessionStorage.setItem("agentid_key", apiKey);
    sessionStorage.setItem("agentid_login_ts", String(Date.now()));
    // Notify sibling tabs — BroadcastChannel (no storage) or localStorage fallback
    if (window._bcTabSync) {
      window._bcTabSync.postMessage({ type: "response", key: apiKey, ts: Date.now() });
    } else {
      // Fallback: write then immediately delete — key in localStorage for ≤1 tick
      const sync = JSON.stringify({ key: apiKey, ts: Date.now(), origin: location.origin });
      localStorage.setItem("agentid_tab_sync", sync);
      setTimeout(() => localStorage.removeItem("agentid_tab_sync"), 0);
    }
    scheduleSessionExpiry();
  } catch (e) {
    const status = e.message;
    if (status === "401" || status === "403") {
      err.textContent = "Invalid API key — please check and try again.";
    } else if (status === "429") {
      err.textContent = "Too many attempts — please wait a moment.";
    } else {
      err.textContent = "Could not connect to the registry. Try again shortly.";
    }
    err.style.display = "block";
    apiKey = "";
  } finally {
    btn.textContent = "Connect";
    btn.disabled = false;
  }
}

function logout() {
  sessionStorage.removeItem("agentid_key");
  sessionStorage.removeItem("agentid_login_ts");
  apiKey = "";
  clearTimeout(sessionTimer);
  clearInterval(_anomalyTimer);
  stopSse();
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("logout-btn").style.display = "none";
  document.getElementById("api-key-input").value = "";
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (capChart)   { capChart.destroy();   capChart = null; }
}

// ── MAIN DASHBOARD LOAD ───────────────────────────────────────────────────────

async function loadDashboard() {
  const data = await apiFetch("/pro/analytics/overview");

  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("logout-btn").style.display = "flex";

  const tier = String(data.tier);

  // Header
  document.getElementById("dash-title").textContent = data.owner;
  document.getElementById("dash-sub").textContent = "Pro analytics dashboard";

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

  // Badge, charts, audit, agents — load in parallel
  loadBadge(data.owner);
  try { renderCharts(data); } catch (e) { console.warn("Charts:", e); }
  renderActivity(data.activity_last_7d || []);
  loadAuditLog();
  loadSigningActivity();
  loadAgentsTable();
  loadDiscoveryStats();
  loadAnomalies();

  // Start real-time SSE feed (or restart if already running)
  startSse();

  // Anomaly auto-refresh every 60 s
  clearInterval(_anomalyTimer);
  _anomalyTimer = setInterval(loadAnomalies, 60000);

}

// ── CHARTS ────────────────────────────────────────────────────────────────────

function renderCharts(data) {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded — charts skipped");
    return;
  }
  const trendLabels = (data.registration_trend_30d || []).map(r => {
    const d = new Date(r.date);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
  const trendData = (data.registration_trend_30d || []).map(r => Number(r.count) || 0);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById("trend-chart"), {
    type: "bar",
    data: {
      labels: trendLabels.length ? trendLabels : ["No data"],
      datasets: [{
        data: trendData.length ? trendData : [0],
        backgroundColor: "rgba(194, 65, 12, 0.15)",
        borderColor: "rgba(194, 65, 12, 0.8)",
        borderWidth: 1.5, borderRadius: 5, borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#78716C", font: { size: 10, family: "Inter" }, maxRotation: 0, maxTicksLimit: 8 }, grid: { color: "#F2F0EC" }, border: { color: "#E5E2DB" } },
        y: { ticks: { color: "#78716C", font: { size: 10, family: "Inter" }, stepSize: 1 }, grid: { color: "#F2F0EC" }, border: { color: "#E5E2DB" }, beginAtZero: true },
      }
    }
  });

  const capLabels = (data.top_capabilities || []).map(c => String(c.capability));
  const capData   = (data.top_capabilities || []).map(c => Number(c.agent_count) || 0);
  const capColors = [
    "rgba(194,65,12,0.7)", "rgba(5,150,105,0.7)", "rgba(37,99,235,0.7)",
    "rgba(217,119,6,0.7)", "rgba(124,58,237,0.7)", "rgba(219,39,119,0.7)",
  ];

  if (capChart) capChart.destroy();
  capChart = new Chart(document.getElementById("cap-chart"), {
    type: "bar",
    data: {
      labels: capLabels.length ? capLabels : ["No data"],
      datasets: [{ data: capData.length ? capData : [0], backgroundColor: capColors, borderRadius: 5, borderSkipped: false }]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#78716C", font: { size: 10, family: "Inter" }, stepSize: 1 }, grid: { color: "#F2F0EC" }, border: { color: "#E5E2DB" }, beginAtZero: true },
        y: { ticks: { color: "#44403C", font: { size: 11, family: "Inter" } }, grid: { display: false }, border: { display: false } },
      }
    }
  });
}

// ── ACTIVITY ──────────────────────────────────────────────────────────────────

function renderActivity(activity) {
  const actEl = document.getElementById("activity-list");
  if (!activity.length) {
    actEl.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>No activity in the last 7 days</p></div>';
    return;
  }
  actEl.innerHTML = activity.map(r => `
    <div class="activity-row">
      <span class="op-pill ${opClass(r.operation)}">${esc(r.operation)}</span>
      <span class="activity-count">${esc(Number(r.count).toLocaleString())}</span>
    </div>
  `).join("");
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

async function loadAuditLog() {
  const el = document.getElementById("audit-list");
  try {
    const data = await apiFetch("/pro/audit-log/json");
    const logs = (data.logs || []).slice(0, 10);
    if (!logs.length) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><p>No audit events yet</p></div>';
      return;
    }
    el.innerHTML = `
      <div style="overflow:auto;">
        <table class="audit-table">
          <thead><tr><th>Time</th><th>Operation</th><th>DID</th><th>Status</th></tr></thead>
          <tbody>
            ${logs.map(r => `
              <tr>
                <td class="time-cell">${esc(String(r.timestamp).slice(11, 19))}</td>
                <td><span class="op-pill ${opClass(r.operation)}">${esc(r.operation)}</span></td>
                <td class="did-mono">${esc(shortDid(r.did))}</td>
                <td class="${r.status === "ok" ? "status-ok" : "status-invalid"}">${esc(r.status)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load audit log</p></div>';
  }
}

// ── AGENTS TABLE ──────────────────────────────────────────────────────────────

let _allAgents = [];   // cached for client-side search

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
  return `<tr
    data-name="${esc(a.name.toLowerCase())}"
    data-did="${esc((a.did || "").toLowerCase())}"
    data-caps="${esc(capsArr.join(" ").toLowerCase())}">
    <td class="agent-name">${esc(a.name)}</td>
    <td class="did-mono" title="${esc(a.did || "")}">${esc(shortDid(a.did))}</td>
    <td>${caps || '<span style="color:var(--muted);font-size:0.8rem;">none</span>'}</td>
    <td style="text-align:center;font-weight:600;">${esc(String(a.audit_events ?? 0))}</td>
    <td class="${lastActiveClass}">${esc(lastActiveStr)}</td>
    <td style="color:var(--muted);font-size:0.78rem;">${esc(createdStr)}</td>
    <td>${privacyBtn}</td>
  </tr>`;
}

function _applyAgentSearch() {
  const q      = (document.getElementById("agent-search")?.value || "").trim().toLowerCase();
  const mode   = document.querySelector(".search-tag-active")?.dataset.mode || "all";
  const status = document.getElementById("agent-search-status");
  const tbody  = document.querySelector("#agents-table tbody");
  const label  = document.getElementById("agents-count-label");
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll("tr"));
  let visible = 0;

  rows.forEach(row => {
    if (!q) {
      row.classList.remove("agent-row-hidden", "agent-row-highlight");
      visible++;
      return;
    }
    const name = row.dataset.name || "";
    const did  = row.dataset.did  || "";
    const caps = row.dataset.caps || "";

    let match = false;
    if (mode === "all")  match = name.includes(q) || did.includes(q) || caps.includes(q);
    if (mode === "name") match = name.includes(q);
    if (mode === "did")  match = did.includes(q);
    if (mode === "cap")  match = caps.split(" ").some(c => c.includes(q));

    row.classList.toggle("agent-row-hidden",    !match);
    row.classList.toggle("agent-row-highlight",  match && q.length > 0);
    if (match) visible++;
  });

  const total = _allAgents.length;
  if (q) {
    label.textContent = `${visible} of ${total} agent${total !== 1 ? "s" : ""}`;
    status.textContent = visible === 0
      ? `No agents match "${q}" — try a different term or switch filter`
      : `${visible} result${visible !== 1 ? "s" : ""} for "${q}"`;
  } else {
    label.textContent = `${total} agent${total !== 1 ? "s" : ""}`;
    status.textContent = "";
  }
}

function _initAgentSearch() {
  const input = document.getElementById("agent-search");
  const tags  = document.querySelectorAll(".search-tag");
  if (!input) return;

  input.addEventListener("input", _applyAgentSearch);

  // Clear on Escape
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; _applyAgentSearch(); input.blur(); }
  });

  // Mode pills
  tags.forEach(tag => {
    tag.addEventListener("click", () => {
      tags.forEach(t => t.classList.remove("search-tag-active"));
      tag.classList.add("search-tag-active");
      _applyAgentSearch();
      input.focus();
    });
  });
}

function _initPrivacyToggles() {
  const el = document.getElementById("agents-table");
  if (!el) return;
  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".privacy-toggle");
    if (!btn) return;
    const did        = btn.dataset.did;
    const isPrivate  = btn.dataset.private === "true";
    const newPrivate = !isPrivate;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await fetch(
        `${BASE}/agents/${encodeURIComponent(did)}/visibility?private=${newPrivate}`,
        { method: "PATCH", headers: { "x-api-key": apiKey } }
      );
      if (!res.ok) throw new Error((await res.json()).detail || res.status);
      // Update button in place without full reload
      btn.dataset.private = String(newPrivate);
      btn.title     = newPrivate ? "Private — click to make public" : "Public — click to make private";
      btn.style.border     = `1px solid ${newPrivate ? "var(--yellow)" : "var(--border-dark)"}`;
      btn.style.background = newPrivate ? "var(--yellow-bg)" : "var(--surface2)";
      btn.style.color      = newPrivate ? "var(--yellow)" : "var(--muted)";
      btn.textContent      = newPrivate ? "🔒 private" : "🌐 public";
    } catch (e) {
      btn.textContent = "error";
      setTimeout(() => {
        btn.textContent = isPrivate ? "🔒 private" : "🌐 public";
        btn.disabled = false;
      }, 1500);
      return;
    }
    btn.disabled = false;
  });
}

async function loadAgentsTable() {
  const el    = document.getElementById("agents-table");
  const label = document.getElementById("agents-count-label");
  try {
    const data = await apiFetch("/pro/analytics/agents");
    _allAgents = data.agents || [];

    label.textContent = `${_allAgents.length} agent${_allAgents.length !== 1 ? "s" : ""}`;

    if (!_allAgents.length) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">🤖</div><p>No agents registered yet</p></div>';
      return;
    }

    el.innerHTML = `
      <div style="overflow:auto;">
        <table class="agents-table">
          <thead><tr>
            <th>Name</th>
            <th>DID</th>
            <th>Capabilities</th>
            <th>Audit Events</th>
            <th>Last Active</th>
            <th>Registered</th>
            <th>Visibility</th>
          </tr></thead>
          <tbody>${_allAgents.map(_renderAgentRow).join("")}</tbody>
        </table>
      </div>`;

    // Re-apply any pending search query (e.g. user typed before data loaded)
    _applyAgentSearch();

    // Initialise search + privacy controls once per load
    _initAgentSearch();
    _initPrivacyToggles();

  } catch {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load agents</p></div>';
  }
}

// ── SIGNING ACTIVITY ──────────────────────────────────────────────────────────

const _signing = { page: 1, pages: 1, total: 0, perPage: 50, didQuery: "" };

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
        <td colspan="6" style="padding:0.75rem 1rem;border-bottom:1px solid var(--border);">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.75rem;">
            <div>
              <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:0.2rem;">💬 Message</div>
              <div style="font-size:0.8rem;color:var(--text-2);">${summary || "—"}</div>
            </div>
            <div>
              <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:0.2rem;">📋 Signed Payload</div>
              <pre style="font-size:0.72rem;font-family:'JetBrains Mono',monospace;color:var(--text-2);white-space:pre-wrap;line-height:1.5;margin:0;">${payloadJson}</pre>
            </div>
            <div style="grid-column:1/-1;">
              <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:0.2rem;">
                🔏 Signature
                ${e.signature ? `<button data-copy="${i}" style="background:none;border:1px solid var(--border-dark);border-radius:5px;padding:0.1rem 0.45rem;font-size:0.7rem;cursor:pointer;color:var(--muted);margin-left:0.4rem;">copy</button>` : ""}
              </div>
              <div data-sig="${i}" style="font-size:0.72rem;font-family:'JetBrains Mono',monospace;color:var(--text-2);word-break:break-all;">${sigFull}</div>
            </div>
          </div>
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
    const copyBtn = ev.target.closest("[data-copy]");
    if (copyBtn) {
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
    const qParam = _signing.didQuery
      ? `&q=${encodeURIComponent(_signing.didQuery)}`
      : "";
    const data = await apiFetch(
      `/pro/analytics/signing?page=${_signing.page}&per_page=${_signing.perPage}${qParam}`
    );
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

async function loadAnomalies() {
  const el = document.getElementById("anomaly-list");
  if (!el) return;
  try {
    const data = await apiFetch("/pro/anomalies");
    const anomalies = data.anomalies || [];
    if (!anomalies.length) {
      el.innerHTML = `<div class="anomaly-clear">
        <span style="font-size:1.2rem;">✅</span>
        <span>No anomalies detected</span>
      </div>`;
      return;
    }
    el.innerHTML = anomalies.map(a => {
      const sev = a.severity || "low";
      const sevColor = sev === "high" ? "var(--red)" : sev === "medium" ? "var(--yellow)" : "var(--blue)";
      const sevBg    = sev === "high" ? "var(--red-bg)" : sev === "medium" ? "var(--yellow-bg)" : "var(--blue-bg)";
      return `<div class="anomaly-card" style="border-left:3px solid ${sevColor};background:${sevBg};border-radius:6px;padding:0.6rem 0.9rem;margin-bottom:0.5rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.2rem;">
          <span style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${sevColor};border:1px solid ${sevColor};border-radius:999px;padding:0.1rem 0.45rem;">${esc(sev)}</span>
          <span style="font-weight:600;font-size:0.88rem;">${esc(a.title)}</span>
        </div>
        <p style="font-size:0.8rem;color:var(--text-2);margin:0;">${esc(a.description)}</p>
      </div>`;
    }).join("");
  } catch {
    if (el) el.innerHTML = `<div class="anomaly-clear" style="color:var(--muted);font-size:0.8rem;">Could not load anomaly data</div>`;
  }
}

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

function startSse() {
  if (!apiKey) return;
  stopSse();

  const url = `${BASE}/pro/stream?api_key=${encodeURIComponent(apiKey)}`;
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
  const wrap = document.getElementById("account-info-rows");
  if (!wrap) return;
  try {
    const data = await apiFetch("/pro/keys/me");
    const rows = [
      ["Owner",       esc(data.owner),      false],
      ["Tier",        esc(data.tier),        false],
      ["Label",       esc(data.label || "—"), false],
      ["Created",     esc(String(data.created_at || "—").slice(0, 10)), false],
      ["Scopes",      data.scopes ? esc(data.scopes) : "full access", false],
      ["IP Allowlist",data.allowed_ips ? esc(data.allowed_ips) : "unrestricted", true],
    ];
    wrap.innerHTML = rows.map(([k, v, mono]) =>
      `<div class="info-row">
        <span class="info-key">${k}</span>
        <span class="info-val${mono ? " mono" : ""}">${v}</span>
       </div>`
    ).join("");

    // Pre-fill allowlist textarea
    const ta = document.getElementById("allowlist-input");
    if (ta) ta.value = data.allowed_ips || "";
  } catch {
    wrap.innerHTML = `<div class="info-row"><span class="info-key" style="color:var(--red);">Could not load key info</span></div>`;
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
            <div style="display:flex;gap:0.3rem;">
              <button class="btn btn-outline" data-wh-test="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Test</button>
              <button class="btn btn-outline" data-wh-toggle="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;">${wh.active ? "Disable" : "Enable"}</button>
              <button class="btn btn-outline" data-wh-delete="${wh.id}" style="font-size:0.7rem;padding:0.2rem 0.5rem;color:var(--red);border-color:var(--red);">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");

    // Wire up action buttons
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

function openSettings() {
  document.getElementById("settings-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
  // Always reload account info when modal opens
  _loadAccountInfo();
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
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  _initSigningPager();   // one-time — survives every table redraw
  _initSigningSearch();  // one-time — survives every table redraw

  document.getElementById("login-btn").addEventListener("click", login);
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("api-key-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  document.getElementById("refresh-btn").addEventListener("click", () => {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    if (capChart)   { capChart.destroy();   capChart = null; }
    loadDashboard();
  });

  // ── Settings modal ──────────────────────────────────────────────────────────
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);

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

  // Account tab actions
  document.getElementById("allowlist-save-btn").addEventListener("click", _saveAllowlist);

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

  // Auto-login if key in sessionStorage and session not expired
  if (apiKey) {
    if (getSessionAge() >= SESSION_TTL_MS) {
      expireSession();
    } else {
      loadDashboard()
        .then(() => scheduleSessionExpiry())
        .catch(() => {
          sessionStorage.removeItem("agentid_key");
          sessionStorage.removeItem("agentid_login_ts");
          apiKey = "";
        });
    }
  }
});
