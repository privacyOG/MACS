import { authStatus, initAccessibleNavigation, listQuoteJobs, listRecurringJobs, listRosterJobs, requireAdminSession, updateCustomerContact } from "./auth.js";

const searchInput = document.querySelector("#customer-search");
const summary = document.querySelector("#customer-summary");
const customerList = document.querySelector("#customer-list");

let customerRows = [];
let currentUser = null;

function money(value) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value || 0);
}

function dateLabel(value) {
  if (!value) return "No date";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function customerKey(item) {
  return `${String(item.customerName || "Unknown customer").trim().toLowerCase()}|${String(item.address || "No address").trim().toLowerCase()}`;
}

function contactLabel(item) {
  const phone = item.customerPhone || item.phone || item.mobile || "";
  const email = item.customerEmail || item.email || "";
  return [phone, email].filter(Boolean).join(" · ") || "No contact saved";
}

function escapeAttribute(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function statusLabel(status) {
  const labels = {
    pending: "Pending quote",
    accepted: "Accepted",
    assigned: "Assigned",
    completed_pending_approval: "Awaiting approval",
    approved: "Approved",
    rejected: "Rejected",
    active: "Active",
    archived: "Archived"
  };
  return labels[status] || status || "Unknown";
}

function addStat(label, value) {
  const card = document.createElement("article");
  card.className = "dashboard-stat";
  card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  summary.append(card);
}

function groupCustomers(quotes, rosterJobs, recurringJobs) {
  const map = new Map();
  for (const item of [...quotes, ...rosterJobs, ...recurringJobs]) {
    const key = customerKey(item);
    if (!map.has(key)) {
      map.set(key, {
        customerName: item.customerName || "Unknown customer",
        address: item.address || "No address",
        customerPhone: item.customerPhone || item.phone || item.mobile || "",
        customerEmail: item.customerEmail || item.email || "",
        quotes: [],
        rosterJobs: [],
        recurringJobs: []
      });
    }
    const row = map.get(key);
    row.customerPhone ||= item.customerPhone || item.phone || item.mobile || "";
    row.customerEmail ||= item.customerEmail || item.email || "";
    if ("scheduledDate" in item && "sourceType" in item) row.rosterJobs.push(item);
    else if ("frequency" in item) row.recurringJobs.push(item);
    else row.quotes.push(item);
  }
  return [...map.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));
}

function renderSummary(rows) {
  summary.replaceChildren();
  const totalQuotes = rows.reduce((sum, row) => sum + row.quotes.length, 0);
  const totalVisits = rows.reduce((sum, row) => sum + row.rosterJobs.length, 0);
  const approved = rows.reduce((sum, row) => sum + row.rosterJobs.filter((job) => job.status === "approved").length, 0);
  addStat("Customers", rows.length);
  addStat("Quotes", totalQuotes);
  addStat("Roster visits", totalVisits);
  addStat("Approved jobs", approved);
}

function renderCustomers() {
  const query = searchInput.value.trim().toLowerCase();
  const rows = customerRows.filter((row) => [
    row.customerName,
    row.address,
    row.customerPhone,
    row.customerEmail
  ].join(" ").toLowerCase().includes(query));
  renderSummary(rows);
  if (!rows.length) {
    customerList.innerHTML = `<p class="empty-state">No matching customers or properties.</p>`;
    return;
  }
  customerList.replaceChildren(...rows.map((row) => {
    const latestVisit = row.rosterJobs.slice().sort((a, b) => String(b.scheduledDate || "").localeCompare(String(a.scheduledDate || "")))[0];
    const quoteTotal = row.quotes.reduce((sum, quote) => sum + Number(quote.price || 0), 0);
    const article = document.createElement("article");
    article.className = "customer-card";
    article.innerHTML = `
      <div class="customer-card-head">
        <div>
          <strong>${row.customerName}</strong>
          <span>${row.address}</span>
          <small>${contactLabel(row)}</small>
        </div>
        <div class="customer-card-kpis">
          <span>${row.quotes.length} quotes</span>
          <span>${row.rosterJobs.length} visits</span>
          <span>${money(quoteTotal)}</span>
        </div>
      </div>
      <div class="customer-history-grid">
        <div>
          <span>Latest visit</span>
          <strong>${latestVisit ? `${dateLabel(latestVisit.scheduledDate)} · ${statusLabel(latestVisit.status)}` : "No visits yet"}</strong>
        </div>
        <div>
          <span>Recurring</span>
          <strong>${row.recurringJobs.length ? row.recurringJobs.map((job) => job.frequency || "active").join(", ") : "None"}</strong>
        </div>
        <div>
          <span>Next actions</span>
          <strong>${row.rosterJobs.some((job) => job.status === "completed_pending_approval") ? "Approval needed" : "No urgent action"}</strong>
        </div>
      </div>
    `;
    if (["owner", "leader"].includes(currentUser?.role)) {
      const form = document.createElement("form");
      form.className = "customer-edit-form";
      form.innerHTML = `
        <input name="customerName" value="${escapeAttribute(row.customerName)}" placeholder="Customer name" aria-label="Customer name" />
        <input name="customerPhone" value="${escapeAttribute(row.customerPhone)}" placeholder="Phone/mobile" aria-label="Phone/mobile" />
        <input name="customerEmail" value="${escapeAttribute(row.customerEmail)}" type="email" placeholder="Email" aria-label="Email" />
        <input name="address" value="${escapeAttribute(row.address)}" placeholder="Address" aria-label="Address" />
        <button class="secondary-button compact-button" type="submit">Save details</button>
      `;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        const formData = new FormData(form);
        button.disabled = true;
        const result = await updateCustomerContact({
          matchName: row.customerName,
          matchAddress: row.address,
          customerName: formData.get("customerName"),
          customerPhone: formData.get("customerPhone"),
          customerEmail: formData.get("customerEmail"),
          address: formData.get("address")
        });
        button.disabled = false;
        button.textContent = result.ok ? `Saved ${result.updated}` : "Save failed";
        await loadCustomers();
      });
      article.append(form);
    }
    return article;
  }));
}

async function loadCustomers() {
  const [quoteResult, rosterResult, recurringResult] = await Promise.all([listQuoteJobs(), listRosterJobs(), listRecurringJobs()]);
  customerRows = groupCustomers(
    quoteResult.ok ? quoteResult.quotes : [],
    rosterResult.ok ? rosterResult.jobs : [],
    recurringResult.ok ? recurringResult.jobs : []
  );
  renderCustomers();
}

async function init() {
  if (!await requireAdminSession()) return;
  const nav = await initAccessibleNavigation();
  currentUser = nav.user || (await authStatus()).user;
  await loadCustomers();
}

searchInput.addEventListener("input", renderCustomers);
init();
