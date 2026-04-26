const BASE = "https://api.agentid-protocol.com";
// SEC: sessionStorage — cleared when tab closes, not accessible cross-tab
let apiKey = sessionStorage.getItem("agentid_key") || "";
let trendChart, capChart;

// SEC: HTML escape — all API-sourced strings pass through before innerHTML
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

// SEC: allowlist — unknown operations get no CSS class
function opClass(op) { return OP_CLASS[String(op)] || ""; }

function shortDid(did) {
  if (!did) return "—";
  const s = String(did);
  return s.length > 26 ? s.slice(0, 14) + "…" + s.slice(-8) : s;
}

// SEC: allowlist tier values — never interpolate raw API tier into class names
function tierClass(tier) {
  return { enterprise: "tier-enterprise", pro: "tier-pro", free: "tier-free" }[String(tier)] || "tier-free";
}

async function apiFetch(path) {
  const res = await fetch(BASE + path, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

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

  // Show loading state on button
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

async function loadDashboard() {
  const data = await apiFetch("/pro/analytics/overview");

  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("logout-btn").style.display = "flex";

  // SEC: textContent for simple strings — no HTML parsing
  document.getElementById("dash-title").textContent = data.owner;
  document.getElementById("dash-sub").textContent = "Pro analytics dashboard";

  // SEC: tier is allowlisted via tierClass(); textContent guards the value
  const tierEl = document.createElement("span");
  tierEl.className = "tier-badge " + tierClass(data.tier);
  tierEl.textContent = data.tier;
  const tierWrap = document.getElementById("tier-badge-wrap");
  tierWrap.textContent = "";
  tierWrap.appendChild(tierEl);

  const totalActivity = (data.activity_last_7d || []).reduce((s, r) => s + r.count, 0);
  document.getElementById("stat-agents").textContent = data.usage.agents_registered;
  document.getElementById("stat-events").textContent = data.usage.audit_events;
  document.getElementById("stat-active").textContent = totalActivity;
  document.getElementById("stat-caps").textContent = (data.top_capabilities || []).length;

  loadBadge(data.owner);

  // Trend chart
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
        borderWidth: 1.5,
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#78716C", font: { size: 10, family: "Inter" }, maxRotation: 0, maxTicksLimit: 8 }, grid: { color: "#F2F0EC" }, border: { color: "#E5E2DB" } },
        y: { ticks: { color: "#78716C", font: { size: 10, family: "Inter" }, stepSize: 1 }, grid: { color: "#F2F0EC" }, border: { color: "#E5E2DB" }, beginAtZero: true },
      }
    }
  });

  // Capabilities chart
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
      datasets: [{
        data: capData.length ? capData : [0],
        backgroundColor: capColors,
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#78716C", font: { size: 10, family: "Inter" }, stepSize: 1 }, grid: { color: "#F2F0EC" }, border: { color: "#E5E2DB" }, beginAtZero: true },
        y: { ticks: { color: "#44403C", font: { size: 11, family: "Inter" } }, grid: { display: false }, border: { display: false } },
      }
    }
  });

  // Activity
  const actEl = document.getElementById("activity-list");
  const activity = data.activity_last_7d || [];
  if (!activity.length) {
    actEl.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>No activity in the last 7 days</p></div>';
  } else {
    actEl.innerHTML = activity.map(r => `
      <div class="activity-row">
        <span class="op-pill ${opClass(r.operation)}">${esc(r.operation)}</span>
        <span class="activity-count">${esc(Number(r.count).toLocaleString())}</span>
      </div>
    `).join("");
  }

  loadAuditLog();
}

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
          <thead><tr>
            <th>Time</th><th>Operation</th><th>DID</th><th>Status</th>
          </tr></thead>
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

// Attach all event listeners — no inline handlers in HTML
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("login-btn").addEventListener("click", login);
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("api-key-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });

  // Auto-login if key already in sessionStorage
  if (apiKey) {
    loadDashboard().catch(() => {
      sessionStorage.removeItem("agentid_key");
      apiKey = "";
    });
  }
});
