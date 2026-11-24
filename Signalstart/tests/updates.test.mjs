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
