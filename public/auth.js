async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json();
  return response.ok ? result : { ok: false, message: result.message || "Request failed." };
}

let inactivityTimer = null;
let inactivityBound = false;
let inactivityMinutes = 30;
let androidUpdateCheckStarted = false;

function isAndroidApp() {
  return navigator.userAgent.includes("MACS-LawnQuote-Android");
}

async function clearClientSessionState() {
  try {
    for (const key of Object.keys(sessionStorage)) sessionStorage.removeItem(key);
  } catch {
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("macs-lawnquote-")).map((key) => caches.delete(key)));
    }
  } catch {
  }
}

export function startInactivityLogout(minutes = 30) {
  inactivityMinutes = Math.max(5, Math.min(240, Number(minutes || 30)));
  function resetTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(async () => {
      await api("/api/auth/logout", {});
      location.href = "admin.html?timeout=1";
    }, inactivityMinutes * 60 * 1000);
  }
  if (!inactivityBound) {
    for (const event of ["click", "keydown", "touchstart", "input", "change"]) {
      window.addEventListener(event, resetTimer, { passive: true });
    }
    inactivityBound = true;
  }
  resetTimer();
}

function browserContext() {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    locale: navigator.language || ""
  };
}

export async function authStatus() {
  return api("/api/auth/status");
}

export async function hasAdminAccount() {
  return Boolean((await authStatus()).configured);
}

export async function isAdminLoggedIn() {
  return Boolean((await authStatus()).loggedIn);
}

export async function requireAdminSession() {
  if (await isAdminLoggedIn()) return true;
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  location.replace(`admin.html?next=${next}`);
  return false;
}

export async function logoutAdmin() {
  clearTimeout(inactivityTimer);
  try {
    await api("/api/auth/logout", {});
  } finally {
    await clearClientSessionState();
    if (isAndroidApp()) {
      if (window.MacsAndroid?.logoutToLogin) {
        window.MacsAndroid.logoutToLogin();
        return;
      }
      location.replace(`admin.html?logout=1&t=${Date.now()}`);
    } else {
      location.replace("admin.html");
    }
  }
}

export async function resetAndroidAppSession() {
  clearTimeout(inactivityTimer);
  try {
    await api("/api/auth/logout", {});
  } finally {
    await clearClientSessionState();
    if (window.MacsAndroid?.resetAppData) {
      window.MacsAndroid.resetAppData();
      return;
    }
    if (window.MacsAndroid?.logoutToLogin) {
      window.MacsAndroid.logoutToLogin();
      return;
    }
    localStorage.clear();
    sessionStorage.clear();
    location.replace(`admin.html?logout=1&reset=1&t=${Date.now()}`);
  }
}

export async function setupAdmin(password, twoFactorCode = "") {
  const result = await api("/api/auth/setup", { password, twoFactorCode });
  if (!result.ok && result.message) throw new Error(result.message);
  return result.recoveryCode;
}

export async function createOwnerAccount({ username, email, password }) {
  const result = await api("/api/auth/setup", { username, email, password });
  if (!result.ok && result.message) throw new Error(result.message);
  return result;
}

export async function loginAdmin(identifier, password, twoFactorCode = "") {
  return api("/api/auth/login", { identifier, password, twoFactorCode, ...browserContext() });
}

export async function updateSessionLocation(location = {}) {
  const coords = location?.coords || {};
  return api("/api/auth/session-location", {
    ...browserContext(),
    source: location.source || (location.coords ? "browser-gps" : "browser"),
    status: location.status || (location.coords ? "granted" : "unknown"),
    permissionState: location.permissionState || "",
    latitude: coords.latitude ?? location.latitude,
    longitude: coords.longitude ?? location.longitude,
    accuracy: coords.accuracy ?? location.accuracy,
    altitude: coords.altitude ?? location.altitude,
    altitudeAccuracy: coords.altitudeAccuracy ?? location.altitudeAccuracy,
    heading: coords.heading ?? location.heading,
    speed: coords.speed ?? location.speed,
    capturedAt: location.timestamp ? new Date(location.timestamp).toISOString() : location.capturedAt,
    errorCode: location.errorCode,
    errorMessage: location.errorMessage
  });
}

export async function recordCurrentLocation({ force = false } = {}) {
  if (!("geolocation" in navigator)) {
    return updateSessionLocation({ source: "browser", status: "unavailable", errorMessage: "Browser geolocation is unavailable." });
  }
  let permissionState = "unknown";
  try {
    if (navigator.permissions?.query) {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      permissionState = permission.state;
    }
    if (!force && permissionState !== "granted") {
      return updateSessionLocation({ source: "browser", status: permissionState || "not_granted", permissionState });
    }
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      });
    });
    return updateSessionLocation({ ...position, source: "browser-gps", status: "granted", permissionState });
  } catch (error) {
    return updateSessionLocation({
      source: "browser-gps",
      status: error?.code === 1 ? "denied" : "error",
      permissionState,
      errorCode: error?.code,
      errorMessage: error?.message || "Browser location request failed."
    });
  }
}

export async function listLoginActivity() {
  return api("/api/login-activity");
}

export async function listSecurityAudit() {
  return api("/api/security/audit");
}

export async function updateSessionTimeout(minutes) {
  return api("/api/security/session-timeout", { minutes });
}

export async function updateFieldSettings(payload) {
  return api("/api/security/field-settings", payload);
}

export async function sendTestSecurityEmail() {
  return api("/api/security/test-email", {});
}

export async function createEncryptedBackup() {
  return api("/api/security/backup", {});
}

export async function changePassword(currentPassword, nextPassword) {
  return api("/api/auth/change-password", { currentPassword, nextPassword });
}

export async function recoverPassword(identifier, recoveryCode, nextPassword) {
  return api("/api/auth/recover", { identifier, recoveryCode, nextPassword });
}

export async function getTwoFactorSetup() {
  return api("/api/auth/2fa/setup");
}

export async function updateTwoFactor(enabled, twoFactorCode = "", secret = "") {
  return api("/api/auth/2fa", { enabled, twoFactorCode, secret });
}

export async function listTeamMembers() {
  return api("/api/team");
}

export async function createTeamMember(payload) {
  return api("/api/team", payload);
}

export async function updateTeamMember(id, role) {
  return api("/api/team/update", { id, role });
}

export async function updateTeamProfile(payload) {
  return api("/api/team/profile", payload);
}

export async function getProfile() {
  return api("/api/profile");
}

export async function updateProfileContact(payload) {
  return api("/api/profile/contact", payload);
}

export async function updateProfileCredentials(credentials) {
  return api("/api/profile/credentials", { credentials });
}

export async function approveTeamMember(id) {
  return api("/api/team/approve", { id });
}

export async function unlockTeamMember(id) {
  return api("/api/team/unlock", { id });
}

export async function deleteTeamMember(id) {
  return api("/api/team/delete", { id });
}

export async function listRosterJobs() {
  return api("/api/roster/jobs");
}

export async function saveRosterJob(job) {
  return api("/api/roster/jobs", job);
}

export async function deleteRosterJob(payload) {
  return api("/api/roster/jobs/delete", payload);
}

export async function completeRosterJob(id, payload = {}) {
  return api("/api/roster/jobs/complete", { id, ...payload });
}

export async function approveRosterJob(id) {
  return api("/api/roster/jobs/approve", { id });
}

export async function saveRosterWorklog(payload) {
  return api("/api/roster/jobs/worklog", payload);
}

export async function logCustomerMessage(payload) {
  return api("/api/customer-messages/log", payload);
}

export async function sendCrewLocationPing(payload) {
  return api("/api/field/location", payload);
}

export async function listFieldOperations() {
  return api("/api/operations/field-logs");
}

export async function updateCustomerContact(payload) {
  return api("/api/customers/contact", payload);
}

export async function listQuoteJobs() {
  return api("/api/jobs/quotes");
}

export async function saveQuoteJobs(payload) {
  return api("/api/jobs/quotes", payload);
}

export async function deleteQuoteJobs(payload) {
  return api("/api/jobs/quotes/delete", payload);
}

export async function listRecurringJobs() {
  return api("/api/jobs/recurring");
}

export async function saveRecurringJobs(payload) {
  return api("/api/jobs/recurring", payload);
}

export async function deleteRecurringJobs(payload) {
  return api("/api/jobs/recurring/delete", payload);
}

export async function adminSecurityStatus() {
  const admin = await authStatus();
  return {
    configured: Boolean(admin.configured),
    twoFactorEnabled: Boolean(admin.twoFactorEnabled),
    updatedAt: admin.updatedAt || null,
    user: admin.user || null,
    security: admin.security || { sessionTimeoutMinutes: 30, maxSessionTimeoutMinutes: 240 },
    roles: admin.roles || {}
  };
}

export function canAccessPage(user, page) {
  if (isAndroidApp()) {
    if (!user) return ["admin", "downloads"].includes(page);
    return ["schedule", "crew", "profile", "more", "downloads"].includes(page);
  }
  if (page === "home") return true;
  if (page === "downloads") return true;
  if (page === "more") return true;
  if (!user) return ["admin", "schedule", "quote"].includes(page);
  if (page === "profile") return true;
  if (page === "admin") return user.role === "owner" || user.role === "leader";
  if (page === "security") return user.role === "owner";
  if (page === "schedule") return ["owner", "leader", "member"].includes(user.role);
  if (page === "quote") return user.role === "owner" || user.role === "leader";
  if (page === "customers") return user.role === "owner" || user.role === "leader";
  if (page === "crew") return user.role === "owner" || user.role === "leader";
  if (page === "reports") return user.role === "owner" || user.role === "leader";
  if (page === "invoices") return user.role === "owner" || user.role === "leader";
  return true;
}

const navItems = [
  { page: "home", href: "index.html", icon: "⌂", label: "Home" },
  { page: "quote", href: "quote.html", icon: "+", label: "Quote" },
  { page: "schedule", href: "schedule.html", icon: "▦", label: "Schedule" },
  { page: "crew", href: "crew.html", icon: "◉", label: "Crew" },
  { page: "downloads", href: "downloads.html", icon: "⇩", label: "Downloads" },
  { page: "profile", href: "profile.html", icon: "◎", label: "Profile" },
  { page: "more", href: "more.html", icon: "⋯", label: "More" }
];

const androidNavItems = [
  { page: "crew", href: "crew.html", icon: "◉", label: "Today" },
  { page: "schedule", href: "schedule.html", icon: "▦", label: "Schedule" },
  { page: "profile", href: "profile.html", icon: "◎", label: "Profile" },
  { page: "more", href: "more.html", icon: "⋯", label: "More" }
];

function currentPageKey() {
  const page = location.pathname.split("/").pop() || "index.html";
  if (page === "index.html") return "home";
  return page.replace(/\.html$/, "") || "home";
}

function setupBottomNavigation(user) {
  if (document.querySelector(".mobile-bottom-nav")) return;
  const nav = document.createElement("nav");
  nav.className = "mobile-bottom-nav";
  nav.setAttribute("aria-label", "Primary app navigation");
  const activePage = currentPageKey();
  const items = isAndroidApp() && user ? androidNavItems : navItems;
  for (const item of items) {
    if (!canAccessPage(user, item.page)) continue;
    const link = document.createElement("a");
    link.href = item.href;
    link.dataset.page = item.page;
    link.className = item.page === activePage ? "is-active" : "";
    link.setAttribute("aria-label", item.label);
    if (item.page === activePage) link.setAttribute("aria-current", "page");
    link.innerHTML = `<span aria-hidden="true">${item.icon}</span><strong>${item.label}</strong>`;
    nav.append(link);
  }
  if (nav.children.length) document.body.append(nav);
}

function setupLoggedOutResetPanel() {
  const params = new URLSearchParams(location.search);
  const shouldShow = currentPageKey() === "admin" && (params.has("logout") || params.has("loggedout") || params.has("timeout") || params.has("reset"));
  if (!shouldShow || document.querySelector(".logout-reset-panel")) return;
  const authPanel = document.querySelector("#auth-panel");
  if (!authPanel) return;
  const panel = document.createElement("article");
  panel.className = "admin-card logout-reset-panel";
  const title = params.has("timeout") ? "Session timed out" : "You are logged out";
  const body = isAndroidApp()
    ? "The app has cleared the protected view. If this phone still shows old pages, reset the app session below."
    : "Use the login form to open MACS again.";
  panel.innerHTML = `
    <div class="section-head">
      <h2>${title}</h2>
      <span>Secure session closed</span>
    </div>
    <p>${body}</p>
    ${isAndroidApp() ? `<button class="secondary-button" id="reset-android-session" type="button">Reset app session</button>` : ""}
  `;
  authPanel.prepend(panel);
  panel.querySelector("#reset-android-session")?.addEventListener("click", resetAndroidAppSession);
}

function setupOutdoorModeToggle() {
  if (document.querySelector(".outdoor-mode-toggle")) return;
  const enabled = localStorage.getItem("macs.outdoorMode") === "1";
  document.body.dataset.outdoorMode = enabled ? "true" : "false";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outdoor-mode-toggle";
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", "Toggle outdoor mode");
  button.innerHTML = `<span aria-hidden="true">☼</span><strong>${enabled ? "Outdoor on" : "Outdoor"}</strong>`;
  button.addEventListener("click", () => {
    const next = document.body.dataset.outdoorMode !== "true";
    document.body.dataset.outdoorMode = next ? "true" : "false";
    localStorage.setItem("macs.outdoorMode", next ? "1" : "0");
    button.setAttribute("aria-pressed", String(next));
    button.querySelector("strong").textContent = next ? "Outdoor on" : "Outdoor";
  });
  document.body.append(button);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

function setupResponsiveNavigationMenus() {
  const menus = document.querySelectorAll(".top-actions, .site-nav nav");
  let index = 0;
  for (const menu of menus) {
    if (menu.dataset.responsiveMenuReady === "true") continue;
    menu.dataset.responsiveMenuReady = "true";
    menu.classList.add("responsive-menu");

    if (!menu.id) {
      index += 1;
      menu.id = `responsive-menu-${index}`;
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "menu-toggle";
    toggle.setAttribute("aria-controls", menu.id);
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Menu";

    const closeMenu = () => {
      menu.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    };

    toggle.addEventListener("click", () => {
      const isOpen = menu.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
    menu.before(toggle);
  }
}

function androidAppVersion() {
  const match = navigator.userAgent.match(/MACS-LawnQuote-Android\/([0-9.]+)/i);
  return match?.[1] || "";
}

function compareVersions(left, right) {
  const leftParts = String(left || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function showAndroidUpdatePrompt(latest, currentVersion) {
  if (document.querySelector(".app-update-banner")) return;
  const apkUrl = latest.externalApkUrl || latest.apkUrl;
  const banner = document.createElement("aside");
  banner.className = "app-update-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Android app update available");
  banner.innerHTML = `
    <div>
      <p class="eyebrow">Update available</p>
      <h2>MACS App ${latest.versionName} is ready</h2>
      <p>Your installed app is ${currentVersion || "older"}. Update to the latest version for the newest fixes.</p>
      <p class="app-update-link">${apkUrl}</p>
    </div>
    <div class="app-update-actions">
      <button class="primary-button" data-update-now type="button">Update now</button>
      <button class="secondary-button" data-copy-update-link type="button">Copy link</button>
      <button class="secondary-button" type="button">Later</button>
    </div>
  `;
  banner.querySelector("[data-update-now]").addEventListener("click", () => {
    window.location.href = apkUrl;
  });
  banner.querySelector("[data-copy-update-link]").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(apkUrl);
      event.currentTarget.textContent = "Copied";
    } catch {
      event.currentTarget.textContent = "Copy failed";
    }
  });
  banner.querySelector(".app-update-actions button:last-child").addEventListener("click", () => {
    localStorage.setItem(`macs.android.update.snooze.${latest.versionName}`, String(Date.now()));
    banner.remove();
  });
  document.body.append(banner);
}

async function checkAndroidAppUpdate() {
  if (androidUpdateCheckStarted) return;
  androidUpdateCheckStarted = true;
  const currentVersion = androidAppVersion();
  if (!currentVersion) return;
  try {
    const response = await fetch(`/downloads/android-latest.json?t=${Date.now()}`, {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return;
    const latest = await response.json();
    if (!latest?.versionName || !latest?.apkUrl || compareVersions(currentVersion, latest.versionName) >= 0) return;
    const snoozedAt = Number(localStorage.getItem(`macs.android.update.snooze.${latest.versionName}`) || 0);
    if (snoozedAt && Date.now() - snoozedAt < 12 * 60 * 60 * 1000) return;
    showAndroidUpdatePrompt(latest, currentVersion);
  } catch {
  }
}

export async function initAccessibleNavigation() {
  const androidApp = isAndroidApp();
  const currentPage = location.pathname.split("/").pop() || "index.html";
  if (androidApp && currentPage === "admin.html") {
    document.body.classList.add("login-only");
  }
  const status = await authStatus();
  const user = status.user || null;
  const currentAndroidVersion = androidAppVersion();
  document.body.dataset.androidApp = androidApp ? "true" : "false";
  document.body.dataset.androidAppVersion = currentAndroidVersion;
  document.body.dataset.loggedIn = user ? "true" : "false";
  document.body.dataset.role = user?.role || "guest";
  document.body.classList.toggle("login-only", androidApp && !user && currentPageKey() === "admin");
  setupLoggedOutResetPanel();
  if (androidApp && compareVersions(currentAndroidVersion, "1.0.4") < 0) {
    document.documentElement.style.setProperty("--android-status-offset", "48px");
  }
  if (androidApp) checkAndroidAppUpdate();
  if (androidApp && !user && !["admin.html", "downloads.html"].includes(currentPage)) {
    await clearClientSessionState();
    location.replace(`admin.html?android=1&loggedout=1&t=${Date.now()}`);
    return { status, user };
  }
  if (androidApp && user && !["crew.html", "schedule.html", "profile.html", "more.html", "downloads.html"].includes(currentPage)) {
    if (currentPage === "admin.html" && (new URLSearchParams(location.search).has("logout") || new URLSearchParams(location.search).has("loggedout"))) {
      document.body.classList.add("login-only");
    } else {
      location.replace("crew.html");
    }
    return { status, user };
  }
  if (user) {
    startInactivityLogout(status.security?.sessionTimeoutMinutes || 30);
    recordCurrentLocation({ force: false }).catch(() => {});
  }
  for (const link of document.querySelectorAll("[data-page]")) {
    link.hidden = !canAccessPage(user, link.dataset.page);
  }
  for (const button of document.querySelectorAll("#logout-admin")) {
    button.hidden = !user;
  }
  for (const element of document.querySelectorAll("[data-auth-label]")) {
    element.textContent = user ? `${user.username} · ${user.roleLabel}` : "Login required";
  }
  setupResponsiveNavigationMenus();
  setupBottomNavigation(user);
  setupOutdoorModeToggle();
  registerServiceWorker();
  return { status, user };
}
