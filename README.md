# Workspace Orchestrator

Workspace Orchestrator is a local Obsidian plugin for treating panes, tabs, plugin views, canvases, Bases, and sessions as a controllable workspace.

## What works in this build

- Focus visible panes forward and backward.
- Focus visible pane 1-9.
- Focus nearest pane up, down, left, or right.
- Toggle a reversible focus mode for the active pane.
- Assign the active pane to a named region such as `draft`, `reference`, `scratch`, or `dashboard`.
- Open the active file into a selected region.
- Open built-in view types such as search, graph, backlinks, outline, and file explorer into a selected region.
- Save the current Obsidian workspace layout as a session.
- Restore saved sessions.
- Review missing files and plugin-view dependencies before restoring a session or template.
- Use the layout designer to inspect the current surface grid, assign regions, duplicate panes, and inspect the serialized workspace tree.
- Capture reusable templates from the current workspace.
- Capture variable templates with placeholders such as `{{activeFile}}`, `{{activeFolder}}`, `{{activeBasename}}`, `{{date}}`, `{{datetime}}`, and custom variables.
- Apply saved templates.
- Export and import sessions/templates as declarative JSON packs with validation.

## Architecture

The plugin uses Obsidian's native workspace primitives instead of replacing them:

- `Workspace.getLayout()` and `Workspace.changeLayout()` for session and template restoration.
- `Workspace.iterateRootLeaves()` / `iterateAllLeaves()` for focus rings.
- `Workspace.setActiveLeaf()` and `Workspace.revealLeaf()` for navigation.
- `WorkspaceLeaf.getViewState()` / `setViewState()` for note, canvas, graph, search, and plugin views.

The plugin stores metadata in its own `data.json`; it does not store file contents.

Pack format details live in `PACK_SCHEMA.md`.

## Install manually

Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/workspace-orchestrator/`, then enable the plugin under **Settings → Community plugins**. The readable JavaScript implementation is in `main.js`.

## Trust model

- No network calls.
- No telemetry.
- No arbitrary JavaScript in imported packs.
- Imported packs must be JSON objects with `sessions` and/or `templates` arrays.
- Imported packs are size-limited, item-limited, and validated before any session/template is added.

## Suggested next milestones

- Drag/drop region assignment inside the layout designer.
- Template variable transforms for tags and active project metadata.
- Pack signing or trusted-source metadata for a future marketplace.
- Optional dependency metadata for community plugin views.
- Rich conflict resolution when files or plugin view types are missing.

## License

MIT. See [LICENSE](LICENSE).
