# 字体管理规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`current-project-status.md`、`figma-gap-roadmap.md`、`rich-text.md`

## 1. 要解决的问题

在此之前字体只有「一个族名字符串」：缺失字体会被静默回退到系统字体，
交付稿和设计稿的字形可能完全不同；也不能把字体文件随项目一起带走。

本轮补齐三件事：

1. **字体资源上传**：字体文件按内容哈希进项目，随文档备份与迁移；
2. **文档级字体声明**：`document.fonts` 记录"这个项目用了哪些字体、对应哪份文件"；
3. **缺失字体诊断与非静默回退**：加载不到的族名在「数据 → 字体」里明确列出来。

## 2. 数据模型

```ts
interface DocumentFont {
  family: string;
  assetId?: AssetId;     // 上传的字体文件；缺省 = 依赖系统安装
  weight?: number;       // 该文件提供的字重，缺省 400
  style?: "normal" | "italic";
}

interface DesignDocument {
  fonts?: DocumentFont[]; // 可选字段，旧文档不需要迁移
}
```

**字节不进文档**：字体文件与图片共用 `assets` 表（哈希去重、字节在仓库里），
文档里只登记引用。这样备份、导出、迁移都只有一条资产链路。

字体 MIME 白名单在 `design-schema/src/fonts.ts`（`FONT_MIME_TYPES`），
`woff2/woff/ttf/otf/collection` 与浏览器常见的 `application/x-font-*` 都收——
浏览器对 ttf/otf 的类型上报并不统一。

## 3. 命令

| 命令 | 作用 | 校验 |
| --- | --- | --- |
| `font.register` | 登记/替换字体声明 | 族名非空、字重 100–900 整数、assetId 存在且 MIME 是字体 |
| `font.remove` | 删除字体声明 | 还有文本节点用这个族名时拒绝 |

规则细节：

- **同键替换**：族名 + 字重 + 字形相同视为同一条记录，再次登记是覆盖而不是追加
  （重新上传同名同字重的字体文件不需要先删）。
- **资产保护**：`asset.delete` 会检查字体声明，字体还在引用这份字节时拒绝删除。
- **删除保护**：族名仍被文本使用时拒绝删除声明——否则那些文本会悄悄掉进回退字形，
  而这正是本轮要消灭的行为。

## 4. 加载与诊断

```
loadDocumentFonts(document, { resolveAssetUrl })
  → new FontFace(family, url(...), { weight, style }) → document.fonts.add → await load()
prepareFonts(collectFontFamilies(document))
  → 返回真正加载成功的族名（系统已装字体立即成功，缺失字体 reject）
collectMissingFonts(document, available) = 文本用到的族名 − available
```

- 上传字体先注册 Faces，再统一探测；两步都完成，"缺失"才有意义。
- 单个字体加载失败**不抛错**：坏文件、缺字节、浏览器拒绝都只让这个族名落到缺失清单，
  不能让整个工作台打不开项目。
- 加载完成后清空文本测量缓存并触发一次重排——否则页面会一直沿用回退字形的宽度。
- 已注册过的字体文件在会话内不重复 `add`（同一份文档反复打开不会堆积 FontFace）。

诊断展示在「数据」分段：`字体` 区块列出每条声明（族名、字重/字形、来源是"上传"还是"系统"），
缺失族名单独用橙色提示条列出，文案明确写"画布与导出会使用回退字形"。

## 5. 编辑入口

- **数据 → 字体**：「上传字体」选择 `.woff2/.woff/.ttf/.otf`，弹窗里确认族名（默认从文件名猜）
  与字重；列表项可删除（受 §3 的删除保护）。
- **属性面板 → 文字 → 字体**：输入框带 `datalist` 建议（已加载族名 + 文档声明族名），
  仍允许自由输入（用于系统中已装但项目里没登记的字体）。

## 6. 已知限制

- 字体文件不解析内部的 family 名与字重/字形（避免引入字体解析依赖），
  由用户在弹窗里确认；填错只影响诊断，不影响文档合法性；
- 不做字体子集化与打包：导出的 HTML 仍引用字体族名，**不会内联字体文件**；
- 字体 token（typography token 的渲染语义）仍未实现，与本轮的"字体文件管理"是两件事；
- 缺失字体只做提示，不阻止导出——导出的交付物里同样会走回退字形。

## 7. 测试

| 文件 | 覆盖 |
| --- | --- |
| `design-runtime/test/fonts.test.ts` | 默认字重/字形、同键替换、非法资产、删除保护、资产删除保护 |
| `studio-web/test/font-management.test.ts` | 文件名 → MIME/族名、文件校验、上传加载成功/坏文件跳过、缺失字体计算 |
| `design-schema/src/validate.ts` | 导入校验：重复键、缺失资产、非字体资产 |
