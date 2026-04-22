#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use russh_keys::ssh_key;
use uuid::Uuid;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

const CREATE_NO_WINDOW: u32 = 0x08000000;

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

// --- SFTP Types ---

#[derive(Debug, Serialize, Clone)]
struct RemoteEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: i64,
    permissions: String,
}

#[derive(Debug, Clone, Serialize)]
struct SftpProgress {
    session_id: String,
    filename: String,
    bytes_transferred: u64,
    total_bytes: u64,
    direction: String,
}

enum SftpCommand {
    ListDir { path: String, reply: tokio::sync::oneshot::Sender<Result<Vec<RemoteEntry>, String>> },
    Upload { local_path: String, remote_dir: String, app: AppHandle, session_id: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Download { remote_path: String, local_path: String, app: AppHandle, session_id: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Mkdir { path: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Delete { path: String, is_dir: bool, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Disconnect,
}

struct SftpHandle {
    tx: tokio::sync::mpsc::Sender<SftpCommand>,
}

struct PtyInstance {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    terminal_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    terminal_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct AddTabPayload {
    terminal_id: String,
    title: String,
    ssh_args: Vec<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    adopt: bool,
    #[serde(default)]
    initial_content: String,
}

struct AppState {
    sftp_connections: Mutex<HashMap<String, SftpHandle>>,
    ptys: Mutex<HashMap<String, Arc<PtyInstance>>>,
    pending_tabs: Mutex<HashMap<String, AddTabPayload>>,
    runtime: tokio::runtime::Runtime,
}

fn format_permissions(mode: u32) -> String {
    let flags = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    flags.iter().map(|(bit, ch)| if mode & bit != 0 { *ch } else { '-' }).collect()
}

// --- russh client handler ---

struct SshClientHandler;

#[async_trait::async_trait]
impl russh::client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _key: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true) // Accept all host keys (like ssh -o StrictHostKeyChecking=no)
    }
}

fn load_key_pair(path: &str) -> Result<Arc<russh_keys::PrivateKey>, String> {
    let key = russh_keys::load_secret_key(path, None)
        .map_err(|e| format!("Failed to load key '{}': {}", path, e))?;
    Ok(Arc::new(key))
}

async fn try_auth(handle: &mut russh::client::Handle<SshClientHandler>, user: &str, key: &Arc<russh_keys::PrivateKey>) -> Result<(), String> {
    // Try default hash algorithm first
    let key_with_hash = russh_keys::key::PrivateKeyWithHashAlg::new(key.clone(), None)
        .map_err(|e| format!("Key error: {}", e))?;
    let auth_ok = handle.authenticate_publickey(user, key_with_hash).await
        .map_err(|e| format!("Auth failed: {}", e))?;
    if auth_ok { return Ok(()); }

    // Fallback: try SHA-256 for RSA keys
    if let Ok(key_sha256) = russh_keys::key::PrivateKeyWithHashAlg::new(
        key.clone(), Some(russh_keys::HashAlg::Sha256)
    ) {
        if let Ok(true) = handle.authenticate_publickey(user, key_sha256).await {
            return Ok(());
        }
    }

    // Fallback: try SHA-512 for RSA keys
    if let Ok(key_sha512) = russh_keys::key::PrivateKeyWithHashAlg::new(
        key.clone(), Some(russh_keys::HashAlg::Sha512)
    ) {
        if let Ok(true) = handle.authenticate_publickey(user, key_sha512).await {
            return Ok(());
        }
    }

    Err("Auth rejected - all key algorithms tried".to_string())
}

async fn connect_sftp(session: &SshSession, config: Arc<russh::client::Config>) -> Result<(russh_sftp::client::SftpSession, Option<russh::client::Handle<SshClientHandler>>, russh::client::Handle<SshClientHandler>), String> {
    let (jump_handle, target_handle);

    if let Some(jump) = &session.jump_host {
        let jump_key = load_key_pair(&jump.key_file)?;
        let mut jh = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            russh::client::connect(config.clone(), (jump.host.as_str(), jump.port), SshClientHandler)
        ).await
            .map_err(|_| format!("Jump host timeout: {}:{}", jump.host, jump.port))?
            .map_err(|e| format!("Jump host failed: {}", e))?;

        try_auth(&mut jh, &jump.user, &jump_key).await
            .map_err(|e| format!("Jump host: {}", e))?;

        let channel = jh.channel_open_direct_tcpip(&session.host, session.port as u32, "127.0.0.1", 0).await
            .map_err(|e| format!("Tunnel failed: {}", e))?;

        let target_key = load_key_pair(&session.key_file)?;
        let mut th = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            russh::client::connect_stream(config, channel.into_stream(), SshClientHandler)
        ).await
            .map_err(|_| "Target timeout via jump".to_string())?
            .map_err(|e| format!("Target failed: {}", e))?;

        try_auth(&mut th, &session.user, &target_key).await
            .map_err(|e| format!("Target: {}", e))?;

        jump_handle = Some(jh);
        target_handle = th;
    } else {
        let key = load_key_pair(&session.key_file)?;
        let mut h = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            russh::client::connect(config, (session.host.as_str(), session.port), SshClientHandler)
        ).await
            .map_err(|_| format!("Connection timeout: {}:{}", session.host, session.port))?
            .map_err(|e| format!("Connection failed: {}", e))?;

        try_auth(&mut h, &session.user, &key).await?;

        jump_handle = None;
        target_handle = h;
    }

    // Small delay to let the server process auth before opening channel
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let channel = target_handle.channel_open_session().await
        .map_err(|e| format!("Channel failed (server may have disconnected after auth): {}", e))?;
    channel.request_subsystem(true, "sftp").await
        .map_err(|e| format!("SFTP subsystem failed: {}", e))?;

    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await
        .map_err(|e| format!("SFTP init failed: {}", e))?;

    Ok((sftp, jump_handle, target_handle))
}

async fn list_dir_impl(sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<Vec<RemoteEntry>, String> {
    let entries = sftp.read_dir(path).await
        .map_err(|e| format!("Failed to list: {}", e))?;

    let mut items: Vec<RemoteEntry> = entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            if name == "." || name == ".." { return None; }
            let full_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            let attrs = entry.metadata();
            let is_dir = attrs.is_dir();
            let size = attrs.size.unwrap_or(0);
            let modified = attrs.mtime.unwrap_or(0) as i64;
            let permissions = format_permissions(attrs.permissions.unwrap_or(0));

            Some(RemoteEntry { name, path: full_path, is_dir, size, modified, permissions })
        })
        .collect();

    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(items)
}

async fn upload_impl(sftp: &russh_sftp::client::SftpSession, local_path: &str, remote_dir: &str, app: &AppHandle, session_id: &str) -> Result<(), String> {
    let local = std::path::Path::new(local_path);
    let filename = local.file_name().ok_or("Invalid filename")?.to_string_lossy().to_string();
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), filename);

    let local_data = fs::read(local_path).map_err(|e| e.to_string())?;
    let total_bytes = local_data.len() as u64;

    let mut remote_file = sftp.create(&remote_path).await
        .map_err(|e| format!("Create failed: {}", e))?;

    use tokio::io::AsyncWriteExt;
    let chunk_size = 32768;
    let mut transferred: u64 = 0;
    for chunk in local_data.chunks(chunk_size) {
        remote_file.write_all(chunk).await.map_err(|e| e.to_string())?;
        transferred += chunk.len() as u64;
        let _ = app.emit("sftp-progress", SftpProgress {
            session_id: session_id.to_string(), filename: filename.clone(),
            bytes_transferred: transferred, total_bytes, direction: "upload".to_string(),
        });
    }
    remote_file.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn download_impl(sftp: &russh_sftp::client::SftpSession, remote_path: &str, local_path: &str, app: &AppHandle, session_id: &str) -> Result<(), String> {
    let filename = std::path::Path::new(remote_path)
        .file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();

    let metadata = sftp.metadata(remote_path).await
        .map_err(|e| format!("Stat failed: {}", e))?;
    let total_bytes = metadata.size.unwrap_or(0);

    let mut remote_file = sftp.open(remote_path).await
        .map_err(|e| format!("Open failed: {}", e))?;

    use tokio::io::AsyncReadExt;
    let mut local_file = fs::File::create(local_path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 32768];
    let mut transferred: u64 = 0;
    loop {
        let n = remote_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        std::io::Write::write_all(&mut local_file, &buf[..n]).map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit("sftp-progress", SftpProgress {
            session_id: session_id.to_string(), filename: filename.clone(),
            bytes_transferred: transferred, total_bytes, direction: "download".to_string(),
        });
    }
    Ok(())
}

// --- Helpers ---

fn get_data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let new_dir = home.join(".simple-ssh-client");
    let old_dir = home.join(".keencho-ssh");
    // One-time migration: if the legacy keencho dir exists and the new one
    // doesn't, rename it so existing sessions/config carry over.
    if !new_dir.exists() && old_dir.exists() {
        let _ = fs::rename(&old_dir, &new_dir);
    }
    if !new_dir.exists() {
        fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    }
    Ok(new_dir)
}

fn get_data_path() -> Result<PathBuf, String> {
    let cfg = load_config();
    if let Some(custom) = cfg.data_path.filter(|s| !s.trim().is_empty()) {
        return Ok(PathBuf::from(custom));
    }
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

// --- Logging ---

fn resolve_log_dir() -> Result<PathBuf, String> {
    let cfg = load_config();
    let dir = if let Some(custom) = cfg.log_dir.filter(|s| !s.trim().is_empty()) {
        PathBuf::from(custom)
    } else {
        get_data_dir()?.join("logs")
    };
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log dir: {}", e))?;
    }
    Ok(dir)
}

fn slug(name: &str) -> String {
    let mut out: String = name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if out.is_empty() { out.push_str("unnamed"); }
    out.truncate(40);
    out
}

fn ts_filename() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn ts_line() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

fn log_app(level: &str, msg: &str) {
    let Ok(dir) = resolve_log_dir() else { return };
    let path = dir.join("app.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] [{}] {}", ts_line(), level, msg);
    }
}

fn build_ssh_args(session: &SshSession) -> Vec<String> {
    let cfg = load_config();
    let verbose = cfg.ssh_verbose.unwrap_or(false);
    let mut args: Vec<String> = Vec::new();
    // Legacy RSA+SHA-1 compatibility: re-enable ssh-rsa alongside modern
    // algorithms so OpenSSH 8.8+ can still talk to CentOS 7 / older servers
    // that don't speak rsa-sha2-256/512. The `+` prefix *adds* to the default
    // list — modern servers continue using modern signatures first.
    args.push("-o".to_string());
    args.push("PubkeyAcceptedAlgorithms=+ssh-rsa".to_string());
    args.push("-o".to_string());
    args.push("HostKeyAlgorithms=+ssh-rsa".to_string());
    if verbose {
        // -vv writes debug output to stderr, which the PTY merges into the
        // terminal view so the user actually sees "Permission denied" and
        // other failures. We tee that same output to a log file in pty_spawn,
        // so `-E` (which would *suppress* terminal output) is intentionally
        // NOT used here.
        args.push("-vv".to_string());
    }
    if let Some(jump) = &session.jump_host {
        args.push("-o".to_string());
        args.push(format!(
            "ProxyCommand=ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa -i \"{}\" -W %h:%p -p {} {}@{}",
            jump.key_file, jump.port, jump.user, jump.host
        ));
    }
    args.push("-i".to_string());
    args.push(session.key_file.clone());
    args.push("-p".to_string());
    args.push(session.port.to_string());
    args.push(format!("{}@{}", session.user, session.host));
    log_app("INFO", &format!("connect: {}@{}:{} key={} verbose={}",
        session.user, session.host, session.port, session.key_file, verbose));
    args
}

// --- Tauri Commands ---

#[tauri::command]
fn get_all_data() -> Result<SessionsData, String> { load_data() }

#[tauri::command]
fn create_session(name: String, host: String, port: u16, user: String, key_file: String, folder_id: Option<String>, jump_host: Option<JumpHost>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let max_order = data.sessions.iter().filter(|s| s.folder_id == folder_id).map(|s| s.order).max().unwrap_or(0);
    data.sessions.push(SshSession { id: Uuid::new_v4().to_string(), name, host, port, user, key_file, folder_id, order: max_order + 1, jump_host });
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn update_session(session: SshSession) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    if let Some(existing) = data.sessions.iter_mut().find(|s| s.id == session.id) { *existing = session; }
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
    data.folders.push(Folder { id: Uuid::new_v4().to_string(), name, order: max_order + 1 });
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn update_folder(id: String, name: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    if let Some(folder) = data.folders.iter_mut().find(|f| f.id == id) { folder.name = name; }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn delete_folder(id: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    data.folders.retain(|f| f.id != id);
    for session in data.sessions.iter_mut() {
        if session.folder_id.as_deref() == Some(&id) { session.folder_id = None; }
    }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn copy_session(id: String) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let original = data.sessions.iter().find(|s| s.id == id).cloned().ok_or("Session not found")?;
    // Shift all sessions in the same folder with order > original.order to make room
    for s in data.sessions.iter_mut() {
        if s.folder_id == original.folder_id && s.order > original.order {
            s.order += 1;
        }
    }
    data.sessions.push(SshSession {
        id: Uuid::new_v4().to_string(),
        name: format!("{} (복사)", original.name),
        host: original.host,
        port: original.port,
        user: original.user,
        key_file: original.key_file,
        folder_id: original.folder_id,
        order: original.order + 1,
        jump_host: original.jump_host,
    });
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn reorder_sessions(sessions: Vec<SshSession>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let order_map: HashMap<String, (u32, Option<String>)> = sessions.into_iter().map(|s| (s.id.clone(), (s.order, s.folder_id))).collect();
    for session in data.sessions.iter_mut() {
        if let Some((order, folder_id)) = order_map.get(&session.id) { session.order = *order; session.folder_id = folder_id.clone(); }
    }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn reorder_folders(folders: Vec<Folder>, root_folder_order: Option<u32>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let order_map: HashMap<String, u32> = folders.into_iter().map(|f| (f.id.clone(), f.order)).collect();
    for folder in data.folders.iter_mut() {
        if let Some(order) = order_map.get(&folder.id) { folder.order = *order; }
    }
    data.root_folder_order = root_folder_order;
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn fix_key_permissions(key_path: &str) -> Result<(), String> {
    use std::process::Command;
    static FIXED: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
        std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

    if key_path.is_empty() || !std::path::Path::new(key_path).exists() { return Ok(()); }
    if FIXED.lock().unwrap().contains(key_path) { return Ok(()); }
    let user = whoami::username();
    let _ = Command::new("takeown").args(["/f", key_path]).creation_flags(CREATE_NO_WINDOW).output();
    let _ = Command::new("icacls").args([key_path, "/inheritance:r"]).creation_flags(CREATE_NO_WINDOW).output();
    let _ = Command::new("icacls").args([key_path, "/grant:r", &format!("{user}:(R)")]).creation_flags(CREATE_NO_WINDOW).output();
    for group in ["Authenticated Users", "Users", "Everyone", "BUILTIN\\Users"] {
        let _ = Command::new("icacls").args([key_path, "/remove:g", group]).creation_flags(CREATE_NO_WINDOW).output();
    }
    FIXED.lock().unwrap().insert(key_path.to_string());
    Ok(())
}

#[tauri::command]
async fn open_ssh(id: String, new_window: bool, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == id).cloned().ok_or("Session not found")?;
    fix_key_permissions(&session.key_file)?;
    if let Some(jump) = &session.jump_host { fix_key_permissions(&jump.key_file)?; }

    let folder_name = session.folder_id.as_ref()
        .and_then(|fid| data.folders.iter().find(|f| f.id == *fid))
        .map(|f| f.name.clone())
        .unwrap_or_else(|| "미분류".to_string());
    let title = format!("{}:{}", folder_name, session.name);
    let ssh_args = build_ssh_args(&session);
    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload { terminal_id, title: title.clone(), ssh_args, session_id: Some(session.id.clone()), adopt: false, initial_content: String::new() };

    let existing_label = if new_window {
        None
    } else if app.get_webview_window("main").is_some() {
        // Prefer the main window (sidebar + terminal layout).
        Some("main".to_string())
    } else {
        // Fallback: any legacy terminal-only window that happens to exist.
        app.webview_windows()
            .keys()
            .find(|label| label.starts_with("term-"))
            .cloned()
    };

    if let Some(label) = existing_label {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
            window.emit_to(label.as_str(), "add-tab", payload)
                .map_err(|e| e.to_string())?;
        }
    } else {
        let label = format!("term-{}", Uuid::new_v4().simple());
        state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(title.clone())
            .inner_size(1100.0, 720.0)
            .min_inner_size(640.0, 400.0)
            .resizable(true);
        builder.build().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_take_pending(window_label: String, state: State<AppState>) -> Option<AddTabPayload> {
    state.pending_tabs.lock().unwrap().remove(&window_label)
}

#[derive(Serialize)]
struct SessionArgs {
    title: String,
    ssh_args: Vec<String>,
}

#[tauri::command]
fn get_ssh_args_for_session(id: String) -> Result<SessionArgs, String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == id).ok_or("Session not found")?;
    fix_key_permissions(&session.key_file)?;
    if let Some(jump) = &session.jump_host { fix_key_permissions(&jump.key_file)?; }
    let folder_name = session.folder_id.as_ref()
        .and_then(|fid| data.folders.iter().find(|f| f.id == *fid))
        .map(|f| f.name.clone())
        .unwrap_or_else(|| "미분류".to_string());
    Ok(SessionArgs {
        title: format!("{}:{}", folder_name, session.name),
        ssh_args: build_ssh_args(session),
    })
}

/// Spawn a new SSH terminal from raw ssh args. Used for "duplicate tab" — same
/// host/user/key but a fresh connection (PTYs cannot be forked).
#[tauri::command]
async fn spawn_terminal(
    ssh_args: Vec<String>,
    title: String,
    new_window: bool,
    source_label: String,
    session_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload {
        terminal_id,
        title: title.clone(),
        ssh_args,
        session_id,
        adopt: false,
        initial_content: String::new(),
    };

    if new_window {
        let label = format!("term-{}", Uuid::new_v4().simple());
        state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(title)
            .inner_size(1100.0, 720.0)
            .min_inner_size(640.0, 400.0)
            .resizable(true);
        builder.build().map_err(|e| e.to_string())?;
    } else if let Some(window) = app.get_webview_window(&source_label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        window.emit_to(source_label.as_str(), "add-tab", payload)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Config (for persisted preferences like terminal theme) ---

#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    terminal_theme: Option<String>,
    #[serde(default)]
    terminal_font: Option<String>,
    #[serde(default)]
    log_dir: Option<String>,      // custom log directory; None = data_dir/logs
    #[serde(default)]
    ssh_verbose: Option<bool>,    // when true, adds -v to ssh args + tees PTY to log file
    #[serde(default)]
    data_path: Option<String>,    // custom sessions.json path; None = data_dir/sessions.json
}

fn config_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join("config.json"))
}

fn load_config() -> AppConfig {
    let Ok(p) = config_path() else { return AppConfig::default() };
    fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path()?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_terminal_theme() -> Option<String> {
    load_config().terminal_theme
}

#[tauri::command]
fn set_terminal_theme(name: String, app: AppHandle) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.terminal_theme = Some(name.clone());
    save_config(&cfg)?;
    // Broadcast to every window (session list + all terminals)
    app.emit("terminal-theme-changed", name).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_terminal_font() -> Option<String> {
    load_config().terminal_font
}

#[tauri::command]
fn set_terminal_font(name: String, app: AppHandle) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.terminal_font = Some(name.clone());
    save_config(&cfg)?;
    app.emit("terminal-font-changed", name).map_err(|e| e.to_string())?;
    Ok(())
}

// --- Log/Verbose settings commands ---

#[tauri::command]
fn get_log_dir() -> Result<String, String> {
    Ok(resolve_log_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
fn set_log_dir(path: Option<String>) -> Result<String, String> {
    let mut cfg = load_config();
    cfg.log_dir = path.filter(|s| !s.trim().is_empty());
    save_config(&cfg)?;
    let resolved = resolve_log_dir()?.to_string_lossy().to_string();
    log_app("INFO", &format!("log_dir changed to {}", resolved));
    Ok(resolved)
}

#[tauri::command]
fn get_ssh_verbose() -> bool {
    load_config().ssh_verbose.unwrap_or(false)
}

#[tauri::command]
fn set_ssh_verbose(enabled: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.ssh_verbose = Some(enabled);
    save_config(&cfg)?;
    log_app("INFO", &format!("ssh_verbose={}", enabled));
    Ok(())
}

// --- Data file (sessions.json) commands ---

#[tauri::command]
fn get_data_file_path() -> Result<String, String> {
    Ok(get_data_path()?.to_string_lossy().to_string())
}

#[tauri::command]
fn set_data_file_path(path: Option<String>) -> Result<String, String> {
    // If a specific file is given, validate it parses as SessionsData (when the
    // file exists). Empty/None resets to the default location.
    if let Some(p) = path.as_ref().filter(|s| !s.trim().is_empty()) {
        let path_buf = PathBuf::from(p);
        if path_buf.exists() {
            let content = fs::read_to_string(&path_buf)
                .map_err(|e| format!("파일 읽기 실패: {}", e))?;
            serde_json::from_str::<SessionsData>(&content)
                .map_err(|e| format!("JSON 양식이 맞지 않습니다: {}", e))?;
        }
    }
    let mut cfg = load_config();
    cfg.data_path = path.filter(|s| !s.trim().is_empty());
    save_config(&cfg)?;
    let resolved = get_data_path()?.to_string_lossy().to_string();
    log_app("INFO", &format!("data_path changed to {}", resolved));
    Ok(resolved)
}

#[tauri::command]
fn export_sessions_to(target_path: String) -> Result<(), String> {
    let data = load_data()?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&target_path, json).map_err(|e| format!("저장 실패: {}", e))?;
    log_app("INFO", &format!("exported sessions to {}", target_path));
    Ok(())
}

#[tauri::command]
fn import_sessions_from(source_path: String) -> Result<SessionsData, String> {
    let content = fs::read_to_string(&source_path)
        .map_err(|e| format!("파일 읽기 실패: {}", e))?;
    let data: SessionsData = serde_json::from_str(&content)
        .map_err(|e| format!("JSON 양식이 맞지 않습니다: {}", e))?;
    save_data(&data)?;
    log_app("INFO", &format!("imported sessions from {}", source_path));
    Ok(data)
}

// Opens a file or directory path with the OS default handler. Used for
// "open log folder" / "open latest log" where tauri-plugin-shell's `open`
// rejects non-URL paths via its built-in scope validator.
#[tauri::command]
fn open_path_in_os(path: String) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe").arg(&path).spawn()
            .map_err(|e| format!("explorer failed: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&path).spawn()
            .map_err(|e| format!("open failed: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&path).spawn()
            .map_err(|e| format!("xdg-open failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn clear_logs() -> Result<u32, String> {
    let dir = resolve_log_dir()?;
    let mut count = 0u32;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() { continue; }
            if let Some(ext) = p.extension() { if ext != "log" { continue; } } else { continue; }
            if fs::remove_file(&p).is_ok() { count += 1; }
        }
    }
    log_app("INFO", &format!("cleared {} log files", count));
    Ok(count)
}

#[derive(Clone, Serialize)]
struct MergeTabPayload {
    terminal_id: String,
    title: String,
    ssh_args: Vec<String>,
    session_id: Option<String>,
    initial_content: String,
    screen_x: f64,
    screen_y: f64,
}

#[tauri::command]
async fn drop_tab(
    source_label: String,
    terminal_id: String,
    title: String,
    ssh_args: Vec<String>,
    session_id: Option<String>,
    initial_content: String,
    screen_x: f64,
    screen_y: f64,
    is_last_tab: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    // Try to find a target window whose outer rect contains the cursor.
    // Both "main" (sidebar+terminal) and "term-*" (terminal-only) windows
    // are valid merge targets.
    for (label, window) in app.webview_windows() {
        if label != "main" && !label.starts_with("term-") { continue; }
        if label == source_label { continue; }
        let Ok(pos) = window.outer_position() else { continue };
        let Ok(size) = window.outer_size() else { continue };
        let Ok(scale) = window.scale_factor() else { continue };
        let x0 = pos.x as f64 / scale;
        let y0 = pos.y as f64 / scale;
        let x1 = x0 + size.width as f64 / scale;
        let y1 = y0 + size.height as f64 / scale;
        if screen_x >= x0 && screen_x < x1 && screen_y >= y0 && screen_y < y1 {
            let merge = MergeTabPayload {
                terminal_id,
                title,
                ssh_args,
                session_id,
                initial_content,
                screen_x,
                screen_y,
            };
            window.emit_to(label.as_str(), "merge-tab", merge).map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            return Ok(true);
        }
    }
    // No merge target. If a term-* source's last tab is dragged out, "detach"
    // would just relocate an identical window — pointless. Main window stays
    // alive with a placeholder even after all tabs leave, so detaching from it
    // into a new window is meaningful.
    if is_last_tab && source_label.starts_with("term-") {
        return Ok(false);
    }
    let label = format!("term-{}", Uuid::new_v4().simple());
    let payload = AddTabPayload {
        terminal_id,
        title: title.clone(),
        ssh_args,
        session_id,
        adopt: true,
        initial_content,
    };
    state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title.clone())
        .inner_size(1100.0, 720.0)
        .min_inner_size(640.0, 400.0)
        .resizable(true)
        .position(screen_x - 100.0, screen_y - 20.0);
    builder.build().map_err(|e| e.to_string())?;
    Ok(true)
}

// --- PTY Commands ---

#[tauri::command]
fn pty_spawn(
    terminal_id: String,
    ssh_args: Vec<String>,
    rows: u16,
    cols: u16,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {}", e))?;

    let mut cmd = CommandBuilder::new("ssh.exe");
    for a in &ssh_args {
        cmd.arg(a);
    }
    // Ensure ssh thinks stdout is a TTY
    cmd.env("TERM", "xterm-256color");

    // If verbose SSH is on, open a log file that we tee the PTY output to.
    // Filename uses user@host from the last arg (ssh command line ends with it).
    let mut log_file: Option<std::fs::File> = None;
    if load_config().ssh_verbose.unwrap_or(false) {
        if let Ok(log_dir) = resolve_log_dir() {
            let target = ssh_args.last().cloned().unwrap_or_default();
            let fname = format!("ssh-{}-{}.log", ts_filename(), slug(&target));
            let path = log_dir.join(&fname);
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                log_app("INFO", &format!("verbose ssh log: {}", path.display()));
                log_file = Some(f);
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {}", e))?;
    // Drop slave so EOF propagates when child exits
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {}", e))?;

    let instance = Arc::new(PtyInstance {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    state.ptys.lock().unwrap().insert(terminal_id.clone(), instance);

    let app_clone = app.clone();
    let tid = terminal_id.clone();
    std::thread::spawn(move || {
        use std::io::Write;
        let mut buf = [0u8; 8192];
        let mut log = log_file;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(f) = log.as_mut() {
                        let _ = f.write_all(&buf[..n]);
                    }
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutputPayload {
                            terminal_id: tid.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit("pty-exit", PtyExitPayload { terminal_id: tid });
    });
    Ok(())
}

#[tauri::command]
fn pty_write(terminal_id: String, data: Vec<u8>, state: State<AppState>) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    let pty = ptys.get(&terminal_id).ok_or("Unknown terminal")?.clone();
    drop(ptys);
    let mut w = pty.writer.lock().unwrap();
    w.write_all(&data).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_resize(terminal_id: String, rows: u16, cols: u16, state: State<AppState>) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    let pty = ptys.get(&terminal_id).ok_or("Unknown terminal")?.clone();
    drop(ptys);
    pty.master
        .lock()
        .unwrap()
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_kill(terminal_id: String, state: State<AppState>) -> Result<(), String> {
    let pty = state.ptys.lock().unwrap().remove(&terminal_id);
    if let Some(pty) = pty {
        let _ = pty.child.lock().unwrap().kill();
    }
    Ok(())
}

// --- SFTP Commands ---

/// Resolve the SFTP "home" (canonical of ".") for a session without keeping
/// the connection alive. Used by the frontend to expand "~" found in window
/// titles when tracking the remote shell's cwd. Result is cached on the JS
/// side per session, so this command runs at most once per session lifetime.
#[tauri::command]
fn get_session_home(session_id: String, state: State<AppState>) -> Result<String, String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == session_id).cloned().ok_or("Session not found")?;
    fix_key_permissions(&session.key_file)?;
    if let Some(jump) = &session.jump_host { fix_key_permissions(&jump.key_file)?; }
    let rt = &state.runtime;
    rt.block_on(async {
        let config = Arc::new(russh::client::Config::default());
        let (sftp, _jump, _target) = connect_sftp(&session, config).await?;
        let home = sftp.canonicalize(".").await.map_err(|e| format!("home: {}", e))?;
        Ok::<String, String>(home)
    })
}

#[tauri::command]
fn sftp_connect(session_id: String, state: State<AppState>) -> Result<String, String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == session_id).ok_or("Session not found")?.clone();

    fix_key_permissions(&session.key_file)?;
    if let Some(jump) = &session.jump_host { fix_key_permissions(&jump.key_file)?; }

    let rt = &state.runtime;
    let result = rt.block_on(async {
        let config = Arc::new(russh::client::Config::default());
        let (sftp, _jump, _target) = connect_sftp(&session, config).await?;

        // Get home dir
        let home_dir = sftp.canonicalize(".").await
            .map_err(|e| format!("Cannot get home dir: {}", e))?;

        // Spawn worker
        let (tx, mut rx) = tokio::sync::mpsc::channel::<SftpCommand>(32);

        tokio::spawn(async move {
            // Keep handles alive
            let _j = _jump;
            let _t = _target;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    SftpCommand::ListDir { path, reply } => { let _ = reply.send(list_dir_impl(&sftp, &path).await); }
                    SftpCommand::Upload { local_path, remote_dir, app, session_id, reply } => { let _ = reply.send(upload_impl(&sftp, &local_path, &remote_dir, &app, &session_id).await); }
                    SftpCommand::Download { remote_path, local_path, app, session_id, reply } => { let _ = reply.send(download_impl(&sftp, &remote_path, &local_path, &app, &session_id).await); }
                    SftpCommand::Mkdir { path, reply } => { let _ = reply.send(sftp.create_dir(&path).await.map_err(|e| format!("Failed: {}", e))); }
                    SftpCommand::Delete { path, is_dir, reply } => {
                        let r = if is_dir { sftp.remove_dir(&path).await } else { sftp.remove_file(&path).await };
                        let _ = reply.send(r.map_err(|e| format!("Failed: {}", e)));
                    }
                    SftpCommand::Disconnect => return,
                }
            }
        });

        state.sftp_connections.lock().unwrap().insert(session_id, SftpHandle { tx });
        Ok::<String, String>(home_dir)
    })?;

    Ok(result)
}

#[tauri::command]
fn sftp_disconnect(session_id: String, state: State<AppState>) -> Result<(), String> {
    if let Some(handle) = state.sftp_connections.lock().unwrap().remove(&session_id) {
        let _ = state.runtime.block_on(handle.tx.send(SftpCommand::Disconnect));
    }
    Ok(())
}

#[tauri::command]
fn sftp_list_dir(session_id: String, path: String, state: State<AppState>) -> Result<Vec<RemoteEntry>, String> {
    let connections = state.sftp_connections.lock().unwrap();
    let handle = connections.get(&session_id).ok_or("Not connected")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    state.runtime.block_on(handle.tx.send(SftpCommand::ListDir { path, reply: reply_tx }))
        .map_err(|_| "Worker disconnected".to_string())?;
    state.runtime.block_on(reply_rx).map_err(|_| "Worker crashed".to_string())?
}

#[tauri::command]
fn sftp_upload(session_id: String, remote_dir: String, local_path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let connections = state.sftp_connections.lock().unwrap();
    let handle = connections.get(&session_id).ok_or("Not connected")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    state.runtime.block_on(handle.tx.send(SftpCommand::Upload { local_path, remote_dir, app, session_id: session_id.clone(), reply: reply_tx }))
        .map_err(|_| "Worker disconnected".to_string())?;
    state.runtime.block_on(reply_rx).map_err(|_| "Worker crashed".to_string())?
}

#[tauri::command]
fn sftp_download(session_id: String, remote_path: String, local_path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let connections = state.sftp_connections.lock().unwrap();
    let handle = connections.get(&session_id).ok_or("Not connected")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    state.runtime.block_on(handle.tx.send(SftpCommand::Download { remote_path, local_path, app, session_id: session_id.clone(), reply: reply_tx }))
        .map_err(|_| "Worker disconnected".to_string())?;
    state.runtime.block_on(reply_rx).map_err(|_| "Worker crashed".to_string())?
}

#[tauri::command]
fn sftp_mkdir(session_id: String, path: String, state: State<AppState>) -> Result<(), String> {
    let connections = state.sftp_connections.lock().unwrap();
    let handle = connections.get(&session_id).ok_or("Not connected")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    state.runtime.block_on(handle.tx.send(SftpCommand::Mkdir { path, reply: reply_tx }))
        .map_err(|_| "Worker disconnected".to_string())?;
    state.runtime.block_on(reply_rx).map_err(|_| "Worker crashed".to_string())?
}

#[tauri::command]
fn sftp_delete(session_id: String, path: String, is_dir: bool, state: State<AppState>) -> Result<(), String> {
    let connections = state.sftp_connections.lock().unwrap();
    let handle = connections.get(&session_id).ok_or("Not connected")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    state.runtime.block_on(handle.tx.send(SftpCommand::Delete { path, is_dir, reply: reply_tx }))
        .map_err(|_| "Worker disconnected".to_string())?;
    state.runtime.block_on(reply_rx).map_err(|_| "Worker crashed".to_string())?
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create tokio runtime");

    log_app("INFO", &format!("app start v{}", env!("CARGO_PKG_VERSION")));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState {
            sftp_connections: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            pending_tabs: Mutex::new(HashMap::new()),
            runtime,
        })
        .invoke_handler(tauri::generate_handler![
            get_all_data, create_session, update_session, delete_session, copy_session,
            create_folder, update_folder, delete_folder,
            reorder_sessions, reorder_folders, open_ssh,
            sftp_connect, sftp_disconnect, sftp_list_dir,
            sftp_upload, sftp_download, sftp_mkdir, sftp_delete,
            get_session_home,
            pty_spawn, pty_write, pty_resize, pty_kill, pty_take_pending, drop_tab,
            spawn_terminal, get_ssh_args_for_session,
            get_terminal_theme, set_terminal_theme,
            get_terminal_font, set_terminal_font,
            get_log_dir, set_log_dir, get_ssh_verbose, set_ssh_verbose,
            clear_logs, open_path_in_os,
            get_data_file_path, set_data_file_path,
            export_sessions_to, import_sessions_from
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
