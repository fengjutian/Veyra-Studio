import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SafeAiEditor, type AiPlanPreview, type AiPlanner } from "@ufira/ai-orchestrator";
import type { CommandEnvelope, DesignCommand } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import { DexieProjectRepository, type StoredProjectSummary } from "./browser-repository";
import "./styles.css";

const PROJECT_ID = "studio:local";
const CanvasInteractionLayer = lazy(() => import("./canvas-interaction-layer"));
const repository = new DexieProjectRepository();

function App() {
  const [project, setProject] = useState<StudioProject>();
  const [projects, setProjects] = useState<StoredProjectSummary[]>([]);
  const [document, setDocument] = useState<DesignDocument>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("添加一个蓝色卡片");
  const [preview, setPreview] = useState<AiPlanPreview>();
  const [message, setMessage] = useState("正在打开本地项目…");
  const [busy, setBusy] = useState(false);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const operationInFlight = useRef(false);
  const editor = useMemo(() => project ? new SafeAiEditor(project, demoPlanner) : undefined, [project]);

  const applyHistory = async (direction: "undo" | "redo") => {
    if (!project) return;
    const committed = await project[direction]();
    const snapshot = project.snapshot();
    setDocument(snapshot); setProjects(await repository.listProjects()); setSelectedIds(current => current.filter(id => Boolean(snapshot.nodes[id]))); setPreview(undefined); setMessage(`${direction === "undo" ? "撤销" : "重做"}完成 · revision ${committed.result.revision}`);
  };

  useEffect(() => { void initialize(repository).then(async ({ project: value }) => { setProject(value); setDocument(value.snapshot()); setProjects(await repository.listProjects()); setMessage("就绪"); }).catch(error => setMessage(String(error))); }, []);
  useEffect(() => {
    if (!project) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || target?.matches("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      if (operationInFlight.current) return;
      operationInFlight.current = true; setBusy(true);
      void applyHistory(event.shiftKey ? "redo" : "undo").catch(error => setMessage(errorMessage(error))).finally(() => { operationInFlight.current = false; setBusy(false); });
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [project]);

  if (!project || !document) return <main className="loading">{message}</main>;
  const page = document.pages[document.pageOrder[0]!];
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
    setProject(opened.project); setDocument(opened.project.snapshot()); setSelectedIds([]); setPreview(undefined); setMessage(opened.recovery.degraded ? "项目已降级恢复，请检查事务日志" : "项目已打开");
  };
  const createProject = () => void run(async () => {
    const name = window.prompt("新项目名称", "未命名设计")?.trim(); if (!name) return;
    const created = await StudioProject.create(repository, `project:${crypto.randomUUID()}`, name, `page:${crypto.randomUUID()}`);
    setProject(created); setDocument(created.snapshot()); setProjects(await repository.listProjects()); setSelectedIds([]); setPreview(undefined); setMessage("项目已创建");
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
      setProject(created); setDocument(created.snapshot()); setSelectedIds([]); setPreview(undefined);
    }
    setProjects(await repository.listProjects()); setMessage("项目已删除");
  });
  const addNode = (type: "frame" | "text" | "rectangle") => void run(() => execute([{ type: "node.create", payload: { node: makeNode(type, page.id) } }]));
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
  const previewStale = preview?.baseRevision !== document.revision;

  return <div className="studio">
    <header><strong>AI Design Studio</strong><select className="project-select" disabled={busy} value={document.id} onChange={event => void run(() => openProject(event.target.value))}>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select><button disabled={busy} onClick={createProject}>新建</button><button disabled={busy} onClick={renameProject}>重命名</button><button disabled={busy || !project.canUndo()} title="Ctrl/Cmd+Z" onClick={() => void run(() => applyHistory("undo"))}>撤销</button><button disabled={busy || !project.canRedo()} title="Shift+Ctrl/Cmd+Z" onClick={() => void run(() => applyHistory("redo"))}>重做</button><button disabled={busy} onClick={exportHtml}>HTML</button><button disabled={busy} onClick={exportJson}>JSON</button><button disabled={busy} className="header-danger" onClick={deleteCurrentProject}>删除项目</button><span className="status">{message}</span></header>
    <aside className="layers"><h2>图层</h2><div className="tools"><button disabled={busy} onClick={() => addNode("frame")}>Frame</button><button disabled={busy} onClick={() => addNode("rectangle")}>矩形</button><button disabled={busy} onClick={() => addNode("text")}>文本</button></div>{page.childIds.map(id => <button className={selectedIds.includes(id) ? "layer active" : "layer"} key={id} onClick={event => setSelectedIds(current => event.shiftKey ? toggleId(current, id) : [id])}>{document.nodes[id]?.name}</button>)}</aside>
    <section className="workspace"><div ref={setCanvas} className="canvas" onClick={event => event.target === event.currentTarget && setSelectedIds([])}>{page.childIds.map(id => <CanvasNode key={id} node={document.nodes[id]!} selected={selectedIds.includes(id)} onSelect={event => setSelectedIds(current => event.shiftKey ? toggleId(current, id) : [id])} />)}<Suspense fallback={null}><CanvasInteractionLayer canvas={canvas} nodes={page.childIds.map(id => document.nodes[id]!)} selectedIds={selectedIds} disabled={busy || selectedIds.some(id => document.nodes[id]?.locked)} onSelect={setSelectedIds} onCommit={patchLayouts} /></Suspense></div></section>
    <aside className="inspector"><h2>属性{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length}` : ""}</h2>{selected ? <>
      <Field label="名称" value={selected.name} onCommit={value => patch({ name: value })} />
      {(["x", "y", "width", "height"] as const).map(key => <Field key={key} label={key} type="number" value={selected.layout[key]} onCommit={value => patch({ layout: { ...selected.layout, [key]: Number(value) } })} />)}
      <Field label="填充" value={selected.appearance.fill ?? "#ffffff"} onCommit={value => patch({ appearance: { ...selected.appearance, fill: value } })} />
      <Toggle label="显示" checked={selected.visible} onChange={visible => patchNode(selected.id, { visible })} />
      <Toggle label="锁定" checked={selected.locked} onChange={locked => patchNode(selected.id, { locked })} />
      {selected.type === "text" && <><Field label="文本" value={selected.text} onCommit={text => patchText({ text })} /><Field label="字体" value={selected.fontFamily} onCommit={fontFamily => patchText({ fontFamily })} /><Field label="字号" type="number" value={selected.fontSize} onCommit={value => patchText({ fontSize: Number(value) })} /><Field label="行高" type="number" value={selected.lineHeight} onCommit={value => patchText({ lineHeight: Number(value) })} /></>}
      <button disabled={busy} className="danger" onClick={() => void run(async () => { await execute(selectedIds.map(id => ({ type: "node.delete", payload: { id } }))); setSelectedIds([]); })}>删除{selectedIds.length > 1 ? ` ${selectedIds.length} 个节点` : ""}</button>
    </> : <p>选择画布中的节点</p>}
    <hr/><h2>AI 安全编辑</h2><textarea value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button disabled={busy || !prompt.trim()} onClick={() => editor && void run(async () => { setPreview(await editor.createPlan(prompt, selectedIds)); setMessage("AI 计划已完成 dry-run，等待确认"); })}>生成变更预览</button>
      {preview && <div className={previewStale ? "preview stale" : "preview"}><strong>{preview.summary}</strong><p>影响：{preview.affectedNodeIds.join(", ") || "文档级"}</p><p>警告：{preview.warnings.length}</p>{previewStale && <p>文档已变化，请取消并重新生成计划。</p>}<div className="preview-actions"><button disabled={busy || previewStale} onClick={() => editor && void run(async () => { await editor.confirm(preview.planId); setDocument(project.snapshot()); setPreview(undefined); setMessage("AI 变更已确认"); })}>确认提交</button><button disabled={busy} onClick={() => { editor?.cancel(preview.planId); setPreview(undefined); }}>取消</button></div></div>}
    </aside>
  </div>;
}

function CanvasNode({ node, selected, onSelect }: { node: DesignNode; selected: boolean; onSelect(event: React.MouseEvent): void }) {
  const style: React.CSSProperties = { display: node.visible ? "flex" : "none", left: node.layout.x, top: node.layout.y, width: node.layout.width, height: node.layout.height, background: node.appearance.fill ?? "transparent", borderRadius: node.appearance.cornerRadius, opacity: node.appearance.opacity };
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

function safeFilename(name: string): string { return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "design"; }
function downloadFile(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }

createRoot(document.getElementById("root")!).render(<App />);
