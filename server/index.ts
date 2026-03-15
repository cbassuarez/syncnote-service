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
};

type SnapshotPayload = Partial<Snapshot>;

type SnapshotRecord = {
  snapshotID: string;
  text: string;
  createdAt: string;
  deviceID: string;
  language?: string | null;
  byteSize?: number | null;
  reason?: string | null;
  pinTitle?: string | null;
  pinNote?: string | null;
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
            checkpoint_reason, checkpoint_source, byte_size, pin_title, pin_note, updated_at_unix
     FROM pads
     WHERE pad_id = ?`
  ),
  upsertPad: db.prepare(
    `INSERT INTO pads (
       pad_id, text, last_modified, device_id, version, language, snapshot_id,
       checkpoint_reason, checkpoint_source, byte_size, pin_title, pin_note, updated_at_unix
     ) VALUES (
       @pad_id, @text, @last_modified, @device_id, @version, @language, @snapshot_id,
       @checkpoint_reason, @checkpoint_source, @byte_size, @pin_title, @pin_note, @updated_at_unix
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
       updated_at_unix = excluded.updated_at_unix`
  ),
  deletePad: db.prepare(`DELETE FROM pads WHERE pad_id = ?`),
  insertSnapshot: db.prepare(
    `INSERT OR REPLACE INTO snapshots (
      snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
      language, byte_size, reason, source, pin_title, pin_note, is_pinned
    ) VALUES (
      @snapshot_id, @pad_id, @text, @created_at, @created_at_unix, @device_id,
      @language, @byte_size, @reason, @source, @pin_title, @pin_note, @is_pinned
    )`
  ),
  selectSnapshotById: db.prepare(
    `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note, is_pinned
     FROM snapshots
     WHERE pad_id = ? AND snapshot_id = ?`
  ),
  listSnapshotsFirstPage: db.prepare(
    `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note, is_pinned
     FROM snapshots
     WHERE pad_id = @pad_id
     ORDER BY created_at_unix DESC, snapshot_id DESC
     LIMIT @limit`
  ),
  listSnapshotsAfterCursor: db.prepare(
    `SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note, is_pinned
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
  ensureColumn("pads", "updated_at_unix", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn("snapshots", "language", "TEXT");
  ensureColumn("snapshots", "byte_size", "INTEGER");
  ensureColumn("snapshots", "reason", "TEXT");
  ensureColumn("snapshots", "source", "TEXT");
  ensureColumn("snapshots", "pin_title", "TEXT");
  ensureColumn("snapshots", "pin_note", "TEXT");
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
    pinTitle: row.pin_title,
    pinNote: row.pin_note,
  };
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

  if (!payloadText || !payloadDateRaw || !payloadDeviceID) {
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
  };

  return { snapshot, receivedBytes };
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
    pinTitle: snapshot.pinTitle ?? null,
    pinNote: snapshot.pinNote ?? null,
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

function listSnapshots(padId: string, rawCursor: string | undefined, rawLimit: string | undefined): {
  snapshots: SnapshotRecord[];
  nextCursor: string | null;
} {
  const limit = normalizeLimit(rawLimit);
  const fetchLimit = limit + 1;
  const cursor = decodeCursor(rawCursor);

  const rows = cursor
    ? (statements.listSnapshotsAfterCursor.all({
        pad_id: padId,
        created_at_unix: cursor.createdAtUnix,
        snapshot_id: cursor.snapshotID,
        limit: fetchLimit,
      }) as SnapshotRow[])
    : (statements.listSnapshotsFirstPage.all({ pad_id: padId, limit: fetchLimit }) as SnapshotRow[]);

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
  (padId: string, incoming: Snapshot): { canonical: Snapshot; accepted: boolean } => {
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

    const autoRecord = insertSnapshot(padId, canonical, false);
    if (autoRecord) {
      canonical.snapshotID = autoRecord.snapshotID;
      canonical.checkpointReason = autoRecord.reason || canonical.checkpointReason || null;
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
    };

    const autoRecord = insertSnapshot(padId, restored, false, {
      reason: "restore",
      source: "restored",
    });
    if (autoRecord) {
      restored.snapshotID = autoRecord.snapshotID;
      restored.checkpointReason = autoRecord.reason || "restore";
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
  };

  const autoRecord = insertSnapshot(padId, cleared, false, {
    reason: "clear",
    source: "remote",
  });
  if (autoRecord) {
    cleared.snapshotID = autoRecord.snapshotID;
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

  const { canonical, accepted } = writeCanonicalSnapshotTx(padId, parsed.snapshot);

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

  const page = listSnapshots(
    padId,
    typeof req.query.cursor === "string" ? req.query.cursor : undefined,
    typeof req.query.limit === "string" ? req.query.limit : undefined
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
    incidentContact: "mailto:developer.com",
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
