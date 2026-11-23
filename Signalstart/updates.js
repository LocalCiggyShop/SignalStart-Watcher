import { confirmExtensionFolder, readUpdateFolder, saveUpdateFolder } from "./browser-updater.js";

const chooseFolder = document.getElementById("chooseFolder");
const restoreFolder = document.getElementById("restoreFolder");
const folderStatus = document.getElementById("folderStatus");
const setupStatus = document.getElementById("setupStatus");
const writable = { mode: "readwrite" };
let folder = await readUpdateFolder();

chooseFolder.addEventListener("click", async () => {
  chooseFolder.disabled = true;
  try {
    const selected = await showDirectoryPicker({ ...writable, startIn: "desktop" });
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
  const permission = folder ? await folder.queryPermission(writable) : null;
  restoreFolder.classList.toggle("hidden", !folder || permission === "granted");
  folderStatus.textContent = permission === "granted"
    ? `Folder selected: ${folder.name}`
    : folder ? "Chrome needs permission to write to this folder." : "Choose your unpacked extension folder.";
  setupStatus.textContent = permission === "granted"
    ? "Updates run when Chrome starts or you open the popup."
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
