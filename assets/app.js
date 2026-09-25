"use strict";

const payloadFailureReasons = new Set([
  "image_evidence_review_required",
  "prompt_guard_blocked",
  "analysis_failed",
]);
const payloadProhibitedKeys = new Set([
  "agent_output",
  "error_message",
  "injection_detected",
  "evidence_images",
]);
const payloadFailureClasses = new Set([
  "Unclassified",
  "True failure",
  "False failure",
  "BSL-induced failure",
  "Supplier/process-induced failure",
  "Undetermined",
]);
const payloadValidationStatuses = new Set([
  "Pending",
  "Under review",
  "Confirmed",
  "Closed",
]);

function payloadError(path, message) {
  throw new Error(`${path}: ${message}`);
}

function exactObject(value, path, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    payloadError(path, "must be an object");
  }
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) payloadError(`${path}.${key}`, "is not allowlisted");
  });
  required.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      payloadError(path, `missing ${key}`);
    }
  });
}

function boundedString(value, path, maximum, pattern = null) {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    payloadError(path, "must be bounded printable text");
  }
  if (pattern && !pattern.test(value)) payloadError(path, "has invalid format");
}

function boundedInteger(value, path, minimum = 0, maximum = 2147483647) {
  if (!Number.isInteger(value) || typeof value === "boolean" || value < minimum || value > maximum) {
    payloadError(path, "must be a bounded integer");
  }
}

function boundedNumber(value, path, minimum = 0, maximum = 1e9) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    payloadError(path, "must be a bounded finite number");
  }
}

function utcTimestamp(value, path, allowEmpty = false) {
  boundedString(value, path, 40);
  if (allowEmpty && !value) return;
  if (!(value.endsWith("Z") || value.endsWith("+00:00")) || Number.isNaN(Date.parse(value))) {
    payloadError(path, "must be a UTC timestamp");
  }
}

function canonicalAdoUrl(value, path, adoId, evidence = false) {
  boundedString(value, path, 2048);
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    payloadError(path, "must be a URL");
  }
  const host = url.hostname.toLowerCase();
  const allowedHost = host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  const allowedPath = evidence
    ? /\/_apis\/wit\/attachments\/[0-9a-f]{8}-[0-9a-f-]{27}\/?$/i.test(url.pathname)
    : new RegExp(`/_workitems/edit/${adoId}/?$`, "i").test(url.pathname);
  if (
    url.protocol !== "https:"
    || !allowedHost
    || !allowedPath
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.search
    || url.hash
  ) {
    payloadError(path, "is not an approved canonical ADO URL");
  }
}

function rejectProhibited(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectProhibited(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      if (payloadProhibitedKeys.has(key)) payloadError(`${path}.${key}`, "is quarantined");
      rejectProhibited(item, `${path}.${key}`);
    });
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    payloadError(path, "must be finite");
  }
}

function validateCommentAnalysis(value, path) {
  const keys = new Set([
    "comment_count", "status", "confidence", "summary", "source_comment_ids",
    "analyzed_at", "failure_reason_code", "failure_correlation_id",
  ]);
  exactObject(value, path, keys);
  boundedInteger(value.comment_count, `${path}.comment_count`, 0, 100000);
  ["status", "confidence", "summary"].forEach((key) => boundedString(
    value[key], `${path}.${key}`, key === "summary" ? 4000 : 50,
  ));
  if (!Array.isArray(value.source_comment_ids) || value.source_comment_ids.length > 100) {
    payloadError(`${path}.source_comment_ids`, "must be a bounded array");
  }
  value.source_comment_ids.forEach((item, index) => boundedInteger(
    item, `${path}.source_comment_ids[${index}]`, 1,
  ));
  utcTimestamp(value.analyzed_at, `${path}.analyzed_at`, true);
  if (value.failure_reason_code) {
    boundedString(value.failure_reason_code, `${path}.failure_reason_code`, 64);
    if (!payloadFailureReasons.has(value.failure_reason_code)) {
      payloadError(`${path}.failure_reason_code`, "has invalid value");
    }
  }
  if (value.failure_correlation_id) {
    boundedString(
      value.failure_correlation_id,
      `${path}.failure_correlation_id`,
      64,
      /^[A-Za-z0-9_-]{16,64}$/,
    );
  }
}

function validateRepair(value, path) {
  const required = new Set([
    "action_type", "performed_at", "performed_by", "supplier", "outcome", "notes",
    "source", "source_comment_ids", "confidence", "action_status", "is_final",
  ]);
  const allowed = new Set([...required, "evidence_url", "evidence_reference"]);
  exactObject(value, path, allowed, required);
  [
    ["action_type", 500], ["performed_at", 100], ["performed_by", 200],
    ["supplier", 200], ["outcome", 4000], ["notes", 4000], ["source", 100],
    ["confidence", 50], ["action_status", 50],
  ].forEach(([key, maximum]) => boundedString(value[key], `${path}.${key}`, maximum));
  if (value.evidence_url) canonicalAdoUrl(value.evidence_url, `${path}.evidence_url`, "", true);
  if (value.evidence_reference !== undefined) {
    if (value.evidence_reference !== "Microsoft 365 evidence retained locally") {
      payloadError(`${path}.evidence_reference`, "has invalid value");
    }
  }
  if (!Array.isArray(value.source_comment_ids) || value.source_comment_ids.length > 100) {
    payloadError(`${path}.source_comment_ids`, "must be a bounded array");
  }
  value.source_comment_ids.forEach((item, index) => boundedInteger(
    item, `${path}.source_comment_ids[${index}]`, 1,
  ));
  if (typeof value.is_final !== "boolean") payloadError(`${path}.is_final`, "must be boolean");
}

function validateDetail(value, path, adoId) {
  const keys = new Set([
    "ado_url", "title", "summary", "category", "bsl_attribution", "confidence",
    "root_cause", "supplier", "delay_start", "delay_end", "delay_hours",
    "delay_source", "effective_delay_hours", "delay_display", "production_stage",
    "ai_summary", "quantity_evidence", "building_block_evidence", "failure_evidence",
    "product_manufacturer", "product_name", "product_serial_number",
    "affected_servers", "repairs", "comment_analysis",
  ]);
  exactObject(value, path, keys);
  if (value.ado_url) canonicalAdoUrl(value.ado_url, `${path}.ado_url`, adoId);
  [
    ["ado_url", 2048], ["title", 500], ["summary", 4000], ["category", 200],
    ["bsl_attribution", 100], ["confidence", 50], ["root_cause", 5000],
    ["supplier", 200], ["delay_start", 100], ["delay_end", 100],
    ["delay_source", 20], ["delay_display", 100], ["production_stage", 200],
    ["ai_summary", 4000], ["quantity_evidence", 2000],
    ["building_block_evidence", 2000], ["failure_evidence", 4000],
    ["product_manufacturer", 200], ["product_name", 500],
    ["product_serial_number", 500], ["affected_servers", 1000],
  ].forEach(([key, maximum]) => boundedString(value[key], `${path}.${key}`, maximum));
  boundedNumber(value.delay_hours, `${path}.delay_hours`);
  boundedNumber(value.effective_delay_hours, `${path}.effective_delay_hours`);
  if (!Array.isArray(value.repairs) || value.repairs.length > 100) {
    payloadError(`${path}.repairs`, "must be a bounded array");
  }
  value.repairs.forEach((repair, index) => validateRepair(repair, `${path}.repairs[${index}]`));
  validateCommentAnalysis(value.comment_analysis, `${path}.comment_analysis`);
}

function validateItem(value, path) {
  const required = new Set([
    "ado_id", "site", "building_block", "state", "severity", "classification", "age_days",
  ]);
  const allowed = new Set([
    ...required, "ai_review", "units_impacted", "repair_count", "created_this_week",
    "closed_this_week", "week_index", "created_date", "closed_date", "resolution_days",
    "validation_status", "building_block_ai_verified", "failure_error", "failure_codes",
    "owner", "delay_recorded", "attention_reasons", "detail",
  ]);
  exactObject(value, path, allowed, required);
  boundedString(value.ado_id, `${path}.ado_id`, 12, /^\d{1,12}$/);
  [
    ["site", 100], ["building_block", 100], ["state", 50],
    ["severity", 50], ["classification", 100],
  ].forEach(([key, maximum]) => boundedString(value[key], `${path}.${key}`, maximum));
  if (!payloadFailureClasses.has(value.classification)) {
    payloadError(`${path}.classification`, "has invalid value");
  }
  boundedInteger(value.age_days, `${path}.age_days`, 0, 100000);
  if (Object.prototype.hasOwnProperty.call(value, "ai_review")) {
    ["ai_review", "created_this_week", "closed_this_week"].forEach((key) => {
      if (typeof value[key] !== "boolean") payloadError(`${path}.${key}`, "must be boolean");
    });
    boundedInteger(value.units_impacted, `${path}.units_impacted`);
    boundedInteger(value.repair_count, `${path}.repair_count`);
    boundedInteger(value.week_index, `${path}.week_index`, -1, 5);
  }
  if (Object.prototype.hasOwnProperty.call(value, "created_date")) {
    boundedString(value.created_date, `${path}.created_date`, 10, /^\d{4}-\d{2}-\d{2}$/);
    if (value.closed_date !== null) boundedString(
      value.closed_date, `${path}.closed_date`, 10, /^\d{4}-\d{2}-\d{2}$/,
    );
    if (value.resolution_days !== null) boundedInteger(
      value.resolution_days, `${path}.resolution_days`,
    );
    if (!payloadValidationStatuses.has(value.validation_status)) {
      payloadError(`${path}.validation_status`, "has invalid value");
    }
    if (typeof value.building_block_ai_verified !== "boolean") {
      payloadError(`${path}.building_block_ai_verified`, "must be boolean");
    }
    boundedString(value.failure_error, `${path}.failure_error`, 500);
    if (!Array.isArray(value.failure_codes) || value.failure_codes.length > 10) {
      payloadError(`${path}.failure_codes`, "must be a bounded array");
    }
    value.failure_codes.forEach((code, index) => boundedString(
      code, `${path}.failure_codes[${index}]`, 64,
    ));
    boundedString(value.owner, `${path}.owner`, 200);
    if (typeof value.delay_recorded !== "boolean") {
      payloadError(`${path}.delay_recorded`, "must be boolean");
    }
    if (!Array.isArray(value.attention_reasons) || value.attention_reasons.length > 8) {
      payloadError(`${path}.attention_reasons`, "must be a bounded array");
    }
    value.attention_reasons.forEach((reason, index) => {
      exactObject(reason, `${path}.attention_reasons[${index}]`, new Set(["code", "label"]));
      boundedString(reason.code, `${path}.attention_reasons[${index}].code`, 64);
      boundedString(reason.label, `${path}.attention_reasons[${index}].label`, 100);
    });
  }
  if (value.detail) validateDetail(value.detail, `${path}.detail`, value.ado_id);
}

function validateSnapshot(snapshot) {
  rejectProhibited(snapshot);
  const keys = new Set([
    "schema_version", "source_revision", "metrics", "items", "generated_at", "content_hash",
  ]);
  exactObject(snapshot, "$", keys);
  boundedInteger(snapshot.schema_version, "$.schema_version", 2, 2);
  boundedInteger(snapshot.source_revision, "$.source_revision");
  exactObject(snapshot.metrics, "$.metrics", new Set(["total", "open", "critical", "ai_review"]));
  Object.entries(snapshot.metrics).forEach(([key, value]) => boundedInteger(
    value, `$.metrics.${key}`, 0, 10000,
  ));
  if (!Array.isArray(snapshot.items) || snapshot.items.length > 10000) {
    payloadError("$.items", "must be a bounded array");
  }
  snapshot.items.forEach((item, index) => validateItem(item, `$.items[${index}]`));
  if (snapshot.metrics.total !== snapshot.items.length) {
    payloadError("$.metrics.total", "does not match item count");
  }
  utcTimestamp(snapshot.generated_at, "$.generated_at");
  boundedString(snapshot.content_hash, "$.content_hash", 64, /^[0-9a-f]{64}$/);
  return snapshot;
}

const closedStates = new Set(["closed", "resolved", "done", "completed"]);
const numericSorts = new Set([
  "ado_id",
  "units_impacted",
  "repair_count",
  "lifecycle_days",
  "attention_score",
]);
const dashboardStateKey = "bsl-dashboard-view-v1";
const dashboardSortKeys = new Set([
  "ado_id",
  "created_date",
  "site",
  "building_block",
  "failure_error",
  "failure_codes",
  "classification",
  "units_impacted",
  "repair_count",
  "owner",
  "state",
  "severity",
  "lifecycle_days",
  "attention_score",
]);
const filters = {
  query: "",
  createdFrom: "",
  createdTo: "",
  site: "",
  block: "",
  state: "",
  severity: "",
  category: "",
  owner: "",
  classification: "",
  validation: "",
  failureCode: "",
  age: "",
  lifecycle: "",
  recent: "",
  focus: "",
};
let allItems = [];
let siteChart;
let trendChart;
let siteChartMode = "issues";
let periodScope = "month";
let page = 1;
let pageSize = 25;
let sortKey = "attention_score";
let sortDirection = "desc";
let snapshotGeneratedAt = "";

const text = (value) => document.createTextNode(String(value ?? ""));
const setText = (id, value) => { document.getElementById(id).textContent = value; };
const countBy = (items, key) => items.reduce((counts, item) => {
  const value = item[key] || "Not identified";
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});
const topEntry = (counts) => Object.entries(counts).sort(
  (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
)[0];

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfCurrentMonth() {
  const now = new Date();
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
}

function applyPeriod(scope) {
  periodScope = scope;
  if (scope === "month") {
    filters.createdFrom = startOfCurrentMonth();
    filters.createdTo = isoDate(new Date());
  } else {
    filters.createdFrom = "";
    filters.createdTo = "";
  }
  document.getElementById("from-date").value = filters.createdFrom;
  document.getElementById("through-date").value = filters.createdTo;
}

function applyDefaultPeriod() {
  applyPeriod("month");
  if (allItems.length && filteredItems().length === 0) applyPeriod("all");
}

function selectHasValue(id, value) {
  return [...document.getElementById(id).options].some(
    (option) => option.value === value,
  );
}

function restoreDashboardState() {
  let saved;
  try {
    const serialized = window.sessionStorage.getItem(dashboardStateKey);
    if (!serialized || serialized.length > 4096) return false;
    saved = JSON.parse(serialized);
  } catch (_error) {
    return false;
  }
  if (!saved || saved.version !== 1 || typeof saved.filters !== "object") {
    return false;
  }
  const selectFilters = {
    site: "site-filter",
    block: "block-filter",
    state: "state-filter",
    severity: "severity-filter",
    category: "category-filter",
    owner: "owner-filter",
    classification: "class-filter",
    validation: "validation-filter",
    failureCode: "failure-code-filter",
    age: "age-filter",
  };
  Object.entries(selectFilters).forEach(([key, id]) => {
    const value = typeof saved.filters[key] === "string" ? saved.filters[key] : "";
    if (value && selectHasValue(id, value)) {
      filters[key] = value;
      document.getElementById(id).value = value;
    }
  });
  ["createdFrom", "createdTo"].forEach((key) => {
    const value = saved.filters[key];
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      filters[key] = value;
    }
  });
  if (filters.createdFrom && filters.createdTo && filters.createdFrom > filters.createdTo) {
    filters.createdFrom = "";
    filters.createdTo = "";
  }
  document.getElementById("from-date").value = filters.createdFrom;
  document.getElementById("through-date").value = filters.createdTo;
  if (["open", "closed"].includes(saved.filters.lifecycle)) {
    filters.lifecycle = saved.filters.lifecycle;
  }
  if (["new-week", "closed-week"].includes(saved.filters.recent)) {
    filters.recent = saved.filters.recent;
  }
  if (["attention", "diagnostic", "repair", "owner", "delay", "ai"].includes(
    saved.filters.focus,
  )) {
    filters.focus = saved.filters.focus;
  }
  if (["month", "all"].includes(saved.periodScope)) periodScope = saved.periodScope;
  if ([10, 25, 50].includes(saved.pageSize)) {
    pageSize = saved.pageSize;
    document.getElementById("page-size").value = String(pageSize);
  }
  if (dashboardSortKeys.has(saved.sortKey)) sortKey = saved.sortKey;
  if (["asc", "desc"].includes(saved.sortDirection)) {
    sortDirection = saved.sortDirection;
  }
  return true;
}

function persistDashboardState() {
  const persistedFilters = {};
  [
    "createdFrom",
    "createdTo",
    "site",
    "block",
    "state",
    "severity",
    "category",
    "owner",
    "classification",
    "validation",
    "failureCode",
    "age",
    "lifecycle",
    "recent",
    "focus",
  ].forEach((key) => {
    persistedFilters[key] = filters[key];
  });
  try {
    window.sessionStorage.setItem(dashboardStateKey, JSON.stringify({
      version: 1,
      filters: persistedFilters,
      periodScope,
      pageSize,
      sortKey,
      sortDirection,
    }));
  } catch (_error) {
    // Storage may be unavailable in hardened or private browser contexts.
  }
}

function updateSnapshotFreshness() {
  if (!snapshotGeneratedAt) return;
  const ageMinutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(snapshotGeneratedAt)) / 60000),
  );
  const status = ageMinutes <= 30
    ? ["Fresh", "success"]
    : ageMinutes <= 60
      ? ["Aging", "running"]
      : ["Stale", "failure"];
  const badge = document.getElementById("snapshot-freshness");
  badge.className = `sync-badge ${status[1]}`;
  badge.textContent = `${status[0]} · ${ageMinutes}m`;
}

function isOpen(item) {
  return !closedStates.has(String(item.state || "").toLowerCase());
}

function ageBand(days) {
  const value = Number(days || 0);
  if (value <= 7) return "0-7";
  if (value <= 14) return "8-14";
  if (value <= 30) return "15-30";
  return ">30";
}

function hasDiagnostic(item) {
  return Boolean(String(item.failure_error || "").trim() || (item.failure_codes || []).length);
}

function attentionScore(item) {
  let score = 0;
  if (isOpen(item)) {
    score += String(item.severity).startsWith("1")
      ? 4
      : String(item.severity).startsWith("2")
        ? 2
        : 0;
    score += item.age_days > 14 ? 2 : item.age_days > 7 ? 1 : 0;
    score += item.delay_recorded ? 2 : 0;
    score += Number(item.units_impacted || 0) > 0 ? 1 : 0;
    score += hasDiagnostic(item) ? 0 : 1;
    score += Number(item.repair_count || 0) > 0 ? 0 : 1;
  }
  return score;
}

function attention(item) {
  const score = attentionScore(item);
  return score >= 5 ? "high" : score >= 3 ? "watch" : "routine";
}

function severityClass(value) {
  if (String(value).startsWith("1")) return "critical";
  if (String(value).startsWith("2")) return "high";
  if (String(value).startsWith("3")) return "medium";
  return "low";
}

function normalizedFailure(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b(failed|failure|error|mismatch|fault|defect)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function mostCommonFailure(items) {
  const groups = new Map();
  items.forEach((item) => {
    const failure = String(item.failure_error || "").trim();
    const key = normalizedFailure(failure);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { count: 0, labels: new Map() });
    const group = groups.get(key);
    group.count += 1;
    group.labels.set(failure, (group.labels.get(failure) || 0) + 1);
  });
  if (!groups.size) return { label: "Not enough diagnostic data", count: 0 };
  const group = [...groups.entries()].sort(
    (left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]),
  )[0][1];
  const label = [...group.labels.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0][0];
  return { label, count: group.count };
}

function filteredItems() {
  const query = filters.query.toLowerCase();
  return allItems.filter((item) => {
    if (filters.createdFrom && item.created_date < filters.createdFrom) return false;
    if (filters.createdTo && item.created_date > filters.createdTo) return false;
    if (filters.site && item.site !== filters.site) return false;
    if (filters.block && item.building_block !== filters.block) return false;
    if (filters.state && item.state !== filters.state) return false;
    if (filters.severity && item.severity !== filters.severity) return false;
    if (filters.category && item.detail?.category !== filters.category) return false;
    if (filters.owner && item.owner !== filters.owner) return false;
    if (filters.classification && item.classification !== filters.classification) return false;
    if (filters.validation && item.validation_status !== filters.validation) return false;
    if (
      filters.failureCode
      && !(item.failure_codes || []).includes(filters.failureCode)
    ) return false;
    if (filters.age && ageBand(item.age_days) !== filters.age) return false;
    if (filters.lifecycle === "open" && !isOpen(item)) return false;
    if (filters.lifecycle === "closed" && isOpen(item)) return false;
    if (filters.recent === "new-week" && !item.created_this_week) return false;
    if (filters.recent === "closed-week" && !item.closed_this_week) return false;
    if (filters.focus === "attention" && attention(item) !== "high") return false;
    if (filters.focus === "diagnostic" && hasDiagnostic(item)) return false;
    if (filters.focus === "repair" && Number(item.repair_count || 0) > 0) return false;
    if (filters.focus === "owner" && (item.owner || !isOpen(item))) return false;
    if (filters.focus === "delay" && item.delay_recorded) return false;
    if (filters.focus === "ai" && !item.ai_review) return false;
    if (!query) return true;
    return [
      item.ado_id,
      item.site,
      item.building_block,
      item.failure_error,
      ...(item.failure_codes || []),
      item.owner,
      item.state,
      item.classification,
      item.validation_status,
    ].join(" ").toLowerCase().includes(query);
  });
}

function populateSelect(id, key) {
  const select = document.getElementById(id);
  [...new Set(allItems.map((item) => item[key]).filter(Boolean))]
    .sort()
    .forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.append(text(value));
      select.append(option);
    });
}

function populateFailureCodeSelect() {
  const select = document.getElementById("failure-code-filter");
  [...new Set(allItems.flatMap((item) => item.failure_codes || []).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.append(text(value));
      select.append(option);
    });
}

function renderActiveFilters() {
  const labels = {
    createdFrom: "Created from",
    createdTo: "Created through",
    site: "Site",
    block: "Building Block",
    state: "State",
    severity: "Severity",
    category: "Category",
    owner: "Owner",
    classification: "Failure class",
    validation: "Validation",
    failureCode: "Failure code",
    age: "Age",
    lifecycle: "Lifecycle",
    recent: "Recent activity",
    query: "Search",
    focus: "Focus",
  };
  const focusLabels = {
    attention: "High attention",
    diagnostic: "Missing diagnostic",
    repair: "No repair action",
    owner: "Unassigned",
    delay: "Missing delay record",
    ai: "Needs human review",
  };
  const lifecycleLabels = {
    open: "Open",
    closed: "Closed / resolved",
  };
  const recentLabels = {
    "new-week": "Created in 7 days",
    "closed-week": "Closed in 7 days",
  };
  const active = Object.entries(filters).filter(([, value]) => value);
  const container = document.getElementById("active-filters");
  container.replaceChildren();
  container.hidden = active.length === 0;
  if (!active.length) return;
  const heading = document.createElement("span");
  heading.className = "small fw-semibold text-secondary";
  heading.append(text("Active:"));
  container.append(heading);
  active.forEach(([key, value]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.dataset.clearFilter = key;
    const displayValue = key === "focus"
      ? focusLabels[value]
      : key === "lifecycle"
        ? lifecycleLabels[value]
        : key === "recent"
          ? recentLabels[value]
        : value;
    button.append(text(`${labels[key]}: ${displayValue} ×`));
    button.addEventListener("click", () => {
      filters[key] = "";
      if (key === "createdFrom" || key === "createdTo") {
        periodScope = "";
        document.getElementById(key === "createdFrom" ? "from-date" : "through-date").value = "";
      } else if (key !== "focus" && key !== "lifecycle" && key !== "recent") {
        const input = document.getElementById({
          query: "search",
          site: "site-filter",
          block: "block-filter",
          state: "state-filter",
          severity: "severity-filter",
          category: "category-filter",
          owner: "owner-filter",
          classification: "class-filter",
          validation: "validation-filter",
          failureCode: "failure-code-filter",
          age: "age-filter",
        }[key]);
        if (input) input.value = "";
      }
      page = 1;
      render();
    });
    container.append(button);
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
  const delayReported = items.filter((item) => item.delay_recorded).length;
  const diagnosticCount = items.filter(hasDiagnostic).length;
  const repairCount = items.filter((item) => Number(item.repair_count || 0) > 0).length;
  const failureCodeCounts = new Map();
  items.forEach((item) => (item.failure_codes || []).forEach((code) => {
    failureCodeCounts.set(code, (failureCodeCounts.get(code) || 0) + 1);
  }));
  const topFailureCode = [...failureCodeCounts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];

  setText("scope-count", items.length);
  setText("scope-label", items.length);
  setText("kpi-open", open.length);
  setText("kpi-critical", critical);
  setText("kpi-new", items.filter((item) => item.created_this_week).length);
  setText("kpi-closed", items.filter((item) => item.closed_this_week).length);
  setText("assessed-count", items.length);

  const impact = [
    ["False failures", falseFailures, "Confirmed classification", "danger"],
    ["BSL-induced", bslInduced, "Failures caused by BSL", "warning"],
    ["Delay records", `${delayReported}/${items.length}`, "Explicit impact evidence", "secondary"],
    ["Quantity affected", quantity, "Units explicitly impacted", "primary"],
    ["Needs classification", unclassified, "Incomplete assessments", "secondary"],
    ["AI review queue", aiReview, "Low-confidence or blocked analysis", "warning"],
  ];
  const impactGrid = document.getElementById("impact-grid");
  impactGrid.replaceChildren(...impact.map(([label, value, detail, style]) => {
    const column = document.createElement("div");
    column.className = "col";
    const metric = createElement("div", `impact-metric ${style}`);
    metric.append(
      createElement("small", "", label),
      createElement("strong", "", value),
      createElement("span", "", detail),
    );
    column.append(metric);
    return column;
  }));

  const signals = [
    ["High attention", highAttention, "Severity, age, impact, and evidence risk", "danger"],
    ["Diagnostic coverage", items.length ? `${Math.round(diagnosticCount * 100 / items.length)}%` : "0%", "Issues with a failed task or error", "info"],
    ["Repair coverage", items.length ? `${Math.round(repairCount * 100 / items.length)}%` : "0%", "Issues with at least one action", "success"],
    ["Unassigned open", open.filter((item) => !item.owner).length, "Open items without a named owner", "warning"],
    ["AI review queue", aiReview, "Low-confidence, blocked, or failed analysis", "warning"],
  ];
  const decisionGrid = document.getElementById("decision-grid");
  decisionGrid.replaceChildren(...signals.map(([label, value, detail, style]) => {
    const column = document.createElement("div");
    column.className = "col";
    const button = createElement("button", `decision-signal signal-${style}`);
    button.type = "button";
    button.append(
      createElement("span", "", label),
      createElement("strong", "", value),
      createElement("small", "", detail),
    );
    column.append(button);
    const focus = {
      "High attention": "attention",
      "Diagnostic coverage": "diagnostic",
      "Repair coverage": "repair",
      "Unassigned open": "owner",
      "AI review queue": "ai",
    }[label];
    if (focus) {
      button.addEventListener("click", () => {
        filters.focus = focus;
        page = 1;
        render();
      });
    }
    return column;
  }));

  const failure = mostCommonFailure(items);
  const block = topEntry(countBy(items.filter((item) => item.building_block), "building_block"));
  setText("top-failure", failure.count ? `${failure.label} · ${failure.count} issue(s)` : failure.label);
  const topFailureCodeButton = document.getElementById("top-failure-code");
  topFailureCodeButton.disabled = !topFailureCode;
  topFailureCodeButton.textContent = topFailureCode
    ? `${topFailureCode[0]} · ${topFailureCode[1]} issue(s)`
    : "Not identified";
  topFailureCodeButton.onclick = topFailureCode
    ? () => {
      filters.failureCode = topFailureCode[0];
      document.getElementById("failure-code-filter").value = topFailureCode[0];
      page = 1;
      render();
    }
    : null;
  setText("top-block", block ? block[0] : "Not identified");
}

function createElement(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.append(text(value));
  return element;
}

function validatedAdoUrl(item) {
  const value = String(item.detail?.ado_url || "");
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === "dev.azure.com" || host.endsWith(".visualstudio.com");
    const allowedPath = new RegExp(`/_workitems/edit/${item.ado_id}/?$`, "i").test(url.pathname);
    return url.protocol === "https:" && allowedHost && allowedPath ? url.href : "";
  } catch (_error) {
    return "";
  }
}

function addDetailCard(grid, label, value, className = "") {
  const card = createElement("div", `detail-readonly-card ${className}`.trim());
  card.append(createElement("small", "", label));
  const content = createElement("p", "", value || "Not identified");
  card.append(content);
  grid.append(card);
  return card;
}

function addMetaBadge(container, value) {
  if (value === "" || value === null || value === undefined) return;
  container.append(createElement("span", "detail-meta-badge", value));
}

function renderAdoDetail(item) {
  const detail = item.detail || {};
  const container = document.getElementById("ado-detail-content");
  container.replaceChildren();

  const hero = createElement("header", "detail-hero app-card mb-4");
  const heroMain = createElement("div", "detail-hero-main");
  const badges = createElement("div", "d-flex flex-wrap align-items-center gap-2 mb-2");
  badges.append(createElement("span", "eyebrow mb-0", `ADO ${item.ado_id}`));
  badges.append(createElement("span", "state", item.state));
  badges.append(createElement("span", `severity ${severityClass(item.severity)}`, item.severity));
  heroMain.append(badges);
  const title = createElement("h1", "detail-title", detail.title || `ADO ${item.ado_id}`);
  title.id = "ado-detail-title";
  heroMain.append(title);
  const metadata = createElement("div", "detail-meta");
  [
    item.site,
    `${item.building_block || "Building block not specified"}${item.building_block_ai_verified ? " · AI extracted" : ""}`,
    item.owner || "Unassigned",
    isOpen(item) ? `${item.age_days} days old` : `Resolved in ${item.resolution_days ?? "unknown"} days`,
  ].forEach((value) => metadata.append(createElement("span", "", value)));
  heroMain.append(metadata);
  hero.append(heroMain);
  const actions = createElement("div", "detail-hero-actions");
  const adoUrl = validatedAdoUrl(item);
  if (adoUrl) {
    const link = createElement("a", "btn btn-primary", "Open in Azure DevOps");
    link.href = adoUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  hero.append(actions);
  container.append(hero);

  const summarySection = createElement("section", "card app-card operational-summary mb-4");
  const summaryHeader = createElement("div", "card-header bg-white border-0 p-4 pb-2");
  summaryHeader.append(createElement("p", "eyebrow", "OPERATIONAL SUMMARY"));
  summaryHeader.append(createElement("h2", "h4 fw-bold mb-1", "What happened and how production was affected"));
  summarySection.append(summaryHeader);
  const summaryBody = createElement("div", "card-body p-4 pt-2");
  const grid = createElement("div", "detail-readonly-grid");
  addDetailCard(grid, "Issue", detail.ai_summary || detail.summary, "wide");
  addDetailCard(grid, "Delay exposure", detail.delay_display || "No delay data");
  addDetailCard(
    grid,
    "Quantity affected",
    item.units_impacted || detail.quantity_evidence
      ? `${item.units_impacted || 0} unit(s)`
      : "Not documented",
  );
  addDetailCard(grid, "Quantity evidence", detail.quantity_evidence);
  addDetailCard(grid, "Production stage", detail.production_stage);
  addDetailCard(grid, "Failure classification", item.classification);
  addDetailCard(grid, "BSL attribution", detail.bsl_attribution);
  addDetailCard(grid, "Validation", item.validation_status);
  addDetailCard(grid, "Assessment confidence", detail.confidence);
  addDetailCard(grid, "Failed task / error", item.failure_error, "wide");
  addDetailCard(grid, "Failure codes", (item.failure_codes || []).join(", ") || "Not identified");
  addDetailCard(grid, "Failure evidence", detail.failure_evidence, "full");
  addDetailCard(grid, "Root cause", detail.root_cause || "Root cause has not been confirmed.", "full");
  addDetailCard(grid, "Building Block evidence", detail.building_block_evidence, "full");
  addDetailCard(grid, "Product manufacturer", detail.product_manufacturer);
  addDetailCard(grid, "Product name", detail.product_name);
  addDetailCard(grid, "Product serial number", detail.product_serial_number);
  addDetailCard(grid, "Affected servers", detail.affected_servers);
  addDetailCard(grid, "Supplier", detail.supplier);
  addDetailCard(grid, "Category", detail.category);
  summaryBody.append(grid);
  summarySection.append(summaryBody);
  container.append(summarySection);

  const repairSection = createElement("section", "card app-card repair-panel mb-4");
  const repairHeader = createElement("div", "card-header bg-white border-0 p-4");
  repairHeader.append(createElement("p", "eyebrow", "REPAIR PROGRESSION"));
  repairHeader.append(createElement(
    "h2",
    "h4 fw-bold mb-1",
    `${(detail.repairs || []).length} recorded action${(detail.repairs || []).length === 1 ? "" : "s"}`,
  ));
  repairSection.append(repairHeader);
  const repairBody = createElement("div", "card-body p-4 pt-0");
  const repairList = createElement("div", "detail-repair-list");
  if (!(detail.repairs || []).length) {
    repairList.append(createElement("p", "detail-empty", "No repair action has been recorded."));
  }
  (detail.repairs || []).forEach((repair) => {
    const article = createElement("article", `detail-repair${repair.is_final ? " final" : ""}`);
    article.append(createElement("h3", "repair-action-title", repair.action_type || "Unnamed action"));
    const meta = createElement("div", "detail-repair-meta");
    [
      repair.action_status,
      repair.is_final ? "Final action" : "",
      repair.source,
      repair.confidence ? `${repair.confidence} confidence` : "",
      repair.performed_at,
      repair.performed_by,
      repair.supplier,
    ].forEach((value) => addMetaBadge(meta, value));
    article.append(meta);
    if (repair.outcome) {
      article.append(createElement("strong", "", "Outcome"));
      article.append(createElement("p", "", repair.outcome));
    }
    if (repair.notes) {
      article.append(createElement("strong", "d-block mt-2", "Evidence / notes"));
      article.append(createElement("p", "", repair.notes));
    }
    if (repair.source_comment_ids?.length || repair.evidence_images?.length) {
      const evidenceMeta = createElement("div", "detail-evidence-meta");
      addMetaBadge(
        evidenceMeta,
        repair.source_comment_ids?.length
          ? `Comment IDs: ${repair.source_comment_ids.join(", ")}`
          : "",
      );
      addMetaBadge(
        evidenceMeta,
        repair.evidence_images?.length
          ? `Evidence files: ${repair.evidence_images.join(", ")}`
          : "",
      );
      article.append(evidenceMeta);
    }
    if (repair.evidence_url) {
      const evidenceUrl = createElement("a", "btn btn-sm btn-outline-primary mt-2", "Open evidence link");
      evidenceUrl.href = repair.evidence_url;
      evidenceUrl.target = "_blank";
      evidenceUrl.rel = "noopener noreferrer";
      article.append(evidenceUrl);
    }
    repairList.append(article);
  });
  repairBody.append(repairList);
  repairSection.append(repairBody);
  container.append(repairSection);

  const analysis = detail.comment_analysis || {};
  const evidenceSection = createElement("section", "card app-card evidence-panel mb-4");
  const evidenceBody = createElement("div", "card-body p-4");
  evidenceBody.append(createElement("p", "eyebrow", "AI EVIDENCE AND COMMENT REVIEW"));
  evidenceBody.append(createElement("h2", "h4 fw-bold mb-3", "Comment and evidence metadata"));
  const evidenceMeta = createElement("div", "detail-evidence-meta");
  [
    `${analysis.comment_count || 0} comments reviewed`,
    analysis.status || "No review status",
    analysis.confidence ? `${analysis.confidence} confidence` : "",
    analysis.analyzed_at,
  ].forEach((value) => addMetaBadge(evidenceMeta, value));
  evidenceBody.append(evidenceMeta);
  if (analysis.injection_detected) {
    evidenceBody.append(createElement(
      "p",
      "detail-evidence-warning",
      "Prompt Guard detected instruction-like content in the ADO evidence. It was treated as untrusted data.",
    ));
  }
  if (analysis.failure_reason_code) {
    const failureStatus = {
      image_evidence_review_required: [
        "Image evidence requires human review",
        "Automated assessment and repair extraction were not updated.",
      ],
      prompt_guard_blocked: [
        "Automated review blocked",
        "Instruction-like evidence was treated as untrusted data.",
      ],
      analysis_failed: [
        "Automated review unavailable",
        "Protected local logs contain diagnostic details.",
      ],
    }[analysis.failure_reason_code];
    addDetailCard(
      evidenceBody,
      "Automated review status",
      `${failureStatus[0]}. ${failureStatus[1]}`,
      "wide",
    );
    addDetailCard(
      evidenceBody,
      "Correlation reference",
      analysis.failure_correlation_id || "Unavailable",
    );
  }
  if (analysis.summary) addDetailCard(evidenceBody, "Comment review summary", analysis.summary);
  const metadataGrid = createElement("div", "detail-readonly-grid mt-3");
  addDetailCard(
    metadataGrid,
    "Cited comment IDs",
    analysis.source_comment_ids?.join(", ") || "None recorded",
  );
  addDetailCard(
    metadataGrid,
    "Evidence handling",
    "Image evidence and filenames remain quarantined on the local BSL runtime.",
    "wide",
  );
  evidenceBody.append(metadataGrid);
  evidenceBody.append(createElement(
    "p",
    "detail-evidence-warning mt-3 mb-0",
    "Evidence image binaries remain on the local BSL runtime and are not copied into public Git history.",
  ));
  evidenceSection.append(evidenceBody);
  container.append(evidenceSection);

  document.getElementById("ado-detail-dialog").showModal();
}

function sortValue(item, key) {
  if (key === "attention_score") return attentionScore(item);
  if (key === "lifecycle_days") {
    return isOpen(item) ? Number(item.age_days || 0) : Number(item.resolution_days ?? -1);
  }
  if (key === "failure_codes") return (item.failure_codes || []).join(", ").toLowerCase();
  if (numericSorts.has(key)) return Number(item[key] || 0);
  return String(item[key] || "").toLowerCase();
}

function sortedItems(items) {
  return [...items].sort((left, right) => {
    const leftValue = sortValue(left, sortKey);
    const rightValue = sortValue(right, sortKey);
    const result = typeof leftValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue));
    return sortDirection === "asc" ? result : -result;
  });
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportFilteredCsv() {
  const rows = sortedItems(filteredItems());
  const columns = [
    "ADO",
    "Created",
    "Site",
    "Building Block",
    "Failed Task / Error",
    "Failure Codes",
    "Classification",
    "Owner",
    "State",
    "Severity",
    "Age / Resolution Days",
  ];
  const csvRows = rows.map((item) => [
    item.ado_id,
    item.created_date,
    item.site,
    item.building_block,
    item.failure_error,
    (item.failure_codes || []).join(", "),
    item.classification,
    item.owner || "Unassigned",
    item.state,
    item.severity,
    isOpen(item) ? item.age_days : item.resolution_days,
  ]);
  const csv = `\uFEFF${[columns, ...csvRows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `bsl-filtered-${isoDate(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyFilteredAdoIds() {
  const status = document.getElementById("copy-filtered-ado-status");
  const ids = sortedItems(filteredItems()).map((item) => String(item.ado_id));
  if (!ids.length) {
    status.textContent = "No matching ADO IDs to copy.";
    return;
  }
  try {
    await navigator.clipboard.writeText(ids.join("\n"));
    status.textContent = `Copied ${ids.length} filtered ADO ID(s).`;
  } catch (_error) {
    status.textContent = "Clipboard access was blocked by the browser.";
  }
}

function renderTable(items) {
  const ordered = sortedItems(items);
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  page = Math.min(page, pageCount);
  const start = (page - 1) * pageSize;
  const visible = ordered.slice(start, start + pageSize);
  const body = document.getElementById("items");
  body.replaceChildren();

  visible.forEach((item) => {
    const row = document.createElement("tr");
    const state = String(item.state || "").toLowerCase();
    row.className = closedStates.has(state)
      ? (state === "resolved" ? "state-resolved" : "state-closed")
      : "state-open";

    const ado = document.createElement("td");
    const marker = document.createElement("span");
    marker.className = `attention-marker ${attention(item)}`;
    const detailButton = createElement("button", "ado-detail-trigger", item.ado_id);
    detailButton.type = "button";
    detailButton.addEventListener("click", () => renderAdoDetail(item));
    ado.append(marker, detailButton);
    const reasons = Array.isArray(item.attention_reasons)
      ? item.attention_reasons.slice(0, 2)
      : [];
    if (reasons.length) {
      const reasonList = createElement("span", "attention-reasons");
      reasons.forEach((reason) => {
        reasonList.append(createElement("span", "", reason.label));
      });
      ado.append(reasonList);
    }
    const adoUrl = validatedAdoUrl(item);
    if (adoUrl) {
      const directLink = createElement("a", "ado-direct-link", "↗");
      directLink.href = adoUrl;
      directLink.target = "_blank";
      directLink.rel = "noopener noreferrer";
      directLink.title = "Open in Azure DevOps";
      ado.append(directLink);
    }
    row.append(ado);

    const created = document.createElement("td");
    const createdTime = document.createElement("time");
    createdTime.dateTime = item.created_date;
    createdTime.append(text(item.created_date));
    created.append(createdTime);
    row.append(created);

    const site = document.createElement("td");
    site.append(text(item.site));
    row.append(site);

    const block = document.createElement("td");
    block.append(text(item.building_block || "—"));
    if (item.building_block_ai_verified) {
      const verified = document.createElement("small");
      verified.className = "d-block text-muted";
      verified.append(text("AI extracted"));
      block.append(verified);
    }
    row.append(block);

    const failure = document.createElement("td");
    failure.className = "failure-task";
    failure.append(text(item.failure_error || "Not identified"));
    row.append(failure);

    const codes = document.createElement("td");
    codes.className = "failure-codes";
    if ((item.failure_codes || []).length) {
      item.failure_codes.forEach((value) => {
        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = "failure-code";
        badge.append(text(value));
        badge.addEventListener("click", () => {
          filters.failureCode = value;
          document.getElementById("failure-code-filter").value = value;
          page = 1;
          render();
        });
        codes.append(badge);
      });
    } else {
      codes.append(text("—"));
    }
    row.append(codes);

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

    const owner = document.createElement("td");
    owner.append(text(item.owner || "Unassigned"));
    row.append(owner);

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
    if (isOpen(item)) {
      age.className = item.age_days > 30 ? "age-risk" : "";
      age.append(text(`Age ${item.age_days}d`));
    } else if (item.resolution_days !== null && item.resolution_days !== undefined) {
      age.append(text(`Resolved in ${item.resolution_days}d`));
    } else {
      age.append(text("Resolution time unavailable"));
    }
    row.append(age);
    body.append(row);
  });

  document.getElementById("empty").hidden = items.length !== 0;
  setText(
    "queue-summary",
    `Showing ${items.length ? start + 1 : 0}–${Math.min(start + pageSize, items.length)} of ${items.length} matching item(s) · prioritized by operational attention`,
  );
  const pagination = document.getElementById("pagination");
  pagination.hidden = pageCount <= 1;
  setText("page-label", `Page ${page} of ${pageCount}`);
  document.getElementById("previous-page").classList.toggle("disabled", page === 1);
  document.getElementById("next-page").classList.toggle("disabled", page === pageCount);
  document.querySelectorAll("[data-sort]").forEach((button) => {
    const active = button.dataset.sort === sortKey;
    button.classList.toggle("active", active);
    button.setAttribute("aria-sort", active ? (sortDirection === "asc" ? "ascending" : "descending") : "none");
  });
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
    const status = score >= 80 ? ["Green", "green"] : score >= 60 ? ["Watch", "yellow"] : ["Risk", "red"];
    const common = mostCommonFailure(rows);
    const column = document.createElement("div");
    column.className = "col";
    const button = createElement("button", "health-card w-100 text-start");
    button.type = "button";
    const heading = document.createElement("div");
    heading.append(
      createElement("b", "", site),
      createElement("span", `pill ${status[1]}`, status[0]),
    );
    const pattern = createElement("span", "site-failure-pattern");
    pattern.append(
      createElement("b", "", "Most common failure"),
      createElement(
        "span",
        "",
        common.count ? `${common.label} · ${common.count} issue(s)` : common.label,
      ),
    );
    button.append(
      heading,
      createElement("strong", "", score),
      createElement(
        "small",
        "",
        `${open.length} open · ${critical} critical · ${old} over 30d`,
      ),
      pattern,
    );
    button.addEventListener("click", () => {
      filters.site = site;
      document.getElementById("site-filter").value = site;
      page = 1;
      render();
    });
    column.append(button);
    return column;
  }));
}

function weeklyData(items) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = (today.getDay() + 6) % 7;
  const currentMonday = new Date(today);
  currentMonday.setDate(currentMonday.getDate() - day);
  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(currentMonday);
    start.setDate(start.getDate() - (5 - index) * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const startIso = isoDate(start);
    const endIso = isoDate(end);
    return {
      label: start.toLocaleDateString(undefined, { month: "short", day: "2-digit" }),
      start: startIso,
      end: endIso,
      count: items.filter((item) => item.created_date >= startIso && item.created_date <= endIso).length,
    };
  });
}

function renderCharts(items) {
  if (!window.Chart) return;
  const siteCounts = countBy(items, "site");
  const labels = Object.keys(siteCounts).sort();
  const siteValues = labels.map((label) => items
    .filter((item) => item.site === label)
    .reduce((sum, item) => sum + Number(item.units_impacted || 0), 0));
  const weeks = weeklyData(items);
  const siteData = document.getElementById("site-chart-data");
  siteData.replaceChildren(...labels.map((label, index) => {
    const button = createElement(
      "button",
      "chart-data-control",
      `${label}: ${siteChartMode === "issues" ? siteCounts[label] : siteValues[index]} ${siteChartMode === "issues" ? "issue(s)" : "explicitly reported unit(s)"}`,
    );
    button.type = "button";
    button.addEventListener("click", () => {
      filters.site = label;
      document.getElementById("site-filter").value = label;
      page = 1;
      render();
    });
    return button;
  }));
  const trendData = document.getElementById("trend-chart-data");
  trendData.replaceChildren(...weeks.map((week) => {
    const button = createElement(
      "button",
      "chart-data-control",
      `${week.label}: ${week.count} issue(s)`,
    );
    button.type = "button";
    button.addEventListener("click", () => {
      filters.createdFrom = week.start;
      filters.createdTo = week.end;
      periodScope = "";
      document.getElementById("from-date").value = week.start;
      document.getElementById("through-date").value = week.end;
      page = 1;
      render();
    });
    return button;
  }));
  if (siteChart) siteChart.destroy();
  if (trendChart) trendChart.destroy();
  Chart.defaults.font.family = '"Segoe UI",system-ui,sans-serif';
  Chart.defaults.color = "#667085";
  siteChart = new Chart(document.getElementById("site-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: siteChartMode === "issues" ? labels.map((label) => siteCounts[label]) : siteValues,
        backgroundColor: siteChartMode === "issues" ? "#0b5ed7" : "#d97706",
        hoverBackgroundColor: siteChartMode === "issues" ? "#084298" : "#b45309",
        borderRadius: 7,
        maxBarThickness: 48,
      }],
    },
    options: {
      maintainAspectRatio: false,
      onClick: (_, elements) => {
        if (!elements.length) return;
        filters.site = labels[elements[0].index];
        document.getElementById("site-filter").value = filters.site;
        page = 1;
        render();
      },
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  trendChart = new Chart(document.getElementById("trend-chart"), {
    type: "line",
    data: {
      labels: weeks.map((week) => week.label),
      datasets: [{
        data: weeks.map((week) => week.count),
        borderColor: "#087990",
        backgroundColor: "rgba(8,121,144,.12)",
        fill: true,
        tension: .35,
        pointRadius: 5,
        pointBackgroundColor: "#087990",
      }],
    },
    options: {
      maintainAspectRatio: false,
      onClick: (_, elements) => {
        if (!elements.length) return;
        const week = weeks[elements[0].index];
        filters.createdFrom = week.start;
        filters.createdTo = week.end;
        periodScope = "";
        document.getElementById("from-date").value = week.start;
        document.getElementById("through-date").value = week.end;
        page = 1;
        render();
      },
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function render() {
  const items = filteredItems();
  persistDashboardState();
  document.querySelectorAll("[data-lifecycle]").forEach((button) => {
    button.classList.toggle("active", button.dataset.lifecycle === filters.lifecycle);
  });
  document.querySelectorAll("[data-open-state]").forEach((button) => {
    button.classList.toggle(
      "active",
      filters.lifecycle === "open" && filters.state === button.dataset.openState,
    );
  });
  document.querySelectorAll("[data-focus]").forEach((button) => {
    button.classList.toggle("active", button.dataset.focus === filters.focus);
  });
  document.querySelectorAll("[data-aging]").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.aging === "stale-open"
        && filters.lifecycle === "open"
        && filters.age === ">30",
    );
  });
  document.querySelectorAll("[data-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.period === periodScope);
  });
  renderActiveFilters();
  renderCards(items);
  renderTable(items);
  renderHealth(items);
  renderCharts(items);
}

function renderCoverage(snapshot) {
  const generatedYear = new Date(snapshot.generated_at).getFullYear();
  setText(
    "coverage-policy",
    `Bug only · title contains [BSL] · created ${generatedYear} · recognized manufacturing site`,
  );
  setText("coverage-count", allItems.length);
  const newest = [...allItems].sort((left, right) => {
    const dateOrder = String(right.created_date || "").localeCompare(
      String(left.created_date || ""),
    );
    return dateOrder || Number(right.ado_id || 0) - Number(left.ado_id || 0);
  })[0];
  const button = document.getElementById("coverage-newest-ado");
  button.disabled = !newest;
  button.textContent = newest
    ? `ADO ${newest.ado_id} · ${newest.created_date}`
    : "Not identified";
  button.onclick = newest ? () => renderAdoDetail(newest) : null;
}

const fromBase64 = (value) => Uint8Array.from(
  atob(value),
  (character) => character.charCodeAt(0),
);

async function decryptSnapshot(password) {
  const response = await fetch("data/dashboard.enc.json", { cache: "no-store" });
  if (!response.ok) throw new Error("snapshot-unavailable");
  let envelope;
  try {
    envelope = await response.json();
  } catch (_error) {
    throw new Error("snapshot-format");
  }
  if (
    envelope.algorithm !== "AES-256-GCM"
    || envelope.kdf !== "PBKDF2-SHA256"
    || Number(envelope.iterations) < 210000
  ) {
    throw new Error("snapshot-format");
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
  return validateSnapshot(JSON.parse(new TextDecoder().decode(plaintext)));
}

function startDashboard(snapshot) {
  validateSnapshot(snapshot);
  allItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  snapshotGeneratedAt = snapshot.generated_at;
  setText("generated-at", new Date(snapshot.generated_at).toLocaleString());
  updateSnapshotFreshness();
  setText("source-revision", snapshot.source_revision);
  setText("published-count", allItems.length);
  setText("total-count", allItems.length);
  renderCoverage(snapshot);
  populateSelect("site-filter", "site");
  populateSelect("block-filter", "building_block");
  populateSelect("state-filter", "state");
  populateSelect("severity-filter", "severity");
  const categorySelect = document.getElementById("category-filter");
  [...new Set(allItems.map((item) => item.detail?.category).filter(Boolean))]
    .sort()
    .forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.append(text(value));
      categorySelect.append(option);
    });
  populateSelect("owner-filter", "owner");
  populateSelect("class-filter", "classification");
  populateSelect("validation-filter", "validation_status");
  populateFailureCodeSelect();
  if (!restoreDashboardState()) applyDefaultPeriod();
  document.getElementById("login-screen").hidden = true;
  document.getElementById("dashboard-shell").hidden = false;
  window.scrollTo(0, 0);
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
  } catch (failure) {
    const safeMessage = {
      "snapshot-unavailable": "The encrypted dashboard file is unavailable. Try again later or ask the publisher to republish it.",
      "snapshot-format": "The protected dashboard format was rejected. Ask the publisher to republish a valid snapshot.",
    }[failure.message]
      || (failure instanceof DOMException && failure.name === "OperationError"
        ? "The access key was not accepted, or the encrypted dashboard file is damaged."
        : "The protected dashboard data was rejected. Ask the publisher to republish a valid snapshot.");
    error.textContent = safeMessage;
    error.hidden = false;
    error.focus();
    form.elements.password.value = "";
    form.elements.password.focus();
  }
});

document.getElementById("dashboard-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  filters.query = document.getElementById("search").value.trim();
  filters.createdFrom = document.getElementById("from-date").value;
  filters.createdTo = document.getElementById("through-date").value;
  periodScope = "";
  page = 1;
  render();
});
window.setInterval(updateSnapshotFreshness, 60000);
document.getElementById("export-filtered-csv").addEventListener("click", exportFilteredCsv);
document.getElementById("copy-filtered-ado-ids").addEventListener("click", copyFilteredAdoIds);
[
  ["site-filter", "site"],
  ["block-filter", "block"],
  ["state-filter", "state"],
  ["severity-filter", "severity"],
  ["category-filter", "category"],
  ["owner-filter", "owner"],
  ["class-filter", "classification"],
  ["validation-filter", "validation"],
  ["failure-code-filter", "failureCode"],
  ["age-filter", "age"],
].forEach(([id, key]) => {
  document.getElementById(id).addEventListener("change", (event) => {
    filters[key] = event.target.value;
    page = 1;
    render();
  });
});
document.querySelectorAll("[data-lifecycle]").forEach((button) => {
  button.addEventListener("click", () => {
    filters.lifecycle = filters.lifecycle === button.dataset.lifecycle
      ? ""
      : button.dataset.lifecycle;
    page = 1;
    render();
  });
});
document.querySelectorAll("[data-open-state]").forEach((button) => {
  button.addEventListener("click", () => {
    const active = filters.lifecycle === "open"
      && filters.state === button.dataset.openState;
    filters.lifecycle = active ? "" : "open";
    filters.state = active ? "" : button.dataset.openState;
    document.getElementById("state-filter").value = filters.state;
    page = 1;
    render();
  });
});
document.querySelectorAll("[data-aging]").forEach((button) => {
  button.addEventListener("click", () => {
    const active = filters.lifecycle === "open" && filters.age === ">30";
    filters.lifecycle = active ? "" : "open";
    filters.age = active ? "" : ">30";
    document.getElementById("age-filter").value = filters.age;
    page = 1;
    render();
  });
});
document.getElementById("open-card").addEventListener("click", () => {
  filters.lifecycle = "open";
  filters.recent = "";
  page = 1;
  render();
});
document.getElementById("new-week-card").addEventListener("click", () => {
  filters.recent = "new-week";
  page = 1;
  render();
});
document.getElementById("closed-week-card").addEventListener("click", () => {
  filters.lifecycle = "closed";
  filters.recent = "closed-week";
  page = 1;
  render();
});
document.getElementById("critical-open-card").addEventListener("click", () => {
  filters.severity = "1 - Critical";
  filters.lifecycle = "open";
  filters.recent = "";
  document.getElementById("severity-filter").value = filters.severity;
  page = 1;
  render();
});
document.getElementById("close-ado-detail").addEventListener("click", () => {
  document.getElementById("ado-detail-dialog").close();
});
document.getElementById("ado-detail-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelectorAll("[data-focus]").forEach((button) => {
  button.addEventListener("click", () => {
    filters.focus = filters.focus === button.dataset.focus ? "" : button.dataset.focus;
    page = 1;
    render();
  });
});
document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => {
    applyPeriod(button.dataset.period);
    page = 1;
    render();
  });
});
document.getElementById("reset-filters").addEventListener("click", () => {
  Object.keys(filters).forEach((key) => { filters[key] = ""; });
  document.getElementById("dashboard-filters").reset();
  applyDefaultPeriod();
  sortKey = "attention_score";
  sortDirection = "desc";
  page = 1;
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
document.getElementById("page-size").addEventListener("change", (event) => {
  pageSize = Number(event.target.value);
  page = 1;
  render();
});
document.getElementById("previous-page").addEventListener("click", () => {
  if (page > 1) {
    page -= 1;
    render();
  }
});
document.getElementById("next-page").addEventListener("click", () => {
  const pageCount = Math.max(1, Math.ceil(filteredItems().length / pageSize));
  if (page < pageCount) {
    page += 1;
    render();
  }
});
document.querySelectorAll("[data-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    if (sortKey === button.dataset.sort) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = button.dataset.sort;
      sortDirection = "desc";
    }
    page = 1;
    render();
  });
});
