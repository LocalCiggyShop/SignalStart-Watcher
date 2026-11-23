import assert from "node:assert/strict";
import test from "node:test";
import { mt5Snapshot, mt5CheckSeconds, createMt5Bridge, MT5_HOST } from "../mt5-bridge.js";

function state() {
  return { settings: { mt5SignalId: "123" }, signals: { "123": {
    id: "123", name: "Example", enabled: true, floatingValue: -10,
    floatingDisplay: "-$10", openTrades: 3, sampleAt: 1000, lastSource: "live"
  } }, mt5Alerts: [
    { id: "a", signalId: "123", at: 1000, title: "PL changed", message: "Three trades" },
    { id: "b", signalId: "456", at: 1001, title: "Other signal", message: "Also mirror this" }
  ] };
}

test("publishes the selected signal and mirrors alerts from every watched signal", () => {
  const snapshot = mt5Snapshot(state(), 1100);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.signal.id, "123");
  assert.equal(snapshot.signal.openTrades, 3);
  assert.deepEqual(snapshot.alerts.map(alert => alert.signalId), ["123", "456"]);
  const paused = state(); paused.signals["123"].enabled = false;
  assert.equal(mt5Snapshot(paused, 1100).enabled, false);
  assert.equal(mt5Snapshot(paused, 1100).alerts.length, 2);
  paused.settings.mt5SignalId = "";
  assert.equal(mt5Snapshot(paused, 1100).alerts.length, 0);
});

test("sanitizes page text, omits invalid numbers and expires old alerts", () => {
  const input = state();
  input.signals["123"].name = "a\tbad\nname";
  input.mt5Alerts.push({ id: "old", signalId: "123", at: 1, title: "old" });
  const snapshot = mt5Snapshot(input, 121000);
  assert.equal(snapshot.signal.name, "a bad name");
  assert.deepEqual(snapshot.alerts.map(alert => alert.id), ["b"]);
  input.signals["123"].floatingValue = NaN;
  assert.equal(mt5Snapshot(input).signal, null);
});

test("defaults to five seconds and carries only validated automatic source trade details",()=>{
  assert.equal(mt5Snapshot(state()).checkSeconds,5);
  assert.equal(mt5CheckSeconds({mt5CheckSeconds:10}),10);
  for(const seconds of [0,1.5,61,NaN]) assert.equal(mt5CheckSeconds({mt5CheckSeconds:seconds}),5);
  const value=state();value.settings.mt5CheckSeconds=10;
  value.signals["123"].openTrades=1;
  value.signals["123"].tradeDetails={status:"ready",symbol:"US30",lots:.1,sl:0,tp:0,side:-1,identity:"source"};
  const snapshot=mt5Snapshot(value);
  assert.equal(snapshot.checkSeconds,10);assert.equal(snapshot.signal.tradeDetails.symbol,"US30");
  assert.equal(snapshot.signal.tradeDetails.lots,.1);
});

function harness(onTerminalClosed = () => {}, onHelperClosed = () => {}) {
  let current = state();
  const writes = [], statuses = [];
  let connections = 0, disconnects = 0;
  let message, disconnect;
  const port = {
    onMessage: { addListener(fn) { message = fn; } },
    onDisconnect: { addListener(fn) { disconnect = fn; } },
    postMessage(value) { writes.push(value); },
    disconnect() { disconnects++; disconnect(); }
  };
  const runtime = { connectNative(name) { connections++; assert.equal(name, MT5_HOST); return port; } };
  const bridge = createMt5Bridge({ readState: async () => structuredClone(current), runtime,
    writeStatus: async value => { statuses.push(value); }, onTerminalClosed, onHelperClosed });
  return { bridge, writes, statuses, runtime, port,
    setState(value) { current = value; },
    get connections() { return connections; },
    get disconnects() { return disconnects; },
    reply(value) { message({ requestId: writes.at(-1).requestId, ...value }); },
    ack() { message({ ok: true, requestId: writes.at(-1).requestId }); },
    disconnect() { disconnect(); }
  };
}

test("serializes writes, sends the newest queued update and acknowledges disabling", async () => {
  const h = harness();
  try {
    await h.bridge.publish();
    assert.equal(h.writes.length, 1);
    const next = state(); next.signals["123"].floatingValue = -20;
    h.setState(next); await h.bridge.publish();
    assert.equal(h.writes.length, 1);
    h.ack(); await Promise.resolve();
    assert.equal(h.writes.at(-1).signal.floatingValue, -20);
    next.settings.mt5SignalId = "";
    h.setState(next); await h.bridge.publish(); h.ack(); await Promise.resolve();
    assert.equal(h.writes.at(-1).enabled, false);
    h.ack();
    assert.equal(h.statuses.at(-1).state, "disabled");
  } finally { h.bridge.dispose(); }
});

test("MT5 closure disconnects the port and cannot reconnect until explicitly resumed", async () => {
  let closed = 0;
  const h = harness(() => { closed++; });
  try {
    await h.bridge.publish();
    h.reply({ ok: true, mt5Running: false });
    assert.equal(h.disconnects, 1);
    assert.equal(closed, 1);
    assert.equal(h.statuses.at(-1).state, "paused");
    await h.bridge.publish();
    await h.bridge.publish();
    assert.equal(h.connections, 1);
    await h.bridge.resume();
    assert.equal(h.connections, 2);
  } finally { h.bridge.dispose(); }
});

test("disposing while storage is pending cannot reopen the native host", async () => {
  let finish;
  let connections = 0;
  const bridge = createMt5Bridge({
    readState: () => new Promise(resolve => { finish = resolve; }),
    writeStatus: async () => {},
    runtime: { connectNative() { connections++; throw new Error("Must stay stopped"); } }
  });
  const pending = bridge.publish();
  bridge.dispose();
  finish(state());
  await pending;
  assert.equal(connections, 0);
});

test("shows the actual native-host error and cancels reconnects on disposal", async () => {
  const h = harness();
  await h.bridge.publish();
  h.runtime.lastError = { message: "Specified native messaging host not found." };
  h.disconnect();
  assert.equal(h.statuses.at(-1).error, h.runtime.lastError.message);
  h.bridge.dispose();
});

test("ending the helper cancels heartbeats and reconnects until explicit resumption", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let stopped = 0;
  const h = harness(() => {}, () => { stopped++; });
  try {
    await h.bridge.publish();
    h.ack();
    h.disconnect();
    assert.equal(stopped, 1);
    t.mock.timers.tick(30000);
    await Promise.resolve();
    await h.bridge.publish();
    assert.equal(h.connections, 1, "no timer or data update can relaunch a stopped helper");
    await h.bridge.resume();
    assert.equal(h.connections, 2);
  } finally { h.bridge.dispose(); }
});

test("a failed helper launch reports its error once and does not retry in the background", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let attempts = 0, stopped = 0;
  const statuses = [];
  const bridge = createMt5Bridge({ readState: async () => state(),
    writeStatus: async value => { statuses.push(value); },
    onHelperClosed: error => { stopped++; assert.match(error, /not found/); },
    runtime: { connectNative() { attempts++; throw new Error("Native host not found."); } }
  });
  try {
    await bridge.publish();
    t.mock.timers.tick(30000);
    await Promise.resolve();
    await bridge.publish();
    assert.equal(attempts, 1);
    assert.equal(stopped, 1);
    assert.equal(statuses.at(-1).error, "Native host not found.");
  } finally { bridge.dispose(); }
});
