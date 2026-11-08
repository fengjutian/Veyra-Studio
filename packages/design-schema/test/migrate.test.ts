import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_SCHEMA_VERSION,
  createDocument,
  defaultAppearance,
  defaultLayout,
  detectSchemaVersion,
  migrateDocument,
  validateDocument,
  type DesignDocument,
} from "../src/index";

/** 造一份 0.1.x 时代写出的文档：格式版本是 1，没有迁移历史。 */
function legacyDocument(): DesignDocument {
  const document = createDocument("doc:1", "Legacy");
  const legacy = document as unknown as Record<string, unknown>;
  legacy.schemaVersion = 1;
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Frame",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  document.pages["page:1"].childIds = ["node:1"];
  return document;
}

test("migrates a version 1 document to the current version", () => {
  const legacy = legacyDocument();
  const result = migrateDocument(legacy, { now: "2026-11-06T00:00:00.000Z" });

  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.document.schemaVersion, 3);
  assert.deepEqual(result.applied, [{ from: 1, to: 2, at: "2026-11-06T00:00:00.000Z" }, { from: 2, to: 3, at: "2026-11-06T00:00:00.000Z" }]);
  assert.deepEqual(result.document.migrations, [{ from: 1, to: 2, at: "2026-11-06T00:00:00.000Z" }, { from: 2, to: 3, at: "2026-11-06T00:00:00.000Z" }]);
});

test("keeps the node tree intact across a migration", () => {
  const legacy = legacyDocument();
  const result = migrateDocument(legacy);

  assert.deepEqual(result.document.nodes["node:1"], legacy.nodes["node:1"]);
  assert.deepEqual(result.document.pages["page:1"].childIds, ["node:1"]);
  assert.deepEqual(validateDocument(result.document), result.document);
});

test("does not mutate the source document", () => {
  const legacy = legacyDocument();
  const before = JSON.stringify(legacy);
  migrateDocument(legacy);

  assert.equal(JSON.stringify(legacy), before);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.migrations, undefined);
});

test("treats a current version document as already migrated", () => {
  const document = createDocument("doc:1", "Current");
  const result = migrateDocument(document);

  assert.deepEqual(result.applied, []);
  assert.equal(result.document.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("is idempotent", () => {
  const once = migrateDocument(legacyDocument());
  const twice = migrateDocument(once.document);

  assert.deepEqual(twice.applied, []);
  assert.deepEqual(twice.document.migrations, once.document.migrations);
});

test("refuses a document from a newer version", () => {
  const future = { ...createDocument("doc:1", "Future"), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
  assert.throws(() => migrateDocument(future), /高于当前支持的版本/);
});

test("refuses a document without a recognisable version", () => {
  const anonymous = { ...createDocument("doc:1", "Anonymous") } as Record<string, unknown>;
  delete anonymous.schemaVersion;

  assert.throws(() => migrateDocument(anonymous), /schemaVersion/);
});

test("reports validation failures of a migrated document", () => {
  const legacy = legacyDocument();
  const broken = { ...legacy, schemaVersion: 1 } as unknown as Record<string, unknown>;
  broken.nodes = { "node:1": { id: "node:1", type: "frame" } };

  assert.throws(() => migrateDocument(broken), /Invalid design document/);
});

test("detects the declared schema version", () => {
  assert.equal(detectSchemaVersion(createDocument("doc:1", "Demo")), CURRENT_SCHEMA_VERSION);
  assert.equal(detectSchemaVersion({ schemaVersion: 1 }), 1);
  assert.equal(detectSchemaVersion({ schemaVersion: "2" }), undefined);
  assert.equal(detectSchemaVersion({}), undefined);
  assert.equal(detectSchemaVersion(null), undefined);
});

test("migrates a v2 document fill into a paint layer", () => {
  const document = createDocument("doc:1", "Legacy");
  const legacy = document as unknown as Record<string, unknown>;
  legacy.schemaVersion = 2;
  document.nodes["node:1"] = {
    id: "node:1",
    type: "rectangle",
    name: "Card",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    // 旧形状：appearance.fill 是单值字符串。
    appearance: { opacity: 1, fill: "#8b5cf6", cornerRadius: 8 },
  } as unknown as DesignNode;
  document.pages["page:1"].childIds = ["node:1"];

  const result = migrateDocument(legacy);
  const appearance = result.document.nodes["node:1"]!.appearance;
  assert.deepEqual(appearance.fills, [{ type: "solid", color: "#8b5cf6" }]);
  assert.equal("fill" in appearance, false);
  // 圆角等其它字段原样保留。
  assert.equal(appearance.cornerRadius, 8);
});