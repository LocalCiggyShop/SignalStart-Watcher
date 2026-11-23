import { confirmExtensionFolder, confirmUpdateToken, readUpdateSetup, saveUpdateSetting } from "./browser-updater.js";

const chooseFolder = document.getElementById("chooseFolder");
const restoreFolder = document.getElementById("restoreFolder");
const folderStatus = document.getElementById("folderStatus");
const tokenForm = document.getElementById("tokenForm");
const githubToken = document.getElementById("githubToken");
const saveToken = document.getElementById("saveToken");
const tokenStatus = document.getElementById("tokenStatus");
const setupStatus = document.getElementById("setupStatus");
const writable = { mode: "readwrite" };
let { folder, token } = await readUpdateSetup();

chooseFolder.addEventListener("click", async () => {
  chooseFolder.disabled = true;
  try {
    const selected = await showDirectoryPicker({ ...writable, startIn: "desktop" });
    await confirmExtensionFolder(selected);
    await saveUpdateSetting("folder", selected);
    folder = selected;
    await renderSetup();
    checkIfReady();
  } catch (error) {
    if (error.name !== "AbortError") folderStatus.textContent = error.message;
  } finally {
    chooseFolder.disabled = false;
  }
});

restoreFolder.addEventListener("click", async () => {
  restoreFolder.disabled = true;
  try {
    if (await folder.requestPermission(writable) === "granted") {
      await confirmExtensionFolder(folder);
      await renderSetup();
      checkIfReady();
    } else {
      await renderSetup();
    }
  } catch (error) {
    folderStatus.textContent = error.message;
  } finally {
    restoreFolder.disabled = false;
  }
});

tokenForm.addEventListener("submit", async event => {
  event.preventDefault();
  const value = githubToken.value.trim();
  if (!value) return;
  saveToken.disabled = true;
  tokenStatus.textContent = "Checking GitHub access…";
  try {
    await confirmUpdateToken(value);
    await saveUpdateSetting("token", value);
    token = value;
    githubToken.value = "";
    await renderSetup();
    checkIfReady();
  } catch (error) {
    tokenStatus.textContent = error.message;
  } finally {
    saveToken.disabled = false;
  }
});

await renderSetup();

async function renderSetup() {
  const permission = folder ? await folder.queryPermission(writable) : null;
  restoreFolder.classList.toggle("hidden", !folder || permission === "granted");
  folderStatus.textContent = permission === "granted"
    ? `Folder selected: ${folder.name}`
    : folder ? "Chrome needs permission to write to this folder." : "Choose your unpacked extension folder.";
  tokenStatus.textContent = token ? "GitHub token saved in this Chrome profile." : "";
  setupStatus.textContent = folder && token && permission === "granted"
    ? "Updates run when Chrome starts or you open the popup."
    : "";
}

async function checkIfReady() {
  if (!folder || !token || await folder.queryPermission(writable) !== "granted") return;
  try {
    const result = await chrome.runtime.sendMessage({ type: "CHECK_FOR_UPDATE" });
    if (result?.error) setupStatus.textContent = result.error;
  } catch {
    // Installing a release reloads the extension and disconnects this settings page.
  }
}
