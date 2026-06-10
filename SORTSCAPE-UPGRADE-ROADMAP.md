# SortScape-Inspired Upgrade Roadmap

Reference reviewed: https://sortscape.com.au/

Goal: make LawnQuote feel more like a complete lawn and garden operations app while keeping MACS branding, data ownership, and the existing quote/schedule/security foundation.

## Phase 1 - Operations Hub

- Replace the landing-style home page with a daily operations dashboard.
- Show live signed-in counts for quotes, roster jobs, approvals, and recurring work.
- Surface today's rostered jobs from the shared server roster.
- Add workflow entry points for Quote, Schedule, Customer History, Route Planning, Time & Materials, Invoice, Admin, and Security.

Status: first implementation deployed.

## Phase 2 - Scheduler Upgrade

- Add drag-style roster movement or faster reschedule controls.
- Add day route view with ordered visits and map links.
- Add rain/staff-change rescheduling helpers.
- Keep completion and approval locked to assigned roster time.

Status: day route view, map links, and roster worklog capture deployed. Drag-style movement and rescheduling helpers still pending.

## Phase 3 - Customer History

- Add a dedicated customer/property view.
- Group quotes, scheduled visits, completed jobs, contact details, notes, photos, and invoices by customer/address.
- Add search by customer, phone, email, suburb, and address.
- Add Owner/Team Leader editing for existing customer contact details.

Status: first dedicated Customer History page deployed with grouped quote/roster/recurring history, search, and editable customer contact details.

## Phase 4 - Communication

- Add customer SMS/email templates for booked visit, visit reminder, quote follow-up, completion, and invoice.
- Add message logs to each customer/job.
- Keep email/SMS provider settings in Owner security/admin controls.
- Add crew "on my way" message action from route/job views.

Status: on-the-way SMS deep links deployed from Scheduler route view and Crew app. On-my-way SMS actions now log to PostgreSQL before opening the device SMS app. Provider-backed SMS sending still pending.

## Phase 5 - Time, Materials, Invoices

- Add field timer and materials-used entry on roster jobs.
- Turn approved jobs into an invoice queue.
- Add invoice PDF/export.
- Later option: Xero/QuickBooks export or integration.
- Add crew-only field app with no visible pricing.
- Add employee time reports by date, crew, and employee with CSV export.

Status: roster job worklog endpoint, time/materials form, crew app, check-in/out, time reports with CSV export, and approved-job invoice queue deployed. PDF/export and accounting integrations still pending.

## Phase 7 - Crew GPS & Routing

- Add explicit opt-in crew location sharing.
- Show last-seen crew location to Owner Admin and Team Leader only.
- Store short-retention GPS pings with clear audit logging.
- Add route optimisation after privacy-safe location handling exists.

Status: privacy-safe first pass deployed. Owner Admin can enable/disable crew GPS capture and set retention. Team Members must explicitly opt in on-device before check-in/out GPS is captured, and can manually share location from the Schedule job panel. Owner Admin and Team Leader can view field location logs in Reports.

## Phase 8 - PostgreSQL Backend

- Move quotes, customers, properties, recurring jobs, roster jobs, worklogs, materials, messages, users, audit logs, and location pings into PostgreSQL.
- Keep the browser as a synced client only, not the business data source.
- Add encrypted PostgreSQL backups and a JSON export safety valve.
- Migrate existing `data/*.json` records into SQL.

Status: live PostgreSQL cutover deployed for quote jobs, recurring jobs, roster jobs, users/security settings, login activity, security audit events, and email notifications. Normalized reporting tables are now deployed for customers, properties, materials, customer messages, and crew location pings. Field SMS logs, crew GPS retention controls, health endpoints, and hardened user-level systemd services are deployed. JSON snapshots remain as a transition backup. Remaining backend work is provider-backed SMS sending and off-device encrypted backup replication.

## Phase 6 - Polish

- Mobile-first field worker view.
- Desktop operations view for Owner Admin and Team Leader.
- Better empty states, filters, and status chips.
- Import/export tools for customer/job data.
