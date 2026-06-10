import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const outboxFile = path.join(dataDir, "email-outbox.json");
const fromEmail = process.env.NOTIFICATION_FROM_EMAIL || "security@macs.rctrusts.com";
const heloName = process.env.MAIL_HELO_NAME || "macs.rctrusts.com";
const requireTls = process.env.MAIL_REQUIRE_TLS !== "0";
const directMxFallback = process.env.MAIL_DIRECT_MX_FALLBACK === "1";
const maxPerRun = Number(process.env.MAIL_OUTBOX_MAX_PER_RUN || 20);
const pendingStatuses = new Set(["queued", "queued-local", "unsent", "failed"]);

function smtpRead(socket, timeout = 10000) {
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

function cleanHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function dotStuff(body) {
  return String(body || "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function buildMessage(notification) {
  const to = cleanHeader(notification.to);
  const subject = cleanHeader(notification.subject);
  return [
    `From: MACS Security <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${notification.id || randomUUID()}@macs.rctrusts.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    dotStuff(notification.body)
  ].join("\r\n");
}

function sendWithLocalTransport(notification) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/sbin/sendmail", ["-t"], { stdio: ["pipe", "ignore", "pipe"] });
    let errorOutput = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Local msmtp transport timed out."));
    }, 30000);
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
      else reject(new Error(errorOutput.trim() || `Local msmtp transport exited with code ${code}.`));
    });
    child.stdin.end(buildMessage(notification));
  });
}

async function startTls(socket, host) {
  await smtpCommand(socket, "STARTTLS", /^220/);
  return tls.connect({
    socket,
    servername: host,
    rejectUnauthorized: true
  });
}

async function sendDirectMx(notification) {
  const to = cleanHeader(notification.to);
  const domain = to.split("@")[1];
  if (!domain) throw new Error("Recipient email domain is invalid.");
  const mxRecords = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority);
  if (!mxRecords.length) throw new Error(`No MX record found for ${domain}.`);

  let lastError = null;
  for (const mx of mxRecords.slice(0, 3)) {
    let socket = net.createConnection({ host: mx.exchange, port: 25, timeout: 10000 });
    socket.setTimeout(10000);
    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        socket.once("timeout", () => reject(new Error("SMTP connection timed out.")));
      });
      await smtpRead(socket);
      const ehlo = await smtpCommand(socket, `EHLO ${heloName}`);
      if (/STARTTLS/im.test(ehlo)) {
        socket = await startTls(socket, mx.exchange);
        await smtpCommand(socket, `EHLO ${heloName}`);
      } else if (requireTls) {
        throw new Error(`MX ${mx.exchange} does not advertise STARTTLS.`);
      }
      await smtpCommand(socket, `MAIL FROM:<${fromEmail}>`);
      await smtpCommand(socket, `RCPT TO:<${to}>`);
      await smtpCommand(socket, "DATA", /^354/);
      socket.write(`${buildMessage(notification)}\r\n.\r\n`);
      const accepted = await smtpRead(socket);
      if (!/^250/m.test(accepted)) throw new Error(accepted.trim());
      await smtpCommand(socket, "QUIT", /^[23]/).catch(() => {});
      return;
    } catch (error) {
      lastError = error;
    } finally {
      socket.end();
    }
  }
  throw lastError || new Error("No MX accepted the message.");
}

async function readOutbox() {
  try {
    const parsed = JSON.parse(await readFile(outboxFile, "utf8"));
    return Array.isArray(parsed.notifications) ? parsed : { notifications: [] };
  } catch {
    return { notifications: [] };
  }
}

async function writeOutbox(outbox) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(outboxFile, JSON.stringify(outbox, null, 2));
  await chmod(outboxFile, 0o600).catch(() => {});
}

const outbox = await readOutbox();
let attempted = 0;
let delivered = 0;

for (const notification of outbox.notifications) {
  if (attempted >= maxPerRun) break;
  if (notification.sentAt || !pendingStatuses.has(notification.status)) continue;

  attempted += 1;
  notification.deliveryAttempts = Number(notification.deliveryAttempts || 0) + 1;
  notification.lastAttemptAt = new Date().toISOString();
  try {
    try {
      await sendWithLocalTransport(notification);
      notification.status = "sent-relay";
    } catch (relayError) {
      if (!directMxFallback) throw relayError;
      await sendDirectMx(notification);
      notification.status = "sent-direct-mx";
    }
    notification.sentAt = new Date().toISOString();
    notification.error = null;
    notification.deliveryError = null;
    delivered += 1;
  } catch (error) {
    notification.status = "queued-local";
    notification.deliveryError = error.message;
  }
}

await writeOutbox(outbox);
console.log(`Mail outbox worker attempted ${attempted}, delivered ${delivered}.`);
