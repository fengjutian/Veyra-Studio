# 存储布局版本与迁移

> 文档状态：生效中的实现规格
> 建立日期：2026-11-09
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.2.0`）

## 1. 问题：两条迁移链，之前只有一条

项目里其实有**两种**会变的东西：

| | 文档格式 | 存储布局 |
| --- | --- | --- |
| 例子 | `appearance.fill` → `appearance.fills`；Grid 进 v4 | manifest 字段、IndexedDB 表 |
| 影响面 | 每一份文档 | 数据放在哪、长什么样 |
| 迁移方式 | 读文档时逐份升级 | 打开仓库时把容器升上来 |

文档格式这条链是成体系的（`design-schema/src/migrate.ts`：版本常量 + 步骤表 +
`migrateDocument()`）。存储布局此前只有两个数字（`STORAGE_VERSION = 2`、
`BROWSER_STORAGE_VERSION = 3`）和 Dexie 的 `version(n).stores()`，没有统一的
版本判定、步骤编排、历史记录与未来版本拒绝。

这一轮把存储布局补齐成同一套纪律。

## 2. 机制（`design-persistence/src/storage-layout.ts`）

```ts
CURRENT_STORAGE_VERSION = { filesystem: 2, browser: 3 }
STORAGE_MIGRATIONS = { filesystem: [...], browser: [...] }   // from → to 步骤表
migrateStorageLayout(backend, state, { now? })               // 逐级执行并记录历史
detectStorageLayoutVersion(raw)                              // 缺字段 = v1
StorageMigrationError                                        // 未来版本 / 缺步骤 / 非法版本
```

四条规则：

1. **版本号只有一个来源**：两个后端都从 `CURRENT_STORAGE_VERSION` 取，
   文件系统的 `STORAGE_VERSION` 只是转发，浏览器的 `BROWSER_STORAGE_VERSION` 同理。
2. **逐级迁移，不允许跳跃**：缺步骤直接报错，跳过会漏掉中间的结构变更。
3. **未来版本一律拒绝**：比当前应用新的布局可能带本版本不认识的字段/表，
   猜着读只会写出半坏的存储。错误信息里带版本号与应用支持的上限。
4. **步骤只改内存状态**：真正的结构变更由后端完成（文件系统重写 manifest，
   浏览器由 Dexie 建表），引擎负责版本推进、步骤编排与迁移历史。

状态里带 `migrations` 历史（`from` / `to` / `description` / `at`），与文档自带的
`migrations` 同构，可以在恢复报告里逐条展示。

## 3. 文件系统后端

`recover()` 先找出一份能读的快照，再做布局迁移（**放在 `try` 外面**）：
布局版本不受支持或写盘失败必须让用户看到，不能被「换上一份旧快照」掩盖过去。

三种情况会写回 manifest：

- manifest 不存在（旧项目只靠快照目录）；
- 版本落后（v1 没有 `storageVersion` / `documentSchemaVersion`）；
- 文档格式版本变了（迁移过文档后 manifest 要跟着更新）。

写回前把原始 manifest 备份到 `backups/manifest-v{旧版本}.json`；同一版本只留
第一次的副本——重复打开不能覆盖原始证据。普通保存（`saveSnapshot`）会把已有的
`storageMigrations` 带过去，一次自动保存不会抹掉「这份数据是怎么升上来的」。

## 4. 浏览器后端

Dexie 的建表是声明式的，没有运行时改结构这一步，所以：

- 布局版本与迁移历史记在 `storage` 表（单行 `id: "layout"`）里；
- Dexie schema 版本 4 只新增这张 meta 表，**不改任何已有表**，升级是纯新增；
- 旧库（没有 meta）当成 v1 逐级升到 3，两步都会留痕；
- 每次 `saveSnapshot` 与 `recover` 都会确保布局记录存在且是最新的，
  全新库第一次保存也不会缺这项账。

## 5. 验收

- 引擎单测：缺字段判 v1、逐级升级、幂等、未来版本拒绝、非法版本拒绝、历史时间戳。
- 文件系统：v1 manifest 升级 + 原始备份、无 manifest 的旧项目补写、未来版本拒绝、
  普通保存保留迁移历史。
- 浏览器（fake-indexeddb）：新建库记录 v3 与两步历史、v1 旧库升级留痕、
  未来版本拒绝。

## 6. 仍未完成

- **磁盘/加密定时备份**：备份目前只落在浏览器本地 IndexedDB
  （最近 3 份、10 分钟节流），没有导出到磁盘、没有加密、不能跨设备同步。
- 文件系统后端没有「布局降级」：版本只升不降，回滚需要旧版本应用自己处理。
