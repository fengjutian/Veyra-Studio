import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SafeAiEditor, type AiPlanPreview, type AiPlanner } from "@ufira/ai-orchestrator";
import type { CommandEnvelope, DesignCommand } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import { BrowserProjectRepository } from "./browser-repository";
import { CanvasInteractionLayer } from "./canvas-interaction-layer";
import "./styles.css";

const PROJECT_ID = "studio:local";

function App() {
  const [project, setProject] = useState<StudioProject>();
  const [document, setDocument] = useState<DesignDocument>();
  const [selectedId, setSelectedId] = useState<string>();
  const [prompt, setPrompt] = useState("添加一个蓝色卡片");
  const [preview, setPreview] = useState<AiPlanPreview>();
  const [message, setMessage] = useState("正在打开本地项目…");
  const [busy, setBusy] = useState(false);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const operationInFlight = useRef(false);
  const editor = useMemo(() => project ? new SafeAiEditor(project, demoPlanner) : undefined, [project]);

  useEffect(() => { void initialize().then(({ project: value }) => { setProject(value); setDocument(value.snapshot()); setMessage("就绪"); }).catch(error => setMessage(String(error))); }, []);

  if (!project || !document) return <main className="loading">{message}</main>;
  const page = document.pages[document.pageOrder[0]!];
  const selected = selectedId ? document.nodes[selectedId] : undefined;

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
    setDocument(project.snapshot()); setMessage(`已提交 revision ${committed.result.revision}`); setPreview(undefined);
  };
  const addNode = (type: "frame" | "text" | "rectangle") => void run(() => execute([{ type: "node.create", payload: { node: makeNode(type, page.id) } }]));
  const patchNode = (id: string, patchValue: Partial<Pick<DesignNode, "name" | "layout" | "appearance">>) => void run(() => execute([{ type: "node.patch", payload: { id, patch: patchValue } }]));
  const patch = (patchValue: Partial<Pick<DesignNode, "name" | "layout" | "appearance">>) => selected && patchNode(selected.id, patchValue);
  const previewStale = preview?.baseRevision !== document.revision;

  return <div className="studio">
    <header><strong>AI Design Studio</strong><span>{document.meta.name} · r{document.revision}</span><span className="status">{message}</span></header>
    <aside className="layers"><h2>图层</h2><div className="tools"><button disabled={busy} onClick={() => addNode("frame")}>Frame</button><button disabled={busy} onClick={() => addNode("rectangle")}>矩形</button><button disabled={busy} onClick={() => addNode("text")}>文本</button></div>{page.childIds.map(id => <button className={selectedId === id ? "layer active" : "layer"} key={id} onClick={() => setSelectedId(id)}>{document.nodes[id]?.name}</button>)}</aside>
    <section className="workspace"><div ref={setCanvas} className="canvas" onClick={() => setSelectedId(undefined)}>{page.childIds.map(id => <CanvasNode key={id} node={document.nodes[id]!} selected={selectedId === id} onSelect={() => setSelectedId(id)} />)}<CanvasInteractionLayer canvas={canvas} nodes={page.childIds.map(id => document.nodes[id]!)} selectedId={selectedId} disabled={busy} onSelect={setSelectedId} onCommit={(id, layout) => patchNode(id, { layout })} /></div></section>
    <aside className="inspector"><h2>属性</h2>{selected ? <>
      <Field label="名称" value={selected.name} onCommit={value => patch({ name: value })} />
      {(["x", "y", "width", "height"] as const).map(key => <Field key={key} label={key} type="number" value={selected.layout[key]} onCommit={value => patch({ layout: { ...selected.layout, [key]: Number(value) } })} />)}
      <Field label="填充" value={selected.appearance.fill ?? "#ffffff"} onCommit={value => patch({ appearance: { ...selected.appearance, fill: value } })} />
      <button disabled={busy} className="danger" onClick={() => void run(async () => { await execute([{ type: "node.delete", payload: { id: selected.id } }]); setSelectedId(undefined); })}>删除</button>
    </> : <p>选择画布中的节点</p>}
    <hr/><h2>AI 安全编辑</h2><textarea value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button disabled={busy || !prompt.trim()} onClick={() => editor && void run(async () => { setPreview(await editor.createPlan(prompt, selectedId ? [selectedId] : [])); setMessage("AI 计划已完成 dry-run，等待确认"); })}>生成变更预览</button>
      {preview && <div className={previewStale ? "preview stale" : "preview"}><strong>{preview.summary}</strong><p>影响：{preview.affectedNodeIds.join(", ") || "文档级"}</p><p>警告：{preview.warnings.length}</p>{previewStale && <p>文档已变化，请取消并重新生成计划。</p>}<div className="preview-actions"><button disabled={busy || previewStale} onClick={() => editor && void run(async () => { await editor.confirm(preview.planId); setDocument(project.snapshot()); setPreview(undefined); setMessage("AI 变更已确认"); })}>确认提交</button><button disabled={busy} onClick={() => { editor?.cancel(preview.planId); setPreview(undefined); }}>取消</button></div></div>}
    </aside>
  </div>;
}

function CanvasNode({ node, selected, onSelect }: { node: DesignNode; selected: boolean; onSelect(): void }) {
  const style: React.CSSProperties = { left: node.layout.x, top: node.layout.y, width: node.layout.width, height: node.layout.height, background: node.appearance.fill ?? "transparent", borderRadius: node.appearance.cornerRadius, opacity: node.appearance.opacity };
  return <button data-node-id={node.id} className={selected ? "node selected" : "node"} style={style} onClick={event => { event.stopPropagation(); onSelect(); }}>{node.type === "text" ? node.text : node.name}</button>;
}

function Field({ label, value, type = "text", onCommit }: { label: string; value: string | number; type?: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label>{label}<input type={type} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => String(value) !== draft && onCommit(draft)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

async function initialize() {
  const repository = new BrowserProjectRepository();
  try { return await StudioProject.open(repository, PROJECT_ID); }
  catch { return { project: await StudioProject.create(repository, PROJECT_ID, "本地设计", "page:1"), recovery: undefined }; }
}

function makeNode(type: "frame" | "text" | "rectangle", parentId: string): DesignNode {
  const id = `${type}:${crypto.randomUUID().slice(0, 8)}`;
  const common = { id, name: type === "text" ? "文本" : type === "frame" ? "Frame" : "矩形", parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x: 48, y: 48, width: type === "text" ? 160 : 240, height: type === "text" ? 48 : 140 }, appearance: { ...defaultAppearance(), fill: type === "text" ? "#ffffff" : "#8b5cf6", cornerRadius: 12 } };
  if (type === "text") return { ...common, type: "text", text: "双击编辑文本", fontFamily: "Inter", fontSize: 20, lineHeight: 28 };
  return { ...common, type };
}

const demoPlanner: AiPlanner = { async plan({ document }) { return { summary: "创建一个经过安全预演的蓝色卡片", assumptions: ["使用当前页面"], commands: [{ type: "node.create", payload: { node: { ...makeNode("frame", document.pageOrder[0]!), name: "AI 卡片", layout: { ...defaultLayout(), x: 340, y: 120, width: 280, height: 180 }, appearance: { ...defaultAppearance(), fill: "#2563eb", cornerRadius: 20 } } } }] }; } };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

createRoot(document.getElementById("root")!).render(<App />);
