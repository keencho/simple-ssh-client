import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import "./fonts.css";
import { getTheme, applyUiTheme, getFontValue, type TerminalTheme } from "./themes";

// ---------- Window label detection ----------
const myLabel = getCurrentWindow().label;
const isMainWindow = !myLabel.startsWith("term-");
const scoped = { target: { kind: "AnyLabel" as const, label: myLabel } };

// ---------- Body setup ----------
// In the main window, the sidebar + terminal area layout already created
// #tabs and #terminals (via renderShell in main.ts). In a term-* window,
// we own the whole body and create them ourselves.
let tabsEl: HTMLElement;
let termsEl: HTMLElement;
if (isMainWindow) {
  const t = document.getElementById("tabs");
  const ts = document.getElementById("terminals");
  if (!t || !ts) throw new Error("Main window terminal area not found");
  tabsEl = t;
  termsEl = ts;
} else {
  document.body.innerHTML = "";
  tabsEl = document.createElement("div");
  tabsEl.id = "tabs";
  termsEl = document.createElement("div");
  termsEl.id = "terminals";
  document.body.append(tabsEl, termsEl);
  document.body.classList.add("terminal-window");
  document.title = "Terminal";
}

// ---------- Types ----------
interface AddTabPayload {
  terminal_id: string;
  title: string;
  ssh_args: string[];
  session_id?: string | null;
  adopt?: boolean;
  initial_content?: string;
}

interface Pane {
  id: string;          // terminal_id (owns Rust PTY)
  baseTitle: string;
  title: string;
  sshArgs: string[];
  sessionId: string | null;  // sidebar session id (for SFTP-at-cwd lookup)
  cwd: string | null;        // tracked from OSC 7 / window title
  fontSize: number;
  paneEl: HTMLElement;
  headerEl: HTMLElement;
  xtermEl: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  exited: boolean;
}

interface Tab {
  id: string;          // unique tab id
  tabBtnEl: HTMLElement;
  panesWrapEl: HTMLElement;
  panes: Pane[];       // left-to-right
  ratios: number[];    // sum = 1
  focusedPaneId: string;
  zoomedPaneId: string | null;
  broadcast: boolean;
}

interface MergeTabPayload {
  terminal_id: string;
  title: string;
  ssh_args: string[];
  session_id?: string | null;
  initial_content: string;
  screen_x: number;
  screen_y: number;
}

interface PtyOutput { terminal_id: string; data: number[]; }
interface PtyExit { terminal_id: string; }

// ---------- State ----------
const tabs = new Map<string, Tab>();
let activeTabId: string | null = null;
const pendingOutput = new Map<string, Uint8Array[]>();

// Per-session SFTP home dir cache. Populated lazily the first time a pane in
// that session emits a "~" title (we ask Rust to resolve home via SFTP, then
// re-evaluate later titles). Keyed by sidebar session_id.
const sessionHomeCache = new Map<string, string>();
const sessionHomeInflight = new Set<string>();
function triggerHomeFetch(sessionId: string | null | undefined) {
  if (!sessionId || sessionHomeCache.has(sessionId) || sessionHomeInflight.has(sessionId)) return;
  sessionHomeInflight.add(sessionId);
  invoke<string>("get_session_home", { sessionId })
    .then((home) => { if (home) sessionHomeCache.set(sessionId, home); })
    .catch(() => {})
    .finally(() => sessionHomeInflight.delete(sessionId));
}

// Expose a tiny lookup so main.ts (sidebar context menu) can ask:
// "is there an active pane for this session, and if so what's its cwd?"
(window as any).__sshmgr_findCwdForSession = (sid: string): string | null => {
  for (const tab of tabs.values()) {
    for (const p of tab.panes) {
      if (p.sessionId === sid && p.cwd) return p.cwd;
    }
  }
  return null;
};

const MAX_PANES_PER_TAB = 3;
const FONT_MIN = 8;
const FONT_MAX = 28;
const FONT_DEFAULT = 13;

let currentTheme: TerminalTheme = getTheme(null);
applyUiTheme(currentTheme.ui);
let currentFontFamily: string = getFontValue(null);

const CLOSE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const ZOOM_OUT_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 3h6M3 9v6m0-6h6M3 9l6 6m12-6v6m0-6h-6m6 0l-6 6M9 21H3m0 0v-6"/></svg>`;

// ---------- Helpers ----------
function uid() { return "x-" + Math.random().toString(36).slice(2, 10); }

// Clean every transient drag-related class across the document. This is
// called on ANY dragend at capture phase, so even if the original drag source
// was removed from DOM mid-drop (and dragend can't bubble to our handlers),
// we don't leak visual residue (accent lines, drop zones, ghost highlights).
function clearAllDragArtifacts() {
  document.querySelectorAll(
    ".tab-dragging, .tab-drop-before, .tab-drop-after, .tab-pane-drop, " +
    ".drop-zone-left, .drop-zone-right, .pane-dragging, " +
    ".pane-drop-before, .pane-drop-after"
  ).forEach(el => {
    el.classList.remove(
      "tab-dragging", "tab-drop-before", "tab-drop-after", "tab-pane-drop",
      "drop-zone-left", "drop-zone-right", "pane-dragging",
      "pane-drop-before", "pane-drop-after"
    );
  });
  tabsEl.classList.remove("tab-bar-drop-empty");
}

// Global cleanup on dragend AND drop, at capture phase — runs before/regardless
// of any other handler, so we never leak visual residue even when the drag
// source element was removed from DOM mid-drop.
document.addEventListener("dragend", clearAllDragArtifacts, { capture: true });
document.addEventListener("drop", () => {
  // Schedule cleanup after the specific drop handlers finish adjusting DOM
  setTimeout(clearAllDragArtifacts, 0);
}, { capture: true });

function findPane(terminalId: string): { tab: Tab; pane: Pane; index: number } | null {
  for (const tab of tabs.values()) {
    const index = tab.panes.findIndex(p => p.id === terminalId);
    if (index >= 0) return { tab, pane: tab.panes[index], index };
  }
  return null;
}

function getActiveTab(): Tab | null {
  return activeTabId ? tabs.get(activeTabId) ?? null : null;
}

function getActivePane(): { tab: Tab; pane: Pane } | null {
  const tab = getActiveTab();
  if (!tab) return null;
  const pane = tab.panes.find(p => p.id === tab.focusedPaneId) ?? tab.panes[0];
  return pane ? { tab, pane } : null;
}

function stripSuffix(s: string): string { return s.replace(/ \(\d+\)$/, ""); }

function chooseTitle(base: string): string {
  const taken = new Set<string>();
  for (const t of tabs.values()) for (const p of t.panes) taken.add(p.title);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base} (${n})`;
    if (!taken.has(c)) return c;
  }
  return base;
}

function updateWindowTitle() {
  const ap = getActivePane();
  const fallback = isMainWindow ? "Simple SSH Client" : "Terminal";
  void getCurrentWindow().setTitle(ap ? ap.pane.title : fallback);
}

function hidePlaceholder() {
  document.querySelector(".terminal-placeholder")?.remove();
}

function sendResize(pane: Pane) {
  if (pane.exited) return;
  const { rows, cols } = pane.term;
  if (!rows || !cols) return;
  invoke("pty_resize", { terminalId: pane.id, rows, cols }).catch(() => {});
}

function normalizeRatios(tab: Tab) {
  const sum = tab.ratios.reduce((a, b) => a + b, 0);
  if (sum > 0) tab.ratios = tab.ratios.map(r => r / sum);
  else tab.ratios = tab.panes.map(() => 1 / tab.panes.length);
}

// ---------- Theme hot-swap ----------
function applyThemeToAllPanes(t: TerminalTheme) {
  currentTheme = t;
  applyUiTheme(t.ui);
  for (const tab of tabs.values()) {
    for (const pane of tab.panes) {
      pane.term.options.theme = t.xterm;
    }
  }
}

listen<string>("terminal-theme-changed", (event) => {
  applyThemeToAllPanes(getTheme(event.payload));
});

function applyFontToAllPanes(fontFamily: string) {
  currentFontFamily = fontFamily;
  for (const tab of tabs.values()) {
    for (const pane of tab.panes) {
      pane.term.options.fontFamily = fontFamily;
      try { pane.fit.fit(); } catch {}
      sendResize(pane);
    }
  }
}

listen<string>("terminal-font-changed", (event) => {
  applyFontToAllPanes(getFontValue(event.payload));
});

// ---------- PTY output routing ----------
listen<PtyOutput>("pty-output", (event) => {
  const data = new Uint8Array(event.payload.data);
  const r = findPane(event.payload.terminal_id);
  if (r) {
    r.pane.term.write(data);
  } else {
    const q = pendingOutput.get(event.payload.terminal_id) ?? [];
    q.push(data);
    pendingOutput.set(event.payload.terminal_id, q);
  }
});

listen<PtyExit>("pty-exit", (event) => {
  const r = findPane(event.payload.terminal_id);
  if (!r) return;
  r.pane.exited = true;
  r.pane.headerEl.classList.add("pane-exited");
  r.pane.term.writeln("\r\n\x1b[1;33m[세션 종료됨]\x1b[0m");
});

// ---------- Rendering ----------
function renderTabLayout(tab: Tab) {
  const isMulti = tab.panes.length > 1;
  const zoomedId = tab.zoomedPaneId;

  tab.panesWrapEl.classList.toggle("multi", isMulti);
  tab.panesWrapEl.classList.toggle("zoomed", !!zoomedId);
  tab.panesWrapEl.replaceChildren();

  tab.panes.forEach((pane, i) => {
    const hidden = zoomedId !== null && pane.id !== zoomedId;
    pane.paneEl.classList.toggle("pane-hidden", hidden);
    pane.headerEl.classList.toggle("pane-header-visible", isMulti || !!zoomedId);

    if (zoomedId) {
      pane.paneEl.style.flex = hidden ? "0 0 0" : "1 1 0";
    } else {
      pane.paneEl.style.flex = `${tab.ratios[i] ?? 1} 1 0`;
    }
    tab.panesWrapEl.appendChild(pane.paneEl);

    if (!zoomedId && i < tab.panes.length - 1) {
      const div = document.createElement("div");
      div.className = "pane-divider";
      div.dataset.leftIdx = String(i);
      div.dataset.tabId = tab.id;
      tab.panesWrapEl.appendChild(div);
    }
  });

  // Fit after layout settles
  requestAnimationFrame(() => {
    for (const p of tab.panes) {
      if (!p.exited && p.paneEl.offsetWidth > 0 && p.paneEl.offsetHeight > 0) {
        try { p.fit.fit(); } catch {}
        sendResize(p);
      }
    }
  });
}

function applyFocusStyles(tab: Tab) {
  for (const p of tab.panes) {
    p.paneEl.classList.toggle("pane-focused", p.id === tab.focusedPaneId);
  }
}

// ---------- Pane creation ----------
// NOTE: handlers below look up the owning tab via findPane() each time, so a pane
// can be moved between tabs and still behave correctly (focus, broadcast, zoom).
function createPane(init: { id: string; baseTitle: string; title: string; sshArgs: string[]; sessionId: string | null }): Pane {
  const paneEl = document.createElement("div");
  paneEl.className = "term-pane";
  paneEl.dataset.paneId = init.id;

  const headerEl = document.createElement("div");
  headerEl.className = "pane-header";
  headerEl.draggable = true;
  headerEl.innerHTML = `
    <span class="pane-header-title"></span>
    <span class="pane-header-actions">
      <button class="pane-header-btn pane-header-zoom" title="전체화면 토글">${ZOOM_OUT_SVG}</button>
      <button class="pane-header-btn pane-header-close" title="pane 닫기">${CLOSE_SVG}</button>
    </span>
  `;
  (headerEl.querySelector(".pane-header-title") as HTMLElement).textContent = init.title;

  const xtermEl = document.createElement("div");
  xtermEl.className = "pane-xterm";
  paneEl.append(headerEl, xtermEl);

  const term = new Terminal({
    theme: currentTheme.xterm,
    fontFamily: currentFontFamily,
    fontSize: FONT_DEFAULT,
    lineHeight: 1.08,
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 10000,
    allowProposedApi: true,
    minimumContrastRatio: 4.5,
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    return !isOurShortcut(ev);
  });
  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(serialize);
  term.open(xtermEl);

  const pane: Pane = {
    id: init.id,
    baseTitle: init.baseTitle,
    title: init.title,
    sshArgs: init.sshArgs,
    sessionId: init.sessionId,
    cwd: null,
    fontSize: FONT_DEFAULT,
    paneEl, headerEl, xtermEl,
    term, fit, serialize,
    exited: false,
  };

  // ---- cwd tracking (passive: no commands sent to remote shell) ----
  // OSC 7: \e]7;file://<host>/<path>\a — modern shells configured with
  // PROMPT_COMMAND (vte.sh, zsh's default on macOS, etc.) emit this on every
  // prompt. Most accurate signal.
  term.parser.registerOscHandler(7, (data) => {
    const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
    if (m) {
      try { pane.cwd = decodeURIComponent(m[1]); } catch { pane.cwd = m[1]; }
    }
    return false;  // let other handlers see it too
  });
  // Window title: OSC 0/2. Default Ubuntu/Debian/many distros' /etc/bash.bashrc
  // sets PS1 to include "\[\e]0;\u@\h: \w\a\]" → title becomes "user@host: ~/path".
  // Less precise (uses ~ for home) but very widely available.
  term.onTitleChange((title) => {
    const m = title.match(/^[^:@\s]+@[^:]+:\s*(.+)$/);
    if (!m) return;
    let path = m[1].trim();
    if (path.startsWith("~")) {
      // Resolve ~ via this pane's session SFTP home (lazily fetched once).
      const home = sessionHomeCache.get(init.sessionId ?? "");
      if (home) path = home + path.slice(1);
      else { triggerHomeFetch(init.sessionId); return; }
    }
    if (path.startsWith("/")) pane.cwd = path;
  });

  // Focus on click anywhere in pane (resolve current tab dynamically)
  paneEl.addEventListener("mousedown", () => {
    const r = findPane(pane.id);
    if (!r) return;
    const { tab } = r;
    if (tab.focusedPaneId !== pane.id) {
      tab.focusedPaneId = pane.id;
      applyFocusStyles(tab);
      pane.term.focus();
      sendResize(pane);
      updateWindowTitle();
    }
  });

  headerEl.querySelector(".pane-header-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void closePane(pane.id);
  });
  headerEl.querySelector(".pane-header-zoom")!.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = findPane(pane.id);
    if (r) toggleZoomForPane(r.tab, pane.id);
  });
  headerEl.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".pane-header-btn")) return;
    const r = findPane(pane.id);
    if (r) toggleZoomForPane(r.tab, pane.id);
  });

  term.onData((data) => {
    if (pane.exited) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    const r = findPane(pane.id);
    if (!r) return;
    const { tab } = r;
    if (tab.broadcast) {
      for (const p of tab.panes) {
        if (!p.exited) void invoke("pty_write", { terminalId: p.id, data: bytes });
      }
    } else {
      void invoke("pty_write", { terminalId: pane.id, data: bytes });
    }
  });

  return pane;
}

// ---------- Tab creation ----------
async function addTab(payload: AddTabPayload) {
  if (findPane(payload.terminal_id)) return;  // dedup guard

  const baseTitle = stripSuffix(payload.title);
  const displayTitle = chooseTitle(baseTitle);
  const adopt = payload.adopt === true;
  const initialContent = payload.initial_content || "";

  const tabId = uid();

  hidePlaceholder();

  const tabBtnEl = document.createElement("div");
  tabBtnEl.className = "tab";
  tabBtnEl.dataset.tabId = tabId;
  tabBtnEl.draggable = true;
  tabBtnEl.innerHTML = `
    <span class="tab-broadcast" title="broadcast"></span>
    <span class="tab-title"></span>
    <span class="tab-close" title="닫기">${CLOSE_SVG}</span>
  `;
  (tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = displayTitle;
  tabsEl.appendChild(tabBtnEl);

  const panesWrapEl = document.createElement("div");
  panesWrapEl.className = "panes-wrap";
  panesWrapEl.dataset.tabId = tabId;
  termsEl.appendChild(panesWrapEl);

  const tab: Tab = {
    id: tabId,
    tabBtnEl, panesWrapEl,
    panes: [],
    ratios: [],
    focusedPaneId: payload.terminal_id,
    zoomedPaneId: null,
    broadcast: false,
  };
  tabs.set(tabId, tab);

  // Tab button interactions
  tabBtnEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    setActiveTab(tabId);
  });
  tabBtnEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTab(tabId);
  });
  tabBtnEl.addEventListener("auxclick", (e) => {
    if ((e as MouseEvent).button === 1) void closeTab(tabId);
  });

  // First pane
  const pane = createPane({
    id: payload.terminal_id,
    baseTitle,
    title: displayTitle,
    sshArgs: payload.ssh_args,
    sessionId: payload.session_id ?? null,
  });
  tab.panes.push(pane);
  tab.ratios.push(1);

  // Activate this tab
  if (activeTabId && activeTabId !== tabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.tabBtnEl.classList.remove("active");
      prev.panesWrapEl.classList.remove("active");
    }
  }
  activeTabId = tabId;
  tabBtnEl.classList.add("active");
  panesWrapEl.classList.add("active");
  renderTabLayout(tab);
  applyFocusStyles(tab);

  if (adopt) {
    if (initialContent) pane.term.write(initialContent);
    const queued = pendingOutput.get(pane.id);
    if (queued) {
      for (const c of queued) pane.term.write(c);
      pendingOutput.delete(pane.id);
    }
    sendResize(pane);
    pane.term.focus();
    updateWindowTitle();
    return;
  }

  try {
    await invoke("pty_spawn", {
      terminalId: pane.id,
      sshArgs: payload.ssh_args,
      rows: pane.term.rows || 24,
      cols: pane.term.cols || 80,
    });
    pane.term.focus();
    updateWindowTitle();
  } catch (e) {
    pane.term.writeln(`\x1b[1;31m세션 실행 실패: ${e}\x1b[0m`);
    pane.exited = true;
    pane.headerEl.classList.add("pane-exited");
  }
}

// ---------- Tab activation ----------
function setActiveTab(tabId: string) {
  if (activeTabId === tabId) {
    const t = tabs.get(tabId);
    if (t) {
      const p = t.panes.find(p => p.id === t.focusedPaneId);
      if (p) p.term.focus();
    }
    return;
  }
  if (activeTabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.tabBtnEl.classList.remove("active");
      prev.panesWrapEl.classList.remove("active");
    }
  }
  const next = tabs.get(tabId);
  if (!next) return;
  activeTabId = tabId;
  next.tabBtnEl.classList.add("active");
  next.panesWrapEl.classList.add("active");
  applyFocusStyles(next);
  renderTabLayout(next);
  const p = next.panes.find(p => p.id === next.focusedPaneId) ?? next.panes[0];
  if (p) {
    next.focusedPaneId = p.id;
    sendResize(p);
    p.term.focus();
  }
  updateWindowTitle();
}

// ---------- Split ----------
async function splitTab(tab: Tab, from: Pane, sshArgs: string[], baseTitle: string) {
  if (tab.panes.length >= MAX_PANES_PER_TAB) return;
  if (!sshArgs.length) return;

  const newId = uid();
  const displayTitle = chooseTitle(baseTitle);
  const pane = createPane({ id: newId, baseTitle, title: displayTitle, sshArgs, sessionId: from.sessionId });

  const insertIdx = tab.panes.indexOf(from) + 1;
  tab.panes.splice(insertIdx, 0, pane);

  // Split the origin's share equally with the new pane
  const origIdx = insertIdx - 1;
  const half = tab.ratios[origIdx] / 2;
  tab.ratios.splice(origIdx, 1, half, half);

  // Clear zoom on split
  tab.zoomedPaneId = null;
  renderTabLayout(tab);

  tab.focusedPaneId = pane.id;
  applyFocusStyles(tab);

  try {
    await invoke("pty_spawn", {
      terminalId: newId,
      sshArgs,
      rows: pane.term.rows || 24,
      cols: pane.term.cols || 80,
    });
    pane.term.focus();
    updateWindowTitle();
  } catch (e) {
    pane.term.writeln(`\x1b[1;31m분할 실패: ${e}\x1b[0m`);
    pane.exited = true;
    pane.headerEl.classList.add("pane-exited");
  }
}

function splitActiveSameSession() {
  const ap = getActivePane();
  if (!ap) return;
  void splitTab(ap.tab, ap.pane, ap.pane.sshArgs, ap.pane.baseTitle);
}

// ---------- Close pane / close tab ----------
async function closePane(terminalId: string) {
  const r = findPane(terminalId);
  if (!r) return;
  const { tab, pane, index } = r;

  try { await invoke("pty_kill", { terminalId }); } catch {}
  pane.term.dispose();

  tab.panes.splice(index, 1);
  tab.ratios.splice(index, 1);

  if (tab.panes.length === 0) {
    await closeTab(tab.id);
    return;
  }

  normalizeRatios(tab);

  if (tab.focusedPaneId === terminalId) {
    tab.focusedPaneId = tab.panes[Math.min(index, tab.panes.length - 1)].id;
  }
  if (tab.zoomedPaneId === terminalId) tab.zoomedPaneId = null;

  clearBroadcastIfSinglePane(tab);
  renderTabLayout(tab);
  applyFocusStyles(tab);
  const focused = tab.panes.find(p => p.id === tab.focusedPaneId);
  if (focused) { focused.term.focus(); sendResize(focused); }
  updateWindowTitle();
}

async function closeTab(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  for (const p of tab.panes) {
    try { await invoke("pty_kill", { terminalId: p.id }); } catch {}
    p.term.dispose();
  }
  tab.tabBtnEl.remove();
  tab.panesWrapEl.remove();
  tabs.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    const next = tabs.keys().next().value;
    if (next) {
      setActiveTab(next);
    } else if (isMainWindow) {
      updateWindowTitle();
    } else {
      void getCurrentWindow().close();
    }
  }
}

// ---------- Focus navigation ----------
function focusAdjacentPane(dir: -1 | 1) {
  const t = getActiveTab();
  if (!t) return;
  const idx = t.panes.findIndex(p => p.id === t.focusedPaneId);
  const next = idx + dir;
  if (next < 0 || next >= t.panes.length) return;
  t.focusedPaneId = t.panes[next].id;
  applyFocusStyles(t);
  const p = t.panes[next];
  sendResize(p);
  p.term.focus();
  updateWindowTitle();
}

// ---------- Divider resize ----------
function resizeActiveDivider(delta: number) {
  const t = getActiveTab();
  if (!t || t.panes.length < 2) return;
  const idx = t.panes.findIndex(p => p.id === t.focusedPaneId);
  const leftIdx = idx >= 0 && idx < t.panes.length - 1 ? idx : t.panes.length - 2;
  if (leftIdx < 0) return;
  const newLeft = Math.max(0.1, Math.min(0.9, t.ratios[leftIdx] + delta));
  const diff = newLeft - t.ratios[leftIdx];
  t.ratios[leftIdx] = newLeft;
  t.ratios[leftIdx + 1] -= diff;
  renderTabLayout(t);
}

function startDividerDrag(tab: Tab, leftIdx: number, startX: number) {
  const startRatios = tab.ratios.slice();
  const wrap = tab.panesWrapEl;
  const totalWidth = wrap.getBoundingClientRect().width;
  const leftRatio = startRatios[leftIdx];
  const rightRatio = startRatios[leftIdx + 1];
  const combined = leftRatio + rightRatio;
  const minRatio = 0.1 * combined;

  let pendingRatioLeft = leftRatio;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    tab.ratios[leftIdx] = pendingRatioLeft;
    tab.ratios[leftIdx + 1] = combined - pendingRatioLeft;
    for (let i = 0; i < tab.panes.length; i++) {
      tab.panes[i].paneEl.style.flex = `${tab.ratios[i]} 1 0`;
    }
    const lp = tab.panes[leftIdx];
    const rp = tab.panes[leftIdx + 1];
    try { lp.fit.fit(); } catch {}
    try { rp.fit.fit(); } catch {}
    sendResize(lp);
    sendResize(rp);
  };

  const onMove = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    const ratioDelta = dx / Math.max(totalWidth, 1) * (startRatios.reduce((a, b) => a + b, 0));
    pendingRatioLeft = Math.max(minRatio, Math.min(combined - minRatio, leftRatio + ratioDelta));
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.classList.remove("dragging-divider");
    flush();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.body.classList.add("dragging-divider");
}

termsEl.addEventListener("pointerdown", (e) => {
  const div = (e.target as HTMLElement).closest(".pane-divider") as HTMLElement | null;
  if (!div) return;
  const tabId = div.dataset.tabId!;
  const leftIdx = Number(div.dataset.leftIdx);
  const tab = tabs.get(tabId);
  if (!tab) return;
  e.preventDefault();
  startDividerDrag(tab, leftIdx, e.clientX);
});

termsEl.addEventListener("dblclick", (e) => {
  const div = (e.target as HTMLElement).closest(".pane-divider") as HTMLElement | null;
  if (!div) return;
  const tabId = div.dataset.tabId!;
  const leftIdx = Number(div.dataset.leftIdx);
  const tab = tabs.get(tabId);
  if (!tab) return;
  const combined = tab.ratios[leftIdx] + tab.ratios[leftIdx + 1];
  tab.ratios[leftIdx] = combined / 2;
  tab.ratios[leftIdx + 1] = combined / 2;
  renderTabLayout(tab);
});

// ---------- Zoom ----------
function toggleZoomForPane(tab: Tab, paneId: string) {
  tab.zoomedPaneId = tab.zoomedPaneId === paneId ? null : paneId;
  if (tab.zoomedPaneId) tab.focusedPaneId = paneId;
  renderTabLayout(tab);
  applyFocusStyles(tab);
  const p = tab.panes.find(p => p.id === tab.focusedPaneId);
  if (p) { sendResize(p); p.term.focus(); }
  updateWindowTitle();
}

function toggleZoomActive() {
  const ap = getActivePane();
  if (!ap) return;
  toggleZoomForPane(ap.tab, ap.pane.id);
}

// ---------- Broadcast ----------
// Only meaningful on split tabs (2+ panes). Single-pane tabs ignore the toggle.
function toggleBroadcastActive() {
  const t = getActiveTab();
  if (!t || t.panes.length < 2) return;
  t.broadcast = !t.broadcast;
  t.panesWrapEl.classList.toggle("broadcast", t.broadcast);
  t.tabBtnEl.classList.toggle("broadcast", t.broadcast);
}

function clearBroadcastIfSinglePane(tab: Tab) {
  if (tab.broadcast && tab.panes.length < 2) {
    tab.broadcast = false;
    tab.panesWrapEl.classList.remove("broadcast");
    tab.tabBtnEl.classList.remove("broadcast");
  }
}

// ---------- Font zoom (Ctrl+wheel, per pane) ----------
function adjustFontSize(pane: Pane, delta: number) {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, pane.fontSize + delta));
  if (next === pane.fontSize) return;
  pane.fontSize = next;
  pane.term.options.fontSize = next;
  try { pane.fit.fit(); } catch {}
  sendResize(pane);
}

document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  const ap = getActivePane();
  if (!ap) return;
  adjustFontSize(ap.pane, e.deltaY > 0 ? -1 : 1);
}, { capture: true, passive: false });

// ---------- Clipboard ----------
async function copyActiveSelection(): Promise<boolean> {
  const ap = getActivePane();
  if (!ap) return false;
  const sel = ap.pane.term.getSelection();
  if (!sel) return false;
  try {
    await navigator.clipboard.writeText(sel);
    return true;
  } catch {
    return false;
  }
}

async function pasteToActive() {
  const ap = getActivePane();
  if (!ap) return;
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch { return; }
  if (!text) return;
  const bytes = Array.from(new TextEncoder().encode(text));
  if (ap.tab.broadcast) {
    for (const p of ap.tab.panes) {
      if (!p.exited) void invoke("pty_write", { terminalId: p.id, data: bytes });
    }
  } else if (!ap.pane.exited) {
    void invoke("pty_write", { terminalId: ap.pane.id, data: bytes });
  }
}

function hasSelectionInActivePane(): boolean {
  const ap = getActivePane();
  return !!ap && ap.pane.term.hasSelection();
}

// ---------- Keyboard shortcuts ----------
function isOurShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && e.code === "Digit5") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyC") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyV") return true;
  if (e.ctrlKey && e.shiftKey && e.key === "Enter") return true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && hasSelectionInActivePane()) return true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") return true;
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  return false;
}

function handleShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && e.code === "Digit5") {
    e.preventDefault();
    if (e.altKey) openSessionPickerForSplit();
    else splitActiveSameSession();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") {
    e.preventDefault();
    const ap = getActivePane();
    if (ap) void closePane(ap.pane.id);
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    toggleZoomActive();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") {
    e.preventDefault();
    toggleBroadcastActive();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
    e.preventDefault();
    void copyActiveSelection();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
    e.preventDefault();
    void pasteToActive();
    return true;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && hasSelectionInActivePane()) {
    e.preventDefault();
    void copyActiveSelection().then((ok) => {
      if (ok) getActivePane()?.pane.term.clearSelection();
    });
    return true;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") {
    e.preventDefault();
    void pasteToActive();
    return true;
  }
  if (e.altKey && e.shiftKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") { e.preventDefault(); resizeActiveDivider(-0.03); return true; }
    if (e.key === "ArrowRight") { e.preventDefault(); resizeActiveDivider(+0.03); return true; }
  }
  if (e.altKey && !e.shiftKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") { e.preventDefault(); focusAdjacentPane(-1); return true; }
    if (e.key === "ArrowRight") { e.preventDefault(); focusAdjacentPane(+1); return true; }
  }
  return false;
}

// Run in capture phase so we beat xterm's own handlers
document.addEventListener("keydown", (e) => { handleShortcut(e); }, { capture: true });

// ---------- Tab DnD (reorder within tab bar + drag-out for detach/merge) ----------
let dragSrcTabEl: HTMLElement | null = null;

tabsEl.addEventListener("dragstart", (e) => {
  const t = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (!t || !tabsEl.contains(t)) return;
  dragSrcTabEl = t;
  t.classList.add("tab-dragging");
  e.dataTransfer?.setData("text/plain", t.dataset.tabId || "");
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});

tabsEl.addEventListener("dragend", (e) => {
  if (!dragSrcTabEl) return;
  const srcEl = dragSrcTabEl;
  const srcTabId = srcEl.dataset.tabId;
  srcEl.classList.remove("tab-dragging");
  dragSrcTabEl = null;
  tabsEl.querySelectorAll(".tab-drop-before,.tab-drop-after").forEach(el =>
    el.classList.remove("tab-drop-before", "tab-drop-after"));
  clearSplitDropZones();
  if (srcTabId && e.dataTransfer?.dropEffect === "none") {
    void dropTab(srcTabId, e.screenX, e.screenY);
  }
});

function computeInsertBeforeTab(clientX: number): HTMLElement | null {
  for (const child of Array.from(tabsEl.children) as HTMLElement[]) {
    if (child === dragSrcTabEl) continue;
    const rect = child.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return child;
  }
  return null;
}

tabsEl.addEventListener("dragover", (e) => {
  if (!dragSrcTabEl) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  tabsEl.querySelectorAll(".tab-drop-before,.tab-drop-after").forEach(el =>
    el.classList.remove("tab-drop-before", "tab-drop-after"));
  const hoverTab = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (hoverTab === dragSrcTabEl) return;
  const insertBefore = computeInsertBeforeTab(e.clientX);
  if (insertBefore) {
    insertBefore.classList.add("tab-drop-before");
  } else {
    const nonSrc = (Array.from(tabsEl.children) as HTMLElement[]).filter(el => el !== dragSrcTabEl);
    const last = nonSrc[nonSrc.length - 1];
    if (last) last.classList.add("tab-drop-after");
  }
});

tabsEl.addEventListener("drop", (e) => {
  if (!dragSrcTabEl) return;
  e.preventDefault();
  const insertBefore = computeInsertBeforeTab(e.clientX);
  if (insertBefore) tabsEl.insertBefore(dragSrcTabEl, insertBefore);
  else tabsEl.appendChild(dragSrcTabEl);
});

// ---------- Tab → another tab's panes-wrap (split drop) ----------

function clearSplitDropZones() {
  document.querySelectorAll(".drop-zone-left,.drop-zone-right").forEach(el =>
    el.classList.remove("drop-zone-left", "drop-zone-right"));
}

termsEl.addEventListener("dragover", (e) => {
  if (!dragSrcTabEl) return;
  const wrap = (e.target as HTMLElement).closest(".panes-wrap") as HTMLElement | null;
  if (!wrap) return;
  const targetTabId = wrap.dataset.tabId!;
  const srcTabId = dragSrcTabEl.dataset.tabId;
  if (!srcTabId || srcTabId === targetTabId) return;
  const source = tabs.get(srcTabId);
  const target = tabs.get(targetTabId);
  if (!source || !target) return;
  if (target.panes.length + source.panes.length > MAX_PANES_PER_TAB) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearSplitDropZones();
  const rect = wrap.getBoundingClientRect();
  const isLeft = e.clientX < rect.left + rect.width / 2;
  wrap.classList.add(isLeft ? "drop-zone-left" : "drop-zone-right");
});

termsEl.addEventListener("dragleave", () => {
  // only clear if we're leaving the whole terms area
});

termsEl.addEventListener("drop", (e) => {
  if (!dragSrcTabEl) return;
  const wrap = (e.target as HTMLElement).closest(".panes-wrap") as HTMLElement | null;
  if (!wrap) return;
  const targetTabId = wrap.dataset.tabId!;
  const srcTabId = dragSrcTabEl.dataset.tabId;
  if (!srcTabId || srcTabId === targetTabId) return;
  const source = tabs.get(srcTabId);
  const target = tabs.get(targetTabId);
  if (!source || !target) return;
  if (target.panes.length + source.panes.length > MAX_PANES_PER_TAB) return;
  e.preventDefault();
  clearSplitDropZones();
  const rect = wrap.getBoundingClientRect();
  const isLeft = e.clientX < rect.left + rect.width / 2;
  if (isLeft) {
    let at = 0;
    while (source.panes.length > 0) {
      movePaneAcrossTabs(source, 0, target, at);
      at++;
    }
  } else {
    while (source.panes.length > 0) {
      movePaneAcrossTabs(source, 0, target, target.panes.length);
    }
  }
  setActiveTab(target.id);
});

async function dropTab(tabId: string, screenX: number, screenY: number) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  // For v1 scope: only drag tabs with a single pane across windows — multi-pane tabs
  // are moved/detached whole with the panes intact.
  const primary = tab.panes[tab.panes.length > 0 ? 0 : 0];
  if (!primary) return;
  // Serialize currently focused pane's content (just the focused one for now)
  const fp = tab.panes.find(p => p.id === tab.focusedPaneId) ?? primary;
  const content = fp.serialize.serialize();
  let moved: boolean;
  try {
    moved = await invoke<boolean>("drop_tab", {
      sourceLabel: myLabel,
      terminalId: fp.id,
      title: fp.baseTitle,
      sshArgs: fp.sshArgs,
      sessionId: fp.sessionId,
      initialContent: content,
      screenX, screenY,
      isLastTab: tabs.size === 1,
    });
  } catch {
    return;
  }
  if (!moved) return;
  // The PTY fp.id is now adopted elsewhere; remove its pane locally (keep other panes)
  const r = findPane(fp.id);
  if (!r) return;
  const { tab: t, pane, index } = r;
  pane.term.dispose();
  t.panes.splice(index, 1);
  t.ratios.splice(index, 1);
  if (t.panes.length === 0) {
    await closeTab(t.id);
  } else {
    normalizeRatios(t);
    if (t.focusedPaneId === fp.id) t.focusedPaneId = t.panes[Math.min(index, t.panes.length - 1)].id;
    if (t.zoomedPaneId === fp.id) t.zoomedPaneId = null;
    clearBroadcastIfSinglePane(t);
    renderTabLayout(t);
    applyFocusStyles(t);
  }
}

// ---------- merge-tab event (from another window) ----------
listen<MergeTabPayload>("merge-tab", async (event) => {
  const p = event.payload;
  await addTab({
    terminal_id: p.terminal_id,
    title: p.title,
    ssh_args: p.ssh_args,
    session_id: p.session_id ?? null,
    adopt: true,
    initial_content: p.initial_content,
  });
  await getCurrentWindow().setFocus();
}, scoped);

// ---------- add-tab (create tab in this window) ----------
listen<AddTabPayload>("add-tab", (event) => {
  void addTab(event.payload);
}, scoped);

// ---------- Context menus ----------
interface MenuItem { label: string; action: () => void; danger?: boolean; }

function showContextMenu(x: number, y: number, items: MenuItem[]) {
  document.querySelectorAll(".ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = items.map((it, i) =>
    it.label === "-"
      ? `<div class="ctx-sep"></div>`
      : `<div class="ctx-item ${it.danger ? "ctx-item-danger" : ""}" data-idx="${i}">${it.label}</div>`
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

// Tab button right-click menu
tabsEl.addEventListener("contextmenu", (e) => {
  const tabEl = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (!tabEl) return;
  e.preventDefault();
  e.stopPropagation();
  const tabId = tabEl.dataset.tabId!;
  const tab = tabs.get(tabId);
  if (!tab) return;
  const ap = tab.panes.find(p => p.id === tab.focusedPaneId) ?? tab.panes[0];
  const items: MenuItem[] = [];
  if (ap && ap.sshArgs.length > 0) {
    items.push({ label: "같은 창에 탭 복제", action: () => void duplicateFromPane(ap, false) });
    items.push({ label: "새 창에 탭 복제", action: () => void duplicateFromPane(ap, true) });
    items.push({ label: "-", action: () => {} });
    items.push({ label: "세로로 분할 (같은 세션)", action: () => { setActiveTab(tabId); splitActiveSameSession(); } });
    items.push({ label: "세로로 분할 (다른 세션...)", action: () => { setActiveTab(tabId); openSessionPickerForSplit(); } });
    items.push({ label: "-", action: () => {} });
  }
  if (tab.panes.length > 1) {
    items.push({ label: tab.broadcast ? "브로드캐스트 OFF" : "브로드캐스트 ON", action: () => { setActiveTab(tabId); toggleBroadcastActive(); } });
    items.push({ label: "-", action: () => {} });
  }
  items.push({ label: "탭 닫기", action: () => void closeTab(tabId), danger: true });
  showContextMenu(e.clientX, e.clientY, items);
});

// Pane header / xterm area right-click menu
termsEl.addEventListener("contextmenu", (e) => {
  const header = (e.target as HTMLElement).closest(".pane-header") as HTMLElement | null;
  const xtermArea = (e.target as HTMLElement).closest(".pane-xterm") as HTMLElement | null;
  const paneEl = (header ?? xtermArea)?.closest(".term-pane") as HTMLElement | null;
  if (!paneEl) return;
  e.preventDefault();
  e.stopPropagation();
  const paneId = paneEl.dataset.paneId!;
  const r = findPane(paneId);
  if (!r) return;
  const { tab, pane } = r;
  setActiveTab(tab.id);
  tab.focusedPaneId = paneId;
  applyFocusStyles(tab);
  const items: MenuItem[] = [];
  if (xtermArea) {
    const hasSel = pane.term.hasSelection();
    items.push({
      label: "복사",
      action: () => { void copyActiveSelection().then((ok) => { if (ok) pane.term.clearSelection(); }); },
    });
    if (!hasSel) items[items.length - 1].label += " (선택 없음)";
    items.push({ label: "붙여넣기", action: () => void pasteToActive() });
    items.push({ label: "-", action: () => {} });
  }
  if (tab.panes.length < MAX_PANES_PER_TAB && pane.sshArgs.length > 0) {
    items.push({ label: "세로로 분할 (같은 세션)", action: () => splitActiveSameSession() });
    items.push({ label: "세로로 분할 (다른 세션...)", action: () => openSessionPickerForSplit() });
    items.push({ label: "-", action: () => {} });
  }
  if (pane.sessionId) {
    const openSftp = (window as any).__sshmgr_openSftpPanel as ((sid: string, dir?: string) => void) | undefined;
    if (openSftp) {
      if (pane.cwd) {
        const display = pane.cwd.length > 40 ? "..." + pane.cwd.slice(-37) : pane.cwd;
        items.push({ label: `SFTP 열기 (${display})`, action: () => openSftp(pane.sessionId!, pane.cwd!) });
      }
      items.push({ label: "SFTP 열기 (홈)", action: () => openSftp(pane.sessionId!) });
      items.push({ label: "-", action: () => {} });
    }
  }
  items.push({ label: tab.zoomedPaneId === paneId ? "전체화면 해제" : "전체화면", action: () => toggleZoomForPane(tab, paneId) });
  items.push({ label: "-", action: () => {} });
  items.push({ label: "pane 닫기", action: () => void closePane(paneId), danger: true });
  showContextMenu(e.clientX, e.clientY, items);
});

// ---------- Duplicate (from any pane) ----------
async function duplicateFromPane(pane: Pane, newWindow: boolean) {
  if (!pane.sshArgs.length) return;
  try {
    await invoke("spawn_terminal", {
      sshArgs: pane.sshArgs,
      title: pane.baseTitle,
      newWindow,
      sourceLabel: myLabel,
      sessionId: pane.sessionId,
    });
  } catch (e) { console.error("duplicate failed", e); }
}

// ---------- Session picker for split (different session) ----------
interface SessionOption { title: string; ssh_args: string[]; }

async function openSessionPickerForSplit() {
  const ap = getActivePane();
  if (!ap) return;
  if (ap.tab.panes.length >= MAX_PANES_PER_TAB) return;

  // Fetch the session tree
  let data: any;
  try { data = await invoke("get_all_data"); }
  catch { return; }

  const overlay = document.createElement("div");
  overlay.className = "picker-overlay";
  overlay.innerHTML = `
    <div class="picker-modal">
      <div class="picker-header">
        <span class="picker-title">다른 세션으로 분할</span>
        <button class="picker-close" title="닫기">${CLOSE_SVG}</button>
      </div>
      <input class="picker-search" type="text" placeholder="검색..." autofocus />
      <div class="picker-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector(".picker-list") as HTMLElement;
  const searchEl = overlay.querySelector(".picker-search") as HTMLInputElement;

  const folderOf = (id: string | null) => {
    if (!id) return "미분류";
    return (data.folders ?? []).find((f: any) => f.id === id)?.name ?? "미분류";
  };

  const renderList = (q: string) => {
    const query = q.toLowerCase();
    const sessions = (data.sessions ?? [])
      .slice()
      .sort((a: any, b: any) => a.order - b.order)
      .filter((s: any) => !query
        || s.name.toLowerCase().includes(query)
        || s.host.toLowerCase().includes(query)
        || folderOf(s.folder_id).toLowerCase().includes(query));
    if (sessions.length === 0) {
      listEl.innerHTML = `<div class="picker-empty">결과 없음</div>`;
      return;
    }
    listEl.innerHTML = sessions.map((s: any) => `
      <div class="picker-item" data-session-id="${s.id}">
        <div class="picker-item-folder">${folderOf(s.folder_id)}</div>
        <div class="picker-item-name">${escapeHtml(s.name)}</div>
        <div class="picker-item-host">${escapeHtml(s.user)}@${escapeHtml(s.host)}:${s.port}</div>
      </div>
    `).join("");
  };

  const escapeHtml = (s: string) => {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  };

  const close = () => overlay.remove();
  overlay.querySelector(".picker-close")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  searchEl.addEventListener("input", () => renderList(searchEl.value));

  listEl.addEventListener("click", async (e) => {
    const el = (e.target as HTMLElement).closest(".picker-item") as HTMLElement | null;
    if (!el) return;
    const id = el.dataset.sessionId!;
    close();
    try {
      const resp = await invoke<SessionOption>("get_ssh_args_for_session", { id });
      const ap2 = getActivePane();
      if (!ap2) return;
      await splitTab(ap2.tab, ap2.pane, resp.ssh_args, stripSuffix(resp.title));
    } catch (err) { console.error("split session failed", err); }
  });

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);

  renderList("");
  setTimeout(() => searchEl.focus(), 0);
}

// ---------- Pane DnD (drag from header) ----------
let dragSrcPane: { tabId: string; paneId: string; el: HTMLElement } | null = null;

termsEl.addEventListener("dragstart", (e) => {
  const header = (e.target as HTMLElement).closest(".pane-header") as HTMLElement | null;
  if (!header) return;
  const paneEl = header.closest(".term-pane") as HTMLElement;
  const r = findPane(paneEl.dataset.paneId!);
  if (!r) return;
  dragSrcPane = { tabId: r.tab.id, paneId: r.pane.id, el: paneEl };
  paneEl.classList.add("pane-dragging");
  e.dataTransfer?.setData("text/plain", r.pane.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});

termsEl.addEventListener("dragend", (e) => {
  if (!dragSrcPane) return;
  const { paneId, el } = dragSrcPane;
  el.classList.remove("pane-dragging");
  const effect = e.dataTransfer?.dropEffect ?? "none";
  dragSrcPane = null;
  document.querySelectorAll(".pane-drop-before,.pane-drop-after").forEach(el =>
    el.classList.remove("pane-drop-before", "pane-drop-after"));
  tabsEl.querySelectorAll(".tab-pane-drop").forEach(el => el.classList.remove("tab-pane-drop"));
  // Dropped with no accepted handler → detach. Inside our window's tab bar empty
  // area becomes "extract to new tab"; otherwise (outside webview) we ask Rust to
  // merge-or-create-new-window just like a tab drag-out.
  if (effect === "none") {
    void detachPane(paneId, e.screenX, e.screenY);
  }
});

async function detachPane(paneId: string, screenX: number, screenY: number) {
  const r = findPane(paneId);
  if (!r) return;
  const { tab, pane, index } = r;

  // Outside window → Rust decides: merge into another term window or new window.
  // (Drops inside this window's tab bar empty area are handled separately by the
  //  tabsEl drop handler and won't reach here because that handler accepts the drop.)
  const content = pane.serialize.serialize();
  let moved = false;
  try {
    moved = await invoke<boolean>("drop_tab", {
      sourceLabel: myLabel,
      terminalId: paneId,
      title: pane.baseTitle,
      sshArgs: pane.sshArgs,
      sessionId: pane.sessionId,
      initialContent: content,
      screenX, screenY,
      isLastTab: tab.panes.length === 1 && tabs.size === 1,
    });
  } catch {}
  if (!moved) return;
  pane.term.dispose();
  tab.panes.splice(index, 1);
  tab.ratios.splice(index, 1);
  if (tab.panes.length === 0) {
    await closeTab(tab.id);
  } else {
    normalizeRatios(tab);
    if (tab.focusedPaneId === paneId) {
      tab.focusedPaneId = tab.panes[Math.min(index, tab.panes.length - 1)].id;
    }
    if (tab.zoomedPaneId === paneId) tab.zoomedPaneId = null;
    clearBroadcastIfSinglePane(tab);
    renderTabLayout(tab);
    applyFocusStyles(tab);
  }
}

function extractPaneToNewTab(srcTab: Tab, srcIdx: number) {
  const pane = srcTab.panes[srcIdx];
  if (!pane) return;
  // Create a fresh tab hosting this pane.
  pane.paneEl.remove();
  srcTab.panes.splice(srcIdx, 1);
  srcTab.ratios.splice(srcIdx, 1);
  normalizeRatios(srcTab);
  if (srcTab.focusedPaneId === pane.id) {
    srcTab.focusedPaneId = srcTab.panes[Math.min(srcIdx, srcTab.panes.length - 1)].id;
  }
  if (srcTab.zoomedPaneId === pane.id) srcTab.zoomedPaneId = null;
  clearBroadcastIfSinglePane(srcTab);
  // Sync tab button title when collapsing back to a single pane
  if (srcTab.panes.length === 1) {
    (srcTab.tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = srcTab.panes[0].title;
  }
  renderTabLayout(srcTab);
  applyFocusStyles(srcTab);

  // Build a new tab around the extracted pane
  const newTabId = uid();
  const tabBtnEl = document.createElement("div");
  tabBtnEl.className = "tab";
  tabBtnEl.dataset.tabId = newTabId;
  tabBtnEl.draggable = true;
  tabBtnEl.innerHTML = `
    <span class="tab-broadcast" title="broadcast"></span>
    <span class="tab-title"></span>
    <span class="tab-close" title="닫기">${CLOSE_SVG}</span>
  `;
  (tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = pane.title;
  tabsEl.appendChild(tabBtnEl);

  const panesWrapEl = document.createElement("div");
  panesWrapEl.className = "panes-wrap";
  panesWrapEl.dataset.tabId = newTabId;
  termsEl.appendChild(panesWrapEl);

  const newTab: Tab = {
    id: newTabId, tabBtnEl, panesWrapEl,
    panes: [pane], ratios: [1],
    focusedPaneId: pane.id,
    zoomedPaneId: null, broadcast: false,
  };
  tabs.set(newTabId, newTab);

  tabBtnEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    setActiveTab(newTabId);
  });
  tabBtnEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTab(newTabId);
  });
  tabBtnEl.addEventListener("auxclick", (e) => {
    if ((e as MouseEvent).button === 1) void closeTab(newTabId);
  });

  setActiveTab(newTabId);
}

termsEl.addEventListener("dragover", (e) => {
  if (!dragSrcPane) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".pane-drop-before,.pane-drop-after").forEach(el =>
    el.classList.remove("pane-drop-before", "pane-drop-after"));
  const hoverPane = (e.target as HTMLElement).closest(".term-pane") as HTMLElement | null;
  if (!hoverPane) return;
  if (hoverPane === dragSrcPane.el) return;
  const rect = hoverPane.getBoundingClientRect();
  const before = e.clientX < rect.left + rect.width / 2;
  hoverPane.classList.add(before ? "pane-drop-before" : "pane-drop-after");
});

termsEl.addEventListener("drop", (e) => {
  if (!dragSrcPane) return;
  e.preventDefault();
  const hoverPane = (e.target as HTMLElement).closest(".term-pane") as HTMLElement | null;
  if (!hoverPane || hoverPane === dragSrcPane.el) return;
  const targetPaneId = hoverPane.dataset.paneId!;
  const srcR = findPane(dragSrcPane.paneId);
  const dstR = findPane(targetPaneId);
  if (!srcR || !dstR) return;
  const before = (() => {
    const rect = hoverPane.getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2;
  })();
  if (srcR.tab === dstR.tab) {
    // same tab: reorder
    const t = srcR.tab;
    const srcIdx = srcR.index;
    const dstIdx = dstR.index + (before ? 0 : 1);
    const adjusted = dstIdx > srcIdx ? dstIdx - 1 : dstIdx;
    if (adjusted === srcIdx) return;
    const [movedPane] = t.panes.splice(srcIdx, 1);
    const [movedRatio] = t.ratios.splice(srcIdx, 1);
    t.panes.splice(adjusted, 0, movedPane);
    t.ratios.splice(adjusted, 0, movedRatio);
    renderTabLayout(t);
  } else {
    // different tab: move (respect 3-pane cap in destination)
    if (dstR.tab.panes.length >= MAX_PANES_PER_TAB) return;
    movePaneAcrossTabs(srcR.tab, srcR.index, dstR.tab, dstR.index + (before ? 0 : 1));
  }
});

// Pane drag over tabsEl: accept on tab buttons (merge) OR empty area (extract-to-new-tab)
tabsEl.addEventListener("dragover", (e) => {
  if (!dragSrcPane) return;
  const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (tabBtn) {
    const tid = tabBtn.dataset.tabId!;
    if (tid === dragSrcPane.tabId) return;
    const target = tabs.get(tid);
    if (!target || target.panes.length >= MAX_PANES_PER_TAB) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    tabBtn.classList.add("tab-pane-drop");
    tabsEl.classList.remove("tab-bar-drop-empty");
    return;
  }
  // Empty tab bar area → will extract into a new tab (only makes sense for multi-pane tabs)
  const srcR = findPane(dragSrcPane.paneId);
  if (!srcR || srcR.tab.panes.length <= 1) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  tabsEl.classList.add("tab-bar-drop-empty");
  tabsEl.querySelectorAll(".tab-pane-drop").forEach(el => el.classList.remove("tab-pane-drop"));
});

tabsEl.addEventListener("dragleave", (e) => {
  const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (tabBtn) tabBtn.classList.remove("tab-pane-drop");
  // If we left tabsEl entirely, clear the empty-area indicator
  if (!tabsEl.contains(e.relatedTarget as Node)) {
    tabsEl.classList.remove("tab-bar-drop-empty");
  }
});

tabsEl.addEventListener("drop", (e) => {
  if (!dragSrcPane) return;
  const srcR = findPane(dragSrcPane.paneId);
  if (!srcR) return;
  const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (tabBtn) {
    const tid = tabBtn.dataset.tabId!;
    if (tid === dragSrcPane.tabId) return;
    const dst = tabs.get(tid);
    if (!dst || dst.panes.length >= MAX_PANES_PER_TAB) return;
    e.preventDefault();
    tabBtn.classList.remove("tab-pane-drop");
    movePaneAcrossTabs(srcR.tab, srcR.index, dst, dst.panes.length);
    return;
  }
  // Empty area → extract pane to new tab (single-pane tabs bail)
  if (srcR.tab.panes.length <= 1) return;
  e.preventDefault();
  tabsEl.classList.remove("tab-bar-drop-empty");
  extractPaneToNewTab(srcR.tab, srcR.index);
});

function movePaneAcrossTabs(srcTab: Tab, srcIdx: number, dstTab: Tab, dstIdx: number) {
  const pane = srcTab.panes[srcIdx];
  if (!pane) return;
  // Remove from src DOM
  pane.paneEl.remove();
  srcTab.panes.splice(srcIdx, 1);
  srcTab.ratios.splice(srcIdx, 1);
  if (srcTab.panes.length === 0) {
    // If this tab was the active tab drag source, reset the reference before removing it
    // from the DOM — otherwise stale dragSrcTabEl causes ghost tabs when a pane-drag
    // later drops on the same tabsEl (both drop handlers fire).
    if (dragSrcTabEl?.dataset.tabId === srcTab.id) dragSrcTabEl = null;
    void closeTab(srcTab.id);
  } else {
    normalizeRatios(srcTab);
    if (srcTab.focusedPaneId === pane.id) srcTab.focusedPaneId = srcTab.panes[Math.min(srcIdx, srcTab.panes.length - 1)].id;
    if (srcTab.zoomedPaneId === pane.id) srcTab.zoomedPaneId = null;
    clearBroadcastIfSinglePane(srcTab);
    if (srcTab.panes.length === 1) {
      (srcTab.tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = srcTab.panes[0].title;
    }
    renderTabLayout(srcTab);
    applyFocusStyles(srcTab);
  }
  // Insert into dst. Pane event handlers resolve their current tab via findPane()
  // at call time, so no rewiring is needed after a move.
  dstTab.panes.splice(dstIdx, 0, pane);
  // Rename only on actual collision within the destination tab
  if (dstTab.panes.filter(p => p.title === pane.title).length > 1) {
    pane.title = chooseTitle(pane.baseTitle);
    (pane.headerEl.querySelector(".pane-header-title") as HTMLElement).textContent = pane.title;
  }
  const share = 1 / (dstTab.panes.length);
  dstTab.ratios = dstTab.panes.map(() => share);
  dstTab.focusedPaneId = pane.id;
  renderTabLayout(dstTab);
  applyFocusStyles(dstTab);
  setActiveTab(dstTab.id);
}

// ---------- Window close: kill all PTYs ----------
getCurrentWindow().onCloseRequested(async (event) => {
  if (tabs.size === 0) return;
  event.preventDefault();
  for (const tab of tabs.values()) {
    for (const p of tab.panes) {
      try { await invoke("pty_kill", { terminalId: p.id }); } catch {}
    }
  }
  tabs.clear();
  await getCurrentWindow().destroy();
});

// ---------- Window resize ----------
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const t = getActiveTab();
    if (!t) return;
    for (const p of t.panes) {
      if (!p.exited) {
        try { p.fit.fit(); } catch {}
        sendResize(p);
      }
    }
  }, 50);
});

// ---------- Bootstrap ----------
(async () => {
  try {
    const savedTheme = await invoke<string | null>("get_terminal_theme");
    if (savedTheme) applyThemeToAllPanes(getTheme(savedTheme));
    const savedFont = await invoke<string | null>("get_terminal_font");
    if (savedFont) currentFontFamily = getFontValue(savedFont);
    const initial = await invoke<AddTabPayload | null>("pty_take_pending", { windowLabel: myLabel });
    if (initial) await addTab(initial);
    else if (isMainWindow) {
      // showPlaceholder();
    }
  } catch (e) {
    console.error("bootstrap failed:", e);
  }
})();
