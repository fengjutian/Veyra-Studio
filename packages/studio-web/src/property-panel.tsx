import { useEffect, useId, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { MAX_LIST_INDENT, TEXT_DEFAULTS, applyTextRunStyle, paragraphIndexAt, paragraphRanges, paragraphStyleAt, runStyleAt, type BlendMode, type ConstraintAxis, type CornerRadii, type DesignNode, type FontStyle, type GridTrack, type ImageNode, type LayoutSpec, type ListType, type Paint, type ShadowSpec, type SizeMode, type TextAlign, type TextNode, type TextPatch, type TextRunStyle, type OverflowMode, type NodePosition } from "@ufira/design-schema";
import { addGridTrack, opacityToPercent, percentToOpacity, removeGridTrack, resolvePadding, switchLayoutMode, type LayoutMode } from "./layout-edit";
import { GridTrackEditor as GridTrackVisualEditor } from "./grid-track-editor";
import { GridAreaEditor } from "./grid-area-editor";
import { reconcileGridAreasWithTracks } from "./grid-areas-model";
import type { BooleanOperation } from "./boolean";
import { CollapsibleSection } from "./ui/collapsible-section";

export interface PropertyPanelProps {
  node: DesignNode;
  /** 父节点：约束只在绝对布局的容器里才有意义，所以面板需要知道父级。 */
  parent?: DesignNode;
  disabled?: boolean;
  onPatch(patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "mask" | "constraints" | "overflow" | "position">>): void;
  onPatchText(patch: TextPatch): void;
  /** 改段落样式（列表类型 / 缩进 / 段落缩进 / 悬挂 / 列表间距）；走独立命令，不经过 TextPatch。 */
  onSetParagraphStyle?(payload: { from: number; to: number; style: { listType?: ListType | "none"; indentDelta?: number; paragraphIndent?: number; hanging?: boolean; listSpacing?: number } }): void;
  onPatchImage(patch: { fit?: ImageNode["fit"] }): void;
/** 布尔组的运算类型切换与解除。 */
  onSetBooleanOperation?(operation: BooleanOperation): void;
  onReleaseBoolean?(): void;
  /** 属性面板的字体建议（已加载 + 文档声明过的族名）。 */
  fontSuggestions?: string[];
  /** 换一张图：只改节点引用的资源，节点本身不重建。 */
  onReplaceImage?(): void;
  /** 子节点显示名（Grid 命名区域的分配下拉框用）；缺省显示节点 id。 */
  nodeName?(id: string): string;
}

/**
 * The property inspector for a single selected node.
 *
 * It exposes the full layout vocabulary the layout engine understands —
 * absolute and stack modes, fixed/fill/hug sizing, gap, padding and alignment —
 * so the editor can drive the same semantics the exporters use.
 */
export function PropertyPanel({ node, parent, disabled, onPatch, onPatchText, onSetParagraphStyle, onPatchImage, onReplaceImage, fontSuggestions, onSetBooleanOperation, onReleaseBoolean, nodeName }: PropertyPanelProps) {
  const layout = node.layout;
  const isStack = layout.mode === "stack";  const isGrid = layout.mode === "grid";
  const padding = resolvePadding(layout);
  const grid = layout.grid;

  const patchLayout = (changes: Partial<LayoutSpec>) => onPatch({ layout: { ...layout, ...changes } });
  /** 轨道数变化后模板失配的提示；切换节点时清空。 */
  const [gridNotice, setGridNotice] = useState<string>();
  useEffect(() => { setGridNotice(undefined); }, [node.id]);
  /** Grid 配置整体替换：轨道数组是嵌套结构，浅合并会留下旧轨道。 */
  const patchGrid = (changes: Partial<NonNullable<LayoutSpec["grid"]>>) => {
    if (!grid) return;
    const next = { ...grid, ...changes };
    const trackCountChanged =
      (changes.columns !== undefined && changes.columns.length !== grid.columns.length) ||
      (changes.rows !== undefined && changes.rows.length !== grid.rows.length);
    // 轨道数变了，模板就可能与新轨道对不上（区域画在已经删掉的那一列上）。
    // 这时先把区域固化成行列号再丢掉模板：位置不跳，文档仍然合法。
    if (trackCountChanged) {
      const reconciled = reconcileGridAreasWithTracks(next);
      if (reconciled.dropped) {
        setGridNotice("轨道数变化后模板对不上了，已把区域位置固化为行列号（模板已清除）");
        patchLayout({ grid: { ...next, areas: reconciled.areas, cells: reconciled.cells } });
        return;
      }
    }
    setGridNotice(undefined);
    patchLayout({ grid: next });
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
  const selectionStyle = node.type === "text" && hasTextSelection ? runStyleAt(node.text, node.runs, textSelection.from) : {};
  const selectionColor = selectionStyle.color ?? "#111111";
  const selectionFontSize = node.type === "text" ? selectionStyle.fontSize ?? node.fontSize : 0;
  /**
   * 段落样式的当前状态：取选区（或光标）所在那一段。
   *
   * 列表类型与缩进是**段落级**的，面板读的是段落而不是字符——
   * 用户选中了列表项中间的一个字，回显的仍然是这一段的列表类型。
   */
  const paragraphState = node.type === "text" ? currentParagraphState(node.text, node.paragraphStyles, hasTextSelection ? textSelection.from : 0) : undefined;
  /**
   * 段落样式的作用范围：有选区时作用于选区覆盖的段落，没有选区时作用于整段文本。
   *
   * 命令层会把区间吸附到段落边界，所以这里给选区原始偏移就够——
   * 选区落在段中时整段生效，与 Figma 一致。
   */
  const paragraphRange = node.type === "text"
    ? (hasTextSelection
      ? { from: Math.max(0, textSelection.from), to: Math.min(node.text.length, textSelection.to) }
      : { from: 0, to: node.text.length })
    : { from: 0, to: 0 };
  const setParagraphStyle = (style: { listType?: ListType | "none"; indentDelta?: number; paragraphIndent?: number; hanging?: boolean; listSpacing?: number }) => {
    if (node.type !== "text") return;
    onSetParagraphStyle?.({ ...paragraphRange, style });
  };
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
      <Section id="layout" title="布局">
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
            <GridTrackVisualEditor
              tracks={grid.columns}
              gutter={grid.columnGap}
              margin={0}
              containerWidth={Math.max(0, layout.width - padding.left - padding.right)}
              disabled={disabled}
              onChange={next => patchGrid({ columns: next.tracks, columnGap: next.gutter })}
            />
            <GridTrackEditor label="行" tracks={grid.rows} disabled={disabled} onChange={rows => patchGrid({ rows })} />
            <NumberField label="列间距" value={grid.columnGap} min={0} disabled={disabled} onCommit={columnGap => patchGrid({ columnGap })} />
            <NumberField label="行间距" value={grid.rowGap} min={0} disabled={disabled} onCommit={rowGap => patchGrid({ rowGap })} />
            <GridAreaEditor
              grid={grid}
              childIds={node.childIds}
              nodeName={nodeName}
              disabled={disabled}
              onChange={changes => patchGrid(changes)}
            />
            {gridNotice && (
              <div className="warning-row">
                <span className="warning-code">areas-dropped</span>
                <span className="warning-message">{gridNotice}</span>
              </div>
            )}
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

      {/* 溢出模式只对容器有意义：形状没有「内容超出盒子」这回事。 */}
      {CONTAINER_TYPES.has(node.type) && (
        <Section title="溢出">
          <Segmented
            label="内容超出盒子时"
            value={node.overflow ?? "hidden"}
            disabled={disabled}
            options={overflowOptions}
            onChange={value => onPatch({ overflow: value === "hidden" ? undefined : (value as OverflowMode) })}
          />
          <p className="field-hint">「裁切」是缺省行为；「滚动」在原型预览里可滚；「可见」允许内容溢出到盒子外。</p>
        </Section>
      )}

      {/* 滚动定位：任何节点都能设，固定/粘性都只在原型预览里生效。 */}
      <Section title="定位">
        <Segmented
          label="滚动时"
          value={node.position ?? "scroll"}
          disabled={disabled}
          options={positionOptions}
          onChange={value => onPatch({ position: value === "scroll" ? undefined : (value as NodePosition) })}
        />
        <p className="field-hint">「固定」在原型预览里钉在视口上；「粘性」在滚动容器里滚到边缘就停住。</p>
      </Section>

      {/* 约束只对绝对布局容器里的子节点有意义；在页面根或 stack 容器里显示只会误导。 */}
      {parent && parent.layout.mode === "absolute" && (
        <Section id="constraints" title="约束" defaultOpen={false}>
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

      <Section id="appearance" title="外观">
        {/* 多层填充：数字按钮切换当前编辑的层，顺序即叠放顺序（1 在最底下）。 */}
        <div className="paint-layers">
          {paints.map((layer, index) => (
            <button
              key={index}
              type="button"
              className={`paint-layer${index === activeIndex ? " active" : ""}`}
              disabled={disabled}
              title={paintLayerTitle(layer.type)}
              onClick={() => setPaintIndex(index)}
            >
              {index + 1}{layer.type === "solid" ? "" : "渐变"}
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
        ) : paint?.type === "elliptical" ? (
          <>
            <NumberField label="中心X%" value={Math.round(paint.cx * 100)} disabled={disabled} onCommit={value => patchPaint({ ...paint, cx: value / 100 })} />
            <NumberField label="中心Y%" value={Math.round(paint.cy * 100)} disabled={disabled} onCommit={value => patchPaint({ ...paint, cy: value / 100 })} />
            <NumberField label="横半轴%" value={Math.round(paint.rx * 100)} min={1} disabled={disabled} onCommit={value => patchPaint({ ...paint, rx: Math.max(value, 1) / 100 })} />
            <NumberField label="纵半轴%" value={Math.round(paint.ry * 100)} min={1} disabled={disabled} onCommit={value => patchPaint({ ...paint, ry: Math.max(value, 1) / 100 })} />
            <NumberField label="旋转" value={paint.angle ?? 0} disabled={disabled} onCommit={angle => patchPaint({ ...paint, angle: angle === 0 ? undefined : angle })} />
            <TextField label="起始色" value={paint.stops[0]?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(withStop(paint, 0, color))} />
            <TextField label="结束色" value={paint.stops[paint.stops.length - 1]?.color ?? ""} disabled={disabled} onCommit={color => patchPaint(withStop(paint, paint.stops.length - 1, color))} />
            <p className="field-hint">横/纵半轴是占盒子宽/高的比例：50% / 50% 时椭圆正好内接于盒子。</p>            <button type="button" className="link-button" disabled={disabled} onClick={() => patchPaint({ type: "solid", color: paint.stops[0]?.color ?? "#8b5cf6" })}>
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
                <button type="button" className="link-button" disabled={disabled} onClick={() => patchPaint(toElliptical(paint.color))}>
                  改为椭圆渐变
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
        <SelectField
          label="混合模式"
          value={node.appearance.blendMode ?? "normal"}
          disabled={disabled}
          options={blendModeOptions}
          onChange={value => onPatch({ appearance: { ...node.appearance, blendMode: value as BlendMode } })}
        />
        <NumberField label="背景模糊" value={node.appearance.backgroundBlur ?? 0} min={0} disabled={disabled} onCommit={value => onPatch({ appearance: { ...node.appearance, backgroundBlur: value > 0 ? value : undefined } })} />
        <p className="field-hint">背景模糊只影响节点后面的内容；导出到 HTML/SVG 与画布一致。</p>
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

      {node.type === "boolean" && (
        <Section title="布尔运算">
          <Segmented
            label="类型"
            value={node.operation}
            disabled={disabled}
            options={booleanOperationOptions}
            onChange={operation => onSetBooleanOperation?.(operation as BooleanOperation)}
          />
          <p className="field-hint">几何按操作数实时计算：改子节点或换类型都会立刻生效。</p>
          <button type="button" disabled={disabled} onClick={onReleaseBoolean}>解除布尔组</button>
        </Section>
      )}
      {node.type === "text" && (
        <Section id="typography" title="文字">
          <TextAreaField
            label="文本"
            value={node.text}
            disabled={disabled}
            onSelection={(from, to) => setTextSelection({ from, to })}
            onCommit={text => { setTextSelection({ from: 0, to: 0 }); onPatchText({ text }); }}
          />
          <TextField label="字体" value={node.fontFamily} disabled={disabled} suggestions={fontSuggestions} onCommit={fontFamily => onPatchText({ fontFamily })} />
          {node.bindings?.typography && (
            <p className="empty-hint">
              字体样式由 token「{node.bindings.typography}」控制，字体/字号/行高以它为准；
              要改就在「数据 → 设计 Tokens」里改这份 token。
            </p>
          )}
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
              <NumberField label="选区字号" value={selectionFontSize} min={1} disabled={disabled} onCommit={fontSize => patchRunStyle({ fontSize })} />
              <label className="field field-inline">
                <span className="field-label">选区颜色</span>
                <input type="color" value={selectionColor} disabled={disabled} onChange={event => patchRunStyle({ color: event.target.value })} />
              </label>
              <button type="button" disabled={disabled} onClick={() => patchRunStyle({})}>清除选区样式</button>
            </div>
          )}
        </Section>
      )}

      {node.type === "text" && (
        <Section title="段落">
          <Segmented
            label="列表"
            value={paragraphState?.listType ?? "none"}
            disabled={disabled || !onSetParagraphStyle}
            options={[
              { value: "none", label: "无" },
              { value: "bullet", label: "项目符号" },
              { value: "ordered", label: "编号" },
            ]}
            onChange={value => setParagraphStyle({ listType: value as ListType | "none" })}
          />
          <div className="field field-inline">
            <span className="field-label">缩进</span>
            <div className="paragraph-indent">
              <button
                type="button"
                className="paragraph-indent-step"
                disabled={disabled || !onSetParagraphStyle || (paragraphState?.indent ?? 0) <= 0}
                aria-label="减少缩进"
                onClick={() => setParagraphStyle({ indentDelta: -1 })}
              >
                −
              </button>
              <span className="paragraph-indent-value">{paragraphState?.indent ?? 0}</span>
              <button
                type="button"
                className="paragraph-indent-step"
                disabled={disabled || !onSetParagraphStyle || (paragraphState?.indent ?? 0) >= MAX_LIST_INDENT}
                aria-label="增加缩进"
                onClick={() => setParagraphStyle({ indentDelta: 1 })}
              >
                ＋
              </button>
            </div>
          </div>
          <NumberField
            label="段落缩进"
            value={paragraphState?.paragraphIndent ?? 0}
            min={0}
            disabled={disabled || !onSetParagraphStyle}
            onCommit={paragraphIndent => setParagraphStyle({ paragraphIndent })}
          />
          <Segmented
            label="悬挂"
            value={paragraphState?.hanging ? "hanging" : "none"}
            disabled={disabled || !onSetParagraphStyle || !paragraphState?.listType}
            options={[
              { value: "none", label: "不悬挂" },
              { value: "hanging", label: "悬挂" },
            ]}
            onChange={value => setParagraphStyle({ hanging: value === "hanging" })}
          />
          <NumberField
            label="列表间距"
            value={paragraphState?.listSpacing ?? 0}
            min={0}
            disabled={disabled || !onSetParagraphStyle}
            onCommit={listSpacing => setParagraphStyle({ listSpacing })}
          />
          <p className="field-hint">列表作用于选区覆盖的段落；没有选区时作用于整段文本。悬挂只对列表段落有效（标记会画到文本框外）。</p>
        </Section>
      )}
    </>
  );
}

/**
 * 取某个下标所在段落的列表状态（面板回显用）。
 *
 * 段落边界由 `paragraphRanges` 决定，所以这里能定位到「光标落在哪一段」，
 * 再读那一段上的段落样式区间。
 */
function currentParagraphState(
  text: string,
  paragraphStyles: TextNode["paragraphStyles"],
  offset: number,
): { listType?: ListType; indent: number; paragraphIndent: number; hanging: boolean; listSpacing: number } | undefined {
  if (!text.length) return undefined;
  const index = paragraphIndexAt(text, Math.max(0, Math.min(offset, text.length - 1)));
  const range = paragraphRanges(text)[index];
  if (!range) return undefined;
  const style = paragraphStyleAt(paragraphStyles, range.start, range.end);
  return {
    listType: style?.listType,
    indent: style?.indent ?? 0,
    paragraphIndent: style?.paragraphIndent ?? 0,
    hanging: style?.hanging === true,
    listSpacing: style?.listSpacing ?? 0,
  };
}

const booleanOperationOptions = [  { value: "union", label: "合并" },
  { value: "subtract", label: "减去" },
  { value: "intersect", label: "交集" },
  { value: "exclude", label: "排除" },
];

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

/**
 * 混合模式选项：取值与 CSS `mix-blend-mode` 一致，标签用通行中文名。
 *
 * 画布上 16 种全部可用（Canvas 的 `globalCompositeOperation` 里有同名的一整套，
 * 实测与 CSS 逐像素一致，见 `visual/blend-probe.ts`）。
 */
const blendModeOptions = [
  { value: "normal", label: "正常" },
  { value: "multiply", label: "正片叠底" },
  { value: "screen", label: "滤色" },
  { value: "overlay", label: "叠加" },
  { value: "darken", label: "变暗" },
  { value: "lighten", label: "变亮" },
  { value: "color-dodge", label: "颜色减淡" },
  { value: "color-burn", label: "颜色加深" },
  { value: "hard-light", label: "强光" },
  { value: "soft-light", label: "柔光" },
  { value: "difference", label: "差异" },
  { value: "exclusion", label: "排除" },
  { value: "hue", label: "色相" },
  { value: "saturation", label: "饱和度" },
  { value: "color", label: "颜色" },
  { value: "luminosity", label: "明度" },
];

/** 填充层的按钮提示：按类型说清楚是哪一层。 */
function paintLayerTitle(type: Paint["type"]): string {
  if (type === "linear") return "线性渐变层";
  if (type === "radial") return "径向渐变层";
  if (type === "elliptical") return "椭圆渐变层";
  return "实色层";
}

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

function Section({ id, title, defaultOpen, children }: { id?: string; title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  if (id) return <CollapsibleSection id={id} title={title} defaultOpen={defaultOpen}>{children}</CollapsibleSection>;
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
              <option value="repeat">自动重复</option>
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
            {track.type === "repeat" && (
              <>
                <input
                  type="number"
                  className="grid-track-size"
                  value={track.min}
                  min={1}
                  disabled={disabled}
                  aria-label={`${label} ${index + 1} 最小宽度`}
                  title="自动重复轨道的最小宽度（px）"
                  onChange={event => {
                    const min = Number(event.target.value);
                    // 最小宽度必须为正：0 会让轨道条数变成无穷多。
                    if (Number.isFinite(min) && min > 0) replace(index, { ...track, min });
                  }}
                />
                <select
                  className="grid-track-type"
                  value={track.mode}
                  disabled={disabled}
                  aria-label={`${label} ${index + 1} 自动模式`}
                  onChange={event => replace(index, { ...track, mode: event.target.value as "auto-fill" | "auto-fit" })}>
                  <option value="auto-fill">auto-fill</option>
                  <option value="auto-fit">auto-fit</option>
                </select>
                <label className="grid-track-grow" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(track.grow)}
                    disabled={disabled}
                    aria-label={`${label} ${index + 1} 均分剩余空间`}
                    onChange={event => replace(index, { ...track, grow: event.target.checked })}
                  />
                  均分
                </label>
              </>
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
    case "repeat":
      return { type: "repeat", mode: "auto-fill", min: 120, grow: true };
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
 * A single-choice dropdown.
 *
 * Used for long option lists (blend modes) where a segmented control would wrap
 * into an unreadable wall of buttons.
 */
export function SelectField({
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
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <select disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
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
export function TextField({ label, value, disabled, mixed, onCommit, suggestions }: {
  label: string;
  value: string;
  disabled?: boolean;
  mixed?: boolean;
  onCommit(value: string): void;
  /** 下拉建议（仍可自由输入）——字体名用它，避免用户拼错导致「看起来正常、其实回退了」。 */
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState(mixed ? "" : value);
  const [dirty, setDirty] = useState(false);
  const listId = useId();
  useEffect(() => { setDraft(mixed ? "" : value); setDirty(false); }, [value, mixed]);
  return (
    <label className="field field-inline">
      <span className="field-label">{label}</span>
      <input
        type="text"
        list={suggestions?.length ? listId : undefined}
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
      {suggestions?.length ? <datalist id={listId}>{suggestions.map(name => <option key={name} value={name} />)}</datalist> : null}
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
/** 只有容器谈得上「内容超出盒子」：形状没有子内容。 */
const CONTAINER_TYPES = new Set(["frame", "component", "instance"]);
/** 溢出模式选项；缺省是「裁切」，所以面板上显示的是显式值。 */
const overflowOptions = [
  { value: "hidden", label: "裁切" },
  { value: "scroll", label: "滚动" },
  { value: "visible", label: "可见" },
];
/** 滚动定位选项；缺省是「跟着内容滚」，所以面板上显示的是显式值。 */
const positionOptions = [
  { value: "scroll", label: "跟随" },
  { value: "fixed", label: "固定" },
  { value: "sticky", label: "粘性" },
];
/** 纯色 → 线性渐变：默认上下两段，结束色先给白色，用户自己改。 */
function toGradient(color: string): Paint {
  return { type: "linear", angle: 180, stops: [{ offset: 0, color }, { offset: 1, color: "#ffffff" }] };
}

/** 纯色 → 径向渐变：默认从中心向外，半径盖住盒子长边的一半。 */
function toRadial(color: string): Paint {
  return { type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: [{ offset: 0, color }, { offset: 1, color: "#ffffff" }] };
}

/** 纯色 → 椭圆渐变：默认居中、两个半轴都内接于盒子。 */
function toElliptical(color: string): Paint {
  return { type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops: [{ offset: 0, color }, { offset: 1, color: "#ffffff" }] };
}

/** 改一个色标，其余保持不变（线性、径向与椭圆共用）。 */
function withStop(paint: Extract<Paint, { type: "linear" | "radial" | "elliptical" }>, index: number, color: string): Paint {
  return { ...paint, stops: paint.stops.map((stop, position) => position === index ? { ...stop, color } : stop) };
}
