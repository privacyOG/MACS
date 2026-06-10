import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createCipheriv, createHmac, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCrewLocationPingToPostgres,
  appendCustomerMessageLogToPostgres,
  ensurePostgresSchema,
  postgresStatus,
  pruneCrewLocationPings,
  readAdminFromPostgres,
  readEmailOutboxFromPostgres,
  readFieldOperationsFromPostgres,
  readJobsDataFromPostgres,
  readLoginActivityFromPostgres,
  readPostgresCounts,
  readRosterFromPostgres,
  readSecurityAuditFromPostgres,
  writeAdminToPostgres,
  writeEmailOutboxToPostgres,
  writeJobsDataToPostgres,
  writeLoginActivityToPostgres,
  writeRosterToPostgres,
  writeSecurityAuditToPostgres
} from "./lib/postgres-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const adminFile = path.join(dataDir, "admin.json");
const loginActivityFile = path.join(dataDir, "login-activity.json");
const emailOutboxFile = path.join(dataDir, "email-outbox.json");
const securityAuditFile = path.join(dataDir, "security-audit.json");
const rosterFile = path.join(dataDir, "roster.json");
const jobsFile = path.join(dataDir, "jobs.json");
const backupDir = path.join(dataDir, "backups");
const backupKeyFile = path.join(dataDir, "backup.key");
const port = Number(process.env.PORT || 18890);
const host = process.env.HOST || "0.0.0.0";
const tlsCertFile = process.env.TLS_CERT_FILE || "";
const tlsKeyFile = process.env.TLS_KEY_FILE || "";
const forceHttps = process.env.FORCE_HTTPS === "1";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
const ownerNotificationEmail = process.env.OWNER_NOTIFICATION_EMAIL || "rc@privacyx.co";
const notificationFromEmail = process.env.NOTIFICATION_FROM_EMAIL || "security@macs.rctrusts.com";
const maxFailedLogins = 4;
const defaultSessionTimeoutMinutes = 30;
const maxSessionTimeoutMinutes = 240;
const sessions = new Map();
const roles = {
  owner: "Owner Admin",
  leader: "Team Leader",
  member: "Team Member"
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
  [".apk", "application/vnd.android.package-archive"],
  [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

function hashSecret(secret, salt) {
  return scryptSync(secret, salt, 32).toString("hex");
}

function verifySecret(secret, salt, expectedHash) {
  const actual = Buffer.from(hashSecret(secret, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function recoveryCode() {
  return randomBytes(8).toString("hex").toUpperCase();
}

function normaliseIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanEmployeeProfile(input = {}, existing = {}) {
  return {
    fullName: String(input.fullName ?? existing.fullName ?? "").trim().slice(0, 160),
    address: String(input.address ?? existing.address ?? "").trim().slice(0, 500),
    dateOfBirth: String(input.dateOfBirth ?? input.dob ?? existing.dateOfBirth ?? "").trim().slice(0, 20),
    mobile: String(input.mobile ?? input.phone ?? existing.mobile ?? "").trim().slice(0, 80),
    email: normaliseIdentifier(input.email ?? existing.email ?? "")
  };
}

function cleanCredentialFiles(input = [], existing = []) {
  const files = Array.isArray(input) ? input : [];
  return files.slice(0, 20).map((file, index) => {
    const previous = Array.isArray(existing) ? existing[index] || {} : {};
    return {
      id: String(file.id || previous.id || randomUUID()),
      label: String(file.label || previous.label || "Credential").trim().slice(0, 120),
      filename: String(file.filename || previous.filename || "").trim().slice(0, 180),
      mimeType: String(file.mimeType || previous.mimeType || "").trim().slice(0, 120),
      size: Math.max(0, Math.round(Number(file.size || previous.size || 0))),
      dataUrl: String(file.dataUrl || previous.dataUrl || "").slice(0, 2_500_000),
      uploadedAt: String(file.uploadedAt || previous.uploadedAt || new Date().toISOString()),
      uploadedBy: String(file.uploadedBy || previous.uploadedBy || "")
    };
  }).filter((file) => file.label && file.filename && file.dataUrl && /^(image\/|application\/pdf$)/.test(file.mimeType));
}

function employeeProfileForUser(user, { includeCredentials = false } = {}) {
  const profile = cleanEmployeeProfile(user.profile || {}, { email: user.email });
  return {
    ...profile,
    credentials: includeCredentials ? cleanCredentialFiles(user.credentials || []) : undefined,
    credentialCount: Array.isArray(user.credentials) ? user.credentials.length : 0
  };
}

function publicUser(user, options = {}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    roleLabel: roles[user.role] || user.role,
    approvalStatus: user.approvalStatus || "approved",
    approvedAt: user.approvedAt || null,
    approvedBy: user.approvedBy || null,
    lockedAt: user.lockedAt || null,
    unlockedAt: user.unlockedAt || null,
    failedLoginCount: Number(user.failedLoginCount || 0),
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
    profile: employeeProfileForUser(user, options),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function isApproved(user) {
  return (user.approvalStatus || "approved") === "approved";
}

function isLocked(user) {
  if (!user.lockedAt) return false;
  if (!user.unlockedAt) return true;
  return new Date(user.lockedAt) > new Date(user.unlockedAt);
}

function approveUser(user, owner) {
  user.approvalStatus = "approved";
  user.approvedAt = new Date().toISOString();
  user.approvedBy = owner?.username || "Owner Admin";
  user.updatedAt = new Date().toISOString();
}

function unlockUser(user, owner) {
  user.failedLoginCount = 0;
  user.lockedAt = null;
  user.unlockedAt = new Date().toISOString();
  user.unlockedBy = owner?.username || "Owner Admin";
  user.updatedAt = new Date().toISOString();
}

function recordFailedLogin(user) {
  user.failedLoginCount = Number(user.failedLoginCount || 0) + 1;
  user.lastFailedLoginAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  if (user.failedLoginCount >= maxFailedLogins) {
    user.lockedAt = new Date().toISOString();
  }
}

function resetFailedLogins(user) {
  user.failedLoginCount = 0;
  user.lastFailedLoginAt = null;
  user.updatedAt = new Date().toISOString();
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  const socketIp = req.socket.remoteAddress || "";
  return forwarded || realIp || socketIp || "unknown";
}

function forwardedIpChain(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isPrivateIp(ip) {
  const value = String(ip || "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value.startsWith("10.") || value.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

function deviceProfile(userAgent = "") {
  const ua = String(userAgent);
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/i.test(ua)
        ? "iOS"
        : /Mac OS|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown OS";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /OPR\//i.test(ua)
      ? "Opera"
      : /Chrome\//i.test(ua)
        ? "Chrome"
        : /Safari\//i.test(ua)
          ? "Safari"
          : /Firefox\//i.test(ua)
            ? "Firefox"
            : "Unknown browser";
  return {
    type: isTablet ? "Tablet" : isMobile ? "Mobile" : "Desktop",
    browser,
    os,
    userAgent: ua.slice(0, 240)
  };
}

function sessionTimeoutMinutes(admin) {
  const minutes = Number(admin?.security?.sessionTimeoutMinutes || defaultSessionTimeoutMinutes);
  if (!Number.isFinite(minutes)) return defaultSessionTimeoutMinutes;
  return Math.max(5, Math.min(maxSessionTimeoutMinutes, Math.round(minutes)));
}

function crewGpsEnabled(admin) {
  return Boolean(admin?.security?.crewGpsEnabled);
}

function crewGpsRetentionDays(admin) {
  const days = Number(admin?.security?.crewGpsRetentionDays || 14);
  if (!Number.isFinite(days)) return 14;
  return Math.max(1, Math.min(90, Math.round(days)));
}

function fieldSecuritySettings(admin) {
  return {
    crewGpsEnabled: crewGpsEnabled(admin),
    crewGpsRetentionDays: crewGpsRetentionDays(admin),
    maxCrewGpsRetentionDays: 90
  };
}

function sessionTimeoutMs(admin) {
  return sessionTimeoutMinutes(admin) * 60 * 1000;
}

function loginRiskSignals(req, user, body = {}, activity = { logins: [] }) {
  const ip = clientIp(req);
  const chain = forwardedIpChain(req);
  const timezone = String(body.timezone || "");
  const previous = activity.logins.filter((login) => login.userId === user.id);
  const signals = [];
  if (chain.length > 1 || req.headers["x-real-ip"]) signals.push("Proxy/VPN header chain detected");
  if (ip !== "unknown" && !isPrivateIp(ip) && !previous.some((login) => login.ip === ip)) signals.push("New IP address for this user");
  if (timezone && previous.some((login) => login.location?.timezone && login.location.timezone !== timezone)) signals.push("Different timezone than previous login");
  if (Number(user.failedLoginCount || 0) > 0) signals.push(`${user.failedLoginCount} recent failed login ${Number(user.failedLoginCount) === 1 ? "attempt" : "attempts"}`);
  const recentSameIp = activity.logins.filter((login) => login.ip === ip && new Date(login.loginAt).getTime() > Date.now() - 60 * 60 * 1000);
  if (recentSameIp.length >= 5) signals.push("High login volume from same IP in the last hour");
  return {
    level: signals.length >= 2 ? "high" : signals.length ? "medium" : "normal",
    signals
  };
}

async function readLoginActivityJson() {
  try {
    const parsed = JSON.parse(await readFile(loginActivityFile, "utf8"));
    return Array.isArray(parsed.logins) ? parsed : { logins: [] };
  } catch {
    return { logins: [] };
  }
}

async function writeLoginActivityJson(activity) {
  await mkdir(dataDir, { recursive: true });
  const logins = Array.isArray(activity.logins) ? activity.logins.slice(0, 500) : [];
  await writeFile(loginActivityFile, JSON.stringify({ logins }, null, 2));
  await chmod(loginActivityFile, 0o600).catch(() => {});
}

async function readLoginActivity() {
  const fallback = await readLoginActivityJson();
  try {
    const postgresActivity = await readLoginActivityFromPostgres();
    if (postgresActivity) {
      const hasPostgresLogins = Array.isArray(postgresActivity.logins) && postgresActivity.logins.length > 0;
      const hasJsonLogins = Array.isArray(fallback.logins) && fallback.logins.length > 0;
      if (!hasPostgresLogins && hasJsonLogins) {
        await writeLoginActivityToPostgres(fallback);
        console.info("Bootstrapped PostgreSQL login_activity from data/login-activity.json.");
        return fallback;
      }
      return postgresActivity;
    }
  } catch (error) {
    console.warn(`PostgreSQL login activity read unavailable: ${error.message}`);
  }
  return fallback;
}

async function writeLoginActivity(activity) {
  const logins = Array.isArray(activity.logins) ? activity.logins.slice(0, 500) : [];
  const snapshot = { logins };
  try {
    await writeLoginActivityToPostgres(snapshot);
  } catch (error) {
    console.warn(`PostgreSQL login activity write unavailable: ${error.message}`);
  }
  await writeLoginActivityJson(snapshot);
}

async function recordLogin(req, user, sessionId, body = {}, timeoutMinutes = defaultSessionTimeoutMinutes) {
  const now = new Date().toISOString();
  const activity = await readLoginActivity();
  const risk = loginRiskSignals(req, user, body, activity);
  const login = {
    id: randomUUID(),
    sessionId,
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    roleLabel: roles[user.role] || user.role,
    loginAt: now,
    lastSeenAt: now,
    logoutAt: null,
    expiresAt: new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString(),
    inactivityTimeoutMinutes: timeoutMinutes,
    durationSeconds: 0,
    ip: clientIp(req),
    forwardedFor: forwardedIpChain(req),
    device: deviceProfile(req.headers["user-agent"]),
    riskLevel: risk.level,
    riskSignals: risk.signals,
    location: {
      timezone: String(body.timezone || ""),
      locale: String(body.locale || ""),
      latitude: null,
      longitude: null,
      accuracy: null,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      capturedAt: null,
      permissionState: "",
      status: "pending",
      errorCode: null,
      errorMessage: "",
      source: "request"
    }
  };
  activity.logins.unshift(login);
  await writeLoginActivity(activity);
  return login;
}

async function updateLoginActivity(loginId, patch) {
  if (!loginId) return;
  const activity = await readLoginActivity();
  const login = activity.logins.find((item) => item.id === loginId);
  if (!login) return;
  Object.assign(login, patch);
  if (login.loginAt) {
    const end = login.logoutAt || login.lastSeenAt || new Date().toISOString();
    login.durationSeconds = Math.max(0, Math.round((new Date(end) - new Date(login.loginAt)) / 1000));
  }
  await writeLoginActivity(activity);
}

async function readEmailOutboxJson() {
  try {
    const parsed = JSON.parse(await readFile(emailOutboxFile, "utf8"));
    return Array.isArray(parsed.notifications) ? parsed : { notifications: [] };
  } catch {
    return { notifications: [] };
  }
}

async function readEmailOutbox() {
  const fallback = await readEmailOutboxJson();
  try {
    const postgresOutbox = await readEmailOutboxFromPostgres();
    if (postgresOutbox) {
      const hasPostgresItems = Array.isArray(postgresOutbox.notifications) && postgresOutbox.notifications.length > 0;
      const hasJsonItems = Array.isArray(fallback.notifications) && fallback.notifications.length > 0;
      if (!hasPostgresItems && hasJsonItems) {
        await writeEmailOutboxToPostgres(fallback);
        console.info("Bootstrapped PostgreSQL email_notifications from data/email-outbox.json.");
        return fallback;
      }
      return postgresOutbox;
    }
  } catch (error) {
    console.warn(`PostgreSQL email outbox read unavailable: ${error.message}`);
  }
  return fallback;
}

async function readSecurityAuditJson() {
  try {
    const parsed = JSON.parse(await readFile(securityAuditFile, "utf8"));
    return Array.isArray(parsed.events) ? parsed : { events: [] };
  } catch {
    return { events: [] };
  }
}

async function readRosterJson() {
  try {
    const parsed = JSON.parse(await readFile(rosterFile, "utf8"));
    return Array.isArray(parsed.jobs) ? parsed : { jobs: [] };
  } catch {
    return { jobs: [] };
  }
}

async function writeRosterJson(roster) {
  await mkdir(dataDir, { recursive: true });
  const jobs = Array.isArray(roster.jobs) ? roster.jobs.slice(0, 1000) : [];
  await writeFile(rosterFile, JSON.stringify({ jobs }, null, 2));
  await chmod(rosterFile, 0o600).catch(() => {});
}

async function readRoster() {
  const fallback = await readRosterJson();
  try {
    const postgresRoster = await readRosterFromPostgres();
    if (postgresRoster) {
      const hasPostgresJobs = Array.isArray(postgresRoster.jobs) && postgresRoster.jobs.length > 0;
      const hasJsonJobs = Array.isArray(fallback.jobs) && fallback.jobs.length > 0;
      if (!hasPostgresJobs && hasJsonJobs) {
        await writeRosterToPostgres(fallback);
        console.info("Bootstrapped PostgreSQL roster_jobs from data/roster.json.");
        return fallback;
      }
      return postgresRoster;
    }
  } catch (error) {
    console.warn(`PostgreSQL roster read unavailable: ${error.message}`);
  }
  return fallback;
}

async function writeRoster(roster) {
  const jobs = Array.isArray(roster.jobs) ? roster.jobs.slice(0, 1000) : [];
  const snapshot = { jobs };
  try {
    await writeRosterToPostgres(snapshot);
  } catch (error) {
    console.warn(`PostgreSQL roster write unavailable: ${error.message}`);
  }
  await writeRosterJson(snapshot);
}

async function readJobsDataJson() {
  try {
    const parsed = JSON.parse(await readFile(jobsFile, "utf8"));
    return {
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      recurring: Array.isArray(parsed.recurring) ? parsed.recurring : []
    };
  } catch {
    return { quotes: [], recurring: [] };
  }
}

async function writeJobsDataJson(data) {
  await mkdir(dataDir, { recursive: true });
  const quotes = Array.isArray(data.quotes) ? data.quotes.slice(0, 1000) : [];
  const recurring = Array.isArray(data.recurring) ? data.recurring.slice(0, 1000) : [];
  await writeFile(jobsFile, JSON.stringify({ quotes, recurring }, null, 2));
  await chmod(jobsFile, 0o600).catch(() => {});
}

async function readJobsData() {
  const fallback = await readJobsDataJson();
  try {
    const postgresJobs = await readJobsDataFromPostgres();
    if (postgresJobs) {
      const hasPostgresJobs = (Array.isArray(postgresJobs.quotes) && postgresJobs.quotes.length > 0)
        || (Array.isArray(postgresJobs.recurring) && postgresJobs.recurring.length > 0);
      const hasJsonJobs = (Array.isArray(fallback.quotes) && fallback.quotes.length > 0)
        || (Array.isArray(fallback.recurring) && fallback.recurring.length > 0);
      if (!hasPostgresJobs && hasJsonJobs) {
        await writeJobsDataToPostgres(fallback);
        console.info("Bootstrapped PostgreSQL quote_jobs and recurring_jobs from data/jobs.json.");
        return fallback;
      }
      return postgresJobs;
    }
  } catch (error) {
    console.warn(`PostgreSQL jobs read unavailable: ${error.message}`);
  }
  return fallback;
}

async function writeJobsData(data) {
  const quotes = Array.isArray(data.quotes) ? data.quotes.slice(0, 1000) : [];
  const recurring = Array.isArray(data.recurring) ? data.recurring.slice(0, 1000) : [];
  const snapshot = { quotes, recurring };
  try {
    await writeJobsDataToPostgres(snapshot);
  } catch (error) {
    console.warn(`PostgreSQL jobs write unavailable: ${error.message}`);
  }
  await writeJobsDataJson(snapshot);
}

async function readSecurityAudit() {
  const fallback = await readSecurityAuditJson();
  try {
    const postgresAudit = await readSecurityAuditFromPostgres();
    if (postgresAudit) {
      const hasPostgresEvents = Array.isArray(postgresAudit.events) && postgresAudit.events.length > 0;
      const hasJsonEvents = Array.isArray(fallback.events) && fallback.events.length > 0;
      if (!hasPostgresEvents && hasJsonEvents) {
        await writeSecurityAuditToPostgres(fallback);
        console.info("Bootstrapped PostgreSQL security_audit_events from data/security-audit.json.");
        return fallback;
      }
      return postgresAudit;
    }
  } catch (error) {
    console.warn(`PostgreSQL security audit read unavailable: ${error.message}`);
  }
  return fallback;
}

async function writeSecurityAuditJson(audit) {
  await mkdir(dataDir, { recursive: true });
  const events = Array.isArray(audit.events) ? audit.events.slice(0, 500) : [];
  await writeFile(securityAuditFile, JSON.stringify({ events }, null, 2));
  await chmod(securityAuditFile, 0o600).catch(() => {});
}

async function writeSecurityAudit(audit) {
  const events = Array.isArray(audit.events) ? audit.events.slice(0, 500) : [];
  const snapshot = { events };
  try {
    await writeSecurityAuditToPostgres(snapshot);
  } catch (error) {
    console.warn(`PostgreSQL security audit write unavailable: ${error.message}`);
  }
  await writeSecurityAuditJson(snapshot);
}

async function auditSecurityEvent(req, actor, action, target = {}, details = {}) {
  const audit = await readSecurityAudit();
  audit.events.unshift({
    id: randomUUID(),
    action,
    actor: actor ? { id: actor.id, username: actor.username, email: actor.email, role: actor.role } : null,
    target,
    details,
    ip: req ? clientIp(req) : null,
    device: req ? deviceProfile(req.headers["user-agent"]) : null,
    createdAt: new Date().toISOString()
  });
  await writeSecurityAudit(audit);
}

async function writeEmailOutbox(outbox) {
  await mkdir(dataDir, { recursive: true });
  const notifications = Array.isArray(outbox.notifications) ? outbox.notifications.slice(0, 200) : [];
  const snapshot = { notifications };
  try {
    await writeEmailOutboxToPostgres(snapshot);
  } catch (error) {
    console.warn(`PostgreSQL email outbox write unavailable: ${error.message}`);
  }
  await writeFile(emailOutboxFile, JSON.stringify(snapshot, null, 2));
  await chmod(emailOutboxFile, 0o600).catch(() => {});
}

function startLocalMailTransport() {
  const child = spawn("systemctl", ["--user", "start", "macs-mail-outbox.service"], {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {});
  child.unref();
}

async function availableMailer(to = ownerNotificationEmail) {
  const candidates = [
    { command: "/usr/sbin/sendmail", args: ["-t"] },
    { command: "/usr/bin/sendmail", args: ["-t"] },
    { command: "/usr/bin/msmtp", args: [to] }
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate.command);
      return candidate;
    } catch {
      // Try the next known local mailer path.
    }
  }
  return null;
}

function smtpRead(socket, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => cleanup(() => reject(new Error("SMTP read timed out."))), timeout);
    function cleanup(done) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      done();
    }
    function onError(error) {
      cleanup(() => reject(error));
    }
    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) cleanup(() => resolve(buffer));
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!expected.test(response)) throw new Error(response.trim());
  return response;
}

async function sendMailDirectToMx(to, subject, body) {
  const domain = String(to).split("@")[1];
  if (!domain) throw new Error("Recipient email domain is invalid.");
  const mx = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0];
  if (!mx?.exchange) throw new Error(`No MX record found for ${domain}.`);
  const message = [
    `From: MACS Security <${notificationFromEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n");
  const socket = net.createConnection({ host: mx.exchange, port: 25, timeout: 5000 });
  socket.setTimeout(5000);
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("SMTP connection timed out.")));
    });
    await smtpRead(socket);
    await smtpCommand(socket, "EHLO macs.rctrusts.com");
    await smtpCommand(socket, `MAIL FROM:<${notificationFromEmail}>`);
    await smtpCommand(socket, `RCPT TO:<${to}>`);
    await smtpCommand(socket, "DATA", /^354/);
    socket.write(`${message}\r\n.\r\n`);
    const accepted = await smtpRead(socket);
    if (!/^250/m.test(accepted)) throw new Error(accepted.trim());
    await smtpCommand(socket, "QUIT", /^[23]/).catch(() => {});
  } finally {
    socket.end();
  }
}

function sendMailWithLocalTransport(mailer, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(mailer.command, mailer.args, { stdio: ["pipe", "ignore", "pipe"] });
    let errorOutput = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Mail transport timed out."));
    }, 10000);
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `Mail transport exited with code ${code}.`));
    });
    child.stdin.end(message);
  });
}

async function notifyOwnerLoginCreated(user, createdBy) {
  return sendSecurityEmail(ownerNotificationEmail, `MACS login pending approval: ${user.username}`, [
    `A new MACS login was created and is waiting for Owner Admin approval.`,
    ``,
    `Username: ${user.username}`,
    `Email: ${user.email}`,
    `Role: ${roles[user.role] || user.role}`,
    `Created by: ${createdBy?.username || "Owner Admin"}`,
    `Created at: ${user.createdAt}`,
    ``,
    `Login is blocked until Owner Admin approves it from the Admin dashboard.`
  ].join("\n"));
}

async function notifyTeamLoginPending(user, createdBy) {
  return sendSecurityEmail(user.email, "MACS team login created - pending approval", [
    `Your MACS team login has been created and is waiting for Owner Admin approval.`,
    ``,
    `Username: ${user.username}`,
    `Email: ${user.email}`,
    `Role: ${roles[user.role] || user.role}`,
    `Created by: ${createdBy?.username || "Owner Admin"}`,
    `Created at: ${user.createdAt}`,
    ``,
    `You will receive another email once your login registration has been approved.`
  ].join("\n"));
}

async function notifyTeamLoginApproved(user, approvedBy) {
  return sendSecurityEmail(user.email, "MACS team login approved", [
    `Your MACS team login registration has been approved.`,
    ``,
    `Username: ${user.username}`,
    `Email: ${user.email}`,
    `Role: ${roles[user.role] || user.role}`,
    `Approved by: ${approvedBy?.username || "Owner Admin"}`,
    `Approved at: ${user.approvedAt}`,
    ``,
    `You can now sign in to MACS.`
  ].join("\n"));
}

async function notifyRosterAssignment(user, job, assignedBy) {
  const title = job.title || job.customerName || job.address || "MACS roster job";
  return sendSecurityEmail(user.email, `MACS roster update: ${title}`, [
    `Your MACS roster has been updated.`,
    ``,
    `Job: ${title}`,
    `Customer: ${job.customerName || "Not specified"}`,
    `Customer phone/mobile: ${job.customerPhone || "Not specified"}`,
    `Customer email: ${job.customerEmail || "Not specified"}`,
    `Address: ${job.address || "Not specified"}`,
    `Date: ${job.scheduledDate}`,
    `Start: ${job.startTime}`,
    `Finish: ${job.finishTime}`,
    `Type: ${job.sourceType === "recurring" ? `Recurring (${job.frequency || "regular"})` : "One-off quote job"}`,
    `Assigned by: ${assignedBy?.username || "Owner Admin"}`,
    ``,
    job.notes ? `Notes: ${job.notes}` : `Please check your MACS Schedule/Roster page for details.`
  ].join("\n"));
}

async function notifyRosterAssignments(user, jobs, assignedBy) {
  if (jobs.length <= 1) return notifyRosterAssignment(user, jobs[0], assignedBy);
  const first = jobs[0];
  const title = first.title || first.customerName || first.address || "MACS roster job";
  return sendSecurityEmail(user.email, `MACS roster update: ${title}`, [
    `Your MACS roster has been updated with ${jobs.length} scheduled visits.`,
    ``,
    `Job: ${title}`,
    `Customer: ${first.customerName || "Not specified"}`,
    `Customer phone/mobile: ${first.customerPhone || "Not specified"}`,
    `Customer email: ${first.customerEmail || "Not specified"}`,
    `Address: ${first.address || "Not specified"}`,
    `Type: ${first.sourceType === "recurring" ? `Recurring (${first.frequency || "regular"})` : "One-off quote job"}`,
    `Assigned by: ${assignedBy?.username || "Owner Admin"}`,
    ``,
    `Scheduled visits:`,
    ...jobs.map((job) => `- ${job.scheduledDate}: ${job.startTime} - ${job.finishTime}`),
    ``,
    first.notes ? `Notes: ${first.notes}` : `Please check your MACS Schedule/Roster page for details.`
  ].join("\n"));
}

async function notifyOwnerSecurityEvent(subject, body) {
  return sendSecurityEmail(ownerNotificationEmail, subject, body);
}

function notificationAccepted(notification) {
  return Boolean(notification?.status?.startsWith("sent") || notification?.status === "queued-local" || notification?.status === "queued");
}

async function sendSecurityEmail(to, subject, body) {
  const message = [
    `To: ${to}`,
    `From: MACS Security <${notificationFromEmail}>`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\n");
  const notification = {
    id: randomUUID(),
    to,
    subject,
    body,
    createdAt: new Date().toISOString(),
    sentAt: null,
    status: "queued",
    error: null,
    deliveryError: null
  };
  const mailer = await availableMailer(to);
  if (!mailer) {
    notification.status = "queued-local";
    notification.deliveryError = "Queued for local mail transport.";
  } else {
    try {
      await sendMailWithLocalTransport(mailer, message);
      notification.status = "sent";
      notification.sentAt = new Date().toISOString();
    } catch (error) {
      notification.status = "queued-local";
      notification.deliveryError = error.message;
    }
  }
  const outbox = await readEmailOutbox();
  outbox.notifications.unshift(notification);
  await writeEmailOutbox(outbox);
  if (!notification.sentAt && (notification.status === "queued" || notification.status === "queued-local")) {
    startLocalMailTransport();
  }
  return notification;
}

async function backupKey() {
  try {
    return await readFile(backupKeyFile);
  } catch {
    const key = randomBytes(32);
    await mkdir(dataDir, { recursive: true });
    await writeFile(backupKeyFile, key.toString("hex"));
    await chmod(backupKeyFile, 0o600).catch(() => {});
    return key;
  }
}

async function createEncryptedBackup(req, owner, reason = "manual") {
  await mkdir(backupDir, { recursive: true });
  const files = {};
  for (const name of await readdir(dataDir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    files[name] = JSON.parse(await readFile(path.join(dataDir, name), "utf8").catch(() => "{}"));
  }
  const payload = Buffer.from(JSON.stringify({
    createdAt: new Date().toISOString(),
    reason,
    files
  }, null, 2));
  const keyMaterial = await backupKey();
  const key = createHash("sha256").update(keyMaterial).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  const backup = {
    algorithm: "aes-256-gcm",
    createdAt: new Date().toISOString(),
    reason,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64")
  };
  const filename = `lawnquote-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.enc.json`;
  const fullPath = path.join(backupDir, filename);
  await writeFile(fullPath, JSON.stringify(backup, null, 2));
  await auditSecurityEvent(req, owner, "encrypted_backup_created", { filename }, { reason });
  return { filename, path: fullPath, createdAt: backup.createdAt };
}

function normaliseAdmin(admin) {
  if (!admin) return { users: [], updatedAt: null, security: { sessionTimeoutMinutes: defaultSessionTimeoutMinutes } };
  if (Array.isArray(admin.users)) {
    return {
      ...admin,
      security: {
        ...(admin.security || {}),
        sessionTimeoutMinutes: sessionTimeoutMinutes(admin)
      },
      users: admin.users.map((user) => ({
        ...user,
        approvalStatus: user.approvalStatus || "approved",
        approvedAt: user.approvedAt || user.createdAt || admin.updatedAt || null,
        approvedBy: user.approvedBy || "Legacy",
        failedLoginCount: Number(user.failedLoginCount || 0),
        lockedAt: user.lockedAt || null,
        unlockedAt: user.unlockedAt || null
      }))
    };
  }
  if (!admin.passwordHash) return { users: [], updatedAt: null };
  return {
    users: [{
      id: "owner-legacy",
      username: "owner",
      email: "owner@macs.local",
      role: "owner",
      salt: admin.salt,
      passwordHash: admin.passwordHash,
      recoveryHash: admin.recoveryHash,
      twoFactorEnabled: Boolean(admin.twoFactorEnabled),
      twoFactorSecret: "",
      legacyTwoFactorHash: admin.twoFactorHash || "",
      approvalStatus: "approved",
      approvedAt: admin.updatedAt || new Date().toISOString(),
      approvedBy: "Legacy",
      failedLoginCount: 0,
      lockedAt: null,
      unlockedAt: null,
      createdAt: admin.updatedAt || new Date().toISOString(),
      updatedAt: admin.updatedAt || new Date().toISOString()
    }],
    updatedAt: admin.updatedAt || new Date().toISOString(),
    security: { sessionTimeoutMinutes: defaultSessionTimeoutMinutes }
  };
}

async function readAdminJson() {
  try {
    return normaliseAdmin(JSON.parse(await readFile(adminFile, "utf8")));
  } catch {
    return normaliseAdmin(null);
  }
}

async function writeAdminJson(admin) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(adminFile, JSON.stringify(admin, null, 2));
  await chmod(adminFile, 0o600).catch(() => {});
}

async function readAdmin() {
  const fallback = await readAdminJson();
  try {
    const postgresAdmin = await readAdminFromPostgres();
    if (postgresAdmin) return normaliseAdmin(postgresAdmin);
    if (fallback.users.length) {
      await writeAdminToPostgres(fallback);
      console.info("Bootstrapped PostgreSQL app_state/app_users from data/admin.json.");
    }
  } catch (error) {
    console.warn(`PostgreSQL admin read unavailable: ${error.message}`);
  }
  return fallback;
}

async function writeAdmin(admin) {
  const snapshot = normaliseAdmin(admin);
  try {
    await writeAdminToPostgres(snapshot);
  } catch (error) {
    console.warn(`PostgreSQL admin write unavailable: ${error.message}`);
  }
  await writeAdminJson(snapshot);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((cookie) => {
    const [name, ...value] = cookie.trim().split("=");
    return [name, decodeURIComponent(value.join("="))];
  }));
}

function currentSession(req) {
  const id = parseCookies(req).macs_admin_session;
  const session = id ? sessions.get(id) : null;
  const now = Date.now();
  if (!session || session.expiresAt < now || (session.timeoutMs && now - session.lastSeenAt > session.timeoutMs)) {
    if (id) sessions.delete(id);
    return null;
  }
  session.lastSeenAt = now;
  if (session.timeoutMs) session.expiresAt = now + session.timeoutMs;
  return session;
}

function currentUser(admin, req) {
  const session = currentSession(req);
  if (!session) return null;
  const user = admin.users.find((item) => item.id === session.userId);
  if (!user) return null;
  return { session, user };
}

function requireUser(admin, req, res) {
  const auth = currentUser(admin, req);
  if (!auth) {
    sendJson(res, 401, { ok: false, message: "Login required." });
    return null;
  }
  return auth;
}

function requireOwner(admin, req, res) {
  const auth = requireUser(admin, req, res);
  if (!auth) return null;
  if (auth.user.role !== "owner") {
    sendJson(res, 403, { ok: false, message: "Owner Admin access required." });
    return null;
  }
  return auth;
}

function requireRosterManager(admin, req, res) {
  const auth = requireUser(admin, req, res);
  if (!auth) return null;
  if (!["owner", "leader"].includes(auth.user.role)) {
    sendJson(res, 403, { ok: false, message: "Only Owner Admin or Team Leader can assign roster jobs." });
    return null;
  }
  return auth;
}

function requireOwnerTwoFactor(admin, req, res) {
  const auth = requireOwner(admin, req, res);
  if (!auth) return null;
  if (!auth.user.twoFactorEnabled) {
    sendJson(res, 403, { ok: false, message: "Owner Admin must enable authenticator app 2FA before using this security action." });
    return null;
  }
  return auth;
}

function rosterJobForUser(job, user) {
  return {
    ...job,
    assignedUser: user ? publicUser(user) : null
  };
}

function cleanRosterJob(input, assignedUser, assignedBy, existing = null) {
  const now = new Date().toISOString();
  const scheduledDate = String(input.scheduledDate || input.nextRun || "").trim();
  const startTime = String(input.startTime || "").trim();
  const finishTime = String(input.finishTime || "").trim();
  const sourceType = input.sourceType === "recurring" ? "recurring" : "quote";
  const sourceId = String(input.sourceId || input.id || randomUUID()).trim();
  return {
    id: String(input.id || existing?.id || `${sourceType}:${sourceId}:${scheduledDate}`).trim(),
    sourceType,
    sourceId,
    title: String(input.title || input.customerName || input.address || "MACS roster job").trim(),
    customerName: String(input.customerName || "").trim(),
    customerPhone: String(input.customerPhone || input.phone || input.mobile || "").trim(),
    customerEmail: String(input.customerEmail || input.email || "").trim(),
    address: String(input.address || "").trim(),
    assignedTo: assignedUser.id,
    assignedUsername: assignedUser.username,
    assignedEmail: assignedUser.email,
    scheduledDate,
    startTime,
    finishTime,
    frequency: String(input.frequency || "").trim(),
    price: Number(input.price || 0),
    notes: String(input.notes || "").trim(),
    status: String(input.status || existing?.status || "assigned").trim(),
    assignedBy: assignedBy.username,
    assignedById: assignedBy.id,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function rosterStartDate(job) {
  const scheduledDate = String(job?.scheduledDate || "").trim();
  const startTime = String(job?.startTime || "").trim();
  if (!scheduledDate || !startTime) return null;
  const date = new Date(`${scheduledDate}T${startTime}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isBeforeRosterStart(job) {
  const start = rosterStartDate(job);
  return Boolean(start && Date.now() < start.getTime());
}

function serverTimeLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function completedActualMinutes(job, completedDate) {
  const startTime = String(job?.actualStartTime || "").trim();
  if (!startTime) return Math.max(0, Math.round(Number(job?.actualMinutes || 0)));
  const scheduledDate = String(job?.scheduledDate || "").trim() || completedDate.toISOString().slice(0, 10);
  const start = new Date(`${scheduledDate}T${startTime}:00`);
  if (Number.isNaN(start.getTime())) return Math.max(0, Math.round(Number(job?.actualMinutes || 0)));
  return Math.max(0, Math.round((completedDate.getTime() - start.getTime()) / 60000));
}

function itemId(item) {
  return String(item.id || item.createdAt || randomUUID());
}

function canSeeJobItem(user, item) {
  if (!user) return false;
  if (["owner", "leader"].includes(user.role)) return true;
  return item.assignedTo === user.id || item.assignedTo === user.username || item.createdById === user.id || item.createdBy === user.username;
}

function canActOnRosterJob(user, job) {
  if (!user || !job) return false;
  if (["owner", "leader"].includes(user.role)) return true;
  return job.assignedTo === user.id || job.assignedUsername === user.username;
}

function canWriteJobItem(user, item) {
  if (!user) return false;
  if (["owner", "leader"].includes(user.role)) return true;
  return item.createdById === user.id || item.createdBy === user.username;
}

function cleanQuoteJob(input, actor, existing = null) {
  const now = new Date().toISOString();
  const id = itemId(input);
  return {
    ...existing,
    ...input,
    id,
    createdAt: input.createdAt || existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || input.createdBy || actor.username,
    createdById: existing?.createdById || input.createdById || actor.id
  };
}

function cleanRecurringJob(input, actor, existing = null) {
  const now = new Date().toISOString();
  const id = itemId(input);
  return {
    ...existing,
    ...input,
    id,
    createdAt: input.createdAt || existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || input.createdBy || actor.username,
    createdById: existing?.createdById || input.createdById || actor.id
  };
}

async function updateLinkedRosterSource(job, patch) {
  if (job?.sourceType !== "quote" || !job?.sourceId) return;
  const data = await readJobsData();
  const index = data.quotes.findIndex((item) => itemId(item) === String(job.sourceId));
  if (index < 0) return;
  data.quotes[index] = {
    ...data.quotes[index],
    ...patch,
    statusUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writeJobsData(data);
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Secret(length = 20) {
  const bytes = randomBytes(length);
  let output = "";
  for (const byte of bytes) output += base32Alphabet[byte % base32Alphabet.length];
  return output;
}

function base32Decode(input) {
  const clean = String(input || "").replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const value = base32Alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, step) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, "0");
}

function verifyTotp(secret, code) {
  const clean = String(code || "").replace(/\s+/g, "");
  const step = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((offset) => totpCode(secret, step + offset) === clean);
}

function otpauthUrl(user, secret) {
  const label = encodeURIComponent(`MACS:${user.email || user.username}`);
  const issuer = encodeURIComponent("MACS Mowing");
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function sendJson(res, statusCode, body, headers = {}) {
  const content = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(content);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeJoin(base, requestPath) {
  const target = path.normalize(path.join(base, requestPath));
  return target.startsWith(base) ? target : null;
}

async function sendFile(res, filePath) {
  const fileStat = await stat(filePath);
  const extension = path.extname(filePath);
  const type = mimeTypes.get(extension) || "application/octet-stream";
  const headers = {};
  if (extension === ".apk") {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath)}"`;
    headers["X-Content-Type-Options"] = "nosniff";
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": fileStat.size,
    "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=300",
    ...headers
  });
  createReadStream(filePath).pipe(res);
}

async function handleAuth(req, res, url) {
  const admin = await readAdmin();

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const auth = currentUser(admin, req);
    sendJson(res, 200, {
      configured: admin.users.length > 0,
      loggedIn: Boolean(auth),
      twoFactorEnabled: Boolean(auth?.user.twoFactorEnabled),
      updatedAt: admin.updatedAt || null,
      user: auth ? publicUser(auth.user) : null,
      security: {
        sessionTimeoutMinutes: sessionTimeoutMinutes(admin),
        maxSessionTimeoutMinutes,
        ...fieldSecuritySettings(admin)
      },
      storage: auth && ["owner", "leader"].includes(auth.user.role) ? postgresStatus() : null,
      roles
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/health/storage") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    try {
      const counts = await readPostgresCounts();
      sendJson(res, 200, {
        ok: true,
        storage: {
          ...postgresStatus(),
          counts
        },
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        storage: postgresStatus(),
        message: error?.message || "PostgreSQL health check failed.",
        checkedAt: new Date().toISOString()
      });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/setup") {
    if (admin.users.length) {
      sendJson(res, 409, { ok: false, message: "Admin account already exists." });
      return true;
    }
    const body = await readJsonBody(req);
    const username = normaliseIdentifier(body.username);
    const email = normaliseIdentifier(body.email);
    if (!body.password || body.password.length < 8) {
      sendJson(res, 400, { ok: false, message: "Use at least 8 characters for the admin password." });
      return true;
    }
    if (!username || !email.includes("@")) {
      sendJson(res, 400, { ok: false, message: "Enter an admin username and email address." });
      return true;
    }
    const salt = randomBytes(16).toString("hex");
    const nextRecoveryCode = recoveryCode();
    const user = {
      id: randomUUID(),
      username,
      email,
      role: "owner",
      salt,
      passwordHash: hashSecret(body.password, salt),
      recoveryHash: hashSecret(nextRecoveryCode, salt),
      twoFactorEnabled: false,
      twoFactorSecret: "",
      approvalStatus: "approved",
      approvedAt: new Date().toISOString(),
      approvedBy: "Initial setup",
      failedLoginCount: 0,
      lockedAt: null,
      unlockedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    admin.users = [user];
    admin.security = { sessionTimeoutMinutes: defaultSessionTimeoutMinutes };
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    sendJson(res, 200, { ok: true, recoveryCode: nextRecoveryCode, user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const identifier = normaliseIdentifier(body.identifier || body.email || body.username);
    const user = admin.users.find((item) => item.email === identifier || item.username === identifier);
    if (!user) {
      sendJson(res, 401, { ok: false, message: "Incorrect password." });
      return true;
    }
    if (!isApproved(user)) {
      sendJson(res, 403, { ok: false, message: "This login is waiting for Owner Admin approval." });
      return true;
    }
    if (isLocked(user)) {
      sendJson(res, 423, { ok: false, message: "This account is locked after too many failed login attempts. Owner Admin must unlock it." });
      return true;
    }
    if (!verifySecret(body.password || "", user.salt, user.passwordHash)) {
      recordFailedLogin(user);
      admin.updatedAt = new Date().toISOString();
      await writeAdmin(admin);
      await auditSecurityEvent(req, null, "failed_login_attempt", { id: user.id, username: user.username, email: user.email, role: user.role }, { reason: "failed_password", attempts: user.failedLoginCount, bruteForceThreshold: maxFailedLogins });
      if (isLocked(user)) {
        await auditSecurityEvent(req, null, "account_locked", { id: user.id, username: user.username, email: user.email, role: user.role }, { reason: "failed_password", attempts: user.failedLoginCount });
        await notifyOwnerSecurityEvent(`MACS account locked: ${user.username}`, [
          `A MACS login was locked after ${maxFailedLogins} failed password attempts.`,
          ``,
          `Username: ${user.username}`,
          `Email: ${user.email}`,
          `Role: ${roles[user.role] || user.role}`,
          `IP: ${clientIp(req)}`,
          `Time: ${new Date().toISOString()}`,
          ``,
          `Owner Admin must unlock this account before it can sign in again.`
        ].join("\n"));
      }
      const remaining = Math.max(0, maxFailedLogins - Number(user.failedLoginCount || 0));
      sendJson(res, 401, {
        ok: false,
        message: isLocked(user)
          ? "Account locked after 4 failed login attempts. Owner Admin must unlock it."
          : `Incorrect password. ${remaining} ${remaining === 1 ? "try" : "tries"} remaining before lockout.`
      });
      return true;
    }
    const legacy2faOk = user.legacyTwoFactorHash && verifySecret(body.twoFactorCode || "", user.salt, user.legacyTwoFactorHash);
    const totpOk = user.twoFactorSecret && verifyTotp(user.twoFactorSecret, body.twoFactorCode);
    if (user.twoFactorEnabled && !legacy2faOk && !totpOk) {
      recordFailedLogin(user);
      admin.updatedAt = new Date().toISOString();
      await writeAdmin(admin);
      await auditSecurityEvent(req, null, "failed_login_attempt", { id: user.id, username: user.username, email: user.email, role: user.role }, { reason: "failed_2fa", attempts: user.failedLoginCount, bruteForceThreshold: maxFailedLogins });
      if (isLocked(user)) {
        await auditSecurityEvent(req, null, "account_locked", { id: user.id, username: user.username, email: user.email, role: user.role }, { reason: "failed_2fa", attempts: user.failedLoginCount });
        await notifyOwnerSecurityEvent(`MACS account locked: ${user.username}`, [
          `A MACS login was locked after ${maxFailedLogins} failed 2FA attempts.`,
          ``,
          `Username: ${user.username}`,
          `Email: ${user.email}`,
          `Role: ${roles[user.role] || user.role}`,
          `IP: ${clientIp(req)}`,
          `Time: ${new Date().toISOString()}`,
          ``,
          `Owner Admin must unlock this account before it can sign in again.`
        ].join("\n"));
      }
      const remaining = Math.max(0, maxFailedLogins - Number(user.failedLoginCount || 0));
      sendJson(res, 401, {
        ok: false,
        message: isLocked(user)
          ? "Account locked after 4 failed login attempts. Owner Admin must unlock it."
          : `Incorrect 2FA code. ${remaining} ${remaining === 1 ? "try" : "tries"} remaining before lockout.`
      });
      return true;
    }
    resetFailedLogins(user);
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    const sessionId = randomUUID();
    const timeoutMinutes = sessionTimeoutMinutes(admin);
    const timeoutMs = sessionTimeoutMs(admin);
    const login = await recordLogin(req, user, sessionId, body, timeoutMinutes);
    sessions.set(sessionId, {
      userId: user.id,
      role: user.role,
      loginId: login.id,
      loginAt: Date.now(),
      lastSeenAt: Date.now(),
      timeoutMs,
      expiresAt: Date.now() + timeoutMs
    });
    await auditSecurityEvent(req, user, user.role === "owner" ? "owner_login_success" : "login_success", { id: user.id, username: user.username, email: user.email, role: user.role }, { riskLevel: login.riskLevel, riskSignals: login.riskSignals });
    if (user.role === "owner") {
      await notifyOwnerSecurityEvent(`MACS Owner Admin login: ${user.username}`, [
        `Owner Admin logged in successfully.`,
        ``,
        `Username: ${user.username}`,
        `Email: ${user.email}`,
        `IP: ${clientIp(req)}`,
        `Device: ${deviceProfile(req.headers["user-agent"]).type} / ${deviceProfile(req.headers["user-agent"]).browser} / ${deviceProfile(req.headers["user-agent"]).os}`,
        `Time: ${new Date().toISOString()}`
      ].join("\n"));
    }
    sendJson(res, 200, { ok: true, user: publicUser(user) }, {
      "Set-Cookie": `macs_admin_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxSessionTimeoutMinutes * 60}`
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const sessionId = parseCookies(req).macs_admin_session;
    const session = sessionId ? sessions.get(sessionId) : null;
    if (sessionId) sessions.delete(sessionId);
    if (session?.loginId) {
      const now = new Date().toISOString();
      await updateLoginActivity(session.loginId, { logoutAt: now, lastSeenAt: now });
    }
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": "macs_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/session-location") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    await updateLoginActivity(auth.session.loginId, {
      location: {
        timezone: String(body.timezone || ""),
        locale: String(body.locale || ""),
        latitude: Number.isFinite(Number(body.latitude)) ? Number(body.latitude) : null,
        longitude: Number.isFinite(Number(body.longitude)) ? Number(body.longitude) : null,
        accuracy: Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
        altitude: Number.isFinite(Number(body.altitude)) ? Number(body.altitude) : null,
        altitudeAccuracy: Number.isFinite(Number(body.altitudeAccuracy)) ? Number(body.altitudeAccuracy) : null,
        heading: Number.isFinite(Number(body.heading)) ? Number(body.heading) : null,
        speed: Number.isFinite(Number(body.speed)) ? Number(body.speed) : null,
        capturedAt: String(body.capturedAt || new Date().toISOString()),
        permissionState: String(body.permissionState || ""),
        status: String(body.status || "unknown"),
        errorCode: body.errorCode || null,
        errorMessage: String(body.errorMessage || ""),
        source: String(body.source || "browser")
      },
      lastSeenAt: new Date().toISOString()
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (!verifySecret(body.currentPassword || "", auth.user.salt, auth.user.passwordHash)) {
      sendJson(res, 401, { ok: false, message: "Current password is incorrect." });
      return true;
    }
    if (!body.nextPassword || body.nextPassword.length < 8) {
      sendJson(res, 400, { ok: false, message: "Use at least 8 characters for the new password." });
      return true;
    }
    auth.user.passwordHash = hashSecret(body.nextPassword, auth.user.salt);
    auth.user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "password_changed", { id: auth.user.id, username: auth.user.username, email: auth.user.email, role: auth.user.role }, {});
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/recover") {
    const body = await readJsonBody(req);
    const identifier = normaliseIdentifier(body.identifier || body.email || body.username);
    const user = admin.users.find((item) => item.email === identifier || item.username === identifier);
    if (!user || !verifySecret(body.recoveryCode || "", user.salt, user.recoveryHash)) {
      sendJson(res, 401, { ok: false, message: "Recovery code is incorrect." });
      return true;
    }
    const nextRecoveryCode = recoveryCode();
    user.passwordHash = hashSecret(body.nextPassword || "", user.salt);
    user.recoveryHash = hashSecret(nextRecoveryCode, user.salt);
    user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    sendJson(res, 200, { ok: true, recoveryCode: nextRecoveryCode });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/2fa/setup") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const secret = base32Secret();
    sendJson(res, 200, {
      ok: true,
      secret,
      otpauthUrl: otpauthUrl(auth.user, secret)
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/2fa") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (body.enabled) {
      const secret = String(body.secret || auth.user.twoFactorSecret || "");
      if (!secret || !verifyTotp(secret, body.twoFactorCode)) {
        sendJson(res, 400, { ok: false, message: "Enter a valid 6-digit authenticator code." });
        return true;
      }
      auth.user.twoFactorEnabled = true;
      auth.user.twoFactorSecret = secret;
      delete auth.user.legacyTwoFactorHash;
    } else {
      auth.user.twoFactorEnabled = false;
      auth.user.twoFactorSecret = "";
      delete auth.user.legacyTwoFactorHash;
    }
    auth.user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, body.enabled ? "two_factor_enabled" : "two_factor_disabled", { id: auth.user.id, username: auth.user.username, email: auth.user.email, role: auth.user.role }, {});
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/team") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    sendJson(res, 200, {
      ok: true,
      users: admin.users.map((user) => publicUser(user, {
        includeCredentials: auth.user.role === "owner" || (auth.user.role === "leader" && user.role !== "owner")
      }))
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/profile") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    sendJson(res, 200, { ok: true, user: publicUser(auth.user, { includeCredentials: true }) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/contact") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const profile = cleanEmployeeProfile({
      ...(auth.user.profile || {}),
      mobile: body.mobile,
      email: body.email
    }, { email: auth.user.email });
    if (!profile.email.includes("@")) {
      sendJson(res, 400, { ok: false, message: "Enter a valid email address." });
      return true;
    }
    if (admin.users.some((user) => user.id !== auth.user.id && user.email === profile.email)) {
      sendJson(res, 409, { ok: false, message: "Another login already uses that email address." });
      return true;
    }
    auth.user.email = profile.email;
    auth.user.profile = { ...(auth.user.profile || {}), ...profile };
    auth.user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "self_profile_contact_updated", { id: auth.user.id, username: auth.user.username, email: auth.user.email }, {});
    sendJson(res, 200, { ok: true, user: publicUser(auth.user, { includeCredentials: true }) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/credentials") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    auth.user.credentials = cleanCredentialFiles(body.credentials || [], auth.user.credentials || []).map((file) => ({
      ...file,
      uploadedBy: file.uploadedBy || auth.user.username
    }));
    auth.user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "self_profile_credentials_updated", { id: auth.user.id, username: auth.user.username, email: auth.user.email }, {
      credentialCount: auth.user.credentials.length
    });
    sendJson(res, 200, { ok: true, user: publicUser(auth.user, { includeCredentials: true }) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/quotes") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const data = await readJobsData();
    sendJson(res, 200, { ok: true, quotes: data.quotes.filter((quote) => canSeeJobItem(auth.user, quote)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/quotes") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const incoming = Array.isArray(body.quotes) ? body.quotes : [body.quote || body];
    const data = await readJobsData();
    const saved = [];
    for (const input of incoming.filter(Boolean)) {
      const id = itemId(input);
      const index = data.quotes.findIndex((quote) => itemId(quote) === id);
      const existing = index >= 0 ? data.quotes[index] : null;
      if (existing && !canWriteJobItem(auth.user, existing)) {
        sendJson(res, 403, { ok: false, message: "You cannot update this quote job." });
        return true;
      }
      const quote = cleanQuoteJob(input, auth.user, existing);
      if (index >= 0) data.quotes[index] = quote;
      else data.quotes.unshift(quote);
      saved.push(quote);
    }
    await writeJobsData(data);
    await auditSecurityEvent(req, auth.user, "quote_jobs_saved", { count: saved.length }, { ids: saved.map((quote) => quote.id) });
    sendJson(res, 200, { ok: true, quote: saved[0] || null, quotes: data.quotes.filter((quote) => canSeeJobItem(auth.user, quote)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/quotes/delete") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const data = await readJobsData();
    const before = data.quotes.length;
    data.quotes = data.quotes.filter((quote) => {
      if (body.all && canSeeJobItem(auth.user, quote) && canWriteJobItem(auth.user, quote)) return false;
      if (body.id && itemId(quote) === String(body.id) && canWriteJobItem(auth.user, quote)) return false;
      return true;
    });
    const deleted = before - data.quotes.length;
    await writeJobsData(data);
    await auditSecurityEvent(req, auth.user, "quote_jobs_deleted", { id: String(body.id || "bulk") }, { deleted });
    sendJson(res, 200, { ok: true, deleted, quotes: data.quotes.filter((quote) => canSeeJobItem(auth.user, quote)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/recurring") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const data = await readJobsData();
    sendJson(res, 200, { ok: true, jobs: data.recurring.filter((job) => canSeeJobItem(auth.user, job)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/recurring") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const incoming = Array.isArray(body.jobs) ? body.jobs : [body.job || body];
    const data = await readJobsData();
    const saved = [];
    for (const input of incoming.filter(Boolean)) {
      const id = itemId(input);
      const index = data.recurring.findIndex((job) => itemId(job) === id);
      const job = cleanRecurringJob(input, auth.user, index >= 0 ? data.recurring[index] : null);
      if (index >= 0) data.recurring[index] = job;
      else data.recurring.unshift(job);
      saved.push(job);
    }
    await writeJobsData(data);
    await auditSecurityEvent(req, auth.user, "recurring_jobs_saved", { count: saved.length }, { ids: saved.map((job) => job.id) });
    sendJson(res, 200, { ok: true, job: saved[0] || null, jobs: data.recurring.filter((job) => canSeeJobItem(auth.user, job)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/recurring/delete") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const data = await readJobsData();
    const before = data.recurring.length;
    data.recurring = data.recurring.filter((job) => {
      if (body.all) return false;
      if (body.id && itemId(job) === String(body.id)) return false;
      return true;
    });
    const deleted = before - data.recurring.length;
    await writeJobsData(data);
    await auditSecurityEvent(req, auth.user, "recurring_jobs_deleted", { id: String(body.id || "bulk") }, { deleted });
    sendJson(res, 200, { ok: true, deleted, jobs: data.recurring.filter((job) => canSeeJobItem(auth.user, job)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/roster/jobs") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const roster = await readRoster();
    const visibleJobs = roster.jobs
      .filter((job) => ["owner", "leader"].includes(auth.user.role) || job.assignedTo === auth.user.id || job.assignedUsername === auth.user.username)
      .map((job) => rosterJobForUser(job, admin.users.find((user) => user.id === job.assignedTo || user.username === job.assignedUsername)));
    sendJson(res, 200, { ok: true, jobs: visibleJobs });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/roster/jobs") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const incomingJobs = Array.isArray(body.jobs) ? body.jobs : [body];
    if (!incomingJobs.length) {
      sendJson(res, 400, { ok: false, message: "At least one roster job is required." });
      return true;
    }
    const assignedTo = String(incomingJobs[0].assignedTo || incomingJobs[0].userId || "").trim();
    const assignedUser = admin.users.find((user) => user.id === assignedTo || user.username === assignedTo);
    if (!assignedUser || assignedUser.role !== "member") {
      sendJson(res, 404, { ok: false, message: "Assigned team member not found." });
      return true;
    }
    const roster = await readRoster();
    const savedJobs = [];
    for (const input of incomingJobs) {
      if (String(input.assignedTo || input.userId || "").trim() !== assignedTo) {
        sendJson(res, 400, { ok: false, message: "Bulk roster assignment must use one team member." });
        return true;
      }
      if (!String(input.scheduledDate || input.nextRun || "").trim() || !String(input.startTime || "").trim() || !String(input.finishTime || "").trim()) {
        sendJson(res, 400, { ok: false, message: "Roster date, start time, and finish time are required." });
        return true;
      }
      if (String(input.finishTime) <= String(input.startTime)) {
        sendJson(res, 400, { ok: false, message: "Finish time must be after start time." });
        return true;
      }
      const requestedId = String(input.id || `${input.sourceType === "recurring" ? "recurring" : "quote"}:${input.sourceId || input.id}:${input.scheduledDate || input.nextRun}`).trim();
      const existingIndex = roster.jobs.findIndex((job) => job.id === requestedId);
      const job = cleanRosterJob(input, assignedUser, auth.user, existingIndex >= 0 ? roster.jobs[existingIndex] : null);
      if (existingIndex >= 0) roster.jobs[existingIndex] = job;
      else roster.jobs.unshift(job);
      savedJobs.push(job);
    }
    await writeRoster(roster);
    const notification = await notifyRosterAssignments(assignedUser, savedJobs, auth.user);
    await auditSecurityEvent(req, auth.user, "roster_assignment_notified", {
      id: assignedUser.id,
      username: assignedUser.username,
      email: assignedUser.email,
      role: assignedUser.role
    }, {
      jobIds: savedJobs.map((job) => job.id),
      title: savedJobs[0].title,
      scheduledDates: savedJobs.map((job) => job.scheduledDate),
      status: notification.status
    });
    sendJson(res, 200, {
      ok: true,
      job: rosterJobForUser(savedJobs[0], assignedUser),
      jobs: savedJobs.map((job) => rosterJobForUser(job, assignedUser)),
      notification: {
        to: notification.to,
        status: notification.status,
        sentAt: notification.sentAt,
        error: notification.error
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/roster/jobs/delete") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const roster = await readRoster();
    const before = roster.jobs.length;
    roster.jobs = roster.jobs.filter((job) => {
      if (body.id && job.id === body.id) return false;
      if (body.sourceType && body.sourceId && job.sourceType === body.sourceType && job.sourceId === body.sourceId) return false;
      return true;
    });
    const deleted = before - roster.jobs.length;
    await writeRoster(roster);
    await auditSecurityEvent(req, auth.user, "roster_job_deleted", { id: String(body.id || body.sourceId || "bulk") }, { deleted });
    sendJson(res, 200, { ok: true, deleted });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/roster/jobs/complete") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const id = String(body.id || "").trim();
    const roster = await readRoster();
    const index = roster.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      sendJson(res, 404, { ok: false, message: "Roster job not found." });
      return true;
    }
    const job = roster.jobs[index];
    const isAssignedMember = job.assignedTo === auth.user.id || job.assignedUsername === auth.user.username;
    if (!["owner", "leader"].includes(auth.user.role) && !isAssignedMember) {
      sendJson(res, 403, { ok: false, message: "You can only complete roster jobs assigned to you." });
      return true;
    }
    if (isBeforeRosterStart(job)) {
      sendJson(res, 400, { ok: false, message: `This job cannot be marked complete before ${job.scheduledDate} at ${job.startTime}.` });
      return true;
    }
    if (job.status === "approved") {
      sendJson(res, 400, { ok: false, message: "This roster job has already been approved." });
      return true;
    }
    if (job.status === "completed_pending_approval" || job.completedAt) {
      sendJson(res, 400, { ok: false, message: "This roster job has already been submitted for approval." });
      return true;
    }
    const completedDate = new Date();
    const now = completedDate.toISOString();
    const actualFinishTime = serverTimeLabel(completedDate);
    const allowGps = crewGpsEnabled(admin);
    roster.jobs[index] = {
      ...job,
      status: "completed_pending_approval",
      completedAt: now,
      completedBy: auth.user.username,
      completedById: auth.user.id,
      actualFinishTime,
      actualMinutes: completedActualMinutes(job, completedDate),
      checkOutLocation: allowGps ? body.checkOutLocation || job.checkOutLocation || null : job.checkOutLocation || null,
      updatedAt: now
    };
    await writeRoster(roster);
    await updateLinkedRosterSource(roster.jobs[index], {
      status: "completed_pending_approval",
      completedAt: roster.jobs[index].completedAt,
      completedBy: roster.jobs[index].completedBy,
      completedById: roster.jobs[index].completedById,
      actualFinishTime: roster.jobs[index].actualFinishTime,
      actualMinutes: roster.jobs[index].actualMinutes
    });
    await auditSecurityEvent(req, auth.user, "roster_job_completed", {
      id: roster.jobs[index].id,
      title: roster.jobs[index].title,
      assignedTo: roster.jobs[index].assignedTo
    }, {
      scheduledDate: roster.jobs[index].scheduledDate,
      completedAt: roster.jobs[index].completedAt,
      actualFinishTime: roster.jobs[index].actualFinishTime,
      actualMinutes: roster.jobs[index].actualMinutes
    });
    const assignedUser = admin.users.find((user) => user.id === roster.jobs[index].assignedTo || user.username === roster.jobs[index].assignedUsername);
    sendJson(res, 200, { ok: true, job: rosterJobForUser(roster.jobs[index], assignedUser) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/roster/jobs/approve") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const id = String(body.id || "").trim();
    const roster = await readRoster();
    const index = roster.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      sendJson(res, 404, { ok: false, message: "Roster job not found." });
      return true;
    }
    const job = roster.jobs[index];
    if (job.status !== "completed_pending_approval") {
      sendJson(res, 400, { ok: false, message: "This roster job is not waiting for approval." });
      return true;
    }
    const now = new Date().toISOString();
    roster.jobs[index] = {
      ...job,
      status: "approved",
      approvedAt: now,
      approvedBy: auth.user.username,
      approvedById: auth.user.id,
      updatedAt: now
    };
    await writeRoster(roster);
    await updateLinkedRosterSource(roster.jobs[index], {
      status: "approved",
      approvedAt: now,
      approvedBy: auth.user.username,
      approvedById: auth.user.id
    });
    await auditSecurityEvent(req, auth.user, "roster_job_approved", {
      id: roster.jobs[index].id,
      title: roster.jobs[index].title,
      assignedTo: roster.jobs[index].assignedTo
    }, {
      scheduledDate: roster.jobs[index].scheduledDate,
      completedAt: roster.jobs[index].completedAt,
      approvedAt: now
    });
    const assignedUser = admin.users.find((user) => user.id === roster.jobs[index].assignedTo || user.username === roster.jobs[index].assignedUsername);
    sendJson(res, 200, { ok: true, job: rosterJobForUser(roster.jobs[index], assignedUser) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/roster/jobs/worklog") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const id = String(body.id || "").trim();
    const roster = await readRoster();
    const index = roster.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      sendJson(res, 404, { ok: false, message: "Roster job not found." });
      return true;
    }
    const job = roster.jobs[index];
    if (!canActOnRosterJob(auth.user, job)) {
      sendJson(res, 403, { ok: false, message: "You can only update work logs for jobs assigned to you." });
      return true;
    }
    const allowGps = crewGpsEnabled(admin);
    const materials = Array.isArray(body.materials)
      ? body.materials.map((item) => ({
        name: String(item.name || "").trim(),
        quantity: Number(item.quantity || 0),
        unit: String(item.unit || "").trim(),
        cost: Number(item.cost || 0)
      })).filter((item) => item.name || item.quantity || item.cost)
      : [];
    const now = new Date().toISOString();
    roster.jobs[index] = {
      ...job,
      actualStartTime: String(body.actualStartTime || "").trim(),
      actualFinishTime: String(body.actualFinishTime || "").trim(),
      actualMinutes: Math.max(0, Math.round(Number(body.actualMinutes || 0))),
      materials,
      workNotes: String(body.workNotes || "").trim(),
      checkInLocation: allowGps ? body.checkInLocation || job.checkInLocation || null : job.checkInLocation || null,
      checkOutLocation: allowGps ? body.checkOutLocation || job.checkOutLocation || null : job.checkOutLocation || null,
      worklogUpdatedAt: now,
      worklogUpdatedBy: auth.user.username,
      worklogUpdatedById: auth.user.id,
      updatedAt: now
    };
    await writeRoster(roster);
    await auditSecurityEvent(req, auth.user, "roster_job_worklog_saved", {
      id: roster.jobs[index].id,
      title: roster.jobs[index].title,
      assignedTo: roster.jobs[index].assignedTo
    }, {
      actualMinutes: roster.jobs[index].actualMinutes,
      materials: roster.jobs[index].materials.length
    });
    const assignedUser = admin.users.find((user) => user.id === roster.jobs[index].assignedTo || user.username === roster.jobs[index].assignedUsername);
    sendJson(res, 200, { ok: true, job: rosterJobForUser(roster.jobs[index], assignedUser) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/customer-messages/log") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const roster = await readRoster();
    const job = roster.jobs.find((item) => item.id === String(body.rosterJobId || body.jobId || "").trim());
    if (!job) {
      sendJson(res, 404, { ok: false, message: "Roster job not found." });
      return true;
    }
    if (!canActOnRosterJob(auth.user, job)) {
      sendJson(res, 403, { ok: false, message: "You can only message customers for jobs assigned to you." });
      return true;
    }
    const recipient = String(body.recipient || job.customerPhone || job.phone || job.mobile || "").trim();
    if (!recipient) {
      sendJson(res, 400, { ok: false, message: "Customer phone/mobile is required before sending an SMS." });
      return true;
    }
    const now = new Date().toISOString();
    const text = String(body.body || `Hi ${job.customerName || "there"}, this is MACS. We are on our way to your property now.`).trim();
    const message = await appendCustomerMessageLogToPostgres({
      id: randomUUID(),
      type: "customer_message",
      channel: String(body.channel || "sms").trim() || "sms",
      template: String(body.template || "on_my_way").trim() || "on_my_way",
      status: "opened-device-sms",
      recipient,
      to: recipient,
      subject: "On my way SMS",
      body: text,
      rosterJobId: job.id,
      customerName: job.customerName || "",
      customerPhone: job.customerPhone || "",
      customerEmail: job.customerEmail || "",
      address: job.address || "",
      createdAt: now,
      createdBy: auth.user.username,
      createdById: auth.user.id
    });
    await auditSecurityEvent(req, auth.user, "customer_message_logged", {
      id: job.id,
      title: job.title,
      customerName: job.customerName
    }, {
      channel: message.channel,
      template: message.template,
      status: message.status
    });
    sendJson(res, 200, { ok: true, message });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/field/location") {
    const auth = requireUser(admin, req, res);
    if (!auth) return true;
    if (!crewGpsEnabled(admin)) {
      sendJson(res, 403, { ok: false, message: "Crew GPS capture is disabled by Owner Admin." });
      return true;
    }
    const body = await readJsonBody(req);
    const roster = await readRoster();
    const job = roster.jobs.find((item) => item.id === String(body.rosterJobId || body.jobId || "").trim());
    if (!job) {
      sendJson(res, 404, { ok: false, message: "Roster job not found." });
      return true;
    }
    if (!canActOnRosterJob(auth.user, job)) {
      sendJson(res, 403, { ok: false, message: "You can only share location for jobs assigned to you." });
      return true;
    }
    try {
      const ping = await appendCrewLocationPingToPostgres({
        id: randomUUID(),
        kind: String(body.kind || "live").trim() || "live",
        userId: auth.user.id,
        username: auth.user.username,
        rosterJobId: job.id,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy,
        capturedAt: body.capturedAt || new Date().toISOString(),
        customerName: job.customerName || "",
        customerPhone: job.customerPhone || "",
        customerEmail: job.customerEmail || "",
        address: job.address || "",
        scheduledDate: job.scheduledDate || "",
        startTime: job.startTime || "",
        finishTime: job.finishTime || ""
      });
      const pruned = await pruneCrewLocationPings(crewGpsRetentionDays(admin));
      await auditSecurityEvent(req, auth.user, "crew_location_ping_logged", {
        id: job.id,
        title: job.title,
        assignedTo: job.assignedTo
      }, {
        kind: ping.kind,
        capturedAt: ping.capturedAt,
        retentionDays: crewGpsRetentionDays(admin),
        pruned
      });
      sendJson(res, 200, { ok: true, ping, pruned });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error?.message || "Crew location could not be saved." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/operations/field-logs") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const operations = await readFieldOperationsFromPostgres(200);
    sendJson(res, 200, { ok: true, ...operations });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/customers/contact") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const matchName = String(body.matchName || "").trim().toLowerCase();
    const matchAddress = String(body.matchAddress || "").trim().toLowerCase();
    if (!matchName && !matchAddress) {
      sendJson(res, 400, { ok: false, message: "Customer name or address is required." });
      return true;
    }
    const patch = {
      customerName: String(body.customerName || body.matchName || "").trim(),
      customerPhone: String(body.customerPhone || "").trim(),
      customerEmail: String(body.customerEmail || "").trim(),
      address: String(body.address || body.matchAddress || "").trim()
    };
    const matches = (item) => {
      const name = String(item.customerName || "").trim().toLowerCase();
      const address = String(item.address || "").trim().toLowerCase();
      return (!matchName || name === matchName) && (!matchAddress || address === matchAddress);
    };
    const data = await readJobsData();
    const roster = await readRoster();
    let updated = 0;
    for (const collection of [data.quotes, data.recurring, roster.jobs]) {
      for (const item of collection) {
        if (!matches(item)) continue;
        item.customerName = patch.customerName;
        item.customerPhone = patch.customerPhone;
        item.customerEmail = patch.customerEmail;
        item.address = patch.address;
        item.updatedAt = new Date().toISOString();
        updated += 1;
      }
    }
    await writeJobsData(data);
    await writeRoster(roster);
    await auditSecurityEvent(req, auth.user, "customer_contact_updated", {
      customerName: patch.customerName,
      address: patch.address
    }, { updated });
    sendJson(res, 200, { ok: true, updated });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/login-activity") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const activity = await readLoginActivity();
    const activeSessions = new Map([...sessions.values()].map((session) => [session.loginId, session]));
    sendJson(res, 200, {
      ok: true,
      logins: activity.logins.map((login) => {
        const activeSession = activeSessions.get(login.id);
        const endTime = activeSession ? Date.now() : new Date(login.logoutAt || login.lastSeenAt || login.loginAt).getTime();
        const startTime = new Date(login.loginAt).getTime();
        return {
          ...login,
          active: Boolean(activeSession),
          durationSeconds: Math.max(0, Math.round((endTime - startTime) / 1000))
        };
      })
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/security/audit") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const audit = await readSecurityAudit();
    sendJson(res, 200, { ok: true, events: audit.events });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/security/session-timeout") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const requestedMinutes = Math.round(Number(body.minutes || defaultSessionTimeoutMinutes));
    const minutes = Math.max(5, Math.min(maxSessionTimeoutMinutes, Number.isFinite(requestedMinutes) ? requestedMinutes : defaultSessionTimeoutMinutes));
    admin.security = { ...(admin.security || {}), sessionTimeoutMinutes: minutes };
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "session_timeout_updated", { minutes }, { maxMinutes: maxSessionTimeoutMinutes });
    sendJson(res, 200, { ok: true, minutes, maxMinutes: maxSessionTimeoutMinutes });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/security/field-settings") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const retentionDays = Math.max(1, Math.min(90, Math.round(Number(body.crewGpsRetentionDays || 14))));
    admin.security = {
      ...(admin.security || {}),
      crewGpsEnabled: Boolean(body.crewGpsEnabled),
      crewGpsRetentionDays: Number.isFinite(retentionDays) ? retentionDays : 14
    };
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    const pruned = await pruneCrewLocationPings(admin.security.crewGpsRetentionDays).catch(() => 0);
    await auditSecurityEvent(req, auth.user, "field_settings_updated", {
      crewGpsEnabled: admin.security.crewGpsEnabled,
      crewGpsRetentionDays: admin.security.crewGpsRetentionDays
    }, { pruned });
    sendJson(res, 200, { ok: true, security: fieldSecuritySettings(admin), pruned });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/security/test-email") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const notification = await notifyOwnerSecurityEvent("MACS security email test", [
      `This is a MACS security notification test.`,
      ``,
      `Requested by: ${auth.user.username}`,
      `Recipient: ${ownerNotificationEmail}`,
      `Time: ${new Date().toISOString()}`
    ].join("\n"));
    await auditSecurityEvent(req, auth.user, "test_email_sent", { to: ownerNotificationEmail }, { status: notification.status, error: notification.error });
    const accepted = notificationAccepted(notification);
    sendJson(res, accepted ? 200 : 502, {
      ok: accepted,
      notification: {
        to: notification.to,
        status: notification.status,
        sentAt: notification.sentAt,
        error: notification.error
      },
      message: notification.status.startsWith("sent")
        ? `Test email accepted for delivery to ${ownerNotificationEmail}.`
        : accepted
          ? `Test email queued for delivery to ${ownerNotificationEmail}.`
        : `Test email could not be sent: ${notification.error}`
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/security/backup") {
    const auth = requireOwnerTwoFactor(admin, req, res);
    if (!auth) return true;
    const backup = await createEncryptedBackup(req, auth.user, "owner_admin_request");
    sendJson(res, 200, { ok: true, backup });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/team") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const username = normaliseIdentifier(body.username);
    const email = normaliseIdentifier(body.email);
    const role = ["owner", "leader", "member"].includes(body.role) ? body.role : "member";
    const profile = cleanEmployeeProfile({
      fullName: body.fullName,
      address: body.address,
      dateOfBirth: body.dateOfBirth || body.dob,
      mobile: body.mobile,
      email
    }, { email });
    if (!username || !email.includes("@") || !body.password || body.password.length < 8) {
      sendJson(res, 400, { ok: false, message: "Enter username, email, role, and an 8+ character password." });
      return true;
    }
    if (admin.users.some((user) => user.username === username || user.email === email)) {
      sendJson(res, 409, { ok: false, message: "A team login with that username or email already exists." });
      return true;
    }
    const salt = randomBytes(16).toString("hex");
    const nextRecoveryCode = recoveryCode();
    const user = {
      id: randomUUID(),
      username,
      email,
      role,
      salt,
      passwordHash: hashSecret(body.password, salt),
      recoveryHash: hashSecret(nextRecoveryCode, salt),
      twoFactorEnabled: false,
      twoFactorSecret: "",
      approvalStatus: role === "owner" ? "pending" : "pending",
      approvedAt: null,
      approvedBy: null,
      failedLoginCount: 0,
      lockedAt: null,
      unlockedAt: null,
      profile,
      credentials: cleanCredentialFiles(body.credentials || []).map((file) => ({
        ...file,
        uploadedAt: file.uploadedAt || new Date().toISOString(),
        uploadedBy: auth.user.username
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    admin.users.push(user);
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "team_login_created_pending", { id: user.id, username: user.username, email: user.email, role: user.role }, {});
    const ownerNotification = await notifyOwnerLoginCreated(user, auth.user);
    const teamNotification = await notifyTeamLoginPending(user, auth.user);
    sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      recoveryCode: nextRecoveryCode,
      notification: {
        to: ownerNotification.to,
        status: ownerNotification.status,
        error: ownerNotification.error
      },
      notifications: {
        owner: {
          to: ownerNotification.to,
          status: ownerNotification.status,
          error: ownerNotification.error
        },
        team: {
          to: teamNotification.to,
          status: teamNotification.status,
          error: teamNotification.error
        }
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/team/approve") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const user = admin.users.find((item) => item.id === body.id);
    if (!user) {
      sendJson(res, 404, { ok: false, message: "Team member not found." });
      return true;
    }
    if (auth.user.role !== "owner" && user.role === "owner") {
      sendJson(res, 403, { ok: false, message: "Only Owner Admin can manage Owner Admin employee records." });
      return true;
    }
    approveUser(user, auth.user);
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "team_login_approved", { id: user.id, username: user.username, email: user.email, role: user.role }, {});
    const notification = await notifyTeamLoginApproved(user, auth.user);
    sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      notification: {
        to: notification.to,
        status: notification.status,
        error: notification.error
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/team/unlock") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const user = admin.users.find((item) => item.id === body.id);
    if (!user) {
      sendJson(res, 404, { ok: false, message: "Team member not found." });
      return true;
    }
    unlockUser(user, auth.user);
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "team_login_unlocked", { id: user.id, username: user.username, email: user.email, role: user.role }, {});
    sendJson(res, 200, { ok: true, user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/team/update") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const user = admin.users.find((item) => item.id === body.id);
    if (!user) {
      sendJson(res, 404, { ok: false, message: "Team member not found." });
      return true;
    }
    const ownerCount = admin.users.filter((item) => item.role === "owner").length;
    const nextRole = ["owner", "leader", "member"].includes(body.role) ? body.role : user.role;
    if (user.role === "owner" && nextRole !== "owner" && ownerCount <= 1) {
      sendJson(res, 400, { ok: false, message: "Keep at least one Owner Admin account." });
      return true;
    }
    const previousRole = user.role;
    user.role = nextRole;
    user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "team_login_role_updated", { id: user.id, username: user.username, email: user.email, previousRole, role: nextRole }, {});
    sendJson(res, 200, { ok: true, user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/team/profile") {
    const auth = requireRosterManager(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const user = admin.users.find((item) => item.id === body.id);
    if (!user) {
      sendJson(res, 404, { ok: false, message: "Team member not found." });
      return true;
    }
    const profile = cleanEmployeeProfile(body.profile || body, user.profile || { email: user.email });
    if (profile.email && !profile.email.includes("@")) {
      sendJson(res, 400, { ok: false, message: "Enter a valid employee email address." });
      return true;
    }
    if (profile.email && admin.users.some((item) => item.id !== user.id && item.email === profile.email)) {
      sendJson(res, 409, { ok: false, message: "Another login already uses that email address." });
      return true;
    }
    user.email = profile.email || user.email;
    user.profile = profile;
    if (Array.isArray(body.credentials)) {
      user.credentials = cleanCredentialFiles(body.credentials, user.credentials || []).map((file) => ({
        ...file,
        uploadedBy: file.uploadedBy || auth.user.username
      }));
    }
    user.updatedAt = new Date().toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "employee_profile_updated", { id: user.id, username: user.username, email: user.email, role: user.role }, {
      credentialCount: Array.isArray(user.credentials) ? user.credentials.length : 0
    });
    sendJson(res, 200, { ok: true, user: publicUser(user, { includeCredentials: true }) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/team/delete") {
    const auth = requireOwner(admin, req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const user = admin.users.find((item) => item.id === body.id);
    if (!user) {
      sendJson(res, 404, { ok: false, message: "Team member not found." });
      return true;
    }
    if (user.id === auth.user.id) {
      sendJson(res, 400, { ok: false, message: "You cannot delete your own active login." });
      return true;
    }
    if (user.role === "owner" && admin.users.filter((item) => item.role === "owner").length <= 1) {
      sendJson(res, 400, { ok: false, message: "Keep at least one Owner Admin account." });
      return true;
    }
    admin.users = admin.users.filter((item) => item.id !== user.id);
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    await auditSecurityEvent(req, auth.user, "team_login_deleted", { id: user.id, username: user.username, email: user.email, role: user.role }, {});
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        app: "lawnquote",
        uptimeSeconds: Math.round(process.uptime()),
        postgres: postgresStatus().enabled ? "enabled" : "disabled",
        checkedAt: new Date().toISOString()
      });
      return;
    }
    if (forceHttps && !tlsCertFile && !url.pathname.startsWith("/.well-known/acme-challenge/")) {
      const target = publicBaseUrl
        ? new URL(`${url.pathname}${url.search}`, publicBaseUrl).toString()
        : `https://${req.headers.host || "localhost"}${url.pathname}${url.search}`;
      res.writeHead(301, {
        "Location": target,
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }
    if ((url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/health/") || url.pathname.startsWith("/api/profile") || url.pathname.startsWith("/api/team") || url.pathname.startsWith("/api/jobs/") || url.pathname.startsWith("/api/roster/") || url.pathname.startsWith("/api/customers/") || url.pathname.startsWith("/api/customer-messages/") || url.pathname.startsWith("/api/field/") || url.pathname.startsWith("/api/operations/") || url.pathname.startsWith("/api/security/") || url.pathname === "/api/login-activity") && await handleAuth(req, res, url)) return;

    if (url.pathname === "/admin.html" && url.searchParams.has("logout")) {
      const sessionId = parseCookies(req).macs_admin_session;
      const session = sessionId ? sessions.get(sessionId) : null;
      if (sessionId) sessions.delete(sessionId);
      if (session?.loginId) {
        const now = new Date().toISOString();
        await updateLoginActivity(session.loginId, { logoutAt: now, lastSeenAt: now });
      }
      res.writeHead(302, {
        "Location": `/admin.html?loggedout=1&t=${Date.now()}`,
        "Cache-Control": "no-store",
        "Set-Cookie": "macs_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
      });
      res.end();
      return;
    }

    if ((url.pathname === "/quote.html" || url.pathname === "/schedule.html" || url.pathname === "/customers.html" || url.pathname === "/invoices.html" || url.pathname === "/crew.html" || url.pathname === "/reports.html" || url.pathname === "/profile.html") && !currentSession(req)) {
      res.writeHead(302, {
        "Location": `/admin.html?next=${encodeURIComponent(url.pathname)}`,
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }

    const session = currentSession(req);
    if ((url.pathname === "/quote.html" || url.pathname === "/customers.html" || url.pathname === "/crew.html" || url.pathname === "/invoices.html") && session && !["owner", "leader"].includes(session.role)) {
      res.writeHead(302, {
        "Location": "/schedule.html",
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }

    if (url.pathname === "/reports.html" && session && !["owner", "leader"].includes(session.role)) {
      res.writeHead(302, {
        "Location": "/schedule.html",
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }

    if (url.pathname === "/admin.html" && session?.role === "member") {
      res.writeHead(302, {
        "Location": "/schedule.html",
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }

    const requestPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = safeJoin(publicDir, requestPath);

    if (!filePath) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    await sendFile(res, filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = tlsCertFile && tlsKeyFile
  ? createHttpsServer({
    cert: await readFile(tlsCertFile),
    key: await readFile(tlsKeyFile)
  }, handleRequest)
  : createHttpServer(handleRequest);

server.listen(port, host, () => {
  console.log(`LawnQuote running at ${tlsCertFile && tlsKeyFile ? "https" : "http"}://${host}:${port}`);
  ensurePostgresSchema().then((enabled) => {
    if (process.env.DATABASE_URL) {
      console.log(`PostgreSQL storage ${enabled ? "enabled" : "not enabled"}: ${postgresStatus().disabledReason || "ready"}`);
    } else {
      console.log("PostgreSQL storage not configured; using JSON backend snapshots.");
    }
  });
});
