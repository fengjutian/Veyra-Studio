import { useEffect, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { TEXT_DEFAULTS, type CornerRadii, type DesignNode, type FontStyle, type ImageNode, type LayoutSpec, type SizeMode, type TextAlign, type TextPatch } from "@ufira/design-schema";
import { opacityToPercent, percentToOpacity, resolvePadding, switchLayoutMode, type LayoutMode } from "./layout-edit";

export interface PropertyPanelProps {
  node: DesignNode;
  disabled?: boolean;
  onPatch(patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance">>): void;
  onPatchText(patch: TextPatch): void;
  onPatchImage(patch: { fit?: ImageNode["fit"] }): void;
  /** 换一张图：只改节点引用的资源，节点本身不重建。 */
  onReplaceImage?(): void;
}

/**
 * The property inspector for a single selected node.
 *
 * It exposes the full layout vocabulary the layout engine understands —
 * absolute and stack modes, fixed/fill/hug sizing, gap, padding and alignment —
 * so the editor can drive the same semantics the exporters use.
 */
export function PropertyPanel({ node, disabled, onPatch, onPatchText, onPatchImage, onReplaceImage }: PropertyPanelProps) {
  const layout = node.layout;
  const isStack = layout.mode === "stack";
  const padding = resolvePadding(layout);

  const patchLayout = (changes: Partial<LayoutSpec>) => onPatch({ layout: { ...layout, ...changes } });
  const patchPadding = (changes: Partial<typeof padding>) => patchLayout({ padding: { ...padding, ...changes } });
  /** 只改一个角：四角数组是整体替换的，先拷贝再赋值。 */
  const patchCorner = (index: number, value: number) => {
    const radii = [...(node.appearance.cornerRadii ?? uniformRadii(node.appearance.cornerRadius ?? 0))] as CornerRadii;
    radii[index] = value;
    onPatch({ appearance: { ...node.appearance, cornerRadii: radii } });
  };

  return (
    <>
      <Section title="布局">
        <Segmented
          label="模式"
          value={layout.mode}
          disabled={disabled}
          options={[
            { value: "absolute", label: "绝对" },
            { value: "stack", label: "自动布局" },
          ]}
          onChange={mode => onPatch({ layout: switchLayoutMode(layout, mode as LayoutMode) })}
        />
        {isStack && (
          <>
            <Segmented
              label="方向"
              value={layout.direction ?? "vertical"}
              disabled={disabled}
              options={[
                { value: "vertical", label: "垂直" },
                { value: "horizontal", label: "水平" },
              ]}
              onChange={direction => patchLayout({ direction: direction as "vertical" | "horizontal" })}
            />
            <Segmented
              label="对齐"
              value={layout.align ?? "start"}
              disabled={disabled}
              options={[
                { value: "start", label: "起点" },
                { value: "center", label: "居中" },
                { value: "end", label: "终点" },
                { value: "stretch", label: "拉伸" },
              ]}
              onChange={align => patchLayout({ align: align as LayoutSpec["align"] })}
            />
            <NumberField label="间距" value={layout.gap ?? 0} disabled={disabled} onCommit={gap => patchLayout({ gap })} />
          </>
        )}
      </Section>

      <Section title="尺寸">
        <NumberField label="X" value={layout.x} disabled={disabled} onCommit={x => patchLayout({ x })} />
        <NumberField label="Y" value={layout.y} disabled={disabled} onCommit={y => patchLayout({ y })} />
        <NumberField label="宽" value={layout.width} min={0} disabled={disabled} onCommit={width => patchLayout({ width })} />
        <NumberField label="高" value={layout.height} min={0} disabled={disabled} onCommit={height => patchLayout({ height })} />
        <Segmented
          label="宽度"
          value={layout.widthMode}
          disabled={disabled}
          options={sizeModeOptions}
          onChange={widthMode => patchLayout({ widthMode: widthMode as SizeMode })}
        />
        <Segmented
          label="高度"
          value={layout.heightMode}
          disabled={disabled}
          options={sizeModeOptions}
          onChange={heightMode => patchLayout({ heightMode: heightMode as SizeMode })}
        />
      </Section>

      <Section title="内边距">
        <div className="field-grid field-grid-4">
          <NumberField label="上" value={padding.top} min={0} disabled={disabled} onCommit={top => patchPadding({ top })} />
          <NumberField label="右" value={padding.right} min={0} disabled={disabled} onCommit={right => patchPadding({ right })} />
          <NumberField label="下" value={padding.bottom} min={0} disabled={disabled} onCommit={bottom => patchPadding({ bottom })} />
          <NumberField label="左" value={padding.left} min={0} disabled={disabled} onCommit={left => patchPadding({ left })} />
        </div>
      </Section>

      <Section title="外观">
        <TextField label="填充" value={node.appearance.fill ?? ""} disabled={disabled} onCommit={fill => onPatch({ appearance: { ...node.appearance, fill: fill || undefined } })} />
        <TextField label="描边" value={node.appearance.stroke ?? ""} disabled={disabled} onCommit={stroke => onPatch({ appearance: { ...node.appearance, stroke: stroke || undefined } })} />
        <NumberField label="描边宽度" value={node.appearance.strokeWidth ?? 1} min={0} disabled={disabled} onCommit={strokeWidth => onPatch({ appearance: { ...node.appearance, strokeWidth: strokeWidth > 0 ? strokeWidth : undefined } })} />
        {node.appearance.cornerRadii ? (
          <>
            <div className="field-grid field-grid-4">
              {CORNER_LABELS.map((label, index) => (
                <NumberField
                  key={label}
                  label={label}
                  value={node.appearance.cornerRadii![index]}
                  disabled={disabled}
                  onCommit={value => patchCorner(index, value)}
                />
              ))}
            </div>
            <button type="button" className="link-button" disabled={disabled} onClick={() => onPatch({ appearance: { ...node.appearance, cornerRadii: undefined, cornerRadius: maxRadius(node.appearance.cornerRadii!) } })}>
              统一为单值圆角
            </button>
          </>
        ) : (
          <>
            <NumberField label="圆角" value={node.appearance.cornerRadius ?? 0} disabled={disabled} onCommit={cornerRadius => onPatch({ appearance: { ...node.appearance, cornerRadius, cornerRadii: undefined } })} />
            <button type="button" className="link-button" disabled={disabled} onClick={() => onPatch({ appearance: { ...node.appearance, cornerRadii: uniformRadii(node.appearance.cornerRadius ?? 0) } })}>
              拆分为四角独立圆角
            </button>
          </>
        )}
        <NumberField label="透明度" value={opacityToPercent(node.appearance.opacity)} disabled={disabled} onCommit={percent => onPatch({ appearance: { ...node.appearance, opacity: percentToOpacity(percent) } })} />
      </Section>

      {node.type === "image" && (
        <Section title="图片">
          <Segmented
            label="填充方式"
            value={node.fit}
            disabled={disabled}
            options={imageFitOptions}
            onChange={fit => onPatchImage({ fit: fit as ImageNode["fit"] })}
          />
          <p className="field-hint">资源 {node.assetId}</p>
          {onReplaceImage && <button type="button" disabled={disabled} onClick={onReplaceImage}>替换图片…</button>}
        </Section>
      )}

      {node.type === "text" && (
        <Section title="文字">
          <TextField label="文本" value={node.text} disabled={disabled} onCommit={text => onPatchText({ text })} />
          <TextField label="字体" value={node.fontFamily} disabled={disabled} onCommit={fontFamily => onPatchText({ fontFamily })} />
          <NumberField label="字号" value={node.fontSize} disabled={disabled} onCommit={fontSize => onPatchText({ fontSize })} />
          <NumberField label="行高" value={node.lineHeight} disabled={disabled} onCommit={lineHeight => onPatchText({ lineHeight })} />
          <Segmented
            label="粗细"
            value={String(node.fontWeight ?? TEXT_DEFAULTS.fontWeight)}
            disabled={disabled}
            options={fontWeightOptions}
            onChange={value => onPatchText({ fontWeight: Number(value) })}
          />
          <Segmented
            label="字形"
            value={node.fontStyle ?? TEXT_DEFAULTS.fontStyle}
            disabled={disabled}
            options={[
              { value: "normal", label: "常规" },
              { value: "italic", label: "斜体" },
            ]}
            onChange={value => onPatchText({ fontStyle: value as FontStyle })}
          />
          <Segmented
            label="对齐"
            value={node.textAlign ?? TEXT_DEFAULTS.textAlign}
            disabled={disabled}
            options={[
              { value: "left", label: "左" },
              { value: "center", label: "中" },
              { value: "right", label: "右" },
            ]}
            onChange={value => onPatchText({ textAlign: value as TextAlign })}
          />
          <NumberField label="字距" value={node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing} disabled={disabled} onCommit={letterSpacing => onPatchText({ letterSpacing })} />
        </Section>
      )}
    </>
  );
}

const sizeModeOptions = [
  { value: "fixed", label: "固定" },
  { value: "fill", label: "填充" },
  { value: "hug", label: "适应" },
];

const imageFitOptions = [
  { value: "cover", label: "覆盖" },
  { value: "contain", label: "适应" },
  { value: "fill", label: "拉伸" },
];

const fontWeightOptions = [
  { value: "400", label: "常规" },
  { value: "500", label: "中等" },
  { value: "600", label: "半粗" },
  { value: "700", label: "加粗" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      {children}
    </>
  );
}

export function Segmented({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <ToggleGroup.Root
        type="single"
        className="segmented"
        aria-label={label}
        value={value}
        disabled={disabled}
        // Radix reports "" when the active item is re-pressed; keep the current value instead.
        onValueChange={next => { if (next) onChange(next); }}
      >
        {options.map(option => (
          <ToggleGroup.Item key={option.value} value={option.value} className="segment">
            {option.label}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </label>
  );
}

/**
 * A numeric input.
 *
 * `mixed` marks a field whose value differs across a selection: the input stays
 * blank so it does not pretend that one of the values is the truth, and the user
 * can still type a new value to apply to every selected node. Only a field the
 * user actually typed into is committed — tabbing through it changes nothing.
 */
export function NumberField({ label, value, min, disabled, mixed, onCommit }: { label: string; value: number; min?: number; disabled?: boolean; mixed?: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(mixed ? "" : String(value));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft(mixed ? "" : String(value)); setDirty(false); }, [value, mixed]);
  return (
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <input
        type="number"
        disabled={disabled}
        value={draft}
        placeholder={mixed ? "混合" : undefined}
        onChange={event => { setDraft(event.target.value); setDirty(true); }}
        onBlur={() => {
          const parsed = Number(draft);
          if (!dirty || draft.trim() === "" || !Number.isFinite(parsed)) { setDraft(mixed ? "" : String(value)); setDirty(false); return; }
          const next = min === undefined ? parsed : Math.max(min, parsed);
          setDirty(false);
          // In a mixed field the typed value may equal the first node's value and
          // still be a real change for the other nodes.
          if (mixed || next !== value) onCommit(next);
          else setDraft(String(value));
        }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}

/** A text input. `mixed` behaves like in {@link NumberField}. */
export function TextField({ label, value, disabled, mixed, onCommit }: { label: string; value: string; disabled?: boolean; mixed?: boolean; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(mixed ? "" : value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft(mixed ? "" : value); setDirty(false); }, [value, mixed]);
  return (
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <input
        type="text"
        disabled={disabled}
        value={draft}
        placeholder={mixed ? "混合" : undefined}
        onChange={event => { setDraft(event.target.value); setDirty(true); }}
        onBlur={() => {
          if (!dirty) return;
          setDirty(false);
          // An emptied mixed field clears the value on every selected node.
          if (mixed || draft !== value) onCommit(draft);
        }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}

/** 四角圆角字段的标签，顺序与 CSS `border-radius` 一致。 */
const CORNER_LABELS = ["左上", "右上", "右下", "左下"] as const;

function uniformRadii(radius: number): CornerRadii {
  return [radius, radius, radius, radius];
}

/** 从四角独立切回单值时取最大值，视觉上至少不会把圆角削没了。 */
function maxRadius(radii: CornerRadii): number {
  return Math.max(...radii);
}