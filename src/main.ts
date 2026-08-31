import { mount } from "svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getTheme, applyUiTheme } from "./themes";
import App from "./App.svelte";
import TerminalWindow from "./TerminalWindow.svelte";
import { t } from "./lib/i18n";
import * as Data from "./lib/api/data";
import * as Ssh from "./lib/api/ssh";
import * as Config from "./lib/api/config";
import type { SshSession } from "./lib/api/types";
import { mountAlert, mountConfirm, mountSession, mountSettings, mountPasswordPrompt } from "./lib/components/modals/mount";
import { mountInputPrompt } from "./lib/components/modals/inputPrompt";
import { openSftpPanel } from "./lib/sftp/operations";
import { dataStore, setData, loadData as loadDataStore, getSortedFolders } from "./lib/stores/data.svelte";
import { ui } from "./lib/stores/ui.svelte";
import type { SidebarActions } from "./lib/components/sidebar/types";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import "./terminal.css";

// Block browser default context menu (Inspect / Reload / etc.)
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Route by window label: terminal-only windows mount TerminalWindow,
// main window mounts the full App shell (sidebar + terminal area).
const IS_TERMINAL_WINDOW = getCurrentWindow().label.startsWith("term-");
if (IS_TERMINAL_WINDOW) {
  // Apply body class BEFORE mount so flex layout is in place at first paint;
  // doing this in TerminalWindow.onMount ran too late and #terminals collapsed
  // to height 0, hiding xterm.
  document.body.classList.add("terminal-window");
  const target = document.getElementById("app")!;
  target.innerHTML = "";
  mount(TerminalWindow, { target });
  // Reveal window after mount (visible:false in tauri.conf.json).
  void getCurrentWindow().show();
}

// Sidebar/welcome/tree strings are all reactive (svelte-i18n $_ store).
// SFTP panels are now Svelte components — i18n labels react automatically.

// --- Custom Dialogs ---

function customAlert(message: string): Promise<void> {
  return mountAlert(message);
}

function customConfirm(message: string, title?: string): Promise<boolean> {
  return mountConfirm(message, title);
}

function customPrompt(message: string, defaultValue?: string): Promise<string | null> {
  return mountInputPrompt({ message, defaultValue });
}

// --- Actions ---

async function loadData() {
  try {
    await loadDataStore();
  } catch (e) {
    void customAlert(t("sidebar.errors.loadData", { error: String(e) }));
  }
}

/// Prompt for any password the session needs but doesn't have stashed
/// (target/jump). Returns false if user cancelled — caller should abort.
async function ensurePasswordsForSession(id: string): Promise<boolean> {
  const needs = await Data.checkSessionPasswordNeeds(id);
  for (const need of needs) {
    const pwd = await mountPasswordPrompt({
      user: need.user,
      host: need.host,
      isJump: need.slot === "jump",
    });
    if (pwd === null) return false;
    await Data.setSessionPassword(id, need.slot, pwd);
  }
  return true;
}

async function connectSession(id: string, newWindow: boolean) {
  try {
    if (!(await ensurePasswordsForSession(id))) return;
    await Ssh.openSsh(id, newWindow);
  } catch (e) {
    customAlert(t("sidebar.errors.connect", { error: String(e) }));
  }
}

let deleteInProgress = false;
async function deleteSession(id: string) {
  if (deleteInProgress) return;
  deleteInProgress = true;
  try {
    const session = dataStore.sessions.find((s) => s.id === id);
    const ok = await customConfirm(t("sidebar.confirm.deleteSession.body", { name: session?.name || id }), t("sidebar.confirm.deleteSession.title"));
    if (!ok) return;
    setData(await Data.deleteSession(id));
  } catch (e) {
    customAlert(t("sidebar.errors.deleteSession", { error: String(e) }));
  } finally {
    deleteInProgress = false;
  }
}

async function addFolder() {
  const name = await customPrompt(t("sidebar.prompt.newFolder"));
  if (!name) return;
  try {
    setData(await Data.createFolder(name));
  } catch (e) {
    customAlert(t("sidebar.errors.createFolder", { error: String(e) }));
  }
}

async function deleteFolder(id: string) {
  const folder = dataStore.folders.find((f) => f.id === id);
  if (!folder) return;
  const ok = await customConfirm(t("sidebar.confirm.deleteFolder.body", { name: folder.name }), t("sidebar.confirm.deleteFolder.title"));
  if (!ok) return;
  try {
    setData(await Data.deleteFolder(id));
    ui.removeCollapsedFolder(id);
  } catch (e) {
    customAlert(t("sidebar.errors.deleteFolder", { error: String(e) }));
  }
}

async function editFolder(id: string) {
  const folder = dataStore.folders.find((f) => f.id === id);
  if (!folder) return;
  const name = await customPrompt(t("sidebar.prompt.renameFolder"), folder.name);
  if (name === null) return;
  if (!name) {
    const ok = await customConfirm(t("sidebar.confirm.deleteFolder.body", { name: folder.name }), t("sidebar.confirm.deleteFolder.title"));
    if (!ok) return;
    setData(await Data.deleteFolder(id));
    ui.removeCollapsedFolder(id);
  } else {
    setData(await Data.updateFolder(id, name));
  }
}


// Context menu handled by ContextMenu.svelte + mountContextMenu helper.

// Sidebar resize handled by Resizer.svelte component.

// --- Modal ---

type SettingsSection = "font" | "theme" | "terminal" | "layout" | "log" | "data";

function openSettings(initialSection: SettingsSection = "font") {
  mountSettings({
    initialSection,
    sidebarPosition: ui.sidebarPosition,
    onSidebarPositionChange: (pos) => ui.setSidebarPosition(pos),
    onLanguageSwitch: () => {},
    onDataReloaded: () => { void loadData(); },
    onAlert: (msg) => customAlert(msg),
  });
}


function openModal(session?: SshSession, defaultFolderId?: string | null) {
  mountSession({
    mode: session ? "edit" : "add",
    initial: session,
    defaultFolderId,
    folders: getSortedFolders(),
    onSave: (newData) => setData(newData),
    onError: (msg) => { void customAlert(msg); },
  });
}

// SFTP panels live entirely in lib/sftp + lib/components/sftp now.

function renderShell() {
  const target = document.getElementById("app")!;
  target.innerHTML = "";

  const actions: SidebarActions = {
    connect: (sid, newWindow) => connectSession(sid, newWindow),
    openSftp: (sid) => void openSftpPanel(sid),
    editSession: (s) => openModal(s),
    duplicateSession: async (sid) => {
      try { setData(await Data.copySession(sid)); }
      catch (err) { customAlert(t("sidebar.errors.duplicate", { error: String(err) })); }
    },
    deleteSession: (sid) => deleteSession(sid),
    addInFolder: (folderId) => openModal(undefined, folderId),
    editFolder: (fid) => editFolder(fid),
    deleteFolder: (fid) => deleteFolder(fid),
  };

  mount(App, {
    target,
    props: {
      actions,
      onAddSession: () => openModal(),
      onAddFolder: () => addFolder(),
      onSettings: () => void openSettings(),
      onRefresh: () => void loadData(),
      onToggleHide: () => ui.toggleSidebarHidden(),
    },
  });
}

if (!IS_TERMINAL_WINDOW) {
  (async () => {
    // Pre-apply saved theme before first paint to avoid default→saved flash.
    try {
      const savedTheme = await Config.getTerminalTheme();
      if (savedTheme) applyUiTheme(getTheme(savedTheme).ui);
    } catch {}
    renderShell();
    // Reveal window (tauri.conf.json visible:false → window-state plugin
    // restored size silently; showing here = no flash).
    try { await getCurrentWindow().show(); } catch {}
    await loadData();
  })();
}
