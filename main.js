const {
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "workspace-orchestrator-panel";

const COMMON_REGIONS = [
  "draft",
  "reference",
  "scratch",
  "dashboard",
  "canvas",
  "database",
  "graph",
  "search",
];

const VIEW_PRESETS = [
  { name: "Search", type: "search", state: {} },
  { name: "Graph", type: "graph", state: {} },
  { name: "Backlinks", type: "backlink", state: {} },
  { name: "Outgoing Links", type: "outgoing-link", state: {} },
  { name: "Outline", type: "outline", state: {} },
  { name: "File Explorer", type: "file-explorer", state: {} },
];

const BUILT_IN_TEMPLATE_VARIABLES = [
  { key: "activeFile", label: "Active file path" },
  { key: "activeFolder", label: "Active file folder" },
  { key: "activeBasename", label: "Active file name without extension" },
  { key: "date", label: "Current date" },
  { key: "datetime", label: "Current date and time" },
];

const MAX_PACK_BYTES = 2_000_000;
const MAX_IMPORT_ITEMS = 100;
const MAX_NAME_LENGTH = 120;

const DEFAULT_SETTINGS = {
  version: 1,
  includeSidebarsInFocusRing: false,
  showPaneNumbers: true,
  autoSaveBeforeSessionSwitch: true,
  activeSessionId: null,
  regions: {},
  sessions: [],
  templates: [],
};

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function normalizeRegionName(value) {
  return safeText(value)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase();
}

function normalizeVariableKey(value) {
  return safeText(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "");
}

function getStatePath(state) {
  if (!state || typeof state !== "object") return "";
  return safeText(state.file || state.path || state.source || state.query || "");
}

function viewStateFingerprint(viewState) {
  const type = safeText(viewState && viewState.type, "unknown");
  const state = viewState && viewState.state ? viewState.state : {};
  const primary = getStatePath(state);
  if (primary) return `${type}:${primary}`;

  let serialized = "";
  try {
    serialized = JSON.stringify(state);
  } catch (error) {
    serialized = "";
  }
  return `${type}:${serialized.slice(0, 240)}`;
}

function basenameWithoutExtension(path) {
  const filename = safeText(path).split("/").pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

function dirname(path) {
  const parts = safeText(path).split("/");
  parts.pop();
  return parts.join("/");
}

function replaceTemplateVariables(value, variables) {
  return safeText(value).replace(/\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return safeText(variables[key]);
    }
    return match;
  });
}

function resolveTemplateValue(value, variables) {
  if (typeof value === "string") {
    return replaceTemplateVariables(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, variables));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = resolveTemplateValue(child, variables);
    }
    return next;
  }
  return value;
}

function collectViewTypesFromLayout(value, types = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectViewTypesFromLayout(item, types));
    return types;
  }
  if (!value || typeof value !== "object") return types;

  if (typeof value.type === "string" && !["split", "tabs", "leaf"].includes(value.type)) {
    types.add(value.type);
  }
  for (const child of Object.values(value)) {
    collectViewTypesFromLayout(child, types);
  }
  return types;
}

function collectFilePathsFromLayout(value, paths = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFilePathsFromLayout(item, paths));
    return paths;
  }
  if (!value || typeof value !== "object") return paths;

  if (typeof value.file === "string") paths.add(value.file);
  if (typeof value.path === "string" && /\.(md|canvas|base)$/i.test(value.path)) paths.add(value.path);
  for (const child of Object.values(value)) {
    collectFilePathsFromLayout(child, paths);
  }
  return paths;
}

function normalizeTemplateVariables(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const key = normalizeVariableKey(item && item.key);
      if (!key) return null;
      return {
        key,
        label: safeText(item.label || key).slice(0, MAX_NAME_LENGTH),
        defaultValue: safeText(item.defaultValue || ""),
      };
    })
    .filter(Boolean);
}

function validateWorkspaceObject(item, kind) {
  const errors = [];
  const warnings = [];
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { errors: [`${kind} is not an object.`], warnings };
  }
  const name = safeText(item.name).trim();
  if (!name) errors.push(`${kind} is missing a name.`);
  if (name.length > MAX_NAME_LENGTH) errors.push(`${kind} name is too long.`);
  if (!item.layout || typeof item.layout !== "object" || Array.isArray(item.layout)) {
    errors.push(`${name || kind} has no layout object.`);
  }
  if (item.regions && (typeof item.regions !== "object" || Array.isArray(item.regions))) {
    errors.push(`${name || kind} regions must be an object.`);
  }
  if (item.variables && !Array.isArray(item.variables)) {
    errors.push(`${name || kind} variables must be an array.`);
  }
  const viewTypes = item.layout ? Array.from(collectViewTypesFromLayout(item.layout)) : [];
  const unusualViewTypes = viewTypes.filter((type) => type && ![
    "markdown",
    "canvas",
    "base",
    "search",
    "graph",
    "backlink",
    "outgoing-link",
    "outline",
    "file-explorer",
    VIEW_TYPE,
  ].includes(type));
  if (unusualViewTypes.length) {
    warnings.push(`${name || kind} references plugin view types: ${unusualViewTypes.join(", ")}.`);
  }
  return { errors, warnings };
}

function validateWorkspacePack(rawText, parsed) {
  const errors = [];
  const warnings = [];
  if (rawText.length > MAX_PACK_BYTES) {
    errors.push("Pack is too large.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("Pack must be a JSON object.");
    return { errors, warnings };
  }
  if (parsed.type && parsed.type !== "workspace-orchestrator-pack") {
    errors.push("Pack type is not workspace-orchestrator-pack.");
  }
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const templates = Array.isArray(parsed.templates) ? parsed.templates : [];
  if (!Array.isArray(parsed.sessions || [])) errors.push("sessions must be an array.");
  if (!Array.isArray(parsed.templates || [])) errors.push("templates must be an array.");
  if (sessions.length + templates.length > MAX_IMPORT_ITEMS) {
    errors.push(`Pack has more than ${MAX_IMPORT_ITEMS} importable items.`);
  }
  sessions.forEach((session, index) => {
    const result = validateWorkspaceObject(session, `session ${index + 1}`);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  });
  templates.forEach((template, index) => {
    const result = validateWorkspaceObject(template, `template ${index + 1}`);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  });
  return { errors, warnings };
}

function createButton(parent, icon, title, onClick, className = "wo-icon-button") {
  const button = parent.createEl("button", { cls: className });
  button.type = "button";
  button.title = title;
  button.setAttr("aria-label", title);
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}

function createTextButton(parent, text, title, onClick) {
  const button = parent.createEl("button", { text, cls: "wo-action-button" });
  button.type = "button";
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

class WorkspaceOrchestratorPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.focusModeLeafId = null;
    this.decorationTimer = null;

    this.registerView(VIEW_TYPE, (leaf) => new WorkspaceOrchestratorView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "Workspace Orchestrator", () => {
      this.activateView();
    });

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("workspace-orchestrator-status");
    this.statusBarItem.addEventListener("click", () => this.activateView());

    this.registerCommands();
    this.addSettingTab(new WorkspaceOrchestratorSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleDecorationRefresh();
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshFocusModeClass();
        this.scheduleDecorationRefresh();
        this.refreshViews();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleDecorationRefresh();
      this.updateStatus();
    });
  }

  onunload() {
    this.removeDecorations();
    document.body.removeClass("wo-focus-mode");
    document.querySelectorAll(".wo-focus-mode-active").forEach((el) => el.removeClass("wo-focus-mode-active"));
  }

  registerCommands() {
    this.addCommand({
      id: "open-control-panel",
      name: "Open workspace orchestrator panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-layout-designer",
      name: "Open layout designer",
      callback: () => this.openDesigner(),
    });

    this.addCommand({
      id: "focus-next-surface",
      name: "Focus next visible surface",
      callback: () => this.focusRelative(1),
    });

    this.addCommand({
      id: "focus-previous-surface",
      name: "Focus previous visible surface",
      callback: () => this.focusRelative(-1),
    });

    for (let index = 1; index <= 9; index += 1) {
      this.addCommand({
        id: `focus-surface-${index}`,
        name: `Focus visible surface ${index}`,
        callback: () => this.focusByNumber(index),
      });
    }

    [
      ["left", "Focus nearest surface left"],
      ["right", "Focus nearest surface right"],
      ["up", "Focus nearest surface up"],
      ["down", "Focus nearest surface down"],
    ].forEach(([direction, name]) => {
      this.addCommand({
        id: `focus-${direction}`,
        name,
        callback: () => this.focusDirection(direction),
      });
    });

    this.addCommand({
      id: "toggle-focus-mode",
      name: "Toggle focus mode for active surface",
      callback: () => this.toggleFocusMode(),
    });

    this.addCommand({
      id: "assign-active-surface-region",
      name: "Assign active surface to region",
      callback: () => this.promptAssignActiveRegion(),
    });

    this.addCommand({
      id: "focus-region",
      name: "Focus named region",
      callback: () => this.promptFocusRegion(),
    });

    this.addCommand({
      id: "open-active-file-in-region",
      name: "Open active file in region",
      callback: () => this.promptOpenActiveFileInRegion(),
    });

    this.addCommand({
      id: "open-view-in-region",
      name: "Open built-in view in region",
      callback: () => this.promptOpenViewInRegion(),
    });

    this.addCommand({
      id: "duplicate-active-surface-right",
      name: "Duplicate active surface to split right",
      callback: () => this.duplicateActiveLeaf("vertical"),
    });

    this.addCommand({
      id: "duplicate-active-surface-down",
      name: "Duplicate active surface to split down",
      callback: () => this.duplicateActiveLeaf("horizontal"),
    });

    this.addCommand({
      id: "save-current-session",
      name: "Save current workspace as session",
      callback: () => this.promptSaveSession(),
    });

    this.addCommand({
      id: "quick-snapshot-session",
      name: "Quick snapshot current workspace",
      callback: () => this.quickSnapshotSession(),
    });

    this.addCommand({
      id: "update-active-session",
      name: "Update active session from current workspace",
      callback: () => this.updateActiveSession(),
    });

    this.addCommand({
      id: "load-session",
      name: "Load session",
      callback: () => new SessionManagerModal(this.app, this).open(),
    });

    this.addCommand({
      id: "capture-template",
      name: "Capture template from current workspace",
      callback: () => this.promptCaptureTemplate(),
    });

    this.addCommand({
      id: "capture-variable-template",
      name: "Capture variable template from current workspace",
      callback: () => this.promptCaptureVariableTemplate(),
    });

    this.addCommand({
      id: "apply-template",
      name: "Apply template",
      callback: () => new TemplateManagerModal(this.app, this).open(),
    });

    this.addCommand({
      id: "import-pack",
      name: "Import workspace pack",
      callback: () => new JsonImportModal(this.app, this).open(),
    });

    this.addCommand({
      id: "export-pack",
      name: "Export all sessions and templates",
      callback: () => this.exportAll(),
    });
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
    this.settings.regions = this.settings.regions || {};
    this.settings.sessions = Array.isArray(this.settings.sessions) ? this.settings.sessions : [];
    this.settings.templates = Array.isArray(this.settings.templates) ? this.settings.templates : [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.scheduleDecorationRefresh();
    this.updateStatus();
    this.refreshViews();
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(true) || this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  openDesigner() {
    new LayoutDesignerModal(this.app, this).open();
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view && typeof view.refresh === "function") {
        view.refresh();
      }
    }
  }

  updateStatus() {
    if (!this.statusBarItem) return;
    const count = this.getFocusableLeaves().length;
    const active = this.settings.sessions.find((session) => session.id === this.settings.activeSessionId);
    const label = active ? `${active.name} · ${count}` : `Surfaces ${count}`;
    this.statusBarItem.setText(label);
  }

  scheduleDecorationRefresh() {
    if (this.decorationTimer) window.clearTimeout(this.decorationTimer);
    this.decorationTimer = window.setTimeout(() => this.refreshDecorations(), 80);
  }

  removeDecorations() {
    document.querySelectorAll(".wo-pane-badge").forEach((el) => el.remove());
    document.querySelectorAll(".wo-focused").forEach((el) => el.removeClass("wo-focused"));
  }

  refreshDecorations() {
    this.removeDecorations();
    if (!this.settings.showPaneNumbers) {
      this.updateStatus();
      return;
    }

    const leaves = this.getFocusableLeaves();
    leaves.forEach((leaf, index) => {
      const leafEl = this.getLeafEl(leaf);
      if (!leafEl) return;
      if (getComputedStyle(leafEl).position === "static") {
        leafEl.style.position = "relative";
      }
      const region = this.getRegionForLeaf(leaf);
      const badge = leafEl.createDiv({ cls: "wo-pane-badge" });
      badge.createSpan({ text: String(index + 1) });
      if (region) {
        badge.createSpan({ cls: "wo-pane-badge-region", text: region });
      }
      badge.title = region ? `Focus ${region}` : `Focus surface ${index + 1}`;
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.focusLeaf(leaf);
      });
    });

    this.updateStatus();
  }

  getFocusableLeaves() {
    const leaves = [];
    const iterator = this.settings.includeSidebarsInFocusRing
      ? this.app.workspace.iterateAllLeaves.bind(this.app.workspace)
      : this.app.workspace.iterateRootLeaves.bind(this.app.workspace);

    iterator((leaf) => {
      if (!this.isFocusableLeaf(leaf)) return;
      const rect = this.getLeafRect(leaf);
      if (!rect) return;
      leaves.push({ leaf, rect });
    });

    leaves.sort((a, b) => {
      const rowDelta = a.rect.top - b.rect.top;
      if (Math.abs(rowDelta) > 24) return rowDelta;
      return a.rect.left - b.rect.left;
    });

    return leaves.map((entry) => entry.leaf);
  }

  isFocusableLeaf(leaf) {
    if (!leaf || !leaf.view || typeof leaf.getViewState !== "function") return false;
    const state = leaf.getViewState();
    if (!state || state.type === "empty" || state.type === VIEW_TYPE) return false;
    const leafEl = this.getLeafEl(leaf);
    if (!leafEl) return false;
    const rect = leafEl.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  getLeafEl(leaf) {
    const viewEl = leaf && leaf.view && leaf.view.containerEl;
    if (!viewEl) return null;
    return viewEl.closest(".workspace-leaf") || viewEl;
  }

  getLeafRect(leaf) {
    const leafEl = this.getLeafEl(leaf);
    if (!leafEl) return null;
    const rect = leafEl.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return null;
    return rect;
  }

  getActiveLeaf() {
    return this.app.workspace.activeLeaf || this.app.workspace.getMostRecentLeaf();
  }

  async focusRelative(offset) {
    const leaves = this.getFocusableLeaves();
    if (!leaves.length) {
      new Notice("No visible surfaces found.");
      return;
    }
    const active = this.getActiveLeaf();
    const activeIndex = Math.max(0, leaves.indexOf(active));
    const nextIndex = (activeIndex + offset + leaves.length) % leaves.length;
    await this.focusLeaf(leaves[nextIndex]);
  }

  async focusByNumber(number) {
    const leaf = this.getFocusableLeaves()[number - 1];
    if (!leaf) {
      new Notice(`Surface ${number} is not visible.`);
      return;
    }
    await this.focusLeaf(leaf);
  }

  async focusDirection(direction) {
    const active = this.getActiveLeaf();
    const activeRect = this.getLeafRect(active);
    if (!active || !activeRect) {
      await this.focusRelative(1);
      return;
    }

    const activeCenter = {
      x: activeRect.left + activeRect.width / 2,
      y: activeRect.top + activeRect.height / 2,
    };

    let best = null;
    for (const leaf of this.getFocusableLeaves()) {
      if (leaf === active) continue;
      const rect = this.getLeafRect(leaf);
      if (!rect) continue;
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const dx = center.x - activeCenter.x;
      const dy = center.y - activeCenter.y;
      let primary = 0;
      let secondary = 0;

      if (direction === "left" && dx < -8) {
        primary = Math.abs(dx);
        secondary = Math.abs(dy);
      } else if (direction === "right" && dx > 8) {
        primary = Math.abs(dx);
        secondary = Math.abs(dy);
      } else if (direction === "up" && dy < -8) {
        primary = Math.abs(dy);
        secondary = Math.abs(dx);
      } else if (direction === "down" && dy > 8) {
        primary = Math.abs(dy);
        secondary = Math.abs(dx);
      } else {
        continue;
      }

      const score = primary + secondary * 1.75;
      if (!best || score < best.score) {
        best = { leaf, score };
      }
    }

    if (best) {
      await this.focusLeaf(best.leaf);
    } else {
      await this.focusRelative(direction === "left" || direction === "up" ? -1 : 1);
    }
  }

  async focusLeaf(leaf) {
    if (!leaf) return;
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.isDeferred && typeof leaf.loadIfDeferred === "function") {
      await leaf.loadIfDeferred();
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.flashLeaf(leaf);
    this.refreshFocusModeClass();
    this.scheduleDecorationRefresh();
  }

  flashLeaf(leaf) {
    const leafEl = this.getLeafEl(leaf);
    if (!leafEl) return;
    leafEl.addClass("wo-focused");
    window.setTimeout(() => leafEl.removeClass("wo-focused"), 650);
  }

  toggleFocusMode() {
    if (document.body.hasClass("wo-focus-mode")) {
      this.focusModeLeafId = null;
      document.body.removeClass("wo-focus-mode");
    } else {
      const active = this.getActiveLeaf();
      this.focusModeLeafId = this.getLeafId(active);
      document.body.addClass("wo-focus-mode");
    }
    this.refreshFocusModeClass();
  }

  refreshFocusModeClass() {
    document.querySelectorAll(".wo-focus-mode-active").forEach((el) => el.removeClass("wo-focus-mode-active"));
    if (!document.body.hasClass("wo-focus-mode")) return;

    const active = this.getActiveLeaf();
    if (active) this.focusModeLeafId = this.getLeafId(active);
    const leaf = this.findLeafById(this.focusModeLeafId) || active;
    const leafEl = this.getLeafEl(leaf);
    if (leafEl) leafEl.addClass("wo-focus-mode-active");
  }

  getLeafId(leaf) {
    if (!leaf) return "";
    return safeText(leaf.id || "");
  }

  findLeafById(id) {
    if (!id) return null;
    if (typeof this.app.workspace.getLeafById === "function") {
      const leaf = this.app.workspace.getLeafById(id);
      if (leaf) return leaf;
    }
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (this.getLeafId(leaf) === id) found = leaf;
    });
    return found;
  }

  getLeafDescription(leaf) {
    if (!leaf || !leaf.view) return "Unknown";
    const state = leaf.getViewState();
    const path = getStatePath(state.state);
    if (path) return path;
    if (typeof leaf.view.getDisplayText === "function") {
      const text = leaf.view.getDisplayText();
      if (text) return text;
    }
    return state.type || "Unknown";
  }

  createLeafLocator(leaf) {
    const viewState = leaf.getViewState();
    return {
      leafId: this.getLeafId(leaf),
      viewType: viewState.type,
      state: deepClone(viewState.state || {}),
      fingerprint: viewStateFingerprint(viewState),
      display: this.getLeafDescription(leaf),
      updatedAt: nowIso(),
    };
  }

  locatorMatchesLeaf(locator, leaf) {
    if (!locator || !leaf) return false;
    if (locator.leafId && locator.leafId === this.getLeafId(leaf)) return true;
    const state = leaf.getViewState();
    return locator.fingerprint && locator.fingerprint === viewStateFingerprint(state);
  }

  getRegionForLeaf(leaf) {
    for (const [name, locator] of Object.entries(this.settings.regions || {})) {
      if (this.locatorMatchesLeaf(locator, leaf)) return name;
    }
    return "";
  }

  getKnownRegions() {
    const names = new Set(COMMON_REGIONS);
    Object.keys(this.settings.regions || {}).forEach((name) => names.add(name));
    return Array.from(names).sort();
  }

  assignRegionToLeaf(regionName, leaf = this.getActiveLeaf()) {
    const normalized = normalizeRegionName(regionName);
    if (!normalized) {
      new Notice("Region name is empty.");
      return false;
    }
    if (!leaf) {
      new Notice("No active surface to assign.");
      return false;
    }
    this.settings.regions[normalized] = this.createLeafLocator(leaf);
    this.saveSettings();
    new Notice(`Assigned ${normalized}.`);
    return true;
  }

  promptAssignActiveRegion() {
    new RegionPickerModal(this.app, this, "Assign region", (region) => {
      this.assignRegionToLeaf(region);
    }).open();
  }

  promptFocusRegion() {
    new RegionPickerModal(this.app, this, "Focus region", (region) => {
      this.focusRegion(region);
    }).open();
  }

  async focusRegion(region) {
    const leaf = this.findLeafForRegion(region);
    if (!leaf) {
      new Notice(`Region ${region} is not available in the current workspace.`);
      return;
    }
    await this.focusLeaf(leaf);
  }

  findLeafForRegion(region) {
    const normalized = normalizeRegionName(region);
    const locator = this.settings.regions[normalized];
    if (!locator) return null;

    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && this.locatorMatchesLeaf(locator, leaf)) {
        found = leaf;
      }
    });
    return found;
  }

  async ensureRegionLeaf(region) {
    let leaf = this.findLeafForRegion(region);
    if (!leaf) {
      try {
        leaf = this.app.workspace.getLeaf("split", "vertical");
      } catch (error) {
        leaf = this.app.workspace.getLeaf(true);
      }
      this.assignRegionToLeaf(region, leaf);
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  promptOpenActiveFileInRegion() {
    new RegionPickerModal(this.app, this, "Open active file in region", (region) => {
      this.openActiveFileInRegion(region);
    }).open();
  }

  async openActiveFileInRegion(region) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file.");
      return;
    }

    const leaf = await this.ensureRegionLeaf(region);
    await leaf.openFile(file, { active: true });
    this.assignRegionToLeaf(region, leaf);
    await this.focusLeaf(leaf);
  }

  promptOpenViewInRegion() {
    new RegionPickerModal(this.app, this, "Choose region", (region) => {
      new ViewPickerModal(this.app, VIEW_PRESETS, (preset) => {
        this.openViewInRegion(region, preset);
      }).open();
    }).open();
  }

  async openViewInRegion(region, preset) {
    const leaf = await this.ensureRegionLeaf(region);
    try {
      await leaf.setViewState({
        type: preset.type,
        state: deepClone(preset.state || {}),
        active: true,
      });
      this.assignRegionToLeaf(region, leaf);
      await this.focusLeaf(leaf);
    } catch (error) {
      console.error(error);
      new Notice(`Could not open ${preset.name}.`);
    }
  }

  async duplicateActiveLeaf(direction) {
    const active = this.getActiveLeaf();
    if (!active) {
      new Notice("No active surface.");
      return;
    }
    try {
      const leaf = await this.app.workspace.duplicateLeaf(active, "split", direction);
      await this.focusLeaf(leaf);
    } catch (error) {
      console.error(error);
      new Notice("Could not duplicate active surface.");
    }
  }

  async requestWorkspaceSave() {
    if (this.app.workspace.requestSaveLayout) {
      await this.app.workspace.requestSaveLayout();
    }
  }

  async captureWorkspaceObject(name, existing, kind) {
    await this.requestWorkspaceSave();
    const active = this.getActiveLeaf();
    const activeRegion = active ? this.getRegionForLeaf(active) : "";
    const createdAt = existing && existing.createdAt ? existing.createdAt : nowIso();

    return {
      id: existing && existing.id ? existing.id : uid(kind),
      kind,
      name,
      version: 1,
      createdAt,
      updatedAt: nowIso(),
      layout: deepClone(this.app.workspace.getLayout()),
      regions: deepClone(this.settings.regions || {}),
      requirements: Array.from(collectViewTypesFromLayout(this.app.workspace.getLayout())).sort(),
      variables: normalizeTemplateVariables(existing && existing.variables),
      activeRegion,
    };
  }

  promptSaveSession() {
    new TextPromptModal(this.app, {
      title: "Save session",
      placeholder: "Research dashboard",
      initialValue: this.getSuggestedSessionName(),
      submitLabel: "Save",
      onSubmit: (name) => this.saveCurrentSession(name),
    }).open();
  }

  getSuggestedSessionName() {
    const active = this.settings.sessions.find((session) => session.id === this.settings.activeSessionId);
    if (active) return active.name;
    return `Session ${new Date().toLocaleString()}`;
  }

  async quickSnapshotSession() {
    await this.saveCurrentSession(`Snapshot ${new Date().toLocaleString()}`);
  }

  async saveCurrentSession(name) {
    const cleanName = safeText(name).trim();
    if (!cleanName) {
      new Notice("Session name is empty.");
      return;
    }
    const existing = this.settings.sessions.find((session) => session.name === cleanName);
    const session = await this.captureWorkspaceObject(cleanName, existing, "session");
    const index = this.settings.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) this.settings.sessions[index] = session;
    else this.settings.sessions.unshift(session);
    this.settings.activeSessionId = session.id;
    await this.saveSettings();
    new Notice(`Saved session: ${session.name}`);
  }

  async updateActiveSession() {
    const active = this.settings.sessions.find((session) => session.id === this.settings.activeSessionId);
    if (!active) {
      this.promptSaveSession();
      return;
    }
    const session = await this.captureWorkspaceObject(active.name, active, "session");
    const index = this.settings.sessions.findIndex((item) => item.id === session.id);
    this.settings.sessions[index] = session;
    await this.saveSettings();
    new Notice(`Updated session: ${session.name}`);
  }

  getRestoreWarnings(layout) {
    const warnings = [];
    const missingFiles = Array.from(collectFilePathsFromLayout(layout)).filter((path) => {
      return !this.app.vault.getAbstractFileByPath(path);
    });
    if (missingFiles.length) {
      warnings.push(`Missing files: ${missingFiles.slice(0, 12).join(", ")}${missingFiles.length > 12 ? "..." : ""}`);
    }
    const pluginViews = Array.from(collectViewTypesFromLayout(layout)).filter((type) => ![
      "markdown",
      "canvas",
      "base",
      "search",
      "graph",
      "backlink",
      "outgoing-link",
      "outline",
      "file-explorer",
      VIEW_TYPE,
    ].includes(type));
    if (pluginViews.length) {
      warnings.push(`Plugin views: ${pluginViews.join(", ")}`);
    }
    return warnings;
  }

  async loadSession(session, force = false) {
    if (!session || !session.layout) {
      new Notice("Session has no layout.");
      return;
    }
    const warnings = this.getRestoreWarnings(session.layout);
    if (warnings.length && !force) {
      new RestoreWarningModal(this.app, "Load session", warnings, () => this.loadSession(session, true)).open();
      return;
    }
    if (this.settings.autoSaveBeforeSessionSwitch && this.settings.activeSessionId) {
      const active = this.settings.sessions.find((item) => item.id === this.settings.activeSessionId);
      if (active) {
        const updated = await this.captureWorkspaceObject(active.name, active, "session");
        const index = this.settings.sessions.findIndex((item) => item.id === active.id);
        this.settings.sessions[index] = updated;
      }
    }

    await this.app.workspace.changeLayout(deepClone(session.layout));
    this.settings.regions = deepClone(session.regions || {});
    this.settings.activeSessionId = session.id;
    await this.saveSettings();
    window.setTimeout(() => {
      if (session.activeRegion) this.focusRegion(session.activeRegion);
      this.scheduleDecorationRefresh();
    }, 120);
    new Notice(`Loaded session: ${session.name}`);
  }

  deleteSession(sessionId) {
    this.settings.sessions = this.settings.sessions.filter((session) => session.id !== sessionId);
    if (this.settings.activeSessionId === sessionId) this.settings.activeSessionId = null;
    this.saveSettings();
  }

  promptCaptureTemplate() {
    new TextPromptModal(this.app, {
      title: "Capture template",
      placeholder: "Writing cockpit",
      submitLabel: "Capture",
      onSubmit: (name) => this.captureTemplate(name),
    }).open();
  }

  promptCaptureVariableTemplate() {
    new TextPromptModal(this.app, {
      title: "Capture variable template",
      placeholder: "Project dashboard",
      submitLabel: "Capture",
      onSubmit: (name) => this.captureVariableTemplate(name),
    }).open();
  }

  async captureTemplate(name) {
    const cleanName = safeText(name).trim();
    if (!cleanName) {
      new Notice("Template name is empty.");
      return;
    }
    const existing = this.settings.templates.find((template) => template.name === cleanName);
    const template = await this.captureWorkspaceObject(cleanName, existing, "template");
    const index = this.settings.templates.findIndex((item) => item.id === template.id);
    if (index >= 0) this.settings.templates[index] = template;
    else this.settings.templates.unshift(template);
    await this.saveSettings();
    new Notice(`Captured template: ${template.name}`);
  }

  async captureVariableTemplate(name) {
    const cleanName = safeText(name).trim();
    if (!cleanName) {
      new Notice("Template name is empty.");
      return;
    }
    const template = await this.captureWorkspaceObject(cleanName, null, "template");
    template.variables = [
      { key: "project", label: "Project folder or slug", defaultValue: dirname(this.app.workspace.getActiveFile()?.path || "") },
      { key: "focusFile", label: "Primary file path", defaultValue: this.app.workspace.getActiveFile()?.path || "" },
    ];
    this.settings.templates.unshift(template);
    await this.saveSettings();
    new TemplateVariablesModal(this.app, this, template).open();
    new Notice(`Captured variable template: ${template.name}`);
  }

  async applyTemplate(template, providedValues = null, force = false) {
    if (!template || !template.layout) {
      new Notice("Template has no layout.");
      return;
    }
    const variables = normalizeTemplateVariables(template.variables);
    if (variables.length && !providedValues) {
      new TemplateApplyModal(this.app, this, template).open();
      return;
    }
    const resolvedValues = this.buildTemplateVariableValues(variables, providedValues || {});
    const layout = resolveTemplateValue(template.layout, resolvedValues);
    const regions = resolveTemplateValue(template.regions || {}, resolvedValues);
    const warnings = this.getRestoreWarnings(layout);
    if (warnings.length && !force) {
      new RestoreWarningModal(this.app, "Apply template", warnings, () => this.applyTemplate(template, providedValues || {}, true)).open();
      return;
    }
    await this.app.workspace.changeLayout(deepClone(layout));
    this.settings.regions = deepClone(regions || {});
    await this.saveSettings();
    window.setTimeout(() => {
      if (template.activeRegion) this.focusRegion(template.activeRegion);
      this.scheduleDecorationRefresh();
    }, 120);
    new Notice(`Applied template: ${template.name}`);
  }

  deleteTemplate(templateId) {
    this.settings.templates = this.settings.templates.filter((template) => template.id !== templateId);
    this.saveSettings();
  }

  buildTemplateVariableValues(templateVariables, providedValues) {
    const activeFile = this.app.workspace.getActiveFile();
    const activePath = activeFile ? activeFile.path : "";
    const today = new Date();
    const values = {
      activeFile: activePath,
      activeFolder: dirname(activePath),
      activeBasename: basenameWithoutExtension(activePath),
      date: today.toISOString().slice(0, 10),
      datetime: today.toISOString(),
      ...providedValues,
    };
    templateVariables.forEach((variable) => {
      if (!Object.prototype.hasOwnProperty.call(values, variable.key)) {
        values[variable.key] = variable.defaultValue || "";
      }
    });
    return values;
  }

  updateTemplateVariables(templateId, variables) {
    const index = this.settings.templates.findIndex((template) => template.id === templateId);
    if (index < 0) return;
    this.settings.templates[index].variables = normalizeTemplateVariables(variables);
    this.settings.templates[index].updatedAt = nowIso();
    this.saveSettings();
  }

  exportPack(items) {
    return JSON.stringify(
      {
        type: "workspace-orchestrator-pack",
        version: 1,
        exportedAt: nowIso(),
        sessions: items.sessions || [],
        templates: items.templates || [],
      },
      null,
      2
    );
  }

  exportAll() {
    const text = this.exportPack({
      sessions: this.settings.sessions,
      templates: this.settings.templates,
    });
    this.copyText(text, "Copied workspace pack.");
  }

  async copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(successMessage);
    } catch (error) {
      new JsonDisplayModal(this.app, "Workspace pack", text).open();
    }
  }

  async importPack(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      new Notice("Invalid JSON.");
      return;
    }

    const validation = validateWorkspacePack(rawText, parsed);
    if (validation.errors.length) {
      new JsonDisplayModal(
        this.app,
        "Pack validation failed",
        validation.errors.join("\n")
      ).open();
      return;
    }

    const incomingSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const incomingTemplates = Array.isArray(parsed.templates) ? parsed.templates : [];
    let imported = 0;

    for (const session of incomingSessions) {
      if (!session || !session.name || !session.layout) continue;
      const copy = Object.assign({}, deepClone(session), {
        id: uid("session"),
        kind: "session",
        name: safeText(session.name).trim().slice(0, MAX_NAME_LENGTH),
        variables: normalizeTemplateVariables(session.variables),
        regions: session.regions && typeof session.regions === "object" ? deepClone(session.regions) : {},
        requirements: Array.from(collectViewTypesFromLayout(session.layout)).sort(),
        importedAt: nowIso(),
      });
      this.settings.sessions.unshift(copy);
      imported += 1;
    }

    for (const template of incomingTemplates) {
      if (!template || !template.name || !template.layout) continue;
      const copy = Object.assign({}, deepClone(template), {
        id: uid("template"),
        kind: "template",
        name: safeText(template.name).trim().slice(0, MAX_NAME_LENGTH),
        variables: normalizeTemplateVariables(template.variables),
        regions: template.regions && typeof template.regions === "object" ? deepClone(template.regions) : {},
        requirements: Array.from(collectViewTypesFromLayout(template.layout)).sort(),
        importedAt: nowIso(),
      });
      this.settings.templates.unshift(copy);
      imported += 1;
    }

    await this.saveSettings();
    const suffix = validation.warnings.length ? ` ${validation.warnings.length} warning${validation.warnings.length === 1 ? "" : "s"}.` : "";
    new Notice(`Imported ${imported} item${imported === 1 ? "" : "s"}.${suffix}`);
  }
}

class WorkspaceOrchestratorView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Workspace Orchestrator";
  }

  getIcon() {
    return "layout-dashboard";
  }

  async onOpen() {
    this.refresh();
  }

  refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("wo-panel");
    this.renderHeader(container);
    this.renderSurfaces(container);
    this.renderRegions(container);
    this.renderSessions(container);
    this.renderTemplates(container);
  }

  renderHeader(container) {
    const header = container.createDiv({ cls: "wo-panel-header" });
    const titleWrap = header.createDiv();
    titleWrap.createEl("h3", { text: "Orchestrator", cls: "wo-panel-title" });
    const active = this.plugin.settings.sessions.find((session) => session.id === this.plugin.settings.activeSessionId);
    titleWrap.createDiv({
      text: active ? active.name : "No active session",
      cls: "wo-panel-kicker",
    });

    const toolbar = header.createDiv({ cls: "wo-toolbar" });
    createButton(toolbar, "panel-top", "Layout designer", () => this.plugin.openDesigner());
    createButton(toolbar, "save", "Save session", () => this.plugin.promptSaveSession());
    createButton(toolbar, "folder-open", "Load session", () => new SessionManagerModal(this.app, this.plugin).open());
    createButton(toolbar, "layout-template", "Templates", () => new TemplateManagerModal(this.app, this.plugin).open());
    createButton(toolbar, "archive", "Export pack", () => this.plugin.exportAll());
    createButton(toolbar, "package-plus", "Import pack", () => new JsonImportModal(this.app, this.plugin).open());
  }

  renderSurfaces(container) {
    this.renderSection(container, "Surfaces", (section) => {
      const list = section.createDiv({ cls: "wo-list" });
      const leaves = this.plugin.getFocusableLeaves();
      if (!leaves.length) {
        list.createDiv({ text: "No visible surfaces.", cls: "wo-empty" });
        return;
      }

      leaves.forEach((leaf, index) => {
        const state = leaf.getViewState();
        const region = this.plugin.getRegionForLeaf(leaf);
        const item = list.createDiv({ cls: "wo-item" });
        const main = item.createDiv({ cls: "wo-item-main" });
        const left = main.createDiv();
        left.createDiv({
          text: `${index + 1}. ${this.plugin.getLeafDescription(leaf)}`,
          cls: "wo-item-title",
        });
        left.createDiv({
          text: region ? `${state.type} · ${region}` : state.type,
          cls: "wo-item-meta",
        });

        const actions = main.createDiv({ cls: "wo-row-actions" });
        createButton(actions, "crosshair", "Focus", () => this.plugin.focusLeaf(leaf));
        createButton(actions, "tag", "Assign region", () => {
          new RegionPickerModal(this.app, this.plugin, "Assign region", (name) => {
            this.plugin.assignRegionToLeaf(name, leaf);
          }).open();
        });
      });
    });
  }

  renderRegions(container) {
    this.renderSection(container, "Regions", (section) => {
      const list = section.createDiv({ cls: "wo-list" });
      const regions = this.plugin.getKnownRegions();
      regions.forEach((region) => {
        const leaf = this.plugin.findLeafForRegion(region);
        const item = list.createDiv({ cls: "wo-item" });
        const main = item.createDiv({ cls: "wo-item-main" });
        const left = main.createDiv();
        left.createDiv({ text: region, cls: "wo-item-title" });
        left.createDiv({
          text: leaf ? this.plugin.getLeafDescription(leaf) : "Not mapped in current workspace",
          cls: "wo-item-meta",
        });
        const actions = main.createDiv({ cls: "wo-row-actions" });
        createButton(actions, "crosshair", "Focus", () => this.plugin.focusRegion(region));
        createButton(actions, "file-input", "Open active file here", () => this.plugin.openActiveFileInRegion(region));
      });
    });
  }

  renderSessions(container) {
    this.renderSection(container, "Sessions", (section) => {
      const list = section.createDiv({ cls: "wo-list" });
      const sessions = this.plugin.settings.sessions.slice(0, 6);
      if (!sessions.length) {
        list.createDiv({ text: "No sessions saved.", cls: "wo-empty" });
        return;
      }
      sessions.forEach((session) => {
        const item = list.createDiv({ cls: "wo-item" });
        const main = item.createDiv({ cls: "wo-item-main" });
        const left = main.createDiv();
        left.createDiv({ text: session.name, cls: "wo-item-title" });
        left.createDiv({ text: new Date(session.updatedAt).toLocaleString(), cls: "wo-item-meta" });
        const actions = main.createDiv({ cls: "wo-row-actions" });
        createButton(actions, "play", "Load", () => this.plugin.loadSession(session));
        createButton(actions, "copy", "Export", () => {
          const text = this.plugin.exportPack({ sessions: [session] });
          this.plugin.copyText(text, "Copied session pack.");
        });
      });
    });
  }

  renderTemplates(container) {
    this.renderSection(container, "Templates", (section) => {
      const toolbar = section.createDiv({ cls: "wo-toolbar" });
      createTextButton(toolbar, "Capture", "Capture current workspace as template", () => this.plugin.promptCaptureTemplate());
      createTextButton(toolbar, "Variable", "Capture variable template", () => this.plugin.promptCaptureVariableTemplate());
      createTextButton(toolbar, "Manage", "Manage templates", () => new TemplateManagerModal(this.app, this.plugin).open());
    });
  }

  renderSection(container, title, render) {
    const section = container.createDiv({ cls: "wo-section" });
    section.createEl("h4", { text: title, cls: "wo-section-title" });
    render(section);
  }
}

class LayoutDesignerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wo-designer");
    contentEl.createEl("h2", { text: "Layout Designer" });

    this.renderActions(contentEl);
    this.renderSurfaceBoard(contentEl);
    this.renderTemplateVariables(contentEl);
    this.renderLayoutTree(contentEl);
  }

  renderActions(container) {
    const actions = container.createDiv({ cls: "wo-designer-actions" });
    createTextButton(actions, "Save session", "Save current workspace as session", () => {
      this.close();
      this.plugin.promptSaveSession();
    });
    createTextButton(actions, "Capture template", "Capture current workspace as template", () => {
      this.close();
      this.plugin.promptCaptureTemplate();
    });
    createTextButton(actions, "Variable template", "Capture variable template", () => {
      this.close();
      this.plugin.promptCaptureVariableTemplate();
    });
    createTextButton(actions, "Focus mode", "Toggle focus mode", () => this.plugin.toggleFocusMode());
    createTextButton(actions, "Export pack", "Export all sessions and templates", () => this.plugin.exportAll());
  }

  renderSurfaceBoard(container) {
    const section = container.createDiv({ cls: "wo-designer-section" });
    section.createEl("h3", { text: "Current Surfaces", cls: "wo-section-title" });
    const grid = section.createDiv({ cls: "wo-surface-grid" });
    const leaves = this.plugin.getFocusableLeaves();

    if (!leaves.length) {
      grid.createDiv({ text: "No visible surfaces.", cls: "wo-empty" });
      return;
    }

    leaves.forEach((leaf, index) => {
      const state = leaf.getViewState();
      const region = this.plugin.getRegionForLeaf(leaf);
      const card = grid.createDiv({ cls: "wo-surface-card" });
      const header = card.createDiv({ cls: "wo-surface-card-header" });
      header.createSpan({ text: String(index + 1), cls: "wo-surface-number" });
      const titleWrap = header.createDiv();
      titleWrap.createDiv({ text: this.plugin.getLeafDescription(leaf), cls: "wo-item-title" });
      titleWrap.createDiv({ text: region ? `${state.type} · ${region}` : state.type, cls: "wo-item-meta" });

      const controls = card.createDiv({ cls: "wo-row-actions" });
      createButton(controls, "crosshair", "Focus", () => this.plugin.focusLeaf(leaf));
      createButton(controls, "tag", "Assign region", () => {
        new RegionPickerModal(this.app, this.plugin, "Assign region", (name) => {
          this.plugin.assignRegionToLeaf(name, leaf);
          this.refresh();
        }).open();
      });
      createButton(controls, "copy-plus", "Duplicate right", async () => {
        await this.plugin.focusLeaf(leaf);
        this.plugin.duplicateActiveLeaf("vertical");
      });
      createButton(controls, "copy-plus", "Duplicate down", async () => {
        await this.plugin.focusLeaf(leaf);
        this.plugin.duplicateActiveLeaf("horizontal");
      });
      createButton(controls, "file-input", "Open active file here", () => {
        const targetRegion = region || `surface-${index + 1}`;
        this.plugin.assignRegionToLeaf(targetRegion, leaf);
        this.plugin.openActiveFileInRegion(targetRegion);
      });
      createButton(controls, "panel-right-open", "Open built-in view here", () => {
        const targetRegion = region || `surface-${index + 1}`;
        this.plugin.assignRegionToLeaf(targetRegion, leaf);
        new ViewPickerModal(this.app, VIEW_PRESETS, (preset) => this.plugin.openViewInRegion(targetRegion, preset)).open();
      });
    });
  }

  renderTemplateVariables(container) {
    const section = container.createDiv({ cls: "wo-designer-section" });
    section.createEl("h3", { text: "Template Variables", cls: "wo-section-title" });
    const list = section.createDiv({ cls: "wo-variable-grid" });
    BUILT_IN_TEMPLATE_VARIABLES.forEach((variable) => {
      const item = list.createDiv({ cls: "wo-variable-token" });
      item.createSpan({ text: `{{${variable.key}}}` });
      item.createSpan({ text: variable.label });
    });
  }

  renderLayoutTree(container) {
    const section = container.createDiv({ cls: "wo-designer-section" });
    section.createEl("h3", { text: "Workspace Tree", cls: "wo-section-title" });
    const tree = section.createDiv({ cls: "wo-layout-tree" });
    const layout = this.app.workspace.getLayout();
    ["main", "left", "right", "floating"].forEach((rootKey) => {
      if (layout[rootKey]) {
        this.renderLayoutNode(tree, layout[rootKey], rootKey, 0);
      }
    });
  }

  renderLayoutNode(parent, node, label, depth) {
    if (!node || typeof node !== "object") return;
    const row = parent.createDiv({ cls: "wo-layout-node" });
    row.style.setProperty("--wo-depth", String(depth));
    const title = row.createDiv({ cls: "wo-layout-node-title" });
    title.createSpan({ text: label, cls: "wo-pill" });

    if (node.type === "leaf") {
      const state = node.state || {};
      title.createSpan({
        text: `${state.type || "leaf"}${state.title ? ` · ${state.title}` : ""}`,
      });
    } else {
      title.createSpan({
        text: `${node.type || "node"}${node.direction ? ` · ${node.direction}` : ""}`,
      });
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child, index) => {
        this.renderLayoutNode(parent, child, `${node.type || "node"} ${index + 1}`, depth + 1);
      });
    }
  }

  refresh() {
    this.onOpen();
  }
}

class TextPromptModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.options.title });
    const input = contentEl.createEl("input", {
      type: "text",
      cls: "wo-input",
      value: this.options.initialValue || "",
      placeholder: this.options.placeholder || "",
    });
    const actions = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(actions, this.options.submitLabel || "Save", this.options.submitLabel || "Save", () => {
      this.options.onSubmit(input.value);
      this.close();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.options.onSubmit(input.value);
        this.close();
      }
    });
    input.focus();
  }
}

class RegionPickerModal extends Modal {
  constructor(app, plugin, title, onChoose) {
    super(app);
    this.plugin = plugin;
    this.title = title;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });

    new Setting(contentEl)
      .setName("Region")
      .addText((text) => {
        text.setPlaceholder("reference");
        text.inputEl.addClass("wo-input");
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.choose(text.getValue());
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("Use");
        button.onClick(() => {
          const input = contentEl.querySelector("input");
          this.choose(input ? input.value : "");
        });
      });

    const list = contentEl.createDiv({ cls: "wo-modal-list" });
    this.plugin.getKnownRegions().forEach((region) => {
      const row = list.createDiv({ cls: "wo-modal-row" });
      const left = row.createDiv();
      left.createDiv({ text: region, cls: "wo-modal-row-title" });
      const leaf = this.plugin.findLeafForRegion(region);
      left.createDiv({
        text: leaf ? this.plugin.getLeafDescription(leaf) : "Unmapped",
        cls: "wo-modal-row-meta",
      });
      const actions = row.createDiv({ cls: "wo-modal-actions" });
      createTextButton(actions, "Choose", `Choose ${region}`, () => this.choose(region));
    });
  }

  choose(value) {
    const region = normalizeRegionName(value);
    if (!region) {
      new Notice("Region name is empty.");
      return;
    }
    this.onChoose(region);
    this.close();
  }
}

class ViewPickerModal extends Modal {
  constructor(app, presets, onChoose) {
    super(app);
    this.presets = presets;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Open view" });
    const list = contentEl.createDiv({ cls: "wo-modal-list" });
    this.presets.forEach((preset) => {
      const row = list.createDiv({ cls: "wo-modal-row" });
      const left = row.createDiv();
      left.createDiv({ text: preset.name, cls: "wo-modal-row-title" });
      left.createDiv({ text: preset.type, cls: "wo-modal-row-meta" });
      const actions = row.createDiv({ cls: "wo-modal-actions" });
      createTextButton(actions, "Open", `Open ${preset.name}`, () => {
        this.onChoose(preset);
        this.close();
      });
    });
  }
}

class RestoreWarningModal extends Modal {
  constructor(app, title, warnings, onContinue) {
    super(app);
    this.title = title;
    this.warnings = warnings;
    this.onContinue = onContinue;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    const list = contentEl.createDiv({ cls: "wo-modal-list" });
    this.warnings.forEach((warning) => {
      list.createDiv({ text: warning, cls: "wo-item" });
    });
    const actions = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(actions, "Cancel", "Cancel", () => this.close());
    createTextButton(actions, "Continue", "Continue", () => {
      this.onContinue();
      this.close();
    });
  }
}

class TemplateApplyModal extends Modal {
  constructor(app, plugin, template) {
    super(app);
    this.plugin = plugin;
    this.template = template;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.template.name });
    const variables = normalizeTemplateVariables(this.template.variables);
    const builtIns = this.plugin.buildTemplateVariableValues([], {});
    const inputs = new Map();

    const list = contentEl.createDiv({ cls: "wo-modal-list" });
    variables.forEach((variable) => {
      const row = list.createDiv({ cls: "wo-variable-row" });
      const label = row.createEl("label", { text: variable.label || variable.key });
      label.createSpan({ text: ` {{${variable.key}}}`, cls: "wo-item-meta" });
      const input = row.createEl("input", {
        type: "text",
        cls: "wo-input",
        value: variable.defaultValue || builtIns[variable.key] || "",
      });
      inputs.set(variable.key, input);
    });

    const actions = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(actions, "Apply", "Apply template", () => {
      const values = {};
      inputs.forEach((input, key) => {
        values[key] = input.value;
      });
      this.plugin.applyTemplate(this.template, values);
      this.close();
    });
  }
}

class TemplateVariablesModal extends Modal {
  constructor(app, plugin, template) {
    super(app);
    this.plugin = plugin;
    this.template = template;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.template.name} variables` });

    const builtInList = contentEl.createDiv({ cls: "wo-variable-grid" });
    BUILT_IN_TEMPLATE_VARIABLES.forEach((variable) => {
      const item = builtInList.createDiv({ cls: "wo-variable-token" });
      item.createSpan({ text: `{{${variable.key}}}` });
      item.createSpan({ text: variable.label });
    });

    const textarea = contentEl.createEl("textarea", { cls: "wo-textarea" });
    textarea.value = JSON.stringify(normalizeTemplateVariables(this.template.variables), null, 2);

    const actions = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(actions, "Add project", "Add project variable", () => {
      this.addVariable(textarea, { key: "project", label: "Project", defaultValue: "" });
    });
    createTextButton(actions, "Add focusFile", "Add focus file variable", () => {
      this.addVariable(textarea, { key: "focusFile", label: "Focus file", defaultValue: this.plugin.app.workspace.getActiveFile()?.path || "" });
    });
    createTextButton(actions, "Save", "Save variables", () => {
      let parsed;
      try {
        parsed = JSON.parse(textarea.value);
      } catch (error) {
        new Notice("Variables JSON is invalid.");
        return;
      }
      this.plugin.updateTemplateVariables(this.template.id, parsed);
      this.close();
      new Notice("Template variables saved.");
    });
  }

  addVariable(textarea, variable) {
    let parsed = [];
    try {
      parsed = JSON.parse(textarea.value);
    } catch (error) {
      parsed = [];
    }
    parsed.push(variable);
    textarea.value = JSON.stringify(normalizeTemplateVariables(parsed), null, 2);
  }
}

class SessionManagerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sessions" });

    const toolbar = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(toolbar, "Save current", "Save current workspace", () => {
      this.close();
      this.plugin.promptSaveSession();
    });
    createTextButton(toolbar, "Import", "Import workspace pack", () => {
      this.close();
      new JsonImportModal(this.app, this.plugin).open();
    });

    const list = contentEl.createDiv({ cls: "wo-modal-list" });
    if (!this.plugin.settings.sessions.length) {
      list.createDiv({ text: "No sessions saved.", cls: "wo-empty" });
      return;
    }

    this.plugin.settings.sessions.forEach((session) => {
      const row = list.createDiv({ cls: "wo-modal-row" });
      const left = row.createDiv();
      left.createDiv({ text: session.name, cls: "wo-modal-row-title" });
      left.createDiv({ text: new Date(session.updatedAt).toLocaleString(), cls: "wo-modal-row-meta" });
      const actions = row.createDiv({ cls: "wo-modal-actions" });
      createTextButton(actions, "Load", `Load ${session.name}`, () => {
        this.plugin.loadSession(session);
        this.close();
      });
      createTextButton(actions, "Update", `Update ${session.name}`, async () => {
        const updated = await this.plugin.captureWorkspaceObject(session.name, session, "session");
        const index = this.plugin.settings.sessions.findIndex((item) => item.id === session.id);
        this.plugin.settings.sessions[index] = updated;
        this.plugin.settings.activeSessionId = updated.id;
        await this.plugin.saveSettings();
        this.close();
        new Notice(`Updated session: ${updated.name}`);
      });
      createTextButton(actions, "Export", `Export ${session.name}`, () => {
        const text = this.plugin.exportPack({ sessions: [session] });
        this.plugin.copyText(text, "Copied session pack.");
      });
      createTextButton(actions, "Delete", `Delete ${session.name}`, () => {
        this.plugin.deleteSession(session.id);
        this.close();
      });
    });
  }
}

class TemplateManagerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Templates" });

    const toolbar = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(toolbar, "Capture current", "Capture current workspace as template", () => {
      this.close();
      this.plugin.promptCaptureTemplate();
    });
    createTextButton(toolbar, "Variable current", "Capture variable template", () => {
      this.close();
      this.plugin.promptCaptureVariableTemplate();
    });
    createTextButton(toolbar, "Import", "Import workspace pack", () => {
      this.close();
      new JsonImportModal(this.app, this.plugin).open();
    });

    const list = contentEl.createDiv({ cls: "wo-modal-list" });
    if (!this.plugin.settings.templates.length) {
      list.createDiv({ text: "No templates captured.", cls: "wo-empty" });
      return;
    }

    this.plugin.settings.templates.forEach((template) => {
      const row = list.createDiv({ cls: "wo-modal-row" });
      const left = row.createDiv();
      left.createDiv({ text: template.name, cls: "wo-modal-row-title" });
      left.createDiv({ text: new Date(template.updatedAt).toLocaleString(), cls: "wo-modal-row-meta" });
      const actions = row.createDiv({ cls: "wo-modal-actions" });
      createTextButton(actions, "Apply", `Apply ${template.name}`, () => {
        this.plugin.applyTemplate(template);
        this.close();
      });
      createTextButton(actions, "Variables", `Edit ${template.name} variables`, () => {
        new TemplateVariablesModal(this.app, this.plugin, template).open();
      });
      createTextButton(actions, "Refresh", `Refresh ${template.name}`, async () => {
        const updated = await this.plugin.captureWorkspaceObject(template.name, template, "template");
        const index = this.plugin.settings.templates.findIndex((item) => item.id === template.id);
        this.plugin.settings.templates[index] = updated;
        await this.plugin.saveSettings();
        this.close();
        new Notice(`Refreshed template: ${updated.name}`);
      });
      createTextButton(actions, "Export", `Export ${template.name}`, () => {
        const text = this.plugin.exportPack({ templates: [template] });
        this.plugin.copyText(text, "Copied template pack.");
      });
      createTextButton(actions, "Delete", `Delete ${template.name}`, () => {
        this.plugin.deleteTemplate(template.id);
        this.close();
      });
    });
  }
}

class JsonDisplayModal extends Modal {
  constructor(app, title, value) {
    super(app);
    this.title = title;
    this.value = value;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    const textarea = contentEl.createEl("textarea", { cls: "wo-textarea" });
    textarea.value = this.value;
    textarea.select();
  }
}

class JsonImportModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Import workspace pack" });
    const textarea = contentEl.createEl("textarea", {
      cls: "wo-textarea",
      placeholder: "{\n  \"type\": \"workspace-orchestrator-pack\",\n  \"sessions\": [],\n  \"templates\": []\n}",
    });
    const actions = contentEl.createDiv({ cls: "wo-modal-actions" });
    createTextButton(actions, "Import", "Import pack", () => {
      this.plugin.importPack(textarea.value);
      this.close();
    });
    textarea.focus();
  }
}

class WorkspaceOrchestratorSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Workspace Orchestrator" });

    new Setting(containerEl)
      .setName("Show pane number overlays")
      .setDesc("Show clickable numbers on visible workspace surfaces.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showPaneNumbers);
        toggle.onChange(async (value) => {
          this.plugin.settings.showPaneNumbers = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Include sidebars in focus ring")
      .setDesc("Include left and right sidebar leaves when cycling focus.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeSidebarsInFocusRing);
        toggle.onChange(async (value) => {
          this.plugin.settings.includeSidebarsInFocusRing = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-save active session before switching")
      .setDesc("Refresh the active session snapshot before loading another session.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoSaveBeforeSessionSwitch);
        toggle.onChange(async (value) => {
          this.plugin.settings.autoSaveBeforeSessionSwitch = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Open control panel")
      .addButton((button) => {
        button.setButtonText("Open");
        button.onClick(() => this.plugin.activateView());
      });
  }
}

module.exports = WorkspaceOrchestratorPlugin;
