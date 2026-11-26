import assert from "node:assert/strict";
import test from "node:test";

const signal = {
  id: "123",
  name: "Example",
  slug: "example",
  url: "https://www.signalstart.com/analysis/example/123",
  enabled: true,
  floatingValue: 0,
  floatingDisplay: "$0.00",
  openTrades: 0,
  lastCheckedAt: null,
  lastAlertAt: null,
  lastKind: null,
  lastSource: null
};
const data = {
  signals: { "123": signal },
  settings: { playSound: false }
};
const notifications = [];
const listeners = {};
let alarm = null;
let alarmCreates = 0;
let notificationPermission = "granted";
let fetchImpl = async () => htmlResponse("$0.00");
let browserWindows = [{ id: 1 }];
let offscreenOpen = false;

function htmlResponse(value, openTrades, openRows) {
  const table = openRows && `<table id="openTradesTable">
    <thead><tr><th><a>Open Date</a></th><th><a>Symbol</a></th><th>Lots</th></tr></thead>
    <tbody>${openRows.map(([date, symbol]) => `<tr><td><nobr>${date}</nobr></td>
      <td><nobr><span>${symbol}</span></nobr></td><td><span class="fa fa-lock"></span></td></tr>`).join("")}</tbody>
  </table>`;
  return {
    ok: true,
    text: async () => `<li>Floating PL: <span>${value}</span></li>` +
      (openTrades == null ? "" : `<a href="#openTradesListData">Open Trades (${openTrades})</a>`) +
      (table || "")
  };
}

globalThis.fetch = (...args) => fetchImpl(...args);
globalThis.chrome = {
  windows: {
    async getAll() { return browserWindows; },
    onRemoved: { addListener(fn) { listeners.windowRemoved = fn; } },
    onCreated: { addListener(fn) { listeners.windowCreated = fn; } }
  },
  storage: {
    local: {
      async get() { return structuredClone(data); },
      async set(next) { Object.assign(data, structuredClone(next)); }
    }
  },
  alarms: {
    async get() { return alarm; },
    async create(name, options) {
      alarmCreates += 1;
      alarm = { name, ...options };
    },
    async clear() { alarm = null; },
    onAlarm: { addListener(fn) { listeners.alarm = fn; } }
  },
  runtime: {
    getURL(path) { return `chrome-extension://test/${path}`; },
    getContexts: async () => offscreenOpen ? [{}] : [],
    onInstalled: { addListener(fn) { listeners.installed = fn; } },
    onStartup: { addListener(fn) { listeners.startup = fn; } },
    onMessage: { addListener(fn) { listeners.message = fn; } }
  },
  notifications: {
    async create(id, options) { notifications.push({ id, options }); return id; },
    async getPermissionLevel() { return notificationPermission; },
    onClicked: { addListener(fn) { listeners.notificationClicked = fn; } }
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {}
  },
  offscreen: {
    async createDocument() { offscreenOpen = true; },
    async closeDocument() { offscreenOpen = false; }
  }
};

await import("../background.js");

async function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const sender = type === "LIVE_STATS" ? { url: payload.payload.url } : {};
    const keepOpen = listeners.message({ type, ...payload }, sender, resolve);
    if (keepOpen !== true) reject(new Error(`${type} did not keep its response open`));
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for background startup");
}

test("keeps an existing poll alarm and processes later live changes", async () => {
  await waitFor(() => data.signals["123"].lastCheckedAt != null && alarmCreates === 1);
  listeners.startup();
  await waitFor(() => data.signals["123"].lastCheckedAt != null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alarmCreates, 1);
  await send("SAVE_SETTINGS", { settings: { playSound: false, pollMinutes: 15 } });
  assert.equal(alarmCreates, 2);
  assert.equal(alarm.periodInMinutes, 15);

  const response = await send("LIVE_STATS", {
    payload: {
      url: signal.url,
      name: signal.name,
      floatingDisplay: "$10.00",
      floatingValue: 10,
      openTrades: 0
    }
  });
  assert.deepEqual(response, { ok: true });
  assert.equal(data.signals["123"].floatingValue, 10);
  assert.equal(notifications.length, 1);
});

test("an in-flight older poll cannot overwrite a newer page update", async () => {
  let finishFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  fetchImpl = () => {
    fetchStarted();
    return new Promise((resolve) => { finishFetch = resolve; });
  };
  const poll = send("POLL_NOW");
  await started;
  await send("LIVE_STATS", {
    payload: {
      url: signal.url,
      name: signal.name,
      floatingDisplay: "$20.00",
      floatingValue: 20,
      openTrades: 0
    }
  });
  finishFetch(htmlResponse("$0.00"));
  await poll;
  assert.equal(data.signals["123"].floatingValue, 20);
  assert.equal(notifications.length, 2);
});

test("a completed poll cannot restore a removed signal", async () => {
  let finishFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  fetchImpl = () => {
    fetchStarted();
    return new Promise((resolve) => { finishFetch = resolve; });
  };
  const poll = send("POLL_NOW");
  await started;
  await send("REMOVE_SIGNAL", { id: "123" });
  finishFetch(htmlResponse("$30.00"));
  await poll;
  assert.equal(data.signals["123"], undefined);
  assert.equal(alarm, null);
  assert.equal(notifications.length, 2);
});

test("test notification uses the real notification path and reports blocked settings", async () => {
  const response = await send("TEST_NOTIFICATION");
  assert.deepEqual(response, { ok: true });
  assert.equal(notifications.length, 3);
  assert.match(notifications[2].id, /^ss-test-/);
  assert.equal(notifications[2].options.title, "SignalStart Watcher: Test notification");

  data.settings.notificationsEnabled = false;
  assert.match((await send("TEST_NOTIFICATION")).error, /Enable notifications/);
  assert.equal(notifications.length, 3);

  data.settings.notificationsEnabled = true;
  notificationPermission = "denied";
  assert.match((await send("TEST_NOTIFICATION")).error, /blocked/);
  assert.equal(notifications.length, 3);
});

test("test notification returns the actual notification API error", async () => {
  data.settings.notificationsEnabled = true;
  notificationPermission = "granted";
  const originalCreate = chrome.notifications.create;
  chrome.notifications.create = async () => { throw new Error("Unable to download all specified images."); };
  try {
    assert.deepEqual(await send("TEST_NOTIFICATION"), {
      error: "Unable to download all specified images."
    });
  } finally {
    chrome.notifications.create = originalCreate;
  }
});

test("test notification returns sound errors after the desktop notification is created", async () => {
  data.settings.playSound = true;
  chrome.runtime.sendMessage = async () => ({ error: "AudioContext could not be created." });
  const notificationCount = notifications.length;
  try {
    assert.deepEqual(await send("TEST_NOTIFICATION"), {
      error: "Notification created, but sound failed: AudioContext could not be created."
    });
    assert.equal(notifications.length, notificationCount + 1);
  } finally {
    data.settings.playSound = false;
    delete chrome.runtime.sendMessage;
  }
});

test("saved drawdown settings notify on poll and live threshold crossings", async () => {
  await send("SAVE_SETTINGS", { settings: {
    playSound: false,
    alertOnLeaveZero: false,
    alertOnAnyChange: false,
    alertOnOpenTrades: false,
    alertOnDrawdown: true,
    drawdownAmount: 100
  } });
  const count = notifications.length;
  fetchImpl = async () => htmlResponse("-$90.00");
  await send("ADD_SIGNAL", { payload: { name: signal.name, url: signal.url } });
  assert.equal(notifications.length, count);
  assert.equal(data.settings.drawdownAmount, 100);

  fetchImpl = async () => htmlResponse("-$100.00");
  await send("POLL_NOW");
  assert.equal(notifications.length, count + 1);
  assert.equal(data.signals["123"].lastKind, "drawdown");
  assert.match(notifications.at(-1).options.title, /loss threshold reached/);

  const live = (value) => send("LIVE_STATS", { payload: {
    url: signal.url,
    name: signal.name,
    floatingValue: value,
    floatingDisplay: `-$${Math.abs(value).toFixed(2)}`,
    openTrades: 0
  } });
  await live(-150);
  assert.equal(notifications.length, count + 1);
  await live(-90);
  await live(-120);
  assert.equal(notifications.length, count + 2);

  data.settings.notificationsEnabled = false;
  await live(-90);
  await live(-150);
  assert.equal(notifications.length, count + 2);
});

function live(value, openTrades, openTradeKeys) {
  return send("LIVE_STATS", { payload: {
    url: signal.url,
    floatingValue: value,
    floatingDisplay: `$${value}`,
    openTrades,
    openTradeKeys
  } });
}

test("new-trade alerts work for polls and live changes and respect both switches", async () => {
  fetchImpl = async () => htmlResponse("$0.00", 1);
  await send("SAVE_SETTINGS", { settings: {
    notificationsEnabled: true,
    alertOnOpenTrades: true,
    alertOnLeaveZero: true,
    alertOnAnyChange: false,
    alertOnDrawdown: false
  } });
  await send("REMOVE_SIGNAL", { id: "123" });
  const count = notifications.length;
  await send("ADD_SIGNAL", { payload: signal });
  assert.equal(notifications.length, count, "existing trades establish a baseline");

  fetchImpl = async () => htmlResponse("$0.00", 2);
  await send("POLL_NOW");
  assert.match(notifications.at(-1).options.title, /New trade opened/);
  assert.match(notifications.at(-1).options.message, /1 to 2/);
  assert.equal(notifications.length, count + 1);
  await live(0, 2, ["first", "second"]);
  assert.equal(notifications.length, count + 1, "the live sample supplies identities for the same trades");
  await live(0, 2, ["second", "first"]);
  assert.equal(notifications.length, count + 1, "a row reorder is not a new trade");

  fetchImpl = async () => htmlResponse("$0.00", 2);
  await send("POLL_NOW");
  await live(0, 2, ["first", "third"]);
  assert.equal(notifications.length, count + 2, "a replacement trade is detected when the count stays the same");
  await live(-20, 3, ["first", "third", "fourth"]);
  assert.equal(notifications.length, count + 3);
  assert.match(notifications.at(-1).options.title, /New trade opened/);
  assert.match(notifications.at(-1).options.message, /Floating PL moved/);

  await send("SAVE_SETTINGS", { settings: { alertOnOpenTrades: false } });
  await live(-20, 4);
  assert.equal(notifications.length, count + 3);
  await live(0, 0);
  await live(-20, 1);
  assert.equal(notifications.length, count + 4, "the independent Floating PL alert still fires");
  assert.match(notifications.at(-1).options.title, /Floating PL went negative/);

  await send("SAVE_SETTINGS", { settings: { notificationsEnabled: false, alertOnOpenTrades: true } });
  await live(-20, 2);
  assert.equal(notifications.length, count + 4);
  await send("SAVE_SETTINGS", { settings: { notificationsEnabled: true } });
  await live(-20, 2);
  assert.equal(notifications.length, count + 4, "missed alerts are not replayed when re-enabled");
  await live(-20, 4);
  assert.equal(notifications.length, count + 5);
  assert.match(notifications.at(-1).options.title, /2 new trades opened/);
});

test("background polling recognizes trade replacements and agrees with the page watcher", async () => {
  const old = ["26/11/2026", "XAUUSD.R"];
  const kept = ["26/11/2026", "BTCUSD"];
  const opened = ["27/11/2026", "GER&amp;40"];
  fetchImpl = async () => htmlResponse("-$46.19", 2, [old, kept]);
  await send("REMOVE_SIGNAL", { id: "123" });
  const count = notifications.length;
  await send("ADD_SIGNAL", { payload: signal });
  assert.equal(notifications.length, count);

  // A partial page must not discard the identities from the last complete reading.
  fetchImpl = async () => htmlResponse("-$46.19", 2, [kept]);
  await send("POLL_NOW");
  assert.equal(notifications.length, count);

  fetchImpl = async () => htmlResponse("-$46.19", 2, [kept, opened]);
  await send("POLL_NOW");
  assert.equal(notifications.length, count + 1);
  assert.match(notifications.at(-1).options.title, /New trade opened/);

  await live(-46.19, 2, [JSON.stringify(kept), JSON.stringify([opened[0], "GER&40"])]);
  await send("POLL_NOW");
  assert.equal(notifications.length, count + 1, "the same rows from a tab or a poll do not alert again");
});

test("desktop API failures preserve the latest signal stats and surface the error", async () => {
  const original = chrome.notifications.create;
  chrome.notifications.create = async () => { throw new Error("Desktop notifications unavailable"); };
  try {
    await live(0, 0);
    const response = await live(20, 2);
    assert.deepEqual(response, { error: "Desktop notifications unavailable" });
    assert.equal(data.signals["123"].floatingValue, 20);
    assert.equal(data.signals["123"].openTrades, 2);
    assert.match(data.signals["123"].error, /Desktop notifications unavailable/);
  } finally {
    chrome.notifications.create = original;
  }
});

test("rejects forged live updates before they reach the signal and alert logic", async () => {
  const before = data.signals["123"].floatingValue;
  const result = await new Promise(resolve => listeners.message({ type: "LIVE_STATS", payload: {
    url: signal.url, floatingValue: 999, floatingDisplay: "$999", openTrades: 1
  } }, { url: "https://example.com/analysis/example/123" }, resolve));
  assert.match(result.error, /Untrusted/);
  assert.equal(data.signals["123"].floatingValue, before);
});

test("slow desktop notifications cannot hold up live prices or open-trade stats", async () => {
  await live(0, 0);
  const original = chrome.notifications.create;
  let release, notifyStarted;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  chrome.notifications.create = async (...args) => {
    notifyStarted();
    await blocked;
    return original(...args);
  };
  let first;
  try {
    first = live(-10, 1, ["position"]);
    await started;
    await live(-20, 1, ["position"]);
    assert.equal(data.signals["123"].floatingValue, -20);
    assert.deepEqual(data.signals["123"].openTradeKeys, ["position"]);
  } finally {
    release();
    if (first) await first;
    chrome.notifications.create = original;
  }
});

test("closing the last browser window cancels a fetch, closes offscreen audio and clears the alarm", async () => {
  let started;
  let aborted = false;
  const ready = new Promise(resolve => { started = resolve; });
  fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("Aborted", "AbortError"));
    });
    started();
  });
  const pending = send("POLL_NOW");
  await ready;
  offscreenOpen = true;
  browserWindows = [];
  listeners.windowRemoved(1);
  await waitFor(() => data.monitoringPaused === "browser" && !alarm && !offscreenOpen);
  await pending;
  assert.ok(aborted);
  assert.equal(data.signals["123"].enabled, true, "watch preferences are preserved");
  const before = data.signals["123"].floatingValue;
  await send("LIVE_STATS", { payload: { url: signal.url, floatingValue: 999, floatingDisplay: "$999", openTrades: 1 } });
  assert.equal(data.signals["123"].floatingValue, before);
});

test("a browser window resumes saved monitoring and closing just one of two windows leaves it running", async () => {
  fetchImpl = async () => htmlResponse("$0.00");
  browserWindows = [{ id: 2 }, { id: 3 }];
  listeners.windowCreated(browserWindows[0]);
  await waitFor(() => data.monitoringPaused === "" && alarm != null);
  browserWindows = [{ id: 3 }];
  listeners.windowRemoved(2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(data.monitoringPaused, "");
  assert.notEqual(alarm, null);
});

test("legacy MT5 settings and pause state cannot connect MT5 or pause alerts", async () => {
  let connections = 0;
  chrome.runtime.connectNative = () => { connections++; };
  data.monitoringPaused = "mt5";
  data.settings.mt5SignalId = "123";
  await send("RESUME_MONITORING");
  assert.equal(data.monitoringPaused, "");
  await send("SAVE_SETTINGS", { settings: { mt5SignalId: "456", alertOnOpenTrades: true } });
  const state = await send("GET_STATE");
  assert.equal(state.settings.mt5SignalId, undefined);
  assert.equal(data.settings.mt5SignalId, "123");
  assert.notEqual(alarm, null);
  assert.match((await send("TEST_MT5")).error, /currently unavailable/);
  await live(0, 0);
  await live(0, 1);
  assert.match(notifications.at(-1).options.title, /New trade opened/);
  assert.equal(connections, 0);
});
