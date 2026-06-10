import {
  adminSecurityStatus,
  approveTeamMember,
  changePassword,
  createEncryptedBackup,
  createOwnerAccount,
  createTeamMember,
  deleteQuoteJobs,
  deleteTeamMember,
  getTwoFactorSetup,
  hasAdminAccount,
  isAdminLoggedIn,
  listQuoteJobs,
  listLoginActivity,
  listRecurringJobs,
  listSecurityAudit,
  listTeamMembers,
  loginAdmin,
  logoutAdmin,
  recoverPassword,
  recordCurrentLocation,
  saveQuoteJobs,
  saveRecurringJobs,
  sendTestSecurityEmail,
  unlockTeamMember,
  updateTeamMember,
  updateTwoFactor,
  initAccessibleNavigation
} from "./auth.js";
import {
  employeeProfileFromForm,
  openEmployeeProfileEditor,
  profileSummary,
  setupCredentialDraft
} from "./team-profile.js";

const QUOTES_KEY = "lawnquote.history.v1";
const RECURRING_KEY = "lawnquote.recurring.v1";
const MATERIALS_KEY = "lawnquote.materials.v1";

const setupForm = document.querySelector("#setup-form");
const loginForm = document.querySelector("#login-form");
const passwordForm = document.querySelector("#password-form");
const recoveryForm = document.querySelector("#recovery-form");
const twoFactorForm = document.querySelector("#two-factor-form");
const materialForm = document.querySelector("#material-form");
const teamForm = document.querySelector("#team-form");
const jobImportForm = document.querySelector("#job-import-form");
const authPanel = document.querySelector("#auth-panel");
const adminPanel = document.querySelector("#admin-panel");
const setupPanel = document.querySelector("#setup-panel");
const loginPanel = document.querySelector("#login-panel");
const recoveryOutput = document.querySelector("#recovery-output");
const authMessage = document.querySelector("#auth-message");
const securitySummary = document.querySelector("#security-summary");
const dashboardStats = document.querySelector("#dashboard-stats");
const quoteAdminList = document.querySelector("#quote-admin-list");
const materialsSummary = document.querySelector("#materials-summary");
const teamCard = document.querySelector("#team-card");
const teamList = document.querySelector("#team-list");
const securityToolsCard = document.querySelector("#security-tools-card");
const securityToolOutput = document.querySelector("#security-tool-output");
const loginActivityCard = document.querySelector("#login-activity-card");
const loginActivityList = document.querySelector("#login-activity-list");
const securityAuditCard = document.querySelector("#security-audit-card");
const securityAuditList = document.querySelector("#security-audit-list");
const twoFactorSetup = document.querySelector("#two-factor-setup");
const teamCredentialLabel = document.querySelector("#team-credential-label");
const teamCredentialFile = document.querySelector("#team-credential-file");
const addTeamCredential = document.querySelector("#add-team-credential");
const teamCredentialList = document.querySelector("#team-credential-list");
const topActions = document.querySelector(".top-actions");

let currentUser = null;
let currentRoles = {};
let teamUsers = [];
let pendingTwoFactorSecret = "";
let quoteCache = [];
let recurringCache = [];
let newTeamCredentials = [];
let refreshTeamCredentialDraft = () => {};

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  if (key === QUOTES_KEY) {
    quoteCache = Array.isArray(value) ? value : [];
    saveQuoteJobs({ quotes: quoteCache }).catch(() => {});
  }
  if (key === RECURRING_KEY) {
    recurringCache = Array.isArray(value) ? value : [];
    saveRecurringJobs({ jobs: recurringCache }).catch(() => {});
  }
}

function money(value) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function dateLabel(value) {
  if (!value) return "No date set";
  return new Date(value).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function dateTimeLabel(value) {
  if (!value) return "Not recorded";
  return new Date(value).toLocaleString("en-AU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function durationLabel(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${Math.floor(total % 60)}s`;
}

function locationLabel(location = {}) {
  const hasGps = Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude));
  if (hasGps) {
    const accuracy = location.accuracy ? ` · accuracy ${Math.round(location.accuracy)}m` : "";
    return `GPS ${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}${accuracy}`;
  }
  if (location.status === "denied") return "Browser GPS denied";
  if (location.status === "prompt") return "Browser GPS not granted yet";
  if (location.status === "unavailable") return "Browser GPS unavailable";
  if (location.status === "error") return `Browser GPS error${location.errorMessage ? `: ${location.errorMessage}` : ""}`;
  return "Browser GPS not recorded";
}

function statusLabel(status) {
  const labels = {
    pending: "Pending quote",
    accepted: "Accepted job",
    completed_pending_approval: "Completed - awaiting approval",
    approved: "Completed - approved",
    rejected: "Rejected",
    completed: "Completed"
  };
  return labels[status] || status || "Pending quote";
}

function teamLabel(id) {
  if (!id) return "Unassigned";
  const user = teamUsers.find((item) => item.id === id || item.username === id);
  return user ? `${user.username} (${user.roleLabel})` : "Unknown team member";
}

function isAssignedToCurrentUser(item) {
  return Boolean(item.assignedTo && (item.assignedTo === currentUser?.id || item.assignedTo === currentUser?.username));
}

function setMessage(message, tone = "info") {
  authMessage.textContent = message;
  authMessage.dataset.tone = tone;
}

function logoutRequested() {
  return new URLSearchParams(location.search).has("logout") || new URLSearchParams(location.search).has("loggedout");
}

function notificationSent(notification) {
  return Boolean(notification?.status?.startsWith("sent"));
}

function notificationAccepted(notification) {
  return notificationSent(notification) || notification?.status === "queued-local" || notification?.status === "queued";
}

function showLoginPopup(message) {
  setMessage(message, "warning");
  window.alert(message);
}

function enhancePasswordFields() {
  for (const input of document.querySelectorAll('input[type="password"]')) {
    if (input.parentElement?.classList.contains("password-control")) continue;
    const label = input.parentElement;
    const wrapper = document.createElement("span");
    const button = document.createElement("button");
    wrapper.className = "password-control";
    button.className = "password-toggle";
    button.type = "button";
    button.textContent = "Show";
    button.setAttribute("aria-label", `Show ${label?.textContent?.trim() || "password"}`);
    input.replaceWith(wrapper);
    wrapper.append(input, button);
    button.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      button.textContent = showing ? "Show" : "Hide";
      button.setAttribute("aria-label", `${showing ? "Show" : "Hide"} ${label?.textContent?.trim() || "password"}`);
    });
  }
}

function currentNextUrl() {
  const next = new URLSearchParams(location.search).get("next");
  return next || (navigator.userAgent.includes("MACS-LawnQuote-Android") ? "crew.html" : "quote.html");
}

function quoteId(quote) {
  return quote.id || quote.createdAt;
}

function quotes() {
  return quoteCache;
}

function recurringJobs() {
  return recurringCache;
}

function mergeById(remoteItems, localItems) {
  const map = new Map();
  for (const item of remoteItems) map.set(quoteId(item), item);
  for (const item of localItems) {
    const id = quoteId(item);
    if (!map.has(id)) map.set(id, item);
  }
  return [...map.values()];
}

async function refreshSharedJobs() {
  const [quoteResult, recurringResult] = await Promise.all([listQuoteJobs(), listRecurringJobs()]);
  quoteCache = quoteResult.ok ? quoteResult.quotes : [];
  recurringCache = recurringResult.ok ? recurringResult.jobs : [];
  const localQuotes = loadJson(QUOTES_KEY, []);
  const localRecurring = loadJson(RECURRING_KEY, []);
  if ((currentUser?.role === "owner" || currentUser?.role === "leader") && localQuotes.length) {
    const merged = mergeById(quoteCache, localQuotes);
    if (merged.length > quoteCache.length) {
      const saved = await saveQuoteJobs({ quotes: merged });
      quoteCache = saved.ok ? saved.quotes : merged;
    }
  }
  if ((currentUser?.role === "owner" || currentUser?.role === "leader") && localRecurring.length) {
    const merged = mergeById(recurringCache, localRecurring);
    if (merged.length > recurringCache.length) {
      const saved = await saveRecurringJobs({ jobs: merged });
      recurringCache = saved.ok ? saved.jobs : merged;
    }
  }
  localStorage.setItem(QUOTES_KEY, JSON.stringify(quoteCache));
  localStorage.setItem(RECURRING_KEY, JSON.stringify(recurringCache));
}

function calculateNextRun(startDate, frequency) {
  const base = startDate ? new Date(startDate) : new Date();
  const next = new Date(base);
  const days = frequency === "weekly" ? 7 : frequency === "fortnightly" ? 14 : 30;
  while (next < new Date()) next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

async function renderSecurity() {
  const status = await adminSecurityStatus();
  currentUser = status.user;
  currentRoles = status.roles || {};
  securitySummary.replaceChildren();
  const lines = [
    ["Signed in as", currentUser ? `${currentUser.username} (${currentUser.roleLabel})` : "Not signed in"],
    ["2FA", status.twoFactorEnabled ? "Enabled" : "Off"],
    ["Last security update", status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "Not set"]
  ];
  for (const [label, value] of lines) {
    const row = document.createElement("div");
    row.className = "dashboard-stat";
    row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    securitySummary.append(row);
  }
  document.querySelector("#two-factor-enabled").checked = status.twoFactorEnabled;
  if (teamCard) teamCard.hidden = !(currentUser?.role === "owner" || currentUser?.role === "leader");
  if (teamForm) teamForm.hidden = currentUser?.role !== "owner";
  if (securityToolsCard) securityToolsCard.hidden = currentUser?.role !== "owner";
  if (loginActivityCard) loginActivityCard.hidden = currentUser?.role !== "owner";
  if (securityAuditCard) securityAuditCard.hidden = currentUser?.role !== "owner";
  passwordForm.hidden = !currentUser;
  twoFactorForm.hidden = !currentUser;
  const teamResult = currentUser ? await listTeamMembers() : { ok: false, users: [] };
  teamUsers = teamResult.ok ? teamResult.users : [];
  if (currentUser) await refreshSharedJobs();
  renderPrivileges();
  if ((currentUser?.role === "owner" || currentUser?.role === "leader") && teamCard) {
    renderTeam(teamResult);
  }
  if (currentUser?.role === "owner" && teamCard) {
    await renderLoginActivity();
    await renderSecurityAudit();
  }
}

function renderPrivileges() {
  const role = currentUser?.role || "";
  const canWrite = role === "owner" || role === "leader";
  for (const element of [
    materialForm,
    jobImportForm,
    document.querySelector("#password-form"),
    document.querySelector("#two-factor-form")
  ]) {
    if (element) element.classList.toggle("read-only-panel", role === "member");
  }
  materialForm.querySelectorAll("input, select, button").forEach((node) => {
    node.disabled = !canWrite;
  });
  jobImportForm.querySelectorAll("input, select, button").forEach((node) => {
    node.disabled = !canWrite;
  });
}

function renderDashboard() {
  const savedQuotes = quotes();
  const pending = savedQuotes.filter((quote) => (quote.status || "pending") === "pending");
  const accepted = savedQuotes.filter((quote) => quote.status === "accepted");
  const approvalQueue = savedQuotes.filter((quote) => quote.status === "completed_pending_approval");
  const income = savedQuotes
    .filter((quote) => quote.status === "accepted" || quote.status === "approved")
    .reduce((sum, quote) => sum + Number(quote.price || 0), 0);
  const upcoming = recurringJobs().filter((job) => !job.archived).length;
  dashboardStats.replaceChildren();
  for (const [label, value] of [
    ["Pending quotes", pending.length],
    ["Accepted jobs", accepted.length],
    ["Need approval", approvalQueue.length],
    ["Estimated income", money(income)],
    ["Recurring jobs", upcoming]
  ]) {
    const card = document.createElement("article");
    card.className = "dashboard-stat";
    card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    dashboardStats.append(card);
  }
  renderQuoteAdminList(savedQuotes);
}

function renderQuoteAdminList(savedQuotes = quotes()) {
  if (!savedQuotes.length) {
    quoteAdminList.innerHTML = `<p class="empty-state">No saved quotes yet.</p>`;
    return;
  }
  quoteAdminList.replaceChildren(...savedQuotes.map((quote) => {
    const item = document.createElement("article");
    item.className = "admin-list-item";
    const status = quote.status || "pending";
    const canWrite = currentUser?.role === "owner" || currentUser?.role === "leader";
    const canComplete = currentUser?.role === "member" && isAssignedToCurrentUser(quote);
    const canApprove = canWrite && status === "completed_pending_approval";
    item.innerHTML = `
      <div>
        <strong>${quote.customerName || quote.address || "Unnamed quote"}</strong>
        <span>${quote.address || "No address"} · ${money(quote.price)} · ${teamLabel(quote.assignedTo)} · ${statusLabel(status)}</span>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "inline-actions";
    if (canWrite) {
      const assigned = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Unassigned";
      assigned.append(blank);
      for (const user of teamUsers.filter((member) => member.role === "member")) {
        const option = document.createElement("option");
        option.value = user.id;
        option.textContent = user.username;
        option.selected = quote.assignedTo === user.id;
        assigned.append(option);
      }
      assigned.addEventListener("change", () => {
        updateQuoteStatus(quoteId(quote), { assignedTo: assigned.value });
        setMessage("Quote job assignment updated.", "success");
      });
      actions.append(assigned);
    }
    const select = document.createElement("select");
    for (const option of ["pending", "accepted", "completed_pending_approval", "approved", "rejected"]) {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = statusLabel(option);
      node.selected = option === status;
      select.append(node);
    }
    select.disabled = !canWrite;
    select.addEventListener("change", () => {
      if (currentUser?.role === "member") {
        select.value = status;
        setMessage("Team Member access is read-only for quote status changes.", "warning");
        return;
      }
      const allQuotes = quotes();
      const index = allQuotes.findIndex((itemQuote) => quoteId(itemQuote) === quoteId(quote));
      if (index >= 0) {
        allQuotes[index].status = select.value;
        allQuotes[index].statusUpdatedAt = new Date().toISOString();
        if (select.value === "completed_pending_approval") {
          allQuotes[index].completedAt = new Date().toISOString();
          allQuotes[index].completedBy = currentUser?.username || "Unknown";
        }
        if (select.value === "approved") {
          allQuotes[index].approvedAt = new Date().toISOString();
          allQuotes[index].approvedBy = currentUser?.username || "Unknown";
        }
        saveJson(QUOTES_KEY, allQuotes);
        renderDashboard();
      }
    });
    const completeButton = document.createElement("button");
    completeButton.className = "secondary-button";
    completeButton.type = "button";
    completeButton.textContent = "Complete";
    completeButton.disabled = !canComplete || status === "approved" || status === "completed_pending_approval";
    completeButton.addEventListener("click", () => markQuoteCompleted(quoteId(quote)));
    const approveButton = document.createElement("button");
    approveButton.className = "primary-button";
    approveButton.type = "button";
    approveButton.textContent = "Approve";
    approveButton.disabled = !canApprove;
    approveButton.addEventListener("click", () => approveQuote(quoteId(quote)));
    actions.append(select, completeButton, approveButton);
    item.append(actions);
    return item;
  }));
}

function updateQuoteStatus(id, patch) {
  const allQuotes = quotes();
  const index = allQuotes.findIndex((itemQuote) => quoteId(itemQuote) === id);
  if (index < 0) return false;
  allQuotes[index] = {
    ...allQuotes[index],
    ...patch,
    statusUpdatedAt: new Date().toISOString()
  };
  saveJson(QUOTES_KEY, allQuotes);
  renderDashboard();
  return true;
}

function markQuoteCompleted(id) {
  const quote = quotes().find((itemQuote) => quoteId(itemQuote) === id);
  if (!(currentUser?.role === "member" && quote && isAssignedToCurrentUser(quote))) {
    setMessage("Only the assigned Team Member can submit this job as completed.", "warning");
    return;
  }
  if (!updateQuoteStatus(id, {
    status: "completed_pending_approval",
    completedAt: new Date().toISOString(),
    completedBy: currentUser?.username || "Unknown"
  })) return;
  setMessage("Job marked completed. It now needs approval from Owner Admin or Team Leader.", "success");
}

function approveQuote(id) {
  if (!(currentUser?.role === "owner" || currentUser?.role === "leader")) {
    setMessage("Only Owner Admin or Team Leader can approve completed jobs.", "warning");
    return;
  }
  if (!updateQuoteStatus(id, {
    status: "approved",
    approvedAt: new Date().toISOString(),
    approvedBy: currentUser?.username || "Unknown"
  })) return;
  setMessage("Completed job approved.", "success");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normaliseHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function importedValue(record, names, fallback = "") {
  for (const name of names) {
    const value = record[normaliseHeader(name)];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function importJobsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normaliseHeader);
  return rows.slice(1).map((row) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]));
    const price = Number(importedValue(record, ["price", "quote", "amount", "total"], 0));
    const area = Number(importedValue(record, ["area", "lawn area", "sqm", "m2"], 0));
    const edging = Number(importedValue(record, ["edging", "edge", "edging metres"], 0));
    const minutes = Number(importedValue(record, ["minutes", "time", "estimated minutes"], 0));
    const status = normaliseHeader(importedValue(record, ["status"], "pending"));
    return {
      id: crypto.randomUUID(),
      customerName: importedValue(record, ["customer", "customer name", "name"]),
      address: importedValue(record, ["address", "job address", "property"]),
      jobType: importedValue(record, ["job type", "type", "service"], "imported"),
      price: Number.isFinite(price) ? price : 0,
      low: Number.isFinite(price) ? price : 0,
      high: Number.isFinite(price) ? price : 0,
      minutes: Number.isFinite(minutes) ? minutes : 0,
      area: Number.isFinite(area) ? area : 0,
      edging: Number.isFinite(edging) ? edging : 0,
      difficulty: 1,
      zones: [],
      notes: [importedValue(record, ["notes", "note", "description"], "Imported from CSV")],
      breakdown: [{ label: "Imported job", value: Number.isFinite(price) ? money(price) : money(0) }],
      formState: {
        customerName: importedValue(record, ["customer", "customer name", "name"]),
        address: importedValue(record, ["address", "job address", "property"]),
        jobType: importedValue(record, ["job type", "type", "service"], "imported"),
        notes: importedValue(record, ["notes", "note", "description"], "Imported from CSV"),
        zones: []
      },
      status: ["pending", "accepted", "completed", "completedpendingapproval", "approved", "rejected"].includes(status)
        ? status.replace("completed", "completed_pending_approval").replace("completed_pending_approvalpendingapproval", "completed_pending_approval")
        : "pending",
      importedAt: new Date().toISOString(),
      createdAt: importedValue(record, ["date", "created", "created at"], new Date().toISOString())
    };
  }).filter((job) => job.customerName || job.address);
}

function renderTeam(existingResult = null) {
  if (!teamList) return;
  const result = existingResult || { ok: true, users: teamUsers };
  if (!result.ok) {
    teamList.innerHTML = `<p class="empty-state">${result.message || "Team list unavailable."}</p>`;
    return;
  }
  teamList.replaceChildren(...result.users.map((user) => {
    const item = document.createElement("article");
    item.className = "admin-list-item";
    const approval = user.approvalStatus === "approved" ? "Approved" : "Pending approval";
    const locked = user.lockedAt && (!user.unlockedAt || new Date(user.lockedAt) > new Date(user.unlockedAt));
    item.innerHTML = `
      <div>
        <strong>${user.username} · ${user.email}</strong>
        <span>${user.roleLabel} · ${approval}${locked ? " · Locked" : ""} · ${user.failedLoginCount || 0}/4 failed tries${user.twoFactorEnabled ? " · 2FA on" : " · 2FA off"}</span>
        <span>${profileSummary(user)}</span>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "inline-actions";
    const details = document.createElement("button");
    details.className = "secondary-button";
    details.type = "button";
    details.textContent = "Employee details";
    details.addEventListener("click", () => openEmployeeProfileEditor(user, {
      currentUser,
      setMessage,
      onSaved: async () => {
        const result = await listTeamMembers();
        teamUsers = result.ok ? result.users : teamUsers;
        renderTeam(result.ok ? result : null);
      }
    }));
    actions.append(details);
    const role = document.createElement("select");
    for (const [value, label] of Object.entries(currentRoles)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = user.role === value;
      role.append(option);
    }
    role.addEventListener("change", async () => {
      const update = await updateTeamMember(user.id, role.value);
      setMessage(update.ok ? "Team access updated." : update.message, update.ok ? "success" : "warning");
      await renderTeam();
    });
    role.disabled = currentUser?.role !== "owner";
    const approve = document.createElement("button");
    approve.className = "primary-button";
    approve.type = "button";
    approve.textContent = "Approve";
    approve.disabled = user.approvalStatus === "approved";
    approve.addEventListener("click", async () => {
      const approved = await approveTeamMember(user.id);
      const notification = notificationSent(approved.notification)
        ? "Approval email sent to team user."
        : notificationAccepted(approved.notification)
          ? "Approval email queued for team user."
          : `Approval email not sent: ${approved.notification?.error || "mail transport unavailable"}`;
      setMessage(approved.ok ? `Team login approved. They can now sign in. ${notification}` : approved.message, approved.ok && notificationAccepted(approved.notification) ? "success" : "warning");
      await renderSecurity();
    });
    const unlock = document.createElement("button");
    unlock.className = "secondary-button";
    unlock.type = "button";
    unlock.textContent = "Unlock";
    unlock.disabled = !locked;
    unlock.addEventListener("click", async () => {
      const unlocked = await unlockTeamMember(user.id);
      setMessage(unlocked.ok ? "Team login unlocked." : unlocked.message, unlocked.ok ? "success" : "warning");
      await renderSecurity();
    });
    const remove = document.createElement("button");
    remove.className = "danger-button";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.disabled = user.id === currentUser?.id;
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete login for ${user.username}?`)) return;
      const deleted = await deleteTeamMember(user.id);
      setMessage(deleted.ok ? "Team login deleted." : deleted.message, deleted.ok ? "success" : "warning");
      await renderTeam();
    });
    if (currentUser?.role === "owner") actions.append(role, approve, unlock, remove);
    item.append(actions);
    return item;
  }));
}

async function renderLoginActivity() {
  if (!loginActivityList) return;
  const result = await listLoginActivity();
  if (!result.ok) {
    loginActivityList.innerHTML = `<p class="empty-state">${result.message || "Login activity unavailable."}</p>`;
    return;
  }
  if (!result.logins.length) {
    loginActivityList.innerHTML = `<p class="empty-state">No login activity recorded yet.</p>`;
    return;
  }
  loginActivityList.replaceChildren(...result.logins.slice(0, 80).map((login) => {
    const item = document.createElement("article");
    item.className = "admin-list-item activity-item";
    const location = login.location || {};
    const device = login.device || {};
    item.innerHTML = `
      <div>
        <strong>${login.username || "Unknown"} · ${login.roleLabel || login.role || "Role unknown"}${login.active ? " · Active" : ""}</strong>
        <span>${login.email || "No email"} · ${login.ip || "IP unknown"}</span>
      </div>
      <div class="activity-meta">
        <span><b>Login</b>${dateTimeLabel(login.loginAt)}</span>
        <span><b>Duration</b>${durationLabel(login.durationSeconds)}</span>
        <span><b>Device</b>${device.type || "Unknown"} · ${device.browser || "Browser unknown"} · ${device.os || "OS unknown"}</span>
        <span><b>Location</b>${location.timezone || "Timezone unknown"} · ${locationLabel(location)}</span>
      </div>
    `;
    return item;
  }));
}

async function renderSecurityAudit() {
  if (!securityAuditList) return;
  const result = await listSecurityAudit();
  if (!result.ok) {
    securityAuditList.innerHTML = `<p class="empty-state">${result.message || "Security audit unavailable."}</p>`;
    return;
  }
  if (!result.events.length) {
    securityAuditList.innerHTML = `<p class="empty-state">No security audit events recorded yet.</p>`;
    return;
  }
  securityAuditList.replaceChildren(...result.events.slice(0, 100).map((event) => {
    const item = document.createElement("article");
    item.className = "admin-list-item activity-item";
    const actor = event.actor?.username || "System";
    const target = event.target?.username || event.target?.email || event.target?.filename || event.target?.to || "No target";
    item.innerHTML = `
      <div>
        <strong>${event.action.replaceAll("_", " ")}</strong>
        <span>${actor} · ${target}</span>
      </div>
      <div class="activity-meta">
        <span><b>Time</b>${dateTimeLabel(event.createdAt)}</span>
        <span><b>IP</b>${event.ip || "Not recorded"}</span>
        <span><b>Device</b>${event.device ? `${event.device.type} · ${event.device.browser}` : "Not recorded"}</span>
        <span><b>Details</b>${event.details ? JSON.stringify(event.details) : "None"}</span>
      </div>
    `;
    return item;
  }));
}

function renderMaterials() {
  const saved = loadJson(MATERIALS_KEY, null);
  if (!saved) {
    materialsSummary.innerHTML = `<p class="empty-state">Enter quantities to calculate material and delivery costs.</p>`;
    return;
  }
  const rows = [
    ["Mulch", money(saved.mulch)],
    ["Soil", money(saved.soil)],
    ["Turf", money(saved.turf)],
    ["Gravel", money(saved.gravel)],
    ["Plants", money(saved.plants)],
    ["Disposal", money(saved.disposal)],
    ["Delivery", money(saved.delivery)],
    ["Total", money(saved.total)]
  ];
  materialsSummary.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    return row;
  }));
}

async function refreshAdmin() {
  await renderSecurity();
  renderDashboard();
  renderMaterials();
}

async function updateMode() {
  const configured = await hasAdminAccount();
  const loggedIn = !logoutRequested() && await isAdminLoggedIn();
  authPanel.hidden = loggedIn;
  adminPanel.hidden = !loggedIn;
  if (topActions) topActions.hidden = !loggedIn;
  setupPanel.hidden = configured;
  loginPanel.hidden = !configured;
  if (loggedIn) {
    await refreshAdmin();
    if (currentUser?.role === "member") location.replace("schedule.html");
  }
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#setup-username").value.trim();
  const email = document.querySelector("#setup-email").value.trim();
  const password = document.querySelector("#setup-password").value;
  const confirmPassword = document.querySelector("#setup-confirm-password").value;
  if (password.length < 8) return setMessage("Use at least 8 characters for the admin password.", "warning");
  if (password !== confirmPassword) return setMessage("Passwords do not match.", "warning");
  try {
    const result = await createOwnerAccount({ username, email, password });
    recoveryOutput.textContent = `Owner recovery code: ${result.recoveryCode}`;
    setMessage("Admin account created. Store the recovery code somewhere safe.", "success");
    await updateMode();
  } catch (error) {
    setMessage(error.message, "warning");
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await loginAdmin(
    document.querySelector("#login-identifier").value.trim(),
    document.querySelector("#login-password").value,
    document.querySelector("#login-2fa-code").value.trim()
  );
  if (!result.ok) return showLoginPopup(result.message);
  await recordCurrentLocation({ force: true });
  location.href = currentNextUrl();
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await changePassword(
    document.querySelector("#current-password").value,
    document.querySelector("#new-password").value
  );
  setMessage(result.ok ? "Password changed." : result.message, result.ok ? "success" : "warning");
  passwordForm.reset();
  await refreshAdmin();
});

recoveryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await recoverPassword(
    document.querySelector("#recovery-identifier").value.trim(),
    document.querySelector("#recovery-code").value.trim(),
    document.querySelector("#recovery-new-password").value
  );
  if (result.ok) {
    recoveryOutput.textContent = `New recovery code: ${result.recoveryCode}`;
    setMessage("Password recovered. Store the new recovery code.", "success");
    recoveryForm.reset();
    await updateMode();
  } else {
    setMessage(result.message, "warning");
  }
});

twoFactorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const enabled = document.querySelector("#two-factor-enabled").checked;
  const code = document.querySelector("#two-factor-code").value.trim();
  if (enabled && !/^\d{6}$/.test(code)) return setMessage("Enter the 6-digit code from your authenticator app.", "warning");
  const result = await updateTwoFactor(enabled, code, pendingTwoFactorSecret);
  setMessage(result.ok ? "2FA settings updated." : result.message, result.ok ? "success" : "warning");
  if (result.ok) {
    pendingTwoFactorSecret = "";
    twoFactorSetup.replaceChildren();
  }
  twoFactorForm.reset();
  await refreshAdmin();
});

document.querySelector("#prepare-2fa").addEventListener("click", async () => {
  const setup = await getTwoFactorSetup();
  if (!setup.ok) return setMessage(setup.message, "warning");
  pendingTwoFactorSecret = setup.secret;
  twoFactorSetup.replaceChildren();
  const key = document.createElement("div");
  const uri = document.createElement("div");
  key.className = "setup-key";
  uri.className = "setup-uri";
  key.innerHTML = `<span>Manual setup key</span><strong>${setup.secret}</strong>`;
  uri.innerHTML = `<span>Authenticator URI</span><code>${setup.otpauthUrl}</code>`;
  twoFactorSetup.append(key, uri);
  document.querySelector("#two-factor-enabled").checked = true;
  setMessage("Add the setup key to 2FAS or another authenticator app, then enter the 6-digit code.", "success");
});

document.querySelector("#test-security-email")?.addEventListener("click", async () => {
  securityToolOutput.innerHTML = `<p class="empty-state">Sending test email...</p>`;
  const result = await sendTestSecurityEmail();
  securityToolOutput.innerHTML = `<p class="empty-state">${result.message || (result.ok ? "Test email sent." : "Test email failed.")}</p>`;
  setMessage(result.ok ? "Security test email accepted for delivery." : result.message, result.ok ? "success" : "warning");
  await renderSecurityAudit();
});

document.querySelector("#create-backup")?.addEventListener("click", async () => {
  securityToolOutput.innerHTML = `<p class="empty-state">Creating encrypted backup...</p>`;
  const result = await createEncryptedBackup();
  if (result.ok) {
    securityToolOutput.innerHTML = `<p class="empty-state">Encrypted backup created: ${result.backup.filename}</p>`;
    setMessage("Encrypted backup created.", "success");
  } else {
    securityToolOutput.innerHTML = `<p class="empty-state">${result.message || "Backup failed."}</p>`;
    setMessage(result.message || "Backup failed.", "warning");
  }
  await renderSecurityAudit();
});

materialForm.addEventListener("input", () => {
  if (currentUser?.role === "member") return;
  const material = (id) => Number(document.querySelector(`#${id}`).value || 0);
  const calculated = {
    mulch: material("mulch-cubic") * material("mulch-rate"),
    soil: material("soil-cubic") * material("soil-rate"),
    turf: material("turf-sqm") * material("turf-rate"),
    gravel: material("gravel-cubic") * material("gravel-rate"),
    plants: material("plant-count") * material("plant-rate"),
    disposal: material("disposal-loads") * material("disposal-rate"),
    delivery: material("delivery-fee")
  };
  calculated.total = Object.values(calculated).reduce((sum, value) => sum + value, 0);
  saveJson(MATERIALS_KEY, calculated);
  renderMaterials();
});

teamForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await createTeamMember({
    username: document.querySelector("#team-username").value.trim(),
    email: document.querySelector("#team-email").value.trim(),
    password: document.querySelector("#team-password").value,
    role: document.querySelector("#team-role").value,
    ...employeeProfileFromForm(teamForm),
    email: document.querySelector("#team-email").value.trim(),
    credentials: newTeamCredentials
  });
  if (result.ok) {
    teamForm.reset();
    newTeamCredentials = [];
    refreshTeamCredentialDraft();
    recoveryOutput.textContent = `${result.user.username} recovery code: ${result.recoveryCode}`;
    const ownerNotification = result.notifications?.owner || result.notification;
    const teamNotification = result.notifications?.team;
    const ownerEmail = notificationSent(ownerNotification)
      ? "Owner email notification sent."
      : notificationAccepted(ownerNotification)
        ? "Owner email notification queued."
        : `Owner email notification not sent: ${ownerNotification?.error || "mail transport unavailable"}`;
    const teamEmail = notificationSent(teamNotification)
      ? "Pending approval email sent to team user."
      : notificationAccepted(teamNotification)
        ? "Pending approval email queued for team user."
        : `Pending approval email not sent to team user: ${teamNotification?.error || "mail transport unavailable"}`;
    window.alert("Team login has been created and is pending Owner Admin approval.");
    setMessage(`Team login created and pending Owner Admin approval. ${ownerEmail} ${teamEmail}`, notificationAccepted(ownerNotification) && notificationAccepted(teamNotification) ? "success" : "warning");
    await renderSecurity();
  } else {
    setMessage(result.message, "warning");
  }
});

jobImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(currentUser?.role === "owner" || currentUser?.role === "leader")) {
    setMessage("Only Owner Admin or Team Leader can import jobs.", "warning");
    return;
  }
  const [file] = document.querySelector("#job-import-file").files;
  if (!file) return setMessage("Choose a CSV file first.", "warning");
  const imported = importJobsFromCsv(await file.text());
  if (!imported.length) return setMessage("No valid jobs found in the CSV file.", "warning");
  saveJson(QUOTES_KEY, [...imported, ...quotes()].slice(0, 250));
  jobImportForm.reset();
  renderDashboard();
  setMessage(`Imported ${imported.length} job${imported.length === 1 ? "" : "s"} from CSV.`, "success");
});

document.querySelector("#logout-admin").addEventListener("click", () => {
  logoutAdmin();
});

enhancePasswordFields();
if (teamForm && teamCredentialLabel && teamCredentialFile && addTeamCredential && teamCredentialList) {
  refreshTeamCredentialDraft = setupCredentialDraft({
    labelInput: teamCredentialLabel,
    fileInput: teamCredentialFile,
    addButton: addTeamCredential,
    list: teamCredentialList,
    getCredentials: () => newTeamCredentials,
    setCredentials: (next) => { newTeamCredentials = next; },
    setMessage
  });
}
await initAccessibleNavigation();
await updateMode();
