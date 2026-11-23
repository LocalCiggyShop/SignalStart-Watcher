import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function page({ initialFailure, statePromise, stateFailure } = {}) {
  const messages = [];
  const parts = new Map();
  const timers = new Map();
  const observers = [];
  let serial = 0;
  let storageChanged;
  let listenerRemoved = false;
  let failure = initialFailure;
  let reloads = 0;
  let callbackErrorsRead = 0;
  let floatingDisplay = "$0.00";
  const root = {
    contains(target) { return target === this || [...parts.values()].includes(target); },
    querySelector(selector) {
      if (!parts.has(selector)) parts.set(selector, {
        textContent: "", classList: { toggle() {} },
        addEventListener(type, fn) { this[type] = fn; }
      });
      return parts.get(selector);
    }
  };
  const state = { signals: { "123": { enabled: true } }, settings: {} };
  const runtime = {
    id: "test-extension",
    sendMessage(message, respond) {
      messages.push(message);
      const mode = message.type === "GET_STATE" ? stateFailure : failure;
      if (mode === "sync") throw new Error("Extension context invalidated.");
      if (mode === "async" || mode === "transient") {
        queueMicrotask(() => {
          Object.defineProperty(runtime, "lastError", { configurable: true, get() {
            callbackErrorsRead++;
            return { message: mode === "async" ? "Extension context invalidated." : "Could not establish connection." };
          } });
          try { respond(); }
          finally { delete runtime.lastError; }
        });
      } else if (message.type === "GET_STATE") {
        (statePromise || Promise.resolve(state)).then(respond);
      } else {
        queueMicrotask(() => respond({ ok: true }));
      }
    }
  };
  vm.runInNewContext(source, {
    location: { href: "https://www.signalstart.com/analysis/example/123", reload() { reloads++; } },
    chrome: { runtime, storage: { onChanged: {
      addListener(fn) { storageChanged = fn; },
      removeListener(fn) { assert.equal(fn, storageChanged); listenerRemoved = true; }
    } } },
    window: {
      setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    MutationObserver: class {
      constructor(fn) { this.callback = fn; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    document: {
      documentElement: { appendChild() {} },
      createElement() { return root; },
      getElementById() { return null; },
      querySelector(selector) { return selector === "h1" ? { textContent: "Example" } : null; },
      querySelectorAll(selector) {
        return selector === "li.list-group-item"
          ? [{ textContent: "Floating PL", querySelector() { return { textContent: floatingDisplay }; } }]
          : [{ textContent: "Open Trades (0)" }];
      }
    },
    SignalStartTradeReader: { readOpenTradeKeys() { return []; } }
  });
  return {
    messages, parts, timers, observers, runtime, state,
    set failure(value) { failure = value; },
    get reloads() { return reloads; },
    get callbackErrorsRead() { return callbackErrorsRead; },
    get listenerRemoved() { return listenerRemoved; },
    set floatingDisplay(value) { floatingDisplay = value; },
    queueRead() {
      observers.at(-1).callback([{ target: {} }]);
      return [...timers.values()][0]?.fn;
    },
    storage(changes) { storageChanged(changes, "local"); }
  };
}

function assertDisconnected(p) {
  assert.equal(p.parts.get(".ss-watcher-btn").textContent, "Reload page");
  assert.match(p.parts.get(".ss-watcher-status").textContent, /Reload this page/);
  assert.equal(p.timers.size, 0, "all polling and pending reads stop");
  assert.ok(p.observers.every(observer => observer.disconnected));
  assert.ok(p.listenerRemoved);
}

for (const failure of ["sync", "async"]) {
  test(`handles ${failure} invalidation during a live report and ignores stale callbacks`, async () => {
    const p = page();
    await flush();
    const observer = p.observers[0];
    p.floatingDisplay = "$1.00";
    const read = p.queueRead();
    p.failure = failure;
    assert.doesNotThrow(read);
    await flush();
    assertDisconnected(p);
    if (failure === "async") assert.equal(p.callbackErrorsRead, 1, "Chrome's callback error is consumed");
    const count = p.messages.length;
    read();
    observer.callback([{ target: {} }]);
    p.storage({ signals: { newValue: p.state.signals }, settings: { newValue: p.state.settings } });
    await flush();
    assert.equal(p.messages.length, count);
    assertDisconnected(p);
    await p.parts.get(".ss-watcher-btn").click();
    assert.equal(p.reloads, 1);
  });

  test(`handles ${failure} invalidation on the first live report without restarting the timer`, async () => {
    const p = page({ initialFailure: failure });
    await flush();
    assertDisconnected(p);
  });
}

for (const failure of ["sync", "async"]) {
  test(`handles ${failure} invalidation during the initial state request`, async () => {
    const p = page({ stateFailure: failure });
    await flush();
    assert.equal(p.parts.get(".ss-watcher-btn").textContent, "Reload page");
    assert.equal(p.timers.size, 0);
    assert.equal(p.observers.length, 0);
    assert.equal(p.messages.length, 1);
    if (failure === "async") assert.equal(p.callbackErrorsRead, 1);
  });
}

test("runtime invalidation while reading callback lastError is contained", async () => {
  const p = page();
  await flush();
  Object.defineProperty(p.runtime, "lastError", { configurable: true, get() {
    throw new Error("Extension context invalidated.");
  } });
  p.floatingDisplay = "$2.00";
  p.queueRead()();
  await flush();
  assertDisconnected(p);
});

test("notices a missing runtime ID before sending another report", async () => {
  const p = page();
  await flush();
  delete p.runtime.id;
  const count = p.messages.length;
  p.queueRead();
  assertDisconnected(p);
  assert.equal(p.messages.length, count);
});

test("watch button handles invalidation without an unhandled rejection", async () => {
  const p = page();
  await flush();
  p.failure = "sync";
  await assert.doesNotReject(p.parts.get(".ss-watcher-btn").click());
  assertDisconnected(p);
});

test("a late state reply cannot restart a disconnected watcher", async () => {
  let resolve;
  const p = page({ statePromise: new Promise(done => { resolve = done; }) });
  delete p.runtime.id;
  p.storage({ settings: { newValue: p.state.settings } });
  resolve(p.state);
  await flush();
  assertDisconnected(p);
  assert.equal(p.observers.length, 0);
});

test("transient delivery failures keep the watcher active and allow the next report", async () => {
  const p = page();
  await flush();
  p.failure = "transient";
  p.floatingDisplay = "$3.00";
  p.queueRead()();
  await flush();
  assert.equal(p.parts.get(".ss-watcher-btn").textContent, "Stop watching");
  assert.equal(p.timers.size, 0);
  p.failure = null;
  const count = p.messages.length;
  p.queueRead()();
  await flush();
  assert.equal(p.messages.length, count + 1, "unchanged data is retried after failed delivery");
});

test("browser pause clears pending DOM reads, then resumes without losing the watched signal", async () => {
  const p = page();
  await flush();
  const observer = p.observers[0];
  const read = p.queueRead();
  p.storage({ monitoringPaused: { newValue: "browser" } });
  assert.equal(p.timers.size, 0);
  assert.ok(observer.disconnected);
  assert.equal(p.parts.get(".ss-watcher-btn").disabled, true);
  const count = p.messages.length;
  read();
  await flush();
  assert.equal(p.messages.length, count);
  p.storage({ monitoringPaused: { newValue: "" } });
  await flush();
  assert.equal(p.parts.get(".ss-watcher-btn").disabled, false);
  assert.equal(p.parts.get(".ss-watcher-btn").textContent, "Stop watching");
  assert.equal(p.messages.length, count + 1);
  assert.equal(p.timers.size, 0);
});
