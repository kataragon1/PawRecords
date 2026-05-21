// ── FILES ── Drive files panel, processing pipeline, batch jobs
import {
  driveAccessToken, setDriveAccessToken,
  apiKey,
  _fileStatusCache, setFileStatusCache,
  _activeFileFilter, setActiveFileFilter,
  _fileSort, setFileSort,
  _fileSortDir, setFileSortDir,
  processingQueue, setProcessingQueue,
  processingActive, setProcessingActive,
  processingStop, setProcessingStop,
  _allVisitsCache, setAllVisitsCache,
  _allLabsCache, setAllLabsCache,
  _activeTab,
  wakeLock, setWakeLock,
  APP_PETS,
} from './state.js';

import {
  db, doc, getDoc, setDoc, deleteDoc, updateDoc, arrayRemove, writeBatch,
  collection, getDocs, query, where,
  provider, auth, signInWithPopup, GoogleAuthProvider,
  $, showToast, showAlert, escHtml, formatSize, sleep, invalidateChatContext,
} from './core.js';

// ── FILE STATUS CACHE ──
export function invalidateFileStatusCache() { setFileStatusCache(null); }

export async function loadFileStatuses(driveFileIds) {
  if (!driveFileIds.length) return {};
  if (_fileStatusCache) {
    const map = {};
    driveFileIds.forEach(id => { map[id] = _fileStatusCache[id] || 'unprocessed'; });
    return map;
  }
  const map = {};
  try {
    for (let i = 0; i < driveFileIds.length; i += 10) {
      const batch = driveFileIds.slice(i, i + 10);
      const snap = await getDocs(query(collection(db, 'files'), where('driveFileId', 'in', batch)));
      snap.forEach(d => { map[d.data().driveFileId] = d.data().status || 'unprocessed'; });
    }
    const newCache = _fileStatusCache ? { ..._fileStatusCache } : {};
    Object.assign(newCache, map);
    setFileStatusCache(newCache);
  } catch(err) { console.error('Status load error:', err); }
  return map;
}

// ── WRITE FILE STATUS ──
export async function writeFileStatus(fileId, filename, status, extra = {}) {
  invalidateFileStatusCache();
  const ref = doc(db, 'files', fileId);
  await setDoc(ref, sanitizeForFirestore({
    driveFileId: fileId,
    filename,
    driveUrl: `https://drive.google.com/file/d/${fileId}/view`,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  }), { merge: true });
}

// ── SANITIZE FOR FIRESTORE ──
export function sanitizeForFirestore(val, depth = 0) {
  if (depth > 10) return null;
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) return null;
    return val;
  }
  if (typeof val === 'string') {
    return val.length > 900000 ? val.slice(0, 900000) + '…[truncated]' : val;
  }
  if (typeof val === 'boolean') return val;
  if (Array.isArray(val)) {
    return val.map(v => sanitizeForFirestore(v, depth + 1)).filter(v => v !== undefined);
  }
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const clean = sanitizeForFirestore(v, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return val;
}

// ── WAKE LOCK ──
export async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      const wl = await navigator.wakeLock.request('screen');
      setWakeLock(wl);
    }
  } catch(e) { /* non-critical */ }
}

export function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); setWakeLock(null); }
}

// ── FILTER FILES ──
export function filterFiles(filter) {
  setActiveFileFilter(filter);
  document.querySelectorAll('.file-item').forEach(el => {
    const status = el.dataset.status;
    let show = false;
    if (filter === 'all') show = true;
    else if (filter === 'done') show = (status === 'complete' || status === 'flagged');
    else if (filter === 'empty') show = (status === 'empty');
    else if (filter === 'unprocessed') show = (status === 'unprocessed' || status === 'failed');
    else show = (status === filter);
    el.style.display = show ? 'flex' : 'none';
  });
  updateSelectAllLabel();
  updateProcessButtons();
}

export function updateSelectAllLabel() {
  const sal = $('select-all-link');
  if (!sal) return;
  const visible = [...document.querySelectorAll('.file-item')]
    .filter(el => el.style.display !== 'none');
  const allChecked = visible.length > 0 && visible.every(el => el.querySelector('.file-item-checkbox')?.checked);
  sal.textContent = allChecked ? 'deselect all' : 'select all';
}

// ── DRIVE RECONNECT ──
export async function reconnectDrive(triggerEl) {
  if (triggerEl) { triggerEl.disabled = true; triggerEl.textContent = 'Connecting…'; }
  try {
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      setDriveAccessToken(credential.accessToken);
      try { sessionStorage.setItem('pr_drive_token', credential.accessToken); } catch(e) {}
      $('drive-dot').className = 'status-dot green';
      $('drive-status').textContent = 'Drive connected';
      showToast('Drive reconnected ✓', 'journal');
      window._driveLastLoaded = Date.now();
      await loadDriveFiles();
    } else {
      showAlert('Drive reconnect did not return an access token. Please try again.', 'warning');
    }
  } catch(e) {
    if (e.code === 'auth/cancelled-popup-request' || e.code === 'auth/popup-closed-by-user') {
      // User closed popup — silent
    } else {
      showAlert(`Drive reconnect failed: ${e.message}`, 'warning');
    }
  } finally {
    if (triggerEl) { triggerEl.disabled = false; triggerEl.textContent = 'Reconnect Drive'; }
  }
}

// ── CONNECT PROMPT ──
export function showDriveConnectPrompt(message) {
  const prompt = $('drive-connect-prompt');
  if (!prompt) return;
  const p = prompt.querySelector('p');
  if (p) p.textContent = message;
  prompt.style.display = 'flex';
  const filesList = $('files-list');
  if (filesList) {
    const spinner = filesList.querySelector('.files-loading');
    if (spinner) spinner.remove();
  }
  const dot = $('drive-dot');
  if (dot) dot.className = 'status-dot amber';
  const statusEl = $('drive-status');
  if (statusEl) statusEl.textContent = 'Drive disconnected';
  showAlert(`Drive disconnected — ${message}`);
  window._driveLastLoaded = 0;
}

export function showFolderNotFoundPrompt() {
  const filesList = $('files-list');
  filesList.innerHTML = `
    <div class="files-connect-prompt" style="flex-direction:column;gap:0.75rem;">
      <p style="color:var(--amber);">Could not find a "PawRecords" folder in your Drive.</p>
      <p>Enter the name of your uploads folder:</p>
      <div style="display:flex;gap:0.5rem;">
        <input id="folder-name-input" type="text" value="PawRecords"
          style="flex:1;font-family:'JetBrains Mono',monospace;font-size:0.75rem;background:var(--bg);border:1.5px solid var(--border);border-radius:7px;padding:0.4rem 0.6rem;color:var(--ink);outline:none;">
        <button class="btn-icon free-icon" id="folder-search-btn"><span class="free-dot"></span> Search</button>
      </div>
    </div>`;
  $('folder-search-btn').addEventListener('click', async () => {
    const name = $('folder-name-input').value.trim();
    if (!name) return;
    try { localStorage.removeItem('pr_uploads_folder_id'); } catch(e) {}
    filesList.innerHTML = `<div class="files-loading">Searching for "${escHtml(name)}"…</div>`;
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name%3D'${encodeURIComponent(name)}'+and+mimeType%3D'application%2Fvnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id,name)&includeItemsFromAllDrives=true&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${driveAccessToken}` } }
      );
      const data = await res.json();
      const folder = data.files?.[0];
      if (!folder) {
        showFolderNotFoundPrompt();
        $('folder-name-input').value = name;
        showToast(`No folder named "${name}" found`, 'warning');
        return;
      }
      try { localStorage.setItem('pr_uploads_folder_id', folder.id); } catch(e) {}
      loadDriveFiles();
    } catch(e) {
      showToast('Search failed: ' + e.message, 'warning');
    }
  });
}

// ── LOAD DRIVE FILES ──
export async function loadDriveFiles() {
  const filesList = $('files-list');
  if (!driveAccessToken) {
    showDriveConnectPrompt('Drive access token missing or expired. Click to reconnect.');
    return;
  }
  const connectPrompt = $('drive-connect-prompt');
  if (connectPrompt) connectPrompt.style.display = 'none';
  $('drive-dot').className = 'status-dot green';
  $('drive-status').textContent = 'Drive connected';
  $('files-actions').style.display = 'none';

  const loadStart = Date.now();
  const loadingEl = document.createElement('div');
  loadingEl.className = 'files-loading';
  loadingEl.textContent = 'Loading files from Drive…';
  filesList.innerHTML = '';
  filesList.appendChild(loadingEl);

  const ticker = setInterval(() => {
    const secs = Math.round((Date.now() - loadStart) / 1000);
    if (loadingEl.isConnected) loadingEl.textContent = `Loading files from Drive… ${secs}s`;
  }, 1000);

  const timeout = setTimeout(() => {
    clearInterval(ticker);
    if (loadingEl.isConnected) {
      loadingEl.innerHTML = `Taking longer than expected. <button class="btn-icon" onclick="window._driveLastLoaded=0;loadDriveFiles()" style="margin-left:0.5rem;">Retry</button> <button class="btn-icon" onclick="try{localStorage.removeItem('pr_uploads_folder_id')}catch(e){}window._driveLastLoaded=0;loadDriveFiles()" style="margin-left:0.25rem;">Clear cache &amp; retry</button>`;
    }
  }, 20000);

  const fetchWithTimeout = (url, opts, ms = 15000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  try {
    let uploadsId = null;
    try { uploadsId = localStorage.getItem('pr_uploads_folder_id'); } catch(e) {}

    if (!uploadsId) {
      const pawRes = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files?q=name%3D'PawRecords'+and+mimeType%3D'application%2Fvnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id,name)&includeItemsFromAllDrives=true&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${driveAccessToken}` } }
      );

      if (pawRes.status === 401) {
        clearInterval(ticker); clearTimeout(timeout);
        setDriveAccessToken(null);
        try { sessionStorage.removeItem('pr_drive_token'); } catch(e) {}
        $('drive-dot').className = 'status-dot amber';
        $('drive-status').textContent = 'Drive token expired';
        filesList.innerHTML = '';
        showDriveConnectPrompt('Drive access token expired. Click to reconnect.');
        return;
      }
      if (pawRes.status === 403) {
        clearInterval(ticker); clearTimeout(timeout);
        filesList.innerHTML = '';
        showDriveConnectPrompt('Drive API access denied (403). Make sure the Google Drive API is enabled in your Google Cloud project.');
        return;
      }
      if (!pawRes.ok) {
        clearInterval(ticker); clearTimeout(timeout);
        filesList.innerHTML = '';
        showDriveConnectPrompt(`Drive API error ${pawRes.status} — sign out and back in to retry.`);
        return;
      }

      const pawData = await pawRes.json();
      const pawFolder = pawData.files?.[0];

      if (!pawFolder) {
        clearInterval(ticker); clearTimeout(timeout);
        filesList.innerHTML = '';
        showFolderNotFoundPrompt();
        return;
      }

      const folderRes = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files?q=name%3D'uploads'+and+mimeType%3D'application%2Fvnd.google-apps.folder'+and+'${pawFolder.id}'+in+parents+and+trashed%3Dfalse&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${driveAccessToken}` } }
      );
      const folderData = await folderRes.json();
      const uploadFolder = folderData.files?.[0];

      if (!uploadFolder) {
        uploadsId = pawFolder.id;
        showToast('No "uploads" subfolder found — using PawRecords root folder', 'info');
      } else {
        uploadsId = uploadFolder.id;
      }
      try { localStorage.setItem('pr_uploads_folder_id', uploadsId); } catch(e) {}
    }

    const filesRes = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?q='${uploadsId}'+in+parents+and+trashed%3Dfalse&fields=files(id,name,size,mimeType,modifiedTime)&pageSize=200&orderBy=name`,
      { headers: { Authorization: `Bearer ${driveAccessToken}` } }
    );

    if (filesRes.status === 401) {
      clearInterval(ticker); clearTimeout(timeout);
      try { localStorage.removeItem('pr_uploads_folder_id'); } catch(e) {}
      setDriveAccessToken(null);
      try { sessionStorage.removeItem('pr_drive_token'); } catch(e) {}
      filesList.innerHTML = '';
      showDriveConnectPrompt('Drive access token expired. Click to reconnect.');
      return;
    }

    const filesData = await filesRes.json();
    const driveFiles = filesData.files || [];
    try { sessionStorage.setItem('pr_drive_file_ids', JSON.stringify(driveFiles.map(f => f.id))); } catch(e) {}
    const statusMap = await loadFileStatuses(driveFiles.map(f => f.id));
    clearInterval(ticker); clearTimeout(timeout);
    renderFilesList(driveFiles, statusMap);
    $('files-secondary-toolbar').style.display = 'flex';
    $('files-actions').style.display = 'flex';
    updateProcessButtons();
  } catch (err) {
    clearInterval(ticker); clearTimeout(timeout);
    console.error('Drive load error:', err);
    filesList.innerHTML = `<div class="files-loading" style="color:var(--red);">
      ${err.name === 'AbortError' ? 'Drive timed out — connection may be slow or the token expired.' : 'Drive error: ' + escHtml(err.message)}
      <br><br>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn-icon" onclick="window._driveLastLoaded=0;loadDriveFiles()" style="margin-top:0.25rem;">Retry</button>
        <button class="btn-icon" onclick="try{localStorage.removeItem('pr_uploads_folder_id')}catch(e){}window._driveLastLoaded=0;loadDriveFiles()" style="margin-top:0.25rem;">Clear cache &amp; retry</button>
      </div>
    </div>`;
    try { localStorage.removeItem('pr_uploads_folder_id'); } catch(e) {}
    window._driveLastLoaded = 0;
  }
}

// ── RENDER FILES LIST ──
export function renderFilesList(driveFiles, statusMap) {
  const filesList = $('files-list');
  if (!driveFiles.length) {
    filesList.innerHTML = '<div class="files-loading">No files found in PawRecords/uploads.</div>';
    return;
  }

  const sorted = [...driveFiles].sort((a, b) => {
    if (_fileSort === 'date') {
      const da = new Date(a.modifiedTime || 0).getTime();
      const db2 = new Date(b.modifiedTime || 0).getTime();
      return (db2 - da) * _fileSortDir * -1;
    }
    if (_fileSort === 'size') {
      return ((a.size || 0) - (b.size || 0)) * _fileSortDir;
    }
    return a.name.localeCompare(b.name) * _fileSortDir;
  });

  window._driveFiles = sorted;
  window._statusMap = statusMap;

  filesList.innerHTML = '';

  const arrow = (col) => _fileSort === col ? (_fileSortDir === 1 ? ' ▲' : ' ▼') : '';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;padding:0.3rem 0.75rem 0.3rem 1.5rem;border-bottom:1px solid var(--surface2);gap:0.5rem;background:var(--surface);position:sticky;top:0;z-index:1;';
  hdr.innerHTML = `
    <input type="checkbox" style="opacity:0;pointer-events:none;flex-shrink:0;">
    <span id="sort-name-btn" style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:${_fileSort==='name'?'var(--accent)':'var(--ink-muted)'};cursor:pointer;flex:1;user-select:none;" title="Sort by name">Name${arrow('name')}</span>
    <span id="sort-size-btn" style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:${_fileSort==='size'?'var(--accent)':'var(--ink-muted)'};cursor:pointer;flex-shrink:0;user-select:none;" title="Sort by size">Size${arrow('size')}</span>
    <span id="sort-date-btn" style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:${_fileSort==='date'?'var(--accent)':'var(--ink-muted)'};cursor:pointer;flex-shrink:0;user-select:none;" title="Sort by date">Date${arrow('date')}</span>
    <span style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:var(--ink-muted);flex-shrink:0;cursor:pointer;" id="select-all-link">select all</span>`;
  filesList.appendChild(hdr);

  setTimeout(() => {
    const nameBtn = $('sort-name-btn');
    const dateBtn = $('sort-date-btn');
    if (nameBtn) nameBtn.addEventListener('click', () => {
      if (_fileSort === 'name') setFileSortDir(_fileSortDir * -1); else { setFileSort('name'); setFileSortDir(1); }
      if (window._driveFiles && window._statusMap) renderFilesList(window._driveFiles, window._statusMap);
    });
    const sizeBtn = $('sort-size-btn');
    if (sizeBtn) sizeBtn.addEventListener('click', () => {
      if (_fileSort === 'size') setFileSortDir(_fileSortDir * -1); else { setFileSort('size'); setFileSortDir(-1); }
      if (window._driveFiles && window._statusMap) renderFilesList(window._driveFiles, window._statusMap);
    });
    if (dateBtn) dateBtn.addEventListener('click', () => {
      if (_fileSort === 'date') setFileSortDir(_fileSortDir * -1); else { setFileSort('date'); setFileSortDir(-1); }
      if (window._driveFiles && window._statusMap) renderFilesList(window._driveFiles, window._statusMap);
    });
  }, 0);

  for (const file of sorted) {
    const status = statusMap[file.id] || 'unprocessed';
    const ext = file.name.split('.').pop().toUpperCase();
    const size = formatSize(file.size);
    const fileDate = file.modifiedTime
      ? new Date(file.modifiedTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
      : '';
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.status = status;
    item.dataset.fileId = file.id;
    item.dataset.fileName = file.name;
    item.dataset.mimeType = file.mimeType || '';
    item.style.paddingLeft = '1.5rem';
    item.innerHTML = `
      <input type="checkbox" class="file-item-checkbox" data-file-id="${file.id}">
      <div class="file-item-top">
        <span class="file-ext-badge">${escHtml(ext)}</span>
        <a class="file-name" title="${escHtml(file.name)}" href="https://drive.google.com/file/d/${file.id}/view" target="_blank" onclick="event.stopPropagation()" style="text-decoration:none;color:inherit;cursor:pointer;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color=''">${escHtml(file.name)}</a>
        <span class="file-status-badge ${status}" id="badge-${file.id}" ${status === 'flagged' ? `style="cursor:pointer;" title="Click to view flags" onclick="event.stopPropagation();openFlagsModal('${file.id}')"` : ''}>${status}</span>
      </div>
      <div class="file-item-meta">
        <span>${size}</span>
        ${fileDate ? `<span style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:var(--ink-muted);margin-left:auto;">${escHtml(fileDate)}</span>` : ''}
        <span class="file-cats" id="cats-${file.id}"></span>
        ${status === 'complete' ? `<button class="file-verify-btn" data-file-id="${file.id}" style="background:none;border:1px solid var(--border);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:0.55rem;color:var(--ink-muted);padding:0.1rem 0.35rem;cursor:pointer;transition:all 0.15s;" title="Re-verify this file">verify</button>` : ''}
        <button class="file-delete-btn" data-file-id="${file.id}" style="background:none;border:1px solid transparent;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:0.55rem;color:var(--ink-muted);padding:0.1rem 0.3rem;cursor:pointer;transition:all 0.15s;opacity:0;" title="Delete imported records for this file">✕</button>
        <a href="https://drive.google.com/file/d/${file.id}/view" target="_blank"
           style="color:var(--accent);text-decoration:none;margin-left:auto;" onclick="event.stopPropagation()">
          open ↗
        </a>
      </div>`;

    item.addEventListener('mouseenter', () => { const d = item.querySelector('.file-delete-btn'); if (d) d.style.opacity = '1'; });
    item.addEventListener('mouseleave', () => { const d = item.querySelector('.file-delete-btn'); if (d) d.style.opacity = '0'; });

    const cb = item.querySelector('.file-item-checkbox');
    cb.addEventListener('change', () => {
      item.classList.toggle('selected', cb.checked);
      updateProcessButtons();
    });
    item.addEventListener('click', e => {
      if (e.target === cb || e.target.tagName === 'A' ||
          e.target.classList.contains('file-verify-btn') ||
          e.target.classList.contains('file-delete-btn')) return;
      cb.checked = !cb.checked;
      item.classList.toggle('selected', cb.checked);
      updateProcessButtons();
    });

    const verifyBtn = item.querySelector('.file-verify-btn');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', e => { e.stopPropagation(); verifyFile(file); });
    }

    const deleteBtn = item.querySelector('.file-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async e => {
        e.stopPropagation();
        await confirmDeleteFileRecords(file);
      });
    }

    attachFileCtxMenu(item, file, status);
    filesList.appendChild(item);
  }

  setTimeout(() => {
    const sal = $('select-all-link');
    if (sal) sal.addEventListener('click', () => {
      const all = [...document.querySelectorAll('.file-item')];
      const visible = all.filter(el => el.style.display !== 'none');
      const anyUnchecked = visible.some(el => !el.querySelector('.file-item-checkbox')?.checked);
      all.forEach(el => {
        const cb = el.querySelector('.file-item-checkbox');
        if (!cb) return;
        const isVisible = el.style.display !== 'none';
        cb.checked = isVisible ? anyUnchecked : false;
        el.classList.toggle('selected', isVisible ? anyUnchecked : false);
      });
      updateSelectAllLabel();
      updateProcessButtons();
    });
  }, 50);

  $('files-actions').style.display = 'flex';
  updateProcessButtons();
}

// ── UPDATE PROCESS BUTTONS ──
export function updateProcessButtons() {
  updateSelectAllLabel();
  const selected = [...document.querySelectorAll('.file-item-checkbox')].filter(cb => cb.checked);
  const selBtn = $('process-selected-btn');
  const allBtn = $('process-all-btn');
  const hint = $('files-select-hint');
  if (selected.length > 0) {
    selBtn.style.display = 'inline-flex';
    selBtn.innerHTML = `<span class="cost-dot"></span> Process ${selected.length} Selected`;
    allBtn.style.display = 'none';
    hint.textContent = `${selected.length} file${selected.length > 1 ? 's' : ''} selected`;
  } else {
    selBtn.style.display = 'none';
    allBtn.style.display = 'inline-flex';
    const unprocessed = [...document.querySelectorAll('.file-item')].filter(el =>
      el.dataset.status === 'unprocessed' || el.dataset.status === 'failed' || el.dataset.status === 'empty').length;
    hint.textContent = unprocessed ? `${unprocessed} unprocessed` : 'all files processed';
    allBtn.disabled = !unprocessed;
  }
}

// ── UPLOAD FILES TO DRIVE ──
export async function uploadFilesToDrive(files) {
  if (!driveAccessToken) { showToast('Connect Drive first', 'warning'); return; }

  let uploadsId = null;
  try { uploadsId = localStorage.getItem('pr_uploads_folder_id'); } catch(e) {}
  if (!uploadsId) {
    showToast('Drive folder not loaded yet — open Files tab first', 'warning');
    return;
  }

  const bar = $('upload-progress-bar');
  const label = $('upload-progress-label');
  const fill = $('upload-progress-fill');
  bar.style.display = 'block';

  const results = { ok: 0, fail: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    label.textContent = `Uploading ${i + 1}/${files.length}: ${file.name}`;
    fill.style.width = `${Math.round((i / files.length) * 100)}%`;

    try {
      const metadata = JSON.stringify({ name: file.name, parents: [uploadsId] });

      if (file.size <= 5 * 1024 * 1024) {
        const form = new FormData();
        form.append('metadata', new Blob([metadata], { type: 'application/json' }));
        form.append('file', file);
        const res = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,mimeType,modifiedTime',
          { method: 'POST', headers: { Authorization: `Bearer ${driveAccessToken}` }, body: form }
        );
        if (res.status === 401) { setDriveAccessToken(null); showDriveConnectPrompt('Token expired during upload.'); break; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const newFile = await res.json();
        if (window._driveFiles) {
          window._driveFiles.push(newFile);
          if (window._statusMap) window._statusMap[newFile.id] = 'unprocessed';
        }
        results.ok++;
      } else {
        const initRes = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType,modifiedTime',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${driveAccessToken}`,
              'Content-Type': 'application/json',
              'X-Upload-Content-Type': file.type || 'application/octet-stream',
              'X-Upload-Content-Length': file.size
            },
            body: metadata
          }
        );
        if (!initRes.ok) throw new Error(`Init failed: HTTP ${initRes.status}`);
        const uploadUrl = initRes.headers.get('Location');
        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file
        });
        if (!uploadRes.ok) throw new Error(`Upload failed: HTTP ${uploadRes.status}`);
        const newFile = await uploadRes.json();
        if (window._driveFiles) {
          window._driveFiles.push(newFile);
          if (window._statusMap) window._statusMap[newFile.id] = 'unprocessed';
        }
        results.ok++;
      }
    } catch(e) {
      console.error(`Upload failed: ${file.name}`, e);
      results.fail++;
    }
  }

  fill.style.width = '100%';
  label.textContent = `Done — ${results.ok} uploaded${results.fail ? ', ' + results.fail + ' failed' : ''}`;
  setTimeout(() => { bar.style.display = 'none'; }, 2500);

  if (window._driveFiles && window._statusMap) {
    renderFilesList(window._driveFiles, window._statusMap);
    $('files-actions').style.display = 'flex';
    updateProcessButtons();
  }
  if (results.ok) showToast(`${results.ok} file${results.ok > 1 ? 's' : ''} uploaded to Drive ✓`, 'journal');
  if (results.fail) showAlert(`${results.fail} file${results.fail > 1 ? 's' : ''} failed to upload — check Drive connection`, 'warning');
}

// ── ESTIMATE COST ──
export function estimateCost(files) {
  const tokensPerFile = 8000;
  const totalTokens = files.length * tokensPerFile;
  const ratePerM = 9;
  const cost = (totalTokens / 1000000) * ratePerM;
  return { cost, totalTokens };
}

// ── OPEN PROCESS MODAL ──
export function openProcessModal(files) {
  if (!files.length) return;
  $('process-modal-title').textContent = 'Process Files';
  $('process-modal-subtitle').textContent = `${files.length} file${files.length > 1 ? 's' : ''} selected`;

  const modeInfo = $('process-mode-info');
  modeInfo.innerHTML = `<div class="process-mode-card realtime">
    <div class="process-mode-label">Real-time processing</div>
    <div class="process-mode-desc">Files processed one at a time — watch progress live. Rate limiting handled automatically with pause/resume.</div>
  </div>`;
  $('process-confirm-label').textContent = files.length === 1 ? 'Process File' : `Process ${files.length} Files`;

  const { cost } = estimateCost(files);
  $('process-cost-estimate').textContent = `~$${cost.toFixed(3)}`;

  const listEl = $('process-file-list');
  listEl.innerHTML = '';
  const showFiles = files.slice(0, 20);
  for (const f of showFiles) {
    const ext = f.name.split('.').pop();
    const row = document.createElement('div');
    row.className = 'process-file-row';
    row.innerHTML = `<span class="process-file-row-ext">${escHtml(ext.toUpperCase())}</span>
      <span class="process-file-row-name">${escHtml(f.name)}</span>`;
    listEl.appendChild(row);
  }
  if (files.length > 20) {
    const more = document.createElement('div');
    more.className = 'process-file-row';
    more.style.color = 'var(--ink-muted)';
    more.innerHTML = `<span style="flex:1;padding-left:36px;">…and ${files.length - 20} more</span>`;
    listEl.appendChild(more);
  }

  window._pendingProcessFiles = files;
  $('process-modal').classList.add('open');
}

// ── PROCESSING PIPELINE ──
export async function startProcessingQueue(files) {
  if (!apiKey) { showToast('Set your API key first', 'warning'); return; }
  if (!driveAccessToken) { showToast('Connect Drive first', 'warning'); return; }
  setProcessingStop(false);
  setProcessingActive(true);
  setProcessingQueue([...files]);
  await requestWakeLock();

  // Ensure visits cache is fresh
  setAllVisitsCache(null); invalidateChatContext();
  if (window.dirtyRecordsSidebar) window.dirtyRecordsSidebar();
  if (window.ensureDataCache) await window.ensureDataCache();

  const progress = $('process-progress');
  progress.classList.add('active');
  $('process-all-btn').disabled = true;
  $('process-selected-btn').disabled = true;

  let done = 0;
  const total = files.length;
  let failed = 0;

  // Lazy import of import.js for processFile
  const importMod = await import('./import.js');

  for (const file of files) {
    if (processingStop) break;
    const existingDoc = await getDoc(doc(db, 'files', file.id));
    if (existingDoc.exists() && existingDoc.data().status === 'complete') {
      const reprocess = confirm(`"${file.name}" has already been processed.\n\nReprocess it anyway? This will add to your API costs.`);
      if (!reprocess) { done++; updateProgress(done, total, `Skipped: ${file.name}`); continue; }
    }
    updateProgress(done, total, `Processing: ${file.name}`);
    updateFileBadge(file.id, 'processing');
    try {
      const result = await importMod.processFile(file);
      if (result !== 'skipped') {
        updateFileBadge(file.id, 'complete');
      }
      done++;
      updateProgress(done, total, done < total ? `Done: ${file.name}` : 'All complete!');
    } catch (err) {
      console.error(`Failed: ${file.name}`, err);
      const isDriveAuth = err.message.includes('token expired') || err.message.includes('401');
      const newStatus = isDriveAuth ? 'unprocessed' : 'failed';
      updateFileBadge(file.id, newStatus);
      await writeFileStatus(file.id, file.name, newStatus, { error: err.message });
      failed++;
      done++;
      if (!isDriveAuth) {
        showAlert(`Processing failed: ${file.name.slice(0,40)} — ${err.message.slice(0,80)}`, 'warning');
      }
    }
    updateProcessButtons();
    if (done < total && !processingStop) await sleep(800);
  }

  setProcessingActive(false);
  releaseWakeLock();
  $('process-all-btn').disabled = false;
  $('process-selected-btn').disabled = false;
  $('progress-label').textContent = processingStop ? 'Stopped' : 'Complete';
  $('progress-current').textContent = `${done - failed} succeeded · ${failed} failed`;

  window._driveLoaded = false;
  invalidateFileStatusCache();
  if (window.reloadSidebars) await window.reloadSidebars('all');
  if (window.updatePetList) await window.updatePetList();
  setAllVisitsCache(null); invalidateChatContext();
  if (window.dirtyRecordsSidebar) window.dirtyRecordsSidebar();
  setAllLabsCache(null);
  if (_activeTab === 'files') loadDriveFiles();
  updateProcessButtons();

  const msg = processingStop
    ? `Stopped — ${done - failed} of ${total} files processed`
    : `Processed ${done - failed} files${failed ? ` · ${failed} failed` : ''} ✓`;
  showToast(msg, 'journal');

  setTimeout(() => { progress.classList.remove('active'); }, 8000);
}

export function updateProgress(done, total, currentFile) {
  $('progress-count').textContent = `${done}/${total}`;
  $('progress-bar').style.width = total ? `${(done / total) * 100}%` : '0%';
  $('progress-current').textContent = currentFile;
}

export function updateFileBadge(fileId, status) {
  const badge = $(`badge-${fileId}`);
  if (badge) {
    badge.className = `file-status-badge ${status}`;
    badge.textContent = status;
    const item = document.querySelector(`[data-file-id="${fileId}"]`);
    if (item) item.dataset.status = status;
  }
}

// ── FILE CONTEXT MENU ──
export function attachFileCtxMenu(item, file, status) {
  item.addEventListener('contextmenu', async e => {
    e.preventDefault();
    e.stopPropagation();
    const items = [];

    if (status !== 'complete' && status !== 'processing') {
      items.push({ label: '▶ Process this file', action: () => openProcessModal([file]) });
    }
    if (status === 'complete' || status === 'flagged') {
      items.push({ label: '⟳ Reprocess', action: () => openProcessModal([file]) });
      items.push({ label: '✓ Verify extraction', action: () => verifyFile(file) });
    }
    if (status === 'flagged') {
      items.push({ label: '🚩 View flags', action: () => openFlagsModal(file.id) });
      items.push({
        label: '✓ Mark as complete',
        action: async () => {
          const flagSnap = await getDocs(query(collection(db, 'flags'), where('fileId', '==', file.id), where('resolved', '==', false)));
          const batch = writeBatch(db);
          flagSnap.forEach(d => batch.update(d.ref, { resolved: true, resolution: 'manually marked complete', resolvedAt: new Date().toISOString() }));
          await batch.commit();
          await writeFileStatus(file.id, file.name, 'complete');
          updateFileBadge(file.id, 'complete');
          item.dataset.status = 'complete';
          updateProcessButtons();
          showToast('Marked complete ✓', 'journal');
        }
      });
    }
    items.push('sep');
    items.push({
      label: '↗ Open in Drive',
      action: () => window.open(`https://drive.google.com/file/d/${file.id}/view`, '_blank')
    });

    if (status === 'complete' || status === 'flagged' || status === 'failed') {
      items.push('sep');
      items.push({
        label: '🗑 Delete imported records',
        danger: true,
        action: () => confirmDeleteFileRecords(file)
      });
    }

    if (status !== 'unprocessed') {
      items.push({
        label: 'Mark as unprocessed',
        action: async () => {
          await writeFileStatus(file.id, file.name, 'unprocessed');
          updateFileBadge(file.id, 'unprocessed');
          item.dataset.status = 'unprocessed';
          updateProcessButtons();
        }
      });
    }

    // Use ui.js showCtxMenu via lazy import
    import('./ui.js').then(m => m.showCtxMenu(e, file.name.slice(0, 30), items));
  });
}

// ── CONFIRM DELETE FILE RECORDS ──
export async function confirmDeleteFileRecords(file) {
  const [visitSnap, labSnap, flagSnap] = await Promise.all([
    getDocs(query(collection(db, 'visits'), where('driveFileIds', 'array-contains', file.id))),
    getDocs(query(collection(db, 'labs'), where('driveFileId', '==', file.id))),
    getDocs(query(collection(db, 'flags'), where('fileId', '==', file.id)))
  ]);

  const visits = visitSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const toDelete = visits.filter(v => (v.driveFileIds||[]).length <= 1);
  const toUnlink = visits.filter(v => (v.driveFileIds||[]).length > 1);
  const labCount = labSnap.docs.length;
  const flagCount = flagSnap.docs.length;

  let msg = `Delete records imported from "${file.name}"?\n\n`;
  if (toDelete.length) msg += `• ${toDelete.length} visit(s) will be deleted\n`;
  if (toUnlink.length) msg += `• ${toUnlink.length} visit(s) will be unlinked (referenced by other files)\n`;
  if (labCount) msg += `• ${labCount} lab result(s) will be deleted\n`;
  if (flagCount) msg += `• ${flagCount} flag(s) will be deleted\n`;
  msg += `\nThe file stays in Google Drive.`;

  if (!confirm(msg)) return;

  for (const v of toDelete) await deleteDoc(doc(db, 'visits', v.id));
  for (const v of toUnlink) {
    await updateDoc(doc(db, 'visits', v.id), {
      driveFileIds: arrayRemove(file.id),
      sourceFiles: (v.sourceFiles||[]).filter(f => f !== file.name)
    });
  }
  for (const d of labSnap.docs) await deleteDoc(d.ref);
  for (const d of flagSnap.docs) await deleteDoc(d.ref);

  await writeFileStatus(file.id, file.name, 'unprocessed');
  updateFileBadge(file.id, 'unprocessed');

  if (window.reloadSidebars) {
    await window.reloadSidebars('records');
    await window.reloadSidebars('labs');
  }
  updateProcessButtons();

  const summary = [];
  if (toDelete.length) summary.push(`${toDelete.length} visit${toDelete.length > 1 ? 's' : ''}`);
  if (labCount) summary.push(`${labCount} lab result${labCount > 1 ? 's' : ''}`);
  if (flagCount) summary.push(`${flagCount} flag${flagCount > 1 ? 's' : ''}`);
  showToast(`Deleted ${summary.join(', ')} from "${file.name.slice(0, 25)}" ✓`, 'journal');
}

// ── VERIFY FILE ──
export async function verifyFile(file) {
  if (!apiKey) { showToast('Set your API key first', 'warning'); return; }
  if (!driveAccessToken) { showToast('Connect Drive first', 'warning'); return; }

  const verifyingToast = document.createElement('div');
  verifyingToast.className = 'toast';
  verifyingToast.innerHTML = `<div class="toast-dot amber"></div><div class="toast-text">Verifying ${file.name.slice(0,25)}…</div>`;
  $('toast-container').appendChild(verifyingToast);

  const btn = document.querySelector(`.file-verify-btn[data-file-id="${file.id}"]`);
  if (btn) { btn.textContent = 'verifying…'; btn.disabled = true; }

  const clearVerifying = () => { verifyingToast.remove(); if (btn) { btn.textContent = 'verify'; btn.disabled = false; } };

  const showVerifyResult = (text, type = 'journal') => {
    clearVerifying();
    const t = document.createElement('div');
    t.className = 'toast';
    const dotColor = type === 'warning' ? 'amber' : 'green';
    t.innerHTML = `<div class="toast-dot ${dotColor}"></div><div class="toast-text" style="flex:1;">${text}</div><button style="background:none;border:1px solid var(--border);border-radius:5px;font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--ink-muted);cursor:pointer;padding:0.15rem 0.4rem;flex-shrink:0;transition:all 0.15s;" onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background='none'">OK</button>`;
    t.querySelector('button').onclick = () => t.remove();
    $('toast-container').appendChild(t);
  };

  try {
    const importMod = await import('./import.js');
    const blob = await importMod.fetchDriveFileBlob(file.id);
    let rawText = '';
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf') rawText = await importMod.extractPdfText(blob);
    else rawText = await blob.text();

    if (!rawText || rawText.trim().length < 50) {
      clearVerifying();
      showToast(`${file.name.slice(0,30)}: too short to verify`, 'warning');
      return;
    }

    const snap = await getDocs(query(collection(db, 'visits'), where('sourceFileId', '==', file.id)));
    let existingText = '';
    snap.forEach(d => {
      const v = d.data();
      existingText += `${v.date||''} ${v.cat||''}: ${v.synopsis || v.chiefComplaint || ''}\nMeds: ${(v.medications||[]).map(m=>m.name).join(', ')}\n`;
    });
    const labSnap = await getDocs(query(collection(db, 'labs'), where('driveFileId', '==', file.id)));
    if (!labSnap.empty) {
      const labsByDate = {};
      labSnap.forEach(d => {
        const l = d.data();
        if (!labsByDate[l.resultDate]) labsByDate[l.resultDate] = [];
        labsByDate[l.resultDate].push(`${l.test}: ${l.value}${l.unit ? ' ' + l.unit : ''}`);
      });
      for (const [date, tests] of Object.entries(labsByDate)) {
        existingText += `Labs ${date}: ${tests.join(', ')}\n`;
      }
    }

    if (!existingText.trim()) {
      clearVerifying();
      showToast(`${file.name.slice(0,30)}: no existing records found — try reprocessing`, 'warning');
      return;
    }

    const diffPrompt = `You are checking whether a veterinary record has been fully captured in our database.

STORED RECORDS (what we have):
${existingText.slice(0, 3000)}

SOURCE DOCUMENT (what the file contains):
${rawText.slice(0, 3000)}

List ONLY clinical data present in the source document but missing from the stored records.
Include: lab values, diagnoses, medications, procedures, vitals not captured.
Ignore: billing, boilerplate, portal instructions, duplicate info.
If nothing clinical is missing, respond exactly: NOTHING_NEW`;

    const diffResult = await importMod.callPlainClaude(diffPrompt, 1000);
    const hasNew = diffResult && diffResult.trim() !== 'NOTHING_NEW' && diffResult.trim().length > 10;

    if (!hasNew) {
      const fileDoc = await getDoc(doc(db, 'files', file.id));
      const currentStatus = fileDoc.exists() ? fileDoc.data().status : 'unknown';
      if (currentStatus === 'flagged') {
        clearVerifying();
        const t = document.createElement('div');
        t.className = 'toast';
        t.innerHTML = `<div class="toast-dot green"></div><div class="toast-text" style="flex:1;">✓ ${escHtml(file.name.slice(0,25))}: nothing missing</div><button class="toast-undo" style="flex-shrink:0;">Mark complete</button><button style="background:none;border:1px solid var(--border);border-radius:5px;font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--ink-muted);cursor:pointer;padding:0.15rem 0.4rem;flex-shrink:0;">OK</button>`;
        t.querySelector('.toast-undo').onclick = async () => {
          const flagSnap2 = await getDocs(query(collection(db, 'flags'), where('fileId', '==', file.id), where('resolved', '==', false)));
          const batch = writeBatch(db);
          flagSnap2.forEach(d => batch.update(d.ref, { resolved: true, resolution: 'verified clean', resolvedAt: new Date().toISOString() }));
          await batch.commit();
          await writeFileStatus(file.id, file.name, 'complete');
          updateFileBadge(file.id, 'complete');
          t.remove();
          showVerifyResult('Marked complete ✓');
        };
        t.querySelectorAll('button')[1].onclick = () => t.remove();
        $('toast-container').appendChild(t);
      } else {
        showVerifyResult(`✓ ${file.name.slice(0,30)}: nothing missing`);
      }
    } else {
      // Show diff in record popup
      if (window.setupClassicPopup) window.setupClassicPopup();
      $('popup-title').textContent = `Verify: ${file.name}`;
      const popupRawText = typeof diffResult === 'string' ? diffResult.trim() : '';
      const body = $('popup-body');
      body.innerHTML = '';
      const note = document.createElement('div');
      note.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:0.68rem;color:var(--amber);margin-bottom:0.75rem;line-height:1.6;';
      note.textContent = '⚠ Possible missing clinical data — review and decide:';
      body.appendChild(note);
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:0.68rem;color:var(--ink-dim);background:var(--surface);border-radius:6px;padding:0.75rem;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow-y:auto;margin-bottom:0.75rem;line-height:1.6;';
      pre.textContent = popupRawText;
      body.appendChild(pre);
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:0.5rem;flex-wrap:wrap;';

      const reprocessBtn = document.createElement('button');
      reprocessBtn.className = 'btn-icon cost-icon';
      reprocessBtn.innerHTML = '<span class="cost-dot"></span> Reprocess file';
      reprocessBtn.onclick = () => {
        clearVerifying();
        $('record-popup').classList.remove('open');
        openProcessModal([file]);
      };
      btns.appendChild(reprocessBtn);

      const flagBtn = document.createElement('button');
      flagBtn.className = 'btn-icon free-icon';
      flagBtn.innerHTML = '<span class="free-dot"></span> Flag for review';
      flagBtn.onclick = async () => {
        clearVerifying();
        await setDoc(doc(collection(db, 'flags')), {
          fileId: file.id, filename: file.name, type: 'verify_missing_data',
          description: popupRawText.slice(0, 500),
          resolved: false, createdAt: new Date().toISOString()
        });
        const fc = parseInt($('flags-count').textContent || '0') + 1;
        $('flags-count').textContent = fc;
        $('flags-btn').style.display = 'inline-flex';
        showToast('Flagged for review ✓', 'journal');
        $('record-popup').classList.remove('open');
      };
      btns.appendChild(flagBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn-icon';
      dismissBtn.textContent = 'Looks fine';
      dismissBtn.onclick = () => {
        clearVerifying();
        $('record-popup').classList.remove('open');
      };
      btns.appendChild(dismissBtn);

      body.appendChild(btns);
      $('popup-search-input').value = '';
      $('popup-search-count').textContent = '';
      $('record-popup').classList.add('open');
    }
  } catch(err) {
    clearVerifying();
    console.error('Verify error:', err);
    showVerifyResult('Verify failed: ' + err.message.slice(0, 60), 'warning');
  }
}

// ── BATCH JOBS ──
export async function submitBatchJob(files) {
  if (!apiKey) { showToast('Set your API key first', 'warning'); return; }
  showToast(`Preparing batch for ${files.length} files…`, 'info');

  for (const file of files) {
    await writeFileStatus(file.id, file.name, 'queued');
    updateFileBadge(file.id, 'queued');
  }

  const importMod = await import('./import.js');

  try {
    const requests = [];
    for (const file of files) {
      let text = '';
      try {
        const blob = await importMod.fetchDriveFileBlob(file.id);
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'pdf' || file.mimeType === 'application/pdf') {
          text = await importMod.extractPdfText(blob);
        } else if (['txt','md','csv'].includes(ext)) {
          text = await blob.text();
        }
      } catch(e) {
        console.warn(`Could not fetch ${file.name}:`, e.message);
        continue;
      }
      if (!text || text.trim().length < 50) continue;

      requests.push({
        custom_id: file.id,
        params: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 6000,
          system: importMod.getSystemExtraction(),
          messages: [{
            role: 'user',
            content: buildBatchPrompt(file.name, text)
          }]
        }
      });
    }

    if (!requests.length) {
      showToast('No processable files found in selection', 'warning');
      return;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ requests })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Batch submit failed: ${res.status}`);
    }

    const batch = await res.json();
    const batchId = batch.id;

    await setDoc(doc(db, 'batches', batchId), {
      batchId,
      status: 'in_progress',
      fileIds: files.map(f => f.id),
      fileNames: Object.fromEntries(files.map(f => [f.id, f.name])),
      submittedAt: new Date().toISOString(),
      totalFiles: requests.length,
      processedFiles: 0
    });

    showBatchBanner(batchId, requests.length, 0);
    showToast(`Batch submitted — ${requests.length} files queued. Results will appear automatically.`, 'journal');
    pollBatchJob(batchId);

  } catch(err) {
    console.error('Batch submit error:', err);
    showAlert('Batch failed: ' + err.message, 'warning');
    for (const file of files) {
      await writeFileStatus(file.id, file.name, 'unprocessed');
      updateFileBadge(file.id, 'unprocessed');
    }
  }
}

function buildBatchPrompt(filename, text) {
  return `You are a veterinary medical records processor. Known pets in this account: ${APP_PETS.join(', ')||'detect from document'}. The cat/patient name is the ANIMAL PATIENT listed in the patient details section (with species, breed, age), not the owner, vet, or clinic name.
Extract ALL clinical data from this document. Be exhaustive — never omit values.

CRITICAL — DATE ANCHORING:
All content in a clinical summary document (clinical note, physical exam, assessments, AND all diagnostic
results including CBC, chemistry, urinalysis, endocrinology, blood pressure) belongs to the same Record Date
shown in the document header. Even if diagnostics appear under a separate section header or reference number,
use the Record Date for every visit and every lab result unless a DIFFERENT date is explicitly stated.
Never leave resultDate or visitDate null if a Record Date exists anywhere in the document.

IMPORTANT — LAB TABLE FORMAT:
PDF extraction often garbles table columns. Columns are:
  Test Name | Result | Units | Low Reference | High Reference | Qualifier (H/L/blank)
Reconstruct each row carefully. Extract EVERY row — do not skip any.
H or HIGH qualifier → abnormal:"HIGH", L or LOW → abnormal:"LOW", blank → abnormal:null.
For values expressed as "<N" keep the string as the value.

IMPORTANT — LAB GROUPING:
Set labGroup to the panel header, cleaned: strip trailing "(N)" suffixes ("Hematology(1)" → "Hematology"),
and map "Hematology" → "CBC". Use section headings: "Chemistry", "CBC", "Urinalysis", "GI Panel",
"Spec cPL", "T4", "FELV/FIV", etc. Do NOT invent categories or use "Endocrinology" unless the report says that.
BLOOD PRESSURE: Do NOT put in labs. Store in vitals.BP instead.

EXTRACT everything: visits with synopsis, chief complaint, medications (name/dose/freq/route/continuing/supplement flag),
procedures, vitals, ALL lab values from ALL panels, PCR results, parasite prevention, vaccines.
SYNOPSIS: 2-4 factual sentences — what happened at this visit, what was found, what was decided.
NARRATIVE: Structure with labeled sections: HISTORY, PHYSICAL EXAM, ASSESSMENT, PLAN. Preserve all details.
MEDICATIONS: tag supplement:true for vitamins/supplements/nutraceuticals. Deduplicate.
SKIP: costs, billing, boilerplate, appointment reminders, legal text, product marketing, feeding plans, kcal.

Return JSON only, no markdown:
{"skip":false,"isAmendment":false,"cats":["Bella"],"dates":["2025-05-13"],"visits":[{"cat":"Bella","date":"2025-05-13","clinic":"City Vet","doctor":"Dr. Smith","chiefComplaint":"weight loss, alopecia","synopsis":"2-4 sentence factual summary","medications":[],"procedures":[],"vitals":{"weight":"8.25 lbs","HR":164},"narrative":"HISTORY\\n...","confidence":0.9,"flags":[]}],"labs":[{"cat":"Bella","test":"BUN","value":16,"unit":"mg/dL","refLow":16,"refHigh":37,"abnormal":null,"resultDate":"2025-05-13","visitDate":"2025-05-13","labName":"Chemistry","labGroup":"Chemistry"}],"pcr":[],"flags":[]}

Only skip if truly empty of all clinical content → {"skip":true}

--- FILE: ${filename} ---
${text.slice(0, 18000)}`;
}

export async function pollBatchJob(batchId) {
  const poll = async () => {
    try {
      const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        }
      });
      if (!res.ok) return;
      const batch = await res.json();

      const processed = (batch.request_counts?.succeeded || 0) + (batch.request_counts?.errored || 0);
      const total = batch.request_counts?.processing + processed + (batch.request_counts?.canceled || 0) || 0;

      if ($('batch-banner').classList.contains('show')) {
        showBatchBanner(batchId, total, processed);
      }

      if (batch.processing_status === 'ended') {
        await processBatchResults(batchId);
        return;
      }

      setTimeout(poll, 30000);
    } catch(e) {
      console.warn('Batch poll error:', e.message);
      setTimeout(poll, 60000);
    }
  };
  setTimeout(poll, 15000);
}

export async function processBatchResults(batchId) {
  try {
    const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });
    if (!res.ok) throw new Error(`Results fetch failed: ${res.status}`);

    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);

    const batchDoc = await getDoc(doc(db, 'batches', batchId));
    const batchData = batchDoc.exists() ? batchDoc.data() : {};
    const fileNames = batchData.fileNames || {};

    const importMod = await import('./import.js');
    let succeeded = 0, failed = 0, flagged = 0;

    for (const line of lines) {
      try {
        const result = JSON.parse(line);
        const fileId = result.custom_id;
        const filename = fileNames[fileId] || fileId;

        if (result.result?.type === 'succeeded') {
          const raw = result.result.message?.content?.map(b => b.text || '').join('') || '';
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

          if (parsed.skip) {
            await writeFileStatus(fileId, filename, 'complete', { extractionPasses: ['skipped'] });
            updateFileBadge(fileId, 'complete');
            continue;
          }

          const batchLabs = [...(parsed.labs || []), ...(parsed.pcr || []).map(r => ({...r, labName:'PCR', labGroup:'PCR'}))];
          importMod.normalizeLabGroups(batchLabs);
          parsed._normalizedLabs = batchLabs;

          await writeBatchResultToFirestore(fileId, filename, parsed, importMod);
          succeeded++;
          updateFileBadge(fileId, parsed.flags?.length ? 'flagged' : 'complete');
          if (parsed.flags?.length) flagged++;
        } else {
          await writeFileStatus(fileId, filename, 'failed', { error: result.result?.error?.message || 'Batch error' });
          updateFileBadge(fileId, 'failed');
          failed++;
        }
      } catch(e) {
        console.warn('Result parse error:', e.message);
        failed++;
      }
    }

    await setDoc(doc(db, 'batches', batchId), { status: 'complete', completedAt: new Date().toISOString() }, { merge: true });

    if (window.reloadSidebars) {
      await window.reloadSidebars('records');
      await window.reloadSidebars('labs');
    }

    const flagCount = parseInt($('flags-count').textContent || '0') + flagged;
    if (flagCount > 0) { $('flags-count').textContent = flagCount; $('flags-btn').style.display = 'inline-flex'; }

    $('batch-banner').classList.remove('show');
    showToast(`Batch complete — ${succeeded} processed, ${failed} failed, ${flagged} flagged`, 'journal');

  } catch(err) {
    console.error('Batch results error:', err);
    showAlert('Error processing batch results: ' + err.message, 'warning');
  }
}

async function writeBatchResultToFirestore(fileId, filename, parsed, importMod) {
  const allCats = new Set(parsed.cats || []);
  const allDates = new Set(parsed.dates || []);
  let batch = writeBatch(db);
  let writeCount = 0;

  const maybeFlush = async () => {
    if (writeCount > 0 && writeCount % 400 === 0) {
      await batch.commit();
      batch = writeBatch(db);
    }
  };

  const visitDates = (parsed.visits || []).map(v => v.date).filter(Boolean);
  const allKnownDates = [...new Set([...allDates, ...visitDates])].sort().reverse();
  const primaryDate = allKnownDates[0] || null;

  for (const visit of (parsed.visits || [])) {
    if (!visit.cat || visit.cat === 'SKIP') continue;
    const ref = doc(collection(db, 'visits'));
    batch.set(ref, sanitizeForFirestore({
      cat: visit.cat, date: visit.date || 'unknown',
      clinic: visit.clinic || null, doctor: visit.doctor || null,
      chiefComplaint: visit.chiefComplaint || null,
      synopsis: visit.synopsis || null,
      docType: visit.docType || null,
      medications: visit.medications || [],
      procedures: visit.procedures || [], vitals: visit.vitals || null,
      narrative: visit.narrative || '',
      sourceFiles: [filename], driveFileIds: [fileId], sourceFileId: fileId,
      visitCluster: `${visit.date||'unknown'}_${(visit.clinic||'unknown').toLowerCase().replace(/\s+/g,'_').slice(0,20)}`,
      confidence: visit.confidence || 0.8, flags: visit.flags || [],
      createdAt: new Date().toISOString()
    }));
    allCats.add(visit.cat);
    if (visit.date) allDates.add(visit.date);
    writeCount++;
    await maybeFlush();
  }

  for (const lab of (parsed._normalizedLabs || [...(parsed.labs || []), ...(parsed.pcr || []).map(r => ({...r, labName:'PCR', labGroup:'PCR'}))])) {
    if (!lab.test || lab.value === undefined || lab.value === null) continue;
    const cat = lab.cat || (allCats.size === 1 ? [...allCats][0] : null);
    if (!cat) continue;
    const resolvedDate = lab.resultDate || lab.visitDate || primaryDate;
    const ref = doc(collection(db, 'labs'));
    batch.set(ref, sanitizeForFirestore({
      cat, test: lab.test, value: lab.value, unit: lab.unit || null,
      refLow: lab.refLow ?? null, refHigh: lab.refHigh ?? null, abnormal: lab.abnormal || null,
      resultDate: resolvedDate, visitDate: resolvedDate,
      labName: lab.labName || null, labGroup: lab.labGroup || null,
      sourceFile: filename, driveFileId: fileId,
      createdAt: new Date().toISOString()
    }));
    writeCount++;
    await maybeFlush();
  }

  for (const flag of (parsed.flags || [])) {
    const ref = doc(collection(db, 'flags'));
    batch.set(ref, sanitizeForFirestore({
      fileId, filename, type: flag.type || 'unclear_structure',
      description: flag.description || '', bestGuess: flag.bestGuess || null,
      options: ['Accept guess', 'Enter manually', 'View original'],
      resolved: false, resolvedAt: null, resolution: null,
      createdAt: new Date().toISOString()
    }));
    writeCount++;
    await maybeFlush();
  }

  await batch.commit();

  const ACTIONABLE_FLAG_TYPES = ['no_date', 'no_cats', 'unknown_type', 'chunk_skipped'];
  const actionableFlags = (parsed.flags || []).filter(f => ACTIONABLE_FLAG_TYPES.includes(f.type));
  const finalStatus = actionableFlags.length > 0 ? 'flagged' : 'complete';
  await writeFileStatus(fileId, filename, finalStatus, {
    cats: [...allCats], datesCovered: [...allDates].sort(),
    extractionPasses: ['combined_batch'], processedAt: new Date().toISOString()
  });
}

// ── RECOVER STUCK FILES ──
export async function recoverStuckFiles() {
  try {
    const stuckSnap = await getDocs(query(
      collection(db, 'files'),
      where('status', '==', 'processing')
    ));
    if (stuckSnap.empty) return;

    const importMod = await import('./import.js');
    let recovered = 0, reset = 0;
    for (const fileDoc of stuckSnap.docs) {
      const fileData = fileDoc.data();
      const fileId = fileData.driveFileId || fileDoc.id;
      const filename = fileData.filename || fileId;

      try {
        const cacheDoc = await getDoc(doc(db, 'extractions', fileId));
        if (cacheDoc.exists() && cacheDoc.data().result && !cacheDoc.data().committed) {
          const cached = JSON.parse(cacheDoc.data().result);
          if (cached.allVisits || cached.allLabs) {
            const allCats = new Set(cached.cats || []);
            const allDates = new Set(cached.dates || []);
            await importMod.writeExtractionToFirestore(
              { id: fileId, name: filename },
              cached.allVisits || [],
              cached.allLabs || [],
              cached.allFlags || [],
              allCats, allDates,
              cached.passes || [],
              false, null
            );
            recovered++;
            console.log(`Recovered stuck file: ${filename}`);
            continue;
          }
        }
      } catch(e) { /* no cache — fall through to reset */ }

      await setDoc(doc(db, 'files', fileId), { status: 'unprocessed', updatedAt: new Date().toISOString() }, { merge: true });
      reset++;
    }

    if (recovered || reset) {
      if (window.reloadSidebars) await window.reloadSidebars('all');
      if (recovered) showToast(`Recovered ${recovered} interrupted file${recovered > 1 ? 's' : ''} ✓`, 'journal');
      if (reset) showToast(`Reset ${reset} stuck file${reset > 1 ? 's' : ''} to unprocessed`, 'warning');
    }
  } catch(e) {
    console.warn('Stuck file recovery failed (non-critical):', e.message);
  }
}

// ── CHECK PENDING BATCHES ──
export async function checkPendingBatches() {
  const { currentUser } = await import('./state.js');
  if (!apiKey || !currentUser) return;
  try {
    const snap = await getDocs(query(collection(db, 'batches'), where('status', '==', 'in_progress')));
    snap.forEach(d => {
      const b = d.data();
      showBatchBanner(b.batchId, b.totalFiles, b.processedFiles || 0);
      pollBatchJob(b.batchId);
    });
  } catch(e) { console.warn('Pending batch check:', e.message); }
}

// ── BATCH BANNER ──
function showBatchBanner(batchId, total, processed) {
  const banner = $('batch-banner');
  if (!banner) return;
  banner.classList.add('show');
  const label = banner.querySelector('.batch-banner-label') || banner;
  if (label) {
    label.textContent = `Batch processing: ${processed}/${total} files complete`;
  }
  banner.dataset.batchId = batchId;
}

// Expose for window.loadDriveFiles reference in HTML onclick handlers
window.loadDriveFiles = loadDriveFiles;

// ── DRIVE RECONNECT BUTTON WIRING ──
{
  const connectBtn = $('connect-drive-btn');
  if (connectBtn) connectBtn.addEventListener('click', () => reconnectDrive(connectBtn));

  const statusIndicator = $('drive-status-indicator');
  if (statusIndicator) statusIndicator.addEventListener('click', () => reconnectDrive(null));
}

// ── TOOLBAR BUTTON WIRING ──
{
  const refreshBtn = $('refresh-drive-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    if (!driveAccessToken) { showToast('Connect Drive first', 'warning'); return; }
    window._driveLastLoaded = 0;
    loadDriveFiles();
  });

  const uploadBtn = $('upload-files-btn');
  const uploadInput = $('upload-file-input');
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => {
      if (!driveAccessToken) { showToast('Connect Drive first', 'warning'); return; }
      uploadInput.click();
    });
    uploadInput.addEventListener('change', () => {
      if (uploadInput.files?.length) {
        uploadFilesToDrive(Array.from(uploadInput.files));
        uploadInput.value = '';
      }
    });
  }
}
window.openFlagsModal = (...args) => import('./ui.js').then(m => m.openFlagsModal?.(...args) || window._openFlagsModal?.(...args));
