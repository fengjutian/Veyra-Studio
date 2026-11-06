import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SafeAiEditor, type AiPlanPreview, type AiPlanner } from "@ufira/ai-orchestrator";
import type { CommandEnvelope, DesignCommand } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import { DexieProjectRepository, type StoredProjectSummary } from "./browser-repository";
import { copyNodeTrees, pasteNodeTrees, type NodeClipboard } from "./node-clipboard";
import { arrangeNodes, nudgeNodes, type Arrangement } from "./node-arrangement";
import { flattenNodeTrees } from "./node-tree";
import { prepareImportedDocument } from "./project-import";
import { LayerTree } from "./layer-tree";
import { planReparent, type DropPosition } from "./layer-reorder";
import { resolveBox, useCanvasLayout, type CanvasLayout } from "./canvas-layout";
import { listComponents, makeInstanceNode } from "./components";
import { PropertyPanel } from "./property-panel";
import { exportPageToPng, downloadDataUrl } from "./png-export";
import { Icon } from "./icons";
import "./styles.css";

const PROJECT_ID = "studio:local";
const CanvasInteractionLayer = lazy(() => import("./canvas-interaction-layer"));
const repository = new DexieProjectRepository();

function App() {
  const [project, setProject] = useState<StudioProject>();
  const [projects, setProjects] = useState<StoredProjectSummary[]>([]);
  const [document, setDocument] = useState<DesignDocument>();
  const [currentPageId, setCurrentPageId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("添加一个蓝色卡片");
  const [preview, setPreview] = useState<AiPlanPreview>();
  const [message, setMessage] = useState("正在打开本地项目…");
  const [busy, setBusy] = useState(false);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const operationInFlight = useRef(false);
  const clipboard = useRef<NodeClipboard | undefined>(undefined);
  const keyboardAction = useRef<(action: "copy" | "paste" | "duplicate" | "delete" | "layerUp" | "layerDown") => void>(() => undefined);
  const nudgeAction = useRef<(dx: number, dy: number) => void>(() => undefined);
  const importInput = useRef<HTMLInputElement>(null);
  const [componentName, setComponentName] = useState("");
  const editor = useMemo(() => project ? new SafeAiEditor(project, demoPlanner) : undefined, [project]);

  const applyHistory = async (direction: "undo" | "redo") => {
    if (!project) return;
    const committed = await project[direction]();
    const snapshot = project.snapshot();
    setDocument(snapshot); setProjects(await repository.listProjects()); setSelectedIds(current => current.filter(id => Boolean(snapshot.nodes[id]))); setPreview(undefined); setMessage(`${direction === "undo" ? "撤销" : "重做"}完成 · revision ${committed.result.revision}`);
  };

  useEffect(() => { void initialize(repository).then(async ({ project: value }) => { const snapshot = value.snapshot(); setProject(value); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setProjects(await repository.listProjects()); setMessage("就绪"); }).catch(error => setMessage(String(error))); }, []);
  useEffect(() => {
    if (!project) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      const action = modifier && key === "c" ? "copy" : modifier && key === "v" ? "paste" : modifier && key === "d" ? "duplicate" : modifier && key === "]" ? "layerUp" : modifier && key === "[" ? "layerDown" : key === "delete" || key === "backspace" ? "delete" : undefined;
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

  const activePageId = document && currentPageId && document.pages[currentPageId] ? currentPageId : document?.pageOrder[0];
  // Hooks must run before the early return below, so the layout is resolved unconditionally.
  const canvasLayout = useCanvasLayout(document, activePageId ?? "", { width: 960, height: 680 });

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
  const openProject = async (id: string) => {
    const opened = await StudioProject.open(repository, id);
    const snapshot = opened.project.snapshot();
    setProject(opened.project); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setSelectedIds([]); setPreview(undefined); setMessage(opened.recovery.degraded ? "项目已降级恢复，请检查事务日志" : "项目已打开");
  };
  const createProject = () => void run(async () => {
    const name = window.prompt("新项目名称", "未命名设计")?.trim(); if (!name) return;
    const created = await StudioProject.create(repository, `project:${crypto.randomUUID()}`, name, `page:${crypto.randomUUID()}`);
    const snapshot = created.snapshot(); setProject(created); setDocument(snapshot); setCurrentPageId(snapshot.pageOrder[0]); setProjects(await repository.listProjects()); setSelectedIds([]); setPreview(undefined); setMessage("项目已创建");
  });
  const renameProject = () => void run(async () => {
    const name = window.prompt("项目名称", document.meta.name)?.trim(); if (!name || name === document.meta.name) return;
    await execute([{ type: "document.rename", payload: { name } }]);
  });
  const deleteCurrentProject = () => void run(async () => {
    if (!window.confirm(`删除项目“${document.meta.name}”？此操作不可撤销。`)) return;
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
  const switchPage = (id: string) => { setCurrentPageId(id); setSelectedIds([]); setPreview(undefined); };
  const createPage = () => void run(async () => {
    const name = window.prompt("页面名称", `页面 ${document.pageOrder.length + 1}`)?.trim(); if (!name) return;
    const id = `page:${crypto.randomUUID()}`;
    await execute([{ type: "page.create", payload: { page: { id, name, childIds: [] } } }]);
    switchPage(id);
  });
  const renamePage = () => void run(async () => {
    const name = window.prompt("页面名称", page.name)?.trim(); if (!name || name === page.name) return;
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
  const patchText = (patchValue: { text?: string; fontFamily?: string; fontSize?: number; lineHeight?: number }) => selected?.type === "text" && void run(() => execute([{ type: "text.patch", payload: { id: selected.id, patch: patchValue } }]));
  const exportHtml = () => {
    const result = project.exportHtml({ pageId: page.id, viewport: { width: 960, height: 680 }, title: document.meta.name });
    downloadFile(`${safeFilename(document.meta.name)}.html`, result.document, "text/html");
    setMessage(`HTML 已导出 · ${result.diagnostics.length} 条诊断`);
  };
  const exportSvg = () => {
    const result = project.exportSvg({ pageId: page.id, viewport: { width: 960, height: 680 }, title: document.meta.name });
    downloadFile(`${safeFilename(document.meta.name)}.svg`, result.svg, "image/svg+xml");
    setMessage(`SVG 已导出 · ${result.diagnostics.length} 条诊断`);
  };
  const exportPng = () => void run(async () => {
    const result = await exportPageToPng(project.snapshot(), { pageId: page.id, viewport: { width: 960, height: 680 }, title: document.meta.name, scale: 2 });
    downloadDataUrl(`${safeFilename(document.meta.name)}.png`, result.dataUrl);
    setMessage(`PNG 已导出 · ${result.width}×${result.height}`);
  });
  const exportJson = () => { downloadFile(`${safeFilename(document.meta.name)}.design.json`, JSON.stringify(document, null, 2), "application/json"); setMessage("项目 JSON 已导出"); };
  const importJson = (file: File) => void run(async () => {
    const imported = prepareImportedDocument(JSON.parse(await file.text()));
    await repository.saveSnapshot(imported); await openProject(imported.id); setProjects(await repository.listProjects());
    setMessage(`项目已导入${Object.keys(imported.assets).length ? "；二进制资产需重新关联" : ""}`);
  });
  const createColorToken = () => void run(async () => {
    const name = window.prompt("Token 名称", "color.primary")?.trim(); if (!name) return;
    const value = window.prompt("颜色值", "#6366f1")?.trim(); if (!value) return;
    await execute([{ type: "token.upsert", payload: { name, token: { type: "color", value } } }]);
  });
  const updateColorToken = (name: string, currentValue: unknown) => void run(async () => {
    const value = window.prompt("颜色值", String(currentValue))?.trim(); if (!value || value === currentValue) return;
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
  const selectedOwner = selected ? document.nodes[selected.parentId] ?? document.pages[selected.parentId] : undefined;
  const selectedLayerIndex = selectedIds.length === 1 ? selectedOwner?.childIds.indexOf(selectedIds[0]!) ?? -1 : -1;
  const reorderLayer = (targetIndex: number) => {
    if (selectedLayerIndex < 0 || targetIndex === selectedLayerIndex) return;
    const id = selectedIds[0]!;
    void run(() => execute([{ type: "node.reparent", payload: { id, parentId: selected!.parentId, index: targetIndex } }]));
  };
  const arrangeSelection = (arrangement: Arrangement) => { if (!selectionLocked && selectionSameParent) patchLayouts(arrangeNodes(selectedNodes, arrangement)); };
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
    else deleteSelection();
  };
  const previewStale = preview?.baseRevision !== document.revision;
  const componentSummaries = listComponents(document);

  return <div className="studio">
    <header><strong>AI Design Studio</strong><select className="project-select" disabled={busy} value={document.id} onChange={event => void run(() => openProject(event.target.value))}>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select><button disabled={busy} onClick={createProject}><Icon name="newProject" />新建</button><button disabled={busy} onClick={renameProject}><Icon name="rename" />重命名</button><button disabled={busy || !project.canUndo()} title="Ctrl/Cmd+Z" onClick={() => void run(() => applyHistory("undo"))}><Icon name="undo" />撤销</button><button disabled={busy || !project.canRedo()} title="Shift+Ctrl/Cmd+Z" onClick={() => void run(() => applyHistory("redo"))}><Icon name="redo" />重做</button><button disabled={busy} onClick={exportHtml}><Icon name="exportHtml" />HTML</button><button disabled={busy} onClick={exportSvg}><Icon name="exportSvg" />SVG</button><button disabled={busy} onClick={exportPng}><Icon name="exportPng" />PNG</button><button disabled={busy} onClick={exportJson}><Icon name="exportJson" />JSON</button><button disabled={busy} onClick={() => importInput.current?.click()}><Icon name="import" />导入</button><input ref={importInput} className="hidden-input" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) importJson(file); event.target.value = ""; }} /><button disabled={busy} className="header-danger" onClick={deleteCurrentProject}><Icon name="trash" />删除项目</button><span className="status">{message}</span></header>
    <aside className="layers"><div className="section-heading"><h2>页面</h2><button disabled={busy} onClick={createPage}><Icon name="pageAdd" />新增</button></div><select className="project-select" style={{ width: "100%", minWidth: 0, marginBottom: 8 }} disabled={busy} value={page.id} onChange={event => switchPage(event.target.value)}>{document.pageOrder.map(id => <option key={id} value={id}>{document.pages[id]?.name}</option>)}</select><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 20 }}><button disabled={busy} onClick={renamePage}><Icon name="rename" />重命名</button><button disabled={busy || document.pageOrder.length === 1 || page.childIds.length > 0} title={page.childIds.length ? "请先清空页面" : "删除当前页面"} onClick={deletePage}><Icon name="pageDelete" />删除</button></div><h2>图层</h2><div className="tools"><button disabled={busy} onClick={() => addNode("frame")}><Icon name="addFrame" />Frame</button><button disabled={busy} onClick={() => addNode("rectangle")}><Icon name="addRectangle" />矩形</button><button disabled={busy} onClick={() => addNode("ellipse")}><Icon name="addEllipse" />椭圆</button><button disabled={busy} onClick={() => addNode("text")}><Icon name="addText" />文本</button></div><div className="layer-actions" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 8 }}><button disabled={busy || !selectedIds.length} title="Ctrl/Cmd+C" onClick={copySelection}><Icon name="copy" />复制</button><button disabled={busy || !clipboard.current} title="Ctrl/Cmd+V" onClick={pasteSelection}><Icon name="paste" />粘贴</button><button disabled={busy || !selectedIds.length} title="Ctrl/Cmd+D" onClick={duplicateSelection}><Icon name="duplicate" />重复</button></div><div className="icon-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginBottom: 12 }}><button className="icon-only" disabled={busy || selectedLayerIndex <= 0} title="置底" aria-label="置底" onClick={() => reorderLayer(0)}><Icon name="toBack" /></button><button className="icon-only" disabled={busy || selectedLayerIndex <= 0} title="下移 (Ctrl/Cmd+[)" aria-label="下移" onClick={() => reorderLayer(selectedLayerIndex - 1)}><Icon name="moveDown" /></button><button className="icon-only" disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= (selectedOwner?.childIds.length ?? 0) - 1} title="上移 (Ctrl/Cmd+])" aria-label="上移" onClick={() => reorderLayer(selectedLayerIndex + 1)}><Icon name="moveUp" /></button><button className="icon-only" disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= (selectedOwner?.childIds.length ?? 0) - 1} title="置顶" aria-label="置顶" onClick={() => reorderLayer((selectedOwner?.childIds.length ?? 1) - 1)}><Icon name="toFront" /></button></div><LayerTree document={document} rootIds={page.childIds} selectedIds={selectedIds} onSelect={(nodeId, event) => setSelectedIds(current => event.shiftKey ? toggleId(current, nodeId) : [nodeId])} onReorder={reorderFromTree} /></aside>    <section className="workspace"><div ref={setCanvas} className="canvas" onClick={event => event.target === event.currentTarget && setSelectedIds([])}>{page.childIds.map(id => <CanvasNode key={id} document={document} node={document.nodes[id]!} selectedIds={selectedIds} layout={canvasLayout} onSelect={(id, event) => setSelectedIds(current => event.shiftKey ? toggleId(current, id) : [id])} />)}<Suspense fallback={null}><CanvasInteractionLayer canvas={canvas} nodes={pageNodes} selectedIds={selectedRootIds} disabled={busy || selectionLocked} onSelect={setSelectedIds} onCommit={patchLayouts} /></Suspense></div></section>
    <aside className="inspector"><h2>属性{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length}` : ""}</h2>{selectedIds.length > 1 && <><h2>对齐与分布</h2><div className="icon-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, marginBottom: 12 }}><button className="icon-only" disabled={busy} title="左对齐" aria-label="左对齐" onClick={() => arrangeSelection("left")}><Icon name="alignLeft" /></button><button className="icon-only" disabled={busy} title="水平居中" aria-label="水平居中" onClick={() => arrangeSelection("centerX")}><Icon name="alignCenterX" /></button><button className="icon-only" disabled={busy} title="右对齐" aria-label="右对齐" onClick={() => arrangeSelection("right")}><Icon name="alignRight" /></button><button className="icon-only" disabled={busy} title="顶对齐" aria-label="顶对齐" onClick={() => arrangeSelection("top")}><Icon name="alignTop" /></button><button className="icon-only" disabled={busy} title="垂直居中" aria-label="垂直居中" onClick={() => arrangeSelection("centerY")}><Icon name="alignCenterY" /></button><button className="icon-only" disabled={busy} title="底对齐" aria-label="底对齐" onClick={() => arrangeSelection("bottom")}><Icon name="alignBottom" /></button><button className="icon-only" disabled={busy || selectedIds.length < 3} title="水平分布" aria-label="水平分布" onClick={() => arrangeSelection("distributeX")}><Icon name="distributeX" /></button><button className="icon-only" disabled={busy || selectedIds.length < 3} title="垂直分布" aria-label="垂直分布" onClick={() => arrangeSelection("distributeY")}><Icon name="distributeY" /></button></div></>}{selected && selectedIds.length === 1 ? <>
      <Field label="名称" value={selected.name} onCommit={value => patch({ name: value })} />
      <PropertyPanel node={selected} disabled={busy} onPatch={patch} onPatchText={patchText} />
      <Toggle label="显示" checked={selected.visible} onChange={visible => patchNode(selected.id, { visible })} />
      <Toggle label="锁定" checked={selected.locked} onChange={locked => patchNode(selected.id, { locked })} />
      <button disabled={busy} className="danger" onClick={deleteSelection}><Icon name="trash" />删除{selectedIds.length > 1 ? ` ${selectedIds.length} 个节点` : ""}</button>
    </> : <p>{selectedIds.length > 1 ? "使用上方工具批量调整所选节点" : "选择画布中的节点"}</p>}
    {canvasLayout.warnings.length > 0 && <><h2>布局警告</h2><div className="warning-list">{canvasLayout.warnings.map((warning, index) => <button key={`${warning.nodeId}:${warning.code}:${index}`} className="warning-row" onClick={() => warning.nodeId && setSelectedIds([warning.nodeId])} title={warning.nodeId ? `选中 ${warning.nodeId}` : warning.message}><span className={`warning-code warning-code-${warning.code}`}>{warning.code}</span><span className="warning-message">{warning.message}</span></button>)}</div></>}
    <hr/><div className="section-heading"><h2>颜色 Tokens</h2><button disabled={busy} onClick={createColorToken}><Icon name="tokenAdd" />新增</button></div>
    <div className="token-list">{Object.entries(document.tokens).map(([name, token]) => <div className="token-row" style={{ gridTemplateColumns: "18px minmax(0,1fr) auto auto auto" }} key={name}><span className="token-swatch" style={{ background: String(token.value) }} /><span title={`${name}: ${String(token.value)}`}>{name}</span>{token.type === "color" && <button className="icon-only" title="修改颜色值" aria-label="修改颜色值" disabled={busy} onClick={() => updateColorToken(name, token.value)}><Icon name="tokenEdit" /></button>}{token.type === "color" && selected && <button className="icon-only" title="绑定为选中节点的填充" aria-label="绑定填充" disabled={busy} onClick={() => patchNode(selected.id, { bindings: { ...selected.bindings, fill: name } })}><Icon name="tokenBind" /></button>}<button className="icon-only" title="删除 Token" aria-label="删除 Token" disabled={busy} onClick={() => void run(() => execute([{ type: "token.delete", payload: { name } }]))}><Icon name="tokenRemove" /></button></div>)}</div>
    {selected?.bindings?.fill && <button className="unbind" disabled={busy} onClick={unbindFill}><Icon name="tokenUnbind" />解绑填充：{selected.bindings.fill}</button>}
    <hr/><h2>组件</h2>
    <div className="component-create"><input type="text" placeholder="组件名称" value={componentName} onChange={event => setComponentName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") createComponentFromSelection(componentName); }} /><button disabled={busy || !componentName.trim() || !selected || selectedIds.length !== 1 || selected.type === "instance"} title={selected?.type === "instance" ? "实例不能转为组件" : "将选中节点转为组件"} onClick={() => createComponentFromSelection(componentName)}><Icon name="componentCreate" />创建</button></div>
    <div className="component-list">{componentSummaries.length
      ? componentSummaries.map(component => <div className="component-row" key={component.id}><span className="component-glyph"><Icon name="nodeComponent" size={12} /></span><span className="component-name" title={component.name}>{component.name}</span><span className="component-count">{component.instanceCount}</span><button className="icon-only" title="创建实例" aria-label="创建实例" disabled={busy} onClick={() => instantiateComponent(component.id)}><Icon name="componentInstantiate" /></button><button className="icon-only" title="删除组件" aria-label="删除组件" disabled={busy} onClick={() => removeComponent(component.id)}><Icon name="componentRemove" /></button></div>)
      : <p className="empty-hint">还没有组件。选中一个节点，输入名称后点击「创建」。</p>}</div>
    <hr/><h2>AI 安全编辑</h2><textarea value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button disabled={busy || !prompt.trim()} onClick={() => editor && void run(async () => { setPreview(await editor.createPlan(prompt, selectedIds)); setMessage("AI 计划已完成 dry-run，等待确认"); })}><Icon name="aiPlan" />生成变更预览</button>
      {preview && <div className={previewStale ? "preview stale" : "preview"}><strong>{preview.summary}</strong><p>影响：{preview.affectedNodeIds.join(", ") || "文档级"}</p><p>警告：{preview.warnings.length}</p>{previewStale && <p>文档已变化，请取消并重新生成计划。</p>}<div className="preview-actions"><button disabled={busy || previewStale} onClick={() => editor && void run(async () => { await editor.confirm(preview.planId); setDocument(project.snapshot()); setPreview(undefined); setMessage("AI 变更已确认"); })}><Icon name="aiConfirm" />确认提交</button><button disabled={busy} onClick={() => { editor?.cancel(preview.planId); setPreview(undefined); }}><Icon name="aiCancel" />取消</button></div></div>}
    </aside>
  </div>;
}

function CanvasNode({ document, node, selectedIds, layout, onSelect }: { document: DesignDocument; node: DesignNode; selectedIds: string[]; layout: CanvasLayout; onSelect(id: string, event: { shiftKey: boolean }): void }) {
  const box = resolveBox(layout, node);
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
  if (node.type === "text") {
    style.fontFamily = node.fontFamily;
    style.fontSize = node.fontSize;
    style.lineHeight = `${node.lineHeight}px`;
    style.textAlign = "left";
    style.alignItems = "flex-start";
    style.justifyContent = "flex-start";
    style.whiteSpace = "pre-wrap";
  }
  return <div role="button" tabIndex={0} data-node-id={node.id} className={`${selectedIds.includes(node.id) ? "node selected" : "node"}${node.locked ? " locked" : ""}`} style={style} onClick={event => { event.stopPropagation(); onSelect(node.id, event); }} onKeyDown={event => { if (event.key === "Enter") onSelect(node.id, event); }}><span style={{ pointerEvents: "none" }}>{node.type === "text" ? node.text : node.name}</span>{node.childIds.map(id => <CanvasNode key={id} document={document} node={document.nodes[id]!} selectedIds={selectedIds} layout={layout} onSelect={onSelect} />)}</div>;
}

function Field({ label, value, type = "text", onCommit }: { label: string; value: string | number; type?: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label>{label}<input type={type} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => String(value) !== draft && onCommit(draft)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) { return <label>{label}<input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /></label>; }

async function initialize(repository: DexieProjectRepository) {
  await migrateLegacySnapshot(repository, PROJECT_ID);
  const existing = await repository.listProjects();
  if (existing[0]) return StudioProject.open(repository, existing[0].id);
  return { project: await StudioProject.create(repository, PROJECT_ID, "本地设计", "page:1"), recovery: undefined };
}

async function migrateLegacySnapshot(repository: DexieProjectRepository, projectId: string): Promise<void> {
  const key = `studio:${projectId}:document`, serialized = localStorage.getItem(key);
  if (!serialized) return;
  try { await repository.saveSnapshot(JSON.parse(serialized) as DesignDocument); localStorage.removeItem(key); localStorage.removeItem(`${key}:pending`); localStorage.removeItem(`studio:${projectId}:transactions`); }
  catch { /* Preserve invalid legacy data for manual recovery. */ }
}

function makeNode(type: "frame" | "text" | "rectangle" | "ellipse", parentId: string): DesignNode {
  const id = `${type}:${crypto.randomUUID().slice(0, 8)}`;
  const names = { frame: "Frame", text: "文本", rectangle: "矩形", ellipse: "椭圆" } as const;
  const common = { id, name: names[type], parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x: 48, y: 48, width: type === "text" ? 160 : 240, height: type === "text" ? 48 : 140 }, appearance: { ...defaultAppearance(), fill: type === "text" ? "#ffffff" : "#8b5cf6", cornerRadius: type === "ellipse" ? undefined : 12 } };
  if (type === "text") return { ...common, type: "text", text: "双击编辑文本", fontFamily: "Inter", fontSize: 20, lineHeight: 28 };
  return { ...common, type };
}

const demoPlanner: AiPlanner = { async plan({ document }) { return { summary: "创建一个经过安全预演的蓝色卡片", assumptions: ["使用当前页面"], commands: [{ type: "node.create", payload: { node: { ...makeNode("frame", document.pageOrder[0]!), name: "AI 卡片", layout: { ...defaultLayout(), x: 340, y: 120, width: 280, height: 180 }, appearance: { ...defaultAppearance(), fill: "#2563eb", cornerRadius: 20 } } } }] }; } };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function toggleId(ids: string[], id: string): string[] { return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]; }

function resolveFill(document: DesignDocument, node: DesignNode): string { const token = node.bindings?.fill ? document.tokens[node.bindings.fill] : undefined; return token?.type === "color" ? String(token.value) : node.appearance.fill ?? "transparent"; }

function safeFilename(name: string): string { return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "design"; }
function downloadFile(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }

createRoot(document.getElementById("root")!).render(<App />);
