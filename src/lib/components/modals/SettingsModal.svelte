<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "svelte-i18n";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { open as openExternal } from "@tauri-apps/plugin-shell";
  import {
    THEMES, THEME_ORDER, THEME_GROUPS, DEFAULT_THEME,
    FONTS, DEFAULT_FONT, getFontValue,
    type TerminalTheme, type FontOption,
  } from "../../../themes";
  import {
    GENERIC_FONT_FAMILIES, parseFontStack, isFontInstalled, resolveActualFont,
  } from "../../fonts";
  import { ICONS } from "../../icons";
  import { getLanguage, setLanguage, type Lang } from "../../i18n";
  import * as Config from "../../api/config";
  import * as Data from "../../api/data";
  import { mountConfirm } from "./mount";

  type SidebarPosition = "left" | "right";
  type Section = "font" | "theme" | "terminal" | "layout" | "log" | "data";

  let {
    initialSection,
    sidebarPosition,
    onSidebarPositionChange,
    onLanguageSwitch,
    onDataReloaded,
    onAlert,
    onClose,
  }: {
    initialSection: Section;
    sidebarPosition: SidebarPosition;
    onSidebarPositionChange: (pos: SidebarPosition) => void;
    onLanguageSwitch: (lang: Lang) => void;
    onDataReloaded: () => void;
    onAlert: (msg: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let section = $state<Section>(initialSection);

  // Pre-loaded values
  let currentThemeName = $state<string>(DEFAULT_THEME);
  let currentFontName = $state<string>(DEFAULT_FONT);
  let currentLogDir = $state<string>("");
  let currentSshVerbose = $state<boolean>(false);
  let currentCopyOnSelect = $state<boolean>(false);
  let currentDataPath = $state<string>("");
  let lang = $state<Lang>(getLanguage());
  // svelte-ignore state_referenced_locally
  let pos = $state<SidebarPosition>(sidebarPosition);
  let loaded = $state<boolean>(false);

  onMount(() => {
    void (async () => {
      [currentThemeName, currentFontName, currentLogDir, currentSshVerbose, currentDataPath, currentCopyOnSelect] =
        await Promise.all([
          Config.getTerminalTheme().then((v) => v ?? DEFAULT_THEME),
          Config.getTerminalFont().then((v) => v ?? DEFAULT_FONT),
          Config.getLogDir(),
          Config.getSshVerbose(),
          Config.getDataFilePath(),
          Config.getCopyOnSelect(),
        ]);
      loaded = true;
      void updateFontUI(currentFontName);
    })();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") doClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.getElementById("settings-font-cdn-link")?.remove();
    };
  });

  function handleOverlayMouseDown(e: MouseEvent) {
    if (e.target === e.currentTarget) doClose();
  }

  function doClose() {
    document.getElementById("settings-font-cdn-link")?.remove();
    onClose();
  }

  // --- Theme grouping ---
  const rankMap = new Map<string, number>();
  THEME_ORDER.forEach((n, i) => rankMap.set(n, i + 1));

  function selectTheme(name: string) {
    if (name === currentThemeName) return;
    currentThemeName = name;
    Config.setTerminalTheme(name).catch((err) =>
      void onAlert($_("settings.theme.errors.apply", { values: { error: String(err) } })),
    );
  }

  // --- Font grouping ---
  const bundledFonts: FontOption[] = [];
  const installedFonts: FontOption[] = [];
  const missingFonts: FontOption[] = [];
  for (const f of FONTS) {
    if (f.bundled) { bundledFonts.push(f); continue; }
    const primary = parseFontStack(f.value).find((n) => !GENERIC_FONT_FAMILIES.has(n));
    if (primary && isFontInstalled(primary)) installedFonts.push(f);
    else missingFonts.push(f);
  }

  let fontStatusCls = $state("");
  let fontStatusText = $state("");
  let fontInstallUrl = $state<string | null>(null);
  let fontSampleStyle = $state("");

  function setCdnPreview(url: string | null) {
    const existing = document.getElementById("settings-font-cdn-link") as HTMLLinkElement | null;
    if (!url) { existing?.remove(); return; }
    if (existing && existing.href === url) return;
    existing?.remove();
    const link = document.createElement("link");
    link.id = "settings-font-cdn-link";
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  }

  async function updateFontUI(label: string) {
    const entry = FONTS.find((f) => f.label === label);
    const value = entry?.value ?? getFontValue(label);
    const primary = parseFontStack(value).find((n) => !GENERIC_FONT_FAMILIES.has(n)) ?? label;
    const installed = entry?.bundled || (primary && isFontInstalled(primary));

    if (!entry?.bundled && !installed && entry?.cdnUrl) {
      setCdnPreview(entry.cdnUrl);
      try { await (document as any).fonts.load(`12px "${primary}"`); } catch {}
    } else {
      setCdnPreview(null);
    }

    fontSampleStyle = `font-family: ${value}`;

    const r = resolveActualFont(value);
    const nowAvailable = entry?.bundled || (r.actual === r.primary);
    const isCdnPreview = !entry?.bundled && !installed && !!entry?.cdnUrl;

    if (entry?.bundled) {
      fontStatusCls = "installed";
      fontStatusText = $_("settings.font.status.bundled", { values: { name: r.primary } });
    } else if (nowAvailable && !isCdnPreview) {
      fontStatusCls = "installed";
      fontStatusText = $_("settings.font.status.installed", { values: { name: r.primary } });
    } else if (isCdnPreview) {
      fontStatusCls = "cdn";
      fontStatusText = $_("settings.font.status.cdnPreview");
    } else if (r.actual) {
      fontStatusCls = "missing";
      fontStatusText = $_("settings.font.status.fallback", { values: { primary: r.primary, actual: r.actual } });
    } else {
      fontStatusCls = "missing";
      fontStatusText = $_("settings.font.status.fallbackDefault", { values: { primary: r.primary } });
    }

    fontInstallUrl = entry?.installUrl && !entry.bundled && (!installed || isCdnPreview)
      ? entry.installUrl
      : null;
  }

  async function onFontChange() {
    await updateFontUI(currentFontName);
    try { await Config.setTerminalFont(currentFontName); }
    catch (err) { void onAlert($_("settings.font.errors.apply", { values: { error: String(err) } })); }
  }

  async function openInstallLink() {
    if (!fontInstallUrl) return;
    try { await openExternal(fontInstallUrl); }
    catch (err) { void onAlert($_("settings.font.errors.openLink", { values: { error: String(err) } })); }
  }

  // --- Layout ---
  function onSidebarPosChange(value: string) {
    const p = value as SidebarPosition;
    pos = p;
    onSidebarPositionChange(p);
  }

  function onLangChange(value: string) {
    const l = value as Lang;
    lang = l;
    setLanguage(l);
    onLanguageSwitch(l);
  }

  // --- Log ---
  async function logOpenFolder() {
    try { await Config.openPathInOs(currentLogDir); }
    catch (err) { void onAlert($_("settings.log.errors.openFolder", { values: { error: String(err) } })); }
  }
  async function logChangeDir() {
    try {
      const picked = await open({ directory: true, multiple: false, title: $_("settings.log.dialog.changeFolder") });
      if (typeof picked !== "string") return;
      currentLogDir = await Config.setLogDir(picked);
    } catch (err) { void onAlert($_("settings.log.errors.changeDir", { values: { error: String(err) } })); }
  }
  async function logResetDir() {
    try { currentLogDir = await Config.setLogDir(null); }
    catch (err) { void onAlert($_("settings.log.errors.resetDir", { values: { error: String(err) } })); }
  }
  async function logClear() {
    if (!await mountConfirm(
      $_("settings.log.dialog.deleteConfirm.body", { values: { path: currentLogDir } }),
      $_("settings.log.dialog.deleteConfirm.title"),
    )) return;
    try {
      const n = await Config.clearLogs();
      await onAlert($_("settings.log.dialog.deleted", { values: { count: n } }));
    } catch (err) { void onAlert($_("settings.log.errors.clear", { values: { error: String(err) } })); }
  }
  async function onSshVerboseChange() {
    try { await Config.setSshVerbose(currentSshVerbose); }
    catch (err) { void onAlert($_("settings.log.errors.verbose", { values: { error: String(err) } })); }
  }

  // --- Terminal ---
  async function onCopyOnSelectChange() {
    try { await Config.setCopyOnSelect(currentCopyOnSelect); }
    catch (err) { void onAlert(String(err)); }
  }

  // --- Data ---
  const parentOf = (p: string) => p.replace(/[\\/][^\\/]+$/, "") || p;

  async function dataOpenFolder() {
    try { await Config.openPathInOs(parentOf(currentDataPath)); }
    catch (err) { void onAlert($_("settings.data.errors.openFolder", { values: { error: String(err) } })); }
  }
  async function dataChange() {
    try {
      const picked = await open({ multiple: false, title: $_("settings.data.dialog.changeFile"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      currentDataPath = await Config.setDataFilePath(picked);
      onDataReloaded();
    } catch (err) { void onAlert($_("settings.data.errors.changeFile", { values: { error: String(err) } })); }
  }
  async function dataReset() {
    try {
      currentDataPath = await Config.setDataFilePath(null);
      onDataReloaded();
    } catch (err) { void onAlert($_("settings.data.errors.resetFile", { values: { error: String(err) } })); }
  }
  async function dataExport() {
    try {
      const picked = await save({ defaultPath: "simple-ssh-client-sessions.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      await Data.exportSessionsTo(picked);
      await onAlert($_("settings.data.dialog.exported", { values: { path: picked } }));
    } catch (err) { void onAlert($_("settings.data.errors.export", { values: { error: String(err) } })); }
  }
  async function dataImport() {
    try {
      const picked = await open({ multiple: false, title: $_("settings.data.dialog.importFile"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      if (!await mountConfirm(
        $_("settings.data.dialog.importConfirm.body"),
        $_("settings.data.dialog.importConfirm.title"),
      )) return;
      await Data.importSessionsFrom(picked);
      onDataReloaded();
      await onAlert($_("settings.data.dialog.imported"));
    } catch (err) { void onAlert($_("settings.data.errors.import", { values: { error: String(err) } })); }
  }
</script>

<div class="modal-overlay" role="presentation" onmousedown={handleOverlayMouseDown}>
  <div class="modal modal-settings">
    <header class="settings-header">
      <div class="settings-title">{$_("settings.title")}</div>
      <button class="settings-close" title={$_("settings.close")} onclick={doClose} aria-label="close">{@html ICONS.close}</button>
    </header>
    <div class="settings-body">
      <aside class="settings-nav">
        <button class="settings-nav-item" class:active={section === "font"} onclick={() => (section = "font")}>{$_("settings.nav.font")}</button>
        <button class="settings-nav-item" class:active={section === "theme"} onclick={() => (section = "theme")}>{$_("settings.nav.theme")}</button>
        <button class="settings-nav-item" class:active={section === "terminal"} onclick={() => (section = "terminal")}>{$_("settings.nav.terminal")}</button>
        <button class="settings-nav-item" class:active={section === "layout"} onclick={() => (section = "layout")}>{$_("settings.nav.layout")}</button>
        <button class="settings-nav-item" class:active={section === "log"} onclick={() => (section = "log")}>{$_("settings.nav.log")}</button>
        <button class="settings-nav-item" class:active={section === "data"} onclick={() => (section = "data")}>{$_("settings.nav.data")}</button>
      </aside>
      <div class="settings-content">
        <!-- Font -->
        <section class="settings-panel" hidden={section !== "font"}>
          <div class="settings-panel-title">{$_("settings.font.title")}</div>
          <div class="settings-panel-subtitle">{$_("settings.font.subtitle")}</div>
          {#if loaded}
            <select class="settings-select" bind:value={currentFontName} onchange={onFontChange}>
              {#if bundledFonts.length}
                <optgroup label={$_("settings.font.optgroup.bundled")}>
                  {#each bundledFonts as f (f.label)}<option value={f.label}>{f.label}</option>{/each}
                </optgroup>
              {/if}
              {#if installedFonts.length}
                <optgroup label={$_("settings.font.optgroup.installed")}>
                  {#each installedFonts as f (f.label)}<option value={f.label}>{f.label}</option>{/each}
                </optgroup>
              {/if}
              {#if missingFonts.length}
                <optgroup label={$_("settings.font.optgroup.missing")}>
                  {#each missingFonts as f (f.label)}<option value={f.label}>{f.label}</option>{/each}
                </optgroup>
              {/if}
            </select>
          {/if}
          <div class="settings-font-status {fontStatusCls}">
            <span class="settings-font-status-text">{fontStatusText}</span>
            {#if fontInstallUrl}
              <button class="settings-font-install-btn" onclick={openInstallLink}>{$_("settings.font.installBtn")}</button>
            {/if}
          </div>
          <pre class="settings-font-sample" style={fontSampleStyle}>[ec2-user@host ~]$ ls -la | grep foo
drwxr-xr-x  user  1024  2026-04-20  documents/
-rw-r--r--  user  2048  2026-04-20  readme.md
The quick brown fox jumps over 0123456789 (&lbrace;[]&rbrace;) "`~$"</pre>
        </section>

        <!-- Theme -->
        <section class="settings-panel" hidden={section !== "theme"}>
          <div class="settings-panel-title">{$_("settings.theme.title")}</div>
          <div class="settings-panel-subtitle">{$_("settings.theme.subtitle")}</div>
          <div class="theme-groups">
            {#each THEME_GROUPS as g}
              <div class="theme-group">
                <div class="theme-group-header">
                  <span class="theme-group-label">{$_(g.label)}</span>
                  <span class="theme-group-count">{g.names.length}</span>
                </div>
                <div class="theme-grid">
                  {#each g.names as n (n)}
                    {@const theme = THEMES[n] as TerminalTheme}
                    {@const x = theme.xterm}
                    {@const selected = theme.name === currentThemeName}
                    {@const rank = rankMap.get(theme.name) ?? 0}
                    <div
                      class="theme-card"
                      class:selected
                      style="background:{x.background}; border-color:{selected ? theme.ui.accent : 'transparent'}"
                      role="button"
                      tabindex="0"
                      onclick={() => selectTheme(theme.name)}
                      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") selectTheme(theme.name); }}
                    >
                      <div class="theme-card-rank" style="color:{theme.ui.fgDim}; border-color:{theme.ui.border}">#{rank}</div>
                      <div class="theme-card-header">
                        <span class="theme-card-title" style="color:{x.foreground}">{theme.displayName}</span>
                        <span class="theme-card-check" style="color:{theme.ui.accent}; visibility:{selected ? 'visible' : 'hidden'}">{@html ICONS.check}</span>
                      </div>
                      <div class="theme-card-sample" style="color:{x.foreground}">
                        <div><span style="color:{x.green}">$</span> <span style="color:{x.blue}">ls</span> <span style="color:{x.cyan}">-la</span></div>
                        <div><span style="color:{x.magenta}">drwxr-xr-x</span> <span style="color:{x.foreground}">user</span> <span style="color:{x.yellow}">docs</span></div>
                      </div>
                      <div class="theme-card-dots">
                        <span class="theme-dot" style="background:{x.red}"></span>
                        <span class="theme-dot" style="background:{x.green}"></span>
                        <span class="theme-dot" style="background:{x.yellow}"></span>
                        <span class="theme-dot" style="background:{x.blue}"></span>
                        <span class="theme-dot" style="background:{x.magenta}"></span>
                        <span class="theme-dot" style="background:{x.cyan}"></span>
                      </div>
                      <div class="theme-card-blurb">{$_(theme.blurb ?? "")}</div>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        </section>

        <!-- Layout -->
        <section class="settings-panel" hidden={section !== "layout"}>
          <div class="settings-panel-title">{$_("settings.layout.title")}</div>
          <div class="settings-panel-subtitle">{$_("settings.layout.subtitle")}</div>
          <div class="settings-radio-group">
            <label class="settings-radio-label">
              <input type="radio" name="sidebar-pos" value="left" checked={pos === "left"} onchange={(e) => onSidebarPosChange((e.currentTarget as HTMLInputElement).value)} />
              <span>{$_("settings.layout.sidebarPos.left")}</span>
            </label>
            <label class="settings-radio-label">
              <input type="radio" name="sidebar-pos" value="right" checked={pos === "right"} onchange={(e) => onSidebarPosChange((e.currentTarget as HTMLInputElement).value)} />
              <span>{$_("settings.layout.sidebarPos.right")}</span>
            </label>
          </div>

          <div class="settings-divider"></div>

          <div class="settings-row-label">{$_("settings.layout.language.title")}</div>
          <div class="settings-panel-hint">{$_("settings.layout.language.subtitle")}</div>
          <div class="settings-radio-group">
            <label class="settings-radio-label">
              <input type="radio" name="lang" value="en" checked={lang === "en"} onchange={(e) => onLangChange((e.currentTarget as HTMLInputElement).value)} />
              <span>{$_("settings.layout.language.en")}</span>
            </label>
            <label class="settings-radio-label">
              <input type="radio" name="lang" value="ko" checked={lang === "ko"} onchange={(e) => onLangChange((e.currentTarget as HTMLInputElement).value)} />
              <span>{$_("settings.layout.language.ko")}</span>
            </label>
          </div>
        </section>

        <!-- Terminal -->
        <section class="settings-panel" hidden={section !== "terminal"}>
          <div class="settings-panel-title">{$_("settings.terminal.title")}</div>
          <div class="settings-panel-subtitle">{$_("settings.terminal.subtitle")}</div>

          <label class="settings-toggle-row">
            <input type="checkbox" bind:checked={currentCopyOnSelect} onchange={onCopyOnSelectChange} />
            <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
            <span class="settings-toggle-text">{@html $_("settings.terminal.copyOnSelectToggle")}</span>
          </label>
          <div class="settings-panel-hint">{$_("settings.terminal.copyOnSelectHint")}</div>
        </section>

        <!-- Log -->
        <section class="settings-panel" hidden={section !== "log"}>
          <div class="settings-panel-title">{$_("settings.log.title")}</div>
          <div class="settings-panel-subtitle">{$_("settings.log.subtitle")}</div>

          <div class="settings-row-label">{$_("settings.log.folderLabel")}</div>
          <div class="settings-path-row">
            <code class="settings-path">{currentLogDir}</code>
          </div>
          <div class="settings-btn-row">
            <button class="btn-secondary-sm" onclick={logOpenFolder}>{@html ICONS.folderOpen}<span>{$_("settings.log.openFolder")}</span></button>
            <button class="btn-secondary-sm" onclick={logChangeDir}>{@html ICONS.edit}<span>{$_("settings.log.changeDir")}</span></button>
            <button class="btn-secondary-sm" onclick={logResetDir}>{$_("settings.log.resetDir")}</button>
            <button class="btn-secondary-sm" style="margin-left:auto" onclick={logClear}>{@html ICONS.trash}<span>{$_("settings.log.clearAll")}</span></button>
          </div>

          <div class="settings-divider"></div>

          <div class="settings-row-label">{$_("settings.log.verboseLabel")}</div>
          <label class="settings-toggle-row">
            <input type="checkbox" bind:checked={currentSshVerbose} onchange={onSshVerboseChange} />
            <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
            <span class="settings-toggle-text">{@html $_("settings.log.verboseToggle")}</span>
          </label>
          <div class="settings-panel-hint">{$_("settings.log.verboseHint")}</div>
        </section>

        <!-- Data -->
        <section class="settings-panel" hidden={section !== "data"}>
          <div class="settings-panel-title">{$_("settings.data.title")}</div>
          <div class="settings-panel-subtitle">{$_("settings.data.subtitle")}</div>

          <div class="settings-row-label">{$_("settings.data.currentFile")}</div>
          <div class="settings-path-row">
            <code class="settings-path">{currentDataPath}</code>
          </div>
          <div class="settings-btn-row">
            <button class="btn-secondary-sm" onclick={dataOpenFolder}>{@html ICONS.folderOpen}<span>{$_("settings.data.openFolder")}</span></button>
            <button class="btn-secondary-sm" onclick={dataChange}>{@html ICONS.edit}<span>{$_("settings.data.changeFile")}</span></button>
            <button class="btn-secondary-sm" onclick={dataReset}>{$_("settings.data.resetFile")}</button>
          </div>
          <div class="settings-panel-hint">{$_("settings.data.changeHint")}</div>

          <div class="settings-divider"></div>

          <div class="settings-row-label">{$_("settings.data.exportImport")}</div>
          <div class="settings-btn-row">
            <button class="btn-secondary-sm" onclick={dataExport}>{@html ICONS.download}<span>{$_("settings.data.export")}</span></button>
            <button class="btn-secondary-sm" onclick={dataImport}>{@html ICONS.upload}<span>{$_("settings.data.import")}</span></button>
          </div>
          <div class="settings-panel-hint">{$_("settings.data.exportImportHint")}</div>
        </section>
      </div>
    </div>
  </div>
</div>
