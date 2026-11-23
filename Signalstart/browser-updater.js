import { RELEASE_PUBLIC_KEY, UPDATE_REPOSITORY } from "./update-config.js";

const databaseName = "signalstart-updates";
const storeName = "setup";
const releaseUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/signalstart-browser-update.json`;
const filePermission = { mode: "readwrite" };
const maxReleaseBytes = 8 * 1024 * 1024;
const versionPattern = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/;
const pathPartPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const reservedNamePattern = /^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i;

function openUpdateDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) request.result.createObjectStore(storeName);
      else request.transaction.objectStore(storeName).delete("token");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withUpdateStore(mode, use) {
  const database = await openUpdateDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const read = use(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(read());
      transaction.onabort = () => reject(transaction.error || new Error("Update settings could not be saved."));
    });
  } finally {
    database.close();
  }
}

export function readUpdateFolder() {
  return withUpdateStore("readonly", store => {
    const folder = store.get("folder");
    return () => folder.result;
  });
}

export function saveUpdateFolder(folder) {
  return withUpdateStore("readwrite", store => {
    store.put(folder, "folder");
    return () => undefined;
  });
}

async function downloadRelease() {
  const response = await fetch(releaseUrl, {
    credentials: "omit",
    cache: "no-cache",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
  let size = 0;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxReleaseBytes) throw new Error("The signed update exceeds its size limit.");
      controller.enqueue(chunk);
    }
  }));
  return new Response(body).json();
}

function partsForVersion(version) {
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error("The update contains an invalid version.");
  }
  const parts = version.split(".").map(Number);
  if (parts.some(part => part > 65535) || !parts.some(Boolean)) {
    throw new Error("The update contains an invalid version.");
  }
  return Array.from({ length: 4 }, (_, index) => parts[index] ?? 0);
}

export function compareVersions(first, second) {
  const a = partsForVersion(first);
  const b = partsForVersion(second);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

function bytesFromBase64(value) {
  if (typeof value !== "string") throw new Error("Invalid signed update data.");
  return Uint8Array.fromBase64(value);
}

async function verifyRelease(wrapped) {
  const bytes = bytesFromBase64(wrapped.payload);
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("spki", bytesFromBase64(RELEASE_PUBLIC_KEY), algorithm, false, ["verify"]);
  if (!await crypto.subtle.verify(algorithm, key, bytesFromBase64(wrapped.signature), bytes)) {
    throw new Error("Update signature invalid. The installed version is still active.");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function safePath(path) {
  const parts = typeof path === "string" ? path.split("/") : [];
  if (!parts.length || parts.some(part => !pathPartPattern.test(part) || part.endsWith(".") ||
      reservedNamePattern.test(part))) {
    throw new Error("The update contains an invalid file path.");
  }
  return parts;
}

async function writeFile(folder, path, contents) {
  const parts = safePath(path);
  const name = parts.pop();
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create: true });
  const file = await folder.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(contents);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

async function installedManifest(folder) {
  const handle = await folder.getFileHandle("manifest.json");
  return JSON.parse(await (await handle.getFile()).text());
}

export async function confirmExtensionFolder(folder) {
  const loaded = chrome.runtime.getManifest();
  const selected = await installedManifest(folder);
  if (selected.name !== loaded.name || selected.manifest_version !== 3 ||
      selected.key !== loaded.key || compareVersions(selected.version, loaded.version) < 0) {
    throw new Error("Select the same SignalStart folder you loaded in Chrome.");
  }

  // Prove Chrome serves files from this folder, including when two copies have the same version.
  const nonce = crypto.randomUUID();
  const name = `signalstart-folder-check-${nonce}.txt`;
  try {
    await writeFile(folder, name, nonce);
    const response = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
    if (!response.ok || await response.text() !== nonce) throw new Error("Folder mismatch.");
  } catch {
    throw new Error("Select the same SignalStart folder you loaded in Chrome.");
  } finally {
    await folder.removeEntry(name).catch(() => {});
  }
  return selected;
}

function stagedManifest(manifest, files, folderName) {
  const loaded = chrome.runtime.getManifest();
  if (manifest?.name !== loaded.name || manifest.manifest_version !== 3 ||
      manifest.key !== loaded.key || !files || Object.hasOwn(files, "manifest.json")) {
    throw new Error("The update is not a valid SignalStart release.");
  }
  for (const path of Object.keys(files)) safePath(path);

  const relocate = path => {
    if (!Object.hasOwn(files, path)) throw new Error(`The update is missing ${path}.`);
    return `${folderName}/${path}`;
  };
  const icons = set => Object.fromEntries(Object.entries(set).map(([size, path]) => [size, relocate(path)]));
  return {
    ...manifest,
    icons: icons(manifest.icons),
    action: {
      ...manifest.action,
      default_icon: icons(manifest.action.default_icon),
      default_popup: relocate(manifest.action.default_popup)
    },
    background: { ...manifest.background, service_worker: relocate(manifest.background.service_worker) },
    content_scripts: manifest.content_scripts.map(script => ({
      ...script,
      js: script.js.map(relocate),
      css: script.css.map(relocate)
    }))
  };
}

export async function installAvailableUpdate() {
  const folder = await readUpdateFolder();
  if (!folder) return "setup";
  if (await folder.queryPermission(filePermission) !== "granted") return "permission";

  const loaded = chrome.runtime.getManifest();
  const release = await verifyRelease(await downloadRelease());
  const version = release.manifest?.version;
  if (compareVersions(version, loaded.version) <= 0) return "current";

  const onDisk = await confirmExtensionFolder(folder);
  const comparison = compareVersions(onDisk.version, version);
  if (comparison > 0) return "current";
  if (comparison === 0) return "installed";

  const directoryName = `release-${version}`;
  const manifest = stagedManifest(release.manifest, release.files, directoryName);
  const releaseFolder = await folder.getDirectoryHandle(directoryName, { create: true });
  for (const [path, data] of Object.entries(release.files)) {
    await writeFile(releaseFolder, path, bytesFromBase64(data));
  }

  // Keep the existing entry points usable until every new file has closed successfully.
  await writeFile(folder, "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return "installed";
}
