import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Alert, SensorEvent, Severity } from '@vigil/core';

/**
 * Read-only queries over the local vigil.db, for the MCP pull surface: what
 * a Vigil SOC agent may ask the endpoint. The store validates every row
 * against the same zod schemas the app wrote them with, and opens its
 * connection read-only — SQLite itself refuses anything that smells like a
 * write, so no tool can be talked into changing the machine's records.
 */
export class AlertStore {
  private readonly db: DatabaseSync;
  private readonly byIdStmt: StatementSync;
  private readonly recentStmt: StatementSync;
  private readonly recentOfSeverityStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.byIdStmt = db.prepare('SELECT body FROM alerts WHERE id = ?');
    this.recentStmt = db.prepare(
      'SELECT body FROM alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?',
    );
    this.recentOfSeverityStmt = db.prepare(
      'SELECT body FROM alerts WHERE created_at >= ? AND severity = ? ORDER BY created_at DESC LIMIT ?',
    );
  }

  /**
   * Open a database file read-only. The whole point of the pull surface is
   * that the SOC's agents never write; SQLite enforces it below us.
   */
  static openReadOnly(path: string): AlertStore {
    return new AlertStore(new DatabaseSync(path, { readOnly: true }));
  }

  /** Alerts raised since `sinceMs` (epoch ms), newest first. */
  recent(q: { sinceMs: number; severity?: Severity | undefined; limit: number }): Alert[] {
    const rows =
      q.severity === undefined
        ? this.recentStmt.all(q.sinceMs, q.limit)
        : this.recentOfSeverityStmt.all(q.sinceMs, q.severity, q.limit);
    return rows.map((row) => Alert.parse(JSON.parse((row as { body: string }).body)));
  }

  /** One alert by id, or undefined when the SOC names one we never raised. */
  byId(id: string): Alert | undefined {
    const row = this.byIdStmt.get(id) as { body: string } | undefined;
    return row === undefined ? undefined : Alert.parse(JSON.parse(row.body));
  }

  /** The events behind an alert — its evidence, oldest first. */
  evidence(alert: Alert, limit: number): SensorEvent[] {
    const ids = alert.eventIds.slice(0, limit);
    if (ids.length === 0) return [];
    // The bound count varies per alert, so the statement is built per call.
    const marks = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT body, ts FROM events WHERE id IN (${marks}) ORDER BY ts ASC`)
      .all(...ids) as Array<{ body: string }>;
    return rows.map((row) => SensorEvent.parse(JSON.parse(row.body)));
  }

  close(): void {
    this.db.close();
  }
}

/** The severity filter the list tool offers, straight from the core enum. */
export const SEVERITIES = Severity.options;
