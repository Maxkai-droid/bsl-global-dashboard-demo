"use strict";

const text = (value) => document.createTextNode(String(value ?? ""));
const cells = ["ado_id", "site", "building_block", "state", "severity", "classification"];
let snapshotItems = [];

function render(items) {
  const body = document.getElementById("items");
  body.replaceChildren();
  for (const item of items) {
    const row = document.createElement("tr");
    for (const key of cells) {
      const cell = document.createElement("td");
      cell.append(text(item[key]));
      row.append(cell);
    }
    const age = document.createElement("td");
    age.className = "number";
    age.append(text(`${item.age_days}d`));
    row.append(age);
    body.append(row);
  }
  document.getElementById("empty").hidden = items.length !== 0;
}

function applyFilter() {
  const query = document.getElementById("filter").value.trim().toLowerCase();
  if (!query) {
    render(snapshotItems);
    return;
  }
  render(snapshotItems.filter((item) => Object.values(item).join(" ").toLowerCase().includes(query)));
}

fetch("data/dashboard.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((snapshot) => {
    document.getElementById("metric-total").textContent = snapshot.metrics.total;
    document.getElementById("metric-open").textContent = snapshot.metrics.open;
    document.getElementById("metric-critical").textContent = snapshot.metrics.critical;
    document.getElementById("metric-ai-review").textContent = snapshot.metrics.ai_review;
    document.getElementById("freshness").textContent =
      `Generated ${new Date(snapshot.generated_at).toLocaleString()} · revision ${snapshot.source_revision}`;
    snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
    render(snapshotItems);
  })
  .catch((error) => {
    document.getElementById("freshness").textContent = `Snapshot unavailable: ${error.message}`;
  });

document.getElementById("filter").addEventListener("input", applyFilter);
