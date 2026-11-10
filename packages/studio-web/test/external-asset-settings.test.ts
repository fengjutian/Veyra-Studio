import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_ASSET_HEADERS_SESSION_KEY,
  EXTERNAL_ASSET_SETTINGS_KEY,
  isExternalProviderDisabled,
  providerConfigFromInput,
  providerInputFromConfig,
  readExternalAssetSettings,
  setProviderDisabled,
  validateProviderInput,
  writeExternalAssetSettings,
  type ExternalAssetStorage,
} from "../src/external-asset-settings";

/**
 * 外部素材服务的工作台设置。
 *
 * 两条不变量：
 * - **授权头不落盘**：它跟 AI 密钥一个待遇，只在本次会话里。
 * - **退出清单要跟着用户走**：关掉浏览器再打开，用户退出过的服务仍然不该被请求。
 */

function memoryStorage(): ExternalAssetStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

const validInput = {
  id: "iconify",
  label: "Iconify",
  urlTemplate: "https://api.iconify.design/{id}.svg",
  requiresAttribution: "yes",
  cacheTtlHours: "24",
  author: "Iconify Authors",
  license: "CC-BY-4.0",
  source: "https://iconify.design",
};

test("校验：地址模板必须含 {id} 且是 https", () => {
  assert.equal(validateProviderInput({ ...validInput, urlTemplate: "https://x.com/a.png" }), "地址模板里要有 {id} 占位符");
  assert.equal(validateProviderInput({ ...validInput, urlTemplate: "http://x.com/{id}" }), "地址模板必须以 https:// 开头");
  assert.equal(validateProviderInput({ ...validInput, id: "" }), "服务标识不能为空");
  assert.equal(validateProviderInput({ ...validInput, label: " " }), "服务名称不能为空");
  assert.equal(validateProviderInput(validInput), undefined);
});

test("校验：服务标识只允许字母数字与少量符号", () => {
  assert.match(validateProviderInput({ ...validInput, id: "a/b" }) ?? "", /只能用/);
  assert.equal(validateProviderInput({ ...validInput, id: "iconify.v2" }), undefined);
});

test("表单值与服务配置可以来回转换", () => {
  const config = providerConfigFromInput(validInput);
  assert.ok(config);
  assert.equal(config.id, "iconify");
  assert.equal(config.requiresAttribution, true);
  assert.equal(config.cacheTtlMs, 24 * 3600000);
  assert.equal(config.attribution?.author, "Iconify Authors");
  assert.equal(config.attribution?.source, "https://iconify.design");
  const roundTrip = providerInputFromConfig(config);
  assert.equal(roundTrip.id, "iconify");
  assert.equal(roundTrip.source, "https://iconify.design");
});

test("设置：授权头只写进会话存储，不落盘", () => {
  const persistent = memoryStorage();
  const session = memoryStorage();
  writeExternalAssetSettings({
    providers: [providerConfigFromInput(validInput)!],
    disabledProviders: [],
    headers: { iconify: { Authorization: "Bearer secret" } },
  }, persistent, session);

  const dumped = persistent.dump();
  assert.ok(dumped[EXTERNAL_ASSET_SETTINGS_KEY]);
  assert.equal(JSON.stringify(dumped).includes("secret"), false);
  assert.ok(session.dump()[EXTERNAL_ASSET_HEADERS_SESSION_KEY]);
});

test("设置：服务清单与退出清单刷新后还在", () => {
  const persistent = memoryStorage();
  const session = memoryStorage();
  const settings = {
    providers: [providerConfigFromInput(validInput)!],
    disabledProviders: ["iconify"],
    headers: {},
  };
  writeExternalAssetSettings(settings, persistent, session);
  const read = readExternalAssetSettings(persistent, session);
  assert.equal(read.providers.length, 1);
  assert.equal(read.providers[0]!.id, "iconify");
  assert.deepEqual(read.disabledProviders, ["iconify"]);
});

test("退出：退出与重新加入只影响目标服务", () => {
  const settings = { providers: [], disabledProviders: ["other"], headers: {} };
  const exited = setProviderDisabled(settings, "iconify", true);
  assert.deepEqual(exited.disabledProviders, ["other", "iconify"]);
  assert.equal(isExternalProviderDisabled(exited, "iconify"), true);
  const back = setProviderDisabled(exited, "iconify", false);
  assert.deepEqual(back.disabledProviders, ["other"]);
  assert.equal(isExternalProviderDisabled(back, "iconify"), false);
});

test("设置：读坏的存储不拖垮工作台", () => {
  const persistent = memoryStorage();
  persistent.setItem(EXTERNAL_ASSET_SETTINGS_KEY, "{不是 JSON");
  const read = readExternalAssetSettings(persistent, memoryStorage());
  assert.deepEqual(read.providers, []);
  assert.deepEqual(read.disabledProviders, []);
});
