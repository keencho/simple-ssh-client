import { mount, unmount } from "svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import SessionModal from "./SessionModal.svelte";
import SettingsModal from "./SettingsModal.svelte";
import SessionPicker from "./SessionPicker.svelte";
import PasswordPromptModal from "./PasswordPromptModal.svelte";
import ContextMenu from "../ui/ContextMenu.svelte";
import type { SshSession, Folder, SessionsData } from "../../api/types";
import type { ContextMenuItem } from "../sidebar/types";
import type { Lang } from "../../i18n";

type SidebarPosition = "left" | "right";
type SettingsSection = "font" | "theme" | "terminal" | "layout" | "log" | "data";

function attach<C extends Record<string, any>>(
  Component: any,
  build: (close: () => void) => C,
): () => void {
  const target = document.createElement("div");
  document.body.appendChild(target);

  let component: ReturnType<typeof mount> | null = null;
  const close = () => {
    if (component) unmount(component);
    target.remove();
  };
  component = mount(Component, { target, props: build(close) });
  return close;
}

export function mountConfirm(message: string, title?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const close = attach(ConfirmModal, (closeFn) => ({
      title,
      message,
      onConfirm: () => { closeFn(); resolve(true); },
      onCancel: () => { closeFn(); resolve(false); },
    }));
    void close;
  });
}

export function mountAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    attach(ConfirmModal, (closeFn) => ({
      message,
      onConfirm: () => { closeFn(); resolve(); },
      onCancel: () => { closeFn(); resolve(); },
    }));
  });
}

export function mountSession(opts: {
  mode: "add" | "edit";
  initial?: SshSession;
  defaultFolderId?: string | null;
  folders: Folder[];
  onSave: (newData: SessionsData) => void;
  onError: (msg: string) => void;
}): void {
  attach(SessionModal, (closeFn) => ({
    mode: opts.mode,
    initial: opts.initial,
    defaultFolderId: opts.defaultFolderId,
    folders: opts.folders,
    onSave: (newData: SessionsData) => { closeFn(); opts.onSave(newData); },
    onCancel: closeFn,
    onError: opts.onError,
  }));
}

export function mountSessionPicker(opts: {
  folders: Folder[];
  sessions: SshSession[];
  onSelect: (sessionId: string) => void;
}): void {
  attach(SessionPicker, (closeFn) => ({
    folders: opts.folders,
    sessions: opts.sessions,
    onSelect: opts.onSelect,
    onClose: closeFn,
  }));
}

export function mountPasswordPrompt(opts: {
  user: string;
  host: string;
  isJump: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    attach(PasswordPromptModal, (closeFn) => ({
      user: opts.user,
      host: opts.host,
      isJump: opts.isJump,
      onConfirm: (pwd: string) => { closeFn(); resolve(pwd); },
      onCancel: () => { closeFn(); resolve(null); },
    }));
  });
}

let _ctxClose: (() => void) | null = null;
export function mountContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  _ctxClose?.();
  _ctxClose = attach(ContextMenu, (closeFn) => ({
    x, y, items,
    onClose: () => { closeFn(); _ctxClose = null; },
  }));
}

export function mountSettings(opts: {
  initialSection: SettingsSection;
  sidebarPosition: SidebarPosition;
  onSidebarPositionChange: (pos: SidebarPosition) => void;
  onLanguageSwitch: (lang: Lang) => void;
  onDataReloaded: () => void;
  onAlert: (msg: string) => Promise<void>;
}): void {
  attach(SettingsModal, (closeFn) => ({
    initialSection: opts.initialSection,
    sidebarPosition: opts.sidebarPosition,
    onSidebarPositionChange: opts.onSidebarPositionChange,
    onLanguageSwitch: opts.onLanguageSwitch,
    onDataReloaded: opts.onDataReloaded,
    onAlert: opts.onAlert,
    onClose: closeFn,
  }));
}
