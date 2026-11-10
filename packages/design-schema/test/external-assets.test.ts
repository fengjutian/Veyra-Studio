import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, validateDocument, type DesignDocument } from "../src/index";

/**
 * 外部素材的来源记录。
 *
 * 关键在于它必须能**活着通过 schema**：zod 会剥掉未声明的字段，一旦漏登记，
 * 这份记录会在校验时被悄悄丢掉（缓存键没了，同一份素材会被反复请求）。
 */

function documentWithExternalAsset(): DesignDocument {
  const document = createDocument("doc:external", "External");
  document.assets = {
    "asset:abc": {
      id: "asset:abc",
      hash: "a".repeat(64),
      mimeType: "image/png",
      byteLength: 128,
      name: "icon.png",
      origin: { source: "https://cdn.example.com/icon.png", author: "Ada", license: "CC-BY-4.0" },
      external: {
        provider: "iconify",
        providerAssetId: "mdi:home",
        fetchedAt: "2026-11-10T00:00:00.000Z",
        expiresAt: "2026-11-17T00:00:00.000Z",
      },
    },
  };
  return document;
}

test("外部素材记录：能通过文档校验，且字段不会被剥掉", () => {
  const document = documentWithExternalAsset();
  const parsed = validateDocument(document);
  assert.deepEqual(parsed.assets["asset:abc"]!.external, document.assets["asset:abc"]!.external);
  assert.deepEqual(parsed.assets["asset:abc"]!.origin, document.assets["asset:abc"]!.origin);
});

test("外部素材记录：没有过期时间也是合法的（永不过期）", () => {
  const document = documentWithExternalAsset();
  delete document.assets["asset:abc"]!.external!.expiresAt;
  assert.deepEqual(validateDocument(document).assets["asset:abc"]!.external, {
    provider: "iconify",
    providerAssetId: "mdi:home",
    fetchedAt: "2026-11-10T00:00:00.000Z",
  });
});

test("外部素材记录：provider 或素材 id 为空时校验不通过", () => {
  const document = documentWithExternalAsset();
  document.assets["asset:abc"]!.external!.provider = "";
  assert.throws(() => validateDocument(document));

  const other = documentWithExternalAsset();
  other.assets["asset:abc"]!.external!.providerAssetId = "";
  assert.throws(() => validateDocument(other));
});

test("外部素材记录：拉取时间不是 ISO 时间戳时校验不通过", () => {
  const document = documentWithExternalAsset();
  document.assets["asset:abc"]!.external!.fetchedAt = "昨天";
  assert.throws(() => validateDocument(document));
});

test("外部素材记录：本地素材没有这个字段也完全合法", () => {
  const document = createDocument("doc:local", "Local");
  document.assets = {
    "asset:local": { id: "asset:local", hash: "b".repeat(64), mimeType: "image/png", byteLength: 10 },
  };
  const parsed = validateDocument(document);
  assert.equal(parsed.assets["asset:local"]!.external, undefined);
});
