import { readFileSync } from "node:fs";
import { Font } from "fonteditor-core";

const source = readFileSync("D:/github/design-ai/packages/design-export/test/fixtures/PressStart2P-Regular.ttf");
const font = Font.create(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, { type: "ttf" });
const object: any = font.get();
console.log("family =", object.name?.fontFamily);
console.log("weight =", object["OS/2"]?.usWeightClass, " fsSelection =", object["OS/2"]?.fsSelection);
console.log("macStyle =", object.head?.macStyle);
