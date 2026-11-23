(() => {
  const parsed = parseUrl(location.href);
  if (!parsed) return;

  const ui = mountUi();
  let watching = false;
  let observer = null;
  let readTimer = 0;
  let lastReported = null;
  let watchedSignal = null;
  let floatingNode = null;
  let tradesNode = null;
  let contextInvalidated = false;
  let monitoringPaused = "";
  let stateRevision = 0;

  ui.button.addEventListener("click", async () => {
    if (contextInvalidated) {
      location.reload();
      return;
    }
    if (!runtimeAvailable()) return;
    try {
      if (watching) {
        await sendMessage({ type: "REMOVE_SIGNAL", id: parsed.id });
      } else {
        await sendMessage({
          type: "ADD_SIGNAL",
          payload: {
            id: parsed.id,
            name: readName(),
            url: parsed.url
          }
        });
      }
      await refreshWatchState();
    } catch (error) {
      if (!contextInvalidated) ui.status.textContent = `Watcher unavailable: ${error.message || error}`;
    }
  });

  refreshWatchState();
  if (runtimeAvailable()) {
    try {
      chrome.storage?.onChanged?.addListener(onStorageChanged);
    } catch (error) {
      handleContextError(error);
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !runtimeAvailable()) return;
    if (changes.signals || changes.monitoringPaused) stateRevision++;
    if (changes.monitoringPaused) monitoringPaused = changes.monitoringPaused.newValue === "browser" ? "browser" : "";
    if (changes.signals) watchedSignal = changes.signals.newValue?.[parsed.id];
    if (changes.signals || changes.monitoringPaused) applyWatchState();
  }

  function runtimeAvailable() {
    if (contextInvalidated) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch {}
    invalidateContext();
    return false;
  }

  function handleContextError(error) {
    if (/Extension context invalidated/i.test(String(error?.message || error))) {
      // Some Chrome versions throw before runtime.id disappears.
      invalidateContext();
    } else {
      runtimeAvailable();
    }
  }

  function invalidateContext() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    watching = false;
    stopLiveWatchers();
    try { chrome.storage?.onChanged?.removeListener(onStorageChanged); } catch {}
    ui.button.textContent = "Reload page";
    ui.button.disabled = false;
    ui.button.classList.toggle("active", false);
    ui.status.textContent = "Extension disconnected. Reload this page to reconnect.";
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      const failed = error => {
        handleContextError(error);
        // A reload disconnect is terminal for this script, not a retryable rejection.
        if (contextInvalidated) resolve(null);
        else reject(error);
      };
      if (!runtimeAvailable()) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, response => {
          try {
            // Chrome exposes callback failures only while this callback is running.
            const error = chrome.runtime.lastError;
            if (error) failed(new Error(error.message || String(error)));
            else resolve(runtimeAvailable() ? response : null);
          } catch (error) {
            failed(error);
          }
        });
      } catch (error) {
        failed(error);
      }
    });
  }

  async function refreshWatchState() {
    if (!runtimeAvailable()) return;
    const revision = stateRevision;
    try {
      const state = await sendMessage({ type: "GET_STATE" });
      if (!runtimeAvailable()) return;
      if (revision !== stateRevision) return;
      monitoringPaused = state?.monitoringPaused || "";
      watchedSignal = state?.signals?.[parsed.id];
      applyWatchState();
    } catch {
      if (contextInvalidated) return;
      ui.status.textContent = "Watcher unavailable";
      stopLiveWatchers();
    }
  }

  function applyWatchState() {
    const signal = watchedSignal;
    watching = !!(signal && signal.enabled !== false && !monitoringPaused);
    ui.button.disabled = !!monitoringPaused;
    ui.button.textContent = watching ? "Stop watching" : "Watch signal";
    ui.button.classList.toggle("active", watching);
    renderPnl(signal?.floatingDisplay || "—", signal?.floatingValue || 0);
    ui.status.textContent = watching ? "Watching this signal" : signal ? "Watch paused" : "Ready to watch";
    if (monitoringPaused) {
      ui.button.textContent = "Paused";
      ui.status.textContent = "Reopen the extension popup to resume.";
    }
    syncLiveWatchers();
  }

  function syncLiveWatchers() {
    if (watching) startLiveWatchers();
    else stopLiveWatchers();
  }

  function startLiveWatchers() {
    if (observer || !runtimeAvailable()) return;
    observer = new MutationObserver((mutations) => {
      if (!runtimeAvailable()) return;
      const roots = [floatingNode, tradesNode, document.getElementById("openTradesListData")].filter(Boolean);
      if (!readTimer && mutations.some(({ target }) => !ui.root.contains(target) &&
        (!roots.length || roots.some(root => root.isConnected === false || root === target ||
          root.contains?.(target) || target.contains?.(root) || !root.contains)))) {
        // Bound batching latency even if unrelated page animations never stop.
        readTimer = window.setTimeout(readAndReport, 25);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true
    });
    readAndReport();
  }

  function stopLiveWatchers() {
    observer?.disconnect();
    observer = null;
    window.clearTimeout(readTimer);
    readTimer = 0;
    lastReported = null;
  }

  function renderPnl(display, value) {
    ui.pnl.textContent = display;
    ui.pnl.className = "ss-watcher-pnl " +
      (Math.abs(value) < 0.005 ? "zero" : value > 0 ? "pos" : "neg");
  }

  function readAndReport() {
    window.clearTimeout(readTimer);
    readTimer = 0;
    if (!watching || !runtimeAvailable()) return;
    const stats = readStats();
    if (!stats) return;
    renderPnl(stats.floatingDisplay, stats.floatingValue);
    const signature = JSON.stringify([stats.floatingValue, stats.openTrades, stats.openTradeKeys]);
    if (signature === lastReported) return;
    lastReported = signature;
    sendMessage({ type: "LIVE_STATS", payload: stats })
      .then((response) => {
        if (response?.error && lastReported === signature) lastReported = null;
      })
      .catch(() => {
        if (lastReported === signature) lastReported = null;
      });
  }

  function readStats() {
    if (!floatingNode?.isConnected) floatingNode = [...document.querySelectorAll("li.list-group-item")]
      .find(el => /Floating\s*PL/i.test(el.textContent || ""));
    const floatingLi = floatingNode;
    if (!floatingLi) return null;
    const display = (floatingLi.querySelector(".pull-right")?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const value = parseMoney(display);
    if (value == null) return null;

    if (!tradesNode?.isConnected) tradesNode = document.querySelector('a[href="#openTradesListData"]') ||
      [...document.querySelectorAll("a, li")].find((el) =>
        /Open\s*Trades\s*\(/i.test(el.textContent || "")
      );
    const tradesText = tradesNode?.textContent || "";
    const tradesMatch = tradesText.match(/Open\s*Trades\s*\((\d+)\)/i);
    const freshness = document.querySelector(".caption-helper")?.textContent?.trim() || null;

    const openTrades = tradesMatch ? Number(tradesMatch[1]) : null;
    return {
      url: location.href,
      floatingDisplay: display,
      floatingValue: value,
      openTrades,
      openTradeKeys: globalThis.SignalStartTradeReader?.readOpenTradeKeys(document, openTrades) ?? null,
      freshness,
      name: readName(),
      capturedAt: Date.now()
    };
  }

  function parseMoney(text) {
    const decoded = String(text || "").replace(/\s+/g, " ").trim();
    if (!decoded) return null;
    const compact = decoded.replace(/\s+/g, "");
    const negative =
      /^\(.*\)$/.test(compact) ||
      /^[-−–]/.test(compact) ||
      /[-−–][$€£¥]/.test(compact) ||
      /[$€£¥][-−–]/.test(compact);
    const numeric = decoded.replace(/[^\d,.]/g, "").replace(/,/g, "");
    if (!numeric) return null;
    const value = Number(numeric);
    if (!Number.isFinite(value)) return null;
    return negative ? -Math.abs(value) : value;
  }

  function parseUrl(url) {
    const match = String(url).match(
      /(?:https?:\/\/(?:www\.)?signalstart\.com)?\/analysis\/([^/?#]+)\/(\d+)/i
    );
    if (!match) return null;
    return {
      slug: match[1],
      id: match[2],
      url: `https://www.signalstart.com/analysis/${match[1]}/${match[2]}`
    };
  }

  function readName() {
    const heading = document.querySelector("h1");
    if (!heading) return parsed.slug;
    return heading.textContent.replace(/\s*Forex Signals\s*/i, "").trim() || parsed.slug;
  }

  function mountUi() {
    const root = document.createElement("div");
    root.id = "ss-pnl-watcher";
    root.innerHTML = `
      <div class="ss-watcher-copy">
        <strong>SignalStart Watcher</strong>
        <span class="ss-watcher-status" role="status">Ready to watch</span>
      </div>
      <span class="ss-watcher-pnl zero" aria-label="Floating P/L">—</span>
      <button type="button" class="ss-watcher-btn">Watch signal</button>
    `;
    document.documentElement.appendChild(root);
    return {
      root,
      button: root.querySelector(".ss-watcher-btn"),
      status: root.querySelector(".ss-watcher-status"),
      pnl: root.querySelector(".ss-watcher-pnl")
    };
  }
})();
