import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, type DesignDocument } from "@ufira/design-schema";
import { comparePaneTitles, formatCompareTime, planVersionCompareScope } from "../src/version-compare";

/**
 * 版本对比范围对齐的单测。
 *
 * 这一层决定「左右两张图是不是同一件事」。范围对不上还照样并排展示，比没有
 * 对比更糟——用户会以为自己看的是选区差异，其实是两幅不相干的画面。
 */

/** 造一份有两个节点、一页的文档。 */
function documentWith(nodeIds: string[], pageId = "page:1"): DesignDocument {
  const document = createDocument("project:1", "对比项目", pageId);
  for (const id of nodeIds) {
    document.nodes[id] = {
      id,
      name: id,
      type: "frame",
      parentId: pageId,
      layout: { x: 0, y: 0, width: 100, height: 100 },
    } as DesignDocument["nodes"][string];
  }
  document.pages[pageId]!.childIds = [...nodeIds];
  return document;
}

test("两侧都有这些对象时按选区对比", () => {
  const current = documentWith(["a", "b"]);
  const historical = documentWith(["a", "b"]);
  const result = planVersionCompareScope({ currentNodeIds: ["a", "b"], currentPageId: "page:1", current, historical });
  assert.ok(result.ok);
  assert.deepEqual(result.plan.nodeIds, ["a", "b"]);
  assert.equal(result.plan.pageId, "page:1");
  assert.equal(result.plan.note, undefined);
});

test("没有选中时按整页对比", () => {
  const current = documentWith(["a"]);
  const historical = documentWith(["a"]);
  const result = planVersionCompareScope({ currentPageId: "page:1", current, historical });
  assert.ok(result.ok);
  assert.equal(result.plan.nodeIds, undefined);
  assert.equal(result.plan.note, undefined);
});

test("历史版本里没有选中的对象时退回整页并说明原因", () => {
  const current = documentWith(["a"]);
  const historical = documentWith([]);
  const result = planVersionCompareScope({ currentNodeIds: ["later"], currentPageId: "page:1", current, historical });
  assert.ok(result.ok);
  assert.equal(result.plan.nodeIds, undefined);
  assert.match(result.plan.note ?? "", /没有选中的对象/);
});

test("历史版本里缺少部分选中对象时只对比剩下的，并说明少了几个", () => {
  const current = documentWith(["a", "b"]);
  const historical = documentWith(["a"]);
  const result = planVersionCompareScope({ currentNodeIds: ["a", "b"], currentPageId: "page:1", current, historical });
  assert.ok(result.ok);
  assert.deepEqual(result.plan.nodeIds, ["a"]);
  assert.match(result.plan.note ?? "", /缺少 1 个选中对象/);
});

test("历史版本里没有当前这一页时没法比，并说清缺哪一页", () => {
  const current = documentWith(["a"], "page:2");
  const historical = documentWith(["a"], "page:1");
  const result = planVersionCompareScope({ currentPageId: "page:2", current, historical });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /还没有/);
});

test("对比用的是用户正在看的那一页，不是第一页", () => {
  const current = documentWith(["a"], "page:1");
  current.pageOrder = ["page:1", "page:2"];
  current.pages["page:2"] = { id: "page:2", name: "第二页", childIds: [] };
  const historical = documentWith(["a"], "page:1");
  historical.pageOrder = ["page:1", "page:2"];
  historical.pages["page:2"] = { id: "page:2", name: "第二页", childIds: [] };
  const result = planVersionCompareScope({ currentPageId: "page:2", current, historical });
  assert.ok(result.ok);
  assert.equal(result.plan.pageId, "page:2");
});

test("两栏标题：左边是哪一版，右边是当前", () => {
  const titles = comparePaneTitles({ label: "r3", updatedAt: "2026-11-09T10:20:00.000Z" });
  assert.match(titles.historical, /r3/);
  assert.equal(titles.current, "当前");
});

test("同一天的时间只写时分，跨天补上日期", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  const sameDay = formatCompareTime("2026-11-09T10:20:00.000Z", now);
  const otherDay = formatCompareTime("2026-11-01T10:20:00.000Z", now);
  assert.match(sameDay, /^\d{2}:\d{2}$/);
  assert.match(otherDay, /月.*日/);
});

test("时间戳坏了就原样返回，不显示 NaN", () => {
  assert.equal(formatCompareTime("不是时间", new Date()), "不是时间");
});
