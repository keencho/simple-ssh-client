import {
  terminalStore,
  findPane,
  findTab,
  MAX_PANES_PER_TAB,
  reorderTab,
  moveTabToEnd,
} from "../stores/terminals.svelte";
import {
  movePaneAcrossTabs,
  extractPaneToNewTab,
  dropTabOut,
  detachPane,
  setActiveTab,
} from "../terminal/operations";
import { reorderPaneInTab as reorderPaneStore } from "../stores/terminals.svelte";

// Shared transient state across the two action surfaces
let dragSrcTabId: string | null = null;
let dragSrcPane: { tabId: string; paneId: string } | null = null;

// Clear every transient drag-related class across the document. Defensive
// against the dragged source disappearing from DOM mid-drop (capture-phase).
function clearAllDragArtifacts(tabsEl?: HTMLElement) {
  document.querySelectorAll(
    ".tab-dragging, .tab-drop-before, .tab-drop-after, .tab-pane-drop, " +
      ".drop-zone-left, .drop-zone-right, .pane-dragging, " +
      ".pane-drop-before, .pane-drop-after",
  ).forEach((el) => {
    el.classList.remove(
      "tab-dragging",
      "tab-drop-before",
      "tab-drop-after",
      "tab-pane-drop",
      "drop-zone-left",
      "drop-zone-right",
      "pane-dragging",
      "pane-drop-before",
      "pane-drop-after",
    );
  });
  tabsEl?.classList.remove("tab-bar-drop-empty");
}

function clearSplitDropZones() {
  document.querySelectorAll(".drop-zone-left, .drop-zone-right").forEach((el) =>
    el.classList.remove("drop-zone-left", "drop-zone-right"),
  );
}

// Compute insert position when dragging a tab over the tab bar.
function computeInsertBeforeTab(tabsEl: HTMLElement, clientX: number): HTMLElement | null {
  for (const child of Array.from(tabsEl.children) as HTMLElement[]) {
    if (!child.classList.contains("tab")) continue;
    if (child.classList.contains("tab-dragging")) continue;
    const rect = child.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return child;
  }
  return null;
}

// ============================================================
// Tab DnD action — attach to #tabs container
// ============================================================
export function tabDnd(node: HTMLElement) {
  const tabsEl = node;

  function onDragStart(e: DragEvent) {
    const tabEl = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
    if (!tabEl || !tabsEl.contains(tabEl)) return;
    // Defensive: a previous drag's dragend may have been lost (Svelte
    // re-render destroying source, browser quirk, etc). Clear stale state.
    dragSrcPane = null;
    dragSrcTabId = tabEl.dataset.tabId ?? null;
    tabEl.classList.add("tab-dragging");
    e.dataTransfer?.setData("text/plain", dragSrcTabId ?? "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: DragEvent) {
    if (dragSrcTabId) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      tabsEl.querySelectorAll(".tab-drop-before,.tab-drop-after").forEach((el) =>
        el.classList.remove("tab-drop-before", "tab-drop-after"),
      );
      const hover = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
      if (hover && hover.classList.contains("tab-dragging")) return;
      const insertBefore = computeInsertBeforeTab(tabsEl, e.clientX);
      if (insertBefore) {
        insertBefore.classList.add("tab-drop-before");
      } else {
        const nonSrc = (Array.from(tabsEl.children) as HTMLElement[]).filter(
          (el) => el.classList.contains("tab") && !el.classList.contains("tab-dragging"),
        );
        const last = nonSrc[nonSrc.length - 1];
        if (last) last.classList.add("tab-drop-after");
      }
      return;
    }
    if (dragSrcPane) {
      const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
      if (tabBtn) {
        const tid = tabBtn.dataset.tabId ?? "";
        if (tid !== dragSrcPane.tabId) {
          const target = findTab(tid);
          if (!target || target.panes.length >= MAX_PANES_PER_TAB) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          tabBtn.classList.add("tab-pane-drop");
          tabsEl.classList.remove("tab-bar-drop-empty");
          return;
        }
        // Same-tab hover → fall through to "extract" behavior so users don't
        // have to aim at the narrow empty strip beside the source tab.
      }
      // Empty area / same-tab area → extract to new tab (multi-pane only)
      const srcR = findPane(dragSrcPane.paneId);
      if (!srcR || srcR.tab.panes.length <= 1) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      tabsEl.classList.add("tab-bar-drop-empty");
      tabsEl.querySelectorAll(".tab-pane-drop").forEach((el) =>
        el.classList.remove("tab-pane-drop"),
      );
    }
  }

  function onDragLeave(e: DragEvent) {
    const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
    if (tabBtn) tabBtn.classList.remove("tab-pane-drop");
    if (!tabsEl.contains(e.relatedTarget as Node | null)) {
      tabsEl.classList.remove("tab-bar-drop-empty");
    }
  }

  function onDrop(e: DragEvent) {
    if (dragSrcTabId) {
      e.preventDefault();
      const insertBefore = computeInsertBeforeTab(tabsEl, e.clientX);
      const dstId = insertBefore?.dataset.tabId;
      if (dstId) reorderTab(dragSrcTabId, dstId, true);
      else moveTabToEnd(dragSrcTabId);
      return;
    }
    if (dragSrcPane) {
      const srcR = findPane(dragSrcPane.paneId);
      if (!srcR) return;
      const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
      if (tabBtn) {
        const tid = tabBtn.dataset.tabId ?? "";
        if (tid !== dragSrcPane.tabId) {
          const dst = findTab(tid);
          if (!dst || dst.panes.length >= MAX_PANES_PER_TAB) return;
          e.preventDefault();
          tabBtn.classList.remove("tab-pane-drop");
          movePaneAcrossTabs(srcR.tab.id, srcR.index, dst.id, dst.panes.length);
          return;
        }
        // Same-tab → fall through to extract
      }
      // Empty / same-tab → extract pane to new tab (multi-pane only)
      if (srcR.tab.panes.length <= 1) return;
      e.preventDefault();
      tabsEl.classList.remove("tab-bar-drop-empty");
      extractPaneToNewTab(srcR.tab.id, srcR.index);
    }
  }

  function onDragEnd(e: DragEvent) {
    if (dragSrcTabId) {
      const srcEl = tabsEl.querySelector(`.tab[data-tab-id="${dragSrcTabId}"]`) as HTMLElement | null;
      const srcId = dragSrcTabId;
      srcEl?.classList.remove("tab-dragging");
      dragSrcTabId = null;
      tabsEl.querySelectorAll(".tab-drop-before,.tab-drop-after").forEach((el) =>
        el.classList.remove("tab-drop-before", "tab-drop-after"),
      );
      clearSplitDropZones();
      if (srcId && e.dataTransfer?.dropEffect === "none") {
        void dropTabOut(srcId, e.screenX, e.screenY);
      }
    }
  }

  tabsEl.addEventListener("dragstart", onDragStart);
  tabsEl.addEventListener("dragover", onDragOver);
  tabsEl.addEventListener("dragleave", onDragLeave);
  tabsEl.addEventListener("drop", onDrop);
  tabsEl.addEventListener("dragend", onDragEnd);

  return {
    destroy() {
      tabsEl.removeEventListener("dragstart", onDragStart);
      tabsEl.removeEventListener("dragover", onDragOver);
      tabsEl.removeEventListener("dragleave", onDragLeave);
      tabsEl.removeEventListener("drop", onDrop);
      tabsEl.removeEventListener("dragend", onDragEnd);
    },
  };
}

// ============================================================
// Pane DnD action — attach to #terminals container
// ============================================================
export function paneDnd(node: HTMLElement) {
  const termsEl = node;

  function onDragStart(e: DragEvent) {
    const header = (e.target as HTMLElement).closest(".pane-header") as HTMLElement | null;
    if (!header) return;
    const paneEl = header.closest(".term-pane") as HTMLElement | null;
    if (!paneEl) return;
    const r = findPane(paneEl.dataset.paneId ?? "");
    if (!r) return;
    // Defensive: clear any stale tab-drag state (see tabDnd.onDragStart).
    dragSrcTabId = null;
    dragSrcPane = { tabId: r.tab.id, paneId: r.pane.id };
    paneEl.classList.add("pane-dragging");
    e.dataTransfer?.setData("text/plain", r.pane.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  // Pane → another tab's panes-wrap (split drop) handled here too
  function onDragOver(e: DragEvent) {
    // Tab → another panes-wrap split drop
    if (dragSrcTabId) {
      const wrap = (e.target as HTMLElement).closest(".panes-wrap") as HTMLElement | null;
      if (!wrap) return;
      const targetTabId = wrap.dataset.tabId ?? "";
      if (!targetTabId || targetTabId === dragSrcTabId) return;
      const source = findTab(dragSrcTabId);
      const target = findTab(targetTabId);
      if (!source || !target) return;
      if (target.panes.length + source.panes.length > MAX_PANES_PER_TAB) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearSplitDropZones();
      const rect = wrap.getBoundingClientRect();
      const isLeft = e.clientX < rect.left + rect.width / 2;
      wrap.classList.add(isLeft ? "drop-zone-left" : "drop-zone-right");
      return;
    }
    if (!dragSrcPane) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".pane-drop-before,.pane-drop-after").forEach((el) =>
      el.classList.remove("pane-drop-before", "pane-drop-after"),
    );
    const hoverPane = (e.target as HTMLElement).closest(".term-pane") as HTMLElement | null;
    if (!hoverPane) return;
    if (hoverPane.dataset.paneId === dragSrcPane.paneId) return;
    const rect = hoverPane.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    hoverPane.classList.add(before ? "pane-drop-before" : "pane-drop-after");
  }

  function onDrop(e: DragEvent) {
    // Tab → other panes-wrap split drop
    if (dragSrcTabId) {
      const wrap = (e.target as HTMLElement).closest(".panes-wrap") as HTMLElement | null;
      if (!wrap) return;
      const targetTabId = wrap.dataset.tabId ?? "";
      if (!targetTabId || targetTabId === dragSrcTabId) return;
      const source = findTab(dragSrcTabId);
      const target = findTab(targetTabId);
      if (!source || !target) return;
      if (target.panes.length + source.panes.length > MAX_PANES_PER_TAB) return;
      e.preventDefault();
      clearSplitDropZones();
      const rect = wrap.getBoundingClientRect();
      const isLeft = e.clientX < rect.left + rect.width / 2;
      if (isLeft) {
        let at = 0;
        while (source.panes.length > 0) {
          movePaneAcrossTabs(source.id, 0, target.id, at);
          at++;
        }
      } else {
        while (source.panes.length > 0) {
          movePaneAcrossTabs(source.id, 0, target.id, target.panes.length);
        }
      }
      setActiveTab(target.id);
      return;
    }
    if (!dragSrcPane) return;
    e.preventDefault();
    const hoverPane = (e.target as HTMLElement).closest(".term-pane") as HTMLElement | null;
    if (!hoverPane || hoverPane.dataset.paneId === dragSrcPane.paneId) return;
    const targetPaneId = hoverPane.dataset.paneId ?? "";
    const srcR = findPane(dragSrcPane.paneId);
    const dstR = findPane(targetPaneId);
    if (!srcR || !dstR) return;
    const rect = hoverPane.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    if (srcR.tab === dstR.tab) {
      // Same-tab reorder
      const srcIdx = srcR.index;
      const dstIdx = dstR.index + (before ? 0 : 1);
      const adjusted = dstIdx > srcIdx ? dstIdx - 1 : dstIdx;
      if (adjusted === srcIdx) return;
      reorderPaneStore(srcR.tab.id, srcIdx, adjusted);
    } else {
      if (dstR.tab.panes.length >= MAX_PANES_PER_TAB) return;
      movePaneAcrossTabs(srcR.tab.id, srcR.index, dstR.tab.id, dstR.index + (before ? 0 : 1));
    }
  }

  function onDragEnd(e: DragEvent) {
    if (!dragSrcPane) return;
    const { paneId } = dragSrcPane;
    document.querySelectorAll(".pane-dragging").forEach((el) =>
      el.classList.remove("pane-dragging"),
    );
    document.querySelectorAll(".pane-drop-before,.pane-drop-after").forEach((el) =>
      el.classList.remove("pane-drop-before", "pane-drop-after"),
    );
    document.querySelectorAll(".tab-pane-drop").forEach((el) =>
      el.classList.remove("tab-pane-drop"),
    );
    const effect = e.dataTransfer?.dropEffect ?? "none";
    dragSrcPane = null;
    if (effect === "none") {
      void detachPane(paneId, e.screenX, e.screenY);
    }
  }

  termsEl.addEventListener("dragstart", onDragStart);
  termsEl.addEventListener("dragover", onDragOver);
  termsEl.addEventListener("drop", onDrop);
  termsEl.addEventListener("dragend", onDragEnd);

  return {
    destroy() {
      termsEl.removeEventListener("dragstart", onDragStart);
      termsEl.removeEventListener("dragover", onDragOver);
      termsEl.removeEventListener("drop", onDrop);
      termsEl.removeEventListener("dragend", onDragEnd);
    },
  };
}

// ============================================================
// Global cleanup — capture-phase, runs even if drag source vanished
// ============================================================
export function installGlobalDragCleanup(tabsEl: HTMLElement) {
  // CSS artifact cleanup runs in capture phase (safe, idempotent). But
  // resetting the shared dragSrcTabId / dragSrcPane MUST be deferred —
  // doing it in capture phase would null the state before the bubble-
  // phase dragend handler in tabDnd / paneDnd runs, so the "drop
  // outside any window" path never fires (dropTabOut → detach/merge
  // never gets called). Use setTimeout 0 so the per-action handler
  // sees the live state, then we wipe.
  const onDragEnd = () => {
    clearAllDragArtifacts(tabsEl);
    setTimeout(() => {
      dragSrcTabId = null;
      dragSrcPane = null;
    }, 0);
  };
  const onDrop = () => setTimeout(() => {
    clearAllDragArtifacts(tabsEl);
    dragSrcTabId = null;
    dragSrcPane = null;
  }, 0);
  document.addEventListener("dragend", onDragEnd, { capture: true });
  document.addEventListener("drop", onDrop, { capture: true });
  return () => {
    document.removeEventListener("dragend", onDragEnd, { capture: true });
    document.removeEventListener("drop", onDrop, { capture: true });
  };
}

