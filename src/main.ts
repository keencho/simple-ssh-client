import { invoke } from "@tauri-apps/api/core";
import { open, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";

// --- Types ---

interface JumpHost {
  host: string;
  port: number;
  user: string;
  key_file: string;
}

interface SshSession {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  key_file: string;
  folder_id: string | null;
  order: number;
  jump_host: JumpHost | null;
}

interface Folder {
  id: string;
  name: string;
  order: number;
}

interface SessionsData {
  folders: Folder[];
  sessions: SshSession[];
  root_folder_order: number | null;
}

// --- State ---

let data: SessionsData = { folders: [], sessions: [], root_folder_order: null };
let searchQuery = "";
let collapsedFolders = new Set<string>();
let globalNewWindow = false;

// --- SVG Icons ---

const ICONS = {
  search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
  refresh: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>`,
  plus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>`,
  edit: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>`,
  close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  key: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  jump: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>`,
  folder: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
  chevronDown: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`,
  chevronRight: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`,
  terminal: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  server: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>`,
  drag: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.4"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`,
};

// --- Helpers ---

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getFolderName(folderId: string | null): string {
  if (!folderId) return "";
  return data.folders.find((f) => f.id === folderId)?.name || "";
}

function getKeyFileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function getSortedFolders(): Folder[] {
  return [...data.folders].sort((a, b) => a.order - b.order);
}

function getSessionsForFolder(folderId: string | null): SshSession[] {
  const q = searchQuery.toLowerCase();
  return data.sessions
    .filter((s) => {
      if (s.folder_id !== folderId) return false;
      if (!q) return true;
      const folderName = getFolderName(s.folder_id).toLowerCase();
      return s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q) || s.user.toLowerCase().includes(q) || folderName.includes(q);
    })
    .sort((a, b) => a.order - b.order);
}

function hasMatchingSessionsInFolder(folderId: string): boolean {
  if (!searchQuery) return true;
  return getSessionsForFolder(folderId).length > 0;
}

// --- Actions ---

async function loadData() {
  try {
    data = await invoke<SessionsData>("get_all_data");
    renderTree();
    renderStats();
  } catch (e) {
    const area = document.getElementById("content-area");
    if (area) area.innerHTML = `<div class="empty" style="color:var(--red)">데이터 로드 실패: ${e}</div>`;
  }
}

async function connectSession(id: string, newWindow: boolean) {
  try {
    await invoke("open_ssh", { id, newWindow });
  } catch (e) {
    alert("연결 실패: " + e);
  }
}

let deleteInProgress = false;
async function deleteSession(id: string) {
  if (deleteInProgress) return;
  deleteInProgress = true;
  try {
    const session = data.sessions.find((s) => s.id === id);
    const ok = await tauriConfirm(`"${session?.name || id}" 세션을 삭제할까요?`, { title: "세션 삭제", kind: "warning" });
    if (!ok) return;
    data = await invoke<SessionsData>("delete_session", { id });
    renderTree();
    renderStats();
  } catch (e) {
    alert("삭제 실패: " + e);
  } finally {
    deleteInProgress = false;
  }
}

async function addFolder() {
  const name = prompt("폴더 이름:");
  if (!name) return;
  try {
    data = await invoke<SessionsData>("create_folder", { name });
    renderTree();
    renderStats();
  } catch (e) {
    alert("폴더 생성 실패: " + e);
  }
}

async function editFolder(id: string) {
  const folder = data.folders.find((f) => f.id === id);
  if (!folder) return;
  const name = prompt("폴더 이름 변경 (비우면 삭제):", folder.name);
  if (name === null) return;
  if (!name) {
    const ok = await tauriConfirm(`"${folder.name}" 폴더를 삭제할까요?\n(세션은 미분류로 이동됩니다)`, { title: "폴더 삭제", kind: "warning" });
    if (!ok) return;
    data = await invoke<SessionsData>("delete_folder", { id });
    collapsedFolders.delete(id);
  } else {
    data = await invoke<SessionsData>("update_folder", { id, name });
  }
  renderTree();
  renderStats();
}

// --- Custom DnD (inline transform animation) ---

interface DndItem {
  el: HTMLElement;
  id: string;
  midY: number; // original center Y
  height: number;
  originalIndex: number;
}

let dndJustFinished = false;

let dnd: {
  type: "session" | "folder";
  dragEl: HTMLElement;
  dragId: string;
  dragOrigIdx: number;
  items: DndItem[];
  currentIndex: number;
  startY: number;
  folderId: string | null;
} | null = null;

function initDnD() {
  const content = document.getElementById("content-area")!;

  content.addEventListener("mousedown", (e) => {
    const handle = (e.target as HTMLElement).closest(".drag-handle") as HTMLElement | null;
    if (!handle) return;

    const sessionRow = handle.closest("[data-session-id]") as HTMLElement | null;
    const folderHeader = handle.closest(".tree-folder-header") as HTMLElement | null;

    let type: "session" | "folder";
    let dragEl: HTMLElement;
    let dragId: string;
    let folderId: string | null = null;

    if (sessionRow) {
      type = "session";
      dragEl = sessionRow;
      dragId = sessionRow.dataset.sessionId!;
      const s = data.sessions.find((s) => s.id === dragId);
      folderId = s?.folder_id ?? null;
    } else if (folderHeader) {
      const folderEl = folderHeader.closest("[data-folder-id]") as HTMLElement | null;
      if (!folderEl) return;
      type = "folder";
      dragEl = folderEl;
      dragId = folderEl.dataset.folderId!;
    } else {
      return;
    }

    e.preventDefault();

    // Collect all siblings of same type in same container
    let allEls: HTMLElement[];
    if (type === "session") {
      const parent = dragEl.parentElement!;
      allEls = Array.from(parent.children).filter(
        (el) => el instanceof HTMLElement && el.dataset.sessionId
      ) as HTMLElement[];
    } else {
      // Only direct children of content-area that are folders
      allEls = Array.from(content.children).filter(
        (el) => el instanceof HTMLElement && el.dataset.folderId
      ) as HTMLElement[];
    }

    const items: DndItem[] = allEls.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        id: type === "session" ? el.dataset.sessionId! : el.dataset.folderId!,
        midY: r.top + r.height / 2,
        height: r.height,
        originalIndex: i,
      };
    });

    const dragOrigIdx = items.findIndex((it) => it.id === dragId);
    if (dragOrigIdx < 0) return;

    dragEl.style.position = "relative";
    dragEl.style.zIndex = "100";
    dragEl.classList.add("dnd-active-item");
    document.body.classList.add("dnd-active");

    dnd = {
      type,
      dragEl,
      dragId,
      dragOrigIdx,
      items,
      currentIndex: dragOrigIdx,
      startY: e.clientY,
      folderId,
    };
  });

  document.addEventListener("mousemove", (e) => {
    if (!dnd) return;
    e.preventDefault();

    const deltaY = e.clientY - dnd.startY;
    const { dragOrigIdx, items, dragId } = dnd;
    const dragItem = items[dragOrigIdx];

    // Move dragged element
    dnd.dragEl.style.transform = `translateY(${deltaY}px)`;

    // Determine new index by comparing mouse position to original midpoints
    const mouseY = e.clientY;
    let newIndex = dragOrigIdx;

    if (deltaY > 0) {
      // Moving down
      for (let i = dragOrigIdx + 1; i < items.length; i++) {
        if (mouseY > items[i].midY) {
          newIndex = i;
        } else {
          break;
        }
      }
    } else {
      // Moving up
      for (let i = dragOrigIdx - 1; i >= 0; i--) {
        if (mouseY < items[i].midY) {
          newIndex = i;
        } else {
          break;
        }
      }
    }

    if (newIndex !== dnd.currentIndex) {
      dnd.currentIndex = newIndex;

      // Animate other items to make room
      for (const item of items) {
        if (item.id === dragId) continue;

        let shift = 0;
        if (dragOrigIdx < newIndex) {
          // Dragging down: items between old+1 and new move up by drag item height
          if (item.originalIndex > dragOrigIdx && item.originalIndex <= newIndex) {
            shift = -dragItem.height;
          }
        } else if (dragOrigIdx > newIndex) {
          // Dragging up: items between new and old-1 move down
          if (item.originalIndex >= newIndex && item.originalIndex < dragOrigIdx) {
            shift = dragItem.height;
          }
        }

        item.el.style.transition = "transform 0.2s ease";
        item.el.style.transform = shift ? `translateY(${shift}px)` : "";
      }
    }
  });

  document.addEventListener("mouseup", async () => {
    if (!dnd) return;

    const { type, dragId, items, currentIndex, dragOrigIdx, folderId } = dnd;

    // Cleanup styles immediately
    for (const item of items) {
      item.el.style.transform = "";
      item.el.style.transition = "";
      item.el.style.position = "";
      item.el.style.zIndex = "";
    }
    dnd.dragEl.classList.remove("dnd-active-item");
    document.body.classList.remove("dnd-active");
    dnd = null;
    dndJustFinished = true;
    setTimeout(() => { dndJustFinished = false; }, 50);

    // Skip if no change
    if (dragOrigIdx === currentIndex) return;

    // Build new order
    const ids = items.map((it) => it.id);
    const moved = ids.splice(dragOrigIdx, 1)[0];
    ids.splice(currentIndex, 0, moved);

    // Save & re-render immediately
    if (type === "session") {
      const updates: SshSession[] = ids.map((sid, i) => {
        const s = data.sessions.find((s) => s.id === sid)!;
        return { ...s, order: i, folder_id: folderId };
      });
      try {
        data = await invoke<SessionsData>("reorder_sessions", { sessions: updates });
      } catch (e) {
        alert("순서 변경 실패: " + e);
      }
    } else {
      let rootFolderOrder: number | null = null;
      const updates: Folder[] = [];
      ids.forEach((fid, i) => {
        if (fid === "__root__") {
          rootFolderOrder = i;
        } else {
          const f = data.folders.find((f) => f.id === fid)!;
          updates.push({ ...f, order: i });
        }
      });
      try {
        data = await invoke<SessionsData>("reorder_folders", { folders: updates, rootFolderOrder });
      } catch (e) {
        alert("순서 변경 실패: " + e);
      }
    }
    renderTree();
  });
}

// --- Modal ---

function openModal(session?: SshSession, defaultFolderId?: string | null) {
  const isEdit = !!session;
  const folders = getSortedFolders();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="modal-close">${ICONS.close}</button>
      <div class="modal-title">${isEdit ? "세션 편집" : "세션 추가"}</div>
      <div class="form-group">
        <label class="form-label">이름</label>
        <input class="form-input" id="f-name" value="${escapeHtml(session?.name || "")}" placeholder="서버 이름" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Host</label>
          <input class="form-input" id="f-host" value="${escapeHtml(session?.host || "")}" placeholder="IP 또는 hostname" />
        </div>
        <div class="form-group small">
          <label class="form-label">Port</label>
          <input class="form-input" id="f-port" type="number" value="${session?.port || 22}" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">User</label>
        <input class="form-input" id="f-user" value="${escapeHtml(session?.user || "")}" placeholder="ec2-user" />
      </div>
      <div class="form-group">
        <label class="form-label">Key File</label>
        <div class="form-file-row">
          <input class="form-input" id="f-keyfile" value="${escapeHtml(session?.key_file || "")}" placeholder="SSH key 경로" />
          <button class="form-file-btn" id="f-browse-key">찾기</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">폴더</label>
        <select class="form-select" id="f-folder">
          <option value="">(미분류)</option>
          ${folders.map((f) => {
            const selected = isEdit ? session?.folder_id === f.id : defaultFolderId === f.id;
            return `<option value="${f.id}" ${selected ? "selected" : ""}>${escapeHtml(f.name)}</option>`;
          }).join("")}
        </select>
      </div>
      <label class="jump-toggle">
        <input type="checkbox" id="f-use-jump" ${session?.jump_host ? "checked" : ""} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="jump-toggle-label">Jump Host 사용</span>
      </label>
      <div class="jump-section ${session?.jump_host ? "" : "hidden"}" id="jump-section">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Jump Host</label>
            <input class="form-input" id="f-jhost" value="${escapeHtml(session?.jump_host?.host || "")}" placeholder="Bastion IP" />
          </div>
          <div class="form-group small">
            <label class="form-label">Port</label>
            <input class="form-input" id="f-jport" type="number" value="${session?.jump_host?.port || 22}" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Jump User</label>
          <input class="form-input" id="f-juser" value="${escapeHtml(session?.jump_host?.user || "")}" placeholder="ec2-user" />
        </div>
        <div class="form-group">
          <label class="form-label">Jump Key File</label>
          <div class="form-file-row">
            <input class="form-input" id="f-jkeyfile" value="${escapeHtml(session?.jump_host?.key_file || "")}" placeholder="Bastion key 경로" />
            <button class="form-file-btn" id="f-browse-jkey">찾기</button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-cancel" id="modal-cancel">취소</button>
        <button class="btn-save" id="modal-save">저장</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#modal-close")!.addEventListener("click", close);
  overlay.querySelector("#modal-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const jumpCb = overlay.querySelector("#f-use-jump") as HTMLInputElement;
  const jumpSec = overlay.querySelector("#jump-section") as HTMLElement;
  jumpCb.addEventListener("change", () => jumpSec.classList.toggle("hidden", !jumpCb.checked));

  overlay.querySelector("#f-browse-key")!.addEventListener("click", async () => {
    const path = await open({ filters: [{ name: "Key Files", extensions: ["pem", "key", "ppk"] }], multiple: false });
    if (path) (overlay.querySelector("#f-keyfile") as HTMLInputElement).value = path as string;
  });
  overlay.querySelector("#f-browse-jkey")!.addEventListener("click", async () => {
    const path = await open({ filters: [{ name: "Key Files", extensions: ["pem", "key", "ppk"] }], multiple: false });
    if (path) (overlay.querySelector("#f-jkeyfile") as HTMLInputElement).value = path as string;
  });

  overlay.querySelector("#modal-save")!.addEventListener("click", async () => {
    const name = (overlay.querySelector("#f-name") as HTMLInputElement).value.trim();
    const host = (overlay.querySelector("#f-host") as HTMLInputElement).value.trim();
    const port = parseInt((overlay.querySelector("#f-port") as HTMLInputElement).value) || 22;
    const user = (overlay.querySelector("#f-user") as HTMLInputElement).value.trim();
    const keyFile = (overlay.querySelector("#f-keyfile") as HTMLInputElement).value.trim();
    const folderId = (overlay.querySelector("#f-folder") as HTMLSelectElement).value || null;
    if (!name || !host || !user) { alert("이름, Host, User는 필수 항목입니다."); return; }

    let jumpHost: JumpHost | null = null;
    if (jumpCb.checked) {
      const jHost = (overlay.querySelector("#f-jhost") as HTMLInputElement).value.trim();
      const jPort = parseInt((overlay.querySelector("#f-jport") as HTMLInputElement).value) || 22;
      const jUser = (overlay.querySelector("#f-juser") as HTMLInputElement).value.trim();
      const jKey = (overlay.querySelector("#f-jkeyfile") as HTMLInputElement).value.trim();
      if (jHost && jUser) jumpHost = { host: jHost, port: jPort, user: jUser, key_file: jKey };
    }

    try {
      if (isEdit && session) {
        data = await invoke<SessionsData>("update_session", {
          session: { ...session, name, host, port, user, key_file: keyFile, folder_id: folderId, jump_host: jumpHost },
        });
      } else {
        data = await invoke<SessionsData>("create_session", { name, host, port, user, keyFile, folderId, jumpHost });
      }
      close(); renderTree(); renderStats();
    } catch (e) { alert("저장 실패: " + e); }
  });

  const escHandler = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
  setTimeout(() => (overlay.querySelector("#f-name") as HTMLInputElement)?.focus(), 50);
}

// --- Render ---

function renderStats() {
  const el = document.getElementById("stats");
  if (!el) return;
  el.textContent = `${data.folders.length}개 폴더 / ${data.sessions.length}개 세션`;
}

function renderSessionRow(s: SshSession): string {
  const jumpInfo = s.jump_host ? `<span class="row-tag row-tag-jump">${ICONS.jump} via ${escapeHtml(s.jump_host.host)}</span>` : "";
  const keyInfo = s.key_file ? `<span class="row-tag row-tag-key">${ICONS.key} ${escapeHtml(getKeyFileName(s.key_file))}</span>` : "";

  return `
    <div class="tree-row tree-session" data-session-id="${s.id}">
      <div class="drag-handle">${ICONS.drag}</div>
      <div class="row-icon">${ICONS.server}</div>
      <div class="row-name">${escapeHtml(s.name)}</div>
      <div class="row-connection">${escapeHtml(s.user)}@${escapeHtml(s.host)}:${s.port}</div>
      <div class="row-tags">${keyInfo}${jumpInfo}</div>
      <div class="row-actions">
        <label class="toggle-mini" title="새 창에서 열기">
          <input type="checkbox" data-newwin-for="${s.id}" />
          <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
        </label>
        <button class="btn-sm btn-connect-sm" data-action="connect" data-id="${s.id}" title="연결">${ICONS.terminal}</button>
        <button class="btn-sm btn-edit-sm" data-action="edit" data-id="${s.id}" title="편집">${ICONS.edit}</button>
        <button class="btn-sm btn-delete-sm" data-action="delete" data-id="${s.id}" title="삭제">${ICONS.trash}</button>
      </div>
    </div>
  `;
}

function renderTree() {
  const container = document.getElementById("content-area");
  if (!container) return;

  if (data.sessions.length === 0) {
    container.innerHTML = '<div class="empty">세션을 추가해주세요</div>';
    return;
  }

  const folders = getSortedFolders();
  const rootSessions = getSessionsForFolder(null);
  const showRootFolder = rootSessions.length > 0 && folders.length > 0;
  let html = "";

  // Build ordered list: real folders + __root__ (if applicable)
  const rootOrder = data.root_folder_order ?? folders.length;
  type FolderEntry = { type: "folder"; folder: Folder } | { type: "root" };
  const entries: FolderEntry[] = folders.map((f) => ({ type: "folder" as const, folder: f }));
  if (showRootFolder) {
    entries.push({ type: "root" as const });
  }
  entries.sort((a, b) => {
    const oa = a.type === "root" ? rootOrder : a.folder.order;
    const ob = b.type === "root" ? rootOrder : b.folder.order;
    return oa - ob;
  });

  for (const entry of entries) {
    if (entry.type === "root") {
      html += `
        <div class="tree-folder" data-folder-id="__root__">
          <div class="tree-folder-header tree-folder-root" data-folder-toggle="__root__">
            <div class="drag-handle">${ICONS.drag}</div>
            <span class="folder-chevron">${collapsedFolders.has("__root__") ? ICONS.chevronRight : ICONS.chevronDown}</span>
            <span class="folder-name folder-name-dim">미분류</span>
            <span class="folder-count">${rootSessions.length}</span>
          </div>
          ${collapsedFolders.has("__root__") ? "" : `<div class="tree-children">${rootSessions.map(renderSessionRow).join("")}</div>`}
        </div>
      `;
      continue;
    }
    const folder = entry.folder;
    if (!hasMatchingSessionsInFolder(folder.id)) continue;
    const sessions = getSessionsForFolder(folder.id);
    const isCollapsed = collapsedFolders.has(folder.id);
    const chevron = isCollapsed ? ICONS.chevronRight : ICONS.chevronDown;

    html += `
      <div class="tree-folder" data-folder-id="${folder.id}">
        <div class="tree-folder-header" data-folder-toggle="${folder.id}">
          <div class="drag-handle">${ICONS.drag}</div>
          <span class="folder-chevron">${chevron}</span>
          <span class="folder-icon">${ICONS.folder}</span>
          <span class="folder-name">${escapeHtml(folder.name)}</span>
          <span class="folder-count">${sessions.length}</span>
          <div class="folder-actions">
            <button class="btn-sm btn-add-in-folder" data-action="add-in-folder" data-folder-id="${folder.id}" title="세션 추가">${ICONS.plus}</button>
            <button class="btn-sm btn-edit-sm" data-action="edit-folder" data-folder-id="${folder.id}" title="폴더 편집">${ICONS.edit}</button>
          </div>
        </div>
        ${isCollapsed ? "" : `<div class="tree-children">${sessions.map(renderSessionRow).join("")}</div>`}
      </div>
    `;
  }

  if (rootSessions.length > 0 && folders.length === 0) {
    html += rootSessions.map(renderSessionRow).join("");
  }

  if (!html) { container.innerHTML = '<div class="empty">검색 결과가 없습니다</div>'; return; }
  container.innerHTML = html;
}

function renderShell() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="container">
      <header>
        <div class="toolbar">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input type="text" id="search" placeholder="검색..." />
          </div>
          <button class="btn-action" id="add-session-btn">${ICONS.plus} 세션</button>
          <button class="btn-action" id="add-folder-btn">${ICONS.folder} 폴더</button>
          <label class="toggle-newwin" title="새 창에서 열기">
            <input type="checkbox" id="global-newwin" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-text-label">New Window</span>
          </label>
          <button class="btn-ghost" id="refresh-btn" title="새로고침">${ICONS.refresh}</button>
        </div>
        <div class="stats" id="stats"></div>
      </header>
      <div id="content-area" class="tree-list"></div>
    </div>
  `;

  const searchInput = document.getElementById("search") as HTMLInputElement;
  searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderTree(); });

  document.getElementById("add-session-btn")!.addEventListener("click", () => openModal());
  document.getElementById("add-folder-btn")!.addEventListener("click", addFolder);
  document.getElementById("refresh-btn")!.addEventListener("click", loadData);

  (document.getElementById("global-newwin") as HTMLInputElement).addEventListener("change", (e) => {
    globalNewWindow = (e.target as HTMLInputElement).checked;
  });

  // Event delegation
  const contentArea = document.getElementById("content-area")!;

  contentArea.addEventListener("click", (e) => {
    if (dndJustFinished) return;

    const folderHeader = (e.target as HTMLElement).closest("[data-folder-toggle]") as HTMLElement | null;
    if (folderHeader && !(e.target as HTMLElement).closest("[data-action]") && !(e.target as HTMLElement).closest(".drag-handle")) {
      const fId = folderHeader.dataset.folderToggle!;
      if (collapsedFolders.has(fId)) collapsedFolders.delete(fId); else collapsedFolders.add(fId);
      renderTree();
      return;
    }

    const actionEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!actionEl) return;
    e.stopPropagation();

    const action = actionEl.dataset.action;
    if (action === "connect") {
      const id = actionEl.dataset.id!;
      const perSession = document.querySelector(`input[data-newwin-for="${id}"]`) as HTMLInputElement | null;
      connectSession(id, perSession?.checked ?? globalNewWindow);
    } else if (action === "edit") {
      const s = data.sessions.find((s) => s.id === actionEl.dataset.id);
      if (s) openModal(s);
    } else if (action === "delete") {
      deleteSession(actionEl.dataset.id!);
    } else if (action === "edit-folder") {
      editFolder(actionEl.dataset.folderId!);
    } else if (action === "add-in-folder") {
      openModal(undefined, actionEl.dataset.folderId!);
    }
  });

  // Double-click to connect
  contentArea.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("[data-action]")) return;
    if ((e.target as HTMLElement).closest(".drag-handle")) return;
    const row = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
    if (!row) return;
    const sid = row.dataset.sessionId!;
    const perSession = document.querySelector(`input[data-newwin-for="${sid}"]`) as HTMLInputElement | null;
    connectSession(sid, perSession?.checked ?? globalNewWindow);
  });

  initDnD();
  renderTree();
}

(async () => {
  renderShell();
  await loadData();
})();
