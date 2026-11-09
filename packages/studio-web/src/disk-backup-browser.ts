/**
 * 磁盘备份的浏览器实现（File System Access API）。
 *
 * 只有 Chromium 系浏览器支持目录选择与持久化句柄；Firefox / Safari 上
 * `supportsDiskBackup()` 返回 false，界面会说明「当前浏览器不支持」，而不是
 * 给一个点了没反应的按钮。
 *
 * 句柄本身可以结构化克隆，所以存在 IndexedDB 里；但**权限不能跨会话自动恢复**：
 * 重新打开页面后只能 `queryPermission()`，需要用户手势时再 `requestPermission()`。
 */

import Dexie, { type Table } from "dexie";
import type { BackupDirectoryPort } from "./disk-backup";

interface SavedDirectoryRecord {
  id: "backup-directory";
  handle: FileSystemDirectoryHandle;
  lastSavedAt?: string;
}

interface HandleDatabase extends Dexie {
  handles: Table<SavedDirectoryRecord, string>;
}

let cached: HandleDatabase | undefined;

function handleDatabase(): HandleDatabase {
  if (cached) return cached;
  const database = new Dexie("ufira-design-studio-fs") as HandleDatabase;
  database.version(1).stores({ handles: "&id" });
  cached = database;
  return database;
}

/** 当前浏览器是否支持选择备份目录。 */
export function supportsDiskBackup(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

type DirectoryPicker = (options?: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
}) => Promise<FileSystemDirectoryHandle>;

/**
 * 弹出目录选择器。
 *
 * 用户取消（`AbortError`）返回 `undefined`——那不是错误，界面不该弹红字。
 */
export async function pickBackupDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) return undefined;
  try {
    return await picker({ id: "ufira-backups", mode: "readwrite", startIn: "documents" });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") return undefined;
    throw error;
  }
}

type PermissionState = "granted" | "denied" | "prompt";

interface PermissionCapableHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/**
 * 检查（并在用户手势里请求）目录的读写权限。
 *
 * `request = false` 只能用于页面加载时：没有用户手势调用 `requestPermission()`
 * 会被浏览器直接拒绝。
 */
export async function ensureDirectoryPermission(handle: FileSystemDirectoryHandle, request = false): Promise<boolean> {
  const capable = handle as PermissionCapableHandle;
  if (!capable.queryPermission) return true;
  const descriptor = { mode: "readwrite" as const };
  if ((await capable.queryPermission(descriptor)) === "granted") return true;
  if (!request || !capable.requestPermission) return false;
  return (await capable.requestPermission(descriptor)) === "granted";
}

/**
 * 把目录句柄包成备份端口。
 *
 * 只暴露「写文件 / 列文件名 / 删文件」三件事——轮转与节流都在纯逻辑层，
 * 浏览器的异常（配额、权限被收回、磁盘拔出）由调用方统一转成状态。
 */
export function backupDirectoryFromHandle(handle: FileSystemDirectoryHandle): BackupDirectoryPort {
  return {
    name: handle.name,
    async write(name, contents) {
      const file = await handle.getFileHandle(name, { create: true }) as unknown as WritableFileHandle;
      const writable = await file.createWritable();
      await writable.write(contents);
      await writable.close();
    },
    async list() {
      const names: string[] = [];
      // `entries()` 是异步迭代器（lib.dom 里尚未声明，按运行时形状收窄）。
      for await (const [name, entry] of (handle as unknown as IterableDirectoryHandle).entries()) {
        if (entry.kind === "file") names.push(name);
      }
      return names;
    },
    async remove(name) {
      await handle.removeEntry(name);
    },
  };
}

/** `createWritable()` 尚未进 lib.dom，按实际运行时形状声明。 */
interface WritableFileHandle {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

/** 目录句柄的异步迭代入口（Chromium 实现）。 */
interface IterableDirectoryHandle {
  entries(): AsyncIterableIterator<[string, { kind: "file" | "directory" }]>;
}

/** 读出上次选择的目录（没有则 undefined）。 */
export async function loadSavedBackupDirectory(): Promise<SavedDirectoryRecord | undefined> {
  try {
    return await handleDatabase().handles.get("backup-directory");
  } catch {
    // 隐私模式 / 存储被禁用：当作没配置，不影响编辑器。
    return undefined;
  }
}

/** 记住目录与最近一次备份时间。 */
export async function saveBackupDirectory(handle: FileSystemDirectoryHandle, lastSavedAt?: string): Promise<void> {
  await handleDatabase().handles.put({ id: "backup-directory", handle, lastSavedAt });
}

/** 只更新最近一次备份时间（保持目录句柄不变）。 */
export async function rememberLastBackupSavedAt(lastSavedAt: string): Promise<void> {
  const record = await loadSavedBackupDirectory();
  if (!record) return;
  await handleDatabase().handles.put({ ...record, lastSavedAt });
}

/** 断开目录：删掉句柄记录（磁盘上的备份文件不动）。 */
export async function clearSavedBackupDirectory(): Promise<void> {
  await handleDatabase().handles.delete("backup-directory");
}
