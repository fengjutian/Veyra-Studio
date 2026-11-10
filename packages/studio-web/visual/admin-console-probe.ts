/**
 * 「AI 生成一整套后台管理端页面」验收探针。
 *
 *   npm run visual:admin-console
 *   npm run visual:admin-console -- --pages=dashboard,users --out=.artifacts/admin-console
 *   npm run visual:admin-console -- --stub
 *
 * ## 回答什么问题
 *
 * 这个仓库能「一句话 → 设计稿」，但**多页**才是后台管理端的真实形态：
 * 数据总览、列表、详情、表单、设置、登录……用户要的不是一张图，而是**一套**页面。
 * 这里要回答的是：**一次生成能不能给出好几页，而且这几页看起来像同一个产品。**
 *
 * 「风格统一」不能靠嘴说，所以这条探针把它拆成三件可判定的事：
 *
 * 1. **设计系统先行**：先让模型定一套 token（颜色/圆角/字号），落到文档里；
 * 2. **每页同源**：后续每一页的提示里都带同一份 token 清单 + 同一份骨架坐标，
 *    文档摘要里还带着前一页的真实节点——模型是在照着已有页面继续画；
 * 3. **事后审计**：生成完把每页实际用到的颜色/圆角/字号取出来，与 token 比对，
 *    报告里写清楚哪些值偏了。**统一是量出来的，不是说出来的。**
 *
 * ## 走的是产品同一条路
 *
 *   一句话 → Planner（仓库自己的提示与解析器）→ 命令计划
 *          → dry-run（领域校验）→ 结构审查 → 事务提交
 *          → 画布渲染（Canvas 2D）→ PNG
 *
 * 中间没有一步是探针自己实现的：计划用 `SafeAiEditor.createPlan`，提交用 `confirm`，
 * 出图用 `capturePageScreenshot`——与「视觉上下文」给模型看图的是同一个渲染器。
 * 唯一的差别是：模型返回的**颜色**会被归一化到 token 调色板（见 `enforcePalette`），
 * 这是「风格统一」这一条验收标准的执行手段，会在报告里逐条列出改了什么。
 *
 * ## 凭据
 *
 * 真实模型那一跑需要端点与密钥。优先读环境变量
 * （`STUDIO_PROVIDER_BASE` / `STUDIO_PROVIDER_MODEL` / `STUDIO_PROVIDER_KEY`，
 * 或 `--env-file=` 指定的文件）；都没有时读**工作台自己已经保存的那份**——
 * studio-desktop 的 WebView2 存储里有用户配好的端点与密钥环，密钥只在
 * sessionStorage 里，探针只取用、不落盘、不写进报告。
 *
 * 没有凭据时用 `--stub` 跑确定性替身：它只能证明**链路是通的**，
 * **不能**证明「AI 会设计」，两者在报告里分开写。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { StudioProject } from "@ufira/studio-application";
import { SafeAiEditor, createOpenAiCompatiblePlanner, type AiPlanner, type AiPlanRequest } from "@ufira/ai-orchestrator";
import { buildSelfCheckReport, collectSelfCheck, type SelfCheckContext } from "@ufira/ai-orchestrator";
import type { DesignCommand } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";
import { findBrowser } from "../../design-export/visual/browser";
import { buildHarness } from "./build-harness";
import { launchHeadlessBrowser } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const OUT_DIR = join(root, ".artifacts", "admin-console");

/** 每一页的画布尺寸。桌面端后台的常见宽度，够放侧栏 + 内容区。 */
const PAGE_WIDTH = 1440;
const PAGE_HEIGHT = 900;
/** 每页最多让模型改几版。回喂次数会写进报告，不能悄悄吞掉。 */
const MAX_ATTEMPTS = 3;
/** 颜色归一化的距离阈值：只有「几乎同一个色」（差 ≤18）才吸附到调色板。 */
const SNAP_DISTANCE = 18;

/**
 * 一次生成多少个节点。
 *
 * 这是**速度与细节的取舍点**：一条 node.create 带完整节点对象，40 条就是一万多 token。
 * 推理模型出得慢，节点一多就容易顶到超时。所以页面按「骨架 + 关键内容」来生成，
 * 细节靠骨架坐标与组件化结构补齐，而不是靠堆节点。
 */
const NODE_BUDGET = { min: 12, max: 22 };

interface Args {
  outDir: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  envFile?: string;
  pages: string[];
  stub: boolean;
  render: boolean;
  /** 接着上一次跑：项目里已有的页面不再重做。 */
  resume: boolean;
  /** 重画已存在的页面（清掉旧节点再生成）。 */
  force: boolean;
  /** 是否关掉模型思考：off / auto。 */
  thinking: "auto" | "off";
}

/** 要生成的页面。id 必须与文档里的页面 id 一致。 */
export interface PageSpec {
  id: string;
  name: string;
  /** 页面里要放什么内容。 */
  brief: string;
  /** 登录页没有侧栏与顶栏，骨架不一样。 */
  bare?: boolean;
}

export const PAGE_SPECS: PageSpec[] = [
  {
    id: "page:dashboard",
    name: "数据总览",
    brief: [
      "内容区自上而下分三块：",
      "1) 4 张 KPI 卡片横排（每张 264×120，间距 24）：总营收 / 订单数 / 活跃用户 / 退款率；",
      "   每张卡里是指标名（13px 文本次色）、大数字（30px/700）、环比变化（小字 + 涨跌颜色：涨用成功色、跌用危险色）。",
      "   四张卡各自都要有自己的三个文本节点，不要把多个指标写进同一张卡，也不要留空卡。",
      "2) 中间一行：左边一张「近 30 日趋势」卡片（816×280，里面是标题 + 一张由折线/柱状片段组成的示意图 + 底部图例），",
      "   右边一张「待办事项」卡片（316×280，5 条待办，每条一个圆点 + 文案 + 右侧时间）。",
      "3) 底部一张「最近订单」卡片（1136×260）：表头（订单号/客户/金额/状态/时间）+ 5 行数据，状态用彩色标签。",
    ].join("\n"),
  },
  {
    id: "page:users",
    name: "用户管理",
    brief: [
      "内容区自上而下：",
      "1) 一张筛选卡片（1136×120）：搜索框（240×36）、3 个下拉框（角色/状态/注册时间，各 160×36）、右侧「查询」「重置」两个按钮。",
      "2) 批量操作条（1136×56）：左侧一个全选框 + 「已选 0 项」，右侧「批量禁用」「导出」两个次要按钮。",
      "3) 用户表格卡片（1136×560）：表头（用户/邮箱/角色/状态/最近登录/操作）6 列 + 8 行数据；",
      "   每行第一个是一个头像圆（32×32）+ 用户名；状态用彩色标签；操作列是「编辑」「删除」两个文字按钮。",
      "4) 表格底部一条分页条：左侧「共 128 条」，右侧上一页/页码/下一页。",
    ].join("\n"),
  },
  {
    id: "page:user-detail",
    name: "用户详情",
    brief: [
      "内容区左侧一列（320 宽）、右侧一列（800 宽）：",
      "1) 左列：一张用户资料卡（320×300）：头像（72×72 圆形）、姓名（20px/700）、邮箱、角色标签、状态标签、注册时间、两个按钮（编辑资料 / 停用账号）。",
      "   下面一张「账户概览」卡（320×220）：4 行「标签 — 数值」样式的信息（余额、积分、优惠券、最后登录）。",
      "2) 右列顶部一条标签页（800×40）：标签「基本信息 / 订单记录 / 操作日志 / 权限」，当前选中项有主色下划线。",
      "3) 右列主体：两张信息分组卡（800×220 各一张），卡内是「字段名（13px 文本次色）— 值」的左对齐两列排布，每张卡 8 行；",
      "   最下面一张「操作日志」卡（800×300）：5 条时间线记录（时间 13px 文本次色 + 事件文案 + 右侧 IP）。",
    ].join("\n"),
  },
  {
    id: "page:orders",
    name: "订单管理",
    brief: [
      "内容区自上而下：",
      "1) 一排状态标签页（全部 128 / 待付款 12 / 待发货 8 / 已发货 45 / 已完成 51 / 已退款 12），当前选中项主色文字 + 主色下划线。",
      "2) 一张工具条（1136×56）：左边一个搜索框 + 一个下拉，右边「导出」「新建订单」两个按钮。",
      "3) 订单表格卡片（1136×600）：表头（订单号/客户/商品/金额/状态/下单时间/操作）7 列 + 9 行；",
      "   金额右对齐并用等宽数字感（fontWeight 600）；状态用彩色标签（待付款=警告色、待发货=信息色、已完成=成功色、已退款=中性色）；",
      "   操作列是「查看」「退款」两个文字按钮。",
      "4) 底部一条分页条（左右分布：总数 + 页码）。",
    ].join("\n"),
  },
  {
    id: "page:order-create",
    name: "新建订单",
    brief: [
      "内容区左右两列：左列 720 宽放表单卡，右列 384 宽放摘要卡。",
      "1) 左列三张表单卡（各 720×高）：",
      "   - 「基本信息」：商品名称输入框、SKU 下拉、数量步进器（一个方框内加 - 号、数字、加号）、单价输入框；",
      "   - 「收货信息」：收货人、联系电话、省市区三级选择（并排三个下拉）、详细地址多行输入区；",
      "   - 「支付方式」：3 个单选卡片横排（对公转账 / 在线支付 / 账期），其中一个选中态是主色边框 + 主色底。",
      "   每张卡里字段标签 13px 文本次色在左、输入框 36 高、字段间距 20。",
      "2) 右列一张「订单摘要」卡（384×360）：商品行、运费、折扣、合计（大号 24px/700，右对齐）；下面一张「备注」卡（384×200）：多行文本。",
      "3) 底部操作条（1136×64，右对齐）：「取消」次要按钮 + 「创建订单」主按钮。",
    ].join("\n"),
  },
  {
    id: "page:settings",
    name: "系统设置",
    brief: [
      "内容区左列 220 宽放二级菜单，右列 880 宽放设置表单：",
      "1) 二级菜单（220×420）：7 项（基本信息 / 成员与权限 / 通知设置 / 集成 / 计费 / 安全 / 高级），当前项有主色左边条 + 浅主色底。",
      "2) 右侧第一张「基本信息」卡（880×320）：字段名在左（160 宽）、控件在右（输入框 320 高 36、下拉 200×36），共 5 行。",
      "3) 右侧第二张「通知设置」卡（880×260）：3 行开关行，每行左侧标题 + 13px 说明，右侧是一个 36×20 的开关（开启时主色、关闭时灰色，滑块是 16px 白色圆）。",
      "4) 底部操作条：右对齐「放弃修改」「保存设置」两个按钮。",
    ].join("\n"),
  },
  {
    id: "page:login",
    name: "登录",
    bare: true,
    brief: [
      "这一页没有侧栏也没有顶栏。整页是页面背景色，中间偏上放一张登录卡片（400×420，圆角 12，白色表面 + 边框）：",
      "1) 卡片顶部：产品 logo 方块（40×40，主色圆角 10）+ 标题「Veyra 管理后台」（20px/700）+ 副标题「请使用企业账号登录」（13px 文本次色）。",
      "2) 表单：邮箱输入框（336×40）、密码输入框（336×40），标签在上（13px 文本次色）。",
      "3) 一行「记住我」勾选框 + 右侧「忘记密码?」文字链接。",
      "4) 主按钮「登录」（336×40，主色填充、白色文字、圆角 8）。",
      "5) 卡片底部一行小字（12px 弱色）：「© 2026 Veyra. 保留所有权利。」",
      "页面底部正中放一个 13px 弱色的版本号文本。",
    ].join("\n"),
  },
];

/** 有侧栏的页面共用的骨架：坐标写死，所有页面照抄，风格自然统一。 */
const SHELL_SPEC = `【页面骨架 —— 除了登录页，所有页面都严格按这套坐标】
- 侧边导航 frame：x=0, y=0, width=240, height=900，填充=侧栏底色（color.bg.sidebar）。
  - logo 区：x=0, y=0, width=240, height=72，内含一个 28×28 圆角 8 的主色方块 + 右侧产品名（16px/700，主色文字）。
  - 导航分组标题：x=16, y=92, width=208, height=20，12px/600，字间距 0.5，文本次色。
  - 导航项：x=8, width=224, height=40，纵向依次排列，间距 4；每项 = 16×16 圆角 4 图标方块（主色/中性灰）+ 右侧 14px 文案（次色）。
    当前选中项：整项填充=浅主色底，左侧一条 3px 宽的主色竖条，文案变主色且 500 字重。
  - 底部用户区：x=0, y=812, width=240, height=88，顶部一条 1px 分隔线；里面 32×32 圆形头像 + 姓名（14px/600）+ 角色（12px 文本次色）。
- 顶栏 frame：x=240, y=0, width=1200, height=64，填充=表面色（color.bg.surface），底部一条 1px 边框（color.border.default）。
  - 左侧页面标题：x=272, y=18, 18px/700，主文本色；标题左边 8px 处放一个 20×20 的返回/菜单图标占位。
  - 右侧：搜索框（240×32，圆角 6，浅灰底）、一个 20×20 通知图标方块、32×32 圆形头像，彼此间距 16，右端距边 24。
- 内容区 frame：x=240, y=64, width=1200, height=836，填充=页面背景色（color.bg.app）。
  内容区里的所有元素坐标都相对内容区左上角；常见边距 32，卡片之间间距 24，卡片内边距 20~24。`;

/** 每一页都要遵守的硬性规则。 */
const HARD_RULES = `【硬性规则】
1. 所有节点的 layout.mode 一律用 "absolute"，坐标相对父节点，widthMode 与 heightMode 一律 "fixed"。
2. 字体族一律写 "Inter"，字重只用 400 / 500 / 600 / 700；正文字号 13/14，标题 16/18/20/24。
3. 行高 = 字号 × 1.5（标题可以 1.3）。文本节点要写固定宽度以便换行，高度按 行数 × 行高 给足。
4. 颜色只能从【设计系统】的 token 值里挑；不要自己发明新色值，也不要用带透明度的写法（除阴影外）。
5. 卡片：填充=表面色，圆角 12（radius.lg），1px 边框（color.border.default）；需要浮起感时加阴影 { "x": 0, "y": 1, "blur": 3, "color": "rgba(15,23,42,0.06)" }。
6. 按钮：主按钮=主色填充 + 白色文字；次要按钮=表面色 + 1px 边框 + 主文本色；高度 36，圆角 8。
7. 标签（状态徽章）：圆角 6，小字号 12，浅色底 + 同色系深色文字，内边距 8~12。
8. 图标用圆角矩形/椭圆占位即可，不要用矢量路径。
9. 只新建当前页需要的节点，parentId 只能是当前页面 id 或本页新建的 frame id；不要改动已存在的节点。
10. commands 里 node.create 的数量控制在 ${NODE_BUDGET.min}~${NODE_BUDGET.max} 条之间。节点不够表达这一页时，
    用**一个 frame 承载一组同类元素**（比如一行表格行、一列导航项、一个卡片组）而不是逐个展开——
    但 **frame 里面必须再放 text 子节点**，空的 frame 不算画完了。宁可少画一点，也不要超出这个数量。
11. **坐标一律取整数，宽度按经验给整**（例如 180 / 160 / 120 / 96）。不要逐字符推算文本宽度、
    不要为了对齐去算全角字符占几个像素——那会让计划写不完。视觉上大致齐整即可。
12. **子节点的坐标相对它自己的父 frame**。卡片里的文字，x/y 是相对**那张卡片**的
    （一般从 x=16~24、y=12~16 起）；不要写成相对卡片组或内容区的坐标——
    那会让文字掉到卡片外面去。
13. **每个卡片都要有自己的文字**。不要把好几个指标塞进同一张卡，也不要留空卡片：
    4 张 KPI 卡就是 4 组「指标名 / 数值 / 环比」三个文本节点。
    **整页必须有文字**：标题、导航文案、按钮文字、表格内容都要有——只有 frame 没有文字的页面等于没画。
14. **不要用 runs**。runs 要写字符起止偏移，模型算不准就会让整份计划作废；
    文字颜色、字号统一用 node.create / node.patch 里的 appearance 与 fontSize 整块设置。
15. **不要用 node.patch / node.delete 去改任何已存在的节点**，更不要改别的页面的节点：
    这一页要的东西一律用 node.create 新建。参照的用途只是对齐样式。
16. 没有描边就**不要写** stroke 和 strokeWidth；有描边就写 1（标准）或 2（强调）。
17. **直接输出 JSON，不要输出任何解释、计算过程或注释**。`;

interface Credentials {
  baseUrl: string;
  model: string;
  apiKey: string;
  source: string;
}

interface ProviderConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  const pages = value("--pages=");
  return {
    outDir: value("--out=") ?? OUT_DIR,
    baseUrl: value("--base-url="),
    model: value("--model="),
    apiKey: value("--api-key="),
    envFile: value("--env-file="),
    pages: pages ? pages.split(",").map(item => item.trim()).filter(Boolean) : PAGE_SPECS.map(spec => spec.id),
    stub: argv.includes("--stub"),
    render: !argv.includes("--no-render"),
    resume: argv.includes("--resume"),
    force: argv.includes("--force"),
    thinking: value("--thinking=") === "off" ? "off" : "auto",
  };
}

/** 读 `KEY=VALUE` 形式的文件；`#` 开头是注释。 */
function readEnvFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const file = resolve(path);
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

/**
 * 端点与密钥。
 *
 * 优先环境变量，其次读工作台自己保存的那份（studio-desktop 的 WebView2 存储：
 * 端点与模型名在 localStorage，密钥在 sessionStorage 的密钥环里）。
 * 密钥**只取用**，不落盘、不进报告。
 */
function resolveCredentials(args: Args): Credentials | undefined {
  const file = readEnvFile(args.envFile);
  const envBase = (process.env.STUDIO_PROVIDER_BASE ?? file.STUDIO_PROVIDER_BASE ?? "").trim();
  const envModel = (process.env.STUDIO_PROVIDER_MODEL ?? file.STUDIO_PROVIDER_MODEL ?? "").trim();
  const envKey = (process.env.STUDIO_PROVIDER_KEY ?? file.STUDIO_PROVIDER_KEY ?? "").trim();
  if (envBase && envModel && envKey) {
    return { baseUrl: envBase, model: envModel, apiKey: envKey, source: "环境变量" };
  }
  if (args.baseUrl && args.model && args.apiKey) {
    return { baseUrl: args.baseUrl, model: args.model, apiKey: args.apiKey, source: "命令行参数" };
  }

  const studio = readStudioSettings();
  if (studio) {
    const baseUrl = args.baseUrl ?? studio.baseUrl;
    const model = args.model ?? studio.model;
    const apiKey = args.apiKey ?? studio.apiKeys[0];
    if (baseUrl && model && apiKey) {
      return { baseUrl, model, apiKey, source: "工作台已保存的模型配置" };
    }
  }
  return undefined;
}

/** 读 studio-desktop 的 WebView2 存储：端点/模型 + 密钥环。 */
function readStudioSettings(): { baseUrl: string; model: string; apiKeys: string[] } | undefined {
  const dataDir = process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", "AppData", "Local");
  const profile = join(dataDir, "app.ufira.design-studio", "EBWebView", "Default");
  if (!existsSync(profile)) return undefined;

  const localText = readStorageText(join(profile, "Local Storage", "leveldb"));
  const sessionText = readStorageText(join(profile, "Session Storage"));
  if (!localText && !sessionText) return undefined;

  const baseUrl = /"baseUrl"\s*:\s*"([^"]+)"/.exec(localText)?.[1] ?? "";
  const model = /"model"\s*:\s*"([^"]+)"/.exec(localText)?.[1] ?? "";
  const apiKeys = [...new Set([...sessionText.matchAll(/sk-[A-Za-z0-9_-]{20,}/g)].map(match => match[0]))];
  if (!baseUrl || !model || !apiKeys.length) return undefined;
  return { baseUrl, model, apiKeys };
}

/**
 * 读一个存储目录里的文本。
 *
 * leveldb 的字符串是 UTF-16LE（字符之间夹 0x00），先按 latin1 读再去掉 NUL，
 * 否则匹配不到任何东西。
 */
function readStorageText(directory: string): string {
  if (!existsSync(directory)) return "";
  const chunks: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      try {
        chunks.push(readFileSync(full).toString("latin1").replace(/\u0000/g, ""));
      } catch {
        // 读不到就跳过：存储文件可能被浏览器锁着。
      }
    }
  };
  walk(directory, 0);
  return chunks.join("\n");
}

/* ------------------------------------------------------------------ *
 * 设计系统
 * ------------------------------------------------------------------ */

interface Palette {
  /** 调色板里的颜色（token 的值）。 */
  colors: string[];
  /** 圆角档位。 */
  radii: number[];
  /** 字号档位。 */
  fontSizes: number[];
}

export interface DesignSystem {
  summary: string;
  tokens: Array<{ name: string; type: string; value: string }>;
  palette: Palette;
}

/** 让模型先定一套设计系统——这是「风格统一」的源头。 */
export function designSystemPrompt(): string {
  return [
    "先为这个后台管理端定一套**设计系统**，以 token 的形式写进文档。这一步不要创建任何节点。",
    "",
    "请用 token.upsert 命令建立这些 token（名字可以微调，但用途要对得上）：",
    "",
    "- 颜色：",
    "  - color.bg.app（页面背景）、color.bg.surface（卡片/顶栏表面）、color.bg.sidebar（侧栏底色）、color.bg.muted（浅灰底，用于输入框/表头）",
    "  - color.border.default（默认边框）、color.border.strong（强调边框）",
    "  - color.text.primary（主文本）、color.text.secondary（次要文本）、color.text.tertiary（弱文本）、color.text.inverse（深底上的文字）",
    "  - color.brand.primary（主色）、color.brand.primary.soft（主色的浅底，用于选中态）",
    "  - color.status.success / warning / danger / info，以及各自的 .soft 浅底",
    "  - color.chart.1 ~ color.chart.6（图表与数据可视化用的系列色，彼此要能区分开）",
    "- 数字：radius.sm / radius.md / radius.lg（圆角档位，建议 4/8/12）、space.1 ~ space.6（间距档位，建议 4/8/12/16/24/32）、",
    "  font.size.xs / sm / md / lg / xl / xxl（字号档位，建议 12/13/14/16/18/20 或 24）。",
    "",
    "这是一套**克制**的后台系统：中性色打底，一个主色做强调，状态色只用于状态，图表色彼此拉开差距。",
    "主色请用现代 SaaS 常见的靛蓝或蓝紫色系（例如 #4f46e5 / #2563eb 一类），不要用大红大紫。",
    "所有色值都写 6 位十六进制（#rrggbb）。",
    "",
    "只输出 token.upsert 命令，不要创建节点、不要创建页面。",
  ].join("\n");
}

/** 从文档的 token 表里取出调色板。 */
function extractPalette(document: DesignDocument): Palette {
  const colors: string[] = [];
  const radii: number[] = [];
  const fontSizes: number[] = [];
  for (const [name, token] of Object.entries(document.tokens)) {
    if (token.type === "color" && typeof token.value === "string") {
      colors.push(token.value.toLowerCase());
      continue;
    }
    if (token.type !== "number" || typeof token.value !== "number") continue;
    if (/^radius\./i.test(name)) radii.push(token.value);
    else if (/font\.size|^size\.|fontSize/i.test(name)) fontSizes.push(token.value);
  }
  return {
    colors: [...new Set(colors)],
    radii: [...new Set(radii)].sort((a, b) => a - b),
    fontSizes: [...new Set(fontSizes)].sort((a, b) => a - b),
  };
}

/* ------------------------------------------------------------------ *
 * 调色板归一化（把「风格统一」这条验收标准落到执行上）
 * ------------------------------------------------------------------ */

/**
 * 生成后的事后归一化：把页面里**不在调色板内**的颜色改回最近的调色板色。
 *
 * 为什么要在提交后再来一遍：计划阶段只能拦住模型**新写**出来的颜色，
 * 但文档里已有的节点、以及模型在多次重试里逐步写出来的颜色，只有落地之后
 * 才看得全。这里走的是仓库自己的 `node.patch` 命令（appearance 是整块替换，
 * 所以先把原 appearance 完整复制一份再改颜色，避免把圆角、描边、阴影丢掉）。
 *
 * 改动会逐条写进报告——「统一风格」这件事必须有账可查。
 */
async function enforcePageStyle(project: StudioProject, pageId: string, palette: Palette): Promise<Snapped[]> {
  if (!palette.colors.length) return [];
  const document = project.snapshot();
  const page = document.pages[pageId];
  if (!page) return [];

  const commands: DesignCommand[] = [];
  const changes: Snapped[] = [];

  const visit = (nodeId: string): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    const appearance = node.appearance;
    const fills = appearance.fills ?? [];
    let touched = false;
    const nextFills = fills.map(fill => {
      if (fill.type !== "solid") return fill;
      const snapped = nearestPaletteColor(fill.color, palette);
      if (!snapped) return fill;
      touched = true;
      changes.push(snapped);
      return { ...fill, color: snapped.to };
    });
    let nextStroke = appearance.stroke;
    if (typeof appearance.stroke === "string") {
      const snapped = nearestPaletteColor(appearance.stroke, palette);
      if (snapped) {
        nextStroke = snapped.to;
        touched = true;
        changes.push(snapped);
      }
    }
    if (touched) {
      // appearance 是整块替换：把原来的字段完整带上，只换颜色。
      const nextAppearance = structuredClone(appearance);
      if (nextAppearance.fills) nextAppearance.fills = nextFills;
      if (nextStroke !== undefined) nextAppearance.stroke = nextStroke;
      commands.push({ type: "node.patch", payload: { id: node.id, patch: { appearance: nextAppearance } } });
    }
    for (const childId of node.childIds) visit(childId);
  };

  for (const childId of page.childIds) visit(childId);
  if (!commands.length) return changes;

  const current = project.snapshot();
  await project.execute({
    commandId: `probe:style:${pageId}`,
    documentId: current.id,
    baseRevision: current.revision,
    actor: { type: "integration", id: "admin-console-probe" },
    commands,
  });
  return changes;
}

interface Snapped {
  from: string;
  to: string;
  distance: number;
}

/** 解析 #rgb / #rrggbb；其它写法（rgba、颜色名）不参与归一化。 */
function parseHex(color: string): [number, number, number] | undefined {
  const value = color.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(value);
  if (short) {
    const digits = short[1]!.split("");
    return [parseInt(digits[0]! + digits[0]!, 16), parseInt(digits[1]! + digits[1]!, 16), parseInt(digits[2]! + digits[2]!, 16)];
  }
  const long = /^#([0-9a-f]{6})$/.exec(value);
  if (!long) return undefined;
  const hex = long[1]!;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** 找最接近的调色板颜色；差得太远就返回 undefined（保留原值，交给审计报告）。 */
function nearestPaletteColor(color: string, palette: Palette): Snapped | undefined {
  const source = parseHex(color);
  if (!source) return undefined;
  let best: Snapped | undefined;
  for (const candidate of palette.colors) {
    const target = parseHex(candidate);
    if (!target) continue;
    const distance = colorDistance(source, target);
    if (!best || distance < best.distance) best = { from: color, to: candidate, distance };
  }
  if (!best || best.distance > SNAP_DISTANCE) return undefined;
  return best;
}

function nearestNumber(value: number, candidates: number[], tolerance: number): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= tolerance ? best : undefined;
}

/** 把一条命令里的节点外观归一化到调色板。 */
function enforceAppearance(appearance: Record<string, unknown> | undefined, palette: Palette, changes: Snapped[]): void {
  if (!appearance || typeof appearance !== "object") return;
  const fills = appearance.fills;
  if (Array.isArray(fills)) {
    for (const fill of fills) {
      if (!fill || typeof fill !== "object") continue;
      const paint = fill as Record<string, unknown>;
      if (paint.type !== "solid" || typeof paint.color !== "string") continue;
      const snapped = nearestPaletteColor(paint.color, palette);
      if (!snapped) continue;
      paint.color = snapped.to;
      changes.push(snapped);
    }
  }
  if (typeof appearance.stroke === "string") {
    const snapped = nearestPaletteColor(appearance.stroke, palette);
    if (snapped) {
      appearance.stroke = snapped.to;
      changes.push(snapped);
    }
  }
  if (typeof appearance.cornerRadius === "number" && palette.radii.length) {
    const snapped = nearestNumber(appearance.cornerRadius, palette.radii, 2);
    if (snapped !== undefined) appearance.cornerRadius = snapped;
  }
}

/**
 * 把模型返回的计划里的颜色/圆角/字号归一化。
 *
 * 只动「几乎同一个色」（差 ≤18）——差得远的保留原值并写进审计，
 * 因为那多半是模型有意的设计决定，不是跑偏。
 */
function enforcePlan(plan: { commands: unknown[] }, palette: Palette): Snapped[] {
  const changes: Snapped[] = [];
  for (const command of plan.commands as Array<{ type?: string; payload?: Record<string, unknown> }>) {
    const payload = command.payload;
    if (!payload) continue;
    if (command.type === "node.create" || command.type === "component.instantiate") {
      const node = payload.node as Record<string, unknown> | undefined;
      if (!node) continue;
      enforceAppearance(node.appearance as Record<string, unknown> | undefined, palette, changes);
      if (typeof node.fontSize === "number" && palette.fontSizes.length) {
        const snapped = nearestNumber(node.fontSize, palette.fontSizes, 1);
        if (snapped !== undefined) node.fontSize = snapped;
      }
      if (typeof node.fontFamily === "string" && node.fontFamily.trim() !== "Inter") node.fontFamily = "Inter";
      continue;
    }
    if (command.type === "node.patch") {
      const patch = payload.patch as Record<string, unknown> | undefined;
      if (!patch) continue;
      enforceAppearance(patch.appearance as Record<string, unknown> | undefined, palette, changes);
      continue;
    }
    if (command.type === "text.patch") {
      const patch = payload.patch as Record<string, unknown> | undefined;
      if (patch && typeof patch.fontSize === "number" && palette.fontSizes.length) {
        const snapped = nearestNumber(patch.fontSize, palette.fontSizes, 1);
        if (snapped !== undefined) patch.fontSize = snapped;
      }
    }
  }
  return changes;
}

/* ------------------------------------------------------------------ *
 * 生成
 * ------------------------------------------------------------------ */

interface PageOutcome {
  pageId: string;
  name: string;
  ok: boolean;
  attempts: number;
  rounds: string[];
  summary?: string;
  assumptions?: string[];
  nodeCount: number;
  warnings: string[];
  review: string[];
  snapped: Snapped[];
  error?: string;
}

interface DesignSystemOutcome {
  ok: boolean;
  summary?: string;
  rounds: string[];
  tokens: Array<{ name: string; type: string; value: string }>;
  palette: Palette;
  error?: string;
}

/** 跑一次「提示 → 计划 → dry-run → 审查 → 提交」。 */
async function runStep(
  editor: SafeAiEditor,
  prompt: string,
  options: { pageId?: string; label?: string; rawDir?: string; selfCheck?: SelfCheckContext } = {},
): Promise<{ ok: boolean; rounds: string[]; summary?: string; assumptions?: string[]; warnings: string[]; review: string[]; error?: string }> {
  const rounds: string[] = [];
  let feedback = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const request = feedback ? `${prompt}\n\n上一版的命令没跑通，请修正后重新给出完整计划（不要只给改动）：\n${feedback}` : prompt;
    const startedAt = Date.now();
    // 流式进度：模型生成整页计划要一两分钟，没有进度就看不出是在跑还是卡住。
    let lastReport = 0;
    let raw = "";
    const onDelta = (_delta: string, fullText: string): void => {
      raw = fullText;
      if (fullText.length - lastReport < 4000) return;
      lastReport = fullText.length;
      console.log(`    …${options.label ?? ""}模型正在生成（已 ${fullText.length} 字，${Math.round((Date.now() - startedAt) / 1000)}s）`);
    };
    // 原始回复落盘：解析失败时，「模型到底写了什么」比报错信息有用得多。
    const rawPath = options.rawDir ? join(options.rawDir, `${options.label ?? "step"}-attempt${attempt}.txt`) : undefined;
    if (rawPath) mkdirSync(dirname(rawPath), { recursive: true });
    try {
      const preview = await editor.createPlan(request, [], {
        ...(options.pageId ? { pageId: options.pageId } : {}),
        ...(options.selfCheck ? { selfCheck: options.selfCheck } : {}),
        onDelta,
      });
      if (rawPath) {
        try {
          writeFileSync(rawPath, raw, "utf8");
        } catch {
          // 落盘失败不影响主流程。
        }
      }
      const review = preview.review.findings.map(finding => `[${finding.severity}] ${finding.message}`);
      if (preview.review.blocking) {
        rounds.push(`第 ${attempt} 次：结构审查拦下（${Date.now() - startedAt}ms）—— ${review.join("；")}`);
        feedback = `结构审查发现：${review.join("；")}`;
        continue;
      }
      await editor.confirm(preview.planId);
      rounds.push(`第 ${attempt} 次：成功，落地 ${preview.commands.length} 条命令（${Date.now() - startedAt}ms）`);
      return {
        ok: true,
        rounds,
        summary: preview.summary,
        assumptions: preview.assumptions,
        warnings: preview.warnings,
        review,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (rawPath) {
        try {
          writeFileSync(rawPath, raw, "utf8");
        } catch {
          // 落盘失败不影响主流程。
        }
      }
      rounds.push(`第 ${attempt} 次：失败（${Date.now() - startedAt}ms）—— ${message.slice(0, 400)}`);
      feedback = message;
    }
  }
  return { ok: false, rounds, warnings: [], review: [], error: rounds[rounds.length - 1] };
}

/**
 * 清空一页（--force 重画前用）。
 *
 * 页面的所有后代节点都要删掉，光删顶层那些会留下孤儿。
 * 页面本身留着不删：page.create 只能把新页追加到 pageOrder 末尾，
 * 删了重建会让页面顺序乱掉；留着页面，模型往里放节点就行。
 */
async function clearPage(project: StudioProject, pageId: string): Promise<number> {
  const document = project.snapshot();
  const page = document.pages[pageId];
  if (!page) return 0;
  const ids: string[] = [];
  const collect = (nodeId: string): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    for (const childId of node.childIds) collect(childId);
    ids.push(nodeId);
  };
  for (const childId of page.childIds) collect(childId);

  const current = project.snapshot();
  const commands: DesignCommand[] = ids.map(id => ({ type: "node.delete", payload: { id } }));
  if (!commands.length) return 0;
  await project.execute({
    commandId: `probe:clear:${pageId}`,
    documentId: current.id,
    baseRevision: current.revision,
    actor: { type: "integration", id: "admin-console-probe" },
    commands,
  });
  return ids.length;
}

/**
 * 体检 → 回喂：生成完一页，用仓库自己的检查器扫一遍，把「有明确修法」的问题回喂给模型。
 *
 * 用的是产品同一条通道（`collectSelfCheck` + `formatSelfCheckForPrompt`），
 * 不是另写一套规则。两条约束：
 *
 * 1. 只看**本页**的节点——文档是整份的，别的页的结论回喂过来会让模型去改别的页；
 * 2. 关掉几条在这套生成方式下必然误报的规则：颜色是硬编码的（模型不绑 token）、
 *    坐标不按 8px 栅格（这套设计用的是 4px 步长）。
 */
function selfCheckForPage(document: DesignDocument, pageId: string): SelfCheckContext | undefined {
  const page = document.pages[pageId];
  if (!page) return undefined;
  const ownNodes = new Set<string>();
  const collect = (nodeId: string): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    ownNodes.add(nodeId);
    for (const childId of node.childIds) collect(childId);
  };
  for (const childId of page.childIds) collect(childId);

  const report = collectSelfCheck(document, {
    grid: 4,
    lintRules: {
      "hardcoded-fill": false,
      "hardcoded-stroke": false,
      "off-grid": false,
      "duplicate-name": false,
    },
    skipExport: true,
  });
  const issues = report.issues.filter(issue => !issue.nodeId || ownNodes.has(issue.nodeId));
  const scoped = buildSelfCheckReport(issues);
  if (!scoped.counts.actionable) return undefined;
  return { report: scoped, stuck: [] };
}

/** 一页的提示：任务 + 设计系统 + 骨架 + 硬性规则。 */export function buildPagePrompt(spec: PageSpec, system: DesignSystem, previousShell?: string, pageExists = false): string {
  const tokenText = system.tokens.map(token => `- ${token.name} = ${token.value}`).join("\n");
  const parts = [
    `【要做的页面】${spec.name}（页面 id：${spec.id}）`,
    "",
    spec.brief,
    "",
    "【设计系统 —— 已确定，所有页面共用这一套，颜色与字距只能从这里挑】",
    tokenText,
    "",
  ];
  if (!spec.bare) {
    parts.push(SHELL_SPEC, "");
  }
  if (previousShell) {
    parts.push("【上一页做出来的东西 —— 只照它的样式继续做（颜色/圆角/字号/间距都对齐）；这些节点在别的页上，不能改也不能复用 id，要同样的东西就自己新建】", previousShell, "");
  }
  parts.push(HARD_RULES, "");
  parts.push(
    spec.bare
      ? `这一页没有侧栏与顶栏：整页铺页面背景色，登录卡片放在 x=520, y=170, width=400, height=420（页面 1440×900，水平居中略偏上）。`
      : pageExists
        ? `页面 ${spec.id} 已经存在，直接往里放节点，**不要** page.create。页面尺寸 1440×900。`
        : `页面 ${spec.id} 还不存在：第一步用 page.create 创建它，payload 写 { "page": { "id": "${spec.id}", "name": "${spec.name}", "childIds": [], "width": 1440, "height": 900 } }，再往里放节点。`,
    "",
    "现在只输出 JSON 计划。",
  );
  return parts.join("\n");
}

/**
 * 从已完成的页面里抽一小段「上一页长什么样」，给下一页当参照。
 *
 * **只给样式，不给节点 id。**
 *
 * 给了 id 模型就会去改它们——实测「计划限定为当前页，却修改了 22 个页外节点」
 * 就是这么来的：模型把参照里的 id 当成「已经存在的节点」，用 node.patch 去调它们，
 * 于是整份计划被范围审查拦下。参照的用处是**对齐风格**，风格信息足够用了。
 */
function describePreviousPage(document: DesignDocument, pageId: string): string | undefined {
  const page = document.pages[pageId];
  if (!page) return undefined;
  const lines: string[] = [];
  let index = 0;
  for (const childId of page.childIds) {
    const node = document.nodes[childId];
    if (!node) continue;
    index += 1;
    const fill = node.appearance.fills?.[0];
    const fillText = fill && fill.type === "solid" ? `填充=${fill.color}` : "无填充";
    const radius = node.appearance.cornerRadius ? `圆角=${node.appearance.cornerRadius}` : "";
    lines.push(`- 顶层 ${index}：名称="${node.name}" 类型=${node.type} 位置=(${node.layout.x},${node.layout.y}) 尺寸=${node.layout.width}×${node.layout.height} ${fillText} ${radius}`);
    for (const grandChildId of node.childIds.slice(0, 6)) {
      const child = document.nodes[grandChildId];
      if (!child) continue;
      const childFill = child.appearance.fills?.[0];
      const childFillText = childFill && childFill.type === "solid" ? `填充=${childFill.color}` : "";
      const size = child.type === "text" ? `文字="${child.text}" 字号=${child.fontSize}` : "";
      lines.push(`  - ${child.name} 位置=(${child.layout.x},${child.layout.y}) 尺寸=${child.layout.width}×${child.layout.height} ${childFillText} ${size}`);
    }
  }
  return lines.slice(0, 24).join("\n");
}

/* ------------------------------------------------------------------ *
 * 风格审计
 * ------------------------------------------------------------------ */

interface PageAudit {
  pageId: string;
  nodes: number;
  colors: string[];
  offPalette: Array<{ color: string; nearest: string; distance: number }>;
  radii: number[];
  fontSizes: number[];
  fontFamilies: string[];
}

function auditPage(document: DesignDocument, pageId: string, palette: Palette): PageAudit {
  const page = document.pages[pageId];
  const colors = new Set<string>();
  const radii = new Set<number>();
  const fontSizes = new Set<number>();
  const fontFamilies = new Set<string>();
  let nodes = 0;

  const visit = (nodeId: string): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    nodes += 1;
    for (const fill of node.appearance.fills ?? []) {
      if (fill.type === "solid") colors.add(fill.color.toLowerCase());
    }
    if (node.appearance.stroke) colors.add(node.appearance.stroke.toLowerCase());
    if (typeof node.appearance.cornerRadius === "number") radii.add(node.appearance.cornerRadius);
    if (node.type === "text") {
      fontSizes.add(node.fontSize);
      fontFamilies.add(node.fontFamily);
    }
    for (const childId of node.childIds) visit(childId);
  };

  for (const childId of page?.childIds ?? []) visit(childId);

  const offPalette = [...colors]
    .filter(color => !palette.colors.includes(color))
    .map(color => {
      const nearest = nearestPaletteColor(color, palette);
      return { color, nearest: nearest?.to ?? "（无近似）", distance: nearest?.distance ?? Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.distance - b.distance);

  return {
    pageId,
    nodes,
    colors: [...colors].sort(),
    offPalette,
    radii: [...radii].sort((a, b) => a - b),
    fontSizes: [...fontSizes].sort((a, b) => a - b),
    fontFamilies: [...fontFamilies].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * 出图与导出
 * ------------------------------------------------------------------ */

interface RenderResult {
  pageId: string;
  ok: boolean;
  path?: string;
  width?: number;
  height?: number;
  error?: string;
}

/** 用工作台的 Canvas 渲染器把每一页画成 PNG。 */
async function renderPages(document: DesignDocument, outDir: string, pageIds: string[]): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  const browser = findBrowser();
  if (!browser) return pageIds.map(pageId => ({ pageId, ok: false, error: "未找到 Chrome/Edge；设置 CHROME_PATH 后重试" }));

  const harnessPath = await buildHarness("page-shot");
  const shotDir = join(outDir, "shots");
  mkdirSync(shotDir, { recursive: true });
  const pagePath = join(shotDir, "harness.html");
  copyFileSync(harnessPath, pagePath);
  writeFileSync(join(shotDir, "document.json"), JSON.stringify(document), "utf8");

  const server = await serveDirectory(shotDir);
  const launched = await launchHeadlessBrowser(browser);
  try {
    for (const pageId of pageIds) {
      const tab = await launched.newPage(`${server.url}harness.html?page=${encodeURIComponent(pageId)}`);
      try {
        const payload = await waitForResult(tab, 90_000);
        if (!payload.ok) {
          results.push({ pageId, ok: false, error: payload.error ?? "渲染失败" });
          continue;
        }
        const image = payload.image;
        if (!image) {
          results.push({ pageId, ok: false, error: "渲染结果里没有图片" });
          continue;
        }
        const base64 = image.dataUrl.slice(image.dataUrl.indexOf(",") + 1);
        const file = join(shotDir, `${pageId.replace(/[^\w-]/g, "_")}.png`);
        writeFileSync(file, Buffer.from(base64, "base64"));
        results.push({ pageId, ok: true, path: file, width: image.width, height: image.height });
      } finally {
        await tab.send("Page.close").catch(() => undefined);
      }
    }
  } finally {
    await launched.close();
    await server.close();
  }
  return results;
}

interface HarnessPayload {
  ok: boolean;
  error?: string;
  image?: { dataUrl: string; mimeType: string; width: number; height: number };
}

/** 轮询 harness 页面，等它把渲染结果写进 `#page-shot-result`。 */
async function waitForResult(page: { evaluate<T>(expression: string): Promise<T> }, timeoutMs = 60_000): Promise<HarnessPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await page.evaluate<string>(
      'document.querySelector("#page-shot-result")?.textContent ?? document.querySelector("#page-shot-error")?.textContent ?? ""',
    );
    if (raw) {
      try {
        return JSON.parse(raw) as HarnessPayload;
      } catch {
        throw new Error(`harness 输出的不是 JSON：${raw.slice(0, 200)}`);
      }
    }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`harness 在 ${timeoutMs}ms 内没有产出结果`);
}

/** 导出每页的 HTML——这是给人看的那一份。 */
function exportHtml(project: StudioProject, outDir: string, pageIds: string[]): Array<{ pageId: string; path?: string; error?: string }> {
  const htmlDir = join(outDir, "html");
  mkdirSync(htmlDir, { recursive: true });
  return pageIds.map(pageId => {
    try {
      const page = project.snapshot().pages[pageId];
      const result = project.exportHtml({
        pageId,
        viewport: { width: page?.width ?? PAGE_WIDTH, height: page?.height ?? PAGE_HEIGHT },
        title: page?.name ?? pageId,
      });
      const file = join(htmlDir, `${pageId.replace(/[^\w-]/g, "_")}.html`);
      writeFileSync(file, result.document, "utf8");
      return { pageId, path: file };
    } catch (error) {
      return { pageId, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/* ------------------------------------------------------------------ *
 * 替身规划器（没有凭据时）
 * ------------------------------------------------------------------ */

/** 确定性替身：只搭一个空架子，证明链路通。 */
function stubPlanner(): AiPlanner {
  return {
    async plan(_request: AiPlanRequest) {
      return {
        summary: "（替身规划器）空计划",
        assumptions: [],
        commands: [{ type: "document.rename", payload: { name: "后台管理端" } }] as never[],
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const credentials = resolveCredentials(args);
  const usingStub = args.stub || !credentials;
  if (!args.stub && !credentials) {
    console.log("没有找到端点配置（STUDIO_PROVIDER_BASE / MODEL / KEY、--env-file=，或工作台里保存过的模型配置），改跑确定性替身。");
    console.log("替身只能证明链路通，**不能**证明 AI 会设计。真实模型那一跑请补上凭据。\n");
  }
  if (args.stub) console.log("以 --stub 运行：确定性替身，不代表真实模型的表现。\n");

  const projectDir = join(outDir, "project");
  mkdirSync(projectDir, { recursive: true });
  const rawDir = join(outDir, "raw");
  const repository = new FileSystemProjectRepository(projectDir);
  const firstPage = PAGE_SPECS[0]!;
  const projectId = "project:admin-console";

  // 断点续跑：整轮要几十分钟，中途被超时打断不该从头再来。
  // 项目里已有的页面直接跳过——快照是每次提交都落盘的，续跑接着上次画。
  let project: StudioProject;
  let resumed = false;
  if (args.resume) {
    try {
      const opened = await StudioProject.open(repository, projectId);
      project = opened.project;
      resumed = true;
    } catch {
      resumed = false;
    }
  }
  if (!resumed) {
    project = await StudioProject.create(repository, projectId, "后台管理端设计", firstPage.id);
    // 第一页的尺寸与名字：createDocument 给的是 960×680 / "Page 1"，这里改成桌面后台的 1440×900 与中文页名。
    const initial = project.snapshot();
    await project.execute({
      commandId: `probe:setup:${firstPage.id}`,
      documentId: initial.id,
      baseRevision: initial.revision,
      actor: { type: "integration", id: "admin-console-probe" },
      commands: [
        { type: "page.resize", payload: { id: firstPage.id, width: PAGE_WIDTH, height: PAGE_HEIGHT } },
        { type: "page.rename", payload: { id: firstPage.id, name: firstPage.name } },
      ],
    });
  }

  const planner: AiPlanner = usingStub
    ? stubPlanner()
    : createOpenAiCompatiblePlanner({
        baseUrl: credentials!.baseUrl,
        model: credentials!.model,
        apiKey: credentials!.apiKey,
        jsonMode: true,
        temperature: 0.3,
        maxTokens: Number(process.env.STUDIO_PROVIDER_MAX_TOKENS ?? 65536),
        stream: true,
        timeoutMs: Number(process.env.STUDIO_PROVIDER_TIMEOUT_MS ?? 600000),
        // 思考开关：推理模型默认先想一遍，整页计划能把 token 预算烧光。
        // 实测 MiniMax-M3 关掉思考后整页 12 秒写完，开着 338 秒还没写完。
        ...(args.thinking === "off" ? { thinking: { type: "disabled" as const } } : {}),
      });

  // 归一化包在规划器外层：模型给什么颜色都要过一遍调色板。
  let palette: Palette = { colors: [], radii: [], fontSizes: [] };
  const snappedChanges: Snapped[] = [];
  const enforcingPlanner: AiPlanner = {
    async plan(request: AiPlanRequest) {
      const plan = await planner.plan(request);
      if (!palette.colors.length) return plan;
      const changes = enforcePlan(plan, palette);
      snappedChanges.push(...changes);
      return plan;
    },
  };

  const editor = new SafeAiEditor(project, enforcingPlanner);
  console.log(`模型：${usingStub ? "(stub planner)" : `${credentials!.model} @ ${credentials!.baseUrl}`}`);
  console.log(resumed ? `续跑：接着 ${outDir} 里已有的文档继续` : `起点：空白文档（一个空页面 ${firstPage.id}，零个节点）`);
  console.log(`目标：${args.pages.join(", ")}\n`);

  // --- 第一步：设计系统 ---
  // 续跑时 token 已经在文档里了：重定一遍会让颜色改名，前面的页面就地对不上了。
  const existingTokens = Object.keys(project.snapshot().tokens).length;
  let systemResult: Awaited<ReturnType<typeof runStep>>;
  if (resumed && existingTokens > 0) {
    console.log(`  设计系统：沿用文档里已有的 ${existingTokens} 个 token`);
    systemResult = { ok: true, rounds: [`沿用已有 token（${existingTokens} 个）`], warnings: [], review: [] };
  } else {
    systemResult = await runStep(editor, designSystemPrompt(), { label: "设计系统", rawDir });
  }
  palette = extractPalette(project.snapshot());
  const designSystem: DesignSystemOutcome = {
    ok: systemResult.ok,
    summary: systemResult.summary,
    rounds: systemResult.rounds,
    tokens: Object.entries(project.snapshot().tokens).map(([name, token]) => ({
      name,
      type: token.type,
      value: String(token.value),
    })),
    palette,
    error: systemResult.error,
  };
  for (const round of systemResult.rounds) console.log(`  设计系统 ${round}`);
  console.log(`  token：${designSystem.tokens.length} 个（颜色 ${palette.colors.length} / 圆角 ${palette.radii.join(",") || "无"} / 字号 ${palette.fontSizes.join(",") || "无"}）\n`);

  // --- 第二步：逐页生成 ---
  const outcomes: PageOutcome[] = [];
  const specs = PAGE_SPECS.filter(spec => args.pages.includes(spec.id));
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]!;
    // 「上一页」参照按全量顺序找，不按本次筛选出来的子集——
    // 只重画后半几页时，也要能看到前半页画出来是什么样。
    const fullIndex = PAGE_SPECS.findIndex(item => item.id === spec.id);
    const previous = fullIndex > 0 ? PAGE_SPECS[fullIndex - 1]! : undefined;
    const previousShell = previous ? describePreviousPage(project.snapshot(), previous.id) : undefined;
    // 页面在文档里存在就直接往里放节点（不 page.create），
    // 不存在才让模型 page.create。判据是「文档里有没有这一页」，
    // 不是「是不是本次的第一页」——后者会让局部重跑把页删了重建，
    // page.create 只能追加到 pageOrder 末尾，页面顺序就乱了。
    const pageExists = Boolean(project.snapshot().pages[spec.id]);

    // 续跑时，已经画好的页面直接跳过。
    const existing = project.snapshot().pages[spec.id];
    if (resumed && !args.force && existing && existing.childIds.length > 0) {
      console.log(`  ${spec.name} 已有 ${existing.childIds.length} 个顶层节点，跳过`);
      outcomes.push({
        pageId: spec.id,
        name: spec.name,
        ok: true,
        attempts: 0,
        rounds: ["续跑：跳过（页面已存在）"],
        nodeCount: existing.childIds.length,
        warnings: [],
        review: [],
        snapped: [],
      });
      continue;
    }

    // --force：先把这一页清空再重画（否则新旧节点会叠在一起）。
    // 只删节点不删页面：页面留在 pageOrder 里的原位，模型直接往里放节点。
    if (args.force && existing && existing.childIds.length > 0) {
      const removed = await clearPage(project, spec.id);
      console.log(`  ${spec.name} 重画：清掉 ${removed} 个节点`);
    }

    const prompt = buildPagePrompt(spec, { summary: designSystem.summary ?? "", tokens: designSystem.tokens, palette }, previousShell, pageExists);
    const before = Object.keys(project.snapshot().nodes).length;
    const snappedBefore = snappedChanges.length;
    // 单页范围约束只在页面已存在时能用：范围检查要求目标页在改之前就在文档里。
    const result = await runStep(editor, prompt, pageExists ? { pageId: spec.id, label: spec.name, rawDir } : { label: spec.name, rawDir });
    const after = Object.keys(project.snapshot().nodes).length;
    for (const round of result.rounds) console.log(`  ${spec.name} ${round}`);

    // 体检 → 回喂修一轮：生成完不等于画对了，仓库的检查器说了算。
    let selfCheckFixed = 0;
    if (result.ok) {
      const check = selfCheckForPage(project.snapshot(), spec.id);
      if (check) {
        console.log(`  ${spec.name} 体检：待修 ${check.report.counts.actionable} 项，回喂模型修一轮`);
        // 修复轮里说清怎么改：体检项多半是「空文本 / 字号太小」，
        // 改内容用 text.patch 的 text 字段就够了。用 runs 改局部颜色时
        // from/to 必须落在文本长度内——模型经常算错，于是整轮白跑。
        const fixPrompt = `${prompt}\n\n只修体检清单里的问题，不要重画整页。改文字内容用 text.patch 的 {"text": "..."}；` +
          "要改颜色用 node.patch 的 appearance（写全 opacity 与 fills）。不要用 runs。";
        const fix = await runStep(editor, fixPrompt, {
          ...(pageExists ? { pageId: spec.id } : {}),
          label: `${spec.name}-体检`,
          rawDir,
          selfCheck: check,
        });
        for (const round of fix.rounds) console.log(`  ${spec.name} ${round}`);
        selfCheckFixed = fix.ok ? check.report.counts.actionable : 0;
      }
    }
    outcomes.push({
      pageId: spec.id,
      name: spec.name,
      ok: result.ok,
      attempts: result.rounds.length,
      rounds: result.rounds,
      summary: result.summary,
      assumptions: result.assumptions,
      nodeCount: after - before,
      warnings: result.warnings,
      review: result.review,
      snapped: snappedChanges.slice(snappedBefore),
      error: result.error,
    });
    console.log("");
  }

  // --- 第三步：风格归一化 + 审计 ---
  // 先把落地后才发现的越界颜色改回调色板，再审计——审计报告的是**归一化之后**的状态。
  const styleChanges: Array<{ pageId: string; changes: Snapped[] }> = [];
  for (const outcome of outcomes.filter(item => item.ok)) {
    const changes = await enforcePageStyle(project, outcome.pageId, palette);
    if (changes.length) styleChanges.push({ pageId: outcome.pageId, changes });
  }

  const document = project.snapshot();
  const audits = outcomes.filter(outcome => outcome.ok).map(outcome => auditPage(document, outcome.pageId, palette));

  // --- 第四步：导出与出图 ---
  const htmlResults = exportHtml(project, outDir, document.pageOrder);
  const renderResults = args.render ? await renderPages(document, outDir, document.pageOrder) : [];

  const report = {
    mode: usingStub ? "stub" : "real",
    model: usingStub ? "(stub planner)" : credentials!.model,
    baseUrl: usingStub ? null : credentials!.baseUrl,
    credentialSource: usingStub ? null : credentials!.source,
    pages: document.pageOrder.map(id => ({ id, name: document.pages[id]?.name ?? id })),
    designSystem,
    outcomes,
    audits,
    styleChanges,
    html: htmlResults,
    renders: renderResults,
    snappedTotal: snappedChanges.length,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(outDir, "document.json"), JSON.stringify(document), "utf8");

  console.log("—— 风格审计 ——");
  for (const audit of audits) {
    console.log(
      `${audit.pageId}：${audit.nodes} 个节点，颜色 ${audit.colors.length} 种（${audit.offPalette.length} 种在调色板外），` +
        `圆角 ${audit.radii.join(",") || "无"}，字号 ${audit.fontSizes.join(",") || "无"}，字体 ${audit.fontFamilies.join(",") || "无"}`,
    );
    for (const off of audit.offPalette.slice(0, 6)) {
      console.log(`   · ${off.color} → 最近 ${off.nearest}（距离 ${Number.isFinite(off.distance) ? off.distance.toFixed(1) : "∞"}）`);
    }
  }
  console.log(`\n归一化改色 ${snappedChanges.length} 处；产物在 ${outDir}`);
  console.log(`HTML：${htmlResults.filter(item => item.path).map(item => item.path).join("、")}`);
  console.log(`PNG：${renderResults.filter(item => item.path).map(item => item.path).join("、") || "（未出图）"}`);

  const failed = outcomes.filter(outcome => !outcome.ok);
  if (failed.length) {
    console.error(`\n✗ ${failed.length} 个页面没生成成功：${failed.map(item => item.pageId).join(", ")}`);
    process.exitCode = 1;
  }
  if (usingStub) {
    console.log("\n注意：这一轮是确定性替身。它证明链路通，不证明「AI 会设计」。");
  }
}

// 只有直接运行这个文件才跑主流程：被别的脚本 import 时（例如测速探针）只取提示构造器。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
