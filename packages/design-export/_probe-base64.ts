import { readFileSync } from "node:fs";
import { base64FromBytes } from "@ufira/design-export";

const bytes = new Uint8Array(readFileSync("D:/github/design-ai/packages/design-export/test/fixtures/PressStart2P-Regular.ttf"));
const mine = base64FromBytes(bytes);
const node = Buffer.from(bytes).toString("base64");
console.log("长度 mine =", mine.length, " node =", node.length);
console.log("一致 =", mine === node);
if (mine !== node) {
  for (let index = 0; index < Math.min(mine.length, node.length); index += 1) {
    if (mine[index] !== node[index]) {
      console.log("首个不同位置", index, JSON.stringify(mine.slice(index - 10, index + 10)), JSON.stringify(node.slice(index - 10, index + 10)));
      break;
    }
  }
}
