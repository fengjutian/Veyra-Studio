import { exportPageToSvg } from "@ufira/design-export";
import type { AiPlanPreview } from "@ufira/ai-orchestrator";
import { pageSize } from "./page-size";
import { svgPreviewDataUrl } from "./export-preview";
import { Icon } from "./icons";

export type AiVariantStatus = "queued" | "generating" | "ready" | "failed";

export interface AiVariantJob {
  id: string;
  index: number;
  status: AiVariantStatus;
  preview?: AiPlanPreview;
  error?: string;
}

interface AiVariantGalleryProps {
  jobs: AiVariantJob[];
  selectedId?: string;
  currentPageId: string;
  themeId?: string;
  stale: boolean;
  busy: boolean;
  onSelect(job: AiVariantJob): void;
  onRetry(job: AiVariantJob): void;
  onAdopt(job: AiVariantJob): void;
  onDiscard(): void;
}

/**
 * 多候选只负责比较与选择，不负责请求模型。
 *
 * 缩略图直接渲染 dry-run 的 `after` 文档，与 SVG 导出共用一条渲染路径；因此画廊
 * 展示的不是示意占位，而是用户采用该方案后会得到的真实页面结构。
 */
export function AiVariantGallery(props: AiVariantGalleryProps) {
  const selected = props.jobs.find(job => job.id === props.selectedId && job.preview);
  return <section className="inspector-section ai-results-section">
    <div className="section-heading">
      <h2>2 · 选择候选</h2>
      <span className="ai-result-count">{props.jobs.filter(job => job.status === "ready").length}/{props.jobs.length}</span>
    </div>
    <div className="ai-variant-grid" role="listbox" aria-label="AI 候选方案">
      {props.jobs.map(job => <VariantCard
        key={job.id}
        job={job}
        selected={props.selectedId === job.id}
        currentPageId={props.currentPageId}
        themeId={props.themeId}
        busy={props.busy}
        onSelect={() => props.onSelect(job)}
        onRetry={() => props.onRetry(job)}
      />)}
    </div>
    {selected?.preview && <div className={props.stale ? "preview ai-selected-preview stale" : "preview ai-selected-preview"}>
      <span className="ai-review-kicker">3 · 审查并提交</span>
      <strong>{selected.preview.summary}</strong>
      <p>影响：{selected.preview.affectedNodeIds.join(", ") || "文档级"}</p>
      <p>警告：{selected.preview.warnings.length} · 审查：{reviewLabel(selected.preview)}</p>
      {selected.preview.review.findings.length > 0 && <div className="review-list">{selected.preview.review.findings.map(finding => <div className={`review-row review-${finding.severity}`} key={`${finding.code}:${finding.message}`}><span className="review-badge">{finding.severity === "blocking" ? "阻断" : "提示"}</span><span className="review-message">{finding.message}</span></div>)}</div>}
      {props.stale && <p>文档已变化，这批候选已过期，请重新生成。</p>}
      <div className="preview-actions">
        <button disabled={props.busy || props.stale || selected.preview.review.blocking} title={selected.preview.review.blocking ? "存在阻断项，计划不能提交" : undefined} onClick={() => props.onAdopt(selected)}><Icon name="aiConfirm" />采用此方案</button>
        <button disabled={props.busy} onClick={props.onDiscard}><Icon name="aiCancel" />放弃全部</button>
      </div>
    </div>}
  </section>;
}

function VariantCard({ job, selected, currentPageId, themeId, busy, onSelect, onRetry }: { job: AiVariantJob; selected: boolean; currentPageId: string; themeId?: string; busy: boolean; onSelect(): void; onRetry(): void }) {
  const thumbnail = job.preview ? variantThumbnail(job.preview, currentPageId, themeId) : undefined;
  if (job.status === "failed") return <article className="ai-variant-card is-failed">
    <span className="ai-variant-index">{variantNumber(job)}</span>
    <div className="ai-variant-placeholder"><Icon name="aiCancel" /></div>
    <strong>生成失败</strong>
    <span title={job.error}>{job.error}</span>
    <button disabled={busy} onClick={onRetry}><Icon name="aiPlan" />单独重试</button>
  </article>;
  if (!job.preview) return <article className={`ai-variant-card is-${job.status}`} aria-busy={job.status === "generating"}>
    <span className="ai-variant-index">{variantNumber(job)}</span>
    <div className="ai-variant-placeholder"><span /></div>
    <strong>{job.status === "generating" ? "正在生成" : "等待生成"}</strong>
  </article>;
  const status = variantStatus(job.preview);
  return <button role="option" aria-selected={selected} className={`ai-variant-card is-${status}${selected ? " is-selected" : ""}`} onClick={onSelect}>
    <span className="ai-variant-index">{variantNumber(job)}</span>
    <div className="ai-variant-thumbnail">{thumbnail ? <img src={thumbnail} alt="" /> : <span>无法预览</span>}</div>
    <strong>{job.preview.summary}</strong>
    <span>{job.preview.affectedNodeIds.length || "文档级"} 处影响 · {job.preview.warnings.length} 警告</span>
    <span className={`ai-variant-status is-${status}`}>{status === "blocked" ? "审查阻断" : status === "warning" ? "需要确认" : "可提交"}</span>
  </button>;
}

function variantStatus(preview: AiPlanPreview): "safe" | "warning" | "blocked" {
  if (preview.review.blocking) return "blocked";
  if (preview.warnings.length || preview.review.findings.length) return "warning";
  return "safe";
}

export function variantThumbnail(preview: AiPlanPreview, currentPageId: string, themeId?: string): string | undefined {
  try {
    const pageId = preview.after.pages[currentPageId] ? currentPageId : preview.after.pageOrder[0];
    if (!pageId) return undefined;
    const viewport = pageSize(preview.after.pages[pageId]);
    return svgPreviewDataUrl(exportPageToSvg(preview.after, { pageId, viewport, themeId }).svg);
  } catch {
    return undefined;
  }
}

function variantNumber(job: AiVariantJob): string { return String(job.index + 1).padStart(2, "0"); }

function reviewLabel(preview: AiPlanPreview): string {
  if (!preview.review.findings.length) return "通过";
  return `${preview.review.findings.length} 条${preview.review.blocking ? "（含阻断项）" : "（仅提示）"}`;
}
