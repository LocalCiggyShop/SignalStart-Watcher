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
        const hiddenAtStart = id === "braveInstructions" || id === "manualUpdates";
        const classes = new Set(hiddenAtStart ? ["hidden"] : []);
        elements.set(id, {
          disabled: false,
          textContent: "",
          addEventListener() {},
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
  await import("../updates.js?brave");
  assert.equal(element("chooseFolder").disabled, true);
  assert.equal(element("braveInstructions").classList.contains("hidden"), false);
  assert.equal(element("manualUpdates").classList.contains("hidden"), false);
  assert.match(element("folderStatus").textContent, /Folder access is unavailable/);
});

test("other browsers without the picker get only manual update instructions", async () => {
  const element = setupPage(false);
  await import("../updates.js?no_picker");
  assert.equal(element("chooseFolder").disabled, true);
  assert.equal(element("braveInstructions").classList.contains("hidden"), true);
  assert.equal(element("manualUpdates").classList.contains("hidden"), false);
});
