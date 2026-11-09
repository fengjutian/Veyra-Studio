/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 为什么自己写而不是装 Playwright/Puppeteer：这套自动化只需要三件事——执行页面
 * 脚本、派发真实按键、读可访问性树。Puppeteer 为了这些要拖进一整套浏览器下载
 * 管理，而 Node 24 自带 WebSocket，直接说 CDP 就够了（全仓库零新依赖）。
 *
 * 也因此它很薄：只实现 flat session 模式下用得到的那几个域。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CdpEventPayload {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/** 一条 CDP 连接（浏览器级）。 */
export class CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  private nextId = 1;
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message?.id === "number") {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message}（code ${message.error.code ?? "?"}）`));
        else entry.resolve(message.result);
        return;
      }
      if (typeof message?.method === "string") {
        const handlers = this.listeners.get(message.method);
        if (!handlers) return;
        for (const handler of handlers) handler(message.params, message.sessionId);
      }
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        socket.removeEventListener("open", onOpen);
        reject(new Error(`无法连接 ${url}`));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
    return new CdpConnection(socket);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: any) => void, reject });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method: string, handler: (params: any, sessionId?: string) => void): () => void {
    const handlers = this.listeners.get(method) ?? new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => handlers.delete(handler);
  }

  /** 等下一次事件（用于「先注册再触发」的时序）。 */
  once(method: string, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待 ${method} 超时`));
      }, timeoutMs);
      const off = this.on(method, params => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error("CDP 连接已关闭"));
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      // 关不上就算了：浏览器进程随后会被 Browser.close 收掉。
    }
  }
}

/** AX 树里的一个节点（原始形状）。 */
export interface AxTreeNode {
  nodeId: string;
  ignored: boolean;
  role: string;
  name: string;
  focusable: boolean;
  backendDOMNodeId?: number;
}

/** 一个页面（tab）的会话。 */
export interface CdpPage {
  sessionId: string;
  /** 直接发一条 CDP 命令（页面级域）。 */
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  navigate(url: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  pressKey(key: string): Promise<void>;
  axTree(): Promise<AxTreeNode[]>;
}

/** 键盘键位表：CDP 要的是虚拟键码，不是字符。 */
const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

export interface LaunchedBrowser {
  connection: CdpConnection;
  newPage(url: string): Promise<CdpPage>;
  close(): Promise<void>;
}

/**
 * 启动 headless Chrome 并连上它。
 *
 * 端口用 0（让系统分配），再从 stderr 里读回真实的 DevTools 地址——这样并发跑
 * 多个探针不会撞端口。
 */
export async function launchHeadlessBrowser(
  browserPath: string,
  options: { timeoutMs?: number } = {},
): Promise<LaunchedBrowser> {
  const userDataDir = mkdtempSync(join(tmpdir(), "design-ai-a11y-"));
  const child = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let endpoint: string | undefined;
  let stderrBuffer = "";
  child.stderr?.on("data", chunk => {
    stderrBuffer += String(chunk);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderrBuffer);
    if (match) endpoint = match[1];
  });
  const spawnFailure = new Promise<never>((_, reject) => {
    child.once("error", error => reject(new Error(`启动浏览器失败：${error.message}`)));
  });

  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (!endpoint) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`浏览器没有在 ${timeoutMs}ms 内报出 DevTools 地址：${stderrBuffer.slice(-400)}`);
    }
    await Promise.race([new Promise(resolve => setTimeout(resolve, 50)), spawnFailure]);
  }

  const connection = await CdpConnection.connect(endpoint);

  const close = async () => {
    try {
      await connection.send("Browser.close");
    } catch {
      // 浏览器可能已经退出；忽略。
    }
    connection.close();
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // 临时目录残留不影响结果，下次运行会各自新建。
    }
  };

  const newPage = async (url: string): Promise<CdpPage> => {
    const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send("DOM.enable", {}, sessionId);
    await connection.send("Accessibility.enable", {}, sessionId);

    const page: CdpPage = {
      sessionId,
      async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        return connection.send<T>(method, params, sessionId);
      },
      async navigate(target: string) {
        const loaded = connection.once("Page.loadEventFired");
        await connection.send("Page.navigate", { url: target }, sessionId);
        await loaded;
      },
      async evaluate<T>(expression: string): Promise<T> {
        const response = await connection.send<any>(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        if (response?.exceptionDetails) {
          const text = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "未知错误";
          throw new Error(`页面脚本异常：${text}`);
        }
        return response?.result?.value as T;
      },
      async pressKey(key: string) {
        const spec = KEY_CODES[key];
        if (!spec) throw new Error(`未登记的按键：${key}`);
        const base = {
          key: spec.key,
          code: spec.code,
          windowsVirtualKeyCode: spec.keyCode,
          nativeVirtualKeyCode: spec.keyCode,
          modifiers: 0,
        };
        await connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
        await connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
      },
      async axTree(): Promise<AxTreeNode[]> {
        const { nodes } = await connection.send<{ nodes: any[] }>("Accessibility.getFullAXTree", {}, sessionId);
        return (nodes ?? []).map(node => ({
          nodeId: String(node.nodeId),
          ignored: node.ignored === true,
          role: node.role?.value ?? "",
          name: node.name?.value ?? "",
          focusable: (node.properties ?? []).some(
            (property: any) => property.name === "focusable" && property.value?.value === true,
          ),
          ...(node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }),
        }));
      },
    };

    if (url) await page.navigate(url);
    return page;
  };

  return { connection, newPage, close };
}
