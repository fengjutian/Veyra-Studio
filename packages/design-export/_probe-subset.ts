import { readFileSync } from "node:fs";
import { Font } from "fonteditor-core";

const source = readFileSync("C:/Windows/Fonts/arial.ttf");
const font = Font.create(source as unknown as ArrayBuffer, { type: "ttf" });
const chars = Array.from(new Set("Hello 世界".split("")));

const out: any = font.write({ subset: chars, toBuffer: true, type: "ttf" });
console.log("typeof =", typeof out, " isBuffer =", Buffer.isBuffer(out), " ctor =", out?.constructor?.name);
console.log("byteLength =", out?.byteLength, " length =", out?.length);
const head = Buffer.from(out instanceof ArrayBuffer ? new Uint8Array(out) : out).subarray(0, 16);
console.log("head hex =", head.toString("hex"));
