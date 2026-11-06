import { TEXT_DEFAULTS, type DesignNode, type FontStyle, type SizeMode, type TextAlign, type TextNode } from "@ufira/design-schema";
import { sharedField, type BatchAppearanceChanges, type BatchLayoutChanges, type BatchTextChanges } from "./batch-edit";
import { opacityToPercent, percentToOpacity } from "./layout-edit";
import { NumberField, Segmented, TextField } from "./property-panel";

export interface BatchPanelProps {
  nodes: DesignNode[];
  disabled?: boolean;
  onPatchAppearance(changes: BatchAppearanceChanges): void;
  onPatchLayout(changes: BatchLayoutChanges): void;
  onPatchText(changes: BatchTextChanges): void;
}

/**
 * The property inspector for a multi-selection.
 *
 * Every field shows the value the selected nodes share. Fields that differ across
 * the selection stay blank and are applied to all selected nodes as soon as the
 * user types a value, so the panel never pretends that one of the values is the truth.
 */
export function BatchPanel({ nodes, disabled, onPatchAppearance, onPatchLayout, onPatchText }: BatchPanelProps) {
  const fill = sharedField(nodes, node => node.appearance.fill ?? "");
  const stroke = sharedField(nodes, node => node.appearance.stroke ?? "");
  const cornerRadius = sharedField(nodes, node => node.appearance.cornerRadius ?? 0);
  const opacity = sharedField(nodes, node => opacityToPercent(node.appearance.opacity));
  const widthMode = sharedField(nodes, node => node.layout.widthMode);
  const heightMode = sharedField(nodes, node => node.layout.heightMode);
  const width = sharedField(nodes, node => node.layout.width);
  const height = sharedField(nodes, node => node.layout.height);
  // 文字样式只对文本节点有意义：只看被选中的文本节点之间的取值。
  const textNodes = nodes.filter((node): node is TextNode => node.type === "text");
  const fontFamily = sharedField(textNodes, node => node.fontFamily);
  const fontSize = sharedField(textNodes, node => node.fontSize);
  const lineHeight = sharedField(textNodes, node => node.lineHeight);
  const fontWeight = sharedField(textNodes, node => node.fontWeight ?? TEXT_DEFAULTS.fontWeight);
  const fontStyle = sharedField(textNodes, node => node.fontStyle ?? TEXT_DEFAULTS.fontStyle);
  const textAlign = sharedField(textNodes, node => node.textAlign ?? TEXT_DEFAULTS.textAlign);
  const letterSpacing = sharedField(textNodes, node => node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing);

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
      {textNodes.length > 0 && <Section title="批量文字">
        <TextField label="字体" value={fontFamily.value} mixed={fontFamily.mixed} disabled={disabled} onCommit={value => onPatchText({ fontFamily: value })} />
        <NumberField label="字号" value={fontSize.value} mixed={fontSize.mixed} disabled={disabled} onCommit={value => onPatchText({ fontSize: value })} />
        <NumberField label="行高" value={lineHeight.value} mixed={lineHeight.mixed} disabled={disabled} onCommit={value => onPatchText({ lineHeight: value })} />
        <Segmented label="粗细" value={fontWeight.mixed ? "" : String(fontWeight.value)} disabled={disabled} options={fontWeightOptions} onChange={value => onPatchText({ fontWeight: Number(value) })} />
        <Segmented label="字形" value={fontStyle.mixed ? "" : fontStyle.value} disabled={disabled} options={fontStyleOptions} onChange={value => onPatchText({ fontStyle: value as FontStyle })} />
        <Segmented label="对齐" value={textAlign.mixed ? "" : textAlign.value} disabled={disabled} options={textAlignOptions} onChange={value => onPatchText({ textAlign: value as TextAlign })} />
        <NumberField label="字距" value={letterSpacing.value} mixed={letterSpacing.mixed} disabled={disabled} onCommit={value => onPatchText({ letterSpacing: value })} />
      </Section>}
    </>
  );
}

const sizeModeOptions = [
  { value: "fixed", label: "固定" },
  { value: "fill", label: "填充" },
  { value: "hug", label: "适应" },
];

const fontWeightOptions = [
  { value: "400", label: "常规" },
  { value: "500", label: "中等" },
  { value: "600", label: "半粗" },
  { value: "700", label: "加粗" },
];

const fontStyleOptions = [
  { value: "normal", label: "常规" },
  { value: "italic", label: "斜体" },
];

const textAlignOptions = [
  { value: "left", label: "左" },
  { value: "center", label: "中" },
  { value: "right", label: "右" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      {children}
    </>
  );
}
