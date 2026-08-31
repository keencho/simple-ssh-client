import { tick } from "svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getTheme, applyUiTheme, getFontValue, type TerminalTheme } from "../../themes";
import { t } from "../i18n";
import { showToast } from "../stores/toast.svelte";
import * as Ssh from "../api/ssh";
import * as Data from "../api/data";
import type { AddTabPayload } from "../api/types";
import { mountSessionPicker, mountPasswordPrompt } from "../components/modals/mount";
import {
  type TabData,
  type PaneData,
  terminalStore,
  findPane,
  getActivePane,
  getXterm,
  unregisterXterm,
  addTab as addTabToStore,
  removeTab as removeTabFromStore,
  removePaneFromTab,
  insertPaneAt,
  setRatios,
  setActiveTab as setActiveTabInStore,
  setFocusedPane,
  setZoomedPane,
  setBroadcast,
  setPaneExited,
  setPaneFontSize,
  setAdoptedContent,
  normalizeRatios,
  clearBroadcastIfSinglePane,
  chooseUniqueTitle,
  stripSuffix,
  resolveTitle,
  uid,
  setCurrentTheme,
  setCurrentFontFamily,
  getCurrentFontFamily,
  FONT_DEFAULT,
  FONT_MIN,
  FONT_MAX,
  MAX_PANES_PER_TAB,
} from "../stores/terminals.svelte";

// ---------- Window helpers ----------
const _myLabel = getCurrentWindow().label;
export const myWindowLabel = _myLabel;
export const isMainWindow = !_myLabel.startsWith("term-");

export function updateWindowTitle(): void {
  const ap = getActivePane();
  const fallback = isMainWindow ? "Simple SSH Client" : "Terminal";
  void getCurrentWindow().setTitle(ap ? ap.pane.title : fallback);
}

// ---------- Xterm-side helpers ----------
export function sendResize(paneId: string): void {
  const x = getXterm(paneId);
  if (!x) return;
  const r = findPane(paneId);
  if (!r || r.pane.exited) return;
  const { rows, cols } = x.term;
  if (!rows || !cols) return;
  Ssh.ptyResize(paneId, rows, cols).catch(() => {});
}

export function fitPane(paneId: string): void {
  const x = getXterm(paneId);
  if (!x) return;
  const r = findPane(paneId);
  if (!r || r.pane.exited) return;
  try { x.fit.fit(); } catch {}
  sendResize(paneId);
}

export function focusPane(paneId: string): void {
  getXterm(paneId)?.term.focus();
}

// ---------- Theme/font hot-swap ----------
export function applyThemeToAllPanes(theme: TerminalTheme): void {
  setCurrentTheme(theme);
  applyUiTheme(theme.ui);
  for (const tab of terminalStore.tabs) {
    for (const p of tab.panes) {
      const x = getXterm(p.id);
      if (x) x.term.options.theme = theme.xterm;
    }
  }
}

export function applyFontToAllPanes(fontFamily: string): void {
  setCurrentFontFamily(fontFamily);
  // 스토어를 거쳐서 다시 읽는다 — 한글 폴백이 붙은 최종 스택이 필요하다.
  const resolved = getCurrentFontFamily();
  for (const tab of terminalStore.tabs) {
    for (const p of tab.panes) {
      const x = getXterm(p.id);
      if (!x) continue;
      x.term.options.fontFamily = resolved;
      try { x.fit.fit(); } catch {}
      sendResize(p.id);
    }
  }
}

export function applyThemeName(name: string | null | undefined): void {
  applyThemeToAllPanes(getTheme(name));
}
export function applyFontName(name: string | null | undefined): void {
  applyFontToAllPanes(getFontValue(name));
}

// ---------- Tab activation ----------
export function setActiveTab(tabId: string): void {
  const current = terminalStore.activeTabId;
  if (current === tabId) {
    const ap = getActivePane();
    if (ap) focusPane(ap.pane.id);
    return;
  }
  setActiveTabInStore(tabId);
  void tick().then(() => {
    const ap = getActivePane();
    if (ap) {
      fitPane(ap.pane.id);
      focusPane(ap.pane.id);
    }
    updateWindowTitle();
  });
}

// ---------- Close pane / close tab ----------
export async function closePane(paneId: string): Promise<void> {
  const r = findPane(paneId);
  if (!r) return;
  const { tab, index } = r;

  try { await Ssh.ptyKill(paneId); } catch {}

  removePaneFromTab(tab.id, paneId);

  if (tab.panes.length === 0) {
    await closeTab(tab.id);
    return;
  }

  normalizeRatios(tab);
  if (tab.focusedPaneId === paneId) {
    setFocusedPane(tab.id, tab.panes[Math.min(index, tab.panes.length - 1)].id);
  }
  if (tab.zoomedPaneId === paneId) setZoomedPane(tab.id, null);
  clearBroadcastIfSinglePane(tab);

  void tick().then(() => {
    const focused = tab.panes.find(p => p.id === tab.focusedPaneId);
    if (focused) {
      fitPane(focused.id);
      focusPane(focused.id);
    }
    updateWindowTitle();
  });
}

export async function closeTab(tabId: string): Promise<void> {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab) return;
  for (const p of tab.panes) {
    try { await Ssh.ptyKill(p.id); } catch {}
  }
  removeTabFromStore(tabId);

  void tick().then(() => {
    const next = terminalStore.activeTab;
    if (next) {
      const p = next.panes.find(p => p.id === next.focusedPaneId) ?? next.panes[0];
      if (p) {
        fitPane(p.id);
        focusPane(p.id);
      }
      updateWindowTitle();
    } else if (isMainWindow) {
      updateWindowTitle();
    } else {
      void getCurrentWindow().close();
    }
  });
}

// ---------- Add tab (from add-tab event or local spawn) ----------
export async function addTab(payload: AddTabPayload): Promise<void> {
  if (findPane(payload.terminal_id)) return;  // dedup guard

  const baseTitle = stripSuffix(resolveTitle(payload.title, t("sidebar.uncategorized")));
  const displayTitle = chooseUniqueTitle(baseTitle);
  const adopt = payload.adopt === true;
  const initialContent = payload.initial_content || "";

  const pane: PaneData = {
    id: payload.terminal_id,
    baseTitle,
    title: displayTitle,
    sshArgs: payload.ssh_args,
    sessionId: payload.session_id ?? null,
    cwd: null,
    fontSize: FONT_DEFAULT,
    exited: false,
  };

  const tab: TabData = {
    id: uid(),
    panes: [pane],
    ratios: [1],
    focusedPaneId: pane.id,
    zoomedPaneId: null,
    broadcast: false,
  };

  addTabToStore(tab);
  setActiveTabInStore(tab.id);

  await tick();

  const x = getXterm(pane.id);
  if (!x) return;

  if (adopt) {
    if (initialContent) x.term.write(initialContent);
    fitPane(pane.id);
    focusPane(pane.id);
    updateWindowTitle();
    return;
  }

  try {
    await Ssh.ptySpawn({
      terminalId: pane.id,
      sshArgs: payload.ssh_args,
      sessionId: pane.sessionId,
      rows: x.term.rows || 24,
      cols: x.term.cols || 80,
    });
    focusPane(pane.id);
    updateWindowTitle();
  } catch (e) {
    setPaneExited(pane.id, true);
    x.term.writeln(`\x1b[1;31m${t("terminal.errors.runFailed", { error: String(e) })}\x1b[0m`);
  }
}

// ---------- Zoom / Broadcast ----------
export function toggleZoomForPane(tabId: string, paneId: string): void {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const next = tab.zoomedPaneId === paneId ? null : paneId;
  setZoomedPane(tabId, next);
  if (next) setFocusedPane(tabId, paneId);

  void tick().then(() => {
    const focused = tab.panes.find(p => p.id === tab.focusedPaneId);
    if (focused) {
      fitPane(focused.id);
      focusPane(focused.id);
    }
    updateWindowTitle();
  });
}

export function toggleBroadcastForTab(tabId: string): void {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab || tab.panes.length < 2) return;
  setBroadcast(tabId, !tab.broadcast);
}

export function toggleZoomActive(): void {
  const ap = getActivePane();
  if (!ap) return;
  toggleZoomForPane(ap.tab.id, ap.pane.id);
}

export function toggleBroadcastActive(): void {
  const t = terminalStore.activeTab;
  if (!t) return;
  toggleBroadcastForTab(t.id);
}

// ---------- Split ----------
export async function splitPane(
  tabId: string,
  fromPaneId: string,
  sshArgs: string[],
  baseTitle: string,
  overrideSessionId?: string | null,
): Promise<void> {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab) return;
  if (tab.panes.length >= MAX_PANES_PER_TAB) return;
  // Empty sshArgs is valid for password-auth sessions (handled via sessionId).
  if (!sshArgs.length && overrideSessionId === undefined) return;

  const fromIdx = tab.panes.findIndex(p => p.id === fromPaneId);
  if (fromIdx < 0) return;

  const newId = uid();
  const displayTitle = chooseUniqueTitle(baseTitle);
  const sessionId = overrideSessionId !== undefined ? overrideSessionId : tab.panes[fromIdx].sessionId;

  const newPane: PaneData = {
    id: newId,
    baseTitle,
    title: displayTitle,
    sshArgs,
    sessionId,
    cwd: null,
    fontSize: FONT_DEFAULT,
    exited: false,
  };

  const insertIdx = fromIdx + 1;
  const half = tab.ratios[fromIdx] / 2;
  insertPaneAt(tabId, insertIdx, newPane, half);
  // Adjust origin's share to half (now at fromIdx)
  const ratios = tab.ratios.slice();
  ratios[fromIdx] = half;
  setRatios(tabId, ratios);

  setZoomedPane(tabId, null);
  setFocusedPane(tabId, newId);

  await tick();

  const x = getXterm(newId);
  if (!x) return;

  try {
    await Ssh.ptySpawn({
      terminalId: newId,
      sshArgs,
      sessionId,
      rows: x.term.rows || 24,
      cols: x.term.cols || 80,
    });
    focusPane(newId);
    updateWindowTitle();
  } catch (e) {
    setPaneExited(newId, true);
    x.term.writeln(`\x1b[1;31m${t("terminal.errors.splitFailed", { error: String(e) })}\x1b[0m`);
  }
}

export function splitActiveSameSession(): void {
  const ap = getActivePane();
  if (!ap) return;
  void splitPane(ap.tab.id, ap.pane.id, ap.pane.sshArgs, ap.pane.baseTitle);
}

// ---------- Focus navigation ----------
export function focusAdjacentPane(dir: -1 | 1): void {
  const t = terminalStore.activeTab;
  if (!t) return;
  const idx = t.panes.findIndex(p => p.id === t.focusedPaneId);
  const next = idx + dir;
  if (next < 0 || next >= t.panes.length) return;
  setFocusedPane(t.id, t.panes[next].id);
  void tick().then(() => {
    fitPane(t.panes[next].id);
    focusPane(t.panes[next].id);
    updateWindowTitle();
  });
}

// ---------- Divider resize ----------
export function resizeActiveDivider(delta: number): void {
  const t = terminalStore.activeTab;
  if (!t || t.panes.length < 2) return;
  const idx = t.panes.findIndex(p => p.id === t.focusedPaneId);
  const leftIdx = idx >= 0 && idx < t.panes.length - 1 ? idx : t.panes.length - 2;
  if (leftIdx < 0) return;
  const newLeft = Math.max(0.1, Math.min(0.9, t.ratios[leftIdx] + delta));
  const diff = newLeft - t.ratios[leftIdx];
  const ratios = t.ratios.slice();
  ratios[leftIdx] = newLeft;
  ratios[leftIdx + 1] -= diff;
  setRatios(t.id, ratios);
}

export function startDividerDrag(tabId: string, leftIdx: number, startX: number): void {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const wrap = document.querySelector(
    `.panes-wrap[data-tab-id="${tabId}"]`,
  ) as HTMLElement | null;
  const totalWidth = wrap ? wrap.getBoundingClientRect().width : window.innerWidth;
  const startRatios = tab.ratios.slice();
  const leftRatio = startRatios[leftIdx];
  const rightRatio = startRatios[leftIdx + 1];
  const combined = leftRatio + rightRatio;
  const minRatio = 0.1 * combined;

  let pendingRatioLeft = leftRatio;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const ratios = tab.ratios.slice();
    ratios[leftIdx] = pendingRatioLeft;
    ratios[leftIdx + 1] = combined - pendingRatioLeft;
    setRatios(tabId, ratios);
    // Pane.svelte's ResizeObserver will trigger fit + sendResize
  };

  const onMove = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    const ratioDelta =
      (dx / Math.max(totalWidth, 1)) * startRatios.reduce((a, b) => a + b, 0);
    pendingRatioLeft = Math.max(
      minRatio,
      Math.min(combined - minRatio, leftRatio + ratioDelta),
    );
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
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

export function resetDividerToCenter(tabId: string, leftIdx: number): void {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const combined = tab.ratios[leftIdx] + tab.ratios[leftIdx + 1];
  const ratios = tab.ratios.slice();
  ratios[leftIdx] = combined / 2;
  ratios[leftIdx + 1] = combined / 2;
  setRatios(tabId, ratios);
}

// ---------- Clipboard ----------
// 선택 즉시 복사. config.json에 저장되고 창마다 따로 들고 있으므로
// 분리된 터미널 창은 copy-on-select-changed 이벤트로 갱신된다.
let _copyOnSelect = false;
export function setCopyOnSelectFlag(on: boolean): void { _copyOnSelect = on; }

export function hasSelectionInActivePane(): boolean {
  const ap = getActivePane();
  if (!ap) return false;
  const x = getXterm(ap.pane.id);
  return !!x && x.term.hasSelection();
}

// 한글/이모지는 UTF-16 code unit 수와 눈에 보이는 글자 수가 다르다.
// 토스트에 띄우는 숫자는 사람이 세는 쪽에 맞춘다.
function describeCopied(text: string): string {
  const chars = Array.from(text).length;
  const lines = text.split("\n").length;
  return lines > 1
    ? t("terminal.toast.copiedLines", { lines, chars })
    : t("terminal.toast.copied", { chars });
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(describeCopied(text));
    return true;
  } catch {
    return false;
  }
}

// 드래그/더블클릭으로 만들어진 선택을 바로 복사한다.
// 활성 페인이 아니라 실제로 선택이 일어난 페인을 대상으로 한다 —
// mouseup 시점엔 포커스 전환이 아직 안 끝났을 수 있다.
export async function copySelectionFromPane(paneId: string): Promise<void> {
  if (!_copyOnSelect) return;
  const x = getXterm(paneId);
  if (!x || !x.term.hasSelection()) return;
  const sel = x.term.getSelection();
  if (!sel) return;
  await writeClipboard(sel);
}

export async function copyActiveSelection(): Promise<boolean> {
  const ap = getActivePane();
  if (!ap) return false;
  const x = getXterm(ap.pane.id);
  if (!x) return false;
  const sel = x.term.getSelection();
  if (!sel) return false;
  return writeClipboard(sel);
}

export async function pasteToActive(): Promise<void> {
  const ap = getActivePane();
  if (!ap) return;
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch { return; }
  if (!text) return;
  const bytes = Array.from(new TextEncoder().encode(text));
  if (ap.tab.broadcast) {
    for (const p of ap.tab.panes) {
      if (!p.exited) void Ssh.ptyWrite(p.id, bytes);
    }
  } else if (!ap.pane.exited) {
    void Ssh.ptyWrite(ap.pane.id, bytes);
  }
}

// ---------- Font zoom ----------
export function adjustActiveFontSize(delta: number): void {
  const ap = getActivePane();
  if (!ap) return;
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, ap.pane.fontSize + delta));
  if (next === ap.pane.fontSize) return;
  setPaneFontSize(ap.pane.id, next);
  const x = getXterm(ap.pane.id);
  if (x) {
    x.term.options.fontSize = next;
    try { x.fit.fit(); } catch {}
    sendResize(ap.pane.id);
  }
}

// ---------- Duplicate (from any pane) ----------
export async function duplicateFromPane(pane: PaneData, newWindow: boolean): Promise<void> {
  // Empty sshArgs is valid for password sessions; sessionId carries the auth.
  if (!pane.sshArgs.length && !pane.sessionId) return;
  try {
    await Ssh.spawnTerminal({
      sshArgs: pane.sshArgs,
      title: pane.baseTitle,
      newWindow,
      sourceLabel: myWindowLabel,
      sessionId: pane.sessionId,
    });
  } catch (e) { console.error("duplicate failed", e); }
}

// ---------- Session picker for split (different session) ----------
export async function openSessionPicker(): Promise<void> {
  const ap = getActivePane();
  if (!ap) return;
  if (ap.tab.panes.length >= MAX_PANES_PER_TAB) return;

  let data;
  try { data = await Data.getAllData(); }
  catch { return; }

  mountSessionPicker({
    folders: data.folders,
    sessions: data.sessions,
    onSelect: async (sessionId) => {
      try {
        // Password prompt for any missing creds before spawning.
        const needs = await Data.checkSessionPasswordNeeds(sessionId);
        for (const need of needs) {
          const pwd = await mountPasswordPrompt({
            user: need.user,
            host: need.host,
            isJump: need.slot === "jump",
          });
          if (pwd === null) return;
          await Data.setSessionPassword(sessionId, need.slot, pwd);
        }
        const resp = await Ssh.getSshArgsForSession(sessionId);
        const ap2 = getActivePane();
        if (!ap2) return;
        await splitPane(
          ap2.tab.id,
          ap2.pane.id,
          resp.ssh_args,
          stripSuffix(resolveTitle(resp.title, t("sidebar.uncategorized"))),
          sessionId,
        );
      } catch (err) { console.error("split session failed", err); }
    },
  });
}

// ---------- Cross-tab pane move + extract ----------
export async function movePaneAcrossTabs(
  srcTabId: string,
  srcIdx: number,
  dstTabId: string,
  dstIdx: number,
): Promise<void> {
  const srcTab = terminalStore.tabs.find(t => t.id === srcTabId);
  const dstTab = terminalStore.tabs.find(t => t.id === dstTabId);
  if (!srcTab || !dstTab) return;
  const pane = srcTab.panes[srcIdx];
  if (!pane) return;
  if (dstTab.panes.length >= MAX_PANES_PER_TAB) return;

  // Capture xterm scrollback before unmount-remount loses it
  const x = getXterm(pane.id);
  if (x) setAdoptedContent(pane.id, x.serialize.serialize());

  removePaneFromTab(srcTabId, pane.id);
  if (srcTab.panes.length === 0) {
    removeTabFromStore(srcTabId);
  } else {
    normalizeRatios(srcTab);
    if (srcTab.focusedPaneId === pane.id) {
      setFocusedPane(srcTabId, srcTab.panes[Math.min(srcIdx, srcTab.panes.length - 1)].id);
    }
    if (srcTab.zoomedPaneId === pane.id) setZoomedPane(srcTabId, null);
    clearBroadcastIfSinglePane(srcTab);
  }

  // Wait for Svelte to unmount the old Pane component (and its xterm).
  // Without this gap, the destination's new Pane could mount first,
  // register its xterm, then have the old onDestroy unregister it.
  await tick();

  // Insert into dst, rename only on actual collision
  if (dstTab.panes.some(p => p.title === pane.title)) {
    pane.title = chooseUniqueTitle(pane.baseTitle);
  }
  insertPaneAt(dstTabId, dstIdx, pane, 1);
  const equal = 1 / dstTab.panes.length;
  setRatios(dstTabId, dstTab.panes.map(() => equal));
  setFocusedPane(dstTabId, pane.id);
  setActiveTab(dstTabId);
}

export async function extractPaneToNewTab(srcTabId: string, srcIdx: number): Promise<void> {
  const srcTab = terminalStore.tabs.find(t => t.id === srcTabId);
  if (!srcTab) return;
  const pane = srcTab.panes[srcIdx];
  if (!pane || srcTab.panes.length <= 1) return;

  const x = getXterm(pane.id);
  if (x) setAdoptedContent(pane.id, x.serialize.serialize());

  removePaneFromTab(srcTabId, pane.id);
  if (srcTab.panes.length > 0) {
    normalizeRatios(srcTab);
    if (srcTab.focusedPaneId === pane.id) {
      setFocusedPane(srcTabId, srcTab.panes[Math.min(srcIdx, srcTab.panes.length - 1)].id);
    }
    if (srcTab.zoomedPaneId === pane.id) setZoomedPane(srcTabId, null);
    clearBroadcastIfSinglePane(srcTab);
  }

  // Wait for unmount before re-mounting under a new tab — see movePaneAcrossTabs.
  await tick();

  const newTab: TabData = {
    id: uid(),
    panes: [pane],
    ratios: [1],
    focusedPaneId: pane.id,
    zoomedPaneId: null,
    broadcast: false,
  };
  addTabToStore(newTab);
  setActiveTabInStore(newTab.id);
}

// ---------- Detach (drop tab/pane outside window) ----------
export async function dropTabOut(
  tabId: string,
  screenX: number,
  screenY: number,
): Promise<void> {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab || tab.panes.length === 0) return;
  // Detach the focused pane only (multi-pane tabs keep the rest)
  const fp = tab.panes.find(p => p.id === tab.focusedPaneId) ?? tab.panes[0];
  const x = getXterm(fp.id);
  const content = x ? x.serialize.serialize() : "";
  let moved: boolean;
  try {
    moved = await Ssh.dropTab({
      sourceLabel: myWindowLabel,
      terminalId: fp.id,
      title: fp.baseTitle,
      sshArgs: fp.sshArgs,
      sessionId: fp.sessionId,
      initialContent: content,
      screenX,
      screenY,
      isLastTab: terminalStore.tabs.length === 1,
    });
  } catch { return; }
  if (!moved) return;
  removeAdoptedPaneAfterAdoption(tab.id, fp.id, /*indexHint*/ tab.panes.findIndex(p => p.id === fp.id));
}

export async function detachPane(
  paneId: string,
  screenX: number,
  screenY: number,
): Promise<void> {
  const r = findPane(paneId);
  if (!r) return;
  const { tab, index } = r;
  const x = getXterm(paneId);
  const content = x ? x.serialize.serialize() : "";
  let moved = false;
  try {
    moved = await Ssh.dropTab({
      sourceLabel: myWindowLabel,
      terminalId: paneId,
      title: r.pane.baseTitle,
      sshArgs: r.pane.sshArgs,
      sessionId: r.pane.sessionId,
      initialContent: content,
      screenX,
      screenY,
      isLastTab: tab.panes.length === 1 && terminalStore.tabs.length === 1,
    });
  } catch {}
  if (!moved) return;
  removeAdoptedPaneAfterAdoption(tab.id, paneId, index);
}

function removeAdoptedPaneAfterAdoption(tabId: string, paneId: string, indexHint: number) {
  const tab = terminalStore.tabs.find(t => t.id === tabId);
  if (!tab) return;
  removePaneFromTab(tabId, paneId);
  if (tab.panes.length === 0) {
    removeTabFromStore(tabId);
    void tick().then(() => {
      const next = terminalStore.activeTab;
      if (next) {
        const p = next.panes.find(p => p.id === next.focusedPaneId) ?? next.panes[0];
        if (p) { fitPane(p.id); focusPane(p.id); }
        updateWindowTitle();
      } else if (isMainWindow) {
        updateWindowTitle();
      } else {
        void getCurrentWindow().close();
      }
    });
    return;
  }
  normalizeRatios(tab);
  if (tab.focusedPaneId === paneId) {
    setFocusedPane(tabId, tab.panes[Math.min(indexHint, tab.panes.length - 1)].id);
  }
  if (tab.zoomedPaneId === paneId) setZoomedPane(tabId, null);
  clearBroadcastIfSinglePane(tab);
}

// ---------- Keyboard shortcuts ----------
// Ctrl 단독 + C는 선택 영역이 있을 때만 복사로 가로챈다. copy-on-select이
// 켜져 있으면 선택하는 순간 이미 복사됐으므로 가로챌 이유가 없다 —
// 그대로 흘려보내 SIGINT가 되게 한다(Ctrl+Shift+C는 언제나 복사).
function ctrlCCopies(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.code !== "KeyC") return false;
  if (_copyOnSelect) return false;
  return hasSelectionInActivePane();
}

export function isOurShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && e.code === "Digit5") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyC") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyV") return true;
  if (e.ctrlKey && e.shiftKey && e.key === "Enter") return true;
  if (ctrlCCopies(e)) return true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") return true;
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  return false;
}

export function handleShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && e.code === "Digit5") {
    e.preventDefault();
    if (e.altKey) void openSessionPicker();
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
  if (ctrlCCopies(e)) {
    e.preventDefault();
    void copyActiveSelection().then((ok) => {
      if (!ok) return;
      const ap = getActivePane();
      if (ap) getXterm(ap.pane.id)?.term.clearSelection();
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

// ---------- Re-export for convenience ----------
export { applyUiTheme };
