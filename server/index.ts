// server/index.ts

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";

type Snapshot = {
  text: string;
  lastModified: string; // ISO8601
  deviceID: string;
  version: number;
};

const app = express();
app.use(cors());
app.use(express.json());

// One snapshot per padID, plus a global version counter.
const pads = new Map<string, Snapshot>();
let globalVersionCounter = 0;

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
type Client = {
  ws: WebSocket;
  padId: string;
};

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
