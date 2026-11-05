import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SafeAiEditor, type AiPlanPreview, type AiPlanner } from "@ufira/ai-orchestrator";
import type { CommandEnvelope, DesignCommand } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import { DexieProjectRepository, type StoredProjectSummary } from "./browser-repository";
import { copyNodeTrees, pasteNodeTrees, type NodeClipboard } from "./node-clipboard";
import { arrangeNodes, type Arrangement } from "./node-arrangement";
import { prepareImportedDocument } from "./project-import";
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
  const importInput = useRef<HTMLInputElement>(null);
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
      if (!modifier || key !== "z") return;
      event.preventDefault();
      if (operationInFlight.current) return;
      operationInFlight.current = true; setBusy(true);
      void applyHistory(event.shiftKey ? "redo" : "undo").catch(error => setMessage(errorMessage(error))).finally(() => { operationInFlight.current = false; setBusy(false); });
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [project]);

  if (!project || !document) return <main className="loading">{message}</main>;
  const activePageId = currentPageId && document.pages[currentPageId] ? currentPageId : document.pageOrder[0]!;
  const page = document.pages[activePageId]!;
  const selected = selectedIds.length ? document.nodes[selectedIds.at(-1)!] : undefined;

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
  const addNode = (type: "frame" | "text" | "rectangle") => void run(() => execute([{ type: "node.create", payload: { node: makeNode(type, page.id) } }]));
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
  const selectedLayerIndex = selectedIds.length === 1 ? page.childIds.indexOf(selectedIds[0]!) : -1;
  const reorderLayer = (targetIndex: number) => {
    if (selectedLayerIndex < 0 || targetIndex === selectedLayerIndex) return;
    const id = selectedIds[0]!;
    void run(() => execute([{ type: "node.reparent", payload: { id, parentId: page.id, index: targetIndex } }]));
  };
  const arrangeSelection = (arrangement: Arrangement) => patchLayouts(arrangeNodes(selectedIds.map(id => document.nodes[id]!).filter(Boolean), arrangement));
  keyboardAction.current = action => {
    if (busy) return;
    if (action === "copy") copySelection();
    else if (action === "paste") pasteSelection();
    else if (action === "duplicate") duplicateSelection();
    else if (action === "layerUp") reorderLayer(Math.min(page.childIds.length - 1, selectedLayerIndex + 1));
    else if (action === "layerDown") reorderLayer(Math.max(0, selectedLayerIndex - 1));
    else deleteSelection();
  };
  const previewStale = preview?.baseRevision !== document.revision;

  return <div className="studio">
    <header><strong>AI Design Studio</strong><select className="project-select" disabled={busy} value={document.id} onChange={event => void run(() => openProject(event.target.value))}>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select><button disabled={busy} onClick={createProject}>新建</button><button disabled={busy} onClick={renameProject}>重命名</button><button disabled={busy || !project.canUndo()} title="Ctrl/Cmd+Z" onClick={() => void run(() => applyHistory("undo"))}>撤销</button><button disabled={busy || !project.canRedo()} title="Shift+Ctrl/Cmd+Z" onClick={() => void run(() => applyHistory("redo"))}>重做</button><button disabled={busy} onClick={exportHtml}>HTML</button><button disabled={busy} onClick={exportJson}>JSON</button><button disabled={busy} onClick={() => importInput.current?.click()}>导入</button><input ref={importInput} className="hidden-input" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) importJson(file); event.target.value = ""; }} /><button disabled={busy} className="header-danger" onClick={deleteCurrentProject}>删除项目</button><span className="status">{message}</span></header>
    <aside className="layers"><div className="section-heading"><h2>页面</h2><button disabled={busy} onClick={createPage}>新增</button></div><select className="project-select" style={{ width: "100%", minWidth: 0, marginBottom: 8 }} disabled={busy} value={page.id} onChange={event => switchPage(event.target.value)}>{document.pageOrder.map(id => <option key={id} value={id}>{document.pages[id]?.name}</option>)}</select><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 20 }}><button disabled={busy} onClick={renamePage}>重命名</button><button disabled={busy || document.pageOrder.length === 1 || page.childIds.length > 0} title={page.childIds.length ? "请先清空页面" : "删除当前页面"} onClick={deletePage}>删除</button></div><h2>图层</h2><div className="tools"><button disabled={busy} onClick={() => addNode("frame")}>Frame</button><button disabled={busy} onClick={() => addNode("rectangle")}>矩形</button><button disabled={busy} onClick={() => addNode("text")}>文本</button></div><div className="layer-actions" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 8 }}><button disabled={busy || !selectedIds.length} title="Ctrl/Cmd+C" onClick={copySelection}>复制</button><button disabled={busy || !clipboard.current} title="Ctrl/Cmd+V" onClick={pasteSelection}>粘贴</button><button disabled={busy || !selectedIds.length} title="Ctrl/Cmd+D" onClick={duplicateSelection}>重复</button></div><div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginBottom: 12 }}><button disabled={busy || selectedLayerIndex <= 0} onClick={() => reorderLayer(0)}>置底</button><button disabled={busy || selectedLayerIndex <= 0} title="Ctrl/Cmd+[" onClick={() => reorderLayer(selectedLayerIndex - 1)}>下移</button><button disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= page.childIds.length - 1} title="Ctrl/Cmd+]" onClick={() => reorderLayer(selectedLayerIndex + 1)}>上移</button><button disabled={busy || selectedLayerIndex < 0 || selectedLayerIndex >= page.childIds.length - 1} onClick={() => reorderLayer(page.childIds.length - 1)}>置顶</button></div>{page.childIds.map(id => <button className={selectedIds.includes(id) ? "layer active" : "layer"} key={id} onClick={event => setSelectedIds(current => event.shiftKey ? toggleId(current, id) : [id])}>{document.nodes[id]?.name}</button>)}</aside>
    <section className="workspace"><div ref={setCanvas} className="canvas" onClick={event => event.target === event.currentTarget && setSelectedIds([])}>{page.childIds.map(id => <CanvasNode key={id} node={document.nodes[id]!} fill={resolveFill(document, document.nodes[id]!)} selected={selectedIds.includes(id)} onSelect={event => setSelectedIds(current => event.shiftKey ? toggleId(current, id) : [id])} />)}<Suspense fallback={null}><CanvasInteractionLayer canvas={canvas} nodes={page.childIds.map(id => document.nodes[id]!)} selectedIds={selectedIds} disabled={busy || selectedIds.some(id => document.nodes[id]?.locked)} onSelect={setSelectedIds} onCommit={patchLayouts} /></Suspense></div></section>
    <aside className="inspector"><h2>属性{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length}` : ""}</h2>{selectedIds.length > 1 && <><h2>对齐与分布</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, marginBottom: 12 }}><button disabled={busy} onClick={() => arrangeSelection("left")}>左</button><button disabled={busy} onClick={() => arrangeSelection("centerX")}>水平中</button><button disabled={busy} onClick={() => arrangeSelection("right")}>右</button><button disabled={busy} onClick={() => arrangeSelection("top")}>上</button><button disabled={busy} onClick={() => arrangeSelection("centerY")}>垂直中</button><button disabled={busy} onClick={() => arrangeSelection("bottom")}>下</button><button disabled={busy || selectedIds.length < 3} onClick={() => arrangeSelection("distributeX")}>水平分布</button><button disabled={busy || selectedIds.length < 3} onClick={() => arrangeSelection("distributeY")}>垂直分布</button></div></>}{selected ? <>
      <Field label="名称" value={selected.name} onCommit={value => patch({ name: value })} />
      {(["x", "y", "width", "height"] as const).map(key => <Field key={key} label={key} type="number" value={selected.layout[key]} onCommit={value => patch({ layout: { ...selected.layout, [key]: Number(value) } })} />)}
      <Field label="填充" value={selected.appearance.fill ?? "#ffffff"} onCommit={value => patch({ appearance: { ...selected.appearance, fill: value } })} />
      <Toggle label="显示" checked={selected.visible} onChange={visible => patchNode(selected.id, { visible })} />
      <Toggle label="锁定" checked={selected.locked} onChange={locked => patchNode(selected.id, { locked })} />
      {selected.type === "text" && <><Field label="文本" value={selected.text} onCommit={text => patchText({ text })} /><Field label="字体" value={selected.fontFamily} onCommit={fontFamily => patchText({ fontFamily })} /><Field label="字号" type="number" value={selected.fontSize} onCommit={value => patchText({ fontSize: Number(value) })} /><Field label="行高" type="number" value={selected.lineHeight} onCommit={value => patchText({ lineHeight: Number(value) })} /></>}
      <button disabled={busy} className="danger" onClick={deleteSelection}>删除{selectedIds.length > 1 ? ` ${selectedIds.length} 个节点` : ""}</button>
    </> : <p>选择画布中的节点</p>}
    <hr/><div className="section-heading"><h2>颜色 Tokens</h2><button disabled={busy} onClick={createColorToken}>新增</button></div>
    <div className="token-list">{Object.entries(document.tokens).map(([name, token]) => <div className="token-row" style={{ gridTemplateColumns: "18px minmax(0,1fr) auto auto auto" }} key={name}><span className="token-swatch" style={{ background: String(token.value) }} /><span title={`${name}: ${String(token.value)}`}>{name}</span>{token.type === "color" && <button disabled={busy} onClick={() => updateColorToken(name, token.value)}>改</button>}{token.type === "color" && selected && <button disabled={busy} onClick={() => patchNode(selected.id, { bindings: { ...selected.bindings, fill: name } })}>绑定</button>}<button disabled={busy} onClick={() => void run(() => execute([{ type: "token.delete", payload: { name } }]))}>×</button></div>)}</div>
    {selected?.bindings?.fill && <button className="unbind" disabled={busy} onClick={unbindFill}>解绑填充：{selected.bindings.fill}</button>}
    <hr/><h2>AI 安全编辑</h2><textarea value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button disabled={busy || !prompt.trim()} onClick={() => editor && void run(async () => { setPreview(await editor.createPlan(prompt, selectedIds)); setMessage("AI 计划已完成 dry-run，等待确认"); })}>生成变更预览</button>
      {preview && <div className={previewStale ? "preview stale" : "preview"}><strong>{preview.summary}</strong><p>影响：{preview.affectedNodeIds.join(", ") || "文档级"}</p><p>警告：{preview.warnings.length}</p>{previewStale && <p>文档已变化，请取消并重新生成计划。</p>}<div className="preview-actions"><button disabled={busy || previewStale} onClick={() => editor && void run(async () => { await editor.confirm(preview.planId); setDocument(project.snapshot()); setPreview(undefined); setMessage("AI 变更已确认"); })}>确认提交</button><button disabled={busy} onClick={() => { editor?.cancel(preview.planId); setPreview(undefined); }}>取消</button></div></div>}
    </aside>
  </div>;
}

function CanvasNode({ node, fill, selected, onSelect }: { node: DesignNode; fill: string; selected: boolean; onSelect(event: React.MouseEvent): void }) {
  const style: React.CSSProperties = { display: node.visible ? "flex" : "none", left: node.layout.x, top: node.layout.y, width: node.layout.width, height: node.layout.height, background: fill, borderRadius: node.appearance.cornerRadius, opacity: node.appearance.opacity };
  return <button data-node-id={node.id} className={`${selected ? "node selected" : "node"}${node.locked ? " locked" : ""}`} style={style} onClick={event => { event.stopPropagation(); onSelect(event); }}>{node.type === "text" ? node.text : node.name}</button>;
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

function makeNode(type: "frame" | "text" | "rectangle", parentId: string): DesignNode {
  const id = `${type}:${crypto.randomUUID().slice(0, 8)}`;
  const common = { id, name: type === "text" ? "文本" : type === "frame" ? "Frame" : "矩形", parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x: 48, y: 48, width: type === "text" ? 160 : 240, height: type === "text" ? 48 : 140 }, appearance: { ...defaultAppearance(), fill: type === "text" ? "#ffffff" : "#8b5cf6", cornerRadius: 12 } };
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
