import assert from "node:assert/strict";
import test from "node:test";

const messages = [];
const parts = new Map();
const root = {
  innerHTML: "",
  id: "",
  contains(target) { return target === this || parts.has(target); },
  querySelector(selector) {
    if (!parts.has(selector)) {
      parts.set(selector, {
        textContent: "",
        className: "",
        classList: { toggle() {} },
        addEventListener() {}
      });
    }
    return parts.get(selector);
  }
};
let floatingDisplay = "$0.00";
let observer;
let openTrades = 0;
let openDate = "16/10/2026";
const tradeTable = {
  querySelectorAll(selector) {
    if (selector === "thead th") return [{ textContent: "Open Date" }, { textContent: "Symbol" }];
    return [{ querySelectorAll: () => [{ textContent: openDate }, { textContent: "US30" }] }];
  }
};

globalThis.location = { href: "https://www.signalstart.com/analysis/example/123" };
globalThis.window = { setTimeout, clearTimeout };
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; observer = this; }
  observe() {}
  disconnect() {}
};
globalThis.document = {
  documentElement: { appendChild() {} },
  createElement() { return root; },
  getElementById() { return { querySelector() { return tradeTable; } }; },
  querySelector(selector) {
    if (selector === "h1") return { textContent: "Example Forex Signals" };
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "li.list-group-item") {
      return [{
        textContent: "Floating PL",
        querySelector() { return { textContent: floatingDisplay }; }
      }];
    }
    return [{ textContent: `Open Trades (${openTrades})` }];
  }
};
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    sendMessage(message, respond) {
      if (message.type === "GET_STATE") {
        respond({ signals: { "123": { enabled: true, floatingDisplay: "$0.00" } }, settings: {} });
        return;
      }
      messages.push(message);
      respond({ ok: true });
    }
  }
};

await import("../trade-reader.js");
await import("../content.js");

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for page watcher");
}

test("reports later page changes without repeating unchanged values", async () => {
  await waitFor(() => messages.length === 1);
  assert.equal(messages[0].payload.floatingValue, 0);

  floatingDisplay = "$10.00";
  observer.callback([{ target: {} }]);
  await waitFor(() => messages.length === 2);
  assert.equal(messages[1].payload.floatingValue, 10);

  observer.callback([{ target: {} }]);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(messages.length, 2);
});

test("reports open trades and row replacements even when Floating PL is unchanged", async () => {
  const count = messages.length;
  openTrades = 1;
  observer.callback([{ target: {} }]);
  await waitFor(() => messages.length === count + 1);
  assert.equal(messages.at(-1).payload.floatingValue, 10);
  assert.equal(messages.at(-1).payload.openTrades, 1);
  assert.deepEqual(messages.at(-1).payload.openTradeKeys, ['["16/10/2026","US30"]']);

  openDate = "17/10/2026";
  observer.callback([{ target: {} }]);
  await waitFor(() => messages.length === count + 2);
  assert.deepEqual(messages.at(-1).payload.openTradeKeys, ['["17/10/2026","US30"]']);
});
