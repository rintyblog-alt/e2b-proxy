import { Sandbox } from "e2b";
import { createServer } from "http";

const PORT = process.env.PORT || 3001;
const PROXY_SECRET = process.env.PROXY_SECRET || "vocabuquiz-e2b-2026";
const E2B_API_KEY = process.env.E2B_API_KEY || "";

/* ═══ Sandbox pool — reuse sandboxes for efficiency ═══ */
let activeSandbox = null;
let lastUsed = 0;
const SANDBOX_TIMEOUT = 300; // 5 min
const IDLE_KILL = 120000; // 2 min idle → kill

async function getSandbox() {
  if (activeSandbox) {
    lastUsed = Date.now();
    return activeSandbox;
  }
  console.log("[E2B] Creating new sandbox...");
  activeSandbox = await Sandbox.create({
    apiKey: E2B_API_KEY,
    timeout: SANDBOX_TIMEOUT
  });
  lastUsed = Date.now();
  console.log("[E2B] Sandbox ready:", activeSandbox.sandboxId);
  return activeSandbox;
}

/* Kill idle sandbox */
setInterval(async () => {
  if (activeSandbox && Date.now() - lastUsed > IDLE_KILL) {
    console.log("[E2B] Killing idle sandbox");
    try { await activeSandbox.kill(); } catch {}
    activeSandbox = null;
  }
}, 30000);

/* ═══ HTTP Server ═══ */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function jsonResp(res, status, data) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  /* Auth check */
  const auth = req.headers.authorization || "";
  if (!auth.includes(PROXY_SECRET)) {
    return jsonResp(res, 401, { ok: false, error: "Unauthorized" });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    /* ── POST /exec — Run a command ── */
    if (req.method === "POST" && path === "/exec") {
      const body = await readBody(req);
      const cmd = String(body.command || "").trim();
      if (!cmd) return jsonResp(res, 400, { ok: false, error: "command required" });

      const sandbox = await getSandbox();
      const timeoutMs = Math.min(Number(body.timeout) || 30000, 60000);

      console.log("[E2B] exec:", cmd);
      const result = await sandbox.commands.run(cmd, { timeout: timeoutMs / 1000 });

      return jsonResp(res, 200, {
        ok: true,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exitCode,
        error: result.error || null
      });
    }

    /* ── POST /write — Write a file ── */
    if (req.method === "POST" && path === "/write") {
      const body = await readBody(req);
      const filePath = String(body.path || "").trim();
      const content = String(body.content || "");
      if (!filePath) return jsonResp(res, 400, { ok: false, error: "path required" });

      const sandbox = await getSandbox();
      await sandbox.files.write(filePath, content);

      return jsonResp(res, 200, { ok: true, path: filePath });
    }

    /* ── POST /read — Read a file ── */
    if (req.method === "POST" && path === "/read") {
      const body = await readBody(req);
      const filePath = String(body.path || "").trim();
      if (!filePath) return jsonResp(res, 400, { ok: false, error: "path required" });

      const sandbox = await getSandbox();
      const content = await sandbox.files.read(filePath);

      return jsonResp(res, 200, { ok: true, content });
    }

    /* ── GET /health ── */
    if (req.method === "GET" && path === "/health") {
      return jsonResp(res, 200, {
        ok: true,
        sandbox: activeSandbox ? activeSandbox.sandboxId : null,
        uptime: process.uptime()
      });
    }

    jsonResp(res, 404, { ok: false, error: "Not found" });

  } catch (err) {
    console.error("[E2B] Error:", err.message);
    /* If sandbox died, reset */
    if (err.message?.includes("sandbox") || err.message?.includes("not found")) {
      activeSandbox = null;
    }
    jsonResp(res, 500, { ok: false, error: err.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[E2B Proxy] Running on port ${PORT}`);
  console.log(`[E2B Proxy] API Key: ${E2B_API_KEY ? "set" : "NOT SET"}`);
});
