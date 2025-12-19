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

let currentSnapshot: Snapshot | null = null;
let versionCounter = 0;

// Ensure we always have at least an empty pad
function ensureSnapshot(): Snapshot {
  if (!currentSnapshot) {
    currentSnapshot = {
      text: "",
      lastModified: new Date().toISOString(),
      deviceID: "server",
      version: versionCounter,
    };
  }
  return currentSnapshot!;
}

// GET /pads/default – return latest snapshot
app.get("/pads/default", (_req, res) => {
  const snap = ensureSnapshot();
  res.json(snap);
});

// PUT /pads/default – last-writer-wins
app.put("/pads/default", (req, res) => {
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

  const current = ensureSnapshot();
  const currentDate = new Date(current.lastModified);

  if (!current || incomingDate > currentDate) {
    versionCounter += 1;
    currentSnapshot = {
      text: body.text,
      lastModified: incomingDate.toISOString(),
      deviceID: body.deviceID,
      version: versionCounter,
    };
    broadcastSnapshot();
    res.json(currentSnapshot);
  } else {
    // Stale write, but we still return the canonical snapshot
    res.status(200).json(current);
  }
});

// Simple health endpoint
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);

// WebSocket for live updates
const wss = new WebSocketServer({
  server,
  path: "/ws/pads/default",
});

wss.on("connection", (ws: WebSocket) => {
  console.log("WebSocket client connected");
  const snap = currentSnapshot;
  if (snap) {
    ws.send(JSON.stringify(snap));
  }

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

function broadcastSnapshot() {
  if (!currentSnapshot) return;
  const payload = JSON.stringify(currentSnapshot);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

const port = Number(process.env.PORT) || 4000;

server.listen(port, () => {
  console.log(`Bus backend listening on port ${port}`);
});

