<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "svelte-i18n";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import {
    terminalStore,
    findPane,
    bufferPendingOutput,
    getXterm,
    setPaneExited,
  } from "../../stores/terminals.svelte";
  import {
    addTab,
    applyThemeName,
    applyFontName,
    fitPane,
    updateWindowTitle,
    isMainWindow,
    myWindowLabel,
    handleShortcut,
    setCopyOnSelectFlag,
    adjustActiveFontSize,
    startDividerDrag,
    resetDividerToCenter,
  } from "../../terminal/operations";
  import * as Ssh from "../../api/ssh";
  import * as Config from "../../api/config";
  import { t, onLanguageChanged } from "../../i18n";
  import type { AddTabPayload, MergeTabPayload, PtyOutput, PtyExit } from "../../api/types";
  import { tabDnd, paneDnd, installGlobalDragCleanup } from "../../dnd/terminalDnd";
  import Tab from "./Tab.svelte";
  import Pane from "./Pane.svelte";
  import Toast from "../ui/Toast.svelte";

  // Scope add-tab / merge-tab to this window's label
  const scoped = { target: { kind: "AnyLabel" as const, label: myWindowLabel } };

  let tabsEl: HTMLElement;
  let termsEl: HTMLElement;

  const showWelcome = $derived(isMainWindow && terminalStore.tabs.length === 0);
  let pullOutHint = $state(t("terminal.tab.pullOutHint"));

  onMount(() => {
    const unlisteners: Array<() => void> = [];

    // ---------- PTY routing ----------
    void listen<PtyOutput>("pty-output", (event) => {
      const data = new Uint8Array(event.payload.data);
      const r = findPane(event.payload.terminal_id);
      if (r) {
        const x = getXterm(event.payload.terminal_id);
        if (x) x.term.write(data);
        else bufferPendingOutput(event.payload.terminal_id, data);
      } else {
        bufferPendingOutput(event.payload.terminal_id, data);
      }
    }).then((u) => unlisteners.push(u));

    void listen<PtyExit>("pty-exit", (event) => {
      const r = findPane(event.payload.terminal_id);
      if (!r) return;
      setPaneExited(event.payload.terminal_id, true);
      const x = getXterm(event.payload.terminal_id);
      if (x) x.term.writeln(`\r\n\x1b[1;33m${t("terminal.errors.sessionEnded")}\x1b[0m`);
    }).then((u) => unlisteners.push(u));

    // ---------- Theme / Font hot-swap ----------
    void listen<string>("terminal-theme-changed", (event) => {
      applyThemeName(event.payload);
    }).then((u) => unlisteners.push(u));

    void listen<string>("terminal-font-changed", (event) => {
      applyFontName(event.payload);
    }).then((u) => unlisteners.push(u));

    // 분리된 터미널 창은 자기 프로세스가 아니므로 설정 변경을 이벤트로 받는다.
    void listen<boolean>("copy-on-select-changed", (event) => {
      setCopyOnSelectFlag(event.payload);
    }).then((u) => unlisteners.push(u));

    // ---------- Add / merge tab ----------
    void listen<AddTabPayload>("add-tab", (event) => {
      void addTab(event.payload);
    }, scoped).then((u) => unlisteners.push(u));

    void listen<MergeTabPayload>("merge-tab", async (event) => {
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
    }, scoped).then((u) => unlisteners.push(u));

    // ---------- Window resize → fit active panes ----------
    let resizeTimer: number | undefined;
    const onResize = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const t = terminalStore.activeTab;
        if (!t) return;
        for (const p of t.panes) {
          if (!p.exited) fitPane(p.id);
        }
      }, 50);
    };
    window.addEventListener("resize", onResize);
    unlisteners.push(() => window.removeEventListener("resize", onResize));

    // ---------- Keyboard shortcuts (capture phase to beat xterm) ----------
    const onKeydown = (e: KeyboardEvent) => {
      // IME 조합 중에는 손대지 않는다: 조합 중에도 e.code는 물리 키 그대로라
      // 단축키로 오인해 preventDefault()를 부르면 한글 조합이 깨진다.
      if (e.isComposing || e.keyCode === 229) return;
      // 진짜 입력 필드(세션 모달, 설정, 세션 피커 검색창 등)에 포커스가 있으면
      // 손대지 않는다. 안 그러면 Ctrl+V가 입력창이 아니라 PTY로 가버린다.
      // xterm의 숨은 textarea는 예외 — 그건 터미널 입력이다.
      const target = e.target as HTMLElement | null;
      if (target
          && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
          && !target.classList.contains("xterm-helper-textarea")) return;
      handleShortcut(e);
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    unlisteners.push(() => document.removeEventListener("keydown", onKeydown, { capture: true }));

    // ---------- Ctrl+wheel font zoom ----------
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      adjustActiveFontSize(e.deltaY > 0 ? -1 : 1);
    };
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    unlisteners.push(() => document.removeEventListener("wheel", onWheel, { capture: true }));

    // ---------- Divider pointer interactions ----------
    const onTermsPointerDown = (e: PointerEvent) => {
      const div = (e.target as HTMLElement).closest(".pane-divider") as HTMLElement | null;
      if (!div) return;
      const tabId = div.dataset.tabId ?? "";
      const leftIdx = Number(div.dataset.leftIdx);
      if (!tabId || Number.isNaN(leftIdx)) return;
      e.preventDefault();
      startDividerDrag(tabId, leftIdx, e.clientX);
    };
    const onTermsDblClick = (e: MouseEvent) => {
      const div = (e.target as HTMLElement).closest(".pane-divider") as HTMLElement | null;
      if (!div) return;
      const tabId = div.dataset.tabId ?? "";
      const leftIdx = Number(div.dataset.leftIdx);
      if (!tabId || Number.isNaN(leftIdx)) return;
      resetDividerToCenter(tabId, leftIdx);
    };
    termsEl.addEventListener("pointerdown", onTermsPointerDown);
    termsEl.addEventListener("dblclick", onTermsDblClick);
    unlisteners.push(() => {
      termsEl.removeEventListener("pointerdown", onTermsPointerDown);
      termsEl.removeEventListener("dblclick", onTermsDblClick);
    });

    // ---------- Global drag cleanup ----------
    unlisteners.push(installGlobalDragCleanup(tabsEl));

    // ---------- Language change → refresh tab-bar empty hint ----------
    const offLang = onLanguageChanged(() => {
      pullOutHint = t("terminal.tab.pullOutHint");
    });
    unlisteners.push(offLang);

    // ---------- Window close: kill all PTYs ----------
    let unlistenClose: (() => void) | null = null;
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (terminalStore.tabs.length === 0) return;
      event.preventDefault();
      for (const tab of terminalStore.tabs) {
        for (const p of tab.panes) {
          try { await Ssh.ptyKill(p.id); } catch {}
        }
      }
      await getCurrentWindow().destroy();
    }).then((u) => { unlistenClose = u; });

    // ---------- Bootstrap ----------
    (async () => {
      try {
        const savedTheme = await Config.getTerminalTheme();
        if (savedTheme) applyThemeName(savedTheme);
        const savedFont = await Config.getTerminalFont();
        if (savedFont) applyFontName(savedFont);
        setCopyOnSelectFlag(await Config.getCopyOnSelect());
        const initial = await Ssh.ptyTakePending(myWindowLabel);
        if (initial) await addTab(initial);
      } catch (e) {
        console.error("terminal bootstrap failed:", e);
      }
    })();

    return () => {
      for (const u of unlisteners) u();
      if (unlistenClose) unlistenClose();
    };
  });

</script>

<div id="tabs" bind:this={tabsEl} data-empty-text={pullOutHint} use:tabDnd>
  {#each terminalStore.tabs as tab (tab.id)}
    <Tab {tab} />
  {/each}
</div>
<div id="terminals" bind:this={termsEl} use:paneDnd>
  {#each terminalStore.tabs as tab (tab.id)}
    <div
      class="panes-wrap"
      class:active={terminalStore.activeTabId === tab.id}
      class:multi={tab.panes.length > 1}
      class:zoomed={tab.zoomedPaneId !== null}
      class:broadcast={tab.broadcast}
      data-tab-id={tab.id}
    >
      {#each tab.panes as pane, i (pane.id)}
        <Pane {pane} {tab} />
        {#if tab.zoomedPaneId === null && i < tab.panes.length - 1}
          <div class="pane-divider" data-left-idx={i} data-tab-id={tab.id}></div>
        {/if}
      {/each}
    </div>
  {/each}
  {#if showWelcome}
    <div id="welcome-screen" class="welcome-screen">
      <h1>{$_("welcome.title")}</h1>
      <p>{@html $_("welcome.body")}</p>
    </div>
  {/if}
</div>
<Toast />
