#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

// --- Data Model ---

#[derive(Debug, Serialize, Deserialize, Clone)]
struct JumpHost {
    host: String,
    port: u16,
    user: String,
    key_file: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SshSession {
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    key_file: String,
    folder_id: Option<String>,
    order: u32,
    jump_host: Option<JumpHost>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Folder {
    id: String,
    name: String,
    order: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionsData {
    folders: Vec<Folder>,
    sessions: Vec<SshSession>,
    #[serde(default)]
    root_folder_order: Option<u32>,
}

impl Default for SessionsData {
    fn default() -> Self {
        SessionsData {
            folders: Vec::new(),
            sessions: Vec::new(),
            root_folder_order: None,
        }
    }
}

// --- Helpers ---

fn get_data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(".keencho-ssh");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn get_data_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join("sessions.json"))
}

fn load_data() -> Result<SessionsData, String> {
    let path = get_data_path()?;
    if !path.exists() {
        return Ok(SessionsData::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn save_data(data: &SessionsData) -> Result<(), String> {
    let path = get_data_path()?;
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn build_ssh_command(session: &SshSession) -> String {
    let mut cmd = String::from("ssh");

    if let Some(jump) = &session.jump_host {
        cmd.push_str(&format!(
            " -o \"ProxyCommand=ssh -i \\\"{}\\\" -W %h:%p -p {} {}@{}\"",
            jump.key_file, jump.port, jump.user, jump.host
        ));
    }

    cmd.push_str(&format!(
        " -i \"{}\" -p {} {}@{}",
        session.key_file, session.port, session.user, session.host
    ));

    cmd
}

// --- Tauri Commands ---

#[tauri::command]
fn get_all_data() -> Result<SessionsData, String> {
    load_data()
}

#[tauri::command]
fn create_session(
    name: String,
    host: String,
    port: u16,
    user: String,
    key_file: String,
    folder_id: Option<String>,
    jump_host: Option<JumpHost>,
) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let max_order = data
        .sessions
        .iter()
        .filter(|s| s.folder_id == folder_id)
        .map(|s| s.order)
        .max()
        .unwrap_or(0);

    data.sessions.push(SshSession {
        id: Uuid::new_v4().to_string(),
        name,
        host,
        port,
        user,
        key_file,
        folder_id,
        order: max_order + 1,
        jump_host,
    });

    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn update_session(session: SshSession) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    if let Some(existing) = data.sessions.iter_mut().find(|s| s.id == session.id) {
        *existing = session;
    }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn delete_session(id: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    data.sessions.retain(|s| s.id != id);
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn create_folder(name: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let max_order = data.folders.iter().map(|f| f.order).max().unwrap_or(0);
    data.folders.push(Folder {
        id: Uuid::new_v4().to_string(),
        name,
        order: max_order + 1,
    });
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn update_folder(id: String, name: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    if let Some(folder) = data.folders.iter_mut().find(|f| f.id == id) {
        folder.name = name;
    }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn delete_folder(id: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    data.folders.retain(|f| f.id != id);
    // Move sessions to root
    for session in data.sessions.iter_mut() {
        if session.folder_id.as_deref() == Some(&id) {
            session.folder_id = None;
        }
    }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn reorder_sessions(sessions: Vec<SshSession>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let order_map: HashMap<String, (u32, Option<String>)> = sessions
        .into_iter()
        .map(|s| (s.id.clone(), (s.order, s.folder_id)))
        .collect();
    for session in data.sessions.iter_mut() {
        if let Some((order, folder_id)) = order_map.get(&session.id) {
            session.order = *order;
            session.folder_id = folder_id.clone();
        }
    }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn reorder_folders(folders: Vec<Folder>, root_folder_order: Option<u32>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let order_map: HashMap<String, u32> = folders
        .into_iter()
        .map(|f| (f.id.clone(), f.order))
        .collect();
    for folder in data.folders.iter_mut() {
        if let Some(order) = order_map.get(&folder.id) {
            folder.order = *order;
        }
    }
    data.root_folder_order = root_folder_order;
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn fix_key_permissions(key_path: &str) -> Result<(), String> {
    use std::process::Command;
    if key_path.is_empty() || !std::path::Path::new(key_path).exists() {
        return Ok(());
    }
    let user = whoami::username();
    // 0. Take ownership first (needed when current user has no access)
    let _ = Command::new("takeown")
        .args(["/f", key_path])
        .output();
    // 1. Remove inheritance and inherited ACEs
    let _ = Command::new("icacls")
        .args([key_path, "/inheritance:r"])
        .output();
    // 2. Grant only current user read access
    let _ = Command::new("icacls")
        .args([key_path, "/grant:r", &format!("{user}:(R)")])
        .output();
    // 3. Remove common groups that cause "too open" errors
    for group in ["Authenticated Users", "Users", "Everyone", "BUILTIN\\Users"] {
        let _ = Command::new("icacls")
            .args([key_path, "/remove:g", group])
            .output();
    }
    Ok(())
}

#[tauri::command]
fn open_ssh(id: String, new_window: bool) -> Result<(), String> {
    use std::process::Command;

    let data = load_data()?;
    let session = data
        .sessions
        .iter()
        .find(|s| s.id == id)
        .ok_or("Session not found")?;

    // Fix key file permissions before connecting
    fix_key_permissions(&session.key_file)?;
    if let Some(jump) = &session.jump_host {
        fix_key_permissions(&jump.key_file)?;
    }

    let ssh_cmd = build_ssh_command(session);
    let title = &session.name;

    if new_window {
        Command::new("wt.exe")
            .args(["new-tab", "--title", title, "--", "cmd", "/k", &ssh_cmd])
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        Command::new("wt.exe")
            .args([
                "-w", "0", "new-tab", "--title", title, "--", "cmd", "/k", &ssh_cmd,
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_all_data,
            create_session,
            update_session,
            delete_session,
            create_folder,
            update_folder,
            delete_folder,
            reorder_sessions,
            reorder_folders,
            open_ssh
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
