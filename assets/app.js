/* ==========================================================================
   app.js — PressReader Collector

   Wires the page together: settings, search, the results table, the SQLite
   database and the export tab. Everything runs in the browser; nothing is
   sent anywhere except to the PressReader API (or the proxy you configure).
   ========================================================================== */

import { Store, ARTICLE_COLUMNS, SQLJS_VERSION } from './db.js';
import { titleKey } from './title.js';
import * as api from './api.js';
import * as ex from './export.js';
const safeHref = ex.safeHref;

/* --------------------------------------------------------------- helpers -- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const on = (node, type, fn, opts) => node && node.addEventListener(type, fn, opts);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmtInt = (n) => Number(n || 0).toLocaleString();

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ---------------------------------------------------------------- toasts -- */

function toast(title, message = '', kind = 'info', ms = 6000) {
  const box = $('#toasts');
  if (!box) return;
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, [
    el('div', { class: 'toast__body' }, [
      el('div', { class: 'toast__title', text: title }),
      message ? el('div', { class: 'toast__msg', text: message }) : null,
    ]),
    el('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss', text: '✕' }),
  ]);
  const close = () => { node.remove(); clearTimeout(timer); };
  $('.toast__close', node).addEventListener('click', close);
  const timer = setTimeout(close, ms);
  box.append(node);
  while (box.children.length > 5) box.firstElementChild.remove();
}

function reportError(err, fallbackTitle = 'Something went wrong') {
  const isApi = err instanceof api.ApiError;
  const title = isApi ? err.message : fallbackTitle;
  const parts = [];
  if (isApi && err.detail) parts.push(err.detail);
  if (isApi && err.hint) parts.push(err.hint);
  if (!isApi) parts.push(err?.message || String(err));
  toast(title, parts.join(' — '), 'err', 12000);
  console.error(err);
}

/* -------------------------------------------------------------- confirm -- */

function confirmDialog(title, bodyHtml, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const dialog = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').innerHTML = bodyHtml;
    $('#confirmOk').textContent = okLabel;
    const done = (value) => {
      dialog.close();
      $('#confirmOk').removeEventListener('click', ok);
      $('#confirmCancel').removeEventListener('click', cancel);
      resolve(value);
    };
    const ok = () => done(true);
    const cancel = () => done(false);
    $('#confirmOk').addEventListener('click', ok);
    $('#confirmCancel').addEventListener('click', cancel);
    dialog.addEventListener('close', () => resolve(false), { once: true });
    dialog.showModal();
  });
}

/* -------------------------------------------------------------- settings -- */

const SETTINGS_KEY = 'pressreader-collector:settings';
const KEY_STORAGE = 'pressreader-collector:api-key';
const DEFAULT_PROXY_URL = 'https://pressreader-proxy.systemslibrarian.workers.dev';

const defaultSettings = () => ({
  endpoint: api.DEFAULT_ENDPOINT,
  proxyUrl: DEFAULT_PROXY_URL,
  proxyMode: 'path',
  theme: 'auto',
  rememberKey: false,
  autosave: true,
  exportColumns: ARTICLE_COLUMNS.filter((c) => c.core).map((c) => c.key),
  form: null,
});

function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch { /* storage unavailable or corrupt — defaults are fine */ }
  // Migrate visitors who previously saved the old empty proxy default.
  if (!base.proxyUrl) base.proxyUrl = DEFAULT_PROXY_URL;
  return base;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* private browsing — settings simply will not persist */ }
}

/* ----------------------------------------------------------------- state -- */

const state = {
  store: null,
  settings: loadSettings(),
  apiKey: '',
  selected: new Set(),
  sort: { key: 'date', dir: 'desc' },
  page: 0,
  pageSize: 50,
  filters: { text: '', publication: '', searchId: '', from: '', to: '', dedupeTitles: true },
  lastRunId: null,
  rowsOnPage: [],
  controller: null,
  sqlResult: null,
  demoLoaded: false,
};

/* ----------------------------------------------------------------- theme -- */

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = $('#themeBtn');
  if (btn) btn.title = `Theme: ${t} — click to change`;
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  state.settings.theme = next;
  saveSettings();
  applyTheme();
  toast('Theme', `Now using the ${next === 'auto' ? "system's" : next} theme.`, 'info', 2500);
}

/* ------------------------------------------------------------------ tabs -- */

function showTab(name) {
  $$('.tab').forEach((tab) => {
    const active = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(active));
  });
  $$('.panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });
  if (name === 'export') refreshExportPreview();
  if (name === 'database') refreshSchema();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* --------------------------------------------------------------- api key -- */

function loadApiKey() {
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    if (stored) return stored;
  } catch { /* ignore */ }
  try {
    return sessionStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

function storeApiKey(key) {
  state.apiKey = key;
  try {
    if (state.settings.rememberKey && key) {
      localStorage.setItem(KEY_STORAGE, key);
      sessionStorage.removeItem(KEY_STORAGE);
    } else {
      localStorage.removeItem(KEY_STORAGE);
      if (key) sessionStorage.setItem(KEY_STORAGE, key);
      else sessionStorage.removeItem(KEY_STORAGE);
    }
  } catch { /* storage blocked — the key stays in memory for this tab */ }
  renderKeyBadge();
}

function renderKeyBadge() {
  const badge = $('#keyBadge');
  const text = $('#keyBadgeText');
  if (!badge || !text) return;
  const key = state.apiKey;
  badge.className = 'badge' + (key ? ' badge--ok' : '');
  if (!key) {
    text.textContent = 'Not set';
  } else {
    const tail = key.length > 4 ? key.slice(-4) : '';
    text.textContent = state.settings.rememberKey
      ? `Saved on this device · …${tail}`
      : `Set for this tab · …${tail}`;
  }
}

function syncKeyPanel({ collapse = false } = {}) {
  const panel = $('#keyPanel');
  if (panel) {
    if (!state.apiKey) panel.open = true;
    else if (collapse) panel.open = false;
  }
  const firstRun = $('#firstRunNote');
  if (firstRun) firstRun.hidden = Boolean(state.apiKey);
}

/* -------------------------------------------------------- connection UI -- */

function connConfig() {
  return {
    endpoint: state.settings.endpoint || api.DEFAULT_ENDPOINT,
    proxyUrl: state.settings.proxyUrl || '',
    proxyMode: state.settings.proxyMode || 'path',
  };
}

function renderConnBanner() {
  const banner = $('#connBanner');
  if (banner) banner.hidden = Boolean(state.settings.proxyUrl);
}

/* ------------------------------------------------------------ rendering -- */

function renderDbBadge() {
  const text = $('#dbBadgeText');
  const badge = $('#dbBadge');
  if (!text || !state.store) return;
  const n = state.store.count('articles');
  text.textContent = `${fmtInt(n)} article${n === 1 ? '' : 's'}`;
  badge.className = 'badge' + (n ? ' badge--ok' : '');
  const pip = $('#pipResults');
  if (pip) pip.textContent = fmtInt(n);
}

function renderStats() {
  if (!state.store) return;
  const s = state.store;
  const set = (id, value) => { const n = $(id); if (n) n.textContent = value; };
  set('#statArticles', fmtInt(s.count('articles')));
  set('#statPublications', fmtInt(
    s.scalar('SELECT COUNT(DISTINCT publication) AS n FROM articles WHERE publication IS NOT NULL AND publication != ""') ?? 0));
  set('#statQueries', fmtInt(s.count('searches')));
  const range = s.one(
    'SELECT MIN(date) AS lo, MAX(date) AS hi FROM articles WHERE date IS NOT NULL AND date != ""');
  set('#statEarliest', range?.lo || '—');
  set('#statLatest', range?.hi || '—');
  set('#statSize', fmtBytes(s.byteSize()));
}

/** Escapes LIKE wildcards so a filter containing % or _ behaves literally. */
function likeParam(text) {
  return '%' + String(text).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

/** WHERE clause + params for the current Results-tab filters. */
function filterClause() {
  const clauses = [];
  const params = [];
  const f = state.filters;

  if (f.text.trim()) {
    const p = likeParam(f.text.trim());
    const cols = ['title', 'subtitle', 'summary', 'publication', 'author', 'categories', 'entities'];
    clauses.push('(' + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    cols.forEach(() => params.push(p));
  }
  if (f.publication) { clauses.push('publication = ?'); params.push(f.publication); }
  if (f.from) { clauses.push('date >= ?'); params.push(f.from); }
  if (f.to) { clauses.push('date <= ?'); params.push(f.to); }
  if (f.searchId) {
    clauses.push('id IN (SELECT article_id FROM article_searches WHERE search_id = ?)');
    params.push(Number(f.searchId));
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

function hasActiveResultsFilters() {
  const f = state.filters;
  return Boolean(f.text.trim() || f.publication || f.searchId || f.from || f.to);
}

const SORTABLE = new Set(['title', 'publication', 'date', 'author', 'fetched_at']);

function orderClause() {
  const key = SORTABLE.has(state.sort.key) ? state.sort.key : 'date';
  const dir = state.sort.dir === 'asc' ? 'ASC' : 'DESC';
  // Empty and NULL values sort last whichever direction is chosen.
  return `ORDER BY (${key} IS NULL OR ${key} = '') ASC, ${key} COLLATE NOCASE ${dir}, id ASC`;
}

function renderResults() {
  if (!state.store) return;
  const tbody = $('#articlesTable tbody');
  const { where, params } = filterClause();

  let hiddenTitleDuplicates = 0;
  let allRows = null;
  let total;
  if (state.filters.dedupeTitles) {
    const seenTitles = new Set();
    allRows = state.store.all(`SELECT * FROM articles ${where} ${orderClause()}`, params)
      .filter((row) => {
        const key = titleKey(row.title);
        if (!key || !seenTitles.has(key)) {
          if (key) seenTitles.add(key);
          return true;
        }
        hiddenTitleDuplicates += 1;
        return false;
      });
    total = allRows.length;
  } else {
    total = Number(state.store.scalar(`SELECT COUNT(*) AS n FROM articles ${where}`, params) ?? 0);
  }
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page >= pages) state.page = pages - 1;
  if (state.page < 0) state.page = 0;
  const offset = state.page * state.pageSize;

  const rows = allRows
    ? allRows.slice(offset, offset + state.pageSize)
    : state.store.all(
      `SELECT * FROM articles ${where} ${orderClause()} LIMIT ? OFFSET ?`,
      [...params, state.pageSize, offset]
    );
  state.rowsOnPage = rows;

  tbody.replaceChildren();

  if (!rows.length) {
    const message = total === 0 && !where
      ? ['No articles yet', 'Run a search, load the sample data, or import a .db file.']
      : ['Nothing matches these filters', 'Try clearing the filter boxes above.'];
    tbody.append(el('tr', {}, [
      el('td', { colspan: '7' }, [
        el('div', { class: 'empty' }, [
          el('span', { class: 'empty__icon', text: '🗞️' }),
          el('div', { class: 'empty__title', text: message[0] }),
          el('div', { text: message[1] }),
        ]),
      ]),
    ]));
  }

  for (const row of rows) {
    const checked = state.selected.has(row.id);
    const tr = el('tr', { class: checked ? 'is-selected' : '' }, [
      el('td', { class: 'check' }, [
        el('input', {
          type: 'checkbox', 'aria-label': `Select ${row.title || row.id}`,
          ...(checked ? { checked: true } : {}),
          onchange: (e) => {
            if (e.target.checked) state.selected.add(row.id);
            else state.selected.delete(row.id);
            tr.classList.toggle('is-selected', e.target.checked);
            renderSelectionUi();
          },
        }),
      ]),
      el('td', { class: 'title' }, [
        safeHref(row.url)
          ? el('a', {
              class: 'rowlink', href: safeHref(row.url), target: '_blank', rel: 'noopener noreferrer',
              text: row.title || '(untitled)',
            })
          : (row.title || '(untitled)'),
      ]),
      el('td', { class: 'clip', title: row.publication || '' }, [row.publication || '—']),
      el('td', { class: 'nowrap' }, [row.date || '—']),
      el('td', { class: 'clip', title: row.author || '' }, [row.author || '—']),
      el('td', { class: 'clip', title: row.summary || '' }, [truncate(row.summary || '—', 90)]),
      el('td', { class: 'nowrap' }, [
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', title: 'Show every field',
          text: 'Details', onclick: () => showDetail(row),
        }),
      ]),
    ]);
    tbody.append(tr);
  }

  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + rows.length, total);
  $('#pagerCount').textContent = total
    ? `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(total)}` +
      (hiddenTitleDuplicates ? ` · ${fmtInt(hiddenTitleDuplicates)} duplicate title${hiddenTitleDuplicates === 1 ? '' : 's'} hidden` : '')
    : 'No articles';
  const hiddenCount = $('#hiddenTitleCount');
  if (hiddenCount) {
    hiddenCount.textContent = hiddenTitleDuplicates
      ? `${fmtInt(hiddenTitleDuplicates)} duplicate title${hiddenTitleDuplicates === 1 ? '' : 's'} hidden`
      : 'No duplicate titles hidden';
  }
  $('#pagerPage').textContent = `Page ${state.page + 1} of ${pages}`;
  $('#prevPageBtn').disabled = state.page === 0;
  $('#nextPageBtn').disabled = state.page >= pages - 1;
  $('#headCheck').checked = rows.length > 0 && rows.every((r) => state.selected.has(r.id));
  $('#clearFiltersBtn').disabled = !hasActiveResultsFilters();

  renderSelectionUi();
  renderStats();
  renderDbBadge();
}

function renderSelectionUi() {
  const n = state.selected.size;
  const btn = $('#deleteSelectedBtn');
  if (btn) {
    btn.disabled = n === 0;
    btn.textContent = n ? `Delete ${fmtInt(n)} selected` : 'Delete selected';
  }
  refreshExportCount();
}

function showDetail(row) {
  const body = $('#detailBody');
  const dl = el('dl', { class: 'kv' });
  for (const col of ARTICLE_COLUMNS) {
    const value = row[col.key];
    if (value === null || value === undefined || value === '') continue;
    if (col.key === 'raw') continue;
    dl.append(el('dt', { text: col.label }));
    const href = safeHref(value);
    dl.append(el('dd', {}, [
      href
        ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: String(value) })
        : String(value),
    ]));
  }
  body.replaceChildren(dl);

  if (row.raw) {
    let pretty = row.raw;
    try { pretty = JSON.stringify(JSON.parse(row.raw), null, 2); } catch { /* show as-is */ }
    body.append(el('details', { class: 'disclosure', style: 'margin-top:16px' }, [
      el('summary', { text: 'Raw JSON from the API' }),
      el('div', { class: 'disclosure__body' }, [el('pre', {}, [el('code', { text: pretty })])]),
    ]));
  }
  $('.dialog__title', $('#detailDialog')).textContent = row.title || 'Article';
  $('#detailDialog').showModal();
}

function refreshFilterOptions() {
  if (!state.store) return;

  const pubSel = $('#filterPublication');
  const chosenPub = state.filters.publication;
  const pubs = state.store.all(
    `SELECT publication, COUNT(*) AS n FROM articles
      WHERE publication IS NOT NULL AND publication != ''
      GROUP BY publication ORDER BY n DESC, publication ASC`);
  pubSel.replaceChildren(el('option', { value: '', text: 'All publications' }));
  for (const p of pubs) {
    pubSel.append(el('option', {
      value: p.publication,
      text: `${truncate(p.publication, 40)} (${fmtInt(p.n)})`,
      ...(p.publication === chosenPub ? { selected: true } : {}),
    }));
  }

  const runSel = $('#filterQuery');
  const chosenRun = state.filters.searchId;
  const runs = state.store.all(
    `SELECT s.id, s.query, s.started_at, COUNT(a.article_id) AS n
       FROM searches s LEFT JOIN article_searches a ON a.search_id = s.id
      GROUP BY s.id ORDER BY s.id DESC LIMIT 100`);
  runSel.replaceChildren(el('option', { value: '', text: 'All searches' }));
  for (const r of runs) {
    runSel.append(el('option', {
      value: String(r.id),
      text: `#${r.id} “${truncate(r.query || '', 28)}” (${fmtInt(r.n)})`,
      ...(String(r.id) === String(chosenRun) ? { selected: true } : {}),
    }));
  }
}

function renderRuns() {
  if (!state.store) return;
  const card = $('#runLogCard');
  const runs = state.store.all('SELECT * FROM searches ORDER BY id DESC LIMIT 50');
  card.hidden = runs.length === 0;
  const tbody = $('#runsTable tbody');
  tbody.replaceChildren();

  for (const run of runs) {
    const badge = run.status === 'ok'
      ? el('span', { class: 'badge badge--ok', text: 'OK' })
      : run.status === 'cancelled'
        ? el('span', { class: 'badge badge--warn', text: 'Cancelled' })
        : el('span', { class: 'badge badge--err', text: 'Failed', title: run.message || '' });

    tbody.append(el('tr', {}, [
      el('td', { class: 'nowrap' }, [fmtWhen(run.started_at)]),
      el('td', { class: 'clip', title: run.query || '' }, [run.query || '—']),
      el('td', { class: 'num' }, [fmtInt(run.returned)]),
      el('td', { class: 'num' }, [fmtInt(run.inserted)]),
      el('td', { class: 'num' }, [fmtInt(run.duplicates)]),
      el('td', {}, [badge]),
      el('td', { class: 'nowrap' }, [
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', text: 'View articles',
          onclick: () => {
            state.filters.searchId = String(run.id);
            $('#filterQuery').value = String(run.id);
            state.page = 0;
            renderResults();
            showTab('results');
          },
        }),
      ]),
    ]));

    if (run.message && run.status !== 'ok') {
      tbody.append(el('tr', {}, [
        el('td', { colspan: '7', class: 'muted', style: 'padding-top:0;font-size:12.5px' },
          [truncate(run.message, 240)]),
      ]));
    }
  }
}

/* ---------------------------------------------------------------- search -- */

function readForm() {
  return {
    query: $('#query').value,
    countries: $('#countries').value,
    languages: $('#languages').value,
    author: $('#author').value,
    cids: $('#cids').value,
    searchIn: $('#searchIn').value,
    itemTypes: $('#itemTypes').value,
    startDate: $('#startDate').value,
    endDate: $('#endDate').value,
    extra: $('#extraParams').value,
    wantTotal: Number($('#wantTotal').value) || 25,
    pageSize: Number($('#pageSize').value) || 25,
    startOffset: Number($('#startOffset').value) || 0,
    sort: $('#sortOrder').value,
    keepRaw: $('#storeRaw').checked,
    overwrite: $('#updateExisting').checked,
    dedupeByTitle: $('#dedupeTitles').checked,
  };
}

function writeForm(form) {
  if (!form) return;
  const set = (id, value) => { const n = $(id); if (n && value !== undefined && value !== null) n.value = value; };
  set('#query', form.query);
  set('#countries', form.countries);
  set('#languages', form.languages);
  set('#author', form.author);
  set('#cids', form.cids);
  set('#searchIn', form.searchIn);
  set('#itemTypes', form.itemTypes);
  set('#startDate', form.startDate);
  set('#endDate', form.endDate);
  set('#extraParams', form.extra);
  set('#wantTotal', form.wantTotal);
  set('#pageSize', form.pageSize);
  set('#startOffset', form.startOffset);
  set('#sortOrder', form.sort);
  if (typeof form.keepRaw === 'boolean') $('#storeRaw').checked = form.keepRaw;
  if (typeof form.overwrite === 'boolean') $('#updateExisting').checked = form.overwrite;
  if (typeof form.dedupeByTitle === 'boolean') $('#dedupeTitles').checked = form.dedupeByTitle;
}

function setSearching(active) {
  $('#searchBtn').disabled = active;
  $('#previewBtn').disabled = active;
  $('#cancelBtn').hidden = !active;
  $('#searchProgress').hidden = !active;
  $('#searchBtn').replaceChildren(
    ...(active
      ? [el('span', { class: 'btn__spinner' }), document.createTextNode(' Searching…')]
      : [document.createTextNode('🔍 Search & save to database')])
  );
  if (!active) {
    $('#progressBar').style.width = '0%';
    $('#progressText').textContent = '';
  }
}

function setProgress(fetched, target, page, totalCount, titleDuplicates = 0) {
  const pct = Math.min(100, Math.round((fetched / Math.max(1, target)) * 100));
  $('#progressBar').style.width = `${pct}%`;
  const totalNote = totalCount !== null && totalCount !== undefined
    ? ` · the API reports ${fmtInt(totalCount)} matching article${totalCount === 1 ? '' : 's'} in total`
    : '';
  const duplicateNote = titleDuplicates
    ? ` · ${fmtInt(titleDuplicates)} repeated title${titleDuplicates === 1 ? '' : 's'} skipped`
    : '';
  $('#progressText').textContent =
    `Collected ${fmtInt(fetched)} unique of ${fmtInt(target)} · request ${page}${duplicateNote}${totalNote}`;
}

async function runSearch({ preview = false } = {}) {
  if (!state.store) return;
  const form = readForm();

  if (!state.apiKey) {
    toast('No API key', 'Paste your PressReader key above, or use “Load sample data” to try the app first.', 'warn');
    $('#apiKey').focus();
    return;
  }

  state.settings.form = form;
  saveSettings();

  const controller = new AbortController();
  state.controller = controller;
  setSearching(true);

  const conn = connConfig();
  let runId = null;

  try {
    if (!preview) {
      runId = state.store.beginSearch(form.query || form.author, {
        countries: form.countries, languages: form.languages, cids: form.cids,
        startDate: form.startDate, endDate: form.endDate, sort: form.sort,
        wantTotal: form.wantTotal, pageSize: form.pageSize, startOffset: form.startOffset,
        dedupeByTitle: form.dedupeByTitle,
      }, conn.proxyUrl ? `${conn.endpoint} (via proxy)` : conn.endpoint);
    }

    const result = await api.search({
      apiKey: state.apiKey,
      conn,
      form,
      wantTotal: preview ? Math.min(form.pageSize, form.wantTotal) : form.wantTotal,
      pageSize: form.pageSize,
      startOffset: form.startOffset,
      sort: form.sort,
      keepRaw: form.keepRaw,
      signal: controller.signal,
      onProgress: ({ fetched, target, page, totalCount, titleDuplicates }) =>
        setProgress(fetched, target, page, totalCount, titleDuplicates),
    });

    if (preview) {
      showPreview(result);
      return;
    }

    const saved = state.store.saveArticles(result.articles, {
      searchId: runId, query: form.query || form.author,
      overwrite: form.overwrite, keepRaw: form.keepRaw,
      dedupeByTitle: form.dedupeByTitle,
    });
    const titleDuplicates = (result.titleDuplicates || 0) + (saved.titleDuplicates || 0);
    const messages = [];
    if (titleDuplicates) {
      messages.push(`${titleDuplicates} repeated title${titleDuplicates === 1 ? '' : 's'} skipped.`);
    }
    if (result.truncated) {
      messages.push(`The API reports ${result.totalCount} matches in total; ${result.rawFetched} were examined.`);
    }
    state.store.finishSearch(runId, {
      returned: result.rawFetched,
      inserted: saved.inserted,
      duplicates: saved.duplicates + titleDuplicates,
      status: 'ok',
      message: messages.join(' '),
    });
    state.lastRunId = runId;
    await state.store.save();

    refreshFilterOptions();
    renderRuns();
    state.page = 0;
    renderResults();

    const bits = [`${fmtInt(saved.inserted)} new`];
    if (saved.updated) bits.push(`${fmtInt(saved.updated)} refreshed`);
    if (saved.duplicates) bits.push(`${fmtInt(saved.duplicates)} already stored`);
    if (titleDuplicates) bits.push(`${fmtInt(titleDuplicates)} repeated title${titleDuplicates === 1 ? '' : 's'} skipped`);
    toast(
      `Processed ${fmtInt(result.rawFetched)} result${result.rawFetched === 1 ? '' : 's'}`,
      bits.join(' · ') + (result.truncated ? ` · ${fmtInt(result.totalCount)} matches exist in total` : ''),
      'ok'
    );
    if (result.articles.length) showTab('results');
  } catch (err) {
    if (runId !== null) {
      const cancelled = controller.signal.aborted;
      state.store.finishSearch(runId, {
        status: cancelled ? 'cancelled' : 'error',
        message: [err?.message, err?.detail, err?.hint].filter(Boolean).join(' — '),
      });
      renderRuns();
    }
    if (!controller.signal.aborted) reportError(err, 'The search failed');
    else toast('Search cancelled', '', 'warn', 3000);
  } finally {
    state.controller = null;
    setSearching(false);
  }
}

function showPreview(result) {
  const body = $('#detailBody');
  body.replaceChildren();
  body.append(el('p', { class: 'section-note' }, [
    `${result.articles.length} unique article${result.articles.length === 1 ? '' : 's'} shown` +
    (result.titleDuplicates ? ` · ${fmtInt(result.titleDuplicates)} repeated title${result.titleDuplicates === 1 ? '' : 's'} hidden` : '') +
    (result.totalCount !== null ? ` · ${fmtInt(result.totalCount)} matches in total` : '') +
    ' · nothing was saved.',
  ]));

  const table = el('table', { class: 'data' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Title' }), el('th', { text: 'Publication' }), el('th', { text: 'Date' }),
    ])]),
    el('tbody', {}, result.articles.map((a) => el('tr', {}, [
      el('td', { class: 'title' }, [a.title || '(untitled)']),
      el('td', {}, [a.publication || '—']),
      el('td', { class: 'nowrap' }, [a.date || '—']),
    ]))),
  ]);
  body.append(el('div', { class: 'tablewrap' }, [table]));

  if (result.articles[0]?.raw) {
    let pretty = result.articles[0].raw;
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* as-is */ }
    body.append(el('details', { class: 'disclosure', style: 'margin-top:16px' }, [
      el('summary', { text: 'Raw JSON of the first result' }),
      el('div', { class: 'disclosure__body' }, [el('pre', {}, [el('code', { text: pretty })])]),
    ]));
  }
  $('.dialog__title', $('#detailDialog')).textContent = 'Preview — not saved';
  $('#detailDialog').showModal();
}

async function loadDemo() {
  if (!state.store) return;
  if (state.demoLoaded) {
    toast('Sample data is already loaded', '', 'info', 3000);
    return;
  }
  const items = api.sampleItems();
  const runId = state.store.beginSearch('coffee (sample data)', { demo: true }, 'sample data — no API call');
  const articles = items.map((item) => api.normaliseItem(item, { query: 'coffee (sample data)', keepRaw: true }));
  const saved = state.store.saveArticles(articles, {
    searchId: runId, query: 'coffee (sample data)', keepRaw: true,
  });
  state.store.finishSearch(runId, {
    returned: articles.length, inserted: saved.inserted, duplicates: saved.duplicates,
    status: 'ok', message: 'Sample data — no request was made to PressReader.',
  });
  state.lastRunId = runId;
  state.demoLoaded = true;
  await state.store.save();

  refreshFilterOptions();
  renderRuns();
  renderResults();
  toast(`Loaded ${fmtInt(saved.inserted)} sample articles`, 'Nothing was sent to PressReader. Try the Results and Export tabs.', 'ok');
  showTab('results');
}

/* -------------------------------------------------------------- database -- */

async function downloadDatabase() {
  if (!state.store) return;
  const bytes = state.store.export();
  const name = `${ex.safeFilename($('#exportFilename').value || 'pressreader-collector')}.db`;
  ex.download(name, new Blob([bytes], { type: 'application/vnd.sqlite3' }));
  toast('Database downloaded', `${name} · ${fmtBytes(bytes.length)}`, 'ok');
}

async function importFile(file) {
  if (!state.store || !file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.json')) {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed.articles) ? parsed.articles
        : Array.isArray(parsed.items) ? parsed.items.map((i) => api.normaliseItem(i))
        : null;
      if (!list) throw new Error('Expected a JSON array, or an object with an "articles" or "items" array.');
      const rows = list.map((row) => (row && row.article ? api.normaliseItem(row) : row))
        .filter((row) => row && row.id !== undefined && row.id !== null)
        .map((row) => ({ ...row, id: String(row.id) }));
      if (!rows.length) throw new Error('No usable articles found in that file.');
      const before = state.store.count('articles');
      state.store.saveArticles(rows, { query: 'imported', keepRaw: true });
      const added = state.store.count('articles') - before;
      await state.store.save();
      toast('Imported', `${fmtInt(rows.length)} article${rows.length === 1 ? '' : 's'} read · ${fmtInt(added)} new`, 'ok');
    } else {
      const buffer = await file.arrayBuffer();
      const result = state.store.importBytes(buffer);
      await state.store.save();
      toast('Database merged', `${fmtInt(result.articles)} article${result.articles === 1 ? '' : 's'} read · ${fmtInt(result.added)} new · ${fmtInt(result.searches)} search records`, 'ok');
    }
    refreshFilterOptions();
    renderRuns();
    state.page = 0;
    renderResults();
    showTab('results');
  } catch (err) {
    reportError(err, `Could not import ${file.name}`);
  }
}

async function resetDatabase() {
  const ok = await confirmDialog(
    'Erase the whole database?',
    '<p>Every stored article and search record is deleted from this browser. ' +
    'This cannot be undone.</p><p><strong>Download the <code>.db</code> file first if you want to keep it.</strong></p>',
    'Erase everything'
  );
  if (!ok) return;
  state.store.eraseAll();
  state.selected.clear();
  state.lastRunId = null;
  state.demoLoaded = false;
  await state.store.save();
  refreshFilterOptions();
  renderRuns();
  renderResults();
  refreshSchema();
  toast('Database erased', '', 'ok');
}

function refreshSchema() {
  if (!state.store) return;
  const rows = state.store.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  const counts = ['articles', 'searches', 'article_searches']
    .map((t) => `-- ${t}: ${fmtInt(state.store.count(t))} rows`).join('\n');
  const text = rows.map((r) => (r.sql ? r.sql.trim() + ';' : `-- ${r.type} ${r.name}`)).join('\n\n');
  $('#schemaOut').textContent = `${counts}\n-- SQLite ${SQLJS_VERSION} via sql.js\n\n${text}`;
}

const SQL_SAMPLES = [
  ['Articles per publication',
    'SELECT publication, COUNT(*) AS articles\nFROM articles\nGROUP BY publication\nORDER BY articles DESC;'],
  ['Articles per month',
    "SELECT substr(date, 1, 7) AS month, COUNT(*) AS articles\nFROM articles\nWHERE date != ''\nGROUP BY month\nORDER BY month DESC;"],
  ['Most recent 50 articles',
    'SELECT date, publication, title, url\nFROM articles\nORDER BY date DESC\nLIMIT 50;'],
  ['Search the summaries',
    "SELECT date, publication, title\nFROM articles\nWHERE summary LIKE '%climate%'\nORDER BY date DESC;"],
  ['Articles found by more than one search',
    'SELECT a.title, COUNT(s.search_id) AS searches\nFROM articles a\nJOIN article_searches s ON s.article_id = a.id\nGROUP BY a.id\nHAVING searches > 1\nORDER BY searches DESC;'],
  ['Sentiment breakdown',
    "SELECT sentiment, COUNT(*) AS articles\nFROM articles\nWHERE sentiment IS NOT NULL AND sentiment != ''\nGROUP BY sentiment\nORDER BY articles DESC;"],
  ['Most frequent authors',
    "SELECT author, COUNT(*) AS articles\nFROM articles\nWHERE author IS NOT NULL AND author != ''\nGROUP BY author\nORDER BY articles DESC\nLIMIT 25;"],
  ['Every search I have run',
    'SELECT id, query, started_at, returned, inserted, duplicates, status\nFROM searches\nORDER BY id DESC;'],
];

function runSql() {
  if (!state.store) return;
  const sql = $('#sqlInput').value.trim();
  const errBox = $('#sqlError');
  const wrap = $('#sqlResultWrap');
  errBox.hidden = true;
  errBox.replaceChildren();

  if (!sql) { wrap.hidden = true; return; }

  let results;
  try {
    results = state.store.readOnlyExec(sql);
  } catch (err) {
    wrap.hidden = true;
    errBox.hidden = false;
    errBox.append(el('div', { class: 'note note--err' }, [
      el('span', { class: 'note__icon', text: '⚠️' }),
      el('div', { class: 'note__body' }, [
        el('strong', { text: 'That query did not run' }),
        el('div', { class: 'mono-sm', style: 'margin-top:5px' }, [err.message]),
      ]),
    ]));
    return;
  }

  const last = [...results].reverse().find((r) => r.columns.length) || results[results.length - 1];
  if (!last || !last.columns.length) {
    wrap.hidden = true;
    errBox.hidden = false;
    errBox.append(el('div', { class: 'note note--info' }, [
      el('span', { class: 'note__icon', text: 'ℹ️' }),
      el('div', { class: 'note__body', text: 'The query ran but returned no columns.' }),
    ]));
    return;
  }

  state.sqlResult = last;
  wrap.hidden = false;
  $('#sqlRowCount').textContent =
    `${fmtInt(last.rows.length)} row${last.rows.length === 1 ? '' : 's'}` +
    (last.rows.length >= 1000 ? ' (showing the first 1,000)' : '');

  const table = $('#sqlTable');
  $('thead', table).replaceChildren(el('tr', {}, last.columns.map((c) => el('th', { text: c }))));
  const tbody = $('tbody', table);
  tbody.replaceChildren();
  for (const row of last.rows.slice(0, 1000)) {
    tbody.append(el('tr', {}, last.columns.map((c) => {
      const v = row[c];
      const isNum = typeof v === 'number';
      return el('td', {
        class: isNum ? 'num' : 'clip',
        title: v === null || v === undefined ? '' : String(v),
      }, [v === null || v === undefined ? '—' : truncate(String(v), 120)]);
    })));
  }
}

async function exportSqlResult(format) {
  if (!state.sqlResult) return;
  const columns = state.sqlResult.columns.map((c) => ({ key: c, label: c, width: 22 }));
  const { blob, filename } = await ex.buildExport(format, state.sqlResult.rows, columns, {
    filename: `${ex.safeFilename($('#exportFilename').value || 'pressreader')}-query`,
    bom: $('#optBom').checked,
    sanitise: $('#optSanitize').checked,
    extraSheets: false,
    pretty: $('#optPretty').checked,
    markdownStyle: 'table',
    sheetName: 'Query result',
  });
  ex.download(filename, blob);
  toast('Exported', filename, 'ok');
}

/* ---------------------------------------------------------------- export -- */

function selectedExportColumns() {
  const keys = new Set(state.settings.exportColumns);
  const chosen = ARTICLE_COLUMNS.filter((c) => keys.has(c.key));
  return chosen.length ? chosen : ARTICLE_COLUMNS.filter((c) => c.core);
}

function renderColumnChips() {
  const box = $('#columnChips');
  const keys = new Set(state.settings.exportColumns);
  box.replaceChildren();
  for (const col of ARTICLE_COLUMNS) {
    const input = el('input', {
      type: 'checkbox', value: col.key,
      ...(keys.has(col.key) ? { checked: true } : {}),
      onchange: (e) => {
        const set = new Set(state.settings.exportColumns);
        if (e.target.checked) set.add(col.key); else set.delete(col.key);
        state.settings.exportColumns = ARTICLE_COLUMNS.map((c) => c.key).filter((k) => set.has(k));
        saveSettings();
        refreshExportPreview();
      },
    });
    box.append(el('label', { class: 'chip' }, [input, col.label]));
  }
}

/** Sorts rows in JS using the same "column DIR, …" grammar as the SQL path. */
function sortRows(rows, order) {
  const terms = order.split(',').map((part) => {
    const [key, dir] = part.trim().split(/\s+/);
    return { key, sign: (dir || 'ASC').toUpperCase() === 'DESC' ? -1 : 1 };
  });
  return rows.sort((a, b) => {
    for (const { key, sign } of terms) {
      const x = a[key], y = b[key];
      const xEmpty = x === null || x === undefined || x === '';
      const yEmpty = y === null || y === undefined || y === '';
      if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;   // empties last, as in SQL
      if (xEmpty) continue;
      const cmp = typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
      if (cmp) return cmp * sign;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Rows for the chosen export scope. */
function exportRows() {
  if (!state.store) return [];
  const scope = $('#exportScope').value;
  const order = $('#exportSort').value || 'date DESC';
  const safeOrder = /^[a-z_]+ (ASC|DESC)(, ?[a-z_]+ (ASC|DESC))*$/i.test(order) ? order : 'date DESC';

  if (scope === 'selected') {
    const ids = [...state.selected];
    if (!ids.length) return [];
    // Chunked: SQLite caps the number of bound parameters in one statement.
    const chunk = 400;
    const rows = [];
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const marks = slice.map(() => '?').join(',');
      rows.push(...state.store.all(`SELECT * FROM articles WHERE id IN (${marks})`, slice));
    }
    return sortRows(rows, safeOrder);
  }
  if (scope === 'lastrun') {
    if (state.lastRunId === null) return [];
    return state.store.all(
      `SELECT a.* FROM articles a
         JOIN article_searches s ON s.article_id = a.id
        WHERE s.search_id = ? ORDER BY ${safeOrder}`, [state.lastRunId]);
  }
  if (scope === 'filtered') {
    const { where, params } = filterClause();
    return state.store.all(`SELECT * FROM articles ${where} ORDER BY ${safeOrder}`, params);
  }
  return state.store.all(`SELECT * FROM articles ORDER BY ${safeOrder}`);
}

function refreshExportCount() {
  const badge = $('#exportCountBadge');
  if (!badge || !state.store) return;
  const scope = $('#exportScope')?.value;
  let n = 0;
  if (scope === 'selected') n = state.selected.size;
  else if (scope === 'lastrun') {
    n = state.lastRunId === null ? 0 : Number(state.store.scalar(
      'SELECT COUNT(*) AS n FROM article_searches WHERE search_id = ?', [state.lastRunId]) ?? 0);
  } else if (scope === 'filtered') {
    const { where, params } = filterClause();
    n = Number(state.store.scalar(`SELECT COUNT(*) AS n FROM articles ${where}`, params) ?? 0);
  } else {
    n = state.store.count('articles');
  }
  badge.textContent = `${fmtInt(n)} row${n === 1 ? '' : 's'}`;
  badge.className = 'badge ' + (n ? 'badge--info' : 'badge--warn');
  return n;
}

function refreshExportPreview() {
  if (!state.store) return;
  refreshExportCount();
  const columns = selectedExportColumns();
  const rows = exportRows().slice(0, 10);
  const table = $('#previewTable');

  $('thead', table).replaceChildren(
    el('tr', {}, columns.map((c) => el('th', { text: c.label }))));

  const tbody = $('tbody', table);
  tbody.replaceChildren();
  if (!rows.length) {
    tbody.append(el('tr', {}, [el('td', { colspan: String(columns.length || 1) }, [
      el('div', { class: 'empty' }, [
        el('span', { class: 'empty__icon', text: '📤' }),
        el('div', { class: 'empty__title', text: 'Nothing to export yet' }),
        el('div', { text: 'Collect some articles, or pick a different scope above.' }),
      ]),
    ])]));
    return;
  }
  const sanitise = $('#optSanitize').checked;
  for (const row of rows) {
    tbody.append(el('tr', {}, columns.map((col) => {
      let v = row[col.key];
      if (v === null || v === undefined) v = '';
      if (sanitise && typeof v === 'string') v = ex.sanitiseCell(v);
      return el('td', { class: 'clip', title: String(v) }, [truncate(String(v), 70) || '—']);
    })));
  }
}

async function doExport(format) {
  if (!state.store) return;
  try {
    if (format === 'db') { await downloadDatabase(); return; }

    const rows = exportRows();
    if (!rows.length) {
      toast('Nothing to export', 'The chosen scope contains no articles.', 'warn');
      return;
    }
    const columns = selectedExportColumns();
    const searches = state.store.all('SELECT * FROM searches ORDER BY id DESC LIMIT 200');

    const { blob, filename } = await ex.buildExport(format, rows, columns, {
      filename: $('#exportFilename').value || 'pressreader-articles',
      bom: $('#optBom').checked,
      sanitise: $('#optSanitize').checked,
      extraSheets: $('#optExcelSheets').checked,
      pretty: $('#optPretty').checked,
      searches,
      title: 'PressReader articles',
      meta: {
        exported_at: new Date().toISOString(),
        source: 'PressReader Discovery API',
        tool: 'PressReader Collector',
        count: rows.length,
      },
    });
    ex.download(filename, blob);
    toast(`Exported ${fmtInt(rows.length)} article${rows.length === 1 ? '' : 's'}`,
      `${filename} · ${fmtBytes(blob.size)}`, 'ok');
  } catch (err) {
    reportError(err, `Could not build the ${format.toUpperCase()} file`);
  }
}

/* ------------------------------------------------------------ connection -- */

async function testConnection() {
  const btn = $('#testConnBtn');
  const out = $('#connResult');
  btn.disabled = true;
  out.replaceChildren(el('p', { class: 'hint', text: 'Testing…' }));

  const conn = connConfig();
  const render = (kind, icon, title, lines) => {
    out.replaceChildren(el('div', { class: `note note--${kind}` }, [
      el('span', { class: 'note__icon', text: icon }),
      el('div', { class: 'note__body' }, [
        el('strong', { text: title }),
        ...lines.map((line) => el('div', { style: 'margin-top:5px' }, [line])),
      ]),
    ]));
  };

  try {
    const result = await api.testConnection({ apiKey: state.apiKey, conn });
    if (result.ok) {
      render('ok', '✅', 'Working', [
        `The API answered in ${result.ms} ms and accepted your key. You are ready to search.`,
      ]);
    } else if (result.reachable) {
      const e = result.error;
      render(e.kind === 'auth' ? 'warn' : 'info', e.kind === 'auth' ? '🔑' : 'ℹ️',
        e.kind === 'auth' ? 'Reachable, but the key was rejected' : 'Reachable, but the request was refused',
        [
          `The request completed a round trip in ${result.ms} ms — so the connection itself works.`,
          `${e.message}${e.detail ? ' — ' + e.detail : ''}`,
          e.hint || '',
        ].filter(Boolean));
    } else {
      render('err', '⛔', 'Could not reach the API', [
        conn.proxyUrl
          ? 'The proxy did not respond, or it did not allow this page. Check the address, that it is deployed, and that its allowed-origins list includes ' + location.origin + '.'
          : 'This is expected without a proxy: PressReader sends no CORS headers, so the browser blocks the request before it leaves. Set up the Worker below.',
        result.error?.detail ? `Browser reported: ${result.error.detail}` : '',
      ].filter(Boolean));
    }
  } catch (err) {
    render('err', '⛔', 'The test could not run', [err?.message || String(err)]);
  } finally {
    btn.disabled = false;
  }
}

async function loadWorkerSource() {
  const box = $('#workerCode');
  if (!box) return;
  try {
    const res = await fetch('proxy/cloudflare-worker.js', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    box.textContent = await res.text();
  } catch {
    box.textContent =
      'Could not load proxy/cloudflare-worker.js from this site.\n' +
      'Open it in the repository instead:\n' +
      'https://github.com/systemslibrarian/pressreader-news-scraper/blob/main/proxy/cloudflare-worker.js';
  }
}

function showDiagnostics() {
  const out = $('#diagOut');
  const lines = [
    `Page origin      ${location.origin}`,
    `App URL          ${location.href.split('#')[0]}`,
    `User agent       ${navigator.userAgent}`,
    `Language         ${navigator.language}`,
    `Online           ${navigator.onLine}`,
    `sql.js           ${SQLJS_VERSION}`,
    `Endpoint         ${state.settings.endpoint}`,
    `Proxy            ${state.settings.proxyUrl || '(none — direct calls will be blocked by CORS)'}`,
    `Proxy mode       ${state.settings.proxyMode}`,
    `API key          ${state.apiKey ? `set (${state.apiKey.length} characters)` : 'not set'}`,
    `Key persistence  ${state.settings.rememberKey ? 'localStorage' : 'this tab only'}`,
    `Autosave         ${state.store?.autosave ? 'on' : 'off'}`,
    `Articles         ${state.store ? fmtInt(state.store.count('articles')) : '—'}`,
    `Searches         ${state.store ? fmtInt(state.store.count('searches')) : '—'}`,
    `Database size    ${state.store ? fmtBytes(state.store.byteSize()) : '—'}`,
    `IndexedDB        ${'indexedDB' in window ? 'available' : 'UNAVAILABLE — nothing will persist'}`,
    `CompressionStream ${typeof CompressionStream !== 'undefined' ? 'available (compressed .xlsx)' : 'missing (uncompressed .xlsx)'}`,
    `Secure context   ${window.isSecureContext}`,
  ];
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then((est) => {
      out.textContent = lines.concat([
        `Storage used     ${fmtBytes(est.usage || 0)} of about ${fmtBytes(est.quota || 0)}`,
      ]).join('\n');
    }).catch(() => { out.textContent = lines.join('\n'); });
  }
  out.textContent = lines.join('\n');
  out.hidden = false;
}

/* ------------------------------------------------------------------ wire -- */

function wireTabs() {
  $$('.tab').forEach((tab) => {
    on(tab, 'click', () => showTab(tab.id.replace('tab-', '')));
  });
  $$('[data-goto]').forEach((btn) => {
    on(btn, 'click', () => showTab(btn.dataset.goto));
  });
  on($('.tabs'), 'keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = $$('.tab');
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    showTab(next.id.replace('tab-', ''));
    e.preventDefault();
  });
}

function wireKey() {
  const input = $('#apiKey');
  input.value = state.apiKey;
  $('#rememberKey').checked = state.settings.rememberKey;
  syncKeyPanel({ collapse: Boolean(state.apiKey) });

  on(input, 'input', () => storeApiKey(input.value.trim()));
  on(input, 'change', () => syncKeyPanel({ collapse: Boolean(state.apiKey) }));
  on($('#rememberKey'), 'change', (e) => {
    state.settings.rememberKey = e.target.checked;
    saveSettings();
    storeApiKey(state.apiKey);
    toast(
      e.target.checked ? 'Key will be remembered' : 'Key kept for this tab only',
      e.target.checked
        ? 'It is stored in this browser only. Untick this on a shared computer.'
        : 'It will be forgotten when you close the tab.',
      'info', 4000
    );
  });
  on($('#toggleKeyBtn'), 'click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggleKeyBtn').textContent = input.type === 'password' ? '👁️' : '🙈';
  });
  on($('#clearKeyBtn'), 'click', () => {
    input.value = '';
    storeApiKey('');
    syncKeyPanel();
    toast('Key cleared', 'Removed from this page and from browser storage.', 'ok', 3000);
  });
}

function wireSearch() {
  writeForm(state.settings.form);
  on($('#searchForm'), 'submit', (e) => { e.preventDefault(); runSearch(); });
  on($('#previewBtn'), 'click', () => runSearch({ preview: true }));
  on($('#cancelBtn'), 'click', () => state.controller?.abort());
  on($('#loadDemoBtn'), 'click', () => loadDemo());
  on($('#resetSearchBtn'), 'click', () => {
    state.settings.form = null;
    saveSettings();
    $('#searchForm').reset();
    toast('Form reset', '', 'info', 2000);
  });
  on($('#clearRunsBtn'), 'click', async () => {
    const ok = await confirmDialog(
      'Clear the search history?',
      '<p>The record of which searches you ran is deleted. <strong>Your articles are kept.</strong></p>',
      'Clear history');
    if (!ok) return;
    state.store.clearSearches();
    state.lastRunId = null;
    await state.store.save();
    refreshFilterOptions();
    renderRuns();
    toast('Search history cleared', '', 'ok', 3000);
  });
}

function wireResults() {
  const rerender = () => { state.page = 0; renderResults(); };

  let debounce;
  on($('#filterText'), 'input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.filters.text = e.target.value; rerender(); }, 220);
  });
  on($('#filterPublication'), 'change', (e) => { state.filters.publication = e.target.value; rerender(); });
  on($('#filterQuery'), 'change', (e) => { state.filters.searchId = e.target.value; rerender(); });
  on($('#filterFrom'), 'change', (e) => { state.filters.from = e.target.value; rerender(); });
  on($('#filterTo'), 'change', (e) => { state.filters.to = e.target.value; rerender(); });
  on($('#filterDedupeTitles'), 'change', (e) => {
    state.filters.dedupeTitles = e.target.checked;
    rerender();
  });
  on($('#clearFiltersBtn'), 'click', () => {
    clearTimeout(debounce);
    state.filters.text = '';
    state.filters.publication = '';
    state.filters.searchId = '';
    state.filters.from = '';
    state.filters.to = '';
    $('#filterText').value = '';
    $('#filterPublication').value = '';
    $('#filterQuery').value = '';
    $('#filterFrom').value = '';
    $('#filterTo').value = '';
    rerender();
    toast('Filters cleared', '', 'info', 2000);
  });

  $$('#articlesTable th.sortable').forEach((th) => {
    on(th, 'click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: key === 'date' ? 'desc' : 'asc' };
      $$('#articlesTable th.sortable').forEach((other) => other.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      $('.arrow', th).textContent = state.sort.dir === 'asc' ? '↑' : '↓';
      renderResults();
    });
  });

  on($('#pageSizeSel'), 'change', (e) => {
    state.pageSize = Number(e.target.value) || 50;
    state.page = 0;
    renderResults();
  });
  on($('#prevPageBtn'), 'click', () => { state.page -= 1; renderResults(); });
  on($('#nextPageBtn'), 'click', () => { state.page += 1; renderResults(); });

  on($('#headCheck'), 'change', (e) => {
    for (const row of state.rowsOnPage) {
      if (e.target.checked) state.selected.add(row.id);
      else state.selected.delete(row.id);
    }
    renderResults();
  });
  on($('#selectAllBtn'), 'click', () => {
    const { where, params } = filterClause();
    const ids = state.store.all(`SELECT id FROM articles ${where}`, params).map((r) => r.id);
    ids.forEach((id) => state.selected.add(id));
    renderResults();
    toast(`Selected ${fmtInt(ids.length)} article${ids.length === 1 ? '' : 's'}`, '', 'info', 2500);
  });
  on($('#selectNoneBtn'), 'click', () => { state.selected.clear(); renderResults(); });

  on($('#deleteSelectedBtn'), 'click', async () => {
    const n = state.selected.size;
    if (!n) return;
    const ok = await confirmDialog(
      `Delete ${fmtInt(n)} article${n === 1 ? '' : 's'}?`,
      '<p>They are removed from the database in this browser. This cannot be undone.</p>',
      `Delete ${fmtInt(n)}`);
    if (!ok) return;
    const removed = state.store.deleteArticles([...state.selected]);
    state.selected.clear();
    await state.store.save();
    refreshFilterOptions();
    renderResults();
    toast(`Deleted ${fmtInt(removed)} article${removed === 1 ? '' : 's'}`, '', 'ok');
  });

  on($('#detailClose'), 'click', () => $('#detailDialog').close());
}

function wireDatabase() {
  on($('#downloadDbBtn'), 'click', downloadDatabase);
  on($('#importDbBtn'), 'click', () => $('#fileInput').click());
  on($('#fileInput'), 'change', (e) => {
    const file = e.target.files?.[0];
    if (file) importFile(file);
    e.target.value = '';
  });

  const dz = $('#dropzone');
  on(dz, 'click', () => $('#fileInput').click());
  on(dz, 'keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
  });
  ['dragenter', 'dragover'].forEach((type) => on(dz, type, (e) => {
    e.preventDefault(); dz.classList.add('is-over');
  }));
  ['dragleave', 'dragend'].forEach((type) => on(dz, type, () => dz.classList.remove('is-over')));
  on(dz, 'drop', (e) => {
    e.preventDefault();
    dz.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });
  // Anywhere else on the page, a dropped file should not navigate away.
  on(window, 'dragover', (e) => e.preventDefault());
  on(window, 'drop', (e) => e.preventDefault());

  on($('#vacuumBtn'), 'click', async () => {
    const before = state.store.byteSize();
    state.store.vacuum();
    await state.store.save();
    const after = state.store.byteSize();
    renderStats();
    toast('Database compacted', `${fmtBytes(before)} → ${fmtBytes(after)}`, 'ok');
  });
  on($('#resetDbBtn'), 'click', resetDatabase);

  on($('#autosave'), 'change', async (e) => {
    state.store.autosave = e.target.checked;
    state.settings.autosave = e.target.checked;
    saveSettings();
    if (e.target.checked) {
      await state.store.save();
      toast('Autosave on', 'Changes are written to browser storage.', 'ok', 3000);
    } else {
      toast('Autosave off', 'Nothing will be kept after you reload. Download the .db file to keep your work.', 'warn', 6000);
    }
  });

  const samples = $('#sqlSamples');
  SQL_SAMPLES.forEach(([label, sql], i) => samples.append(el('option', { value: String(i), text: label })));
  on(samples, 'change', (e) => {
    const chosen = SQL_SAMPLES[Number(e.target.value)];
    if (!chosen) return;
    $('#sqlInput').value = chosen[1];
    e.target.value = '';
    runSql();
  });

  on($('#runSqlBtn'), 'click', runSql);
  on($('#sqlInput'), 'keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
  });
  $$('[data-export-sql]').forEach((btn) => {
    on(btn, 'click', () => exportSqlResult(btn.dataset.exportSql));
  });
}

function wireExport() {
  renderColumnChips();
  $('#exportFilename').value = 'pressreader-articles';

  on($('#exportScope'), 'change', refreshExportPreview);
  on($('#exportSort'), 'change', refreshExportPreview);
  on($('#optSanitize'), 'change', refreshExportPreview);
  on($('#colsAllBtn'), 'click', () => {
    state.settings.exportColumns = ARTICLE_COLUMNS.map((c) => c.key);
    saveSettings();
    renderColumnChips();
    refreshExportPreview();
  });
  on($('#colsCoreBtn'), 'click', () => {
    state.settings.exportColumns = ARTICLE_COLUMNS.filter((c) => c.core).map((c) => c.key);
    saveSettings();
    renderColumnChips();
    refreshExportPreview();
  });
  $$('[data-export]').forEach((btn) => on(btn, 'click', () => doExport(btn.dataset.export)));
}

function wireHelp() {
  $('#apiBase').value = state.settings.endpoint;
  $('#apiBaseDefault').textContent = api.DEFAULT_ENDPOINT;
  $('#proxyUrl').value = state.settings.proxyUrl;
  $('#proxyMode').value = state.settings.proxyMode;
  const originNode = $('#thisOrigin');
  if (originNode) originNode.textContent = location.origin;

  on($('#apiBase'), 'change', (e) => {
    state.settings.endpoint = e.target.value.trim() || api.DEFAULT_ENDPOINT;
    e.target.value = state.settings.endpoint;
    saveSettings();
  });
  on($('#proxyUrl'), 'change', (e) => {
    const value = e.target.value.trim() || DEFAULT_PROXY_URL;
    try {
      api.rejectUnsafeProxy(value);
    } catch (err) {
      e.target.value = state.settings.proxyUrl;
      reportError(err, 'That proxy cannot be used');
      return;
    }
    e.target.value = value;
    state.settings.proxyUrl = value;
    saveSettings();
    renderConnBanner();
    toast(value ? 'Proxy saved' : 'Proxy cleared',
      value ? 'Run the connection test to check it.' : 'Direct calls to PressReader will be blocked by CORS.',
      value ? 'ok' : 'warn', 4000);
  });
  on($('#proxyMode'), 'change', (e) => {
    state.settings.proxyMode = e.target.value;
    saveSettings();
  });
  on($('#resetConnBtn'), 'click', () => {
    state.settings.endpoint = api.DEFAULT_ENDPOINT;
    state.settings.proxyUrl = DEFAULT_PROXY_URL;
    state.settings.proxyMode = 'path';
    saveSettings();
    $('#apiBase').value = api.DEFAULT_ENDPOINT;
    $('#proxyUrl').value = DEFAULT_PROXY_URL;
    $('#proxyMode').value = 'path';
    renderConnBanner();
    toast('Connection settings restored', '', 'info', 3000);
  });
  on($('#testConnBtn'), 'click', testConnection);
  on($('#diagBtn'), 'click', showDiagnostics);
  on($('#copyWorkerBtn'), 'click', async () => {
    try {
      await navigator.clipboard.writeText($('#workerCode').textContent);
      toast('Copied', 'Paste it into the Cloudflare Worker editor.', 'ok', 3000);
    } catch {
      toast('Could not copy', 'Select the code and copy it manually.', 'warn');
    }
  });
  loadWorkerSource();
}

/* ------------------------------------------------------------------ boot -- */

function showBootError(err) {
  const main = $('#main');
  main.replaceChildren(el('div', { class: 'card' }, [
    el('div', { class: 'card__body' }, [
      el('div', { class: 'note note--err' }, [
        el('span', { class: 'note__icon', text: '⛔' }),
        el('div', { class: 'note__body' }, [
          el('strong', { text: 'The database engine could not start' }),
          el('p', {}, [
            'This app needs SQLite compiled to WebAssembly, which is loaded from a public CDN. ' +
            'The most likely causes are no network connection, a content blocker, or a network that ' +
            'blocks cdn.jsdelivr.net.',
          ]),
          el('pre', {}, [el('code', { text: err?.message || String(err) })]),
          el('p', {}, [
            el('button', {
              class: 'btn btn--primary', type: 'button', text: 'Try again',
              onclick: () => location.reload(),
            }),
          ]),
        ]),
      ]),
    ]),
  ]));
}

async function boot() {
  applyTheme();
  wireTabs();
  on($('#themeBtn'), 'click', cycleTheme);
  state.apiKey = loadApiKey();
  wireKey();
  renderKeyBadge();
  renderConnBanner();
  wireHelp();

  try {
    state.store = await Store.open();
  } catch (err) {
    showBootError(err);
    return;
  }

  state.store.autosave = state.settings.autosave !== false;
  state.store.onSaveError = (err) => {
    toast('Could not save to browser storage',
      `${err.message}. Your work is still in this tab — download the .db file to keep it.`, 'warn', 12000);
  };

  wireSearch();
  wireResults();
  wireDatabase();
  wireExport();

  $('#autosave').checked = state.store.autosave;
  $('#pageSizeSel').value = String(state.pageSize);

  const lastRun = state.store.one('SELECT id FROM searches ORDER BY id DESC LIMIT 1');
  state.lastRunId = lastRun ? lastRun.id : null;
  state.demoLoaded = Boolean(state.store.scalar(
    "SELECT 1 FROM searches WHERE query LIKE '%(sample data)%' LIMIT 1"));

  refreshFilterOptions();
  renderRuns();
  renderResults();
  refreshSchema();

  const count = state.store.count('articles');
  if (count) {
    $('#firstRunNote').hidden = true;
    showTab('results');
  }

  // A last save on the way out, so nothing collected is lost to a closed tab.
  on(window, 'beforeunload', () => {
    if (state.store?.autosave) state.store.save();
  });
}

boot().catch((err) => {
  console.error(err);
  showBootError(err);
});
