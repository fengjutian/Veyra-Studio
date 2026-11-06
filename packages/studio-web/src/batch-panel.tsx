import type { DesignNode, SizeMode } from "@ufira/design-schema";
import { sharedField, type BatchAppearanceChanges, type BatchLayoutChanges } from "./batch-edit";
import { opacityToPercent, percentToOpacity } from "./layout-edit";
import { NumberField, Segmented, TextField } from "./property-panel";

export interface BatchPanelProps {
  nodes: DesignNode[];
  disabled?: boolean;
  onPatchAppearance(changes: BatchAppearanceChanges): void;
  onPatchLayout(changes: BatchLayoutChanges): void;
}

/**
 * The property inspector for a multi-selection.
 *
 * Every field shows the value the selected nodes share. Fields that differ across
 * the selection stay blank and are applied to all selected nodes as soon as the
 * user types a value, so the panel never pretends that one of the values is the truth.
 */
export function BatchPanel({ nodes, disabled, onPatchAppearance, onPatchLayout }: BatchPanelProps) {
  const fill = sharedField(nodes, node => node.appearance.fill ?? "");
  const stroke = sharedField(nodes, node => node.appearance.stroke ?? "");
  const cornerRadius = sharedField(nodes, node => node.appearance.cornerRadius ?? 0);
  const opacity = sharedField(nodes, node => opacityToPercent(node.appearance.opacity));
  const widthMode = sharedField(nodes, node => node.layout.widthMode);
  const heightMode = sharedField(nodes, node => node.layout.heightMode);
  const width = sharedField(nodes, node => node.layout.width);
  const height = sharedField(nodes, node => node.layout.height);

  return (
    <>
      <Section title="批量外观">
        <TextField label="填充" value={fill.value} mixed={fill.mixed} disabled={disabled} onCommit={value => onPatchAppearance({ fill: value })} />
        <TextField label="描边" value={stroke.value} mixed={stroke.mixed} disabled={disabled} onCommit={value => onPatchAppearance({ stroke: value })} />
        <NumberField label="圆角" value={cornerRadius.value} min={0} mixed={cornerRadius.mixed} disabled={disabled} onCommit={cornerRadiusValue => onPatchAppearance({ cornerRadius: cornerRadiusValue })} />
        <NumberField label="透明度" value={opacity.value} mixed={opacity.mixed} disabled={disabled} onCommit={percent => onPatchAppearance({ opacity: percentToOpacity(percent) })} />
      </Section>
      <Section title="批量尺寸">
        <Segmented label="宽度模式" value={widthMode.mixed ? "" : widthMode.value} disabled={disabled} options={sizeModeOptions} onChange={value => onPatchLayout({ widthMode: value as SizeMode })} />
        <Segmented label="高度模式" value={heightMode.mixed ? "" : heightMode.value} disabled={disabled} options={sizeModeOptions} onChange={value => onPatchLayout({ heightMode: value as SizeMode })} />
        <NumberField label="宽" value={width.value} min={0} mixed={width.mixed} disabled={disabled} onCommit={value => onPatchLayout({ width: value })} />
        <NumberField label="高" value={height.value} min={0} mixed={height.mixed} disabled={disabled} onCommit={value => onPatchLayout({ height: value })} />
      </Section>
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
