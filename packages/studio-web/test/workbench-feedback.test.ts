import assert from "node:assert/strict";
import test from "node:test";
import { feedbackTone } from "../src/ui/workbench-feedback";

test("工作台反馈按消息语义分类", () => {
  assert.equal(feedbackTone("项目已创建"), "success");
  assert.equal(feedbackTone("没有匹配的图层"), "warning");
  assert.equal(feedbackTone("导出失败：磁盘不可写"), "error");
  assert.equal(feedbackTone("正在生成候选方案"), "neutral");
});
