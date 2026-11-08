import { useEffect, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { TEXT_DEFAULTS, applyTextRunStyle, runStyleAt, type ConstraintAxis, type CornerRadii, type DesignNode, type FontStyle, type GridTrack, type ImageNode, type LayoutSpec, type Paint, type ShadowSpec, type SizeMode, type TextAlign, type TextPatch, type TextRunStyle } from "@ufira/design-schema";
import { addGridTrack, opacityToPercent, percentToOpacity, removeGridTrack, resolvePadding, switchLayoutMode, type LayoutMode } from "./layout-edit";

export interface PropertyPanelProps {
  node: DesignNode;
  /** 父节点：约束只在绝对布局的容器里才有意义，所以面板需要知道父级。 */
  parent?: DesignNode;
  disabled?: boolean;
  onPatch(patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "mask" | "constraints">>): void;
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
export function PropertyPanel({ node, parent, disabled, onPatch, onPatchText, onPatchImage, onReplaceImage }: PropertyPanelProps) {
  const layout = node.layout;
  const isStack = layout.mode === "stack";  const isGrid = layout.mode === "grid";
  const padding = resolvePadding(layout);
  const grid = layout.grid;

  const patchLayout = (changes: Partial<LayoutSpec>) => onPatch({ layout: { ...layout, ...changes } });
  /** Grid 配置整体替换：轨道数组是嵌套结构，浅合并会留下旧轨道。 */
  const patchGrid = (changes: Partial<NonNullable<LayoutSpec["grid"]>>) => {
    if (!grid) return;
    patchLayout({ grid: { ...grid, ...changes } });
  };
  const patchPadding = (changes: Partial<typeof padding>) => patchLayout({ padding: { ...padding, ...changes } });
  /** 只改一个角：四角数组是整体替换的，先拷贝再赋值。 */
  const patchCorner = (index: number, value: number) => {
    const radii = [...(node.appearance.cornerRadii ?? uniformRadii(node.appearance.cornerRadius ?? 0))] as CornerRadii;
    radii[index] = value;
    onPatch({ appearance: { ...node.appearance, cornerRadii: radii } });
  };
  /** 填充层：数组顺序是「第 0 层在最底下」，面板只编辑当前选中的那一层。 */
  const paints = node.appearance.fills ?? [];
  const [paintIndex, setPaintIndex] = useState(0);
  /**
   * 文本选区的 UTF-16 偏移。
   *
   * 选中文字后改「粗细 / 字形 / 选区颜色」只作用于这一段；没选中就退回整节点样式。
   * 切到别的节点时清空——旧偏移套在新文本上会落在随机位置。
   */
  const [textSelection, setTextSelection] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  useEffect(() => { setTextSelection({ from: 0, to: 0 }); }, [node.id]);
  const hasTextSelection = node.type === "text" && textSelection.to > textSelection.from;
  /** 返回 true 表示这次改动已经作为段内样式提交，调用方不要再改整节点样式。 */
  const patchRunStyle = (style: TextRunStyle): boolean => {
    if (node.type !== "text" || !hasTextSelection) return false;
    const from = Math.max(0, Math.min(textSelection.from, node.text.length));
    const to = Math.max(0, Math.min(textSelection.to, node.text.length));
    if (to <= from) return false;
    onPatchText({ runs: applyTextRunStyle(node.text, node.runs, from, to, style) });
    return true;
  };
  const selectionColor = node.type === "text" && hasTextSelection
    ? runStyleAt(node.text, node.runs, textSelection.from).color ?? "#111111"
    : "#111111";
  // 删掉一层后下标可能越界，取最小值兜底，避免编辑到不存在的层。
  const activeIndex = paints.length ? Math.min(paintIndex, paints.length - 1) : 0;
  const paint = paints[activeIndex];
  const patchPaint = (next: Paint | undefined) => {
    const nextFills = paints.length
      ? paints
        .map((current, index) => (index === activeIndex ? next : current))
        .filter((value): value is Paint => Boolean(value))
      : next ? [next] : [];
    onPatch({ appearance: { ...node.appearance, fills: nextFills.length ? nextFills : undefined } });
  };
  const addPaint = () => {
    onPatch({ appearance: { ...node.appearance, fills: [...paints, { type: "solid", color: "#8b5cf6" }] } });
    setPaintIndex(paints.length);
  };
  /** 阴影是整体替换的对象：合并时保留没改的字段，空对象就是「新建默认阴影」。 */
  const patchShadow = (changes: Partial<ShadowSpec>) => {
    const shadow: ShadowSpec = { x: 0, y: 4, blur: 12, color: "#00000040", ...node.appearance.shadow, ...changes };
    onPatch({ appearance: { ...node.appearance, shadow } });
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
            { value: "grid", label: "网格" },
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
        {isGrid && grid && (
          <>
            <Segmented
              label="对齐"
              value={grid.align ?? "start"}
              disabled={disabled}
              options={[
                { value: "start", label: "起点" },
                { value: "center", label: "居中" },
                { value: "end", label: "终点" },
                { value: "stretch", label: "拉伸" },
              ]}
              onChange={align => patchGrid({ align: align as NonNullable<LayoutSpec["grid"]>["align"] })}
            />
            <GridTrackEditor label="列" tracks={grid.columns} disabled={disabled} onChange={columns => patchGrid({ columns })} />
            <GridTrackEditor label="行" tracks={grid.rows} disabled={disabled} onChange={rows => patchGrid({ rows })} />
            <NumberField label="列间距" value={grid.columnGap} min={0} disabled={disabled} onCommit={columnGap => patchGrid({ columnGap })} />
            <NumberField label="行间距" value={grid.rowGap} min={0} disabled={disabled} onCommit={rowGap => patchGrid({ rowGap })} />
          </>
        )}
      </Section>

      <Section title="尺寸">
        <NumberField label="X" value={layout.x} disabled={disabled} onCommit={x => patchLayout({ x })} />
        <NumberField label="Y" value={layout.y} disabled={disabled} onCommit={y => patchLayout({ y })} />
        <NumberField label="宽" value={layout.width} min={0} disabled={disabled} onCommit={width => patchLayout({ width })} />
        <NumberField label="高" value={layout.height} min={0} disabled={disabled} onCommit={height => patchLayout({ height })} />
        <NumberField label="旋转" value={layout.rotation ?? 0} disabled={disabled} onCommit={rotation => patchLayout({ rotation: rotation === 0 ? undefined : rotation })} />
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

      {/* 约束只对绝对布局容器里的子节点有意义；在页面根或 stack 容器里显示只会误导。 */}
      {parent && parent.layout.mode === "absolute" && (
        <Section title="约束">
          <Segmented
            label="水平"
            value={node.constraints?.horizontal ?? "start"}
            disabled={disabled}
            options={horizontalConstraintOptions}
            onChange={horizontal => onPatch({ constraints: { horizontal: horizontal as ConstraintAxis, vertical: node.constraints?.vertical ?? "start" } })}
          />
          <Segmented
            label="垂直"
            value={node.constraints?.vertical ?? "start"}
            disabled={disabled}
            options={verticalConstraintOptions}
            onChange={vertical => onPatch({ constraints: { horizontal: node.constraints?.horizontal ?? "start", vertical: vertical as ConstraintAxis } })}
          />
          <p className="field-hint">父级尺寸变化时生效：贴边保持间距、拉伸、居中或按比例缩放。</p>
        </Section>
      )}

      <Section title="外观">
        {/* 多层填充：数字按钮切换当前编辑的层，顺序即叠放顺序（1 在最底下）。 */}
        <div className="paint-layers">
          {paints.map((layer, index) => (
            <button
              key={index}
              type="button"
              className={`paint-layer${index === activeIndex ? " active" : ""}`}
              disabled={disabled}
              title={layer.type === "linear" ? "线性渐变层" : "实色层"}
              onClick={() => setPaintIndex(index)}
            >
              {index + 1}{layer.type === "linear" ? "渐变" : ""}
            </button>
          ))}
          <button type="button" className="paint-layer" disabled={disabled} title="添加填充层" onClick={addPaint}>＋</button>
          {paints.length > 0 && (
            <button type="button" className="paint-layer" disabled={disabled} title="移除当前层" onClick={() => patchPaint(undefined)}>－</button>
          )}
        </div>
        {paint?.type === "linear" ? (
          <>
            <NumberField label="渐变角度" value={paint.angle} disabled={disabled} onCommit={angle => patchPaint({ ...paint, angle })} />
            <TextField label="起始色" value={paint.stops[0]?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(withStop(paint, 0, color))} />
            <TextField label="结束色" value={paint.stops[paint.stops.length - 1]?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(withStop(paint, paint.stops.length - 1, color))} />
            <button type="button" className="link-button" disabled={disabled} onClick={() => patchPaint({ type: "solid", color: paint.stops[0]?.color ?? "#8b5cf6" })}>
              改回纯色
            </button>
          </>
        ) : paint?.type === "radial" ? (
          <>
            <NumberField label="中心X%" value={Math.round(paint.cx * 100)} disabled={disabled} onCommit={value => patchPaint({ ...paint, cx: value / 100 })} />
            <NumberField label="中心Y%" value={Math.round(paint.cy * 100)} disabled={disabled} onCommit={value => patchPaint({ ...paint, cy: value / 100 })} />
            <NumberField label="半径%" value={Math.round(paint.r * 100)} min={1} disabled={disabled} onCommit={value => patchPaint({ ...paint, r: Math.max(value, 1) / 100 })} />
            <TextField label="起始色" value={paint.stops[0]?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(withStop(paint, 0, color))} />
            <TextField label="结束色" value={paint.stops[paint.stops.length - 1]?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(withStop(paint, paint.stops.length - 1, color))} />
            <button type="button" className="link-button" disabled={disabled} onClick={() => patchPaint({ type: "solid", color: paint.stops[0]?.color ?? "#8b5cf6" })}>
              改回纯色
            </button>
          </>
        ) : (
          <>
            <TextField label="填充" value={paint?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(color ? { type: "solid", color } : undefined)} />
            {paint?.type === "solid" && (
              <>
                <button type="button" className="link-button" disabled={disabled} onClick={() => patchPaint(toGradient(paint.color))}>
                  改为线性渐变
                </button>
                <button type="button" className="link-button" disabled={disabled} onClick={() => patchPaint(toRadial(paint.color))}>
                  改为径向渐变
                </button>
              </>
            )}
          </>
        )}
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
        {MASKABLE_TYPES.has(node.type) && (
          <button type="button" className="link-button" disabled={disabled} onClick={() => onPatch({ mask: node.mask ? undefined : true })}>
            {node.mask ? "取消蒙版" : "用作蒙版（裁剪上方兄弟层）"}
          </button>
        )}
        {node.appearance.shadow ? (
          <>
            <div className="field-grid field-grid-4">
              <NumberField label="X" value={node.appearance.shadow.x} disabled={disabled} onCommit={x => patchShadow({ x })} />
              <NumberField label="Y" value={node.appearance.shadow.y} disabled={disabled} onCommit={y => patchShadow({ y })} />
              <NumberField label="模糊" value={node.appearance.shadow.blur} min={0} disabled={disabled} onCommit={blur => patchShadow({ blur })} />
            </div>
            <TextField label="阴影色" value={node.appearance.shadow.color} disabled={disabled} onCommit={color => patchShadow({ color })} />
            <button type="button" className="link-button" disabled={disabled} onClick={() => onPatch({ appearance: { ...node.appearance, shadow: undefined } })}>
              移除阴影
            </button>
          </>
        ) : (
          <button type="button" className="link-button" disabled={disabled} onClick={() => patchShadow({})}>
            添加投影
          </button>
        )}
        <NumberField label="图层模糊" value={node.appearance.blur ?? 0} min={0} disabled={disabled} onCommit={blur => onPatch({ appearance: { ...node.appearance, blur: blur > 0 ? blur : undefined } })} />
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
          <TextAreaField
            label="文本"
            value={node.text}
            disabled={disabled}
            onSelection={(from, to) => setTextSelection({ from, to })}
            onCommit={text => { setTextSelection({ from: 0, to: 0 }); onPatchText({ text }); }}
          />
          <TextField label="字体" value={node.fontFamily} disabled={disabled} onCommit={fontFamily => onPatchText({ fontFamily })} />
          <NumberField label="字号" value={node.fontSize} disabled={disabled} onCommit={fontSize => onPatchText({ fontSize })} />
          <NumberField label="行高" value={node.lineHeight} disabled={disabled} onCommit={lineHeight => onPatchText({ lineHeight })} />
          <Segmented
            label="粗细"
            value={String(node.fontWeight ?? TEXT_DEFAULTS.fontWeight)}
            disabled={disabled}
            options={fontWeightOptions}
            onChange={value => {
              if (!patchRunStyle({ fontWeight: Number(value) })) onPatchText({ fontWeight: Number(value) });
            }}
          />
          <Segmented
            label="字形"
            value={node.fontStyle ?? TEXT_DEFAULTS.fontStyle}
            disabled={disabled}
            options={[
              { value: "normal", label: "常规" },
              { value: "italic", label: "斜体" },
            ]}
            onChange={value => {
              const fontStyle = value as FontStyle;
              if (!patchRunStyle({ fontStyle })) onPatchText({ fontStyle });
            }}
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
          <p className="field-hint">{hasTextSelection ? `已选中 ${textSelection.to - textSelection.from} 个字符：粗细、字形、颜色只作用于选区` : "在文本框里选中文字后，粗细/字形/颜色只作用于选区"}</p>
          {hasTextSelection && (
            <div className="rich-text-selection">
              <label className="field field-inline">
                <span className="field-label">选区颜色</span>
                <input type="color" value={selectionColor} disabled={disabled} onChange={event => patchRunStyle({ color: event.target.value })} />
              </label>
              <button type="button" disabled={disabled} onClick={() => patchRunStyle({})}>清除选区样式</button>
            </div>
          )}
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

/** 约束选项：水平方向贴左/贴右，垂直方向贴上/贴下，其余三个轴通用。 */
const horizontalConstraintOptions = [
  { value: "start", label: "左" },
  { value: "end", label: "右" },
  { value: "center", label: "居中" },
  { value: "stretch", label: "拉伸" },
  { value: "scale", label: "缩放" },
];

const verticalConstraintOptions = [
  { value: "start", label: "上" },
  { value: "end", label: "下" },
  { value: "center", label: "居中" },
  { value: "stretch", label: "拉伸" },
  { value: "scale", label: "缩放" },
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

/**
 * Grid 轨道编辑器。
 *
 * 每条轨道一行：类型下拉 + 尺寸/权重输入 + 删除按钮。
 * 轨道数组是整体替换的——所以每次改动都产出完整的新数组，
 * 不做「就地修改」（那样 React 拿不到新引用，面板不会重渲染）。
 */
function GridTrackEditor({
  label,
  tracks,
  disabled,
  onChange,
}: {
  label: string;
  tracks: GridTrack[];
  disabled?: boolean;
  onChange(tracks: GridTrack[]): void;
}) {
  const replace = (index: number, track: GridTrack) => {
    onChange(tracks.map((current, position) => (position === index ? track : current)));
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="grid-tracks">
        {tracks.map((track, index) => (
          <div className="grid-track" key={index}>
            <select
              className="grid-track-type"
              value={track.type}
              disabled={disabled}
              aria-label={`${label} ${index + 1} 类型`}
              onChange={event => {
                const type = event.target.value as GridTrack["type"];
                // 换类型时尺寸参数要跟着换：fixed 要像素，fraction 要权重。
                replace(index, track.type === type ? track : defaultTrackOf(type));
              }}
            >
              <option value="fixed">固定</option>
              <option value="fraction">比例</option>
              <option value="auto">自适应</option>
              <option value="min-content">最小内容</option>
              <option value="max-content">最大内容</option>
            </select>
            {track.type === "fixed" && (
              <input
                type="number"
                className="grid-track-size"
                value={track.size}
                min={0}
                disabled={disabled}
                aria-label={`${label} ${index + 1} 尺寸`}
                onChange={event => {
                  const size = Number(event.target.value);
                  if (Number.isFinite(size) && size >= 0) replace(index, { type: "fixed", size });
                }}
              />
            )}
            {track.type === "fraction" && (
              <input
                type="number"
                className="grid-track-size"
                value={track.weight}
                min={0}
                step={0.5}
                disabled={disabled}
                aria-label={`${label} ${index + 1} 权重`}
                onChange={event => {
                  const weight = Number(event.target.value);
                  // 权重必须为正：0 权重的轨道永远分不到空间。
                  if (Number.isFinite(weight) && weight > 0) replace(index, { type: "fraction", weight });
                }}
              />
            )}
            <button
              type="button"
              className="grid-track-remove"
              disabled={disabled || tracks.length <= 1}
              aria-label={`删除${label} ${index + 1}`}
              onClick={() => onChange(removeGridTrack(tracks, index))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="grid-track-add"
          disabled={disabled}
          onClick={() => onChange(addGridTrack(tracks, "auto"))}
        >
          + 添加{label}
        </button>
      </div>
    </div>
  );
}

/** 换轨道类型时的缺省参数。 */
function defaultTrackOf(type: GridTrack["type"]): GridTrack {
  switch (type) {
    case "fixed":
      return { type: "fixed", size: 100 };
    case "fraction":
      return { type: "fraction", weight: 1 };
    case "auto":
      return { type: "auto" };
    case "min-content":
      return { type: "min-content" };
    case "max-content":
      return { type: "max-content" };
  }
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

/**
 * 多行文本输入。
 *
 * 除了编辑内容，还负责把选区（UTF-16 偏移）报给面板——段内样式就是按这个区间应用的。
 * 用 `onSelect` 而不是 `onChange`：只移动光标也要更新，否则上一次的选区会被当成当前选区。
 */
export function TextAreaField({ label, value, disabled, onCommit, onSelection }: {
  label: string;
  value: string;
  disabled?: boolean;
  onCommit(value: string): void;
  onSelection?(from: number, to: number): void;
}) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft(value); setDirty(false); }, [value]);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea
        rows={3}
        disabled={disabled}
        value={draft}
        onChange={event => { setDraft(event.target.value); setDirty(true); }}
        onSelect={event => onSelection?.(event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0)}
        onBlur={() => { if (dirty && draft !== value) onCommit(draft); }}
      />
    </label>
  );
}

/** 四角圆角字段的标签，顺序与 CSS `border-radius` 一致。 */const CORNER_LABELS = ["左上", "右上", "右下", "左下"] as const;

function uniformRadii(radius: number): CornerRadii {
  return [radius, radius, radius, radius];
}

/** 从四角独立切回单值时取最大值，视觉上至少不会把圆角削没了。 */
function maxRadius(radii: CornerRadii): number {
  return Math.max(...radii);
}
/** 只有形状能当蒙版：文本/图片/容器的「轮廓」没有明确语义。 */
const MASKABLE_TYPES = new Set(["vector", "rectangle", "ellipse"]);
/** 纯色 → 线性渐变：默认上下两段，结束色先给白色，用户自己改。 */
function toGradient(color: string): Paint {
  return { type: "linear", angle: 180, stops: [{ offset: 0, color }, { offset: 1, color: "#ffffff" }] };
}

/** 改一个色标，其余保持不变（线性与径向共用）。 */
function withStop(paint: Extract<Paint, { type: "linear" | "radial" }>, index: number, color: string): Paint {
  return { ...paint, stops: paint.stops.map((stop, position) => position === index ? { ...stop, color } : stop) };
}

/** 纯色 → 径向渐变：默认从中心向外，半径盖住盒子长边的一半。 */
function toRadial(color: string): Paint {
  return { type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: [{ offset: 0, color }, { offset: 1, color: "#ffffff" }] };
}