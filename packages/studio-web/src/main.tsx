import React, { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { SafeAiEditor, createOpenAiCompatiblePlanner, type AiPlanPreview, type AiPlanner } from "@ufira/ai-orchestrator";
import type { CommandEnvelope, DesignCommand } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, CURRENT_SCHEMA_VERSION, migrateDocument, TEXT_DEFAULTS, type AssetMetadata, type DesignDocument, type DesignNode, type ImageNode, type TextPatch } from "@ufira/design-schema";
import { StudioProject, collectAssetUsage, createAssetResolver, findMissingAssets } from "@ufira/studio-application";
import type { AutosaveStatus, ProjectRepository, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { currentAutosaveStatus, flushAutosave, installAutosaveFlush, repository, subscribeAutosave } from "./autosave-store";
import { copyNodeTrees, pasteNodeTrees, type NodeClipboard } from "./node-clipboard";
import { arrangeNodes, nudgeNodes, type Arrangement } from "./node-arrangement";
import { flattenNodeTrees } from "./node-tree";
import { detectImportConflict, prepareImportedDocument } from "./project-import";
import { buildRecoveryReport, missingAssetNotice, recoveryReportFileName, recoveryReportRows, type RecoveryReport } from "./recovery-report";
import { formatSnapshotTime, restoreConfirmation, restoreSnapshotEnvelope, snapshotRows, type SnapshotRow } from "./snapshot-history";
import { safeFilename } from "./file-name";
import { LayerTree } from "./layer-tree";
import { planReparent, type DropPosition } from "./layer-reorder";
import { resolveBox, useCanvasLayout, type CanvasLayout } from "./canvas-layout";
import { CANVAS_HEIGHT, CANVAS_PADDING, CANVAS_WIDTH, clampZoom, contentBounds, fitZoom, selectionBounds, zoomPercent, zoomStep } from "./canvas-zoom";
import { clampScroll, panScroll } from "./canvas-pan";
import { listComponents, makeInstanceNode } from "./components";
import { PropertyPanel } from "./property-panel";
import { BatchPanel } from "./batch-panel";
import { planAppearancePatches, planLayoutPatches, planTextPatches, selectAllIds, type BatchAppearanceChanges, type BatchLayoutChanges, type BatchTextChanges } from "./batch-edit";
import { commitText, textEditAction } from "./text-edit";
import { exportPageToPng, downloadDataUrl } from "./png-export";
import { assetIdForHash, fitImageBox, imageBackgroundStyle, imageFileError, readImageSize, sha256Hex } from "./assets";
import { assetLabel, missingAssetIds, relinkError, relinkSuccessMessage } from "./asset-relink";
import { AssetPanel } from "./asset-panel";
import { assetUrlCacheVersion, forgetAssetUrl, loadAssetUrl } from "./asset-url";
import { Icon } from "./icons";
import { DialogProvider, useChoice, useConfirm, usePrompt } from "./ui/dialogs";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuSeparator, ContextMenuSub, ContextMenuTrigger, resolveContextNodeId } from "./ui/context-menu";
import { aiSettingsComplete, clearAiSettings, readAiSettings, writeAiSettings, DEFAULT_AI_SETTINGS, type AiSettings } from "./ai-settings";
import { AiSettingsPanel } from "./ai-settings-panel";
import "./styles.css";

const PROJECT_ID = "studio:local";
const CanvasInteractionLayer = lazy(() => import("./canvas-interaction-layer"));

function App() {
  const [project, setProject] = useState<StudioProject>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [document, setDocument] = useState<DesignDocument>();
  const [currentPageId, setCurrentPageId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("添加一个蓝色卡片");
  const [preview, setPreview] = useState<AiPlanPreview>();
  const [message, setMessage] = useState("正在打开本地项目…");
  const [busy, setBusy] = useState(false);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // 缩放只是视图状态：它不写进文档，也不涨 revision。
  const [zoom, setZoom] = useState(1);
  // 抓手模式与左右面板开合同样只是视图状态。
  const [panMode, setPanMode] = useState(false);
  const [panning, setPanning] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  // 导出范围：整页，或只导出当前选区。
  const [exportScope, setExportScope] = useState<"page" | "selection">("page");
  const panPointer = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const operationInFlight = useRef(false);
  const clipboard = useRef<NodeClipboard | undefined>(undefined);
  const keyboardAction = useRef<(action: "copy" | "paste" | "duplicate" | "delete" | "layerUp" | "layerDown" | "selectAll") => void>(() => undefined);
  const nudgeAction = useRef<(dx: number, dy: number) => void>(() => undefined);
  const importInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const relinkInput = useRef<HTMLInputElement>(null);
  // 重新关联需要知道"这次要补哪份资源"，文件选择框本身不带这个信息。
  const relinkTarget = useRef<AssetMetadata | undefined>(undefined);
  // 仓库里读不到字节的图片资源，来自打开项目、导入和每次插入/重新关联后的核对。
  const [missingAssets, setMissingAssets] = useState<AssetMetadata[]>([]);
  const [componentName, setComponentName] = useState("");
  const [contextIds, setContextIds] = useState<string[]>([]);
  // AI 模型设置只存在浏览器 localStorage，不进文档也不进事务日志。
  const [aiSettings, setAiSettings] = useState<AiSettings>(() => readAiSettings());
  const askText = usePrompt();
  const askConfirm = useConfirm();
  const askChoice = useChoice();
  // 自动保存状态：待保存 / 保存中 / 已保存 / 失败（含存储配额耗尽）。
  const autosave = useSyncExternalStore(subscribeAutosave, currentAutosaveStatus);
  // 最近一次打开项目的恢复报告。
  const [recovery, setRecovery] = useState<RecoveryReport>();
  // 存储里保留的历史版本，用于回滚。
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  // 没启用真实模型就退回演示规划器：它只造一张固定卡片，不会理解用户需求。
  const planner = useMemo(() => aiSettingsComplete(aiSettings)
    ? createOpenAiCompatiblePlanner({ baseUrl: aiSettings.baseUrl, model: aiSettings.model, apiKey: aiSettings.apiKey || undefined })
    : demoPlanner, [aiSettings]);
  const editor = useMemo(() => project ? new SafeAiEditor(project, planner) : undefined, [project, planner]);

  const applyHistory = async (direction: "undo" | "redo") => {
    if (!project) return;
    const committed = await project[direction]();
    const snapshot = project.snapshot();
    setDocument(snapshot); setProjects(await repository.listProjects()); setSelectedIds(current => current.filter(id => Boolean(snapshot.nodes[id]))); setPreview(undefined); setMessage(`${direction === "undo" ? "撤销" : "重做"}完成 · revision ${committed.result.revision}`);
  };

  useEffect(() => { void initialize(repository).then(async ({ project: value }) => { const snapshot = value.snapshot(); setProject(value); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setProjects(await repository.listProjects()); setSnapshots(await repository.listSnapshots(snapshot.id)); setMissingAssets(await findMissingAssets(repository, snapshot)); setMessage("就绪"); }).catch(error => setMessage(String(error))); }, []);
  // 页面被关闭或切到后台时立刻把待写快照落盘，避免最后几次编辑留在内存里。
  useEffect(() => installAutosaveFlush(), []);
  // 历史版本列表：等自动保存真正落盘之后再刷新，否则看到的还是上一版。
  const snapshotProjectId = document?.id;
  useEffect(() => {
    if (autosave.state !== "saved" || !snapshotProjectId) return;
    let cancelled = false;
    void repository.listSnapshots(snapshotProjectId).then(list => { if (!cancelled) setSnapshots(list); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [autosave.state, autosave.lastSavedAt, snapshotProjectId]);
  useEffect(() => {
    if (!project) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      const action = modifier && key === "c" ? "copy" : modifier && key === "v" ? "paste" : modifier && key === "d" ? "duplicate" : modifier && key === "a" ? "selectAll" : modifier && key === "]" ? "layerUp" : modifier && key === "[" ? "layerDown" : key === "delete" || key === "backspace" ? "delete" : undefined;
      if (action) { event.preventDefault(); keyboardAction.current(action); return; }
      const arrow = !modifier ? ({ arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] } as const)[key as "arrowleft"] : undefined;
      if (arrow) { event.preventDefault(); const step = event.shiftKey ? 10 : 1; nudgeAction.current(arrow[0] * step, arrow[1] * step); return; }
      if (!modifier || key !== "z") return;
      event.preventDefault();
      if (operationInFlight.current) return;
      operationInFlight.current = true; setBusy(true);
      void applyHistory(event.shiftKey ? "redo" : "undo").catch(error => setMessage(errorMessage(error))).finally(() => { operationInFlight.current = false; setBusy(false); });
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [project]);
  // Ctrl/Cmd + 滚轮缩放画布。React 的 onWheel 是被动监听，拦不住默认行为，所以这里用原生监听。
  useEffect(() => {
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(current => clampZoom(current * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [scroller]);

  const activePageId = document && currentPageId && document.pages[currentPageId] ? currentPageId : document?.pageOrder[0];
  // Hooks must run before the early return below, so the layout is resolved unconditionally.
  const canvasLayout = useCanvasLayout(document, activePageId ?? "", { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  // 导出范围：整页用画布尺寸；选区用选中节点的包围盒，并只导出与选中节点相关的分支。
  const exportTarget = useMemo(() => {
    if (exportScope === "selection") {
      const bounds = selectionBounds(canvasLayout.boxes, selectedIds);
      if (bounds) return { viewport: { width: bounds.width, height: bounds.height }, origin: { x: bounds.x, y: bounds.y }, nodeIds: selectedIds };
    }
    return { viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT } };
  }, [exportScope, canvasLayout.boxes, selectedIds]);
  // 选区没了就把范围退回整页，避免导出一个空视口。
  useEffect(() => { if (exportScope === "selection" && !selectedIds.length) setExportScope("page"); }, [exportScope, selectedIds.length]);
  // 资源面板和画布共用同一份使用情况与缺失集合。
  const assetUsage = useMemo(() => document ? collectAssetUsage(document) : [], [document]);
  const missingIds = useMemo(() => missingAssetIds(missingAssets), [missingAssets]);

  if (!project || !document) return <main className="loading">{message}</main>;
  const page = document.pages[activePageId!]!;
  const pageNodes = flattenNodeTrees(document, page.childIds);
  const selected = selectedIds.length ? document.nodes[selectedIds.at(-1)!] : undefined;
  const selectedRootIds = copyNodeTrees(document, selectedIds).roots;
  const selectedNodes = selectedRootIds.map(id => document.nodes[id]!).filter(Boolean);
  const selectionLocked = selectedNodes.some(node => node.locked);
  const selectionSameParent = selectedNodes.every(node => node.parentId === selectedNodes[0]?.parentId);

  const run = async (operation: () => Promise<void>) => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    try { await operation(); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { operationInFlight.current = false; setBusy(false); }
  };
  const execute = async (commands: DesignCommand[]) => {
    const current = project.snapshot();
    const envelope: CommandEnvelope = { commandId: crypto.randomUUID(), documentId: current.id, baseRevision: current.revision, actor: { type: "human", id: "local-user" }, commands };
    const committed = await project.execute(envelope);
    setDocument(project.snapshot()); setProjects(await repository.listProjects()); setMessage(`已提交 revision ${committed.result.revision}`); setPreview(undefined);
  };
  /** 重新核对仓库里读不到的图片资源，返回最新清单。 */
  const refreshMissingAssets = async (snapshot: DesignDocument) => {
    const list = await findMissingAssets(repository, snapshot);
    setMissingAssets(list);
    return list;
  };
  const openProject = async (id: string) => {
    const opened = await StudioProject.open(repository, id);
    const snapshot = opened.project.snapshot();
    setProject(opened.project); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setSelectedIds([]); setPreview(undefined);
    setSnapshots(await repository.listSnapshots(id));
    // 资源字节不在文档里，只能对着仓库逐份核对；导入别人的项目时这里会查出缺失。
    const missing = await refreshMissingAssets(snapshot);
    setRecovery(buildRecoveryReport({
      projectId: snapshot.id,
      projectName: snapshot.meta.name,
      document: snapshot,
      recoveredFromRevision: opened.recovery.recoveredFromRevision,
      replayedTransactions: opened.recovery.replayedTransactions,
      latestKnownRevision: opened.recovery.latestKnownRevision,
      degraded: opened.recovery.degraded,
      migratedFrom: opened.recovery.migratedFrom,
      missingAssets: missing,
    }));
    const missingNotice = missingAssetNotice(missing);
    setMessage((opened.recovery.migratedFrom !== undefined
      ? `项目已从格式版本 ${opened.recovery.migratedFrom} 升级到当前版本`
      : opened.recovery.degraded ? "项目已降级恢复，请检查事务日志" : "项目已打开") + missingNotice);
  };
  const createProject = () => void run(async () => {
    const name = (await askText({ title: "新项目名称", defaultValue: "未命名设计" }))?.trim(); if (!name) return;
    const created = await StudioProject.create(repository, `project:${crypto.randomUUID()}`, name, `page:${crypto.randomUUID()}`);
    const snapshot = created.snapshot(); setProject(created); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setProjects(await repository.listProjects()); setSelectedIds([]); setPreview(undefined); setRecovery(undefined); setSnapshots(await repository.listSnapshots(snapshot.id)); setMessage("项目已创建");
  });
  const renameProject = () => void run(async () => {
    const name = (await askText({ title: "项目名称", defaultValue: document.meta.name }))?.trim(); if (!name || name === document.meta.name) return;
    await execute([{ type: "document.rename", payload: { name } }]);
  });
  const restoreVersion = (row: SnapshotRow) => void run(async () => {
    const confirmation = restoreConfirmation(row);
    if (!await askConfirm({ ...confirmation, confirmLabel: "还原", destructive: true })) return;
    const snapshot = await repository.readSnapshot(document.id, row.revision);
    // 用运行时自带的 history.restore：版本号继续往前走，这次还原本身也能撤销。
    // 基准取运行时的当前文档，而不是界面上的 state——后者可能慢一拍。
    await project.execute(restoreSnapshotEnvelope(project.snapshot(), snapshot));
    // 还原要立刻落盘，版本列表才能马上反映出来。
    await flushAutosave();
    const restored = project.snapshot();
    setDocument(restored);
    setSelectedIds(current => current.filter(id => Boolean(restored.nodes[id])));
    setProjects(await repository.listProjects());
    setSnapshots(await repository.listSnapshots(document.id));
    setMessage(`已还原到 ${row.label}`);
  });
  const deleteCurrentProject = () => void run(async () => {
    if (!await askConfirm({ title: "删除项目", description: `删除项目“${document.meta.name}”？此操作不可撤销。`, confirmLabel: "删除", destructive: true })) return;
    await repository.deleteProject(document.id);
    const remaining = await repository.listProjects();
    if (remaining[0]) await openProject(remaining[0].id);
    else {
      const created = await StudioProject.create(repository, `project:${crypto.randomUUID()}`, "未命名设计", `page:${crypto.randomUUID()}`);
      const snapshot = created.snapshot(); setProject(created); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setSelectedIds([]); setPreview(undefined);
    }
    setProjects(await repository.listProjects()); setMessage("项目已删除");
  });
  const addNode = (type: "frame" | "text" | "rectangle" | "ellipse") => void run(() => execute([{ type: "node.create", payload: { node: makeNode(type, page.id) } }]));
  /**
   * 插入图片。
   *
   * 三步必须一起成立：字节落进仓库、文档登记资源元数据、创建引用它的节点。
   * 后两步在同一个事务里提交，任何一步失败都不会留下"引用了不存在资源"的文档。
   */
  const insertImage = (file: File) => void run(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const invalid = imageFileError(file, bytes.byteLength);
    if (invalid) { setMessage(invalid); return; }
    const hash = await sha256Hex(bytes);
    await repository.putAsset(document.id, { hash, bytes });
    // 之前可能缓存过"这个资源读不到"，写入之后要让画布重新读一次。
    forgetAssetUrl(document.id, hash);
    const assetId = assetIdForHash(hash);
    const box = fitImageBox(await readImageSize(file));
    const asset: AssetMetadata = { id: assetId, hash, mimeType: file.type || "image/png", byteLength: bytes.byteLength, name: file.name };
    const node = makeImageNode(page.id, assetId, box, file.name);
    await execute([
      { type: "asset.upsert", payload: { asset } },
      { type: "node.create", payload: { node } },
    ]);
    // 同一张图可能正好补上了导入项目里缺失的资源，顺手把清单刷新掉。
    await refreshMissingAssets(project.snapshot());
    setSelectedIds([node.id]);
    setMessage(`已插入图片「${file.name}」· ${box.width}×${box.height}`);
  });
  /**
   * 重新关联缺失的图片资源。
   *
   * 只补字节，不动文档：元数据早就在文档里，补上文件之后画布和导出立刻恢复。
   * 必须校验内容哈希，否则"重新关联"就变成了偷偷换图。
   */
  const startRelink = (asset: AssetMetadata) => { relinkTarget.current = asset; relinkInput.current?.click(); };
  const relinkAssetFile = (file: File) => void run(async () => {
    const asset = relinkTarget.current;
    relinkTarget.current = undefined;
    if (!asset) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.byteLength) { setMessage("文件内容为空"); return; }
    const hash = await sha256Hex(bytes);
    const error = relinkError(asset, hash);
    if (error) { setMessage(error); return; }
    await repository.putAsset(document.id, { hash, bytes });
    forgetAssetUrl(document.id, hash);
    const missing = await refreshMissingAssets(document);
    const restored = collectAssetUsage(document).find(entry => entry.asset.id === asset.id)?.nodeIds.length ?? 0;
    setMessage(`${relinkSuccessMessage(asset, restored)}${missing.length ? `；仍有 ${missing.length} 个资源缺失` : ""}`);
  });
  /** 清理没有被任何图片节点引用的资源元数据。 */
  const deleteAsset = (asset: AssetMetadata) => void run(async () => {
    if (!await askConfirm({ title: "清理图片资源", description: `「${assetLabel(asset)}」没有被任何图片节点引用。清理后这份文件不能从历史版本里找回。`, confirmLabel: "清理", destructive: true })) return;
    await execute([{ type: "asset.delete", payload: { id: asset.id } }]);
    // 同一份字节可能被多条资源记录共享，确认没人再用这个哈希才回收字节。
    const stillShared = Object.values(project.snapshot().assets).some(entry => entry.hash === asset.hash);
    if (!stillShared && repository.deleteAsset) await repository.deleteAsset(document.id, asset.hash);
    await refreshMissingAssets(project.snapshot());
    setMessage(`资源「${assetLabel(asset)}」已清理`);
  });
  const switchPage = (id: string) => { setCurrentPageId(id); setSelectedIds([]); setPreview(undefined); };
  const createPage = () => void run(async () => {
    const name = (await askText({ title: "页面名称", defaultValue: `页面 ${document.pageOrder.length + 1}` }))?.trim(); if (!name) return;
    const id = `page:${crypto.randomUUID()}`;
    await execute([{ type: "page.create", payload: { page: { id, name, childIds: [] } } }]);
    switchPage(id);
  });
  const renamePage = () => void run(async () => {
    const name = (await askText({ title: "页面名称", defaultValue: page.name }))?.trim(); if (!name || name === page.name) return;
    await execute([{ type: "page.rename", payload: { id: page.id, name } }]);
  });
  const deletePage = () => void run(async () => {
    if (document.pageOrder.length === 1 || page.childIds.length) return;
    const nextPageId = document.pageOrder.find(id => id !== page.id)!;
    await execute([{ type: "page.delete", payload: { id: page.id } }]);
    switchPage(nextPageId);
  });
  const patchNode = (id: string, patchValue: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "bindings">>) => void run(() => execute([{ type: "node.patch", payload: { id, patch: patchValue } }]));
  const patchLayouts = (changes: Array<{ id: string; layout: DesignNode["layout"] }>) => changes.length && void run(() => execute(changes.map(change => ({ type: "node.patch", payload: { id: change.id, patch: { layout: change.layout } } }))));
  const patch = (patchValue: Partial<Pick<DesignNode, "name" | "layout" | "appearance">>) => selected && patchNode(selected.id, patchValue);
  const patchTextOf = (id: string, patchValue: TextPatch) => void run(() => execute([{ type: "text.patch", payload: { id, patch: patchValue } }]));
  const patchText = (patchValue: TextPatch) => selected?.type === "text" && patchTextOf(selected.id, patchValue);
  // 图片的 fit 单独走 image.patch，和文字一样不扩张通用节点 patch。
  const patchImageOf = (id: string, patchValue: { fit?: ImageNode["fit"] }) => void run(() => execute([{ type: "image.patch", payload: { id, patch: patchValue } }]));
  // 批量改动：每个节点用自己原有的外观/布局合并后再发一条 patch，避免整块替换丢掉别的字段。
  const patchBatchAppearance = (changes: BatchAppearanceChanges) => {
    const patches = planAppearancePatches(selectedNodes, changes);
    if (!patches.length) return;
    void run(() => execute(patches.map(patch => ({ type: "node.patch", payload: { id: patch.id, patch: { appearance: patch.appearance, ...(patch.bindings ? { bindings: patch.bindings } : {}) } } }))));
  };
  const patchBatchLayout = (changes: BatchLayoutChanges) => {
    const patches = planLayoutPatches(selectedNodes, changes);
    if (!patches.length) return;
    void run(() => execute(patches.map(patch => ({ type: "node.patch", payload: { id: patch.id, patch: { layout: patch.layout } } }))));
  };
  // 批量文字样式：只作用于选中的文本节点，逐条走 text.patch。
  const patchBatchText = (changes: BatchTextChanges) => {
    const patches = planTextPatches(selectedNodes, changes);
    if (!patches.length) return;
    void run(() => execute(patches.map(patch => ({ type: "text.patch", payload: { id: patch.id, patch: patch.patch } }))));
  };
  // 导出文件名和状态文案带上范围，避免"导出的到底是哪一块"说不清。
  const exportFilename = exportTarget.nodeIds ? `${safeFilename(document.meta.name)}-选区` : safeFilename(document.meta.name);
  const exportScopeLabel = exportTarget.nodeIds ? "（选区）" : "（整页）";
  const exportHtml = () => void run(async () => {
    // 带资源的导出：图片节点在 HTML 里要落成 data URL，否则只会剩一个空框。
    const result = await project.exportHtmlWithAssets({ pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds });
    downloadFile(`${exportFilename}.html`, result.document, "text/html");
    setMessage(`HTML 已导出${exportScopeLabel} · ${result.diagnostics.length} 条诊断`);
  });
  const exportSvg = () => void run(async () => {
    const result = await project.exportSvgWithAssets({ pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds });
    downloadFile(`${exportFilename}.svg`, result.svg, "image/svg+xml");
    setMessage(`SVG 已导出${exportScopeLabel} · ${result.diagnostics.length} 条诊断`);
  });
  const exportPng = () => void run(async () => {
    const snapshot = project.snapshot();
    // 图片写成 data URL 之后画布不会被外部资源污染，PNG 才能读回像素。
    const resolveAsset = await createAssetResolver(repository, snapshot, page.id, exportTarget.nodeIds);
    const result = await exportPageToPng(snapshot, { pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, scale: 2, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds, resolveAsset });
    downloadDataUrl(`${exportFilename}.png`, result.dataUrl);
    setMessage(`PNG 已导出${exportScopeLabel} · ${result.width}×${result.height}`);
  });
  const exportJson = () => { downloadFile(`${safeFilename(document.meta.name)}.design.json`, JSON.stringify(document, null, 2), "application/json"); setMessage("项目 JSON 已导出"); };
  const importJson = (file: File) => void run(async () => {
    const raw = JSON.parse(await file.text());
    const existing = await repository.listProjects();
    const probe = prepareImportedDocument(raw);
    // 冲突按导入文件**原本的 id** 判定：copy 模式下的新 id 谁也不匹配；
    // 名字比较用导入后会落到的名字，否则会漏掉"上次导入的副本也叫这个名字"。
    const conflict = detectImportConflict({ id: probe.sourceId, name: probe.document.meta.name }, existing);
    let prepared = probe;
    if (conflict?.kind === "id") {
      // 同一个项目 id：要么覆盖它，要么另存一份，由用户决定。
      const choice = await askChoice({
        title: "已存在同一个项目",
        description: `本地已有项目「${conflict.projectName}」，导入的文件是它的另一个版本。要覆盖原项目，还是作为新项目导入？`,
        options: [
          { value: "replace", label: "覆盖原项目", destructive: true },
          { value: "copy", label: "作为新项目导入" },
        ],
      });
      if (choice === null) { setMessage("已取消导入"); return; }
      prepared = choice === "replace"
        ? prepareImportedDocument(raw, { mode: "replace", id: conflict.projectId })
        : prepareImportedDocument(raw, { mode: "copy" });
    } else if (conflict?.kind === "name") {
      // 只是重名：内容是另一个项目，导入安全，但要让用户确认改后的名字。
      const name = conflict.suggestedName ?? probe.document.meta.name;
      const choice = await askChoice({
        title: "项目名称已被占用",
        description: `本地已有项目「${conflict.projectName}」。导入的文件会以「${name}」存成一个新项目，原有项目不受影响。`,
        options: [{ value: "rename", label: `以「${name}」导入` }],
      });
      if (choice === null) { setMessage("已取消导入"); return; }
      prepared = prepareImportedDocument(raw, { mode: "copy", name });
    }
    if (prepared.mode === "replace") await repository.replaceProject(prepared.document.id, prepared.document);
    else await repository.saveSnapshot(prepared.document);
    await openProject(prepared.document.id); setProjects(await repository.listProjects());
    const upgrade = prepared.migratedFrom !== undefined ? `；已从格式版本 ${prepared.migratedFrom} 升级到当前版本` : "";
    const mode = prepared.mode === "replace" ? "（已覆盖原项目）" : "（作为新项目）";
    // 文档里带着资源元数据，字节却不会跟着 JSON 走，所以导入后要逐份核对。
    const missing = await findMissingAssets(repository, prepared.document);
    setMessage(`项目已导入${mode}${upgrade}${missingAssetNotice(missing)}`);
  });
  const saveAiSettings = (next: AiSettings) => {
    writeAiSettings(next);
    setAiSettings(next);
    setMessage(aiSettingsComplete(next) ? `AI 模型已保存：${next.model} @ ${next.baseUrl}` : "AI 设置已保存；未启用真实模型，继续使用演示规划器");
  };
  const resetAiSettings = () => {
    clearAiSettings();
    setAiSettings({ ...DEFAULT_AI_SETTINGS });
    setMessage("AI 模型设置已清除，已回退到演示规划器");
  };
  const createColorToken = () => void run(async () => {
    const name = (await askText({ title: "Token 名称", defaultValue: "color.primary" }))?.trim(); if (!name) return;
    const value = (await askText({ title: "颜色值", defaultValue: "#6366f1", validate: validateColor }))?.trim(); if (!value) return;
    await execute([{ type: "token.upsert", payload: { name, token: { type: "color", value } } }]);
  });
  const updateColorToken = (name: string, currentValue: unknown) => void run(async () => {
    const value = (await askText({ title: "颜色值", defaultValue: String(currentValue), validate: validateColor }))?.trim(); if (!value || value === currentValue) return;
    await execute([{ type: "token.upsert", payload: { name, token: { type: "color", value } } }]);
  });
  const unbindFill = () => {
    if (!selected) return;
    const remaining = { ...selected.bindings };
    delete remaining.fill;
    patchNode(selected.id, { bindings: Object.keys(remaining).length ? remaining : undefined });
  };
  const copySelection = () => {
    if (!selectedIds.length) return;
    clipboard.current = copyNodeTrees(document, selectedIds);
    setMessage(`已复制 ${clipboard.current.roots.length} 个图层树`);
  };
  const pasteSelection = () => {
    if (!clipboard.current) return;
    const pasted = pasteNodeTrees(clipboard.current, page.id);
    void run(async () => { await execute(pasted.commands); setSelectedIds(pasted.rootIds); });
  };
  const duplicateSelection = () => {
    if (!selectedIds.length) return;
    const pasted = pasteNodeTrees(copyNodeTrees(document, selectedIds), page.id);
    void run(async () => { await execute(pasted.commands); setSelectedIds(pasted.rootIds); });
  };
  const deleteSelection = () => {
    if (!selectedIds.length) return;
    const roots = copyNodeTrees(document, selectedIds).roots;
    void run(async () => { await execute(roots.map(id => ({ type: "node.delete", payload: { id } }))); setSelectedIds([]); });
  };
  const selectAll = () => {
    const ids = selectAllIds(document, page.id);
    setSelectedIds(ids);
    setMessage(`已选中 ${ids.length} 个对象`);
  };
  // 「适应内容」框住真正有内容的区域，而不是整块 960x680 的画布。
  const fitCanvas = () => {
    if (!scroller) return;
    const bounds = contentBounds(canvasLayout.boxes);
    if (!bounds) { setZoom(1); return; }
    const viewport = {
      width: Math.max(1, scroller.clientWidth - CANVAS_PADDING * 2),
      height: Math.max(1, scroller.clientHeight - CANVAS_PADDING * 2),
    };
    setZoom(fitZoom(bounds, viewport, 8));
  };
  // 抓手：拖动改变的是视口滚动位置，不是文档，也不涨 revision。
  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panMode && event.button !== 1) return;
    event.preventDefault();
    panPointer.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panPointer.current;
    if (!pan || pan.pointerId !== event.pointerId || !scroller) return;
    const next = panScroll({ scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop }, event.clientX - pan.x, event.clientY - pan.y);
    pan.x = event.clientX; pan.y = event.clientY;
    scroller.scrollLeft = clampScroll(next.scrollLeft, scroller.scrollWidth - scroller.clientWidth);
    scroller.scrollTop = clampScroll(next.scrollTop, scroller.scrollHeight - scroller.clientHeight);
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panPointer.current?.pointerId !== event.pointerId) return;
    panPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPanning(false);
  };
  const selectedOwner = selected ? document.nodes[selected.parentId] ?? document.pages[selected.parentId] : undefined;
  const selectedLayerIndex = selectedIds.length === 1 ? selectedOwner?.childIds.indexOf(selectedIds[0]!) ?? -1 : -1;
  const reorderLayer = (targetIndex: number) => {
    if (selectedLayerIndex < 0 || targetIndex === selectedLayerIndex) return;
    const id = selectedIds[0]!;
    void run(() => execute([{ type: "node.reparent", payload: { id, parentId: selected!.parentId, index: targetIndex } }]));
  };
  const arrangeSelection = (arrangement: Arrangement) => { if (!selectionLocked && selectionSameParent) patchLayouts(arrangeNodes(selectedNodes, arrangement)); };
  // 右键命中节点时沿用 Excalidraw 的行为：未选中的节点被选中，已在选区内的则保留原多选。
  const handleCanvasContextMenu = (event: React.MouseEvent) => {
    const nodeId = resolveContextNodeId(event.target);
    if (!nodeId) { setContextIds([]); return; }
    if (selectedIds.includes(nodeId)) { setContextIds(selectedIds); return; }
    setSelectedIds([nodeId]);
    setContextIds([nodeId]);
  };
  const reorderFromTree = (draggedId: string, targetId: string, position: DropPosition) => {
    const plan = planReparent(document, draggedId, targetId, position);
    if (!plan) { setMessage("该位置无法放置此图层"); return; }
    void run(async () => { await execute([{ type: "node.reparent", payload: { id: draggedId, parentId: plan.parentId, index: plan.index } }]); setSelectedIds([draggedId]); });
  };
  const createComponentFromSelection = (name: string) => void run(async () => {
    if (!selected || selectedIds.length !== 1) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const componentId = `component:${crypto.randomUUID().slice(0, 8)}`;
    await execute([{ type: "component.create", payload: { id: componentId, nodeId: selected.id, name: trimmed } }]);
    setComponentName("");
    setMessage(`组件「${trimmed}」已创建`);
  });
  const instantiateComponent = (componentId: string) => void run(async () => {
    const definition = document.components[componentId];
    if (!definition) return;
    const root = document.nodes[definition.rootNodeId];
    const instanceId = `instance:${crypto.randomUUID().slice(0, 8)}`;
    // The instance takes the size of the component root so it renders like the original.
    const node = makeInstanceNode(componentId, page.id, {
      id: instanceId,
      name: definition.name,
      x: root?.layout.x ?? 96,
      y: root?.layout.y ?? 96,
      width: root?.layout.width ?? 200,
      height: root?.layout.height ?? 120,
    });
    await execute([{ type: "component.instantiate", payload: { node } }]);
    setSelectedIds([instanceId]);
    setMessage(`已实例化「${definition.name}」`);
  });
  const removeComponent = (componentId: string) => void run(async () => {
    const definition = document.components[componentId];
    if (!definition) return;
    await execute([{ type: "component.remove", payload: { id: componentId } }]);
    setMessage(`组件「${definition.name}」已删除`);
  });
  nudgeAction.current = (dx, dy) => {
    if (!busy && selectedNodes.length && !selectionLocked) patchLayouts(nudgeNodes(selectedNodes, dx, dy));
  };
  keyboardAction.current = action => {
    if (busy) return;
    if (action === "copy") copySelection();
    else if (action === "paste") pasteSelection();
    else if (action === "duplicate") duplicateSelection();
    else if (action === "layerUp") reorderLayer(Math.min((selectedOwner?.childIds.length ?? 1) - 1, selectedLayerIndex + 1));
    else if (action === "layerDown") reorderLayer(Math.max(0, selectedLayerIndex - 1));
    else if (action === "selectAll") selectAll();
    else deleteSelection();
  };
  const previewStale = preview?.baseRevision !== document.revision;
  const componentSummaries = listComponents(document);
  const versionRows = snapshotRows(snapshots);

  return <div className={`studio${leftPanelOpen ? "" : " left-collapsed"}${rightPanelOpen ? "" : " right-collapsed"}`}>
    <header><strong>AI Design Studio</strong><select className="project-select" disabled={busy} value={document.id} onChange={event => void run(() => openProject(event.target.value))}>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select><Tooltip label={leftPanelOpen ? "收起图层面板" : "展开图层面板"}><button className="icon-only" aria-label="图层面板" onClick={() => setLeftPanelOpen(open => !open)}><Icon name="panelLeft" /></button></Tooltip><Tooltip label={rightPanelOpen ? "收起属性面板" : "展开属性面板"}><button className="icon-only" aria-label="属性面板" onClick={() => setRightPanelOpen(open => !open)}><Icon name="panelRight" /></button></Tooltip><button disabled={busy} onClick={createProject}><Icon name="newProject" />新建</button><button disabled={busy} onClick={renameProject}><Icon name="rename" />重命名</button><Tooltip label="撤销 · Ctrl/Cmd+Z"><button disabled={busy || !project.canUndo()} onClick={() => void run(() => applyHistory("undo"))}><Icon name="undo" />撤销</button></Tooltip><Tooltip label="重做 · Shift+Ctrl/Cmd+Z"><button disabled={busy || !project.canRedo()} onClick={() => void run(() => applyHistory("redo"))}><Icon name="redo" />重做</button></Tooltip><select className="export-scope" disabled={busy} value={exportScope} title="导出范围" onChange={event => setExportScope(event.target.value as "page" | "selection")}><option value="page">导出：整页</option><option value="selection" disabled={!selectedIds.length}>导出：选区</option></select><button disabled={busy} onClick={exportHtml}><Icon name="exportHtml" />HTML</button><button disabled={busy} onClick={exportSvg}><Icon name="exportSvg" />SVG</button><button disabled={busy} onClick={exportPng}><Icon name="exportPng" />PNG</button><button disabled={busy} onClick={exportJson}><Icon name="exportJson" />JSON</button><button disabled={busy} onClick={() => importInput.current?.click()}><Icon name="import" />导入</button><input ref={importInput} className="hidden-input" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) importJson(file); event.target.value = ""; }} /><button disabled={busy} className="header-danger" onClick={deleteCurrentProject}><Icon name="trash" />删除项目</button><span className={`autosave-status autosave-${autosave.state}`} title={autosaveTitle(autosave)}>{autosaveLabel(autosave)}</span><span className="status">{message}</span></header>
    <aside className="layers"><div className="section-heading"><h2>页面</h2><button disabled={busy} onClick={createPage}><Icon name="pageAdd" />新增</button></div><select className="project-select" style={{ width: "100%", minWidth: 0, marginBottom: 8 }} disabled={busy} value={page.id} onChange={event => switchPage(event.target.value)}>{document.pageOrder.map(id => <option key={id} value={id}>{document.pages[id]?.name}</option>)}</select><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 20 }}><button disabled={busy} onClick={renamePage}><Icon name="rename" />重命名</button><Tooltip label={page.childIds.length ? "请先清空页面" : "删除当前页面"}><button disabled={busy || document.pageOrder.length === 1 || page.childIds.length > 0} onClick={deletePage}><Icon name="pageDelete" />删除</button></Tooltip></div><div className="section-heading"><h2>图层</h2><Tooltip label="全选页面顶层对象 · Ctrl/Cmd+A"><button disabled={busy || !page.childIds.length} onClick={selectAll}><Icon name="selectAll" />全选</button></Tooltip></div><div className="tools"><button disabled={busy} onClick={() => addNode("frame")}><Icon name="addFrame" />Frame</button><button disabled={busy} onClick={() => addNode("rectangle")}><Icon name="addRectangle" />矩形</button><button disabled={busy} onClick={() => addNode("ellipse")}><Icon name="addEllipse" />椭圆</button><button disabled={busy} onClick={() => addNode("text")}><Icon name="addText" />文本</button><button disabled={busy} onClick={() => imageInput.current?.click()}><Icon name="nodeImage" />图片</button></div><input ref={imageInput} className="hidden-input" type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) insertImage(file); }} /><div className="layer-actions" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 8 }}><Tooltip label="复制 · Ctrl/Cmd+C"><button disabled={busy || !selectedIds.length} onClick={copySelection}><Icon name="copy" />复制</button></Tooltip><Tooltip label="粘贴 · Ctrl/Cmd+V"><button disabled={busy || !clipboard.current} onClick={pasteSelection}><Icon name="paste" />粘贴</button></Tooltip><Tooltip label="重复 · Ctrl/Cmd+D"><button disabled={busy || !selectedIds.length} onClick={duplicateSelection}><Icon name="duplicate" />重复</button></Tooltip></div><div className="icon-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginBottom: 12 }}><Tooltip label="置底"><button className="icon-only" disabled={busy || selectedLayerIndex <= 0} aria-label="置底" onClick={() => reorderLayer(0)}><Icon name="toBack" /></button></Tooltip><Tooltip label="下移 · Ctrl/Cmd+["><button className="icon-only" disabled={busy || selectedLayerIndex <= 0} aria-label="下移" onClick={() => reorderLayer(selectedLayerIndex - 1)}><Icon name="moveDown" /></button></Tooltip><Tooltip label="上移 · Ctrl/Cmd+]"><button className="icon-only" disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= (selectedOwner?.childIds.length ?? 0) - 1} aria-label="上移" onClick={() => reorderLayer(selectedLayerIndex + 1)}><Icon name="moveUp" /></button></Tooltip><Tooltip label="置顶"><button className="icon-only" disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= (selectedOwner?.childIds.length ?? 0) - 1} aria-label="置顶" onClick={() => reorderLayer((selectedOwner?.childIds.length ?? 1) - 1)}><Icon name="toFront" /></button></Tooltip></div><LayerTree document={document} rootIds={page.childIds} selectedIds={selectedIds} onSelect={(nodeId, event) => setSelectedIds(current => event.shiftKey ? toggleId(current, nodeId) : [nodeId])} onReorder={reorderFromTree} /></aside>    <section className="workspace"><div className={`canvas-scroller${panMode ? " pan-mode" : ""}${panning ? " panning" : ""}`} ref={setScroller} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}><ContextMenuRoot><ContextMenuTrigger onContextMenu={handleCanvasContextMenu}><div ref={setCanvas} className={`canvas${panMode ? " pan-mode" : ""}`} style={{ zoom }} onClick={event => event.target === event.currentTarget && setSelectedIds([])}>{page.childIds.map(id => <CanvasNode key={id} projectId={document.id} document={document} node={document.nodes[id]!} selectedIds={selectedIds} layout={canvasLayout} onSelect={(id, event) => setSelectedIds(current => event.shiftKey ? toggleId(current, id) : [id])} onCommitText={(nodeId, text) => patchTextOf(nodeId, { text })} />)}<Suspense fallback={null}><CanvasInteractionLayer canvas={canvas} nodes={pageNodes} selectedIds={selectedRootIds} disabled={busy || selectionLocked} onSelect={setSelectedIds} onCommit={patchLayouts} /></Suspense></div></ContextMenuTrigger><ContextMenuContent>{contextIds.length ? <><ContextMenuItem icon="copy" shortcut="Ctrl/Cmd+C" disabled={busy} onSelect={copySelection}>复制</ContextMenuItem><ContextMenuItem icon="paste" shortcut="Ctrl/Cmd+V" disabled={busy || !clipboard.current} onSelect={pasteSelection}>粘贴</ContextMenuItem><ContextMenuItem icon="duplicate" shortcut="Ctrl/Cmd+D" disabled={busy} onSelect={duplicateSelection}>重复</ContextMenuItem><ContextMenuSeparator /><ContextMenuItem icon="trash" shortcut="Delete" danger disabled={busy} onSelect={deleteSelection}>删除</ContextMenuItem><ContextMenuSeparator />{contextIds.length === 1 && <ContextMenuSub label="图层顺序" icon="layerOrder"><ContextMenuItem icon="toFront" disabled={busy} onSelect={() => reorderLayer((selectedOwner?.childIds.length ?? 1) - 1)}>置顶</ContextMenuItem><ContextMenuItem icon="toBack" disabled={busy} onSelect={() => reorderLayer(0)}>置底</ContextMenuItem><ContextMenuItem icon="moveUp" disabled={busy} onSelect={() => reorderLayer(selectedLayerIndex + 1)}>上移</ContextMenuItem><ContextMenuItem icon="moveDown" disabled={busy} onSelect={() => reorderLayer(selectedLayerIndex - 1)}>下移</ContextMenuItem></ContextMenuSub>}{contextIds.length > 1 && <ContextMenuSub label="对齐" icon="alignGroup"><ContextMenuItem icon="alignLeft" disabled={busy} onSelect={() => arrangeSelection("left")}>左对齐</ContextMenuItem><ContextMenuItem icon="alignCenterX" disabled={busy} onSelect={() => arrangeSelection("centerX")}>水平居中</ContextMenuItem><ContextMenuItem icon="alignRight" disabled={busy} onSelect={() => arrangeSelection("right")}>右对齐</ContextMenuItem><ContextMenuItem icon="alignTop" disabled={busy} onSelect={() => arrangeSelection("top")}>顶对齐</ContextMenuItem><ContextMenuItem icon="alignCenterY" disabled={busy} onSelect={() => arrangeSelection("centerY")}>垂直居中</ContextMenuItem><ContextMenuItem icon="alignBottom" disabled={busy} onSelect={() => arrangeSelection("bottom")}>底对齐</ContextMenuItem></ContextMenuSub>}{contextIds.length === 1 && <ContextMenuItem icon={selected?.locked ? "unlock" : "lock"} disabled={busy} onSelect={() => { if (selected) patchNode(selected.id, { locked: !selected.locked }); }}>{selected?.locked ? "解锁" : "锁定"}</ContextMenuItem>}</> : <><ContextMenuItem icon="paste" shortcut="Ctrl/Cmd+V" disabled={busy || !clipboard.current} onSelect={pasteSelection}>粘贴</ContextMenuItem><ContextMenuSeparator /><ContextMenuSub label="添加" icon="addFrame"><ContextMenuItem icon="addFrame" disabled={busy} onSelect={() => addNode("frame")}>Frame</ContextMenuItem><ContextMenuItem icon="addRectangle" disabled={busy} onSelect={() => addNode("rectangle")}>矩形</ContextMenuItem><ContextMenuItem icon="addEllipse" disabled={busy} onSelect={() => addNode("ellipse")}>椭圆</ContextMenuItem><ContextMenuItem icon="addText" disabled={busy} onSelect={() => addNode("text")}>文本</ContextMenuItem></ContextMenuSub></>}</ContextMenuContent></ContextMenuRoot></div><div className="canvas-controls"><Tooltip label={panMode ? "退出抓手" : "抓手拖动画布"}><button className={`icon-only${panMode ? " active" : ""}`} aria-label="抓手" aria-pressed={panMode} onClick={() => setPanMode(on => !on)}><Icon name="pan" /></button></Tooltip><Tooltip label="缩小"><button className="icon-only" aria-label="缩小" onClick={() => setZoom(current => zoomStep(current, -1))}><Icon name="zoomOut" /></button></Tooltip><Tooltip label="重置为 100%"><button className="zoom-value" onClick={() => setZoom(1)}>{zoomPercent(zoom)}%</button></Tooltip><Tooltip label="放大"><button className="icon-only" aria-label="放大" onClick={() => setZoom(current => zoomStep(current, 1))}><Icon name="zoomIn" /></button></Tooltip><Tooltip label="适应内容"><button className="icon-only zoom-fit" aria-label="适应内容" onClick={fitCanvas}><Icon name="zoomFit" /></button></Tooltip></div></section>
    <aside className="inspector"><h2>属性{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length}` : ""}</h2>{selectedIds.length > 1 && <><h2>对齐与分布</h2><div className="icon-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, marginBottom: 12 }}><Tooltip label="左对齐"><button className="icon-only" disabled={busy} aria-label="左对齐" onClick={() => arrangeSelection("left")}><Icon name="alignLeft" /></button></Tooltip><Tooltip label="水平居中"><button className="icon-only" disabled={busy} aria-label="水平居中" onClick={() => arrangeSelection("centerX")}><Icon name="alignCenterX" /></button></Tooltip><Tooltip label="右对齐"><button className="icon-only" disabled={busy} aria-label="右对齐" onClick={() => arrangeSelection("right")}><Icon name="alignRight" /></button></Tooltip><Tooltip label="顶对齐"><button className="icon-only" disabled={busy} aria-label="顶对齐" onClick={() => arrangeSelection("top")}><Icon name="alignTop" /></button></Tooltip><Tooltip label="垂直居中"><button className="icon-only" disabled={busy} aria-label="垂直居中" onClick={() => arrangeSelection("centerY")}><Icon name="alignCenterY" /></button></Tooltip><Tooltip label="底对齐"><button className="icon-only" disabled={busy} aria-label="底对齐" onClick={() => arrangeSelection("bottom")}><Icon name="alignBottom" /></button></Tooltip><Tooltip label="水平分布"><button className="icon-only" disabled={busy || selectedIds.length < 3} aria-label="水平分布" onClick={() => arrangeSelection("distributeX")}><Icon name="distributeX" /></button></Tooltip><Tooltip label="垂直分布"><button className="icon-only" disabled={busy || selectedIds.length < 3} aria-label="垂直分布" onClick={() => arrangeSelection("distributeY")}><Icon name="distributeY" /></button></Tooltip></div></>}{selected && selectedIds.length === 1 ? <>
      <Field label="名称" value={selected.name} onCommit={value => patch({ name: value })} />
      <PropertyPanel node={selected} disabled={busy} onPatch={patch} onPatchText={patchText} onPatchImage={patchValue => patchImageOf(selected.id, patchValue)} />
      <Toggle label="显示" checked={selected.visible} onChange={visible => patchNode(selected.id, { visible })} />
      <Toggle label="锁定" checked={selected.locked} onChange={locked => patchNode(selected.id, { locked })} />
      <button disabled={busy} className="danger" onClick={deleteSelection}><Icon name="trash" />删除{selectedIds.length > 1 ? ` ${selectedIds.length} 个节点` : ""}</button>
    </> : selectedIds.length > 1 ? <><BatchPanel nodes={selectedNodes} disabled={busy} onPatchAppearance={patchBatchAppearance} onPatchLayout={patchBatchLayout} onPatchText={patchBatchText} /><button disabled={busy} className="danger" onClick={deleteSelection}><Icon name="trash" />删除 {selectedIds.length} 个节点</button></> : <p>选择画布中的节点</p>}
    {canvasLayout.warnings.length > 0 && <><h2>布局警告</h2><div className="warning-list">{canvasLayout.warnings.map((warning, index) => <button key={`${warning.nodeId}:${warning.code}:${index}`} className="warning-row" onClick={() => warning.nodeId && setSelectedIds([warning.nodeId])} title={warning.nodeId ? `选中 ${warning.nodeId}` : warning.message}><span className={`warning-code warning-code-${warning.code}`}>{warning.code}</span><span className="warning-message">{warning.message}</span></button>)}</div></>}
    {recovery && <><h2>恢复报告</h2><div className="recovery-report">{recoveryReportRows({ ...recovery, missingAssets }).map(row => <div className="recovery-row" key={row.label}><span className="recovery-label">{row.label}</span><span className={row.tone === "warning" ? "recovery-value recovery-warning" : "recovery-value"}>{row.value}</span></div>)}</div><button disabled={busy} onClick={() => { downloadFile(recoveryReportFileName(recovery.projectName), JSON.stringify({ ...recovery, missingAssets }, null, 2), "application/json"); setMessage("恢复报告已导出"); }}><Icon name="exportJson" />导出报告</button></>}
    <hr/><div className="section-heading"><h2>历史版本</h2></div>
    <div className="snapshot-list">{versionRows.length
      ? versionRows.map(row => <div className="snapshot-row" key={row.revision}><span className="snapshot-label">{row.label}</span><span className="snapshot-time" title={row.updatedAt}>{formatSnapshotTime(row.updatedAt)}</span>{row.schemaVersion < CURRENT_SCHEMA_VERSION && <span className="snapshot-legacy">旧格式</span>}{row.current
        ? <span className="snapshot-current">当前</span>
        : <Tooltip label={`还原到 ${row.label}`}><button className="icon-only" aria-label={`还原到 ${row.label}`} disabled={busy} onClick={() => restoreVersion(row)}><Icon name="versionRestore" /></button></Tooltip>}</div>)
      : <p className="empty-hint">还没有历史版本。改动落盘之后，这里会列出可以回滚到的版本。</p>}</div>
    <hr/><div className="section-heading"><h2>颜色 Tokens</h2><button disabled={busy} onClick={createColorToken}><Icon name="tokenAdd" />新增</button></div>
    <div className="token-list">{Object.entries(document.tokens).map(([name, token]) => <div className="token-row" style={{ gridTemplateColumns: "18px minmax(0,1fr) auto auto auto" }} key={name}><span className="token-swatch" style={{ background: String(token.value) }} /><span title={`${name}: ${String(token.value)}`}>{name}</span>{token.type === "color" && <Tooltip label="修改颜色值"><button className="icon-only" aria-label="修改颜色值" disabled={busy} onClick={() => updateColorToken(name, token.value)}><Icon name="tokenEdit" /></button></Tooltip>}{token.type === "color" && selected && <Tooltip label="绑定为选中节点的填充"><button className="icon-only" aria-label="绑定填充" disabled={busy} onClick={() => patchNode(selected.id, { bindings: { ...selected.bindings, fill: name } })}><Icon name="tokenBind" /></button></Tooltip>}<Tooltip label="删除 Token"><button className="icon-only" aria-label="删除 Token" disabled={busy} onClick={() => void run(() => execute([{ type: "token.delete", payload: { name } }]))}><Icon name="tokenRemove" /></button></Tooltip></div>)}</div>
    {selected?.bindings?.fill && <button className="unbind" disabled={busy} onClick={unbindFill}><Icon name="tokenUnbind" />解绑填充：{selected.bindings.fill}</button>}
    <hr/><div className="section-heading"><h2>图片资源</h2></div>
    <AssetPanel usage={assetUsage} missingIds={missingIds} disabled={busy} onRelink={startRelink} onDelete={deleteAsset} />
    <input ref={relinkInput} className="hidden-input" type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) relinkAssetFile(file); }} />
    <hr/><h2>组件</h2>
    <div className="component-create"><input type="text" placeholder="组件名称" value={componentName} onChange={event => setComponentName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") createComponentFromSelection(componentName); }} /><Tooltip label={selected?.type === "instance" ? "实例不能转为组件" : "将选中节点转为组件"}><button disabled={busy || !componentName.trim() || !selected || selectedIds.length !== 1 || selected.type === "instance"} onClick={() => createComponentFromSelection(componentName)}><Icon name="componentCreate" />创建</button></Tooltip></div>
    <div className="component-list">{componentSummaries.length
      ? componentSummaries.map(component => <div className="component-row" key={component.id}><span className="component-glyph"><Icon name="nodeComponent" size={12} /></span><span className="component-name" title={component.name}>{component.name}</span><span className="component-count">{component.instanceCount}</span><Tooltip label="创建实例"><button className="icon-only" aria-label="创建实例" disabled={busy} onClick={() => instantiateComponent(component.id)}><Icon name="componentInstantiate" /></button></Tooltip><Tooltip label="删除组件"><button className="icon-only" aria-label="删除组件" disabled={busy} onClick={() => removeComponent(component.id)}><Icon name="componentRemove" /></button></Tooltip></div>)
      : <p className="empty-hint">还没有组件。选中一个节点，输入名称后点击「创建」。</p>}</div>
    <hr/><AiSettingsPanel settings={aiSettings} active={aiSettingsComplete(aiSettings)} disabled={busy} onSave={saveAiSettings} onClear={resetAiSettings} />
    <hr/><h2>AI 安全编辑</h2><textarea value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button disabled={busy || !prompt.trim()} onClick={() => editor && void run(async () => { setPreview(await editor.createPlan(prompt, selectedIds)); setMessage("AI 计划已完成 dry-run，等待确认"); })}><Icon name="aiPlan" />生成变更预览</button>
      {preview && <div className={previewStale ? "preview stale" : "preview"}><strong>{preview.summary}</strong><p>影响：{preview.affectedNodeIds.join(", ") || "文档级"}</p><p>警告：{preview.warnings.length}</p>{previewStale && <p>文档已变化，请取消并重新生成计划。</p>}<div className="preview-actions"><button disabled={busy || previewStale} onClick={() => editor && void run(async () => { await editor.confirm(preview.planId); setDocument(project.snapshot()); setPreview(undefined); setMessage("AI 变更已确认"); })}><Icon name="aiConfirm" />确认提交</button><button disabled={busy} onClick={() => { editor?.cancel(preview.planId); setPreview(undefined); }}><Icon name="aiCancel" />取消</button></div></div>}
    </aside>
  </div>;
}

type AssetUrlState = { url?: string; state: "idle" | "loading" | "ready" | "missing" };

/**
 * 把一个图片资源解析成可以直接画的对象 URL。
 *
 * 解析走 {@link loadAssetUrl} 的进程内缓存，所以同一张图被多个节点引用时只读
 * 一次盘；`state` 让画布能区分"还在加载"和"资源确实缺失"，后者要画占位框。
 */
function useAssetUrl(projectId: string, asset: AssetMetadata | undefined): AssetUrlState {
  const [value, setValue] = useState<AssetUrlState>({ state: asset ? "loading" : "idle" });
  const hash = asset?.hash;
  // 资源缺失是会被修复的（用户重新插入同一张图）。缓存版本变了就重新读一次，
  // 否则已经渲染过的节点会一直停在"资源缺失"上。
  const cacheVersion = assetUrlCacheVersion();
  useEffect(() => {
    if (!asset) { setValue({ state: "idle" }); return; }
    let cancelled = false;
    setValue({ state: "loading" });
    void loadAssetUrl(repository, projectId, asset).then(url => {
      if (!cancelled) setValue(url ? { url, state: "ready" } : { state: "missing" });
    });
    return () => { cancelled = true; };
  }, [projectId, hash, cacheVersion]);
  return value;
}

function CanvasNode({ projectId, document, node, selectedIds, layout, onSelect, onCommitText }: { projectId: string; document: DesignDocument; node: DesignNode; selectedIds: string[]; layout: CanvasLayout; onSelect(id: string, event: { shiftKey: boolean }): void; onCommitText(id: string, text: string): void }) {
  const box = resolveBox(layout, node);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.type === "text" ? node.text : "");
  // Guards a single edit session: committing and cancelling both end it, so a
  // late blur event cannot commit the same text twice.
  const editState = useRef<"idle" | "editing" | "done">("idle");
  const asset = node.type === "image" ? document.assets[node.assetId] : undefined;
  const assetUrl = useAssetUrl(projectId, asset);
  const style: React.CSSProperties = {
    display: node.visible ? "flex" : "none",
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
    background: resolveFill(document, node),
    borderRadius: node.type === "ellipse" ? "50%" : node.appearance.cornerRadius,
    opacity: node.appearance.opacity,
  };
  if (node.appearance.stroke) style.border = `1px solid ${node.appearance.stroke}`;
  if (node.type === "image") {
    if (assetUrl.url) {
      style.backgroundImage = `url("${assetUrl.url}")`;
      Object.assign(style, imageBackgroundStyle(node.fit));
    } else {
      // 资源缺失时给出能看懂的占位，而不是一个空白框。
      style.background = "#f1f5f9";
      style.border = "1px dashed #94a3b8";
      style.color = "#64748b";
      style.fontSize = 12;
      style.alignItems = "center";
      style.justifyContent = "center";
    }
  }
  if (node.type === "text") {
    style.fontFamily = node.fontFamily;
    style.fontSize = node.fontSize;
    style.lineHeight = `${node.lineHeight}px`;
    style.fontWeight = node.fontWeight ?? TEXT_DEFAULTS.fontWeight;
    style.fontStyle = node.fontStyle ?? TEXT_DEFAULTS.fontStyle;
    style.letterSpacing = `${node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing}px`;
    style.textAlign = node.textAlign ?? TEXT_DEFAULTS.textAlign;
    style.alignItems = "flex-start";
    style.justifyContent = "flex-start";
    style.whiteSpace = "pre-wrap";
  }
  const startEditing = () => {
    if (node.type !== "text" || node.locked) return;
    editState.current = "editing";
    setDraft(node.text);
    setEditing(true);
  };
  const finishEditing = (commit: boolean) => {
    if (editState.current !== "editing") return;
    editState.current = "done";
    setEditing(false);
    if (!commit || node.type !== "text") return;
    const next = commitText(node.text, draft);
    if (next !== undefined) onCommitText(node.id, next);
  };
  return <div role="button" tabIndex={0} aria-label={node.type === "image" ? node.name : undefined} data-node-id={node.id} className={`${selectedIds.includes(node.id) ? "node selected" : "node"}${node.locked ? " locked" : ""}${node.type === "image" && !assetUrl.url ? " node-image-missing" : ""}`} style={style} onClick={event => { event.stopPropagation(); onSelect(node.id, event); }} onDoubleClick={event => { event.stopPropagation(); startEditing(); }} onKeyDown={event => { if (event.key === "Enter") onSelect(node.id, event); }}>{editing && node.type === "text" ? <textarea className="canvas-text-editor" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => finishEditing(true)} onKeyDown={event => { const action = textEditAction(event.key, event.shiftKey); if (action === "cancel") { event.preventDefault(); event.stopPropagation(); finishEditing(false); } else if (action === "commit") { event.preventDefault(); finishEditing(true); } }} /> : node.type === "image" && assetUrl.url ? null : <span style={{ pointerEvents: "none", ...(node.type === "text" ? { width: "100%" } : {}) }}>{node.type === "text" ? node.text : node.type === "image" ? (assetUrl.state === "loading" ? "载入图片…" : "图片资源缺失") : node.name}</span>}{node.childIds.map(id => <CanvasNode key={id} projectId={projectId} document={document} node={document.nodes[id]!} selectedIds={selectedIds} layout={layout} onSelect={onSelect} onCommitText={onCommitText} />)}</div>;
}

function Field({ label, value, type = "text", onCommit }: { label: string; value: string | number; type?: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label>{label}<input type={type} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => String(value) !== draft && onCommit(draft)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) { return <label>{label}<input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /></label>; }

async function initialize(repository: ProjectRepository) {
  await migrateLegacySnapshot(repository, PROJECT_ID);
  const existing = await repository.listProjects();
  if (existing[0]) return StudioProject.open(repository, existing[0].id);
  return { project: await StudioProject.create(repository, PROJECT_ID, "本地设计", "page:1"), recovery: undefined };
}

/**
 * 把早期 localStorage 里的快照搬进新的仓库存储。
 *
 * 那份数据是格式版本 1 的文档，得先升级再落盘；升级不了就原样留在 localStorage，
 * 用户还能自己把它救回来。
 */
async function migrateLegacySnapshot(repository: ProjectRepository, projectId: string): Promise<void> {
  const key = `studio:${projectId}:document`, serialized = localStorage.getItem(key);
  if (!serialized) return;
  try {
    const migrated = migrateDocument(JSON.parse(serialized));
    await repository.saveSnapshot(migrated.document);
    localStorage.removeItem(key); localStorage.removeItem(`${key}:pending`); localStorage.removeItem(`studio:${projectId}:transactions`);
  } catch { /* Preserve invalid legacy data for manual recovery. */ }
}

function makeNode(type: "frame" | "text" | "rectangle" | "ellipse", parentId: string): DesignNode {
  const id = `${type}:${crypto.randomUUID().slice(0, 8)}`;
  const names = { frame: "Frame", text: "文本", rectangle: "矩形", ellipse: "椭圆" } as const;
  const common = { id, name: names[type], parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x: 48, y: 48, width: type === "text" ? 160 : 240, height: type === "text" ? 48 : 140 }, appearance: { ...defaultAppearance(), fill: type === "text" ? "#ffffff" : "#8b5cf6", cornerRadius: type === "ellipse" ? undefined : 12 } };
  if (type === "text") return { ...common, type: "text", text: "双击编辑文本", fontFamily: "Inter", fontSize: 20, lineHeight: 28 };
  return { ...common, type };
}

function makeImageNode(parentId: string, assetId: string, box: { width: number; height: number }, name: string): ImageNode {
  return {
    id: `image:${crypto.randomUUID().slice(0, 8)}`,
    type: "image",
    name: name || "图片",
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 48, y: 48, width: box.width, height: box.height },
    appearance: { ...defaultAppearance() },
    assetId,
    fit: "cover",
  };
}

const demoPlanner: AiPlanner = { async plan({ document }) { return { summary: "演示规划器：创建一个蓝色卡片（未启用真实模型，需求未被理解）", assumptions: ["使用当前页面"], commands: [{ type: "node.create", payload: { node: { ...makeNode("frame", document.pageOrder[0]!), name: "AI 卡片", layout: { ...defaultLayout(), x: 340, y: 120, width: 280, height: 180 }, appearance: { ...defaultAppearance(), fill: "#2563eb", cornerRadius: 20 } } } }] }; } };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** 自动保存状态在顶栏的一行提示。 */
function autosaveLabel(status: AutosaveStatus): string {
  if (status.state === "error") return status.quotaExceeded ? "自动保存失败：存储空间不足" : "自动保存失败";
  if (status.state === "saving") return "自动保存中…";
  if (status.state === "pending") return "待自动保存";
  if (status.state === "saved" && status.lastSavedAt) return `已自动保存 ${new Date(status.lastSavedAt).toLocaleTimeString()}`;
  return "自动保存就绪";
}

function autosaveTitle(status: AutosaveStatus): string {
  if (status.state === "error") return status.quotaExceeded ? `${status.lastError ?? "存储空间不足"}；请导出 JSON 备份后清理旧项目` : status.lastError ?? "自动保存失败";
  return status.state === "saved" ? `最近一次落盘：${status.lastSavedAt ?? "未知"}` : "文档改动会在停止输入后自动落盘";
}

function toggleId(ids: string[], id: string): string[] { return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]; }

function resolveFill(document: DesignDocument, node: DesignNode): string { const token = node.bindings?.fill ? document.tokens[node.bindings.fill] : undefined; return token?.type === "color" ? String(token.value) : node.appearance.fill ?? "transparent"; }

function validateColor(value: string): string | undefined {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
    ? undefined
    : "请输入 #RGB、#RRGGBB 或 #RRGGBBAA 形式的颜色值";
}
function downloadFile(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }

const container = document.getElementById("root")! as HTMLElement & { __studioRoot?: ReturnType<typeof createRoot> };
const root = container.__studioRoot ?? createRoot(container);
container.__studioRoot = root;
// Vite 的 HMR 会重新执行本模块。若直接再调一次 createRoot，React 会报
// "container already passed to createRoot" 并撕裂 DOM，表现为点击随机失效、拖拽坐标错乱。
// 把 root 挂在容器上复用，HMR 时只是重新 render，永远不会出现两个 React 树。
root.render(<DialogProvider><TooltipProvider><App /></TooltipProvider></DialogProvider>);
