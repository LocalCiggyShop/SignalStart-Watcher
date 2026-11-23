import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  parseAnalysisUrl,
  fetchSignalStats,
  evaluateAlert,
  createTrackedSignal,
  isZero,
  tidyName,
  pollMinutesFromSettings,
  percentChange
} from "./shared.js";
import "./trade-reader.js";
import { installAvailableUpdate } from "./browser-updater.js";

const ALARM_NAME = "signalstart-poll";
const OFFSCREEN_URL = new URL("./offscreen.html", import.meta.url);
const UPDATE_PAGES = ["popup.html", "updates.html"].map(page => new URL(page, import.meta.url).href);
let pollingPromise = null;
let offscreenCreating = null;
let bootstrapPromise = null;
let signalWriteQueue = Promise.resolve();
let settingsWriteQueue = Promise.resolve();
let runtimeSyncQueue = Promise.resolve();
let windowSyncQueue = Promise.resolve();
let updateCheck = null;
const activeFetches = new Set();

async function getState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.signals,
    STORAGE_KEYS.settings,
    "monitoringPaused"
  ]);
  const storedSettings = data[STORAGE_KEYS.settings] || {};
  return {
    signals: data[STORAGE_KEYS.signals] || {},
    settings: activeSettings(storedSettings),
    monitoringPaused: data.monitoringPaused === "browser" ? "browser" : ""
  };
}

function activeSettings(stored) {
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(
    ([key, value]) => [key, stored?.[key] ?? value]
  ));
}

async function setSignals(signals) {
  await chrome.storage.local.set({ [STORAGE_KEYS.signals]: signals });
}

function setSettings(changes = {}) {
  const work = settingsWriteQueue.then(async () => {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings] || {};
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { ...stored, ...activeSettings({ ...stored, ...changes }) }
    });
  });
  settingsWriteQueue = work.catch(() => {});
  return work;
}

function updateSignals(change) {
  const work = signalWriteQueue.then(async () => {
    const { signals, settings, monitoringPaused } = await getState();
    const afterSave = [];
    const result = await change(signals, settings, afterSave, monitoringPaused);
    if (result?.save) {
      await setSignals(signals);
      updateBadge(signals);
    }
    return { signals, value: result?.value, afterSave };
  });
  signalWriteQueue = work.catch(() => {});
  return work.then(async result => {
    for (const task of result.afterSave) await task();
    return { signals: result.signals, value: result.value };
  });
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [OFFSCREEN_URL.href]
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === OFFSCREEN_URL.href);
}

async function ensureOffscreen() {
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = (async () => {
    if (await hasOffscreenDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL.pathname.slice(1),
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play a sound for SignalStart desktop notifications."
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("single offscreen document")) return;
      if (await hasOffscreenDocument()) return;
      throw error;
    }
  })().finally(() => {
    offscreenCreating = null;
  });
  await offscreenCreating;
}

function enabledSignals(signals) {
  return Object.values(signals).filter((signal) => signal.enabled !== false);
}

async function pauseMonitoring() {
  await chrome.storage.local.set({ monitoringPaused: "browser" });
  for (const controller of activeFetches) controller.abort();
  await syncWatchingRuntime();
}

function refreshBrowserPresence() {
  const work = windowSyncQueue.then(async () => {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });
    if (!windows.length) {
      await pauseMonitoring();
      return;
    }
    const { monitoringPaused } = await chrome.storage.local.get("monitoringPaused");
    if (monitoringPaused) {
      await chrome.storage.local.set({ monitoringPaused: "" });
      await syncWatchingRuntime();
    }
  });
  windowSyncQueue = work.catch(() => {});
  return work;
}

async function fetchWatchedStats(url) {
  const controller = new AbortController();
  activeFetches.add(controller);
  try { return await fetchSignalStats(url, { signal: controller.signal }); }
  finally { activeFetches.delete(controller); }
}

function syncWatchingRuntime() {
  const work = runtimeSyncQueue.then(async () => {
    const { signals, settings, monitoringPaused } = await getState();
    if (!monitoringPaused && enabledSignals(signals).length) {
      const minutes = pollMinutesFromSettings(settings);
      const alarm = await chrome.alarms.get(ALARM_NAME);
      if (!alarm || alarm.periodInMinutes !== minutes) {
        await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
      }
      return;
    }
    await chrome.alarms.clear(ALARM_NAME);
    if (offscreenCreating) await offscreenCreating;
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  });
  runtimeSyncQueue = work.catch(() => {});
  return work;
}

function updateBadge(signals) {
  const watched = enabledSignals(signals);
  if (!watched.length) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const live = watched.find((signal) => !isZero(signal.floatingValue));
  if (live) {
    const abs = Math.abs(live.floatingValue);
    const text =
      abs >= 100 ? String(Math.round(live.floatingValue)) : abs.toFixed(abs >= 10 ? 0 : 1);
    chrome.action.setBadgeBackgroundColor({
      color: live.floatingValue < 0 ? "#c0392b" : "#1bbc9b"
    });
    chrome.action.setBadgeText({ text: text.slice(0, 4) });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: "#7f8c8d" });
  chrome.action.setBadgeText({ text: "0" });
}

async function playAlertSound() {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ type: "PLAY_SOUND" });
  if (response?.error) throw new Error(response.error);
  if (response?.ok !== true) throw new Error("No response from the alert sound handler.");
}

function notificationIdFor(signal) {
  return `ss-pl-${signal.id}-${crypto.randomUUID()}`;
}

async function notify(
  signal,
  decision,
  settings,
  notificationId = notificationIdFor(signal),
  { reportSoundErrors = false } = {}
) {
  if (settings.notificationsEnabled === false) return false;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getManifest?.().icons?.["128"] ?? "icons/icon128.png",
    title: `${signal.name}: ${decision.title}`,
    message: decision.message,
    priority: 2
  });
  if (settings.playSound) {
    try {
      await playAlertSound();
    } catch (error) {
      if (reportSoundErrors) {
        throw new Error(`Notification created, but sound failed: ${error?.message || String(error)}`);
      }
      console.warn("Could not play alert sound", error);
    }
  }
  return true;
}

async function testNotification() {
  const { settings, monitoringPaused } = await getState();
  if (monitoringPaused) throw new Error("Monitoring is paused. Reopen the extension popup to resume.");
  if (settings.notificationsEnabled === false) {
    throw new Error("Enable notifications in Alerts first.");
  }
  if (await chrome.notifications.getPermissionLevel() === "denied") {
    throw new Error("Chrome has blocked this extension's notifications.");
  }
  await notify(
    { name: "SignalStart Watcher" },
    { title: "Test notification", message: "This is a test alert from SignalStart Watcher." },
    settings,
    `ss-test-${Date.now()}`,
    { reportSoundErrors: true }
  );
  return { ok: true };
}

function applyStats(signal, stats, settings, source, afterSave) {
  const count = Number.isSafeInteger(stats.openTrades) && stats.openTrades >= 0
    ? stats.openTrades : signal.openTrades;
  const tradeKeys = globalThis.SignalStartTradeReader.validateOpenTradeKeys(stats.openTradeKeys, stats.openTrades)
    ?? (count === signal.openTrades ? signal.openTradeKeys : null);
  const previous = {
    floatingValue: signal.floatingValue,
    floatingDisplay: signal.floatingDisplay,
    openTrades: signal.openTrades,
    openTradeKeys: signal.openTradeKeys
  };
  const next = {
    floatingValue: stats.floatingValue,
    floatingDisplay: stats.floatingDisplay,
    openTrades: count,
    openTradeKeys: tradeKeys
  };
  const decision = evaluateAlert(previous, next, settings);
  const duplicateAlert =
    decision.shouldAlert &&
    decision.kind !== "open-trades" &&
    signal.lastAlertAt &&
    Date.now() - signal.lastAlertAt < 5000 &&
    signal.lastKind === decision.kind &&
    signal.floatingDisplay === next.floatingDisplay &&
    signal.openTrades === next.openTrades;
  const updated = {
    ...signal,
    name: tidyName(stats.name, signal.name),
    floatingValue: stats.floatingValue,
    floatingDisplay: stats.floatingDisplay,
    openTrades: count,
    openTradeKeys: tradeKeys ?? null,
    freshness: stats.freshness || signal.freshness,
    lastCheckedAt: Date.now(),
    sampleAt: Number.isFinite(stats.capturedAt) ? stats.capturedAt : Date.now(),
    lastSource: source,
    lastChangePercent: percentChange(previous.floatingValue, next.floatingValue),
    error: null
  };
  if (decision.shouldAlert && !duplicateAlert) {
    afterSave.push(async () => {
      let deliveredKind = null;
      let failure = null;
      try {
        const current = await getState();
        const tracked = current.signals[signal.id];
        if (!current.monitoringPaused && tracked && tracked.enabled !== false) {
          const latestDecision = evaluateAlert(previous, next, current.settings);
          if (latestDecision.shouldAlert && await notify(updated, latestDecision, current.settings)) {
            deliveredKind = latestDecision.kind;
          }
        }
      }
      catch (error) { failure = error; }
      if (failure || deliveredKind) {
        await updateSignals(currentSignals => {
          const current = currentSignals[signal.id];
          if (!current || current.sampleAt !== updated.sampleAt || current.floatingValue !== updated.floatingValue) return { save: false };
          if (failure) current.error = `Desktop notification failed: ${failure?.message || String(failure)}`;
          else { current.lastAlertAt = Date.now(); current.lastKind = deliveredKind; }
          return { save: true };
        });
      }
      if (failure) throw failure;
    });
  }
  return updated;
}

function pollAll() {
  if (!pollingPromise) {
    pollingPromise = runPollAll().finally(() => {
      pollingPromise = null;
    });
  }
  return pollingPromise;
}

async function runPollAll() {
  const { signals, monitoringPaused } = await getState();
  if (monitoringPaused) return;
  const watched = enabledSignals(signals);
  if (!watched.length) {
    updateBadge(signals);
    await syncWatchingRuntime();
    return;
  }
  for (const signal of watched) {
    if ((await getState()).monitoringPaused) break;
    const startedAt = Date.now();
    try {
      const stats = await fetchWatchedStats(signal.url);
      await updateSignals(async (currentSignals, settings, afterSave, paused) => {
        if (paused) return { save: false };
        const current = currentSignals[signal.id];
        if (!current || current.enabled === false) return { save: false };
        if (current.lastSource === "live" && current.lastCheckedAt >= startedAt) {
          return { save: false };
        }
        currentSignals[signal.id] = applyStats(current, stats, settings, "poll", afterSave);
        return { save: true };
      });
    } catch (error) {
      if (error.name === "AbortError") return;
      await updateSignals((currentSignals, settings, afterSave, paused) => {
        if (paused) return { save: false };
        const current = currentSignals[signal.id];
        if (!current || current.enabled === false) return { save: false };
        if (current.lastSource === "live" && current.lastCheckedAt >= startedAt) {
          return { save: false };
        }
        currentSignals[signal.id] = {
          ...current,
          error: error.message || "Poll failed",
          lastCheckedAt: Date.now()
        };
        return { save: true };
      });
    }
  }
}

async function addSignal(input) {
  let parsed = parseAnalysisUrl(input.url || input);
  if (!parsed && input.id && input.url) {
    parsed = parseAnalysisUrl(input.url);
  }
  if (!parsed) {
    throw new Error("Open or paste a SignalStart analysis URL like /analysis/name/123456");
  }
  await updateSignals((currentSignals) => {
    const existing = currentSignals[parsed.id];
    currentSignals[parsed.id] = existing
      ? {
          ...existing,
          enabled: true,
          name: tidyName(input.name, existing.name),
          error: null
        }
      : createTrackedSignal({
          id: parsed.id,
          name: input.name,
          url: parsed.url,
          slug: parsed.slug
        });
    return { save: true };
  });
  await syncWatchingRuntime();
  if ((await getState()).monitoringPaused) return (await getState()).signals[parsed.id];
  const startedAt = Date.now();
  try {
    const stats = await fetchWatchedStats(parsed.url);
    await updateSignals(async (currentSignals, settings, afterSave, paused) => {
      if (paused) return { save: false };
      const current = currentSignals[parsed.id];
      if (!current || current.enabled === false) return { save: false };
      if (current.lastSource === "live" && current.lastCheckedAt >= startedAt) {
        return { save: false };
      }
      currentSignals[parsed.id] = applyStats(current, stats, settings, "poll", afterSave);
      return { save: true };
    });
  } catch (error) {
    if (error.name === "AbortError") return (await getState()).signals[parsed.id];
    await updateSignals((currentSignals, settings, afterSave, paused) => {
      if (paused) return { save: false };
      const current = currentSignals[parsed.id];
      if (!current || current.enabled === false) return { save: false };
      if (current.lastSource === "live" && current.lastCheckedAt >= startedAt) {
        return { save: false };
      }
      current.error = error.message || "Could not read Floating PL yet";
      return { save: true };
    });
  }
  return (await getState()).signals[parsed.id];
}

async function removeSignal(id) {
  await updateSignals(currentSignals => {
    delete currentSignals[id];
    return { save: true };
  });
  await syncWatchingRuntime();
}

async function setSignalEnabled(id, enabled) {
  await updateSignals(currentSignals => {
    if (!currentSignals[id]) return { save: false };
    currentSignals[id].enabled = Boolean(enabled);
    return { save: true };
  });
  await syncWatchingRuntime();
  if (enabled) {
    await pollAll();
  }
}

async function handleLiveStats(payload) {
  const parsed = parseAnalysisUrl(payload.url);
  if (!parsed) return;
  if (
    payload.floatingValue == null ||
    !Number.isFinite(payload.floatingValue)
  ) {
    return;
  }
  await updateSignals(async (signals, settings, afterSave, paused) => {
    if (paused) return { save: false };
    const signal = signals[parsed.id];
    if (!signal || signal.enabled === false) return { save: false };
    if (signal.lastSource === "live" && Number.isFinite(payload.capturedAt) &&
        payload.capturedAt < signal.sampleAt) return { save: false };
    signals[parsed.id] = applyStats(
      signal,
      {
        floatingValue: payload.floatingValue,
        floatingDisplay: payload.floatingDisplay,
        openTrades: payload.openTrades,
        freshness: payload.freshness,
        name: payload.name,
        capturedAt: payload.capturedAt,
        openTradeKeys: payload.openTradeKeys
      },
      settings,
      "live", afterSave
    );
    return { save: true };
  });
}

async function bootstrap({ persistDefaults = false } = {}) {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    await refreshBrowserPresence();
    const { signals } = await getState();
    if (persistDefaults) {
      await setSettings();
    }
    await syncWatchingRuntime();
    if (enabledSignals(signals).length) {
      await pollAll();
    }
    updateBadge((await getState()).signals);
  })().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap({ persistDefaults: true });
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap();
  checkForUpdate();
});

function checkForUpdate() {
  if (!updateCheck) {
    updateCheck = (async () => {
      try {
        const status = await installAvailableUpdate();
        if (status === "installed") chrome.runtime.reload();
        return { status };
      } catch (error) {
        return { error: error.message || String(error) };
      }
    })().finally(() => { updateCheck = null; });
  }
  return updateCheck;
}

chrome.windows.onRemoved.addListener(() => {
  refreshBrowserPresence().catch(error => console.warn("Could not pause monitoring", error));
});
chrome.windows.onCreated.addListener(() => {
  refreshBrowserPresence().catch(error => console.warn("Could not resume monitoring", error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollAll();
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith("ss-test-")) return;
  const { signals } = await getState();
  const match = notificationId.match(/^ss-pl-(\d+)/);
  const signal = match ? signals[match[1]] : enabledSignals(signals)[0];
  if (!signal) return;
  await chrome.tabs.create({ url: signal.url });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise.then(sendResponse).catch((error) => {
      sendResponse({ error: error.message || String(error) });
    });
    return true;
  };

  switch (message?.type) {
    case "GET_STATE":
      return respond(getState());
    case "RESUME_MONITORING":
      return respond(refreshBrowserPresence().then(() => ({ ok: true })));
    case "CHECK_FOR_UPDATE":
      if (!UPDATE_PAGES.includes(sender.url)) return false;
      return respond(checkForUpdate());
    case "ADD_SIGNAL":
      return respond(addSignal(message.payload).then((signal) => ({ signal })));
    case "REMOVE_SIGNAL":
      return respond(removeSignal(message.id).then(() => ({ ok: true })));
    case "SET_ENABLED":
      return respond(
        setSignalEnabled(message.id, message.enabled).then(() => ({ ok: true }))
      );
    case "SAVE_SETTINGS":
      return respond(setSettings(message.settings).then(async () => {
        await syncWatchingRuntime();
        return { ok: true };
      }));
    case "POLL_NOW":
      return respond(pollAll().then(() => ({ ok: true })));
    case "TEST_NOTIFICATION":
      return respond(testNotification());
    case "TEST_MT5":
      return respond(Promise.reject(new Error("The MT5 connection is currently unavailable.")));
    case "TICK":
      pollAll();
      return false;
    case "LIVE_STATS":
      try {
        const origin = new URL(sender.url || "");
        if (origin.protocol !== "https:" ||
            !["www.signalstart.com", "signalstart.com"].includes(origin.hostname) ||
            parseAnalysisUrl(origin.href)?.id !== parseAnalysisUrl(message.payload?.url)?.id) {
          return respond(Promise.reject(new Error("Untrusted SignalStart page.")));
        }
      } catch {
        return respond(Promise.reject(new Error("Untrusted SignalStart page.")));
      }
      return respond(handleLiveStats(message.payload || {}).then(() => ({ ok: true })));
    default:
      return false;
  }
});

bootstrap();
