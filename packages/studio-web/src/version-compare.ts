import type { DesignDocument } from "@ufira/design-schema";

/**
 * 版本对比预览的范围对齐。
 *
 * 并排对比要成立，两侧必须导出**同一批节点、同一份视口**——否则左右两张图
 * 根本不是同一件事，看不出差异。麻烦的是历史版本和当前版本不一定一样：
 * 选中的对象可能是后来才建的，当时的页面也还不存在。
 *
 * 这些情况一律**退回整页并把话说出来**，不静默换一个范围：用户以为自己在
 * 对比选区，实际上看的是整页，这种"看起来能用"的对比比没有对比更糟。
 */

export interface CompareScopePlan {
  /** 两侧共用的页面 id（历史版本里必须也有这一页）。 */
  pageId: string;
  /** 两侧共用的导出范围（节点 id 列表）；空 = 整页。 */
  nodeIds?: string[];
  /** 范围被调整过时的说明（给用户看）。 */
  note?: string;
}

/**
 * 对比范围的结果。
 *
 * 「没法比」和「比整页」是两种不同的情况，必须分开：
 * 没法比时要说清**为什么**（历史版本里还没有这一页），否则用户看到的是
 * 两幅根本不相干的画面，还以为差异是内容改出来的。
 */
export type CompareScopeResult =
  | { ok: true; plan: CompareScopePlan }
  | { ok: false; reason: string };

/**
 * 算出两侧该怎么导出。
 *
 * 规则：
 * ① 页面：两侧必须是**同一页**。历史版本里没有用户正在看的那一页时，
 *    没法比——拿另一个页面凑数只会得到一幅不相干的画面。
 * ② 范围：选中的对象在历史版本里全都存在才按选区对比；缺一部分就只对比剩下
 *    的（并说明少了几个）；一个都没有就退回整页。
 */
export function planVersionCompareScope(options: {
  currentNodeIds?: string[];
  /** 用户正在看的那一页。 */
  currentPageId: string;
  current: DesignDocument;
  historical: DesignDocument;
}): CompareScopeResult {
  const { currentNodeIds, currentPageId, current, historical } = options;

  // ① 页面。
  if (!historical.pages[currentPageId]) {
    const name = current.pages[currentPageId]?.name ?? currentPageId;
    return { ok: false, reason: `这个版本里还没有「${name}」这一页，没法并排对比` };
  }

  // ② 范围。
  if (currentNodeIds?.length) {
    const shared = currentNodeIds.filter(id => Boolean(historical.nodes[id]));
    if (!shared.length) {
      return {
        ok: true,
        plan: { pageId: currentPageId, note: "这个版本里没有选中的对象，已改为整页对比" },
      };
    }
    if (shared.length < currentNodeIds.length) {
      return {
        ok: true,
        plan: {
          pageId: currentPageId,
          nodeIds: shared,
          note: `这个版本里缺少 ${currentNodeIds.length - shared.length} 个选中对象，已按剩下的对比`,
        },
      };
    }
    return { ok: true, plan: { pageId: currentPageId, nodeIds: shared } };
  }

  return { ok: true, plan: { pageId: currentPageId } };
}

/** 对比弹窗两栏的标题。 */
export interface ComparePaneTitles {
  /** 左侧：历史版本。 */
  historical: string;
  /** 右侧：当前版本。 */
  current: string;
}

/**
 * 两栏的标题。
 *
 * 左边写清楚是哪一版（标签 + 时间），右边写清楚是当前——不看标题就没法判断
 * 左右谁新谁旧。
 */
export function comparePaneTitles(options: { label: string; updatedAt: string; currentLabel?: string }): ComparePaneTitles {
  return {
    historical: `${options.label}（${formatCompareTime(options.updatedAt)}）`,
    current: options.currentLabel ?? "当前",
  };
}

/** 版本时间戳的短格式：同一天只写时分，跨天补上日期。 */
export function formatCompareTime(updatedAt: string, now = new Date()): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return updatedAt;
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return time;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
