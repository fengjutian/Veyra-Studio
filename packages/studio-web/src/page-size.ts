import type { DesignPage } from "@ufira/design-schema";

export const DEFAULT_PAGE_SIZE = { width: 960, height: 680 } as const;

export interface PageSizePreset {
  id: string;
  group: "桌面" | "平板" | "手机" | "演示" | "社交媒体";
  label: string;
  width: number;
  height: number;
}

export const PAGE_SIZE_PRESETS: readonly PageSizePreset[] = [
  { id: "desktop-hd", group: "桌面", label: "桌面 HD", width: 1440, height: 1024 },
  { id: "desktop-wide", group: "桌面", label: "桌面宽屏", width: 1280, height: 800 },
  { id: "desktop-compact", group: "桌面", label: "紧凑桌面", width: 960, height: 680 },
  { id: "tablet-landscape", group: "平板", label: "平板横屏", width: 1024, height: 768 },
  { id: "tablet-portrait", group: "平板", label: "平板竖屏", width: 768, height: 1024 },
  { id: "mobile-iphone", group: "手机", label: "手机 390", width: 390, height: 844 },
  { id: "mobile-modern", group: "手机", label: "手机 393", width: 393, height: 852 },
  { id: "mobile-android", group: "手机", label: "Android", width: 360, height: 800 },
  { id: "slides-fhd", group: "演示", label: "演示 16:9", width: 1920, height: 1080 },
  { id: "slides-hd", group: "演示", label: "演示 HD", width: 1280, height: 720 },
  { id: "social-square", group: "社交媒体", label: "方形帖子", width: 1080, height: 1080 },
  { id: "social-portrait", group: "社交媒体", label: "竖版帖子", width: 1080, height: 1350 },
  { id: "social-cover", group: "社交媒体", label: "横版封面", width: 1200, height: 628 },
] as const;

export function pageSize(page: Pick<DesignPage, "width" | "height"> | undefined) {
  return {
    width: page?.width ?? DEFAULT_PAGE_SIZE.width,
    height: page?.height ?? DEFAULT_PAGE_SIZE.height,
  };
}

export function matchingPageSizePreset(width: number, height: number): string {
  return PAGE_SIZE_PRESETS.find(item => item.width === width && item.height === height)?.id ?? "custom";
}
