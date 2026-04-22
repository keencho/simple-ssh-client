import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { THEMES, THEME_ORDER, THEME_GROUPS, DEFAULT_THEME, FONTS, DEFAULT_FONT, getFontValue, getTheme, applyUiTheme, type TerminalTheme, type FontOption } from "./themes";
import "./fonts.css";

// Block browser default context menu (Inspect / Reload / etc.)
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Route by window label: terminal-only windows skip the sidebar shell.
const IS_TERMINAL_WINDOW = getCurrentWindow().label.startsWith("term-");
if (IS_TERMINAL_WINDOW) {
  void import("./terminal");
}
// Main window loads the terminal module AFTER renderShell creates
// #tabs and #terminals (see bootstrap block at bottom of file).

// --- Types ---

interface JumpHost {
  host: string;
  port: number;
  user: string;
  key_file: string;
}

interface SshSession {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  key_file: string;
  folder_id: string | null;
  order: number;
  jump_host: JumpHost | null;
}

interface Folder {
  id: string;
  name: string;
  order: number;
}

interface SessionsData {
  folders: Folder[];
  sessions: SshSession[];
  root_folder_order: number | null;
}

interface RemoteEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  permissions: string;
}

interface SftpProgress {
  session_id: string;
  filename: string;
  bytes_transferred: number;
  total_bytes: number;
  direction: string;
}

// --- State ---

let data: SessionsData = { folders: [], sessions: [], root_folder_order: null };
let searchQuery = "";

const COLLAPSED_FOLDERS_KEY = "ssh-collapsed-folders";
function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}
function saveCollapsedFolders() {
  try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...collapsedFolders])); } catch {}
}
let collapsedFolders = loadCollapsedFolders();
let globalNewWindow = false;

const SIDEBAR_POSITION_KEY = "kc-sidebar-position";
const SIDEBAR_HIDDEN_KEY = "kc-sidebar-hidden";
type SidebarPosition = "left" | "right";
let sidebarPosition: SidebarPosition =
  (localStorage.getItem(SIDEBAR_POSITION_KEY) as SidebarPosition) === "right" ? "right" : "left";
let sidebarHidden: boolean = localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1";

function applySidebarState() {
  document.body.classList.toggle("sidebar-right", sidebarPosition === "right");
  document.body.classList.toggle("sidebar-hidden", sidebarHidden);
}
function setSidebarPosition(pos: SidebarPosition) {
  sidebarPosition = pos;
  localStorage.setItem(SIDEBAR_POSITION_KEY, pos);
  applySidebarState();
  window.dispatchEvent(new Event("resize"));
}
function toggleSidebarHidden() {
  sidebarHidden = !sidebarHidden;
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, sidebarHidden ? "1" : "0");
  applySidebarState();
  window.dispatchEvent(new Event("resize"));
}

// --- SVG Icons ---

const ICONS = {
  search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
  refresh: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  plus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>`,
  edit: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>`,
  close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  jump: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>`,
  folder: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
  chevronDown: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`,
  chevronRight: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`,
  chevronLeft: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>`,
  terminal: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  server: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>`,
  drag: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.4"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`,
  fileManager: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  upload: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  folderPlus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
  file: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  folderOpen: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
  arrowUp: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  newWindow: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><path d="M10 14L21 3"/></svg>`,
  settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
};

// --- Helpers ---

const GENERIC_FONT_FAMILIES = new Set([
  "monospace", "sans-serif", "serif", "ui-monospace", "ui-sans-serif",
  "ui-serif", "system-ui", "cursive", "fantasy", "SFMono-Regular",
]);

function parseFontStack(value: string): string[] {
  return value.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
}

// Width-comparison font detection. `document.fonts.check()` gives false
// positives in webview2 (returns true even for uninstalled fonts). We render
// a test string in a hidden span with each generic fallback alone, then with
// the candidate font in front. If the width differs from at least one
// fallback, the font is installed.
const FONT_PROBE_STRING = "mmMwWLlIi00O0!@#$%^&*()_+{}[]|:;<>,.?/~`";
const FONT_PROBE_GENERICS = ["monospace", "sans-serif", "serif"];
let _fontProbeSpan: HTMLSpanElement | null = null;
const _fontProbeBaseline = new Map<string, number>();
const _fontInstallCache = new Map<string, boolean>();

function measureFontWidth(family: string): number {
  if (!_fontProbeSpan) {
    const s = document.createElement("span");
    s.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;font-size:72px;white-space:nowrap;";
    s.textContent = FONT_PROBE_STRING;
    document.body.appendChild(s);
    _fontProbeSpan = s;
  }
  _fontProbeSpan.style.fontFamily = family;
  return _fontProbeSpan.getBoundingClientRect().width;
}

function isFontInstalled(name: string): boolean {
  if (_fontInstallCache.has(name)) return _fontInstallCache.get(name)!;
  for (const g of FONT_PROBE_GENERICS) {
    if (!_fontProbeBaseline.has(g)) _fontProbeBaseline.set(g, measureFontWidth(g));
    const baseline = _fontProbeBaseline.get(g)!;
    const actual = measureFontWidth(`"${name}", ${g}`);
    if (Math.abs(actual - baseline) > 0.5) {
      _fontInstallCache.set(name, true);
      return true;
    }
  }
  _fontInstallCache.set(name, false);
  return false;
}

function resolveActualFont(value: string): { primary: string; actual: string | null } {
  const names = parseFontStack(value);
  const specifics = names.filter(n => !GENERIC_FONT_FAMILIES.has(n));
  const primary = specifics[0] ?? names[0];
  for (const n of names) {
    if (GENERIC_FONT_FAMILIES.has(n)) continue;
    if (isFontInstalled(n)) return { primary, actual: n };
  }
  return { primary, actual: null };
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getFolderName(folderId: string | null): string {
  if (!folderId) return "";
  return data.folders.find((f) => f.id === folderId)?.name || "";
}

function getKeyFileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function getSortedFolders(): Folder[] {
  return [...data.folders].sort((a, b) => a.order - b.order);
}

function getSessionsForFolder(folderId: string | null): SshSession[] {
  const q = searchQuery.toLowerCase();
  return data.sessions
    .filter((s) => {
      if (s.folder_id !== folderId) return false;
      if (!q) return true;
      const folderName = getFolderName(s.folder_id).toLowerCase();
      return s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q) || s.user.toLowerCase().includes(q) || folderName.includes(q);
    })
    .sort((a, b) => a.order - b.order);
}

function hasMatchingSessionsInFolder(folderId: string): boolean {
  if (!searchQuery) return true;
  return getSessionsForFolder(folderId).length > 0;
}

// --- Custom Dialogs ---

function customAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-message">${escapeHtml(message)}</div>
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector(".dialog-btn-ok")!.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter") { close(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);
    (overlay.querySelector(".dialog-btn-ok") as HTMLElement).focus();
  });
}

function customConfirm(message: string, title?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-box">
        ${title ? `<div class="dialog-title">${escapeHtml(title)}</div>` : ""}
        <div class="dialog-message">${escapeHtml(message)}</div>
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-cancel">취소</button>
          <button class="dialog-btn dialog-btn-ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (val: boolean) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".dialog-btn-ok")!.addEventListener("click", () => close(true));
    overlay.querySelector(".dialog-btn-cancel")!.addEventListener("click", () => close(false));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(false); });
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(false); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);
    (overlay.querySelector(".dialog-btn-ok") as HTMLElement).focus();
  });
}

interface TabResult {
  completed: string | null;
  candidates?: string[];
}

function customPrompt(message: string, defaultValue?: string, options?: { onTab?: (value: string) => Promise<TabResult> }): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-message">${escapeHtml(message)}</div>
        <input class="dialog-input" type="text" value="${escapeHtml(defaultValue || "")}" />
        <div class="dialog-suggestions" style="display:none"></div>
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-cancel">취소</button>
          <button class="dialog-btn dialog-btn-ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".dialog-input") as HTMLInputElement;
    const suggestionsEl = overlay.querySelector(".dialog-suggestions") as HTMLElement;
    const close = (val: string | null) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".dialog-btn-ok")!.addEventListener("click", () => close(input.value));
    overlay.querySelector(".dialog-btn-cancel")!.addEventListener("click", () => close(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });

    const hideSuggestions = () => { suggestionsEl.style.display = "none"; suggestionsEl.innerHTML = ""; };

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") { e.preventDefault(); close(input.value); }
      else if (e.key === "Escape") {
        e.preventDefault();
        if (suggestionsEl.style.display !== "none") { hideSuggestions(); }
        else { close(null); }
      }
      else if (e.key === "Tab" && options?.onTab) {
        e.preventDefault();
        const result = await options.onTab(input.value);
        if (result.completed !== null) {
          input.value = result.completed;
          hideSuggestions();
        }
        if (result.candidates && result.candidates.length > 1) {
          suggestionsEl.style.display = "block";
          suggestionsEl.innerHTML = result.candidates.map(c =>
            `<div class="dialog-suggestion-item">${ICONS.folderOpen} ${escapeHtml(c)}</div>`
          ).join("");
          suggestionsEl.querySelectorAll(".dialog-suggestion-item").forEach((item, i) => {
            item.addEventListener("click", () => {
              const parentDir = input.value.replace(/\/[^/]*$/, "") || "/";
              input.value = (parentDir === "/" ? "/" : parentDir + "/") + result.candidates![i] + "/";
              hideSuggestions();
              input.focus();
            });
          });
        }
      }
    });
    input.addEventListener("input", hideSuggestions);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// --- Actions ---

async function loadData() {
  try {
    data = await invoke<SessionsData>("get_all_data");
    renderTree();
    renderStats();
  } catch (e) {
    const area = document.getElementById("content-area");
    if (area) area.innerHTML = `<div class="empty" style="color:var(--red)">데이터 로드 실패: ${e}</div>`;
  }
}

async function connectSession(id: string, newWindow: boolean) {
  try {
    await invoke("open_ssh", { id, newWindow });
  } catch (e) {
    customAlert("연결 실패: " + e);
  }
}

let deleteInProgress = false;
async function deleteSession(id: string) {
  if (deleteInProgress) return;
  deleteInProgress = true;
  try {
    const session = data.sessions.find((s) => s.id === id);
    const ok = await customConfirm(`"${session?.name || id}" 세션을 삭제할까요?`, "세션 삭제");
    if (!ok) return;
    data = await invoke<SessionsData>("delete_session", { id });
    renderTree();
    renderStats();
  } catch (e) {
    customAlert("삭제 실패: " + e);
  } finally {
    deleteInProgress = false;
  }
}

async function addFolder() {
  const name = await customPrompt("폴더 이름:");
  if (!name) return;
  try {
    data = await invoke<SessionsData>("create_folder", { name });
    renderTree();
    renderStats();
  } catch (e) {
    customAlert("폴더 생성 실패: " + e);
  }
}

async function deleteFolder(id: string) {
  const folder = data.folders.find((f) => f.id === id);
  if (!folder) return;
  const ok = await customConfirm(`"${folder.name}" 폴더를 삭제할까요?\n(세션은 미분류로 이동됩니다)`, "폴더 삭제");
  if (!ok) return;
  try {
    data = await invoke<SessionsData>("delete_folder", { id });
    collapsedFolders.delete(id);
    saveCollapsedFolders();
    renderTree();
    renderStats();
  } catch (e) {
    customAlert("폴더 삭제 실패: " + e);
  }
}

async function editFolder(id: string) {
  const folder = data.folders.find((f) => f.id === id);
  if (!folder) return;
  const name = await customPrompt("폴더 이름 변경 (비우면 삭제):", folder.name);
  if (name === null) return;
  if (!name) {
    const ok = await customConfirm(`"${folder.name}" 폴더를 삭제할까요?\n(세션은 미분류로 이동됩니다)`, "폴더 삭제");
    if (!ok) return;
    data = await invoke<SessionsData>("delete_folder", { id });
    collapsedFolders.delete(id);
    saveCollapsedFolders();
  } else {
    data = await invoke<SessionsData>("update_folder", { id, name });
  }
  renderTree();
  renderStats();
}

// --- Custom DnD (inline transform animation) ---

interface DndItem {
  el: HTMLElement;
  id: string;
  midY: number; // original center Y
  height: number;
  originalIndex: number;
}

let dndJustFinished = false;

let dnd: {
  type: "session" | "folder";
  dragEl: HTMLElement;
  dragId: string;
  dragOrigIdx: number;
  items: DndItem[];
  currentIndex: number;
  startY: number;
  folderId: string | null;
} | null = null;

function initDnD() {
  const content = document.getElementById("content-area")!;

  content.addEventListener("mousedown", (e) => {
    const handle = (e.target as HTMLElement).closest(".drag-handle") as HTMLElement | null;
    if (!handle) return;

    const sessionRow = handle.closest("[data-session-id]") as HTMLElement | null;
    const folderHeader = handle.closest(".tree-folder-header") as HTMLElement | null;

    let type: "session" | "folder";
    let dragEl: HTMLElement;
    let dragId: string;
    let folderId: string | null = null;

    if (sessionRow) {
      type = "session";
      dragEl = sessionRow;
      dragId = sessionRow.dataset.sessionId!;
      const s = data.sessions.find((s) => s.id === dragId);
      folderId = s?.folder_id ?? null;
    } else if (folderHeader) {
      const folderEl = folderHeader.closest("[data-folder-id]") as HTMLElement | null;
      if (!folderEl) return;
      type = "folder";
      dragEl = folderEl;
      dragId = folderEl.dataset.folderId!;
    } else {
      return;
    }

    e.preventDefault();

    // Collect all siblings of same type in same container
    let allEls: HTMLElement[];
    if (type === "session") {
      const parent = dragEl.parentElement!;
      allEls = Array.from(parent.children).filter(
        (el) => el instanceof HTMLElement && el.dataset.sessionId
      ) as HTMLElement[];
    } else {
      // Only direct children of content-area that are folders
      allEls = Array.from(content.children).filter(
        (el) => el instanceof HTMLElement && el.dataset.folderId
      ) as HTMLElement[];
    }

    const items: DndItem[] = allEls.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        id: type === "session" ? el.dataset.sessionId! : el.dataset.folderId!,
        midY: r.top + r.height / 2,
        height: r.height,
        originalIndex: i,
      };
    });

    const dragOrigIdx = items.findIndex((it) => it.id === dragId);
    if (dragOrigIdx < 0) return;

    dragEl.style.position = "relative";
    dragEl.style.zIndex = "100";
    dragEl.classList.add("dnd-active-item");
    document.body.classList.add("dnd-active");

    dnd = {
      type,
      dragEl,
      dragId,
      dragOrigIdx,
      items,
      currentIndex: dragOrigIdx,
      startY: e.clientY,
      folderId,
    };
  });

  document.addEventListener("mousemove", (e) => {
    if (!dnd) return;
    e.preventDefault();

    const deltaY = e.clientY - dnd.startY;
    const { dragOrigIdx, items, dragId } = dnd;
    const dragItem = items[dragOrigIdx];

    // Move dragged element
    dnd.dragEl.style.transform = `translateY(${deltaY}px)`;

    // Determine new index by comparing mouse position to original midpoints
    const mouseY = e.clientY;
    let newIndex = dragOrigIdx;

    if (deltaY > 0) {
      // Moving down
      for (let i = dragOrigIdx + 1; i < items.length; i++) {
        if (mouseY > items[i].midY) {
          newIndex = i;
        } else {
          break;
        }
      }
    } else {
      // Moving up
      for (let i = dragOrigIdx - 1; i >= 0; i--) {
        if (mouseY < items[i].midY) {
          newIndex = i;
        } else {
          break;
        }
      }
    }

    if (newIndex !== dnd.currentIndex) {
      dnd.currentIndex = newIndex;

      // Animate other items to make room
      for (const item of items) {
        if (item.id === dragId) continue;

        let shift = 0;
        if (dragOrigIdx < newIndex) {
          // Dragging down: items between old+1 and new move up by drag item height
          if (item.originalIndex > dragOrigIdx && item.originalIndex <= newIndex) {
            shift = -dragItem.height;
          }
        } else if (dragOrigIdx > newIndex) {
          // Dragging up: items between new and old-1 move down
          if (item.originalIndex >= newIndex && item.originalIndex < dragOrigIdx) {
            shift = dragItem.height;
          }
        }

        item.el.style.transition = "transform 0.2s ease";
        item.el.style.transform = shift ? `translateY(${shift}px)` : "";
      }
    }
  });

  document.addEventListener("mouseup", async () => {
    if (!dnd) return;

    const { type, dragId, items, currentIndex, dragOrigIdx, folderId } = dnd;

    // Cleanup styles immediately
    for (const item of items) {
      item.el.style.transform = "";
      item.el.style.transition = "";
      item.el.style.position = "";
      item.el.style.zIndex = "";
    }
    dnd.dragEl.classList.remove("dnd-active-item");
    document.body.classList.remove("dnd-active");
    dnd = null;
    dndJustFinished = true;
    setTimeout(() => { dndJustFinished = false; }, 50);

    // Skip if no change
    if (dragOrigIdx === currentIndex) return;

    // Build new order
    const ids = items.map((it) => it.id);
    const moved = ids.splice(dragOrigIdx, 1)[0];
    ids.splice(currentIndex, 0, moved);

    // Save & re-render immediately
    if (type === "session") {
      const updates: SshSession[] = ids.map((sid, i) => {
        const s = data.sessions.find((s) => s.id === sid)!;
        return { ...s, order: i, folder_id: folderId };
      });
      try {
        data = await invoke<SessionsData>("reorder_sessions", { sessions: updates });
      } catch (e) {
        customAlert("순서 변경 실패: " + e);
      }
    } else {
      let rootFolderOrder: number | null = null;
      const updates: Folder[] = [];
      ids.forEach((fid, i) => {
        if (fid === "__root__") {
          rootFolderOrder = i;
        } else {
          const f = data.folders.find((f) => f.id === fid)!;
          updates.push({ ...f, order: i });
        }
      });
      try {
        data = await invoke<SessionsData>("reorder_folders", { folders: updates, rootFolderOrder });
      } catch (e) {
        customAlert("순서 변경 실패: " + e);
      }
    }
    renderTree();
  });
}

// --- Context menu ---

interface CtxMenuItem {
  label: string;
  icon?: string;
  action: () => void;
  danger?: boolean;
}

function showContextMenu(x: number, y: number, items: CtxMenuItem[]) {
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = items.map((it, i) =>
    it.label === "-"
      ? `<div class="ctx-sep"></div>`
      : `<div class="ctx-item ${it.danger ? "ctx-item-danger" : ""}" data-idx="${i}">${it.icon || ""}<span>${escapeHtml(it.label)}</span></div>`
  ).join("");
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  let adjX = x, adjY = y;
  if (rect.right > window.innerWidth) adjX = Math.max(4, window.innerWidth - rect.width - 4);
  if (rect.bottom > window.innerHeight) adjY = Math.max(4, window.innerHeight - rect.height - 4);
  menu.style.left = adjX + "px";
  menu.style.top = adjY + "px";
  menu.style.visibility = "";

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", close);
  };
  const outside = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) close(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };

  menu.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest(".ctx-item") as HTMLElement | null;
    if (!el) return;
    const idx = Number(el.dataset.idx);
    close();
    items[idx]?.action();
  });
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("blur", close);
}

// --- Sidebar resize ---

function initSidebarResizer() {
  const resizer = document.getElementById("sidebar-resizer");
  const sidebar = document.getElementById("sidebar");
  if (!resizer || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    document.body.classList.add("sidebar-resizing");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const direction = sidebarPosition === "right" ? -1 : 1;
    const w = Math.max(240, Math.min(640, startW + direction * (e.clientX - startX)));
    sidebar.style.width = w + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sidebar-resizing");
    localStorage.setItem("sidebar-w", String(sidebar.offsetWidth));
  });
}

// --- Modal ---

async function openSettings() {
  const currentThemeName: string = (await invoke<string | null>("get_terminal_theme")) ?? DEFAULT_THEME;
  const currentFontName: string = (await invoke<string | null>("get_terminal_font")) ?? DEFAULT_FONT;
  const currentLogDir: string = await invoke<string>("get_log_dir");
  const currentSshVerbose: boolean = await invoke<boolean>("get_ssh_verbose");
  const currentDataPath: string = await invoke<string>("get_data_file_path");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  let selectedName = currentThemeName;
  let rankMap = new Map<string, number>();
  THEME_ORDER.forEach((n, i) => rankMap.set(n, i + 1));

  const renderCard = (t: TerminalTheme) => {
    const x = t.xterm;
    const selected = t.name === selectedName;
    const rank = rankMap.get(t.name) ?? 0;
    const swatches = [x.red, x.green, x.yellow, x.blue, x.magenta, x.cyan]
      .map(c => `<span class="theme-dot" style="background:${c}"></span>`).join("");
    return `
      <div class="theme-card ${selected ? "selected" : ""}" data-theme-name="${t.name}" style="background:${x.background}; border-color:${selected ? t.ui.accent : "transparent"}">
        <div class="theme-card-rank" style="color:${t.ui.fgDim}; border-color:${t.ui.border}">#${rank}</div>
        <div class="theme-card-header">
          <span class="theme-card-title" style="color:${x.foreground}">${escapeHtml(t.displayName)}</span>
          <span class="theme-card-check" style="color:${t.ui.accent}; ${selected ? "" : "visibility:hidden"}">${ICONS.check}</span>
        </div>
        <div class="theme-card-sample" style="color:${x.foreground}">
          <div><span style="color:${x.green}">$</span> <span style="color:${x.blue}">ls</span> <span style="color:${x.cyan}">-la</span></div>
          <div><span style="color:${x.magenta}">drwxr-xr-x</span> <span style="color:${x.foreground}">user</span> <span style="color:${x.yellow}">docs</span></div>
        </div>
        <div class="theme-card-dots">${swatches}</div>
        <div class="theme-card-blurb">${escapeHtml(t.blurb)}</div>
      </div>
    `;
  };

  const renderGroup = (g: { label: string; names: string[] }) => `
    <div class="theme-group">
      <div class="theme-group-header">
        <span class="theme-group-label">${escapeHtml(g.label)}</span>
        <span class="theme-group-count">${g.names.length}</span>
      </div>
      <div class="theme-grid">
        ${g.names.map(n => renderCard(THEMES[n])).join("")}
      </div>
    </div>
  `;

  // Group fonts by availability: bundled / system-installed / missing.
  // Bundled are shipped via @fontsource — always available offline.
  // Installed detection uses width measurement (reliable in webview2).
  const bundledFonts: FontOption[] = [];
  const installedFonts: FontOption[] = [];
  const missingFonts: FontOption[] = [];
  for (const f of FONTS) {
    if (f.bundled) { bundledFonts.push(f); continue; }
    const primary = parseFontStack(f.value).find(n => !GENERIC_FONT_FAMILIES.has(n));
    if (primary && isFontInstalled(primary)) installedFonts.push(f);
    else missingFonts.push(f);
  }
  const renderOption = (f: FontOption) =>
    `<option value="${escapeHtml(f.label)}" ${f.label === currentFontName ? "selected" : ""}>${escapeHtml(f.label)}</option>`;
  const fontOptions = [
    bundledFonts.length  ? `<optgroup label="✓ 번들됨 (항상 사용 가능)">${bundledFonts.map(renderOption).join("")}</optgroup>` : "",
    installedFonts.length ? `<optgroup label="✓ 시스템에 설치됨">${installedFonts.map(renderOption).join("")}</optgroup>` : "",
    missingFonts.length  ? `<optgroup label="⚠ 미설치">${missingFonts.map(renderOption).join("")}</optgroup>` : "",
  ].filter(Boolean).join("");

  overlay.innerHTML = `
    <div class="modal modal-settings">
      <header class="settings-header">
        <div class="settings-title">설정</div>
        <button class="settings-close" title="닫기">${ICONS.close}</button>
      </header>
      <div class="settings-body">
        <aside class="settings-nav">
          <button class="settings-nav-item active" data-section="font">폰트</button>
          <button class="settings-nav-item" data-section="theme">테마</button>
          <button class="settings-nav-item" data-section="layout">외관</button>
          <button class="settings-nav-item" data-section="log">로그</button>
          <button class="settings-nav-item" data-section="data">데이터</button>
        </aside>
        <div class="settings-content">
          <section class="settings-panel" data-section="font">
            <div class="settings-panel-title">폰트</div>
            <div class="settings-panel-subtitle">선택하면 열려있는 모든 터미널에 즉시 적용됩니다. 설치되지 않은 폰트는 대체 폰트로 렌더됩니다.</div>
            <select class="settings-select" id="settings-font">${fontOptions}</select>
            <div class="settings-font-status" id="settings-font-status"></div>
            <pre class="settings-font-sample" id="settings-font-sample">[ec2-user@host ~]$ ls -la | grep foo
drwxr-xr-x  user  1024  2026-04-20  documents/
-rw-r--r--  user  2048  2026-04-20  readme.md
The quick brown fox jumps over 0123456789 ({[]}) "\`~$"</pre>
          </section>
          <section class="settings-panel" data-section="theme" hidden>
            <div class="settings-panel-title">터미널 테마</div>
            <div class="settings-panel-subtitle">랭킹 순 · 선택하면 열려있는 모든 터미널에 즉시 적용됩니다.</div>
            <div class="theme-groups">
              ${THEME_GROUPS.map(renderGroup).join("")}
            </div>
          </section>
          <section class="settings-panel" data-section="layout" hidden>
            <div class="settings-panel-title">외관</div>
            <div class="settings-panel-subtitle">사이드바 위치를 지정합니다. 숨김/펼침은 사이드바 상단의 화살표 버튼으로 언제든 토글할 수 있습니다.</div>
            <div class="settings-radio-group">
              <label class="settings-radio-label">
                <input type="radio" name="sidebar-pos" value="left" ${sidebarPosition === "left" ? "checked" : ""} />
                <span>왼쪽</span>
              </label>
              <label class="settings-radio-label">
                <input type="radio" name="sidebar-pos" value="right" ${sidebarPosition === "right" ? "checked" : ""} />
                <span>오른쪽</span>
              </label>
            </div>
          </section>
          <section class="settings-panel" data-section="log" hidden>
            <div class="settings-panel-title">로그</div>
            <div class="settings-panel-subtitle">앱 동작 로그와 (verbose 모드) SSH 접속 디버그 로그가 저장되는 위치입니다.</div>

            <div class="settings-row-label">로그 폴더</div>
            <div class="settings-path-row">
              <code class="settings-path" id="settings-log-path">${escapeHtml(currentLogDir)}</code>
            </div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="settings-log-open-folder">${ICONS.folderOpen}<span>폴더 열기</span></button>
              <button class="btn-secondary-sm" id="settings-log-change-dir">${ICONS.edit}<span>경로 변경</span></button>
              <button class="btn-secondary-sm" id="settings-log-reset-dir">기본값</button>
              <button class="btn-secondary-sm" id="settings-log-clear" style="margin-left:auto">${ICONS.trash}<span>전체 삭제</span></button>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row-label">SSH Verbose 디버그 로그</div>
            <label class="settings-toggle-row">
              <input type="checkbox" id="settings-ssh-verbose" ${currentSshVerbose ? "checked" : ""}>
              <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
              <span class="settings-toggle-text">연결 시 ssh에 <code>-vv</code> + <code>-E {로그폴더}/ssh-*.log</code> 추가</span>
            </label>
            <div class="settings-panel-hint">Permission denied / 알고리즘 불일치 등 접속 실패 원인을 파악할 때 켜세요. 세션마다 별도 파일이 생성됩니다.</div>
          </section>
          <section class="settings-panel" data-section="data" hidden>
            <div class="settings-panel-title">데이터</div>
            <div class="settings-panel-subtitle">세션과 폴더 정보는 JSON 파일 하나로 관리됩니다. 백업, 다른 기기로 이전, 경로 변경이 가능합니다.</div>

            <div class="settings-row-label">현재 데이터 파일</div>
            <div class="settings-path-row">
              <code class="settings-path" id="settings-data-path">${escapeHtml(currentDataPath)}</code>
            </div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="settings-data-open-folder">${ICONS.folderOpen}<span>폴더 열기</span></button>
              <button class="btn-secondary-sm" id="settings-data-change">${ICONS.edit}<span>다른 파일 사용</span></button>
              <button class="btn-secondary-sm" id="settings-data-reset">기본값</button>
            </div>
            <div class="settings-panel-hint">다른 파일을 지정하면 이후 저장/불러오기가 그 파일로 갑니다. JSON 양식이 맞지 않으면 지정되지 않습니다.</div>

            <div class="settings-divider"></div>

            <div class="settings-row-label">내보내기 / 가져오기</div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="settings-data-export">${ICONS.download}<span>내보내기 (JSON)</span></button>
              <button class="btn-secondary-sm" id="settings-data-import">${ICONS.upload}<span>가져오기 (JSON)</span></button>
            </div>
            <div class="settings-panel-hint">내보내기는 현재 데이터의 복사본을 저장합니다. 가져오기는 현재 세션/폴더를 <strong>모두 대체</strong>합니다.</div>
          </section>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    document.getElementById("settings-font-cdn-link")?.remove();
    overlay.remove();
  };
  overlay.querySelector(".settings-close")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  // Nav switching
  overlay.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.section;
      if (!target) return;
      overlay.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((b) =>
        b.classList.toggle("active", b.dataset.section === target));
      overlay.querySelectorAll<HTMLElement>(".settings-panel").forEach((p) => {
        if (p.dataset.section === target) p.removeAttribute("hidden");
        else p.setAttribute("hidden", "");
      });
    });
  });

  // Layout section
  overlay.querySelectorAll<HTMLInputElement>('input[name="sidebar-pos"]').forEach((r) => {
    r.addEventListener("change", () => setSidebarPosition(r.value as SidebarPosition));
  });

  // Font section
  const fontSelect = overlay.querySelector("#settings-font") as HTMLSelectElement;
  const fontSample = overlay.querySelector("#settings-font-sample") as HTMLElement;
  const fontStatus = overlay.querySelector("#settings-font-status") as HTMLElement;

  // Single-slot CDN preview loader. Loads Google Fonts CSS for missing fonts
  // on-demand so user can see them. Cleared when the modal closes or when
  // the user switches to a bundled/installed font.
  const setCdnPreview = (url: string | null) => {
    const existing = document.getElementById("settings-font-cdn-link") as HTMLLinkElement | null;
    if (!url) { existing?.remove(); return; }
    if (existing && existing.href === url) return;
    existing?.remove();
    const link = document.createElement("link");
    link.id = "settings-font-cdn-link";
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  };

  const updateFontUI = async (label: string) => {
    const entry = FONTS.find(f => f.label === label);
    const value = entry?.value ?? getFontValue(label);
    const primary = parseFontStack(value).find(n => !GENERIC_FONT_FAMILIES.has(n)) ?? label;
    const installed = entry?.bundled || (primary && isFontInstalled(primary));

    // Manage CDN preview: only for non-bundled + not-installed + has cdnUrl.
    if (!entry?.bundled && !installed && entry?.cdnUrl) {
      setCdnPreview(entry.cdnUrl);
      try { await (document as any).fonts.load(`12px "${primary}"`); } catch {}
    } else {
      setCdnPreview(null);
    }

    fontSample.style.fontFamily = value;

    // Re-check after potential CDN load to update badge
    const r = resolveActualFont(value);
    const nowAvailable = entry?.bundled || (r.actual === r.primary);
    const isCdnPreview = !entry?.bundled && !installed && !!entry?.cdnUrl;

    let cls: string, text: string;
    if (entry?.bundled) {
      cls = "installed";
      text = `✓ 번들됨 — "${r.primary}" (항상 사용 가능)`;
    } else if (nowAvailable && !isCdnPreview) {
      cls = "installed";
      text = `✓ 시스템 설치됨 — "${r.primary}"`;
    } else if (isCdnPreview) {
      cls = "cdn";
      text = `🌐 온라인 프리뷰 (Google Fonts) — 오프라인 사용하려면 설치 필요`;
    } else if (r.actual) {
      cls = "missing";
      text = `⚠ "${r.primary}" 미설치 — 실제 렌더: "${r.actual}"`;
    } else {
      cls = "missing";
      text = `⚠ "${r.primary}" 미설치 — 시스템 기본 monospace로 렌더`;
    }

    const installBtn = entry?.installUrl && !entry.bundled && (!installed || isCdnPreview)
      ? `<button class="settings-font-install-btn" data-url="${escapeHtml(entry.installUrl)}">공식 다운로드 ↗</button>`
      : "";
    fontStatus.className = `settings-font-status ${cls}`;
    fontStatus.innerHTML = `<span class="settings-font-status-text">${escapeHtml(text)}</span>${installBtn}`;
  };
  void updateFontUI(currentFontName);
  fontSelect.addEventListener("change", async () => {
    const label = fontSelect.value;
    await updateFontUI(label);
    try { await invoke("set_terminal_font", { name: label }); }
    catch (err) { customAlert("폰트 적용 실패: " + err); }
  });
  fontStatus.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(".settings-font-install-btn") as HTMLButtonElement | null;
    if (!btn?.dataset.url) return;
    try { await openExternal(btn.dataset.url); } catch (err) { customAlert("링크 열기 실패: " + err); }
  });

  // Log section
  const logPathEl = overlay.querySelector("#settings-log-path") as HTMLElement;
  overlay.querySelector("#settings-log-open-folder")!.addEventListener("click", async () => {
    try { await invoke("open_path_in_os", { path: logPathEl.textContent || "" }); }
    catch (err) { customAlert("폴더 열기 실패: " + err); }
  });
  overlay.querySelector("#settings-log-change-dir")!.addEventListener("click", async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "로그 폴더 선택" });
      if (typeof picked !== "string") return;
      const resolved = await invoke<string>("set_log_dir", { path: picked });
      logPathEl.textContent = resolved;
    } catch (err) { customAlert("경로 변경 실패: " + err); }
  });
  overlay.querySelector("#settings-log-reset-dir")!.addEventListener("click", async () => {
    try {
      const resolved = await invoke<string>("set_log_dir", { path: null });
      logPathEl.textContent = resolved;
    } catch (err) { customAlert("기본값 설정 실패: " + err); }
  });
  overlay.querySelector("#settings-log-clear")!.addEventListener("click", async () => {
    if (!await customConfirm(`로그 폴더의 모든 *.log 파일을 삭제합니다.\n${logPathEl.textContent}`, "로그 삭제")) return;
    try {
      const n = await invoke<number>("clear_logs");
      await customAlert(`${n}개 로그 파일을 삭제했습니다.`);
    } catch (err) { customAlert("로그 삭제 실패: " + err); }
  });
  overlay.querySelector("#settings-ssh-verbose")!.addEventListener("change", async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    try { await invoke("set_ssh_verbose", { enabled: checked }); }
    catch (err) { customAlert("설정 실패: " + err); }
  });

  // Data section
  const dataPathEl = overlay.querySelector("#settings-data-path") as HTMLElement;
  const parentOf = (p: string) => p.replace(/[\\\/][^\\\/]+$/, "") || p;
  overlay.querySelector("#settings-data-open-folder")!.addEventListener("click", async () => {
    try { await invoke("open_path_in_os", { path: parentOf(dataPathEl.textContent || "") }); }
    catch (err) { customAlert("폴더 열기 실패: " + err); }
  });
  overlay.querySelector("#settings-data-change")!.addEventListener("click", async () => {
    try {
      const picked = await open({ multiple: false, title: "데이터 JSON 파일 선택", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      const resolved = await invoke<string>("set_data_file_path", { path: picked });
      dataPathEl.textContent = resolved;
      await loadData();
    } catch (err) { customAlert("경로 변경 실패: " + err); }
  });
  overlay.querySelector("#settings-data-reset")!.addEventListener("click", async () => {
    try {
      const resolved = await invoke<string>("set_data_file_path", { path: null });
      dataPathEl.textContent = resolved;
      await loadData();
    } catch (err) { customAlert("기본값 설정 실패: " + err); }
  });
  overlay.querySelector("#settings-data-export")!.addEventListener("click", async () => {
    try {
      const picked = await save({ defaultPath: "simple-ssh-client-sessions.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      await invoke("export_sessions_to", { targetPath: picked });
      await customAlert(`내보내기 완료\n${picked}`);
    } catch (err) { customAlert("내보내기 실패: " + err); }
  });
  overlay.querySelector("#settings-data-import")!.addEventListener("click", async () => {
    try {
      const picked = await open({ multiple: false, title: "가져올 JSON 파일 선택", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      if (!await customConfirm("현재 세션/폴더가 모두 대체됩니다. 계속할까요?", "가져오기")) return;
      await invoke("import_sessions_from", { sourcePath: picked });
      await loadData();
      await customAlert("가져오기 완료. 사이드바가 새로고침되었습니다.");
    } catch (err) { customAlert("가져오기 실패: " + err); }
  });

  // Theme section
  const root = overlay.querySelector(".theme-groups") as HTMLElement;
  root.addEventListener("click", async (e) => {
    const card = (e.target as HTMLElement).closest(".theme-card") as HTMLElement | null;
    if (!card) return;
    const name = card.dataset.themeName!;
    if (name === selectedName) return;
    selectedName = name;
    root.querySelectorAll(".theme-card").forEach(el => {
      const cardName = (el as HTMLElement).dataset.themeName!;
      const isActive = cardName === name;
      el.classList.toggle("selected", isActive);
      const check = el.querySelector(".theme-card-check") as HTMLElement;
      if (check) check.style.visibility = isActive ? "" : "hidden";
      (el as HTMLElement).style.borderColor = isActive ? THEMES[cardName].ui.accent : "transparent";
    });
    try { await invoke("set_terminal_theme", { name }); }
    catch (err) { customAlert("테마 적용 실패: " + err); }
  });

  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
}

function openModal(session?: SshSession, defaultFolderId?: string | null) {
  const isEdit = !!session;
  const folders = getSortedFolders();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="modal-close">${ICONS.close}</button>
      <div class="modal-title">${isEdit ? "세션 편집" : "세션 추가"}</div>
      <div class="form-group">
        <label class="form-label">이름</label>
        <input class="form-input" id="f-name" value="${escapeHtml(session?.name || "")}" placeholder="서버 이름" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Host</label>
          <input class="form-input" id="f-host" value="${escapeHtml(session?.host || "")}" placeholder="IP 또는 hostname" />
        </div>
        <div class="form-group small">
          <label class="form-label">Port</label>
          <input class="form-input" id="f-port" type="number" value="${session?.port || 22}" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">User</label>
        <input class="form-input" id="f-user" value="${escapeHtml(session?.user || "")}" placeholder="ec2-user" />
      </div>
      <div class="form-group">
        <label class="form-label">Key File</label>
        <div class="form-file-row">
          <input class="form-input" id="f-keyfile" value="${escapeHtml(session?.key_file || "")}" placeholder="SSH key 경로" />
          <button class="form-file-btn" id="f-browse-key">찾기</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">폴더</label>
        <select class="form-select" id="f-folder">
          <option value="">(미분류)</option>
          ${folders.map((f) => {
            const selected = isEdit ? session?.folder_id === f.id : defaultFolderId === f.id;
            return `<option value="${f.id}" ${selected ? "selected" : ""}>${escapeHtml(f.name)}</option>`;
          }).join("")}
        </select>
      </div>
      <label class="jump-toggle">
        <input type="checkbox" id="f-use-jump" ${session?.jump_host ? "checked" : ""} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="jump-toggle-label">Jump Host 사용</span>
      </label>
      <div class="jump-section ${session?.jump_host ? "" : "hidden"}" id="jump-section">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Jump Host</label>
            <input class="form-input" id="f-jhost" value="${escapeHtml(session?.jump_host?.host || "")}" placeholder="Bastion IP" />
          </div>
          <div class="form-group small">
            <label class="form-label">Port</label>
            <input class="form-input" id="f-jport" type="number" value="${session?.jump_host?.port || 22}" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Jump User</label>
          <input class="form-input" id="f-juser" value="${escapeHtml(session?.jump_host?.user || "")}" placeholder="ec2-user" />
        </div>
        <div class="form-group">
          <label class="form-label">Jump Key File</label>
          <div class="form-file-row">
            <input class="form-input" id="f-jkeyfile" value="${escapeHtml(session?.jump_host?.key_file || "")}" placeholder="Bastion key 경로" />
            <button class="form-file-btn" id="f-browse-jkey">찾기</button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-cancel" id="modal-cancel">취소</button>
        <button class="btn-save" id="modal-save">저장</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#modal-close")!.addEventListener("click", close);
  overlay.querySelector("#modal-cancel")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  const jumpCb = overlay.querySelector("#f-use-jump") as HTMLInputElement;
  const jumpSec = overlay.querySelector("#jump-section") as HTMLElement;
  jumpCb.addEventListener("change", () => jumpSec.classList.toggle("hidden", !jumpCb.checked));

  overlay.querySelector("#f-browse-key")!.addEventListener("click", async () => {
    const path = await open({ filters: [{ name: "Key Files", extensions: ["pem", "key", "ppk"] }], multiple: false });
    if (path) (overlay.querySelector("#f-keyfile") as HTMLInputElement).value = path as string;
  });
  overlay.querySelector("#f-browse-jkey")!.addEventListener("click", async () => {
    const path = await open({ filters: [{ name: "Key Files", extensions: ["pem", "key", "ppk"] }], multiple: false });
    if (path) (overlay.querySelector("#f-jkeyfile") as HTMLInputElement).value = path as string;
  });

  overlay.querySelector("#modal-save")!.addEventListener("click", async () => {
    const name = (overlay.querySelector("#f-name") as HTMLInputElement).value.trim();
    const host = (overlay.querySelector("#f-host") as HTMLInputElement).value.trim();
    const port = parseInt((overlay.querySelector("#f-port") as HTMLInputElement).value) || 22;
    const user = (overlay.querySelector("#f-user") as HTMLInputElement).value.trim();
    const keyFile = (overlay.querySelector("#f-keyfile") as HTMLInputElement).value.trim();
    const folderId = (overlay.querySelector("#f-folder") as HTMLSelectElement).value || null;
    if (!name || !host || !user) { customAlert("이름, Host, User는 필수 항목입니다."); return; }

    let jumpHost: JumpHost | null = null;
    if (jumpCb.checked) {
      const jHost = (overlay.querySelector("#f-jhost") as HTMLInputElement).value.trim();
      const jPort = parseInt((overlay.querySelector("#f-jport") as HTMLInputElement).value) || 22;
      const jUser = (overlay.querySelector("#f-juser") as HTMLInputElement).value.trim();
      const jKey = (overlay.querySelector("#f-jkeyfile") as HTMLInputElement).value.trim();
      if (jHost && jUser) jumpHost = { host: jHost, port: jPort, user: jUser, key_file: jKey };
    }

    try {
      if (isEdit && session) {
        data = await invoke<SessionsData>("update_session", {
          session: { ...session, name, host, port, user, key_file: keyFile, folder_id: folderId, jump_host: jumpHost },
        });
      } else {
        data = await invoke<SessionsData>("create_session", { name, host, port, user, keyFile, folderId, jumpHost });
      }
      close(); renderTree(); renderStats();
    } catch (e) { customAlert("저장 실패: " + e); }
  });

  const escHandler = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
  setTimeout(() => (overlay.querySelector("#f-name") as HTMLInputElement)?.focus(), 50);
}

// --- SFTP File Manager ---

function humanizeSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(1) + " GB";
}

function formatDate(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

let sftpPanelCounter = 0;

function makeDraggableResizable(panel: HTMLElement, header: HTMLElement) {
  // Drag
  let isDragging = false, dragX = 0, dragY = 0;
  header.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    isDragging = true;
    dragX = e.clientX - panel.offsetLeft;
    dragY = e.clientY - panel.offsetTop;
    panel.style.transition = "none";
    bringToFront(panel);
  });
  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    panel.style.left = Math.max(0, e.clientX - dragX) + "px";
    panel.style.top = Math.max(0, e.clientY - dragY) + "px";
  });
  document.addEventListener("mouseup", () => { isDragging = false; });

  // Resize
  const handle = document.createElement("div");
  handle.className = "sftp-resize-handle";
  panel.appendChild(handle);
  let isResizing = false, resizeX = 0, resizeY = 0, startW = 0, startH = 0;
  handle.addEventListener("mousedown", (e) => {
    isResizing = true;
    resizeX = e.clientX; resizeY = e.clientY;
    startW = panel.offsetWidth; startH = panel.offsetHeight;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    panel.style.width = Math.max(500, startW + (e.clientX - resizeX)) + "px";
    panel.style.height = Math.max(350, startH + (e.clientY - resizeY)) + "px";
  });
  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      localStorage.setItem("sftp-panel-w", String(panel.offsetWidth));
      localStorage.setItem("sftp-panel-h", String(panel.offsetHeight));
    }
  });

  // Click to bring to front
  panel.addEventListener("mousedown", () => bringToFront(panel));
}

function bringToFront(panel: HTMLElement) {
  const panels = document.querySelectorAll(".sftp-panel");
  let maxZ = 1000;
  panels.forEach(p => { maxZ = Math.max(maxZ, parseInt((p as HTMLElement).style.zIndex || "1000")); });
  panel.style.zIndex = String(maxZ + 1);
}

// Exposed to terminal.ts (which lives in a sibling module) for the terminal
// pane right-click menu's "SFTP 열기 (현재 경로)" item.
(window as any).__sshmgr_openSftpPanel = (sid: string, dir?: string) => openSftpPanel(sid, dir);

async function openSftpPanel(sessionId: string, initialDir?: string) {
  const session = data.sessions.find(s => s.id === sessionId);
  if (!session) return;

  const panelId = `sftp-${++sftpPanelCounter}`;
  const offset = (sftpPanelCounter % 5) * 30;

  const savedW = localStorage.getItem("sftp-panel-w");
  const savedH = localStorage.getItem("sftp-panel-h");

  const panel = document.createElement("div");
  panel.className = "sftp-panel";
  panel.id = panelId;
  panel.style.left = (80 + offset) + "px";
  panel.style.top = (40 + offset) + "px";
  if (savedW) panel.style.width = savedW + "px";
  if (savedH) panel.style.height = savedH + "px";
  panel.innerHTML = `
    <div class="sftp-header">
      <div class="sftp-title">${ICONS.fileManager} ${escapeHtml(session.name)}</div>
      <button class="sftp-close">${ICONS.close}</button>
    </div>
    <div class="sftp-connecting">
      <div class="sftp-spinner"></div>
      <span>연결 중...</span>
    </div>
  `;
  document.body.appendChild(panel);

  const headerEl = panel.querySelector(".sftp-header") as HTMLElement;
  makeDraggableResizable(panel, headerEl);
  bringToFront(panel);

  let unlistenProgress: (() => void) | null = null;
  let unlistenDrop: (() => void) | null = null;

  const closePanel = async () => {
    try { await invoke("sftp_disconnect", { sessionId }); } catch {}
    if (unlistenProgress) unlistenProgress();
    if (unlistenDrop) unlistenDrop();
    panel.remove();
  };
  panel.querySelector(".sftp-close")!.addEventListener("click", closePanel);

  // Progress tracking
  const transfers = new Map<string, { bytes: number; total: number; direction: string }>();

  const updateProgressUI = () => {
    const area = panel.querySelector(".sftp-progress-area");
    if (!area) return;
    if (transfers.size === 0) { area.innerHTML = ""; return; }
    area.innerHTML = Array.from(transfers.entries()).map(([filename, t]) => {
      const pct = t.total > 0 ? Math.round(t.bytes / t.total * 100) : 0;
      return `
        <div class="sftp-progress-item">
          <span class="sftp-progress-name">${t.direction === "upload" ? ICONS.upload : ICONS.download} ${escapeHtml(filename)}</span>
          <div class="sftp-progress-bar"><div class="sftp-progress-fill" style="width:${pct}%"></div></div>
          <span class="sftp-progress-pct">${pct}%</span>
        </div>
      `;
    }).join("");
  };

  unlistenProgress = await listen<SftpProgress>("sftp-progress", (event) => {
    const p = event.payload;
    if (p.session_id !== sessionId) return;
    transfers.set(p.filename, { bytes: p.bytes_transferred, total: p.total_bytes, direction: p.direction });
    updateProgressUI();
    if (p.bytes_transferred >= p.total_bytes) {
      setTimeout(() => { transfers.delete(p.filename); updateProgressUI(); }, 1500);
    }
  });

  // Connect
  let currentDir: string;
  try {
    currentDir = await invoke<string>("sftp_connect", { sessionId });
  } catch (e) {
    panel.querySelector(".sftp-connecting")!.innerHTML = `<div class="sftp-error">연결 실패: ${e}</div>`;
    return;
  }

  const homeDir = currentDir;
  let sftpSortMode = "type";

  const renderBrowser = () => {
    const connecting = panel.querySelector(".sftp-connecting");
    if (connecting) connecting.remove();

    let existing = panel.querySelector(".sftp-body");
    if (!existing) {
      existing = document.createElement("div");
      existing.className = "sftp-body";
      panel.appendChild(existing);
    }

    existing.innerHTML = `
      <div class="sftp-toolbar">
        <div class="sftp-breadcrumb"></div>
        <div class="sftp-actions">
          <button class="btn-action btn-sftp sftp-dl-selected-btn" style="display:none">${ICONS.download} 다운로드</button>
          <button class="btn-action btn-sftp sftp-upload-btn">${ICONS.upload} 업로드</button>
          <button class="btn-action btn-sftp sftp-mkdir-btn">${ICONS.folderPlus} 폴더</button>
          <select class="sftp-sort-select" title="정렬">
            <option value="type">폴더순</option>
            <option value="name">이름순</option>
            <option value="modified">최근 수정순</option>
            <option value="modified-asc">오래된순</option>
            <option value="size">크기순</option>
          </select>
          <button class="btn-ghost sftp-refresh-btn" title="새로고침">${ICONS.refresh}</button>
        </div>
      </div>
      <div class="sftp-file-list">
        <div class="sftp-loading"><div class="sftp-spinner"></div></div>
      </div>
      <div class="sftp-drop-zone">파일을 여기에 드래그하여 업로드</div>
      <div class="sftp-progress-area"></div>
    `;

    const sortSelect = panel.querySelector(".sftp-sort-select") as HTMLSelectElement;
    sortSelect.value = sftpSortMode;
    sortSelect.addEventListener("change", () => { sftpSortMode = sortSelect.value; loadDir(currentDir); });

    panel.querySelector(".sftp-dl-selected-btn")!.addEventListener("click", async () => {
      const checked = panel.querySelectorAll(".sftp-check:checked") as NodeListOf<HTMLInputElement>;
      if (checked.length === 0) return;
      const localDir = await open({ directory: true, title: "저장할 폴더 선택" });
      if (!localDir) return;
      for (const cb of checked) {
        const remotePath = cb.dataset.sftpPath!;
        const name = cb.dataset.sftpName!;
        const localPath = (localDir as string).replace(/[/\\]$/, "") + "/" + name;
        try { await invoke("sftp_download", { sessionId, remotePath, localPath }); }
        catch (e) { customAlert("다운로드 실패: " + name + " - " + e); }
      }
      loadDir(currentDir);
    });

    panel.querySelector(".sftp-upload-btn")!.addEventListener("click", async () => {
      const path = await open({ multiple: true });
      if (!path) return;
      const paths = Array.isArray(path) ? path : [path];
      for (const p of paths) {
        try {
          await invoke("sftp_upload", { sessionId, remoteDir: currentDir, localPath: p });
        } catch (e) { customAlert("업로드 실패: " + e); }
      }
      loadDir(currentDir);
    });

    panel.querySelector(".sftp-mkdir-btn")!.addEventListener("click", async () => {
      const name = await customPrompt("폴더 이름:");
      if (!name) return;
      try {
        await invoke("sftp_mkdir", { sessionId, path: currentDir + "/" + name });
        loadDir(currentDir);
      } catch (e) { customAlert("폴더 생성 실패: " + e); }
    });

    panel.querySelector(".sftp-refresh-btn")!.addEventListener("click", () => loadDir(currentDir));
  };

  const sftpTabComplete = async (value: string): Promise<TabResult> => {
    let parentDir: string;
    let partial: string;
    if (value.endsWith("/")) {
      // "/home/ec2-user/" -> list contents of /home/ec2-user
      parentDir = value.replace(/\/+$/, "") || "/";
      partial = "";
    } else {
      // "/home/ec2-u" -> list /home, filter by "ec2-u"
      const lastSlash = value.lastIndexOf("/");
      parentDir = lastSlash === 0 ? "/" : value.substring(0, lastSlash) || "/";
      partial = value.substring(lastSlash + 1);
    }
    try {
      const entries = await invoke<RemoteEntry[]>("sftp_list_dir", { sessionId, path: parentDir });
      const dirs = entries.filter(e => e.is_dir && e.name.startsWith(partial));
      if (dirs.length === 0) return { completed: null };
      const prefix = parentDir === "/" ? "/" : parentDir + "/";
      if (dirs.length === 1) return { completed: prefix + dirs[0].name + "/" };
      // Find common prefix
      let common = dirs[0].name;
      for (let i = 1; i < dirs.length; i++) {
        let j = 0;
        while (j < common.length && j < dirs[i].name.length && common[j] === dirs[i].name[j]) j++;
        common = common.substring(0, j);
      }
      const completed = common.length > partial.length ? prefix + common : null;
      return { completed, candidates: dirs.map(d => d.name) };
    } catch { return { completed: null }; }
  };

  const showBcDropdown = async (segmentEl: HTMLElement, dirPath: string) => {
    // Remove any existing dropdown
    document.querySelectorAll(".sftp-bc-dropdown").forEach(d => d.remove());

    const dropdown = document.createElement("div");
    dropdown.className = "sftp-bc-dropdown";
    dropdown.innerHTML = `<div class="sftp-bc-dropdown-loading">불러오는 중...</div>`;
    document.body.appendChild(dropdown);

    // Position below the breadcrumb segment
    const rect = segmentEl.getBoundingClientRect();
    dropdown.style.left = rect.left + "px";
    dropdown.style.top = (rect.bottom + 4) + "px";

    // Close on outside click
    const closeDropdown = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener("mousedown", closeDropdown);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", closeDropdown), 0);

    try {
      const entries = await invoke<RemoteEntry[]>("sftp_list_dir", { sessionId, path: dirPath });
      const dirs = entries.filter(e => e.is_dir);
      if (dirs.length === 0) {
        dropdown.innerHTML = `<div class="sftp-bc-dropdown-empty">하위 폴더 없음</div>`;
        return;
      }
      dropdown.innerHTML = dirs.map(d =>
        `<div class="sftp-bc-dropdown-item" data-path="${escapeHtml(d.path)}">${ICONS.folderOpen} ${escapeHtml(d.name)}</div>`
      ).join("");
      dropdown.querySelectorAll(".sftp-bc-dropdown-item").forEach(item => {
        item.addEventListener("click", () => {
          dropdown.remove();
          document.removeEventListener("mousedown", closeDropdown);
          loadDir((item as HTMLElement).dataset.path!);
        });
      });
    } catch {
      dropdown.innerHTML = `<div class="sftp-bc-dropdown-empty">로드 실패</div>`;
    }
  };

  const renderBreadcrumb = () => {
    const bc = panel.querySelector(".sftp-breadcrumb")!;
    const parts = currentDir.split("/").filter(Boolean);
    let html = "";
    let path = "";
    for (let i = 0; i < parts.length; i++) {
      path += "/" + parts[i];
      if (i > 0) html += `<span class="sftp-bc-sep">/</span>`;
      html += `<span class="sftp-bc-item" data-path="${path}">${escapeHtml(parts[i])}</span>`;
    }
    html += `<button class="sftp-bc-goto" title="경로 직접 입력">${ICONS.edit}</button>`;
    bc.innerHTML = html;
    bc.querySelectorAll(".sftp-bc-item").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const segPath = (el as HTMLElement).dataset.path!;
        showBcDropdown(el as HTMLElement, segPath);
      });
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        loadDir((el as HTMLElement).dataset.path!);
      });
    });
    bc.querySelector(".sftp-bc-goto")!.addEventListener("click", async () => {
      const target = await customPrompt("이동할 경로:", currentDir, { onTab: sftpTabComplete });
      if (target) loadDir(target);
    });
  };

  const loadDir = async (path: string) => {
    const fileList = panel.querySelector(".sftp-file-list")!;
    fileList.innerHTML = `<div class="sftp-loading"><div class="sftp-spinner"></div></div>`;
    currentDir = path;
    renderBreadcrumb();

    try {
      const entries = await invoke<RemoteEntry[]>("sftp_list_dir", { sessionId, path });

      // Sort
      entries.sort((a, b) => {
        if (sftpSortMode === "type") return b.is_dir === a.is_dir ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : b.is_dir ? 1 : -1;
        if (sftpSortMode === "name") return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        if (sftpSortMode === "modified") return b.modified - a.modified;
        if (sftpSortMode === "modified-asc") return a.modified - b.modified;
        if (sftpSortMode === "size") return b.size - a.size;
        return 0;
      });

      let html = "";

      if (path !== "/") {
        const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
        html += `
          <div class="sftp-row sftp-row-dir" data-sftp-path="${parent}" data-sftp-dir="true">
            <div class="sftp-row-check"></div>
            <div class="sftp-row-icon">${ICONS.arrowUp}</div>
            <div class="sftp-row-name">..</div>
            <div class="sftp-row-size"></div>
            <div class="sftp-row-date"></div>
            <div class="sftp-row-perm"></div>
            <div class="sftp-row-actions"></div>
          </div>
        `;
      }

      for (const entry of entries) {
        const icon = entry.is_dir ? ICONS.folderOpen : ICONS.file;
        html += `
          <div class="sftp-row ${entry.is_dir ? "sftp-row-dir" : "sftp-row-file"}" data-sftp-path="${escapeHtml(entry.path)}" data-sftp-dir="${entry.is_dir}">
            <div class="sftp-row-check">${!entry.is_dir ? `<input type="checkbox" class="sftp-check" data-sftp-path="${escapeHtml(entry.path)}" data-sftp-name="${escapeHtml(entry.name)}" />` : ""}</div>
            <div class="sftp-row-icon">${icon}</div>
            <div class="sftp-row-name">${escapeHtml(entry.name)}</div>
            <div class="sftp-row-size">${entry.is_dir ? "-" : humanizeSize(entry.size)}</div>
            <div class="sftp-row-date">${formatDate(entry.modified)}</div>
            <div class="sftp-row-perm">${entry.permissions}</div>
            <div class="sftp-row-actions">
              ${!entry.is_dir ? `<button class="btn-sm btn-sftp-dl" data-sftp-action="download" data-sftp-path="${escapeHtml(entry.path)}" data-sftp-name="${escapeHtml(entry.name)}" title="다운로드">${ICONS.download}</button>` : ""}
              <button class="btn-sm btn-delete-sm" data-sftp-action="delete" data-sftp-path="${escapeHtml(entry.path)}" data-sftp-isdir="${entry.is_dir}" title="삭제">${ICONS.trash}</button>
            </div>
          </div>
        `;
      }

      if (entries.length === 0) {
        html += `<div class="sftp-empty">빈 디렉토리</div>`;
      }

      fileList.innerHTML = html;

      // Checkbox -> show/hide multi-download button
      const dlBtn = panel.querySelector(".sftp-dl-selected-btn") as HTMLElement;
      fileList.querySelectorAll(".sftp-check").forEach(cb => {
        cb.addEventListener("change", () => {
          const anyChecked = panel.querySelectorAll(".sftp-check:checked").length > 0;
          dlBtn.style.display = anyChecked ? "" : "none";
        });
      });

      fileList.querySelectorAll(".sftp-row").forEach(row => {
        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("[data-sftp-action]")) return;
          if ((e.target as HTMLElement).closest(".sftp-check")) return;
          const el = row as HTMLElement;
          if (el.dataset.sftpDir === "true") {
            loadDir(el.dataset.sftpPath!);
          } else {
            // Toggle checkbox for file rows
            const cb = el.querySelector(".sftp-check") as HTMLInputElement | null;
            if (cb) {
              cb.checked = !cb.checked;
              cb.dispatchEvent(new Event("change"));
            }
          }
        });
      });

      fileList.querySelectorAll("[data-sftp-action]").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const el = btn as HTMLElement;
          const action = el.dataset.sftpAction;
          if (action === "download") {
            const remotePath = el.dataset.sftpPath!;
            const name = el.dataset.sftpName!;
            const localPath = await save({ defaultPath: name });
            if (!localPath) return;
            try { await invoke("sftp_download", { sessionId, remotePath, localPath }); }
            catch (e) { customAlert("다운로드 실패: " + e); }
          } else if (action === "delete") {
            const remotePath = el.dataset.sftpPath!;
            const isDir = el.dataset.sftpIsdir === "true";
            const ok = await customConfirm(`삭제할까요?\n${remotePath}`, "삭제");
            if (!ok) return;
            try { await invoke("sftp_delete", { sessionId, path: remotePath, isDir }); loadDir(currentDir); }
            catch (e) { customAlert("삭제 실패: " + e); }
          }
        });
      });
    } catch (e) {
      fileList.innerHTML = `<div class="sftp-error">디렉토리 로드 실패: ${e}</div>`;
    }
  };

  // Drag & drop
  unlistenDrop = await listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
    if (!document.body.contains(panel)) return;
    const paths = event.payload.paths;
    if (!paths || paths.length === 0) return;
    for (const p of paths) {
      try { await invoke("sftp_upload", { sessionId, remoteDir: currentDir, localPath: p }); }
      catch (e) { customAlert("업로드 실패: " + e); }
    }
    loadDir(currentDir);
  });

  listen("tauri://drag-enter", () => {
    const zone = panel.querySelector(".sftp-drop-zone");
    if (zone) zone.classList.add("sftp-drop-active");
  });
  listen("tauri://drag-leave", () => {
    const zone = panel.querySelector(".sftp-drop-zone");
    if (zone) zone.classList.remove("sftp-drop-active");
  });
  listen("tauri://drag-drop", () => {
    const zone = panel.querySelector(".sftp-drop-zone");
    if (zone) zone.classList.remove("sftp-drop-active");
  });

  renderBrowser();
  loadDir(initialDir || currentDir);
}

// --- Render ---

function renderStats() {
  const el = document.getElementById("stats");
  if (!el) return;
  el.textContent = `${data.folders.length}개 폴더 / ${data.sessions.length}개 세션`;
}

function renderSessionRow(s: SshSession): string {
  const jumpTitle = s.jump_host ? `via ${s.jump_host.host}` : "";
  const jumpBadge = s.jump_host ? `<span class="row-meta-ic row-meta-jump" title="${escapeHtml(jumpTitle)}">${ICONS.jump}</span>` : "";

  return `
    <div class="tree-session" data-session-id="${s.id}">
      <div class="drag-handle">${ICONS.drag}</div>
      <div class="row-icon">${ICONS.server}</div>
      <div class="row-body">
        <div class="row-title-line">
          <span class="row-name">${escapeHtml(s.name)}</span>
          ${jumpBadge}
        </div>
        <div class="row-connection">${escapeHtml(s.user)}@${escapeHtml(s.host)}:${s.port}</div>
      </div>
    </div>
  `;
}

function renderTree() {
  const container = document.getElementById("content-area");
  if (!container) return;

  if (data.sessions.length === 0) {
    container.innerHTML = '<div class="empty">세션을 추가해주세요</div>';
    return;
  }

  const folders = getSortedFolders();
  const rootSessions = getSessionsForFolder(null);
  const showRootFolder = rootSessions.length > 0 && folders.length > 0;
  let html = "";

  // Build ordered list: real folders + __root__ (if applicable)
  const rootOrder = data.root_folder_order ?? folders.length;
  type FolderEntry = { type: "folder"; folder: Folder } | { type: "root" };
  const entries: FolderEntry[] = folders.map((f) => ({ type: "folder" as const, folder: f }));
  if (showRootFolder) {
    entries.push({ type: "root" as const });
  }
  entries.sort((a, b) => {
    const oa = a.type === "root" ? rootOrder : a.folder.order;
    const ob = b.type === "root" ? rootOrder : b.folder.order;
    return oa - ob;
  });

  for (const entry of entries) {
    if (entry.type === "root") {
      html += `
        <div class="tree-folder" data-folder-id="__root__">
          <div class="tree-folder-header tree-folder-root" data-folder-toggle="__root__">
            <div class="drag-handle">${ICONS.drag}</div>
            <span class="folder-chevron">${collapsedFolders.has("__root__") ? ICONS.chevronRight : ICONS.chevronDown}</span>
            <span class="folder-name folder-name-dim">미분류</span>
            <span class="folder-count">(${rootSessions.length})</span>
            <div class="folder-actions">
              <button class="btn-sm btn-add-in-folder" data-action="add-in-folder" data-folder-id="" title="세션 추가">${ICONS.plus}</button>
            </div>
          </div>
          ${collapsedFolders.has("__root__") ? "" : `<div class="tree-children">${rootSessions.map(renderSessionRow).join("")}</div>`}
        </div>
      `;
      continue;
    }
    const folder = entry.folder;
    if (!hasMatchingSessionsInFolder(folder.id)) continue;
    const sessions = getSessionsForFolder(folder.id);
    const isCollapsed = collapsedFolders.has(folder.id);
    const chevron = isCollapsed ? ICONS.chevronRight : ICONS.chevronDown;

    html += `
      <div class="tree-folder" data-folder-id="${folder.id}">
        <div class="tree-folder-header" data-folder-toggle="${folder.id}">
          <div class="drag-handle">${ICONS.drag}</div>
          <span class="folder-chevron">${chevron}</span>
          <span class="folder-icon">${ICONS.folder}</span>
          <span class="folder-name">${escapeHtml(folder.name)}</span>
          <span class="folder-count">(${sessions.length})</span>
          <div class="folder-actions">
            <button class="btn-sm btn-add-in-folder" data-action="add-in-folder" data-folder-id="${folder.id}" title="세션 추가">${ICONS.plus}</button>
            <button class="btn-sm btn-edit-sm" data-action="edit-folder" data-folder-id="${folder.id}" title="폴더 편집">${ICONS.edit}</button>
          </div>
        </div>
        ${isCollapsed ? "" : `<div class="tree-children">${sessions.map(renderSessionRow).join("")}</div>`}
      </div>
    `;
  }

  if (rootSessions.length > 0 && folders.length === 0) {
    html += rootSessions.map(renderSessionRow).join("");
  }

  if (!html) { container.innerHTML = '<div class="empty">검색 결과가 없습니다</div>'; return; }
  container.innerHTML = html;
}

function renderShell() {
  const app = document.getElementById("app")!;
  const savedWidth = parseInt(localStorage.getItem("sidebar-w") || "280");
  const sidebarWidth = Math.max(220, Math.min(500, savedWidth));

  app.innerHTML = `
    <div id="app-layout">
      <aside id="sidebar" style="width: ${sidebarWidth}px">
        <div class="sidebar-top">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input type="text" id="search" placeholder="검색..." />
          </div>
          <button class="btn-ghost-sm" id="sidebar-hide-btn" title="사이드바 숨기기">${ICONS.chevronLeft}</button>
        </div>
        <div id="content-area" class="tree-list"></div>
        <div class="sidebar-bottom">
          <div class="sidebar-actions">
            <button class="btn-secondary-sm" id="add-session-btn">${ICONS.plus}<span>세션</span></button>
            <button class="btn-secondary-sm" id="add-folder-btn">${ICONS.folder}<span>폴더</span></button>
            <div class="sidebar-actions-spacer"></div>
            <label class="toggle-global-nw" title="연결 시 기본적으로 새 창에서 열기">
              <input type="checkbox" id="global-newwin" />
              <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
              <span class="toggle-label-text">새 창</span>
            </label>
            <button class="btn-ghost-sm" id="settings-btn" title="설정">${ICONS.settings}</button>
            <button class="btn-ghost-sm" id="refresh-btn" title="새로고침">${ICONS.refresh}</button>
          </div>
          <div class="stats" id="stats"></div>
        </div>
      </aside>
      <div id="sidebar-resizer"></div>
      <div id="terminal-area">
        <div id="tabs"></div>
        <div id="terminals">
          <div id="welcome-screen" class="welcome-screen">
            <h1>서버에 연결하세요</h1>
            <p>사이드바에서 세션을 <b>더블클릭</b>하여 연결하거나,<br>왼쪽 아래 <b>+ 세션</b> 버튼으로 새 서버를 추가하세요.</p>
          </div>
        </div>
      </div>
    </div>
    <button class="sidebar-edge-trigger" id="sidebar-edge-trigger" title="사이드바 열기">${ICONS.chevronRight}</button>
  `;

  applySidebarState();

  const tabsElForObs = document.getElementById("tabs")!;
  const welcomeObs = new MutationObserver(() => {
    const welcome = document.getElementById("welcome-screen");
    if (!welcome) return;
    welcome.style.display = tabsElForObs.children.length > 0 ? "none" : "";
  });
  welcomeObs.observe(tabsElForObs, { childList: true });

  initSidebarResizer();

  const searchInput = document.getElementById("search") as HTMLInputElement;
  searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderTree(); });

  document.getElementById("sidebar-hide-btn")!.addEventListener("click", toggleSidebarHidden);
  document.getElementById("sidebar-edge-trigger")!.addEventListener("click", toggleSidebarHidden);

  document.getElementById("add-session-btn")!.addEventListener("click", () => openModal());
  document.getElementById("add-folder-btn")!.addEventListener("click", addFolder);
  document.getElementById("settings-btn")!.addEventListener("click", () => void openSettings());
  document.getElementById("refresh-btn")!.addEventListener("click", loadData);

  (document.getElementById("global-newwin") as HTMLInputElement).addEventListener("change", (e) => {
    globalNewWindow = (e.target as HTMLInputElement).checked;
  });

  // Event delegation
  const contentArea = document.getElementById("content-area")!;

  contentArea.addEventListener("click", async (e) => {
    if (dndJustFinished) return;

    const folderHeader = (e.target as HTMLElement).closest("[data-folder-toggle]") as HTMLElement | null;
    if (folderHeader && !(e.target as HTMLElement).closest("[data-action]") && !(e.target as HTMLElement).closest(".drag-handle")) {
      const fId = folderHeader.dataset.folderToggle!;
      if (collapsedFolders.has(fId)) collapsedFolders.delete(fId); else collapsedFolders.add(fId);
      saveCollapsedFolders();
      renderTree();
      return;
    }

    const actionEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!actionEl) return;
    e.stopPropagation();

    const action = actionEl.dataset.action;
    if (action === "edit-folder") {
      editFolder(actionEl.dataset.folderId!);
    } else if (action === "add-in-folder") {
      openModal(undefined, actionEl.dataset.folderId!);
    }
  });

  // Double-click to connect
  contentArea.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("[data-action]")) return;
    if ((e.target as HTMLElement).closest(".drag-handle")) return;
    const row = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
    if (!row) return;
    connectSession(row.dataset.sessionId!, globalNewWindow);
  });

  // Right-click context menu
  contentArea.addEventListener("contextmenu", (e) => {
    const sessionEl = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
    if (sessionEl) {
      e.preventDefault();
      const sid = sessionEl.dataset.sessionId!;
      const s = data.sessions.find((x) => x.id === sid);
      if (!s) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: "연결", icon: ICONS.terminal, action: () => connectSession(sid, globalNewWindow) },
        { label: "새 창에서 연결", icon: ICONS.newWindow, action: () => connectSession(sid, true) },
        { label: "SFTP 열기", icon: ICONS.fileManager, action: () => openSftpPanel(sid) },
        { label: "-", action: () => {} },
        { label: "편집", icon: ICONS.edit, action: () => openModal(s) },
        { label: "복사", icon: ICONS.copy, action: async () => {
          try {
            data = await invoke<SessionsData>("copy_session", { id: sid });
            renderTree(); renderStats();
          } catch (err) { customAlert("복사 실패: " + err); }
        }},
        { label: "-", action: () => {} },
        { label: "삭제", icon: ICONS.trash, action: () => deleteSession(sid), danger: true },
      ]);
      return;
    }
    const folderEl = (e.target as HTMLElement).closest("[data-folder-id]") as HTMLElement | null;
    if (folderEl && folderEl.dataset.folderId !== "__root__") {
      e.preventDefault();
      const fid = folderEl.dataset.folderId!;
      showContextMenu(e.clientX, e.clientY, [
        { label: "세션 추가", icon: ICONS.plus, action: () => openModal(undefined, fid) },
        { label: "폴더 편집", icon: ICONS.edit, action: () => editFolder(fid) },
        { label: "-", action: () => {} },
        { label: "폴더 삭제", icon: ICONS.trash, action: () => deleteFolder(fid), danger: true },
      ]);
    }
  });

  initDnD();
  renderTree();
}

if (!IS_TERMINAL_WINDOW) {
  (async () => {
    // Pre-apply saved theme before first paint to avoid default→saved flash.
    try {
      const savedTheme = await invoke<string | null>("get_terminal_theme");
      if (savedTheme) applyUiTheme(getTheme(savedTheme).ui);
    } catch {}
    renderShell();
    // Reveal window (tauri.conf.json visible:false → window-state plugin
    // restored size silently; showing here = no flash).
    try { await getCurrentWindow().show(); } catch {}
    await loadData();
    // Load terminal module after the DOM is ready so it can mount
    // into #tabs / #terminals created by renderShell.
    await import("./terminal");
  })();
}
