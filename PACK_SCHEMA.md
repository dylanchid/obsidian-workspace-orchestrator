# Workspace Orchestrator Pack Schema

Workspace packs are declarative JSON. They do not execute code.

```json
{
  "type": "workspace-orchestrator-pack",
  "version": 1,
  "name": "Research Pack",
  "sessions": [],
  "templates": []
}
```

## Session

```json
{
  "kind": "session",
  "name": "Current Project",
  "version": 1,
  "layout": {},
  "regions": {},
  "requirements": ["markdown", "canvas"],
  "activeRegion": "draft"
}
```

Sessions should represent live work states. They are allowed to contain specific file paths.

## Template

```json
{
  "kind": "template",
  "name": "Research Dashboard",
  "version": 1,
  "layout": {},
  "regions": {},
  "requirements": ["markdown", "search", "backlink"],
  "activeRegion": "draft",
  "variables": [
    {
      "key": "project",
      "label": "Project folder",
      "defaultValue": "Work/Projects"
    }
  ]
}
```

Templates are reusable blueprints. Any string inside `layout` or `regions` can use variables.

## Built-In Variables

- `{{activeFile}}`
- `{{activeFolder}}`
- `{{activeBasename}}`
- `{{date}}`
- `{{datetime}}`

## Validation

Imports are rejected when:

- The JSON is invalid.
- The pack is larger than the plugin limit.
- The pack contains more than the plugin item limit.
- A session/template has no name.
- A session/template has no layout object.
- `sessions`, `templates`, `regions`, or `variables` have the wrong shape.

Plugin view types are allowed but reported as warnings because the importing vault may not have the same plugins installed.
