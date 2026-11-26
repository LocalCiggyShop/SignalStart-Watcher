import assert from "node:assert/strict";
import test from "node:test";

const elements = new Map();
let testResponse = { ok: true };
let transportError = null;
const popupState = { settings: {}, signals: {} };
const savedSettings = [];
let storageChanged;

function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      textContent: "",
      innerHTML: "",
      disabled: false,
      events: {},
      attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      classList: {
        remove(value) { classes.delete(value); },
        toggle(value, enabled) { enabled ? classes.add(value) : classes.delete(value); },
        contains(value) { return classes.has(value); }
      },
      addEventListener(type, handler) { this.events[type] = handler; },
      focus() {}
    });
  }
  return elements.get(id);
}

globalThis.document = { getElementById: element };
globalThis.chrome = {
  storage: { onChanged: { addListener(fn) { storageChanged=fn; } } },
  runtime: {
    getManifest() { return { version: "1.5.7" }; },
    async sendMessage(message) {
      if (message.type === "GET_STATE") return structuredClone(popupState);
      if (message.type === "SAVE_SETTINGS") {
        Object.assign(popupState.settings, structuredClone(message.settings));
        savedSettings.push(structuredClone(message.settings));
        return { ok: true };
      }
      if (transportError) throw transportError;
      return testResponse;
    }
  }
};

await import("../popup.js");

test("drawdown starts disabled with a custom amount and keeps the displayed version", () => {
  assert.equal(element("alertOnDrawdown").checked, false);
  assert.equal(element("drawdownAmount").value, "100");
  assert.equal(element("drawdownAmount").disabled, true);
  assert.equal(element("versionLabel").textContent, "Version 1.5.7");
});

test("shows the actual error below the test button and allows another test", async () => {
  const button = element("testNotificationBtn");
  const status = element("testNotificationStatus");
  testResponse = { error: "Unable to download all specified images." };
  await button.events.click();
  assert.equal(status.textContent, testResponse.error);
  assert.equal(status.classList.contains("error"), true);
  assert.equal(button.disabled, false);

  testResponse = { ok: true };
  await button.events.click();
  assert.equal(status.textContent, "Chrome accepted the test notification.");
  assert.equal(status.classList.contains("error"), false);
});

test("shows transport errors and missing confirmations instead of success", async () => {
  const button = element("testNotificationBtn");
  const status = element("testNotificationStatus");
  transportError = new Error("Could not establish connection. Receiving end does not exist.");
  await button.events.click();
  assert.equal(status.textContent, transportError.message);
  assert.equal(status.classList.contains("error"), true);

  transportError = null;
  testResponse = undefined;
  await button.events.click();
  assert.equal(status.textContent, "No confirmation received from the notification handler.");
  assert.equal(status.classList.contains("error"), true);
  assert.equal(button.disabled, false);
});

test("saves the custom drawdown amount and restores it when settings reload", async () => {
  const checkbox = element("alertOnDrawdown");
  const amount = element("drawdownAmount");
  checkbox.checked = true;
  await checkbox.events.change();
  assert.equal(amount.disabled, false);
  amount.value = "250.50";
  await amount.events.change();
  assert.equal(savedSettings.at(-1).alertOnDrawdown, true);
  assert.equal(savedSettings.at(-1).drawdownAmount, 250.5);

  await element("notifyToggleBtn").events.click();
  assert.equal(checkbox.checked, true);
  assert.equal(amount.value, "250.5");
  assert.equal(popupState.settings.drawdownAmount, 250.5);
  assert.equal(popupState.settings.notificationsEnabled, false);
});

test("rejects invalid drawdown amounts with visible text and permits disabling the rule", async () => {
  const checkbox = element("alertOnDrawdown");
  const amount = element("drawdownAmount");
  const error = element("drawdownError");
  const count = savedSettings.length;
  for (const value of ["", "0", "-10", "0.001", "not-a-number"]) {
    amount.value = value;
    await amount.events.change();
    assert.equal(savedSettings.length, count);
    assert.equal(error.textContent, "Enter a loss amount of at least 0.01.");
    assert.equal(error.classList.contains("hidden"), false);
  }
  checkbox.checked = false;
  await checkbox.events.change();
  assert.equal(popupState.settings.alertOnDrawdown, false);
  assert.equal(amount.disabled, true);
  assert.equal(error.classList.contains("hidden"), true);
});

test("the new-trade switch controls only trade alerts, even with an invalid loss amount", async () => {
  assert.equal(element("alertOnOpenTrades").checked, true);
  element("alertOnDrawdown").checked = true;
  element("drawdownAmount").value = "";
  await element("alertOnDrawdown").events.change();
  const tradeSwitch = element("alertOnOpenTrades");
  tradeSwitch.checked = false;
  await tradeSwitch.events.change();
  assert.deepEqual(savedSettings.at(-1), { alertOnOpenTrades: false });
  assert.equal(popupState.settings.alertOnOpenTrades, false);

  tradeSwitch.checked = true;
  await tradeSwitch.events.change();
  assert.deepEqual(savedSettings.at(-1), { alertOnOpenTrades: true });
  assert.equal(popupState.settings.alertOnOpenTrades, true);
});

test("master switch updates its accessible state and controls whether a test can be sent", async () => {
  const master = element("notifyToggleBtn");
  const testButton = element("testNotificationBtn");
  assert.equal(master.attributes["aria-checked"], "false");
  assert.equal(testButton.disabled, true);
  await master.events.click();
  assert.equal(master.attributes["aria-checked"], "true");
  assert.equal(testButton.disabled, false);
});

test("live statistics do not reset an interval while the user is editing it", () => {
  element("changePercent").value = "12";
  storageChanged({ signals: { newValue: {} } }, "local");
  assert.equal(element("changePercent").value, "12");
});
