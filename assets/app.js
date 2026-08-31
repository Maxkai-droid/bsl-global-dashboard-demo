"use strict";

const closedStates = new Set(["closed", "resolved", "done", "completed"]);
const filters = { query: "", site: "", block: "", state: "", classification: "", focus: "" };
let allItems = [];
let siteChart;
let trendChart;
let siteChartMode = "issues";

const text = (value) => document.createTextNode(String(value ?? ""));
const setText = (id, value) => { document.getElementById(id).textContent = value; };
const countBy = (items, key) => items.reduce((counts, item) => {
  const value = item[key] || "Not identified";
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});
const topEntry = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

function isOpen(item) {
  return !closedStates.has(String(item.state || "").toLowerCase());
}

function severityClass(value) {
  if (String(value).startsWith("1")) return "critical";
  if (String(value).startsWith("2")) return "high";
  if (String(value).startsWith("3")) return "medium";
  return "low";
}

function attention(item) {
  let score = 0;
  if (isOpen(item)) {
    score += String(item.severity).startsWith("1") ? 4 : String(item.severity).startsWith("2") ? 2 : 0;
    score += item.age_days > 14 ? 2 : item.age_days > 7 ? 1 : 0;
    score += item.ai_review ? 1 : 0;
  }
  return score >= 5 ? "high" : score >= 3 ? "watch" : "routine";
}

function filteredItems() {
  const query = filters.query.toLowerCase();
  return allItems.filter((item) => {
    if (filters.site && item.site !== filters.site) return false;
    if (filters.block && item.building_block !== filters.block) return false;
    if (filters.state && item.state !== filters.state) return false;
    if (filters.classification && item.classification !== filters.classification) return false;
    if (filters.focus === "critical" && !(isOpen(item) && String(item.severity).startsWith("1"))) return false;
    if (filters.focus === "ai" && !item.ai_review) return false;
    if (filters.focus === "aged" && item.age_days <= 14) return false;
    return !query || Object.values(item).join(" ").toLowerCase().includes(query);
  });
}

function populateSelect(id, key) {
  const select = document.getElementById(id);
  [...new Set(allItems.map((item) => item[key]).filter(Boolean))].sort().forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.append(text(value));
    select.append(option);
  });
}

function renderCards(items) {
  const open = items.filter(isOpen);
  const critical = open.filter((item) => String(item.severity).startsWith("1")).length;
  const aiReview = items.filter((item) => item.ai_review).length;
  const falseFailures = items.filter((item) => item.classification === "False failure").length;
  const bslInduced = items.filter((item) => item.classification === "BSL-induced failure").length;
  const unclassified = items.filter((item) => item.classification === "Unclassified").length;
  const quantity = items.reduce((sum, item) => sum + Number(item.units_impacted || 0), 0);
  const highAttention = items.filter((item) => attention(item) === "high").length;
  const classified = items.length - unclassified;

  setText("scope-count", items.length);
  setText("scope-label", items.length);
  setText("kpi-open", open.length);
  setText("kpi-critical", critical);
  setText("kpi-new", items.filter((item) => item.created_this_week).length);
  setText("kpi-closed", items.filter((item) => item.closed_this_week).length);
  setText("assessed-count", items.length);

  const impact = [
    ["False failures", falseFailures, "Confirmed classification"],
    ["BSL-induced", bslInduced, "Failures caused by BSL"],
    ["Quantity affected", quantity, "Synthetic units impacted"],
    ["Needs classification", unclassified, "Incomplete assessments"],
    ["AI review queue", aiReview, "Low-confidence analysis"],
    ["Published scope", items.length, "Read-only demo items"],
  ];
  const impactGrid = document.getElementById("impact-grid");
  impactGrid.replaceChildren(...impact.map(([label, value, detail]) => {
    const column = document.createElement("div");
    column.className = "col";
    column.innerHTML = `<div class="impact-metric"><small></small><strong></strong><span></span></div>`;
    column.querySelector("small").append(text(label));
    column.querySelector("strong").append(text(value));
    column.querySelector("span").append(text(detail));
    return column;
  }));

  const signals = [
    ["High attention", highAttention, "Severity, age, and evidence risk", "danger"],
    ["Classification coverage", items.length ? `${Math.round(classified * 100 / items.length)}%` : "0%", "Issues with AI classification", "info"],
    ["Repair coverage", items.length ? `${Math.round(items.filter((item) => item.repair_count).length * 100 / items.length)}%` : "0%", "Issues with at least one action", "success"],
    ["Aged open", open.filter((item) => item.age_days > 14).length, "Open more than 14 days", "warning"],
    ["AI review queue", aiReview, "Low-confidence or blocked analysis", "warning"],
  ];
  const decisionGrid = document.getElementById("decision-grid");
  decisionGrid.replaceChildren(...signals.map(([label, value, detail, style]) => {
    const column = document.createElement("div");
    column.className = "col";
    column.innerHTML = `<div class="decision-signal signal-${style}"><span></span><strong></strong><small></small></div>`;
    column.querySelector("span").append(text(label));
    column.querySelector("strong").append(text(value));
    column.querySelector("small").append(text(detail));
    return column;
  }));

  const failure = topEntry(countBy(items, "classification"));
  const block = topEntry(countBy(items, "building_block"));
  setText("top-failure", failure ? `${failure[0]} · ${failure[1]} issue(s)` : "Not identified");
  setText("top-block", block ? block[0] : "Not identified");
}

function renderTable(items) {
  const body = document.getElementById("items");
  body.replaceChildren();
  [...items].sort((a, b) => attention(a).localeCompare(attention(b))).forEach((item) => {
    const row = document.createElement("tr");
    const state = String(item.state || "").toLowerCase();
    row.className = closedStates.has(state) ? (state === "resolved" ? "state-resolved" : "state-closed") : "state-open";
    const ado = document.createElement("td");
    const marker = document.createElement("span");
    marker.className = `attention-marker ${attention(item)}`;
    ado.append(marker, text(item.ado_id));
    row.append(ado);
    [item.site, item.building_block].forEach((value) => {
      const cell = document.createElement("td");
      cell.append(text(value || "—"));
      row.append(cell);
    });
    const classification = document.createElement("td");
    const classificationBadge = document.createElement("span");
    classificationBadge.className = `classification${item.classification === "Unclassified" ? " unclassified" : ""}`;
    classificationBadge.append(text(item.classification));
    classification.append(classificationBadge);
    row.append(classification);
    [item.units_impacted || 0, item.repair_count || 0].forEach((value) => {
      const cell = document.createElement("td");
      cell.append(text(value));
      row.append(cell);
    });
    const ai = document.createElement("td");
    ai.append(text(item.ai_review ? "Needs review" : "Verified"));
    row.append(ai);
    const stateCell = document.createElement("td");
    const stateBadge = document.createElement("span");
    stateBadge.className = "state";
    stateBadge.append(text(item.state));
    stateCell.append(stateBadge);
    row.append(stateCell);
    const severity = document.createElement("td");
    const severityBadge = document.createElement("span");
    severityBadge.className = `severity ${severityClass(item.severity)}`;
    severityBadge.append(text(item.severity));
    severity.append(severityBadge);
    row.append(severity);
    const age = document.createElement("td");
    age.className = item.age_days > 30 && isOpen(item) ? "age-risk" : "";
    age.append(text(isOpen(item) ? `Age ${item.age_days}d` : `Resolved in ${item.age_days}d`));
    row.append(age);
    body.append(row);
  });
  document.getElementById("empty").hidden = items.length !== 0;
}

function renderHealth(items) {
  const container = document.getElementById("site-health");
  const sites = [...new Set(items.map((item) => item.site))].sort();
  container.replaceChildren(...sites.map((site) => {
    const rows = items.filter((item) => item.site === site);
    const open = rows.filter(isOpen);
    const critical = open.filter((item) => String(item.severity).startsWith("1")).length;
    const old = open.filter((item) => item.age_days > 30).length;
    const score = Math.max(0, 100 - critical * 18 - old * 10 - Math.max(0, open.length - 3) * 3);
    const status = score >= 80 ? ["Healthy", "green"] : score >= 60 ? ["Watch", "yellow"] : ["Risk", "red"];
    const common = topEntry(countBy(rows, "classification"));
    const column = document.createElement("div");
    column.className = "col";
    column.innerHTML = `<article class="health-card"><div><b></b><span class="pill ${status[1]}"></span></div><strong></strong><small></small><span class="site-failure-pattern"><b>Most common failure</b><span></span></span></article>`;
    column.querySelector("b").append(text(site));
    column.querySelector(".pill").append(text(status[0]));
    column.querySelector("strong").append(text(score));
    column.querySelector("small").append(text(`${open.length} open · ${critical} critical · ${old} over 30d`));
    column.querySelector(".site-failure-pattern span").append(text(common ? common[0] : "Not identified"));
    return column;
  }));
}

function renderCharts(items) {
  if (!window.Chart) return;
  const siteCounts = countBy(items, "site");
  const labels = Object.keys(siteCounts).sort();
  const current = new Date();
  current.setHours(0, 0, 0, 0);
  current.setDate(current.getDate() - ((current.getDay() + 6) % 7) - 35);
  const weeks = Array.from({ length: 6 }, (_, index) => {
    const start = new Date(current);
    start.setDate(start.getDate() + index * 7);
    return start.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  });
  const weekly = weeks.map((_, index) => items.filter((item) => Number(item.week_index) === index).length);
  if (siteChart) siteChart.destroy();
  if (trendChart) trendChart.destroy();
  Chart.defaults.font.family = '"Segoe UI",system-ui,sans-serif';
  Chart.defaults.color = "#667085";
  const siteValues = labels.map((label) => items
    .filter((item) => item.site === label)
    .reduce((sum, item) => sum + Number(item.units_impacted || 0), 0));
  siteChart = new Chart(document.getElementById("site-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: siteChartMode === "issues" ? labels.map((label) => siteCounts[label]) : siteValues,
        backgroundColor: siteChartMode === "issues" ? "#0b5ed7" : "#d97706",
        borderRadius: 7,
        maxBarThickness: 48,
      }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  trendChart = new Chart(document.getElementById("trend-chart"), {
    type: "line",
    data: { labels: weeks, datasets: [{ data: weekly, borderColor: "#087990", backgroundColor: "rgba(8,121,144,.12)", fill: true, tension: .35, pointRadius: 5, pointBackgroundColor: "#087990" }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
}

function render() {
  const items = filteredItems();
  document.querySelectorAll("[data-focus]").forEach((button) => button.classList.toggle("active", button.dataset.focus === filters.focus));
  renderCards(items);
  renderTable(items);
  renderHealth(items);
  renderCharts(items);
}

const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function decryptSnapshot(password) {
  const response = await fetch("data/dashboard.enc.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const envelope = await response.json();
  if (
    envelope.algorithm !== "AES-256-GCM"
    || envelope.kdf !== "PBKDF2-SHA256"
    || Number(envelope.iterations) < 210000
  ) {
    throw new Error("Unsupported encrypted snapshot");
  }

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromBase64(envelope.salt),
      iterations: Number(envelope.iterations),
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const ciphertext = fromBase64(envelope.ciphertext);
  const tag = fromBase64(envelope.tag);
  const encrypted = new Uint8Array(ciphertext.length + tag.length);
  encrypted.set(ciphertext);
  encrypted.set(tag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(envelope.nonce),
      additionalData: new TextEncoder().encode(envelope.additional_data),
      tagLength: 128,
    },
    key,
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function startDashboard(snapshot) {
  allItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  setText("generated-at", new Date(snapshot.generated_at).toLocaleString());
  setText("source-revision", snapshot.source_revision);
  setText("published-count", allItems.length);
  setText("total-count", allItems.length);
  populateSelect("site-filter", "site");
  populateSelect("block-filter", "building_block");
  populateSelect("state-filter", "state");
  populateSelect("class-filter", "classification");
  document.getElementById("login-screen").hidden = true;
  document.getElementById("dashboard-shell").hidden = false;
  render();
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById("login-error");
  error.hidden = true;
  const password = form.elements.password.value;
  try {
    startDashboard(await decryptSnapshot(password));
    form.reset();
  } catch (_error) {
    error.hidden = false;
    form.elements.password.value = "";
    form.elements.password.focus();
  }
});

document.getElementById("search").addEventListener("input", (event) => { filters.query = event.target.value.trim(); render(); });
document.getElementById("site-filter").addEventListener("change", (event) => { filters.site = event.target.value; render(); });
document.getElementById("block-filter").addEventListener("change", (event) => { filters.block = event.target.value; render(); });
document.getElementById("state-filter").addEventListener("change", (event) => { filters.state = event.target.value; render(); });
document.getElementById("class-filter").addEventListener("change", (event) => { filters.classification = event.target.value; render(); });
document.querySelectorAll("[data-focus]").forEach((button) => button.addEventListener("click", () => {
  filters.focus = filters.focus === button.dataset.focus ? "" : button.dataset.focus;
  render();
}));
document.getElementById("reset-filters").addEventListener("click", () => {
  Object.keys(filters).forEach((key) => { filters[key] = ""; });
  document.getElementById("dashboard-filters").reset();
  render();
});
document.getElementById("issues-created-tab").addEventListener("click", () => {
  siteChartMode = "issues";
  document.getElementById("issues-created-tab").classList.add("active");
  document.getElementById("issues-created-tab").setAttribute("aria-selected", "true");
  document.getElementById("units-affected-tab").classList.remove("active");
  document.getElementById("units-affected-tab").setAttribute("aria-selected", "false");
  renderCharts(filteredItems());
});
document.getElementById("units-affected-tab").addEventListener("click", () => {
  siteChartMode = "units";
  document.getElementById("units-affected-tab").classList.add("active");
  document.getElementById("units-affected-tab").setAttribute("aria-selected", "true");
  document.getElementById("issues-created-tab").classList.remove("active");
  document.getElementById("issues-created-tab").setAttribute("aria-selected", "false");
  renderCharts(filteredItems());
});
