import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { getTheme, getFontValue, withKoreanFallback, type TerminalTheme } from "../../themes";

// ---------- Constants ----------
export const MAX_PANES_PER_TAB = 3;
export const FONT_MIN = 8;
export const FONT_MAX = 28;
export const FONT_DEFAULT = 13;

// ---------- Data shapes (reactive — kept free of DOM/xterm refs) ----------
export interface PaneData {
  id: string;          // = terminal_id (Rust PTY)
  baseTitle: string;
  title: string;
  sshArgs: string[];
  sessionId: string | null;
  cwd: string | null;
  fontSize: number;
  exited: boolean;
}

export interface TabData {
  id: string;
  panes: PaneData[];
  ratios: number[];
  focusedPaneId: string;
  zoomedPaneId: string | null;
  broadcast: boolean;
}

// ---------- Reactive state ----------
const _state = $state<{
  tabs: TabData[];
  activeTabId: string | null;
}>({
  tabs: [],
  activeTabId: null,
});

export const terminalStore = {
  get tabs(): TabData[] { return _state.tabs; },
  get activeTabId(): string | null { return _state.activeTabId; },
  get activeTab(): TabData | null {
    return _state.activeTabId ? _state.tabs.find(t => t.id === _state.activeTabId) ?? null : null;
  },
};

// ---------- Active theme/font (module-level, non-reactive) ----------
// Hot-swapped via terminal-theme-changed / terminal-font-changed events.
// Pane.svelte reads these at create time; live xterm instances are updated
// imperatively by walking the xterm registry.
let _currentTheme: TerminalTheme = getTheme(null);
let _currentFontFamily: string = getFontValue(null);
export function getCurrentTheme(): TerminalTheme { return _currentTheme; }
// 터미널에 먹일 최종 스택. 한글 폴백은 여기서 한 번만 붙인다 —
// 이 값을 읽는 곳(Pane 생성, applyFontToAllPanes)이 곧 xterm에 넣는 곳이다.
export function getCurrentFontFamily(): string { return withKoreanFallback(_currentFontFamily); }
export function setCurrentTheme(t: TerminalTheme): void { _currentTheme = t; }
export function setCurrentFontFamily(f: string): void { _currentFontFamily = f; }

// ---------- Xterm registry (reactive 영역 밖) ----------
export interface XtermBundle {
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
}
const xterms = new Map<string, XtermBundle>();
export function registerXterm(paneId: string, b: XtermBundle): void { xterms.set(paneId, b); }
export function getXterm(paneId: string): XtermBundle | undefined { return xterms.get(paneId); }
export function unregisterXterm(paneId: string): void { xterms.delete(paneId); }

// ---------- Adopted content (cross-tab move scrollback rescue) ----------
// When a pane is moved between tabs, Svelte unmount/remount the Pane
// component and the xterm is recreated. We capture serialize() output before
// the move and replay it in the new xterm's onMount so scrollback survives.
const adoptedContent = new Map<string, string>();
export function setAdoptedContent(paneId: string, content: string): void {
  adoptedContent.set(paneId, content);
}
export function takeAdoptedContent(paneId: string): string | null {
  const c = adoptedContent.get(paneId);
  adoptedContent.delete(paneId);
  return c ?? null;
}

// ---------- Pending PTY output (race buffer) ----------
const pendingOutput = new Map<string, Uint8Array[]>();
export function bufferPendingOutput(paneId: string, data: Uint8Array): void {
  const q = pendingOutput.get(paneId) ?? [];
  q.push(data);
  pendingOutput.set(paneId, q);
}
export function takePendingOutput(paneId: string): Uint8Array[] {
  const q = pendingOutput.get(paneId) ?? [];
  pendingOutput.delete(paneId);
  return q;
}

// ---------- Session SFTP-home cache (used to resolve "~" in OSC titles) ----------
const sessionHomeCache = new Map<string, string>();
const sessionHomeInflight = new Set<string>();
export function getSessionHome(sessionId: string): string | undefined {
  return sessionHomeCache.get(sessionId);
}
export function setSessionHome(sessionId: string, home: string): void {
  sessionHomeCache.set(sessionId, home);
}
export function isSessionHomeInflight(sessionId: string): boolean {
  return sessionHomeInflight.has(sessionId);
}
export function markSessionHomeInflight(sessionId: string): void {
  sessionHomeInflight.add(sessionId);
}
export function clearSessionHomeInflight(sessionId: string): void {
  sessionHomeInflight.delete(sessionId);
}

// Convenience: scan active panes for an open SFTP cwd for the given session.
// Used by sidebar context menu ("open SFTP at terminal cwd").
export function findCwdForSession(sessionId: string): string | null {
  for (const t of _state.tabs) {
    for (const p of t.panes) {
      if (p.sessionId === sessionId && p.cwd) return p.cwd;
    }
  }
  return null;
}

// ---------- Lookups ----------
export function findTab(tabId: string): TabData | null {
  return _state.tabs.find(t => t.id === tabId) ?? null;
}
export function findPane(paneId: string): { tab: TabData; pane: PaneData; index: number } | null {
  for (const t of _state.tabs) {
    const idx = t.panes.findIndex(p => p.id === paneId);
    if (idx >= 0) return { tab: t, pane: t.panes[idx], index: idx };
  }
  return null;
}
export function getActivePane(): { tab: TabData; pane: PaneData } | null {
  const tab = terminalStore.activeTab;
  if (!tab) return null;
  const pane = tab.panes.find(p => p.id === tab.focusedPaneId) ?? tab.panes[0];
  return pane ? { tab, pane } : null;
}

// ---------- Mutators ----------
export function addTab(tab: TabData): void {
  _state.tabs.push(tab);
}
export function removeTab(tabId: string): TabData | null {
  const idx = _state.tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return null;
  const [removed] = _state.tabs.splice(idx, 1);
  if (_state.activeTabId === tabId) {
    _state.activeTabId = _state.tabs[0]?.id ?? null;
  }
  return removed;
}
export function setActiveTab(tabId: string | null): void {
  _state.activeTabId = tabId;
}
export function setFocusedPane(tabId: string, paneId: string): void {
  const t = findTab(tabId);
  if (t) t.focusedPaneId = paneId;
}
export function setZoomedPane(tabId: string, paneId: string | null): void {
  const t = findTab(tabId);
  if (t) t.zoomedPaneId = paneId;
}
export function setBroadcast(tabId: string, on: boolean): void {
  const t = findTab(tabId);
  if (t) t.broadcast = on;
}
export function setPaneTitle(paneId: string, title: string): void {
  const r = findPane(paneId);
  if (r) r.pane.title = title;
}
export function setPaneCwd(paneId: string, cwd: string): void {
  const r = findPane(paneId);
  if (r) r.pane.cwd = cwd;
}
export function setPaneExited(paneId: string, exited: boolean): void {
  const r = findPane(paneId);
  if (r) r.pane.exited = exited;
}
export function setPaneFontSize(paneId: string, size: number): void {
  const r = findPane(paneId);
  if (r) r.pane.fontSize = size;
}
export function setRatios(tabId: string, ratios: number[]): void {
  const t = findTab(tabId);
  if (t) t.ratios = ratios;
}

export function normalizeRatios(tab: TabData): void {
  const sum = tab.ratios.reduce((a, b) => a + b, 0);
  if (sum > 0) tab.ratios = tab.ratios.map(r => r / sum);
  else tab.ratios = tab.panes.map(() => 1 / tab.panes.length);
}

export function insertPaneAt(tabId: string, index: number, pane: PaneData, ratio: number): void {
  const t = findTab(tabId);
  if (!t) return;
  t.panes.splice(index, 0, pane);
  t.ratios.splice(index, 0, ratio);
}

export function removePaneFromTab(tabId: string, paneId: string): { pane: PaneData; index: number } | null {
  const t = findTab(tabId);
  if (!t) return null;
  const idx = t.panes.findIndex(p => p.id === paneId);
  if (idx < 0) return null;
  const [pane] = t.panes.splice(idx, 1);
  t.ratios.splice(idx, 1);
  return { pane, index: idx };
}

export function reorderTab(srcId: string, dstId: string, before: boolean): void {
  const srcIdx = _state.tabs.findIndex(t => t.id === srcId);
  if (srcIdx < 0) return;
  const [src] = _state.tabs.splice(srcIdx, 1);
  let dstIdx = _state.tabs.findIndex(t => t.id === dstId);
  if (dstIdx < 0) {
    _state.tabs.push(src);
    return;
  }
  if (!before) dstIdx += 1;
  _state.tabs.splice(dstIdx, 0, src);
}

export function moveTabToEnd(srcId: string): void {
  const srcIdx = _state.tabs.findIndex(t => t.id === srcId);
  if (srcIdx < 0) return;
  const [src] = _state.tabs.splice(srcIdx, 1);
  _state.tabs.push(src);
}

export function reorderPaneInTab(tabId: string, fromIdx: number, toIdx: number): void {
  const t = findTab(tabId);
  if (!t) return;
  const [pane] = t.panes.splice(fromIdx, 1);
  const [ratio] = t.ratios.splice(fromIdx, 1);
  t.panes.splice(toIdx, 0, pane);
  t.ratios.splice(toIdx, 0, ratio);
}

export function clearBroadcastIfSinglePane(tab: TabData): void {
  if (tab.broadcast && tab.panes.length < 2) {
    tab.broadcast = false;
  }
}

// ---------- Title helpers ----------
export function chooseUniqueTitle(base: string): string {
  const taken = new Set<string>();
  for (const t of _state.tabs) for (const p of t.panes) taken.add(p.title);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base} (${n})`;
    if (!taken.has(c)) return c;
  }
  return base;
}

export function stripSuffix(s: string): string {
  return s.replace(/ \(\d+\)$/, "");
}

// Backend emits "__UNCATEGORIZED__:host" placeholder when a session has no
// folder (it can't know the user's language). Caller swaps for the localized
// prefix via the t() function passed in.
export function resolveTitle(s: string, uncategorizedPrefix: string): string {
  return s.replace(/^__UNCATEGORIZED__:/, uncategorizedPrefix + ":");
}

// ---------- ID generator ----------
export function uid(): string {
  return "x-" + Math.random().toString(36).slice(2, 10);
}
