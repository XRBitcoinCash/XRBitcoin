// xrpl-proxy/server.js — XRPL JSON-RPC + optional WS tunnel (no placeholders)

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const http = require("http");
const { WebSocket, WebSocketServer } = require("ws");

// ------------------ Config (from env) ------------------
const PORT = process.env.PORT || 10000;

// XRPL upstreams (HTTP JSON-RPC & WebSocket). Use reliable public endpoints.
const XRPL_HTTP = process.env.XRPL_HTTP || "https://s1.ripple.com:51234";
const XRPL_WSS  = process.env.XRPL_WSS  || "wss://xrplcluster.com";

// Strict CORS — only your production sites (expand if you add subpages)
const CORS_ORIGINS = [
  "https://xrbitcoincash.com",
  "https://www.xrbitcoincash.com",
  "https://xrbitcoincash.github.io"
];

// ------------------ App & middleware -------------------
const app = express();
app.use(cors({
  origin: function (origin, cb) {
    // allow same-origin / curl (no origin header)
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Blocked by CORS: " + origin));
  },
  methods: ["GET","POST","OPTIONS"],
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });

// ------------------ Helpers ----------------------------
async function xrplRpc(body) {
  const r = await axios.post(XRPL_HTTP, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
    validateStatus: () => true
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`XRPL HTTP ${r.status}`);
  }
  return r.data;
}

// ------------------ Routes -----------------------------
// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Generic XRPL passthrough (POST XRPL JSON here)
app.post("/", async (req, res) => {
  try {
    const data = await xrplRpc(req.body);
    // XRPL returns {result:...} or {error:...}
    res.json(data);
  } catch (err) {
    console.error("[proxy error]", err.message || err);
    res.status(502).json({ error: "Proxy request failed", detail: err.message || String(err) });
  }
});

// Helpful read-only endpoints (used by your UI)
app.get("/api/xrpl/ledger", async (_req, res) => {
  try {
    const data = await xrplRpc({ method: "ledger", params: [{ ledger_index: "validated" }] });
    res.json(data);
  } catch (err) {
    console.error("[ledger]", err.message || err);
    res.status(502).json({ error: "Ledger fetch failed", detail: err.message || String(err) });
  }
});

app.get("/api/xrpl/account/:acct", async (req, res) => {
  try {
    const data = await xrplRpc({ method: "account_info", params: [{ account: req.params.acct, ledger_index: "validated" }] });
    res.json(data);
  } catch (err) {
    console.error("[account]", err.message || err);
    res.status(502).json({ error: "Account fetch failed", detail: err.message || String(err) });
  }
});

// ------------------ WS tunnel (optional) ---------------
// Browser connects to wss://<your-render>/ws, we bridge to XRPL_WSS
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (client) => {
      // Upstream connection to XRPL
      const upstream = new WebSocket(XRPL_WSS);

      upstream.on("open", () => console.log("[ws] upstream connected"));
      upstream.on("message", (msg) => client.readyState === WebSocket.OPEN && client.send(msg));
      upstream.on("error", (e) => { console.error("[ws upstream error]", e?.message || e); client.close(1011); });
      upstream.on("close", () => client.close());

      client.on("message", (msg) => upstream.readyState === WebSocket.OPEN && upstream.send(msg));
      client.on("error", (e) => { console.error("[ws client error]", e?.message || e); upstream.close(1011); });
      client.on("close", () => upstream.close());
    });
  } else {
    socket.destroy();
  }
});

// 404 fallback
app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path, method: req.method }));

// Boot
server.listen(PORT, () => {
  console.log(`✅ XRPL proxy ready on :${PORT}`);
  console.log(`   HTTP upstream: ${XRPL_HTTP}`);
  console.log(`   WSS  upstream: ${XRPL_WSS}`);
});
