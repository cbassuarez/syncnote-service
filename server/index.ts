import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Database from "better-sqlite3";
import cors from "cors";
import {
  createHash,
  createPrivateKey,
  createSign,
  randomUUID,
} from "crypto";
import express from "express";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from "fs";
import http from "http";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { validateWithToolchains, type DeepValidationRequest } from "./validation";

type Snapshot = {
  text: string;
  lastModified: string;
  deviceID: string;
  version: number;
  language?: string | null;
  snapshotID?: string | null;
  checkpointReason?: string | null;
  checkpointSource?: string | null;
  byteSize?: number | null;
  pinTitle?: string | null;
  pinNote?: string | null;
  milestoneLabel?: string | null;
  milestoneKind?: string | null;
  sessionID?: string | null;
  restoreGroupID?: string | null;
  changeSummary?: SnapshotChangeSummary | null;
};

type SnapshotPayload = Partial<Snapshot>;

type SnapshotChangeSummary = {
  linesChanged: number;
  characterDelta: number;
  byteDelta?: number | null;
};

type SnapshotRecord = {
  snapshotID: string;
  text: string;
  createdAt: string;
  deviceID: string;
  language?: string | null;
  byteSize?: number | null;
  reason?: string | null;
  source?: string | null;
  pinTitle?: string | null;
  pinNote?: string | null;
  milestoneLabel?: string | null;
  milestoneKind?: string | null;
  sessionID?: string | null;
  restoreGroupID?: string | null;
  changeSummary?: SnapshotChangeSummary | null;
};

type SnapshotCursor = {
  createdAtUnix: number;
  snapshotID: string;
};

type PromotionalOfferSigningConfig = {
  bundleId: string;
  keyId: string;
  privateKey: string;
  allowedOfferIDs: Set<string>;
  allowedProductIDs: Set<string>;
};

type PromotionalOfferSignatureRequest = {
  productID?: string;
  offerID?: string;
};

type Client = {
  ws: WebSocket;
  padId: string;
  isAlive: boolean;
  lastPongAt: number;
};

type PadRow = {
  pad_id: string;
  text: string;
  last_modified: string;
  device_id: string;
  version: number;
  language: string | null;
  snapshot_id: string | null;
  checkpoint_reason: string | null;
  checkpoint_source: string | null;
  byte_size: number | null;
  pin_title: string | null;
  pin_note: string | null;
  milestone_label: string | null;
  milestone_kind: string | null;
  session_id: string | null;
  restore_group_id: string | null;
  change_summary_json: string | null;
  updated_at_unix: number;
};

type SnapshotRow = {
  snapshot_id: string;
  pad_id: string;
  text: string;
  created_at: string;
  created_at_unix: number;
  device_id: string;
  language: string | null;
  byte_size: number | null;
  reason: string | null;
  source: string | null;
  pin_title: string | null;
  pin_note: string | null;
  is_pinned: number;
  milestone_label: string | null;
  milestone_kind: string | null;
  session_id: string | null;
  restore_group_id: string | null;
  change_summary_json: string | null;
};

type MetadataRow = {
  value: string;
};

type RetentionPolicy = {
  name: "normal" | "aggressive" | "critical";
  nonPinnedRetentionDays: number;
  nonPinnedMaxPerPad: number;
  pinnedMaxPerPad: number;
};

type BackupConfig = {
  enabled: boolean;
  client: S3Client | null;
  bucket: string | null;
  keyPrefix: string;
};

type SnapshotSendMode = "scheduled" | "forced";

type SnapshotCreatedAtRow = {
  created_at_unix: number;
};

const defaultPromotionalOfferProductIDs = ["CHRNPROANNUALLY"];
const invisibleSeparator = "\u2063";
const maxSnapshotBytes = 1_048_576;

const diskWarnThresholdPercent = 70;
const diskAggressiveThresholdPercent = 85;
const diskCriticalThresholdPercent = 95;

const maintenanceIntervalMs = 60 * 60 * 1_000;
const backupIntervalMs = 6 * 60 * 60 * 1_000;
const backupVerifyIntervalMs = 24 * 60 * 60 * 1_000;
const schedulerTickIntervalMs = 60 * 1_000;

const wsHeartbeatIntervalMs = 25_000;
const wsStaleTimeoutMs = 75_000;
const scheduledAutoTimelinePromotionIntervalSeconds = 5 * 60;

const backupKeepLocalDays = Number(process.env.BACKUP_KEEP_LOCAL_DAYS || "14");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const dataDir = process.env.DATA_DIR?.trim() || "/var/data";
const dbPath = process.env.SQLITE_PATH?.trim() || path.join(dataDir, "chrony-sync.sqlite");
const backupDir = path.join(dataDir, "backups");

mkdirSync(dataDir, { recursive: true });
mkdirSync(path.dirname(dbPath), { recursive: true });
mkdirSync(backupDir, { recursive: true });

const db = new Database(dbPath);
configureDatabase(db);
migrateSchema(db);
assertIntegrity(db);

const backupConfig = buildBackupConfig();

const statements = {
  selectPad: db.prepare(
    `SELECT pad_id, text, last_modified, device_id, version, language, snapshot_id,
            checkpoint_reason, checkpoint_source, byte_size, pin_title, pin_note,
            milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
            updated_at_unix
     FROM pads
     WHERE pad_id = ?`
  ),
  upsertPad: db.prepare(
    `INSERT INTO pads (
       pad_id, text, last_modified, device_id, version, language, snapshot_id,
       checkpoint_reason, checkpoint_source, byte_size, pin_title, pin_note,
       milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
       updated_at_unix
     ) VALUES (
       @pad_id, @text, @last_modified, @device_id, @version, @language, @snapshot_id,
       @checkpoint_reason, @checkpoint_source, @byte_size, @pin_title, @pin_note,
       @milestone_label, @milestone_kind, @session_id, @restore_group_id, @change_summary_json,
       @updated_at_unix
     )
     ON CONFLICT(pad_id) DO UPDATE SET
       text = excluded.text,
       last_modified = excluded.last_modified,
       device_id = excluded.device_id,
       version = excluded.version,
       language = excluded.language,
       snapshot_id = excluded.snapshot_id,
       checkpoint_reason = excluded.checkpoint_reason,
       checkpoint_source = excluded.checkpoint_source,
       byte_size = excluded.byte_size,
       pin_title = excluded.pin_title,
       pin_note = excluded.pin_note,
       milestone_label = excluded.milestone_label,
       milestone_kind = excluded.milestone_kind,
       session_id = excluded.session_id,
       restore_group_id = excluded.restore_group_id,
       change_summary_json = excluded.change_summary_json,
       updated_at_unix = excluded.updated_at_unix`
  ),
  deletePad: db.prepare(`DELETE FROM pads WHERE pad_id = ?`),
  insertSnapshot: db.prepare(
    `INSERT OR REPLACE INTO snapshots (
      snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
      language, byte_size, reason, source, pin_title, pin_note,
      milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
      is_pinned
    ) VALUES (
      @snapshot_id, @pad_id, @text, @created_at, @created_at_unix, @device_id,
      @language, @byte_size, @reason, @source, @pin_title, @pin_note,
      @milestone_label, @milestone_kind, @session_id, @restore_group_id, @change_summary_json,
      @is_pinned
    )`
  ),
  selectSnapshotById: db.prepare(
    `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note,
            milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
            is_pinned
     FROM snapshots
     WHERE pad_id = ? AND snapshot_id = ?`
  ),
  selectLatestScheduledAutoSnapshotCreatedAt: db.prepare(
    `SELECT created_at_unix
     FROM snapshots
     WHERE pad_id = ?
       AND is_pinned = 0
       AND reason = 'autoEditBatch'
       AND source = 'local'
     ORDER BY created_at_unix DESC, snapshot_id DESC
     LIMIT 1`
  ),
  listSnapshotsFirstPage: db.prepare(
    `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note,
            milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
            is_pinned
     FROM snapshots
     WHERE pad_id = @pad_id
     ORDER BY created_at_unix DESC, snapshot_id DESC
     LIMIT @limit`
  ),
  listSnapshotsAfterCursor: db.prepare(
    `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note,
            milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
            is_pinned
     FROM snapshots
     WHERE pad_id = @pad_id
       AND (
         created_at_unix < @created_at_unix
         OR (created_at_unix = @created_at_unix AND snapshot_id < @snapshot_id)
       )
     ORDER BY created_at_unix DESC, snapshot_id DESC
     LIMIT @limit`
  ),
  deleteOldNonPinnedSnapshots: db.prepare(
    `DELETE FROM snapshots
     WHERE is_pinned = 0 AND created_at_unix < ?`
  ),
  trimNonPinnedByPad: db.prepare(
    `DELETE FROM snapshots
     WHERE snapshot_id IN (
       SELECT snapshot_id FROM (
         SELECT snapshot_id,
                ROW_NUMBER() OVER (
                  PARTITION BY pad_id
                  ORDER BY created_at_unix DESC, snapshot_id DESC
                ) AS rn
         FROM snapshots
         WHERE is_pinned = 0
       ) ranked
       WHERE ranked.rn > ?
     )`
  ),
  trimPinnedByPad: db.prepare(
    `DELETE FROM snapshots
     WHERE snapshot_id IN (
       SELECT snapshot_id FROM (
         SELECT snapshot_id,
                ROW_NUMBER() OVER (
                  PARTITION BY pad_id
                  ORDER BY created_at_unix DESC, snapshot_id DESC
                ) AS rn
         FROM snapshots
         WHERE is_pinned = 1
       ) ranked
       WHERE ranked.rn > ?
     )`
  ),
  getMetadata: db.prepare(`SELECT value FROM metadata WHERE key = ?`),
  setMetadata: db.prepare(
    `INSERT INTO metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ),
};

ensureGlobalVersionCounterRow();

let lastMaintenanceRunAt = readMetadataDate("last_maintenance_run_at");
let lastBackupRunAt = readMetadataDate("last_backup_run_at");
let lastBackupVerifyAt = readMetadataDate("last_backup_verify_at");
let lastBackupErrorMessage = readMetadataString("last_backup_error") || null;
let lastDiskPressureLevel: RetentionPolicy["name"] = retentionPolicyForDiskUsage(
  readDiskUsagePercent()
).name;

let schedulerInFlight = false;

function configureDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  database.pragma("wal_autocheckpoint = 1000");
  database.pragma("foreign_keys = ON");
}

function migrateSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pads (
      pad_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      last_modified TEXT NOT NULL,
      device_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      language TEXT,
      snapshot_id TEXT,
      checkpoint_reason TEXT,
      checkpoint_source TEXT,
      byte_size INTEGER,
      pin_title TEXT,
      pin_note TEXT,
      milestone_label TEXT,
      milestone_kind TEXT,
      session_id TEXT,
      restore_group_id TEXT,
      change_summary_json TEXT,
      updated_at_unix INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id TEXT PRIMARY KEY,
      pad_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_unix INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      language TEXT,
      byte_size INTEGER,
      reason TEXT,
      source TEXT,
      pin_title TEXT,
      pin_note TEXT,
      milestone_label TEXT,
      milestone_kind TEXT,
      session_id TEXT,
      restore_group_id TEXT,
      change_summary_json TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(pad_id) REFERENCES pads(pad_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_pad_created
      ON snapshots(pad_id, created_at_unix DESC, snapshot_id DESC);

    CREATE INDEX IF NOT EXISTS idx_snapshots_pinned_pad_created
      ON snapshots(pad_id, is_pinned, created_at_unix DESC, snapshot_id DESC);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  ensureColumn("pads", "language", "TEXT");
  ensureColumn("pads", "snapshot_id", "TEXT");
  ensureColumn("pads", "checkpoint_reason", "TEXT");
  ensureColumn("pads", "checkpoint_source", "TEXT");
  ensureColumn("pads", "byte_size", "INTEGER");
  ensureColumn("pads", "pin_title", "TEXT");
  ensureColumn("pads", "pin_note", "TEXT");
  ensureColumn("pads", "milestone_label", "TEXT");
  ensureColumn("pads", "milestone_kind", "TEXT");
  ensureColumn("pads", "session_id", "TEXT");
  ensureColumn("pads", "restore_group_id", "TEXT");
  ensureColumn("pads", "change_summary_json", "TEXT");
  ensureColumn("pads", "updated_at_unix", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn("snapshots", "language", "TEXT");
  ensureColumn("snapshots", "byte_size", "INTEGER");
  ensureColumn("snapshots", "reason", "TEXT");
  ensureColumn("snapshots", "source", "TEXT");
  ensureColumn("snapshots", "pin_title", "TEXT");
  ensureColumn("snapshots", "pin_note", "TEXT");
  ensureColumn("snapshots", "milestone_label", "TEXT");
  ensureColumn("snapshots", "milestone_kind", "TEXT");
  ensureColumn("snapshots", "session_id", "TEXT");
  ensureColumn("snapshots", "restore_group_id", "TEXT");
  ensureColumn("snapshots", "change_summary_json", "TEXT");
  ensureColumn("snapshots", "is_pinned", "INTEGER NOT NULL DEFAULT 0");
}

function ensureColumn(tableName: "pads" | "snapshots", columnName: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const hasColumn = rows.some((row) => row.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function assertIntegrity(database: Database.Database): void {
  const row = database.prepare("PRAGMA integrity_check").pluck().get() as string | undefined;
  if (!row || row.toLowerCase() !== "ok") {
    throw new Error(`SQLite integrity check failed: `);
  }
}

function ensureGlobalVersionCounterRow(): void {
  db.prepare(
    `INSERT INTO metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`
  ).run("global_version_counter", "0");
}

function parseCSVSet(rawValue: string | undefined, fallback: string[] = []): Set<string> {
  const values = (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(values.length > 0 ? values : fallback);
}

function normalizePrivateKey(rawValue: string | undefined): string | null {
  if (!rawValue) {
    return null;
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return trimmed.replace(/\\n/g, "\n");
  }

  try {
    return Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function promotionalOfferSigningConfig(): PromotionalOfferSigningConfig | null {
  const keyId = process.env.APPLE_SUBSCRIPTION_KEY_ID?.trim();
  const bundleId = process.env.APPLE_BUNDLE_ID?.trim() || "com.StageDevices.chrony";
  const privateKey =
    normalizePrivateKey(process.env.APPLE_SUBSCRIPTION_PRIVATE_KEY) ??
    normalizePrivateKey(process.env.APPLE_SUBSCRIPTION_PRIVATE_KEY_BASE64);

  if (!keyId || !privateKey) {
    return null;
  }

  try {
    createPrivateKey(privateKey);
  } catch {
    return null;
  }

  return {
    bundleId,
    keyId,
    privateKey,
    allowedOfferIDs: parseCSVSet(process.env.APPLE_PROMOTIONAL_OFFER_IDS),
    allowedProductIDs: parseCSVSet(
      process.env.APPLE_PROMOTIONAL_OFFER_PRODUCT_IDS,
      defaultPromotionalOfferProductIDs
    ),
  };
}

function createPromotionalOfferSignature(
  config: PromotionalOfferSigningConfig,
  productID: string,
  offerID: string,
  appAccountToken = ""
): { keyID: string; nonce: string; signature: string; timestamp: number } {
  const nonce = randomUUID().toLowerCase();
  const timestamp = Date.now();
  const payload = [
    config.bundleId,
    config.keyId,
    productID,
    offerID,
    appAccountToken.toLowerCase(),
    nonce,
    String(timestamp),
  ].join(invisibleSeparator);

  const signer = createSign("SHA256");
  signer.update(payload);
  signer.end();

  return {
    keyID: config.keyId,
    nonce,
    signature: signer.sign(createPrivateKey(config.privateKey)).toString("base64"),
    timestamp,
  };
}

function normalizeETag(tag: string): string {
  return tag.trim().replace(/^W\//i, "");
}

function etagMatches(ifNoneMatchHeader: string, currentETag: string): boolean {
  const normalizedCurrent = normalizeETag(currentETag);
  return ifNoneMatchHeader
    .split(",")
    .map((part) => part.trim())
    .some((candidate) => candidate === "*" || normalizeETag(candidate) === normalizedCurrent);
}

function snapshotETag(snapshot: Snapshot): string {
  const digest = createHash("sha1")
    .update(String(snapshot.version))
    .update(invisibleSeparator)
    .update(snapshot.lastModified)
    .update(invisibleSeparator)
    .update(snapshot.deviceID)
    .update(invisibleSeparator)
    .update(snapshot.text)
    .digest("hex");

  return `"${digest}"`;
}

function parseChangeSummary(raw: string | null): SnapshotChangeSummary | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SnapshotChangeSummary;
    if (
      typeof parsed.linesChanged !== "number" ||
      !Number.isFinite(parsed.linesChanged) ||
      typeof parsed.characterDelta !== "number" ||
      !Number.isFinite(parsed.characterDelta)
    ) {
      return null;
    }

    if (
      parsed.byteDelta != null &&
      (typeof parsed.byteDelta !== "number" || !Number.isFinite(parsed.byteDelta))
    ) {
      return null;
    }

    return {
      linesChanged: Math.floor(parsed.linesChanged),
      characterDelta: Math.floor(parsed.characterDelta),
      byteDelta: parsed.byteDelta == null ? null : Math.floor(parsed.byteDelta),
    };
  } catch {
    return null;
  }
}

function rowToSnapshot(row: PadRow): Snapshot {
  return {
    text: row.text,
    lastModified: row.last_modified,
    deviceID: row.device_id,
    version: row.version,
    language: row.language,
    snapshotID: row.snapshot_id,
    checkpointReason: row.checkpoint_reason,
    checkpointSource: row.checkpoint_source,
    byteSize: row.byte_size,
    pinTitle: row.pin_title,
    pinNote: row.pin_note,
    milestoneLabel: row.milestone_label,
    milestoneKind: row.milestone_kind,
    sessionID: row.session_id,
    restoreGroupID: row.restore_group_id,
    changeSummary: parseChangeSummary(row.change_summary_json),
  };
}

function rowToSnapshotRecord(row: SnapshotRow): SnapshotRecord {
  return {
    snapshotID: row.snapshot_id,
    text: row.text,
    createdAt: row.created_at,
    deviceID: row.device_id,
    language: row.language,
    byteSize: row.byte_size,
    reason: row.reason,
    source: row.source,
    pinTitle: row.pin_title,
    pinNote: row.pin_note,
    milestoneLabel: row.milestone_label,
    milestoneKind: row.milestone_kind,
    sessionID: row.session_id,
    restoreGroupID: row.restore_group_id,
    changeSummary: parseChangeSummary(row.change_summary_json),
  };
}

function serializeChangeSummary(value: SnapshotChangeSummary | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return JSON.stringify({
    linesChanged: Math.floor(value.linesChanged),
    characterDelta: Math.floor(value.characterDelta),
    byteDelta: value.byteDelta == null ? null : Math.floor(value.byteDelta),
  });
}

function readMetadataString(key: string): string | null {
  const row = statements.getMetadata.get(key) as MetadataRow | undefined;
  return row?.value ?? null;
}

function writeMetadataString(key: string, value: string): void {
  statements.setMetadata.run(key, value);
}

function readMetadataNumber(key: string): number | null {
  const raw = readMetadataString(key);
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

function writeMetadataNumber(key: string, value: number): void {
  writeMetadataString(key, String(value));
}

function readMetadataDate(key: string): Date | null {
  const raw = readMetadataString(key);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function writeMetadataDate(key: string, date: Date): void {
  writeMetadataString(key, date.toISOString());
}

function nextGlobalVersion(): number {
  const current = readMetadataNumber("global_version_counter") ?? 0;
  const next = current + 1;
  writeMetadataNumber("global_version_counter", next);
  return next;
}

function currentGlobalVersion(): number {
  return readMetadataNumber("global_version_counter") ?? 0;
}

function writePadSnapshot(padId: string, snapshot: Snapshot): void {
  statements.upsertPad.run({
    pad_id: padId,
    text: snapshot.text,
    last_modified: snapshot.lastModified,
    device_id: snapshot.deviceID,
    version: snapshot.version,
    language: snapshot.language ?? null,
    snapshot_id: snapshot.snapshotID ?? null,
    checkpoint_reason: snapshot.checkpointReason ?? null,
    checkpoint_source: snapshot.checkpointSource ?? null,
    byte_size: snapshot.byteSize ?? Buffer.byteLength(snapshot.text, "utf8"),
    pin_title: snapshot.pinTitle ?? null,
    pin_note: snapshot.pinNote ?? null,
    milestone_label: snapshot.milestoneLabel ?? null,
    milestone_kind: snapshot.milestoneKind ?? null,
    session_id: snapshot.sessionID ?? null,
    restore_group_id: snapshot.restoreGroupID ?? null,
    change_summary_json: serializeChangeSummary(snapshot.changeSummary),
    updated_at_unix: Math.floor(Date.now() / 1_000),
  });
}

function ensureSnapshot(padId: string): Snapshot {
  const row = statements.selectPad.get(padId) as PadRow | undefined;
  if (row) {
    return rowToSnapshot(row);
  }

  const snapshot: Snapshot = {
    text: "",
    lastModified: new Date().toISOString(),
    deviceID: "server",
    version: currentGlobalVersion(),
    language: null,
    snapshotID: null,
    checkpointReason: null,
    checkpointSource: null,
    byteSize: 0,
    pinTitle: null,
    pinNote: null,
    milestoneLabel: null,
    milestoneKind: null,
    sessionID: null,
    restoreGroupID: null,
    changeSummary: null,
  };

  writePadSnapshot(padId, snapshot);
  return snapshot;
}

function buildSnapshotFromPayload(payload: SnapshotPayload): {
  snapshot: Snapshot;
  receivedBytes: number;
} {
  const payloadText = typeof payload.text === "string" ? payload.text : "";
  const payloadDateRaw = typeof payload.lastModified === "string" ? payload.lastModified : "";
  const payloadDeviceID = typeof payload.deviceID === "string" ? payload.deviceID : "";

  if (typeof payload.text !== "string" || !payloadDateRaw || !payloadDeviceID) {
    throw new Error("Invalid snapshot payload");
  }

  const incomingDate = new Date(payloadDateRaw);
  if (Number.isNaN(incomingDate.getTime())) {
    throw new Error("Invalid lastModified");
  }

  const normalizedDate = incomingDate.toISOString();
  const receivedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const byteSize =
    typeof payload.byteSize === "number" && Number.isFinite(payload.byteSize)
      ? Math.max(0, Math.floor(payload.byteSize))
      : Buffer.byteLength(payloadText, "utf8");

  const snapshot: Snapshot = {
    text: payloadText,
    lastModified: normalizedDate,
    deviceID: payloadDeviceID,
    version: typeof payload.version === "number" && Number.isFinite(payload.version) ? payload.version : 0,
    language: typeof payload.language === "string" ? payload.language : null,
    snapshotID: typeof payload.snapshotID === "string" && payload.snapshotID.trim() ? payload.snapshotID : null,
    checkpointReason:
      typeof payload.checkpointReason === "string" && payload.checkpointReason.trim()
        ? payload.checkpointReason
        : null,
    checkpointSource:
      typeof payload.checkpointSource === "string" && payload.checkpointSource.trim()
        ? payload.checkpointSource
        : null,
    byteSize,
    pinTitle: typeof payload.pinTitle === "string" ? payload.pinTitle.trim() || null : null,
    pinNote: typeof payload.pinNote === "string" ? payload.pinNote.trim() || null : null,
    milestoneLabel:
      typeof payload.milestoneLabel === "string" && payload.milestoneLabel.trim()
        ? payload.milestoneLabel.trim()
        : null,
    milestoneKind:
      typeof payload.milestoneKind === "string" && payload.milestoneKind.trim()
        ? payload.milestoneKind.trim()
        : null,
    sessionID:
      typeof payload.sessionID === "string" && payload.sessionID.trim()
        ? payload.sessionID.trim()
        : null,
    restoreGroupID:
      typeof payload.restoreGroupID === "string" && payload.restoreGroupID.trim()
        ? payload.restoreGroupID.trim()
        : null,
    changeSummary: (() => {
      if (!payload.changeSummary || typeof payload.changeSummary !== "object") {
        return null;
      }
      const maybe = payload.changeSummary as SnapshotChangeSummary;
      if (
        typeof maybe.linesChanged !== "number" ||
        !Number.isFinite(maybe.linesChanged) ||
        typeof maybe.characterDelta !== "number" ||
        !Number.isFinite(maybe.characterDelta)
      ) {
        return null;
      }
      if (
        maybe.byteDelta != null &&
        (typeof maybe.byteDelta !== "number" || !Number.isFinite(maybe.byteDelta))
      ) {
        return null;
      }
      return {
        linesChanged: Math.floor(maybe.linesChanged),
        characterDelta: Math.floor(maybe.characterDelta),
        byteDelta: maybe.byteDelta == null ? null : Math.floor(maybe.byteDelta),
      };
    })(),
  };

  return { snapshot, receivedBytes };
}

function parseSnapshotSendMode(value: string | undefined): SnapshotSendMode {
  if (!value) {
    return "forced";
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "scheduled" ? "scheduled" : "forced";
}

function parseScheduledAutoCheckpointIntervalSeconds(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.floor(parsed);
  return Math.min(12 * 60, Math.max(5 * 60, rounded));
}

function shouldPromoteAutoSnapshotRecord(
  padId: string,
  snapshot: Snapshot,
  sendMode: SnapshotSendMode,
  scheduledAutoCheckpointIntervalSeconds: number | null
): boolean {
  if (sendMode === "forced") {
    return true;
  }

  const reason = snapshot.checkpointReason ?? "autoEditBatch";
  const source = snapshot.checkpointSource ?? "remote";
  if (reason !== "autoEditBatch" || source !== "local") {
    return true;
  }

  const createdAtUnix = Math.floor(new Date(snapshot.lastModified).getTime() / 1_000);
  if (!Number.isFinite(createdAtUnix)) {
    return true;
  }

  const latest = statements.selectLatestScheduledAutoSnapshotCreatedAt.get(padId) as
    | SnapshotCreatedAtRow
    | undefined;
  if (!latest) {
    return true;
  }

  const requiredInterval =
    scheduledAutoCheckpointIntervalSeconds ?? scheduledAutoTimelinePromotionIntervalSeconds;
  return createdAtUnix - latest.created_at_unix >= requiredInterval;
}

function insertSnapshot(
  padId: string,
  snapshot: Snapshot,
  isPinned: boolean,
  options?: { forceSnapshotID?: string; reason?: string | null; source?: string | null }
): SnapshotRecord | null {
  const diskPercent = readDiskUsagePercent();
  const policy = retentionPolicyForDiskUsage(diskPercent);

  if (!isPinned && policy.name === "critical") {
    return null;
  }

  const createdAtDate = new Date(snapshot.lastModified);
  const createdAt = Number.isNaN(createdAtDate.getTime())
    ? new Date().toISOString()
    : createdAtDate.toISOString();
  const createdAtUnix = Math.floor(new Date(createdAt).getTime() / 1_000);

  const snapshotID = options?.forceSnapshotID || snapshot.snapshotID || randomUUID();
  const reason = options?.reason ?? snapshot.checkpointReason ?? (isPinned ? "manualPin" : "autoEditBatch");
  const source = options?.source ?? snapshot.checkpointSource ?? "remote";
  const byteSize = snapshot.byteSize ?? Buffer.byteLength(snapshot.text, "utf8");

  statements.insertSnapshot.run({
    snapshot_id: snapshotID,
    pad_id: padId,
    text: snapshot.text,
    created_at: createdAt,
    created_at_unix: createdAtUnix,
    device_id: snapshot.deviceID,
    language: snapshot.language ?? null,
    byte_size: byteSize,
    reason,
    source,
    pin_title: snapshot.pinTitle ?? null,
    pin_note: snapshot.pinNote ?? null,
    milestone_label: snapshot.milestoneLabel ?? null,
    milestone_kind: snapshot.milestoneKind ?? null,
    session_id: snapshot.sessionID ?? null,
    restore_group_id: snapshot.restoreGroupID ?? null,
    change_summary_json: serializeChangeSummary(snapshot.changeSummary),
    is_pinned: isPinned ? 1 : 0,
  });

  return {
    snapshotID,
    text: snapshot.text,
    createdAt,
    deviceID: snapshot.deviceID,
    language: snapshot.language ?? null,
    byteSize,
    reason,
    source,
    pinTitle: snapshot.pinTitle ?? null,
    pinNote: snapshot.pinNote ?? null,
    milestoneLabel: snapshot.milestoneLabel ?? null,
    milestoneKind: snapshot.milestoneKind ?? null,
    sessionID: snapshot.sessionID ?? null,
    restoreGroupID: snapshot.restoreGroupID ?? null,
    changeSummary: snapshot.changeSummary ?? null,
  };
}

function encodeCursor(cursor: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(rawCursor: string | undefined): SnapshotCursor | null {
  if (!rawCursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as SnapshotCursor;
    if (
      typeof parsed.createdAtUnix === "number" &&
      Number.isFinite(parsed.createdAtUnix) &&
      typeof parsed.snapshotID === "string" &&
      parsed.snapshotID.length > 0
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeLimit(rawLimit: string | undefined): number {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

function parseBooleanFilter(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

function parseStringFilter(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDateFilterToUnix(raw: string | undefined): number | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.floor(date.getTime() / 1_000);
}

type SnapshotTimelineFilter = {
  reason?: string | null;
  source?: string | null;
  language?: string | null;
  deviceID?: string | null;
  pinned?: boolean | null;
  milestoneKind?: string | null;
  fromUnix?: number | null;
  toUnix?: number | null;
};

function listSnapshots(
  padId: string,
  rawCursor: string | undefined,
  rawLimit: string | undefined,
  filters?: SnapshotTimelineFilter
): {
  snapshots: SnapshotRecord[];
  nextCursor: string | null;
} {
  const limit = normalizeLimit(rawLimit);
  const fetchLimit = limit + 1;
  const cursor = decodeCursor(rawCursor);
  const where: string[] = ["pad_id = @pad_id"];
  const params: Record<string, unknown> = {
    pad_id: padId,
    limit: fetchLimit,
  };

  if (cursor) {
    where.push(
      "(created_at_unix < @cursor_created_at_unix OR (created_at_unix = @cursor_created_at_unix AND snapshot_id < @cursor_snapshot_id))"
    );
    params.cursor_created_at_unix = cursor.createdAtUnix;
    params.cursor_snapshot_id = cursor.snapshotID;
  }

  if (filters?.reason) {
    where.push("reason = @reason");
    params.reason = filters.reason;
  }
  if (filters?.source) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters?.language) {
    where.push("language = @language");
    params.language = filters.language;
  }
  if (filters?.deviceID) {
    where.push("device_id = @device_id");
    params.device_id = filters.deviceID;
  }
  if (filters?.pinned != null) {
    where.push("is_pinned = @is_pinned");
    params.is_pinned = filters.pinned ? 1 : 0;
  }
  if (filters?.milestoneKind) {
    where.push("milestone_kind = @milestone_kind");
    params.milestone_kind = filters.milestoneKind;
  }
  if (filters?.fromUnix != null) {
    where.push("created_at_unix >= @from_unix");
    params.from_unix = filters.fromUnix;
  }
  if (filters?.toUnix != null) {
    where.push("created_at_unix <= @to_unix");
    params.to_unix = filters.toUnix;
  }

  const query = `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
                        language, byte_size, reason, source, pin_title, pin_note,
                        milestone_label, milestone_kind, session_id, restore_group_id, change_summary_json,
                        is_pinned
                 FROM snapshots
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at_unix DESC, snapshot_id DESC
                 LIMIT @limit`;
  const rows = db.prepare(query).all(params) as SnapshotRow[];

  const hasNext = rows.length > limit;
  const pageRows = hasNext ? rows.slice(0, limit) : rows;
  const snapshots = pageRows.map(rowToSnapshotRecord);

  let nextCursor: string | null = null;
  if (hasNext) {
    const tail = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      createdAtUnix: tail.created_at_unix,
      snapshotID: tail.snapshot_id,
    });
  }

  return { snapshots, nextCursor };
}

function retentionPolicyForDiskUsage(diskUsagePercent: number | null): RetentionPolicy {
  if (diskUsagePercent != null && diskUsagePercent >= diskCriticalThresholdPercent) {
    return {
      name: "critical",
      nonPinnedRetentionDays: 2,
      nonPinnedMaxPerPad: 50,
      pinnedMaxPerPad: 2_000,
    };
  }

  if (diskUsagePercent != null && diskUsagePercent >= diskAggressiveThresholdPercent) {
    return {
      name: "aggressive",
      nonPinnedRetentionDays: 7,
      nonPinnedMaxPerPad: 200,
      pinnedMaxPerPad: 2_000,
    };
  }

  return {
    name: "normal",
    nonPinnedRetentionDays: 30,
    nonPinnedMaxPerPad: 500,
    pinnedMaxPerPad: 2_000,
  };
}

function readDiskUsagePercent(): number | null {
  try {
    const stats = statfsSync(dataDir);
    const total = stats.blocks * stats.bsize;
    if (total <= 0) return null;
    const used = (stats.blocks - stats.bfree) * stats.bsize;
    const percent = (used / total) * 100;
    if (!Number.isFinite(percent)) return null;
    return Math.max(0, Math.min(100, percent));
  } catch {
    return null;
  }
}

function pruneSnapshots(policy: RetentionPolicy): void {
  const nowUnix = Math.floor(Date.now() / 1_000);
  const cutoffUnix = nowUnix - policy.nonPinnedRetentionDays * 24 * 60 * 60;

  statements.deleteOldNonPinnedSnapshots.run(cutoffUnix);
  statements.trimNonPinnedByPad.run(policy.nonPinnedMaxPerPad);
  statements.trimPinnedByPad.run(policy.pinnedMaxPerPad);
}

function runWalCheckpoint(): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

function shouldRun(lastRunAt: Date | null, intervalMs: number, now: Date): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() >= intervalMs;
}

function buildBackupConfig(): BackupConfig {
  const bucket = process.env.BACKUP_S3_BUCKET?.trim() || null;
  const region = process.env.BACKUP_S3_REGION?.trim() || "auto";
  const endpoint = process.env.BACKUP_S3_ENDPOINT?.trim();
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  const keyPrefix = (process.env.BACKUP_S3_KEY_PREFIX?.trim() || "chrony-sync-backups").replace(/\/$/, "");

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return {
      enabled: false,
      client: null,
      bucket: null,
      keyPrefix,
    };
  }

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: process.env.BACKUP_S3_FORCE_PATH_STYLE === "1",
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return {
    enabled: true,
    client,
    bucket,
    keyPrefix,
  };
}

function listLocalBackupFiles(): string[] {
  try {
    const files = readdirSync(backupDir)
      .filter((name) => name.endsWith(".sqlite") || name.endsWith(".sqlite3"))
      .map((name) => path.join(backupDir, name));
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files;
  } catch {
    return [];
  }
}

function pruneLocalBackups(): void {
  const maxAgeMs = Math.max(1, backupKeepLocalDays) * 24 * 60 * 60 * 1_000;
  const cutoffMs = Date.now() - maxAgeMs;

  for (const filePath of listLocalBackupFiles()) {
    try {
      const stats = statSync(filePath);
      if (stats.mtimeMs < cutoffMs) {
        unlinkSync(filePath);
      }
    } catch {
      // best effort
    }
  }
}

function backupFilename(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `chrony-sync-${stamp}.sqlite`;
}

async function runBackup(now: Date, reason: string): Promise<void> {
  const filename = backupFilename(now);
  const backupPath = path.join(backupDir, filename);

  await db.backup(backupPath);

  if (backupConfig.enabled && backupConfig.client && backupConfig.bucket) {
    const key = `${backupConfig.keyPrefix}/${filename}`;
    const body = readFileSync(backupPath);
    await backupConfig.client.send(
      new PutObjectCommand({
        Bucket: backupConfig.bucket,
        Key: key,
        Body: body,
        ContentType: "application/x-sqlite3",
      })
    );
  }

  pruneLocalBackups();

  lastBackupRunAt = now;
  writeMetadataDate("last_backup_run_at", now);
  writeMetadataString("last_backup_error", "");
  lastBackupErrorMessage = null;

  console.log(`[backup] completed reason=${reason} file=${backupPath}`);
}

function runBackupVerify(now: Date, reason: string): void {
  const files = listLocalBackupFiles();
  if (files.length === 0) {
    throw new Error("No local backup files available to verify");
  }

  const latest = files[0];
  const verifyDb = new Database(latest, { readonly: true, fileMustExist: true });
  try {
    const result = verifyDb.prepare("PRAGMA integrity_check").pluck().get() as string | undefined;
    if (!result || result.toLowerCase() !== "ok") {
      throw new Error(`Backup integrity check failed for ${latest}: ${result || "unknown"}`);
    }
  } finally {
    verifyDb.close();
  }

  lastBackupVerifyAt = now;
  writeMetadataDate("last_backup_verify_at", now);
  console.log(`[backup] verify completed reason=${reason} file=${latest}`);
}

async function schedulerTick(reason: string): Promise<void> {
  if (schedulerInFlight) {
    return;
  }

  schedulerInFlight = true;
  try {
    const now = new Date();

    if (shouldRun(lastMaintenanceRunAt, maintenanceIntervalMs, now)) {
      const diskUsagePercent = readDiskUsagePercent();
      const policy = retentionPolicyForDiskUsage(diskUsagePercent);

      if (policy.name !== lastDiskPressureLevel) {
        console.warn(
          `[disk] pressure=${policy.name} usage=${
            diskUsagePercent == null ? "unknown" : `${diskUsagePercent.toFixed(2)}%`
          }`
        );
        lastDiskPressureLevel = policy.name;
      }

      pruneSnapshots(policy);
      runWalCheckpoint();

      if (policy.name === "aggressive" || policy.name === "critical") {
        const lastVacuumAt = readMetadataDate("last_vacuum_run_at");
        if (shouldRun(lastVacuumAt, 24 * 60 * 60 * 1_000, now)) {
          db.exec("VACUUM");
          writeMetadataDate("last_vacuum_run_at", now);
        }
      }

      lastMaintenanceRunAt = now;
      writeMetadataDate("last_maintenance_run_at", now);
    }

    if (shouldRun(lastBackupRunAt, backupIntervalMs, now)) {
      try {
        await runBackup(now, reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown backup error";
        lastBackupErrorMessage = message;
        writeMetadataString("last_backup_error", message);
        console.error("[backup] failed:", message);
      }
    }

    if (shouldRun(lastBackupVerifyAt, backupVerifyIntervalMs, now)) {
      try {
        runBackupVerify(now, reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown verify error";
        lastBackupErrorMessage = message;
        writeMetadataString("last_backup_error", message);
        console.error("[backup] verify failed:", message);
      }
    }
  } finally {
    schedulerInFlight = false;
  }
}

function dbWritableStatus(): boolean {
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return true;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no-op
    }
    return false;
  }
}

const writeCanonicalSnapshotTx = db.transaction(
  (
    padId: string,
    incoming: Snapshot,
    sendMode: SnapshotSendMode,
    scheduledAutoCheckpointIntervalSeconds: number | null
  ): { canonical: Snapshot; accepted: boolean } => {
    const current = ensureSnapshot(padId);
    const incomingDate = new Date(incoming.lastModified);
    const currentDate = new Date(current.lastModified);

    if (incomingDate <= currentDate) {
      return { canonical: current, accepted: false };
    }

    const version = nextGlobalVersion();
    const canonical: Snapshot = {
      ...incoming,
      version,
    };

    if (
      shouldPromoteAutoSnapshotRecord(
        padId,
        canonical,
        sendMode,
        scheduledAutoCheckpointIntervalSeconds
      )
    ) {
      const autoRecord = insertSnapshot(padId, canonical, false);
      if (autoRecord) {
        canonical.snapshotID = autoRecord.snapshotID;
        canonical.checkpointReason = autoRecord.reason || canonical.checkpointReason || null;
        canonical.checkpointSource = autoRecord.source || canonical.checkpointSource || null;
        canonical.milestoneLabel = autoRecord.milestoneLabel ?? canonical.milestoneLabel ?? null;
        canonical.milestoneKind = autoRecord.milestoneKind ?? canonical.milestoneKind ?? null;
        canonical.sessionID = autoRecord.sessionID ?? canonical.sessionID ?? null;
        canonical.restoreGroupID = autoRecord.restoreGroupID ?? canonical.restoreGroupID ?? null;
        canonical.changeSummary = autoRecord.changeSummary ?? canonical.changeSummary ?? null;
      }
    }

    writePadSnapshot(padId, canonical);
    return { canonical, accepted: true };
  }
);

const restoreSnapshotTx = db.transaction(
  (padId: string, snapshotID: string): Snapshot | null => {
    const row = statements.selectSnapshotById.get(padId, snapshotID) as SnapshotRow | undefined;
    if (!row) {
      return null;
    }

    const now = new Date();
    const version = nextGlobalVersion();
    const restored: Snapshot = {
      text: row.text,
      lastModified: now.toISOString(),
      deviceID: "server",
      version,
      language: row.language,
      snapshotID: null,
      checkpointReason: "restore",
      checkpointSource: "restored",
      byteSize: row.byte_size ?? Buffer.byteLength(row.text, "utf8"),
      pinTitle: row.pin_title,
      pinNote: row.pin_note,
      milestoneLabel: "After restore",
      milestoneKind: "restore",
      sessionID: null,
      restoreGroupID: null,
      changeSummary: null,
    };

    const autoRecord = insertSnapshot(padId, restored, false, {
      reason: "restore",
      source: "restored",
    });
    if (autoRecord) {
      restored.snapshotID = autoRecord.snapshotID;
      restored.checkpointReason = autoRecord.reason || "restore";
      restored.checkpointSource = autoRecord.source || "restored";
      restored.milestoneLabel = autoRecord.milestoneLabel ?? restored.milestoneLabel ?? null;
      restored.milestoneKind = autoRecord.milestoneKind ?? restored.milestoneKind ?? null;
      restored.sessionID = autoRecord.sessionID ?? restored.sessionID ?? null;
      restored.restoreGroupID = autoRecord.restoreGroupID ?? restored.restoreGroupID ?? null;
      restored.changeSummary = autoRecord.changeSummary ?? restored.changeSummary ?? null;
    }

    writePadSnapshot(padId, restored);
    return restored;
  }
);

const clearPadTx = db.transaction((padId: string): Snapshot => {
  statements.deletePad.run(padId);

  const version = nextGlobalVersion();
  const cleared: Snapshot = {
    text: "",
    lastModified: new Date().toISOString(),
    deviceID: "server",
    version,
    language: null,
    snapshotID: null,
    checkpointReason: "clear",
    checkpointSource: "remote",
    byteSize: 0,
    pinTitle: null,
    pinNote: null,
    milestoneLabel: "After clear",
    milestoneKind: "semanticEvent",
    sessionID: null,
    restoreGroupID: null,
    changeSummary: null,
  };

  const autoRecord = insertSnapshot(padId, cleared, false, {
    reason: "clear",
    source: "remote",
  });
  if (autoRecord) {
    cleared.snapshotID = autoRecord.snapshotID;
    cleared.checkpointReason = autoRecord.reason || cleared.checkpointReason || "clear";
    cleared.checkpointSource = autoRecord.source || cleared.checkpointSource || "remote";
    cleared.milestoneLabel = autoRecord.milestoneLabel ?? cleared.milestoneLabel ?? null;
    cleared.milestoneKind = autoRecord.milestoneKind ?? cleared.milestoneKind ?? null;
    cleared.sessionID = autoRecord.sessionID ?? cleared.sessionID ?? null;
    cleared.restoreGroupID = autoRecord.restoreGroupID ?? cleared.restoreGroupID ?? null;
    cleared.changeSummary = autoRecord.changeSummary ?? cleared.changeSummary ?? null;
  }

  writePadSnapshot(padId, cleared);
  return cleared;
});

// GET /pads/:padId – return latest snapshot for this pad
app.get("/pads/:padId", (req, res) => {
  const padId = req.params.padId;
  const snap = ensureSnapshot(padId);
  const etag = snapshotETag(snap);

  const ifNoneMatch = req.header("if-none-match");
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    res.setHeader("ETag", etag);
    res.status(304).send();
    return;
  }

  res.setHeader("ETag", etag);
  res.json(snap);
});

// PUT /pads/:padId – last-writer-wins for this pad
app.put("/pads/:padId", (req, res) => {
  const padId = req.params.padId;
  const sendMode = parseSnapshotSendMode(req.header("x-chrony-send-mode"));
  const scheduledAutoCheckpointIntervalSeconds = parseScheduledAutoCheckpointIntervalSeconds(
    req.header("x-chrony-auto-checkpoint-interval-sec")
  );

  let parsed: { snapshot: Snapshot; receivedBytes: number };
  try {
    parsed = buildSnapshotFromPayload(req.body as SnapshotPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid snapshot payload";
    if (message === "Invalid lastModified") {
      res.status(400).json({ error: "Invalid lastModified" });
      return;
    }
    res.status(400).json({ error: "Invalid snapshot payload" });
    return;
  }

  if (parsed.receivedBytes > maxSnapshotBytes) {
    res.status(413).json({
      error: "Snapshot too large",
      maxBytes: maxSnapshotBytes,
      receivedBytes: parsed.receivedBytes,
    });
    return;
  }

  const { canonical, accepted } = writeCanonicalSnapshotTx(
    padId,
    parsed.snapshot,
    sendMode,
    scheduledAutoCheckpointIntervalSeconds
  );

  if (accepted) {
    broadcastSnapshot(padId);
  }

  res.setHeader("ETag", snapshotETag(canonical));
  res.status(200).json(canonical);
});

// DELETE /pads/:padId – clear this pad and broadcast reset state
app.delete("/pads/:padId", (req, res) => {
  const padId = req.params.padId;
  const cleared = clearPadTx(padId);
  broadcastSnapshot(padId);

  console.log("Deleted pad (reset to empty state):", padId, "version", cleared.version);
  res.status(204).send();
});

// GET /pads/:padId/snapshots – paginated timeline
app.get("/pads/:padId/snapshots", (req, res) => {
  const padId = req.params.padId;
  ensureSnapshot(padId);

  const filters: SnapshotTimelineFilter = {
    reason: parseStringFilter(typeof req.query.reason === "string" ? req.query.reason : undefined),
    source: parseStringFilter(typeof req.query.source === "string" ? req.query.source : undefined),
    language: parseStringFilter(typeof req.query.language === "string" ? req.query.language : undefined),
    deviceID: parseStringFilter(typeof req.query.deviceID === "string" ? req.query.deviceID : undefined),
    pinned: parseBooleanFilter(typeof req.query.pinned === "string" ? req.query.pinned : undefined),
    milestoneKind: parseStringFilter(
      typeof req.query.milestoneKind === "string" ? req.query.milestoneKind : undefined
    ),
    fromUnix: parseDateFilterToUnix(typeof req.query.from === "string" ? req.query.from : undefined),
    toUnix: parseDateFilterToUnix(typeof req.query.to === "string" ? req.query.to : undefined),
  };

  const page = listSnapshots(
    padId,
    typeof req.query.cursor === "string" ? req.query.cursor : undefined,
    typeof req.query.limit === "string" ? req.query.limit : undefined,
    filters
  );

  res.json({
    snapshots: page.snapshots,
    nextCursor: page.nextCursor,
  });
});

// POST /pads/:padId/snapshots – create manual pinned snapshot
app.post("/pads/:padId/snapshots", (req, res) => {
  const padId = req.params.padId;
  ensureSnapshot(padId);

  let parsed: { snapshot: Snapshot; receivedBytes: number };
  try {
    parsed = buildSnapshotFromPayload(req.body as SnapshotPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid snapshot payload";
    if (message === "Invalid lastModified") {
      res.status(400).json({ error: "Invalid lastModified" });
      return;
    }
    res.status(400).json({ error: "Invalid snapshot payload" });
    return;
  }

  if (parsed.receivedBytes > maxSnapshotBytes) {
    res.status(413).json({
      error: "Snapshot too large",
      maxBytes: maxSnapshotBytes,
      receivedBytes: parsed.receivedBytes,
    });
    return;
  }

  const record = insertSnapshot(padId, parsed.snapshot, true, {
    reason: parsed.snapshot.checkpointReason || "manualPin",
    source: parsed.snapshot.checkpointSource || "local",
  });

  if (!record) {
    res.status(507).json({ error: "Insufficient storage for pinned snapshot" });
    return;
  }

  res.status(201).json(record);
});

// POST /pads/:padId/restore/:snapshotId – restore checkpoint into canonical head
app.post("/pads/:padId/restore/:snapshotId", (req, res) => {
  const padId = req.params.padId;
  const snapshotID = req.params.snapshotId;

  const restored = restoreSnapshotTx(padId, snapshotID);
  if (!restored) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  broadcastSnapshot(padId);
  res.status(200).json(restored);
});

app.post("/validate", async (req, res) => {
  const payload = req.body as DeepValidationRequest;

  try {
    const response = await validateWithToolchains(payload);
    res.status(200).json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "validation failed";
    res.status(500).json({
      language: "unsupported",
      profile: "unsupported",
      diagnostics: [
        {
          severity: "info",
          message: `validation backend failure: ${message}`,
          line: 1,
          column: 1,
          source: "chrony-validate",
          code: "backend.failure",
        },
      ],
      tools: [],
      truncated: false,
      cached: false,
      generatedAt: new Date().toISOString(),
      limitedReason: "Validation failed on backend.",
    });
  }
});

app.get("/billing/promotional-offers/status", (_req, res) => {
  const config = promotionalOfferSigningConfig();
  res.json({
    ready: config !== null,
    productIDs: config ? Array.from(config.allowedProductIDs) : [],
    offerIDs: config ? Array.from(config.allowedOfferIDs) : [],
  });
});

app.post("/billing/promotional-offers/signature", (req, res) => {
  const config = promotionalOfferSigningConfig();
  if (!config) {
    res.status(503).json({ error: "Promotional offer signing is not configured." });
    return;
  }

  const body = req.body as PromotionalOfferSignatureRequest;
  const productID = body.productID?.trim();
  const offerID = body.offerID?.trim();

  if (!productID || !offerID) {
    res.status(400).json({ error: "productID and offerID are required." });
    return;
  }

  if (!config.allowedProductIDs.has(productID)) {
    res.status(403).json({ error: "This product is not allowed for promotional signing." });
    return;
  }

  if (config.allowedOfferIDs.size > 0 && !config.allowedOfferIDs.has(offerID)) {
    res.status(403).json({ error: "This promotional offer is not allowed for signing." });
    return;
  }

  try {
    const signature = createPromotionalOfferSignature(config, productID, offerID);
    res.json(signature);
  } catch (error) {
    console.error("Failed to sign promotional offer:", error);
    res.status(500).json({ error: "Unable to sign promotional offer." });
  }
});

app.get("/health", (_req, res) => {
  const now = new Date();
  const diskUsagePercent = readDiskUsagePercent();
  const maintenanceLagSeconds =
    lastMaintenanceRunAt == null
      ? null
      : Math.max(
          0,
          Math.floor((now.getTime() - lastMaintenanceRunAt.getTime() - maintenanceIntervalMs) / 1_000)
        );

  const backupAgeSeconds =
    lastBackupRunAt == null ? null : Math.max(0, Math.floor((now.getTime() - lastBackupRunAt.getTime()) / 1_000));

  res.json({
    ok: true,
    incidentContact: "mailto:developer@stagedevices.com",
    db: {
      path: dbPath,
      writable: dbWritableStatus(),
    },
    disk: {
      path: dataDir,
      usagePercent: diskUsagePercent,
      thresholds: {
        warn: diskWarnThresholdPercent,
        aggressive: diskAggressiveThresholdPercent,
        critical: diskCriticalThresholdPercent,
      },
      policy: retentionPolicyForDiskUsage(diskUsagePercent).name,
    },
    backup: {
      enabled: backupConfig.enabled,
      lastRunAt: lastBackupRunAt?.toISOString() || null,
      lastVerifyAt: lastBackupVerifyAt?.toISOString() || null,
      lastError: lastBackupErrorMessage,
      ageSeconds: backupAgeSeconds,
    },
    maintenance: {
      lastRunAt: lastMaintenanceRunAt?.toISOString() || null,
      lagSeconds: maintenanceLagSeconds,
      intervalSeconds: Math.floor(maintenanceIntervalMs / 1_000),
    },
  });
});

app.get("/ready", (_req, res) => {
  const writable = dbWritableStatus();
  if (!writable) {
    res.status(503).json({ ready: false, reason: "db_not_writable" });
    return;
  }

  res.status(200).json({ ready: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set<Client>();

wss.on("connection", (ws: WebSocket, req) => {
  const url = req.url || "";
  const match = url.match(/^\/ws\/pads\/(.+)$/);
  if (!match) {
    console.warn("WS connection with unexpected path:", url);
    ws.close();
    return;
  }

  const padId = decodeURIComponent(match[1]);
  const snap = ensureSnapshot(padId);
  ws.send(JSON.stringify(snap));

  const client: Client = {
    ws,
    padId,
    isAlive: true,
    lastPongAt: Date.now(),
  };
  clients.add(client);

  ws.on("pong", () => {
    client.isAlive = true;
    client.lastPongAt = Date.now();
  });

  ws.on("close", () => {
    clients.delete(client);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

const wsHeartbeat = setInterval(() => {
  const now = Date.now();
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      clients.delete(client);
      continue;
    }

    if (now - client.lastPongAt > wsStaleTimeoutMs) {
      console.warn("Terminating stale WebSocket client for pad:", client.padId);
      client.ws.terminate();
      clients.delete(client);
      continue;
    }

    client.isAlive = false;
    try {
      client.ws.ping();
    } catch (error) {
      console.error("Failed to ping WebSocket client:", error);
      client.ws.terminate();
      clients.delete(client);
    }
  }
}, wsHeartbeatIntervalMs);

const schedulerTimer = setInterval(() => {
  void schedulerTick("interval");
}, schedulerTickIntervalMs);

wss.on("close", () => {
  clearInterval(wsHeartbeat);
});

function broadcastSnapshot(padId: string): void {
  const row = statements.selectPad.get(padId) as PadRow | undefined;
  if (!row) return;

  const payload = JSON.stringify(rowToSnapshot(row));
  for (const client of clients) {
    if (client.padId === padId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

void schedulerTick("startup");

process.on("SIGTERM", () => {
  clearInterval(wsHeartbeat);
  clearInterval(schedulerTimer);
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  clearInterval(wsHeartbeat);
  clearInterval(schedulerTimer);
  server.close(() => process.exit(0));
});

const port = Number(process.env.PORT) || 4000;
server.listen(port, () => {
  console.log(`Bus backend listening on port ${port}`);
  console.log(`SQLite path: ${dbPath}`);
  console.log(`Backup target: ${backupConfig.enabled ? "object-storage + local" : "local-only"}`);
});
