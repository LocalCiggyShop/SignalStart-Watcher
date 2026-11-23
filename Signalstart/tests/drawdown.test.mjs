import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAlert } from "../shared.js";

const settings = {
  alertOnLeaveZero: false,
  alertOnAnyChange: false,
  alertOnOpenTrades: false,
  alertOnDrawdown: true,
  drawdownAmount: 100
};

function stats(value) {
  return { floatingValue: value, floatingDisplay: `$${value.toFixed(2)}`, openTrades: 0 };
}

test("alerts at the exact loss threshold or when a move skips past it", () => {
  assert.equal(evaluateAlert(stats(-90), stats(-99.99), settings).shouldAlert, false);
  const decision = evaluateAlert(stats(-99.99), stats(-100), settings);
  assert.equal(decision.kind, "drawdown");
  assert.equal(decision.shouldAlert, true);
  assert.match(decision.message, /\$-100\.00/);
  assert.match(decision.message, /threshold of 100/);
  assert.equal(evaluateAlert(stats(25), stats(-150), settings).kind, "drawdown");
  assert.equal(evaluateAlert(stats(-25), stats(-25.5), {
    ...settings, drawdownAmount: 25.5
  }).kind, "drawdown");
});

test("alerts once per crossing and rearms after recovery above the threshold", () => {
  assert.equal(evaluateAlert(stats(-100), stats(-150), settings).shouldAlert, false);
  assert.equal(evaluateAlert(stats(-150), stats(-120), settings).shouldAlert, false);
  assert.equal(evaluateAlert(stats(-120), stats(-90), settings).shouldAlert, false);
  assert.equal(evaluateAlert(stats(-90), stats(-100), settings).kind, "drawdown");
});

test("drawdown has priority over other PL alerts and ignores the change percentage filter", () => {
  const allAlerts = { alertOnDrawdown: true, drawdownAmount: 100, changePercent: 1000 };
  assert.equal(evaluateAlert(stats(0), stats(-100), allAlerts).kind, "drawdown");
  assert.equal(evaluateAlert(stats(-99.99), stats(-100), allAlerts).kind, "drawdown");
  assert.equal(evaluateAlert(stats(0), stats(-50), allAlerts).kind, "left-zero");
  assert.equal(evaluateAlert(stats(0), stats(-100), {}).kind, "left-zero");
});

test("disabled, invalid, or baseline-only drawdown rules do not alert", () => {
  assert.equal(evaluateAlert(stats(0), stats(-150), {
    ...settings, alertOnDrawdown: false
  }).shouldAlert, false);
  for (const amount of [0, -100, 0.001, "", null, "invalid", Infinity, NaN]) {
    assert.equal(evaluateAlert(stats(0), stats(-150), {
      ...settings, drawdownAmount: amount
    }).shouldAlert, false, `Invalid amount: ${amount}`);
  }
  assert.equal(evaluateAlert(null, stats(-150), settings).reason, "baseline");
  assert.equal(evaluateAlert({ floatingValue: null }, stats(-150), settings).reason, "baseline");
  assert.equal(evaluateAlert(stats(0), null, settings).reason, "missing");
});
