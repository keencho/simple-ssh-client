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

fn default_auth_method() -> String { "key".to_string() }
fn default_store_password() -> bool { true }

#[derive(Debug, Serialize, Deserialize, Clone)]
struct JumpHost {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    key_file: String,
    #[serde(default = "default_auth_method")]
    auth_method: String,        // "key" | "password"
    #[serde(default = "default_store_password")]
    store_password: bool,       // when method=password: persist in OS keyring
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SshSession {
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    key_file: String,
    folder_id: Option<String>,
    order: u32,
    jump_host: Option<JumpHost>,
    #[serde(default = "default_auth_method")]
    auth_method: String,        // "key" | "password"
    #[serde(default = "default_store_password")]
    store_password: bool,
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
    UploadBytes { remote_dir: String, filename: String, data: Vec<u8>, app: AppHandle, session_id: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Download { remote_path: String, local_path: String, app: AppHandle, session_id: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Mkdir { path: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Delete { path: String, is_dir: bool, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Disconnect,
}

struct SftpHandle {
    tx: tokio::sync::mpsc::Sender<SftpCommand>,
}

enum RusshShellCmd {
    Write(Vec<u8>),
    Resize { rows: u16, cols: u16 },
    Kill,
}

enum PtyInstance {
    /// Child `ssh.exe` process driving a local pseudoterminal (key auth path).
    Cli {
        master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
        writer: Mutex<Box<dyn Write + Send>>,
        child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    },
    /// In-process russh client with a shell channel (password auth path).
    /// Worker task owns the channel and serves write/resize/kill via mpsc.
    Russh {
        tx: tokio::sync::mpsc::UnboundedSender<RusshShellCmd>,
    },
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
    // Per-session password cache for sessions with store_password=false.
    // Key format: session_id (target) or "{session_id}:jump" (jump host).
    // Cleared when a connection error suggests a stale password.
    password_cache: Mutex<HashMap<String, String>>,
    runtime: tokio::runtime::Runtime,
}

// --- Keyring helpers (OS-level secure password storage) ---

const KEYRING_SERVICE: &str = "simple-ssh-client";

fn keyring_account(session_id: &str, is_jump: bool) -> String {
    if is_jump { format!("{}:jump", session_id) } else { session_id.to_string() }
}

fn keyring_set(session_id: &str, is_jump: bool, password: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_account(session_id, is_jump))
        .map_err(|e| format!("keyring entry: {}", e))?;
    entry.set_password(password)
        .map_err(|e| format!("keyring set: {}", e))
}

fn keyring_get(session_id: &str, is_jump: bool) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, &keyring_account(session_id, is_jump)).ok()
        .and_then(|e| e.get_password().ok())
}

fn keyring_delete(session_id: &str, is_jump: bool) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &keyring_account(session_id, is_jump)) {
        let _ = entry.delete_credential();
    }
}

/// Resolve password for a session (target or jump host).
/// store_password=true → keyring lookup. store_password=false → memory cache.
fn resolve_password(state: &AppState, session_id: &str, is_jump: bool, store: bool) -> Option<String> {
    let key = keyring_account(session_id, is_jump);
    if store {
        keyring_get(session_id, is_jump)
    } else {
        state.password_cache.lock().unwrap().get(&key).cloned()
    }
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

/// Password auth with automatic keyboard-interactive fallback.
/// Many OpenSSH/PAM setups advertise "password" but only accept the value via
/// the keyboard-interactive challenge; we transparently feed the same string.
async fn try_auth_password(handle: &mut russh::client::Handle<SshClientHandler>, user: &str, password: &str) -> Result<(), String> {
    // 1) Plain password
    if let Ok(true) = handle.authenticate_password(user, password).await {
        return Ok(());
    }
    // 2) Keyboard-interactive — answer every prompt with the same password
    use russh::client::KeyboardInteractiveAuthResponse;
    let mut state = handle.authenticate_keyboard_interactive_start(user, None).await
        .map_err(|e| format!("kbd-interactive start failed: {}", e))?;
    for _ in 0..16 {
        match state {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("Password rejected".to_string());
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let responses: Vec<String> = prompts.iter().map(|_| password.to_string()).collect();
                state = handle.authenticate_keyboard_interactive_respond(responses).await
                    .map_err(|e| format!("kbd-interactive respond failed: {}", e))?;
            }
        }
    }
    Err("kbd-interactive: too many prompts".to_string())
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

/// Authenticate a russh handle using either a key file or a password,
/// based on the `auth_method` field. Used for both target and jump hosts.
async fn auth_dispatch(
    handle: &mut russh::client::Handle<SshClientHandler>,
    user: &str,
    auth_method: &str,
    key_file: &str,
    password: Option<&str>,
) -> Result<(), String> {
    if auth_method == "password" {
        let pwd = password.ok_or_else(|| "Password not provided".to_string())?;
        try_auth_password(handle, user, pwd).await
    } else {
        let key = load_key_pair(key_file)?;
        try_auth(handle, user, &key).await
    }
}

/// Open authenticated russh handles for the session (and jump host if any).
/// Returns (jump_handle?, target_handle). The jump handle must be kept alive
/// for the duration of the target session — drop it and the tunnel collapses.
async fn connect_handles(
    session: &SshSession,
    config: Arc<russh::client::Config>,
    target_password: Option<String>,
    jump_password: Option<String>,
) -> Result<(Option<russh::client::Handle<SshClientHandler>>, russh::client::Handle<SshClientHandler>), String> {
    if let Some(jump) = &session.jump_host {
        let mut jh = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            russh::client::connect(config.clone(), (jump.host.as_str(), jump.port), SshClientHandler)
        ).await
            .map_err(|_| format!("Jump host timeout: {}:{}", jump.host, jump.port))?
            .map_err(|e| format!("Jump host failed: {}", e))?;

        auth_dispatch(&mut jh, &jump.user, &jump.auth_method, &jump.key_file, jump_password.as_deref()).await
            .map_err(|e| format!("Jump host: {}", e))?;

        let channel = jh.channel_open_direct_tcpip(&session.host, session.port as u32, "127.0.0.1", 0).await
            .map_err(|e| format!("Tunnel failed: {}", e))?;

        let mut th = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            russh::client::connect_stream(config, channel.into_stream(), SshClientHandler)
        ).await
            .map_err(|_| "Target timeout via jump".to_string())?
            .map_err(|e| format!("Target failed: {}", e))?;

        auth_dispatch(&mut th, &session.user, &session.auth_method, &session.key_file, target_password.as_deref()).await
            .map_err(|e| format!("Target: {}", e))?;

        Ok((Some(jh), th))
    } else {
        let mut h = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            russh::client::connect(config, (session.host.as_str(), session.port), SshClientHandler)
        ).await
            .map_err(|_| format!("Connection timeout: {}:{}", session.host, session.port))?
            .map_err(|e| format!("Connection failed: {}", e))?;

        auth_dispatch(&mut h, &session.user, &session.auth_method, &session.key_file, target_password.as_deref()).await?;

        Ok((None, h))
    }
}

async fn connect_sftp(
    session: &SshSession,
    config: Arc<russh::client::Config>,
    target_password: Option<String>,
    jump_password: Option<String>,
) -> Result<(russh_sftp::client::SftpSession, Option<russh::client::Handle<SshClientHandler>>, russh::client::Handle<SshClientHandler>), String> {
    let (jump_handle, target_handle) = connect_handles(session, config, target_password, jump_password).await?;

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
    let local_data = fs::read(local_path).map_err(|e| e.to_string())?;
    write_bytes_impl(sftp, remote_dir, &filename, &local_data, app, session_id).await
}

async fn upload_bytes_impl(sftp: &russh_sftp::client::SftpSession, remote_dir: &str, filename: &str, data: &[u8], app: &AppHandle, session_id: &str) -> Result<(), String> {
    write_bytes_impl(sftp, remote_dir, filename, data, app, session_id).await
}

// SFTP transfer tuning.
//   - 255KB per request stays under typical server packet limits and the
//     russh-sftp default (261120) for File-level reads/writes.
//   - Progress events throttled to 200ms; frontend coalesces per RAF.
//   - Parallel pipeline depth 8 → 8 concurrent SSH_FXP_READ requests.
//     RTT is amortized across all 8, so on a 50ms RTT link throughput
//     jumps from ~5MB/s (sequential) to ~40MB/s. Over LAN/localhost the
//     ceiling is the SSH cipher / disk speed instead.
//   - Files smaller than ~2MB use the sequential path: pipeline setup
//     (multiple SFTP open round-trips) costs more than it saves.
const SFTP_CHUNK_SIZE: usize = 261_120;
const SFTP_PROGRESS_INTERVAL_MS: u128 = 200;
const SFTP_PIPELINE_DEPTH: usize = 8;
const SFTP_PIPELINE_THRESHOLD: u64 = 2 * 1024 * 1024;

use std::sync::atomic::{AtomicU64, Ordering};

/// Progress reporting decoupled from the data path.
///
/// The data path (writer task) only ever does `bytes.fetch_add(...)` —
/// a single relaxed atomic op, never blocks. A dedicated timer task
/// reads the atomic every SFTP_PROGRESS_INTERVAL_MS and emits to the
/// frontend. This means heavy IPC backpressure or slow event dispatch
/// can never stall the actual transfer, and we stop allocating
/// SftpProgress structs at chunk-rate.
struct ProgressTracker {
    bytes: Arc<AtomicU64>,
    _emitter: tokio::task::JoinHandle<()>,
    cancel: Arc<AtomicU64>, // 0 = run, 1 = stop
    app: AppHandle,
    session_id: String,
    filename: String,
    direction: &'static str,
    total_bytes: u64,
}

impl ProgressTracker {
    fn start(app: &AppHandle, session_id: &str, filename: String, direction: &'static str, total_bytes: u64) -> Self {
        let bytes = Arc::new(AtomicU64::new(0));
        let cancel = Arc::new(AtomicU64::new(0));
        let app_c = app.clone();
        let sid = session_id.to_string();
        let fname = filename.clone();
        let bytes_c = bytes.clone();
        let cancel_c = cancel.clone();

        // Emit 0% immediately so the transfer card appears at once.
        let _ = app.emit("sftp-progress", SftpProgress {
            session_id: sid.clone(), filename: fname.clone(),
            bytes_transferred: 0, total_bytes, direction: direction.to_string(),
        });

        let emitter = tokio::spawn(async move {
            let mut interval = tokio::time::interval(
                std::time::Duration::from_millis(SFTP_PROGRESS_INTERVAL_MS as u64)
            );
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if cancel_c.load(Ordering::Relaxed) != 0 { break; }
                let n = bytes_c.load(Ordering::Relaxed);
                let _ = app_c.emit("sftp-progress", SftpProgress {
                    session_id: sid.clone(), filename: fname.clone(),
                    bytes_transferred: n, total_bytes, direction: direction.to_string(),
                });
            }
        });

        Self {
            bytes, _emitter: emitter, cancel,
            app: app.clone(), session_id: session_id.to_string(),
            filename, direction, total_bytes,
        }
    }

    fn counter(&self) -> Arc<AtomicU64> { self.bytes.clone() }

    fn finish(self) {
        // Stop the timer and emit a final guaranteed 100% so the UI
        // doesn't sit at 99.x% if the last interval missed.
        self.cancel.store(1, Ordering::Relaxed);
        let final_bytes = self.bytes.load(Ordering::Relaxed).max(self.total_bytes);
        let _ = self.app.emit("sftp-progress", SftpProgress {
            session_id: self.session_id, filename: self.filename,
            bytes_transferred: final_bytes, total_bytes: self.total_bytes,
            direction: self.direction.to_string(),
        });
    }
}

async fn write_bytes_impl(sftp: &russh_sftp::client::SftpSession, remote_dir: &str, filename: &str, data: &[u8], app: &AppHandle, session_id: &str) -> Result<(), String> {
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), filename);
    let total_bytes = data.len() as u64;

    let mut remote_file = sftp.create(&remote_path).await
        .map_err(|e| format!("Create failed: {}", e))?;

    use tokio::io::AsyncWriteExt;
    let tracker = ProgressTracker::start(app, session_id, filename.to_string(), "upload", total_bytes);
    let bytes = tracker.counter();
    for chunk in data.chunks(SFTP_CHUNK_SIZE) {
        remote_file.write_all(chunk).await.map_err(|e| e.to_string())?;
        bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    remote_file.shutdown().await.map_err(|e| e.to_string())?;
    tracker.finish();
    Ok(())
}

// Files >= this size + key auth on every hop → use the OS scp.exe in a
// separate process. Keeps the UI completely isolated from the transfer
// (cipher CPU, IPC, disk writes all happen in another process). Below
// this size the connection-setup cost outweighs the win, so we stay on
// the in-process pipelined SFTP path.
const SCP_THRESHOLD: u64 = 50 * 1024 * 1024;

fn is_scp_eligible(session: &SshSession) -> bool {
    if session.auth_method != "key" { return false; }
    if let Some(j) = &session.jump_host {
        if j.auth_method != "key" { return false; }
    }
    true
}

async fn download_impl(sftp: &russh_sftp::client::SftpSession, remote_path: &str, local_path: &str, app: &AppHandle, session_id: &str) -> Result<(), String> {
    let filename = std::path::Path::new(remote_path)
        .file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();

    let metadata = sftp.metadata(remote_path).await
        .map_err(|e| format!("Stat failed: {}", e))?;
    let total_bytes = metadata.size.unwrap_or(0);

    let tracker = ProgressTracker::start(app, session_id, filename.clone(), "download", total_bytes);
    let bytes = tracker.counter();

    // Try external scp for big key-auth transfers.
    let session_meta = load_data().ok().and_then(|d| d.sessions.into_iter().find(|s| s.id == session_id));
    if total_bytes >= SCP_THRESHOLD {
        if let Some(s) = session_meta.as_ref() {
            if is_scp_eligible(s) {
                match download_via_scp(s, remote_path, local_path, total_bytes, &bytes).await {
                    Ok(()) => { tracker.finish(); return Ok(()); }
                    Err(e) => {
                        eprintln!("[sftp] scp path failed ({}), falling back to in-process SFTP", e);
                        let _ = tokio::fs::remove_file(local_path).await;
                        bytes.store(0, Ordering::Relaxed);
                    }
                }
            }
        }
    }

    let result = if total_bytes < SFTP_PIPELINE_THRESHOLD {
        download_sequential(sftp, remote_path, local_path, &bytes).await
    } else {
        match download_pipelined(sftp, remote_path, local_path, total_bytes, &bytes).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = tokio::fs::remove_file(local_path).await;
                eprintln!("[sftp] pipelined download failed ({}), falling back to sequential", e);
                bytes.store(0, Ordering::Relaxed);
                download_sequential(sftp, remote_path, local_path, &bytes).await
            }
        }
    };

    tracker.finish();
    result
}

/// Subprocess scp.exe download. The OS isolates everything — cipher,
/// disk I/O, network — in its own process. We just feed args and parse
/// scp's stderr progress line for byte counts (line redrawn with \r).
async fn download_via_scp(
    session: &SshSession,
    remote_path: &str,
    local_path: &str,
    total_bytes: u64,
    bytes: &Arc<AtomicU64>,
) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;

    let mut cmd = Command::new("scp");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg("-o").arg("PubkeyAcceptedAlgorithms=+ssh-rsa");
    cmd.arg("-o").arg("HostKeyAlgorithms=+ssh-rsa");
    cmd.arg("-o").arg("ServerAliveInterval=60");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    cmd.arg("-o").arg("TCPKeepAlive=yes");
    // Auto-add unknown hosts (matches our terminal flow's effective UX —
    // the user just connected via ssh.exe and trusted the key).
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    if let Some(jump) = &session.jump_host {
        cmd.arg("-o").arg(format!(
            "ProxyCommand=ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes -o StrictHostKeyChecking=accept-new -i \"{}\" -W %h:%p -p {} {}@{}",
            jump.key_file, jump.port, jump.user, jump.host
        ));
    }
    cmd.arg("-i").arg(&session.key_file);
    cmd.arg("-P").arg(session.port.to_string());
    cmd.arg(format!("{}@{}:{}", session.user, session.host, remote_path));
    cmd.arg(local_path);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("scp spawn failed: {}", e))?;
    let mut stderr = child.stderr.take().ok_or("scp stderr missing".to_string())?;

    // OpenSSH scp suppresses its built-in progress meter when stderr is
    // not a TTY, so we can't parse percentages from it. Instead, poll the
    // local file's size — that's ground truth (scp writes directly to
    // the destination path). We still drain stderr to capture error text
    // for the failure message, but only the last line is kept.
    let local_path_owned = local_path.to_string();
    let bytes_c = bytes.clone();
    let poll_stop = Arc::new(AtomicU64::new(0));
    let poll_stop_c = poll_stop.clone();
    let poller = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(150));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if poll_stop_c.load(Ordering::Relaxed) != 0 { break; }
            if let Ok(meta) = tokio::fs::metadata(&local_path_owned).await {
                bytes_c.store(meta.len(), Ordering::Relaxed);
            }
        }
    });

    let err_pump = tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        let mut last_line = String::new();
        let mut accum = String::new();
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    accum.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(pos) = accum.find(|c: char| c == '\r' || c == '\n') {
                        let line: String = accum.drain(..=pos).collect();
                        let t = line.trim();
                        if !t.is_empty() { last_line = t.to_string(); }
                    }
                }
                Err(_) => break,
            }
        }
        if !accum.trim().is_empty() { last_line = accum.trim().to_string(); }
        last_line
    });

    let status = child.wait().await.map_err(|e| format!("scp wait: {}", e))?;
    poll_stop.store(1, Ordering::Relaxed);
    let _ = poller.await;
    let last_err = err_pump.await.unwrap_or_default();
    if !status.success() {
        return Err(format!("scp exit {:?}: {}", status.code(), last_err));
    }
    bytes.store(total_bytes, Ordering::Relaxed);
    Ok(())
}

async fn download_sequential(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &str,
    bytes: &Arc<AtomicU64>,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let mut remote_file = sftp.open(remote_path).await
        .map_err(|e| format!("Open failed: {}", e))?;
    let bytes = bytes.clone();

    // Single dedicated blocking thread for disk writes — sync I/O via
    // FileExt::seek_write avoids the per-chunk spawn_blocking that
    // tokio::fs::File does on Windows. Reader pushes chunks; writer
    // drains and write_all_at's them. tx drops when reader finishes,
    // closing rx and ending the writer.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(SFTP_PIPELINE_DEPTH);
    let local_path_owned = local_path.to_string();
    let bytes_w = bytes.clone();
    let writer = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut file = std::fs::File::create(&local_path_owned).map_err(|e| e.to_string())?;
        while let Ok(buf) = rx.recv() {
            std::io::Write::write_all(&mut file, &buf).map_err(|e| e.to_string())?;
            bytes_w.fetch_add(buf.len() as u64, Ordering::Relaxed);
        }
        std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
        Ok(())
    });

    let mut buf = vec![0u8; SFTP_CHUNK_SIZE];
    loop {
        let n = remote_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        if tx.send(buf[..n].to_vec()).is_err() { break; }
    }
    drop(tx);
    writer.await.map_err(|e| format!("writer join: {}", e))??;
    Ok(())
}

/// Pipelined download: open N file handles to the same path, each handle
/// reads a round-robin slice of the file. SFTP multiplexes the read
/// requests on one channel, so we get N concurrent SSH_FXP_READ in flight
/// without ordering hassles. A dedicated blocking writer thread drains
/// chunks via `seek_write` (Windows) / `write_all_at` (Unix), so we
/// never pay tokio's per-write spawn_blocking overhead and writes never
/// stall reads. Progress is updated via Arc<AtomicU64>; a separate timer
/// task emits to the frontend independently.
async fn download_pipelined(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &str,
    total_bytes: u64,
    bytes: &Arc<AtomicU64>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let total_chunks = total_bytes.div_ceil(SFTP_CHUNK_SIZE as u64);
    let workers = std::cmp::min(SFTP_PIPELINE_DEPTH as u64, total_chunks) as usize;

    let mut files = Vec::with_capacity(workers);
    for _ in 0..workers {
        let f = sftp.open(remote_path).await
            .map_err(|e| format!("Pipeline open failed: {}", e))?;
        files.push(f);
    }

    // Pre-allocate so writer can seek+write at any offset (sparse fine
    // on NTFS/ext4 but set_len ensures the OS reserves the size).
    {
        let f = std::fs::OpenOptions::new()
            .write(true).create(true).truncate(true)
            .open(local_path).map_err(|e| e.to_string())?;
        f.set_len(total_bytes).map_err(|e| e.to_string())?;
    }

    let (tx, rx) = std::sync::mpsc::sync_channel::<(u64, Vec<u8>)>(workers * 2);

    // Single blocking writer thread.
    let local_path_owned = local_path.to_string();
    let bytes_w = bytes.clone();
    let writer = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::OpenOptions::new()
            .write(true).open(&local_path_owned).map_err(|e| e.to_string())?;
        while let Ok((offset, data)) = rx.recv() {
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileExt;
                let mut written = 0;
                while written < data.len() {
                    let n = file.seek_write(&data[written..], offset + written as u64)
                        .map_err(|e| e.to_string())?;
                    if n == 0 { return Err("write returned 0".into()); }
                    written += n;
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileExt;
                file.write_all_at(&data, offset).map_err(|e| e.to_string())?;
            }
            bytes_w.fetch_add(data.len() as u64, Ordering::Relaxed);
        }
        file.sync_data().map_err(|e| e.to_string())?;
        Ok(())
    });

    let stride = (workers as u64) * (SFTP_CHUNK_SIZE as u64);
    let mut reader_tasks = Vec::with_capacity(workers);
    for (worker_id, mut file) in files.into_iter().enumerate() {
        let tx = tx.clone();
        let task = tokio::spawn(async move {
            let mut offset = (worker_id as u64) * (SFTP_CHUNK_SIZE as u64);
            if file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
                return Err(format!("worker {} seek failed", worker_id));
            }
            let mut last_pos = offset;
            while offset < total_bytes {
                let want = std::cmp::min(SFTP_CHUNK_SIZE as u64, total_bytes - offset) as usize;
                if last_pos != offset {
                    file.seek(std::io::SeekFrom::Start(offset)).await
                        .map_err(|e| format!("worker {} seek: {}", worker_id, e))?;
                }
                let mut buf = vec![0u8; want];
                let mut filled = 0;
                while filled < want {
                    let n = file.read(&mut buf[filled..]).await
                        .map_err(|e| format!("worker {} read: {}", worker_id, e))?;
                    if n == 0 { break; }
                    filled += n;
                }
                if filled == 0 { break; }
                buf.truncate(filled);
                last_pos = offset + filled as u64;
                if tx.send((offset, buf)).is_err() { return Ok(()); }
                offset += stride;
            }
            Ok::<(), String>(())
        });
        reader_tasks.push(task);
    }
    drop(tx);

    for t in reader_tasks {
        match t.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("worker join: {}", e)),
        }
    }
    writer.await.map_err(|e| format!("writer join: {}", e))??;
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
    // Password-auth sessions don't shell out to ssh.exe — they go through the
    // in-process russh shell path. Returning an empty vec signals that path
    // to pty_spawn (which then uses session_id to look up the session).
    if session.auth_method == "password" {
        return Vec::new();
    }
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
    // Keep idle connections alive: send a keepalive every 60s, drop after 3
    // consecutive missed responses (~3 min). Prevents NAT/firewall timeouts
    // from closing the session as "client_loop: send disconnect: Connection reset".
    args.push("-o".to_string());
    args.push("ServerAliveInterval=60".to_string());
    args.push("-o".to_string());
    args.push("ServerAliveCountMax=3".to_string());
    args.push("-o".to_string());
    args.push("TCPKeepAlive=yes".to_string());
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
            "ProxyCommand=ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes -i \"{}\" -W %h:%p -p {} {}@{}",
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

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_session(
    name: String,
    host: String,
    port: u16,
    user: String,
    key_file: String,
    folder_id: Option<String>,
    jump_host: Option<JumpHost>,
    auth_method: String,
    store_password: bool,
    password: Option<String>,
    jump_password: Option<String>,
    state: State<AppState>,
) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let max_order = data.sessions.iter().filter(|s| s.folder_id == folder_id).map(|s| s.order).max().unwrap_or(0);
    let id = Uuid::new_v4().to_string();
    let new_session = SshSession {
        id: id.clone(),
        name, host, port, user, key_file, folder_id,
        order: max_order + 1,
        jump_host: jump_host.clone(),
        auth_method: auth_method.clone(),
        store_password,
    };
    persist_password_for_session(&state, &id, &new_session, password.as_deref(), jump_password.as_deref())?;
    data.sessions.push(new_session);
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn update_session(session: SshSession, password: Option<String>, jump_password: Option<String>, state: State<AppState>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    let prev = data.sessions.iter().find(|s| s.id == session.id).cloned();

    // If switching auth methods or store_password setting, clean up the old credential.
    if let Some(p) = &prev {
        // Target side
        if p.auth_method == "password" && (session.auth_method != "password") {
            keyring_delete(&session.id, false);
            state.password_cache.lock().unwrap().remove(&session.id);
        } else if p.auth_method == "password" && p.store_password && !session.store_password {
            // store→don't store: drop keyring entry
            keyring_delete(&session.id, false);
        } else if p.auth_method == "password" && !p.store_password && session.store_password {
            // don't store→store: drop in-memory cache (will be re-saved below if password provided)
            state.password_cache.lock().unwrap().remove(&session.id);
        }
        // Jump side
        let prev_jump = p.jump_host.as_ref();
        let new_jump = session.jump_host.as_ref();
        let jump_key = format!("{}:jump", session.id);
        let prev_was_pwd = matches!(prev_jump, Some(j) if j.auth_method == "password");
        let new_is_pwd = matches!(new_jump, Some(j) if j.auth_method == "password");
        if prev_was_pwd && !new_is_pwd {
            keyring_delete(&session.id, true);
            state.password_cache.lock().unwrap().remove(&jump_key);
        } else if let (Some(pj), Some(nj)) = (prev_jump, new_jump) {
            if pj.auth_method == "password" && pj.store_password && nj.auth_method == "password" && !nj.store_password {
                keyring_delete(&session.id, true);
            } else if pj.auth_method == "password" && !pj.store_password && nj.auth_method == "password" && nj.store_password {
                state.password_cache.lock().unwrap().remove(&jump_key);
            }
        }
    }

    persist_password_for_session(&state, &session.id, &session, password.as_deref(), jump_password.as_deref())?;

    if let Some(existing) = data.sessions.iter_mut().find(|s| s.id == session.id) { *existing = session; }
    save_data(&data)?;
    Ok(data)
}

#[tauri::command]
fn delete_session(id: String, state: State<AppState>) -> Result<SessionsData, String> {
    let mut data = load_data()?;
    data.sessions.retain(|s| s.id != id);
    // Always wipe associated credentials (cheap, idempotent).
    keyring_delete(&id, false);
    keyring_delete(&id, true);
    {
        let mut cache = state.password_cache.lock().unwrap();
        cache.remove(&id);
        cache.remove(&format!("{}:jump", id));
    }
    save_data(&data)?;
    Ok(data)
}

/// Save (or omit) password for a freshly created/updated session.
/// store_password=true → keyring; false → memory cache (only if value provided).
fn persist_password_for_session(
    state: &AppState,
    session_id: &str,
    session: &SshSession,
    password: Option<&str>,
    jump_password: Option<&str>,
) -> Result<(), String> {
    if session.auth_method == "password" {
        if let Some(p) = password {
            if session.store_password {
                keyring_set(session_id, false, p)?;
            } else {
                state.password_cache.lock().unwrap().insert(session_id.to_string(), p.to_string());
            }
        }
    }
    if let Some(jump) = &session.jump_host {
        if jump.auth_method == "password" {
            if let Some(p) = jump_password {
                if jump.store_password {
                    keyring_set(session_id, true, p)?;
                } else {
                    state.password_cache.lock().unwrap().insert(format!("{}:jump", session_id), p.to_string());
                }
            }
        }
    }
    Ok(())
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
    let new_id = Uuid::new_v4().to_string();
    // Copy keyring entries too so a duplicated session can connect immediately.
    if original.auth_method == "password" && original.store_password {
        if let Some(pwd) = keyring_get(&original.id, false) {
            let _ = keyring_set(&new_id, false, &pwd);
        }
    }
    if let Some(jump) = &original.jump_host {
        if jump.auth_method == "password" && jump.store_password {
            if let Some(pwd) = keyring_get(&original.id, true) {
                let _ = keyring_set(&new_id, true, &pwd);
            }
        }
    }
    data.sessions.push(SshSession {
        id: new_id,
        name: format!("{} (복사)", original.name),
        host: original.host,
        port: original.port,
        user: original.user,
        key_file: original.key_file,
        folder_id: original.folder_id,
        order: original.order + 1,
        jump_host: original.jump_host,
        auth_method: original.auth_method,
        store_password: original.store_password,
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

/// Apply key permissions fix only when the session uses key auth (and same for
/// jump). Skips entirely for password sessions to avoid touching unrelated paths.
fn fix_key_permissions_if_needed(session: &SshSession) -> Result<(), String> {
    if session.auth_method == "key" {
        fix_key_permissions(&session.key_file)?;
    }
    if let Some(jump) = &session.jump_host {
        if jump.auth_method == "key" {
            fix_key_permissions(&jump.key_file)?;
        }
    }
    Ok(())
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
    fix_key_permissions_if_needed(&session)?;

    // Backend can't know the user's language — emit a placeholder token for the
    // uncategorized prefix and let the frontend swap it via i18n.
    let folder_name_opt = session.folder_id.as_ref()
        .and_then(|fid| data.folders.iter().find(|f| f.id == *fid))
        .map(|f| f.name.clone());
    let payload_title = match &folder_name_opt {
        Some(f) => format!("{}:{}", f, session.name),
        None => format!("__UNCATEGORIZED__:{}", session.name),
    };
    let window_title = match &folder_name_opt {
        Some(f) => format!("{}:{}", f, session.name),
        None => session.name.clone(),
    };
    let ssh_args = build_ssh_args(&session);
    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload { terminal_id, title: payload_title, ssh_args, session_id: Some(session.id.clone()), adopt: false, initial_content: String::new() };

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
            .title(window_title.clone())
            .inner_size(1100.0, 720.0)
            .min_inner_size(640.0, 400.0)
            .resizable(true)
            .disable_drag_drop_handler();
        builder.build().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_take_pending(window_label: String, state: State<AppState>) -> Option<AddTabPayload> {
    state.pending_tabs.lock().unwrap().remove(&window_label)
}

/// Returns which password slots a session needs prompted for, given its
/// current credential state. Frontend calls this before connect; if non-empty,
/// it shows a prompt for each slot then calls `set_session_password` and
/// retries connect.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct PasswordNeed {
    /// "target" or "jump"
    slot: String,
    user: String,
    host: String,
}

#[tauri::command]
fn check_session_password_needs(session_id: String, state: State<AppState>) -> Result<Vec<PasswordNeed>, String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == session_id).ok_or("Session not found")?.clone();
    let mut needs = Vec::new();

    if session.auth_method == "password" {
        let have = if session.store_password {
            keyring_get(&session_id, false).is_some()
        } else {
            state.password_cache.lock().unwrap().contains_key(&session_id)
        };
        if !have {
            needs.push(PasswordNeed { slot: "target".into(), user: session.user.clone(), host: session.host.clone() });
        }
    }
    if let Some(jump) = &session.jump_host {
        if jump.auth_method == "password" {
            let key = format!("{}:jump", session_id);
            let have = if jump.store_password {
                keyring_get(&session_id, true).is_some()
            } else {
                state.password_cache.lock().unwrap().contains_key(&key)
            };
            if !have {
                needs.push(PasswordNeed { slot: "jump".into(), user: jump.user.clone(), host: jump.host.clone() });
            }
        }
    }
    Ok(needs)
}

/// Stash a password in the appropriate slot (keyring if store=true, memory otherwise).
/// Used by the connect-time prompt flow for sessions without a saved password.
#[tauri::command]
fn set_session_password(
    session_id: String,
    slot: String,
    password: String,
    state: State<AppState>,
) -> Result<(), String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == session_id).ok_or("Session not found")?;
    let is_jump = slot == "jump";
    let store = if is_jump {
        session.jump_host.as_ref().map(|j| j.store_password).unwrap_or(true)
    } else {
        session.store_password
    };
    if store {
        keyring_set(&session_id, is_jump, &password)?;
    } else {
        let key = if is_jump { format!("{}:jump", session_id) } else { session_id.clone() };
        state.password_cache.lock().unwrap().insert(key, password);
    }
    Ok(())
}

/// Forget a cached/saved password (e.g. after auth rejection so the next
/// attempt re-prompts the user instead of silently retrying with stale creds).
#[tauri::command]
fn clear_session_password(session_id: String, slot: String, state: State<AppState>) -> Result<(), String> {
    let is_jump = slot == "jump";
    keyring_delete(&session_id, is_jump);
    let key = if is_jump { format!("{}:jump", session_id) } else { session_id.clone() };
    state.password_cache.lock().unwrap().remove(&key);
    Ok(())
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
    fix_key_permissions_if_needed(session)?;
    // Same placeholder pattern as open_ssh — frontend resolves __UNCATEGORIZED__.
    let title = session.folder_id.as_ref()
        .and_then(|fid| data.folders.iter().find(|f| f.id == *fid))
        .map(|f| format!("{}:{}", f.name, session.name))
        .unwrap_or_else(|| format!("__UNCATEGORIZED__:{}", session.name));
    Ok(SessionArgs {
        title,
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
            .resizable(true)
            .disable_drag_drop_handler();
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
        .position(screen_x - 100.0, screen_y - 20.0)
        .disable_drag_drop_handler();
    builder.build().map_err(|e| e.to_string())?;
    Ok(true)
}

// --- PTY Commands ---

#[tauri::command]
fn pty_spawn(
    terminal_id: String,
    ssh_args: Vec<String>,
    session_id: Option<String>,
    rows: u16,
    cols: u16,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // Empty ssh_args = password-auth session: drive the connection in-process
    // via russh instead of shelling out to ssh.exe (which can't accept the
    // password non-interactively on Windows).
    if ssh_args.is_empty() {
        let sid = session_id.ok_or_else(|| "session_id required for password auth spawn".to_string())?;
        return spawn_russh_shell(terminal_id, sid, rows, cols, app, state);
    }

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

    let instance = Arc::new(PtyInstance::Cli {
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

/// In-process SSH shell via russh (used when session uses password auth, since
/// the system `ssh` CLI can't be fed a password non-interactively on Windows).
/// A tokio worker owns the channel and serves write/resize/kill requests over
/// an mpsc; reads are pumped to "pty-output" events as they arrive.
fn spawn_russh_shell(
    terminal_id: String,
    session_id: String,
    rows: u16,
    cols: u16,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == session_id).cloned()
        .ok_or("Session not found")?;

    fix_key_permissions_if_needed(&session)?;

    let target_pwd = if session.auth_method == "password" {
        resolve_password(&state, &session.id, false, session.store_password)
    } else { None };
    let jump_pwd = match &session.jump_host {
        Some(j) if j.auth_method == "password" => resolve_password(&state, &session.id, true, j.store_password),
        _ => None,
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<RusshShellCmd>();
    let instance = Arc::new(PtyInstance::Russh { tx });
    state.ptys.lock().unwrap().insert(terminal_id.clone(), instance);

    let app_clone = app.clone();
    let tid = terminal_id.clone();
    state.runtime.spawn(async move {
        let config = Arc::new(russh::client::Config::default());
        let (jump_handle, target_handle) = match connect_handles(&session, config, target_pwd, jump_pwd).await {
            Ok(h) => h,
            Err(e) => {
                let msg = format!("\r\n\x1b[1;31mConnection failed: {}\x1b[0m\r\n", e);
                let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: msg.into_bytes() });
                let _ = app_clone.emit("pty-exit", PtyExitPayload { terminal_id: tid });
                return;
            }
        };
        let _keep_jump = jump_handle;

        let channel = match target_handle.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("\r\n\x1b[1;31mShell channel failed: {}\x1b[0m\r\n", e);
                let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: msg.into_bytes() });
                let _ = app_clone.emit("pty-exit", PtyExitPayload { terminal_id: tid });
                return;
            }
        };
        if let Err(e) = channel.request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]).await {
            let msg = format!("\r\n\x1b[1;31mrequest_pty failed: {}\x1b[0m\r\n", e);
            let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: msg.into_bytes() });
            let _ = app_clone.emit("pty-exit", PtyExitPayload { terminal_id: tid });
            return;
        }
        if let Err(e) = channel.request_shell(true).await {
            let msg = format!("\r\n\x1b[1;31mrequest_shell failed: {}\x1b[0m\r\n", e);
            let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: msg.into_bytes() });
            let _ = app_clone.emit("pty-exit", PtyExitPayload { terminal_id: tid });
            return;
        }

        let mut channel = channel;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: data.to_vec() });
                        }
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: data.to_vec() });
                        }
                        Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => break,
                        Some(_) => continue,
                        None => break,
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(RusshShellCmd::Write(buf)) => {
                            let _ = channel.data(&buf[..]).await;
                        }
                        Some(RusshShellCmd::Resize { rows, cols }) => {
                            let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                        }
                        Some(RusshShellCmd::Kill) | None => break,
                    }
                }
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
    match &*pty {
        PtyInstance::Cli { writer, .. } => {
            let mut w = writer.lock().unwrap();
            w.write_all(&data).map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
        }
        PtyInstance::Russh { tx } => {
            tx.send(RusshShellCmd::Write(data)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(terminal_id: String, rows: u16, cols: u16, state: State<AppState>) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    let pty = ptys.get(&terminal_id).ok_or("Unknown terminal")?.clone();
    drop(ptys);
    match &*pty {
        PtyInstance::Cli { master, .. } => {
            master.lock().unwrap()
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| e.to_string())?;
        }
        PtyInstance::Russh { tx } => {
            tx.send(RusshShellCmd::Resize { rows, cols }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(terminal_id: String, state: State<AppState>) -> Result<(), String> {
    let pty = state.ptys.lock().unwrap().remove(&terminal_id);
    if let Some(pty) = pty {
        match &*pty {
            PtyInstance::Cli { child, .. } => { let _ = child.lock().unwrap().kill(); }
            PtyInstance::Russh { tx } => { let _ = tx.send(RusshShellCmd::Kill); }
        }
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
    fix_key_permissions_if_needed(&session)?;
    let target_pwd = if session.auth_method == "password" { resolve_password(&state, &session.id, false, session.store_password) } else { None };
    let jump_pwd = match &session.jump_host {
        Some(j) if j.auth_method == "password" => resolve_password(&state, &session.id, true, j.store_password),
        _ => None,
    };
    let rt = &state.runtime;
    rt.block_on(async {
        let config = Arc::new(russh::client::Config::default());
        let (sftp, _jump, _target) = connect_sftp(&session, config, target_pwd, jump_pwd).await?;
        let home = sftp.canonicalize(".").await.map_err(|e| format!("home: {}", e))?;
        Ok::<String, String>(home)
    })
}

#[tauri::command]
fn sftp_connect(session_id: String, state: State<AppState>) -> Result<String, String> {
    let data = load_data()?;
    let session = data.sessions.iter().find(|s| s.id == session_id).ok_or("Session not found")?.clone();

    fix_key_permissions_if_needed(&session)?;

    let target_pwd = if session.auth_method == "password" { resolve_password(&state, &session.id, false, session.store_password) } else { None };
    let jump_pwd = match &session.jump_host {
        Some(j) if j.auth_method == "password" => resolve_password(&state, &session.id, true, j.store_password),
        _ => None,
    };

    let rt = &state.runtime;
    let result = rt.block_on(async {
        let config = Arc::new(russh::client::Config::default());
        let (sftp, _jump, _target) = connect_sftp(&session, config, target_pwd, jump_pwd).await?;

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
                    SftpCommand::UploadBytes { remote_dir, filename, data, app, session_id, reply } => { let _ = reply.send(upload_bytes_impl(&sftp, &remote_dir, &filename, &data, &app, &session_id).await); }
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
async fn sftp_upload(session_id: String, remote_dir: String, local_path: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tx = {
        let connections = state.sftp_connections.lock().unwrap();
        let handle = connections.get(&session_id).ok_or("Not connected")?;
        handle.tx.clone()
    };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(SftpCommand::Upload { local_path, remote_dir, app, session_id: session_id.clone(), reply: reply_tx }).await
        .map_err(|_| "Worker disconnected".to_string())?;
    reply_rx.await.map_err(|_| "Worker crashed".to_string())?
}

#[tauri::command]
async fn sftp_upload_bytes(session_id: String, remote_dir: String, filename: String, data: Vec<u8>, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tx = {
        let connections = state.sftp_connections.lock().unwrap();
        let handle = connections.get(&session_id).ok_or("Not connected")?;
        handle.tx.clone()
    };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(SftpCommand::UploadBytes { remote_dir, filename, data, app, session_id: session_id.clone(), reply: reply_tx }).await
        .map_err(|_| "Worker disconnected".to_string())?;
    reply_rx.await.map_err(|_| "Worker crashed".to_string())?
}

/// Async — downloads can take minutes. A sync command would run on the
/// Tauri main thread and block_on(reply_rx) freezes the window. async
/// fn lets Tauri schedule the await on its async pool, keeping the
/// main message pump free.
#[tauri::command]
async fn sftp_download(session_id: String, remote_path: String, local_path: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tx = {
        let connections = state.sftp_connections.lock().unwrap();
        let handle = connections.get(&session_id).ok_or("Not connected")?;
        handle.tx.clone()
    };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(SftpCommand::Download { remote_path, local_path, app, session_id: session_id.clone(), reply: reply_tx }).await
        .map_err(|_| "Worker disconnected".to_string())?;
    reply_rx.await.map_err(|_| "Worker crashed".to_string())?
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
            password_cache: Mutex::new(HashMap::new()),
            runtime,
        })
        .invoke_handler(tauri::generate_handler![
            get_all_data, create_session, update_session, delete_session, copy_session,
            create_folder, update_folder, delete_folder,
            reorder_sessions, reorder_folders, open_ssh,
            sftp_connect, sftp_disconnect, sftp_list_dir,
            sftp_upload, sftp_upload_bytes, sftp_download, sftp_mkdir, sftp_delete,
            get_session_home,
            pty_spawn, pty_write, pty_resize, pty_kill, pty_take_pending, drop_tab,
            spawn_terminal, get_ssh_args_for_session,
            get_terminal_theme, set_terminal_theme,
            get_terminal_font, set_terminal_font,
            get_log_dir, set_log_dir, get_ssh_verbose, set_ssh_verbose,
            clear_logs, open_path_in_os,
            get_data_file_path, set_data_file_path,
            export_sessions_to, import_sessions_from,
            check_session_password_needs, set_session_password, clear_session_password
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
