// ── UI ── Context menu, flags modal, trends modal, chat search, cost modal
import {
  driveAccessToken,
  apiKey,
  _allVisitsCache,
  _allLabsCache,
  labDataCache,
  APP_PETS,
  _petProfiles,
  costWarnThreshold, setCostWarnThreshold,
  costAlertThreshold, setCostAlertThreshold,
  sessionCost,
  allTimeCost,
  ctxTarget, setCtxTarget,
  chatSearchMatches, setChatSearchMatches,
  chatSearchIdx, setChatSearchIdx,
} from './state.js';

import {
  db, doc, getDoc, setDoc, deleteDoc, writeBatch,
  collection, getDocs, query, where, orderBy,
  $, showToast, showAlert, escHtml, invalidateChatContext,
  catEmoji,
} from './core.js';

// ── CONTEXT MENU ──
export function showCtxMenu(e, label, items) {
  e.preventDefault();
  e.stopPropagation();
  setCtxTarget(null);
  const menu = $('ctx-menu');
  const labelEl = $('ctx-label');
  const itemsEl = $('ctx-items');

  labelEl.textContent = label;
  labelEl.style.display = label ? 'block' : 'none';
  itemsEl.innerHTML = '';

  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      itemsEl.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    el.textContent = item.label;
    if (!item.disabled) {
      el.addEventListener('click', () => {
        hideCtxMenu();
        item.action();
      });
    }
    itemsEl.appendChild(el);
  }

  menu.classList.add('open');
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 150;
  let x = e.clientX;
  let y = e.clientY;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

export function hideCtxMenu() {
  $('ctx-menu').classList.remove('open');
  setCtxTarget(null);
}

// ── FLAGS MODAL ──

// Flag type configuration
const FLAG_CONFIG = {
  no_date: {
    label: 'Missing visit date',
    icon: '📅',
    explain: 'Claude could not find a visit date in this document. All records from this file were stored with an unknown date.',
    actionLabel: 'Enter the correct date',
    inputType: 'date',
    inputPlaceholder: '',
    async apply(flag, value) {
      const batch = writeBatch(db);
      let count = 0;
      const vsnap = await getDocs(query(collection(db, 'visits'), where('sourceFileId', '==', flag.fileId)));
      vsnap.forEach(d => { if (!d.data().date || d.data().date === 'unknown') { batch.update(d.ref, { date: value }); count++; } });
      const lsnap = await getDocs(query(collection(db, 'labs'), where('driveFileId', '==', flag.fileId)));
      lsnap.forEach(d => { if (!d.data().resultDate || d.data().resultDate === 'unknown') { batch.update(d.ref, { resultDate: value, visitDate: value }); count++; } });
      await batch.commit();
      return `Updated ${count} record${count !== 1 ? 's' : ''} to date ${value}`;
    }
  },
  no_cats: {
    label: 'Cat not identified',
    icon: '🐱',
    explain: 'Claude could not identify which cat this document belongs to. Records may have been stored under "Unknown".',
    actionLabel: 'Assign to cat',
    inputType: 'select',
    get inputOptions() { return APP_PETS.length ? APP_PETS : ['(no pets loaded yet)']; },
    async apply(flag, value) {
      const batch = writeBatch(db);
      let count = 0;
      const vsnap = await getDocs(query(collection(db, 'visits'), where('sourceFileId', '==', flag.fileId)));
      vsnap.forEach(d => { if (!d.data().cat || d.data().cat === 'Unknown') { batch.update(d.ref, { cat: value }); count++; } });
      const lsnap = await getDocs(query(collection(db, 'labs'), where('driveFileId', '==', flag.fileId)));
      lsnap.forEach(d => { if (!d.data().cat || d.data().cat === 'Unknown') { batch.update(d.ref, { cat: value }); count++; } });
      await batch.commit();
      return `Assigned ${count} record${count !== 1 ? 's' : ''} to ${value}`;
    }
  },
  unknown_type: {
    label: 'Document type unclear',
    icon: '📄',
    explain: 'Claude could not determine what type of document this is.',
    actionLabel: 'Set document type',
    inputType: 'select',
    inputOptions: ['Clinical Note', 'Lab Results', 'Imaging', 'Invoice', 'Vaccination', 'Discharge Summary', 'Referral', 'Other'],
    async apply(flag, value) {
      const batch = writeBatch(db);
      let count = 0;
      const vsnap = await getDocs(query(collection(db, 'visits'), where('sourceFileId', '==', flag.fileId)));
      vsnap.forEach(d => { batch.update(d.ref, { docType: value }); count++; });
      await batch.commit();
      return `Set document type to "${value}" for ${count} record${count !== 1 ? 's' : ''}`;
    }
  },
  chunk_skipped: {
    label: 'Section skipped during processing',
    icon: '⚠',
    explain: 'Part of this file failed to process twice and was skipped. Some records from this file may be incomplete.',
    actionLabel: null,
    async apply() { return null; }
  },
  verify_missing_data: {
    label: 'Missing data found by verify',
    icon: '🔍',
    explain: 'The verify function found clinical data in the source file that is not in the stored records.',
    actionLabel: null,
    async apply() { return null; }
  },
  excel_manual_review: {
    label: 'Excel file — manual review needed',
    icon: '📊',
    explain: 'Excel files cannot be auto-processed. Lab data needs to be entered manually or exported to CSV first.',
    actionLabel: null,
    async apply() { return null; }
  },
  duplicate_visit: {
    label: 'Duplicate visit skipped',
    icon: '⟳',
    explain: 'A visit with the same cat, date, and clinic already exists. The duplicate was not imported.',
    actionLabel: null,
    async apply() { return null; }
  },
  quality_warning: {
    label: 'Quality check warning',
    icon: 'ℹ',
    explain: 'The extraction may be missing some data. Review and reprocess if needed.',
    actionLabel: null,
    async apply() { return null; }
  }
};

export async function openFlagsModal(filterFileId = null) {
  $('flags-modal').classList.add('open');
  $('flags-modal-body').innerHTML = '<div class="sidebar-empty" style="padding:2rem;"><div>Loading…</div></div>';
  try {
    let q = query(collection(db, 'flags'), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    let flags = [];
    snap.forEach(d => flags.push({ id: d.id, ...d.data() }));

    if (filterFileId) {
      flags = [...flags.filter(f => f.fileId === filterFileId), ...flags.filter(f => f.fileId !== filterFileId)];
    }

    if (!flags.length) {
      $('flags-modal-body').innerHTML = '<div class="sidebar-empty" style="padding:2rem;"><div class="sidebar-empty-icon">✓</div><div>No items need review</div></div>';
      $('flags-summary').textContent = '';
      return;
    }

    const unresolved = flags.filter(f => !f.resolved).length;
    $('flags-summary').textContent = `${unresolved} need${unresolved === 1 ? 's' : ''} attention · ${flags.length} total`;
    $('flags-reprocess-btn').style.display = 'none';

    $('flags-modal-body').innerHTML = '';
    for (const flag of flags) {
      const isKnown = !!FLAG_CONFIG[flag.type];
      const config = FLAG_CONFIG[flag.type] || {
        label: flag.type ? `Unknown flag: ${flag.type}` : 'Unknown issue',
        icon: '⚠',
        explain: (flag.description || 'An issue was detected during a previous processing run.') +
                 (!isKnown ? ' You can safely dismiss this if the records look correct, or reprocess the file to re-evaluate.' : ''),
        actionLabel: null,
        async apply() { return null; }
      };

      const el = document.createElement('div');
      el.className = 'flag-item' + (flag.resolved ? ' resolved' : '');

      const header = document.createElement('div');
      header.className = 'flag-item-header';
      header.innerHTML = `
        <span class="flag-filename" title="${escHtml(flag.filename)}">${escHtml(flag.filename)}</span>
        <span class="flag-type ${flag.resolved ? 'resolved' : ''}">${config.icon} ${flag.resolved ? 'resolved' : escHtml(config.label)}</span>`;
      el.appendChild(header);

      const desc = document.createElement('div');
      desc.className = 'flag-desc';
      desc.textContent = config.explain;
      if (flag.bestGuess) desc.textContent += ` Best guess: ${flag.bestGuess}.`;
      el.appendChild(desc);

      const actions = document.createElement('div');
      actions.className = 'flag-actions';
      actions.id = `flag-actions-${flag.id}`;

      if (flag.resolved) {
        actions.innerHTML = `<span class="flag-resolved-note">✓ ${escHtml(flag.resolution || 'Resolved')}</span>`;
      } else {
        if (flag.fileId) {
          const viewLink = document.createElement('a');
          viewLink.className = 'btn-icon';
          viewLink.style.cssText = 'font-size:0.62rem;text-decoration:none;';
          viewLink.href = `https://drive.google.com/file/d/${flag.fileId}/view`;
          viewLink.target = '_blank';
          viewLink.textContent = 'View in Drive ↗';
          actions.appendChild(viewLink);
        }

        if (config.actionLabel) {
          let input;
          if (config.inputType === 'select') {
            input = document.createElement('select');
            input.className = 'flag-input';
            input.style.cursor = 'pointer';
            const defaultOpt = document.createElement('option');
            defaultOpt.value = ''; defaultOpt.textContent = 'Choose…'; defaultOpt.disabled = true; defaultOpt.selected = true;
            input.appendChild(defaultOpt);
            (config.inputOptions || []).forEach(opt => {
              const o = document.createElement('option');
              o.value = opt; o.textContent = opt;
              input.appendChild(o);
            });
          } else {
            input = document.createElement('input');
            input.className = 'flag-input';
            input.type = config.inputType || 'text';
            input.placeholder = config.inputPlaceholder || 'Enter value…';
            if (flag.bestGuess && config.inputType === 'date') input.value = flag.bestGuess;
          }
          actions.appendChild(input);

          const applyBtn = document.createElement('button');
          applyBtn.className = 'btn-icon free-icon';
          applyBtn.style.fontSize = '0.62rem';
          applyBtn.innerHTML = '<span class="free-dot"></span> Apply fix';
          applyBtn.addEventListener('click', async () => {
            const val = input.value?.trim?.() || input.value;
            if (!val) { showToast('Please enter a value first', 'warning'); return; }
            applyBtn.disabled = true;
            applyBtn.textContent = 'Applying…';
            try {
              const resultMsg = await config.apply(flag, val);
              await setDoc(doc(db, 'flags', flag.id), {
                resolved: true,
                resolution: resultMsg || `Set to: ${val}`,
                resolvedValue: val,
                resolvedAt: new Date().toISOString()
              }, { merge: true });
              el.classList.add('resolved');
              actions.innerHTML = `<span class="flag-resolved-note">✓ ${escHtml(resultMsg || 'Fixed')}</span>`;
              el.querySelector('.flag-type').className = 'flag-type resolved';
              el.querySelector('.flag-type').textContent = 'resolved';
              if (window.reloadSidebars) await window.reloadSidebars('all');
              updateFlagSummary();
              await updateFileFlagStatus(flag.fileId);
              showToast(resultMsg || 'Fixed ✓', 'journal');
            } catch(e) {
              applyBtn.disabled = false;
              applyBtn.innerHTML = '<span class="free-dot"></span> Apply fix';
              showAlert('Could not apply fix: ' + e.message, 'warning');
            }
          });
          actions.appendChild(applyBtn);
        }

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'btn-icon free-icon';
        dismissBtn.style.fontSize = '0.62rem';
        dismissBtn.innerHTML = '<span class="free-dot"></span> Mark complete';
        dismissBtn.addEventListener('click', async () => {
          const allFlagsSnap = await getDocs(query(collection(db, 'flags'),
            where('fileId', '==', flag.fileId), where('resolved', '==', false)));
          const batch = writeBatch(db);
          allFlagsSnap.forEach(d => batch.update(d.ref, {
            resolved: true, resolution: 'marked complete', resolvedAt: new Date().toISOString()
          }));
          await batch.commit();
          document.querySelectorAll('.flag-item').forEach(flagEl => {
            const flagActions = flagEl.querySelector('.flag-actions');
            if (flagActions && flagEl.querySelector('.flag-filename')?.title === flag.filename) {
              flagEl.classList.add('resolved');
              flagEl.querySelector('.flag-type').className = 'flag-type resolved';
              flagEl.querySelector('.flag-type').textContent = 'resolved';
              flagActions.innerHTML = `<span class="flag-resolved-note">✓ marked complete</span>`;
            }
          });
          el.classList.add('resolved');
          actions.innerHTML = `<span class="flag-resolved-note">✓ marked complete</span>`;
          el.querySelector('.flag-type').className = 'flag-type resolved';
          el.querySelector('.flag-type').textContent = 'resolved';
          updateFlagSummary();
          await updateFileFlagStatus(flag.fileId);
          showToast('Marked complete ✓', 'journal');
        });
        actions.appendChild(dismissBtn);

        const REPROCESS_FLAG_TYPES = ['chunk_skipped', 'verify_missing_data', 'quality_warning'];
        if ((REPROCESS_FLAG_TYPES.includes(flag.type) || !isKnown) && flag.fileId) {
          const reprocessBtn = document.createElement('button');
          reprocessBtn.className = 'btn-icon cost-icon';
          reprocessBtn.style.fontSize = '0.62rem';
          reprocessBtn.innerHTML = '<span class="cost-dot"></span> Reprocess';
          reprocessBtn.addEventListener('click', async () => {
            if (!apiKey) { showToast('Set your API key first', 'warning'); return; }
            if (!driveAccessToken) { showToast('Connect Drive first — go to Files tab', 'warning'); return; }
            reprocessBtn.disabled = true;
            reprocessBtn.textContent = 'Starting…';
            $('flags-modal').classList.remove('open');
            const fileObj = { id: flag.fileId, name: flag.filename, mimeType: '' };
            try {
              const [vsnap, lsnap, fsnap] = await Promise.all([
                getDocs(query(collection(db, 'visits'), where('driveFileIds', 'array-contains', flag.fileId))),
                getDocs(query(collection(db, 'labs'), where('driveFileId', '==', flag.fileId))),
                getDocs(query(collection(db, 'flags'), where('fileId', '==', flag.fileId)))
              ]);
              for (const d of vsnap.docs) await deleteDoc(d.ref);
              for (const d of lsnap.docs) await deleteDoc(d.ref);
              for (const d of fsnap.docs) await deleteDoc(d.ref);
              const filesMod = await import('./files.js');
              await filesMod.writeFileStatus(flag.fileId, flag.filename, 'unprocessed');
              filesMod.updateFileBadge(flag.fileId, 'unprocessed');
              await filesMod.startProcessingQueue([fileObj]);
            } catch(e) {
              showAlert('Reprocess failed: ' + e.message, 'warning');
            }
          });
          actions.appendChild(reprocessBtn);
        }
      }

      el.appendChild(actions);
      $('flags-modal-body').appendChild(el);
    }
  } catch(e) {
    $('flags-modal-body').innerHTML = `<div style="padding:1rem;font-family:JetBrains Mono,monospace;font-size:0.7rem;color:var(--red);">Error loading flags: ${escHtml(e.message)}</div>`;
  }
}

export function updateFlagSummary() {
  const items = $('flags-modal-body').querySelectorAll('.flag-item');
  const remaining = $('flags-modal-body').querySelectorAll('.flag-item:not(.resolved)').length;
  $('flags-summary').textContent = remaining
    ? `${remaining} need${remaining === 1 ? 's' : ''} attention · ${items.length} total`
    : `All resolved · ${items.length} total`;
  const btn = $('flags-btn');
  if (remaining === 0) {
    $('flags-count').textContent = '0';
    if (btn) btn.style.display = 'none';
  } else {
    $('flags-count').textContent = remaining;
  }
}

async function updateFileFlagStatus(fileId) {
  if (!fileId) return;
  try {
    const snap = await getDocs(query(collection(db, 'flags'),
      where('fileId', '==', fileId), where('resolved', '==', false)));
    if (snap.empty) {
      await setDoc(doc(db, 'files', fileId), { status: 'complete' }, { merge: true });
      const badge = $(`badge-${fileId}`);
      if (badge) { badge.className = 'file-status-badge complete'; badge.textContent = 'complete'; }
      const item = document.querySelector(`[data-file-id="${fileId}"]`);
      if (item) item.dataset.status = 'complete';
    }
  } catch(e) { console.warn('Could not update file flag status:', e); }
}

// ── CHAT SEARCH ──
export function runChatSearch() {
  clearChatSearchHighlights();
  const term = $('chat-search-input').value.trim();
  if (!term) { $('chat-search-count').textContent = ''; setChatSearchMatches([]); return; }
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re = new RegExp(esc,'gi');
  const matches = [];
  let idx = 0;
  document.querySelectorAll('.msg-bubble').forEach(bubble => {
    const raw = bubble.dataset.raw || bubble.textContent;
    bubble.dataset.raw = raw;
    if (!re.test(raw)) return;
    re.lastIndex = 0;
    const parts = raw.split(re);
    const ms = [...raw.matchAll(re)];
    let html = '', mi = 0;
    for (const p of parts) {
      html += escHtml(p);
      if (mi < ms.length) { html += `<mark class="sh" data-match="${matches.length+mi}">${escHtml(ms[mi][0])}</mark>`; mi++; }
    }
    bubble.innerHTML = html;
    bubble.querySelectorAll('mark.sh').forEach(m => matches.push(m));
  });
  setChatSearchMatches(matches);
  setChatSearchIdx(0);
  if (matches.length) {
    matches[0].classList.add('current');
    matches[0].scrollIntoView({ block:'center' });
  }
  $('chat-search-count').textContent = matches.length ? `1/${matches.length}` : '0';
}

export function navigateChatSearch(dir) {
  if (!chatSearchMatches.length) return;
  chatSearchMatches[chatSearchIdx].classList.remove('current');
  const newIdx = (chatSearchIdx + dir + chatSearchMatches.length) % chatSearchMatches.length;
  setChatSearchIdx(newIdx);
  chatSearchMatches[newIdx].classList.add('current');
  chatSearchMatches[newIdx].scrollIntoView({ block:'center' });
  $('chat-search-count').textContent = `${newIdx+1}/${chatSearchMatches.length}`;
}

export function clearChatSearchHighlights() {
  document.querySelectorAll('.msg-bubble').forEach(b => {
    if (b.dataset.raw) { b.textContent = b.dataset.raw; delete b.dataset.raw; }
  });
  setChatSearchMatches([]);
  setChatSearchIdx(0);
}

export function clearChatSearch() {
  $('chat-search-input').value = '';
  clearChatSearchHighlights();
  $('chat-search-count').textContent = '';
}

// ── TRENDS MODAL ──
export async function openTrendsModal() {
  $('trends-modal').style.display = 'flex';
  const sel = $('trends-cat-select');
  sel.innerHTML = '';
  const cats = APP_PETS.length ? APP_PETS : Object.keys(labDataCache);
  cats.forEach(c => {
    const o = document.createElement('option'); o.value = c; o.textContent = catEmoji(c) + ' ' + c;
    sel.appendChild(o);
  });
  sel.onchange = () => renderTrends(sel.value);
  renderTrends(cats[0] || '');
}

export async function renderTrends(cat) {
  const body = $('trends-body');
  body.innerHTML = '<div style="font-family:\'JetBrains Mono\',monospace;font-size:0.68rem;color:var(--ink-muted);padding:1rem;">Loading…</div>';

  try {
    let visits;
    if (_allVisitsCache) {
      visits = _allVisitsCache.filter(v => v.cat === cat);
    } else {
      const snap = await getDocs(query(collection(db, 'visits'), where('cat', '==', cat)));
      visits = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    }

    const points = visits
      .filter(v => v.date && v.vitals && v.docType !== 'Invoice')
      .map(v => ({
        date: v.date,
        visitId: v.id,
        weight: window.parseKgFromWeight ? window.parseKgFromWeight(v.vitals?.weight, window.isCatKitten ? window.isCatKitten(v.cat, v.date) : false) : null,
        bcs: window.parseBCS ? window.parseBCS(v.vitals?.BCS) : null,
        mcs: window.parseMCS ? window.parseMCS(v.vitals?.muscleConditionScore) : null,
        rawWeight: v.vitals?.weight || '',
        rawBCS: v.vitals?.BCS || '',
        rawMCS: v.vitals?.muscleConditionScore || '',
        source: v.source === 'home' ? 'home' : 'vet',
        label: v.source === 'home' ? (v.chiefComplaint || 'Home') : (window.abbreviateClinic ? window.abbreviateClinic(v.clinic || '') : (v.clinic || 'Visit')),
      }))
      .filter(p => p.weight || p.bcs || p.mcs)
      .sort((a, b) => a.date.localeCompare(b.date));

    body.innerHTML = '';

    if (!points.length) {
      body.innerHTML = '<div style="font-family:\'JetBrains Mono\',monospace;font-size:0.68rem;color:var(--ink-muted);padding:1rem;">No weight/BCS data found for ' + escHtml(cat) + '</div>';
      return;
    }

    // Simple table/chart rendering
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-family:\'JetBrains Mono\',monospace;font-size:0.65rem;';
    table.innerHTML = `<thead><tr style="border-bottom:1px solid var(--border);">
      <th style="padding:0.4rem;text-align:left;color:var(--ink-muted);">Date</th>
      <th style="padding:0.4rem;text-align:left;color:var(--ink-muted);">Source</th>
      <th style="padding:0.4rem;text-align:right;color:var(--ink-muted);">Weight</th>
      <th style="padding:0.4rem;text-align:right;color:var(--ink-muted);">BCS</th>
      <th style="padding:0.4rem;text-align:right;color:var(--ink-muted);">MCS</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const p of points) {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--surface2)';
      tr.innerHTML = `
        <td style="padding:0.4rem;">${escHtml(p.date)}</td>
        <td style="padding:0.4rem;color:var(--ink-muted);">${escHtml(p.label)}</td>
        <td style="padding:0.4rem;text-align:right;">${p.rawWeight ? escHtml(p.rawWeight) : '—'}</td>
        <td style="padding:0.4rem;text-align:right;">${p.rawBCS ? escHtml(p.rawBCS) : '—'}</td>
        <td style="padding:0.4rem;text-align:right;">${p.rawMCS ? escHtml(p.rawMCS) : '—'}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  } catch(e) {
    body.innerHTML = `<div style="padding:1rem;color:var(--red);font-family:JetBrains Mono,monospace;font-size:0.68rem;">Error: ${escHtml(e.message)}</div>`;
  }
}

// ── COST MODAL / SETTINGS ──
export function saveCostSettings() {
  try {
    localStorage.setItem('pr_cost_settings', JSON.stringify({
      warn: costWarnThreshold,
      alert: costAlertThreshold,
      allTime: allTimeCost
    }));
  } catch(e) {}
}

export function openCostModal() {
  $('cost-warn-input').value = costWarnThreshold;
  $('cost-alert-input').value = costAlertThreshold;
  $('cost-modal-total').textContent = `$${sessionCost.toFixed(4)}`;
  $('cost-modal-alltime').textContent = `$${allTimeCost.toFixed(4)}`;
  $('cost-modal').classList.add('open');
}

// ── LAB DETAIL POPUP ──
export function openLabDetail(entry, test, displayVal, abn) {
  const popup = document.getElementById('lab-detail-popup');
  document.getElementById('lab-detail-test').textContent = test;
  const valEl = document.getElementById('lab-detail-value');
  valEl.textContent = displayVal + (entry.unit ? ' ' + entry.unit : '');
  valEl.style.color = abn === 'HIGH' ? '#b91c1c' : abn === 'LOW' ? '#1d4ed8' : 'var(--ink)';
  document.getElementById('lab-detail-unit').textContent = abn && abn !== 'NEG' && abn !== 'NEGATIVE' ? '⚠ ' + abn : '';
  document.getElementById('lab-detail-ref').textContent = entry.refLow != null && entry.refHigh != null ? 'Ref: ' + entry.refLow + '–' + entry.refHigh : '';
  document.getElementById('lab-detail-date').textContent = entry.resultDate || entry.visitDate || '';
  const footer = document.getElementById('lab-detail-footer');
  footer.innerHTML = entry.driveFileId
    ? `<a href="https://drive.google.com/file/d/${entry.driveFileId}/view" target="_blank" title="${escHtml(entry.sourceFile || entry.driveFileId)}" style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--accent);text-decoration:none;">↗ Open original in Drive</a>`
    : `<span style="font-size:0.65rem;color:var(--ink-muted);">${entry.sourceFile || ''}</span>`;
  popup.style.display = 'flex';
}

// Expose globally for inline onclick handlers
window.showCtxMenu = showCtxMenu;
window.hideCtxMenu = hideCtxMenu;
window.openFlagsModal = openFlagsModal;
window.openLabDetail = openLabDetail;
window.openTrendsModal = openTrendsModal;
window.openCostModal = openCostModal;
window._openFlagsModal = openFlagsModal;
