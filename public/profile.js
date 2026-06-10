import {
  getProfile,
  initAccessibleNavigation,
  logoutAdmin,
  requireAdminSession,
  updateProfileContact,
  updateProfileCredentials
} from "./auth.js";
import { setupCredentialDraft } from "./team-profile.js";

const role = document.querySelector("#profile-role");
const summary = document.querySelector("#profile-summary");
const message = document.querySelector("#profile-message");
const form = document.querySelector("#profile-contact-form");
const mobileInput = document.querySelector("#profile-mobile");
const emailInput = document.querySelector("#profile-email");
const credentialLabelInput = document.querySelector("#profile-credential-label");
const credentialFileInput = document.querySelector("#profile-credential-file");
const addCredentialButton = document.querySelector("#add-profile-credential");
const saveCredentialsButton = document.querySelector("#save-profile-credentials");
const credentialList = document.querySelector("#profile-credential-list");

let currentUser = null;
let credentials = [];
let refreshCredentialDraft = () => {};

function setMessage(text, tone = "info") {
  message.textContent = text;
  message.dataset.tone = tone;
}

function addStat(label, value) {
  const row = document.createElement("div");
  row.className = "dashboard-stat";
  row.innerHTML = `<span>${label}</span><strong>${value || "Not saved"}</strong>`;
  summary.append(row);
}

function renderProfile(user) {
  currentUser = user;
  const profile = user.profile || {};
  credentials = Array.isArray(profile.credentials) ? [...profile.credentials] : [];
  role.textContent = `${user.username} · ${user.roleLabel}`;
  mobileInput.value = profile.mobile || "";
  emailInput.value = profile.email || user.email || "";
  summary.replaceChildren();
  addStat("Name", profile.fullName);
  addStat("Address", profile.address);
  addStat("D.O.B", profile.dateOfBirth);
  addStat("Mobile", profile.mobile);
  addStat("Email", profile.email || user.email);
  addStat("Credentials", `${profile.credentialCount || 0} on file`);
  refreshCredentialDraft();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await updateProfileContact({
    mobile: mobileInput.value.trim(),
    email: emailInput.value.trim()
  });
  if (!result.ok) {
    setMessage(result.message || "Profile contact could not be saved.", "warning");
    return;
  }
  renderProfile(result.user);
  setMessage("Profile contact updated.", "success");
});

refreshCredentialDraft = setupCredentialDraft({
  labelInput: credentialLabelInput,
  fileInput: credentialFileInput,
  addButton: addCredentialButton,
  list: credentialList,
  getCredentials: () => credentials,
  setCredentials: (next) => {
    credentials = next;
  },
  setMessage
});

saveCredentialsButton.addEventListener("click", async () => {
  saveCredentialsButton.disabled = true;
  const result = await updateProfileCredentials(credentials);
  saveCredentialsButton.disabled = false;
  if (!result.ok) {
    setMessage(result.message || "Credentials could not be saved.", "warning");
    return;
  }
  renderProfile(result.user);
  setMessage("Credentials saved.", "success");
});

document.querySelector("#logout-admin").addEventListener("click", () => {
  logoutAdmin();
});

if (await requireAdminSession()) {
  await initAccessibleNavigation();
  const result = await getProfile();
  if (result.ok) renderProfile(result.user);
  else setMessage(result.message || "Profile unavailable.", "warning");
}
