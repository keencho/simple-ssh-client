<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "svelte-i18n";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { SerializeAddon } from "@xterm/addon-serialize";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
  import { open as openExternal } from "@tauri-apps/plugin-shell";
  import {
    type PaneData,
    type TabData,
    findPane,
    registerXterm,
    unregisterXterm,
    takePendingOutput,
    takeAdoptedContent,
    setPaneCwd,
    setFocusedPane,
    getSessionHome,
    isSessionHomeInflight,
    markSessionHomeInflight,
    clearSessionHomeInflight,
    setSessionHome,
    getCurrentTheme,
    getCurrentFontFamily,
    FONT_DEFAULT,
    MAX_PANES_PER_TAB,
  } from "../../stores/terminals.svelte";
  import * as Ssh from "../../api/ssh";
  import {
    sendResize,
    focusPane,
    updateWindowTitle,
    closePane,
    toggleZoomForPane,
    setActiveTab,
    isOurShortcut,
    splitActiveSameSession,
    openSessionPicker,
    copyActiveSelection,
    copySelectionFromPane,
    pasteToActive,
  } from "../../terminal/operations";
  import { t } from "../../i18n";
  import { mountContextMenu } from "../modals/mount";
  import { openSftpPanel } from "../../sftp/operations";
  import { TERM_CLOSE_SVG, TERM_ZOOM_OUT_SVG } from "./icons";
  import type { ContextMenuItem } from "../sidebar/types";

  let { pane, tab }: { pane: PaneData; tab: TabData } = $props();

  let paneEl: HTMLElement;
  let xtermEl: HTMLElement;
  let term: Terminal;
  let fit: FitAddon;

  const isFocused = $derived(tab.focusedPaneId === pane.id);
  const isHidden = $derived(tab.zoomedPaneId !== null && tab.zoomedPaneId !== pane.id);
  const isMulti = $derived(tab.panes.length > 1);
  const hasZoom = $derived(tab.zoomedPaneId !== null);
  const flexValue = $derived.by(() => {
    if (hasZoom) return isHidden ? "0 0 0" : "1 1 0";
    const idx = tab.panes.findIndex((p) => p.id === pane.id);
    return `${tab.ratios[idx] ?? 1} 1 0`;
  });

  // 터미널 안의 링크는 반드시 OS에 넘긴다. WebLinksAddon의 기본 동작은
  // window.open()이라 웹뷰가 그 URL로 통째로 이동해버릴 수 있다.
  const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

  function openLink(uri: string) {
    let scheme: string;
    try { scheme = new URL(uri).protocol; }
    catch { return; }
    if (!SAFE_LINK_SCHEMES.has(scheme)) return;
    void openExternal(uri).catch(() => {});
  }

  function triggerHomeFetch(sessionId: string | null | undefined) {
    if (!sessionId) return;
    if (getSessionHome(sessionId) || isSessionHomeInflight(sessionId)) return;
    markSessionHomeInflight(sessionId);
    Ssh.getSessionHome(sessionId)
      .then((home) => { if (home) setSessionHome(sessionId, home); })
      .catch(() => {})
      .finally(() => clearSessionHomeInflight(sessionId));
  }

  onMount(() => {
    term = new Terminal({
      theme: getCurrentTheme().xterm,
      fontFamily: getCurrentFontFamily(),
      fontSize: pane.fontSize ?? FONT_DEFAULT,
      lineHeight: 1.08,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 50000,
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
    });
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // IME 조합 중에는 무조건 xterm에 넘긴다.
      // xterm의 _keyDown은 이 핸들러를 _compositionHelper.keydown()보다 *먼저*
      // 부른다. 여기서 false를 반환하면 CompositionHelper가 통째로 스킵되는데,
      //  - _finalizeComposition(false)로 취소돼야 할 지연 전송이 살아남아 → 글자 중복
      //  - keyCode 229 경로(_handleAnyTextareaChanges)가 안 돌아 → 글자 누락
      // 둘 다 발생한다. 조합 중 키는 전부 xterm이 처리해야 한다.
      if (ev.isComposing || ev.keyCode === 229) return true;
      return !isOurShortcut(ev);
    });

    fit = new FitAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_ev, uri) => openLink(uri)));
    term.loadAddon(serialize);
    // 한글/이모지/조합 문자의 셀 폭을 최신 유니코드 규칙으로 계산한다.
    // 이게 없으면 박스 드로잉과 한글이 섞인 줄에서 폭이 1칸씩 어긋난다.
    term.loadAddon(new UnicodeGraphemesAddon());
    term.unicode.activeVersion = "15-graphemes";
    term.open(xtermEl);

    // WebGL 렌더러는 반드시 open() 이후에 붙인다.
    // 기본 DOM 렌더러는 선택 영역을 마우스 이동마다 span으로 다시 만들기 때문에
    // 드래그 선택과 스크롤이 눈에 띄게 밀린다. WebGL은 텍스처 아틀라스 + GPU라
    // 그 비용이 사라지고, 한글처럼 폭이 다른 글리프도 셀 격자에 맞춰 그린다.
    try {
      const w = new WebglAddon();
      // 컨텍스트 손실(GPU 리셋, 드라이버 갱신 등)은 정상적으로 일어날 수 있다.
      // 이때 addon을 붙들고 있으면 화면이 죽으므로 버린다 — dispose하면
      // xterm이 알아서 DOM 렌더러로 돌아간다.
      w.onContextLoss(() => w.dispose());
      term.loadAddon(w);
    } catch {
      // WebGL을 못 쓰는 환경(원격 데스크톱, 소프트웨어 렌더링 등)에서는
      // 조용히 DOM 렌더러로 둔다. 느릴 뿐 동작에는 문제가 없다.
    }

    registerXterm(pane.id, { term, fit, serialize });

    // ---- 선택 즉시 복사 ----
    // onSelectionChange는 드래그 중 매 프레임 터지므로 쓰지 않는다.
    // 이 페인에서 시작한 드래그의 mouseup만 본다 — 드래그는 페인 밖에서
    // 끝날 수 있으므로 up은 document에서 받는다.
    let selectingHere = false;
    const onXtermMousedown = (e: MouseEvent) => {
      if (e.button === 0) selectingHere = true;
    };
    const onDocMouseup = () => {
      if (!selectingHere) return;
      selectingHere = false;
      void copySelectionFromPane(pane.id);
    };
    xtermEl.addEventListener("mousedown", onXtermMousedown);
    document.addEventListener("mouseup", onDocMouseup);

    // Replay scrollback rescued from a cross-tab move (if any), then drain
    // any output that arrived during the unmount/remount window.
    const adopted = takeAdoptedContent(pane.id);
    if (adopted) term.write(adopted);
    const queued = takePendingOutput(pane.id);
    for (const c of queued) term.write(c);

    // OSC 7 cwd tracking
    term.parser.registerOscHandler(7, (data) => {
      const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
      if (m) {
        try { setPaneCwd(pane.id, decodeURIComponent(m[1])); }
        catch { setPaneCwd(pane.id, m[1]); }
      }
      return false;
    });

    // OSC 0/2 window title fallback (e.g. "user@host: ~/path")
    term.onTitleChange((title) => {
      const m = title.match(/^[^:@\s]+@[^:]+:\s*(.+)$/);
      if (!m) return;
      let path = m[1].trim();
      if (path.startsWith("~")) {
        const home = getSessionHome(pane.sessionId ?? "");
        if (home) path = home + path.slice(1);
        else { triggerHomeFetch(pane.sessionId); return; }
      }
      if (path.startsWith("/")) setPaneCwd(pane.id, path);
    });

    // PTY input → broadcast-aware write
    term.onData((data) => {
      const r = findPane(pane.id);
      if (!r || r.pane.exited) return;
      const bytes = Array.from(new TextEncoder().encode(data));
      if (r.tab.broadcast) {
        for (const p of r.tab.panes) {
          if (!p.exited) void Ssh.ptyWrite(p.id, bytes);
        }
      } else {
        void Ssh.ptyWrite(pane.id, bytes);
      }
    });

    const ro = new ResizeObserver(() => {
      if (pane.exited) return;
      if (paneEl.offsetWidth <= 0 || paneEl.offsetHeight <= 0) return;
      try { fit.fit(); } catch {}
      sendResize(pane.id);
    });
    ro.observe(paneEl);

    requestAnimationFrame(() => {
      if (pane.exited) return;
      try { fit.fit(); } catch {}
      sendResize(pane.id);
    });

    return () => {
      ro.disconnect();
      xtermEl.removeEventListener("mousedown", onXtermMousedown);
      document.removeEventListener("mouseup", onDocMouseup);
      unregisterXterm(pane.id);
      // WebGL addon은 term.dispose()가 같이 정리한다.
      try { term.dispose(); } catch {}
    };
  });

  function handlePaneMousedown() {
    const r = findPane(pane.id);
    if (!r) return;
    if (r.tab.focusedPaneId !== pane.id) {
      setFocusedPane(r.tab.id, pane.id);
      term.focus();
      sendResize(pane.id);
      updateWindowTitle();
    }
  }

  function handleZoomClick(e: MouseEvent) {
    e.stopPropagation();
    const r = findPane(pane.id);
    if (r) toggleZoomForPane(r.tab.id, pane.id);
  }

  function handleCloseClick(e: MouseEvent) {
    e.stopPropagation();
    void closePane(pane.id);
  }

  function handleHeaderDblClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(".pane-header-btn")) return;
    const r = findPane(pane.id);
    if (r) toggleZoomForPane(r.tab.id, pane.id);
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const onXterm = !!target.closest(".pane-xterm");
    const r = findPane(pane.id);
    if (!r) return;
    setActiveTab(r.tab.id);
    setFocusedPane(r.tab.id, pane.id);

    const items: ContextMenuItem[] = [];
    if (onXterm) {
      const hasSel = term.hasSelection();
      items.push({
        label: t("terminal.menu.copy") + (hasSel ? "" : t("terminal.menu.copyNoSelection")),
        action: () => {
          void copyActiveSelection().then((ok) => { if (ok) term.clearSelection(); });
        },
      });
      items.push({ label: t("terminal.menu.paste"), action: () => void pasteToActive() });
      items.push({ label: "-", action: () => {} });
    }
    if (r.tab.panes.length < MAX_PANES_PER_TAB && pane.sshArgs.length > 0) {
      items.push({ label: t("terminal.menu.splitVerticalSame"), action: () => splitActiveSameSession() });
      items.push({ label: t("terminal.menu.splitVerticalOther"), action: () => void openSessionPicker() });
      items.push({ label: "-", action: () => {} });
    }
    if (pane.sessionId) {
      if (pane.cwd) {
        const display = pane.cwd.length > 40 ? "..." + pane.cwd.slice(-37) : pane.cwd;
        items.push({
          label: t("terminal.menu.sftpOpenWithCwd", { path: display }),
          action: () => void openSftpPanel(pane.sessionId!, pane.cwd!, pane.baseTitle),
        });
      }
      items.push({ label: t("terminal.menu.sftpOpenHome"), action: () => void openSftpPanel(pane.sessionId!, undefined, pane.baseTitle) });
      items.push({ label: "-", action: () => {} });
    }
    items.push({
      label: r.tab.zoomedPaneId === pane.id
        ? t("terminal.menu.fullscreenExit")
        : t("terminal.menu.fullscreen"),
      action: () => toggleZoomForPane(r.tab.id, pane.id),
    });
    items.push({ label: "-", action: () => {} });
    items.push({ label: t("terminal.menu.closePane"), action: () => void closePane(pane.id), danger: true });
    mountContextMenu(e.clientX, e.clientY, items);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="term-pane"
  class:pane-focused={isFocused}
  class:pane-hidden={isHidden}
  data-pane-id={pane.id}
  bind:this={paneEl}
  style="flex: {flexValue}"
  onmousedown={handlePaneMousedown}
  oncontextmenu={handleContextMenu}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="pane-header"
    class:pane-header-visible={isMulti || hasZoom}
    class:pane-exited={pane.exited}
    draggable="true"
    ondblclick={handleHeaderDblClick}
  >
    <span class="pane-header-title">{pane.title}</span>
    <span class="pane-header-actions">
      <button
        class="pane-header-btn pane-header-zoom"
        title={$_("terminal.pane.zoom")}
        onclick={handleZoomClick}
      >{@html TERM_ZOOM_OUT_SVG}</button>
      <button
        class="pane-header-btn pane-header-close"
        title={$_("terminal.pane.close")}
        onclick={handleCloseClick}
      >{@html TERM_CLOSE_SVG}</button>
    </span>
  </div>
  <div class="pane-xterm" bind:this={xtermEl}></div>
</div>
