import { authStatus, listQuoteJobs, listRecurringJobs, listRosterJobs } from "./auth.js";

const statusLabel = document.querySelector("#home-status");
const quotesKpi = document.querySelector("#home-kpi-quotes");
const rosterKpi = document.querySelector("#home-kpi-roster");
const approvalsKpi = document.querySelector("#home-kpi-approvals");
const recurringKpi = document.querySelector("#home-kpi-recurring");
const todayTitle = document.querySelector("#home-today-title");
const todayList = document.querySelector("#home-today-list");
const roleHeading = document.querySelector("#home-role-heading");
const roleSummary = document.querySelector("#home-role-summary");
const alertRow = document.querySelector("#home-alerts");

function todayValue() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function timeRange(job) {
  return `${job.startTime || "No start"}-${job.finishTime || "No finish"}`;
}

function jobTitle(job) {
  return job.title || job.customerName || job.address || "Roster job";
}

function contactLabel(job) {
  const phone = job.customerPhone || job.phone || job.mobile || "";
  const email = job.customerEmail || job.email || "";
  return [phone, email].filter(Boolean).join(" · ");
}

function setEmptyState(message) {
  todayList.replaceChildren();
  const item = document.createElement("p");
  item.textContent = message;
  todayList.append(item);
}

function renderTodayJobs(jobs = []) {
  const today = todayValue();
  const todaysJobs = jobs
    .filter((job) => job.scheduledDate === today)
    .sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")))
    .slice(0, 5);
  todayTitle.textContent = todaysJobs.length ? `${todaysJobs.length} visit${todaysJobs.length === 1 ? "" : "s"} today` : "No visits today";
  if (!todaysJobs.length) {
    setEmptyState("No rostered jobs scheduled for today.");
    return;
  }
  todayList.replaceChildren(...todaysJobs.map((job) => {
    const item = document.createElement("a");
    item.href = "schedule.html";
    item.className = "today-job";
    const contact = contactLabel(job);
    item.innerHTML = `
      <strong>${jobTitle(job)}</strong>
      <span>${timeRange(job)} · ${job.address || "No address"}</span>
      <small>${contact || job.assignedUsername || "No customer contact saved"}</small>
    `;
    return item;
  }));
}

function renderRoleDashboard(user, { quotes = [], rosterJobs = [], recurring = [], approvals = 0 } = {}) {
  const role = user?.role || "guest";
  const assignedToday = rosterJobs.filter((job) => job.scheduledDate === todayValue() && (job.assignedTo === user?.id || job.assignedUsername === user?.username));
  const unrosteredQuotes = quotes.filter((quote) => !quote.scheduledDate && !["archived", "approved"].includes(quote.status));
  const invoiceReady = rosterJobs.filter((job) => job.status === "approved").length;
  if (!user) {
    roleHeading.textContent = "MACS command centre";
    roleSummary.textContent = "Sign in to unlock live dashboards, route lists, quoting, approvals, and crew workflows.";
  } else if (role === "member") {
    roleHeading.textContent = `Today’s field route for ${user.username}`;
    roleSummary.textContent = assignedToday.length
      ? `${assignedToday.length} assigned visit${assignedToday.length === 1 ? "" : "s"} today. Open Crew to navigate, check in, SMS, and complete jobs.`
      : "No assigned visits today. Open Crew for upcoming work and profile details.";
  } else {
    roleHeading.textContent = `Owner dashboard for ${user.username}`;
    roleSummary.textContent = `${approvals} completion${approvals === 1 ? "" : "s"} awaiting approval, ${unrosteredQuotes.length} quote${unrosteredQuotes.length === 1 ? "" : "s"} needing schedule, ${invoiceReady} approved job${invoiceReady === 1 ? "" : "s"} ready for invoicing.`;
  }

  alertRow.replaceChildren();
  for (const [label, value] of [
    ["Needs approval", approvals],
    ["Unscheduled quotes", unrosteredQuotes.length],
    ["Today assigned", assignedToday.length],
    ["Recurring active", recurring.filter((job) => job.status !== "archived").length]
  ]) {
    const chip = document.createElement("span");
    chip.className = "app-chip";
    chip.textContent = `${label}: ${value}`;
    alertRow.append(chip);
  }
}

async function initHomeDashboard() {
  const status = await authStatus();
  if (!status.loggedIn) {
    statusLabel.textContent = "Sign in for live figures";
    setEmptyState("Sign in to see today’s roster and operations counts.");
    renderRoleDashboard(null);
    return;
  }

  statusLabel.textContent = `${status.user.username} · ${status.user.roleLabel}`;
  const [quoteResult, rosterResult, recurringResult] = await Promise.all([
    listQuoteJobs(),
    listRosterJobs(),
    listRecurringJobs()
  ]);

  const quotes = quoteResult.ok ? quoteResult.quotes : [];
  const rosterJobs = rosterResult.ok ? rosterResult.jobs : [];
  const recurring = recurringResult.ok ? recurringResult.jobs : [];
  const approvals = rosterJobs.filter((job) => job.status === "completed_pending_approval").length
    + quotes.filter((quote) => quote.status === "completed_pending_approval").length
    + recurring.filter((job) => job.status === "completed_pending_approval").length;

  quotesKpi.textContent = quotes.length;
  rosterKpi.textContent = rosterJobs.length;
  approvalsKpi.textContent = approvals;
  recurringKpi.textContent = recurring.filter((job) => job.status !== "archived").length;
  renderRoleDashboard(status.user, { quotes, rosterJobs, recurring, approvals });
  renderTodayJobs(rosterJobs);
}

initHomeDashboard().catch(() => {
  statusLabel.textContent = "Live overview unavailable";
  setEmptyState("Open Schedule to view rostered work.");
});
