const BASE = "https://api.agentid-protocol.com";

// ── SECURE KEY STORAGE ────────────────────────────────────────────────────────
// Key lives in sessionStorage (tab-scoped, cleared on browser close, not
// readable across origins). A short-lived localStorage pulse lets new tabs
// inherit an active session without permanently storing the raw key.
let apiKey = sessionStorage.getItem("agentid_key") || "";

// If this tab has no key yet, request one from a sibling tab.
if (!apiKey) {
  localStorage.setItem("agentid_tab_ping", String(Date.now()));
  localStorage.removeItem("agentid_tab_ping");
}

// Listen for sibling tabs broadcasting a key in response to a ping,
// or sharing a fresh login.
window.addEventListener("storage", (ev) => {
  if (ev.key === "agentid_tab_sync" && ev.newValue) {
    try {
      const { key, ts } = JSON.parse(ev.newValue);
      // Only accept a sync that arrived within the last 2 seconds
      if (key && Date.now() - ts < 2000 && !apiKey) {
        apiKey = key;
        sessionStorage.setItem("agentid_key", key);
        sessionStorage.setItem("agentid_login_ts",
          sessionStorage.getItem("agentid_login_ts") || String(ts));
        loadDashboard().then(() => scheduleSessionExpiry());
      }
    } catch { /* ignore malformed events */ }
  }
  if (ev.key === "agentid_tab_ping" && apiKey) {
    // A new tab is asking for the key — respond once
    const payload = JSON.stringify({ key: apiKey, ts: Date.now() });
    localStorage.setItem("agentid_tab_sync", payload);
    // Remove after a tick so the event fires in the new tab
    setTimeout(() => localStorage.removeItem("agentid_tab_sync"), 200);
  }
});

let trendChart, capChart;

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
    // Broadcast to any new tabs that open while this session is active
    const sync = JSON.stringify({ key: apiKey, ts: Date.now() });
    localStorage.setItem("agentid_tab_sync", sync);
    setTimeout(() => localStorage.removeItem("agentid_tab_sync"), 200);
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
          </tr></thead>
          <tbody>${_allAgents.map(_renderAgentRow).join("")}</tbody>
        </table>
      </div>`;

    // Re-apply any pending search query (e.g. user typed before data loaded)
    _applyAgentSearch();

    // Initialise search controls once per load
    _initAgentSearch();

  } catch {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load agents</p></div>';
  }
}

// ── SIGNING ACTIVITY ──────────────────────────────────────────────────────────

const _signing = { page: 1, pages: 1, total: 0, perPage: 50 };

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
    const summary     = esc(payloadSummary(e.payload));
    const payloadJson = e.payload   ? esc(JSON.stringify(e.payload, null, 2)) : "—";
    const sigFull     = e.signature ? esc(e.signature) : "—";

    const signerToken   = `${(e.signer_name||"").toLowerCase()} ${(e.signer_did||"").toLowerCase()}`;
    const verifierToken = `${(e.verifier_name||"").toLowerCase()} ${(e.verifier_did||"").toLowerCase()}`;
    const msgToken      = payloadSummary(e.payload).toLowerCase();
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
                <button data-copy="${i}" style="background:none;border:1px solid var(--border-dark);border-radius:5px;padding:0.1rem 0.45rem;font-size:0.7rem;cursor:pointer;color:var(--muted);margin-left:0.4rem;">copy</button>
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

function _applySigningSearch() {
  const q      = (document.getElementById("signing-search")?.value || "").trim().toLowerCase();
  const mode   = document.querySelector(".search-tag-active[data-smode]")?.dataset.smode || "all";
  const status = document.getElementById("signing-search-status");
  const tbody  = document.getElementById("signing-tbody");
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
    } else {
      if (mode === "all")      match = row.dataset.signer.includes(q) || row.dataset.verifier.includes(q) || row.dataset.msg.includes(q);
      if (mode === "signer")   match = row.dataset.signer.includes(q);
      if (mode === "verifier") match = row.dataset.verifier.includes(q);
      if (mode === "msg")      match = row.dataset.msg.includes(q);
    }

    row.classList.toggle("agent-row-hidden", !match);
    row.classList.toggle("agent-row-highlight", match && (q.length > 0 || mode === "invalid"));
    if (detail) detail.classList.toggle("agent-row-hidden", !match);
    if (match) visible++;
  });

  const total = rows.length;
  if (q || mode === "invalid") {
    status.textContent = visible === 0
      ? `No events match — try a different term or filter`
      : `${visible} of ${total} events on this page`;
  } else {
    status.textContent = "";
  }
}

function _initSigningSearch() {
  const input = document.getElementById("signing-search");
  const tags  = document.querySelectorAll(".search-tag[data-smode]");
  if (!input) return;

  input.addEventListener("input", _applySigningSearch);
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; _applySigningSearch(); input.blur(); }
  });

  tags.forEach(tag => {
    tag.addEventListener("click", () => {
      tags.forEach(t => t.classList.remove("search-tag-active"));
      tag.classList.add("search-tag-active");
      _applySigningSearch();
      if (tag.dataset.smode !== "invalid") input.focus();
    });
  });
}

async function loadSigningActivity() {
  const el    = document.getElementById("signing-table");
  const label = document.getElementById("signing-count-label");
  try {
    const data = await apiFetch(
      `/pro/analytics/signing?page=${_signing.page}&per_page=${_signing.perPage}`
    );
    const events = data.events || [];

    // Sync pagination state from server response
    _signing.total  = data.total  ?? events.length;
    _signing.pages  = data.pages  ?? 1;
    _signing.page   = data.page   ?? _signing.page;

    label.textContent = `${_signing.total} event${_signing.total !== 1 ? "s" : ""}`;

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
