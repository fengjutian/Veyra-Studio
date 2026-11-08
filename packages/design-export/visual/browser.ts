/**
 * 用本机 Chrome/Edge 的 headless 模式把 HTML 渲染成 PNG。
 *
 * 不引入 Playwright：CI 和开发机通常已经有浏览器，命令行截图就够做"同一台机器
 * 上前后对比"的视觉回归。代价是基线绑定本机字体，所以基线更新需要明确执行
 * `--update`，而不是自动覆盖。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const UNIX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** 依次查找 CHROME_PATH、EDGE_PATH 与常见安装路径。 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = [env.CHROME_PATH, env.EDGE_PATH].filter((value): value is string => Boolean(value?.trim()));
  const candidates = [...explicit, ...(process.platform === "win32" ? WINDOWS_CANDIDATES : UNIX_CANDIDATES)];
  return candidates.find(candidate => existsSync(candidate));
}

export interface RenderOptions {
  htmlPath: string;
  outPath: string;
  width: number;
  height: number;
  browserPath?: string;
  timeoutMs?: number;
}

export function renderHtmlToPng(options: RenderOptions): Promise<void> {
  const browser = options.browserPath ?? findBrowser();
  if (!browser) return Promise.reject(new Error("找不到 Chrome/Edge；设置 CHROME_PATH 或传入 --browser"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=" + options.width + "," + options.height,
    // 给字体与布局一点时间，避免截到首帧。
    "--virtual-time-budget=1500",
    "--screenshot=" + options.outPath,
    pathToFileURL(options.htmlPath).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: options.timeoutMs ?? 30_000 }, error => {
      if (error) reject(new Error(`浏览器渲染失败：${error.message}`));
      else resolve();
    });
  });
}

/**
 * 用 headless 浏览器把页面渲染后的 DOM 抓回来。
 *
 * 截图只能看像素，读不到计算样式；探针要断言「加粗是不是真的 700」
 * 「缩进是不是真的 24px」，得拿到浏览器排版后的 DOM。
 */
export function dumpHtml(options: { htmlPath: string; browserPath?: string; timeoutMs?: number }): Promise<string> {
  const browser = options.browserPath ?? findBrowser();
  if (!browser) return Promise.reject(new Error("找不到 Chrome/Edge；设置 CHROME_PATH 或传入 --browser"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--virtual-time-budget=3000",
    "--dump-dom",
    pathToFileURL(options.htmlPath).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`浏览器抓取失败：${error.message}`));
      else resolve(stdout);
    });
  });
}
