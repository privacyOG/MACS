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
