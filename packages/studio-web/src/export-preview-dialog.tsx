import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ExportPreview } from "./export-preview";

export interface ExportPreviewDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  preview?: ExportPreview;
  /**
   * 并排对比的**左侧**（历史版本）预览。
   *
   * 有它就把弹窗变成两栏：左边历史版本、右边当前版本。有它时标题栏不再显示
   * 单份预览的格式与范围——两栏各自的标题已经说清楚了。
   */
  compare?: { title: string; preview: ExportPreview };
}

/**
 * 隔离预览弹窗。
 *
 * HTML 用一个空的 `sandbox` 渲染：导出内容里的脚本不会执行，也拿不到父页面的
 * 存储和 DOM；SVG / PNG 走 data URL 的 `<img>`，同样不会执行脚本。预览和下载
 * 用的是同一份产物，所以这里看到的就是交付物本身。
 *
 * 并排对比时两侧都是隔离渲染：历史版本的产物同样不该能碰到工作台。
 */
export function ExportPreviewDialog({ open, onOpenChange, preview, compare }: ExportPreviewDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className={compare ? "dialog-content export-preview export-preview-compare" : "dialog-content export-preview"}>
          <DialogPrimitive.Title className="dialog-title">{compare ? "版本对比预览" : preview?.title ?? "导出预览"}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">
            {compare ? "左边是历史版本，右边是当前版本；两侧导出的是同一范围。" : "这是导出器实际生成的产物，HTML 在无脚本沙箱里渲染。"}
          </DialogPrimitive.Description>
          <div className={compare ? "export-preview-body export-preview-compare-body" : "export-preview-body"}>
            {compare && (
              <section className="export-preview-pane">
                <span className="export-preview-pane-title">{compare.title}</span>
                <PreviewContent preview={compare.preview} />
              </section>
            )}
            {preview && (
              <section className="export-preview-pane">
                {compare && <span className="export-preview-pane-title">{preview.title}</span>}
                <PreviewContent preview={preview} />
              </section>
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

/** 一份预览的内容：HTML 走 sandbox iframe，SVG / PNG 走 data URL 的图片。 */
function PreviewContent({ preview }: { preview: ExportPreview }) {
  if (preview.content.kind === "html") {
    return (
      <iframe
        title={preview.title}
        className="export-preview-frame"
        // 空 sandbox：不执行脚本、不同源，预览内容无法影响工作台。
        sandbox=""
        srcDoc={preview.content.html}
      />
    );
  }
  return (
    <img
      className="export-preview-image"
      src={preview.content.dataUrl}
      alt={preview.title}
      {...(preview.content.width ? { width: preview.content.width } : {})}
      {...(preview.content.height ? { height: preview.content.height } : {})}
    />
  );
}
