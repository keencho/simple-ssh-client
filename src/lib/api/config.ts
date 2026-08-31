import { invoke } from "@tauri-apps/api/core";

// Theme

export const getTerminalTheme = (): Promise<string | null> =>
  invoke("get_terminal_theme");

export const setTerminalTheme = (name: string): Promise<void> =>
  invoke("set_terminal_theme", { name });

// Font

export const getTerminalFont = (): Promise<string | null> =>
  invoke("get_terminal_font");

export const setTerminalFont = (name: string): Promise<void> =>
  invoke("set_terminal_font", { name });

// Log directory + verbose

export const getLogDir = (): Promise<string> =>
  invoke("get_log_dir");

export const setLogDir = (path: string | null): Promise<string> =>
  invoke("set_log_dir", { path });

export const clearLogs = (): Promise<number> =>
  invoke("clear_logs");

export const getSshVerbose = (): Promise<boolean> =>
  invoke("get_ssh_verbose");

export const setSshVerbose = (enabled: boolean): Promise<void> =>
  invoke("set_ssh_verbose", { enabled });

// Copy-on-select

export const getCopyOnSelect = (): Promise<boolean> =>
  invoke("get_copy_on_select");

export const setCopyOnSelect = (enabled: boolean): Promise<void> =>
  invoke("set_copy_on_select", { enabled });

// Data file path

export const getDataFilePath = (): Promise<string> =>
  invoke("get_data_file_path");

export const setDataFilePath = (path: string | null): Promise<string> =>
  invoke("set_data_file_path", { path });

// OS integration

export const openPathInOs = (path: string): Promise<void> =>
  invoke("open_path_in_os", { path });
