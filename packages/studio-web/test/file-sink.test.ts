import assert from "node:assert/strict";
import test from "node:test";
import { encodeBase64, isDesktop, saveFileOnDesktop } from "../src/desktop-bridge";
import { saveBytes, saveDataUrl, saveMessage, saveText } from "../src/file-sink";

/**
 * 桌面端落盘的回归测试。
 *
 * 规格见 `docs/desktop-app.md`。真正的「另存为」对话框在 Rust 侧（`save_file`
 * 命令），这里验证的是前端这一半：探测桌面端、传 base64、回报路径，以及
 * 浏览器分支保持原来的下载行为。
 *
 * 两边的差异全在 `file-sink` 里收口，所以这里把两条分支都钉住：桌面端多了
 * 「用户取消」这个结果，浏览器端不能多出这个结果。
 */

type InvokeCall = { command: string; args?: Record<string, unknown> };
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const scope = globalThis as unknown as Record<string, unknown>;

/** 装一个假的 Tauri 运行时，返回卸载函数。 */
function installTauri(invoke: Invoke): () => void {
  scope.__TAURI__ = { core: { invoke } };
  return () => { delete scope.__TAURI__; };
}

/** 装一个假的浏览器 DOM（只要能造出 <a download>）。 */
function installBrowserDom(): { downloads: { download: string; href: string }[]; restore: () => void } {
  const downloads: { download: string; href: string }[] = [];
  const previousDocument = scope.document;
  const urlConstructor = URL as unknown as { createObjectURL?: (blob: unknown) => string; revokeObjectURL?: (url: string) => void };
  const previousCreate = urlConstructor.createObjectURL;
  const previousRevoke = urlConstructor.revokeObjectURL;

  scope.document = {
    createElement: () => {
      const link = { download: "", href: "", click: () => { downloads.push({ download: link.download, href: link.href }); } };
      return link;
    },
  };
  urlConstructor.createObjectURL = () => "blob:fake";
  urlConstructor.revokeObjectURL = () => undefined;

  return {
    downloads,
    restore: () => {
      if (previousDocument === undefined) delete scope.document;
      else scope.document = previousDocument;
      if (previousCreate === undefined) delete urlConstructor.createObjectURL;
      else urlConstructor.createObjectURL = previousCreate;
      if (previousRevoke === undefined) delete urlConstructor.revokeObjectURL;
      else urlConstructor.revokeObjectURL = previousRevoke;
    },
  };
}

test("不在桌面端时探测不到 Tauri 运行时", () => {
  delete scope.__TAURI__;
  delete scope.__TAURI_INTERNALS__;
  assert.equal(isDesktop(), false);
});

test("base64 编码与原始字节一致（含 0x00 与 0xFF）", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  assert.equal(encodeBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("桌面端把字节以 base64 交给 save_file，并回报真实落盘路径", async () => {
  const calls: InvokeCall[] = [];
  const restore = installTauri(async (command, args) => {
    calls.push({ command, args });
    return "C:\\Users\\me\\首页.html";
  });
  try {
    const bytes = new TextEncoder().encode("<h1>你好</h1>");
    const result = await saveBytes("首页.html", bytes, "text/html");

    assert.equal(result.saved, true);
    assert.equal(result.path, "C:\\Users\\me\\首页.html");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "save_file");
    assert.equal(calls[0]!.args!.name, "首页.html");
    assert.equal(calls[0]!.args!.contents, Buffer.from(bytes).toString("base64"));
  } finally {
    restore();
  }
});

test("用户取消保存时不谎报成功", async () => {
  const restore = installTauri(async () => null);
  try {
    const result = await saveBytes("首页.png", new Uint8Array([1, 2, 3]), "image/png");
    assert.equal(result.saved, false);
    assert.equal(result.path, undefined);
    assert.equal(saveMessage(result, "PNG 已导出"), "已取消导出");
  } finally {
    restore();
  }
});

test("成功时提示带上真实落盘路径", () => {
  assert.equal(saveMessage({ saved: true, path: "D:\\导出\\首页.svg" }, "SVG 已导出"), "SVG 已导出 · D:\\导出\\首页.svg");
  assert.equal(saveMessage({ saved: true }, "SVG 已导出"), "SVG 已导出");
});

test("浏览器分支不碰 Tauri，走原来的下载", async () => {
  delete scope.__TAURI__;
  delete scope.__TAURI_INTERNALS__;
  const dom = installBrowserDom();
  try {
    const result = await saveText("首页.html", "<h1>你好</h1>", "text/html");
    assert.equal(result.saved, true);
    assert.equal(result.path, undefined);
    assert.equal(dom.downloads.length, 1);
    assert.equal(dom.downloads[0]!.download, "首页.html");
    assert.equal(dom.downloads[0]!.href, "blob:fake");
  } finally {
    dom.restore();
  }
});

test("data URL 在桌面端先解成字节再交给 save_file", async () => {
  const calls: InvokeCall[] = [];
  const restore = installTauri(async (command, args) => {
    calls.push({ command, args });
    return "D:\\导出\\首页.png";
  });
  try {
    const payload = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const dataUrl = `data:image/png;base64,${Buffer.from(payload).toString("base64")}`;
    const result = await saveDataUrl("首页.png", dataUrl);

    assert.equal(result.saved, true);
    assert.equal(result.path, "D:\\导出\\首页.png");
    assert.equal(calls[0]!.args!.contents, Buffer.from(payload).toString("base64"));
  } finally {
    restore();
  }
});

test("只有内部入口时也认得桌面端", async () => {
  delete scope.__TAURI__;
  const calls: InvokeCall[] = [];
  scope.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return "E:\\导出\\备份.json";
    },
  };
  try {
    assert.equal(isDesktop(), true);
    const path = await saveFileOnDesktop("备份.json", new Uint8Array([1]));
    assert.equal(path, "E:\\导出\\备份.json");
    assert.equal(calls[0]!.command, "save_file");
  } finally {
    delete scope.__TAURI_INTERNALS__;
  }
});
