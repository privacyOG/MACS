# PostgreSQL Migration Plan

Current state:

- The app is not only phone/browser storage anymore for core business data.
- Quotes and recurring jobs are now stored in PostgreSQL and also written to server-side JSON snapshots in `data/jobs.json`.
- Roster jobs are now stored in PostgreSQL and also written to server-side JSON snapshots in `data/roster.json`.
- Users/security settings, audit logs, login activity, and email outbox are now stored in PostgreSQL and also written to server-side JSON snapshots.
- Customers, properties, customer messages, roster materials, and crew location pings now have normalized PostgreSQL reporting tables rebuilt from the live job/message documents.
- Some local browser storage is still used as a migration/cache fallback for older saved quotes.
- PostgreSQL support is live:
  - `pg` is installed.
  - `lib/postgres-store.mjs` contains the first database access layer.
  - `db/schema.sql` contains the first live tables and indexes.
  - `npm run db:migrate` imports the current JSON backend data into PostgreSQL.
  - `npm run db:check` verifies connectivity and record counts.
  - `npm run db:backup` writes a compressed PostgreSQL backup into `data/backups/`.
  - A user systemd timer, `lebgent-lawnquote-db-backup.timer`, runs `npm run db:backup` nightly at 02:15 AEST and keeps the newest 30 database backups by default.
  - The server prefers PostgreSQL when `DATABASE_URL` is configured and keeps writing JSON snapshots as a backup during the transition.
  - The local production database runs as Docker container `lawnquote-postgres` on `127.0.0.1:15432`.
  - Current normalized counts after the latest migration: 3 customers, 3 properties, 41 customer messages, 0 material rows, and 0 crew location pings.

Target state:

- PostgreSQL is the source of truth.
- Browser local storage is used only for temporary UI state, never primary business records.
- All office/admin dashboards and team member Schedule views sync from the same backend database.

## Recommended Tables

```sql
create table app_users (
  id text primary key,
  username text unique not null,
  email text unique not null,
  role text not null check (role in ('owner', 'leader', 'member')),
  approval_status text not null default 'approved',
  password_salt text not null,
  password_hash text not null,
  two_factor_enabled boolean not null default false,
  two_factor_secret text,
  failed_login_count integer not null default 0,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  address text not null,
  suburb text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table quote_jobs (
  id text primary key,
  customer_id uuid references customers(id),
  property_id uuid references properties(id),
  job_type text,
  status text not null default 'pending',
  price numeric(12,2) not null default 0,
  low_price numeric(12,2) not null default 0,
  high_price numeric(12,2) not null default 0,
  minutes integer not null default 0,
  area integer not null default 0,
  edging integer not null default 0,
  form_state jsonb not null default '{}'::jsonb,
  breakdown jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  created_by text references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table recurring_jobs (
  id text primary key,
  quote_id text references quote_jobs(id),
  customer_id uuid references customers(id),
  property_id uuid references properties(id),
  assigned_to text references app_users(id),
  frequency text not null default 'weekly',
  next_run date,
  start_time time,
  finish_time time,
  status text not null default 'active',
  price numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table roster_jobs (
  id text primary key,
  source_type text not null,
  source_id text,
  customer_id uuid references customers(id),
  property_id uuid references properties(id),
  assigned_to text references app_users(id),
  scheduled_date date not null,
  start_time time not null,
  finish_time time not null,
  status text not null default 'assigned',
  price numeric(12,2) not null default 0,
  completed_at timestamptz,
  completed_by text references app_users(id),
  approved_at timestamptz,
  approved_by text references app_users(id),
  actual_start_time time,
  actual_finish_time time,
  actual_minutes integer not null default 0,
  check_in_location jsonb,
  check_out_location jsonb,
  work_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table roster_materials (
  id uuid primary key default gen_random_uuid(),
  roster_job_id text references roster_jobs(id) on delete cascade,
  name text not null,
  quantity numeric(12,2) not null default 0,
  unit text,
  cost numeric(12,2) not null default 0
);

create table customer_messages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  roster_job_id text references roster_jobs(id),
  channel text not null,
  template text not null,
  body text not null,
  status text not null default 'draft',
  sent_by text references app_users(id),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table crew_location_pings (
  id uuid primary key default gen_random_uuid(),
  user_id text references app_users(id),
  roster_job_id text references roster_jobs(id),
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  accuracy_m numeric(10,2),
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table security_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id text references app_users(id),
  action text not null,
  subject jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

## Migration Steps

1. Install PostgreSQL and create a database/user for LawnQuote.
2. Add `DATABASE_URL` to the systemd services.
3. Run `npm run db:check` to confirm connectivity.
4. Run `npm run db:migrate` once to import `data/*.json`.
5. Restart HTTP and HTTPS services.
6. Confirm `/api/auth/status` shows PostgreSQL configured/enabled for Owner Admin/Team Leader users.
7. Keep JSON snapshot writes enabled for a short transition period.
8. Keep normalized customer/property/material/message/location tables refreshing from live PostgreSQL writes.
9. Keep explicit opt-in live crew GPS ping capture and retention controls enabled only by Owner Admin policy.
10. Remove localStorage migration writes for quotes/recurring jobs after a grace period.
11. Add encrypted/off-device backup replication after local nightly database backups have had a short burn-in period.
12. Use `/api/health` for lightweight app health and `/api/health/storage` for authenticated Owner/Team Leader storage checks.

## Setup Commands

Example local PostgreSQL setup:

```bash
sudo -u postgres createuser lawnquote --pwprompt
sudo -u postgres createdb lawnquote --owner=lawnquote
```

Example environment:

```bash
DATABASE_URL=postgres://lawnquote:CHANGE_ME@localhost:5432/lawnquote
```

Check and migrate:

```bash
npm run db:check
npm run db:migrate
npm run db:backup
```

Systemd example:

```ini
Environment=DATABASE_URL=postgres://lawnquote:CHANGE_ME@localhost:5432/lawnquote
```

Use `DATABASE_SSL=1` only when connecting to a hosted PostgreSQL provider that requires SSL.

## Service Hardening

The live deployment uses user-level systemd services:

- `lebgent-lawnquote.service` for HTTP on port `18890`.
- `lebgent-lawnquote-https.service` for HTTPS on port `18443`.
- `lebgent-lawnquote-db-backup.timer` for nightly PostgreSQL backups.

The app services now run `node server.mjs` directly instead of nesting through `npm start`, use `NODE_ENV=production`, and include a stricter service sandbox baseline: private temp, no-new-privileges, restricted SUID/SGID, native syscall architecture, and `UMask=0077`.

## Important Indexes

```sql
create index roster_jobs_scheduled_date_idx on roster_jobs(scheduled_date);
create index roster_jobs_assigned_to_idx on roster_jobs(assigned_to);
create index roster_jobs_status_idx on roster_jobs(status);
create index quote_jobs_status_idx on quote_jobs(status);
create index properties_address_idx on properties using gin (to_tsvector('english', address));
create index customers_search_idx on customers using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email, '')));
```
