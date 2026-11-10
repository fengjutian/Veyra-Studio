import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import * as Tabs from "@radix-ui/react-tabs";
import { AiCancelledError, PLACEHOLDER_ASSET_URL, SafeAiEditor, createOpenAiCompatiblePlanner, describeProvider, runAutonomousLoop, type AiImagePayload, type AiPlanPreview, type AiPlanner, type AutonomousRound } from "@ufira/ai-orchestrator";
import type { CommandEnvelope, DesignCommand, TransactionEntry } from "@ufira/design-runtime";
import { absolutePath, applyThemeTokens, applyTypographyToken, defaultAppearance, defaultLayout, findTheme, inheritedTokenSource, isTokenOverridden, lintDocument, normalizePath, parseStyleTokens, proposalToToken, supportsBooleanOperand, themeTokenMap, vectorPathCommands, CURRENT_SCHEMA_VERSION, findOwningComponentId, isInsideSubtree, migrateDocument, type AssetMetadata, type ComponentProperty, type ComponentPropertyField, type ComponentPropertyValue, type DesignDocument, type DesignNode, type ImageNode, type TextPatch, type TokenValue, type VectorGeometry } from "@ufira/design-schema";
import { StudioProject, assetDataUrl, collectAssetUsage, collectContrastIssues, createAssetResolver, findMissingAssets, HistoryReconstructionError, installPaperBooleanEngine, prepareFontFaces, reconstructDocumentAt, PACKAGE_DOCUMENT_NAME } from "@ufira/studio-application";
import type { AutosaveStatus, ProjectRepository, ProjectStorageUsage, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { currentAutosaveStatus, flushAutosave, installAutosaveFlush, repository, subscribeAutosave } from "./autosave-store";
import { copyNodeTrees, pasteNodeTrees, type NodeClipboard } from "./node-clipboard";
import { planGroup, planUngroup } from "./grouping";
import { allLocked, deletableRoots, editableNodes } from "./selection-policy";
import { arrangeNodes, nudgeNodes, nudgeReorder, type Arrangement } from "./node-arrangement";
import {
  detectImportConflict,
  planBatchImport,
  prepareImportedDocument,
  readImportSource,
  uniqueProjectName,
  validateBatchNames,
  validateImportName,
  type BatchImportFailure,
  type BatchImportSource,
} from "./project-import";
import { buildRecoveryReport, missingAssetNotice, recoveryReportFileName, recoveryReportRows, type RecoveryReport } from "./recovery-report";
import { formatSnapshotTime, restoreConfirmation, restoreSnapshotEnvelope, snapshotRows, type SnapshotRow } from "./snapshot-history";
import { safeFilename } from "./file-name";
import { LayerTree } from "./layer-tree";
import { planReparent, type DropPosition } from "./layer-reorder";
import { useCanvasLayout } from "./canvas-layout";
import { resetBrowserTextMeasurementCache } from "./browser-text-measurer";
import { registerFontSubsetter } from "./font-subset-client";
import { collectFontFamilies, collectMissingFonts, loadDocumentFonts, prepareFonts } from "./font-loading";
import { CANVAS_HEIGHT, CANVAS_WIDTH, clampZoom, contentBounds, fitZoom, selectionBounds, zoomPercent, zoomStep } from "./canvas-zoom";
import { clampScroll, panScroll } from "./canvas-pan";
import { formatVariant, listComponents, makeInstanceNode, variantOptions } from "./components";
import { currentValuesFromForm, nextValuesFromForm, parseVariantProperties, validateVariantForm, variantCurrentFields, variantNextFields } from "./variant-form";
import { PropertyPanel } from "./property-panel";
import { TokenPanel } from "./token-panel";
import { InstancePanel } from "./instance-panel";
import { newPropertyId } from "./component-props";
import { ComponentPropsPanel } from "./component-props-panel";
import { CanvasSurface } from "./renderer/canvas-surface";
import { PrototypePreview } from "./prototype/preview";
import { buildScene } from "./renderer/scene";
import { hitTest, pointFromEvent, type HitPoint } from "./renderer/hit-test";
import { useCanvasDrag } from "./renderer/use-canvas-drag";
import { usePenTool, type PenCommit } from "./renderer/use-pen-tool";
import { usePathEdit, type PathEditTarget } from "./renderer/use-path-edit";
import { constrainedBoxes } from "./constraint-preview";
import { TOOLS, clampRect, defaultRectFor, isDrawTool, isVectorTool, nextToolAfterDraw, shortcutTool, toolSpec, type DrawToolId, type ToolId, type VectorToolId } from "./tools";
import { buildVectorShape, type VectorShape } from "./shapes";
import { BOOLEAN_OPERATIONS, type BooleanOperation } from "./boolean";
import type { Rect } from "./renderer/selection";
import { TextEditOverlay } from "./renderer/text-edit-overlay";
import { CanvasA11yLayer } from "./renderer/a11y-layer";
import { BatchPanel } from "./batch-panel";
import { planAppearancePatches, planLayoutPatches, planTextPatches, selectAllIds, type BatchAppearanceChanges, type BatchLayoutChanges, type BatchTextChanges } from "./batch-edit";
import { exportPageToPng, downloadDataUrl } from "./png-export";
import { createZip } from "./zip";
import type { ExportDiagnostic } from "@ufira/design-export";
import { exportPageToHtml, exportPageToReact } from "@ufira/design-export";
import { exportDocumentToPdf } from "./pdf-export";
import { ExportDiagnosticsPanel } from "./export-panel";
import type { ExportFormat } from "./export-report";
import { ExportPreviewDialog } from "./export-preview-dialog";
import { fitPreviewSize, previewTitle, svgPreviewDataUrl, type ExportPreview } from "./export-preview";
import { comparePaneTitles, planVersionCompareScope } from "./version-compare";
import { assetIdForHash, fitImageBox, fontFamilyFromFileName, fontFileError, fontMimeFromFileName, imageFileError, readImageSize, sha256Hex } from "./assets";
import { assetLabel, formatBytes, missingAssetIds, relinkError, relinkSuccessMessage } from "./asset-relink";
import { readFontMetadata } from "./font-metadata";
import { AssetPanel } from "./asset-panel";
import { backupRestoreConfirmation, backupStore, shouldWriteBackup, type BackupSummary } from "./backup-store";
import { historyRows, type HistoryRow } from "./history-rows";
import { HistoryPanel } from "./history-panel";
import { readStorageEstimate, storagePercent, type StorageEstimate } from "./storage-estimate";
import { DEFAULT_HISTORY_KEEP, storageUsageOverview, type StorageUsageOverview } from "./storage-usage";
import { StoragePanel } from "./storage-panel";
import { DiskBackupPanel } from "./disk-backup-panel";
import { LintPanel } from "./lint-panel";
import { DiskBackupRunner, type DiskBackupStatus } from "./disk-backup";
import { parentContentOrigin, planCanvasReparent } from "./canvas-reparent";
import { encryptBackupText, supportsBackupEncryption, isEncryptedBackupText, decryptBackupText, BackupDecryptError } from "./backup-crypto";
import { askTypographyValue } from "./typography-form";
import { mergeAssetOrigin } from "./asset-origin";
import {
  backupDirectoryFromHandle,
  clearSavedBackupDirectory,
  ensureDirectoryPermission,
  loadSavedBackupDirectory,
  pickBackupDirectory,
  rememberLastBackupSavedAt,
  saveBackupDirectory,
  supportsDiskBackup,
} from "./disk-backup-browser";
import { inspectorTabs, type InspectorTabId } from "./inspector-tabs";
import { forgetAssetUrl, loadAssetUrl } from "./asset-url";
import { Icon } from "./icons";
import { DialogProvider, useChoice, useConfirm, useForm, usePrompt } from "./ui/dialogs";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuSeparator, ContextMenuSub, ContextMenuTrigger } from "./ui/context-menu";
import { aiSettingsComplete, clearAiSettings, readAiSettings, writeAiSettings, DEFAULT_AI_SETTINGS, type AiSettings } from "./ai-settings";
import { capturePageScreenshot, capturePagesScreenshot, captureSelectionScreenshot } from "./ai-vision";
import { AiSettingsPanel } from "./ai-settings-panel";
import "./styles.css";
import "./workbench.css";
import "./renderer/rich-text-editor.css";

const PROJECT_ID = "studio:local";

function App() {
  const [project, setProject] = useState<StudioProject>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [document, setDocument] = useState<DesignDocument>();
  const [currentPageId, setCurrentPageId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("添加一个蓝色卡片");
  // 「带截图问 AI」：把当前页面渲染成 PNG 一起发给模型。端点不支持看图时自动失效。
  const [aiVision, setAiVision] = useState(false);
  // 截图范围：整页 / 只截选中的节点 / 把所有页拼成一张长图。
  const [aiVisionScope, setAiVisionScope] = useState<"page" | "selection" | "pages">("page");
  const [preview, setPreview] = useState<AiPlanPreview>();
  // AI 生成过程中的取消信号；点「取消生成」只中断请求，不动项目。
  const planAbort = useRef<AbortController | undefined>(undefined);
  const [planning, setPlanning] = useState(false);
  // 自主编排循环的轮次日志与收尾结论。
  const [loopRounds, setLoopRounds] = useState<AutonomousRound[]>([]);
  const [loopSummary, setLoopSummary] = useState<string>();
  const [loopRunning, setLoopRunning] = useState(false);
  // 字体到位后自增，触发一次带真实字体度量的重排。
  const [fontEpoch, setFontEpoch] = useState(0);
  // 流式回复的累计文本，只在生成过程中显示。
  const [streamText, setStreamText] = useState("");
  const [message, setMessage] = useState("正在打开本地项目…");
  const [busy, setBusy] = useState(false);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // 缩放与抓手都是视图状态：不写进文档，也不涨 revision。
  const [zoom, setZoom] = useState(1);
  // 当前画布工具。和缩放一样只是视图状态：切工具不改文档，也不进快照。
  const [tool, setTool] = useState<ToolId>("select");
  const panMode = tool === "hand";
  // 路径编辑态：正在编辑哪个矢量节点的锚点。纯视图状态，不进文档、不涨 revision。
  const [pathEditId, setPathEditId] = useState<string | null>(null);
  const [canvasEditingId, setCanvasEditingId] = useState<string | null>(null);
  // 可视区域（场景坐标）：滚动 + 缩放变化时更新，Canvas 只画相交的根节点。
  const [canvasViewport, setCanvasViewport] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const syncCanvasViewport = useCallback(() => {
    if (!scroller) return;
    setCanvasViewport({
      x: scroller.scrollLeft / zoom,
      y: scroller.scrollTop / zoom,
      width: scroller.clientWidth / zoom,
      height: scroller.clientHeight / zoom,
    });
  }, [scroller, zoom]);
  const [panning, setPanning] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  // 右侧栏当前分段。原来是属性、导出、历史、存储、AI 全塞在一条长滚动列里。
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>("properties");
  // 导出范围：整页，或只导出当前选区。
  const [exportScope, setExportScope] = useState<"page" | "selection">("page");
  const panPointer = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const operationInFlight = useRef(false);
  const clipboard = useRef<NodeClipboard | undefined>(undefined);
  const keyboardAction = useRef<(action: "copy" | "paste" | "duplicate" | "delete" | "layerUp" | "layerDown" | "selectAll" | "group" | "ungroup") => void>(() => undefined);
  const nudgeAction = useRef<(dx: number, dy: number) => void>(() => undefined);
  const importInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const replaceImageInput = useRef<HTMLInputElement>(null);
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
  const askForm = useForm();
  // 自动保存状态：待保存 / 保存中 / 已保存 / 失败（含存储配额耗尽）。
  const autosave = useSyncExternalStore(subscribeAutosave, currentAutosaveStatus);
  // 最近一次打开项目的恢复报告。
  const [recovery, setRecovery] = useState<RecoveryReport>();
  // 存储里保留的历史版本，用于回滚。
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  // 重建基线的版本号：它是事务日志的重放起点，决定了还能退到多早一步。
  const [baselineRevision, setBaselineRevision] = useState<number>();
  // 自动备份列表与浏览器存储用量。
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  // 磁盘备份：是否支持、接上的目录名、最近一次写入状态。
  const [diskBackup, setDiskBackup] = useState<DiskBackupStatus>({ state: "disabled" });
  const [diskBackupDirectory, setDiskBackupDirectory] = useState<string>();
  const diskBackupSupported = useMemo(() => supportsDiskBackup(), []);
  const diskBackupRunner = useRef<DiskBackupRunner | null>(null);
  if (!diskBackupRunner.current) diskBackupRunner.current = new DiskBackupRunner();
  // 磁盘备份的加密状态。密码只留在内存里（ref）：不进 state、不进 localStorage /
  // IndexedDB、不进备份文件——没有服务端就没有找回通道，忘记就是永久丢失。
  const [diskBackupEncrypted, setDiskBackupEncrypted] = useState(false);
  const diskBackupPassword = useRef<string | undefined>(undefined);
  const [storage, setStorage] = useState<StorageEstimate>();
  // 逐项目的存储占用与清理清单。
  const [storageUsage, setStorageUsage] = useState<StorageUsageOverview>();
  // 当前主题：视图状态，不进文档、不涨 revision；切换只影响预览与导出。
  const [activeThemeId, setActiveThemeId] = useState<string>();
  // 主题合并后的文档：画布、对比度、场景都读它。
  const themedDocument = useMemo(() => (document ? applyThemeTokens(document, activeThemeId) : undefined), [document, activeThemeId]);
  const themedTokens = useMemo(() => (document ? themeTokenMap(document, activeThemeId) : {}), [document, activeThemeId]);
  const activeTheme = document ? findTheme(document, activeThemeId) : undefined;
  // 最近一次导出的诊断与格式，面板据此列出可定位的问题。
  const [exportReport, setExportReport] = useState<{ format: ExportFormat; diagnostics: ExportDiagnostic[] }>();
  // 隔离预览：弹窗里渲染导出器真实产物。
  const [exportPreview, setExportPreview] = useState<ExportPreview>();
  // 并排对比的左侧（历史版本）产物。有它时预览弹窗渲染成两栏。
  const [comparePreview, setComparePreview] = useState<{ title: string; preview: ExportPreview }>();
  const [previewOpen, setPreviewOpen] = useState(false);
  // 原型预览：非空时进入全屏预览（Esc 退出）。这是视图状态，不写文档。
  const [prototypeScreenId, setPrototypeScreenId] = useState<string>();
  // 字体：文档声明的上传字体是否真的加载成功，用来做「缺失字体」诊断。
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [fontsReady, setFontsReady] = useState(false);
  const fontInput = useRef<HTMLInputElement>(null);
  // 最新文档快照：字体加载是异步的，回调里不能用渲染时捕获的旧文档。
  const documentRef = useRef<DesignDocument | undefined>(undefined);
  documentRef.current = document;
  // 已提交事务：操作历史面板据此列出每一条可回退的步骤。
  const [transactions, setTransactions] = useState<TransactionEntry[]>([]);
  // 没启用真实模型就退回演示规划器：它只造一张固定卡片，不会理解用户需求。
  // 密钥环交给规划器：鉴权失败时它会自己换下一把，并把新的下标回调上来。
  const planner = useMemo(() => aiSettingsComplete(aiSettings)
    ? createOpenAiCompatiblePlanner({
        baseUrl: aiSettings.baseUrl,
        model: aiSettings.model,
        apiKeys: aiSettings.apiKeys,
        // 环的起点 = 面板上「使用中」的那把；自动换钥后由下面的回调同步回来。
        apiKeyIndex: aiSettings.activeKeyIndex,
        stream: true,
        // 按端点能力决定要不要发 response_format；未收录的端点保守地关掉。
        jsonMode: describeProvider(aiSettings.baseUrl).capabilities.jsonMode,
        onKeyRotated: (index, total, reason) => {
          setAiSettings(current => ({ ...current, activeKeyIndex: index }));
          setMessage(`密钥轮换：${reason}（共 ${total} 把）`);
        },
      })
    : demoPlanner, [aiSettings]);
  // 端点支不支持看图：只有**实测过**能看图的端点才给这个选项。
  // 没验过的端点可能是支持的，但发过去大概率报错——不给用户一个坑。
  const visionSupported = describeProvider(aiSettings.baseUrl).capabilities.vision === true;
  const editor = useMemo(() => project ? new SafeAiEditor(project, planner) : undefined, [project, planner]);

  const applyHistory = async (direction: "undo" | "redo") => {
    if (!project) return;
    const committed = await project[direction]();
    const snapshot = project.snapshot();
    setDocument(snapshot); setSelectedIds(current => current.filter(id => Boolean(snapshot.nodes[id]))); setPreview(undefined); setMessage(`已${direction === "undo" ? "撤销" : "重做"} · r${committed.result.revision}`);
  };

  /**
   * 从「当前选中（或页面第一个根节点）」开始预览。
   *
   * 只有容器型节点能当屏幕：文本/矢量当屏幕没有意义，预览里也点不到东西。
   */
  const startPrototypePreview = () => {
    const SCREEN_TYPES = new Set(["frame", "component", "instance"]);
    const candidate = selected && SCREEN_TYPES.has(selected.type) ? selected.id : document.pages[page.id]?.childIds[0];
    if (!candidate || !document.nodes[candidate]) {
      setMessage("当前页面没有可预览的屏幕：先画一个 Frame 或容器");
      return;
    }
    setPrototypeScreenId(candidate);
  };

  /**
   * 刷新历史版本列表和重建基线。
   *
   * 两者一起决定"还能退到哪一步"：历史版本是可直接回退的快照，重建基线是事务
   * 日志的重放起点——日志里早于最老快照的那些步骤，全靠它起步。
   */
  const refreshHistory = async (projectId: string) => {
    setSnapshots(await repository.listSnapshots(projectId));
    setBaselineRevision((await repository.readBaseline?.(projectId))?.revision);
  };

  useEffect(() => { void initialize(repository).then(async ({ project: value }) => { const snapshot = value.snapshot(); setProject(value); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setProjects(await repository.listProjects()); await refreshHistory(snapshot.id); setMissingAssets(await findMissingAssets(repository, snapshot)); setBackups(await backupStore.list(snapshot.id)); setStorage(await readStorageEstimate()); setStorageUsage(await loadStorageUsage(snapshot.id)); setMessage("就绪"); }).catch(error => setMessage(String(error))); }, []);
  // 恢复上次选的备份目录。这里只能**查**权限：没有用户手势时浏览器不允许申请，
  // 所以权限被收回后要等用户再点一次「立即备份」或重新选择目录。
  useEffect(() => {
    if (!diskBackupSupported) return;
    let cancelled = false;
    void (async () => {
      const saved = await loadSavedBackupDirectory();
      if (!saved || cancelled) return;
      if (!(await ensureDirectoryPermission(saved.handle))) return;
      const runner = diskBackupRunner.current!;
      runner.use(backupDirectoryFromHandle(saved.handle));
      runner.restoreLastSavedAt(saved.lastSavedAt);
      if (cancelled) return;
      setDiskBackupDirectory(saved.handle.name);
      setDiskBackup({ state: "idle", lastSavedAt: saved.lastSavedAt });
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [diskBackupSupported]);
  // 页面被关闭或切到后台时立刻把待写快照落盘，避免最后几次编辑留在内存里。
  useEffect(() => installAutosaveFlush(), []);
  // 历史版本列表和项目摘要：等自动保存真正落盘之后再刷新，否则看到的还是上一版。
  // 顶栏项目下拉里的 revision 和「历史版本」的「当前」必须指向同一份存储状态，
  // 否则撤销后会出现「下拉说 r1、面板说 r2 当前」的自相矛盾。
  const snapshotProjectId = document?.id;
  // 设计检查：纯函数、随文档变化重算；只提示，不写文档也不进事务。
  const lintIssues = useMemo(() => (document ? lintDocument(document, { grid: 8 }) : []), [document]);
  useEffect(() => {
    if (autosave.state !== "saved" || !snapshotProjectId) return;
    let cancelled = false;
    void Promise.all([repository.listSnapshots(snapshotProjectId), repository.listProjects(), repository.readBaseline?.(snapshotProjectId)])
      .then(([list, summary, baseline]) => { if (!cancelled) { setSnapshots(list); setProjects(summary); setBaselineRevision(baseline?.revision); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [autosave.state, autosave.lastSavedAt, snapshotProjectId]);
  // 自动备份：同样等落盘之后再写，但按最小间隔节流，避免轮转表里全是一分钟内的副本。
  useEffect(() => {
    if (autosave.state !== "saved" || !project || !snapshotProjectId) return;
    let cancelled = false;
    void (async () => {
      const existing = await backupStore.list(snapshotProjectId);
      // 两种备份各自节流：IndexedDB 那边跳过了，磁盘这边仍可能该写。
      if (!cancelled && shouldWriteBackup(existing[0], new Date())) {
        await backupStore.write(project.snapshot());
        const next = await backupStore.list(snapshotProjectId);
        if (!cancelled) setBackups(next);
      }
      const runner = diskBackupRunner.current;
      if (!runner?.target || cancelled) return;
      const status = await runner.backup(project.snapshot());
      if (!cancelled) setDiskBackup(status);
      if (status.state === "saved" && status.lastSavedAt) {
        void rememberLastBackupSavedAt(status.lastSavedAt).catch(() => undefined);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [autosave.state, autosave.lastSavedAt, snapshotProjectId, project]);
  // 操作历史：每次落盘后重新读一遍事务日志，回退之后列表也要跟着变。
  useEffect(() => {
    if (!snapshotProjectId) return;
    let cancelled = false;
    void repository.listTransactions(snapshotProjectId).then(entries => { if (!cancelled) setTransactions(entries); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [snapshotProjectId, autosave.lastSavedAt]);
  // 字体异步到达：加载完清掉测量缓存并触发一次重排，避免回退字形的尺寸一直留着。
  const fontFamiliesKey = useMemo(() => document ? collectFontFamilies(document).join("|") : "", [document]);
  const documentFontsKey = useMemo(
    () => document?.fonts?.map(font => [font.family, font.assetId ?? "", font.weight ?? 400, font.style ?? "normal"].join(":")).join("|") ?? "",
    [document],
  );
  useEffect(() => {
    const current = documentRef.current;
    if (!current || !fontFamiliesKey) return;
    let cancelled = false;
    void (async () => {
      // 先注册上传的字体文件，再统一探测可用性：两步都完成，missing 才有意义。
      if (current.fonts?.length) {
        await loadDocumentFonts(current, {
          resolveAssetUrl: async assetId => {
            const asset = current.assets[assetId];
            return asset ? loadAssetUrl(repository, current.id, asset) : undefined;
          },
        });
      }
      const loaded = await prepareFonts(fontFamiliesKey.split("|"));
      if (cancelled) return;
      setAvailableFonts([...loaded].sort());
      setFontsReady(true);
      resetBrowserTextMeasurementCache();
      setFontEpoch(epoch => epoch + 1);
    })();
    return () => { cancelled = true; };
  }, [fontFamiliesKey, documentFontsKey]);
  /** 文本用到、但既没有上传文件也没有装进系统的字体：给用户明确提示，而不是静默换字形。 */
  const missingFonts = useMemo(() => {
    if (!document || !fontsReady) return [];
    return collectMissingFonts(document, availableFonts);
  }, [document, availableFonts, fontsReady]);
  /** 属性面板的字体建议：已加载的族名 + 文档里声明过的族名。 */
  const fontSuggestions = useMemo(() => {
    const families = new Set<string>(availableFonts);
    for (const font of document?.fonts ?? []) families.add(font.family);
    return [...families].sort();
  }, [availableFonts, document]);
  useEffect(() => {
    if (!project) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      const action = modifier && key === "c" ? "copy" : modifier && key === "v" ? "paste" : modifier && key === "d" ? "duplicate" : modifier && key === "a" ? "selectAll" : modifier && key === "]" ? "layerUp" : modifier && key === "[" ? "layerDown" : modifier && key === "g" ? (event.shiftKey ? "ungroup" : "group") : key === "delete" || key === "backspace" ? "delete" : undefined;
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
  // 工具快捷键：V/F/R/O/T/H 切工具，Esc 回到选择（已经是选择工具时清空选区）。
  // 与上面的编辑快捷键分开：工具切换不涉及文档，也不该被 busy 拦住。
  useEffect(() => {
    if (!project) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        // 编辑路径时 Esc 只退出编辑态，不连带清空选中。
        if (pathEditId) setPathEditId(null);
        else if (tool !== "select") setTool("select");
        else setSelectedIds([]);
        return;
      }
      const next = shortcutTool(event.key);
      if (!next) return;
      event.preventDefault();
      setTool(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [project, tool, pathEditId]);
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
  useEffect(() => {
    syncCanvasViewport();
    const onResize = () => syncCanvasViewport();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [syncCanvasViewport]);
  const canvasLayout = useCanvasLayout(document, activePageId ?? "", { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, fontEpoch, activeThemeId);
  const hitTestScene = useMemo(
    () => (themedDocument && activePageId) ? buildScene(themedDocument, activePageId, canvasLayout.boxes) : [],
    [themedDocument, activePageId, canvasLayout.boxes],
  );
  // 路径编辑的目标：命令换成绝对场景坐标，编辑期的一切计算都在这个坐标系里做。
  const pathEditTarget = useMemo<PathEditTarget | undefined>(() => {
    if (!document || !pathEditId) return undefined;
    const node = document.nodes[pathEditId];
    const box = canvasLayout.boxes[pathEditId];
    if (!node || node.type !== "vector" || !node.geometry || !box) return undefined;
    return { id: node.id, commands: absolutePath(vectorPathCommands(node.geometry.d), box), box };
  }, [document, pathEditId, canvasLayout.boxes]);
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
  // 对比度检查只依赖文档颜色，不需要渲染，因此可以随文档变化实时计算。
  const contrastIssues = useMemo(() => themedDocument ? collectContrastIssues(themedDocument) : [], [themedDocument]);
  const missingIds = useMemo(() => missingAssetIds(missingAssets), [missingAssets]);
  const transactionRows = useMemo(() => {
    // 回退的起点：保留的历史版本 + 重建基线。基线让日志里早于最老快照的那些
    // 步骤也能重建，所以它必须一起算进来。
    const baseRevisions = snapshots.map(item => item.revision);
    if (baselineRevision !== undefined) baseRevisions.push(baselineRevision);
    return historyRows(transactions, document?.revision ?? 0, { baseRevisions });
  }, [transactions, document?.revision, snapshots, baselineRevision]);
  // 首次打开项目时把画板缩放到工作区里：1280 宽的屏幕上 960px 画板会被裁掉右侧，
  // 对标市面编辑器的「打开即可看到整页」。只自动执行一次，之后保留用户自己的缩放。
  const initialFitDone = useRef(false);
  useEffect(() => {
    if (initialFitDone.current || !scroller || !document) return;
    initialFitDone.current = true;
    const frame = requestAnimationFrame(() => {
      const viewport = { width: Math.max(1, scroller.clientWidth - 56), height: Math.max(1, scroller.clientHeight - 92) };
      setZoom(fitZoom({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, viewport, 12));
    });
    return () => cancelAnimationFrame(frame);
  }, [scroller, document]);

  // 这个 hook 必须在提前 return 之前调用：加载态渲染的 hook 数量要和项目加载后
  // 完全一致，否则 React 会直接抛「渲染了比上次更多的 hook」，整棵 App 崩掉。
  const canvasDrag = useCanvasDrag({
    busy,
    zoom,
    scene: hitTestScene,
    selectedIds,
    tool,
    pointOf: event => pointFromEvent(canvas?.getBoundingClientRect() ?? { left: 0, top: 0 }, event.clientX, event.clientY, zoom),
    layoutOf: id => document?.nodes[id]?.layout,
    rotationOf: id => document?.nodes[id]?.layout.rotation,
    onCommit: (changes, dropContainerId) => commitCanvasMove(changes, dropContainerId),
    onMarquee: ids => setSelectedIds(ids),
    onDraw: (rect, info) => createNodeFromDraw(info.tool, rect, info),
  });

  // 钢笔独立于拖拽手势：一次路径跨多次点击，草稿留在 hook 里，结束时只提交一条事务。
  const pen = usePenTool({
    active: tool === "pen",
    busy,
    zoom,
    pointOf: event => pointFromEvent(canvas?.getBoundingClientRect() ?? { left: 0, top: 0 }, event.clientX, event.clientY, zoom),
    onCommit: result => commitPenPath(result),
  });

  // 路径编辑只在选中单个矢量节点、且该节点有几何时生效。
  // 缩放父级时，按约束实时推算子节点的新盒子（提交时运行时用同一套公式重算）。
  const constraintPreview = useMemo(() => {
    const id = canvasDrag.resizingId;
    if (!id || !document) return {};
    const from = canvasLayout.boxes[id];
    const to = canvasDrag.previewBoxes[id];
    if (!from || !to) return {};
    return constrainedBoxes(document, canvasLayout.boxes, id, from, to);
  }, [canvasDrag.resizingId, canvasDrag.previewBoxes, canvasLayout.boxes, document]);
  const pathEdit = usePathEdit({
    target: pathEditTarget,
    zoom,
    busy,
    pointOf: event => pointFromEvent(canvas?.getBoundingClientRect() ?? { left: 0, top: 0 }, event.clientX, event.clientY, zoom),
    onCommit: change => commitPathEdit(change),
    onExit: () => setPathEditId(null),
  });

  // 退出编辑态：选中对象换了、或者切了工具。编辑态是视图状态，不能挂在已失效的节点上。
  useEffect(() => {
    if (pathEditId && !selectedIds.includes(pathEditId)) setPathEditId(null);
  }, [pathEditId, selectedIds]);
  useEffect(() => {
    if (pathEditId && tool !== "select") setPathEditId(null);
  }, [pathEditId, tool]);
  // Enter 进入路径编辑（对标 Figma 的 Edit Object）。
  useEffect(() => {
    if (!project || !document) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key !== "Enter" || pathEditId || tool !== "select" || selectedIds.length !== 1) return;
      const node = document.nodes[selectedIds[0]!];
      if (node?.type !== "vector" || !node.geometry) return;
      event.preventDefault();
      setPathEditId(node.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [project, document, pathEditId, tool, selectedIds]);

  if (!project || !document) return <main className="loading">{message}</main>;
  const page = document.pages[activePageId!]!;
  const selected = selectedIds.length ? document.nodes[selectedIds.at(-1)!] : undefined;
  const selectedRootIds = copyNodeTrees(document, selectedIds).roots;
  const selectedNodes = selectedRootIds.map(id => document.nodes[id]!).filter(Boolean);
  const selectionLocked = selectedNodes.some(node => node.locked);
  const selectionSameParent = selectedNodes.every(node => node.parentId === selectedNodes[0]?.parentId);
  // 多选时浮出的对齐工具条。位置把画布坐标换算成 stage 坐标：stage 本身没有被 zoom
  // 缩放，所以按钮始终是屏幕尺寸，只有位置跟着缩放与滚动走。
  const multiSelectionBounds = selectedIds.length > 1 ? selectionBounds(canvasLayout.boxes, selectedIds) : undefined;
  const multiToolbarTop = multiSelectionBounds ? Math.max(4, CANVAS_STAGE_OFFSET_TOP + multiSelectionBounds.y * zoom - 44) : 0;
  const canArrange = !selectionLocked && selectionSameParent;

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
    setDocument(project.snapshot()); setMessage(`已提交 · r${committed.result.revision}`); setPreview(undefined);
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
    await refreshHistory(id);
    setBackups(await backupStore.list(id));
    // 存储占用按项目统计：切项目就得跟着换，否则面板上还挂着上一个项目的数字。
    setStorageUsage(await loadStorageUsage(id));
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
    const snapshot = created.snapshot(); setProject(created); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setProjects(await repository.listProjects()); setSelectedIds([]); setPreview(undefined); setRecovery(undefined); await refreshHistory(snapshot.id); setMessage("项目已创建");
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
    await refreshHistory(document.id);
    setMessage(`已还原到 ${row.label}`);
  });
  /** 重新读一遍浏览器存储用量；估算失败时显示"无法获取"，不阻塞编辑。 */
  const refreshStorage = () => void readStorageEstimate().then(setStorage).catch(() => setStorage(undefined));
  /** 逐项目统计占用并生成清理清单；仓库不支持统计时保持 undefined。 */
  const refreshStorageUsage = () => void loadStorageUsage(document?.id).then(setStorageUsage);
  /** 裁掉某个项目多余的历史版本；当前版本永远保留。 */
  const trimProjectHistory = (projectId: string) => void run(async () => {
    if (!repository.trimSnapshots) return;
    const removed = await repository.trimSnapshots(projectId, DEFAULT_HISTORY_KEEP);
    if (projectId === document?.id) await refreshHistory(projectId);
    await refreshStorageUsage();
    setMessage(removed ? `已裁掉 ${removed} 份旧版本` : "没有可裁掉的历史版本");
  });
  /** 从存储面板删掉一个旧项目；当前项目不走这条路，删除前必须确认。 */
  const deleteStorageProject = (projectId: string) => void run(async () => {
    if (projectId === document?.id) { await deleteCurrentProject(); return; }
    if (!await askConfirm({ title: "删除项目", description: `删除项目“${projectId}”？此操作不可撤销。`, confirmLabel: "删除", destructive: true })) return;
    await repository.deleteProject(projectId);
    await backupStore.deleteProject(projectId);
    setProjects(await repository.listProjects());
    await refreshStorageUsage();
    setMessage("项目已删除");
  });
  const downloadBackup = (row: BackupSummary) => void run(async () => {
    const snapshot = await backupStore.read(document.id, row.createdAt);
    downloadFile(`${safeFilename(snapshot.meta.name)}-备份-r${row.revision}.json`, JSON.stringify(snapshot, null, 2), "application/json");
    setMessage(`备份 r${row.revision} 已下载`);
  });
  /** 选一个本地目录作为磁盘备份目标（需要用户手势，所以只能在点击里调）。 */
  const enableDiskBackup = () => void run(async () => {
    const handle = await pickBackupDirectory();
    if (!handle) return; // 用户取消不是错误。
    if (!(await ensureDirectoryPermission(handle, true))) {
      setMessage("没有拿到该目录的写入权限，备份未启用");
      return;
    }
    const runner = diskBackupRunner.current!;
    runner.use(backupDirectoryFromHandle(handle));
    await saveBackupDirectory(handle);
    setDiskBackupDirectory(handle.name);
    const current = documentRef.current;
    const status = current ? await runner.backup(current, { force: true }) : { state: "idle" as const };
    setDiskBackup(status);
    if (status.state === "saved" && status.lastSavedAt) await rememberLastBackupSavedAt(status.lastSavedAt).catch(() => undefined);
    setMessage(status.state === "saved" ? `磁盘备份已启用：${handle.name}` : `磁盘备份已启用：${handle.name}（下次自动保存时写入）`);
  });
  /** 立刻写一份，不走节流。 */
  const backupToDiskNow = () => void run(async () => {
    const current = documentRef.current;
    const runner = diskBackupRunner.current;
    if (!current || !runner?.target) return;
    const status = await runner.backup(current, { force: true });
    setDiskBackup(status);
    if (status.state === "saved" && status.lastSavedAt) await rememberLastBackupSavedAt(status.lastSavedAt).catch(() => undefined);
    setMessage(status.state === "saved" ? `已备份到 ${diskBackupDirectory}` : `备份失败：${status.error ?? "未知原因"}`);
  });
  /** 断开目录：只删句柄记录，磁盘上已经写出的备份文件不动。 */
  const disableDiskBackup = () => void run(async () => {
    diskBackupRunner.current?.use(undefined);
    await clearSavedBackupDirectory().catch(() => undefined);
    setDiskBackupDirectory(undefined);
    setDiskBackup({ state: "disabled" });
    setMessage("已断开磁盘备份");
  });
  /**
   * 开启磁盘备份加密。
   *
   * 密码只进内存：写盘的每一步都用它派生密钥（PBKDF2），密文里只留 salt 与 IV。
   * 已经写出的明文备份不会被追溯加密——加密只对**之后**的写入生效。
   */
  const enableDiskBackupEncryption = (password: string) => void run(async () => {
    diskBackupPassword.current = password;
    diskBackupRunner.current?.setEncoder({ encode: plain => encryptBackupText(plain, password) });
    setDiskBackupEncrypted(true);
    setMessage("磁盘备份已加密：之后写出的备份是密文");
  });
  /** 关闭加密：新写出的备份恢复明文，已写出的文件不动。 */
  const disableDiskBackupEncryption = () => void run(async () => {
    diskBackupPassword.current = undefined;
    diskBackupRunner.current?.setEncoder(undefined);
    setDiskBackupEncrypted(false);
    setMessage("已关闭磁盘备份加密（新写出的备份恢复明文，已有文件不变）");
  });
  const restoreBackup = (row: BackupSummary) => void run(async () => {
    const confirmation = backupRestoreConfirmation(row);
    if (!await askConfirm({ ...confirmation, confirmLabel: "还原", destructive: true })) return;
    const snapshot = await backupStore.read(document.id, row.createdAt);
    // 和还原历史版本同一条路径：revision 继续往前走，这次还原本身也能撤销。
    await project.execute(restoreSnapshotEnvelope(project.snapshot(), snapshot));
    await flushAutosave();
    const restored = project.snapshot();
    setDocument(restored);
    setSelectedIds(current => current.filter(id => Boolean(restored.nodes[id])));
    setProjects(await repository.listProjects());
    await refreshHistory(document.id);
    setMessage(`已从备份还原到 r${row.revision}`);
  });
  /**
   * 回退到某一次事务之后的状态。
   *
   * 目标版本可能没有快照，所以先按"最近快照 + 重放事务"重建文档，再走
   * `history.restore`——回退本身也是可撤销的一次事务。
   */
  const restoreTransaction = (row: HistoryRow) => void run(async () => {
    const confirmed = await askConfirm({
      title: `回退到 ${row.label}`,
      description: `把项目退回到 ${row.label} 之后的状态（${row.summary}）。之后的改动会作为一次还原记入历史，可以再撤销。`,
      confirmLabel: "回退",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const reconstructed = await reconstructDocumentAt(repository, document.id, row.revision);
      await project.execute(restoreSnapshotEnvelope(project.snapshot(), reconstructed.document));
      await flushAutosave();
      const restored = project.snapshot();
      setDocument(restored);
      setSelectedIds(current => current.filter(id => Boolean(restored.nodes[id])));
      setProjects(await repository.listProjects());
      await refreshHistory(document.id);
      setMessage(`已回退到 ${row.label}（重放 ${reconstructed.replayedTransactions} 条事务）`);
    } catch (error) {
      // 日志被裁剪、起点快照被清理时给出人话，而不是一句内部错误。
      setMessage(error instanceof HistoryReconstructionError ? error.message : errorMessage(error));
    }
  });
  const deleteCurrentProject = () => void run(async () => {
    if (!await askConfirm({ title: "删除项目", description: `删除项目“${document.meta.name}”？此操作不可撤销。`, confirmLabel: "删除", destructive: true })) return;
    await repository.deleteProject(document.id);
    // 备份不随项目删除自动消失，会占着存储且无法再打开，所以一起清掉。
    await backupStore.deleteProject(document.id);
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
   * 用图元工具拖出来的节点。
   *
   * 拖拽超过阈值就按拖出来的范围建，否则按单击建默认尺寸；两者都钳制在画板内，
   * 所以拖到画板外不会生成一半在画布外的对象。提交后回到选择工具并选中新节点——
   * 和 Figma 的手感一致：画完立刻能调尺寸。
   */
  const createNodeFromDraw = (drawTool: DrawToolId, rect: Rect, info: { dragged: boolean; start: HitPoint; end: HitPoint }) => {
    // 先收工具：无论下面建不建得成节点，画完都该回到选择工具。
    setTool(current => nextToolAfterDraw(current));
    if (isVectorTool(drawTool)) {
      // 直线/多边形/星形：几何由 start→end 决定（归一化矩形丢掉了方向），
      // 先钳制端点再建几何，避免先建后裁导致路径与盒子错位。
      const shape = vectorShapeFromDrag(drawTool, info);
      const box = { x: Math.round(shape.box.x), y: Math.round(shape.box.y), width: Math.max(1, Math.round(shape.box.width)), height: Math.max(1, Math.round(shape.box.height)) };
      const node = makeVectorNode(drawTool, page.id, box, shape.geometry);
      void run(async () => {
        await execute([{ type: "node.create", payload: { node } }]);
        setSelectedIds([node.id]);
        setMessage(`已添加${toolSpec(drawTool).label} · ${box.width}×${box.height}`);
      });
      return;
    }
    const target = clampRect(info.dragged ? rect : defaultRectFor(drawTool, { x: rect.x, y: rect.y }), { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    const box = { x: Math.round(target.x), y: Math.round(target.y), width: Math.round(target.width), height: Math.round(target.height) };
    // 整块拖到画板外：没有可建的面积，只把工具收回来。
    if (box.width < 1 || box.height < 1) return;
    const node = makeNode(drawTool, page.id, box);
    void run(async () => {
      await execute([{ type: "node.create", payload: { node } }]);
      setSelectedIds([node.id]);
      setMessage(`已添加${toolSpec(drawTool).label} · ${box.width}×${box.height}`);
    });
  };
  /**
   * 钢笔结束时的提交。
   *
   * 整条路径只发一条 `node.create`，所以一次路径 = 一次撤销；闭合路径给填充，
   * 开放路径只给描边——否则一条不闭合的曲线会被填成一块奇怪的面。
   */
  const commitPenPath = (result: PenCommit) => {
    const box = {
      x: Math.round(result.box.x),
      y: Math.round(result.box.y),
      width: Math.max(1, Math.round(result.box.width)),
      height: Math.max(1, Math.round(result.box.height)),
    };
    const node = makePenNode(page.id, box, result.geometry, result.closed);
    void run(async () => {
      await execute([{ type: "node.create", payload: { node } }]);
      setSelectedIds([node.id]);
      setMessage(`已添加${result.closed ? "闭合路径" : "开放路径"} · ${box.width}×${box.height}`);
    });
  };
  /**
   * 路径编辑的提交。
   *
   * 几何和布局必须落在同一条命令里：锚点拖动会改变整条路径的包围盒，如果先提交几何
   * 再提交布局，中间那一刻盒子是不包含图形的。归一化已经在 `penGeometry` 里做完，
   * 这里只负责把盒子对齐成整数。
   */
  const commitPathEdit = (change: { id: string; geometry: VectorGeometry; box: Rect }) => {
    const node = document.nodes[change.id];
    if (!node) return;
    const layout = {
      ...node.layout,
      x: Math.round(change.box.x),
      y: Math.round(change.box.y),
      width: Math.max(1, Math.round(change.box.width)),
      height: Math.max(1, Math.round(change.box.height)),
    };
    void run(() => execute([{ type: "vector.patch", payload: { id: change.id, patch: { geometry: change.geometry, layout } } }]));
  };
  /** 选区能否合成布尔组：同级、至少两个、都是形状、未锁定未旋转。 */
  const canBoolean = (ids: string[]) => {
    const nodes = ids.map(id => document.nodes[id]).filter((node): node is DesignNode => Boolean(node));
    return nodes.length >= 2
      && nodes.every(node => supportsBooleanOperand(node) && !node.locked && !node.layout.rotation)
      && new Set(nodes.map(node => node.parentId)).size === 1;
  };
  /**
   * 布尔运算：把选区合成**布尔组**（保留运算树），而不是烘焙成一条路径。
   *
   * 命令层只存子节点 + 运算类型，几何在渲染/导出时按运算树计算，
   * 所以之后改操作数或换运算类型都会立刻反映到结果上；一次撤销回到运算前。
   */
  const applyBooleanToSelection = (operation: BooleanOperation, ids: string[]) => {
    const id = `boolean:${crypto.randomUUID().slice(0, 8)}`;
    void run(async () => {
      await execute([{ type: "boolean.create", payload: { id, operation, nodeIds: ids } }]);
      setSelectedIds([id]);
      setMessage(`已${BOOLEAN_OPERATIONS.find(spec => spec.id === operation)?.label ?? "运算"}（可继续编辑操作数）`);
    });
  };
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
   * 上传字体文件并登记为文档字体。
   *
   * 与图片共用同一套资产管线：字节按内容哈希落库（同文件去重）、元数据进文档、
   * 字体声明在同一个事务里提交；族名与字重优先读字体文件里的真实值，
   * 读不出来才回落文件名猜测，用户可以在弹窗里改。
   */
  const insertFont = (file: File) => void run(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = fontMimeFromFileName(file.name) ?? (file.type.startsWith("font/") ? file.type : undefined);
    const invalid = fontFileError(file, bytes.byteLength, mimeType);
    if (invalid) { setMessage(invalid); return; }
    // 读字体文件里的真实族名与字重；读不出来就回落文件名猜测。
    const metadata = await readFontMetadata(bytes, mimeType);
    const values = await askForm({
      title: "登记字体",
      description: "字体文件按内容哈希存进项目，随文档一起备份；同一份文件不会重复占用空间。",
      fields: [
        { key: "family", label: "字体族名", defaultValue: metadata?.family ?? fontFamilyFromFileName(file.name) },
        { key: "weight", label: "字重（100–900 的整百值）", defaultValue: String(metadata?.weight ?? 400) },
      ],
      validate: input => {
        if (!input.family?.trim()) return "字体族名不能为空";
        const weight = Number(input.weight);
        if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) return "字重写 100–900 的整百值";
        return undefined;
      },
    });
    if (!values) return;
    const family = values.family!.trim();
    const weight = Number(values.weight);
    const hash = await sha256Hex(bytes);
    await repository.putAsset(document.id, { hash, bytes });
    forgetAssetUrl(document.id, hash);
    const assetId = assetIdForHash(hash);
    const asset: AssetMetadata = { id: assetId, hash, mimeType: mimeType!, byteLength: bytes.byteLength, name: file.name };
    await execute([
      { type: "asset.upsert", payload: { asset } },
      { type: "font.register", payload: { font: { family, assetId, weight, ...(metadata?.style === "italic" ? { style: "italic" as const } : {}) } } },
    ]);
    setMessage(`已登记字体「${family}」${weight === 400 ? "" : ` ${weight}`}`);
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
  /**
   * 替换选中图片节点的图片。
   *
   * 换的是节点引用的资源，不是"补回原文件"：新图先按哈希落库并在同一事务里
   * 登记元数据，再用 image.patch 把 assetId 指过去，节点位置、尺寸和 fit 都不变。
   */
  const replaceSelectedImage = (file: File) => void run(async () => {
    if (selected?.type !== "image") return;
    const nodeId = selected.id;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const invalid = imageFileError(file, bytes.byteLength);
    if (invalid) { setMessage(invalid); return; }
    const hash = await sha256Hex(bytes);
    const assetId = assetIdForHash(hash);
    if (assetId === selected.assetId) { setMessage("已经是这张图了"); return; }
    await repository.putAsset(document.id, { hash, bytes });
    forgetAssetUrl(document.id, hash);
    const asset: AssetMetadata = { id: assetId, hash, mimeType: file.type || "image/png", byteLength: bytes.byteLength, name: file.name };
    const commands: DesignCommand[] = [];
    // 已经有同样的资源（同一张图被别处用过）就不需要重复登记。
    if (!document.assets[assetId]) commands.push({ type: "asset.upsert", payload: { asset } });
    commands.push({ type: "image.patch", payload: { id: nodeId, patch: { assetId } } });
    await execute(commands);
    await refreshMissingAssets(project.snapshot());
    setMessage(`图片已替换为「${file.name}」`);
  });
  /** 清理没有被任何图片节点引用的资源元数据。 */  const deleteAsset = (asset: AssetMetadata) => void run(async () => {
    if (!await askConfirm({ title: "清理图片资源", description: `「${assetLabel(asset)}」没有被任何图片节点引用。清理后这份文件不能从历史版本里找回。`, confirmLabel: "清理", destructive: true })) return;
    await execute([{ type: "asset.delete", payload: { id: asset.id } }]);
    // 同一份字节可能被多条资源记录共享，确认没人再用这个哈希才回收字节。
    const stillShared = Object.values(project.snapshot().assets).some(entry => entry.hash === asset.hash);
    if (!stillShared && repository.deleteAsset) await repository.deleteAsset(document.id, asset.hash);
    await refreshMissingAssets(project.snapshot());
    setMessage(`资源「${assetLabel(asset)}」已清理`);
  });
  /** 登记/修改资源的来源与授权。全部字段可选，留空即清空。 */
  const editAssetOrigin = (asset: AssetMetadata) => void run(async () => {
    const values = await askForm({
      title: "资源来源与授权",
      description: "全部可选：填了会随文档一起保存、备份和迁移，留空表示未登记。",
      fields: [
        { key: "source", label: "来源（素材库或原始 URL）", defaultValue: asset.origin?.source ?? "" },
        { key: "author", label: "作者 / 版权方", defaultValue: asset.origin?.author ?? "" },
        { key: "license", label: "许可证（如 CC-BY-4.0）", defaultValue: asset.origin?.license ?? "" },
        { key: "note", label: "备注", defaultValue: asset.origin?.note ?? "" },
      ],
    });
    if (!values) return;
    const next = mergeAssetOrigin(asset, values);
    // 没有任何变化就不提交：避免白涨一个 revision。
    if (JSON.stringify(next.origin ?? null) === JSON.stringify(asset.origin ?? null)) return;
    await execute([{ type: "asset.upsert", payload: { asset: next } }]);
    setMessage(next.origin ? `资源「${assetLabel(asset)}」的来源已登记` : `资源「${assetLabel(asset)}」的来源已清空`);
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
  const patchNode = (id: string, patchValue: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "bindings" | "slot" | "mask" | "overflow">>) => void run(() => execute([{ type: "node.patch", payload: { id, patch: patchValue } }]));
  const canvasPointOf = (event: { clientX: number; clientY: number }) =>
    pointFromEvent(canvas?.getBoundingClientRect() ?? { left: 0, top: 0 }, event.clientX, event.clientY, zoom);
  /**
   * 单击选中完全由 Canvas 命中决定；只有选择工具才改变选中态。
   *
   * 路径编辑期间直接忽略：编辑态下点手柄可能落在图形包围盒之外，让它顺带跑一遍选中
   * 逻辑会把「编辑中」的节点取消选中，从而意外退出编辑。退出编辑由编辑 hook 决定。
   */
  const selectFromCanvas = (event: React.MouseEvent<HTMLDivElement>) => {
    if (pathEditId || tool !== "select" || canvasDrag.consumedClick()) return;
    const hit = hitTest(hitTestScene, canvasPointOf(event));
    if (!hit) setSelectedIds([]);
    else setSelectedIds(current => event.shiftKey ? toggleId(current, hit) : [hit]);
  };
  /**
   * 双击：矢量路径进入节点编辑，文本进入行内编辑。
   *
   * 图元工具下双击不进入编辑，避免画到一半跳进文本框或锚点编辑。
   */
  const handleCanvasDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== "select") return;
    // 编辑态里双击锚点 = 切换角点 / 平滑点，不要重新进入编辑态。
    if (pathEditId && pathEdit.toggleAnchorAt(canvasPointOf(event))) {
      event.preventDefault();
      return;
    }
    const hit = hitTest(hitTestScene, canvasPointOf(event));
    if (!hit) return;
    const node = document?.nodes[hit];
    if (node?.type === "vector" && node.geometry) {
      setSelectedIds([hit]);
      setPathEditId(hit);
      setMessage("双击锚点切换角点 / 平滑点，点线段可插点，Delete 删除锚点");
      return;
    }
    if (node?.type === "text") {
      setCanvasEditingId(hit);
      setSelectedIds([hit]);
    }
  };
  const patchLayouts = (changes: Array<{ id: string; layout: DesignNode["layout"] }>) => changes.length && void run(() => execute(changes.map(change => ({ type: "node.patch", payload: { id: change.id, patch: { layout: change.layout } } }))));
  /**
   * 画布拖动的提交：换父级 + 坐标换算。
   *
   * 布局里的 x/y 是**相对父级内容盒**的局部坐标，画布给的却是页面坐标，提交前
   * 必须换算：页面层的原点是 (0,0)，所以页面直接子节点的老行为逐字不变；容器的
   * 原点是它的内容盒左上角（嵌套节点由此被修正——此前写进去的是绝对坐标）。
   *
   * 落点容器与当前父级不同时额外发一条 `node.reparent`；规则与拒绝原因集中在
   * `canvas-reparent.ts`（不拖进自己的子树、不拖进自动布局容器等）。
   */
  const commitCanvasMove = (changes: Array<{ id: string; layout: DesignNode["layout"] }>, dropContainerId?: string) => {
    const current = documentRef.current;
    if (!current || !changes.length) { patchLayouts(changes); return; }
    const ids = changes.map(change => change.id);
    const boxes = Object.fromEntries(changes.map(change => [change.id, { x: change.layout.x, y: change.layout.y }]));
    const crossesContainer = Boolean(dropContainerId) && ids.some(id => current.nodes[id]?.parentId !== dropContainerId);
    if (crossesContainer && dropContainerId) {
      const plan = planCanvasReparent({
        document: current,
        draggedIds: ids,
        containerId: dropContainerId,
        boxes,
        containerOrigin: parentContentOrigin(current, hitTestScene, dropContainerId),
      });
      // 拒绝时不动文档，只把原因说清楚——比默默挪回去有用。
      if ("commands" in plan) {
        void run(() => execute(plan.commands));
        return;
      }
      setMessage(plan.reason);
      return;
    }
    const local = changes.map(change => {
      const origin = parentContentOrigin(current, hitTestScene, current.nodes[change.id]?.parentId);
      return { id: change.id, layout: { ...change.layout, x: change.layout.x - origin.x, y: change.layout.y - origin.y } };
    });
    patchLayouts(local);
  };
  const patch = (patchValue: Partial<Pick<DesignNode, "name" | "layout" | "appearance" | "mask" | "constraints" | "overflow">>) => selected && patchNode(selected.id, patchValue);
  const patchTextOf = (id: string, patchValue: TextPatch) => void run(() => execute([{ type: "text.patch", payload: { id, patch: patchValue } }]));
  const patchText = (patchValue: TextPatch) => selected?.type === "text" && patchTextOf(selected.id, patchValue);
  // 段落样式走独立命令：它是带区间语义的结构，不能混进 text.patch。
  type ParagraphStyleCommand = { listType?: "bullet" | "ordered" | "none"; indentDelta?: number; paragraphIndent?: number; hanging?: boolean; listSpacing?: number };
  const setParagraphStyleOf = (id: string, payload: { from: number; to: number; style: ParagraphStyleCommand }) => void run(() => execute([{ type: "text.paragraph.set", payload: { id, ...payload } }]));
  const setParagraphStyle = (payload: { from: number; to: number; style: ParagraphStyleCommand }) => selected?.type === "text" && setParagraphStyleOf(selected.id, payload);
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
    const result = await project.exportHtmlWithAssets({ pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds, themeId: activeThemeId });
    downloadFile(`${exportFilename}.html`, result.document, "text/html");
    setExportReport({ format: "html", diagnostics: result.diagnostics });
    setMessage(`HTML 已导出${exportScopeLabel} · ${result.diagnostics.length} 条诊断`);
  });
  /**
   * 导出资源包：主文档 + 图片/字体文件，打成 ZIP。
   *
   * 与「导出 HTML」的区别是内联与外链：那个产出单个自包含文件（图片与字体
   * 都写成 data URL），体积涨约 33%、字体超过 1 MB 就只能放弃；这个把资源
   * 拆成独立文件，体积不涨、字体也不受内联上限约束。
   */
  const exportPackage = () => void run(async () => {
    const result = await project.exportHtmlPackage({ pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds, themeId: activeThemeId });
    const encoder = new TextEncoder();
    const entries = [
      { path: PACKAGE_DOCUMENT_NAME, bytes: encoder.encode(result.document) },
      ...result.files.map(file => ({ path: file.path, bytes: file.bytes })),
    ];
    downloadBytes(`${exportFilename}.zip`, createZip(entries), "application/zip");
    setExportReport({ format: "html", diagnostics: result.diagnostics });
    setMessage(`资源包已导出${exportScopeLabel} · ${result.files.length} 个资源文件 · ${result.diagnostics.length} 条诊断`);
  });
  const exportSvg = () => void run(async () => {
    const result = await project.exportSvgWithAssets({ pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds, themeId: activeThemeId });
    downloadFile(`${exportFilename}.svg`, result.svg, "image/svg+xml");
    setExportReport({ format: "svg", diagnostics: result.diagnostics });
    setMessage(`SVG 已导出${exportScopeLabel} · ${result.diagnostics.length} 条诊断`);
  });
  const exportPng = () => void run(async () => {
    const snapshot = project.snapshot();
    // 图片写成 data URL 之后画布不会被外部资源污染，PNG 才能读回像素。
    const resolveAsset = await createAssetResolver(repository, snapshot, page.id, exportTarget.nodeIds);
    const result = await exportPageToPng(snapshot, { pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, scale: 2, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds, resolveAsset, themeId: activeThemeId });
    downloadDataUrl(`${exportFilename}.png`, result.dataUrl);
    setExportReport({ format: "png", diagnostics: result.diagnostics });
    setMessage(`PNG 已导出${exportScopeLabel} · ${result.width}×${result.height}`);
  });
  /**
   * 导出 PDF：整份文档，每页一页。
   *
   * 与其它导出入口不同：PDF 天然是多页的，所以这里导**所有页面**，不受顶栏的
   * 「整页 / 选区」范围影响。页面尺寸按设计尺寸算（96dpi → 72dpi），位图按 2×
   * 渲染——打印更清楚，尺寸没变。
   *
   * 这是图片型 PDF：文字不可选、不可搜索。
   */
  const exportPdf = () => void run(async () => {
    const snapshot = project.snapshot();
    const resolveAsset = await createAssetResolver(repository, snapshot, page.id, undefined);
    const result = await exportDocumentToPdf(snapshot, {
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      title: document.meta.name,
      themeId: activeThemeId,
      resolveAsset,
    });
    downloadBytes(`${safeFilename(document.meta.name)}.pdf`, result.bytes, "application/pdf");
    setExportReport({ format: "pdf", diagnostics: result.diagnostics });
    setMessage(`PDF 已导出 · ${result.pageCount} 页 · ${result.diagnostics.length} 条诊断`);
  });
  // 预览和下载走同一个导出入口，看到的就是交付物本身。
  const exportOptions = () => ({ pageId: page.id, viewport: exportTarget.viewport, title: document.meta.name, origin: exportTarget.origin, nodeIds: exportTarget.nodeIds, themeId: activeThemeId });
  /**
   * 导出 React 组件：设计稿直接变成能进工程的代码。
   *
   * 样式与 HTML 导出共用同一套计算，所以两者渲染结果一致（端到端探针逐像素比对）。
   * 文字内容与图片地址提成 props——内容是内容，样式是样式。
   */
  const exportReact = () => void run(async () => {
    const snapshot = project.snapshot();
    const resolveAsset = await createAssetResolver(repository, snapshot, page.id, exportTarget.nodeIds);
    const result = exportPageToReact(snapshot, {
      pageId: page.id,
      viewport: exportTarget.viewport,
      componentName: page.name,
      origin: exportTarget.origin,
      nodeIds: exportTarget.nodeIds,
      resolveAsset,
      themeId: activeThemeId,
    });
    downloadFile(`${exportFilename}.tsx`, result.code, "text/typescript");
    setExportReport({ format: "react", diagnostics: result.diagnostics });
    setMessage(`React 组件已导出${exportScopeLabel} · ${result.componentName} · ${result.props.length} 个 props · ${result.diagnostics.length} 条诊断`);
  });
  const previewHtml = () => void run(async () => {
    const result = await project.exportHtmlWithAssets(exportOptions());
    setExportReport({ format: "html", diagnostics: result.diagnostics });
    setComparePreview(undefined);
    setExportPreview({ format: "html", title: previewTitle("html", exportScopeLabel), content: { kind: "html", html: result.document } });
    setPreviewOpen(true);
  });
  const previewSvg = () => void run(async () => {
    const result = await project.exportSvgWithAssets(exportOptions());
    setExportReport({ format: "svg", diagnostics: result.diagnostics });
    const size = fitPreviewSize(exportTarget.viewport);
    setComparePreview(undefined);
    setExportPreview({ format: "svg", title: previewTitle("svg", exportScopeLabel), content: { kind: "image", dataUrl: svgPreviewDataUrl(result.svg), ...size } });
    setPreviewOpen(true);
  });
  const previewPng = () => void run(async () => {
    const snapshot = project.snapshot();
    const resolveAsset = await createAssetResolver(repository, snapshot, page.id, exportTarget.nodeIds);
    const result = await exportPageToPng(snapshot, { ...exportOptions(), scale: 2, resolveAsset });
    setExportReport({ format: "png", diagnostics: result.diagnostics });
    const size = fitPreviewSize(result);
    setComparePreview(undefined);
    setExportPreview({ format: "png", title: previewTitle("png", exportScopeLabel), content: { kind: "image", dataUrl: result.dataUrl, ...size } });
    setPreviewOpen(true);
  });

  /**
   * 把一份文档（可能是历史版本）导成 HTML 预览产物。
   *
   * 走的是和真正下载完全一样的导出路径，只是把产物塞进弹窗而不是存成文件——
   * 对比看到的必须就是交付物本身。
   */
  const buildHtmlPreview = async (source: DesignDocument, scope: { pageId: string; nodeIds?: string[] }) => {
    const resolveAsset = await createAssetResolver(repository, source, scope.pageId, scope.nodeIds);
    const fonts = await prepareFontFaces(repository, source, { pageId: scope.pageId, nodeIds: scope.nodeIds, themeId: activeThemeId });
    return exportPageToHtml(source, {
      pageId: scope.pageId,
      viewport: exportTarget.viewport,
      // 范围退回整页时不能再带选区的原点，否则两侧画的不是同一个位置。
      origin: scope.nodeIds ? exportTarget.origin : undefined,
      title: source.meta.name,
      nodeIds: scope.nodeIds,
      themeId: activeThemeId,
      resolveAsset,
      fontFaces: fonts.css ? [fonts.css] : [],
    });
  };

  /**
   * 版本并排对比：左边历史版本、右边当前版本。
   *
   * 两侧用**同一份范围**导出，否则左右根本不是同一件事，看不出差异。范围对不
   * 上时（历史版本里没有这个对象、还没有这一页）会退回整页并把话说出来。
   */
  const previewCompareVersion = (row: SnapshotRow) => void run(async () => {
    const historical = await repository.readSnapshot(document.id, row.revision);
    const result = planVersionCompareScope({
      currentNodeIds: exportTarget.nodeIds,
      currentPageId: activePageId,
      current: document,
      historical,
    });
    if (result.ok === false) {
      setMessage(result.reason);
      return;
    }
    const plan = result.plan;
    const [left, right] = await Promise.all([
      buildHtmlPreview(historical, { pageId: plan.pageId, nodeIds: plan.nodeIds }),
      buildHtmlPreview(document, { pageId: plan.pageId, nodeIds: plan.nodeIds }),
    ]);
    const titles = comparePaneTitles({ label: row.label, updatedAt: row.updatedAt });
    setComparePreview({ title: titles.historical, preview: { format: "html", title: titles.historical, content: { kind: "html", html: left.document } } });
    setExportPreview({ format: "html", title: titles.current, content: { kind: "html", html: right.document } });
    setPreviewOpen(true);
    setMessage(plan.note ? `版本对比：${plan.note}` : `版本对比：${titles.historical} ↔ 当前`);
  });
  const exportJson = () => { downloadFile(`${safeFilename(document.meta.name)}.design.json`, JSON.stringify(document, null, 2), "application/json"); setMessage("项目 JSON 已导出"); };
  /**
   * 导入时的重名处理：让用户自己起名。
   *
   * 以前只能接受自动编号的建议名（"原名（2）"），用户想换个说法做不到——所以这里
   * 给一个输入框，默认值仍是建议名，但可以直接改。校验挡住空名字和重名。
   */
  const askImportName = async (defaultName: string, taken: string[]): Promise<string | undefined> => {
    const name = await askText({
      title: "项目名称已被占用",
      description: `本地已有同名项目。给导入的项目起个名字，默认是「${defaultName}」。`,
      defaultValue: defaultName,
      validate: value => validateImportName(value, taken),
    });
    return name?.trim() || undefined;
  };
  /**
   * 读导入文件的原文；加密备份先要密码。
   *
   * 密码错了可以重试（弹窗再问一次），但不限次数——用户可能压根不知道这个文件
   * 是加密的，一直猜密码没有意义。返回 undefined 表示用户放弃。
   */
  const readImportedText = async (text: string): Promise<string | undefined> => {
    if (!isEncryptedBackupText(text)) return text;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const password = await askText({
        title: "这份备份是加密的",
        description: "输入导出这份备份时设置的密码。密码不对可以再试。",
        label: "密码",
        secret: true,
        confirmLabel: "解密",
      });
      if (!password) return undefined;
      try {
        return await decryptBackupText(text, password);
      } catch (error) {
        if (!(error instanceof BackupDecryptError)) throw error;
        setMessage(error.message);
      }
    }
    return undefined;
  };
  /** 导入一个文件：可能是新项目，也可能覆盖同一个项目的另一个版本。 */
  const importSingle = async (file: File) => {
    const plain = await readImportedText(await file.text());
    if (plain === undefined) { setMessage("已取消导入"); return; }
    const raw = JSON.parse(plain);
    const existing = await repository.listProjects();
    const taken = existing.map(item => item.name);
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
      if (choice === "replace") {
        prepared = prepareImportedDocument(raw, { mode: "replace", id: conflict.projectId });
      } else {
        // 作为新项目导入：副本名（"原名（导入）"）本身也可能撞上已有的副本。
        prepared = prepareImportedDocument(raw, { mode: "copy" });
        if (taken.includes(prepared.document.meta.name)) {
          const name = await askImportName(uniqueProjectName(prepared.document.meta.name, taken), taken);
          if (!name) { setMessage("已取消导入"); return; }
          prepared = prepareImportedDocument(raw, { mode: "copy", name });
        }
      }
    } else if (conflict?.kind === "name") {
      // 只是重名：内容是另一个项目，导入安全，但要确认改后的名字。
      const name = await askImportName(conflict.suggestedName ?? probe.document.meta.name, taken);
      if (!name) { setMessage("已取消导入"); return; }
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
  };
  /**
   * 批量导入：一次导入多个文件。
   *
   * 批量场景下一律按新项目导入，**不覆盖**任何现有项目——逐个弹窗问"要不要覆盖"
   * 既烦又危险。名字由程序先去重，用户可以在确认表格里逐个改名。
   */
  const importBatch = async (files: File[]) => {
    const existing = await repository.listProjects();
    const taken = existing.map(item => item.name);
    const sources: BatchImportSource[] = [];
    const failures: BatchImportFailure[] = [];
    for (const file of files) {
      const parsed = readImportSource(file.name, await file.text());
      if ("reason" in parsed) failures.push(parsed);
      else sources.push(parsed);
    }
    const planned = planBatchImport(sources, existing);
    failures.push(...planned.failures);
    if (!planned.plans.length) {
      setMessage(failures.length ? `没有可导入的文件：${failures[0]?.reason ?? "文件格式不对"}` : "没有可导入的文件");
      return;
    }
    const values = await askForm({
      title: `导入 ${planned.plans.length} 个项目`,
      description: "确认每个项目的名字；重名的已经自动加过编号，可以直接改成你想要的名字。",
      fields: planned.plans.map((plan, index) => ({ key: `name:${index}`, label: plan.fileName, defaultValue: plan.name })),
      validate: next => validateBatchNames(planned.plans.map((_, index) => next[`name:${index}`] ?? ""), taken),
    });
    if (!values) { setMessage("已取消导入"); return; }
    let missingAssets = 0;
    for (const [index, plan] of planned.plans.entries()) {
      const name = values[`name:${index}`]?.trim() || plan.name;
      const document = { ...plan.document, meta: { ...plan.document.meta, name } };
      await repository.saveSnapshot(document);
      // 资源字节不会跟着 JSON 走，逐个核对有没有缺图。
      const missing = await findMissingAssets(repository, document);
      if (missing.length) missingAssets += missing.length;
    }
    setProjects(await repository.listProjects());
    const imported = planned.plans.length;
    const skipped = failures.length ? `，${failures.length} 个文件没导入` : "";
    const missingNotice = missingAssets ? `，${missingAssets} 个图片资源缺失` : "";
    setMessage(`已导入 ${imported} 个项目${skipped}${missingNotice}`);
  };
  const importJsonFiles = (files: File[]) => void run(async () => {
    if (!files.length) return;
    if (files.length === 1) await importSingle(files[0]);
    else await importBatch(files);
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
  /**
   * 生成 AI 计划。
   *
   * 走自己的取消信号而不是 `run()`：`run()` 会把 busy 一直占住，用户没有办法
   * 中止一个卡住的模型请求。失败或取消都不会改动项目——计划只有在 dry-run
   * 成功之后才会进入待确认状态。
   */
  const generateAiPlan = async () => {
    if (!editor || !prompt.trim() || busy) return;
    const controller = new AbortController();
    planAbort.current = controller;
    operationInFlight.current = true;
    setPlanning(true); setBusy(true); setStreamText("");
    try {
      const image = await captureVisionIfEnabled();
      const next = await editor.createPlan(prompt, selectedIds, {
        signal: controller.signal,
        // 只覆盖显示累计文本；权威内容由 Planner 的 fullText 给出。
        onDelta: (_delta, fullText) => setStreamText(fullText),
        ...(image ? { image } : {}),
      });
      setPreview(next);
      setMessage("AI 计划已完成 dry-run，等待确认");
    } catch (error) {
      setMessage(error instanceof AiCancelledError ? "已取消 AI 生成" : errorMessage(error));
    } finally {
      planAbort.current = undefined;
      operationInFlight.current = false;
      setPlanning(false); setBusy(false); setStreamText("");
    }
  };

  /**
   * 「带截图问 AI」开关打开时，给模型截一张图。
   *
   * 端点不支持看图就不截——发过去只会得到一个 400。与其让用户对着报错猜，
   * 不如一开始就把这个选项关掉。
   *
   * 范围有三种：整页、只截选中的节点（问「这个按钮怎么样」时整页里的按钮太小）、
   * 把所有页横向拼成一张长图（看流程的先后与呼应）。截图的范围会写进提示——
   * 模型看到的是一张图，不知道它是整页还是拼图，不说明它会读错。
   */
  const captureVisionIfEnabled = async (): Promise<AiImagePayload | undefined> => {
    if (!aiVision || !document || !page) return undefined;
    if (!describeProvider(aiSettings.baseUrl).capabilities.vision) return undefined;
    const shared = { document, repository, projectId: document.id };
    let shot: Awaited<ReturnType<typeof capturePageScreenshot>>;
    let label: string;
    if (aiVisionScope === "selection" && selectedIds.length) {
      shot = await captureSelectionScreenshot({ ...shared, pageId: page.id, nodeIds: selectedIds });
      label = `当前选区（${selectedIds.length} 个节点）`;
      if (!shot) {
        // 选区不在当前页上时截不出来——退回整页并说清楚，别让用户以为没截。
        shot = await capturePageScreenshot({ ...shared, pageId: page.id });
        label = "当前页";
      }
    } else if (aiVisionScope === "pages" && document.pageOrder.length > 1) {
      shot = await capturePagesScreenshot({ ...shared, pageId: page.id, pageIds: document.pageOrder });
      label = `全部 ${document.pageOrder.length} 个页面（从左到右）`;
    } else {
      shot = await capturePageScreenshot({ ...shared, pageId: page.id });
      label = "当前页";
    }
    if (!shot) {
      setMessage("这一页没有可截图的内容，AI 这次是按文字摘要回答的");
      return undefined;
    }
    return { dataUrl: shot.dataUrl, mimeType: shot.mimeType, width: shot.width, height: shot.height, label };
  };

  /**
   * 自主运行：体检驱动的多轮编排。
   *
   * 每一轮都是「体检 → 计划 → dry-run → 审查 → 提交」，提交完立刻重新体检，
   * 下一轮把体检结论回喂给模型——这就是「AI 自己跑」的那一层。
   *
   * 每一轮都走正常事务，因此跑完之后可以逐轮撤销。
   */
  const startAutonomousRun = async () => {
    if (!editor || !project || !prompt.trim() || busy || loopRunning) return;
    const controller = new AbortController();
    planAbort.current = controller;
    operationInFlight.current = true;
    setLoopRunning(true); setBusy(true); setLoopRounds([]); setLoopSummary(undefined);
    try {
      const resolveAsset = await createSelfCheckResolver(project.snapshot());
      const image = await captureVisionIfEnabled();
      const result = await runAutonomousLoop(editor, {
        goal: prompt.trim(),
        selectedNodeIds: selectedIds,
        maxRounds: 6,
        selfCheck: { resolveAsset },
        ...(image ? { image } : {}),
        signal: controller.signal,
        onRound: round => {
          setLoopRounds(previous => [...previous, round]);
          setDocument(project.snapshot());
        },
      });
      setLoopSummary(result.message);
      setDocument(project.snapshot());
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof AiCancelledError ? "已取消自主运行" : errorMessage(error));
    } finally {
      planAbort.current = undefined;
      operationInFlight.current = false;
      setLoopRunning(false); setBusy(false);
    }
  };

  /** 写 token：主题激活时写成该主题的覆盖，否则改基础值。 */
  const applyToken = async (name: string, token: TokenValue) => {
    if (activeTheme && activeThemeId) {
      await execute([{ type: "theme.upsert", payload: { theme: { ...activeTheme, tokens: { ...activeTheme.tokens, [name]: token } } } }]);
      return;
    }
    await execute([{ type: "token.upsert", payload: { name, token } }]);
  };
  /** 新增主题：先建空主题再切过去，之后在 token 面板里改值就是写覆盖。 */
  const createTheme = () => void run(async () => {
    const values = await askForm({
      title: "新增主题",
      description: "主题只覆盖已有 token 的值，不新建 token；建好后在「设计 Tokens」里改值即为覆盖。",
      fields: [{ key: "name", label: "主题名称", defaultValue: `主题 ${(document.themes?.length ?? 0) + 1}` }],
      validate: input => (input.name?.trim() ? undefined : "主题名称不能为空"),
    });
    if (!values) return;
    // 继承：把父主题的覆盖带过来，之后再逐项覆盖。父主题只在有其它主题时才问。
    const others = (document.themes ?? []).filter(theme => theme.id !== activeThemeId);
    let parentId: string | undefined;
    if (others.length) {
      const picked = await askChoice({
        title: "继承自哪个主题？",
        description: "继承之后，这个主题会先带上父主题的覆盖，再叠加自己的。可以不继承。",
        options: [
          { value: "", label: "不继承（从基础值开始）" },
          ...others.map(theme => ({ value: theme.id, label: theme.name })),
        ],
      });
      if (picked === null) return;
      parentId = picked || undefined;
    }
    const theme = {
      id: `theme:${crypto.randomUUID()}`,
      name: values.name.trim(),
      tokens: {},
      ...(parentId ? { extends: parentId } : {}),
    };
    await execute([{ type: "theme.upsert", payload: { theme } }]);
    setActiveThemeId(theme.id);
    setMessage(theme.extends
      ? `已新增主题「${theme.name}」，继承自「${findTheme(document, theme.extends)?.name ?? theme.extends}」`
      : `已新增主题「${theme.name}」`);
  });
  /**
   * 清空当前主题的**全部**覆盖，回到基础值 / 继承来的值。
   *
   * 一个一个点「恢复基础值」太慢：主题覆盖了几十个 token 时，要点几十次。
   * 注意这不动父主题的覆盖——继承来的值还在。
   */
  const resetWholeTheme = () => void run(async () => {
    if (!activeThemeId || !activeTheme) return;
    if (!await askConfirm({
      title: "清空主题覆盖",
      description: `清空主题「${activeTheme.name}」的 ${Object.keys(activeTheme.tokens).length} 项覆盖？这些 token 会回到基础值（或父主题继承来的值）。`,
      confirmLabel: "清空",
      destructive: true,
    })) return;
    await execute([{ type: "theme.upsert", payload: { theme: { ...activeTheme, tokens: {} } } }]);
    setMessage(`已清空主题「${activeTheme.name}」的覆盖`);
  });
  const deleteActiveTheme = () => void run(async () => {
    if (!activeThemeId) return;
    if (!await askConfirm({
      title: "删除主题",
      description: `删除主题「${activeTheme?.name ?? activeThemeId}」？只删除它的覆盖值，基础 token 不受影响。`,
      confirmLabel: "删除",
      destructive: true,
    })) return;
    await execute([{ type: "theme.delete", payload: { id: activeThemeId } }]);
    setActiveThemeId(undefined);
    setMessage("主题已删除");
  });
  /** 去掉某个 token 在当前主题下的覆盖，回到基础值。 */
  const resetThemeOverride = (name: string) => void run(async () => {
    if (!activeTheme) return;
    const tokens = { ...activeTheme.tokens };
    delete tokens[name];
    await execute([{ type: "theme.upsert", payload: { theme: { ...activeTheme, tokens } } }]);
    setMessage(`「${name}」已恢复基础值`);
  });
  const createToken = () => void run(async () => {
    if (activeThemeId) {
      setMessage("当前在主题模式：主题只能覆盖已有 token，请先切回「基础」再新增");
      return;
    }
    const type = await askChoice({
      title: "新增 Token",
      description: "颜色 token 绑定填充/描边；数值 token 绑定圆角/自动布局间距；字体 token 绑定文本节点；别名 token 指向另一个 token（语义分层）。",
      options: [{ value: "color", label: "颜色" }, { value: "number", label: "数值" }, { value: "typography", label: "字体" }, { value: "alias", label: "别名" }],
    });
    if (!type) return;
    const name = (await askText({
      title: "Token 名称",
      defaultValue: type === "color" ? "color.primary" : type === "number" ? "space.md" : type === "typography" ? "text.body" : "text.primary",
    }))?.trim();
    if (!name) return;
    if (type === "color") {
      const value = (await askText({ title: "颜色值", defaultValue: "#6366f1", validate: validateColor }))?.trim();
      if (!value) return;
      await applyToken(name, { type: "color", value });
      return;
    }
    if (type === "typography") {
      const value = await askTypographyValue(askForm, { fontFamily: "Inter", fontSize: 14, lineHeight: 20, fontWeight: 400, letterSpacing: 0 });
      if (!value) return;
      await applyToken(name, { type: "typography", value });
      return;
    }
    if (type === "alias") {
      const target = (await askText({
        title: "指向哪个 token",
        defaultValue: Object.keys(document.tokens)[0] ?? "",
        validate: input => {
          const value = input?.trim();
          if (!value) return "别名必须指向一个已存在的 token";
          if (value === name) return "别名不能指向自己";
          if (!document.tokens[value]) return `没有名为 ${value} 的 token`;
          return undefined;
        },
      }))?.trim();
      if (!target) return;
      await applyToken(name, { type: "alias", value: target });
      return;
    }
    const value = (await askText({ title: "数值", defaultValue: "16", validate: validateNumber }))?.trim();
    if (!value) return;
    await applyToken(name, { type: "number", value: Number(value) });
  });
  /**
   * 从样式表导入 token。
   *
   * 解析器只给**提案**：类型是推断的、带单位的值不换算、同名 token 会被覆盖——
   * 这三件事都要让人先看见再决定，所以中间有一张可改名的确认表。
   * 导入写在一个事务里，因此可以一次撤销。
   */
  const importTokensFromStyleSheet = () => void run(async () => {
    if (activeThemeId) {
      setMessage("当前在主题模式：主题只能覆盖已有 token，请先切回「基础」再导入");
      return;
    }
    const pasted = await askForm({
      title: "从样式表导入 Token",
      description: "粘贴 CSS 自定义属性或 SCSS 变量，例如：:root { --color-brand: #6366f1; --space-md: 16px; }",
      fields: [{
        key: "css",
        label: "样式表",
        type: "textarea",
        placeholder: ":root {\n  --color-brand: #6366f1;\n  --space-md: 16px;\n}",
      }],
    });
    if (!pasted) return;
    const parsed = parseStyleTokens(pasted.css ?? "", { existing: document.tokens });
    if (!parsed.tokens.length) {
      setMessage(parsed.warnings[0] ?? "没有解析出任何变量");
      return;
    }
    const confirmed = await askForm({
      title: `导入 ${parsed.tokens.length} 个 Token`,
      description: "名字可以改；清空某一项表示不导入它。会覆盖同名 token 的地方已标注。",
      fields: parsed.tokens.map(token => ({
        key: `token:${token.name}`,
        label: `${token.source} = ${token.value}${token.conflicts ? "（会覆盖同名 token）" : ""}`,
        defaultValue: token.name,
      })),
    });
    if (!confirmed) return;
    const commands: DesignCommand[] = [];
    for (const token of parsed.tokens) {
      const name = (confirmed[`token:${token.name}`] ?? "").trim();
      if (!name) continue;
      commands.push({ type: "token.upsert", payload: { name, token: proposalToToken(token) } });
    }
    if (!commands.length) { setMessage("没有导入任何 token"); return; }
    await execute(commands);
    const skipped = parsed.tokens.length - commands.length;
    const hint = parsed.warnings.length ? `；${parsed.warnings[0]}` : "";
    setMessage(`已导入 ${commands.length} 个 token${skipped ? `，跳过 ${skipped} 个` : ""}${hint}`);
  });
  const updateToken = (name: string, token: TokenValue) => void run(async () => {
    if (token.type === "typography") {
      const next = await askTypographyValue(askForm, token.value);
      if (!next) return;
      await applyToken(name, { type: "typography", value: next });
      return;
    }
    if (token.type === "alias") {
      const target = (await askText({
        title: "别名目标",
        defaultValue: token.value,
        validate: input => {
          const value = input?.trim();
          if (!value) return "别名必须指向一个已存在的 token";
          if (value === name) return "别名不能指向自己";
          if (!document.tokens[value]) return `没有名为 ${value} 的 token`;
          return undefined;
        },
      }))?.trim();
      if (!target || target === token.value) return;
      await applyToken(name, { type: "alias", value: target });
      return;
    }
    const current = String(token.value);
    const value = token.type === "color"
      ? (await askText({ title: "颜色值", defaultValue: current, validate: validateColor }))?.trim()
      : (await askText({ title: "数值", defaultValue: current, validate: validateNumber }))?.trim();
    if (!value || value === current) return;
    await applyToken(name, { type: token.type, value: token.type === "color" ? value : Number(value) });
  });
  const bindToken = (property: "fill" | "stroke" | "typography" | "spacing" | "radius", name: string) => {
    if (!selected) return;
    patchNode(selected.id, { bindings: { ...selected.bindings, [property]: name } });
  };
  const unbindToken = (property: "fill" | "stroke" | "typography" | "spacing" | "radius") => {
    if (!selected) return;
    const remaining = { ...selected.bindings };
    delete remaining[property];
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
    // 锁定节点从删除里跳过：它们仍可被选中查看属性，但批量删除不该顺手删掉。
    const targetIds = deletableRoots(roots.map(id => ({ id, locked: Boolean(document.nodes[id]?.locked) })));
    if (!targetIds.length) { setMessage("选中的对象都被锁定了，先解锁再删除"); return; }
    const skipped = roots.length - targetIds.length;
    void run(async () => {
      await execute(targetIds.map(id => ({ type: "node.delete" as const, payload: { id } })));
      setSelectedIds([]);
      if (skipped) setMessage(`已删除 ${targetIds.length} 个节点，跳过 ${skipped} 个锁定节点`);
    });
  };
  const selectAll = () => {
    const ids = selectAllIds(document, page.id);
    setSelectedIds(ids);
    setMessage(`已选中 ${ids.length} 个对象`);
  };
  // 「适应内容」框住真正有内容的区域，而不是整块 960x680 的画布。
  const fitCanvas = () => {
    if (!scroller) return;
    const bounds = contentBounds(canvasLayout.boxes) ?? { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
    const viewport = {
      width: Math.max(1, scroller.clientWidth - 56),
      height: Math.max(1, scroller.clientHeight - 92),
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
    const nodeId = hitTest(hitTestScene, canvasPointOf(event));
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
  /** 选中节点所属的组件：组件属性面板按它来显示。 */
  const owningComponentId = selected ? findOwningComponentId(document, selected.id) : undefined;
  /**
   * 从现有组件复制出一个变体。
   *
   * 首次创建变体时先问属性名（可多个，逗号分隔），再让用户填「当前值 / 新值」；
   * 已经有变体集时只填新值。建集、登记当前组件、复制新变体三条命令在同一个事务里，
   * 失败不会留下「有集合没成员」的半成品。
   */
  const createComponentVariant = (componentId: string) => void run(async () => {
    const component = document.components[componentId];
    if (!component) return;
    const existingSet = component.variantSetId ? document.componentSets?.[component.variantSetId] : undefined;
    let properties: string[];
    let setId: string;
    if (existingSet) {
      properties = existingSet.properties;
      setId = existingSet.id;
    } else {
      const raw = await askText({
        title: `为「${component.name}」建立变体集`,
        description: "属性名用逗号分隔，例如 state, size。建立后集合属性不可修改。",
        label: "变体属性",
        defaultValue: "state",
        validate: value => parseVariantProperties(value).error,
      });
      if (raw === null) return;
      properties = parseVariantProperties(raw).properties;
      setId = `set:${crypto.randomUUID().slice(0, 8)}`;
    }

    const includeCurrent = !component.variantSetId;
    const current = component.variant ?? {};
    const values = await askForm({
      title: `为「${component.name}」创建变体`,
      description: includeCurrent
        ? `属性：${properties.join(" / ")}（首次创建会建立变体集并登记当前组件）`
        : `当前变体：${formatVariant(properties, current)}`,
      fields: [
        ...(includeCurrent ? variantCurrentFields(properties) : []),
        ...variantNextFields(properties, current),
      ],
      validate: input => validateVariantForm(properties, input, { includeCurrent }),
    });
    if (!values) return;

    const nextValues = nextValuesFromForm(properties, values);
    const currentValues = includeCurrent ? currentValuesFromForm(properties, values) : current;
    const commands: DesignCommand[] = [];
    if (!existingSet) {
      commands.push({ type: "component.setCreate", payload: { set: { id: setId, name: `${component.name} 变体`, properties } } });
    }
    if (!component.variantSetId) {
      commands.push({ type: "component.setVariant", payload: { id: componentId, variantSetId: setId, variant: currentValues } });
    }
    commands.push({
      type: "component.createVariant",
      payload: {
        sourceComponentId: componentId,
        componentId: `component:${crypto.randomUUID().slice(0, 8)}`,
        name: `${component.name} / ${formatVariant(properties, nextValues)}`,
        values: nextValues,
      },
    });
    await execute(commands);
    setMessage(`已创建变体「${formatVariant(properties, nextValues)}」`);
  });
  /** 编组：把同级的多个对象包进一个不带填充的 frame。 */
  const groupSelection = () => {
    if (selectionLocked) return;
    const plan = planGroup(document, selectedIds, canvasLayout.boxes, { id: `frame:${crypto.randomUUID().slice(0, 8)}` });
    if (!plan) { setMessage("只有同一个父级下的两个及以上对象可以编组"); return; }
    void run(async () => { await execute(plan.commands); setSelectedIds([plan.frameId]); setMessage(`已编组 ${plan.nodeIds.length} 个对象`); });
  };
  /** 用剪贴板内容填充实例的插槽；多个插槽时让用户选。 */
  const fillInstanceSlot = () => void run(async () => {
    if (selected?.type !== "instance") return;
    const content = clipboard.current;
    if (!content) { setMessage("先复制要放进插槽的内容"); return; }
    const slots = collectSlotNodes(document, selected.id);
    if (!slots.length) { setMessage("这个实例的组件没有插槽"); return; }
    let slotId = slots[0]!.id;
    if (slots.length > 1) {
      const choice = await askChoice({ title: "选择插槽", options: slots.map(node => ({ value: node.id, label: node.name })) });
      if (choice === null) return;
      slotId = choice;
    }
    await execute([{ type: "slot.fill", payload: { instanceId: selected.id, slotNodeId: slotId, template: { roots: content.roots, nodes: content.nodes } } }]);
    setMessage("已把剪贴板内容放进插槽");
  });
  /** 脱离组件：实例去掉组件身份，变成普通 frame，子树原样保留。 */
  const detachComponent = () => {
    if (selected?.type !== "instance") return;
    const id = selected.id;
    void run(async () => {
      await execute([{ type: "component.detach", payload: { id } }]);
      setMessage("已脱离组件：实例变成普通 frame，子图层保留");
    });
  };
  /** 清空选中实例的全部覆盖。 */
  const resetAllOverrides = () => {
    if (selected?.type !== "instance") return;
    const instanceId = selected.id;
    void run(async () => {
      await execute([{ type: "component.resetOverrides", payload: { instanceId } }]);
      setMessage("已清除该实例的全部覆盖");
    });
  };
  /** 多选全是实例时，一次把它们都脱离成普通 frame。 */
  const detachSelectedInstances = () => {
    const ids = selectedNodes.filter(node => node.type === "instance").map(node => node.id);
    if (ids.length < 2) return;
    void run(async () => {
      await execute([{ type: "component.detachMany", payload: { ids } }]);
      setMessage(`已脱离 ${ids.length} 个实例`);
    });
  };
  /**
   * 把选中的节点暴露成组件属性。
   *
   * 先问属性名（默认取节点名），再一次性提交「声明属性 + 绑定字段」两条命令——
   * 中途失败不会留下「有属性没绑定」的半成品。
   */
  const exposeComponentProperty = (field: ComponentPropertyField) => void run(async () => {
    if (!selected) return;
    const componentId = findOwningComponentId(document, selected.id);
    if (!componentId) { setMessage("请先选中组件内部的节点"); return; }
    if (field === "text" && selected.type !== "text") { setMessage("只有文本节点能暴露为文本属性"); return; }
    if (field === "fontSize" && selected.type !== "text") { setMessage("只有文本节点能暴露为字号属性"); return; }
    if (field === "instance" && selected.type !== "instance") { setMessage("只有实例节点能暴露为实例交换属性"); return; }
    const name = await askText({
      title: PROPERTY_EXPOSE_TITLES[field],
      description: PROPERTY_EXPOSE_DESCRIPTIONS[field],
      label: "属性名",
      defaultValue: selected.name,
      validate: value => value.trim() ? undefined : "属性名不能为空",
    });
    if (name === null) return;
    const trimmed = name.trim();
    const propertyId = newPropertyId();
    // 属性是判别联合：类型与默认值必须成对给出，不能靠条件表达式推断。
    const property = buildExposedProperty(propertyId, trimmed, field, selected);
    await execute([
      { type: "component.property.set", payload: { componentId, property } },
      { type: "component.property.bind", payload: { componentId, propertyId, nodeId: selected.id, field } },
    ]);
    setMessage(`已暴露组件属性「${trimmed}」`);
  });
  /** 删除组件属性。 */
  const removeComponentProperty = (componentId: string, propertyId: string) => void run(async () => {
    await execute([{ type: "component.property.remove", payload: { componentId, propertyId } }]);
    setMessage("已删除组件属性");
  });
  /** 解除属性与节点的绑定。 */
  const unbindComponentProperty = (componentId: string, propertyId: string, nodeId: string, field: ComponentPropertyField) => void run(async () => {
    await execute([{ type: "component.property.unbind", payload: { componentId, propertyId, nodeId, field } }]);
    setMessage("已解除组件属性绑定");
  });
  /** 设置实例的属性值。 */
  const setInstanceProperty = (instanceId: string, propertyId: string, value: ComponentPropertyValue) => void run(async () => {
    await execute([{ type: "instance.property.set", payload: { instanceId, propertyId, value } }]);
  });
  /** 删掉实例的显式属性值，回到默认值。 */
  const resetInstanceProperty = (instanceId: string, propertyId: string) => void run(async () => {
    await execute([{ type: "instance.property.reset", payload: { instanceId, propertyId } }]);
  });
  /** 取消编组：把 frame 的子节点放回原位置，再删掉空 frame。 */
  const ungroupSelection = () => {
    if (selectionLocked || selectedIds.length !== 1) return;
    const plan = planUngroup(document, selectedIds[0]!, canvasLayout.boxes);
    if (!plan) { setMessage("选中的对象不是带子节点的编组"); return; }
    void run(async () => { await execute(plan.commands); setSelectedIds(plan.childIds); setMessage(`已取消编组，放出 ${plan.childIds.length} 个对象`); });
  };
  nudgeAction.current = (dx, dy) => {
    if (busy) return;
    const movable = editableNodes(selectedNodes);
    if (!movable.length) {
      setMessage(allLocked(selectedNodes) ? "选中的对象都被锁定了，先解锁再移动" : "没有可以移动的对象");
      return;
    }
    const patches: Array<{ id: string; layout: DesignNode["layout"] }> = [];
    const reorders: Array<{ id: string; parentId: string; index: number }> = [];
    for (const node of movable) {
      const parent = document.nodes[node.parentId];
      // 自动布局 / 网格容器里子节点的 x/y 由布局引擎算，改 layout 不会动；
      // 这时方向键改为调整顺序。
      if (parent?.layout.mode === "stack" || parent?.layout.mode === "grid") {
        const index = nudgeReorder(parent.childIds, node.id, dx, dy);
        if (index !== undefined) reorders.push({ id: node.id, parentId: parent.id, index });
      } else {
        patches.push(...nudgeNodes([node], dx, dy));
      }
    }
    const commands: DesignCommand[] = [
      ...patches.map(change => ({ type: "node.patch" as const, payload: { id: change.id, patch: { layout: change.layout } } })),
      ...reorders.map(order => ({ type: "node.reparent" as const, payload: order })),
    ];
    if (!commands.length) return;
    void run(() => execute(commands));
  };
  keyboardAction.current = action => {
    if (busy) return;
    if (action === "copy") copySelection();
    else if (action === "paste") pasteSelection();
    else if (action === "duplicate") duplicateSelection();
    else if (action === "layerUp") reorderLayer(Math.min((selectedOwner?.childIds.length ?? 1) - 1, selectedLayerIndex + 1));
    else if (action === "layerDown") reorderLayer(Math.max(0, selectedLayerIndex - 1));
    else if (action === "selectAll") selectAll();
    else if (action === "group") groupSelection();
    else if (action === "ungroup") ungroupSelection();
    else deleteSelection();
  };
  const previewStale = preview?.baseRevision !== document.revision;
  const componentSummaries = listComponents(document);
  const versionRows = snapshotRows(snapshots);
  // 并排对比只列历史版本：当前版本和它自己对比没有意义。
  const compareVersionRows = versionRows.filter(row => !row.current);
  // 分段标题的上下文与角标来自纯函数：哪个分段有需要处理的条目，就在标签上显示数字。
  const inspectorTabRows = inspectorTabs({
    selectionCount: selectedIds.length,
    selectedName: selected?.name,
    exportScope,
    revision: document.revision,
    assetCount: assetUsage.length,
    componentCount: componentSummaries.length,
    diagnosticCount: exportReport?.diagnostics.length ?? 0,
    warningCount: canvasLayout.warnings.length,
    missingAssetCount: missingIds.size,
    aiModel: aiSettingsComplete(aiSettings) ? aiSettings.model : undefined,
  });
  const activeInspectorTab = inspectorTabRows.find(tab => tab.id === inspectorTab) ?? inspectorTabRows[0]!;

  return <div className={`studio${leftPanelOpen ? "" : " left-collapsed"}${rightPanelOpen ? "" : " right-collapsed"}`}>
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">A</span>
        <strong className="brand-name">AI Design Studio</strong>
      </div>
      <Tooltip label="切换项目">
        <select className="project-select" aria-label="切换项目" disabled={busy} value={document.id} onChange={event => void run(() => openProject(event.target.value))}>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select>
      </Tooltip>
      <div className="toolbar-group" role="group" aria-label="面板">
        <Tooltip label={leftPanelOpen ? "收起图层面板" : "展开图层面板"}><button className="icon-only" aria-label="图层面板" aria-pressed={leftPanelOpen} onClick={() => setLeftPanelOpen(open => !open)}><Icon name="panelLeft" /></button></Tooltip>
        <Tooltip label={rightPanelOpen ? "收起右侧面板" : "展开右侧面板"}><button className="icon-only" aria-label="右侧面板" aria-pressed={rightPanelOpen} onClick={() => setRightPanelOpen(open => !open)}><Icon name="panelRight" /></button></Tooltip>
      </div>
      <span className="toolbar-separator" aria-hidden="true" />
      <div className="toolbar-group" role="group" aria-label="画布工具">
        {TOOLS.filter(spec => spec.id !== "hand").map(spec => (
          <Tooltip key={spec.id} label={`${spec.label} · ${spec.shortcut.toUpperCase()}`}>
            <button className="icon-only" aria-label={spec.label} aria-pressed={tool === spec.id} disabled={busy} onClick={() => setTool(spec.id)}>
              <Icon name={spec.icon} />
            </button>
          </Tooltip>
        ))}
        <span className="tool-divider" aria-hidden="true" />
        <Tooltip label="添加图片"><button className="icon-only" aria-label="添加图片" disabled={busy} onClick={() => imageInput.current?.click()}><Icon name="nodeImage" /></button></Tooltip>
      </div>
      <input ref={imageInput} className="hidden-input" type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) insertImage(file); }} />
      <span className="toolbar-separator" aria-hidden="true" />
      <div className="toolbar-group" role="group" aria-label="历史">
        <Tooltip label="撤销 · Ctrl/Cmd+Z"><button className="icon-only" aria-label="撤销" disabled={busy || !project.canUndo()} onClick={() => void run(() => applyHistory("undo"))}><Icon name="undo" /></button></Tooltip>
        <Tooltip label="重做 · Shift+Ctrl/Cmd+Z"><button className="icon-only" aria-label="重做" disabled={busy || !project.canRedo()} onClick={() => void run(() => applyHistory("redo"))}><Icon name="redo" /></button></Tooltip>
      </div>
      <div className="toolbar-group" role="group" aria-label="原型">
        <Tooltip label="预览原型（从选中的 Frame 开始）"><button className="icon-only" aria-label="预览原型" disabled={busy} onClick={startPrototypePreview}><Icon name="prototypePlay" /></button></Tooltip>
      </div>
      <div className="toolbar-group" role="group" aria-label="项目">
        <Tooltip label="新建项目"><button className="icon-only" aria-label="新建项目" disabled={busy} onClick={createProject}><Icon name="newProject" /></button></Tooltip>
        <Tooltip label="重命名项目"><button className="icon-only" aria-label="重命名项目" disabled={busy} onClick={renameProject}><Icon name="rename" /></button></Tooltip>
      </div>
      <span className="toolbar-spacer" aria-hidden="true" />
      <div className="toolbar-group" role="group" aria-label="导出">
        <select className="export-scope" aria-label="导出范围" disabled={busy} value={exportScope} title="导出范围" onChange={event => setExportScope(event.target.value as "page" | "selection")}><option value="page">导出：整页</option><option value="selection" disabled={!selectedIds.length}>导出：选区</option></select>
        <Tooltip label="导出 HTML"><button className="icon-only" aria-label="导出 HTML" disabled={busy} onClick={exportHtml}><Icon name="exportHtml" /></button></Tooltip>
        <Tooltip label="导出 SVG"><button className="icon-only" aria-label="导出 SVG" disabled={busy} onClick={exportSvg}><Icon name="exportSvg" /></button></Tooltip>
        <Tooltip label="导出 PNG"><button className="icon-only" aria-label="导出 PNG" disabled={busy} onClick={exportPng}><Icon name="exportPng" /></button></Tooltip>
        <Tooltip label="导出 JSON"><button className="icon-only" aria-label="导出 JSON" disabled={busy} onClick={exportJson}><Icon name="exportJson" /></button></Tooltip>
        <Tooltip label="导入 JSON（可多选）"><button className="icon-only" aria-label="导入 JSON" disabled={busy} onClick={() => importInput.current?.click()}><Icon name="import" /></button></Tooltip>
      </div>
      <input ref={importInput} className="hidden-input" type="file" accept="application/json,.json" multiple onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) importJsonFiles(files); }} />
      <span className="toolbar-separator" aria-hidden="true" />
      <Tooltip label="删除当前项目"><button className="icon-only header-danger" aria-label="删除当前项目" disabled={busy} onClick={deleteCurrentProject}><Icon name="trash" /></button></Tooltip>
      <span className={`autosave-status autosave-${autosave.state}`} title={autosaveTitle(autosave)}>{autosaveLabel(autosave)}</span>
      <span className="status" title={message}>{message}</span>
    </header>

    <aside className="layers">
      <div className="panel-block pages-block">
        <div className="panel-head">
          <h2>页面</h2>
          <span className="panel-count">{document.pageOrder.length}</span>
          <Tooltip label="新增页面"><button className="icon-only" aria-label="新增页面" disabled={busy} onClick={createPage}><Icon name="pageAdd" /></button></Tooltip>
        </div>
        <div className="page-list" role="listbox" aria-label="页面列表">
          {document.pageOrder.map(id => {
            const item = document.pages[id];
            const active = id === page.id;
            return <button key={id} type="button" role="option" aria-selected={active} className={`page-row${active ? " active" : ""}`} disabled={busy} onClick={() => { if (!active) switchPage(id); }}>
              <Icon name="page" size={12} />
              <span className="page-row-name" title={item?.name}>{item?.name ?? id}</span>
              {item && item.childIds.length > 0 && <span className="page-row-meta">{item.childIds.length}</span>}
            </button>;
          })}
        </div>
        <div className="page-actions">
          <button disabled={busy} onClick={renamePage}><Icon name="rename" />重命名</button>
          <Tooltip label={page.childIds.length ? "请先清空页面" : "删除当前页面"}><button disabled={busy || document.pageOrder.length === 1 || page.childIds.length > 0} onClick={deletePage}><Icon name="pageDelete" />删除</button></Tooltip>
        </div>
      </div>
      <div className="panel-block layers-block">
        <div className="panel-head">
          <h2>图层</h2>
          <span className="panel-count">{page.childIds.length}</span>
          <Tooltip label="全选页面顶层对象 · Ctrl/Cmd+A"><button className="icon-only" aria-label="全选" disabled={busy || !page.childIds.length} onClick={selectAll}><Icon name="selectAll" /></button></Tooltip>
        </div>
        <div className="layer-tools" role="toolbar" aria-label="图层操作">
          <div className="layer-tool-row">
            <Tooltip label="复制 · Ctrl/Cmd+C"><button className="icon-only" aria-label="复制" disabled={busy || !selectedIds.length} onClick={copySelection}><Icon name="copy" /></button></Tooltip>
            <Tooltip label="粘贴 · Ctrl/Cmd+V"><button className="icon-only" aria-label="粘贴" disabled={busy || !clipboard.current} onClick={pasteSelection}><Icon name="paste" /></button></Tooltip>
            <Tooltip label="重复 · Ctrl/Cmd+D"><button className="icon-only" aria-label="重复" disabled={busy || !selectedIds.length} onClick={duplicateSelection}><Icon name="duplicate" /></button></Tooltip>
            <span className="tool-divider" aria-hidden="true" />
            <Tooltip label="编组 · Ctrl/Cmd+G"><button className="icon-only" aria-label="编组" disabled={busy || selectedIds.length < 2 || !selectionSameParent} onClick={groupSelection}><Icon name="group" /></button></Tooltip>
            <Tooltip label="取消编组 · Shift+Ctrl/Cmd+G"><button className="icon-only" aria-label="取消编组" disabled={busy || selectedIds.length !== 1 || selected.type !== "frame" || !selected.childIds.length} onClick={ungroupSelection}><Icon name="ungroup" /></button></Tooltip>
          </div>
          <div className="layer-tool-row">
            <span className="layer-tool-label">顺序</span>
            <Tooltip label="置底"><button className="icon-only" aria-label="置底" disabled={busy || selectedLayerIndex <= 0} onClick={() => reorderLayer(0)}><Icon name="toBack" /></button></Tooltip>
            <Tooltip label="下移 · Ctrl/Cmd+["><button className="icon-only" aria-label="下移" disabled={busy || selectedLayerIndex <= 0} onClick={() => reorderLayer(selectedLayerIndex - 1)}><Icon name="moveDown" /></button></Tooltip>
            <Tooltip label="上移 · Ctrl/Cmd+]"><button className="icon-only" aria-label="上移" disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= (selectedOwner?.childIds.length ?? 0) - 1} onClick={() => reorderLayer(selectedLayerIndex + 1)}><Icon name="moveUp" /></button></Tooltip>
            <Tooltip label="置顶"><button className="icon-only" aria-label="置顶" disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= (selectedOwner?.childIds.length ?? 0) - 1} onClick={() => reorderLayer((selectedOwner?.childIds.length ?? 1) - 1)}><Icon name="toFront" /></button></Tooltip>
          </div>
        </div>
        <LayerTree document={document} rootIds={page.childIds} selectedIds={selectedIds} onSelect={(nodeId, event) => setSelectedIds(current => event.shiftKey ? toggleId(current, nodeId) : [nodeId])} onReorder={reorderFromTree} />
      </div>
    </aside>    <section className="workspace">
      <div className={`canvas-scroller${panMode ? " pan-mode" : ""}${panning ? " panning" : ""}`} ref={setScroller} onScroll={syncCanvasViewport} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
        <ContextMenuRoot>
          <ContextMenuTrigger onContextMenu={handleCanvasContextMenu}>
            <div className="canvas-stage">
              <div className="canvas-frame" aria-hidden="true">
                <span className="canvas-frame-name">{page.name}</span>
                <span className="canvas-frame-size">{CANVAS_WIDTH} × {CANVAS_HEIGHT}</span>
              </div>
              <div ref={setCanvas} className={`canvas${panMode ? " pan-mode" : ""} tool-${tool}${canvasDrag.hoverRotate && tool === "select" ? " rotate-hover" : ""}${pathEditId && pathEdit.hoverSegment ? " segment-hover" : ""}`} style={{ zoom }} {...(tool === "pen" ? pen.handlers : pathEditId ? pathEdit.handlers : canvasDrag.handlers)} onClick={selectFromCanvas} onDoubleClick={event => { if (tool === "pen") { pen.finish(); return; } handleCanvasDoubleClick(event); }}>
                <CanvasSurface repository={repository} projectId={document.id} document={themedDocument ?? document} pageId={page.id} boxes={canvasLayout.boxes} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} zoom={zoom} viewport={canvasViewport.width > 0 ? canvasViewport : undefined} selection={selectedIds} previewBoxes={{ ...canvasDrag.previewBoxes, ...constraintPreview }} marquee={canvasDrag.marquee} drawRect={canvasDrag.drawRect} drawShape={isDrawTool(tool) ? tool : undefined} penPath={pen.previewPath} penAnchors={pen.previewAnchors} penClosing={pen.previewClosing} rotationOverride={canvasDrag.previewRotation} showRotateHandle={selectedIds.length === 1 && !pathEditId} pathOverride={pathEditTarget && pathEdit.previewCommands.length ? { id: pathEditTarget.id, commands: normalizePath(pathEdit.previewCommands, pathEditTarget.box) } : undefined} editAnchors={pathEditId ? pathEdit.anchors : undefined} editHandles={pathEditId ? pathEdit.handles : undefined} editSelected={pathEdit.selected} guides={canvasDrag.guides} onWarning={setMessage} />{canvasEditingId && document?.nodes[canvasEditingId]?.type === "text" && canvasLayout.boxes[canvasEditingId] ? (<TextEditOverlay key={canvasEditingId} node={applyTypographyToken(document, document.nodes[canvasEditingId]!)} box={canvasLayout.boxes[canvasEditingId]!} onCommit={text => { patchTextOf(canvasEditingId, { text }); setCanvasEditingId(null); }} onCancel={() => setCanvasEditingId(null)} />) : null}<CanvasA11yLayer document={document} pageId={page.id} selectedIds={selectedIds} onSelect={setSelectedIds} onDelete={id => { const node = document.nodes[id]; if (!node) return; const targetIds = deletableRoots([{ id, locked: Boolean(node.locked) }]); if (!targetIds.length) { setMessage("选中的对象被锁定了，先解锁再删除"); return; } void run(async () => { await execute(targetIds.map(targetId => ({ type: "node.delete" as const, payload: { id: targetId } }))); setSelectedIds(current => current.filter(selectedId => selectedId !== id)); }); }} />
              </div>
              {multiSelectionBounds && !panMode ? <div className="selection-toolbar" role="toolbar" aria-label="对齐与分布" style={{ left: (multiSelectionBounds.x + multiSelectionBounds.width / 2) * zoom, top: multiToolbarTop }}>
                <Tooltip label="左对齐"><button className="icon-only" aria-label="左对齐" disabled={busy || !canArrange} onClick={() => arrangeSelection("left")}><Icon name="alignLeft" /></button></Tooltip>
                <Tooltip label="水平居中"><button className="icon-only" aria-label="水平居中" disabled={busy || !canArrange} onClick={() => arrangeSelection("centerX")}><Icon name="alignCenterX" /></button></Tooltip>
                <Tooltip label="右对齐"><button className="icon-only" aria-label="右对齐" disabled={busy || !canArrange} onClick={() => arrangeSelection("right")}><Icon name="alignRight" /></button></Tooltip>
                <span className="tool-divider" aria-hidden="true" />
                <Tooltip label="水平等距分布"><button className="icon-only" aria-label="水平等距分布" disabled={busy || selectedIds.length < 3 || !canArrange} onClick={() => arrangeSelection("distributeX")}><Icon name="distributeX" /></button></Tooltip>
                <span className="tool-divider" aria-hidden="true" />
                <Tooltip label="顶对齐"><button className="icon-only" aria-label="顶对齐" disabled={busy || !canArrange} onClick={() => arrangeSelection("top")}><Icon name="alignTop" /></button></Tooltip>
                <Tooltip label="垂直居中"><button className="icon-only" aria-label="垂直居中" disabled={busy || !canArrange} onClick={() => arrangeSelection("centerY")}><Icon name="alignCenterY" /></button></Tooltip>
                <Tooltip label="底对齐"><button className="icon-only" aria-label="底对齐" disabled={busy || !canArrange} onClick={() => arrangeSelection("bottom")}><Icon name="alignBottom" /></button></Tooltip>
                <span className="tool-divider" aria-hidden="true" />
                <Tooltip label="垂直等距分布"><button className="icon-only" aria-label="垂直等距分布" disabled={busy || selectedIds.length < 3 || !canArrange} onClick={() => arrangeSelection("distributeY")}><Icon name="distributeY" /></button></Tooltip>
              </div> : null}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{contextIds.length ? <>
            <ContextMenuItem icon="copy" shortcut="Ctrl/Cmd+C" disabled={busy} onSelect={copySelection}>复制</ContextMenuItem>
            <ContextMenuItem icon="paste" shortcut="Ctrl/Cmd+V" disabled={busy || !clipboard.current} onSelect={pasteSelection}>粘贴</ContextMenuItem>
            <ContextMenuItem icon="duplicate" shortcut="Ctrl/Cmd+D" disabled={busy} onSelect={duplicateSelection}>重复</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem icon="trash" shortcut="Delete" danger disabled={busy} onSelect={deleteSelection}>删除</ContextMenuItem>
            <ContextMenuSeparator />{contextIds.length === 1 && <ContextMenuSub label="图层顺序" icon="layerOrder">
              <ContextMenuItem icon="toFront" disabled={busy} onSelect={() => reorderLayer((selectedOwner?.childIds.length ?? 1) - 1)}>置顶</ContextMenuItem>
              <ContextMenuItem icon="toBack" disabled={busy} onSelect={() => reorderLayer(0)}>置底</ContextMenuItem>
              <ContextMenuItem icon="moveUp" disabled={busy} onSelect={() => reorderLayer(selectedLayerIndex + 1)}>上移</ContextMenuItem>
              <ContextMenuItem icon="moveDown" disabled={busy} onSelect={() => reorderLayer(selectedLayerIndex - 1)}>下移</ContextMenuItem>
            </ContextMenuSub>}{contextIds.length > 1 && <ContextMenuSub label="对齐" icon="alignGroup">
              <ContextMenuItem icon="alignLeft" disabled={busy} onSelect={() => arrangeSelection("left")}>左对齐</ContextMenuItem>
              <ContextMenuItem icon="alignCenterX" disabled={busy} onSelect={() => arrangeSelection("centerX")}>水平居中</ContextMenuItem>
              <ContextMenuItem icon="alignRight" disabled={busy} onSelect={() => arrangeSelection("right")}>右对齐</ContextMenuItem>
              <ContextMenuItem icon="alignTop" disabled={busy} onSelect={() => arrangeSelection("top")}>顶对齐</ContextMenuItem>
              <ContextMenuItem icon="alignCenterY" disabled={busy} onSelect={() => arrangeSelection("centerY")}>垂直居中</ContextMenuItem>
              <ContextMenuItem icon="alignBottom" disabled={busy} onSelect={() => arrangeSelection("bottom")}>底对齐</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem icon="distributeX" disabled={busy || contextIds.length < 3} onSelect={() => arrangeSelection("distributeX")}>水平等距分布</ContextMenuItem>
              <ContextMenuItem icon="distributeY" disabled={busy || contextIds.length < 3} onSelect={() => arrangeSelection("distributeY")}>垂直等距分布</ContextMenuItem>
            </ContextMenuSub>}{contextIds.length === 1 && selected && ["vector", "rectangle", "ellipse"].includes(selected.type) && <ContextMenuItem icon="mask" disabled={busy} onSelect={() => patchNode(selected.id, { mask: selected.mask ? undefined : true })}>{selected.mask ? "取消蒙版" : "用作蒙版"}</ContextMenuItem>}{contextIds.length > 1 && <ContextMenuSub label="布尔运算" icon="booleanUnion">
              {BOOLEAN_OPERATIONS.map(spec => (
                <ContextMenuItem
                  key={spec.id}
                  icon={spec.icon}
                  disabled={busy || !canBoolean(contextIds)}
                  onSelect={() => applyBooleanToSelection(spec.id, contextIds)}
                >
                  {spec.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSub>}<ContextMenuItem icon="nodeComponent" disabled={busy || !selectionSameParent} onSelect={groupSelection}>编组</ContextMenuItem>{contextIds.length === 1 && <ContextMenuItem icon={selected?.locked ? "unlock" : "lock"} disabled={busy} onSelect={() => { if (selected) patchNode(selected.id, { locked: !selected.locked }); }}>{selected?.locked ? "解锁" : "锁定"}</ContextMenuItem>}{contextIds.length === 1 && <ContextMenuItem icon="tokenUnbind" disabled={busy} onSelect={ungroupSelection}>取消编组</ContextMenuItem>}{contextIds.length === 1 && selected?.type === "instance" && <ContextMenuItem icon="tokenUnbind" disabled={busy} onSelect={detachComponent}>脱离组件</ContextMenuItem>}</> : <>
            <ContextMenuItem icon="paste" shortcut="Ctrl/Cmd+V" disabled={busy || !clipboard.current} onSelect={pasteSelection}>粘贴</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuSub label="添加" icon="addFrame">
              <ContextMenuItem icon="addFrame" disabled={busy} onSelect={() => addNode("frame")}>Frame</ContextMenuItem>
              <ContextMenuItem icon="addRectangle" disabled={busy} onSelect={() => addNode("rectangle")}>矩形</ContextMenuItem>
              <ContextMenuItem icon="addEllipse" disabled={busy} onSelect={() => addNode("ellipse")}>椭圆</ContextMenuItem>
              <ContextMenuItem icon="addText" disabled={busy} onSelect={() => addNode("text")}>文本</ContextMenuItem>
            </ContextMenuSub>
          </>}</ContextMenuContent>
        </ContextMenuRoot>
      </div>
      <div className="canvas-controls">
        <Tooltip label={panMode ? "退出抓手 · H" : "抓手拖动画布 · H"}><button className={`icon-only${panMode ? " active" : ""}`} aria-label="抓手" aria-pressed={panMode} onClick={() => setTool(current => current === "hand" ? "select" : "hand")}><Icon name="pan" /></button></Tooltip>
        <Tooltip label="缩小"><button className="icon-only" aria-label="缩小" onClick={() => setZoom(current => zoomStep(current, -1))}><Icon name="zoomOut" /></button></Tooltip>
        <Tooltip label="重置为 100%"><button className="zoom-value" onClick={() => setZoom(1)}>{zoomPercent(zoom)}%</button></Tooltip>
        <Tooltip label="放大"><button className="icon-only" aria-label="放大" onClick={() => setZoom(current => zoomStep(current, 1))}><Icon name="zoomIn" /></button></Tooltip>
        <Tooltip label="适应内容"><button className="icon-only zoom-fit" aria-label="适应内容" onClick={fitCanvas}><Icon name="zoomFit" /></button></Tooltip>
      </div>
    </section>
    <aside className="inspector">
      <div className="inspector-head">
        <h2>{activeInspectorTab.label}</h2>
        <span className="inspector-head-meta" title={activeInspectorTab.meta}>{activeInspectorTab.meta}</span>
      </div>
      <Tabs.Root className="inspector-tabs-root" value={inspectorTab} onValueChange={value => setInspectorTab(value as InspectorTabId)}>
        <Tabs.List className="inspector-tabs" aria-label="右侧面板分段">
          {/* Radix 的 roving focus 只在值变化后才把选中项设成 tabIndex=0，
              首次挂载时整排都是 -1，键盘 Tab 进不了分段栏；这里按当前值显式补上。 */}
          {inspectorTabRows.map(tab => (
            <Tabs.Trigger key={tab.id} value={tab.id} className="inspector-tab" tabIndex={inspectorTab === tab.id ? 0 : -1}>
              {tab.label}
              {tab.badge ? <span className="inspector-tab-badge">{tab.badge}</span> : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="properties" className="inspector-body">
          {selectedIds.length > 1 && (
            <section className="inspector-section">
              <h2>对齐与分布</h2>
              <div className="icon-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
                <Tooltip label="左对齐"><button className="icon-only" disabled={busy} aria-label="左对齐" onClick={() => arrangeSelection("left")}><Icon name="alignLeft" /></button></Tooltip>
                <Tooltip label="水平居中"><button className="icon-only" disabled={busy} aria-label="水平居中" onClick={() => arrangeSelection("centerX")}><Icon name="alignCenterX" /></button></Tooltip>
                <Tooltip label="右对齐"><button className="icon-only" disabled={busy} aria-label="右对齐" onClick={() => arrangeSelection("right")}><Icon name="alignRight" /></button></Tooltip>
                <Tooltip label="顶对齐"><button className="icon-only" disabled={busy} aria-label="顶对齐" onClick={() => arrangeSelection("top")}><Icon name="alignTop" /></button></Tooltip>
                <Tooltip label="垂直居中"><button className="icon-only" disabled={busy} aria-label="垂直居中" onClick={() => arrangeSelection("centerY")}><Icon name="alignCenterY" /></button></Tooltip>
                <Tooltip label="底对齐"><button className="icon-only" disabled={busy} aria-label="底对齐" onClick={() => arrangeSelection("bottom")}><Icon name="alignBottom" /></button></Tooltip>
                <Tooltip label="水平分布"><button className="icon-only" disabled={busy || selectedIds.length < 3} aria-label="水平分布" onClick={() => arrangeSelection("distributeX")}><Icon name="distributeX" /></button></Tooltip>
                <Tooltip label="垂直分布"><button className="icon-only" disabled={busy || selectedIds.length < 3} aria-label="垂直分布" onClick={() => arrangeSelection("distributeY")}><Icon name="distributeY" /></button></Tooltip>
              </div>
            </section>
          )}
          {selected && selectedIds.length === 1
            ? (
              <section className="inspector-section">
                <Field label="名称" value={selected.name} onCommit={value => patch({ name: value })} />
                <PropertyPanel node={selected} parent={document.nodes[selected.parentId]} disabled={busy} onPatch={patch} onPatchText={patchText} onSetParagraphStyle={setParagraphStyle} onPatchImage={patchValue => patchImageOf(selected.id, patchValue)} onReplaceImage={() => replaceImageInput.current?.click()} fontSuggestions={fontSuggestions} nodeName={nodeId => document.nodes[nodeId]?.name ?? nodeId}
                  onSetBooleanOperation={operation => void run(() => execute([{ type: "boolean.setOperation", payload: { id: selected.id, operation } }]))}
                  onReleaseBoolean={() => void run(async () => {
                    const children = [...(document.nodes[selected.id]?.childIds ?? [])];
                    await execute([{ type: "boolean.release", payload: { id: selected.id } }]);
                    setSelectedIds(children);
                  })} />
                <input ref={replaceImageInput} className="hidden-input" type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) replaceSelectedImage(file); }} />
                {selected.type === "frame" && findOwningComponentId(document, selected.id) && <Toggle label="作为插槽" checked={Boolean(selected.slot)} onChange={slot => patchNode(selected.id, { slot })} />}
                {selected.type === "instance" && <button disabled={busy || !clipboard.current} onClick={fillInstanceSlot}><Icon name="nodeComponent" />用剪贴板填充插槽</button>}
                {selected.type === "instance" && <InstancePanel document={document} instance={selected} disabled={busy} variants={variantOptions(document, selected.componentId)} onSwitchVariant={componentId => void run(() => execute([{ type: "component.switchVariant", payload: { id: selected.id, componentId } }]))} onOverride={(sourceNodeId, patch) => void run(() => execute([{ type: "component.override", payload: { instanceId: selected.id, sourceNodeId, patch } }]))} onReset={sourceNodeId => void run(() => execute([{ type: "component.resetOverride", payload: { instanceId: selected.id, sourceNodeId } }]))} onResetAll={resetAllOverrides} onDetach={detachComponent} onSetProperty={(propertyId, value) => void setInstanceProperty(selected.id, propertyId, value)} onResetProperty={propertyId => void resetInstanceProperty(selected.id, propertyId)} />}
                {owningComponentId && (
                  <ComponentPropsPanel
                    document={document}
                    componentId={owningComponentId}
                    selectedNodeId={selected.id}
                    canExpose={isInsideSubtree(document, selected.id, document.components[owningComponentId]?.rootNodeId ?? selected.id)}
                    disabled={busy}
                    onExpose={field => void exposeComponentProperty(field)}
                    onRemove={propertyId => void removeComponentProperty(owningComponentId, propertyId)}
                    onUnbind={(propertyId, nodeId, field) => void unbindComponentProperty(owningComponentId, propertyId, nodeId, field)}
                  />
                )}
                <Toggle label="显示" checked={selected.visible} onChange={visible => patchNode(selected.id, { visible })} />
                <Toggle label="锁定" checked={selected.locked} onChange={locked => patchNode(selected.id, { locked })} />
                <button disabled={busy} className="danger" onClick={deleteSelection}><Icon name="trash" />删除</button>
              </section>
            )
            : selectedIds.length > 1
              ? (
                <section className="inspector-section">
                  <BatchPanel nodes={selectedNodes} disabled={busy} onPatchAppearance={patchBatchAppearance} onPatchLayout={patchBatchLayout} onPatchText={patchBatchText} />
                  {selectedNodes.every(node => node.type === "instance") && <button disabled={busy} onClick={detachSelectedInstances}><Icon name="nodeComponent" />批量脱离 {selectedNodes.length} 个实例</button>}
                  <button disabled={busy} className="danger" onClick={deleteSelection}><Icon name="trash" />删除 {selectedIds.length} 个节点</button>
                </section>
              )
              : <div className="inspector-empty">
                <span className="inspector-empty-title">未选择图层</span>
                <span>在画布或左侧图层列表中选择一个对象，这里会显示它的布局、外观和文字属性。</span>
                <span>按住 <kbd>Shift</kbd> 点击可多选，<kbd>Ctrl/Cmd</kbd> + <kbd>A</kbd> 全选顶层对象。</span>
              </div>}
          {contrastIssues.length > 0 && (
            <section className="inspector-section">
              <h2>可访问性 · 对比度</h2>
              <div className="warning-list">
                {contrastIssues.map(issue => (
                  <button
                    key={issue.nodeId}
                    className="warning-row"
                    onClick={() => setSelectedIds([issue.nodeId])}
                    title={`${issue.foreground || "未设置"} 在 ${issue.background} 上`}
                  >
                    <span className="warning-code warning-code-contrast">AA</span>
                    <span className="warning-message">{issue.text || issue.nodeId} · {issue.ratio.toFixed(2)}:1（需 {issue.threshold}:1）</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {canvasLayout.warnings.length > 0 && (
            <section className="inspector-section">
              <h2>布局警告</h2>
              <div className="warning-list">{canvasLayout.warnings.map((warning, index) => <button key={`${warning.nodeId}:${warning.code}:${index}`} className="warning-row" onClick={() => warning.nodeId && setSelectedIds([warning.nodeId])} title={warning.nodeId ? `选中 ${warning.nodeId}` : warning.message}><span className={`warning-code warning-code-${warning.code}`}>{warning.code}</span><span className="warning-message">{warning.message}</span></button>)}</div>
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="export" className="inspector-body">
          <section className="inspector-section">
            <h2>导出交付物</h2>
            <p className="field-hint">「导出 HTML」产出单个自包含文件（图片与字体内联，体积涨约三分之一）；「资源包」把图片与字体拆成独立文件、体积不涨，字体也不受内联上限约束。</p>
            <div className="layer-actions" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
              <Tooltip label="导出单个自包含的 HTML 文件"><button disabled={busy} onClick={exportHtml}><Icon name="exportHtml" />导出 HTML</button></Tooltip>
              <Tooltip label="导出资源包（HTML + 图片/字体文件，打成 ZIP）"><button disabled={busy} onClick={exportPackage}><Icon name="exportPackage" />导出资源包</button></Tooltip>
              <Tooltip label="导出 React 组件（文字与图片地址提成 props）"><button disabled={busy} onClick={exportReact}><Icon name="exportHtml" />导出 React</button></Tooltip>
              <Tooltip label="导出 PDF（整份文档，每页一页；图片型，文字不可选）"><button disabled={busy} onClick={exportPdf}><Icon name="exportPng" />导出 PDF</button></Tooltip>
            </div>
          </section>
          <section className="inspector-section">
            <h2>预览交付物</h2>
            <div className="layer-actions" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              <Tooltip label="在隔离沙箱里预览 HTML 交付物"><button disabled={busy} onClick={previewHtml}><Icon name="exportHtml" />预览 HTML</button></Tooltip>
              <Tooltip label="预览 SVG 交付物"><button disabled={busy} onClick={previewSvg}><Icon name="exportSvg" />预览 SVG</button></Tooltip>
              <Tooltip label="预览 PNG 交付物（会先光栅化）"><button disabled={busy} onClick={previewPng}><Icon name="exportPng" />预览 PNG</button></Tooltip>
            </div>
          </section>
          <section className="inspector-section">
            <h2>版本对比</h2>
            <p className="field-hint">选一个历史版本，和当前版本并排看同一份交付物：左边历史，右边当前。</p>
            <div className="snapshot-list">{compareVersionRows.length
              ? compareVersionRows.map(row => <div className="snapshot-row" key={row.revision}>
                <span className="snapshot-label">{row.label}</span>
                <span className="snapshot-time" title={row.updatedAt}>{formatSnapshotTime(row.updatedAt)}</span>
                <Tooltip label={`和当前版本并排对比 ${row.label}`}>
                  <button className="icon-only" aria-label={`和当前版本并排对比 ${row.label}`} disabled={busy} onClick={() => previewCompareVersion(row)}><Icon name="compareVersions" /></button>
                </Tooltip>
              </div>)
              : <p className="empty-hint">还没有可对比的历史版本。改动落盘之后，这里会列出可以并排对比的版本。</p>}</div>
          </section>
          <section className="inspector-section">
            <h2>导出诊断</h2>
            <ExportDiagnosticsPanel format={exportReport?.format} diagnostics={exportReport?.diagnostics ?? []} onSelect={nodeId => { if (document.nodes[nodeId]) setSelectedIds([nodeId]); }} />
          </section>
        </Tabs.Content>
        <Tabs.Content value="history" className="inspector-body">
          <section className="inspector-section">
            <h2>历史版本</h2>
            <div className="snapshot-list">{versionRows.length
              ? versionRows.map(row => <div className="snapshot-row" key={row.revision}><span className="snapshot-label">{row.label}</span><span className="snapshot-time" title={row.updatedAt}>{formatSnapshotTime(row.updatedAt)}</span>{row.schemaVersion < CURRENT_SCHEMA_VERSION && <span className="snapshot-legacy">旧格式</span>}{row.current
                ? <span className="snapshot-current">当前</span>
                : <Tooltip label={`还原到 ${row.label}`}><button className="icon-only" aria-label={`还原到 ${row.label}`} disabled={busy} onClick={() => restoreVersion(row)}><Icon name="versionRestore" /></button></Tooltip>}</div>)
              : <p className="empty-hint">还没有历史版本。改动落盘之后，这里会列出可以回滚到的版本。</p>}</div>
          </section>
          <section className="inspector-section">
            <h2>操作历史</h2>
            <HistoryPanel rows={transactionRows} disabled={busy} onRestore={restoreTransaction} />
          </section>
          <section className="inspector-section">
            <h2>自动备份</h2>
            <div className="backup-list">{backups.length
              ? backups.map(row => <div className="backup-row" key={row.createdAt}><span className="backup-time">{formatSnapshotTime(row.createdAt)}</span><span className="backup-meta">r{row.revision} · {formatBytes(row.byteLength)}</span><Tooltip label="把这份备份下载成 JSON"><button className="icon-only" aria-label="下载备份" disabled={busy} onClick={() => downloadBackup(row)}><Icon name="exportJson" /></button></Tooltip><Tooltip label="还原到这份备份"><button className="icon-only" aria-label="还原备份" disabled={busy} onClick={() => restoreBackup(row)}><Icon name="versionRestore" /></button></Tooltip></div>)
              : <p className="empty-hint">还没有自动备份。每次落盘后最多每 10 分钟保存一份，保留最近 3 份。</p>}</div>
          </section>
          {recovery && (
            <section className="inspector-section">
              <h2>恢复报告</h2>
              <div className="recovery-report">{recoveryReportRows({ ...recovery, missingAssets }).map(row => <div className="recovery-row" key={row.label}><span className="recovery-label">{row.label}</span><span className={row.tone === "warning" ? "recovery-value recovery-warning" : "recovery-value"}>{row.value}</span></div>)}</div>
              <button disabled={busy} onClick={() => { downloadFile(recoveryReportFileName(recovery.projectName), JSON.stringify({ ...recovery, missingAssets }, null, 2), "application/json"); setMessage("恢复报告已导出"); }}><Icon name="exportJson" />导出报告</button>
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="data" className="inspector-body">
          <section className="inspector-section">
            <h2>存储用量</h2>
            <StoragePanel estimate={storage} usage={storageUsage} disabled={busy} onRefresh={() => { refreshStorage(); refreshStorageUsage(); }} onExportBackup={exportJson} onTrimHistory={trimProjectHistory} onDeleteProject={deleteStorageProject} />
          </section>
          <section className="inspector-section">
            <h2>设计检查</h2>
            <LintPanel issues={lintIssues} disabled={busy} onSelect={nodeId => setSelectedIds([nodeId])} />
          </section>
          <section className="inspector-section">
            <h2>磁盘备份</h2>
            <DiskBackupPanel
              supported={diskBackupSupported}
              directoryName={diskBackupDirectory}
              status={diskBackup}
              disabled={busy}
              onEnable={enableDiskBackup}
              onDisable={disableDiskBackup}
              onBackupNow={backupToDiskNow}
              encrypted={diskBackupEncrypted}
              encryptionSupported={supportsBackupEncryption()}
              onEnableEncryption={enableDiskBackupEncryption}
              onDisableEncryption={disableDiskBackupEncryption}
            />
          </section>
          <section className="inspector-section">
            <h2>主题</h2>
            <div className="theme-panel">
              <label className="field">
                <span className="field-label">当前主题</span>
                <select
                  value={activeThemeId ?? ""}
                  disabled={busy}
                  onChange={event => setActiveThemeId(event.target.value || undefined)}
                >
                  <option value="">基础（{document.tokens ? Object.keys(document.tokens).length : 0} 个 token）</option>
                  {(document.themes ?? []).map(theme => (
                    <option key={theme.id} value={theme.id}>{theme.name}（{Object.keys(theme.tokens).length} 项覆盖{theme.extends ? " · 继承" : ""}）</option>
                  ))}
                </select>
              </label>
              {activeTheme?.extends ? (
                <p className="empty-hint">
                  当前主题继承自「{findTheme(document, activeTheme.extends)?.name ?? activeTheme.extends}」：
                  继承来的值在父主题里改，在这里改会形成覆盖。
                </p>
              ) : null}
              <div className="storage-actions">
                <button disabled={busy} onClick={createTheme}>新增主题</button>
                <button disabled={busy || !activeThemeId} onClick={deleteActiveTheme}>删除当前主题</button>
                <button disabled={busy || !activeThemeId || !Object.keys(activeTheme?.tokens ?? {}).length} onClick={resetWholeTheme}>清空该主题的覆盖</button>
              </div>
              <p className="empty-hint">
                切换主题只影响预览与导出，不改基础 token。选中主题后，
                在下方「设计 Tokens」里改值会写成该主题的覆盖；「恢复基础值」可以撤销覆盖。
              </p>
            </div>
          </section>
          <section className="inspector-section">
            <TokenPanel
              tokens={themedTokens}
              bindings={selected?.bindings}
              disabled={busy}
              canBind={Boolean(selected)}
              onCreate={createToken}
              onImport={importTokensFromStyleSheet}
              onUpdate={updateToken}
              onBind={bindToken}
              onUnbind={unbindToken}
              onDelete={name => void run(() => execute([{ type: "token.delete", payload: { name } }]))}
              overridden={activeThemeId ? name => isTokenOverridden(document, activeThemeId, name) : undefined}
              inheritedFrom={activeThemeId
                ? name => {
                    const source = inheritedTokenSource(document, activeThemeId, name);
                    // 自己写了的显示「已覆盖」，继承来的才显示「继承」。
                    if (!source || source.id === activeThemeId) return undefined;
                    return source.name;
                  }
                : undefined}
              onResetOverride={activeThemeId ? resetThemeOverride : undefined}
              themeName={findTheme(document, activeThemeId)?.name}
            />
          </section>
          <section className="inspector-section">
            <h2>图片资源</h2>
            <AssetPanel usage={assetUsage} missingIds={missingIds} disabled={busy} onRelink={startRelink} onDelete={deleteAsset} onEditOrigin={editAssetOrigin} />
            <input ref={relinkInput} className="hidden-input" type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) relinkAssetFile(file); }} />
          </section>          <section className="inspector-section">
            <h2>字体</h2>
            <div className="font-list">
              {(document.fonts ?? []).length === 0
                ? <p className="empty-hint">还没有上传字体。文本使用系统里已安装的字体。</p>
                : (document.fonts ?? []).map(font => (
                  <div className="font-row" key={`${font.family}:${font.weight ?? 400}:${font.style ?? "normal"}`}>
                    <span className="font-family" title={font.family}>{font.family}</span>
                    <span className="font-meta">{font.weight ?? 400}{font.style === "italic" ? " · 斜体" : ""}</span>
                    <span className="font-source">{font.assetId ? "上传" : "系统"}</span>
                    <Tooltip label="删除字体（仍被文本使用时会被拒绝）"><button className="icon-only" aria-label="删除字体" disabled={busy} onClick={() => void run(() => execute([{ type: "font.remove", payload: { family: font.family, weight: font.weight, style: font.style } }]))}><Icon name="trash" /></button></Tooltip>
                  </div>
                ))}
            </div>
            <button type="button" disabled={busy} onClick={() => fontInput.current?.click()}><Icon name="uploadFont" />上传字体（woff2 / woff / ttf / otf）</button>
            {missingFonts.length > 0 && (
              <div className="font-missing" role="status">
                <strong>缺失字体</strong>
                <p>{missingFonts.join("、")} 既不在项目里，也没有装进系统；画布与导出会使用回退字形。</p>
              </div>
            )}
          </section>
          <input ref={fontInput} className="hidden-input" type="file" accept=".woff2,.woff,.ttf,.otf" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) insertFont(file); }} />
          <section className="inspector-section">
            <h2>组件</h2>
            <div className="component-create"><input type="text" placeholder="组件名称" value={componentName} onChange={event => setComponentName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") createComponentFromSelection(componentName); }} /><Tooltip label={selected?.type === "instance" ? "实例不能转为组件" : "将选中节点转为组件"}><button disabled={busy || !componentName.trim() || !selected || selectedIds.length !== 1 || selected.type === "instance"} onClick={() => createComponentFromSelection(componentName)}><Icon name="componentCreate" />创建</button></Tooltip></div>
            <div className="component-list">{componentSummaries.length
              ? componentSummaries.map(component => <div className="component-row" key={component.id}><span className="component-glyph"><Icon name="nodeComponent" size={12} /></span><span className="component-name" title={component.name}>{component.name}</span>{component.variantLabel && <span className="component-variant" title={component.variantLabel}>{component.variantLabel}</span>}<span className="component-count">{component.instanceCount}</span><Tooltip label="创建实例"><button className="icon-only" aria-label="创建实例" disabled={busy} onClick={() => instantiateComponent(component.id)}><Icon name="componentInstantiate" /></button></Tooltip><Tooltip label="创建变体"><button className="icon-only" aria-label="创建变体" disabled={busy} onClick={() => createComponentVariant(component.id)}><Icon name="componentVariant" /></button></Tooltip><Tooltip label="删除组件"><button className="icon-only" aria-label="删除组件" disabled={busy} onClick={() => removeComponent(component.id)}><Icon name="componentRemove" /></button></Tooltip></div>)
              : <p className="empty-hint">还没有组件。选中一个节点，输入名称后点击「创建」。</p>}</div>
          </section>
        </Tabs.Content>
        <Tabs.Content value="ai" className="inspector-body">
          <section className="inspector-section">
            <AiSettingsPanel settings={aiSettings} active={aiSettingsComplete(aiSettings)} disabled={busy} onSave={saveAiSettings} onClear={resetAiSettings} />
          </section>
          <section className="inspector-section">
            <h2>AI 安全编辑</h2>
            <textarea aria-label="AI 指令" placeholder="描述你想让 AI 做的修改…" value={prompt} onChange={event => setPrompt(event.target.value)} />
            <label className="field field-inline">
              <span className="field-label">带截图问 AI</span>
              <input
                type="checkbox"
                checked={aiVision}
                disabled={!visionSupported}
                title={visionSupported ? "把当前页面渲染成 PNG 一起发给模型" : "当前端点没有实测过看图能力，无法带截图"}
                onChange={event => setAiVision(event.target.checked)}
              />
            </label>
            {visionSupported ? <p className="empty-hint">带上截图后，模型能看出挤不挤、齐不齐、哪里难看——这些光看文字摘要看不出来。</p> : <p className="empty-hint">当前端点没有实测过看图能力，这个开关用不了。</p>}
            {visionSupported && (
              <label className="field">
                <span className="field-label">截图范围</span>
                <select aria-label="截图范围" value={aiVisionScope} onChange={event => setAiVisionScope(event.target.value as "page" | "selection" | "pages")}>
                  <option value="page">当前页</option>
                  <option value="selection" disabled={!selectedIds.length}>当前选区{selectedIds.length ? `（${selectedIds.length} 个节点）` : "（没有选中）"}</option>
                  <option value="pages" disabled={document.pageOrder.length < 2}>全部页面拼接{document.pageOrder.length > 1 ? `（${document.pageOrder.length} 页）` : "（只有一页）"}</option>
                </select>
              </label>
            )}
            <button disabled={busy || !prompt.trim()} onClick={() => void generateAiPlan()}><Icon name="aiPlan" />生成变更预览</button>
            {planning && <button onClick={() => planAbort.current?.abort()}><Icon name="aiCancel" />取消生成</button>}
            {planning && <pre className="ai-stream" style={{ margin: "8px 0 0", padding: 8, maxHeight: 180, overflow: "auto", background: "#0b0d12", border: "1px solid #2b303b", borderRadius: 8, fontSize: 11, lineHeight: 1.5, color: "#c8ccd6", whiteSpace: "pre-wrap", wordBreak: "break-word" }} aria-live="polite">{streamText || "正在等待模型响应…"}</pre>}
            {preview && <div className={previewStale ? "preview stale" : "preview"}><strong>{preview.summary}</strong><p>影响：{preview.affectedNodeIds.join(", ") || "文档级"}</p><p>警告：{preview.warnings.length}</p><p>审查：{preview.review.findings.length ? `${preview.review.findings.length} 条${preview.review.blocking ? "（含阻断项）" : "（仅提示）"}` : "通过"}</p>{preview.review.findings.length > 0 && <div className="review-list">{preview.review.findings.map(finding => <div className={`review-row review-${finding.severity}`} key={finding.code}><span className="review-badge">{finding.severity === "blocking" ? "阻断" : "提示"}</span><span className="review-message">{finding.message}</span></div>)}</div>}{previewStale && <p>文档已变化，请取消并重新生成计划。</p>}<div className="preview-actions"><button disabled={busy || previewStale || preview.review.blocking} title={preview.review.blocking ? "存在阻断项，计划不能提交" : undefined} onClick={() => editor && void run(async () => { await editor.confirm(preview.planId); setDocument(project.snapshot()); setPreview(undefined); setMessage("AI 变更已确认"); })}><Icon name="aiConfirm" />确认提交</button><button disabled={busy} onClick={() => { editor?.cancel(preview.planId); setPreview(undefined); }}><Icon name="aiCancel" />取消</button></div></div>}
          </section>
          <section className="inspector-section">
            <h2>自主运行</h2>
            <p className="empty-hint">按体检结论（设计 lint、对比度、导出诊断）自动多轮修复：体检 → 计划 → 审查 → 提交 → 再体检，直到没有待修项或触发停止条件。每轮都可撤销。</p>
            <button disabled={busy || !prompt.trim() || loopRunning} onClick={() => void startAutonomousRun()}><Icon name="aiLoop" />自主运行</button>
            {loopRunning && <button onClick={() => planAbort.current?.abort()}><Icon name="aiCancel" />取消运行</button>}
            {loopRounds.length > 0 && <div className="loop-log" aria-live="polite">{loopRounds.map(round => <div className="loop-round" key={round.round}><span className="loop-round-index">第 {round.round} 轮</span><span className="loop-round-summary">{round.summary}</span><span className="loop-round-meta">落地 {round.appliedCommands} 条命令 · 待修 {round.report.counts.actionable} → {round.after?.counts.actionable ?? "—"}</span>{round.note && <span className="loop-round-note">{round.note}</span>}</div>)}</div>}
            {loopSummary && <p className="loop-summary">{loopSummary}</p>}
          </section>
        </Tabs.Content>
      </Tabs.Root>
      <div className="inspector-foot">
        <span className={`autosave-status autosave-${autosave.state}`} title={autosaveTitle(autosave)}>{autosaveLabel(autosave)}</span>
        <span className="inspector-foot-meta">{storage ? `存储 ${storagePercent(storage)}%` : "存储用量未知"}</span>
      </div>
    </aside>
    <ExportPreviewDialog open={previewOpen} onOpenChange={open => { setPreviewOpen(open); if (!open) setComparePreview(undefined); }} preview={exportPreview} compare={comparePreview} />
    {prototypeScreenId && <PrototypePreview document={document} repository={repository} projectId={document.id} startScreenId={prototypeScreenId} onExit={() => setPrototypeScreenId(undefined)} />}
  </div>;
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

/**
 * 体检层的资源解析器。
 *
 * 只认**开跑前就声明在文档里**的资源：这些资源要是读不到字节，交付物里就真的
 * 缺图，值得当成待修项报出来。循环过程中新加的资源不在这个集合里——那类资源
 * 是模型自己加的，判定它「缺字节」多半是误报，所以先给一张占位图。
 */
async function createSelfCheckResolver(snapshot: DesignDocument): Promise<(asset: AssetMetadata) => string | undefined> {
  const declared = new Set(Object.keys(snapshot.assets));
  const urls = new Map<string, string>();
  for (const asset of Object.values(snapshot.assets)) {
    const bytes = await repository.getAsset(snapshot.id, asset.hash);
    if (bytes) urls.set(asset.id, assetDataUrl(asset, bytes));
  }
  return asset => {
    const url = urls.get(asset.id);
    if (url) return url;
    return declared.has(asset.id) ? undefined : PLACEHOLDER_ASSET_URL;
  };
}

function makeNode(type: "frame" | "text" | "rectangle" | "ellipse", parentId: string, box?: { x: number; y: number; width: number; height: number }): DesignNode {
  const id = `${type}:${crypto.randomUUID().slice(0, 8)}`;
  const names = { frame: "Frame", text: "文本", rectangle: "矩形", ellipse: "椭圆" } as const;
  const size = box ?? { x: 48, y: 48, width: type === "text" ? 160 : 240, height: type === "text" ? 48 : 140 };
  // 填充写在 fills 里（数组）。`appearance.fill` 是旧格式，运行时只认 fills ——
  // 写成 fill 的节点画布上是没有颜色的。
  const common = { id, name: names[type], parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x: size.x, y: size.y, width: size.width, height: size.height }, appearance: { ...defaultAppearance(), fills: [{ type: "solid" as const, color: type === "text" ? "#ffffff" : "#8b5cf6" }], cornerRadius: type === "ellipse" ? undefined : 12 } };
  if (type === "text") return { ...common, type: "text", text: "双击编辑文本", fontFamily: "Inter", fontSize: 20, lineHeight: 28 };
  return { ...common, type };
}

/**
 * 直线 / 多边形 / 星形节点。
 *
 * 三者都是 `vector` + 归一化路径。直线不填色（填了就是一块色块），改用 2px 描边；
 * 多边形和星形填充、不描边——这和用户对这两种形状的预期一致。
 */
function makeVectorNode(tool: VectorToolId, parentId: string, box: { x: number; y: number; width: number; height: number }, geometry: VectorGeometry): DesignNode {
  const names = { line: "直线", polygon: "多边形", star: "星形" } as const;
  const appearance = tool === "line"
    ? { ...defaultAppearance(), stroke: "#8b5cf6", strokeWidth: 2 }
    : { ...defaultAppearance(), fills: [{ type: "solid" as const, color: "#8b5cf6" }] };
  return {
    id: `vector:${crypto.randomUUID().slice(0, 8)}`,
    type: "vector",
    name: names[tool],
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), ...box },
    appearance,
    geometry,
  };
}

/**
 * 钢笔提交出来的路径节点。
 *
 * 闭合路径给填充、开放路径只给描边：一条不闭合的曲线被填充后会变成一块奇怪的面，
 * 用户很难理解那是自己画出来的。
 */
function makePenNode(parentId: string, box: { x: number; y: number; width: number; height: number }, geometry: VectorGeometry, closed: boolean): DesignNode {
  const appearance = closed
    ? { ...defaultAppearance(), fills: [{ type: "solid" as const, color: "#8b5cf6" }] }
    : { ...defaultAppearance(), stroke: "#8b5cf6", strokeWidth: 2 };
  return {
    id: `vector:${crypto.randomUUID().slice(0, 8)}`,
    type: "vector",
    name: closed ? "闭合路径" : "开放路径",
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), ...box },
    appearance,
    geometry,
  };
}



/**
 * 拖拽结果 → 矢量几何。
 *
 * 端点先钳制到画板内再建几何：如果先建后裁，路径坐标是相对旧盒子的，
 * 裁完就会和盒子错位。单击（没有拖拽）时按默认长度补一个终点。
 */
function vectorShapeFromDrag(tool: VectorToolId, info: { dragged: boolean; start: HitPoint; end: HitPoint }): VectorShape {
  const start = clampToCanvas(info.start);
  const end = info.dragged ? clampToCanvas(info.end) : { x: Math.min(start.x + DEFAULT_VECTOR_LENGTH, CANVAS_WIDTH), y: tool === "line" ? start.y : Math.min(start.y + DEFAULT_VECTOR_LENGTH, CANVAS_HEIGHT) };
  return buildVectorShape(tool, start, end);
}

function clampToCanvas(point: HitPoint): HitPoint {
  return { x: Math.min(Math.max(point.x, 0), CANVAS_WIDTH), y: Math.min(Math.max(point.y, 0), CANVAS_HEIGHT) };
}

/** 单击创建矢量形状时的默认边长。 */
const DEFAULT_VECTOR_LENGTH = 160;

/** `.canvas-stage` 的 padding-top：画布在 stage 里的纵向偏移，浮层定位要用。 */
const CANVAS_STAGE_OFFSET_TOP = 24;

function collectSlotNodes(document: DesignDocument, rootId: string): DesignNode[] {
  const found: DesignNode[] = [];
  const walk = (id: string): void => {
    const node = document.nodes[id];
    if (!node) return;
    if (node.slot) found.push(node);
    for (const childId of node.childIds) walk(childId);
  };
  walk(rootId);
  return found;
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

const demoPlanner: AiPlanner = { async plan({ document }) { return { summary: "演示规划器：创建一个蓝色卡片（未启用真实模型，需求未被理解）", assumptions: ["使用当前页面"], commands: [{ type: "node.create", payload: { node: { ...makeNode("frame", document.pageOrder[0]!), name: "AI 卡片", layout: { ...defaultLayout(), x: 340, y: 120, width: 280, height: 180 }, appearance: { ...defaultAppearance(), fills: [{ type: "solid" as const, color: "#2563eb" }], cornerRadius: 20 } } } }] }; } };

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

/**
 * 逐项目统计存储占用并生成清理清单。
 *
 * 仓库不支持统计时返回 undefined——调用方要显示"无法统计"，不能把 0 当成
 * "这个项目不占空间"。单个项目统计失败也不该让整张清单消失，所以那一项跳过。
 */
async function loadStorageUsage(currentProjectId?: string): Promise<StorageUsageOverview | undefined> {
  if (!repository.inspectStorage) return undefined;
  try {
    const summaries = await repository.listProjects();
    const usages = await Promise.all(summaries.map(summary => repository.inspectStorage!(summary.id).catch(() => undefined)));
    return storageUsageOverview(usages.filter((usage): usage is ProjectStorageUsage => Boolean(usage)), { currentProjectId });
  } catch {
    return undefined;
  }
}

function validateNumber(value: string): string | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? undefined : "请输入不小于 0 的数字";
}

function validateColor(value: string): string | undefined {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
    ? undefined
    : "请输入 #RGB、#RRGGBB 或 #RRGGBBAA 形式的颜色值";
}

/** 「暴露为 XX 属性」对话框的标题。 */
const PROPERTY_EXPOSE_TITLES: Record<ComponentPropertyField, string> = {
  text: "暴露为文本属性",
  visible: "暴露为布尔属性",
  fill: "暴露为颜色属性",
  fontSize: "暴露为字号属性",
  instance: "暴露为实例交换属性",
};

/** 「暴露为 XX 属性」对话框的说明。 */
const PROPERTY_EXPOSE_DESCRIPTIONS: Record<ComponentPropertyField, string> = {
  text: "实例可以用这个属性改这段文字。",
  visible: "实例可以用这个属性开关这个节点的可见性。",
  fill: "实例可以用这个属性改这个节点的填充色。",
  fontSize: "实例可以用这个属性改这段文字的字号。",
  instance: "实例可以用这个属性把内部实例换成另一个组件。",
};

/**
 * 按绑定字段造一条属性声明。
 *
 * 默认值取自**当前节点**：暴露出来的属性一开始就该是这个节点现在的样子，
 * 否则实例会先显示成别的值再被改回来。
 */
function buildExposedProperty(propertyId: string, name: string, field: ComponentPropertyField, node: DesignNode): ComponentProperty {
  switch (field) {
    case "text":
      return { id: propertyId, name, type: "text", defaultValue: node.type === "text" ? node.text : "" };
    case "visible":
      return { id: propertyId, name, type: "boolean", defaultValue: true };
    case "fill": {
      const fill = node.appearance.fills?.find(paint => paint.type === "solid");
      return { id: propertyId, name, type: "color", defaultValue: fill && fill.type === "solid" ? fill.color : "#000000" };
    }
    case "fontSize":
      return { id: propertyId, name, type: "number", defaultValue: node.type === "text" ? node.fontSize : 16 };
    case "instance":
      return { id: propertyId, name, type: "instance-swap", defaultValue: node.type === "instance" ? node.componentId : "" };
  }
}
function downloadFile(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
/** 下载二进制产物（ZIP 等）。 */
function downloadBytes(name: string, bytes: Uint8Array, type: string): void { const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }

const container = document.getElementById("root")! as HTMLElement & { __studioRoot?: ReturnType<typeof createRoot> };
const root = container.__studioRoot ?? createRoot(container);
container.__studioRoot = root;
// 曲线级布尔：引擎装上后，布尔组的结果保留贝塞尔曲线（而不是折线近似）。
// 必须在第一次绘制之前装好，否则首帧会用近似结果。
installPaperBooleanEngine();
// 字体子集化：注册的是「承诺」，wasm 只在导出遇到超限字体时才加载。
registerFontSubsetter();
// Vite 的 HMR 会重新执行本模块。若直接再调一次 createRoot，React 会报
// "container already passed to createRoot" 并撕裂 DOM，表现为点击随机失效、拖拽坐标错乱。
// 把 root 挂在容器上复用，HMR 时只是重新 render，永远不会出现两个 React 树。
root.render(<DialogProvider><TooltipProvider><App /></TooltipProvider></DialogProvider>);
