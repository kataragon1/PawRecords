// ── PETS MODULE ── Pet profiles, birthdates, cat focus pills

import {
  APP_PETS, _petProfiles, setPetProfiles,
  _journalDocsCache, setJournalDocsCache,
  _chatFocusCats, setChatFocusCats,
  _chatFullContext, setChatFullContext,
  _activeTab,
} from './state.js';

import {
  $, db, doc, getDoc, setDoc, getDocs, collection, query, orderBy,
  showToast, escHtml, invalidateChatContext, jCats, catColor, catEmoji, catColorDark,
  formatDate,
} from './core.js';

// ── PET PROFILES ──
export async function loadPetProfiles() {
  try {
    const d = await getDoc(doc(db, 'app_config', 'pet_profiles'));
    if (d.exists()) {
      const data = d.data();
      const profiles = data.profiles || {};
      // Merge into _petProfiles in-place (it's an exported object from state)
      Object.assign(_petProfiles, profiles);
      const savedPetList = data.petList;
      if (savedPetList?.length) {
        for (const p of savedPetList) {
          if (!APP_PETS.includes(p)) APP_PETS.push(p);
        }
      }
    }
    renderPetAges();
    renderCatFocusPills();
    if (_journalDocsCache) {
      const { renderJournalSidebar } = await import('./journal.js');
      renderJournalSidebar(_journalDocsCache);
    } else if (_activeTab === 'journal') {
      const { loadJournalSidebar } = await import('./journal.js');
      loadJournalSidebar();
    }
  } catch(e) { console.warn('Pet profiles load failed:', e.message); }
}

export function renderPetAges() {
  if (!APP_PETS.length) return;
  const today = new Date();
  APP_PETS.forEach(cat => {
    const bd = _petProfiles[cat]?.birthdate;
    const ageEl = document.querySelector(`.cat-age-label[data-cat="${cat}"]`);
    if (!ageEl) return;
    if (!bd) { ageEl.textContent = ''; return; }
    try {
      const birth = new Date(bd + 'T12:00:00');
      const ageMs = today - birth;
      if (ageMs < 0) { ageEl.textContent = ''; return; }
      const years = Math.floor(ageMs / (365.25 * 24 * 3600 * 1000));
      const months = Math.floor((ageMs % (365.25 * 24 * 3600 * 1000)) / (30.44 * 24 * 3600 * 1000));
      ageEl.textContent = years >= 1 ? (months > 0 ? `${years}y ${months}m` : `${years}y`) : `${months}m`;
    } catch { ageEl.textContent = ''; }
  });
}

export async function savePetProfiles() {
  await setDoc(doc(db, 'app_config', 'pet_profiles'), { profiles: _petProfiles });
}

export function isCatKitten(catName, visitDate) {
  const profile = _petProfiles[catName];
  if (!profile?.birthdate || !visitDate) return false;
  try {
    const birth = new Date(profile.birthdate + 'T12:00:00');
    const visit = new Date(visitDate + 'T12:00:00');
    const ageMs = visit - birth;
    return ageMs >= 0 && ageMs < 365.25 * 24 * 3600 * 1000;
  } catch(e) { return false; }
}

// ── PET PROFILES MODAL ──
export function openPetProfilesModal() {
  document.getElementById('pet-profiles-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'pet-profiles-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(42,37,32,0.45);z-index:400;display:flex;align-items:center;justify-content:center;padding:2rem;';
  const cats = APP_PETS.length ? APP_PETS : [];

  const DEFAULT_COLOR = '#e4e0d8';
  const DEFAULT_EMOJI = '🐱';
  const EMOJI_OPTIONS = ['🐱','🐶','🐰','🐹','🐦','🐠','🦜','🐍'];

  const box = document.createElement('div');
  box.style.cssText = 'background:white;border-radius:12px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(42,37,32,0.18);overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'padding:0.85rem 1.25rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;';
  header.innerHTML = `<span style="font-family:'Instrument Serif',serif;font-size:1rem;color:var(--ink);">Pet Profiles</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:6px;width:26px;height:26px;cursor:pointer;color:var(--ink-dim);font-size:0.8rem;';
  closeBtn.onclick = () => modal.remove();
  header.appendChild(closeBtn);
  box.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'padding:1rem 1.25rem;';
  body.innerHTML = `<p style="font-family:'JetBrains Mono',monospace;font-size:0.63rem;color:var(--ink-muted);margin-bottom:0.85rem;line-height:1.6;">Set birthdates and colors for each pet. Add new pets or remove ones no longer in the household.</p>`;

  const inputs = {};
  const petList = [...cats];
  const petRows = document.createElement('div');
  petRows.id = 'pet-profile-rows';
  body.appendChild(petRows);

  function renderPetRows() {
    petRows.innerHTML = '';
    petList.forEach((cat, idx) => {
      const bd = _petProfiles[cat]?.birthdate || '';
      const color = _petProfiles[cat]?.color || DEFAULT_COLOR;
      const emoji = _petProfiles[cat]?.emoji || DEFAULT_EMOJI;

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;border-bottom:1px solid var(--surface2);';

      const emojiSel = document.createElement('select');
      emojiSel.style.cssText = 'font-size:0.85rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.2rem;cursor:pointer;outline:none;';
      EMOJI_OPTIONS.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e; opt.textContent = e;
        if (e === emoji) opt.selected = true;
        emojiSel.appendChild(opt);
      });

      const colorWrap = document.createElement('div');
      colorWrap.style.cssText = 'position:relative;flex-shrink:0;';
      const swatch = document.createElement('div');
      swatch.style.cssText = `width:22px;height:22px;border-radius:50%;background:${color};border:2px solid rgba(0,0,0,0.1);cursor:pointer;`;
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = color;
      colorInput.style.cssText = 'position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;';
      colorInput.addEventListener('input', () => { swatch.style.background = colorInput.value; });
      colorWrap.appendChild(swatch);
      colorWrap.appendChild(colorInput);

      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-family:\'JetBrains Mono\',monospace;font-size:0.72rem;color:var(--ink);flex:1;cursor:pointer;border-bottom:1px dashed transparent;transition:border-color 0.15s;';
      nameSpan.textContent = cat;
      nameSpan.onmouseenter = () => { nameSpan.style.borderBottomColor = 'var(--ink-muted)'; };
      nameSpan.onmouseleave = () => { nameSpan.style.borderBottomColor = 'transparent'; };
      nameSpan.onclick = () => {
        const oldName = petList[idx];
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = oldName;
        nameInput.style.cssText = 'font-family:\'JetBrains Mono\',monospace;font-size:0.72rem;color:var(--ink);flex:1;background:var(--bg);border:1px solid var(--accent);border-radius:4px;padding:0.1rem 0.3rem;outline:none;width:100%;';
        nameSpan.replaceWith(nameInput);
        nameInput.select();
        const commit = () => {
          const newName = nameInput.value.trim();
          if (newName && newName !== oldName) {
            petList[idx] = newName;
            _petProfiles[newName] = _petProfiles[oldName];
            delete _petProfiles[oldName];
            inputs[newName] = inputs[oldName];
            delete inputs[oldName];
          }
          renderPetRows();
        };
        nameInput.onblur = commit;
        nameInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } else if (e.key === 'Escape') { nameInput.value = oldName; nameInput.blur(); } };
      };

      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.value = bd;
      dateInput.style.cssText = 'font-family:\'JetBrains Mono\',monospace;font-size:0.7rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.3rem 0.5rem;color:var(--ink);outline:none;';

      inputs[cat] = { date: dateInput, color: colorInput, emoji: emojiSel };

      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = `Remove ${cat}`;
      delBtn.style.cssText = 'background:none;border:none;color:var(--ink-muted);font-size:0.7rem;cursor:pointer;padding:0.2rem 0.3rem;flex-shrink:0;border-radius:4px;';
      delBtn.onclick = () => {
        if (petList.length <= 1) { showToast('Cannot remove the last pet', 'warning'); return; }
        if (!confirm(`Remove ${cat} from pet profiles? This won't delete their records.`)) return;
        petList.splice(petList.indexOf(cat), 1);
        delete inputs[cat];
        renderPetRows();
      };

      row.appendChild(emojiSel);
      row.appendChild(colorWrap);
      row.appendChild(nameSpan);
      row.appendChild(dateInput);
      row.appendChild(delBtn);
      petRows.appendChild(row);
    });
  }
  renderPetRows();

  const addPetRow = document.createElement('div');
  addPetRow.style.cssText = 'padding:0.6rem 0 0.2rem;';
  const addPetBtn = document.createElement('button');
  addPetBtn.className = 'btn-icon';
  addPetBtn.style.cssText = 'width:100%;justify-content:center;font-size:0.6rem;';
  addPetBtn.textContent = '+ Add Pet';
  addPetBtn.onclick = () => {
    const name = prompt('New pet name:')?.trim();
    if (!name || petList.includes(name)) return;
    petList.push(name);
    if (!_petProfiles[name]) _petProfiles[name] = {};
    renderPetRows();
  };
  addPetRow.appendChild(addPetBtn);
  body.appendChild(addPetRow);
  box.appendChild(body);

  const footer = document.createElement('div');
  footer.style.cssText = 'padding:0.75rem 1.25rem;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:0.5rem;';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-icon';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => modal.remove();
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-icon free-icon';
  saveBtn.innerHTML = '<span class="free-dot"></span> Save';
  saveBtn.onclick = async () => {
    for (const [pet, els] of Object.entries(inputs)) {
      if (!_petProfiles[pet]) _petProfiles[pet] = {};
      _petProfiles[pet].birthdate = els.date?.value || null;
      _petProfiles[pet].color = els.color?.value || DEFAULT_COLOR;
      _petProfiles[pet].emoji = els.emoji?.value || DEFAULT_EMOJI;
    }
    APP_PETS.length = 0;
    petList.forEach(p => APP_PETS.push(p));
    await setDoc(doc(db, 'app_config', 'pet_profiles'), {
      profiles: _petProfiles,
      petList: [...petList]
    });
    modal.remove();
    renderPetAges();
    renderCatFocusPills();
    const { loadJournalSidebar } = await import('./journal.js');
    setJournalDocsCache(null);
    loadJournalSidebar();
    showToast('Pet profiles saved ✓', 'journal');
  };
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  box.appendChild(footer);
  modal.appendChild(box);
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}
window.openPetProfilesModal = openPetProfilesModal;

// ── CAT FOCUS PILLS ──
export function renderCatFocusPills() {
  const bar = document.getElementById('cat-focus-bar');
  if (!bar || !APP_PETS.length) return;
  bar.innerHTML = '';

  const label = document.createElement('span');
  label.style.cssText = 'font-family:\'JetBrains Mono\',monospace;font-size:0.55rem;color:var(--ink-muted);letter-spacing:0.06em;text-transform:uppercase;margin-right:0.2rem;flex-shrink:0;';
  label.textContent = 'Context:';
  bar.appendChild(label);

  const allActive = !_chatFocusCats;

  const allPill = document.createElement('span');
  allPill.textContent = 'All pets';
  allPill.title = 'Include all pets in context';
  pillStyle(allPill, allActive);
  allPill.addEventListener('click', () => { setChatFocusCats(null); invalidateChatContext(); renderCatFocusPills(); });
  bar.appendChild(allPill);

  for (const cat of APP_PETS) {
    const active = !allActive && _chatFocusCats.has(cat);
    const pill = document.createElement('span');
    pill.textContent = cat;
    pill.title = active ? `Remove ${cat} from context` : `Focus on ${cat}`;
    pill.classList.add('cat-pill');
    if (active) {
      const bg = catColor(cat);
      const color = catColorDark(cat);
      pill.style.cssText = `background:${bg};color:${color};border-color:${bg};font-weight:600;`;
    }
    pill.addEventListener('click', () => {
      if (!_chatFocusCats) {
        setChatFocusCats(new Set([cat]));
      } else if (_chatFocusCats.has(cat)) {
        _chatFocusCats.delete(cat);
        if (_chatFocusCats.size === 0) setChatFocusCats(null);
      } else {
        _chatFocusCats.add(cat);
        if (_chatFocusCats.size === APP_PETS.length) setChatFocusCats(null);
      }
      invalidateChatContext();
      renderCatFocusPills();
    });
    bar.appendChild(pill);
  }

  // Context depth toggle
  const depthBtn = document.createElement('button');
  depthBtn.id = 'context-depth-btn';
  depthBtn.style.cssText = 'margin-left:auto;font-family:\'JetBrains Mono\',monospace;font-size:0.55rem;border:1px solid var(--border);border-radius:4px;padding:0.15rem 0.45rem;cursor:pointer;transition:all 0.15s;flex-shrink:0;';
  const updateDepthBtn = () => {
    if (_chatFullContext) {
      depthBtn.textContent = '📚 Full history';
      depthBtn.style.background = 'var(--accent)';
      depthBtn.style.color = 'white';
      depthBtn.style.borderColor = 'var(--accent)';
      depthBtn.title = 'Showing full history — click for recent only (6mo)';
    } else {
      depthBtn.textContent = '📅 Recent';
      depthBtn.style.background = 'var(--surface)';
      depthBtn.style.color = 'var(--ink-muted)';
      depthBtn.style.borderColor = 'var(--border)';
      depthBtn.title = 'Showing recent context (6mo) — click for full history';
    }
  };
  updateDepthBtn();
  depthBtn.addEventListener('click', () => {
    setChatFullContext(!_chatFullContext);
    invalidateChatContext();
    updateDepthBtn();
  });
  bar.appendChild(depthBtn);

  // (The old ⎘ Export button lived here — removed; the Export/Import bar below
  // the chat is the canonical export now.)

  bar.style.display = 'flex';
}

function pillStyle(el, active) {
  el.classList.add('cat-pill');
  el.classList.toggle('active', active);
}
