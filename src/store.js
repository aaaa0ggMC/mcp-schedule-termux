import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export function fail(code, message, details) { throw new DomainError(code, message, details); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO state VALUES(1,0);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (revision INTEGER PRIMARY KEY, at TEXT NOT NULL, body TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  revision() { return this.db.prepare('SELECT revision FROM state WHERE id=1').get().revision; }
  // Audit trail as an incrementally consumable log: oldest first, so a caller can page forward
  // and reuse the last revision it saw instead of re-reading every entity.
  history(since = 0, offset = 0, limit = 200) {
    const total = this.db.prepare('SELECT count(*) AS n FROM history WHERE revision > ?').get(since).n;
    const items = this.db.prepare('SELECT revision, at, body FROM history WHERE revision > ? ORDER BY revision LIMIT ? OFFSET ?')
      .all(since, limit, offset).map(row => ({ revision: row.revision, at: row.at, ...JSON.parse(row.body) }));
    return { items, total };
  }
  snapshot() { return new Map(this.db.prepare('SELECT id,body FROM entities ORDER BY id').all().map(r => [r.id, JSON.parse(r.body)])); }
  read(fn) {
    this.db.exec('BEGIN');
    try { const result = fn(this.snapshot(), this.revision()); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  transact(kind, input, dryRun, work) {
    const hash = createHash('sha256').update(JSON.stringify(canonical({kind, input}))).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.requestId && !dryRun) {
        const old = this.db.prepare('SELECT hash,body FROM receipts WHERE id=?').get(input.requestId);
        if (old) {
          if (old.hash !== hash) fail('REQUEST_ID_REUSED', 'requestId 已用于其他参数，请换一个 requestId');
          this.db.exec('COMMIT'); return { ...JSON.parse(old.body), replayed: true };
        }
      }
      const revision = this.revision();
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
        fail('REVISION_CONFLICT', '数据已变更，请重新查询或使用新的版本', {expected: input.expectedRevision, actual: revision});
      const before = this.snapshot();
      const next = structuredClone(before);
      const result = work(next);
      const changes = [...next].filter(([id, e]) => JSON.stringify(e) !== JSON.stringify(before.get(id)))
        .map(([id, after]) => ({id, before: before.get(id) ?? null, after}));
      const nextRevision = revision + (!dryRun && changes.length ? 1 : 0);
      const response = { ...result, revision: nextRevision, baseRevision: revision, dryRun, changed: changes.length };
      // A write that asks for the changes view wants the diff of this call, which is only known here.
      const pending = result?.query;
      if (pending && Object.hasOwn(pending.views, 'changes')) {
        const items = changes.length ? [{revision: nextRevision, at: new Date().toISOString(), kind, changes}] : [];
        const {offset, limit} = pending.pagination.changes;
        pending.views.changes = items.slice(offset, offset + limit);
        pending.pagination.changes = {total: items.length, offset, limit, hasMore: offset + limit < items.length};
      }
      if (dryRun) { this.db.exec('ROLLBACK'); return response; }
      const put = this.db.prepare('INSERT INTO entities(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
      for (const change of changes) put.run(change.id, JSON.stringify(change.after));
      if (changes.length) {
        this.db.prepare('UPDATE state SET revision=? WHERE id=1').run(nextRevision);
        this.db.prepare('INSERT INTO history VALUES(?,?,?)').run(nextRevision, new Date().toISOString(), JSON.stringify({kind, changes}));
      }
      if (input.requestId) this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.requestId, hash, JSON.stringify(response));
      this.db.exec('COMMIT'); return response;
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
}
