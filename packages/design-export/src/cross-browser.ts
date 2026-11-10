/**
 * 跨浏览器像素基线的机制。
 *
 * 已有的画布像素基线只有一份，绑定「本机 + 本浏览器 + 本机字体」：换台机器、
 * 换个浏览器，差异是**环境差异**，但基线机制只会说「不一致」。跨浏览器基线把
 * 这层拆开：
 *
 * - 基线按 **引擎 + 平台** 分目录存放，每份基线自带**指纹**（引擎、版本、系统、
 *   字体集摘要、视口、DPR）；
 * - 比较时先比指纹：字体集不同就直接说「基线不可比」，而不是甩一堆像素差异；
 * - 目标引擎没有基线时**明确报告「未采集」**，并列出已有基线覆盖了哪些引擎与
 *   平台——既不静默通过（假装没问题），也不静默失败（只抛一句错）。
 *
 * 这个模块只管数据结构、路径布局、选取与比较；采集脚本在
 * `studio-web/visual/cross-browser.ts`，引擎适配器在 `design-export/visual/engines.ts`。
 */

/** 浏览器引擎。当前只区分到「渲染内核」这一层。 */
export type CrossBrowserEngineId = "chromium" | "firefox" | "webkit";

/** 一份基线的环境指纹。 */
export interface CrossBrowserFingerprint {
  /** 引擎。 */
  engine: CrossBrowserEngineId;
  /** 浏览器家族：Chrome / Edge / Firefox / Safari。 */
  family: string;
  /** 浏览器版本。 */
  version: string;
  /** 平台键（win32 / darwin / linux）。 */
  platform: string;
  /** 系统版本（`os.release()`）。 */
  osRelease: string;
  /** 原始 user agent。 */
  userAgent: string;
  /**
   * 字体集摘要（`fontSetDigest()`）。
   *
   * 它是「基线可不可比」的判据：摘要不同说明这台机器的字体与采集时不同，
   * 像素差异归因不到渲染回归。
   */
  fontDigest: string;
  /** 采集时的视口尺寸（CSS 像素）。 */
  viewport: { width: number; height: number };
  /** 采集时的设备像素比。 */
  deviceScaleFactor: number;
}

/** 一份基线。 */
export interface CrossBrowserBaseline {
  /** 场景标识（当前只有画布场景 `canvas`）。 */
  scene: string;
  engine: CrossBrowserEngineId;
  family: string;
  version: string;
  platform: string;
  /** PNG 相对路径（相对 manifest 所在目录）。 */
  image: string;
  fingerprint: CrossBrowserFingerprint;
  /** 采集时间（ISO）。 */
  collectedAt: string;
}

/** 基线清单。 */
export interface CrossBrowserManifest {
  version: 1;
  baselines: CrossBrowserBaseline[];
}

/**
 * 把一段标识压成能进目录名的一小段。
 *
 * 版本号里通常有 `.`（保留），但可能带空格或斜杠（不能出现）——统一转成 `-`。
 * 两个不同标识被压成同一个目录名是有可能的（`a b` 与 `a-b`），所以目录名只
 * 用来存放，真正的身份判定靠 manifest 里的字段。
 */
export function slugifySegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

/**
 * 基线 PNG 的相对路径。
 *
 * 布局是 `<引擎>/<平台>/<家族>-<版本>/<场景>.png`：一眼能看出这份基线是
 * 「哪个引擎、哪个平台」采的，不用打开 manifest。
 */
export function baselineImagePath(input: {
  scene: string;
  engine: CrossBrowserEngineId;
  family: string;
  version: string;
  platform: string;
}): string {
  const folder = `${slugifySegment(input.engine)}/${slugifySegment(input.platform)}/${slugifySegment(input.family)}-${slugifySegment(input.version)}`;
  return `${folder}/${slugifySegment(input.scene)}.png`;
}

/**
 * 浏览器身份（家族 + 版本）。
 */
export interface BrowserIdentity {
  family: string;
  version: string;
}

/**
 * 从 user agent 里解析浏览器家族与版本。
 *
 * 顺序有讲究：Edge 的 UA 里同时有 `Chrome/xxx` 与 `Edg/xxx`，Safari 的 UA 里
 * 既有 `Chrome`（WebKit 的兼容标识）也有 `Version/xxx`，先匹配到的才是真正的
 * 浏览器。headless Chrome 的 UA 带 `HeadlessChrome/`，值与 `Chrome/` 相同，
 * 正则取到的是同一个版本号。
 */
export function parseBrowserUserAgent(userAgent: string): BrowserIdentity | undefined {
  if (!userAgent) return undefined;
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  if (edge) return { family: "Edge", version: edge[1]! };
  const chrome = /Chrome\/([\d.]+)/.exec(userAgent);
  if (chrome) return { family: "Chrome", version: chrome[1]! };
  const firefox = /Firefox\/([\d.]+)/.exec(userAgent);
  if (firefox) return { family: "Firefox", version: firefox[1]! };
  const safari = /Version\/([\d.]+).*Safari/.exec(userAgent);
  if (safari) return { family: "Safari", version: safari[1]! };
  return undefined;
}

/** 选取基线时的条件。 */
export interface BaselineQuery {
  scene: string;
  engine: CrossBrowserEngineId;
  platform: string;
  /** 浏览器家族；给了就只在该家族里找。 */
  family?: string;
  /** 浏览器版本；给了但找不到精确版本时，会退到同家族最近一次采集的基线并给出提示。 */
  version?: string;
}

/** 选取结果。 */
export interface BaselineSelection {
  /** `found` 表示有可比对的基线（可能带版本漂移提示），`missing` 表示没有。 */
  status: "found" | "missing";
  baseline?: CrossBrowserBaseline;
  /** 说明（版本漂移、家族不符等）。 */
  notes: string[];
}

function newestOf(baselines: CrossBrowserBaseline[]): CrossBrowserBaseline {
  return [...baselines].sort((left, right) => (left.collectedAt < right.collectedAt ? -1 : left.collectedAt > right.collectedAt ? 1 : 0)).at(-1)!;
}

/**
 * 选取一份基线。
 *
 * 匹配顺序：场景 + 引擎 + 平台 → 再按家族收窄 → 再按版本收窄。
 * 版本收窄落空时不判失败：浏览器会自动升级，基线还在，只是版本旧了——
 * 这种情况下给出「版本漂移」提示，让差异归因有据可依。
 */
export function selectBaseline(manifest: CrossBrowserManifest, query: BaselineQuery): BaselineSelection {
  const inScope = manifest.baselines.filter(
    baseline => baseline.scene === query.scene && baseline.engine === query.engine && baseline.platform === query.platform,
  );
  if (!inScope.length) {
    return { status: "missing", notes: ["该引擎 / 平台还没有采集过基线"] };
  }

  const byFamily = query.family ? inScope.filter(baseline => baseline.family === query.family) : inScope;
  if (!byFamily.length) {
    const families = [...new Set(inScope.map(baseline => baseline.family))].join("、");
    return { status: "missing", notes: [`该引擎 / 平台下只有其它浏览器家族的基线（${families}）`] };
  }

  if (query.version) {
    const exact = byFamily.filter(baseline => baseline.version === query.version);
    if (exact.length) return { status: "found", baseline: newestOf(exact), notes: [] };
    const fallback = newestOf(byFamily);
    return {
      status: "found",
      baseline: fallback,
      notes: [`浏览器版本漂移：基线来自 ${fallback.family} ${fallback.version}，当前是 ${query.version}`],
    };
  }

  return { status: "found", baseline: newestOf(byFamily), notes: [] };
}

/**
 * 列出清单里已有的基线。
 *
 * 「未采集」的时候这句话最有用：告诉用户现在到底有哪些可比对的基线，而不是
 * 只说「没有」。
 */
export function describeAvailableBaselines(manifest: CrossBrowserManifest): string[] {
  return manifest.baselines.map(
    baseline =>
      `${baseline.engine} / ${baseline.platform} / ${baseline.family} ${baseline.version}`
      + `（场景 ${baseline.scene}，采集于 ${baseline.collectedAt.slice(0, 10)}）`,
  );
}

/** 指纹差异。 */
export interface FingerprintDifference {
  field: string;
  expected: string;
  actual: string;
  /** 说明这条差异意味着什么。 */
  note?: string;
}

/**
 * 比较两份指纹。
 *
 * 字体摘要不同是**最重要**的一条：它意味着两边的画面本来就可能不同，
 * 像素差异不能归因到渲染回归。其余差异（系统版本、视口、DPR）多是解释性信息。
 */
export function compareFingerprints(expected: CrossBrowserFingerprint, actual: CrossBrowserFingerprint): FingerprintDifference[] {
  const differences: FingerprintDifference[] = [];
  const push = (field: string, left: string, right: string, note?: string): void => {
    if (left !== right) differences.push({ field, expected: left, actual: right, ...(note ? { note } : {}) });
  };
  push("engine", expected.engine, actual.engine);
  push("family", expected.family, actual.family);
  push("version", expected.version, actual.version, "浏览器升级会带来真实的渲染差异");
  push("platform", expected.platform, actual.platform);
  push("osRelease", expected.osRelease, actual.osRelease);
  push(
    "fontDigest",
    expected.fontDigest,
    actual.fontDigest,
    "字体集不同：像素差异不能归因于渲染回归，基线不可比",
  );
  push(
    "viewport",
    `${expected.viewport.width}x${expected.viewport.height}`,
    `${actual.viewport.width}x${actual.viewport.height}`,
  );
  push("deviceScaleFactor", String(expected.deviceScaleFactor), String(actual.deviceScaleFactor));
  return differences;
}

/** 字体集是否变了。 */
export function fontSetChanged(expected: CrossBrowserFingerprint, actual: CrossBrowserFingerprint): boolean {
  return expected.fontDigest !== actual.fontDigest;
}

/**
 * 解析 manifest。
 *
 * 清单损坏必须**报错**而不是当成空清单：当成空清单会让检查脚本报「未采集」，
 * 看起来像缺基线，实际是文件坏了——两者的处理完全不同。
 */
export function parseManifest(text: string): CrossBrowserManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`基线清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("基线清单格式不对：顶层不是对象");
  const value = raw as { version?: unknown; baselines?: unknown };
  if (value.version !== 1) throw new Error(`基线清单版本不支持：${String(value.version)}`);
  if (!Array.isArray(value.baselines)) throw new Error("基线清单格式不对：baselines 不是数组");
  for (const [index, entry] of value.baselines.entries()) {
    if (!entry || typeof entry !== "object") throw new Error(`基线清单第 ${index + 1} 条不是对象`);
    const baseline = entry as Partial<CrossBrowserBaseline>;
    for (const field of ["scene", "engine", "family", "version", "platform", "image", "collectedAt"] as const) {
      if (typeof baseline[field] !== "string" || !baseline[field]) {
        throw new Error(`基线清单第 ${index + 1} 条缺少字段 ${field}`);
      }
    }
    if (!baseline.fingerprint || typeof baseline.fingerprint !== "object") {
      throw new Error(`基线清单第 ${index + 1} 条缺少 fingerprint`);
    }
  }
  return { version: 1, baselines: value.baselines as CrossBrowserBaseline[] };
}

/** 序列化 manifest（末尾留一个换行，方便 diff）。 */
export function serializeManifest(manifest: CrossBrowserManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * 往清单里写入（或替换）一份基线。
 *
 * 身份是「场景 + 引擎 + 平台 + 家族」：同一个组合重新采集就是**替换**，
 * 而不是不断追加——否则清单会攒下一串过期条目。
 */
export function upsertBaseline(manifest: CrossBrowserManifest, baseline: CrossBrowserBaseline): CrossBrowserManifest {
  const baselines = manifest.baselines.filter(
    entry =>
      !(
        entry.scene === baseline.scene
        && entry.engine === baseline.engine
        && entry.platform === baseline.platform
        && entry.family === baseline.family
      ),
  );
  baselines.push(baseline);
  baselines.sort((left, right) => {
    const key = (item: CrossBrowserBaseline): string => `${item.engine}/${item.platform}/${item.family}/${item.scene}`;
    return key(left).localeCompare(key(right));
  });
  return { version: 1, baselines };
}
