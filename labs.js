// ── LABS MODULE ──
// Labs sidebar, flowsheet modal, lab group manager, lab context menu.

import {
  _allLabsCache, setAllLabsCache,
  labDataCache,
  flowsheetCat, setFlowsheetCat,
  _labsSidebarDirty, setLabsSidebarDirty,
  _labsSidebarDebounce, setLabsSidebarDebounce,
  _flowsheetSearchMatches, setFlowsheetSearchMatches,
  _flowsheetSearchIdx, setFlowsheetSearchIdx,
  _flowsheetFilterMode, setFlowsheetFilterMode,
  _labGroups, setLabGroups,
  _labCorrections, setLabCorrections,
} from './state.js';

import {
  db, doc, getDoc, setDoc, deleteDoc, writeBatch, collection, getDocs, query, where, orderBy,
  $, showToast, showAlert, escHtml, formatDateShort,
  catEmoji, invalidateChatContext,
} from './core.js';

// ── LABS SIDEBAR ──

function invalidateFlowsheetCache() {} // no-op

export function invalidateLabsCache() { setAllLabsCache(null); invalidateChatContext(); setLabsSidebarDirty(true); }

export async function loadLabsSidebar() {
  if (_labsSidebarDebounce) clearTimeout(_labsSidebarDebounce);
  return new Promise(resolve => {
    setLabsSidebarDebounce(setTimeout(async () => {
      setLabsSidebarDebounce(null);
      try {
        const cacheWasNull = !_allLabsCache;
        if (!_allLabsCache) {
          const snap = await getDocs(query(collection(db, 'labs'), orderBy('resultDate', 'desc')));
          setAllLabsCache(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }
        if (!_labsSidebarDirty && !cacheWasNull) { resolve(); return; }
        // Reset labDataCache in-place
        Object.keys(labDataCache).forEach(k => delete labDataCache[k]);
        invalidateFlowsheetCache();
        _allLabsCache.forEach(l => {
          if (!l.cat || !l.test) return;
          if (!labDataCache[l.cat]) labDataCache[l.cat] = [];
          labDataCache[l.cat].push(l);
        });
        renderLabsSidebar();
        setLabsSidebarDirty(false);
      } catch (err) { console.error('Labs load error:', err); }
      resolve();
    }, 400));
  });
}

export function inferLabGroup(test) {
  const t = (test || '').toLowerCase();
  if (t.includes('systolic') || t.includes('diastolic') || t.includes('blood pressure')) return null;
  if (['felv','fiv','giardia','clostridium','tritrichomonas','cryptosporidium',
       'campylobacter','toxoplasma','bartonella','pcr','culture','titer'].some(k => t.includes(k))) return 'PCR';
  if (['hematocrit','hemoglobin','platelets','neutrophils','lymphocytes',
       'monocytes','eosinophils','basophils','reticulocytes'].some(k => t.includes(k))) return 'CBC';
  if (['specific gravity','usg','urobilinogen','epithelial','cast','crystal'].some(k => t.includes(k))) return 'Urinalysis';
  if (['sediment','rbc urine','wbc urine'].some(k => t.includes(k))) return 'Sediment';
  return null;
}

export function makeLabRow(test, e, targetContainer, onClick) {
  const row = document.createElement('div');
  row.className = 'lab-summary-row';
  const abn = String(e.abnormal||'').toUpperCase();
  const valClass = abn === 'HIGH' ? 'high' : abn === 'LOW' ? 'low' : (abn === 'NEG' || abn === 'NEGATIVE') ? 'neg' : 'normal';
  const displayVal = typeof e.value === 'number'
    ? (e.value % 1 === 0 ? e.value.toString() : e.value < 0.1 ? e.value.toFixed(3) : e.value < 10 ? e.value.toFixed(2) : e.value.toFixed(1))
    : String(e.value || '');
  row.innerHTML = `
    <span class="lab-test-name" title="${escHtml(test)}">${escHtml(test)}</span>
    <span class="lab-val ${valClass}">${escHtml(displayVal)}${e.unit ? ' <span style="font-weight:400;font-size:0.6rem;color:var(--ink-muted)">' + escHtml(e.unit) + '</span>' : ''}</span>
    <span class="lab-date">${formatDateShort(e.resultDate)}</span>
    <button class="lab-group-edit-btn" title="Change group">✏</button>`;
  row.title = (e.refLow != null ? `Ref: ${e.refLow}–${e.refHigh != null ? e.refHigh : ''}` : '') + (abn && abn !== 'NEG' && abn !== 'NEGATIVE' ? ` ⚠ ${abn}` : '');
  row.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
  row.querySelector('.lab-group-edit-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    showLabGroupPicker(e, ev.currentTarget);
  });
  attachLabCtxMenu(row, e, flowsheetCat);
  targetContainer.appendChild(row);
  return row;
}

export function renderLabsSidebar() {
  const container = $('labs-tree');
  const empty = $('labs-empty');
  const cats = Object.keys(labDataCache);
  if (!cats.length) { empty.style.display = 'flex'; container.innerHTML = ''; return; }
  empty.style.display = 'none';
  container.innerHTML = '';
  if (!flowsheetCat || !labDataCache[flowsheetCat]) setFlowsheetCat(cats.sort()[0]);

  const controls = document.createElement('div');
  controls.style.cssText = 'padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:2;';
  const sel = document.createElement('select');
  sel.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:0.68rem;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:0.3rem 0.5rem;color:var(--ink);outline:none;cursor:pointer;width:100%;';
  cats.sort().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat; opt.textContent = catEmoji(cat) + ' ' + cat;
    if (cat === flowsheetCat) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => { setFlowsheetCat(sel.value); renderLabsSidebar(); });
  controls.appendChild(sel);

  const flowsheetRow = document.createElement('div');
  flowsheetRow.style.cssText = 'display:flex;align-items:center;gap:0.4rem;margin-top:0.35rem;';
  const fsLink = document.createElement('button');
  fsLink.style.cssText = 'background:none;border:none;cursor:pointer;font-family:JetBrains Mono,monospace;font-size:0.58rem;color:var(--accent);padding:0;letter-spacing:0.02em;text-decoration:underline;flex:1;text-align:left;';
  fsLink.textContent = '↗ View Full Flowsheet';
  fsLink.addEventListener('click', () => openFlowsheetModal(flowsheetCat, null));
  flowsheetRow.appendChild(fsLink);
  const mgBtn = document.createElement('button');
  mgBtn.className = 'btn-icon';
  mgBtn.style.cssText = 'font-size:0.58rem;padding:0.15rem 0.4rem;flex-shrink:0;';
  mgBtn.title = 'Manage Groups & Duplicates';
  mgBtn.textContent = '⚙';
  mgBtn.addEventListener('click', openLabGroupManager);
  flowsheetRow.appendChild(mgBtn);
  controls.appendChild(flowsheetRow);
  container.appendChild(controls);

  const entries = labDataCache[flowsheetCat] || [];
  if (!entries.length) {
    const empty2 = document.createElement('div');
    empty2.className = 'sidebar-empty';
    empty2.innerHTML = '<div class="sidebar-empty-icon">🧪</div><div>No labs for ' + flowsheetCat + '</div>';
    container.appendChild(empty2);
    return;
  }

  const latest = {};
  const SUBGROUP_OF = { 'sediment': 'urinalysis', 'urine sediment': 'urinalysis' };
  const normalizeGroup = (raw) => (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');

  for (const e of entries) {
    const g = normalizeGroup(e.labGroup || inferLabGroup(e.test, e.labName) || 'Other');
    const key = (e.test || '').trim().toLowerCase() + '||' + g;
    if (!latest[key] || (e.resultDate||'') > (latest[key].resultDate||'')) latest[key] = e;
  }
  const allRowKeys = Object.keys(latest);

  const GROUP_ORDER = _labGroups.length ? _labGroups : ['CBC', 'Chemistry', 'Urinalysis', 'Endocrinology', 'PCR', 'Imaging', 'Other'];
  const byGroup = {};
  for (const key of allRowKeys) {
    const e = latest[key];
    const g = normalizeGroup(e.labGroup || inferLabGroup(e.test, e.labName) || 'Other');
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(key);
  }

  const GROUP_ORDER_NORM_SB = GROUP_ORDER.map(g => g.trim().toLowerCase().replace(/\s+/g, ' '));
  const sbGroupDisplay = {};
  for (const [normKey] of Object.entries(byGroup)) {
    const match = GROUP_ORDER.find(g => g.trim().toLowerCase().replace(/\s+/g, ' ') === normKey);
    const sampleEntry = latest[byGroup[normKey]?.[0]];
    sbGroupDisplay[normKey] = match || (sampleEntry?.labGroup?.trim()) || normKey;
  }
  const orderedGroups = [
    ...GROUP_ORDER_NORM_SB.filter(g => byGroup[g]),
    ...Object.keys(byGroup).filter(g => !GROUP_ORDER_NORM_SB.includes(g)).sort()
  ];

  const finalGroups = [];
  for (const g of orderedGroups) {
    if (SUBGROUP_OF[g]) continue;
    finalGroups.push(g);
    orderedGroups.filter(sg => SUBGROUP_OF[sg] === g).forEach(sg => finalGroups.push(sg));
  }

  for (const group of finalGroups) {
    const keysInGroup = byGroup[group];
    const _seenSK = new Set();
    const ordered = keysInGroup.slice().sort((a, b) => {
      const na = (latest[a]?.labName || '').toLowerCase();
      const nb = (latest[b]?.labName || '').toLowerCase();
      if (na < nb) return -1; if (na > nb) return 1;
      return a.split('||')[0].localeCompare(b.split('||')[0]);
    }).filter(k => { if (_seenSK.has(k)) return false; _seenSK.add(k); return true; });

    const isSubgroup = !!SUBGROUP_OF[group];
    const displayName = sbGroupDisplay[group] || group;

    // Build group section
    const sec = document.createElement('div');
    sec.className = 'lab-group-section';
    if (isSubgroup) sec.style.marginLeft = '0.75rem';

    const hdr = document.createElement('div');
    hdr.className = 'lab-group-header';
    const arrow = document.createElement('span');
    arrow.textContent = '▶';
    arrow.style.cssText = 'font-size:0.45rem;color:var(--ink-muted);transition:transform 0.15s;flex-shrink:0;';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = displayName;

    const body = document.createElement('div');
    body.className = 'lab-group-body';
    arrow.style.transform = 'rotate(90deg)'; // open by default

    hdr.appendChild(arrow);
    hdr.appendChild(titleSpan);
    hdr.addEventListener('click', () => {
      const open = body.classList.toggle('open') || body.style.display !== 'none';
      body.style.display = open ? '' : 'none';
      arrow.style.transform = open ? 'rotate(90deg)' : '';
    });
    body.style.display = '';

    for (const key of ordered) {
      const e = latest[key];
      const test = e.test; // use original casing from the entry, not the normalized key
      makeLabRow(test, e, body, () => openLabDetail(e, test,
        typeof e.value === 'number'
          ? (e.value % 1 === 0 ? e.value.toString() : e.value < 0.1 ? e.value.toFixed(3) : e.value < 10 ? e.value.toFixed(2) : e.value.toFixed(1))
          : String(e.value || ''),
        String(e.abnormal||'').toUpperCase()
      ));
    }

    sec.appendChild(hdr);
    sec.appendChild(body);
    container.appendChild(sec);
  }
}

// ── FLOWSHEET MODAL ──

export function openFlowsheetModal(cat, focusTest) {
  setFlowsheetCat(cat || flowsheetCat || Object.keys(labDataCache).sort()[0]);
  const sel = $('flowsheet-modal-cat');
  sel.innerHTML = '';
  Object.keys(labDataCache).sort().forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = catEmoji(c) + ' ' + c;
    if (c === flowsheetCat) opt.selected = true;
    sel.appendChild(opt);
  });
  $('flowsheet-modal-title').textContent = flowsheetCat + ' — Lab Results';
  const body = $('flowsheet-modal-body');
  body.innerHTML = '';
  setFlowsheetFilterMode(false);
  const { wrap, dates } = buildFlowsheetTable(flowsheetCat, body) || {};
  $('flowsheet-modal').classList.add('open');

  const searchInput = $('flowsheet-search');
  const searchCount = $('flowsheet-search-count');
  searchInput.value = '';
  searchCount.textContent = '';
  initFlowsheetSearch(body);

  if (focusTest) {
    requestAnimationFrame(() => {
      runFlowsheetSearch(body, focusTest, 0);
      const rows = body.querySelectorAll('tr');
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')];
        const nameCell = cells[cells.length - 1];
        if (nameCell && nameCell.textContent.toLowerCase().includes(focusTest.toLowerCase())) {
          let focusCell = null;
          for (let i = cells.length - 2; i >= 0; i--) {
            if (cells[i].textContent && cells[i].textContent !== '—') {
              focusCell = cells[i];
              break;
            }
          }
          if (focusCell) focusCell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          break;
        }
      }
    });
  } else {
    requestAnimationFrame(() => {
      body.scrollLeft = body.scrollWidth;
      searchInput.focus();
    });
  }
}

export function buildFlowsheetTable(cat, container) {
  const entries = labDataCache[cat] || [];
  if (!entries.length) {
    container.innerHTML = '<div style="padding:1.5rem;font-family:JetBrains Mono,monospace;font-size:0.7rem;color:var(--ink-muted);text-align:center;">No lab data for ' + cat + '</div>';
    return;
  }
  const dates = [...new Set(entries.map(e => e.resultDate||e.visitDate||'').filter(Boolean))].sort();
  const normalizeGroup = g => (g || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const rowKeyOf = e => {
    const g = e.labGroup || inferLabGroup(e.test, e.labName) || 'Other';
    return (e.test || '').trim().toLowerCase() + '||' + normalizeGroup(g);
  };
  const allRowKeys = [...new Set(entries.map(rowKeyOf))];
  const lookup = {};
  for (const e of entries) {
    const key = rowKeyOf(e);
    if (!lookup[key]) lookup[key] = {};
    const d = e.resultDate || e.visitDate || '';
    if (!lookup[key][d] || (e.resultDate||'') >= (lookup[key][d].resultDate||'')) lookup[key][d] = e;
  }
  const orderedRowKeys = allRowKeys.slice().sort((a, b) => {
    const ea = Object.values(lookup[a])[0];
    const eb = Object.values(lookup[b])[0];
    const na = (ea?.labName || '').toLowerCase();
    const nb = (eb?.labName || '').toLowerCase();
    if (na < nb) return -1; if (na > nb) return 1;
    return a.split('||')[0].localeCompare(b.split('||')[0]);
  });

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;min-width:100%;';
  wrap.id = 'flowsheet-wrap-' + cat.replace(/\s+/g,'_');
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:separate;border-spacing:0;font-family:JetBrains Mono,monospace;font-size:0.65rem;white-space:nowrap;min-width:100%;';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  const thTest = document.createElement('th');
  thTest.textContent = 'Test';
  thTest.style.cssText = 'background:var(--surface);color:var(--ink-dim);padding:0.35rem 0.6rem;text-align:left;border:1px solid var(--border);border-left:none;font-weight:500;position:sticky;right:0;top:0;z-index:4;';
  for (const date of dates) {
    const th = document.createElement('th');
    const d = new Date(date + 'T12:00:00');
    th.textContent = (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0') + '/' + d.getFullYear().toString().slice(2);
    th.title = date + ' (right-click to delete all labs on this date)';
    th.style.cssText = 'background:var(--surface);color:var(--ink-dim);padding:0.35rem 0.6rem;text-align:center;border:1px solid var(--border);border-right:none;font-weight:500;position:sticky;top:0;z-index:2;min-width:72px;cursor:context-menu;';
    th.addEventListener('contextmenu', e => {
      import('./ui.js').then(m => m.showCtxMenu(e, `${cat} · ${th.textContent}`, [
        { label: '🗑 Delete all labs on this date', danger: true, action: () => confirmDeleteLabsByDate(date, cat) }
      ]));
    });
    hrow.appendChild(th);
  }
  hrow.appendChild(thTest);
  thead.appendChild(hrow);
  table.appendChild(thead);

  const GROUP_ORDER = _labGroups.length ? _labGroups : ['CBC', 'Chemistry', 'Urinalysis', 'Endocrinology', 'PCR', 'Imaging', 'Other'];
  const GROUP_ORDER_NORM = GROUP_ORDER.map(g => normalizeGroup(g));
  const byGroup = {};
  const groupDisplayName = {};
  for (const rowKey of orderedRowKeys) {
    const mostRecent = Object.values(lookup[rowKey]).sort((a,b)=>(b.resultDate||'')>(a.resultDate||'')?1:-1)[0];
    const rawG = mostRecent?.labGroup || inferLabGroup(mostRecent?.test, mostRecent?.labName) || 'Other';
    const normG = normalizeGroup(rawG);
    if (!byGroup[normG]) byGroup[normG] = [];
    byGroup[normG].push(rowKey);
    if (!groupDisplayName[normG]) {
      const ordered = GROUP_ORDER.find(g => normalizeGroup(g) === normG);
      groupDisplayName[normG] = ordered || rawG.trim();
    }
  }
  const orderedGroups = [
    ...GROUP_ORDER_NORM.filter(g => byGroup[g]),
    ...Object.keys(byGroup).filter(g => !GROUP_ORDER_NORM.includes(g)).sort()
  ];

  const tbody = document.createElement('tbody');
  for (const group of orderedGroups) {
    const sepRow = document.createElement('tr');
    const sepTd = document.createElement('td');
    sepTd.colSpan = dates.length + 1;
    sepTd.textContent = groupDisplayName[group] || group;
    sepTd.style.cssText = 'background:var(--surface2);color:var(--ink-muted);font-family:JetBrains Mono,monospace;font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;padding:0.25rem 0.6rem;border:1px solid var(--border);border-top:none;';
    sepRow.appendChild(sepTd);
    tbody.appendChild(sepRow);

    for (const rowKey of byGroup[group]) {
      const mostRecentEntry = Object.values(lookup[rowKey]).sort((a,b)=>(b.resultDate||'')>(a.resultDate||'')?1:-1)[0];
      const test = mostRecentEntry?.test || rowKey.split('||')[0];
      const row = document.createElement('tr');
      row.addEventListener('mouseenter', () => {
        row.querySelectorAll('td').forEach(td => {
          td._origBg = td.style.background || '';
          td.style.background = 'rgba(124,111,91,0.12)';
        });
      });
      row.addEventListener('mouseleave', () => {
        row.querySelectorAll('td').forEach(td => { td.style.background = td._origBg || ''; });
      });
      const tdName = document.createElement('td');
      tdName.textContent = test;
      tdName.style.cssText = 'text-align:left;color:var(--ink-dim);background:var(--surface);position:sticky;right:0;z-index:1;font-weight:500;padding:0.3rem 0.6rem;border:1px solid var(--border);border-left:none;border-top:none;';
      for (const date of dates) {
        const td = document.createElement('td');
        td.style.cssText = 'padding:0.3rem 0.6rem;border:1px solid var(--border);border-right:none;border-top:none;text-align:center;color:var(--ink);cursor:pointer;';
        const entry = lookup[rowKey]?.[date];
        if (!entry) {
          td.textContent = '—';
          td.style.color = 'var(--border)';
        } else {
          const abn = (() => {
            const stored = String(entry.abnormal||'').toUpperCase();
            if (stored) return stored;
            if (typeof entry.value === 'number' && entry.refLow != null && entry.refHigh != null) {
              if (entry.value > entry.refHigh) return 'HIGH';
              if (entry.value < entry.refLow) return 'LOW';
            }
            return '';
          })();
          const displayVal = typeof entry.value === 'number'
            ? (entry.value % 1 === 0 ? entry.value.toString() : entry.value < 0.1 ? entry.value.toFixed(3) : entry.value < 10 ? entry.value.toFixed(2) : entry.value.toFixed(1))
            : String(entry.value || '');
          td.textContent = displayVal;
          if (abn === 'HIGH') td.style.cssText += 'color:#b91c1c;background:#fee2e2;font-weight:600;border-radius:3px;';
          else if (abn === 'LOW') td.style.cssText += 'color:#1d4ed8;background:#dbeafe;font-weight:600;border-radius:3px;';
          else if (abn === 'NEG' || abn === 'NEGATIVE') td.style.color = 'var(--ink-muted)';
          let tooltip = test;
          if (entry.unit) tooltip += ' (' + entry.unit + ')';
          if (entry.refLow != null && entry.refHigh != null) tooltip += '\nRef: ' + entry.refLow + '–' + entry.refHigh;
          if (abn && abn !== 'NEG' && abn !== 'NEGATIVE') tooltip += '\n⚠ ' + abn;
          td.title = tooltip;
          td.addEventListener('click', () => openLabDetail(entry, test, displayVal, abn));
          attachLabCtxMenu(td, entry, cat);
        }
        row.appendChild(td);
      }
      row.appendChild(tdName);
      tbody.appendChild(row);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
  return { wrap, dates };
}

// ── FLOWSHEET SEARCH ──

function initFlowsheetSearch(body) {
  const input = $('flowsheet-search');
  const count = $('flowsheet-search-count');
  const prevBtn = $('flowsheet-search-prev');
  const nextBtn = $('flowsheet-search-next');
  const modeBtn = $('flowsheet-search-mode');

  const newInput = input.cloneNode(true);
  input.parentNode.replaceChild(newInput, input);
  const newPrev = prevBtn.cloneNode(true);
  prevBtn.parentNode.replaceChild(newPrev, prevBtn);
  const newNext = nextBtn.cloneNode(true);
  nextBtn.parentNode.replaceChild(newNext, nextBtn);

  const syncModeBtn = () => {
    modeBtn.textContent = _flowsheetFilterMode ? 'Search' : 'Filter';
    modeBtn.style.color = _flowsheetFilterMode ? 'var(--accent)' : 'var(--ink-muted)';
    modeBtn.style.borderColor = _flowsheetFilterMode ? 'var(--accent)' : 'var(--border)';
    newInput.placeholder = _flowsheetFilterMode ? 'Filter test…' : 'Search test…';
    newPrev.style.display = _flowsheetFilterMode ? 'none' : '';
    newNext.style.display = _flowsheetFilterMode ? 'none' : '';
  };
  syncModeBtn();

  modeBtn.onclick = () => {
    setFlowsheetFilterMode(!_flowsheetFilterMode);
    syncModeBtn();
    runFlowsheetSearch(body, newInput.value, 0);
  };

  newInput.addEventListener('input', () => runFlowsheetSearch(body, newInput.value, 0));
  newInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); navigateFlowsheetSearch(body, 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); navigateFlowsheetSearch(body, -1); }
    if (e.key === 'Escape') { newInput.value = ''; runFlowsheetSearch(body, '', 0); }
  });
  newPrev.addEventListener('click', () => navigateFlowsheetSearch(body, -1));
  newNext.addEventListener('click', () => navigateFlowsheetSearch(body, 1));
}

function runFlowsheetSearch(body, query, startIdx) {
  const count = $('flowsheet-search-count');
  setFlowsheetSearchMatches([]);

  body.querySelectorAll('td[data-search-match]').forEach(td => {
    td.removeAttribute('data-search-match');
    td.style.outline = '';
  });
  body.querySelectorAll('tr[data-search-hidden]').forEach(row => {
    row.removeAttribute('data-search-hidden');
    row.style.display = '';
  });

  if (!query.trim()) { count.textContent = ''; return; }
  const q = query.toLowerCase();
  const matches = [];

  if (_flowsheetFilterMode) {
    const matchingGroups = new Set();
    body.querySelectorAll('tbody tr').forEach(row => {
      const nameCell = row.querySelector('td:last-child');
      const isGroupRow = row.querySelector('td[colspan]');
      if (isGroupRow) return;
      if (nameCell && nameCell.textContent.toLowerCase().includes(q)) {
        matches.push(row);
        let prev = row.previousElementSibling;
        while (prev) {
          if (prev.querySelector('td[colspan]')) { matchingGroups.add(prev); break; }
          prev = prev.previousElementSibling;
        }
      } else {
        row.setAttribute('data-search-hidden', '1');
        row.style.display = 'none';
      }
    });
    body.querySelectorAll('tbody tr').forEach(row => {
      const isGroupRow = row.querySelector('td[colspan]');
      if (isGroupRow && !matchingGroups.has(row)) {
        row.setAttribute('data-search-hidden', '1');
        row.style.display = 'none';
      }
    });
    count.textContent = matches.length ? `${matches.length} match${matches.length !== 1 ? 'es' : ''}` : 'none';
    if (matches.length) {
      setFlowsheetSearchIdx(0);
      matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } else {
    body.querySelectorAll('tbody tr').forEach(row => {
      const nameCell = row.querySelector('td:last-child');
      if (nameCell && nameCell.textContent.toLowerCase().includes(q)) matches.push(row);
    });
    setFlowsheetSearchIdx(startIdx);
    count.textContent = matches.length ? `1/${matches.length}` : 'none';
    setFlowsheetSearchMatches(matches);
    if (matches.length) scrollToFlowsheetMatch(body);
    return;
  }
  setFlowsheetSearchMatches(matches);
}

function navigateFlowsheetSearch(body, dir) {
  if (!_flowsheetSearchMatches.length) return;
  setFlowsheetSearchIdx((_flowsheetSearchIdx + dir + _flowsheetSearchMatches.length) % _flowsheetSearchMatches.length);
  $('flowsheet-search-count').textContent = `${_flowsheetSearchIdx + 1}/${_flowsheetSearchMatches.length}`;
  scrollToFlowsheetMatch(body);
}

function scrollToFlowsheetMatch(body) {
  body.querySelectorAll('td[data-search-match]').forEach(td => {
    td.removeAttribute('data-search-match');
    td.style.outline = '';
  });
  const row = _flowsheetSearchMatches[_flowsheetSearchIdx];
  if (!row) return;
  row.querySelectorAll('td').forEach(td => {
    td.setAttribute('data-search-match', '1');
    td.style.outline = '2px solid var(--accent)';
    td.style.outlineOffset = '-2px';
  });
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ── LAB GROUPS ──

export async function loadLabGroups() {
  try {
    const d = await getDoc(doc(db, 'app_config', 'lab_groups'));
    if (d.exists() && d.data().groups?.length) {
      setLabGroups(d.data().groups);
    } else {
      await setDoc(doc(db, 'app_config', 'lab_groups'), { groups: _labGroups });
    }
  } catch(e) { console.warn('Lab groups load failed:', e.message); }
}

async function addLabGroup(name) {
  const trimmed = name.trim();
  if (!trimmed || _labGroups.includes(trimmed)) return;
  setLabGroups([..._labGroups, trimmed]);
  await setDoc(doc(db, 'app_config', 'lab_groups'), { groups: _labGroups });
}

export async function loadLabCorrections() {
  try {
    const snap = await getDocs(collection(db, 'lab_corrections'));
    const corrections = {};
    snap.forEach(d => { corrections[d.id] = d.data().labGroup; });
    setLabCorrections(corrections);
  } catch(e) { console.warn('Lab corrections load failed:', e.message); }
}

async function saveLabCorrection(testName, labGroup) {
  const key = testName.toLowerCase().trim();
  try {
    await setDoc(doc(db, 'lab_corrections', key), { testName, labGroup, updatedAt: new Date().toISOString() });
    setLabCorrections({ ..._labCorrections, [key]: labGroup });
    const snap = await getDocs(query(collection(db, 'labs'), where('test', '==', testName)));
    const batch = writeBatch(db);
    snap.forEach(d => batch.update(d.ref, { labGroup }));
    await batch.commit();
    showToast(`"${testName}" → ${labGroup} saved ✓`, 'journal');
    invalidateFlowsheetCache();
    await loadLabsSidebar();
  } catch(e) { showAlert('Correction failed: ' + e.message, 'warning'); }
}

// ── LAB GROUP MANAGER ──

export async function openLabGroupManager() {
  $('lab-group-manager').style.display = 'flex';
  const body = $('lab-gm-body');
  body.innerHTML = '<div style="padding:1.25rem;font-family:\'JetBrains Mono\',monospace;font-size:0.68rem;color:var(--ink-muted);">Loading all lab groups…</div>';

  try {
    const snap = await getDocs(collection(db, 'labs'));
    const groupCounts = {};
    snap.forEach(d => {
      const g = (d.data().labGroup || 'Other').trim();
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    });
    const allGroups = Object.keys(groupCounts).sort((a, b) => a.localeCompare(b));

    if (!allGroups.length) {
      body.innerHTML = '<div style="padding:1.25rem;font-family:\'JetBrains Mono\',monospace;font-size:0.68rem;color:var(--ink-muted);">No lab groups found.</div>';
      return;
    }

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
    const dupGroups = new Set();
    for (let i = 0; i < allGroups.length; i++) {
      for (let j = i + 1; j < allGroups.length; j++) {
        if (normalize(allGroups[i]) === normalize(allGroups[j])) {
          dupGroups.add(allGroups[i]);
          dupGroups.add(allGroups[j]);
        }
      }
    }

    body.innerHTML = '';

    if (dupGroups.size) {
      const dupSection = document.createElement('div');
      dupSection.style.cssText = 'border-bottom:1px solid var(--border);';
      const dupHdr = document.createElement('div');
      dupHdr.style.cssText = 'padding:0.6rem 1.25rem 0.4rem;font-family:"JetBrains Mono",monospace;font-size:0.6rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--amber);background:var(--amber-bg);border-bottom:1px solid rgba(156,107,30,0.15);';
      dupHdr.textContent = `⚠ Suspected duplicates (${dupGroups.size} groups)`;
      dupSection.appendChild(dupHdr);
      const dupNote = document.createElement('div');
      dupNote.style.cssText = 'padding:0.45rem 1.25rem 0.35rem;font-family:"JetBrains Mono",monospace;font-size:0.62rem;color:var(--ink-muted);';
      dupNote.textContent = 'These group names look like variants of the same panel. Use → to merge into another group.';
      dupSection.appendChild(dupNote);
      [...dupGroups].sort().forEach(g => dupSection.appendChild(makeGroupRow(g, groupCounts[g], allGroups, true)));
      body.appendChild(dupSection);
    }

    const allSection = document.createElement('div');
    const allHdr = document.createElement('div');
    allHdr.style.cssText = 'padding:0.55rem 1.25rem 0.35rem;font-family:"JetBrains Mono",monospace;font-size:0.6rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-muted);background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:1;';
    allHdr.textContent = `All groups (${allGroups.length})`;
    allSection.appendChild(allHdr);
    allGroups.forEach(g => allSection.appendChild(makeGroupRow(g, groupCounts[g], allGroups, false)));
    body.appendChild(allSection);

  } catch(err) {
    body.innerHTML = `<div style="padding:1.25rem;font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--red);">Error: ${escHtml(err.message)}</div>`;
  }
}

function makeGroupRow(groupName, count, allGroups, highlight) {
  const row = document.createElement('div');
  row.style.cssText = `display:flex;align-items:center;gap:0.5rem;padding:0.55rem 1.25rem;border-bottom:1px solid var(--surface2);${highlight ? 'background:rgba(156,107,30,0.03);' : ''}`;
  row.id = 'gmrow-' + CSS.escape(groupName);

  const nameEl = document.createElement('span');
  nameEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.68rem;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  nameEl.textContent = groupName;
  row.appendChild(nameEl);

  const countEl = document.createElement('span');
  countEl.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.58rem;color:var(--ink-muted);background:var(--surface2);border-radius:8px;padding:0 0.35rem;flex-shrink:0;';
  countEl.textContent = count + ' test' + (count !== 1 ? 's' : '');
  row.appendChild(countEl);

  const arrow = document.createElement('span');
  arrow.style.cssText = 'font-size:0.7rem;color:var(--ink-muted);flex-shrink:0;';
  arrow.textContent = '→';
  row.appendChild(arrow);

  const sel = document.createElement('select');
  sel.style.cssText = 'font-family:"JetBrains Mono",monospace;font-size:0.65rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.25rem 0.4rem;color:var(--ink);outline:none;cursor:pointer;max-width:160px;';
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = 'keep as-is';
  sel.appendChild(placeholder);
  allGroups.filter(g => g !== groupName).forEach(g => {
    const o = document.createElement('option');
    o.value = g; o.textContent = g;
    sel.appendChild(o);
  });
  const renameOpt = document.createElement('option');
  renameOpt.value = '__rename__'; renameOpt.textContent = '✏ Rename…';
  sel.appendChild(renameOpt);
  row.appendChild(sel);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-icon free-icon';
  applyBtn.style.cssText = 'font-size:0.6rem;padding:0.2rem 0.45rem;flex-shrink:0;opacity:0.35;pointer-events:none;';
  applyBtn.innerHTML = '<span class="free-dot"></span> Apply';
  row.appendChild(applyBtn);

  sel.addEventListener('change', () => {
    const hasTarget = sel.value !== '';
    applyBtn.style.opacity = hasTarget ? '1' : '0.35';
    applyBtn.style.pointerEvents = hasTarget ? 'auto' : 'none';
  });

  applyBtn.addEventListener('click', async () => {
    const target = sel.value;
    if (!target) return;
    if (target === '__rename__') {
      const newName = prompt(`Rename "${groupName}" to:`, groupName);
      if (!newName || newName.trim() === groupName) return;
      await mergeLabGroup(groupName, newName.trim(), row, allGroups);
    } else {
      if (!confirm(`Merge all "${groupName}" labs into "${target}"?\n\nThis will update ${count} lab result(s) and cannot be undone.`)) return;
      await mergeLabGroup(groupName, target, row, allGroups);
    }
  });

  return row;
}

async function mergeLabGroup(fromGroup, toGroup, rowEl, allGroups) {
  const applyBtn = rowEl.querySelector('button');
  applyBtn.textContent = 'Saving…';
  applyBtn.disabled = true;

  try {
    const snap = await getDocs(query(collection(db, 'labs'), where('labGroup', '==', fromGroup)));
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.forEach(d => batch.update(d.ref, { labGroup: toGroup }));
      await batch.commit();
      invalidateLabsCache();
    }

    const corrSnap = await getDocs(collection(db, 'lab_corrections'));
    const corrBatch = writeBatch(db);
    let corrCount = 0;
    corrSnap.forEach(d => {
      if (d.data().labGroup === fromGroup) {
        corrBatch.update(d.ref, { labGroup: toGroup });
        corrCount++;
      }
    });
    if (corrCount) await corrBatch.commit();

    const newGroups = [..._labGroups];
    const idx = newGroups.indexOf(fromGroup);
    if (idx !== -1) {
      if (!newGroups.includes(toGroup)) {
        newGroups[idx] = toGroup;
      } else {
        newGroups.splice(idx, 1);
      }
      setLabGroups(newGroups);
      await setDoc(doc(db, 'app_config', 'lab_groups'), { groups: _labGroups });
    }

    rowEl.style.opacity = '0.4';
    rowEl.style.textDecoration = 'line-through';
    rowEl.style.pointerEvents = 'none';

    const msg = snap.size > 0
      ? `"${fromGroup}" → "${toGroup}" — ${snap.size} result(s) updated ✓`
      : `"${fromGroup}" renamed to "${toGroup}" ✓`;
    showToast(msg, 'journal');
    invalidateFlowsheetCache();
    await loadLabsSidebar();
  } catch(err) {
    showAlert('Merge failed: ' + err.message, 'warning');
    applyBtn.textContent = 'Apply';
    applyBtn.disabled = false;
  }
}

// ── LAB CONTEXT MENU ──

export function attachLabCtxMenu(el, entry, cat) {
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    const items = [];
    if (entry.driveFileId) {
      items.push({ label: '↗ Open original in Drive', action: () => window.open(`https://drive.google.com/file/d/${entry.driveFileId}/view`, '_blank') });
    }
    items.push(
      { label: '🗑 Delete this result', danger: true, action: () => confirmDeleteLab(entry, cat) },
      { label: '🗑 Delete all from this date', danger: true, action: () => confirmDeleteLabsByDate(entry.resultDate || entry.visitDate, cat) }
    );
    import('./ui.js').then(m => m.showCtxMenu(e, `${entry.test} · ${entry.labGroup || 'Chemistry'}`, items));
  });
}

function showLabGroupPicker(entry, anchorEl) {
  document.querySelectorAll('.lab-group-picker').forEach(p => p.remove());

  const picker = document.createElement('div');
  picker.className = 'lab-group-picker';
  picker.style.cssText = 'position:fixed;background:white;border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:1000;min-width:140px;padding:0.25rem 0;font-family:JetBrains Mono,monospace;font-size:0.65rem;';

  const currentGroup = entry.labGroup || 'Chemistry';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:0.3rem 0.75rem 0.2rem;color:var(--ink-muted);font-size:0.58rem;letter-spacing:0.06em;border-bottom:1px solid var(--surface2);margin-bottom:0.2rem;';
  hdr.textContent = 'Move to group';
  picker.appendChild(hdr);

  for (const g of _labGroups) {
    const opt = document.createElement('div');
    opt.style.cssText = `padding:0.25rem 0.75rem;cursor:${g === currentGroup ? 'default' : 'pointer'};color:${g === currentGroup ? 'var(--accent)' : 'var(--ink-dim)'};transition:background 0.1s;display:flex;align-items:center;gap:0.4rem;`;
    if (g === currentGroup) opt.style.fontWeight = '600';
    opt.innerHTML = `${g === currentGroup ? '✓ ' : ''}<span>${escHtml(g)}</span>`;
    if (g !== currentGroup) {
      opt.addEventListener('mouseenter', () => opt.style.background = 'var(--surface)');
      opt.addEventListener('mouseleave', () => opt.style.background = '');
      opt.addEventListener('click', async (e) => {
        e.stopPropagation();
        picker.remove();
        await saveLabCorrection(entry.test, g);
      });
    }
    picker.appendChild(opt);
  }

  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid var(--surface2);margin:0.2rem 0;';
  picker.appendChild(sep);

  const addOpt = document.createElement('div');
  addOpt.style.cssText = 'padding:0.25rem 0.75rem;cursor:pointer;color:var(--ink-muted);font-size:0.6rem;';
  addOpt.textContent = '+ New group…';
  addOpt.addEventListener('click', async (e) => {
    e.stopPropagation();
    picker.remove();
    const name = prompt('New group name:');
    if (name?.trim()) {
      await addLabGroup(name.trim());
      await saveLabCorrection(entry.test, name.trim());
    }
  });
  picker.appendChild(addOpt);

  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  const pw = picker.offsetWidth || 150;
  const ph = picker.offsetHeight || 200;
  let x = rect.right - pw;
  let y = rect.bottom + 2;
  if (y + ph > window.innerHeight - 8) y = rect.top - ph - 2;
  if (x < 8) x = 8;
  picker.style.left = x + 'px';
  picker.style.top = y + 'px';

  const close = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

async function confirmDeleteLab(entry, cat) {
  if (!confirm(`Delete ${entry.test} result for ${cat} on ${entry.resultDate}?`)) return;
  const snap = await getDocs(query(collection(db, 'labs'),
    where('cat', '==', cat), where('test', '==', entry.test), where('resultDate', '==', entry.resultDate)));
  for (const d of snap.docs) await deleteDoc(d.ref);
  invalidateLabsCache();
  await loadLabsSidebar();
  showToast(`Deleted ${entry.test} ✓`, 'journal');
}

async function confirmDeleteLabsByDate(date, cat) {
  if (!confirm(`Delete ALL lab results for ${cat} on ${date}?`)) return;
  const snap = await getDocs(query(collection(db, 'labs'),
    where('cat', '==', cat), where('resultDate', '==', date)));
  for (const d of snap.docs) await deleteDoc(d.ref);
  invalidateLabsCache();
  await loadLabsSidebar();
  showToast(`Deleted all labs for ${cat} on ${date} ✓`, 'journal');
}

// ── ABNORMAL LAB ALERTS ──

export async function checkAbnormalLabs() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const snap = await getDocs(collection(db, 'labs'));
    const recent = [];
    snap.forEach(d => {
      const l = d.data();
      if (l.abnormal && l.abnormal !== 'NEG' && l.abnormal !== 'NEGATIVE' && l.resultDate && l.resultDate >= thirtyDaysAgo) recent.push(l);
    });
    if (!recent.length) return;
    const bycat = {};
    for (const l of recent) {
      if (!bycat[l.cat]) bycat[l.cat] = [];
      bycat[l.cat].push(`${l.test} ${l.value}${l.unit?' '+l.unit:''} [${l.abnormal}]`);
    }
    const parts = Object.entries(bycat).map(([cat,tests]) => `${cat}: ${tests.join(', ')}`);
    $('abnormal-banner-text').textContent = `⚠ Recent abnormal values — ${parts.join(' · ')}`;
    $('abnormal-banner').classList.add('show');
  } catch(e) { console.warn('Abnormal check failed:', e); }
}

// openLabDetail is defined in main.js / records.js — forward via window
function openLabDetail(...args) {
  if (typeof window.openLabDetail === 'function') return window.openLabDetail(...args);
}

// ── MANUAL LAB ENTRY ──

export function openAddLabModal(prefillCat) {
  const modal = $('add-lab-modal');
  if (!modal) return;

  // Populate cat select
  const catSel = $('add-lab-cat');
  catSel.innerHTML = '';
  const cats = Object.keys(labDataCache).sort();
  // Also include APP_PETS so cats without labs yet are available
  import('./state.js').then(({ APP_PETS }) => {
    const allCats = [...new Set([...cats, ...APP_PETS])].sort();
    catSel.innerHTML = '';
    for (const c of allCats) {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      if (c === (prefillCat || flowsheetCat)) opt.selected = true;
      catSel.appendChild(opt);
    }
  });

  // Populate group select
  const groupSel = $('add-lab-group');
  groupSel.innerHTML = '';
  const groups = _labGroups.length ? _labGroups : ['CBC','Chemistry','Urinalysis','Endocrinology','GI Panel','PCR','Other'];
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    groupSel.appendChild(opt);
  }

  // Populate test name autocomplete from existing labs
  const dl = $('add-lab-test-list');
  if (dl) {
    const knownTests = [...new Set((_allLabsCache || []).map(l => l.test).filter(Boolean))].sort();
    dl.innerHTML = '';
    for (const t of knownTests) {
      const opt = document.createElement('option');
      opt.value = t;
      dl.appendChild(opt);
    }
  }

  // Default date to today
  $('add-lab-date').value = new Date().toISOString().slice(0, 10);
  $('add-lab-test').value = '';
  $('add-lab-value').value = '';
  $('add-lab-unit').value = '';
  $('add-lab-reflo').value = '';
  $('add-lab-refhi').value = '';
  $('add-lab-abnormal').value = '';

  modal.style.display = 'flex';
  setTimeout(() => $('add-lab-test')?.focus(), 80);
}

async function saveManualLab() {
  const cat = $('add-lab-cat')?.value?.trim();
  const test = $('add-lab-test')?.value?.trim();
  const rawValue = $('add-lab-value')?.value?.trim();
  const unit = $('add-lab-unit')?.value?.trim() || null;
  const refLo = $('add-lab-reflo')?.value;
  const refHi = $('add-lab-refhi')?.value;
  const date = $('add-lab-date')?.value;
  const group = $('add-lab-group')?.value || 'Other';
  const abnormal = $('add-lab-abnormal')?.value || null;

  if (!cat) { showToast('Select a cat', 'warning'); return; }
  if (!test) { showToast('Test name is required', 'warning'); return; }
  if (!rawValue) { showToast('Value is required', 'warning'); return; }
  if (!date) { showToast('Date is required', 'warning'); return; }

  // Coerce to number if possible
  const numVal = parseFloat(rawValue);
  const value = isNaN(numVal) ? rawValue : numVal;

  const btn = $('add-lab-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await setDoc(doc(collection(db, 'labs')), {
      cat,
      test,
      value,
      unit,
      refLow: refLo !== '' && refLo != null ? parseFloat(refLo) : null,
      refHigh: refHi !== '' && refHi != null ? parseFloat(refHi) : null,
      abnormal,
      resultDate: date,
      visitDate: date,
      labGroup: group,
      labName: group,
      source: 'manual',
      createdAt: new Date().toISOString(),
    });
    $('add-lab-modal').style.display = 'none';
    invalidateLabsCache();
    await loadLabsSidebar();
    // Re-render flowsheet if open
    if ($('flowsheet-modal')?.classList.contains('open') && flowsheetCat) {
      openFlowsheetModal(flowsheetCat);
    }
    showToast(`${test} added for ${cat} ✓`, 'journal');
  } catch (e) {
    showAlert('Save failed: ' + e.message, 'warning');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

// ── MODULE-LEVEL WIRING ──
{
  const closeModal = () => { $('add-lab-modal').style.display = 'none'; };
  $('add-lab-modal-close')?.addEventListener('click', closeModal);
  $('add-lab-cancel')?.addEventListener('click', closeModal);
  $('add-lab-save')?.addEventListener('click', saveManualLab);
  $('flowsheet-add-lab-btn')?.addEventListener('click', () => openAddLabModal(flowsheetCat));
}
