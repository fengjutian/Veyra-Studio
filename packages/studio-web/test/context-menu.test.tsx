// @vitest-environment jsdom
/**
 * 画布右键菜单的回归测试。
 *
 * 浏览器端无法用自动化点击派发 `contextmenu` 事件，所以这里直接构造该事件，
 * 验证三件事：命中节点的判定、Radix 菜单的开关、以及菜单项的 onSelect 接线。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuTrigger,
  resolveContextNodeId,
} from "../src/ui/context-menu";

beforeAll(() => {
  // Radix 菜单依赖这些浏览器 API，jsdom 没有实现。
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => cleanup());

function fireContextMenu(element: Element) {
  act(() => {
    fireEvent.contextMenu(element, { clientX: 12, clientY: 24 });
  });
}

describe("resolveContextNodeId", () => {
  it("returns the closest node id for a hit", () => {
    const node = document.createElement("div");
    node.dataset.nodeId = "rectangle:1";
    const child = document.createElement("span");
    node.append(child);
    expect(resolveContextNodeId(child)).toBe("rectangle:1");
  });

  it("returns undefined on empty canvas", () => {
    const canvas = document.createElement("div");
    expect(resolveContextNodeId(canvas)).toBeUndefined();
  });

  it("returns undefined for a target without closest", () => {
    expect(resolveContextNodeId({} as unknown as EventTarget)).toBeUndefined();
    expect(resolveContextNodeId(null)).toBeUndefined();
  });
});

describe("ContextMenu", () => {
  it("opens on a contextmenu event and renders the items", () => {
    render(
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <button type="button">画布</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon="copy" onSelect={() => undefined}>复制</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon="trash" danger onSelect={() => undefined}>删除</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>,
    );

    expect(screen.queryByRole("menu")).toBeNull();
    fireContextMenu(screen.getByRole("button", { name: "画布" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("复制")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("invokes onSelect when an item is chosen", () => {
    const onSelect = vi.fn();
    render(
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <button type="button">画布</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon="copy" onSelect={onSelect}>复制</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>,
    );

    fireContextMenu(screen.getByRole("button", { name: "画布" }));
    act(() => {
      fireEvent.click(screen.getByText("复制"));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("never invokes onSelect for a disabled item", () => {
    const onSelect = vi.fn();
    render(
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <button type="button">画布</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon="paste" disabled onSelect={onSelect}>粘贴</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>,
    );

    fireContextMenu(screen.getByRole("button", { name: "画布" }));
    act(() => {
      fireEvent.click(screen.getByText("粘贴"));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens a submenu and reports its items", () => {
    const onSelect = vi.fn();
    render(
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <button type="button">画布</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub label="图层顺序" icon="layerOrder">
            <ContextMenuItem icon="toFront" onSelect={onSelect}>置顶</ContextMenuItem>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenuRoot>,
    );

    fireContextMenu(screen.getByRole("button", { name: "画布" }));
    expect(screen.getByText("图层顺序")).toBeTruthy();
    act(() => {
      fireEvent.pointerDown(screen.getByText("图层顺序"), { pointerType: "mouse", ctrlKey: false, button: 0 });
    });
    act(() => {
      fireEvent.click(screen.getByText("置顶"));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
