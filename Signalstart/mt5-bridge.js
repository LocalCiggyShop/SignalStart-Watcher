export const MT5_HOST = "com.signalstart.mt5_bridge";

const clean = (value, max = 300) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
export function mt5CheckSeconds(settings) {
  const seconds = Number(settings?.mt5CheckSeconds);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : 5;
}

export function mt5Snapshot(state, now = Date.now()) {
  const id = String(state.settings?.mt5SignalId || "");
  const signal = state.signals?.[id];
  const usable = /^\d+$/.test(id) && signal?.enabled !== false &&
    signal && Number.isFinite(signal.floatingValue);
  return {
    schema: 2,
    checkSeconds: mt5CheckSeconds(state.settings),
    generatedAt: now,
    enabled: !!usable,
    notificationsEnabled: state.settings?.notificationsEnabled !== false,
    signal: usable ? {
      id, name: clean(signal.name),
      floatingValue: signal.floatingValue,
      floatingDisplay: clean(signal.floatingDisplay),
      openTrades: Number.isInteger(signal.openTrades) && signal.openTrades >= 0 ? signal.openTrades : -1,
      cycleHadMultiple: signal.cycleHadMultiple === true,
      sampleAt: Number.isFinite(signal.sampleAt) ? signal.sampleAt : signal.lastCheckedAt || 0,
      source: signal.lastSource === "live" ? "live" : "poll",
      error: clean(signal.error),
      tradeDetails: globalThis.SignalStartTradeReader.validate(signal.tradeDetails, signal.openTrades)
    } : null,
    alerts: /^\d+$/.test(id) ? (state.mt5Alerts || []).filter(event =>
      /^\d+$/.test(String(event.signalId)) && Number.isFinite(event.at) && event.at <= now && now - event.at < 120000
    ).slice(-100).map(event => ({
      id: clean(event.id, 80), at: event.at, signalId: String(event.signalId),
      title: clean(event.title), message: clean(event.message, 600)
    })) : []
  };
}

// One in-flight write preserves order. A native port also keeps the MV3 worker alive.
export function createMt5Bridge({ readState, writeStatus, runtime, onTerminalClosed = () => {}, onHelperClosed = () => {} }) {
  let port = null;
  let desired = false;
  let busy = false;
  let dirty = false;
  let heartbeat = null;
  let timeout = null;
  let sequence = 0;
  let pendingId = null;
  let heartbeatSeconds = 0;
  let lastStatus = null;
  let disposed = false;
  let generation = 0;

  const status = value => {
    if (lastStatus && value.state === lastStatus.state && value.error === lastStatus.error &&
        Date.now() - (lastStatus.writtenAt || 0) < 10000) return Promise.resolve();
    lastStatus = { ...value, writtenAt: value.writtenAt || Date.now() };
    return Promise.resolve(writeStatus(value)).catch(() => {});
  };
  function disconnected(current, error) {
    if (port !== current) return;
    const wasDesired = desired;
    dispose();
    if (!wasDesired) disposed = false;
    status({ state: wasDesired ? "error" : "disabled", error: wasDesired ? error : "" });
    if (wasDesired) Promise.resolve(onHelperClosed(error)).catch(() => {});
  }
  function connect() {
    if (port) return port;
    const current = runtime.connectNative(MT5_HOST);
    port = current;
    current.onDisconnect.addListener(() => disconnected(current,
      runtime.lastError?.message || "The local MT5 helper disconnected."));
    current.onMessage.addListener(message => {
      if (port !== current || message?.requestId !== pendingId) return;
      if (message.mt5Running === false) {
        dispose();
        status({ state: "paused", error: "MT5 is closed. Open MT5, then reopen this popup to resume." });
        Promise.resolve(onTerminalClosed()).catch(() => {});
        return;
      }
      clearTimeout(timeout);
      busy = false;
      pendingId = null;
      status(message.ok === true
        ? { state: desired ? "ready" : "disabled", error: "", writtenAt: Date.now() }
        : { state: "error", error: message.error || "The MT5 helper did not confirm the write." });
      if (!desired) {
        port = null;
        current.disconnect();
      } else if (dirty) publish();
    });
    return current;
  }
  async function publish() {
    if (disposed) return;
    dirty = true;
    if (busy) return;
    busy = true;
    dirty = false;
    const started = generation;
    try {
      const state = await readState();
      if (disposed || started !== generation) return;
      desired = !state.monitoringPaused && /^\d+$/.test(String(state.settings?.mt5SignalId || ""));
      const seconds = mt5CheckSeconds(state.settings);
      if (desired && (!heartbeat || heartbeatSeconds !== seconds)) {
        clearInterval(heartbeat);
        heartbeatSeconds = seconds;
        heartbeat = setInterval(publish, seconds * 1000);
        heartbeat.unref?.();
      } else if (!desired) {
        clearInterval(heartbeat);
        heartbeat = null;
        if (!port) {
          busy = false;
          dirty = false;
          await status({ state: "disabled", error: "" });
          return;
        }
      }
      const current = connect();
      pendingId = String(++sequence);
      timeout = setTimeout(() => {
        disconnected(current, "The local MT5 helper did not respond within 5 seconds.");
        current.disconnect();
      }, 5000);
      timeout.unref?.();
      const snapshot = mt5Snapshot(state);
      current.postMessage({ ...snapshot,
        ...(state.monitoringPaused ? { enabled: false, signal: null, alerts: [] } : {}), requestId: pendingId });
    } catch (error) {
      if (disposed || started !== generation) return;
      busy = false;
      clearTimeout(timeout);
      const current = port;
      if (current) {
        disconnected(current, error?.message || String(error));
        current.disconnect();
      } else {
        const wasDesired = desired;
        if (wasDesired) dispose();
        await status({ state: "error", error: error?.message || String(error) });
        if (wasDesired) await onHelperClosed(error?.message || String(error));
      }
    }
  }
  function dispose() {
    disposed = true;
    generation++;
    desired = false;
    busy = dirty = false;
    pendingId = null;
    clearInterval(heartbeat);
    clearTimeout(timeout);
    heartbeat = timeout = null;
    const current = port;
    port = null;
    current?.disconnect();
  }
  function resume() {
    disposed = false;
    return publish();
  }
  return { publish, dispose, resume };
}
import "./trade-reader.js";

