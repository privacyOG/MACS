import { updateTeamProfile } from "./auth.js";

const maxCredentialBytes = 2 * 1024 * 1024;

export function formatAustralianDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const auMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (auMatch) {
    const [, day, month, year] = auMatch;
    return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
  }
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
  }
  return text;
}

function normalizeDateOfBirth(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const auMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!auMatch) return text;
  const [, day, month, year] = auMatch;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function fileSizeLabel(bytes) {
  const size = Number(bytes || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function credentialLabel(file) {
  return `${file.label || "Credential"} · ${file.filename || "File"} · ${fileSizeLabel(file.size)}`;
}

function openCredential(file) {
  if (!file?.dataUrl) return;
  const filename = file.filename || "credential";
  const mimeType = file.mimeType || "application/octet-stream";
  if (window.MacsAndroid?.openCredential) {
    window.MacsAndroid.openCredential(file.dataUrl, filename, mimeType);
    return;
  }
  const opened = window.open(file.dataUrl, "_blank", "noopener");
  if (opened) return;
  const download = document.createElement("a");
  download.href = file.dataUrl;
  download.download = filename;
  download.rel = "noopener";
  document.body.append(download);
  download.click();
  download.remove();
}

export function profileSummary(user = {}) {
  const profile = user.profile || {};
  const details = [
    profile.fullName,
    profile.mobile,
    profile.email || user.email,
    profile.credentialCount ? `${profile.credentialCount} credential${profile.credentialCount === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  return details.length ? details.join(" · ") : "Employee details not saved yet";
}

export function renderCredentialList(list, credentials = [], { allowRemove = false, onRemove = () => {} } = {}) {
  list.replaceChildren();
  if (!credentials.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No credentials uploaded yet.";
    list.append(empty);
    return;
  }
  for (const file of credentials) {
    const item = document.createElement("div");
    item.className = "credential-item";
    const detail = document.createElement("div");
    const label = document.createElement("strong");
    const meta = document.createElement("span");
    label.textContent = file.label || "Credential";
    meta.textContent = `${file.filename || "File"} · ${file.mimeType || "file"} · ${fileSizeLabel(file.size)}`;
    detail.append(label, meta);
    const actions = document.createElement("div");
    actions.className = "inline-actions";
    if (file.dataUrl) {
      const view = document.createElement("button");
      view.className = "secondary-button";
      view.type = "button";
      view.textContent = "View";
      view.addEventListener("click", () => openCredential(file));
      actions.append(view);
    }
    if (allowRemove) {
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => onRemove(file));
      actions.append(remove);
    }
    item.append(detail, actions);
    list.append(item);
  }
}

export async function readCredentialFile(labelInput, fileInput) {
  const [file] = fileInput.files || [];
  const label = labelInput.value.trim();
  if (!label) throw new Error("Add a label for the credential first.");
  if (!file) throw new Error("Choose an image or PDF file first.");
  if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
    throw new Error("Credential uploads must be an image or PDF.");
  }
  if (file.size > maxCredentialBytes) {
    throw new Error("Credential files must be 2 MB or smaller.");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Could not read credential file.")));
    reader.readAsDataURL(file);
  });
  return {
    id: crypto.randomUUID(),
    label,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    dataUrl,
    uploadedAt: new Date().toISOString()
  };
}

export function employeeProfileFromForm(scope = document) {
  return {
    fullName: scope.querySelector("[data-profile-field='fullName']")?.value.trim() || "",
    address: scope.querySelector("[data-profile-field='address']")?.value.trim() || "",
    dateOfBirth: normalizeDateOfBirth(scope.querySelector("[data-profile-field='dateOfBirth']")?.value || ""),
    mobile: scope.querySelector("[data-profile-field='mobile']")?.value.trim() || "",
    email: scope.querySelector("[data-profile-field='email']")?.value.trim() || ""
  };
}

export async function openEmployeeProfileEditor(user, { currentUser, onSaved, setMessage }) {
  const editableCredentials = currentUser?.role === "owner" || currentUser?.role === "leader";
  const profile = user.profile || {};
  let credentials = Array.isArray(profile.credentials) ? [...profile.credentials] : [];
  const dialog = document.createElement("dialog");
  dialog.className = "job-dialog";
  dialog.innerHTML = `
    <div class="job-dialog-shell employee-dialog-shell">
      <div class="section-head">
        <div>
          <h2>Employee Details</h2>
          <span>${user.username} · ${user.roleLabel || user.role}</span>
        </div>
        <button class="ghost-button" data-close type="button">Close</button>
      </div>
      <form class="admin-form">
        <div class="field-grid two">
          <label>
            Full name
            <input data-profile-field="fullName" autocomplete="name" />
          </label>
          <label>
            Mobile
            <input data-profile-field="mobile" autocomplete="tel" />
          </label>
          <label>
            Email
            <input data-profile-field="email" type="email" autocomplete="email" required />
          </label>
          <label>
            D.O.B
            <input data-profile-field="dateOfBirth" inputmode="numeric" placeholder="dd/mm/yyyy" />
          </label>
        </div>
        <label>
          Address
          <input data-profile-field="address" autocomplete="street-address" />
        </label>
        <div class="credential-panel">
          <div class="section-head compact-head">
            <h3>Credentials</h3>
            <span>Images or PDF, labeled</span>
          </div>
          <div class="field-grid two">
            <label>
              Credential label
              <input data-credential-label placeholder="Driver licence, First aid, Site induction" />
            </label>
            <label>
              Upload file
              <input data-credential-file type="file" accept="image/*,application/pdf" />
            </label>
          </div>
          <button class="secondary-button" data-add-credential type="button">Add credential</button>
          <div data-credential-list class="credential-list"></div>
        </div>
        <div class="job-dialog-actions">
          <button class="secondary-button" data-close type="button">Cancel</button>
          <button class="primary-button" type="submit">Save employee details</button>
        </div>
      </form>
    </div>
  `;
  document.body.append(dialog);
  dialog.querySelector("[data-profile-field='fullName']").value = profile.fullName || "";
  dialog.querySelector("[data-profile-field='mobile']").value = profile.mobile || "";
  dialog.querySelector("[data-profile-field='email']").value = profile.email || user.email || "";
  dialog.querySelector("[data-profile-field='dateOfBirth']").value = formatAustralianDate(profile.dateOfBirth);
  dialog.querySelector("[data-profile-field='address']").value = profile.address || "";
  const list = dialog.querySelector("[data-credential-list]");
  const refreshCredentials = () => renderCredentialList(list, credentials, {
    allowRemove: editableCredentials,
    onRemove: (file) => {
      credentials = credentials.filter((item) => item.id !== file.id);
      refreshCredentials();
    }
  });
  refreshCredentials();
  dialog.querySelector("[data-add-credential]").addEventListener("click", async () => {
    try {
      const added = await readCredentialFile(dialog.querySelector("[data-credential-label]"), dialog.querySelector("[data-credential-file]"));
      credentials = [added, ...credentials].slice(0, 20);
      dialog.querySelector("[data-credential-label]").value = "";
      dialog.querySelector("[data-credential-file]").value = "";
      refreshCredentials();
    } catch (error) {
      setMessage(error.message, "warning");
    }
  });
  dialog.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await updateTeamProfile({
      id: user.id,
      profile: employeeProfileFromForm(dialog),
      credentials
    });
    if (!result.ok) {
      setMessage(result.message || "Employee details could not be saved.", "warning");
      return;
    }
    setMessage("Employee details saved.", "success");
    onSaved?.(result.user);
    dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

export function setupCredentialDraft({ labelInput, fileInput, addButton, list, getCredentials, setCredentials, setMessage }) {
  const refresh = () => renderCredentialList(list, getCredentials(), {
    allowRemove: true,
    onRemove: (file) => {
      setCredentials(getCredentials().filter((item) => item.id !== file.id));
      refresh();
    }
  });
  addButton.addEventListener("click", async () => {
    try {
      const credential = await readCredentialFile(labelInput, fileInput);
      setCredentials([credential, ...getCredentials()].slice(0, 20));
      labelInput.value = "";
      fileInput.value = "";
      refresh();
    } catch (error) {
      setMessage(error.message, "warning");
    }
  });
  refresh();
  return refresh;
}

export function credentialsSummary(credentials = []) {
  if (!credentials.length) return "No credentials added";
  return credentials.map(credentialLabel).join(" | ");
}
