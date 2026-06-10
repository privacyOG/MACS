import { authStatus, initAccessibleNavigation, listRosterJobs, requireAdminSession } from "./auth.js";

const stats = document.querySelector("#invoice-stats");
const invoiceList = document.querySelector("#invoice-list");

function money(value) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(value || 0);
}

function dateLabel(value) {
  if (!value) return "No date";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function materialCost(job) {
  return Array.isArray(job.materials) ? job.materials.reduce((sum, item) => sum + Number(item.cost || 0), 0) : 0;
}

function invoiceAmount(job) {
  return Number(job.price || 0) + materialCost(job);
}

function contactLabel(job) {
  return [job.customerPhone || "", job.customerEmail || ""].filter(Boolean).join(" · ") || "No contact saved";
}

function addStat(label, value) {
  const card = document.createElement("article");
  card.className = "dashboard-stat";
  card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  stats.append(card);
}

function invoiceText(job) {
  const lines = [
    "MACS Mowing & Cleaning Services",
    `Invoice draft for ${job.customerName || "Customer"}`,
    `Address: ${job.address || "Not set"}`,
    `Date: ${dateLabel(job.scheduledDate)}`,
    `Job: ${job.title || "Roster job"}`,
    `Quoted/service price: ${money(job.price || 0)}`,
    `Materials: ${money(materialCost(job))}`,
    `Total: ${money(invoiceAmount(job))}`,
    job.actualMinutes ? `Time logged: ${job.actualMinutes} minutes` : "",
    job.workNotes ? `Notes: ${job.workNotes}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function renderInvoices(jobs) {
  const approved = jobs.filter((job) => job.status === "approved");
  const total = approved.reduce((sum, job) => sum + invoiceAmount(job), 0);
  const materials = approved.reduce((sum, job) => sum + materialCost(job), 0);
  stats.replaceChildren();
  addStat("Ready", approved.length);
  addStat("Service total", money(approved.reduce((sum, job) => sum + Number(job.price || 0), 0)));
  addStat("Materials", money(materials));
  addStat("Invoice total", money(total));

  if (!approved.length) {
    invoiceList.innerHTML = `<p class="empty-state">No approved roster jobs are ready for invoice yet.</p>`;
    return;
  }

  invoiceList.replaceChildren(...approved.map((job) => {
    const article = document.createElement("article");
    article.className = "invoice-card";
    const text = invoiceText(job);
    article.innerHTML = `
      <div>
        <strong>${job.customerName || job.address || "Customer"}</strong>
        <span>${dateLabel(job.scheduledDate)} · ${job.address || "No address"} · ${contactLabel(job)}</span>
        <small>Service ${money(job.price || 0)} · Materials ${money(materialCost(job))} · Total ${money(invoiceAmount(job))}</small>
      </div>
      <div class="inline-actions">
        <button class="secondary-button" type="button">Copy invoice draft</button>
        <a class="primary-button" href="customers.html">Customer history</a>
      </div>
    `;
    article.querySelector("button").addEventListener("click", async () => {
      await navigator.clipboard?.writeText(text);
      article.querySelector("button").textContent = "Copied";
    });
    return article;
  }));
}

async function init() {
  if (!await requireAdminSession()) return;
  await initAccessibleNavigation();
  const status = await authStatus();
  if (!["owner", "leader"].includes(status.user?.role)) {
    invoiceList.innerHTML = `<p class="empty-state">Only Owner Admin and Team Leader can view invoice queue.</p>`;
    return;
  }
  const result = await listRosterJobs();
  renderInvoices(result.ok ? result.jobs : []);
}

init();
