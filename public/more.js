import { initAccessibleNavigation, logoutAdmin, requireAdminSession, resetAndroidAppSession } from "./auth.js";

const status = document.querySelector("#app-version-status");
const message = document.querySelector("#more-message");
const resetButton = document.querySelector("#reset-android-session");
const logoutButton = document.querySelector("#logout-admin");
const logoutSecondary = document.querySelector("#logout-admin-secondary");

function androidVersion() {
  return document.body.dataset.androidAppVersion || "";
}

function setMessage(text, tone = "info") {
  message.textContent = text;
  message.dataset.tone = tone;
}

async function renderVersionStatus() {
  const installed = androidVersion();
  try {
    const response = await fetch(`/downloads/android-latest.json?t=${Date.now()}`, {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });
    const latest = response.ok ? await response.json() : null;
    const latestVersion = latest?.versionName || "unknown";
    status.textContent = installed
      ? `Installed ${installed} · Latest ${latestVersion}`
      : `Latest Android app ${latestVersion}`;
  } catch {
    status.textContent = installed ? `Installed ${installed}` : "App version unavailable";
  }
}

resetButton.addEventListener("click", async () => {
  resetButton.disabled = true;
  setMessage("Resetting app session...", "info");
  await resetAndroidAppSession();
});

logoutButton.addEventListener("click", logoutAdmin);
logoutSecondary.addEventListener("click", logoutAdmin);

if (await requireAdminSession()) {
  await initAccessibleNavigation();
  await renderVersionStatus();
}
