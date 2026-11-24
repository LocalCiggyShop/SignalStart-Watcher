import assert from "node:assert/strict";
import test from "node:test";

function setupPage(brave) {
  const elements = new Map();
  globalThis.window = {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: brave ? { brave: { async isBrave() { return true; } } } : {}
  });
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const hiddenAtStart = ["braveInstructions", "manualUpdates", "openBraveSettings", "braveSettingsFallback", "installedFolder", "showInstalledFolder"].includes(id);
        const classes = new Set(hiddenAtStart ? ["hidden"] : []);
        elements.set(id, {
          disabled: false,
          textContent: "",
          action: null,
          addEventListener(type, callback) { if (type === "click") this.action = callback; },
          classList: {
            toggle(name, force) {
              if (force) classes.add(name);
              else classes.delete(name);
              return force;
            },
            contains(name) { return classes.has(name); }
          }
        });
      }
      return elements.get(id);
    }
  };
  return document.getElementById;
}

test("Brave's disabled folder picker gets flag instructions and a manual update", async () => {
  const element = setupPage(true);
  const opened = [];
  globalThis.chrome = { tabs: { async create(options) { opened.push(options.url); } } };
  await import("../updates.js?brave");
  assert.equal(element("chooseFolder").disabled, true);
  assert.equal(element("braveInstructions").classList.contains("hidden"), false);
  assert.equal(element("manualUpdates").classList.contains("hidden"), false);
  assert.equal(element("openBraveSettings").classList.contains("hidden"), false);
  assert.match(element("folderStatus").textContent, /Folder access is unavailable/);
  await element("openBraveSettings").action();
  assert.deepEqual(opened, ["brave://flags/#file-system-access-api"]);
  assert.equal(element("braveSettingsFallback").classList.contains("hidden"), true);

  chrome.tabs.create = async () => { throw new Error("Navigation blocked"); };
  await element("openBraveSettings").action();
  assert.equal(element("braveSettingsFallback").classList.contains("hidden"), false);
});

test("other browsers without the picker get only manual update instructions", async () => {
  const element = setupPage(false);
  await import("../updates.js?no_picker");
  assert.equal(element("chooseFolder").disabled, true);
  assert.equal(element("braveInstructions").classList.contains("hidden"), true);
  assert.equal(element("openBraveSettings").classList.contains("hidden"), true);
  assert.equal(element("manualUpdates").classList.contains("hidden"), false);
});

test("Updates shows and copies the path saved for this installation", async t => {
  const element = setupPage(true);
  const path = String.raw`C:\Users\Example\Desktop\Signalstart`;
  const id = "extension-id";
  globalThis.chrome = { runtime: { id, getURL: file => `chrome-extension://${id}/${file}` } };
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, `chrome-extension://${id}/installed-folder.json`);
    return Response.json({ extensionId: id, path });
  });
  const copied = [];
  navigator.clipboard = { async writeText(value) { copied.push(value); } };

  await import("../updates.js?installed_path");
  assert.equal(element("installedFolder").classList.contains("hidden"), false);
  assert.equal(element("installedFolderPath").value, path);
  await element("copyInstalledFolder").action();
  assert.deepEqual(copied, [path]);
  assert.equal(element("copyFolderStatus").textContent, "Path copied.");
});

test("Updates opens Brave Details when the saved path is for a different installation", async t => {
  const element = setupPage(true);
  const opened = [];
  globalThis.chrome = {
    runtime: { id: "current-id", getURL: file => `chrome-extension://current-id/${file}` },
    tabs: { async create(options) { opened.push(options.url); } }
  };
  t.mock.method(globalThis, "fetch", async () => Response.json({ extensionId: "old-id", path: "old path" }));

  await import("../updates.js?stale_path");
  assert.equal(element("installedFolder").classList.contains("hidden"), true);
  assert.equal(element("showInstalledFolder").classList.contains("hidden"), false);
  await element("showInstalledFolder").action();
  assert.deepEqual(opened, ["brave://extensions/?id=current-id"]);
});

function setupFolderAccess(t, folder) {
  const element = setupPage(true);
  const id = "current-id";
  const manifest = { name: "SignalStart", manifest_version: 3, version: "1.5.5" };
  const files = new Map([["manifest.json", JSON.stringify(manifest)]]);
  const requests = [];
  let saved = folder;
  globalThis.chrome = { runtime: {
    id,
    getURL: name => `chrome-extension://${id}/${name}`,
    getManifest: () => manifest,
    async sendMessage(message) {
      requests.push(message);
      return { status: "current" };
    }
  } };
  globalThis.indexedDB = {
    open() {
      const request = { result: {
        transaction() {
          const transaction = { objectStore: () => ({
            get: () => ({ result: saved }),
            put: next => { saved = next; }
          }) };
          queueMicrotask(() => transaction.oncomplete());
          return transaction;
        },
        close() {}
      } };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  t.mock.method(globalThis, "fetch", async url => {
    const body = files.get(new URL(url).pathname.slice(1));
    return new Response(body, { status: body === undefined ? 404 : 200 });
  });

  const writableFolder = {
    name: "SignalStart",
    async queryPermission() { return "granted"; },
    async getFileHandle(name) {
      return {
        async getFile() { return new Blob([files.get(name)]); },
        async createWritable() {
          return { async write(content) { files.set(name, content); }, async close() {} };
        }
      };
    },
    async removeEntry(name) { files.delete(name); }
  };
  window.showDirectoryPicker = async options => {
    assert.equal(options.startIn, folder);
    assert.equal(options.mode, "readwrite");
    return writableFolder;
  };
  return { element, requests, writableFolder, readSaved: () => saved };
}

test("restore confirms the write grant before showing success and checking for updates", async t => {
  let permission = "prompt";
  let allow;
  const approval = new Promise(resolve => { allow = resolve; });
  const folder = {
    async requestPermission() { await approval; permission = "granted"; return permission; },
    async queryPermission() { return permission; }
  };
  const { element, requests, writableFolder } = setupFolderAccess(t, folder);
  folder.name = writableFolder.name;
  folder.getFileHandle = writableFolder.getFileHandle;
  folder.removeEntry = writableFolder.removeEntry;
  await import("../updates.js?restored");

  const restore = element("restoreFolder").action();
  assert.equal(element("folderStatus").textContent, "Waiting for folder access…");
  assert.equal(element("chooseFolder").disabled, true);
  assert.equal(requests.length, 0);
  allow();
  await restore;
  assert.match(element("folderStatus").textContent, /^Folder access granted/);
  assert.match(element("setupStatus").textContent, /^You’re up to date/);
  assert.deepEqual(requests, [{ type: "CHECK_FOR_UPDATE" }]);
});

test("write access that remains pending can be recovered by reselecting the saved folder", async t => {
  const folder = {
    async requestPermission() { return "prompt"; },
    async queryPermission() { return "prompt"; }
  };
  const { element, requests, writableFolder, readSaved } = setupFolderAccess(t, folder);
  await import("../updates.js?reselect");

  await element("restoreFolder").action();
  assert.equal(element("restoreFolder").classList.contains("hidden"), true);
  assert.equal(element("chooseFolder").textContent, "Choose folder again");
  assert.equal(requests.length, 0);
  assert.equal(readSaved(), folder);

  await element("chooseFolder").action();
  assert.equal(readSaved(), writableFolder);
  assert.match(element("folderStatus").textContent, /^Folder access granted/);
  assert.deepEqual(requests, [{ type: "CHECK_FOR_UPDATE" }]);
});
