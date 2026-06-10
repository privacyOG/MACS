import pg from "pg";
import { createHash } from "node:crypto";

const { Pool } = pg;

let pool = null;
let schemaReady = false;
let disabledReason = "";

export function postgresEnabled() {
  return Boolean(process.env.DATABASE_URL && !disabledReason);
}

export function postgresStatus() {
  return {
    configured: Boolean(process.env.DATABASE_URL),
    enabled: postgresEnabled(),
    disabledReason
  };
}

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

function itemId(item) {
  return String(item?.id || item?.createdAt || "");
}

function stableId(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part || "").trim().toLowerCase()).join("|"))
    .digest("hex")
    .slice(0, 32);
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function jsonDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quoteRow(item) {
  return [
    itemId(item),
    item.customerName || null,
    item.customerPhone || item.phone || item.mobile || null,
    item.customerEmail || item.email || null,
    item.address || null,
    item.jobType || null,
    item.status || "pending",
    numberValue(item.price),
    item.assignedTo || null,
    item.createdById || null,
    jsonDate(item.createdAt),
    jsonDate(item.updatedAt || item.statusUpdatedAt),
    item
  ];
}

function recurringRow(item) {
  return [
    itemId(item),
    item.quoteId || null,
    item.customerName || null,
    item.customerPhone || item.phone || item.mobile || null,
    item.customerEmail || item.email || null,
    item.address || null,
    item.assignedTo || null,
    item.frequency || null,
    item.nextRun || null,
    item.startTime || null,
    item.finishTime || null,
    item.status || "active",
    numberValue(item.price),
    item.createdById || null,
    jsonDate(item.createdAt),
    jsonDate(item.updatedAt || item.statusUpdatedAt),
    item
  ];
}

function rosterRow(item) {
  return [
    itemId(item),
    item.sourceType || null,
    item.sourceId || null,
    item.customerName || null,
    item.customerPhone || item.phone || item.mobile || null,
    item.customerEmail || item.email || null,
    item.address || null,
    item.assignedTo || null,
    item.assignedUsername || null,
    item.scheduledDate || null,
    item.startTime || null,
    item.finishTime || null,
    item.status || "assigned",
    numberValue(item.price),
    item.completedById || null,
    jsonDate(item.completedAt),
    item.approvedById || null,
    jsonDate(item.approvedAt),
    numberValue(item.actualMinutes),
    item.checkInLocation || null,
    item.checkOutLocation || null,
    jsonDate(item.createdAt),
    jsonDate(item.updatedAt || item.worklogUpdatedAt),
    item
  ];
}

function adminUserRow(item) {
  return [
    itemId(item),
    item.username || null,
    item.email || null,
    item.role || null,
    item.approvalStatus || "approved",
    jsonDate(item.lockedAt),
    jsonDate(item.createdAt),
    jsonDate(item.updatedAt),
    item
  ];
}

function loginRow(item) {
  return [
    itemId(item),
    item.sessionId || null,
    item.userId || null,
    item.username || null,
    item.role || null,
    jsonDate(item.loginAt),
    jsonDate(item.logoutAt),
    jsonDate(item.lastSeenAt),
    item.ip || null,
    item.location || null,
    item
  ];
}

function auditRow(item) {
  return [
    itemId(item),
    item.action || null,
    item.actor?.id || null,
    item.actor?.username || null,
    jsonDate(item.createdAt),
    item
  ];
}

function notificationRow(item) {
  return [
    itemId(item),
    item.type || item.template || item.subject || null,
    item.status || "queued",
    item.to || item.email || null,
    jsonDate(item.createdAt || item.sentAt),
    item
  ];
}

function customerFields(item = {}) {
  return {
    name: String(item.customerName || item.name || "").trim(),
    phone: String(item.customerPhone || item.phone || item.mobile || "").trim(),
    email: String(item.customerEmail || item.email || "").trim(),
    address: String(item.address || "").trim()
  };
}

function customerIdFor(item = {}) {
  const fields = customerFields(item);
  return stableId("customer", fields.name, fields.phone, fields.email, fields.address);
}

function propertyIdFor(item = {}) {
  const fields = customerFields(item);
  return stableId("property", customerIdFor(item), fields.address);
}

function hasCustomerSignal(item = {}) {
  const fields = customerFields(item);
  return Boolean(fields.name || fields.phone || fields.email || fields.address);
}

function locationParts(location = {}) {
  if (!location || typeof location !== "object") return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const accuracy = Number(location.accuracy ?? location.accuracy_m ?? location.accuracyM ?? 0);
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    capturedAt: jsonDate(location.capturedAt || location.timestamp || location.createdAt) || new Date().toISOString()
  };
}

function collectCustomerData({ quotes = [], recurring = [], roster = [] } = {}) {
  const customers = new Map();
  const properties = new Map();
  for (const item of [...quotes, ...recurring, ...roster]) {
    if (!hasCustomerSignal(item)) continue;
    const fields = customerFields(item);
    const customerId = customerIdFor(item);
    const propertyId = propertyIdFor(item);
    const existing = customers.get(customerId) || {
      id: customerId,
      name: fields.name,
      phone: "",
      email: "",
      addresses: new Set(),
      sourceIds: new Set()
    };
    existing.name ||= fields.name;
    existing.phone ||= fields.phone;
    existing.email ||= fields.email;
    if (fields.address) existing.addresses.add(fields.address);
    if (itemId(item)) existing.sourceIds.add(itemId(item));
    customers.set(customerId, existing);
    if (fields.address) {
      properties.set(propertyId, {
        id: propertyId,
        customerId,
        address: fields.address,
        document: {
          id: propertyId,
          customerId,
          customerName: fields.name,
          customerPhone: fields.phone,
          customerEmail: fields.email,
          address: fields.address
        }
      });
    }
  }
  return {
    customers: [...customers.values()].map((item) => ({
      id: item.id,
      name: item.name,
      phone: item.phone,
      email: item.email,
      document: {
        id: item.id,
        name: item.name,
        phone: item.phone,
        email: item.email,
        addresses: [...item.addresses],
        sourceIds: [...item.sourceIds]
      }
    })),
    properties: [...properties.values()]
  };
}

function collectMaterials(roster = []) {
  const rows = [];
  for (const job of roster) {
    const rosterJobId = itemId(job);
    const materials = Array.isArray(job.materials) ? job.materials : [];
    materials.forEach((material, index) => {
      const name = String(material?.name || "").trim();
      if (!rosterJobId || !name) return;
      const id = stableId("material", rosterJobId, index, name, material.quantity, material.unit, material.cost);
      rows.push({
        id,
        rosterJobId,
        name,
        quantity: numberValue(material.quantity),
        unit: String(material.unit || "").trim(),
        cost: numberValue(material.cost),
        document: { ...material, id, rosterJobId }
      });
    });
  }
  return rows;
}

function collectLocationPings(roster = []) {
  const rows = [];
  for (const job of roster) {
    const rosterJobId = itemId(job);
    for (const kind of ["checkIn", "checkOut"]) {
      const location = kind === "checkIn" ? job.checkInLocation : job.checkOutLocation;
      const parts = locationParts(location);
      if (!rosterJobId || !parts) continue;
      rows.push({
        id: stableId("location", rosterJobId, kind, parts.latitude, parts.longitude, parts.capturedAt),
        userId: kind === "checkIn" ? job.worklogUpdatedById || job.completedById || job.assignedTo : job.worklogUpdatedById || job.completedById || job.assignedTo,
        username: kind === "checkIn" ? job.worklogUpdatedBy || job.completedBy || job.assignedUsername : job.worklogUpdatedBy || job.completedBy || job.assignedUsername,
        rosterJobId,
        kind,
        ...parts,
        document: { ...location, rosterJobId, kind }
      });
    }
  }
  return rows;
}

function collectMessages(outbox = [], customerData = { customers: [], properties: [] }) {
  const customers = customerData.customers || [];
  const properties = customerData.properties || [];
  return outbox.map((item) => {
    const body = String(item.body || "");
    const subject = String(item.subject || "");
    const matchingProperty = properties.find((property) => property.address && body.includes(property.address));
    const matchingCustomer = matchingProperty
      ? customers.find((customer) => customer.id === matchingProperty.customerId)
      : customers.find((customer) => customer.name && (body.includes(customer.name) || subject.includes(customer.name)));
    return {
      id: itemId(item) || stableId("message", item.to, item.subject, item.createdAt),
      customerId: matchingCustomer?.id || matchingProperty?.customerId || null,
      propertyId: matchingProperty?.id || null,
      rosterJobId: null,
      channel: String(item.channel || "email"),
      recipient: item.to || item.email || null,
      subject: item.subject || null,
      status: item.status || "queued",
      sentAt: jsonDate(item.sentAt),
      createdAt: jsonDate(item.createdAt || item.sentAt),
      document: item
    };
  }).filter((item) => item.id);
}

async function refreshNormalizedTables(db) {
  const [quotes, recurring, roster, outbox] = await Promise.all([
    db.query("select document from quote_jobs"),
    db.query("select document from recurring_jobs"),
    db.query("select document from roster_jobs"),
    db.query("select document from email_notifications")
  ]);
  const snapshots = {
    quotes: quotes.rows.map((row) => row.document),
    recurring: recurring.rows.map((row) => row.document),
    roster: roster.rows.map((row) => row.document),
    outbox: outbox.rows.map((row) => row.document)
  };
  const customerData = collectCustomerData(snapshots);
  const materials = collectMaterials(snapshots.roster);
  const locations = collectLocationPings(snapshots.roster);
  const messages = collectMessages(snapshots.outbox, customerData);
  const liveLocations = await db.query("select * from crew_location_pings where kind = 'live'");
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("delete from crew_location_pings");
    await client.query("delete from customer_messages");
    await client.query("delete from roster_materials");
    await client.query("delete from properties");
    await client.query("delete from customers");
    for (const item of customerData.customers) {
      await client.query(`
        insert into customers (id, name, phone, email, updated_at, document)
        values ($1,$2,$3,$4,now(),$5)
      `, [item.id, item.name || null, item.phone || null, item.email || null, item.document]);
    }
    for (const item of customerData.properties) {
      await client.query(`
        insert into properties (id, customer_id, address, updated_at, document)
        values ($1,$2,$3,now(),$4)
      `, [item.id, item.customerId, item.address || null, item.document]);
    }
    for (const item of materials) {
      await client.query(`
        insert into roster_materials (id, roster_job_id, name, quantity, unit, cost, document)
        values ($1,$2,$3,$4,$5,$6,$7)
      `, [item.id, item.rosterJobId, item.name, item.quantity, item.unit || null, item.cost, item.document]);
    }
    for (const item of messages) {
      await client.query(`
        insert into customer_messages (
          id, customer_id, property_id, roster_job_id, channel, recipient,
          subject, status, sent_at, created_at, document
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [item.id, item.customerId, item.propertyId, item.rosterJobId, item.channel, item.recipient, item.subject, item.status, item.sentAt, item.createdAt, item.document]);
    }
    for (const item of [
      ...locations,
      ...liveLocations.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        rosterJobId: row.roster_job_id,
        kind: row.kind,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracy: row.accuracy_m,
        capturedAt: jsonDate(row.captured_at),
        document: row.document
      }))
    ]) {
      await client.query(`
        insert into crew_location_pings (
          id, user_id, username, roster_job_id, kind, latitude, longitude,
          accuracy_m, captured_at, document
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (id) do nothing
      `, [item.id, item.userId || null, item.username || null, item.rosterJobId, item.kind, item.latitude, item.longitude, item.accuracy, item.capturedAt, item.document]);
    }
    await client.query("commit");
    return {
      customers: customerData.customers.length,
      properties: customerData.properties.length,
      materials: materials.length,
      messages: messages.length,
      locationPings: locations.length
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function refreshNormalizedTablesQuietly(db) {
  try {
    await refreshNormalizedTables(db);
  } catch (error) {
    console.warn(`PostgreSQL normalized table refresh unavailable: ${error.message}`);
  }
}

export async function ensurePostgresSchema() {
  const db = getPool();
  if (!db || schemaReady) return postgresEnabled();
  try {
    await db.query(`
      create table if not exists quote_jobs (
        id text primary key,
        customer_name text,
        customer_phone text,
        customer_email text,
        address text,
        job_type text,
        status text not null default 'pending',
        price numeric(12,2) not null default 0,
        assigned_to text,
        created_by_id text,
        created_at timestamptz,
        updated_at timestamptz,
        document jsonb not null
      );

      create table if not exists recurring_jobs (
        id text primary key,
        quote_id text,
        customer_name text,
        customer_phone text,
        customer_email text,
        address text,
        assigned_to text,
        frequency text,
        next_run date,
        start_time time,
        finish_time time,
        status text not null default 'active',
        price numeric(12,2) not null default 0,
        created_by_id text,
        created_at timestamptz,
        updated_at timestamptz,
        document jsonb not null
      );

      create table if not exists roster_jobs (
        id text primary key,
        source_type text,
        source_id text,
        customer_name text,
        customer_phone text,
        customer_email text,
        address text,
        assigned_to text,
        assigned_username text,
        scheduled_date date,
        start_time time,
        finish_time time,
        status text not null default 'assigned',
        price numeric(12,2) not null default 0,
        completed_by_id text,
        completed_at timestamptz,
        approved_by_id text,
        approved_at timestamptz,
        actual_minutes integer not null default 0,
        check_in_location jsonb,
        check_out_location jsonb,
        created_at timestamptz,
        updated_at timestamptz,
        document jsonb not null
      );

      create table if not exists app_state (
        key text primary key,
        updated_at timestamptz not null default now(),
        document jsonb not null
      );

      create table if not exists app_users (
        id text primary key,
        username text,
        email text,
        role text,
        approval_status text not null default 'approved',
        locked_at timestamptz,
        created_at timestamptz,
        updated_at timestamptz,
        document jsonb not null
      );

      create table if not exists login_activity (
        id text primary key,
        session_id text,
        user_id text,
        username text,
        role text,
        login_at timestamptz,
        logout_at timestamptz,
        last_seen_at timestamptz,
        ip text,
        location jsonb,
        document jsonb not null
      );

      create table if not exists security_audit_events (
        id text primary key,
        action text,
        actor_id text,
        actor_username text,
        created_at timestamptz,
        document jsonb not null
      );

      create table if not exists email_notifications (
        id text primary key,
        type text,
        status text not null default 'queued',
        recipient text,
        created_at timestamptz,
        document jsonb not null
      );

      create table if not exists customers (
        id text primary key,
        name text,
        phone text,
        email text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        document jsonb not null
      );

      create table if not exists properties (
        id text primary key,
        customer_id text references customers(id) on delete cascade,
        address text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        document jsonb not null
      );

      create table if not exists roster_materials (
        id text primary key,
        roster_job_id text,
        name text,
        quantity numeric(12,2) not null default 0,
        unit text,
        cost numeric(12,2) not null default 0,
        created_at timestamptz not null default now(),
        document jsonb not null
      );

      create table if not exists customer_messages (
        id text primary key,
        customer_id text,
        property_id text,
        roster_job_id text,
        channel text not null default 'email',
        recipient text,
        subject text,
        status text not null default 'queued',
        sent_at timestamptz,
        created_at timestamptz,
        document jsonb not null
      );

      create table if not exists crew_location_pings (
        id text primary key,
        user_id text,
        username text,
        roster_job_id text,
        kind text,
        latitude numeric(10,7) not null,
        longitude numeric(10,7) not null,
        accuracy_m numeric(10,2),
        captured_at timestamptz not null,
        created_at timestamptz not null default now(),
        document jsonb not null
      );

      create index if not exists quote_jobs_status_idx on quote_jobs(status);
      create index if not exists quote_jobs_customer_idx on quote_jobs(customer_name, address);
      create index if not exists quote_jobs_assigned_to_idx on quote_jobs(assigned_to);
      create index if not exists recurring_jobs_next_run_idx on recurring_jobs(next_run);
      create index if not exists recurring_jobs_assigned_to_idx on recurring_jobs(assigned_to);
      create index if not exists roster_jobs_scheduled_date_idx on roster_jobs(scheduled_date);
      create index if not exists roster_jobs_assigned_to_idx on roster_jobs(assigned_to);
      create index if not exists roster_jobs_status_idx on roster_jobs(status);
      create index if not exists roster_jobs_customer_idx on roster_jobs(customer_name, address);
      create index if not exists app_users_role_idx on app_users(role);
      create index if not exists app_users_username_idx on app_users(username);
      create index if not exists login_activity_user_id_idx on login_activity(user_id);
      create index if not exists login_activity_login_at_idx on login_activity(login_at);
      create index if not exists security_audit_action_idx on security_audit_events(action);
      create index if not exists security_audit_created_at_idx on security_audit_events(created_at);
      create index if not exists email_notifications_status_idx on email_notifications(status);
      create index if not exists customers_name_idx on customers(name);
      create index if not exists customers_phone_idx on customers(phone);
      create index if not exists customers_email_idx on customers(email);
      create index if not exists properties_customer_id_idx on properties(customer_id);
      create index if not exists properties_address_idx on properties(address);
      create index if not exists roster_materials_job_idx on roster_materials(roster_job_id);
      create index if not exists customer_messages_customer_idx on customer_messages(customer_id);
      create index if not exists customer_messages_status_idx on customer_messages(status);
      create index if not exists crew_location_user_idx on crew_location_pings(user_id);
      create index if not exists crew_location_job_idx on crew_location_pings(roster_job_id);
      create index if not exists crew_location_captured_idx on crew_location_pings(captured_at);
    `);
    schemaReady = true;
    disabledReason = "";
    return true;
  } catch (error) {
    disabledReason = error.message || "PostgreSQL unavailable";
    return false;
  }
}

async function withPostgres(callback) {
  if (!await ensurePostgresSchema()) return null;
  return callback(getPool());
}

export async function readJobsDataFromPostgres() {
  return withPostgres(async (db) => {
    const [quotes, recurring] = await Promise.all([
      db.query("select document from quote_jobs order by coalesce(updated_at, created_at) desc nulls last"),
      db.query("select document from recurring_jobs order by coalesce(updated_at, created_at) desc nulls last")
    ]);
    return {
      quotes: quotes.rows.map((row) => row.document),
      recurring: recurring.rows.map((row) => row.document)
    };
  });
}

export async function writeJobsDataToPostgres(data = {}) {
  return withPostgres(async (db) => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("delete from quote_jobs");
      await client.query("delete from recurring_jobs");
      for (const item of Array.isArray(data.quotes) ? data.quotes : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into quote_jobs (
            id, customer_name, customer_phone, customer_email, address, job_type, status,
            price, assigned_to, created_by_id, created_at, updated_at, document
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, quoteRow(item));
      }
      for (const item of Array.isArray(data.recurring) ? data.recurring : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into recurring_jobs (
            id, quote_id, customer_name, customer_phone, customer_email, address, assigned_to,
            frequency, next_run, start_time, finish_time, status, price, created_by_id,
            created_at, updated_at, document
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `, recurringRow(item));
      }
      await client.query("commit");
      await refreshNormalizedTablesQuietly(db);
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function readRosterFromPostgres() {
  return withPostgres(async (db) => {
    const result = await db.query("select document from roster_jobs order by scheduled_date asc nulls last, start_time asc nulls last");
    return { jobs: result.rows.map((row) => row.document) };
  });
}

export async function writeRosterToPostgres(roster = {}) {
  return withPostgres(async (db) => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("delete from roster_jobs");
      for (const item of Array.isArray(roster.jobs) ? roster.jobs : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into roster_jobs (
            id, source_type, source_id, customer_name, customer_phone, customer_email, address,
            assigned_to, assigned_username, scheduled_date, start_time, finish_time, status, price,
            completed_by_id, completed_at, approved_by_id, approved_at, actual_minutes,
            check_in_location, check_out_location, created_at, updated_at, document
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        `, rosterRow(item));
      }
      await client.query("commit");
      await refreshNormalizedTablesQuietly(db);
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function readAdminFromPostgres() {
  return withPostgres(async (db) => {
    const result = await db.query("select document from app_state where key = 'admin'");
    return result.rows[0]?.document || null;
  });
}

export async function writeAdminToPostgres(admin = {}) {
  return withPostgres(async (db) => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(`
        insert into app_state (key, updated_at, document)
        values ('admin', now(), $1)
        on conflict (key) do update set updated_at = now(), document = excluded.document
      `, [admin]);
      await client.query("delete from app_users");
      for (const item of Array.isArray(admin.users) ? admin.users : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into app_users (
            id, username, email, role, approval_status, locked_at, created_at, updated_at, document
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, adminUserRow(item));
      }
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function readLoginActivityFromPostgres() {
  return withPostgres(async (db) => {
    const result = await db.query("select document from login_activity order by login_at desc nulls last, last_seen_at desc nulls last limit 500");
    return { logins: result.rows.map((row) => row.document) };
  });
}

export async function writeLoginActivityToPostgres(activity = {}) {
  return withPostgres(async (db) => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("delete from login_activity");
      for (const item of Array.isArray(activity.logins) ? activity.logins.slice(0, 500) : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into login_activity (
            id, session_id, user_id, username, role, login_at, logout_at,
            last_seen_at, ip, location, document
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, loginRow(item));
      }
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function readSecurityAuditFromPostgres() {
  return withPostgres(async (db) => {
    const result = await db.query("select document from security_audit_events order by created_at desc nulls last limit 500");
    return { events: result.rows.map((row) => row.document) };
  });
}

export async function writeSecurityAuditToPostgres(audit = {}) {
  return withPostgres(async (db) => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("delete from security_audit_events");
      for (const item of Array.isArray(audit.events) ? audit.events.slice(0, 500) : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into security_audit_events (
            id, action, actor_id, actor_username, created_at, document
          ) values ($1,$2,$3,$4,$5,$6)
        `, auditRow(item));
      }
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function readEmailOutboxFromPostgres() {
  return withPostgres(async (db) => {
    const result = await db.query("select document from email_notifications order by created_at desc nulls last limit 200");
    return { notifications: result.rows.map((row) => row.document) };
  });
}

export async function readPostgresCounts() {
  return withPostgres(async (db) => {
    const result = await db.query(`
      select
        (select count(*)::int from app_users) as users,
        (select count(*)::int from quote_jobs) as quotes,
        (select count(*)::int from recurring_jobs) as recurring,
        (select count(*)::int from roster_jobs) as roster,
        (select count(*)::int from login_activity) as login_activity,
        (select count(*)::int from security_audit_events) as security_audit,
        (select count(*)::int from email_notifications) as email_notifications,
        (select count(*)::int from customers) as customers,
        (select count(*)::int from properties) as properties,
        (select count(*)::int from roster_materials) as materials,
        (select count(*)::int from customer_messages) as customer_messages,
        (select count(*)::int from crew_location_pings) as crew_location_pings
    `);
    return result.rows[0] || {};
  });
}

export async function rebuildNormalizedTablesFromPostgres() {
  return withPostgres(async (db) => refreshNormalizedTables(db));
}

export async function appendCustomerMessageLogToPostgres(message = {}) {
  return withPostgres(async (db) => {
    const id = itemId(message) || stableId("customer-message", message.rosterJobId, message.channel, message.recipient, message.createdAt);
    const document = { ...message, id };
    await db.query(`
      insert into email_notifications (id, type, status, recipient, created_at, document)
      values ($1,$2,$3,$4,$5,$6)
      on conflict (id) do update set
        type = excluded.type,
        status = excluded.status,
        recipient = excluded.recipient,
        created_at = excluded.created_at,
        document = excluded.document
    `, [
      id,
      message.type || message.template || "customer_message",
      message.status || "logged",
      message.recipient || message.to || null,
      jsonDate(message.createdAt) || new Date().toISOString(),
      document
    ]);
    await refreshNormalizedTablesQuietly(db);
    return document;
  });
}

export async function appendCrewLocationPingToPostgres(ping = {}) {
  return withPostgres(async (db) => {
    const parts = locationParts(ping);
    if (!parts) throw new Error("Valid latitude and longitude are required.");
    const id = itemId(ping) || stableId("live-location", ping.userId, ping.rosterJobId, parts.latitude, parts.longitude, parts.capturedAt);
    const document = { ...ping, id, ...parts };
    await db.query(`
      insert into crew_location_pings (
        id, user_id, username, roster_job_id, kind, latitude, longitude,
        accuracy_m, captured_at, document
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (id) do update set
        user_id = excluded.user_id,
        username = excluded.username,
        roster_job_id = excluded.roster_job_id,
        kind = excluded.kind,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        accuracy_m = excluded.accuracy_m,
        captured_at = excluded.captured_at,
        document = excluded.document
    `, [
      id,
      ping.userId || null,
      ping.username || null,
      ping.rosterJobId || null,
      ping.kind || "live",
      parts.latitude,
      parts.longitude,
      parts.accuracy,
      parts.capturedAt,
      document
    ]);
    return document;
  });
}

export async function pruneCrewLocationPings(days = 14) {
  return withPostgres(async (db) => {
    const retentionDays = Math.max(1, Math.min(90, Number(days || 14)));
    const result = await db.query("delete from crew_location_pings where captured_at < now() - ($1::int * interval '1 day')", [retentionDays]);
    return result.rowCount || 0;
  });
}

export async function readFieldOperationsFromPostgres(limit = 100) {
  return withPostgres(async (db) => {
    const max = Math.max(1, Math.min(500, Number(limit || 100)));
    const [messages, locations] = await Promise.all([
      db.query(`
        select id, customer_id, property_id, roster_job_id, channel, recipient,
          subject, status, sent_at, created_at, document
        from customer_messages
        order by coalesce(created_at, sent_at) desc nulls last
        limit $1
      `, [max]),
      db.query(`
        select id, user_id, username, roster_job_id, kind, latitude, longitude,
          accuracy_m, captured_at, document
        from crew_location_pings
        order by captured_at desc
        limit $1
      `, [max])
    ]);
    return {
      messages: messages.rows.map((row) => ({
        id: row.id,
        customerId: row.customer_id,
        propertyId: row.property_id,
        rosterJobId: row.roster_job_id,
        channel: row.channel,
        recipient: row.recipient,
        subject: row.subject,
        status: row.status,
        sentAt: row.sent_at,
        createdAt: row.created_at,
        document: row.document
      })),
      locations: locations.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        rosterJobId: row.roster_job_id,
        kind: row.kind,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracy: row.accuracy_m === null ? null : Number(row.accuracy_m),
        capturedAt: row.captured_at,
        document: row.document
      }))
    };
  });
}

export async function writeEmailOutboxToPostgres(outbox = {}) {
  return withPostgres(async (db) => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("delete from email_notifications");
      for (const item of Array.isArray(outbox.notifications) ? outbox.notifications.slice(0, 200) : []) {
        if (!itemId(item)) continue;
        await client.query(`
          insert into email_notifications (
            id, type, status, recipient, created_at, document
          ) values ($1,$2,$3,$4,$5,$6)
        `, notificationRow(item));
      }
      await client.query("commit");
      await refreshNormalizedTablesQuietly(db);
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function closePostgresPool() {
  if (pool) await pool.end();
  pool = null;
  schemaReady = false;
}
