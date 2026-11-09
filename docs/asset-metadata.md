# 资源来源与授权元数据

> 文档状态：生效中的实现规格
> 建立日期：2026-11-09
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.5.0`）

## 1. 问题

交付设计稿时最常被问的不是「这张图多大」，而是「哪来的、能不能商用」。此前的
`AssetMetadata` 只有 `id / hash / mimeType / byteLength / name`——来源、作者、
许可证全在文档之外（聊天记录、README、某人的记忆里），换一个人接手就丢了。

## 2. 数据模型

```ts
interface AssetOrigin {
  source?: string;   // 素材库名或原始 URL
  author?: string;   // 作者 / 版权方
  license?: string;  // SPDX（CC-BY-4.0）或一句人话
  note?: string;     // 补充说明（如「仅限本项目使用」）
}

interface AssetMetadata {
  // ...
  origin?: AssetOrigin;
}
```

四条约定：

- **全部可选**：不知道就不填，不逼用户编；缺 `origin` 的旧文档完全合法，
  **不升文档格式版本**。
- **不参与身份**：`origin` 与 `hash` 无关，登记来源不会改动资源内容或让文档 revision 之外
  的任何东西变化；同 id 换 hash 仍然被命令层拒绝。
- **字体文件共用**：字体也是资产（`DocumentFont.assetId`），所以同一份 `origin`
  同样能描述字体文件的授权。
- **随文档走**：存在文档里而不是仓库侧表，因此 JSON 导出、备份、跨设备复制都带着它。

## 3. 编辑与展示

- 资源面板每行显示一条紧凑摘要 `来源 · 作者 · 许可证`（只填备注时不占位）。
- 「编辑来源」弹表单收集四个字段；空字符串表示清空，四个字段全空时整个 `origin`
  被移除，不会留下 `origin: {}` 这种「看着登记过、其实是空」的记录。
- 没有任何变化时**不提交**（避免白涨一个 revision）。
- 修改走 `asset.upsert`：它按 id 整体替换元数据、拒绝换 hash，因此这次编辑只可能
  改到来源信息。

## 4. 验收

- schema：合法 `origin`、空对象、旧文档无 `origin` 都通过；字段类型不是字符串时报
  `assets.<id>.origin.<field>`。
- 运行时：登记来源后 hash 与字节数不变；清空来源后 `origin` 字段消失。
- 面板逻辑（纯函数）：摘要拼接、只填备注、空字段清理、身份字段保留。

## 5. 仍未完成

- **导出物里不写署名**：HTML/SVG 产物不带版权信息，交付时的署名仍靠人工。
- **没有批量编辑**：一次只能改一份资源。
- **没有来源校验**：不检查 URL 是否可达、许可证是否为合法 SPDX 标识。
