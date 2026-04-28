import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as Sftp from "../api/sftp";
import { dataStore } from "../stores/data.svelte";
import {
  addPanel,
  bringPanelToFront,
  clearPanelSelection,
  findPanel,
  nextOffset,
  nextPanelId,
  nextZ,
  removePanel,
  removeTransfer,
  setPanelDir,
  setPanelEntries,
  setPanelGeometry,
  setPanelHome,
  setPanelLoadError,
  setPanelLoading,
  setPanelSort,
  setPanelStatus,
  togglePanelSelected,
  upsertTransfer,
  type SftpPanelData,
  type SftpSortMode,
} from "../stores/sftp.svelte";
import type { SftpProgress } from "../api/types";
import { mountConfirm, mountAlert, mountPasswordPrompt } from "../components/modals/mount";
import { mountInputPrompt } from "../components/modals/inputPrompt";
import * as Data from "../api/data";
import { t } from "../i18n";

const MIN_W = 500;
const MIN_H = 350;
const DEFAULT_W = 760;
const DEFAULT_H = 480;

// One unlisten per panel for sftp-progress event subscription.
const unlistens = new Map<string, UnlistenFn>();

function readSavedSize(): { width: number; height: number } {
  const w = parseInt(localStorage.getItem("sftp-panel-w") || "", 10);
  const h = parseInt(localStorage.getItem("sftp-panel-h") || "", 10);
  return {
    width: Number.isFinite(w) && w >= MIN_W ? w : DEFAULT_W,
    height: Number.isFinite(h) && h >= MIN_H ? h : DEFAULT_H,
  };
}

export function persistPanelSize(width: number, height: number): void {
  localStorage.setItem("sftp-panel-w", String(width));
  localStorage.setItem("sftp-panel-h", String(height));
}

export async function openSftpPanel(sessionId: string, initialDir?: string, sessionName?: string): Promise<void> {
  // Fall back to dataStore lookup (main window) or use provided name (sub window).
  const name = sessionName ?? dataStore.sessions.find(s => s.id === sessionId)?.name ?? sessionId;

  // Prompt for any missing passwords before opening the panel.
  try {
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
  } catch {
    // Session may not exist or backend unreachable; let connect fail visibly.
  }

  const id = nextPanelId();
  const offset = nextOffset();
  const size = readSavedSize();

  const panel: SftpPanelData = {
    id,
    sessionId,
    sessionName: name,
    status: "connecting",
    errorMsg: null,
    homeDir: "",
    currentDir: "",
    entries: [],
    loading: false,
    loadError: null,
    sortMode: "type",
    selected: new Set(),
    transfers: [],
    z: nextZ(),
    left: 80 + offset,
    top: 40 + offset,
    width: size.width,
    height: size.height,
  };
  addPanel(panel);

  // Subscribe to progress events for this session. Coalesce updates per
  // animation frame: even if many events arrive in a single frame, the
  // store mutates once. Once a filename hits 100%, we mark it finished
  // and ignore subsequent events until cleanup — otherwise the SCP path
  // (whose backend timer keeps emitting 100% until the child process
  // actually exits) re-adds and re-removes the card every 1.5s, causing
  // visible flicker.
  try {
    const pending = new Map<string, { bytes: number; total: number; direction: "upload" | "download" }>();
    const finished = new Set<string>();         // sticky, until cleanup
    const justCompleted = new Set<string>();    // drained per flush
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      for (const [filename, u] of pending) {
        upsertTransfer(id, { filename, bytes: u.bytes, total: u.total, direction: u.direction });
      }
      pending.clear();
      for (const filename of justCompleted) {
        setTimeout(() => {
          removeTransfer(id, filename);
          finished.delete(filename);          // allow re-download of same name later
        }, 1500);
      }
      justCompleted.clear();
    };
    const unlisten = await listen<SftpProgress>("sftp-progress", (event) => {
      const p = event.payload;
      if (p.session_id !== sessionId) return;
      if (finished.has(p.filename)) return;   // ignore repeated 100% emits
      pending.set(p.filename, {
        bytes: p.bytes_transferred,
        total: p.total_bytes,
        direction: p.direction as "upload" | "download",
      });
      if (p.total_bytes > 0 && p.bytes_transferred >= p.total_bytes) {
        finished.add(p.filename);
        justCompleted.add(p.filename);
      }
      if (raf === null) raf = requestAnimationFrame(flush);
    });
    unlistens.set(id, unlisten);
  } catch {}

  // Connect
  let homeDir: string;
  try {
    homeDir = await Sftp.sftpConnect(sessionId);
  } catch (e) {
    setPanelStatus(id, "error", t("sftp.connectFailed", { error: String(e) }));
    return;
  }

  setPanelHome(id, homeDir);
  setPanelStatus(id, "ready");
  await loadDir(id, initialDir || homeDir);
}

export async function closeSftpPanel(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  const unlisten = unlistens.get(id);
  if (unlisten) {
    unlistens.delete(id);
    try { unlisten(); } catch {}
  }
  try { await Sftp.sftpDisconnect(p.sessionId); } catch {}
  removePanel(id);
}

export function focusPanel(id: string): void {
  bringPanelToFront(id);
}

export function setSortMode(id: string, mode: SftpSortMode): void {
  setPanelSort(id, mode);
}

export function moveGeometry(id: string, g: { left?: number; top?: number; width?: number; height?: number }): void {
  setPanelGeometry(id, g);
}

export function toggleSelected(id: string, path: string): void {
  togglePanelSelected(id, path);
}

export async function loadDir(id: string, path: string): Promise<void> {
  setPanelDir(id, path);
  setPanelLoading(id, true);
  try {
    const entries = await Sftp.sftpListDir(findPanel(id)!.sessionId, path);
    setPanelEntries(id, entries);
    setPanelLoading(id, false);
  } catch (e) {
    setPanelLoadError(id, t("sftp.errors.loadDir", { error: String(e) }));
  }
}

export async function refreshDir(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  await loadDir(id, p.currentDir);
}

export async function navigateParent(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  if (p.currentDir === "/") return;
  const parent = p.currentDir.replace(/\/[^/]+\/?$/, "") || "/";
  await loadDir(id, parent);
}

export async function downloadSelected(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p || p.selected.size === 0) return;
  const localDir = await open({ directory: true, title: t("sftp.dialog.saveTo") });
  if (!localDir) return;
  const items = p.entries.filter(e => p.selected.has(e.path) && !e.is_dir);
  for (const e of items) {
    const localPath = (localDir as string).replace(/[/\\]$/, "") + "/" + e.name;
    try {
      await Sftp.sftpDownload(p.sessionId, e.path, localPath);
    } catch (err) {
      await mountAlert(t("sftp.errors.downloadName", { name: e.name, error: String(err) }));
    }
  }
  clearPanelSelection(id);
  await refreshDir(id);
}

export async function downloadOne(id: string, remotePath: string, name: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  const localPath = await save({ defaultPath: name });
  if (!localPath) return;
  try {
    await Sftp.sftpDownload(p.sessionId, remotePath, localPath);
  } catch (e) {
    await mountAlert(t("sftp.errors.download", { error: String(e) }));
  }
}

export async function uploadFromDialog(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  const path = await open({ multiple: true });
  if (!path) return;
  const paths = Array.isArray(path) ? path : [path];
  for (const localPath of paths) {
    try {
      await Sftp.sftpUpload(p.sessionId, p.currentDir, localPath);
    } catch (e) {
      await mountAlert(t("sftp.errors.upload", { error: String(e) }));
    }
  }
  await refreshDir(id);
}

export async function uploadFiles(id: string, files: File[]): Promise<void> {
  const p = findPanel(id);
  if (!p || files.length === 0) return;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      await Sftp.sftpUploadBytes(p.sessionId, p.currentDir, f.name, bytes);
    } catch (err) {
      await mountAlert(t("sftp.errors.upload", { error: String(err) }));
    }
  }
  await refreshDir(id);
}

export async function makeDir(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  const name = await mountInputPrompt({ message: t("sftp.prompt.folderName") });
  if (!name) return;
  try {
    await Sftp.sftpMkdir(p.sessionId, p.currentDir + "/" + name);
    await refreshDir(id);
  } catch (e) {
    await mountAlert(t("sftp.errors.createFolder", { error: String(e) }));
  }
}

export async function deleteEntry(id: string, remotePath: string, isDir: boolean): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  const ok = await mountConfirm(
    t("sftp.confirm.delete.body", { path: remotePath }),
    t("sftp.confirm.delete.title"),
  );
  if (!ok) return;
  try {
    await Sftp.sftpDelete(p.sessionId, remotePath, isDir);
    await refreshDir(id);
  } catch (e) {
    await mountAlert(t("sftp.errors.delete", { error: String(e) }));
  }
}

export async function gotoPath(id: string): Promise<void> {
  const p = findPanel(id);
  if (!p) return;
  const target = await mountInputPrompt({
    message: t("sftp.prompt.goto"),
    defaultValue: p.currentDir,
    onTab: async (value) => {
      let parentDir: string;
      let partial: string;
      if (value.endsWith("/")) {
        parentDir = value.replace(/\/+$/, "") || "/";
        partial = "";
      } else {
        const lastSlash = value.lastIndexOf("/");
        parentDir = lastSlash === 0 ? "/" : value.substring(0, lastSlash) || "/";
        partial = value.substring(lastSlash + 1);
      }
      try {
        const entries = await Sftp.sftpListDir(p.sessionId, parentDir);
        const dirs = entries.filter(e => e.is_dir && e.name.startsWith(partial));
        if (dirs.length === 0) return { completed: null };
        const prefix = parentDir === "/" ? "/" : parentDir + "/";
        if (dirs.length === 1) return { completed: prefix + dirs[0].name + "/" };
        let common = dirs[0].name;
        for (let i = 1; i < dirs.length; i++) {
          let j = 0;
          while (j < common.length && j < dirs[i].name.length && common[j] === dirs[i].name[j]) j++;
          common = common.substring(0, j);
        }
        const completed = common.length > partial.length ? prefix + common : null;
        return { completed, candidates: dirs.map(d => d.name) };
      } catch {
        return { completed: null };
      }
    },
  });
  if (target) await loadDir(id, target);
}

export async function listChildDirs(sessionId: string, dirPath: string) {
  const entries = await Sftp.sftpListDir(sessionId, dirPath);
  return entries.filter(e => e.is_dir);
}
