import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mt5Snapshot } from "../mt5-bridge.js";

const executable = fileURLToPath(new URL("../mt5/SignalStartNativeHost.exe", import.meta.url));
function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
async function run(folder, data, args = [], keepInputOpen = false) {
  const child = spawn(executable, [`--data-dir=${folder}`, ...args], { windowsHide: true });
  const stdout = [], stderr = [];
  child.stdout.on("data", value => stdout.push(value));
  child.stderr.on("data", value => stderr.push(value));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve(code));
  });
  child.stdin.on("error", () => {});
  const timeout = setTimeout(() => child.kill(), 5000);
  if (keepInputOpen) child.stdin.write(data);
  else child.stdin.end(data);
  let code;
  try { code = await done; }
  finally { clearTimeout(timeout); }
  const buffer = Buffer.concat(stdout); const replies = [];
  for (let offset = 0; offset < buffer.length;) {
    const length = buffer.readUInt32LE(offset); offset += 4;
    assert.ok(length > 0 && offset + length <= buffer.length);
    replies.push(JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return { code, replies, stderr: Buffer.concat(stderr).toString("utf8") };
}
function snapshot() {
  const now = Date.now();
  return { ...mt5Snapshot({ settings: { mt5SignalId: "123" }, signals: { "123": {
    id: "123", name: "漢字 € test\nInjected\trow", floatingValue: -25.5, floatingDisplay: "-€25.50",
    sampleAt: now, lastSource: "live", openTrades: 3
  } }, mt5Alerts: [{ id: "test-alert", signalId: "456", at: now, title: "Other signal", message: "ΔPL" }] }), requestId: "1" };
}

async function cleanup(folder) {
  const resolved = path.resolve(folder);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep + "signalstart-host-"));
  await rm(resolved, { recursive: true, force: true });
}

test("real native host accepts framed UTF-8 and writes a complete sanitized MT5 snapshot", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "signalstart-host-"));
  try {
    const first = snapshot(); const second = { ...first, requestId: "2" };
    const result = await run(folder, Buffer.concat([frame(first), frame(second)]));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.replies, [{ ok: true, requestId: "1" }, { ok: true, requestId: "2" }]);
    const lines = (await readFile(path.join(folder, "snapshot.tsv"), "utf8")).trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 6);
    assert.equal(lines[1], "C\t5");
    assert.equal(lines[2].split("\t").length, 10);
    assert.match(lines[2], /漢字 € test Injected row\t-25.5\t-€25.50\t3/);
    assert.equal(lines[2].split("\t")[8], "-");
    assert.equal(lines[3].split("\t")[0], "T");
    assert.equal(lines[4].split("\t")[3], "456");
    assert.equal(lines.at(-1), "END\t2");
  } finally { await cleanup(folder); }
});

test("missing MT5 process disables the snapshot and exits even while browser input stays open", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "signalstart-host-"));
  try {
    const result = await run(folder, frame(snapshot()), ["--terminal-process-id=2147483647"], true);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.replies, [{ ok: true, mt5Running: false, requestId: "1" }]);
    const lines = (await readFile(path.join(folder, "snapshot.tsv"), "utf8")).trimEnd().split(/\r?\n/);
    assert.equal(lines[0].split("\t")[3], "0");
    assert.equal(lines[0].split("\t")[6], "0");
    assert.ok(!lines.some(line => /^(S|T|A)\t/.test(line)));
  } finally { await cleanup(folder); }
});

test("a running terminal process permits snapshots and closing browser input terminates the helper", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "signalstart-host-"));
  try {
    const result = await run(folder, frame(snapshot()), [`--terminal-process-id=${process.pid}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.replies, [{ ok: true, requestId: "1" }]);
    assert.match(await readFile(path.join(folder, "snapshot.tsv"), "utf8"), /\r?\nS\t123\t/);
  } finally { await cleanup(folder); }
});

test("invalid payloads return actual errors without overwriting the last valid snapshot", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "signalstart-host-"));
  try {
    await run(folder, frame(snapshot()));
    const before = await readFile(path.join(folder, "snapshot.tsv"), "utf8");
    const bad = snapshot(); bad.signal.floatingValue = "not a number";
    const result = await run(folder, frame(bad));
    assert.match(result.replies[0].error, /Expected a number/);
    assert.equal(await readFile(path.join(folder, "snapshot.tsv"), "utf8"), before);
    const huge = Buffer.alloc(4); huge.writeUInt32LE(1024 * 1024 + 1);
    const oversized = await run(folder, huge);
    assert.equal(oversized.code, 1);
    assert.match(oversized.stderr, /too large/);
  } finally { await cleanup(folder); }
});

test("carries automatic source values, optional stops and the configurable receiver interval",async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"signalstart-host-"));
  try {
    const value=snapshot();value.checkSeconds=10;value.signal.openTrades=1;
    value.signal.tradeDetails={status:"ready",symbol:"US30",lots:.1,sl:0,tp:50123.5,side:1,identity:"position",reason:""};
    assert.equal((await run(folder,frame(value))).replies[0].ok,true);
    const body=await readFile(path.join(folder,"snapshot.tsv"),"utf8");
    assert.match(body,/C\t10/);assert.match(body,/T\tready\tUS30\t0.1\t0\t50123.5\t1/);
    value.checkSeconds=0;
    assert.match((await run(folder,frame(value))).replies[0].error,/interval/);
    assert.equal(await readFile(path.join(folder,"snapshot.tsv"),"utf8"),body);
    value.checkSeconds=5;value.signal.tradeDetails.lots=0;
    assert.match((await run(folder,frame(value))).replies[0].error,/trade details/);
  } finally {await cleanup(folder);}
});
