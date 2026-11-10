/**
 * 密钥落盘（口令加密）的端到端探针。
 *
 *   npm run visual:vault:probe
 *   npm run visual:vault:probe -- --require-browser
 *
 * 回答一个问题：**「密钥加密后落盘、换会话用口令解锁」这件事，在真实应用里真的成立吗？**
 *
 * 单元测试能证明加解密本身对（AES-GCM、口令错了解不开）。它答不了接线上的问题：
 * 磁盘上真的只有密文吗？新会话里密钥真的能从磁盘载回来吗？口令错了会不会把
 * 界面卡死？
 *
 * 做法是走真实应用：填一把密钥 → 设口令 → 加密保存 → 清掉会话存储并刷新
 * （模拟「换了个标签页」）→ 用口令解锁 → 密钥回到会话里。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrowser } from "../../design-export/visual/browser";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const DIST = join(root, "packages", "studio-web", "dist");

const VAULT_KEY = "studio:ai-key-vault";
const SESSION_KEY = "studio:ai-settings:session";
const SECRET = "sk-probe-secret-value";

const failures: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForApp(page: CdpPage, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate<boolean>(
      `Boolean(document.querySelector(".topbar") && document.querySelector(".canvas") && document.querySelector(".status"))`,
    );
    if (ready) {
      await sleep(500);
      return;
    }
    await sleep(100);
  }
  throw new Error("工作台没有渲染出来");
}

/**
 * 用真实鼠标点一个元素（按选择器）。
 *
 * 两个坑：
 * 1. 先滚进视口再量坐标——检查器面板比视口高，「添加」「加密保存」这些按钮
 *    默认落在视口下面，直接按 getBoundingClientRect 的坐标点会点空；
 * 2. 滚完之后要等一拍——布局还在滚的时候量到的是中间位置，坐标会偏。
 */
async function clickSelector(page: CdpPage, selector: string): Promise<boolean> {
  await page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: "center", inline: "nearest" }); return true; })()`,
  );
  await sleep(350);
  const point = await page.evaluate<{ x: number; y: number } | null>(
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       const r = el.getBoundingClientRect();
       if (!r.width || !r.height) return null;
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`,
  );
  if (!point) return false;
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
  return true;
}

/** 切到检查器的「AI」分段（必须用真实鼠标：Radix 的 Tabs 在 mousedown 上激活）。 */
async function switchToAi(page: CdpPage): Promise<void> {
  const ok = await page.evaluate<boolean>(
    `(() => {
       const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
       const target = tabs.find(tab => (tab.textContent || "").trim().startsWith("AI"));
       if (!target) return false;
       target.setAttribute("data-probe-ai", "1");
       return true;
     })()`,
  );
  if (!ok) throw new Error("找不到检查器的「AI」分段");
  await clickSelector(page, '[data-probe-ai="1"]');
  await sleep(500);
}

/** 往输入框里打字（React 要的是原生 setter + input 事件）。 */
async function fillInput(page: CdpPage, selector: string, value: string): Promise<void> {
  const filled = await page.evaluate<boolean>(
    `(() => {
       const input = document.querySelector(${JSON.stringify(selector)});
       if (!input) return false;
       input.scrollIntoView({ block: "center", inline: "nearest" });
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
  if (!filled) throw new Error(`找不到输入框：${selector}`);
  await sleep(150);
}

/** 点一个按钮（按文字）。 */
async function clickButton(page: CdpPage, text: string): Promise<boolean> {
  const ok = await page.evaluate<boolean>(
    `(() => {
       // 先清掉上一轮留下的标记：否则 querySelector 会命中上一次的按钮
       // （探针曾因此把「加密保存」点成了「添加」）。
       for (const el of Array.from(document.querySelectorAll("[data-probe-button]"))) el.removeAttribute("data-probe-button");
       const button = Array.from(document.querySelectorAll("button")).find(el => (el.textContent || "").trim() === ${JSON.stringify(text)});
       if (!button) return false;
       button.setAttribute("data-probe-button", "1");
       return true;
     })()`,
  );
  if (!ok) return false;
  return clickSelector(page, '[data-probe-button="1"]');
}

/** 面板上显示的密钥（打码后的）。 */
async function maskedKeys(page: CdpPage): Promise<string[]> {
  return page.evaluate<string[]>(
    `Array.from(document.querySelectorAll(".ai-key-masked")).map(el => (el.textContent || "").trim())`,
  );
}

/** 保管库的提示文字（aria-live 的那一条，别把面板其它说明混进来）。 */
async function notes(page: CdpPage): Promise<string> {
  return page.evaluate<string>(
    `Array.from(document.querySelectorAll('[aria-live="polite"]')).map(el => (el.textContent || "").trim()).join(" | ")`,
  );
}

async function main(): Promise<void> {
  const requireBrowser = process.argv.slice(2).includes("--require-browser");
  const browserPath = findBrowser();
  if (!browserPath) {
    const message = "未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）";
    if (requireBrowser) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(`${message}，跳过密钥落盘探针。`);
    }
    return;
  }
  if (!existsSync(join(DIST, "index.html"))) {
    console.error(`没有找到构建产物：${DIST}；先运行 npm run build:studio-web`);
    process.exitCode = 1;
    return;
  }

  const server = await serveDirectory(DIST);
  const browser = await launchHeadlessBrowser(browserPath);
  try {
    const page = await browser.newPage(server.url);
    await waitForApp(page);
    await switchToAi(page);

    // ── 配一把密钥并加密落盘 ─────────────────────────────────────────
    await fillInput(page, 'input[placeholder="粘贴新的 API Key"]', SECRET);
    expect(await clickButton(page, "添加"), "AI 分段里没有「添加」按钮");
    await sleep(300);
    await fillInput(page, 'input[aria-label="落盘口令"]', "探针口令");
    expect(await clickButton(page, "加密保存"), "AI 分段里没有「加密保存」按钮");
    await sleep(1200);

    const stored = await page.evaluate<string>(`localStorage.getItem(${JSON.stringify(VAULT_KEY)}) ?? ""`);
    expect(Boolean(stored), "磁盘上没有留下密文");
    expect(!stored.includes(SECRET), "磁盘上出现了明文密钥");
    const session = await page.evaluate<string>(`sessionStorage.getItem(${JSON.stringify(SESSION_KEY)}) ?? ""`);
    expect(session.includes(SECRET), "密钥没有进会话存储");
    console.log(`磁盘记录长度：${stored.length} 字节；明文密钥未出现`);

    // ── 换会话：只清掉会话存储再刷新（模拟新标签页），磁盘上的密文留着 ──
    await page.evaluate(`sessionStorage.clear(); true`);
    await page.navigate(server.url);
    await waitForApp(page);
    await switchToAi(page);
    expect((await maskedKeys(page)).length === 0, "新会话里不该还有密钥");
    expect(await page.evaluate<string>(`localStorage.getItem(${JSON.stringify(VAULT_KEY)}) ?? ""`) === stored,
      "刷新后磁盘上的密文不见了");

    // ── 口令错了：要说清楚，不能静默失败 ────────────────────────────
    await fillInput(page, 'input[aria-label="落盘口令"]', "错的");
    expect(await clickButton(page, "解锁载入"), "AI 分段里没有「解锁载入」按钮");
    await sleep(1200);
    const wrongNote = await notes(page);
    expect(wrongNote.includes("口令不对"), `口令错了应该明说，实际提示：${wrongNote}`);
    expect((await maskedKeys(page)).length === 0, "口令错了却载入了密钥");

    // ── 口令对了：密钥回到会话里 ────────────────────────────────────
    await fillInput(page, 'input[aria-label="落盘口令"]', "探针口令");
    expect(await clickButton(page, "解锁载入"), "解锁按钮点不动");
    await sleep(1500);
    const keys = await maskedKeys(page);
    expect(keys.length === 1, `解锁后应该有一把密钥，实际 ${keys.length} 把`);
    const sessionAfter = await page.evaluate<string>(`sessionStorage.getItem(${JSON.stringify(SESSION_KEY)}) ?? ""`);
    expect(sessionAfter.includes(SECRET), "解锁后密钥没有回到会话存储");
    console.log(`解锁后密钥：${keys.join(", ")}`);
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error(`\n密钥落盘探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n密钥落盘探针通过：磁盘上只有密文，口令错了会明说，口令对了密钥回到会话。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
