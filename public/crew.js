import { authStatus, completeRosterJob, initAccessibleNavigation, listRosterJobs, logoutAdmin, requireAdminSession, saveRosterWorklog } from "./auth.js";

const crewList = document.querySelector("#crew-list");
const routeSummary = document.querySelector("#crew-route-summary");
const logoutButton = document.querySelector("#logout-admin");
const crewStats = document.querySelector("#crew-stats");
const nextTitle = document.querySelector("#crew-next-title");
const nextDetail = document.querySelector("#crew-next-detail");

let currentUser = null;
let rosterJobs = [];

function dateValue(date) {
  const copy = new Date(date);
  copy.setHours(12, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}

function dateLabel(value) {
  if (!value) return "No date";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function mapUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || "")}`;
}

function smsUrl(job) {
  const phone = String(job.customerPhone || job.phone || job.mobile || "").replace(/\s+/g, "");
  const body = encodeURIComponent(`Hi ${job.customerName || "there"}, this is MACS. We are on our way to your property now.`);
  return phone ? `sms:${phone}?&body=${body}` : "";
}

function statusLabel(status) {
  const labels = {
    assigned: "Assigned",
    completed_pending_approval: "Awaiting approval",
    approved: "Approved",
    completed: "Completed"
  };
  return labels[status] || status || "Assigned";
}

function statusBadge(status) {
  return `<span class="status-badge" data-status="${String(status || "assigned").replace(/[&<>"']/g, "")}">${statusLabel(status)}</span>`;
}

function canSee(job) {
  return ["owner", "leader"].includes(currentUser?.role) || job.assignedTo === currentUser?.id || job.assignedUsername === currentUser?.username;
}

function visibleJobs() {
  const today = dateValue(new Date());
  return rosterJobs
    .filter(canSee)
    .filter((job) => job.scheduledDate >= today && job.status !== "approved")
    .sort((a, b) => `${a.scheduledDate || ""} ${a.startTime || ""}`.localeCompare(`${b.scheduledDate || ""} ${b.startTime || ""}`));
}

function renderFieldStats(jobs) {
  const today = dateValue(new Date());
  const todayJobs = jobs.filter((job) => job.scheduledDate === today);
  const checkedIn = jobs.filter((job) => job.actualStartTime && !job.actualFinishTime).length;
  const awaitingApproval = jobs.filter((job) => job.status === "completed_pending_approval").length;
  const stats = [
    ["Today", todayJobs.length],
    ["Upcoming", jobs.length],
    ["Checked in", checkedIn],
    ["Awaiting approval", awaitingApproval]
  ];
  crewStats.replaceChildren(...stats.map(([label, value]) => {
    const card = document.createElement("div");
    card.className = "field-stat";
    card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    return card;
  }));
}

function renderNextJob(jobs) {
  const today = dateValue(new Date());
  const next = jobs.find((job) => job.scheduledDate === today && !job.actualFinishTime) || jobs.find((job) => !job.actualFinishTime) || jobs[0];
  if (!next) {
    nextTitle.textContent = "No assigned jobs";
    nextDetail.textContent = "Nothing is currently assigned to this route.";
    return;
  }
  nextTitle.textContent = next.title || next.customerName || next.address || "Next roster job";
  nextDetail.textContent = [
    dateLabel(next.scheduledDate),
    `${next.startTime || "No start"}-${next.finishTime || "No finish"}`,
    next.address || "No address saved"
  ].join(" · ");
}

async function saveCheck(job, patch, button) {
  button.disabled = true;
  const result = await saveRosterWorklog({
    id: job.id,
    actualStartTime: patch.actualStartTime ?? job.actualStartTime,
    actualFinishTime: patch.actualFinishTime ?? job.actualFinishTime,
    actualMinutes: patch.actualMinutes ?? job.actualMinutes,
    materials: Array.isArray(job.materials) ? job.materials : [],
    workNotes: patch.workNotes ?? job.workNotes
  });
  if (result.ok) {
    await loadJobs();
  } else {
    button.textContent = "Failed";
    button.disabled = false;
  }
}

async function submitComplete(job, button) {
  button.disabled = true;
  button.textContent = "Submitting...";
  const result = await completeRosterJob(job.id);
  if (result.ok) {
    await loadJobs();
    return;
  }
  button.textContent = result.message || "Failed";
  button.disabled = false;
}

function renderCrewJobs() {
  const jobs = visibleJobs();
  renderFieldStats(jobs);
  renderNextJob(jobs);
  if (!jobs.length) {
    crewList.innerHTML = `<p class="empty-state">No upcoming assigned jobs.</p>`;
    routeSummary.textContent = "No pricing visible in crew mode";
    return;
  }
  crewList.classList.add("timeline-route");
  const todayCount = jobs.filter((job) => job.scheduledDate === dateValue(new Date())).length;
  routeSummary.textContent = `${todayCount} today · ${jobs.length} upcoming · no pricing visible`;
  crewList.replaceChildren(...jobs.map((job, index) => {
    const item = document.createElement("article");
    item.className = "crew-job";
    item.dataset.status = job.status || "assigned";
    const sms = smsUrl(job);
    item.innerHTML = `
      <div class="route-index">${index + 1}</div>
      <div class="route-job-main">
        <strong>${job.title || job.customerName || job.address || "Roster job"}</strong>
        <span>${dateLabel(job.scheduledDate)} · ${job.startTime || "No start"}-${job.finishTime || "No finish"}</span>
        <small>${job.address || "No address"}</small>
        <small>${[job.customerName || "", job.customerPhone || "", job.customerEmail || ""].filter(Boolean).join(" · ") || "No customer contact saved"}</small>
        <div class="job-meta-row">
          ${statusBadge(job.status)}
          <span class="app-chip">${job.actualStartTime ? `Checked in ${job.actualStartTime}` : "Not checked in"}</span>
          <span class="app-chip">${job.actualFinishTime ? `Completed ${job.actualFinishTime}` : "Open"}</span>
        </div>
        <label class="field-note">
          Field notes
          <textarea data-field-note rows="2" placeholder="Gate code, access issue, work completed">${job.workNotes || ""}</textarea>
        </label>
      </div>
      <div class="crew-actions">
        <a class="secondary-button field-action-button" href="${mapUrl(job.address)}" target="_blank" rel="noreferrer">Route</a>
        ${sms ? `<a class="secondary-button field-action-button" href="${sms}">On my way SMS</a>` : ""}
        <button class="secondary-button field-action-button" type="button" data-action="checkin">Check in</button>
        <button class="secondary-button field-action-button" type="button" data-action="save-note">Save notes</button>
        <button class="primary-button field-action-button" type="button" data-action="complete">Complete Job</button>
      </div>
    `;
    item.querySelector('[data-action="checkin"]').addEventListener("click", (event) => {
      const now = new Date();
      saveCheck(job, { actualStartTime: now.toTimeString().slice(0, 5) }, event.currentTarget);
    });
    item.querySelector('[data-action="complete"]').addEventListener("click", (event) => {
      submitComplete(job, event.currentTarget);
    });
    item.querySelector('[data-action="save-note"]').addEventListener("click", (event) => {
      const note = item.querySelector("[data-field-note]").value.trim();
      saveCheck(job, { workNotes: note }, event.currentTarget);
    });
    return item;
  }));
}

async function loadJobs() {
  const result = await listRosterJobs();
  rosterJobs = result.ok ? result.jobs : [];
  renderCrewJobs();
}

async function init() {
  if (!await requireAdminSession()) return;
  const nav = await initAccessibleNavigation();
  currentUser = nav.user || (await authStatus()).user;
  await loadJobs();
}

logoutButton.addEventListener("click", logoutAdmin);
init();
