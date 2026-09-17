/* ==========================================================================
   export.js — turns rows into files the user can open elsewhere.

   Every writer here runs locally: nothing is uploaded, and no library is
   fetched from a CDN. Excel output is produced by ./xlsx.js.
   ========================================================================== */

import { buildWorkbook } from './xlsx.js';

/* --------------------------------------------------------------- helpers -- */

/**
 * Neutralises spreadsheet formula injection.
 *
 * A cell whose text starts with = + - @ (or a tab / carriage return) is
 * treated as a formula by Excel, Google Sheets and LibreOffice, so a hostile
 * headline could execute when the export is opened. Prefixing with an
 * apostrophe forces the cell to be read as text; the apostrophe itself is not
 * part of the value and is not displayed.
 */
export function sanitiseCell(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Values, in column order, ready for a writer. */
function rowValues(row, columns, { sanitise = false } = {}) {
  return columns.map((col) => {
    let v = row[col.key];
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    v = String(v);
    return sanitise ? sanitiseCell(v) : v;
  });
}

/** Browser download. Revoking too early cancels the download in some browsers. */
export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFilename(name, fallback = 'pressreader-articles') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/** U+FEFF. Excel on Windows needs it to read a UTF-8 CSV correctly. */
const BOM = '﻿';

/* ------------------------------------------------------------- delimited -- */

/** RFC 4180 quoting: wrap when the value holds a delimiter, quote or newline. */
function quoteField(value, delimiter) {
  const s = value === null || value === undefined ? '' : String(value);
  const mustQuote =
    s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') ||
    s !== s.trim();
  return mustQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toDelimited(rows, columns, { delimiter = ',', bom = true, sanitise = true } = {}) {
  const lines = [columns.map((c) => quoteField(c.label, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(rowValues(row, columns, { sanitise })
      .map((v) => quoteField(v, delimiter)).join(delimiter));
  }
  // CRLF is what RFC 4180 specifies and what Excel on Windows expects.
  return (bom ? BOM : '') + lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ json -- */

function pick(row, columns) {
  const out = {};
  for (const col of columns) {
    let v = row[col.key];
    if (v === undefined) v = null;
    out[col.key] = v;
  }
  return out;
}

export function toJson(rows, columns, { pretty = true, meta = null } = {}) {
  const articles = rows.map((r) => pick(r, columns));
  const payload = meta ? { ...meta, articles } : articles;
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

export function toNdjson(rows, columns) {
  return rows.map((r) => JSON.stringify(pick(r, columns))).join('\n') + '\n';
}

/* -------------------------------------------------------------- markdown -- */

function mdCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function toMarkdownTable(rows, columns) {
  const head = `| ${columns.map((c) => mdCell(c.label)).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) =>
    `| ${rowValues(row, columns).map(mdCell).join(' | ')} |`);
  return [head, rule, ...body].join('\n') + '\n';
}

/** The readable, article-per-section layout the companion notebook produces. */
export function toMarkdownArticles(rows, { title = 'PressReader articles' } = {}) {
  const out = [`# ${title}`, '', `_${rows.length} article${rows.length === 1 ? '' : 's'}_`, ''];
  rows.forEach((row, i) => {
    const heading = row.title || 'Untitled';
    out.push(row.url ? `## ${i + 1}. [${heading}](${row.url})` : `## ${i + 1}. ${heading}`);
    if (row.subtitle) out.push(`*${row.subtitle}*`);
    const meta = [];
    if (row.publication) meta.push(`**${row.publication}**`);
    if (row.date) meta.push(row.date);
    if (row.author) meta.push(`by ${row.author}`);
    if (row.page) meta.push(`p. ${row.page}`);
    if (meta.length) out.push('', meta.join(' · '));
    if (row.summary) out.push('', `> ${String(row.summary).replace(/\r?\n/g, '\n> ')}`);
    out.push('');
  });
  return out.join('\n');
}

/* ------------------------------------------------------------------ html -- */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Only http(s) addresses become links. Escaping alone is not enough for an
 * href: `javascript:` survives it intact and would run when clicked. Article
 * URLs come from the API or from an imported file, so neither is trusted.
 */
export function safeHref(value) {
  const s = String(value ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

export function toHtml(rows, columns, { title = 'PressReader articles' } = {}) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((col) => {
      const v = row[col.key];
      const href = col.key.endsWith('url') ? safeHref(v) : null;
      if (href) {
        return `<td><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a></td>`;
      }
      return `<td>${esc(v)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 2rem; }
  h1 { font-size: 1.4rem; }
  p.meta { color: #666; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid #ccc; padding: .4rem .55rem; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; position: sticky; top: 0; }
  tr:nth-child(even) td { background: rgba(127,127,127,.06); }
  @media (prefers-color-scheme: dark) {
    th { background: #2a2a2a; } th, td { border-color: #444; }
  }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="meta">${rows.length} article${rows.length === 1 ? '' : 's'} · exported ${esc(stamp)} UTC</p>
<table><thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody></table>
</body>
</html>
`;
}

/* ------------------------------------------------------------- citations -- */

function risLines(row) {
  const out = ['TY  - NEWS'];
  const add = (tag, value) => {
    if (value === null || value === undefined || value === '') return;
    String(value).split(/\r?\n/).forEach((line) => out.push(`${tag}  - ${line}`));
  };
  add('TI', row.title);
  if (row.author) String(row.author).split(/;\s*/).forEach((a) => add('AU', a));
  add('T2', row.publication);
  if (row.date) {
    add('PY', String(row.date).slice(0, 4));
    add('DA', String(row.date).replace(/-/g, '/'));
  }
  add('SP', row.page);
  add('AB', row.summary);
  add('LA', row.language);
  if (row.categories) String(row.categories).split(/;\s*/).forEach((k) => add('KW', k));
  add('UR', row.url);
  add('DB', 'PressReader');
  add('ID', row.id);
  out.push('ER  - ', '');
  return out.join('\r\n');
}

export function toRis(rows) {
  return rows.map(risLines).join('\r\n');
}

function bibtexEscape(value) {
  return String(value ?? '')
    .replace(/[\\{}]/g, '')
    .replace(/[&%$#_]/g, (m) => '\\' + m)
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function toBibtex(rows) {
  const used = new Set();
  return rows.map((row) => {
    // Citation keys conventionally use the first author's family name.
    const words = String(row.author || row.publication || 'anon')
      .split(/;/)[0].trim().split(/\s+/).filter(Boolean);
    const first = (words[words.length - 1] || 'anon')
      .replace(/[^A-Za-z]/g, '').toLowerCase() || 'anon';
    const year = row.date ? String(row.date).slice(0, 4) : 'nd';
    let key = `${first}${year}`;
    let n = 1;
    while (used.has(key)) key = `${first}${year}${String.fromCharCode(96 + ++n)}`;
    used.add(key);

    const fields = [
      ['title', row.title],
      ['author', row.author ? String(row.author).split(/;\s*/).join(' and ') : null],
      ['journal', row.publication],
      ['year', row.date ? String(row.date).slice(0, 4) : null],
      ['month', row.date ? String(row.date).slice(5, 7) : null],
      ['pages', row.page],
      ['language', row.language],
      ['abstract', row.summary],
      ['url', row.url],
      ['note', `PressReader article ${row.id}`],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');

    return `@article{${key},\n` +
      fields.map(([k, v]) => `  ${k} = {${bibtexEscape(v)}}`).join(',\n') +
      '\n}\n';
  }).join('\n');
}

/* ----------------------------------------------------------------- excel -- */

/** Counts values of one field, most frequent first. */
function tally(rows, key, { transform = (v) => v } = {}) {
  const counts = new Map();
  for (const row of rows) {
    const value = transform(row[key]);
    if (value === null || value === undefined || value === '') continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/**
 * Builds the workbook: the article list, plus optional summary sheets.
 * @returns {Promise<Blob>}
 */
export function buildArticleWorkbook(rows, columns, {
  sanitise = true, extraSheets = true, realDates = true, searches = null, sheetName = 'Articles',
} = {}) {
  const sheets = [{
    name: sheetName,
    header: columns.map((c) => c.label),
    rows: rows.map((row) => rowValues(row, columns, { sanitise })),
    widths: columns.map((c) => c.width || 18),
  }];

  if (extraSheets && rows.length) {
    sheets.push({
      name: 'By publication',
      header: ['Publication', 'Articles'],
      rows: tally(rows, 'publication').map(([name, n]) => [sanitise ? sanitiseCell(name) : name, n]),
      widths: [38, 11],
    });

    sheets.push({
      name: 'By month',
      header: ['Month', 'Articles'],
      rows: tally(rows, 'date', { transform: (v) => (v ? String(v).slice(0, 7) : null) })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([m, n]) => [m, n]),
      widths: [14, 11],
    });

    const byLanguage = tally(rows, 'language');
    if (byLanguage.length > 1) {
      sheets.push({
        name: 'By language',
        header: ['Language', 'Articles'],
        rows: byLanguage.map(([l, n]) => [l, n]),
        widths: [14, 11],
      });
    }

    if (searches && searches.length) {
      sheets.push({
        name: 'Searches',
        header: ['Run', 'Query', 'Started', 'Returned', 'New', 'Duplicates', 'Status', 'Message'],
        rows: searches.map((s) => [
          s.id,
          sanitise ? sanitiseCell(s.query || '') : s.query || '',
          s.started_at || '',
          s.returned ?? 0, s.inserted ?? 0, s.duplicates ?? 0,
          s.status || '',
          sanitise ? sanitiseCell(s.message || '') : s.message || '',
        ]),
        widths: [7, 30, 20, 11, 8, 12, 11, 46],
      });
    }
  }

  return buildWorkbook(sheets, { realDates, creator: 'PressReader Collector' });
}

/* ------------------------------------------------------------ dispatcher -- */

export const FORMATS = {
  xlsx:   { ext: 'xlsx',   mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel workbook' },
  csv:    { ext: 'csv',    mime: 'text/csv;charset=utf-8',                  label: 'CSV' },
  tsv:    { ext: 'tsv',    mime: 'text/tab-separated-values;charset=utf-8', label: 'Tab-separated' },
  json:   { ext: 'json',   mime: 'application/json;charset=utf-8',          label: 'JSON' },
  ndjson: { ext: 'ndjson', mime: 'application/x-ndjson;charset=utf-8',      label: 'JSON Lines' },
  md:     { ext: 'md',     mime: 'text/markdown;charset=utf-8',             label: 'Markdown' },
  html:   { ext: 'html',   mime: 'text/html;charset=utf-8',                 label: 'HTML table' },
  ris:    { ext: 'ris',    mime: 'application/x-research-info-systems;charset=utf-8', label: 'RIS citations' },
  bibtex: { ext: 'bib',    mime: 'application/x-bibtex;charset=utf-8',      label: 'BibTeX' },
  db:     { ext: 'db',     mime: 'application/vnd.sqlite3',                 label: 'SQLite database' },
};

/**
 * Produces the file for one format.
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function buildExport(format, rows, columns, options = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  const filename = `${safeFilename(options.filename)}.${spec.ext}`;
  const text = (s) => new Blob([s], { type: spec.mime });

  switch (format) {
    case 'xlsx':
      return { blob: await buildArticleWorkbook(rows, columns, options), filename };
    case 'csv':
      return { blob: text(toDelimited(rows, columns, { ...options, delimiter: ',' })), filename };
    case 'tsv':
      return { blob: text(toDelimited(rows, columns, { ...options, delimiter: '\t' })), filename };
    case 'json':
      return { blob: text(toJson(rows, columns, options)), filename };
    case 'ndjson':
      return { blob: text(toNdjson(rows, columns)), filename };
    case 'md':
      return {
        blob: text(options.markdownStyle === 'table'
          ? toMarkdownTable(rows, columns)
          : toMarkdownArticles(rows, options)),
        filename,
      };
    case 'html':
      return { blob: text(toHtml(rows, columns, options)), filename };
    case 'ris':
      return { blob: text(toRis(rows)), filename };
    case 'bibtex':
      return { blob: text(toBibtex(rows)), filename };
    default:
      throw new Error(`The ${format} file is produced elsewhere.`);
  }
}
