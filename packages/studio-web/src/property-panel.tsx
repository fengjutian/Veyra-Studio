import { useEffect, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import type { DesignNode, LayoutSpec, SizeMode } from "@ufira/design-schema";
import { opacityToPercent, percentToOpacity, resolvePadding, switchLayoutMode, type LayoutMode } from "./layout-edit";

export interface PropertyPanelProps {
  node: DesignNode;
  disabled?: boolean;
  onPatch(patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance">>): void;
  onPatchText(patch: { text?: string; fontFamily?: string; fontSize?: number; lineHeight?: number }): void;
}

/**
 * The property inspector for a single selected node.
 *
 * It exposes the full layout vocabulary the layout engine understands —
 * absolute and stack modes, fixed/fill/hug sizing, gap, padding and alignment —
 * so the editor can drive the same semantics the exporters use.
 */
export function PropertyPanel({ node, disabled, onPatch, onPatchText }: PropertyPanelProps) {
  const layout = node.layout;
  const isStack = layout.mode === "stack";
  const padding = resolvePadding(layout);

  const patchLayout = (changes: Partial<LayoutSpec>) => onPatch({ layout: { ...layout, ...changes } });
  const patchPadding = (changes: Partial<typeof padding>) => patchLayout({ padding: { ...padding, ...changes } });

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
        <NumberField label="圆角" value={node.appearance.cornerRadius ?? 0} disabled={disabled} onCommit={cornerRadius => onPatch({ appearance: { ...node.appearance, cornerRadius } })} />
        <NumberField label="透明度" value={opacityToPercent(node.appearance.opacity)} disabled={disabled} onCommit={percent => onPatch({ appearance: { ...node.appearance, opacity: percentToOpacity(percent) } })} />
      </Section>

      {node.type === "text" && (
        <Section title="文字">
          <TextField label="文本" value={node.text} disabled={disabled} onCommit={text => onPatchText({ text })} />
          <TextField label="字体" value={node.fontFamily} disabled={disabled} onCommit={fontFamily => onPatchText({ fontFamily })} />
          <NumberField label="字号" value={node.fontSize} disabled={disabled} onCommit={fontSize => onPatchText({ fontSize })} />
          <NumberField label="行高" value={node.lineHeight} disabled={disabled} onCommit={lineHeight => onPatchText({ lineHeight })} />
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      {children}
    </>
  );
}

function Segmented({
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

function NumberField({ label, value, min, disabled, onCommit }: { label: string; value: number; min?: number; disabled?: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <input
        type="number"
        disabled={disabled}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          const parsed = Number(draft);
          if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
          const next = min === undefined ? parsed : Math.max(min, parsed);
          if (next !== value) onCommit(next);
          else setDraft(String(value));
        }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}

function TextField({ label, value, disabled, onCommit }: { label: string; value: string; disabled?: boolean; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <input
        type="text"
        disabled={disabled}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft); }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}
