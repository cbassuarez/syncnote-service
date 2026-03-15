// server/index.ts

import cors from "cors";
import { createPrivateKey, createSign, randomUUID } from "crypto";
import express from "express";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";

type Snapshot = {
  text: string;
  lastModified: string; // ISO8601
  deviceID: string;
  version: number;
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
};

const defaultPromotionalOfferProductIDs = ["CHRNPROANNUALLY"];
const invisibleSeparator = "\u2063";

const app = express();
app.use(cors());
app.use(express.json());

// One snapshot per padID, plus a global version counter.
const pads = new Map<string, Snapshot>();
let globalVersionCounter = 0;

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

// Ensure we always have at least an empty pad
function ensureSnapshot(padId: string): Snapshot {
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

// GET /pads/:padId – return latest snapshot for this pad
app.get("/pads/:padId", (req, res) => {
  const padId = req.params.padId;
  const snap = ensureSnapshot(padId);
  res.json(snap);
});

// PUT /pads/:padId – last-writer-wins for this pad
app.put("/pads/:padId", (req, res) => {
  const padId = req.params.padId;
  const body = req.body as Partial<Snapshot>;

  if (
    typeof body.text !== "string" ||
    typeof body.lastModified !== "string" ||
    typeof body.deviceID !== "string"
  ) {
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

  if (!current || incomingDate > currentDate) {
    globalVersionCounter += 1;
    const updated: Snapshot = {
      text: body.text,
      lastModified: incomingDate.toISOString(),
      deviceID: body.deviceID,
      version: globalVersionCounter,
    };
    pads.set(padId, updated);
    broadcastSnapshot(padId);
    res.json(updated);
  } else {
    // Stale write, but we still return canonical snapshot
    res.status(200).json(current);
  }
});

// DELETE /pads/:padId – clear this pad and broadcast reset state
app.delete("/pads/:padId", (req, res) => {
  const padId = req.params.padId;
  const existed = pads.delete(padId);
  if (existed) {
    console.log("Deleted pad:", padId);
  }

  globalVersionCounter += 1;
  const cleared: Snapshot = {
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

  const body = req.body as PromotionalOfferSignatureRequest;
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

  if (
    config.allowedOfferIDs.size > 0 &&
    config.allowedOfferIDs.has(offerID) === false
  ) {
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

// Simple health endpoint
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);

// WebSocket for live updates across pads
const wss = new WebSocketServer({
  server,
  // No fixed path here so we can handle /ws/pads/:padId dynamically
});

// Track clients + which pad they’re subscribed to
const clients = new Set<Client>();

wss.on("connection", (ws: WebSocket, req) => {
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

  const client: Client = { ws, padId };
  clients.add(client);

  ws.on("close", () => {
    console.log("WebSocket client disconnected for pad:", padId);
    clients.delete(client);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

function broadcastSnapshot(padId: string) {
  const snap = pads.get(padId);
  if (!snap) return;

  const payload = JSON.stringify(snap);
  for (const client of clients) {
    if (client.padId === padId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

const port = Number(process.env.PORT) || 4000;

server.listen(port, () => {
  console.log(`Bus backend listening on port ${port}`);
});
