import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const themeCss = readFileSync(fileURLToPath(new URL("../src/ui-theme.css", import.meta.url)), "utf8");

test("light theme covers every workbench page and overlay", () => {
  const requiredSurfaces = [
    ".pages-block",
    ".layer-tools",
    ".inspector input",
    ".external-provider-row",
    ".history-row",
    ".storage-project",
    ".settings-page > .inspector-section",
    ".settings-theme-option",
    ".topbar-ai-entry",
    ".dialog-content",
    ".context-menu",
    ".export-preview-body",
    ".prototype-preview",
    ".canvas-controls",
    ".ai-command-dock",
  ];

  for (const selector of requiredSurfaces) {
    assert.ok(themeCss.includes(selector), `missing light-theme coverage for ${selector}`);
  }
});
