// node probe.mjs <url> <width> <height> <dpr> [shot]
import fs from "node:fs";

const [url, wArg, hArg, dprArg, shot] = process.argv.slice(2);
const width = Number(wArg ?? 1513), height = Number(hArg ?? 732), dpr = Number(dprArg ?? 1);

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise(res => ws.addEventListener("open", res));
const send = (method, params = {}) => new Promise(res => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, 5000));

const expr = `(() => {
  const de = document.documentElement;
  const res = { inner: [innerWidth, innerHeight], client: [de.clientWidth, de.clientHeight], scroll: [de.scrollWidth, de.scrollHeight] };
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > de.clientWidth + 0.5 || r.bottom > de.clientHeight + 0.5 || r.left < -0.5 || r.top < -0.5) {
      offenders.push(el.tagName + "." + String(el.className).slice(0,40) + " [" + [r.left, r.top, r.right, r.bottom].map(n => Math.round(n)).join(",") + "] pos=" + getComputedStyle(el).position);
    }
  }
  res.offenders = offenders.slice(0, 25);
  const pick = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [sel, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  res.boxes = [".studio", "header", ".layers", ".workspace", ".canvas-scroller", ".canvas", ".inspector", ".canvas-controls"].map(pick);
  return res;
})()`;
const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(JSON.stringify(ev.result.result.value, null, 2));
if (shot) {
  const cap = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(shot, Buffer.from(cap.result.data, "base64"));
}
ws.close();
