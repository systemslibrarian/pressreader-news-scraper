/* ==========================================================================
   xlsx.js — a small, dependency-free Office Open XML (.xlsx) writer.

   Writes a real multi-sheet workbook: bold frozen headers, auto-filter,
   column widths, true numeric and date cells, and inline strings (so no
   shared-string table is needed). ZIP entries are DEFLATE-compressed via the
   browser's native CompressionStream when available, and stored otherwise.

   Nothing here is loaded from a CDN, so exporting works offline and no third
   party ever sees the data.
   ========================================================================== */

/* ------------------------------------------------------------------- zip -- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const utf8 = new TextEncoder();

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    const out = new Uint8Array(buf);
    // Only worth it if it actually got smaller.
    return out.length < bytes.length ? out : null;
  } catch {
    return null;
  }
}

/** DOS date/time. Fixed to a constant so the same data yields the same bytes. */
const DOS_TIME = 0;                       // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;  // 2020-01-01

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  raw(bytes) { this.chunks.push(bytes); this.length += bytes.length; }
  u16(v) { this.raw(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF])); }
  u32(v) { this.raw(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF])); }
  blob(type) { return new Blob(this.chunks, { type }); }
}

/**
 * Builds a ZIP archive.
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Promise<Blob>}
 */
export async function zip(files) {
  const w = new ByteWriter();
  const central = [];

  for (const file of files) {
    const nameBytes = utf8.encode(file.name);
    const raw = file.data;
    const crc = crc32(raw);
    const packed = await deflateRaw(raw);
    const method = packed ? 8 : 0;
    const body = packed || raw;
    const offset = w.length;

    w.u32(0x04034B50);          // local file header
    w.u16(20);                  // version needed
    w.u16(0x0800);              // flags: UTF-8 names
    w.u16(method);
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(crc);
    w.u32(body.length);
    w.u32(raw.length);
    w.u16(nameBytes.length);
    w.u16(0);
    w.raw(nameBytes);
    w.raw(body);

    central.push({ nameBytes, crc, method, comp: body.length, size: raw.length, offset });
  }

  const cdStart = w.length;
  for (const e of central) {
    w.u32(0x02014B50);          // central directory header
    w.u16(20);                  // version made by
    w.u16(20);                  // version needed
    w.u16(0x0800);
    w.u16(e.method);
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(e.crc);
    w.u32(e.comp);
    w.u32(e.size);
    w.u16(e.nameBytes.length);
    w.u16(0);                   // extra
    w.u16(0);                   // comment
    w.u16(0);                   // disk number
    w.u16(0);                   // internal attrs
    w.u32(0);                   // external attrs
    w.u32(e.offset);
    w.raw(e.nameBytes);
  }
  const cdSize = w.length - cdStart;

  w.u32(0x06054B50);            // end of central directory
  w.u16(0);
  w.u16(0);
  w.u16(central.length);
  w.u16(central.length);
  w.u32(cdSize);
  w.u32(cdStart);
  w.u16(0);

  return w.blob('application/zip');
}

/* ------------------------------------------------------------------- xml -- */

/** Escapes text for XML content and strips characters XML 1.0 forbids. */
export function xmlEscape(value) {
  let s = String(value);
  // Excel treats _xHHHH_ as an escape sequence; escape the underscore itself.
  s = s.replace(/_(x[0-9A-Fa-f]{4})_/g, '_x005F_$1_');
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === 0x09 || code === 0x0A || code === 0x0D) { out += ch; continue; }
    if (code < 0x20) continue;                       // illegal in XML 1.0
    if (code >= 0xD800 && code <= 0xDFFF) continue;  // lone surrogate
    if (code === 0xFFFE || code === 0xFFFF) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** 1 -> A, 27 -> AA */
export function colName(index) {
  let n = index, s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

/** Excel serial number for a date (1900 system, with the 1900 leap-year quirk). */
export function excelSerial(date) {
  const ms = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
                      date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
  return ms / 86400000 + 25569;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** Recognises the ISO date shapes this app stores. Returns null otherwise. */
export function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = DATE_ONLY.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : { date: d, withTime: false };
  }
  m = DATE_TIME.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0));
    return Number.isNaN(d.getTime()) ? null : { date: d, withTime: true };
  }
  return null;
}

/* ------------------------------------------------------------- stylesheet -- */

/* cellXfs indexes used below:
   0 general · 1 header · 2 date · 3 date-time · 4 integer · 5 wrapped text */
const STYLES_XML = XML_HEAD +
`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
`<numFmts count="2">` +
`<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>` +
`<numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/>` +
`</numFmts>` +
`<fonts count="2">` +
`<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
`<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
`</fonts>` +
`<fills count="3">` +
`<fill><patternFill patternType="none"/></fill>` +
`<fill><patternFill patternType="gray125"/></fill>` +
`<fill><patternFill patternType="solid"><fgColor rgb="FF3C3A44"/><bgColor indexed="64"/></patternFill></fill>` +
`</fills>` +
`<borders count="2">` +
`<border><left/><right/><top/><bottom/><diagonal/></border>` +
`<border><left/><right/><top/><bottom style="thin"><color rgb="FF9E9AA6"/></bottom><diagonal/></border>` +
`</borders>` +
`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
`<cellXfs count="6">` +
`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
`<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
`<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
`<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
`<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>` +
`</cellXfs>` +
`<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
`<dxfs count="0"/>` +
`<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
`</styleSheet>`;

const STYLE = { GENERAL: 0, HEADER: 1, DATE: 2, DATETIME: 3, INT: 4, TEXT: 5 };

/* ------------------------------------------------------------- worksheet -- */

function sanitizeSheetName(name, index, used) {
  let s = String(name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, '-').slice(0, 31).trim();
  if (!s) s = `Sheet${index + 1}`;
  let candidate = s, n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = s.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function cellXml(ref, value, opts) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    const style = Number.isInteger(value) ? STYLE.INT : STYLE.GENERAL;
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (value instanceof Date) {
    return `<c r="${ref}" s="${STYLE.DATETIME}"><v>${excelSerial(value)}</v></c>`;
  }

  const text = String(value);

  if (opts.realDates) {
    const parsed = parseIsoDate(text);
    if (parsed) {
      const style = parsed.withTime ? STYLE.DATETIME : STYLE.DATE;
      const serial = excelSerial(parsed.date);
      return `<c r="${ref}" s="${style}"><v>${parsed.withTime ? serial : Math.round(serial)}</v></c>`;
    }
  }

  return `<c r="${ref}" s="${STYLE.TEXT}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

/**
 * @param {{header: string[], rows: any[][], widths?: number[]}} sheet
 */
function sheetXml(sheet, opts) {
  const header = sheet.header || [];
  const rows = sheet.rows || [];
  const colCount = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const rowCount = rows.length + (header.length ? 1 : 0);
  const lastRef = `${colName(colCount)}${Math.max(rowCount, 1)}`;

  const parts = [XML_HEAD,
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastRef}"/>`,
  ];

  parts.push('<sheetViews><sheetView workbookViewId="0">');
  if (header.length) {
    parts.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    parts.push('<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>');
  }
  parts.push('</sheetView></sheetViews>');
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');

  if (sheet.widths && sheet.widths.length) {
    parts.push('<cols>');
    sheet.widths.forEach((wide, i) => {
      const width = Math.min(Math.max(Number(wide) || 12, 4), 90);
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`);
    });
    parts.push('</cols>');
  }

  parts.push('<sheetData>');
  let r = 1;
  if (header.length) {
    parts.push(`<row r="1" ht="22" customHeight="1" s="${STYLE.HEADER}" customFormat="1">`);
    header.forEach((label, i) => {
      parts.push(
        `<c r="${colName(i + 1)}1" s="${STYLE.HEADER}" t="inlineStr">` +
        `<is><t xml:space="preserve">${xmlEscape(label)}</t></is></c>`
      );
    });
    parts.push('</row>');
    r = 2;
  }
  for (const row of rows) {
    parts.push(`<row r="${r}">`);
    for (let c = 0; c < row.length; c++) {
      const xml = cellXml(`${colName(c + 1)}${r}`, row[c], opts);
      if (xml) parts.push(xml);
    }
    parts.push('</row>');
    r += 1;
  }
  parts.push('</sheetData>');

  if (header.length && rows.length) {
    parts.push(`<autoFilter ref="A1:${colName(header.length)}${rows.length + 1}"/>`);
  }
  parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
  parts.push('</worksheet>');
  return parts.join('');
}

/* -------------------------------------------------------------- workbook -- */

/**
 * Builds an .xlsx workbook.
 * @param {Array<{name: string, header: string[], rows: any[][], widths?: number[]}>} sheets
 * @param {{realDates?: boolean, creator?: string}} [options]
 * @returns {Promise<Blob>}
 */
export async function buildWorkbook(sheets, options = {}) {
  const opts = { realDates: options.realDates !== false };
  const used = new Set();
  const list = (sheets.length ? sheets : [{ name: 'Sheet1', header: [], rows: [] }])
    .map((s, i) => ({ ...s, name: sanitizeSheetName(s.name, i, used) }));

  const files = [];
  const push = (name, text) => files.push({ name, data: utf8.encode(text) });

  push('[Content_Types].xml', XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    list.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join('') +
    '</Types>');

  push('_rels/.rels', XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>');

  const stamp = (options.created instanceof Date ? options.created : new Date())
    .toISOString().replace(/\.\d+Z$/, 'Z');
  const creator = xmlEscape(options.creator || 'PressReader Collector');

  push('docProps/core.xml', XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${creator}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>');

  push('docProps/app.xml', XML_HEAD +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>${creator}</Application>` +
    '</Properties>');

  push('xl/workbook.xml', XML_HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    list.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>');

  push('xl/_rels/workbook.xml.rels', XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join('') +
    `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>');

  push('xl/styles.xml', STYLES_XML);
  list.forEach((sheet, i) => push(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, opts)));

  const blob = await zip(files);
  return new Blob([blob], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
