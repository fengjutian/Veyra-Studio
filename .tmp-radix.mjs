import fs from "node:fs";

const path = "packages/studio-web/src/main.tsx";
let text = fs.readFileSync(path, "utf8");

const oldTabs = [
  '      <div className="inspector-tabs" role="tablist" aria-label="右侧面板分段">',
  '        {inspectorTabRows.map(tab => (',
  '          <button',
  '            key={tab.id}',
  '            type="button"',
  '            role="tab"',
  '            id={`inspector-tab-${tab.id}`}',
  '            aria-selected={inspectorTab === tab.id}',
  '            aria-controls="inspector-body"',
  '            className="inspector-tab"',
  '            onClick={() => setInspectorTab(tab.id)}',
  '          >',
  '            {tab.label}',
  '            {tab.badge ? <span className="inspector-tab-badge">{tab.badge}</span> : null}',
  '          </button>',
  '        ))}',
  '      </div>',
  '      <div className="inspector-body" id="inspector-body" role="tabpanel" aria-labelledby={`inspector-tab-${inspectorTab}`}>',
  '        {inspectorTab === "properties" && <>',
].join("\n");

const newTabs = [
  '      <Tabs.Root className="inspector-tabs-root" value={inspectorTab} onValueChange={value => setInspectorTab(value as InspectorTabId)}>',
  '        <Tabs.List className="inspector-tabs" aria-label="右侧面板分段">',
  '          {inspectorTabRows.map(tab => (',
  '            <Tabs.Trigger key={tab.id} value={tab.id} className="inspector-tab">',
  '              {tab.label}',
  '              {tab.badge ? <span className="inspector-tab-badge">{tab.badge}</span> : null}',
  '            </Tabs.Trigger>',
  '          ))}',
  '        </Tabs.List>',
  '        <Tabs.Content value="properties" className="inspector-body">',
].join("\n");

const boundaries = [
  ["export", "export"],
  ["history", "history"],
  ["data", "data"],
  ["ai", "ai"],
];

function replaceOnce(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(search, replacement);
}

text = replaceOnce(text, oldTabs, newTabs, "tabs block");

for (const [value, id] of boundaries) {
  const search = `        </>}\n        {inspectorTab === "${id}" && <>`;
  const replacement = `        </Tabs.Content>\n        <Tabs.Content value="${value}" className="inspector-body">`;
  text = replaceOnce(text, search, replacement, `${id} boundary`);
}

text = replaceOnce(
  text,
  '        </>}\n      </div>\n      <div className="inspector-foot">',
  '        </Tabs.Content>\n      </Tabs.Root>\n      <div className="inspector-foot">',
  "closing boundary",
);

fs.writeFileSync(path, text);
console.log("rewrote inspector tabs to Radix Tabs");
