/* ==========================================================================
   db.js — SQLite in the browser (sql.js / WebAssembly) + IndexedDB persistence
   ========================================================================== */

import { titleKey } from './title.js';

/* sql.js is vendored with the app. The glue script and WebAssembly binary must
   stay together under assets/sqljs/ and must come from this exact release. */
export const SQLJS_VERSION = '1.14.2';
const SQLJS_BASE_URL = new URL('./sqljs/', import.meta.url);

const IDB_NAME = 'pressreader-collector';
const IDB_STORE = 'files';
const IDB_KEY = 'database';

/* ----------------------------------------------------------- script load -- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve(src);
    el.onerror = () => {
      el.remove();
      reject(new Error(`Could not load ${src}`));
    };
    document.head.appendChild(el);
  });
}

let sqlPromise = null;

/** Resolves to the initialised vendored sql.js module. */
export function loadSqlJs() {
  if (sqlPromise) return sqlPromise;
  sqlPromise = (async () => {
    try {
      if (typeof globalThis.initSqlJs !== 'function') {
        await loadScript(new URL('sql-wasm.js', SQLJS_BASE_URL).href);
      }
      if (typeof globalThis.initSqlJs !== 'function') {
        throw new Error('initSqlJs missing after loading the vendored script');
      }
      return await globalThis.initSqlJs({
        locateFile: (filename) => new URL(filename, SQLJS_BASE_URL).href,
      });
    } catch (err) {
      sqlPromise = null;
      throw new Error(`SQLite (sql.js) could not be loaded from this site: ${err.message}`);
    }
  })();
  return sqlPromise;
}

/* -------------------------------------------------------------- IndexedDB -- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB is unavailable in this browser'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) idb.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

async function idbPut(key, value) {
  const idb = await idbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
      tx.objectStore(IDB_STORE).put(value, key);
    });
  } finally {
    idb.close();
  }
}

async function idbGet(key) {
  const idb = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    });
  } finally {
    idb.close();
  }
}

async function idbDelete(key) {
  const idb = await idbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
      tx.objectStore(IDB_STORE).delete(key);
    });
  } finally {
    idb.close();
  }
}

/* ----------------------------------------------------------------- schema -- */

export const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS articles (
  id               TEXT PRIMARY KEY,
  title            TEXT,
  publication      TEXT,
  publication_cid  TEXT,
  date             TEXT,
  page             INTEGER,
  url              TEXT
);

CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  query        TEXT,
  params       TEXT,
  endpoint     TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  returned     INTEGER DEFAULT 0,
  inserted     INTEGER DEFAULT 0,
  duplicates   INTEGER DEFAULT 0,
  status       TEXT,
  message      TEXT
);

CREATE TABLE IF NOT EXISTS article_searches (
  article_id TEXT NOT NULL,
  search_id  INTEGER NOT NULL,
  position   INTEGER,
  PRIMARY KEY (article_id, search_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_date        ON articles(date);
CREATE INDEX IF NOT EXISTS idx_articles_publication ON articles(publication);
CREATE INDEX IF NOT EXISTS idx_as_search            ON article_searches(search_id);
`;

/**
 * Columns of `articles` in export order, mapped from the PressReader
 * Discovery API's SearchResultItem schema. `core` marks the fields most people
 * want in a spreadsheet; `width` is the Excel column width.
 */
export const ARTICLE_COLUMNS = [
  { key: 'title',            label: 'Title',            core: true,  width: 52 },
  { key: 'publication',      label: 'Publication',      core: true,  width: 26 },
  { key: 'date',             label: 'Date',             core: true,  width: 12 },
  { key: 'page',             label: 'Page',             core: true,  width: 7  },
  { key: 'url',              label: 'Article URL',      core: true,  width: 46 },
  { key: 'publication_cid',  label: 'Publication CID',  core: true,  width: 15 },
  { key: 'id',               label: 'Article ID',       core: true,  width: 16 },
];

/** Columns whose SQLite affinity is numeric. */
export const NUMERIC_COLUMNS = new Set(['page']);

const INSERT_COLS = ARTICLE_COLUMNS.map((c) => c.key);

/** Columns a refresh may overwrite: everything except the stable identity. */
const PROVENANCE_COLS = new Set(['id']);
const CONTENT_COLS = INSERT_COLS.filter((k) => !PROVENANCE_COLS.has(k));

/** Statement kinds the SQL console will run. Tested against normalised SQL. */
const READ_ONLY_START = /^\s*(SELECT|WITH|EXPLAIN|VALUES|PRAGMA\s+(TABLE_INFO|TABLE_LIST|INDEX_LIST|INDEX_INFO|DATABASE_LIST|PAGE_COUNT|PAGE_SIZE|FOREIGN_KEY_LIST|COMPILE_OPTIONS|INTEGRITY_CHECK|SCHEMA_VERSION|USER_VERSION|FUNCTION_LIST)\b)/i;

/* ------------------------------------------------------------------ store -- */

export class Store {
  constructor(SQL, db) {
    this.SQL = SQL;
    this.db = db;
    this.autosave = true;
    this.revision = 0;          // bumped on every write
    this._scratch = null;       // read-only copy used by the SQL console
    this._scratchRev = -1;
    this._saveTimer = null;
    this._savePromise = null;
    this.onSaveError = null;
  }

  /** Opens the persisted database, or creates an empty one. */
  static async open() {
    const SQL = await loadSqlJs();
    let bytes = null;
    try {
      bytes = await idbGet(IDB_KEY);
    } catch {
      /* Private browsing or blocked storage — carry on in memory. */
    }
    let db = null;
    if (bytes && bytes.byteLength) {
      try {
        db = new SQL.Database(new Uint8Array(bytes));
        db.exec('PRAGMA schema_version');   // cheap check: throws on a non-database
      } catch {
        if (db) { try { db.close(); } catch { /* ignore */ } }
        db = null;
      }
    }
    if (!db) db = new SQL.Database();
    const store = new Store(SQL, db);
    store.migrate();
    return store;
  }

  migrate() {
    this.db.exec(SCHEMA_SQL);
    // Additive migrations for databases written by an older build.
    const have = new Set(this.columnsOf('articles'));
    for (const col of ARTICLE_COLUMNS) {
      if (!have.has(col.key)) {
        const type = NUMERIC_COLUMNS.has(col.key) ? 'INTEGER' : 'TEXT';
        this.db.exec(`ALTER TABLE articles ADD COLUMN ${col.key} ${type}`);
      }
    }
    // Schema v2 is a strict ingest allowlist based on fields confirmed in live
    // Discovery responses. Remove every legacy article column not on that list.
    this.db.exec('DROP INDEX IF EXISTS idx_articles_fetched');
    const allowed = new Set(ARTICLE_COLUMNS.map((col) => col.key));
    for (const legacy of [...have].filter((col) => !allowed.has(col))) {
      if (!have.has(legacy)) continue;
      try {
        this.db.exec(`ALTER TABLE articles DROP COLUMN ${legacy}`);
      } catch {
        this.db.exec(`UPDATE articles SET ${legacy} = NULL`);
      }
    }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    this.setMeta('app', 'pressreader-collector');
    this.touch();
  }

  columnsOf(table) {
    try {
      const res = this.db.exec(`PRAGMA table_info(${table})`);
      if (!res.length) return [];
      const nameIdx = res[0].columns.indexOf('name');
      return res[0].values.map((r) => r[nameIdx]);
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------- queries -- */

  /** Runs SQL and returns an array of plain row objects. */
  all(sql, params) {
    const stmt = this.db.prepare(sql);
    const rows = [];
    try {
      if (params !== undefined) stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  one(sql, params) {
    const rows = this.all(sql, params);
    return rows.length ? rows[0] : null;
  }

  scalar(sql, params) {
    const row = this.one(sql, params);
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
  }

  run(sql, params) {
    this.db.run(sql, params);
    this.touch();
  }

  /**
   * Runs user-supplied SQL safely.
   *
   * `PRAGMA query_only = ON` on its own is not enough: `exec()` runs every
   * statement in the string, so `PRAGMA query_only=OFF; DROP TABLE articles;`
   * would defeat it. Three layers instead —
   *   1. a throwaway clone, so any write dies with the copy;
   *   2. `query_only` on that clone as defence in depth;
   *   3. an allowlist on each statement's *normalised* SQL (literals replaced
   *      by `?`), so a string literal cannot disguise a write.
   * Preparing a statement does not execute it, so vetting happens before
   * anything runs.
   *
   * @returns {Array<{sql: string, columns: string[], rows: object[]}>}
   */
  readOnlyExec(sql) {
    if (!this._scratch || this._scratchRev !== this.revision) {
      if (this._scratch) { try { this._scratch.close(); } catch { /* ignore */ } }
      this._scratch = new this.SQL.Database(this.db.export());
      this._scratch.run('PRAGMA query_only = ON;');
      this._scratchRev = this.revision;
    }
    const results = [];
    const iter = this._scratch.iterateStatements(sql);
    let statement = null;
    try {
      for (statement of iter) {
        const normalised = (statement.getNormalizedSQL?.() || statement.getSQL() || '').trim();
        if (!READ_ONLY_START.test(normalised)) {
          throw new Error(
            'Only SELECT, WITH, EXPLAIN and PRAGMA queries can be run here. ' +
            'Use the buttons above the console to change the database.'
          );
        }
        const columns = statement.getColumnNames();
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        results.push({ sql: statement.getSQL(), columns, rows });
      }
    } catch (err) {
      // Abandoning the iterator leaves a statement prepared on the clone, so
      // throw the clone away rather than leaking it across repeated failures.
      try { iter.return?.(); } catch { /* not all builds expose return() */ }
      try { this._scratch.close(); } catch { /* ignore */ }
      this._scratch = null;
      this._scratchRev = -1;
      throw err;
    }
    return results;
  }

  /* -------------------------------------------------------------- writes -- */

  beginSearch(query, params, endpoint) {
    this.run(
      `INSERT INTO searches (query, params, endpoint, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
      [query, JSON.stringify(params ?? {}), endpoint ?? '', new Date().toISOString()]
    );
    return this.scalar('SELECT last_insert_rowid() AS id');
  }

  finishSearch(id, patch) {
    this.run(
      `UPDATE searches
          SET finished_at = ?, returned = ?, inserted = ?, duplicates = ?, status = ?, message = ?
        WHERE id = ?`,
      [
        new Date().toISOString(),
        patch.returned ?? 0,
        patch.inserted ?? 0,
        patch.duplicates ?? 0,
        patch.status ?? 'ok',
        patch.message ?? '',
        id,
      ]
    );
  }

  /**
   * Inserts a batch of normalised articles.
   *
   * Search provenance lives in `article_searches`; this table receives only
   * the seven allowlisted citation fields.
   *
   * @returns {{inserted: number, duplicates: number, titleDuplicates: number, updated: number}}
   */
  saveArticles(articles, {
    searchId = null, overwrite = false,
    dedupeByTitle = false,
  } = {}) {
    let inserted = 0, duplicates = 0, titleDuplicates = 0, updated = 0;

    // Preserve the earliest stored row as the canonical copy for a title.
    // This is deliberately in JavaScript so title normalisation is identical
    // to the in-search rule and is not dependent on SQLite collation details.
    const storedTitles = new Map();
    if (dedupeByTitle) {
      for (const row of this.all('SELECT id, title FROM articles ORDER BY rowid')) {
        const key = titleKey(row.title);
        if (key && !storedTitles.has(key)) storedTitles.set(key, row.id);
      }
    }

    const placeholders = INSERT_COLS.map(() => '?').join(', ');
    const exists = this.db.prepare('SELECT 1 FROM articles WHERE id = ?');
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO articles (${INSERT_COLS.join(', ')})
       VALUES (${placeholders})`);
    const update = this.db.prepare(
      `UPDATE articles SET ${CONTENT_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
    const link = this.db.prepare(
      'INSERT OR IGNORE INTO article_searches (article_id, search_id, position) VALUES (?, ?, ?)');

    const valueFor = (article, col) => {
      const v = article[col];
      return v === undefined ? null : v;
    };

    this.db.exec('BEGIN');
    try {
      articles.forEach((article, i) => {
        const id = article.id;
        if (id === null || id === undefined || id === '') return;

        exists.bind([id]);
        const already = exists.step();
        exists.reset();

        const key = dedupeByTitle ? titleKey(article.title) : '';
        const sameTitleId = key ? storedTitles.get(key) : null;

        if (!already && sameTitleId !== undefined && sameTitleId !== null) {
          titleDuplicates += 1;
          if (searchId != null) link.run([sameTitleId, searchId, i]);
          return;
        } else if (!already) {
          insert.run(INSERT_COLS.map((col) => valueFor(article, col)));
          inserted += 1;
          if (key) storedTitles.set(key, id);
        } else if (overwrite) {
          update.run([...CONTENT_COLS.map((col) => valueFor(article, col)), id]);
          updated += 1;
        } else {
          duplicates += 1;
        }

        if (searchId != null) link.run([id, searchId, i]);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      exists.free();
      insert.free();
      update.free();
      link.free();
    }

    this.touch();
    return { inserted, duplicates, titleDuplicates, updated };
  }

  deleteArticles(ids) {
    if (!ids.length) return 0;
    const chunk = 400;
    let removed = 0;
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const marks = slice.map(() => '?').join(',');
        this.db.run(`DELETE FROM article_searches WHERE article_id IN (${marks})`, slice);
        this.db.run(`DELETE FROM articles WHERE id IN (${marks})`, slice);
        removed += this.db.getRowsModified();
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    this.touch();
    return removed;
  }

  clearSearches() {
    this.db.exec('DELETE FROM article_searches; DELETE FROM searches;');
    this.touch();
  }

  eraseAll() {
    this.db.exec(
      'DROP TABLE IF EXISTS article_searches;' +
      'DROP TABLE IF EXISTS articles;' +
      'DROP TABLE IF EXISTS searches;' +
      'DROP TABLE IF EXISTS meta;'
    );
    this.migrate();
  }

  vacuum() {
    this.db.exec('VACUUM');
    this.touch();
  }

  /* ---------------------------------------------------------------- meta -- */

  setMeta(key, value) {
    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
  }

  getMeta(key) {
    return this.scalar('SELECT value FROM meta WHERE key = ?', [key]);
  }

  /* --------------------------------------------------------- import/save -- */

  export() {
    return this.db.export();
  }

  /** Merges every article and search from another .db file into this one. */
  importBytes(bytes) {
    const other = new this.SQL.Database(new Uint8Array(bytes));
    try {
      other.exec('PRAGMA schema_version');   // throws "file is not a database"

      const otherCols = (() => {
        const res = other.exec('PRAGMA table_info(articles)');
        if (!res.length) throw new Error('That file has no "articles" table.');
        const idx = res[0].columns.indexOf('name');
        return new Set(res[0].values.map((r) => r[idx]));
      })();

      const selectable = ARTICLE_COLUMNS.map((c) => c.key).filter((k) => otherCols.has(k));
      if (!selectable.includes('id')) throw new Error('That file has no "id" column in "articles".');

      const res = other.exec(`SELECT ${selectable.join(', ')} FROM articles`);
      const rows = res.length
        ? res[0].values.map((vals) => Object.fromEntries(res[0].columns.map((c, i) => [c, vals[i]])))
        : [];

      const before = this.count('articles');
      this.saveArticles(rows, { overwrite: false });
      const added = this.count('articles') - before;

      let searchesAdded = 0;
      try {
        const sres = other.exec(
          'SELECT query, params, endpoint, started_at, finished_at, returned, inserted, duplicates, status, message FROM searches'
        );
        if (sres.length) {
          for (const v of sres[0].values) {
            this.db.run(
              `INSERT INTO searches (query, params, endpoint, started_at, finished_at, returned, inserted, duplicates, status, message)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, v
            );
            searchesAdded += 1;
          }
        }
      } catch { /* the other file may not track searches */ }

      this.touch();
      return { articles: rows.length, added, searches: searchesAdded };
    } finally {
      try { other.close(); } catch { /* ignore */ }
    }
  }

  count(table) {
    return Number(this.scalar(`SELECT COUNT(*) AS n FROM ${table}`) ?? 0);
  }

  /* ------------------------------------------------------------ autosave -- */

  touch() {
    this.revision += 1;
    if (this.autosave) this.scheduleSave();
  }

  scheduleSave(delay = 600) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this.save(); }, delay);
  }

  /** Writes the current database to IndexedDB. Errors are reported, not thrown. */
  async save() {
    clearTimeout(this._saveTimer);
    if (this._savePromise) return this._savePromise;
    this._savePromise = (async () => {
      try {
        await idbPut(IDB_KEY, this.db.export());
        return true;
      } catch (err) {
        if (this.onSaveError) this.onSaveError(err);
        return false;
      } finally {
        this._savePromise = null;
      }
    })();
    return this._savePromise;
  }

  async forget() {
    clearTimeout(this._saveTimer);
    try { await idbDelete(IDB_KEY); } catch { /* ignore */ }
  }

  /** Approximate on-disk size of the database, in bytes. */
  byteSize() {
    const pageCount = Number(this.scalar('PRAGMA page_count') ?? 0);
    const pageSize = Number(this.scalar('PRAGMA page_size') ?? 0);
    return pageCount * pageSize;
  }
}

export const idb = { get: idbGet, put: idbPut, delete: idbDelete };
