import { DEFAULT_SETTINGS, parseAnalysisUrl, searchSignals, isZero, formatPercent, pollMinutesFromSettings } from "./shared.js";

const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchStatus = document.getElementById("searchStatus");
const trackPageBtn = document.getElementById("trackPageBtn");
const refreshBtn = document.getElementById("refreshBtn");
const signalList = document.getElementById("signalList");
const emptyState = document.getElementById("emptyState");
const watchCount = document.getElementById("watchCount");
const alertOnLeaveZero = document.getElementById("alertOnLeaveZero");
const alertOnAnyChange = document.getElementById("alertOnAnyChange");
const alertOnOpenTrades = document.getElementById("alertOnOpenTrades");
const alertOnDrawdown = document.getElementById("alertOnDrawdown");
const drawdownFields = document.getElementById("drawdownFields");
const drawdownAmount = document.getElementById("drawdownAmount");
const drawdownError = document.getElementById("drawdownError");
const playSound = document.getElementById("playSound");
const pollMinutes = document.getElementById("pollMinutes");
const changePercent = document.getElementById("changePercent");
const notifyStatus = document.getElementById("notifyStatus");
const notifyToggleBtn = document.getElementById("notifyToggleBtn");
const testNotificationBtn = document.getElementById("testNotificationBtn");
const testNotificationStatus = document.getElementById("testNotificationStatus");
const settingsStatus = document.getElementById("settingsStatus");

document.getElementById("versionLabel").textContent = `Version ${chrome.runtime.getManifest().version}`;

let searchTimer = 0;
let searchRevision = 0;
let settings = {};
let testing = false;
const ruleInputs = { alertOnOpenTrades, alertOnLeaveZero, alertOnAnyChange, playSound };

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchRevision++;
  const query = searchInput.value.trim();
  renderResults([]);
  searchStatus.textContent = query ? "Searching…" : "";
  if (query) searchTimer = window.setTimeout(() => runSearch(query), 220);
});

searchInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  window.clearTimeout(searchTimer);
  const results = await runSearch(searchInput.value.trim());
  if (results.length === 1) await trackSignal(results[0]);
});

trackPageBtn.addEventListener("click", trackCurrentPage);
refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Checking…";
  const response = await send("POLL_NOW");
  if (response.error) searchStatus.textContent = response.error;
  await loadState();
  refreshBtn.textContent = "Check now";
  refreshBtn.disabled = false;
});

for (const [key, input] of Object.entries(ruleInputs)) {
  input.addEventListener("change", () => saveSettings({ [key]: input.checked }));
}
alertOnDrawdown.addEventListener("change", saveDrawdown);
drawdownAmount.addEventListener("change", saveDrawdown);
pollMinutes.addEventListener("change", () => saveSettings({ pollMinutes: Number(pollMinutes.value) }));
changePercent.addEventListener("change", () => saveSettings({ changePercent: Math.max(0, Number(changePercent.value) || 0) }));

notifyToggleBtn.addEventListener("click", async () => {
  notifyToggleBtn.disabled = true;
  await saveSettings({ notificationsEnabled: settings.notificationsEnabled === false });
  notifyToggleBtn.disabled = false;
});

testNotificationBtn.addEventListener("click", async () => {
  testing = true;
  testNotificationBtn.disabled = true;
  testNotificationStatus.classList.remove("error");
  testNotificationStatus.textContent = "Sending test…";
  try {
    const response = await send("TEST_NOTIFICATION");
    const error = response.error ||
      (response.ok === true ? "" : "No confirmation received from the notification handler.");
    testNotificationStatus.classList.toggle("error", !!error);
    testNotificationStatus.textContent = error || "Chrome accepted the test notification.";
  } finally {
    testing = false;
    testNotificationBtn.disabled = settings.notificationsEnabled === false;
  }
});

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) applySettings(changes.settings.newValue || {});
  if (changes.signals) renderSignals(changes.signals.newValue || {});
});

await send("RESUME_MONITORING");
await loadState({ includeSettings: true });
send("CHECK_FOR_UPDATE").then(result => {
  if (result.error) document.getElementById("updateStatus").textContent = result.error;
});

async function loadState({ includeSettings = false } = {}) {
  const next = await send("GET_STATE");
  if (next.error) {
    searchStatus.textContent = next.error;
    return;
  }
  if (includeSettings) applySettings(next.settings || {});
  renderSignals(next.signals || {});
}

function applySettings(next, { all = false } = {}) {
  const previous = settings;
  settings = { ...DEFAULT_SETTINGS, ...next };
  for (const [key, input] of Object.entries(ruleInputs)) {
    if (all || settings[key] !== previous[key]) input.checked = settings[key] !== false;
  }
  if (all || settings.alertOnDrawdown !== previous.alertOnDrawdown ||
      settings.drawdownAmount !== previous.drawdownAmount) {
    alertOnDrawdown.checked = settings.alertOnDrawdown === true;
    drawdownAmount.value = String(settings.drawdownAmount);
    showDrawdownFields();
  }
  if (all || settings.pollMinutes !== previous.pollMinutes) {
    pollMinutes.value = String(pollMinutesFromSettings(settings));
  }
  if (all || settings.changePercent !== previous.changePercent) {
    changePercent.value = String(Number(settings.changePercent) || 0);
  }

  const notificationsOn = settings.notificationsEnabled !== false;
  notifyStatus.textContent = notificationsOn ? "On" : "Off";
  notifyToggleBtn.setAttribute("aria-checked", String(notificationsOn));
  testNotificationBtn.disabled = testing || !notificationsOn;
}

function showDrawdownFields() {
  drawdownFields.classList.toggle("hidden", !alertOnDrawdown.checked);
  drawdownAmount.disabled = !alertOnDrawdown.checked;
  drawdownError.textContent = "";
  drawdownError.classList.toggle("hidden", true);
}

async function saveDrawdown() {
  showDrawdownFields();
  if (!alertOnDrawdown.checked) {
    await saveSettings({ alertOnDrawdown: false });
    return;
  }
  const amount = Number(drawdownAmount.value);
  if (!Number.isFinite(amount) || amount < 0.01) {
    drawdownError.textContent = "Enter a loss amount of at least 0.01.";
    drawdownError.classList.toggle("hidden", false);
    return;
  }
  await saveSettings({ alertOnDrawdown: true, drawdownAmount: amount });
}

async function saveSettings(changes) {
  settingsStatus.textContent = "";
  const response = await send("SAVE_SETTINGS", { settings: changes });
  if (response.ok) {
    applySettings({ ...settings, ...changes });
  } else {
    applySettings(settings, { all: true });
    settingsStatus.textContent = response.error || "Could not save settings.";
  }
}

async function runSearch(query) {
  if (!query) return [];
  const revision = ++searchRevision;
  searchStatus.textContent = "Searching…";
  try {
    const results = await searchSignals(query);
    if (revision !== searchRevision) return [];
    renderResults(results);
    searchStatus.textContent = results.length
      ? `Showing ${Math.min(8, results.length)} of ${results.length} matching signals.`
      : "No signals found. Try another name or paste an analysis URL.";
    return results;
  } catch (error) {
    if (revision !== searchRevision) return [];
    renderResults([]);
    searchStatus.textContent = error.message || "Search failed.";
    return [];
  }
}

function renderResults(results) {
  searchResults.innerHTML = "";
  searchResults.classList.toggle("hidden", !results.length);
  for (const signal of results.slice(0, 8)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = '<strong></strong><span class="meta"></span>';
    button.querySelector("strong").textContent = signal.name;
    button.querySelector(".meta").textContent = signal.url.replace("https://www.signalstart.com", "");
    button.addEventListener("click", () => trackSignal(signal));
    item.appendChild(button);
    searchResults.appendChild(item);
  }
}

async function trackSignal(signal) {
  const response = await send("ADD_SIGNAL", { payload: signal });
  if (!response.signal) {
    searchStatus.textContent = response.error || "Could not follow this signal.";
    return;
  }
  window.clearTimeout(searchTimer);
  searchRevision++;
  searchInput.value = "";
  renderResults([]);
  searchStatus.textContent = `Watching ${response.signal.name}.`;
  await loadState();
}

async function trackCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const parsed = parseAnalysisUrl(tab?.url || "");
  if (!parsed) {
    searchStatus.textContent = "Open a SignalStart analysis page to use this button.";
    return;
  }
  await trackSignal({
    id: parsed.id,
    name: parsed.slug.replace(/-/g, " "),
    url: parsed.url
  });
}

function renderSignals(signals) {
  const list = Object.values(signals);
  const active = list.filter(signal => signal.enabled !== false).length;
  const focused = document.activeElement;
  watchCount.textContent = list.length ? `${active} active` : "";
  emptyState.classList.toggle("hidden", list.length > 0);
  signalList.innerHTML = "";

  for (const signal of list) {
    const item = document.createElement("li");
    item.className = "signal";
    const tone = plTone(signal.floatingValue);
    item.innerHTML = `
      <p class="signal-name"></p>
      <span class="pl ${tone}"></span>
      <p class="meta"></p>
      <div class="signal-actions">
        <button class="secondary toggle" type="button"></button>
        <button class="secondary open" type="button">Open</button>
        <button class="remove" type="button">Remove</button>
      </div>
      <p class="error"></p>
    `;
    item.querySelector(".signal-name").textContent = signal.name;
    const pct = formatPercent(signal.lastChangePercent);
    const display = signal.floatingDisplay || "—";
    item.querySelector(".pl").textContent = pct ? `${display} (${pct})` : display;
    item.querySelector(".meta").textContent = describeSignal(signal);
    item.querySelector(".error").textContent = signal.error || "";
    const toggle = item.querySelector(".toggle");
    toggle.textContent = signal.enabled === false ? "Resume" : "Pause";
    toggle.addEventListener("click", () => changeSignal("SET_ENABLED", signal, {
      enabled: signal.enabled === false
    }));
    const open = item.querySelector(".open");
    open.addEventListener("click", () => chrome.tabs.create({ url: signal.url }));
    const remove = item.querySelector(".remove");
    remove.addEventListener("click", () => changeSignal("REMOVE_SIGNAL", signal));
    for (const [action, button] of Object.entries({ toggle, open, remove })) {
      button.setAttribute("aria-label", `${button.textContent} ${signal.name}`);
      button.dataset.signal = signal.id;
      button.dataset.action = action;
    }
    signalList.appendChild(item);
    if (focused?.dataset?.signal === signal.id) {
      item.querySelector(`.${focused.dataset.action}`)?.focus();
    }
  }
}

async function changeSignal(type, signal, payload) {
  const response = await send(type, { id: signal.id, ...payload });
  if (response.error) searchStatus.textContent = response.error;
  await loadState();
}

function describeSignal(signal) {
  const count = signal.openTrades;
  const details = [signal.enabled === false ? "Paused" : "Watching"];
  if (Number.isFinite(count)) details.push(`${count} open ${count === 1 ? "trade" : "trades"}`);
  details.push(signal.lastCheckedAt ? `Checked ${timeAgo(signal.lastCheckedAt)}` : "Waiting for first check");
  return details.join(" · ");
}

function plTone(value) {
  if (value == null || isZero(value)) return "zero";
  return value > 0 ? "up" : "down";
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

async function send(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, ...payload })) || {};
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}
