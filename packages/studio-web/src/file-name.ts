/**
 * 文件名清洗。
 *
 * 导出与下载用的文件名不能带路径分隔符和系统保留字符，否则在 Windows 上会
 * 被解释成路径。
 */
export function safeFilename(name: string): string {
  // 控制字符（\u0000-\u001f）在文件名里是非法的，这里是有意剔除。
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "design";
}
