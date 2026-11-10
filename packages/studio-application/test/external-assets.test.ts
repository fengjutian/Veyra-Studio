import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, type AssetMetadata, type DesignDocument } from "@ufira/design-schema";
import {
  attributionOf,
  buildExternalAssetMetadata,
  collectExternalAssetDiagnostics,
  collectExternalAttributions,
  createHttpExternalAssetProvider,
  findCachedExternalAsset,
  isExternalCacheStale,
  isProviderDisabled,
  planExternalProviderPurge,
  renderAttributionMarkdown,
  resolveExternalAsset,
  type ExternalAssetProvider,
} from "../src/index";
import { MemoryRepository } from "./memory-repository";

/**
 * 外部素材服务：缓存、归因、退出策略。
 *
 * 这三件事各自独立又互相牵扯：
 * - 缓存决定「要不要发请求」；
 * - 归因决定「交付物里要不要写清楚是谁的」；
 * - 退出策略决定「用户说不用了之后怎么办」。
 *
 * 退出最容易出错的地方是**把已有设计搞坏**：退出一个服务不该让已经插进画布的
 * 素材裂开，所以已缓存的素材必须继续可用。
 */

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function provider(overrides: Partial<ExternalAssetProvider> = {}): ExternalAssetProvider {
  return {
    id: "iconify",
    label: "Iconify",
    requiresAttribution: true,
    fetch: async () => ({ bytes: PNG, mimeType: "image/png", attribution: { author: "Ada", license: "CC-BY-4.0" } }),
    ...overrides,
  };
}

function documentWithAsset(asset: AssetMetadata, nodeId = "image:1"): DesignDocument {
  const document = createDocument("doc:ext", "Ext");
  document.assets[asset.id] = asset;
  document.nodes[nodeId] = {
    id: nodeId,
    type: "image",
    name: "图片",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { mode: "absolute", x: 0, y: 0, width: 100, height: 100 },
    appearance: { fills: [], strokes: [], strokeWidth: 1, cornerRadius: 0 },
    assetId: asset.id,
    fit: "cover",
  };
  document.pages["page:1"]!.childIds = [nodeId];
  return document;
}

test("缓存：同一个服务的同一个素材 id 第二次取不会发请求", async () => {
  let calls = 0;
  const service = provider({ fetch: async () => { calls += 1; return { bytes: PNG, mimeType: "image/png", attribution: { author: "Ada", license: "CC-BY-4.0" } }; } });
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");

  const first = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document, repository });
  assert.equal(first.kind, "fetched");
  await repository.putAsset(document.id, { hash: first.asset.hash, bytes: first.bytes });

  // 第二次：文档里已经有缓存，字节也在仓库里 → 不该再请求服务。
  const cachedDocument = documentWithAsset(first.asset);
  const second = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document: cachedDocument, repository });
  assert.equal(second.kind, "cached");
  assert.equal(calls, 1);
});

test("缓存：服务不可达时用过期缓存继续工作，并说明用的是过期缓存", async () => {
  const service = provider();
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const first = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document, repository });
  await repository.putAsset(document.id, { hash: first.asset.hash, bytes: first.bytes });

  const expired = { ...first.asset, external: { ...first.asset.external!, expiresAt: "2020-01-01T00:00:00.000Z" } };
  const cachedDocument = documentWithAsset(expired);
  const failing = provider({ fetch: async () => { throw new Error("服务不可达"); } });
  const result = await resolveExternalAsset({ provider: failing, externalId: "mdi:home", document: cachedDocument, repository });
  assert.equal(result.kind, "cached");
  assert.match(result.kind === "cached" ? result.note ?? "" : "", /过期缓存/);
});

test("缓存：缓存过期后会重新取一次", async () => {
  let calls = 0;
  const service = provider({ cacheTtlMs: 1000, fetch: async () => { calls += 1; return { bytes: PNG, mimeType: "image/png" }; } });
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const first = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document, repository, now: new Date("2026-01-01T00:00:00Z") });
  await repository.putAsset(document.id, { hash: first.asset.hash, bytes: first.bytes });
  const cachedDocument = documentWithAsset(first.asset);
  const later = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document: cachedDocument, repository, now: new Date("2026-01-01T01:00:00Z") });
  assert.equal(later.kind, "fetched");
  assert.equal(later.kind === "fetched" ? later.refreshed : false, true);
  assert.equal(calls, 2);
});

test("退出策略：退出后不再向服务发请求，已有缓存仍然可用", async () => {
  let calls = 0;
  const service = provider({ fetch: async () => { calls += 1; return { bytes: PNG, mimeType: "image/png" }; } });
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const first = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document, repository });
  await repository.putAsset(document.id, { hash: first.asset.hash, bytes: first.bytes });
  const cachedDocument = documentWithAsset(first.asset);

  const result = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document: cachedDocument, repository, disabledProviders: ["iconify"] });
  assert.equal(result.kind, "cached");
  assert.match(result.kind === "cached" ? result.note ?? "" : "", /已退出/);
  assert.equal(calls, 1);
});

test("退出策略：退出后没有缓存就拒绝，不会偷偷去请求", async () => {
  let calls = 0;
  const service = provider({ fetch: async () => { calls += 1; return { bytes: PNG, mimeType: "image/png" }; } });
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const result = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document, repository, disabledProviders: ["iconify"] });
  assert.equal(result.kind, "disabled");
  assert.equal(calls, 0);
});

test("归因：作者与许可证随素材一起记录，并出现在归因清单里", async () => {
  const service = provider();
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const result = await resolveExternalAsset({ provider: service, externalId: "mdi:home", document, repository });
  assert.equal(result.asset.origin?.author, "Ada");
  assert.equal(result.asset.origin?.license, "CC-BY-4.0");
  assert.equal(result.asset.external?.provider, "iconify");
  assert.equal(result.asset.external?.providerAssetId, "mdi:home");

  const entries = collectExternalAttributions(documentWithAsset(result.asset), { providers: [service] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.author, "Ada");
  assert.equal(entries[0]!.license, "CC-BY-4.0");
  assert.equal(entries[0]!.complete, true);
  assert.deepEqual(entries[0]!.usedBy, ["image:1"]);
});

test("归因：服务要求归因但作者或许可证缺失时，标为不完整并出诊断", () => {
  const asset = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "c".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    fetchedAt: new Date("2026-11-10T00:00:00Z"),
  });
  assert.equal(asset.origin?.author, undefined);
  const entries = collectExternalAttributions(documentWithAsset(asset), { providers: [provider()] });
  assert.equal(entries[0]!.complete, false);
  const diagnostics = collectExternalAssetDiagnostics(documentWithAsset(asset), { providers: [provider()] });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.feature, "external-asset");
  assert.match(diagnostics[0]!.message, /归因/);
});

test("归因：归因清单的 Markdown 里带作者、许可证与缺归因标记", () => {
  const asset = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "c".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    fetchedAt: new Date("2026-11-10T00:00:00Z"),
  });
  const markdown = renderAttributionMarkdown(collectExternalAttributions(documentWithAsset(asset), { providers: [provider()] }));
  assert.match(markdown, /# 素材归因/);
  assert.match(markdown, /归因不完整/);
});

test("退出策略：清缓存时，被节点引用的素材只报告不动手", () => {
  const asset = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "d".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    fetchedAt: new Date("2026-11-10T00:00:00Z"),
  });
  const unused = { ...asset, id: "asset:unused", hash: "e".repeat(64) };
  const document = documentWithAsset(asset);
  document.assets[unused.id] = unused;

  const plan = planExternalProviderPurge(document, "iconify");
  assert.equal(plan.removable.length, 1);
  assert.equal(plan.removable[0]!.id, "asset:unused");
  assert.equal(plan.referenced.length, 1);
  assert.deepEqual(plan.referenced[0]!.nodeIds, ["image:1"]);
});

test("退出策略：已退出的服务里的素材在诊断里被标出来", () => {
  const asset = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "f".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    attribution: { author: "Ada", license: "CC-BY-4.0" },
    fetchedAt: new Date("2026-11-10T00:00:00Z"),
  });
  const diagnostics = collectExternalAssetDiagnostics(documentWithAsset(asset), { providers: [provider()], disabledProviders: ["iconify"] });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!.message, /已退出/);
});

test("缓存：内容变了会重取，并报出旧的那条资源 id（内容变了 → 资源 id 变了）", async () => {
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const first = await resolveExternalAsset({
    provider: provider({ cacheTtlMs: 1000 }),
    externalId: "mdi:home",
    document,
    repository,
    now: new Date("2026-01-01T00:00:00Z"),
  });
  await repository.putAsset(document.id, { hash: first.asset.hash, bytes: first.bytes });

  const changed = provider({ fetch: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/png" }) });
  const cachedDocument = documentWithAsset(first.asset);
  const second = await resolveExternalAsset({ provider: changed, externalId: "mdi:home", document: cachedDocument, repository, now: new Date("2026-01-02T00:00:00Z") });
  assert.equal(second.kind, "fetched");
  assert.notEqual(second.kind === "fetched" ? second.asset.id : "", first.asset.id);
  assert.equal(second.kind === "fetched" ? second.supersededAssetId : "", first.asset.id);
});

test("缓存：同一个外部素材有多条记录时，命中最近拉取的那条", () => {
  const older = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "1".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const newer = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "2".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    fetchedAt: new Date("2026-01-02T00:00:00Z"),
  });
  const document = documentWithAsset(older);
  document.assets[newer.id] = newer;
  assert.equal(findCachedExternalAsset(document, "iconify", "mdi:home")?.id, newer.id);
});

test("工具函数：缓存查找、过期判断与退出判断", () => {
  const asset = buildExternalAssetMetadata({
    provider: provider(),
    externalId: "mdi:home",
    hash: "a".repeat(64),
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    attribution: { author: "Ada", license: "CC-BY-4.0" },
    fetchedAt: new Date("2026-11-10T00:00:00Z"),
    ttlMs: 3600000,
  });
  const document = documentWithAsset(asset);
  assert.equal(findCachedExternalAsset(document, "iconify", "mdi:home")?.id, asset.id);
  assert.equal(findCachedExternalAsset(document, "iconify", "mdi:other"), undefined);
  assert.equal(isExternalCacheStale(asset, new Date("2026-11-10T00:30:00Z")), false);
  assert.equal(isExternalCacheStale(asset, new Date("2026-11-10T02:00:00Z")), true);
  assert.equal(isProviderDisabled(["iconify"], "iconify"), true);
  assert.equal(isProviderDisabled([], "iconify"), false);
  assert.equal(attributionOf(asset)?.author, "Ada");
});

test("HTTP 服务：素材 id 会被编码，响应头里的归因被采信", async () => {
  const seen: string[] = [];
  const service = createHttpExternalAssetProvider({
    id: "cdn",
    label: "CDN",
    urlTemplate: "https://cdn.example.com/a/{id}.png",
    requiresAttribution: true,
    fetchImpl: (async (url: string) => {
      seen.push(url);
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png", "x-asset-author": "Grace", "x-asset-license": "MIT" } });
    }) as unknown as typeof fetch,
  });
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  const result = await resolveExternalAsset({ provider: service, externalId: "a/b?c", document, repository });
  assert.equal(seen[0], "https://cdn.example.com/a/a%2Fb%3Fc.png");
  assert.equal(result.asset.origin?.author, "Grace");
  assert.equal(result.asset.origin?.license, "MIT");
});

test("HTTP 服务：响应体超过上限时报错，不会把内容读进内存", async () => {
  const service = createHttpExternalAssetProvider({
    id: "cdn",
    label: "CDN",
    urlTemplate: "https://cdn.example.com/{id}",
    maxBytes: 4,
    fetchImpl: (async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
  });
  const repository = new MemoryRepository();
  const document = createDocument("doc:ext", "Ext");
  await assert.rejects(
    () => resolveExternalAsset({ provider: service, externalId: "big", document, repository }),
    /超过上限/,
  );
});
