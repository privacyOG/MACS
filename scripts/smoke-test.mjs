import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const requiredFiles = [
  "public/index.html",
  "public/admin.html",
  "public/security.html",
  "public/schedule.html",
  "public/downloads.html",
  "public/quote.html",
  "public/styles.css",
  "public/auth.js",
  "public/admin.js",
  "public/security.js",
  "public/schedule.js",
  "public/downloads.js",
  "public/app.js",
  "scripts/mail-outbox-worker.mjs",
  "public/manifest.webmanifest",
  "server.mjs",
  "public/assets/macs-logo.jpg",
  "public/assets/lawn-mower.jpg"
];

for (const file of requiredFiles) {
  const content = await readFile(path.join(root, file));
  if (!content.length) throw new Error(`${file} is empty`);
}

const html = await readFile(path.join(root, "public/index.html"), "utf8");
for (const token of ["MACS Mowing & Cleaning Services", "quote.html", "admin.html", "schedule.html", "downloads.html", "assets/macs-logo.jpg", "assets/lawn-mower.jpg", "home-menu-card"]) {
  if (!html.includes(token)) throw new Error(`Missing expected home token: ${token}`);
}
if (html.includes("upgrades")) throw new Error("Upgrade page links should not be present on home");

const adminHtml = await readFile(path.join(root, "public/admin.html"), "utf8");
for (const token of ["setup-form", "login-form", "login-identifier", "schedule.html", "security.html", "material-form", "dashboard-stats", "prepare-2fa", "job-import-form", "admin.js"]) {
  if (!adminHtml.includes(token)) throw new Error(`Missing expected admin token: ${token}`);
}
for (const token of ["Secure Login", "Owner Admin, Team Leader, or Team Member", "MACS Secure Login"]) {
  if (!adminHtml.includes(token)) throw new Error(`Missing expected general login token: ${token}`);
}

const securityHtml = await readFile(path.join(root, "public/security.html"), "utf8");
for (const token of ["MACS Security", "team-form", "security-tools-card", "session-timeout-form", "security-audit-list", "login-activity-list", "security.js"]) {
  if (!securityHtml.includes(token)) throw new Error(`Missing expected security token: ${token}`);
}

const scheduleHtml = await readFile(path.join(root, "public/schedule.html"), "utf8");
for (const token of ["recurring-form", "recurring-list", "quote-schedule-list", "week-calendar", "prev-week", "recurring-start-time", "schedule.js", "logout-admin"]) {
  if (!scheduleHtml.includes(token)) throw new Error(`Missing expected schedule token: ${token}`);
}

const downloadsHtml = await readFile(path.join(root, "public/downloads.html"), "utf8");
for (const token of ["MACS Downloads", "About the App", "App Info", "Android 7.0 and above", "macs-lawnquote-android-v1.0.8.apk"]) {
  if (!downloadsHtml.includes(token)) throw new Error(`Missing expected downloads token: ${token}`);
}

const quoteHtml = await readFile(path.join(root, "public/quote.html"), "utf8");
for (const token of ["quote-form", "photo-input", "result-price", "open-map", "lawn-map", "print-quote", "device-badge", "job-dialog", "admin.html", "app.js"]) {
  if (!quoteHtml.includes(token)) throw new Error(`Missing expected UI token: ${token}`);
}

const app = await readFile(path.join(root, "public/app.js"), "utf8");
for (const token of ["World_Imagery", "satellite", "street"]) {
  if (!app.includes(token)) throw new Error(`Missing expected map token: ${token}`);
}

for (const token of ["NSW_Cadastre", "PropertyAddress", "searchAddressSuggestions"]) {
  if (!app.includes(token)) throw new Error(`Missing expected address/cadastre token: ${token}`);
}

for (const token of ["detectDevice", "window.print", "updatePrintSheet", "priceBreakdown"]) {
  if (!app.includes(token)) throw new Error(`Missing expected quote/device token: ${token}`);
}

for (const token of ["requireAdminSession", "Admin login required"]) {
  if (!app.includes(token)) throw new Error(`Missing expected quote security token: ${token}`);
}

for (const token of ["viewSavedQuote", "editSavedQuote", "deleteSavedQuote", "loadFormState"]) {
  if (!app.includes(token)) throw new Error(`Missing expected saved-job token: ${token}`);
}

const auth = await readFile(path.join(root, "public/auth.js"), "utf8");
for (const token of ["createOwnerAccount", "loginAdmin", "recoverPassword", "updateTwoFactor", "requireAdminSession", "createTeamMember", "approveTeamMember", "unlockTeamMember", "listSecurityAudit", "sendTestSecurityEmail", "createEncryptedBackup", "initAccessibleNavigation", "startInactivityLogout", "canAccessPage", "listLoginActivity", "updateSessionLocation", "recordCurrentLocation", "enableHighAccuracy: true", "updateSessionTimeout", "listQuoteJobs", "saveQuoteJobs", "listRecurringJobs", "saveRecurringJobs", "page === \"security\"", "page === \"downloads\""]) {
  if (!auth.includes(token)) throw new Error(`Missing expected auth token: ${token}`);
}
if (!auth.includes('["admin", "schedule", "quote"].includes(page)')) {
  throw new Error("Logged-out users should still see login-required page links");
}

const admin = await readFile(path.join(root, "public/admin.js"), "utf8");
for (const token of ["renderDashboard", "materialForm", "changePassword", "recoverPassword", "renderTeam", "renderLoginActivity", "renderSecurityAudit", "showLoginPopup", "sendTestSecurityEmail", "createEncryptedBackup", "approveTeamMember", "unlockTeamMember", "getTwoFactorSetup", "enhancePasswordFields", "importJobsFromCsv", "completed_pending_approval", "isAssignedToCurrentUser"]) {
  if (!admin.includes(token)) throw new Error(`Missing expected admin app token: ${token}`);
}

const security = await readFile(path.join(root, "public/security.js"), "utf8");
for (const token of ["renderTeam", "renderLoginActivity", "renderSecurityAudit", "approveTeamMember", "Team login approved successfully", "window.alert", "createTeamMember", "sendTestSecurityEmail", "createEncryptedBackup", "updateSessionTimeout", "riskSignals", "Risk:", "Browser GPS", "locationLabel", "notificationAccepted", "queued"]) {
  if (!security.includes(token)) throw new Error(`Missing expected security app token: ${token}`);
}

const schedule = await readFile(path.join(root, "public/schedule.js"), "utf8");
for (const token of ["requireAdminSession", "recurringPatch", "quotePatch", "Submit complete", "Only Owner Admin or Team Leader", "listQuoteJobs", "saveQuoteJobs", "listRecurringJobs", "saveRecurringJobs", "listRosterJobs", "saveRosterJob", "deleteRosterJob", "completeRosterJob", "renderWeekCalendar", "rosterDates", "Repeat weeks", "Job assigned successfully", "recurring-start-time", "confirmRosterCompletion", "roster-complete-button", "Confirm", "Reject"]) {
  if (!schedule.includes(token)) throw new Error(`Missing expected schedule app token: ${token}`);
}

const server = await readFile(path.join(root, "server.mjs"), "utf8");
for (const token of ["verifyTotp", "otpauth://totp", "/api/team", "/api/team/approve", "/api/team/unlock", "/api/jobs/quotes", "/api/jobs/recurring", "jobs.json", "/api/roster/jobs", "/api/roster/jobs/delete", "/api/roster/jobs/complete", "roster.json", "notifyRosterAssignment", "notifyRosterAssignments", "roster_assignment_notified", "roster_job_deleted", "roster_job_completed", "/api/security/audit", "/api/security/session-timeout", "/api/security/test-email", "/api/security/backup", "/api/login-activity", "loginRiskSignals", "Proxy/VPN header chain detected", "maxSessionTimeoutMinutes", "login-activity.json", "email-outbox.json", "security-audit.json", "createEncryptedBackup", "notifyOwnerSecurityEvent", "maxFailedLogins", "Owner Admin", "Team Leader", "Team Member", "session?.role === \"member\""]) {
  if (!server.includes(token)) throw new Error(`Missing expected server auth/team token: ${token}`);
}
for (const token of ["queued-local", "deliveryError", "notificationAccepted(notification)", "Queued for local mail transport.", "startLocalMailTransport"]) {
  if (!server.includes(token)) throw new Error(`Missing expected email queue fallback token: ${token}`);
}

const mailWorker = await readFile(path.join(root, "scripts/mail-outbox-worker.mjs"), "utf8");
for (const token of ["STARTTLS", "MAIL_REQUIRE_TLS", "email-outbox.json", "sent-relay", "MAIL_DIRECT_MX_FALLBACK", "deliveryAttempts"]) {
  if (!mailWorker.includes(token)) throw new Error(`Missing expected local mail transport token: ${token}`);
}

for (const path of ["/api/team", "/api/team/approve", "/api/team/unlock", "/api/team/update", "/api/team/delete"]) {
  const routeIndex = server.indexOf(`req.method === "POST" && url.pathname === "${path}"`);
  if (routeIndex === -1) throw new Error(`Missing expected team route: ${path}`);
  const nextRouteIndex = server.indexOf('req.method === "POST" && url.pathname === "', routeIndex + path.length + 41);
  const routeBlock = server.slice(routeIndex, nextRouteIndex === -1 ? server.length : nextRouteIndex);
  if (!routeBlock.includes("requireOwner(admin, req, res)")) {
    throw new Error(`${path} should require Owner Admin access`);
  }
  if (routeBlock.includes("requireOwnerTwoFactor(admin, req, res)")) {
    throw new Error(`${path} should not require 2FA setup before team access changes`);
  }
}

for (const token of ["map-layer-panel", "Lot/property boundaries", "Street address numbers", "Cadastral lot numbers"]) {
  if (!quoteHtml.includes(token)) throw new Error(`Missing expected layer-control token: ${token}`);
}

console.log("Smoke test passed");
