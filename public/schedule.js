import {
  approveRosterJob,
  authStatus,
  completeRosterJob,
  deleteRosterJob,
  deleteQuoteJobs,
  deleteRecurringJobs,
  initAccessibleNavigation,
  listQuoteJobs,
  listRecurringJobs,
  listRosterJobs,
  listTeamMembers,
  logCustomerMessage,
  logoutAdmin,
  requireAdminSession,
  saveQuoteJobs,
  saveRecurringJobs,
  saveRosterJob,
  saveRosterWorklog,
  sendCrewLocationPing
} from "./auth.js";

const QUOTES_KEY = "lawnquote.history.v1";
const RECURRING_KEY = "lawnquote.recurring.v1";
const GPS_CONSENT_KEY = "lawnquote.crewGpsConsent.v1";
const isAndroidApp = navigator.userAgent.includes("MACS-LawnQuote-Android");

const roleLabel = document.querySelector("#schedule-role");
const statsPanel = document.querySelector("#schedule-stats");
const messagePanel = document.querySelector("#schedule-message");
const recurringEditorCard = document.querySelector("#recurring-editor-card");
const recurringForm = document.querySelector("#recurring-form");
const recurringList = document.querySelector("#recurring-list");
const quoteScheduleList = document.querySelector("#quote-schedule-list");
const quoteSelect = document.querySelector("#recurring-quote");
const assignedSelect = document.querySelector("#recurring-assigned");
const weekRange = document.querySelector("#week-range");
const weekCalendar = document.querySelector("#week-calendar");
const routeDayList = document.querySelector("#route-day-list");
const previousWeekButton = document.querySelector("#prev-week");
const nextWeekButton = document.querySelector("#next-week");
const todayWeekButton = document.querySelector("#today-week");

let currentUser = null;
let teamUsers = [];
let rosterJobs = [];
let quoteCache = [];
let recurringCache = [];
let weekStart = startOfWeek(new Date());
let crewGpsEnabled = false;

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

function quotes() {
  return quoteCache;
}

function recurringJobs() {
  return recurringCache;
}

function quoteId(quote) {
  return quote.id || quote.createdAt;
}

function canManage() {
  return currentUser?.role === "owner" || currentUser?.role === "leader";
}

function money(value) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function dateValue(date) {
  const copy = new Date(date);
  copy.setHours(12, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}

function dateLabel(value) {
  if (!value) return "No date set";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function weekLabel(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function dayLabel(value) {
  const date = new Date(`${value}T12:00:00`);
  const weekday = date.toLocaleDateString("en-AU", { weekday: "short" });
  const numeric = date.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${weekday} ${numeric}`;
}

function statusLabel(status) {
  const labels = {
    active: "Active",
    assigned: "Assigned",
    accepted: "Accepted",
    pending: "Pending quote",
    completed_pending_approval: "Completed - awaiting approval",
    approved: "Completed - approved",
    rejected: "Rejected",
    archived: "Archived"
  };
  return labels[status] || status || "Active";
}

function statusBadge(status) {
  return `<span class="status-badge" data-status="${escapeAttribute(status || "active")}">${statusLabel(status)}</span>`;
}

function teamLabel(id) {
  if (!id) return "Unassigned";
  const user = teamUsers.find((item) => item.id === id || item.username === id);
  return user ? `${user.username} (${user.roleLabel})` : "Unknown team member";
}

function customerContactLabel(item) {
  const phone = item.customerPhone || item.phone || item.mobile || "";
  const email = item.customerEmail || item.email || "";
  return [phone, email].filter(Boolean).join(" · ") || "No customer contact saved";
}

function mapUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || "")}`;
}

function gpsConsent() {
  return localStorage.getItem(GPS_CONSENT_KEY) === "yes";
}

function setGpsConsent(value) {
  localStorage.setItem(GPS_CONSENT_KEY, value ? "yes" : "no");
}

function onMyWaySmsBody(job) {
  return `Hi ${job.customerName || "there"}, this is MACS. We are on our way to your property now.`;
}

function smsUrl(job) {
  const phone = String(job.customerPhone || job.phone || job.mobile || "").replace(/\s+/g, "");
  const body = encodeURIComponent(onMyWaySmsBody(job));
  return phone ? `sms:${phone}?&body=${body}` : "";
}

async function openOnMyWaySms(job, button) {
  const sms = smsUrl(job);
  if (!sms) return setMessage("Customer phone/mobile is required before sending an SMS.", "warning");
  if (button) button.disabled = true;
  const result = await logCustomerMessage({
    rosterJobId: job.id,
    channel: "sms",
    template: "on_my_way",
    recipient: job.customerPhone || job.phone || job.mobile || "",
    body: onMyWaySmsBody(job)
  });
  if (button) button.disabled = false;
  if (!result.ok) {
    setMessage(result.message || "SMS action could not be logged.", "warning");
    return;
  }
  window.location.href = sms;
}

function minutesLabel(minutes) {
  const total = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function materialSummary(job) {
  const materials = Array.isArray(job.materials) ? job.materials : [];
  if (!materials.length) return "No materials logged";
  if (!canManage()) return `${materials.length} material item${materials.length === 1 ? "" : "s"} logged`;
  const cost = materials.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  return `${materials.length} item${materials.length === 1 ? "" : "s"} · ${money(cost)}`;
}

function escapeAttribute(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function isAssignedToCurrentUser(item) {
  return Boolean(item.assignedTo && (item.assignedTo === currentUser?.id || item.assignedTo === currentUser?.username));
}

function isRosterAssignedToCurrentUser(job) {
  return Boolean(job.assignedTo === currentUser?.id || job.assignedUsername === currentUser?.username);
}

function isRosterComplete(job) {
  return Boolean(job.completedAt || job.status === "completed_pending_approval" || job.status === "approved" || job.status === "completed");
}

function isRosterApproved(job) {
  return job.status === "approved";
}

function rosterStartDate(job) {
  if (!job?.scheduledDate || !job?.startTime) return null;
  const date = new Date(`${job.scheduledDate}T${job.startTime}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function itemStartDate(item) {
  const day = item?.scheduledDate || item?.nextRun;
  if (!day || !item?.startTime) return null;
  const date = new Date(`${day}T${item.startTime}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function canCompleteRosterNow(job) {
  const start = rosterStartDate(job);
  return Boolean(start && Date.now() >= start.getTime());
}

function canCompleteItemNow(item) {
  const start = itemStartDate(item);
  return Boolean(start && Date.now() >= start.getTime());
}

function rosteredQuoteIds() {
  return new Set(
    rosterJobs
      .filter((job) => job.sourceType === "quote" && job.sourceId)
      .map((job) => String(job.sourceId))
  );
}

function unrosteredQuotes() {
  const assignedQuoteIds = rosteredQuoteIds();
  return quotes().filter((quote) => !assignedQuoteIds.has(String(quoteId(quote))));
}

function setMessage(message, tone = "info") {
  messagePanel.textContent = message;
  messagePanel.dataset.tone = tone;
}

function showScheduleStartupError(message) {
  roleLabel.textContent = "Schedule unavailable";
  recurringEditorCard.hidden = true;
  routeDayList.closest(".admin-card").hidden = true;
  recurringList.closest(".admin-card").hidden = true;
  quoteScheduleList.closest(".admin-card").hidden = true;
  statsPanel.replaceChildren();
  weekRange.textContent = "Retry required";
  weekCalendar.innerHTML = `<p class="empty-state">The schedule could not finish loading.</p>`;
  setMessage(message || "The schedule could not load. Check the connection and try again.", "warning");
}

function hideSkeletons() {
  document.querySelectorAll(".skeleton-pulse").forEach(el => el.remove());
  const roleEl = document.getElementById("schedule-role");
  if (roleEl) {
    roleEl.classList.remove("skeleton-line", "short");
    roleEl.style.display = "";
    roleEl.style.minHeight = "";
    roleEl.style.width = "";
  }
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date) {
  const start = new Date(date);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(12, 0, 0, 0);
  return start;
}

function nextRunAfter(dateValueText, frequency) {
  const next = new Date(`${dateValueText || dateValue(new Date())}T12:00:00`);
  const days = frequency === "weekly" ? 7 : frequency === "fortnightly" ? 14 : 30;
  next.setDate(next.getDate() + days);
  return dateValue(next);
}

function rosterDates(startDate, frequency, repeatWeeks) {
  const dates = [];
  const weeks = Math.max(1, Math.min(52, Number(repeatWeeks || 1)));
  const cursor = new Date(`${startDate}T12:00:00`);
  const end = new Date(cursor);
  end.setDate(end.getDate() + (weeks * 7));
  while (cursor < end) {
    dates.push(dateValue(cursor));
    if (frequency === "monthly") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + (frequency === "fortnightly" ? 14 : 7));
  }
  return dates;
}

function recurringPatch(id, patch) {
  const jobs = recurringJobs();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return false;
  jobs[index] = { ...jobs[index], ...patch, updatedAt: new Date().toISOString() };
  saveJson(RECURRING_KEY, jobs);
  renderAll();
  return true;
}

function quotePatch(id, patch) {
  const savedQuotes = quotes();
  const index = savedQuotes.findIndex((quote) => quoteId(quote) === id);
  if (index < 0) return false;
  savedQuotes[index] = { ...savedQuotes[index], ...patch, statusUpdatedAt: new Date().toISOString() };
  saveJson(QUOTES_KEY, savedQuotes);
  renderAll();
  return true;
}

function deleteRecurringJob(id) {
  const nextJobs = recurringJobs().filter((job) => job.id !== id);
  saveJson(RECURRING_KEY, nextJobs);
  deleteRecurringJobs({ id }).catch(() => {});
  renderAll();
}

function deleteQuoteJob(id) {
  const nextQuotes = quotes().filter((quote) => quoteId(quote) !== id);
  saveJson(QUOTES_KEY, nextQuotes);
  deleteQuoteJobs({ id }).catch(() => {});
  renderAll();
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
  if (canManage() && localQuotes.length) {
    const merged = mergeById(quoteCache, localQuotes);
    if (merged.length > quoteCache.length) {
      const saved = await saveQuoteJobs({ quotes: merged });
      quoteCache = saved.ok ? saved.quotes : merged;
    }
  }
  if (canManage() && localRecurring.length) {
    const merged = mergeById(recurringCache, localRecurring);
    if (merged.length > recurringCache.length) {
      const saved = await saveRecurringJobs({ jobs: merged });
      recurringCache = saved.ok ? saved.jobs : merged;
    }
  }
  localStorage.setItem(QUOTES_KEY, JSON.stringify(quoteCache));
  localStorage.setItem(RECURRING_KEY, JSON.stringify(recurringCache));
}

async function refreshRoster() {
  const result = await listRosterJobs();
  rosterJobs = result.ok ? result.jobs : [];
}

function renderStats() {
  const savedQuotes = quotes();
  const savedRecurring = recurringJobs();
  const awaitingApproval = [...savedRecurring, ...savedQuotes].filter((job) => canManage() || isAssignedToCurrentUser(job)).filter((job) => job.status === "completed_pending_approval").length;
  const assignedToMe = rosterJobs.filter((job) => job.assignedTo === currentUser?.id || job.assignedUsername === currentUser?.username).length;
  statsPanel.replaceChildren();
  for (const [label, value] of [
    ["Roster jobs", rosterJobs.length],
    ["Recurring jobs", savedRecurring.filter((job) => job.status !== "archived").length],
    ["Quote jobs", savedQuotes.length],
    ["Assigned to me", assignedToMe],
    ["Awaiting approval", awaitingApproval]
  ]) {
    const card = document.createElement("article");
    card.className = "dashboard-stat";
    card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    statsPanel.append(card);
  }
}

function renderTeamOptions() {
  assignedSelect.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Unassigned";
  assignedSelect.append(blank);
  for (const user of teamUsers.filter((item) => item.role === "member")) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = `${user.username} · ${user.email}`;
    assignedSelect.append(option);
  }
}

function renderQuoteOptions() {
  quoteSelect.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "No linked quote";
  quoteSelect.append(blank);
  for (const quote of unrosteredQuotes()) {
    const option = document.createElement("option");
    option.value = quoteId(quote);
    option.textContent = `${quote.customerName || quote.address || "Unnamed quote"} · ${money(quote.price)}`;
    quoteSelect.append(option);
  }
}

function resetRecurringForm() {
  recurringForm.reset();
  document.querySelector("#recurring-id").value = "";
  document.querySelector("#recurring-next-run").value = dateValue(new Date());
  document.querySelector("#recurring-start-time").value = "08:00";
  document.querySelector("#recurring-finish-time").value = "09:00";
}

function fillRecurringForm(job) {
  document.querySelector("#recurring-id").value = job.id;
  document.querySelector("#recurring-quote").value = job.quoteId || "";
  document.querySelector("#recurring-customer").value = job.customerName || "";
  document.querySelector("#recurring-address").value = job.address || "";
  document.querySelector("#recurring-assigned").value = job.assignedTo || "";
  document.querySelector("#recurring-frequency").value = job.frequency || "weekly";
  document.querySelector("#recurring-next-run").value = job.nextRun || dateValue(new Date());
  document.querySelector("#recurring-start-time").value = job.startTime || "08:00";
  document.querySelector("#recurring-finish-time").value = job.finishTime || "09:00";
  document.querySelector("#recurring-price").value = Number(job.price || 0);
  document.querySelector("#recurring-notes").value = job.notes || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateRosterFields(fields) {
  if (!fields.assignedTo) return "Choose the assigned team member.";
  if (!fields.scheduledDate) return "Choose the roster date.";
  if (!fields.startTime || !fields.finishTime) return "Start time and finish time are required.";
  if (fields.finishTime <= fields.startTime) return "Finish time must be after start time.";
  return "";
}

function rosterJobFromSource(source, sourceType, fields) {
  const sourceId = sourceType === "recurring" ? source.id : quoteId(source);
  return {
    id: fields.id || `${sourceType}:${sourceId}:${fields.scheduledDate}`,
    sourceType,
    sourceId,
    title: source.customerName || source.address || (sourceType === "recurring" ? "Recurring job" : "Quote job"),
    customerName: source.customerName || "",
    customerPhone: source.customerPhone || source.phone || source.mobile || "",
    customerEmail: source.customerEmail || source.email || "",
    address: source.address || "",
    assignedTo: fields.assignedTo,
    scheduledDate: fields.scheduledDate,
    startTime: fields.startTime,
    finishTime: fields.finishTime,
    frequency: source.frequency || "",
    price: Number(source.price || 0),
    notes: source.notes || "",
    status: "assigned"
  };
}

async function assignSourceJob(source, sourceType, fields) {
  const error = validateRosterFields(fields);
  if (error) {
    setMessage(error, "warning");
    return;
  }
  const patch = sourceType === "recurring"
    ? { assignedTo: fields.assignedTo, nextRun: fields.scheduledDate, startTime: fields.startTime, finishTime: fields.finishTime, status: source.status || "active" }
    : { assignedTo: fields.assignedTo, scheduledDate: fields.scheduledDate, startTime: fields.startTime, finishTime: fields.finishTime };
  if (sourceType === "recurring") recurringPatch(source.id, patch);
  else quotePatch(quoteId(source), patch);
  const repeatWeeks = sourceType === "recurring" ? fields.repeatWeeks : 1;
  const dates = sourceType === "recurring" ? rosterDates(fields.scheduledDate, source.frequency || "weekly", repeatWeeks) : [fields.scheduledDate];
  const jobs = dates.map((scheduledDate) => rosterJobFromSource({ ...source, ...patch }, sourceType, {
    ...fields,
    scheduledDate,
    id: `${sourceType}:${sourceType === "recurring" ? source.id : quoteId(source)}:${scheduledDate}`
  }));
  const result = await saveRosterJob(jobs.length > 1 ? { jobs } : jobs[0]);
  if (!result.ok) {
    setMessage(result.message || "Job assignment could not be saved.", "warning");
    return;
  }
  await refreshRoster();
  renderAll();
  window.alert("Job assigned successfully.");
  setMessage(`${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} assigned successfully. Email notification ${result.notification?.status || "queued"}.`, "success");
}

async function deleteRosterEntry(payload, afterDelete = null) {
  if (!confirm("Delete this job from the schedule?")) return;
  const result = await deleteRosterJob(payload);
  if (!result.ok) {
    setMessage(result.message || "Job could not be deleted.", "warning");
    return;
  }
  if (typeof afterDelete === "function") afterDelete();
  await refreshRoster();
  renderAll();
  setMessage(`Deleted ${result.deleted || 0} scheduled ${Number(result.deleted || 0) === 1 ? "job" : "jobs"}.`, "success");
}

function confirmRosterCompletion(job) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-dialog-backdrop";
    backdrop.setAttribute("role", "presentation");

    const dialog = document.createElement("section");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "complete-job-title");

    const title = document.createElement("h2");
    title.id = "complete-job-title";
    title.textContent = "Confirm completed job";

    const message = document.createElement("p");
    message.textContent = "Do you want to confirm that this specific rostered job has been completed?";

    const details = document.createElement("small");
    details.textContent = `${job.title || job.address || "Roster job"} · ${dateLabel(job.scheduledDate)} · ${job.startTime || ""}-${job.finishTime || ""}`;

    const actions = document.createElement("div");
    actions.className = "confirm-dialog-actions";

    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary-button";
    reject.textContent = "Reject";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary-button";
    confirm.textContent = "Confirm";

    function close(value) {
      backdrop.remove();
      document.removeEventListener("keydown", onKeyDown);
      resolve(value);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") close(false);
    }

    reject.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKeyDown);

    actions.append(reject, confirm);
    dialog.append(title, message, details, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);
    confirm.focus();
  });
}

async function markRosterComplete(job, button) {
  if (isRosterComplete(job)) return;
  if (!canCompleteRosterNow(job)) {
    setMessage(`This job cannot be completed before ${dateLabel(job.scheduledDate)} at ${job.startTime}.`, "warning");
    return;
  }
  const confirmed = await confirmRosterCompletion(job);
  if (!confirmed) return;
  button.disabled = true;
  button.setAttribute("aria-pressed", "true");
  const result = await completeRosterJob(job.id, { checkOutLocation: await currentPosition() });
  if (!result.ok) {
    button.disabled = false;
    button.removeAttribute("aria-pressed");
    setMessage(result.message || "Roster job could not be marked complete.", "warning");
    return;
  }
  await refreshRoster();
  renderAll();
  setMessage("Completion submitted and checkout time logged. This job is now waiting for approval.", "success");
}

async function approveRosterComplete(job, button) {
  if (!canManage() || job.status !== "completed_pending_approval") return;
  button.disabled = true;
  const result = await approveRosterJob(job.id);
  if (!result.ok) {
    button.disabled = false;
    setMessage(result.message || "Completed roster job could not be approved.", "warning");
    return;
  }
  await Promise.all([refreshSharedJobs(), refreshRoster()]);
  renderAll();
  setMessage("Completed roster job approved.", "success");
}

async function saveWorklog(job, form) {
  const formData = new FormData(form);
  const materialName = String(formData.get("materialName") || "").trim();
  const materials = materialName ? [{
    name: materialName,
    quantity: Number(formData.get("materialQuantity") || 0),
    unit: String(formData.get("materialUnit") || "").trim(),
    cost: Number(formData.get("materialCost") || 0)
  }] : Array.isArray(job.materials) ? job.materials : [];
  const result = await saveRosterWorklog({
    id: job.id,
    actualStartTime: formData.get("actualStartTime"),
    actualFinishTime: formData.get("actualFinishTime"),
    actualMinutes: Number(formData.get("actualMinutes") || 0),
    materials,
    workNotes: formData.get("workNotes")
  });
  if (!result.ok) {
    setMessage(result.message || "Worklog could not be saved.", "warning");
    return;
  }
  await refreshRoster();
  renderAll();
  setMessage("Time and materials saved for this roster job.", "success");
}

function currentPosition({ requireConsent = true } = {}) {
  if (!crewGpsEnabled) return Promise.resolve(null);
  if (requireConsent && !gpsConsent()) return Promise.resolve(null);
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        capturedAt: new Date(position.timestamp || Date.now()).toISOString()
      }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  });
}

async function saveCheck(job, patch, button) {
  button.disabled = true;
  const result = await saveRosterWorklog({
    id: job.id,
    actualStartTime: patch.actualStartTime ?? job.actualStartTime,
    actualFinishTime: patch.actualFinishTime ?? job.actualFinishTime,
    actualMinutes: patch.actualMinutes ?? job.actualMinutes,
    materials: Array.isArray(job.materials) ? job.materials : [],
    workNotes: patch.workNotes ?? job.workNotes,
    checkInLocation: patch.checkInLocation,
    checkOutLocation: patch.checkOutLocation
  });
  if (!result.ok) {
    button.disabled = false;
    setMessage(result.message || "Check in could not be saved.", "warning");
    return;
  }
  await refreshRoster();
  renderAll();
  setMessage(crewGpsEnabled && gpsConsent() ? "Job time and location saved." : "Job time saved.", "success");
}

function worklogForm(job) {
  const form = document.createElement("form");
  form.className = "worklog-form";
  form.innerHTML = `
    <input name="actualStartTime" type="time" value="${job.actualStartTime || job.startTime || ""}" aria-label="Actual start time" />
    <input name="actualFinishTime" type="time" value="${job.actualFinishTime || job.finishTime || ""}" aria-label="Actual finish time" />
    <input name="actualMinutes" type="number" min="0" step="1" value="${Number(job.actualMinutes || 0)}" placeholder="Minutes" aria-label="Actual minutes" />
    <input name="materialName" placeholder="Material used" aria-label="Material used" />
    <input name="materialQuantity" type="number" min="0" step="0.1" placeholder="Qty" aria-label="Material quantity" />
    <input name="materialUnit" placeholder="Unit" aria-label="Material unit" />
    <input name="materialCost" type="number" min="0" step="0.01" placeholder="Cost" aria-label="Material cost" />
    <input name="workNotes" value="${escapeAttribute(job.workNotes)}" placeholder="Work notes" aria-label="Work notes" />
    <button class="secondary-button compact-button" type="submit">Save worklog</button>
  `;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await saveWorklog(job, form);
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

function assignmentControls(source, sourceType) {
  const wrapper = document.createElement("div");
  wrapper.className = "roster-assignment";

  const member = document.createElement("select");
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose member";
  member.append(blank);
  for (const user of teamUsers.filter((item) => item.role === "member")) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = user.username;
    option.selected = source.assignedTo === user.id;
    member.append(option);
  }

  const date = document.createElement("input");
  date.type = "date";
  date.value = sourceType === "recurring" ? source.nextRun || dateValue(new Date()) : source.scheduledDate || dateValue(new Date());

  const start = document.createElement("input");
  start.type = "time";
  start.value = source.startTime || "08:00";

  const finish = document.createElement("input");
  finish.type = "time";
  finish.value = source.finishTime || "09:00";

  const repeatWeeks = document.createElement("input");
  repeatWeeks.type = "number";
  repeatWeeks.min = "1";
  repeatWeeks.max = "52";
  repeatWeeks.step = "1";
  repeatWeeks.value = sourceType === "recurring" ? "1" : "1";
  repeatWeeks.placeholder = "Weeks";
  repeatWeeks.title = "Repeat weeks";
  repeatWeeks.setAttribute("aria-label", "Repeat weeks");
  repeatWeeks.hidden = sourceType !== "recurring";

  const button = document.createElement("button");
  button.className = "primary-button";
  button.type = "button";
  button.textContent = "Assign";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await assignSourceJob(source, sourceType, {
        assignedTo: member.value,
        scheduledDate: date.value,
        startTime: start.value,
        finishTime: finish.value,
        repeatWeeks: repeatWeeks.value
      });
    } finally {
      button.disabled = false;
    }
  });

  wrapper.append(member, date, start, finish, repeatWeeks, button);
  return wrapper;
}

function completionControls(item, type) {
  const actions = document.createElement("div");
  actions.className = "inline-actions";
  const canSubmit = currentUser?.role === "member" && isAssignedToCurrentUser(item) && item.status !== "completed_pending_approval" && item.status !== "approved" && canCompleteItemNow(item);
  const canApprove = canManage() && item.status === "completed_pending_approval";
  const complete = document.createElement("button");
  complete.className = "secondary-button";
  complete.type = "button";
  complete.textContent = "Submit complete";
  complete.disabled = !canSubmit;
  complete.addEventListener("click", () => {
    if (!canCompleteItemNow(item)) {
      const day = item.scheduledDate || item.nextRun;
      setMessage(`This job cannot be completed before ${dateLabel(day)} at ${item.startTime}.`, "warning");
      return;
    }
    const patch = {
      status: "completed_pending_approval",
      completedAt: new Date().toISOString(),
      completedBy: currentUser.username,
      completedById: currentUser.id
    };
    if (type === "recurring") recurringPatch(item.id, patch);
    else quotePatch(quoteId(item), patch);
    setMessage("Completion submitted. Owner Admin or Team Leader approval is required.", "success");
  });
  const approve = document.createElement("button");
  approve.className = "primary-button";
  approve.type = "button";
  approve.textContent = "Approve";
  approve.disabled = !canApprove;
  approve.addEventListener("click", () => {
    if (type === "recurring") {
      recurringPatch(item.id, {
        status: "active",
        approvedAt: new Date().toISOString(),
        approvedBy: currentUser.username,
        lastCompletedAt: item.completedAt || new Date().toISOString(),
        nextRun: nextRunAfter(item.nextRun, item.frequency)
      });
    } else {
      quotePatch(quoteId(item), {
        status: "approved",
        approvedAt: new Date().toISOString(),
        approvedBy: currentUser.username
      });
    }
    setMessage("Completed job approved.", "success");
  });
  actions.append(complete, approve);
  return actions;
}

function renderWeekCalendar() {
  const days = Array.from({ length: 7 }, (_, index) => dateValue(addDays(weekStart, index)));
  weekRange.textContent = `${weekLabel(days[0])} - ${weekLabel(days[6])}`;
  weekCalendar.replaceChildren(...days.map((day) => {
    const column = document.createElement("article");
    column.className = "week-day";
    const jobs = rosterJobs
      .filter((job) => job.scheduledDate === day)
      .sort((a, b) => `${a.startTime || ""}`.localeCompare(`${b.startTime || ""}`));
    const header = document.createElement("header");
    header.textContent = dayLabel(day);
    column.append(header);
    if (!jobs.length) {
      column.insertAdjacentHTML("beforeend", `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>
          <p>No assigned jobs</p>
        </div>`);
      return column;
    }
    for (const job of jobs) {
      const card = document.createElement("div");
      card.className = "calendar-job";
      card.dataset.status = job.status || "assigned";
      card.innerHTML = `
        <strong>${job.title || job.address || "Roster job"}</strong>
        <span>${job.startTime} - ${job.finishTime}</span>
        <small>${canManage() ? `${job.assignedUsername || teamLabel(job.assignedTo)} · ` : ""}${job.address || "No address"}</small>
        <small>${customerContactLabel(job)}</small>
        <small>${job.sourceType === "recurring" ? `Recurring ${job.frequency || ""}` : "One-off"}</small>
        ${statusBadge(job.status)}
      `;
      if (canManage()) {
        const del = document.createElement("button");
        del.className = "danger-button compact-button";
        del.type = "button";
        del.textContent = "Delete";
        del.addEventListener("click", () => deleteRosterEntry({ id: job.id }));
        if (job.status === "completed_pending_approval") {
          const approve = document.createElement("button");
          approve.className = "primary-button roster-complete-button";
          approve.type = "button";
          approve.textContent = "Approve completed";
          approve.addEventListener("click", () => approveRosterComplete(job, approve));
          card.append(approve);
        }
        if (isRosterApproved(job)) {
          const approved = document.createElement("button");
          approved.className = "secondary-button roster-complete-button is-complete";
          approved.type = "button";
          approved.textContent = "Approved";
          approved.disabled = true;
          approved.setAttribute("aria-pressed", "true");
          card.append(approved);
        }
        card.append(del);
      } else if (currentUser?.role === "member" && isRosterAssignedToCurrentUser(job)) {
        const complete = document.createElement("button");
        complete.className = `secondary-button roster-complete-button${isRosterComplete(job) ? " is-complete" : ""}`;
        complete.type = "button";
        complete.textContent = "Open job";
        complete.disabled = isRosterComplete(job) || !canCompleteRosterNow(job);
        if (!isRosterComplete(job) && !canCompleteRosterNow(job)) {
          complete.title = `Available from ${dateLabel(job.scheduledDate)} at ${job.startTime}`;
          complete.setAttribute("aria-label", `Completed button available from ${dateLabel(job.scheduledDate)} at ${job.startTime}`);
        }
        complete.setAttribute("aria-pressed", isRosterComplete(job) ? "true" : "false");
        complete.disabled = false;
        complete.addEventListener("click", () => openRosterJobDialog(job));
        card.addEventListener("click", (event) => {
          if (event.target.closest("button")) return;
          openRosterJobDialog(job);
        });
        card.append(complete);
      }
      column.append(card);
    }
    return column;
  }));
}

function openRosterJobDialog(job) {
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-dialog-backdrop";
  backdrop.setAttribute("role", "presentation");
  const dialog = document.createElement("section");
  dialog.className = "confirm-dialog roster-job-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <h2>${job.title || job.customerName || job.address || "Roster job"}</h2>
    <p>${dateLabel(job.scheduledDate)} · ${job.startTime || "No start"}-${job.finishTime || "No finish"}</p>
    <small>${job.address || "No address"}</small>
    <small>${customerContactLabel(job)}</small>
    <small>${job.actualStartTime ? `Checked in ${job.actualStartTime}` : "Not checked in"}${job.actualFinishTime ? ` · Checked out ${job.actualFinishTime}` : ""}</small>
  `;
  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const route = document.createElement("button");
  route.className = "secondary-button";
  route.type = "button";
  route.textContent = "Route";
  route.addEventListener("click", () => {
    window.location.href = mapUrl(job.address);
  });
  actions.append(route);
  const sms = smsUrl(job);
  if (sms) {
    const smsButton = document.createElement("button");
    smsButton.className = "secondary-button";
    smsButton.type = "button";
    smsButton.textContent = "On my way SMS";
    smsButton.addEventListener("click", () => openOnMyWaySms(job, smsButton));
    actions.append(smsButton);
  }
  if (crewGpsEnabled) {
    const gpsRow = document.createElement("label");
    gpsRow.className = "field-checkbox";
    gpsRow.innerHTML = `<input type="checkbox" ${gpsConsent() ? "checked" : ""} /> Share GPS with check-in and completion`;
    gpsRow.querySelector("input").addEventListener("change", (event) => {
      setGpsConsent(event.currentTarget.checked);
    });
    dialog.append(gpsRow);
    const share = document.createElement("button");
    share.className = "secondary-button";
    share.type = "button";
    share.textContent = "Share location";
    share.addEventListener("click", async () => {
      share.disabled = true;
      const location = await currentPosition({ requireConsent: false });
      if (!location) {
        share.disabled = false;
        setMessage("Location could not be captured. Check browser GPS permission.", "warning");
        return;
      }
      const result = await sendCrewLocationPing({ rosterJobId: job.id, kind: "live", ...location });
      share.disabled = false;
      setMessage(result.ok ? "Crew location saved for Owner/Team Leader reports." : result.message || "Location could not be saved.", result.ok ? "success" : "warning");
    });
    actions.append(share);
  }
  const checkIn = document.createElement("button");
  checkIn.className = "secondary-button";
  checkIn.type = "button";
  checkIn.textContent = "Check in";
  checkIn.addEventListener("click", async () => {
    const now = new Date();
    await saveCheck(job, { actualStartTime: now.toTimeString().slice(0, 5), checkInLocation: await currentPosition() }, checkIn);
    backdrop.remove();
  });
  const complete = document.createElement("button");
  complete.className = "primary-button";
  complete.type = "button";
  complete.textContent = isRosterComplete(job) ? "Completed" : "Complete job";
  complete.disabled = isRosterComplete(job) || !canCompleteRosterNow(job);
  complete.addEventListener("click", async () => {
    await markRosterComplete(job, complete);
    backdrop.remove();
  });
  const close = document.createElement("button");
  close.className = "secondary-button";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => backdrop.remove());
  actions.append(checkIn, complete, close);
  dialog.append(actions);
  backdrop.append(dialog);
  document.body.append(backdrop);
  close.focus();
}

function renderRouteDayList() {
  const today = dateValue(new Date());
  const days = Array.from({ length: 7 }, (_, index) => dateValue(addDays(weekStart, index)));
  const preferredDay = days.includes(today) ? today : days[0];
  const jobs = rosterJobs
    .filter((job) => job.scheduledDate === preferredDay)
    .sort((a, b) => `${a.startTime || ""}`.localeCompare(`${b.startTime || ""}`));
  if (!jobs.length) {
    routeDayList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
        <p>No jobs scheduled for ${dateLabel(preferredDay)}.</p>
      </div>`;
    return;
  }
  routeDayList.classList.add("timeline-route");
  routeDayList.replaceChildren(...jobs.map((job, index) => {
    const item = document.createElement("article");
    item.className = "route-job";
    item.dataset.status = job.status || "assigned";
    const sms = smsUrl(job);
    item.innerHTML = `
      <div class="route-index">${index + 1}</div>
      <div class="route-job-main">
        <strong>${job.title || job.address || "Roster job"}</strong>
        <span>${job.startTime || "No start"}-${job.finishTime || "No finish"} · ${job.address || "No address"}</span>
        <div class="job-meta-row">
          ${statusBadge(job.status)}
          <span class="app-chip">${job.actualMinutes ? minutesLabel(job.actualMinutes) : "No time logged"}</span>
          <span class="app-chip">${materialSummary(job)}</span>
        </div>
        <small>${customerContactLabel(job)}</small>
      </div>
      <div class="route-job-actions">
        <a class="secondary-button compact-button" href="${mapUrl(job.address)}" target="_blank" rel="noreferrer">Map</a>
        ${sms ? `<button class="secondary-button compact-button" type="button" data-sms-action="${escapeAttribute(job.id)}">On my way SMS</button>` : ""}
      </div>
    `;
    const smsButton = item.querySelector("[data-sms-action]");
    if (smsButton) {
      smsButton.addEventListener("click", () => openOnMyWaySms(job, smsButton));
    }
    if (canManage() || (currentUser?.role === "member" && isRosterAssignedToCurrentUser(job))) {
      item.append(worklogForm(job));
    }
    return item;
  }));
}

function renderRecurringList() {
  const jobs = recurringJobs().filter((job) => canManage() || isAssignedToCurrentUser(job));
  if (!jobs.length) {
    recurringList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4v2"></path><line x1="8" y1="21" x2="8" y2="11"></line><line x1="3" y1="21" x2="16" y2="21"></line></svg>
        <p>No recurring jobs available for this login.</p>
      </div>`;
    return;
  }
  recurringList.replaceChildren(...jobs.map((job) => {
    const item = document.createElement("article");
    item.className = "admin-list-item schedule-item";
    item.dataset.status = job.status || "active";
    item.innerHTML = `
      <div>
        <strong>${job.customerName || job.address || "Unnamed recurring job"}</strong>
        <span>${job.address || "No address"} · ${dateLabel(job.nextRun)} · ${job.startTime || "No start"}-${job.finishTime || "No finish"} · ${job.frequency || "weekly"} · ${teamLabel(job.assignedTo)}</span>
        <span>${customerContactLabel(job)}</span>
        ${statusBadge(job.status)}
      </div>
    `;
    const controls = completionControls(job, "recurring");
    if (canManage()) {
      controls.prepend(assignmentControls(job, "recurring"));
      const edit = document.createElement("button");
      edit.className = "secondary-button";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => fillRecurringForm(job));
      const archive = document.createElement("button");
      archive.className = "danger-button";
      archive.type = "button";
      archive.textContent = job.status === "archived" ? "Restore" : "Archive";
      archive.addEventListener("click", () => recurringPatch(job.id, { status: job.status === "archived" ? "active" : "archived" }));
      const del = document.createElement("button");
      del.className = "danger-button";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteRosterEntry({ sourceType: "recurring", sourceId: job.id }, () => deleteRecurringJob(job.id)));
      controls.append(edit, archive, del);
    }
    item.append(controls);
    return item;
  }));
}

function renderQuoteScheduleList() {
  const savedQuotes = unrosteredQuotes().filter((quote) => canManage() || isAssignedToCurrentUser(quote));
  if (!savedQuotes.length) {
    quoteScheduleList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
        <p>No quote jobs available for this login.</p>
      </div>`;
    return;
  }
  quoteScheduleList.replaceChildren(...savedQuotes.map((quote) => {
    const item = document.createElement("article");
    item.className = "admin-list-item schedule-item";
    item.dataset.status = quote.status || "pending";
    item.innerHTML = `
      <div>
        <strong>${quote.customerName || quote.address || "Unnamed quote"}</strong>
        <span>${quote.address || "No address"} · ${money(quote.price)} · ${dateLabel(quote.scheduledDate)} · ${quote.startTime || "No start"}-${quote.finishTime || "No finish"} · ${teamLabel(quote.assignedTo)}</span>
        <span>${customerContactLabel(quote)}</span>
        ${statusBadge(quote.status || "pending")}
      </div>
    `;
    const controls = completionControls(quote, "quote");
    if (canManage()) {
      controls.prepend(assignmentControls(quote, "quote"));
      const del = document.createElement("button");
      del.className = "danger-button";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteRosterEntry({ sourceType: "quote", sourceId: quoteId(quote) }, () => deleteQuoteJob(quoteId(quote))));
      controls.append(del);
    }
    item.append(controls);
    return item;
  }));
}

function renderAll() {
  roleLabel.textContent = currentUser ? `Signed in as ${currentUser.username} (${currentUser.roleLabel})` : "Not signed in";
  recurringEditorCard.hidden = isAndroidApp || !canManage();
  routeDayList.closest(".admin-card").hidden = isAndroidApp || !canManage();
  recurringList.closest(".admin-card").hidden = isAndroidApp || !canManage();
  quoteScheduleList.closest(".admin-card").hidden = isAndroidApp || !canManage();
  renderStats();
  renderQuoteOptions();
  renderWeekCalendar();
  renderRouteDayList();
  renderRecurringList();
  renderQuoteScheduleList();
}

quoteSelect.addEventListener("change", () => {
  const quote = quotes().find((item) => quoteId(item) === quoteSelect.value);
  if (!quote) return;
  document.querySelector("#recurring-customer").value = quote.customerName || "";
  document.querySelector("#recurring-address").value = quote.address || "";
  document.querySelector("#recurring-price").value = Number(quote.price || 0);
});

recurringForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canManage()) return setMessage("Only Owner Admin or Team Leader can save recurring jobs.", "warning");
  const startTime = document.querySelector("#recurring-start-time").value;
  const finishTime = document.querySelector("#recurring-finish-time").value;
  if (!startTime || !finishTime || finishTime <= startTime) {
    setMessage("Recurring jobs need a valid start and finish time.", "warning");
    return;
  }
  const id = document.querySelector("#recurring-id").value || crypto.randomUUID();
  const jobs = recurringJobs();
  const existingIndex = jobs.findIndex((job) => job.id === id);
  const job = {
    id,
    quoteId: quoteSelect.value,
    customerName: document.querySelector("#recurring-customer").value.trim(),
    address: document.querySelector("#recurring-address").value.trim(),
    assignedTo: assignedSelect.value,
    frequency: document.querySelector("#recurring-frequency").value,
    nextRun: document.querySelector("#recurring-next-run").value,
    startTime,
    finishTime,
    price: Number(document.querySelector("#recurring-price").value || 0),
    notes: document.querySelector("#recurring-notes").value.trim(),
    status: existingIndex >= 0 ? jobs[existingIndex].status || "active" : "active",
    createdAt: existingIndex >= 0 ? jobs[existingIndex].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (existingIndex >= 0) jobs[existingIndex] = { ...jobs[existingIndex], ...job };
  else jobs.unshift(job);
  saveJson(RECURRING_KEY, jobs);
  resetRecurringForm();
  renderAll();
  setMessage("Recurring job saved. Use Assign to add it to the shared roster and email the team member.", "success");
});

previousWeekButton.addEventListener("click", () => {
  weekStart = addDays(weekStart, -7);
  renderWeekCalendar();
});

nextWeekButton.addEventListener("click", () => {
  weekStart = addDays(weekStart, 7);
  renderWeekCalendar();
});

todayWeekButton.addEventListener("click", () => {
  weekStart = startOfWeek(new Date());
  renderWeekCalendar();
});

document.querySelector("#reset-recurring").addEventListener("click", resetRecurringForm);
document.querySelector("#logout-admin").addEventListener("click", () => {
  logoutAdmin();
});

async function initSchedulePage() {
  try {
    if (!await requireAdminSession()) return;
    await initAccessibleNavigation();
    const status = await authStatus();
    if (!status.loggedIn || !status.user) {
      location.replace(`admin.html?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return;
    }
    currentUser = status.user;
    crewGpsEnabled = Boolean(status.security?.crewGpsEnabled);
    const team = await listTeamMembers();
    teamUsers = team.ok ? team.users : [];
    await refreshSharedJobs();
    await refreshRoster();
    renderTeamOptions();
    resetRecurringForm();
    renderAll();
    hideSkeletons();
  } catch (error) {
    showScheduleStartupError(error?.message);
    setTimeout(() => hideSkeletons(), 2500);
  }
}

// Collapsible recurring editor on mobile
const chevronButton = document.getElementById("recurring-editor-chevron");
if (chevronButton) {
  let collapsed = false;
  const bodyEl = document.getElementById("recurring-editor-body");
  chevronButton.addEventListener("click", () => {
    collapsed = !collapsed;
    if (bodyEl) bodyEl.hidden = collapsed;
    chevronButton.style.transform = collapsed ? "rotate(-90deg)" : "";
  });
}

initSchedulePage();

// Pull-to-refresh for Android WebView
(function setupPullToRefresh() {
  let startY = 0;
  let pulling = false;
  const threshold = 100;
  const indicator = document.createElement("div");
  indicator.className = "pull-indicator";
  indicator.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
    <span class="pull-text">Pull to refresh</span>
  `;
  document.querySelector("main").prepend(indicator);

  const onRefresh = async () => {
    indicator.classList.add("refreshing");
    indicator.querySelector(".pull-text").textContent = "Refreshing…";
    try {
      await refreshSharedJobs();
      await refreshRoster();
      renderAll();
      hideSkeletons();
      setMessage("Updated", "info");
      setTimeout(() => setMessage("", "info"), 2000);
    } catch (e) {
      setMessage("Refresh failed: " + e.message, "warning");
    } finally {
      indicator.classList.remove("refreshing");
      indicator.style.transform = "translateY(-60px)";
      pulling = false;
    }
  };

  document.addEventListener("touchstart", (e) => {
    if (window.scrollY <= 0 && e.touches[0].clientX > 24) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && window.scrollY <= 0) {
      const progress = Math.min(dy / threshold, 1);
      indicator.style.transform = `translateY(${progress * 40 - 60}px)`;
      if (progress >= 0.85) {
        indicator.querySelector(".pull-text").textContent = "Release to refresh";
      }
    }
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling) return;
    const transform = indicator.style.transform;
    const match = transform.match(/translateY\(([-\d.]+)px\)/);
    const currentY = match ? parseFloat(match[1]) : -60;
    if (currentY >= -25) {
      onRefresh();
    } else {
      indicator.style.transform = "translateY(-60px)";
      pulling = false;
    }
  }, { passive: true });
})();
