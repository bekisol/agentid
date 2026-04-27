const BASE = "https://api.agentid-protocol.com";
let apiKey = sessionStorage.getItem("agentid_key") || "";
let trendChart, capChart;

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
  apiKey = "";
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

  // ── Export CSV ──────────────────────────────────────────────────────────────
  const csvBtn = document.getElementById("csv-btn");
  csvBtn.addEventListener("click", async () => {
    const original = csvBtn.textContent;
    csvBtn.textContent = "Exporting…";
    csvBtn.disabled = true;
    try {
      const res = await fetch(`${BASE}/pro/audit-log/csv`, { headers: { "x-api-key": apiKey } });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "audit-log.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch { alert("Could not export CSV — please try again."); }
    finally {
      csvBtn.textContent = original;
      csvBtn.disabled = false;
    }
  });

  // ── PDF Report ───────────────────────────────────────────────────────────────
  const pdfBtn = document.getElementById("pdf-btn");
  pdfBtn.addEventListener("click", async () => {
    const original = pdfBtn.textContent;
    pdfBtn.textContent = "Generating…";
    pdfBtn.disabled = true;
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
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (e.message === "403") {
        alert("PDF reports require a Pro or Enterprise plan.");
      } else {
        alert("Could not generate PDF — please try again.");
      }
    } finally {
      pdfBtn.textContent = original;
      pdfBtn.disabled = false;
    }
  });
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

async function loadAgentsTable() {
  const el = document.getElementById("agents-table");
  const label = document.getElementById("agents-count-label");
  try {
    const data = await apiFetch("/pro/analytics/agents");
    const agents = data.agents || [];

    label.textContent = `${agents.length} agent${agents.length !== 1 ? "s" : ""}`;

    if (!agents.length) {
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
          <tbody>
            ${agents.map(a => {
              const caps = (Array.isArray(a.capabilities) ? a.capabilities : [])
                .slice(0, 4)
                .map(c => `<span class="cap-pill">${esc(String(c))}</span>`)
                .join("") + (a.capabilities && a.capabilities.length > 4
                  ? `<span class="cap-pill">+${a.capabilities.length - 4}</span>` : "");

              const lastActiveStr = a.last_activity ? timeAgo(a.last_activity) : "—";
              const lastActiveClass = a.last_activity &&
                (Date.now() - new Date(a.last_activity).getTime()) < 86400000 * 7
                ? "last-active-fresh" : "last-active-old";

              const createdStr = a.created_at ? new Date(a.created_at).toLocaleDateString("en-US", {
                month: "short", day: "numeric", year: "numeric"
              }) : "—";

              return `<tr>
                <td class="agent-name">${esc(a.name)}</td>
                <td class="did-mono">${esc(shortDid(a.did))}</td>
                <td>${caps || '<span style="color:var(--muted);font-size:0.8rem;">none</span>'}</td>
                <td style="text-align:center;font-weight:600;">${esc(String(a.audit_events ?? 0))}</td>
                <td class="${lastActiveClass}">${esc(lastActiveStr)}</td>
                <td style="color:var(--muted);font-size:0.78rem;">${esc(createdStr)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load agents</p></div>';
  }
}

// ── SIGNING ACTIVITY ──────────────────────────────────────────────────────────

async function loadSigningActivity() {
  const el    = document.getElementById("signing-table");
  const label = document.getElementById("signing-count-label");
  try {
    const data   = await apiFetch("/pro/analytics/signing");
    const events = data.events || [];

    label.textContent = `${events.length} event${events.length !== 1 ? "s" : ""}`;

    if (!events.length) {
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
        <table class="agents-table">
          <thead><tr>
            <th>Time</th>
            <th>Signer</th>
            <th style="padding-left:0.5rem;padding-right:0.5rem;color:var(--muted);">→</th>
            <th>Verified By</th>
            <th>Result</th>
          </tr></thead>
          <tbody>
            ${events.map(e => {
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

              const isValid   = e.status === "valid";
              const statusCls = isValid ? "status-ok" : "status-invalid";
              const statusLbl = isValid ? "✓ valid" : "✗ invalid";
              const timeStr   = e.timestamp ? String(e.timestamp).slice(11, 19) : "—";

              return `<tr>
                <td class="time-cell">${esc(timeStr)}</td>
                <td>${signerCell}</td>
                <td style="text-align:center;color:var(--muted);font-size:1rem;">→</td>
                <td>${verifierCell}</td>
                <td class="${statusCls}" style="font-size:0.8rem;">${statusLbl}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
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

  // Auto-login if key in sessionStorage
  if (apiKey) {
    loadDashboard().catch(() => {
      sessionStorage.removeItem("agentid_key");
      apiKey = "";
    });
  }
});
