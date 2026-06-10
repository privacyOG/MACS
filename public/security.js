import {
  adminSecurityStatus,
  approveTeamMember,
  createEncryptedBackup,
  createTeamMember,
  deleteTeamMember,
  initAccessibleNavigation,
  listLoginActivity,
  listSecurityAudit,
  listTeamMembers,
  logoutAdmin,
  requireAdminSession,
  sendTestSecurityEmail,
  unlockTeamMember,
  updateFieldSettings,
  updateSessionTimeout,
  updateTeamMember
} from "./auth.js";
import {
  employeeProfileFromForm,
  openEmployeeProfileEditor,
  profileSummary,
  setupCredentialDraft
} from "./team-profile.js";

const securityMessage = document.querySelector("#security-message");
const securitySummary = document.querySelector("#security-summary");
const securityRole = document.querySelector("#security-role");
const teamForm = document.querySelector("#team-form");
const teamList = document.querySelector("#team-list");
const securityToolOutput = document.querySelector("#security-tool-output");
const loginActivityList = document.querySelector("#login-activity-list");
const securityAuditList = document.querySelector("#security-audit-list");
const sessionTimeoutForm = document.querySelector("#session-timeout-form");
const sessionTimeoutInput = document.querySelector("#session-timeout-minutes");
const fieldSettingsForm = document.querySelector("#field-settings-form");
const crewGpsEnabledInput = document.querySelector("#crew-gps-enabled");
const crewGpsRetentionInput = document.querySelector("#crew-gps-retention-days");
const teamCredentialLabel = document.querySelector("#team-credential-label");
const teamCredentialFile = document.querySelector("#team-credential-file");
const addTeamCredential = document.querySelector("#add-team-credential");
const teamCredentialList = document.querySelector("#team-credential-list");

let currentUser = null;
let currentRoles = {};
let teamUsers = [];
let newTeamCredentials = [];
let refreshTeamCredentialDraft = () => {};

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
    const captured = location.capturedAt ? ` · ${dateTimeLabel(location.capturedAt)}` : "";
    return `GPS ${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}${accuracy}${captured}`;
  }
  if (location.status === "denied") return "Browser GPS denied";
  if (location.status === "prompt") return "Browser GPS not granted yet";
  if (location.status === "unavailable") return "Browser GPS unavailable";
  if (location.status === "error") return `Browser GPS error${location.errorMessage ? `: ${location.errorMessage}` : ""}`;
  return "Browser GPS not recorded";
}

function setMessage(message, tone = "info") {
  securityMessage.textContent = message;
  securityMessage.dataset.tone = tone;
}

function notificationSent(notification) {
  return Boolean(notification?.status?.startsWith("sent"));
}

function notificationAccepted(notification) {
  return notificationSent(notification) || notification?.status === "queued-local" || notification?.status === "queued";
}

function notificationText(notification, successText, failText) {
  if (notificationSent(notification)) {
    return successText;
  }
  if (notificationAccepted(notification)) {
    return successText.replace("sent", "queued");
  }
  return `${failText}: ${notification?.error || "mail transport unavailable"}`;
}

async function renderSecurityStatus() {
  const status = await adminSecurityStatus();
  currentUser = status.user;
  currentRoles = status.roles || {};
  if (!currentUser) {
    location.replace(`admin.html?next=${encodeURIComponent("security.html")}`);
    return false;
  }
  if (currentUser.role !== "owner") {
    location.replace("admin.html");
    return false;
  }
  securityRole.textContent = `${currentUser.username} · ${currentUser.roleLabel}`;
  sessionTimeoutInput.value = status.security?.sessionTimeoutMinutes || 30;
  sessionTimeoutInput.max = status.security?.maxSessionTimeoutMinutes || 240;
  crewGpsEnabledInput.checked = Boolean(status.security?.crewGpsEnabled);
  crewGpsRetentionInput.value = status.security?.crewGpsRetentionDays || 14;
  crewGpsRetentionInput.max = status.security?.maxCrewGpsRetentionDays || 90;
  securitySummary.replaceChildren();
  for (const [label, value] of [
    ["Signed in as", `${currentUser.username} (${currentUser.roleLabel})`],
    ["2FA", status.twoFactorEnabled ? "Enabled" : "Off"],
    ["Inactivity logout", `${status.security?.sessionTimeoutMinutes || 30} minutes`],
    ["Crew GPS", status.security?.crewGpsEnabled ? `Enabled · ${status.security?.crewGpsRetentionDays || 14} day retention` : "Disabled"],
    ["Last security update", status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "Not set"]
  ]) {
    const row = document.createElement("div");
    row.className = "dashboard-stat";
    row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    securitySummary.append(row);
  }
  return true;
}

async function renderTeam() {
  const result = await listTeamMembers();
  if (!result.ok) {
    teamList.innerHTML = `<p class="empty-state">${result.message || "Team list unavailable."}</p>`;
    return;
  }
  teamUsers = result.users;
  if (!teamUsers.length) {
    teamList.innerHTML = `<p class="empty-state">No team logins created yet.</p>`;
    return;
  }
  teamList.replaceChildren(...teamUsers.map((user) => {
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
        await renderTeam();
        await renderSecurityAudit();
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
      await renderSecurityAudit();
    });
    actions.append(role);
    if (user.approvalStatus !== "approved") {
      const approve = document.createElement("button");
      approve.className = "primary-button";
      approve.type = "button";
      approve.textContent = "Approve";
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        const approved = await approveTeamMember(user.id);
        if (!approved.ok) {
          approve.disabled = false;
          return setMessage(approved.message || "Approval failed.", "warning");
        }
        const notification = notificationText(approved.notification, "Approval email sent to team user.", "Approval email not sent");
        window.alert("Team login approved successfully.");
        setMessage(`Team login approved successfully. ${notification}`, notificationAccepted(approved.notification) ? "success" : "warning");
        await renderTeam();
        await renderLoginActivity();
        await renderSecurityAudit();
      });
      actions.append(approve);
    }
    const unlock = document.createElement("button");
    unlock.className = "secondary-button";
    unlock.type = "button";
    unlock.textContent = "Unlock";
    unlock.disabled = !locked;
    unlock.addEventListener("click", async () => {
      const unlocked = await unlockTeamMember(user.id);
      setMessage(unlocked.ok ? "Team login unlocked." : unlocked.message, unlocked.ok ? "success" : "warning");
      await renderTeam();
      await renderSecurityAudit();
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
      await renderSecurityAudit();
    });
    actions.append(unlock, remove);
    item.append(actions);
    return item;
  }));
}

async function renderLoginActivity() {
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
    const riskSignals = Array.isArray(login.riskSignals) && login.riskSignals.length ? login.riskSignals.join(", ") : "No suspicious signals";
    item.innerHTML = `
      <div>
        <strong>${login.username || "Unknown"} · ${login.roleLabel || login.role || "Role unknown"}${login.active ? " · Active" : ""} · Risk: ${login.riskLevel || "normal"}</strong>
        <span>${login.email || "No email"} · IP ${login.ip || "unknown"}${login.forwardedFor?.length ? ` · forwarded chain ${login.forwardedFor.join(" > ")}` : ""}</span>
      </div>
      <div class="activity-meta">
        <span><b>Login</b>${dateTimeLabel(login.loginAt)}</span>
        <span><b>Duration</b>${durationLabel(login.durationSeconds)}</span>
        <span><b>Device</b>${device.type || "Unknown"} · ${device.browser || "Browser unknown"} · ${device.os || "OS unknown"}</span>
        <span><b>Location</b>${location.timezone || "Timezone unknown"} · ${locationLabel(location)}</span>
        <span><b>Source</b>${location.source || "request"} · ${location.permissionState || location.status || "unknown"}</span>
        <span><b>Detection</b>${riskSignals}</span>
      </div>
    `;
    return item;
  }));
}

async function renderSecurityAudit() {
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

teamForm.addEventListener("submit", async (event) => {
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
  if (!result.ok) return setMessage(result.message, "warning");
  teamForm.reset();
  newTeamCredentials = [];
  refreshTeamCredentialDraft();
  const ownerNotification = result.notifications?.owner || result.notification;
  const teamNotification = result.notifications?.team;
  const ownerEmail = notificationText(ownerNotification, "Owner email notification sent.", "Owner email notification not sent");
  const teamEmail = notificationText(teamNotification, "Pending approval email sent to team user.", "Pending approval email not sent to team user");
  window.alert("Team login has been created and is pending Owner Admin approval.");
  setMessage(`Team login created and pending Owner Admin approval. Recovery code: ${result.recoveryCode}. ${ownerEmail} ${teamEmail}`, notificationAccepted(ownerNotification) && notificationAccepted(teamNotification) ? "success" : "warning");
  await renderTeam();
  await renderSecurityAudit();
});

sessionTimeoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await updateSessionTimeout(sessionTimeoutInput.value);
  setMessage(result.ok ? `Inactivity logout updated to ${result.minutes} minutes.` : result.message, result.ok ? "success" : "warning");
  if (result.ok) await renderSecurityStatus();
  await renderSecurityAudit();
});

fieldSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await updateFieldSettings({
    crewGpsEnabled: crewGpsEnabledInput.checked,
    crewGpsRetentionDays: crewGpsRetentionInput.value
  });
  setMessage(result.ok ? "Field app settings updated." : result.message, result.ok ? "success" : "warning");
  if (result.ok) await renderSecurityStatus();
  await renderSecurityAudit();
});

document.querySelector("#test-security-email").addEventListener("click", async () => {
  securityToolOutput.innerHTML = `<p class="empty-state">Sending test email...</p>`;
  const result = await sendTestSecurityEmail();
  securityToolOutput.innerHTML = `<p class="empty-state">${result.message || (result.ok ? "Test email sent." : "Test email failed.")}</p>`;
  setMessage(result.ok ? "Security test email accepted for delivery." : result.message, result.ok ? "success" : "warning");
  await renderSecurityAudit();
});

document.querySelector("#create-backup").addEventListener("click", async () => {
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

document.querySelector("#logout-admin").addEventListener("click", () => {
  logoutAdmin();
});

refreshTeamCredentialDraft = setupCredentialDraft({
  labelInput: teamCredentialLabel,
  fileInput: teamCredentialFile,
  addButton: addTeamCredential,
  list: teamCredentialList,
  getCredentials: () => newTeamCredentials,
  setCredentials: (next) => { newTeamCredentials = next; },
  setMessage
});

if (await requireAdminSession()) {
  await initAccessibleNavigation();
  if (await renderSecurityStatus()) {
    await renderTeam();
    await renderLoginActivity();
    await renderSecurityAudit();
  }
}
