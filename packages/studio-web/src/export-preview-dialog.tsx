import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ExportPreview } from "./export-preview";

export interface ExportPreviewDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  preview?: ExportPreview;
}

/**
 * 隔离预览弹窗。
 *
 * HTML 用一个空的 `sandbox` 渲染：导出内容里的脚本不会执行，也拿不到父页面的
 * 存储和 DOM；SVG / PNG 走 data URL 的 `<img>`，同样不会执行脚本。预览和下载
 * 用的是同一份产物，所以这里看到的就是交付物本身。
 */
export function ExportPreviewDialog({ open, onOpenChange, preview }: ExportPreviewDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className="dialog-content export-preview">
          <DialogPrimitive.Title className="dialog-title">{preview?.title ?? "导出预览"}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">
            这是导出器实际生成的产物，HTML 在无脚本沙箱里渲染。
          </DialogPrimitive.Description>
          <div className="export-preview-body">
            {preview?.content.kind === "html" && (
              <iframe
                title={preview.title}
                className="export-preview-frame"
                // 空 sandbox：不执行脚本、不同源，预览内容无法影响工作台。
                sandbox=""
                srcDoc={preview.content.html}
              />
            )}
            {preview?.content.kind === "image" && (
              <img
                className="export-preview-image"
                src={preview.content.dataUrl}
                alt={preview.title}
                {...(preview.content.width ? { width: preview.content.width } : {})}
                {...(preview.content.height ? { height: preview.content.height } : {})}
              />
            )}
          </div>
          <div className="dialog-actions">
            <DialogPrimitive.Close asChild>
              <button type="button" className="dialog-primary">关闭</button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
