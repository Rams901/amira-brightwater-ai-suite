import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type {
  AvailabilitySchedule,
  ProcessedCallRecord,
} from "../../shared/types.js";
import { AvailabilityScheduleSchema } from "../../shared/schemas.js";
import { IS_SERVERLESS, readProjectJson } from "../dataFiles.js";

const require = createRequire(import.meta.url);

export function hashCallPayload(rawCall: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(rawCall))
    .digest("hex");
}

export function loadDefaultAvailabilityFromDisk(): AvailabilitySchedule {
  return AvailabilityScheduleSchema.parse(
    readProjectJson<unknown>("availability.json")
  );
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

function tryOpenSqlite(dbPath: string): SqliteDatabaseLike | null {
  try {
    const sqliteMod = require("node:sqlite") as {
      DatabaseSync: new (p: string) => SqliteDatabaseLike;
    };
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    return new sqliteMod.DatabaseSync(dbPath);
  } catch {
    return null;
  }
}

/**
 * Persistence & Idempotency Ledger.
 * - Locally: `data/brightwater_ops.sqlite` via `node:sqlite`.
 * - Netlify / Serverless: `/tmp/brightwater_ops.sqlite` via `node:sqlite`, with an automatic
 *   in-memory Map fallback if a cloud runtime ever runs on Node < 22.5.
 */
export class LedgerStore {
  private db: SqliteDatabaseLike | null;
  private memoryRecords = new Map<string, ProcessedCallRecord>();
  private memoryAvailability: AvailabilitySchedule;
  private initialAvailability: AvailabilitySchedule;

  constructor(options?: { dbPath?: string; initialAvailability?: AvailabilitySchedule }) {
    const defaultDbPath = IS_SERVERLESS
      ? path.join("/tmp", "brightwater_ops.sqlite")
      : path.resolve(process.cwd(), "data", "brightwater_ops.sqlite");

    const dbPath = options?.dbPath ?? defaultDbPath;

    this.initialAvailability =
      options?.initialAvailability ?? loadDefaultAvailabilityFromDisk();
    this.memoryAvailability = structuredClone(this.initialAvailability);

    this.db = tryOpenSqlite(dbPath);
    if (this.db) {
      this.initSchema();
    }
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_records (
        call_id TEXT PRIMARY KEY,
        transcript_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        booked_slot TEXT,
        processed_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS availability_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schedule_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const existing = this.db
      .prepare("SELECT schedule_json FROM availability_state WHERE id = 1")
      .get() as { schedule_json: string } | undefined;

    if (!existing) {
      this.saveAvailability(this.initialAvailability);
    }
  }

  getAvailability(): AvailabilitySchedule {
    if (!this.db) {
      return AvailabilityScheduleSchema.parse(structuredClone(this.memoryAvailability));
    }
    const row = this.db
      .prepare("SELECT schedule_json FROM availability_state WHERE id = 1")
      .get() as { schedule_json: string } | undefined;
    if (!row) return structuredClone(this.initialAvailability);
    return AvailabilityScheduleSchema.parse(JSON.parse(row.schedule_json));
  }

  saveAvailability(schedule: AvailabilitySchedule): void {
    this.memoryAvailability = structuredClone(schedule);
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO availability_state (id, schedule_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET schedule_json = excluded.schedule_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(schedule), now);
  }

  resetToBaseline(): AvailabilitySchedule {
    this.memoryRecords.clear();
    const cleanCopy = structuredClone(this.initialAvailability);
    if (this.db) {
      this.db.exec("DELETE FROM call_records;");
    }
    this.saveAvailability(cleanCopy);
    return cleanCopy;
  }

  setBaselineAvailability(schedule: AvailabilitySchedule): AvailabilitySchedule {
    this.initialAvailability = structuredClone(schedule);
    this.saveAvailability(this.initialAvailability);
    return this.getAvailability();
  }

  resetAll(customAvailability?: AvailabilitySchedule): AvailabilitySchedule {
    const nextAvail = customAvailability ?? loadDefaultAvailabilityFromDisk();
    this.initialAvailability = structuredClone(nextAvail);
    this.memoryRecords.clear();
    if (this.db) {
      this.db.exec("DELETE FROM call_records;");
    }
    this.saveAvailability(nextAvail);
    return nextAvail;
  }

  getRecordByCallId(callId: string): ProcessedCallRecord | null {
    if (!this.db) {
      return this.memoryRecords.get(callId) ?? null;
    }
    const row = this.db
      .prepare("SELECT record_json FROM call_records WHERE call_id = ?")
      .get(callId) as { record_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.record_json) as ProcessedCallRecord;
  }

  listRecords(): ProcessedCallRecord[] {
    if (!this.db) {
      return Array.from(this.memoryRecords.values()).reverse();
    }
    const rows = this.db
      .prepare("SELECT record_json FROM call_records ORDER BY rowid DESC")
      .all() as Array<{ record_json: string }>;
    return rows.map((r) => JSON.parse(r.record_json) as ProcessedCallRecord);
  }

  upsertRecord(record: ProcessedCallRecord): void {
    this.memoryRecords.set(record.extracted.call_id, record);
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO call_records (call_id, transcript_sha256, status, booked_slot, processed_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET
           transcript_sha256 = excluded.transcript_sha256,
           status = excluded.status,
           booked_slot = excluded.booked_slot,
           processed_at = excluded.processed_at,
           record_json = excluded.record_json`
      )
      .run(
        record.extracted.call_id,
        record.transcript_sha256,
        record.status,
        record.booked_slot,
        record.processed_at,
        JSON.stringify(record)
      );
  }

  close(): void {
    this.db?.close();
  }
}
