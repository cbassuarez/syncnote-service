"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_s3_1 = require("@aws-sdk/client-s3");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const cors_1 = __importDefault(require("cors"));
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
const fs_1 = require("fs");
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const ws_1 = require("ws");
const defaultPromotionalOfferProductIDs = ["CHRNPROANNUALLY"];
const invisibleSeparator = "\u2063";
const maxSnapshotBytes = 1048576;
const diskWarnThresholdPercent = 70;
const diskAggressiveThresholdPercent = 85;
const diskCriticalThresholdPercent = 95;
const maintenanceIntervalMs = 60 * 60 * 1000;
const backupIntervalMs = 6 * 60 * 60 * 1000;
const backupVerifyIntervalMs = 24 * 60 * 60 * 1000;
const schedulerTickIntervalMs = 60 * 1000;
const wsHeartbeatIntervalMs = 25000;
const wsStaleTimeoutMs = 75000;
const backupKeepLocalDays = Number(process.env.BACKUP_KEEP_LOCAL_DAYS || "14");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "2mb" }));
const dataDir = process.env.DATA_DIR?.trim() || "/var/data";
const dbPath = process.env.SQLITE_PATH?.trim() || path_1.default.join(dataDir, "chrony-sync.sqlite");
const backupDir = path_1.default.join(dataDir, "backups");
(0, fs_1.mkdirSync)(dataDir, { recursive: true });
(0, fs_1.mkdirSync)(path_1.default.dirname(dbPath), { recursive: true });
(0, fs_1.mkdirSync)(backupDir, { recursive: true });
const db = new better_sqlite3_1.default(dbPath);
configureDatabase(db);
migrateSchema(db);
assertIntegrity(db);
const backupConfig = buildBackupConfig();
const statements = {
    selectPad: db.prepare(`SELECT pad_id, text, last_modified, device_id, version, language, snapshot_id,
            checkpoint_reason, checkpoint_source, byte_size, pin_title, pin_note, updated_at_unix
     FROM pads
     WHERE pad_id = ?`),
    upsertPad: db.prepare(`INSERT INTO pads (
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
       updated_at_unix = excluded.updated_at_unix`),
    deletePad: db.prepare(`DELETE FROM pads WHERE pad_id = ?`),
    insertSnapshot: db.prepare(`INSERT OR REPLACE INTO snapshots (
      snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
      language, byte_size, reason, source, pin_title, pin_note, is_pinned
    ) VALUES (
      @snapshot_id, @pad_id, @text, @created_at, @created_at_unix, @device_id,
      @language, @byte_size, @reason, @source, @pin_title, @pin_note, @is_pinned
    )`),
    selectSnapshotById: db.prepare(`SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note, is_pinned
     FROM snapshots
     WHERE pad_id = ? AND snapshot_id = ?`),
    listSnapshotsFirstPage: db.prepare(`SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note, is_pinned
     FROM snapshots
     WHERE pad_id = @pad_id
     ORDER BY created_at_unix DESC, snapshot_id DESC
     LIMIT @limit`),
    listSnapshotsAfterCursor: db.prepare(`SELECT snapshot_id, pad_id, text, created_at, created_at_unix, device_id,
            language, byte_size, reason, source, pin_title, pin_note, is_pinned
     FROM snapshots
     WHERE pad_id = @pad_id
       AND (
         created_at_unix < @created_at_unix
         OR (created_at_unix = @created_at_unix AND snapshot_id < @snapshot_id)
       )
     ORDER BY created_at_unix DESC, snapshot_id DESC
     LIMIT @limit`),
    deleteOldNonPinnedSnapshots: db.prepare(`DELETE FROM snapshots
     WHERE is_pinned = 0 AND created_at_unix < ?`),
    trimNonPinnedByPad: db.prepare(`DELETE FROM snapshots
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
     )`),
    trimPinnedByPad: db.prepare(`DELETE FROM snapshots
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
     )`),
    getMetadata: db.prepare(`SELECT value FROM metadata WHERE key = ?`),
    setMetadata: db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};
ensureGlobalVersionCounterRow();
let lastMaintenanceRunAt = readMetadataDate("last_maintenance_run_at");
let lastBackupRunAt = readMetadataDate("last_backup_run_at");
let lastBackupVerifyAt = readMetadataDate("last_backup_verify_at");
let lastBackupErrorMessage = readMetadataString("last_backup_error") || null;
let lastDiskPressureLevel = retentionPolicyForDiskUsage(readDiskUsagePercent()).name;
let schedulerInFlight = false;
function configureDatabase(database) {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("busy_timeout = 5000");
    database.pragma("wal_autocheckpoint = 1000");
    database.pragma("foreign_keys = ON");
}
function migrateSchema(database) {
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
function ensureColumn(tableName, columnName, definition) {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const hasColumn = rows.some((row) => row.name === columnName);
    if (!hasColumn) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}
function assertIntegrity(database) {
    const row = database.prepare("PRAGMA integrity_check").pluck().get();
    if (!row || row.toLowerCase() !== "ok") {
        throw new Error(`SQLite integrity check failed: `);
    }
}
function ensureGlobalVersionCounterRow() {
    db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`).run("global_version_counter", "0");
}
function parseCSVSet(rawValue, fallback = []) {
    const values = (rawValue ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    return new Set(values.length > 0 ? values : fallback);
}
function normalizePrivateKey(rawValue) {
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
    }
    catch {
        return null;
    }
}
function promotionalOfferSigningConfig() {
    const keyId = process.env.APPLE_SUBSCRIPTION_KEY_ID?.trim();
    const bundleId = process.env.APPLE_BUNDLE_ID?.trim() || "com.StageDevices.chrony";
    const privateKey = normalizePrivateKey(process.env.APPLE_SUBSCRIPTION_PRIVATE_KEY) ??
        normalizePrivateKey(process.env.APPLE_SUBSCRIPTION_PRIVATE_KEY_BASE64);
    if (!keyId || !privateKey) {
        return null;
    }
    try {
        (0, crypto_1.createPrivateKey)(privateKey);
    }
    catch {
        return null;
    }
    return {
        bundleId,
        keyId,
        privateKey,
        allowedOfferIDs: parseCSVSet(process.env.APPLE_PROMOTIONAL_OFFER_IDS),
        allowedProductIDs: parseCSVSet(process.env.APPLE_PROMOTIONAL_OFFER_PRODUCT_IDS, defaultPromotionalOfferProductIDs),
    };
}
function createPromotionalOfferSignature(config, productID, offerID, appAccountToken = "") {
    const nonce = (0, crypto_1.randomUUID)().toLowerCase();
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
    const signer = (0, crypto_1.createSign)("SHA256");
    signer.update(payload);
    signer.end();
    return {
        keyID: config.keyId,
        nonce,
        signature: signer.sign((0, crypto_1.createPrivateKey)(config.privateKey)).toString("base64"),
        timestamp,
    };
}
function normalizeETag(tag) {
    return tag.trim().replace(/^W\//i, "");
}
function etagMatches(ifNoneMatchHeader, currentETag) {
    const normalizedCurrent = normalizeETag(currentETag);
    return ifNoneMatchHeader
        .split(",")
        .map((part) => part.trim())
        .some((candidate) => candidate === "*" || normalizeETag(candidate) === normalizedCurrent);
}
function snapshotETag(snapshot) {
    const digest = (0, crypto_1.createHash)("sha1")
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
function rowToSnapshot(row) {
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
function rowToSnapshotRecord(row) {
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
function readMetadataString(key) {
    const row = statements.getMetadata.get(key);
    return row?.value ?? null;
}
function writeMetadataString(key, value) {
    statements.setMetadata.run(key, value);
}
function readMetadataNumber(key) {
    const raw = readMetadataString(key);
    if (raw == null)
        return null;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return null;
    return value;
}
function writeMetadataNumber(key, value) {
    writeMetadataString(key, String(value));
}
function readMetadataDate(key) {
    const raw = readMetadataString(key);
    if (!raw)
        return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
        return null;
    return parsed;
}
function writeMetadataDate(key, date) {
    writeMetadataString(key, date.toISOString());
}
function nextGlobalVersion() {
    const current = readMetadataNumber("global_version_counter") ?? 0;
    const next = current + 1;
    writeMetadataNumber("global_version_counter", next);
    return next;
}
function currentGlobalVersion() {
    return readMetadataNumber("global_version_counter") ?? 0;
}
function writePadSnapshot(padId, snapshot) {
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
        updated_at_unix: Math.floor(Date.now() / 1000),
    });
}
function ensureSnapshot(padId) {
    const row = statements.selectPad.get(padId);
    if (row) {
        return rowToSnapshot(row);
    }
    const snapshot = {
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
function buildSnapshotFromPayload(payload) {
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
    const byteSize = typeof payload.byteSize === "number" && Number.isFinite(payload.byteSize)
        ? Math.max(0, Math.floor(payload.byteSize))
        : Buffer.byteLength(payloadText, "utf8");
    const snapshot = {
        text: payloadText,
        lastModified: normalizedDate,
        deviceID: payloadDeviceID,
        version: typeof payload.version === "number" && Number.isFinite(payload.version) ? payload.version : 0,
        language: typeof payload.language === "string" ? payload.language : null,
        snapshotID: typeof payload.snapshotID === "string" && payload.snapshotID.trim() ? payload.snapshotID : null,
        checkpointReason: typeof payload.checkpointReason === "string" && payload.checkpointReason.trim()
            ? payload.checkpointReason
            : null,
        checkpointSource: typeof payload.checkpointSource === "string" && payload.checkpointSource.trim()
            ? payload.checkpointSource
            : null,
        byteSize,
        pinTitle: typeof payload.pinTitle === "string" ? payload.pinTitle.trim() || null : null,
        pinNote: typeof payload.pinNote === "string" ? payload.pinNote.trim() || null : null,
    };
    return { snapshot, receivedBytes };
}
function insertSnapshot(padId, snapshot, isPinned, options) {
    const diskPercent = readDiskUsagePercent();
    const policy = retentionPolicyForDiskUsage(diskPercent);
    if (!isPinned && policy.name === "critical") {
        return null;
    }
    const createdAtDate = new Date(snapshot.lastModified);
    const createdAt = Number.isNaN(createdAtDate.getTime())
        ? new Date().toISOString()
        : createdAtDate.toISOString();
    const createdAtUnix = Math.floor(new Date(createdAt).getTime() / 1000);
    const snapshotID = options?.forceSnapshotID || snapshot.snapshotID || (0, crypto_1.randomUUID)();
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
function encodeCursor(cursor) {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
function decodeCursor(rawCursor) {
    if (!rawCursor)
        return null;
    try {
        const parsed = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
        if (typeof parsed.createdAtUnix === "number" &&
            Number.isFinite(parsed.createdAtUnix) &&
            typeof parsed.snapshotID === "string" &&
            parsed.snapshotID.length > 0) {
            return parsed;
        }
    }
    catch {
        return null;
    }
    return null;
}
function normalizeLimit(rawLimit) {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed))
        return 50;
    return Math.min(200, Math.max(1, Math.floor(parsed)));
}
function listSnapshots(padId, rawCursor, rawLimit) {
    const limit = normalizeLimit(rawLimit);
    const fetchLimit = limit + 1;
    const cursor = decodeCursor(rawCursor);
    const rows = cursor
        ? statements.listSnapshotsAfterCursor.all({
            pad_id: padId,
            created_at_unix: cursor.createdAtUnix,
            snapshot_id: cursor.snapshotID,
            limit: fetchLimit,
        })
        : statements.listSnapshotsFirstPage.all({ pad_id: padId, limit: fetchLimit });
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const snapshots = pageRows.map(rowToSnapshotRecord);
    let nextCursor = null;
    if (hasNext) {
        const tail = pageRows[pageRows.length - 1];
        nextCursor = encodeCursor({
            createdAtUnix: tail.created_at_unix,
            snapshotID: tail.snapshot_id,
        });
    }
    return { snapshots, nextCursor };
}
function retentionPolicyForDiskUsage(diskUsagePercent) {
    if (diskUsagePercent != null && diskUsagePercent >= diskCriticalThresholdPercent) {
        return {
            name: "critical",
            nonPinnedRetentionDays: 2,
            nonPinnedMaxPerPad: 50,
            pinnedMaxPerPad: 2000,
        };
    }
    if (diskUsagePercent != null && diskUsagePercent >= diskAggressiveThresholdPercent) {
        return {
            name: "aggressive",
            nonPinnedRetentionDays: 7,
            nonPinnedMaxPerPad: 200,
            pinnedMaxPerPad: 2000,
        };
    }
    return {
        name: "normal",
        nonPinnedRetentionDays: 30,
        nonPinnedMaxPerPad: 500,
        pinnedMaxPerPad: 2000,
    };
}
function readDiskUsagePercent() {
    try {
        const stats = (0, fs_1.statfsSync)(dataDir);
        const total = stats.blocks * stats.bsize;
        if (total <= 0)
            return null;
        const used = (stats.blocks - stats.bfree) * stats.bsize;
        const percent = (used / total) * 100;
        if (!Number.isFinite(percent))
            return null;
        return Math.max(0, Math.min(100, percent));
    }
    catch {
        return null;
    }
}
function pruneSnapshots(policy) {
    const nowUnix = Math.floor(Date.now() / 1000);
    const cutoffUnix = nowUnix - policy.nonPinnedRetentionDays * 24 * 60 * 60;
    statements.deleteOldNonPinnedSnapshots.run(cutoffUnix);
    statements.trimNonPinnedByPad.run(policy.nonPinnedMaxPerPad);
    statements.trimPinnedByPad.run(policy.pinnedMaxPerPad);
}
function runWalCheckpoint() {
    db.pragma("wal_checkpoint(TRUNCATE)");
}
function shouldRun(lastRunAt, intervalMs, now) {
    if (!lastRunAt)
        return true;
    return now.getTime() - lastRunAt.getTime() >= intervalMs;
}
function buildBackupConfig() {
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
    const client = new client_s3_1.S3Client({
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
function listLocalBackupFiles() {
    try {
        const files = (0, fs_1.readdirSync)(backupDir)
            .filter((name) => name.endsWith(".sqlite") || name.endsWith(".sqlite3"))
            .map((name) => path_1.default.join(backupDir, name));
        files.sort((a, b) => (0, fs_1.statSync)(b).mtimeMs - (0, fs_1.statSync)(a).mtimeMs);
        return files;
    }
    catch {
        return [];
    }
}
function pruneLocalBackups() {
    const maxAgeMs = Math.max(1, backupKeepLocalDays) * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - maxAgeMs;
    for (const filePath of listLocalBackupFiles()) {
        try {
            const stats = (0, fs_1.statSync)(filePath);
            if (stats.mtimeMs < cutoffMs) {
                (0, fs_1.unlinkSync)(filePath);
            }
        }
        catch {
            // best effort
        }
    }
}
function backupFilename(now) {
    const stamp = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    return `chrony-sync-${stamp}.sqlite`;
}
async function runBackup(now, reason) {
    const filename = backupFilename(now);
    const backupPath = path_1.default.join(backupDir, filename);
    await db.backup(backupPath);
    if (backupConfig.enabled && backupConfig.client && backupConfig.bucket) {
        const key = `${backupConfig.keyPrefix}/${filename}`;
        const body = (0, fs_1.readFileSync)(backupPath);
        await backupConfig.client.send(new client_s3_1.PutObjectCommand({
            Bucket: backupConfig.bucket,
            Key: key,
            Body: body,
            ContentType: "application/x-sqlite3",
        }));
    }
    pruneLocalBackups();
    lastBackupRunAt = now;
    writeMetadataDate("last_backup_run_at", now);
    writeMetadataString("last_backup_error", "");
    lastBackupErrorMessage = null;
    console.log(`[backup] completed reason=${reason} file=${backupPath}`);
}
function runBackupVerify(now, reason) {
    const files = listLocalBackupFiles();
    if (files.length === 0) {
        throw new Error("No local backup files available to verify");
    }
    const latest = files[0];
    const verifyDb = new better_sqlite3_1.default(latest, { readonly: true, fileMustExist: true });
    try {
        const result = verifyDb.prepare("PRAGMA integrity_check").pluck().get();
        if (!result || result.toLowerCase() !== "ok") {
            throw new Error(`Backup integrity check failed for ${latest}: ${result || "unknown"}`);
        }
    }
    finally {
        verifyDb.close();
    }
    lastBackupVerifyAt = now;
    writeMetadataDate("last_backup_verify_at", now);
    console.log(`[backup] verify completed reason=${reason} file=${latest}`);
}
async function schedulerTick(reason) {
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
                console.warn(`[disk] pressure=${policy.name} usage=${diskUsagePercent == null ? "unknown" : `${diskUsagePercent.toFixed(2)}%`}`);
                lastDiskPressureLevel = policy.name;
            }
            pruneSnapshots(policy);
            runWalCheckpoint();
            if (policy.name === "aggressive" || policy.name === "critical") {
                const lastVacuumAt = readMetadataDate("last_vacuum_run_at");
                if (shouldRun(lastVacuumAt, 24 * 60 * 60 * 1000, now)) {
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
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "unknown backup error";
                lastBackupErrorMessage = message;
                writeMetadataString("last_backup_error", message);
                console.error("[backup] failed:", message);
            }
        }
        if (shouldRun(lastBackupVerifyAt, backupVerifyIntervalMs, now)) {
            try {
                runBackupVerify(now, reason);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "unknown verify error";
                lastBackupErrorMessage = message;
                writeMetadataString("last_backup_error", message);
                console.error("[backup] verify failed:", message);
            }
        }
    }
    finally {
        schedulerInFlight = false;
    }
}
function dbWritableStatus() {
    try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        return true;
    }
    catch {
        try {
            db.exec("ROLLBACK");
        }
        catch {
            // no-op
        }
        return false;
    }
}
const writeCanonicalSnapshotTx = db.transaction((padId, incoming) => {
    const current = ensureSnapshot(padId);
    const incomingDate = new Date(incoming.lastModified);
    const currentDate = new Date(current.lastModified);
    if (incomingDate <= currentDate) {
        return { canonical: current, accepted: false };
    }
    const version = nextGlobalVersion();
    const canonical = {
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
});
const restoreSnapshotTx = db.transaction((padId, snapshotID) => {
    const row = statements.selectSnapshotById.get(padId, snapshotID);
    if (!row) {
        return null;
    }
    const now = new Date();
    const version = nextGlobalVersion();
    const restored = {
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
});
const clearPadTx = db.transaction((padId) => {
    statements.deletePad.run(padId);
    const version = nextGlobalVersion();
    const cleared = {
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
    let parsed;
    try {
        parsed = buildSnapshotFromPayload(req.body);
    }
    catch (error) {
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
    const page = listSnapshots(padId, typeof req.query.cursor === "string" ? req.query.cursor : undefined, typeof req.query.limit === "string" ? req.query.limit : undefined);
    res.json({
        snapshots: page.snapshots,
        nextCursor: page.nextCursor,
    });
});
// POST /pads/:padId/snapshots – create manual pinned snapshot
app.post("/pads/:padId/snapshots", (req, res) => {
    const padId = req.params.padId;
    ensureSnapshot(padId);
    let parsed;
    try {
        parsed = buildSnapshotFromPayload(req.body);
    }
    catch (error) {
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
    const body = req.body;
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
    }
    catch (error) {
        console.error("Failed to sign promotional offer:", error);
        res.status(500).json({ error: "Unable to sign promotional offer." });
    }
});
app.get("/health", (_req, res) => {
    const now = new Date();
    const diskUsagePercent = readDiskUsagePercent();
    const maintenanceLagSeconds = lastMaintenanceRunAt == null
        ? null
        : Math.max(0, Math.floor((now.getTime() - lastMaintenanceRunAt.getTime() - maintenanceIntervalMs) / 1000));
    const backupAgeSeconds = lastBackupRunAt == null ? null : Math.max(0, Math.floor((now.getTime() - lastBackupRunAt.getTime()) / 1000));
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
            intervalSeconds: Math.floor(maintenanceIntervalMs / 1000),
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
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
const clients = new Set();
wss.on("connection", (ws, req) => {
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
    const client = {
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
        if (client.ws.readyState !== ws_1.WebSocket.OPEN) {
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
        }
        catch (error) {
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
function broadcastSnapshot(padId) {
    const row = statements.selectPad.get(padId);
    if (!row)
        return;
    const payload = JSON.stringify(rowToSnapshot(row));
    for (const client of clients) {
        if (client.padId === padId && client.ws.readyState === ws_1.WebSocket.OPEN) {
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
