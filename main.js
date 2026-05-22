// ── MAIN ENTRY POINT ──
// Auth, sidebar tabs, sidebar resize, and app bootstrap.
// All feature logic lives in the imported modules.

import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { getDoc, doc }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

import {
  auth, db, provider, $, show, setLoading,
  showToast, updateStatusBar, loadApiKey, loadInitialData,
} from './core.js';

import {
  currentUser, setCurrentUser,
  driveAccessToken, setDriveAccessToken,
  sessionCost, setSessionCost,
  convHistory, setConvHistory,
  pendingJournalItems, setPendingJournalItems,
  _activeTab, setActiveTab,
  _recordsSidebarDirty,
  processingActive,
} from './state.js';

import { initChat } from './chat.js';

// Lazy module imports for sidebar tab switching
async function getRecords() { return import('./records.js'); }
async function getLabs()    { return import('./labs.js'); }
async function getFiles()   { return import('./files.js'); }

// ── AUTH ──
$('signin-btn').addEventListener('click', async () => {
  const btn = $('signin-btn');
  if (btn) btn.disabled = true;
  const errEl = $('signin-error');
  if (errEl) errEl.classList.remove('show');
  setLoading('Signing in with Google…');
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      setDriveAccessToken(credential.accessToken);
      try { sessionStorage.setItem('pr_drive_token', driveAccessToken); } catch(e) {}
    }
  } catch (err) {
    if (err.code === 'auth/cancelled-popup-request' || err.code === 'auth/popup-closed-by-user') return;
    show('signin');
    if ($('signin-btn')) $('signin-btn').disabled = false;
    if ($('signin-error')) {
      $('signin-error').textContent = err.message || 'Sign in failed.';
      $('signin-error').classList.add('show');
    }
  }
});

$('signout-btn').addEventListener('click', async () => {
  await signOut(auth);
  setSessionCost(0);
  setConvHistory([]);
  setPendingJournalItems([]);
  setDriveAccessToken(null);
  try { sessionStorage.removeItem('pr_drive_token'); } catch(e) {}
  show('signin');
  $('signin-btn').disabled = false;
});

onAuthStateChanged(auth, async user => {
  if (user) {
    setCurrentUser(user);
    setLoading('Verifying access…');
    try {
      const allowedDoc = await getDoc(doc(db, 'users', 'allowed'));
      if (!allowedDoc.exists()) throw new Error('users/allowed document missing');
      const allowedEmails = Array.isArray(allowedDoc.data().email) ? allowedDoc.data().email : [];
      if (!allowedEmails.some(e => String(e).toLowerCase() === user.email.toLowerCase())) {
        await signOut(auth);
        show('signin');
        const errEl = $('signin-error');
        if (errEl) { errEl.textContent = `Access denied for ${user.email}.`; errEl.classList.add('show'); }
        return;
      }
    } catch(e) {
      await signOut(auth);
      show('signin');
      const errEl = $('signin-error');
      if (errEl) { errEl.textContent = `Could not verify access: ${e.message}`; errEl.classList.add('show'); }
      return;
    }
    setLoading('Loading your records…');
    $('sidebar-user-email').textContent = user.email;
    $('header-context').textContent = '';
    await loadApiKey();
    await loadInitialData();
    show('app');
    import('./exchange.js').then(m => m.initExchangeBar());
  } else {
    setCurrentUser(null);
    show('signin');
  }
});

// ── SIDEBAR TABS ──
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    setActiveTab(tab.dataset.tab);
    $(`panel-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'records' && _recordsSidebarDirty) {
      const { loadRecordsSidebar } = await getRecords();
      loadRecordsSidebar();
    }
    if (tab.dataset.tab === 'labs') {
      const { renderLabsSidebar } = await getLabs();
      renderLabsSidebar();
    }
    if (tab.dataset.tab === 'files') {
      const { loadDriveFiles, showDriveConnectPrompt } = await getFiles();
      if (!driveAccessToken) {
        showDriveConnectPrompt('Drive access token missing or expired. Click to reconnect.');
      } else if (!window._driveLoaded && !processingActive) {
        window._driveLoaded = true;
        loadDriveFiles();
      }
    }
  });
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && _activeTab === 'files') {
    const { showDriveConnectPrompt } = await getFiles();
    if (!driveAccessToken) showDriveConnectPrompt('Drive session expired. Click to reconnect.');
  }
});

// ── SIDEBAR RESIZE ──
{
  const handle = $('sidebar-resize-handle');
  const sidebar = $('sidebar');
  const MIN_W = 200, MAX_W = 520;
  let dragging = false, startX = 0, startW = 0;
  try {
    const saved = localStorage.getItem('pr_sidebar_w');
    if (saved) {
      const w = parseInt(saved);
      if (w >= MIN_W && w <= MAX_W) document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    }
  } catch(e) {}
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.min(MAX_W, Math.max(MIN_W, startW + e.clientX - startX));
    document.documentElement.style.setProperty('--sidebar-w', newW + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem('pr_sidebar_w', sidebar.offsetWidth); } catch(e) {}
  });
}

// ── FILES FILTER ──
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const { filterFiles } = await getFiles();
    filterFiles(btn.dataset.filter);
  });
});

// ── VISIT / RECORDS SEARCH ──
{
  const rsi = $('records-search-input');
  const rsc = $('records-search-clear');
  if (rsi) {
    rsi.addEventListener('input', async () => {
      const q = rsi.value.trim();
      rsc.style.display = q ? '' : 'none';
      const { filterVisitsByKeyword } = await getRecords();
      filterVisitsByKeyword(q);
    });
    rsc.addEventListener('click', async () => {
      rsi.value = '';
      rsc.style.display = 'none';
      const { filterVisitsByKeyword } = await getRecords();
      filterVisitsByKeyword('');
    });
  }
}

// ── INIT ──
updateStatusBar();
initChat();

// ── VERSION ──
document.addEventListener('DOMContentLoaded', () => {
  fetch('./version.json')
    .then(r => r.json())
    .then(data => { document.querySelectorAll('.app-version').forEach(el => { el.textContent = 'v' + data.version; }); })
    .catch(() => {});
});

// ── WINDOW GLOBALS (for HTML onclick handlers) ──
import('./pets.js').then(m => { window.openPetProfilesModal = m.openPetProfilesModal; });
import('./records.js').then(m => { window.openVisit = m.openVisit; });
import('./ui.js').then(m => { window.openFlagsModal = m.openFlagsModal; });

// ── HEADER BUTTON WIRING ──
$('open-trends-btn')?.addEventListener('click', async () => {
  const { openTrendsModal } = await import('./ui.js');
  openTrendsModal();
});

$('add-home-issue-btn')?.addEventListener('click', async () => {
  const { openHomeIssueModal } = await import('./records.js');
  openHomeIssueModal();
});
