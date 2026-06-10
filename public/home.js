import { authStatus, listQuoteJobs, listRecurringJobs, listRosterJobs } from "./auth.js";

const statusLabel = document.querySelector("#home-status");
const quotesKpi = document.querySelector("#home-kpi-quotes");
const rosterKpi = document.querySelector("#home-kpi-roster");
const approvalsKpi = document.querySelector("#home-kpi-approvals");
const recurringKpi = document.querySelector("#home-kpi-recurring");
const todayTitle = document.querySelector("#home-today-title");
const todayList = document.querySelector("#home-today-list");

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

async function initHomeDashboard() {
  const status = await authStatus();
  if (!status.loggedIn) {
    statusLabel.textContent = "Sign in for live figures";
    setEmptyState("Sign in to see today’s roster and operations counts.");
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
  renderTodayJobs(rosterJobs);
}

initHomeDashboard().catch(() => {
  statusLabel.textContent = "Live overview unavailable";
  setEmptyState("Open Schedule to view rostered work.");
});
