import { Alert, Rule } from '@vigil/core';
import type { Alert as AlertType, Rule as RuleType } from '@vigil/core';

/**
 * An alert window read from the local store. `unreadable` counts rows whose
 * body no longer parses as the current schema — reported, never silently
 * dropped: a corrupt row must not shrink the export unnoticed.
 */
export interface AlertWindow {
  alerts: AlertType[];
  ruleTags: (ruleId: string) => { readonly tags: readonly string[] } | undefined;
  unreadable: number;
}

export interface WindowBounds {
  /** Inclusive lower bound on alert createdAt (epoch ms). */
  sinceMs?: number;
  /** Exclusive upper bound on alert createdAt (epoch ms). */
  untilMs?: number;
}

/** The slice of Node's SQLite driver the window reader uses; reads and close only. */
interface ReadOnlyDatabase {
  prepare(sql: string): { all: (...params: number[]) => unknown[] };
  close(): void;
}

interface BodyRow {
  body: unknown;
}

function isBodyRow(row: unknown): row is BodyRow {
  return typeof row === 'object' && row !== null && 'body' in row;
}

function parseAlertBody(body: string): AlertType | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = Alert.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function parseRuleBody(body: string): RuleType | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = Rule.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

type DatabaseSyncCtor = new (path: string, options: { readOnly: boolean }) => ReadOnlyDatabase;

/**
 * Open the store read-only — the app holds the write side, and WAL keeps
 * concurrent reads safe. The driver loads lazily: only reading a database
 * needs Node's built-in, so this module imports anywhere.
 */
async function openReadOnlyDatabase(dbPath: string): Promise<ReadOnlyDatabase> {
  let DatabaseSync: DatabaseSyncCtor;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (cause) {
    throw new Error('Reading the local store needs Node with node:sqlite (22.13+).', { cause });
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (cause) {
    throw new Error(`Unable to open the local store read-only: ${dbPath}`, { cause });
  }
}

/**
 * Read the rules table so the bulk export can lift MITRE tags exactly like
 * the live push does. A rule row that fails to parse is skipped — its alerts
 * simply export without `mitre_predictions`.
 */
function readRuleTags(db: ReadOnlyDatabase): Map<string, RuleType> {
  const rules = new Map<string, RuleType>();
  for (const row of db.prepare('SELECT body FROM rules').all()) {
    if (!isBodyRow(row) || typeof row.body !== 'string') continue;
    const rule = parseRuleBody(row.body);
    if (rule) rules.set(rule.id, rule);
  }
  return rules;
}

/**
 * The supplied alerts source for the bulk path: the machine's own
 * `vigil.db`, read one window at a time. Rows come back in createdAt order,
 * so the same window always exports the same JSONL.
 */
export async function readAlertWindow(
  dbPath: string,
  bounds: WindowBounds = {},
): Promise<AlertWindow> {
  const clauses: string[] = [];
  const params: number[] = [];
  if (bounds.sinceMs !== undefined) {
    clauses.push('created_at >= ?');
    params.push(bounds.sinceMs);
  }
  if (bounds.untilMs !== undefined) {
    clauses.push('created_at < ?');
    params.push(bounds.untilMs);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

  const db = await openReadOnlyDatabase(dbPath);
  try {
    const select = db.prepare(`SELECT body FROM alerts${where} ORDER BY created_at ASC`);
    const rows = params.length ? select.all(...params) : select.all();

    const alerts: AlertType[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const body = isBodyRow(row) ? row.body : undefined;
      if (typeof body !== 'string') {
        unreadable += 1;
        continue;
      }
      const alert = parseAlertBody(body);
      if (alert) alerts.push(alert);
      else unreadable += 1;
    }

    const rules = readRuleTags(db);
    return {
      alerts,
      unreadable,
      ruleTags: (ruleId) => {
        const rule = rules.get(ruleId);
        return rule ? { tags: rule.tags } : undefined;
      },
    };
  } finally {
    db.close();
  }
}
