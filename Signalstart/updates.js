import { confirmExtensionFolder, readUpdateFolder, saveUpdateFolder } from "./browser-updater.js";

const chooseFolder = document.getElementById("chooseFolder");
const restoreFolder = document.getElementById("restoreFolder");
const folderStatus = document.getElementById("folderStatus");
const setupStatus = document.getElementById("setupStatus");
const writable = { mode: "readwrite" };
const canPickFolder = typeof window.showDirectoryPicker === "function";
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

await renderSetup();

async function renderSetup() {
  if (!canPickFolder) {
    chooseFolder.disabled = true;
    document.getElementById("folderInstructions").classList.toggle("hidden", true);
    document.getElementById("manualUpdates").classList.toggle("hidden", false);
    document.getElementById("braveInstructions").classList.toggle("hidden", typeof navigator.brave?.isBrave !== "function");
    folderStatus.textContent = "Folder access is unavailable. Signal monitoring can still run.";
    return;
  }
  const permission = folder ? await folder.queryPermission(writable) : null;
  restoreFolder.classList.toggle("hidden", !folder || permission === "granted");
  folderStatus.textContent = permission === "granted"
    ? `Folder selected: ${folder.name}`
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
