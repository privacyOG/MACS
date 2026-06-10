import { authStatus, initAccessibleNavigation, listFieldOperations, listRosterJobs, requireAdminSession } from "./auth.js";

const groupSelect = document.querySelector("#report-group");
const downloadButton = document.querySelector("#download-report");
const stats = document.querySelector("#report-stats");
const reportList = document.querySelector("#report-list");
const messageLogList = document.querySelector("#message-log-list");
const locationLogList = document.querySelector("#location-log-list");

let rosterJobs = [];
let fieldOperations = { messages: [], locations: [] };

function dateLabel(value) {
  if (!value) return "No date";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function minutesLabel(minutes) {
  const total = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function locationLabel(location) {
  if (!location?.latitude || !location?.longitude) return "No GPS";
  const accuracy = location.accuracy ? ` · ${Math.round(location.accuracy)}m` : "";
  return `${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)}${accuracy}`;
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

function loggedJobs() {
  return rosterJobs.filter((job) => Number(job.actualMinutes || 0) > 0 || job.actualStartTime || job.actualFinishTime);
}

function groupKey(job) {
  if (groupSelect.value === "employee") return job.assignedUsername || "Unassigned";
  if (groupSelect.value === "crew") return job.assignedUsername || job.assignedTo || "Crew";
  return job.scheduledDate || "No date";
}

function groupLabel(key) {
  return groupSelect.value === "date" ? dateLabel(key) : key;
}

function addStat(label, value) {
  const card = document.createElement("article");
  card.className = "dashboard-stat";
  card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  stats.append(card);
}

function renderReports() {
  const jobs = loggedJobs();
  const totalMinutes = jobs.reduce((sum, job) => sum + Number(job.actualMinutes || 0), 0);
  stats.replaceChildren();
  addStat("Entries", jobs.length);
  addStat("Total time", minutesLabel(totalMinutes));
  addStat("Employees", new Set(jobs.map((job) => job.assignedUsername || "Unassigned")).size);
  addStat("Days", new Set(jobs.map((job) => job.scheduledDate || "No date")).size);

  if (!jobs.length) {
    reportList.innerHTML = `<p class="empty-state">No time has been logged yet.</p>`;
    return;
  }

  const groups = new Map();
  for (const job of jobs) {
    const key = groupKey(job);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  reportList.replaceChildren(...[...groups.entries()].map(([key, entries]) => {
    const minutes = entries.reduce((sum, job) => sum + Number(job.actualMinutes || 0), 0);
    const section = document.createElement("article");
    section.className = "report-group";
    section.innerHTML = `
      <header>
        <strong>${groupLabel(key)}</strong>
        <span>${entries.length} entries · ${minutesLabel(minutes)}</span>
      </header>
    `;
    const list = document.createElement("div");
    list.className = "report-entry-list";
    list.replaceChildren(...entries.map((job) => {
      const row = document.createElement("div");
      row.className = "report-entry";
      row.innerHTML = `
        <strong>${job.assignedUsername || "Unassigned"} · ${job.title || job.customerName || job.address || "Roster job"}</strong>
        <span>${dateLabel(job.scheduledDate)} · ${job.actualStartTime || "--"}-${job.actualFinishTime || "--"} · ${minutesLabel(job.actualMinutes)}</span>
        <small>${job.address || "No address"} · In: ${locationLabel(job.checkInLocation)} · Out: ${locationLabel(job.checkOutLocation)}${job.workNotes ? ` · ${job.workNotes}` : ""}</small>
      `;
      return row;
    }));
    section.append(list);
    return section;
  }));
}

function renderFieldOperations() {
  const messages = Array.isArray(fieldOperations.messages) ? fieldOperations.messages : [];
  const locations = Array.isArray(fieldOperations.locations) ? fieldOperations.locations : [];

  if (!messages.length) {
    messageLogList.innerHTML = `<p class="empty-state">No field messages logged yet.</p>`;
  } else {
    messageLogList.replaceChildren(...messages.slice(0, 80).map((message) => {
      const doc = message.document || {};
      const row = document.createElement("article");
      row.className = "report-group";
      row.innerHTML = `
        <header>
          <strong>${doc.customerName || message.recipient || "Customer message"}</strong>
          <span>${message.channel || doc.channel || "message"} · ${message.status || doc.status || "logged"}</span>
        </header>
        <div class="report-entry-list">
          <div class="report-entry">
            <strong>${doc.subject || message.subject || "On my way SMS"}</strong>
            <span>${dateTimeLabel(message.createdAt || message.sentAt || doc.createdAt)} · ${doc.createdBy || "System"}</span>
            <small>${doc.address || "No address"} · ${message.recipient || doc.recipient || "No recipient"}</small>
          </div>
        </div>
      `;
      return row;
    }));
  }

  if (!locations.length) {
    locationLogList.innerHTML = `<p class="empty-state">No crew GPS pings logged yet.</p>`;
  } else {
    locationLogList.replaceChildren(...locations.slice(0, 80).map((location) => {
      const doc = location.document || {};
      const row = document.createElement("article");
      row.className = "report-group";
      row.innerHTML = `
        <header>
          <strong>${location.username || doc.username || "Crew member"}</strong>
          <span>${location.kind || "location"} · ${dateTimeLabel(location.capturedAt)}</span>
        </header>
        <div class="report-entry-list">
          <div class="report-entry">
            <strong>${doc.customerName || doc.address || location.rosterJobId || "Field location"}</strong>
            <span>${locationLabel(location)}${doc.scheduledDate ? ` · ${dateLabel(doc.scheduledDate)}` : ""}</span>
            <small>${doc.address || "No address"} · Job ${location.rosterJobId || "not linked"}</small>
          </div>
        </div>
      `;
      return row;
    }));
  }
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function downloadCsv() {
  const rows = [["Date", "Employee", "Customer", "Address", "Start", "Finish", "Minutes", "Notes", "Check-in GPS", "Check-out GPS"]];
  for (const job of loggedJobs()) {
    rows.push([
      job.scheduledDate,
      job.assignedUsername,
      job.customerName,
      job.address,
      job.actualStartTime,
      job.actualFinishTime,
      job.actualMinutes,
      job.workNotes,
      locationLabel(job.checkInLocation),
      locationLabel(job.checkOutLocation)
    ]);
  }
  const csv = rows.map((row) => row.map(csvValue).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `macs-time-report-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function init() {
  if (!await requireAdminSession()) return;
  await initAccessibleNavigation();
  const status = await authStatus();
  if (!["owner", "leader"].includes(status.user?.role)) {
    reportList.innerHTML = `<p class="empty-state">Only Owner Admin and Team Leader can view time reports.</p>`;
    return;
  }
  const result = await listRosterJobs();
  rosterJobs = result.ok ? result.jobs : [];
  const operations = await listFieldOperations();
  fieldOperations = operations.ok ? { messages: operations.messages || [], locations: operations.locations || [] } : { messages: [], locations: [] };
  renderReports();
  renderFieldOperations();
}

groupSelect.addEventListener("change", renderReports);
downloadButton.addEventListener("click", downloadCsv);
init();
