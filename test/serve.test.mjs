import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../lib/serve.ts";
import { FixtureProvider } from "../lib/demo.ts";

process.env.ETH_USD = "2400"; // offline

const server = startServer({
  port: 0,
  cachePath: ":memory:",
  makeProvider: () => new FixtureProvider("graduated-token"),
});
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

after(() => server.close());

test("serves the terminal page and brand assets", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /XRAY/);
  const sprite = await fetch(base + "/brand/work-scanner-sheet.png");
  assert.equal(sprite.status, 200);
  assert.equal(sprite.headers.get("content-type"), "image/png");
  const css = await fetch(base + "/agents.css");
  assert.match(await css.text(), /\/brand\/work-scanner-sheet\.png/);
});

test("blocks path traversal out of the brand dir", async () => {
  const res = await fetch(base + "/brand/..%2f..%2fpackage.json");
  assert.ok(res.status === 400 || res.status === 404);
});

test("sse check streams stages then a result", async () => {
  const res = await fetch(base + "/api/check?token=0x443522ecf6780a507ead5cdad37bc58b42acf82f");
  assert.equal(res.status, 200);
  const text = await res.text(); // stream ends when the check finishes
  const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.ok(events.includes("stage"), "has stage events");
  assert.ok(events.includes("result"), "has a result");
  assert.equal(events[events.length - 1], "done");
  const resultLine = text.split("\n").find((l, i, all) => all[i - 1] === "event: result");
  const payload = JSON.parse(resultLine.replace("data: ", ""));
  assert.equal(payload.token.symbol, "CAPITOL");
  assert.equal(payload.grade, "shattered");
  assert.equal(payload.demo, true);
  const stages = [...text.matchAll(/^event: stage\ndata: (.+)$/gm)].map((m) => JSON.parse(m[1]));
  const done = stages.filter((s) => s.status === "done").map((s) => s.agent);
  assert.deepEqual(done, ["scanner", "ledger", "flagger", "sorter", "auditor"]);
  assert.ok(stages.some((s) => s.agent === "tracer" && s.status === "skip"));
});

test("bad token query returns an sse error event", async () => {
  const res = await fetch(base + "/api/check?token=notatoken");
  const text = await res.text();
  assert.match(text, /^event: error$/m);
});
