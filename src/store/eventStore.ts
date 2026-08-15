import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Append-only event log in SQLite — the gateway's source of truth (CQRS+ES).
 * Commands append immutable events; read models are projections rebuilt by
 * replaying the log at boot. Nothing here is ever updated or deleted.
 */

export interface StoredEvent {
  id: number;
  /** ISO timestamp assigned at append time. */
  at: string;
  /** Aggregate stream, e.g. "client:jason-3f2a" or "orchestration:<uuid>". */
  stream: string;
  /** Event type, e.g. "client.created", "orchestration.finished". */
  type: string;
  data: Record<string, unknown>;
}

export class EventStore {
  private db: DatabaseSync | null = null;

  /** dataDir ":memory:" keeps the log purely in RAM (tests). */
  constructor(private readonly dataDir: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db;
    let db: DatabaseSync;
    if (this.dataDir === ':memory:') {
      db = new DatabaseSync(':memory:');
    } else {
      mkdirSync(this.dataDir, { recursive: true });
      db = new DatabaseSync(path.join(this.dataDir, 'events.db'));
      db.exec('PRAGMA journal_mode = WAL;');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        stream TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_stream ON events (stream, id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, id);
    `);
    this.db = db;
    return db;
  }

  append(stream: string, type: string, data: Record<string, unknown>): StoredEvent {
    const db = this.open();
    const at = new Date().toISOString();
    const result = db
      .prepare('INSERT INTO events (at, stream, type, data) VALUES (?, ?, ?, ?)')
      .run(at, stream, type, JSON.stringify(data));
    return { id: Number(result.lastInsertRowid), at, stream, type, data };
  }

  private toEvent(row: Record<string, unknown>): StoredEvent {
    return {
      id: Number(row.id),
      at: String(row.at),
      stream: String(row.stream),
      type: String(row.type),
      data: JSON.parse(String(row.data)) as Record<string, unknown>,
    };
  }

  /** Full log in append order, optionally only types with the given prefix. */
  readAll(typePrefix?: string): StoredEvent[] {
    const db = this.open();
    const rows = typePrefix
      ? db.prepare("SELECT * FROM events WHERE type LIKE ? || '%' ORDER BY id").all(typePrefix)
      : db.prepare('SELECT * FROM events ORDER BY id').all();
    return (rows as Record<string, unknown>[]).map((r) => this.toEvent(r));
  }

  /** Most recent events, newest first (admin audit view). */
  readRecent(limit: number, stream?: string): StoredEvent[] {
    const db = this.open();
    const rows = stream
      ? db.prepare('SELECT * FROM events WHERE stream = ? ORDER BY id DESC LIMIT ?').all(stream, limit)
      : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as Record<string, unknown>[]).map((r) => this.toEvent(r));
  }

  count(): number {
    const row = this.open().prepare('SELECT count(*) AS c FROM events').get() as { c: number };
    return Number(row.c);
  }
}
