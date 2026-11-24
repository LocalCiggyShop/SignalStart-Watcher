import { confirmExtensionFolder, readUpdateFolder, saveUpdateFolder } from "./browser-updater.js";

const chooseFolder = document.getElementById("chooseFolder");
const restoreFolder = document.getElementById("restoreFolder");
const openBraveSettings = document.getElementById("openBraveSettings");
const folderStatus = document.getElementById("folderStatus");
const setupStatus = document.getElementById("setupStatus");
const showInstalledFolder = document.getElementById("showInstalledFolder");
const installedFolderHelp = document.getElementById("installedFolderHelp");
const installedFolderPath = document.getElementById("installedFolderPath");
const copyFolderStatus = document.getElementById("copyFolderStatus");
const writable = { mode: "readwrite" };
const canPickFolder = typeof window.showDirectoryPicker === "function";
const isBrave = typeof navigator.brave?.isBrave === "function";
let folder = canPickFolder ? await readUpdateFolder() : null;

chooseFolder.addEventListener("click", async () => {
  chooseFolder.disabled = true;
  try {
    const selected = await window.showDirectoryPicker({ ...writable, startIn: "desktop" });
    await confirmExtensionFolder(selected);
    await saveUpdateFolder(selected);
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

openBraveSettings.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: "brave://flags/#file-system-access-api" });
  } catch {
    document.getElementById("braveSettingsFallback").classList.toggle("hidden", false);
  }
});

showInstalledFolder.addEventListener("click", async () => {
  const browser = isBrave ? "brave" : "chrome";
  try {
    await chrome.tabs.create({ url: `${browser}://extensions/?id=${chrome.runtime.id}` });
  } catch {
    installedFolderHelp.textContent = `Open ${browser}://extensions and select Details for SignalStart Watcher. Click the path under Loaded from to find the folder.`;
  }
});

document.getElementById("copyInstalledFolder").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(installedFolderPath.value);
    copyFolderStatus.textContent = "Path copied.";
  } catch {
    installedFolderPath.focus();
    installedFolderPath.select();
    copyFolderStatus.textContent = "The path is selected. Use your copy shortcut to copy it.";
  }
});

await renderSetup();
const pathHint = await readInstalledPath();
if (pathHint) {
  installedFolderPath.value = pathHint;
  document.getElementById("installedFolder").classList.toggle("hidden", false);
} else if (isBrave || canPickFolder) {
  showInstalledFolder.classList.toggle("hidden", false);
  installedFolderHelp.textContent = "Click the path under Loaded from in the browser’s extension details to find the folder.";
}

async function readInstalledPath() {
  try {
    const response = await fetch(chrome.runtime.getURL("installed-folder.json"), { cache: "no-store" });
    if (!response.ok) return null;
    const hint = await response.json();
    return hint.extensionId === chrome.runtime.id && typeof hint.path === "string" && hint.path.trim()
      ? hint.path
      : null;
  } catch {
    return null;
  }
}

async function renderSetup() {
  if (!canPickFolder) {
    chooseFolder.disabled = true;
    chooseFolder.classList.toggle("hidden", true);
    openBraveSettings.classList.toggle("hidden", !isBrave);
    document.getElementById("folderInstructions").classList.toggle("hidden", true);
    document.getElementById("manualUpdates").classList.toggle("hidden", false);
    document.getElementById("braveInstructions").classList.toggle("hidden", !isBrave);
    folderStatus.textContent = "Folder access is unavailable. Signal monitoring can still run.";
    return;
  }
  const permission = folder ? await folder.queryPermission(writable) : null;
  restoreFolder.classList.toggle("hidden", !folder || permission === "granted");
  folderStatus.textContent = permission === "granted"
    ? `Folder access granted for ${folder.name}.`
    : folder ? "Your browser needs write access to this folder." : "Choose your unpacked extension folder.";
  setupStatus.textContent = permission === "granted"
    ? "Updates run when your browser starts or you open the popup."
    : "";
}

async function checkIfReady() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "CHECK_FOR_UPDATE" });
    if (result?.error) setupStatus.textContent = result.error;
  } catch {
    // Installing a release reloads the extension and disconnects this settings page.
  }
}
