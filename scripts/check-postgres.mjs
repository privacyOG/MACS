import {
  closePostgresPool,
  ensurePostgresSchema,
  postgresStatus,
  readPostgresCounts
} from "../lib/postgres-store.mjs";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL is not configured. Set DATABASE_URL to enable it.");
    return;
  }

  const schemaReady = await ensurePostgresSchema();
  const status = postgresStatus();
  if (!schemaReady) {
    throw new Error(`PostgreSQL is configured but unavailable: ${status.disabledReason || "unknown error"}`);
  }

  const counts = await readPostgresCounts();
  console.log("PostgreSQL is configured and reachable.");
  console.log(`Users: ${counts.users || 0}`);
  console.log(`Quotes: ${counts.quotes || 0}`);
  console.log(`Recurring jobs: ${counts.recurring || 0}`);
  console.log(`Roster jobs: ${counts.roster || 0}`);
  console.log(`Login activity records: ${counts.login_activity || 0}`);
  console.log(`Security audit events: ${counts.security_audit || 0}`);
  console.log(`Email notifications: ${counts.email_notifications || 0}`);
  console.log(`Customers: ${counts.customers || 0}`);
  console.log(`Properties: ${counts.properties || 0}`);
  console.log(`Materials: ${counts.materials || 0}`);
  console.log(`Customer messages: ${counts.customer_messages || 0}`);
  console.log(`Crew location pings: ${counts.crew_location_pings || 0}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
