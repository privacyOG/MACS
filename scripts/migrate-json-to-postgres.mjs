import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closePostgresPool,
  ensurePostgresSchema,
  postgresStatus,
  rebuildNormalizedTablesFromPostgres,
  writeAdminToPostgres,
  writeEmailOutboxToPostgres,
  writeJobsDataToPostgres,
  writeLoginActivityToPostgres,
  writeRosterToPostgres,
  writeSecurityAuditToPostgres
} from "../lib/postgres-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Example: DATABASE_URL=postgres://lawnquote:password@localhost:5432/lawnquote npm run db:migrate");
  }

  const schemaReady = await ensurePostgresSchema();
  if (!schemaReady) {
    throw new Error(`PostgreSQL schema is not ready: ${postgresStatus().disabledReason || "unknown error"}`);
  }

  const jobs = await readJson(path.join(dataDir, "jobs.json"), { quotes: [], recurring: [] });
  const roster = await readJson(path.join(dataDir, "roster.json"), { jobs: [] });
  const admin = await readJson(path.join(dataDir, "admin.json"), { users: [], updatedAt: null });
  const loginActivity = await readJson(path.join(dataDir, "login-activity.json"), { logins: [] });
  const securityAudit = await readJson(path.join(dataDir, "security-audit.json"), { events: [] });
  const emailOutbox = await readJson(path.join(dataDir, "email-outbox.json"), { notifications: [] });
  const normalizedJobs = {
    quotes: Array.isArray(jobs.quotes) ? jobs.quotes : [],
    recurring: Array.isArray(jobs.recurring) ? jobs.recurring : []
  };
  const normalizedRoster = {
    jobs: Array.isArray(roster.jobs) ? roster.jobs : []
  };
  const normalizedAdmin = {
    ...admin,
    users: Array.isArray(admin.users) ? admin.users : []
  };
  const normalizedActivity = {
    logins: Array.isArray(loginActivity.logins) ? loginActivity.logins : []
  };
  const normalizedAudit = {
    events: Array.isArray(securityAudit.events) ? securityAudit.events : []
  };
  const normalizedOutbox = {
    notifications: Array.isArray(emailOutbox.notifications) ? emailOutbox.notifications : []
  };

  await writeAdminToPostgres(normalizedAdmin);
  await writeJobsDataToPostgres(normalizedJobs);
  await writeRosterToPostgres(normalizedRoster);
  await writeLoginActivityToPostgres(normalizedActivity);
  await writeSecurityAuditToPostgres(normalizedAudit);
  await writeEmailOutboxToPostgres(normalizedOutbox);
  const normalized = await rebuildNormalizedTablesFromPostgres();

  await chmod(path.join(dataDir, "admin.json"), 0o600).catch(() => {});
  await chmod(path.join(dataDir, "jobs.json"), 0o600).catch(() => {});
  await chmod(path.join(dataDir, "roster.json"), 0o600).catch(() => {});
  await chmod(path.join(dataDir, "login-activity.json"), 0o600).catch(() => {});
  await chmod(path.join(dataDir, "security-audit.json"), 0o600).catch(() => {});
  await chmod(path.join(dataDir, "email-outbox.json"), 0o600).catch(() => {});

  console.log("PostgreSQL migration complete.");
  console.log(`Imported ${normalizedAdmin.users.length} users.`);
  console.log(`Imported ${normalizedJobs.quotes.length} quotes.`);
  console.log(`Imported ${normalizedJobs.recurring.length} recurring jobs.`);
  console.log(`Imported ${normalizedRoster.jobs.length} roster jobs.`);
  console.log(`Imported ${normalizedActivity.logins.length} login activity records.`);
  console.log(`Imported ${normalizedAudit.events.length} security audit events.`);
  console.log(`Imported ${normalizedOutbox.notifications.length} email notifications.`);
  console.log(`Built ${normalized?.customers || 0} normalized customers.`);
  console.log(`Built ${normalized?.properties || 0} normalized properties.`);
  console.log(`Built ${normalized?.materials || 0} material rows.`);
  console.log(`Built ${normalized?.messages || 0} customer message rows.`);
  console.log(`Built ${normalized?.locationPings || 0} crew location pings.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
