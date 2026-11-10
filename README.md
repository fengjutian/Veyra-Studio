# Veyra

A local-first, host-independent AI interface design environment.

> **Phase 0:** The standalone Studio is under active development but is not yet a
> usable editor. The former MCP-to-Figma bridge is legacy reference code and
> must not be used as the product runtime or the default development path.

## Current scope

Implemented foundations:

- `packages/design-schema` — document types, schemas, and validation;
- `packages/design-runtime` — command and transaction runtime prototype;
- `packages/design-persistence` — filesystem persistence prototype.

The standalone UI, interactive canvas, production renderer, export pipeline, and
complete AI editing loop are not yet implemented.

See [Current Project Status](./docs/current-project-status.md) for authoritative status
and [Veyra Architecture](./docs/ai-design-studio-architecture-analysis.md)
for the draft target architecture.

See [Project Progress and Version Roadmap](./docs/project-progress-and-version-roadmap.md)
for the Studio version baseline, per-version scope, and release gates.

## Development

```bash
npm install
npm run build:studio-core
npm run test:studio-core
```

These commands verify only the Phase 0 foundation packages.

## Desktop app

`packages/studio-desktop` is a Tauri v2 shell around the same studio-web frontend:
same editor, plus a native window and a native "Save As" dialog (exports no longer
land in the browser's download directory).

```bash
npm run dev:desktop     # dev mode
npm run build:desktop   # produce the executable and the NSIS installer
```

See the [desktop app doc](./docs/desktop-app.md) for the design and the trade-offs.

## Legacy bridge code

The old Figma packages, relay, plugin, schemas, and setup guides are retained only
for controlled migration and behavior reference. For new development, do not run the
relay, connect the Figma plugin, configure the old MCP server, or make Studio packages
depend on the legacy Figma runtime code.

## License

[MIT](./LICENSE) · 第三方组件许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)
