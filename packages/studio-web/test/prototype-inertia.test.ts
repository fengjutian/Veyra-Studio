import assert from "node:assert/strict";
import test from "node:test";
import { decayVelocity, inertiaFinished, inertiaStep, INERTIA_MAX_STEP } from "../src/prototype/inertia";

/**
 * 惯性滚动的判定规则。
 *
 * 帧循环在 `preview.tsx` 里（要碰 React），「什么时候停、每帧走多远」这两条规则
 * 是纯的，放在 `inertia.ts` 里单独测。
 */

test("速度按固定比例衰减", () => {
  const decayed = decayVelocity({ x: 100, y: -50 });
  assert.equal(decayed.x, 100 * 0.92);
  assert.equal(decayed.y, -50 * 0.92);
  assert.equal(decayVelocity({ x: 100, y: -50 }, 0.5).x, 50);
});

test("一帧的步长有上限，快速甩动不会跳出去一大截", () => {
  assert.equal(inertiaStep({ x: 9999, y: 0 }).x, INERTIA_MAX_STEP);
  assert.equal(inertiaStep({ x: -9999, y: 0 }).x, -INERTIA_MAX_STEP);
  assert.equal(inertiaStep({ x: 12, y: -3 }).x, 12);
  assert.equal(inertiaStep({ x: Number.NaN, y: Number.NaN }).x, 0);
});

test("速度小到阈值以下就停", () => {
  assert.equal(inertiaFinished({ x: 0, y: 0 }), true);
  assert.equal(inertiaFinished({ x: 0.1, y: 0.2 }), true);
  assert.equal(inertiaFinished({ x: 3, y: 0 }), false);
  assert.equal(inertiaFinished({ x: 0, y: -3 }), false);
});

test("从滚轮速度衰减到停，需要有限帧", () => {
  let velocity = { x: 100, y: 0 };
  let frames = 0;
  while (!inertiaFinished(velocity) && frames < 1000) {
    velocity = decayVelocity(velocity);
    frames += 1;
  }
  assert.ok(frames < 1000, "不该无限衰减下去");
  assert.ok(frames > 10, "也不该一两帧就停——那样就没有滑行的手感了");
});
