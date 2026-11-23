import assert from "node:assert/strict";
import test from "node:test";

let listener;
globalThis.chrome = {
  runtime: { onMessage: { addListener(fn) { listener = fn; } } }
};
globalThis.AudioContext = class {
  constructor() { throw new Error("Audio device is unavailable."); }
};

await import("../offscreen.js");

test("returns audio errors to the caller instead of dropping them", () => {
  let response;
  listener({ type: "PLAY_SOUND" }, {}, (value) => { response = value; });
  assert.deepEqual(response, { error: "Audio device is unavailable." });
});
