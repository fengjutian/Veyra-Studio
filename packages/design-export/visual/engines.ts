/**
 * 浏览器引擎适配器：把「打开一个 HTML、截一张图、读回页面里的指标」这件事
 * 抽象成三个引擎各一份实现。
 *
 * 为什么不用 Playwright：它要下载浏览器二进制，仓库不打算为此引入几百 MB 的
 * 依赖；而且 CI 与开发机通常已经装了浏览器，命令行 + 自带协议就够用。
 *
 * 三条路径的代价不一样，写在这里免得后来的人误以为它们等价：
 *
 * - **Chromium**（Chrome / Edge）：命令行截图 + `--dump-dom`。最稳，已实测。
 * - **Firefox**：Marionette 协议（Firefox 自带，不用装 geckodriver）。
 *   **本机未实测**（开发机只有 Chromium）。
 * - **WebKit**（Safari）：`safaridriver` + WebDriver 协议。需要 macOS，且要
 *   一次性执行 `sudo safaridriver --enable` 并在 Safari 里打开「允许远程自动化」。
 *   **本机未实测**（开发机不是 macOS）。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dumpHtml, findBrowser, renderHtmlToPng } from "./browser";
import { parseBrowserUserAgent, type CrossBrowserEngineId } from "../src/cross-browser";

/** 引擎的静态信息。 */
export interface EngineDescriptor {
  id: CrossBrowserEngineId;
  /** 浏览器家族：Chrome / Edge / Chromium / Firefox / Safari。 */
  family: string;
  /** 浏览器版本（拿不到时为空字符串）。 */
  version: string;
  /** 可执行文件路径。 */
  binaryPath: string;
}

/** 引擎可用性。 */
export interface EngineProbe {
  id: CrossBrowserEngineId;
  available: boolean;
  /** 不可用时的原因（直接给人看）。 */
  reason?: string;
  descriptor?: EngineDescriptor;
}

/** 一次采集的结果。 */
export interface EngineCapture {
  /** harness 写在页面里的指标 JSON。 */
  metrics: Record<string, unknown>;
  /** 页面里的 user agent。 */
  userAgent?: string;
  /** 由 user agent 解析出的浏览器身份。 */
  identity?: { family: string; version: string };
}

export interface CaptureOptions {
  htmlPath: string;
  outPath: string;
  width: number;
  height: number;
  timeoutMs?: number;
}

const FIREFOX_CANDIDATES = [
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  "/Applications/Firefox.app/Contents/MacOS/firefox",
  "/usr/bin/firefox",
  "/usr/bin/firefox-esr",
  "/snap/bin/firefox",
];

/** Safari 的驱动只在 macOS 上有。 */
const SAFARIDRIVER_CANDIDATES = ["/usr/bin/safaridriver", "/usr/local/bin/safaridriver"];

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find(candidate => existsSync(candidate));
}

/** 跑一条命令拿 stdout；失败返回 undefined（探测用，不该抛）。 */
function execCapture(command: string, args: string[], timeoutMs = 20_000): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) resolve(undefined);
      else resolve(String(stdout).trim());
    });
  });
}

/** 从 `--version` 的输出里解析家族与版本。 */
export function parseEngineVersionLine(line: string | undefined): { family: string; version: string } | undefined {
  if (!line) return undefined;
  const version = /(\d+(?:\.\d+)*)\s*$/.exec(line)?.[1];
  if (!version) return undefined;
  if (/Edge/i.test(line)) return { family: "Edge", version };
  if (/Chromium/i.test(line)) return { family: "Chromium", version };
  if (/Chrome/i.test(line)) return { family: "Chrome", version };
  if (/Firefox/i.test(line)) return { family: "Firefox", version };
  return undefined;
}

/** 找到 Firefox 可执行文件。 */
export function findFirefox(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.FIREFOX_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  return firstExisting(FIREFOX_CANDIDATES);
}

/** 找到 safaridriver。 */
export function findSafariDriver(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.SAFARIDRIVER_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  return firstExisting(SAFARIDRIVER_CANDIDATES);
}

/**
 * 探测本机可用的引擎。
 *
 * 探测**只做静态检查**（找可执行文件、读版本），不启动浏览器：探测阶段启动
 * 浏览器会让「这个引擎能不能用」和「这个引擎这次跑成功了吗」混在一起。
 */
export async function probeEngines(env: NodeJS.ProcessEnv = process.env): Promise<EngineProbe[]> {
  const probes: EngineProbe[] = [];

  const chromium = findBrowser(env);
  if (!chromium) {
    probes.push({ id: "chromium", available: false, reason: "未找到 Chrome / Edge（设置 CHROME_PATH 或 EDGE_PATH）" });
  } else {
    const line = await execCapture(chromium, ["--version"]);
    const identity = parseEngineVersionLine(line);
    probes.push({
      id: "chromium",
      available: true,
      descriptor: {
        id: "chromium",
        family: identity?.family ?? "Chromium",
        version: identity?.version ?? "",
        binaryPath: chromium,
      },
    });
  }

  const firefox = findFirefox(env);
  if (!firefox) {
    probes.push({ id: "firefox", available: false, reason: "未找到 Firefox（设置 FIREFOX_PATH）" });
  } else {
    const line = await execCapture(firefox, ["--version"]);
    const identity = parseEngineVersionLine(line);
    probes.push({
      id: "firefox",
      available: true,
      descriptor: { id: "firefox", family: identity?.family ?? "Firefox", version: identity?.version ?? "", binaryPath: firefox },
    });
  }

  const safariDriver = findSafariDriver(env);
  if (!safariDriver) {
    probes.push({
      id: "webkit",
      available: false,
      reason: process.platform === "darwin"
        ? "未找到 safaridriver（macOS 自带，确认 /usr/bin/safaridriver 存在）"
        : "Safari 只在 macOS 上可用，当前系统不是 darwin",
    });
  } else {
    probes.push({
      id: "webkit",
      available: true,
      descriptor: { id: "webkit", family: "Safari", version: "", binaryPath: safariDriver },
    });
  }

  return probes;
}

/**
 * 从 harness 页面里取出指标 JSON。
 *
 * Chromium 的 `--dump-dom` 会把文本节点转义成 HTML 实体，先还原再解析。
 */
export function extractHarnessMetrics(dom: string): Record<string, unknown> {
  const match = /<pre id="harness-metrics"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) {
    const error = /<pre id="harness-error"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
    throw new Error(`页面里没有 harness 指标${error ? `：${error[1]}` : "（页面可能没跑完）"}`);
  }
  const json = match[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return JSON.parse(json) as Record<string, unknown>;
}

function userAgentOf(metrics: Record<string, unknown>): string | undefined {
  return typeof metrics.userAgent === "string" ? metrics.userAgent : undefined;
}

/**
 * 采集一个引擎：截图 + 读回页面指标。
 */
export async function captureWithEngine(descriptor: EngineDescriptor, options: CaptureOptions): Promise<EngineCapture> {
  if (descriptor.id === "chromium") return captureChromium(descriptor, options);
  if (descriptor.id === "firefox") return captureFirefox(descriptor, options);
  return captureSafari(descriptor, options);
}

/** Chromium：命令行截图 + `--dump-dom` 取指标。 */
async function captureChromium(descriptor: EngineDescriptor, options: CaptureOptions): Promise<EngineCapture> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const dom = await dumpHtml({ htmlPath: options.htmlPath, browserPath: descriptor.binaryPath, timeoutMs });
  const metrics = extractHarnessMetrics(dom);
  await renderHtmlToPng({
    htmlPath: options.htmlPath,
    outPath: options.outPath,
    width: options.width,
    height: options.height,
    browserPath: descriptor.binaryPath,
    timeoutMs,
  });
  const userAgent = userAgentOf(metrics);
  return { metrics, userAgent, identity: userAgent ? parseBrowserUserAgent(userAgent) : undefined };
}

/**
 * Firefox：Marionette 协议。
 *
 * Marionette 是 Firefox 自带的远程控制协议（端口 2828），不需要 geckodriver。
 * 报文格式是 `<字节长度>:<JSON>`。
 */
async function captureFirefox(descriptor: EngineDescriptor, options: CaptureOptions): Promise<EngineCapture> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const profile = mkdtempSync(join(tmpdir(), "ufira-firefox-"));
  const preferredPort = 2900 + Math.floor(Math.random() * 400);
  const child = spawn(
    descriptor.binaryPath,
    ["--headless", "--marionette", "--no-remote", "--marionette-port", String(preferredPort), "--profile", profile, "about:blank"],
    { stdio: "ignore" },
  );
  try {
    const session = await MarionetteSession.connect(preferredPort, timeoutMs);
    try {
      await session.send("WebDriver:NewSession", {});
      await session.send("WebDriver:SetWindowRect", { x: 0, y: 0, width: options.width, height: options.height });
      await session.send("WebDriver:Navigate", { url: pathToFileURL(options.htmlPath).href });
      const metrics = await readHarnessMetrics(session, timeoutMs);
      const shot = await session.send("WebDriver:TakeScreenshot", { full: false, hash: false, scroll: false }) as { value?: string };
      if (!shot?.value) throw new Error("Firefox 没有返回截图");
      writeFileSync(options.outPath, Buffer.from(shot.value, "base64"));
      const userAgent = userAgentOf(metrics);
      return { metrics, userAgent, identity: userAgent ? parseBrowserUserAgent(userAgent) : undefined };
    } finally {
      await session.close();
    }
  } finally {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Safari：`safaridriver` + WebDriver（HTTP/JSON）协议。
 */
async function captureSafari(descriptor: EngineDescriptor, options: CaptureOptions): Promise<EngineCapture> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(descriptor.binaryPath, ["-p", String(port)], { stdio: "ignore" });
  try {
    const session = await WebDriverSession.connect(port, timeoutMs);
    try {
      await session.setWindowRect(options.width, options.height);
      await session.navigate(pathToFileURL(options.htmlPath).href);
      const metrics = await readHarnessMetrics(session, timeoutMs);
      const png = await session.screenshot();
      writeFileSync(options.outPath, png);
      const userAgent = userAgentOf(metrics);
      return { metrics, userAgent, identity: userAgent ? parseBrowserUserAgent(userAgent) : undefined };
    } finally {
      await session.close();
    }
  } finally {
    child.kill();
  }
}

/** 页面里 harness 的指标文本；两个远程协议共用「等页面跑完」的逻辑。 */
const READY_SCRIPT = `
  var metrics = document.getElementById('harness-metrics');
  if (metrics) return metrics.textContent;
  var error = document.getElementById('harness-error');
  if (error) return 'ERROR:' + error.textContent;
  return null;
`;

interface RemoteSession {
  execute(script: string): Promise<unknown>;
  send(command: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** 轮询页面，等 harness 把指标写出来。 */
async function readHarnessMetrics(session: RemoteSession, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await session.execute(READY_SCRIPT);
    if (typeof raw === "string" && raw.length > 0) {
      if (raw.startsWith("ERROR:")) throw new Error(`harness 报错：${raw.slice(6)}`);
      return JSON.parse(raw) as Record<string, unknown>;
    }
    await delay(200);
  }
  throw new Error(`等待 harness 指标超时（${Math.round(timeoutMs / 1000)}s）`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Marionette 客户端                                                           */
/* -------------------------------------------------------------------------- */

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class MarionetteSession implements RemoteSession {
  private buffer = new Uint8Array(0);
  private pending = new Map<number, PendingCommand>();
  private nextId = 1;
  private handshake: Promise<void>;
  private handshakeResolve!: () => void;
  private handshakeReject!: (error: Error) => void;

  private constructor(private socket: net.Socket) {
    this.handshake = new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
    socket.on("data", (chunk: Buffer) => {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
      this.drain();
    });
    socket.on("error", error => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("Marionette 连接已关闭")));
  }

  static async connect(port: number, timeoutMs: number): Promise<MarionetteSession> {
    // 优先连指定端口；Firefox 不支持 --marionette-port 的老版本会落到 2828。
    for (const candidate of [port, 2828]) {
      const socket = await openSocket(candidate, Math.min(timeoutMs, 20_000)).catch(() => undefined);
      if (!socket) continue;
      const session = new MarionetteSession(socket);
      try {
        await session.handshake;
        return session;
      } catch {
        socket.destroy();
      }
    }
    throw new Error("连不上 Firefox 的 Marionette 端口（确认 Firefox 能以 --marionette 启动）");
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
    this.handshakeReject(error);
  }

  private drain(): void {
    for (;;) {
      const separator = this.buffer.indexOf(0x3a); // ':'
      if (separator < 0) return;
      const length = Number(new TextDecoder().decode(this.buffer.subarray(0, separator)));
      if (!Number.isFinite(length)) {
        // 长度都解析不出来，说明这一段不是合法报文：丢掉重连比死磕更划算。
        this.buffer = new Uint8Array(0);
        this.failAll(new Error("Marionette 报文长度非法"));
        return;
      }
      const start = separator + 1;
      if (this.buffer.length < start + length) return;
      const payload = new TextDecoder().decode(this.buffer.subarray(start, start + length));
      this.buffer = this.buffer.subarray(start + length);
      this.handle(payload);
    }
  }

  private handle(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (Array.isArray(parsed)) {
      const [, id, error, result] = parsed as [number, number, unknown, unknown];
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) {
        const message = typeof error === "object" && error && "message" in error
          ? String((error as { message: unknown }).message)
          : JSON.stringify(error);
        pending.reject(new Error(`Marionette 命令失败：${message}`));
        return;
      }
      pending.resolve(result);
      return;
    }
    // 握手包是普通对象。
    this.handshakeResolve();
  }

  send(command: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify([0, id, command, params]);
    const packet = `${Buffer.byteLength(body, "utf8")}:${body}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(packet, error => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async execute(script: string): Promise<unknown> {
    const result = await this.send("WebDriver:ExecuteScript", { script, args: [], sandbox: null, newSandbox: false }) as { value?: unknown };
    return result?.value;
  }

  async close(): Promise<void> {
    try {
      await this.send("WebDriver:DeleteSession", {});
    } catch {
      // 会话可能已经没了；关闭失败不影响采集结果。
    }
    this.socket.destroy();
  }
}

function openSocket(port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 127.0.0.1:${port} 超时`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* WebDriver 客户端（safaridriver）                                            */
/* -------------------------------------------------------------------------- */

class WebDriverSession implements RemoteSession {
  private constructor(private baseUrl: string, private sessionId: string) {}

  static async connect(port: number, timeoutMs: number): Promise<WebDriverSession> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;
    let lastError = "驱动没有启动";
    while (Date.now() < deadline) {
      try {
        const response = await webdriverRequest(baseUrl, "POST", "/session", {
          capabilities: { alwaysMatch: { browserName: "safari" } },
        });
        const sessionId = (response.value as { sessionId?: string } | undefined)?.sessionId;
        if (sessionId) return new WebDriverSession(baseUrl, sessionId);
        lastError = "驱动没有返回 sessionId";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(300);
    }
    throw new Error(`连不上 safaridriver：${lastError}（需要 macOS，且先执行一次 sudo safaridriver --enable）`);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await webdriverRequest(this.baseUrl, method, path, body, this.sessionId);
    return response.value;
  }

  async send(command: string, _params: Record<string, unknown>): Promise<unknown> {
    throw new Error(`WebDriver 不支持通用命令：${command}`);
  }

  async execute(script: string): Promise<unknown> {
    const value = await this.call("POST", "/execute/sync", { script, args: [] });
    return value;
  }

  async setWindowRect(width: number, height: number): Promise<void> {
    await this.call("POST", "/window/rect", { width, height });
  }

  async navigate(url: string): Promise<void> {
    await this.call("POST", "/url", { url });
  }

  async screenshot(): Promise<Buffer> {
    const value = await this.call("GET", "/screenshot");
    return Buffer.from(String(value), "base64");
  }

  async close(): Promise<void> {
    try {
      await this.call("DELETE", "");
    } catch {
      // 会话可能已经没了。
    }
  }
}

interface WebDriverResponse {
  value?: unknown;
  error?: string;
  message?: string;
}

async function webdriverRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  sessionId?: string,
): Promise<WebDriverResponse> {
  const url = sessionId ? `${baseUrl}/session/${sessionId}${path}` : `${baseUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: WebDriverResponse;
  try {
    parsed = JSON.parse(text) as WebDriverResponse;
  } catch {
    throw new Error(`WebDriver 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok || parsed.error) {
    throw new Error(`WebDriver 调用失败（HTTP ${response.status}）：${parsed.message ?? parsed.error ?? text.slice(0, 200)}`);
  }
  return parsed;
}
