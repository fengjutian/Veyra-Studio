import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const themeCss = readFileSync(fileURLToPath(new URL("../src/ui-theme.css", import.meta.url)), "utf8");

test("light theme covers every workbench page and overlay", () => {
  const requiredSurfaces = [
    ".pages-block",
    ".layer-tools",
    ".left-panel-tabs",
    ".inspector input",
    ".external-provider-row",
    ".history-row",
    ".storage-project",
    ".settings-page > .inspector-section",
    ".inspector-body > .inspector-section",
    ".settings-theme-option",
    ".topbar-ai-entry",
    ".toolbar-menu-content",
    ".dialog-content",
    ".context-menu",
    ".export-preview-body",
    ".prototype-preview",
    ".canvas-controls",
    ".ai-command-dock",
    ".ai-flow",
    ".workbench-feedback",
    ".ai-variant-status",
  ];

  for (const selector of requiredSurfaces) {
    assert.ok(themeCss.includes(selector), `missing light-theme coverage for ${selector}`);
  }
});
