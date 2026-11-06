// Minimal CDP driver: node cdp.mjs <url> [waitMs] [shotPath]
import fs from "node:fs";

const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 4000);
const shot = process.argv[4];

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find(t => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") logs.push("console:" + msg.params.type + " " + msg.params.args.map(a => a.value ?? a.description ?? a.type).join(" "));
  if (msg.method === "Runtime.exceptionThrown") logs.push("exception:" + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  if (msg.method === "Log.entryAdded") logs.push("log:" + msg.params.entry.level + " " + msg.params.entry.text);
});
await new Promise(res => ws.addEventListener("open", res));
const send = (method, params = {}) => new Promise(res => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1513, height: 732, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, waitMs));
const evalRes = await send("Runtime.evaluate", {
  expression: `(() => {
    const de = document.documentElement;
    const out = { viewport: [innerWidth, innerHeight], scroll: [de.scrollWidth, de.scrollHeight], bodyScroll: [document.body.scrollWidth, document.body.scrollHeight], text: document.body.innerText.slice(0, 120) };
    const pick = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollW: el.scrollWidth, scrollH: el.scrollHeight }; };
    out.boxes = [".studio", "header", ".layers", ".workspace", ".canvas-scroller", ".canvas", ".inspector", ".canvas-controls"].map(pick);
    out.rootChildren = [...document.body.children].map(el => { const r = el.getBoundingClientRect(); return el.tagName + "." + el.className + " " + [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(","); });
    return out;
  })()`, returnByValue: true
});
console.log(JSON.stringify(evalRes.result.result.value, null, 2));
if (logs.length) console.log("LOGS:\n" + logs.join("\n"));
if (shot) {
  const cap = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(shot, Buffer.from(cap.result.data, "base64"));
}
ws.close();
