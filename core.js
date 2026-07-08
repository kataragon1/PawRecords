// ── CORE ── Firebase init, auth, utilities
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, arrayRemove, writeBatch, collection, getDocs, query, where, orderBy, limit, deleteField }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

import {
  currentUser, setCurrentUser,
  apiKey, setApiKey,
  driveAccessToken, setDriveAccessToken,
  sessionCost, setSessionCost,
  allTimeCost, setAllTimeCost,
  costWarnThreshold, setCostWarnThreshold,
  costAlertThreshold, setCostAlertThreshold,
  _cacheTimerInterval, setCacheTimerInterval,
  _cacheExpiresAt, setCacheExpiresAt,
  setChatContextDirty,
  pendingJournalItems,
  APP_PETS,
  _petProfiles,
} from './state.js';

// ── CONFIG ──
const firebaseConfig = {
  apiKey: "AIzaSyBECkOIkB_rbreDsTo44Kvwq0jL6f29cv0",
  authDomain: "pawrecords-1a8e6.firebaseapp.com",
  projectId: "pawrecords-1a8e6",
  storageBucket: "pawrecords-1a8e6.firebasestorage.app",
  messagingSenderId: "434841981751",
  appId: "1:434841981751:web:eb27c2ebb38920e9b040b2"
};

// ── INIT ──
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.readonly');

// Re-export Firestore helpers for use in other modules
export {
  doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, arrayRemove, writeBatch,
  collection, getDocs, query, where, orderBy, limit, deleteField,
  signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider
};

// ── HELPERS ──
export const $ = id => document.getElementById(id);
export const show = s => { document.querySelectorAll('.screen').forEach(el => el.classList.remove('active')); $(s).classList.add('active'); };
export const setLoading = label => { $('loading-label').textContent = label; show('loading'); };

// Persistent dismissable alert bar
export function showAlert(text, type = 'warning') {
  const bar = document.getElementById('alert-bar');
  const a = document.createElement('div');
  const bg = type === 'warning' ? '#fef3c7' : '#fee2e2';
  const border = type === 'warning' ? '#d97706' : '#dc2626';
  const color = type === 'warning' ? '#92400e' : '#991b1b';
  a.style.cssText = `display:flex;align-items:center;gap:0.75rem;padding:0.6rem 1rem;background:${bg};border-top:2px solid ${border};font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:${color};`;
  a.innerHTML = `<span style="flex:1;">${escHtml(text)}</span><button style="background:none;border:none;cursor:pointer;color:${color};font-size:0.8rem;padding:0.1rem 0.3rem;border-radius:3px;font-weight:600;" title="Dismiss">✕</button>`;
  a.querySelector('button').onclick = () => { a.remove(); if (!bar.children.length) bar.style.display = 'none'; };
  bar.style.display = 'block';
  bar.appendChild(a);
}

export function showToast(text, type = 'info', undoFn = null, duration = null) {
  if (duration === null) {
    duration = type === 'warning' ? null : 4000;
  }
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.cursor = type === 'warning' ? 'pointer' : 'default';
  if (type === 'warning') {
    t.style.cssText += 'border-color:var(--amber);background:#fffbf0;';
    t.title = 'Click to dismiss';
  }
  const dotColor = type === 'journal' ? 'green' : type === 'warning' ? 'amber' : 'green';
  const suffix = type === 'warning' ? `<span style="margin-left:0.5rem;font-size:0.6rem;color:var(--amber);flex-shrink:0;font-weight:600;">✕</span>` : '';
  t.innerHTML = `<div class="toast-dot ${dotColor}"></div><div class="toast-text">${text}</div>${suffix}`;
  if (undoFn) {
    const ub = document.createElement('button');
    ub.className = 'toast-undo';
    ub.textContent = 'Undo';
    ub.onclick = (e) => { e.stopPropagation(); undoFn(); t.remove(); };
    t.appendChild(ub);
  }
  const dismiss = () => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); };
  if (type === 'warning') {
    t.addEventListener('click', dismiss);
    c.prepend(t);
  } else {
    c.appendChild(t);
  }
  if (duration !== null) setTimeout(dismiss, duration);
}

// ── UTILITIES ──
export function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
export function formatDate(d) {
  if (!d) return 'Unknown date';
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}
export function formatDateShort(d) {
  if (!d) return '';
  try {
    const dt = new Date(d + 'T12:00:00');
    return `${dt.getMonth()+1}/${dt.getDate()}/${dt.getFullYear().toString().slice(2)}`;
  }
  catch { return d; }
}
export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + 'b';
  if (bytes < 1048576) return Math.round(bytes / 1024) + 'k';
  return (bytes / 1048576).toFixed(1) + 'mb';
}
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CAT COLOR / EMOJI HELPERS ──
// Note: _petProfiles is a live binding from state.js — always up to date
export const _CAT_COLOR_FALLBACK = '#e4e0d8';
export function catColor(catName) {
  return _petProfiles[catName]?.color || _CAT_COLOR_FALLBACK;
}
export function catEmoji(catName) {
  return _petProfiles[catName]?.emoji || '🐱';
}
export function catColorDark(catName) {
  const hex = catColor(catName).replace('#','');
  if (hex.length !== 6) return '#2a2520';
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
  return luminance > 0.55 ? '#2a2520' : '#ffffff';
}

// ── JOURNAL HELPERS ──
export function jCats(j) {
  if (!j) return [];
  if (Array.isArray(j.cats) && j.cats.length) return j.cats;
  if (j.cat) return [j.cat];
  return [];
}

// ── INVALIDATE CHAT CONTEXT ──
export function invalidateChatContext() { setChatContextDirty(true); }

// ── STATUS BAR ──
export function updateStatusBar() {
  // apiKey, currentUser, driveAccessToken are live bindings from state.js
  if (currentUser) {
    $('firebase-dot').className = 'status-dot green';
    $('firebase-status').textContent = 'Firebase connected';
  }
  if (apiKey) {
    $('apikey-dot').className = 'status-dot green';
    $('apikey-status').textContent = 'API key set';
  } else {
    $('apikey-dot').className = 'status-dot amber';
    $('apikey-status').textContent = 'No API key';
  }
  // Send stays enabled even without a key — free local lookups don't need one.
  $('send-btn').disabled = false;
  if (driveAccessToken) {
    // Token exists from session but not yet verified — don't show green until loadDriveFiles() confirms
    $('drive-dot').className = 'status-dot amber';
    $('drive-status').textContent = 'Drive — connecting…';
  } else {
    $('drive-dot').className = 'status-dot amber';
    $('drive-status').textContent = 'Drive — click Files to connect';
  }
}

// ── API KEY ──
export async function loadApiKey() {
  if (currentUser) {
    try {
      const snap = await getDoc(doc(db, 'settings', currentUser.uid));
      if (snap.exists() && snap.data().anthropicKey) {
        setApiKey(snap.data().anthropicKey);
        updateStatusBar();
        return;
      }
    } catch(e) { console.warn('Firestore key load failed:', e); }
  }
  try { setApiKey(localStorage.getItem('pr_apikey') || ''); } catch(e) {}
  updateStatusBar();
}

export async function saveApiKey(key) {
  if (currentUser) {
    try {
      await setDoc(doc(db, 'settings', currentUser.uid), { anthropicKey: key }, { merge: true });
    } catch(e) {
      console.warn('Firestore key save failed, using localStorage:', e);
      try { localStorage.setItem('pr_apikey', key); } catch(e2) {}
    }
  } else {
    try { localStorage.setItem('pr_apikey', key); } catch(e) {}
  }
  try { localStorage.setItem('pr_apikey', key); } catch(e) {}
}

// ── COST TRACKING ──
export function saveCostSettings() {
  try {
    localStorage.setItem('pr_cost_settings', JSON.stringify({
      warn: costWarnThreshold,
      alert: costAlertThreshold,
      allTime: allTimeCost
    }));
  } catch(e) {}
}

export function startCacheTimer(ttlMs = 5 * 60 * 1000) {
  // ttlMs matches the cache TTL chosen for the request (5m quick / 1h extended).
  setCacheExpiresAt(Date.now() + ttlMs);
  const timerEl = $('cache-timer');
  const valEl = $('cache-timer-val');
  if (!timerEl || !valEl) return;
  timerEl.style.display = 'inline-flex';
  timerEl.style.color = 'var(--ink-muted)';
  timerEl.style.borderColor = 'var(--border)';
  if (_cacheTimerInterval) clearInterval(_cacheTimerInterval);
  const interval = setInterval(() => {
    const remaining = Math.max(0, _cacheExpiresAt - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    valEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    if (remaining <= 60000) {
      timerEl.style.color = 'var(--amber)';
      timerEl.style.borderColor = 'var(--amber)';
    }
    if (remaining === 0) {
      clearInterval(interval);
      timerEl.style.display = 'none';
    }
  }, 1000);
  setCacheTimerInterval(interval);
}

export function updateSessionCost(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  let cost;
  if (outputTokens !== undefined) {
    cost = (inputTokens / 1000000) * 3.0
         + (outputTokens / 1000000) * 15.0
         + (cacheReadTokens / 1000000) * 0.30
         + (cacheWriteTokens / 1000000) * 3.75;
  } else {
    cost = (inputTokens / 1000000) * 6.0;
  }
  const newSession = sessionCost + cost;
  const newAllTime = allTimeCost + cost;
  setSessionCost(newSession);
  setAllTimeCost(newAllTime);
  saveCostSettings();
  const el = $('session-cost');
  el.style.display = 'block';
  el.textContent = `Session: $${newSession.toFixed(4)}`;
  el.className = 'session-cost' + (newSession > costAlertThreshold ? ' alert' : newSession > costWarnThreshold ? ' warning' : '');
  if (newSession > costAlertThreshold && newSession - cost <= costAlertThreshold) {
    showToast(`⚠ Cost alert: session has reached $${newSession.toFixed(2)}`, 'warning');
  } else if (newSession > costWarnThreshold && newSession - cost <= costWarnThreshold) {
    showToast(`Cost warning: session at $${newSession.toFixed(2)}`, 'info');
  }
}

// ── JOURNAL BADGE ──
export function updateJournalBadge() {
  const count = pendingJournalItems.length;
  const tab = document.querySelector('.sidebar-tab[data-tab="journal"]');
  if (!tab) return;
  if (count > 0) {
    tab.textContent = `Journal (${count})`;
    tab.style.color = 'var(--amber)';
  } else {
    tab.textContent = 'Journal';
    tab.style.color = '';
  }
}

// ── CLINIC ABBREVIATIONS ──
let _clinicAbbrevLocal = {
  'Veterinary Emergency Group': 'VEG',
  'BluePearl': 'BluePearl',
  'VCA ': 'VCA',
  'Banfield': 'Banfield',
};

export async function loadClinicAbbrev() {
  try {
    const d = await getDoc(doc(db, 'app_config', 'clinic_abbrev'));
    if (d.exists()) _clinicAbbrevLocal = { ..._clinicAbbrevLocal, ...d.data() };
  } catch(e) {}
}

export function abbreviateClinic(name) {
  if (!name) return '';
  for (const [full, abbr] of Object.entries(_clinicAbbrevLocal)) {
    if (name.toLowerCase().includes(full.toLowerCase())) return abbr;
  }
  const words = name.replace(/,.*$/,'').replace(/\s+(Animal|Pet|Vet|Veterinary|Hospital|Clinic|Center|Care)\b.*/i,'').trim().split(/\s+/);
  return words.slice(0,3).join(' ').slice(0,18);
}

// ── NARRATIVE FORMATTER ──
const NARRATIVE_SECTIONS = [
  'HISTORY', 'PHYSICAL EXAMINATION', 'PHYSICAL EXAM', 'ASSESSMENT', 'PLAN',
  'SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT AND PLAN', 'DIAGNOSIS', 'TREATMENT',
  'RECOMMENDATIONS', 'FOLLOW-UP', 'DISCHARGE INSTRUCTIONS', 'PROGNOSIS',
];
export function formatNarrative(text) {
  if (!text) return '';
  let result = text;
  for (const section of NARRATIVE_SECTIONS) {
    const re = new RegExp(`(?:^|\\n)(${section}:?)`, 'gi');
    result = result.replace(re, (_, s) => `\n\n**${s.toUpperCase()}**\n`);
  }
  return result.trim();
}

// ── TYPING INDICATOR ──
export function appendTyping() {
  const chatBody = $('chat-body');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<div class="msg-avatar">pr</div><div class="msg-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
  chatBody.appendChild(div);
  chatBody.scrollTop = chatBody.scrollHeight;
  return div;
}

// ── FIRESTORE HELPERS ──
export async function writeFileStatus(fileId, filename, status, extra = {}) {
  await setDoc(doc(db, 'files', fileId), {
    driveFileId: fileId,
    filename,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  }, { merge: true });
}

// ── LOAD INITIAL DATA ──
export async function loadInitialData() {
  // These are lazy imports to avoid circular deps
  const { loadPetProfiles } = await import('./pets.js');
  const { loadRecordsSidebar } = await import('./records.js');
  const { loadLabsSidebar, loadLabCorrections, loadLabGroups, checkAbnormalLabs } = await import('./labs.js');
  const { loadJournalSidebar } = await import('./journal.js');
  const { loadNotes } = await import('./notes.js');
  const { ensureDataCache } = await import('./chat.js');
  const { loadDriveFiles, recoverStuckFiles, checkPendingBatches } = await import('./files.js');
  const { getPdfJs } = await import('./import.js');
  const { checkPausedSession } = await import('./chat.js');

  try {
    setLoading('Loading profiles…');
    await loadPetProfiles();
    setLoading('Loading records…');
    await loadRecordsSidebar();
    setLoading('Loading labs…');
    await loadLabsSidebar();
    setLoading('Loading journal…');
    await loadJournalSidebar();
    setLoading('Building search index…');
    await ensureDataCache();
    setLoading('Loading notes…');
    await loadNotes();
    setLoading('Loading corrections…');
    await loadLabCorrections();
    await loadLabGroups();
    await loadClinicAbbrev();
    await _updatePetList();
    await checkAbnormalLabs();
    await checkPendingBatches();
    await recoverStuckFiles();

    try {
      const flagSnap = await getDocs(query(collection(db, 'flags'), where('resolved', '==', false)));
      if (!flagSnap.empty) {
        $('flags-count').textContent = flagSnap.size;
        $('flags-btn').style.display = 'inline-flex';
      }
    } catch(e) { /* non-critical */ }

    setLoading('Ready');

    if (driveAccessToken) {
      window._driveLastLoaded = Date.now();
      loadDriveFiles().catch(e => console.warn('Background Drive load failed:', e.message));
    }
  } catch (err) {
    console.error('Load error:', err);
    showAlert('Some data failed to load on startup — check console for details', 'warning');
  }

  getPdfJs().catch(() => {}); // preload PDF.js in background
  setTimeout(checkPausedSession, 1500);
}

export async function reloadSidebars(which = 'all') {
  const { loadRecordsSidebar } = await import('./records.js');
  const { loadLabsSidebar } = await import('./labs.js');
  const { loadJournalSidebar } = await import('./journal.js');
  if (which === 'all' || which === 'records') await loadRecordsSidebar();
  if (which === 'all' || which === 'labs') await loadLabsSidebar();
  if (which === 'all' || which === 'journal') await loadJournalSidebar();
}

async function _updatePetList() {
  try {
    const { renderCatFocusPills, renderPetAges, savePetProfiles } = await import('./pets.js');
    const snap = await getDocs(collection(db, 'visits'));
    const pets = [...new Set(snap.docs.map(d => d.data().cat).filter(Boolean))].sort();
    if (pets.length) {
      APP_PETS.length = 0;
      pets.forEach(p => APP_PETS.push(p));
      Object.keys(_petProfiles).forEach(p => { if (!APP_PETS.includes(p)) APP_PETS.push(p); });

      let profilesUpdated = false;
      for (const cat of pets) {
        if (_petProfiles[cat]?.birthdate) continue;
        const catVisits = snap.docs.filter(d => d.data().cat === cat).map(d => d.data());
        for (const v of catVisits) {
          const bd = v.birthdate || v.patientBirthdate || v.dob;
          if (bd && /^\d{4}-\d{2}-\d{2}$/.test(bd)) {
            if (!_petProfiles[cat]) _petProfiles[cat] = {};
            _petProfiles[cat].birthdate = bd;
            profilesUpdated = true;
            console.log(`Auto-detected birthdate for ${cat}: ${bd}`);
            break;
          }
        }
      }
      if (profilesUpdated) await savePetProfiles();

      if (window._renderNoteChips) window._renderNoteChips();
      renderCatFocusPills();
      renderPetAges();
      const list = pets.length === 1 ? pets[0]
        : pets.slice(0, -1).join(', ') + ' & ' + pets[pets.length - 1];
      $('welcome-subtitle').textContent =
        `Ask about medications, lab trends, visit history, or anything on your mind.\n\nRecords loaded for ${list}.`;
      $('user-input').placeholder = `Ask anything about ${list}…`;
    }
  } catch(e) { /* non-critical */ }
}

// ── API KEY MODAL WIRING ──
{
  const openModal = () => {
    $('apikey-input').value = apiKey || '';
    $('apikey-status-msg').textContent = '';
    $('apikey-modal').style.display = 'flex';
    setTimeout(() => $('apikey-input')?.focus(), 80);
  };
  const closeModal = () => { $('apikey-modal').style.display = 'none'; };
  $('apikey-status-indicator')?.addEventListener('click', openModal);
  $('apikey-modal-close')?.addEventListener('click', closeModal);
  $('apikey-cancel-btn')?.addEventListener('click', closeModal);
  $('apikey-save-btn')?.addEventListener('click', async () => {
    const key = $('apikey-input').value.trim();
    $('apikey-status-msg').textContent = 'Saving…';
    await saveApiKey(key);
    $('apikey-status-msg').textContent = key ? 'Saved ✓' : 'Key cleared';
    setTimeout(closeModal, 800);
  });
  $('apikey-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('apikey-save-btn')?.click();
    if (e.key === 'Escape') closeModal();
  });
}
