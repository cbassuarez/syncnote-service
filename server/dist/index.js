"use strict";
// server/index.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const defaultPromotionalOfferProductIDs = ["CHRNPROANNUALLY"];
const invisibleSeparator = "\u2063";
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// One snapshot per padID, plus a global version counter.
const pads = new Map();
let globalVersionCounter = 0;
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
// Ensure we always have at least an empty pad
function ensureSnapshot(padId) {
    let snap = pads.get(padId);
    if (!snap) {
        snap = {
            text: "",
            lastModified: new Date().toISOString(),
            deviceID: "server",
            version: globalVersionCounter,
        };
        pads.set(padId, snap);
    }
    return snap;
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
    const body = req.body;
    if (typeof body.text !== "string" ||
        typeof body.lastModified !== "string" ||
        typeof body.deviceID !== "string") {
        res.status(400).json({ error: "Invalid snapshot payload" });
        return;
    }
    const incomingDate = new Date(body.lastModified);
    if (Number.isNaN(incomingDate.getTime())) {
        res.status(400).json({ error: "Invalid lastModified" });
        return;
    }
    const current = ensureSnapshot(padId);
    const currentDate = new Date(current.lastModified);
    let canonicalSnapshot;
    if (incomingDate > currentDate) {
        globalVersionCounter += 1;
        const updated = {
            text: body.text,
            lastModified: incomingDate.toISOString(),
            deviceID: body.deviceID,
            version: globalVersionCounter,
        };
        pads.set(padId, updated);
        broadcastSnapshot(padId);
        canonicalSnapshot = updated;
    }
    else {
        // Stale write, but we still return canonical snapshot
        canonicalSnapshot = current;
    }
    res.setHeader("ETag", snapshotETag(canonicalSnapshot));
    res.status(200).json(canonicalSnapshot);
});
// DELETE /pads/:padId – clear this pad and broadcast reset state
app.delete("/pads/:padId", (req, res) => {
    const padId = req.params.padId;
    const existed = pads.delete(padId);
    if (existed) {
        console.log("Deleted pad:", padId);
    }
    globalVersionCounter += 1;
    const cleared = {
        text: "",
        lastModified: new Date().toISOString(),
        deviceID: "server",
        version: globalVersionCounter,
    };
    pads.set(padId, cleared);
    broadcastSnapshot(padId);
    res.status(204).send();
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
    if (config.allowedProductIDs.has(productID) === false) {
        res.status(403).json({ error: "This product is not allowed for promotional signing." });
        return;
    }
    if (config.allowedOfferIDs.size > 0 &&
        config.allowedOfferIDs.has(offerID) === false) {
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
// Simple health endpoint
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});
const server = http_1.default.createServer(app);
// WebSocket for live updates across pads
const wss = new ws_1.WebSocketServer({
    server,
    // No fixed path here so we can handle /ws/pads/:padId dynamically
});
// Track clients + which pad they’re subscribed to
const clients = new Set();
const wsHeartbeatIntervalMs = 25000;
const wsStaleTimeoutMs = 75000;
wss.on("connection", (ws, req) => {
    const url = req.url || "";
    // Expect: /ws/pads/<padId>
    const match = url.match(/^\/ws\/pads\/(.+)$/);
    if (!match) {
        console.warn("WS connection with unexpected path:", url);
        ws.close();
        return;
    }
    const padId = decodeURIComponent(match[1]);
    console.log("WebSocket client connected for pad:", padId);
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
        console.log("WebSocket client disconnected for pad:", padId);
        clients.delete(client);
    });
    ws.on("error", (err) => {
        console.error("WebSocket error:", err);
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
wss.on("close", () => {
    clearInterval(wsHeartbeat);
});
function broadcastSnapshot(padId) {
    const snap = pads.get(padId);
    if (!snap)
        return;
    const payload = JSON.stringify(snap);
    for (const client of clients) {
        if (client.padId === padId && client.ws.readyState === ws_1.WebSocket.OPEN) {
            client.ws.send(payload);
        }
    }
}
const port = Number(process.env.PORT) || 4000;
server.listen(port, () => {
    console.log(`Bus backend listening on port ${port}`);
});
