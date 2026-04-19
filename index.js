import { Sandbox } from "e2b";
import { createServer } from "http";
import { JSDOM, VirtualConsole } from "jsdom";

const PORT = process.env.PORT || 3001;
const PROXY_SECRET = process.env.PROXY_SECRET || "vocabuquiz-e2b-2026";
const E2B_API_KEY = process.env.E2B_API_KEY || "";

/* ═══ Sandbox pool — reuse sandboxes for efficiency ═══ */
let activeSandbox = null;
let lastUsed = 0;
const SANDBOX_TIMEOUT = 1800; // 30 min (longer for live server sessions)
const IDLE_KILL = 600000; // 10 min idle → kill (was 2min; live preview needs longer)
let liveServerRunning = false;
const LIVE_SERVER_PORT = 8080;

let playwrightReady = false;

async function ensurePlaywright(sandbox) {
  if (playwrightReady) return;
  console.log("[E2B] Installing Playwright chromium + system deps (first-time)...");
  try {
    /* pip + chromium (usually already cached), then system libs needed for headless chrome */
    await sandbox.commands.run("pip install playwright --quiet 2>&1 | tail -1 && playwright install chromium 2>&1 | tail -1", { timeout: 120 });
    /* chromium system deps — may already be present, best-effort */
    const depsCmd = "sudo -n apt-get update -qq 2>&1 | tail -1; sudo -n apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 2>&1 | tail -3";
    try { await sandbox.commands.run(depsCmd, { timeout: 90 }); } catch (e) { console.warn("[E2B] apt install warn:", e.message); }
    playwrightReady = true;
    console.log("[E2B] Playwright ready");
  } catch (e) {
    console.error("[E2B] Playwright install failed:", e.message);
  }
}

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
  playwrightReady = false;
  liveServerRunning = false;
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

    /* ── POST /screenshot — Render HTML and capture a PNG screenshot ── */
    if (req.method === "POST" && path === "/screenshot") {
      const body = await readBody(req);
      const html = String(body.html || "");
      const viewport = body.viewport === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      const waitMs = Math.min(Number(body.waitMs) || 800, 5000);
      const fullPage = Boolean(body.fullPage);
      if (!html) return jsonResp(res, 400, { ok: false, error: "html required" });

      const sandbox = await getSandbox();
      await ensurePlaywright(sandbox);
      await sandbox.files.write("/home/user/_app.html", html);

      const script = `
import asyncio, base64, json, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": ${viewport.width}, "height": ${viewport.height}})
        page = await ctx.new_page()
        logs = []
        page.on("console", lambda msg: logs.append({"type": msg.type, "text": msg.text}))
        page.on("pageerror", lambda err: logs.append({"type": "error", "text": str(err)}))
        await page.goto("file:///home/user/_app.html", wait_until="networkidle", timeout=15000)
        await page.wait_for_timeout(${waitMs})
        img = await page.screenshot(type="png", full_page=${fullPage ? "True" : "False"})
        print(json.dumps({"b64": base64.b64encode(img).decode(), "logs": logs[:50]}))
        await b.close()
asyncio.run(main())
`;
      await sandbox.files.write("/home/user/_screenshot.py", script);
      const result = await sandbox.commands.run("python3 /home/user/_screenshot.py", { timeout: 30 });
      if (result.exitCode !== 0) {
        return jsonResp(res, 500, { ok: false, error: "screenshot failed", stderr: result.stderr });
      }
      try {
        const parsed = JSON.parse(result.stdout);
        return jsonResp(res, 200, { ok: true, screenshot_base64: parsed.b64, consoleLogs: parsed.logs });
      } catch (e) {
        return jsonResp(res, 500, { ok: false, error: "parse failed", stdout: result.stdout.slice(0, 500) });
      }
    }

    /* ── POST /console — JSDOM-based HTML runtime verification (fast, no sandbox) ── */
    if (req.method === "POST" && path === "/console") {
      const body = await readBody(req);
      const html = String(body.html || "");
      const waitMs = Math.min(Math.max(Number(body.waitMs) || 800, 50), 5000);
      const interactions = Array.isArray(body.interactions) ? body.interactions.slice(0, 20) : [];
      if (!html) return jsonResp(res, 400, { ok: false, error: "html required" });

      const logs = [];
      const vc = new VirtualConsole();
      vc.on("error", (e) => logs.push({ type: "error", text: String(e?.stack || e?.message || e).slice(0, 500) }));
      vc.on("warn", (m) => logs.push({ type: "warning", text: String(m).slice(0, 500) }));
      vc.on("log", (m) => logs.push({ type: "log", text: String(m).slice(0, 500) }));
      vc.on("info", (m) => logs.push({ type: "info", text: String(m).slice(0, 500) }));
      vc.on("jsdomError", (e) => logs.push({ type: "error", text: String(e?.message || e).slice(0, 500) }));

      let dom;
      try {
        dom = new JSDOM(html, {
          runScripts: "dangerously",
          resources: "usable",
          pretendToBeVisual: true,
          virtualConsole: vc,
          url: "https://sede.app/",
        });
      } catch (e) {
        return jsonResp(res, 200, { ok: true, logs: [{ type: "error", text: "JSDOM parse failed: " + (e?.message || "") }], bodyText: "", buttons: 0, inputs: 0 });
      }

      const { window } = dom;

      /* Trap window.onerror / unhandledrejection */
      window.addEventListener("error", (e) => {
        logs.push({ type: "error", text: String(e?.error?.stack || e?.message || "window error").slice(0, 500) });
      });
      window.addEventListener("unhandledrejection", (e) => {
        logs.push({ type: "error", text: "Unhandled rejection: " + String(e?.reason?.stack || e?.reason || "").slice(0, 500) });
      });

      /* Wait for scripts to execute + any timers */
      await new Promise((r) => setTimeout(r, waitMs));

      /* Apply interactions sequentially */
      for (const it of interactions) {
        try {
          if (it.type === "click" && it.selector) {
            const el = window.document.querySelector(String(it.selector));
            if (el && typeof el.click === "function") el.click();
            else logs.push({ type: "interact_err", text: "click: selector not found " + it.selector });
          } else if (it.type === "type" && it.selector) {
            const el = window.document.querySelector(String(it.selector));
            if (el) {
              el.value = String(it.text || "");
              try { el.dispatchEvent(new window.Event("input", { bubbles: true })); } catch {}
              try { el.dispatchEvent(new window.Event("change", { bubbles: true })); } catch {}
            } else {
              logs.push({ type: "interact_err", text: "type: selector not found " + it.selector });
            }
          } else if (it.type === "wait") {
            await new Promise((r) => setTimeout(r, Math.min(Number(it.ms) || 200, 3000)));
          } else if (it.type === "keydown" && it.selector) {
            const el = window.document.querySelector(String(it.selector));
            if (el) {
              const ev = new window.KeyboardEvent("keydown", { key: String(it.key || ""), bubbles: true });
              el.dispatchEvent(ev);
            }
          }
        } catch (e) {
          logs.push({ type: "interact_err", text: (it.type || "?") + ": " + String(e?.message || e).slice(0, 300) });
        }
      }

      const doc = window.document;
      let bodyText = "";
      try {
        /* Clone body, strip script/style before extracting text to avoid noise */
        const clone = doc.body?.cloneNode(true);
        if (clone) {
          Array.from(clone.querySelectorAll("script,style,noscript")).forEach(n => n.remove());
          bodyText = String(clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000);
        }
      } catch {}
      const buttons = (doc.querySelectorAll("button") || []).length;
      const inputs = (doc.querySelectorAll("input,textarea,select") || []).length;
      const headings = Array.from(doc.querySelectorAll("h1,h2,h3")).slice(0, 10).map(h => (h.tagName.toLowerCase() + ": " + (h.textContent || "").trim().slice(0, 60)));
      const imgs = (doc.querySelectorAll("img") || []).length;
      const forms = (doc.querySelectorAll("form") || []).length;

      try { window.close(); } catch {}

      return jsonResp(res, 200, {
        ok: true,
        logs: logs.slice(0, 100),
        bodyText,
        buttons,
        inputs,
        headings,
        imgs,
        forms,
      });
    }

    /* ── POST /test — Run a Playwright test script inline ── */
    if (req.method === "POST" && path === "/test") {
      const body = await readBody(req);
      const html = String(body.html || "");
      const testScript = String(body.test || "");
      if (!html || !testScript) return jsonResp(res, 400, { ok: false, error: "html and test required" });

      const sandbox = await getSandbox();
      await ensurePlaywright(sandbox);
      await sandbox.files.write("/home/user/_app.html", html);

      const script = `
import asyncio, json
from playwright.async_api import async_playwright
async def main():
    results = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        page = await b.new_page()
        page.on("pageerror", lambda err: results.append({"type": "error", "text": str(err)[:500]}))
        await page.goto("file:///home/user/_app.html", wait_until="networkidle", timeout=15000)
        try:
${testScript.split("\n").map(l => "            " + l).join("\n")}
            results.append({"type": "pass", "text": "all assertions passed"})
        except AssertionError as e:
            results.append({"type": "fail", "text": str(e)[:500]})
        except Exception as e:
            results.append({"type": "error", "text": type(e).__name__ + ": " + str(e)[:500]})
        print(json.dumps({"results": results}))
        await b.close()
asyncio.run(main())
`;
      await sandbox.files.write("/home/user/_test.py", script);
      const result = await sandbox.commands.run("python3 /home/user/_test.py", { timeout: 45 });
      try {
        const parsed = JSON.parse(result.stdout);
        const passed = parsed.results.every(r => r.type === "pass");
        return jsonResp(res, 200, { ok: true, passed, results: parsed.results });
      } catch {
        return jsonResp(res, 500, { ok: false, error: "parse failed", stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) });
      }
    }

    /* ── POST /search — ripgrep across sandbox files ── */
    if (req.method === "POST" && path === "/search") {
      const body = await readBody(req);
      const pattern = String(body.pattern || "").trim();
      const searchPath = String(body.path || "/tmp").trim();
      const maxResults = Math.min(Number(body.maxResults) || 50, 500);
      if (!pattern) return jsonResp(res, 400, { ok: false, error: "pattern required" });

      const sandbox = await getSandbox();
      const safePattern = pattern.replace(/'/g, "'\\''");
      const safePath = searchPath.replace(/'/g, "'\\''");
      const result = await sandbox.commands.run(
        `(command -v rg >/dev/null 2>&1 || pip install --quiet ripgrep 2>/dev/null || true); grep -rn --include='*' '${safePattern}' '${safePath}' 2>/dev/null | head -${maxResults}`,
        { timeout: 20 }
      );
      const lines = (result.stdout || "").split("\n").filter(Boolean);
      return jsonResp(res, 200, { ok: true, matches: lines, count: lines.length });
    }

    /* ── POST /ls — List directory ── */
    if (req.method === "POST" && path === "/ls") {
      const body = await readBody(req);
      const dirPath = String(body.path || "/tmp").trim();
      const sandbox = await getSandbox();
      const result = await sandbox.commands.run(`ls -la '${dirPath.replace(/'/g, "'\\''")}'`, { timeout: 10 });
      return jsonResp(res, 200, { ok: true, output: result.stdout, stderr: result.stderr });
    }

    /* ── POST /install — npm/pip install packages ── */
    if (req.method === "POST" && path === "/install") {
      const body = await readBody(req);
      const manager = body.manager === "pip" ? "pip" : "npm";
      const packages = Array.isArray(body.packages) ? body.packages : [];
      const cwd = String(body.cwd || "/tmp/app").replace(/'/g, "'\\''");
      if (!packages.length) return jsonResp(res, 400, { ok: false, error: "packages required" });

      const safePkgs = packages.map(p => String(p).replace(/[^a-zA-Z0-9@/_\-.]/g, "")).filter(Boolean);
      if (!safePkgs.length) return jsonResp(res, 400, { ok: false, error: "no valid packages" });

      const sandbox = await getSandbox();
      const cmd = manager === "pip"
        ? `pip install --quiet ${safePkgs.join(" ")} 2>&1 | tail -20`
        : `cd '${cwd}' && (test -f package.json || npm init -y >/dev/null) && npm install --silent ${safePkgs.join(" ")} 2>&1 | tail -20`;
      const result = await sandbox.commands.run(cmd, { timeout: 120 });
      return jsonResp(res, 200, { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    }

    /* ── POST /build — Run build command in cwd ── */
    if (req.method === "POST" && path === "/build") {
      const body = await readBody(req);
      const cwd = String(body.cwd || "/tmp/app").replace(/'/g, "'\\''");
      const cmd = String(body.command || "npm run build").replace(/[;&|`$]/g, "");
      const sandbox = await getSandbox();
      const result = await sandbox.commands.run(`cd '${cwd}' && ${cmd} 2>&1 | tail -100`, { timeout: 180 });
      return jsonResp(res, 200, { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    }

    /* ── POST /serve — Live preview server (multi-file support) ── */
    if (req.method === "POST" && path === "/serve") {
      const body = await readBody(req);
      /* files: { "index.html": "...", "style.css": "...", "app.js": "..." } OR just html string */
      const files = body.files && typeof body.files === "object" ? body.files : null;
      const singleHtml = String(body.html || "");
      const entry = String(body.entrypoint || "index.html");
      if (!files && !singleHtml) return jsonResp(res, 400, { ok: false, error: "files or html required" });

      const sandbox = await getSandbox();

      /* Write files into /home/user/app/ */
      const appDir = "/home/user/app";
      await sandbox.commands.run(`rm -rf ${appDir} && mkdir -p ${appDir}`, { timeout: 15 });
      if (files) {
        for (const [fname, content] of Object.entries(files)) {
          const safeFname = String(fname).replace(/\.\.\//g, "").replace(/^\/+/, "");
          await sandbox.files.write(`${appDir}/${safeFname}`, String(content));
        }
      } else {
        await sandbox.files.write(`${appDir}/${entry}`, singleHtml);
      }

      /* Start or verify http.server on LIVE_SERVER_PORT */
      if (!liveServerRunning) {
        /* Start Python http.server in background, detached from this command */
        await sandbox.commands.run(
          `cd ${appDir} && nohup python3 -m http.server ${LIVE_SERVER_PORT} --bind 0.0.0.0 > /tmp/server.log 2>&1 &`,
          { timeout: 10 }
        );
        /* Wait briefly for server to bind */
        await new Promise((r) => setTimeout(r, 800));
        liveServerRunning = true;
      }

      const host = sandbox.getHost(LIVE_SERVER_PORT);
      const url = (host.startsWith("http") ? host : "https://" + host) + "/" + entry;
      return jsonResp(res, 200, { ok: true, url, host, port: LIVE_SERVER_PORT, entrypoint: entry });
    }

    /* ── POST /serve/stop — Stop live server ── */
    if (req.method === "POST" && path === "/serve/stop") {
      if (!activeSandbox) return jsonResp(res, 200, { ok: true, stopped: false });
      try {
        await activeSandbox.commands.run(`pkill -f 'http.server ${LIVE_SERVER_PORT}' || true; pkill -f 'python3.*server.py' || true; pkill -f 'python3.*app.py' || true; pkill -f 'node.*server.js' || true`, { timeout: 5 });
        liveServerRunning = false;
      } catch (e) {}
      return jsonResp(res, 200, { ok: true, stopped: true });
    }

    /* ── POST /serve-fullstack — Full-stack app with backend (Flask/Express) ──
       Input: { files: { "index.html":..., "server.py":..., "style.css":... },
                entrypoint: "index.html",
                backend: "flask" | "express" | "auto" }
       Output: { ok, url, host, port, backend }                                     */
    if (req.method === "POST" && path === "/serve-fullstack") {
      const body = await readBody(req);
      const files = body.files && typeof body.files === "object" ? body.files : null;
      if (!files) return jsonResp(res, 400, { ok: false, error: "files map required" });

      const entry = String(body.entrypoint || "index.html");
      let backend = String(body.backend || "auto");

      /* Auto-detect backend from file list if "auto" */
      if (backend === "auto") {
        if (files["server.py"] || files["app.py"] || files["main.py"]) backend = "flask";
        else if (files["server.js"] || files["app.js"] && files["package.json"]) backend = "express";
        else backend = "static";
      }

      const sandbox = await getSandbox();
      const appDir = "/home/user/app";

      /* Clean + recreate app directory */
      await sandbox.commands.run(`rm -rf ${appDir} && mkdir -p ${appDir}`, { timeout: 15 });

      /* Write all files */
      for (const [fname, content] of Object.entries(files)) {
        const safeFname = String(fname).replace(/\.\.\//g, "").replace(/^\/+/, "");
        await sandbox.files.write(`${appDir}/${safeFname}`, String(content));
      }

      /* Stop any previous server */
      try {
        await sandbox.commands.run(
          `pkill -f 'http.server ${LIVE_SERVER_PORT}' || true; pkill -f 'python3.*${appDir}' || true; pkill -f 'node.*${appDir}' || true`,
          { timeout: 5 }
        );
      } catch {}
      liveServerRunning = false;

      let startCmd = "";
      let installCmd = "";
      let pyEntry = "";

      if (backend === "flask") {
        /* Find Python entrypoint */
        pyEntry = files["server.py"] ? "server.py" : (files["app.py"] ? "app.py" : (files["main.py"] ? "main.py" : ""));
        if (!pyEntry) return jsonResp(res, 400, { ok: false, error: "Flask backend requested but no server.py/app.py/main.py found" });

        /* Install Flask + any requirements.txt */
        const hasRequirements = Boolean(files["requirements.txt"]);
        installCmd = hasRequirements
          ? `pip install -r ${appDir}/requirements.txt 2>&1 | tail -10`
          : `pip install flask flask-cors 2>&1 | tail -5`;

        /* Expose LIVE_SERVER_PORT via env var so server can pick it up */
        startCmd = `cd ${appDir} && (PORT=${LIVE_SERVER_PORT} FLASK_APP=${pyEntry} setsid python3 ${pyEntry} > /tmp/server.log 2>&1 < /dev/null &) ; sleep 0.1 ; echo STARTED`;
      } else if (backend === "express") {
        const jsEntry = files["server.js"] ? "server.js" : "app.js";
        const hasPackageJson = Boolean(files["package.json"]);
        installCmd = hasPackageJson
          ? `cd ${appDir} && npm install 2>&1 | tail -5`
          : `cd ${appDir} && npm init -y >/dev/null && npm install express cors 2>&1 | tail -5`;
        startCmd = `cd ${appDir} && (PORT=${LIVE_SERVER_PORT} setsid node ${jsEntry} > /tmp/server.log 2>&1 < /dev/null &) ; sleep 0.1 ; echo STARTED`;
      } else {
        /* static fallback */
        startCmd = `cd ${appDir} && (setsid python3 -m http.server ${LIVE_SERVER_PORT} --bind 0.0.0.0 > /tmp/server.log 2>&1 < /dev/null &) ; sleep 0.1 ; echo STARTED`;
      }

      /* Run install step (if any) — generous timeout for first-time installs */
      let installLog = "";
      if (installCmd) {
        try {
          const ir = await sandbox.commands.run(installCmd, { timeout: 180 });
          installLog = (ir.stdout || "") + (ir.stderr ? "\n" + ir.stderr : "");
        } catch (e) {
          return jsonResp(res, 500, { ok: false, error: "install failed: " + (e?.message || ""), backend, installLog });
        }
      }

      /* Start server — subshell detach ensures commands.run exits immediately */
      let startLog = "";
      try {
        const sr = await sandbox.commands.run(startCmd, { timeout: 15 });
        startLog = (sr.stdout || "") + (sr.stderr ? "\n" + sr.stderr : "");
      } catch (e) {
        return jsonResp(res, 500, { ok: false, error: "start failed: " + (e?.message || ""), backend, installLog, startLog });
      }

      /* Wait for server to bind + do a health ping via curl */
      await new Promise((r) => setTimeout(r, 2000));
      let serverOk = false;
      let serverLog = "";
      try {
        const ping = await sandbox.commands.run(
          `for i in 1 2 3 4 5; do curl -sf -m 2 http://localhost:${LIVE_SERVER_PORT}/ -o /dev/null && { echo "UP"; break; } || sleep 1; done; echo "---LOG---"; tail -20 /tmp/server.log 2>/dev/null`,
          { timeout: 12 }
        );
        serverLog = ping.stdout || "";
        serverOk = serverLog.includes("UP");
      } catch {}

      liveServerRunning = serverOk;
      const host = sandbox.getHost(LIVE_SERVER_PORT);
      const url = (host.startsWith("http") ? host : "https://" + host) + (backend === "static" ? "/" + entry : "/");

      return jsonResp(res, serverOk ? 200 : 500, {
        ok: serverOk,
        url,
        host,
        port: LIVE_SERVER_PORT,
        backend,
        entrypoint: entry,
        installLog: installLog.slice(0, 500),
        serverLog: serverLog.slice(0, 1000),
        error: serverOk ? null : "server did not respond on port " + LIVE_SERVER_PORT
      });
    }

    /* ── GET /health ── */
    if (req.method === "GET" && path === "/health") {
      return jsonResp(res, 200, {
        ok: true,
        sandbox: activeSandbox ? activeSandbox.sandboxId : null,
        playwrightReady,
        liveServerRunning,
        uptime: process.uptime()
      });
    }

    jsonResp(res, 404, { ok: false, error: "Not found" });

  } catch (err) {
    console.error("[E2B] Error:", err.message);
    /* If sandbox died, reset (case-insensitive match for E2B errors like "Sandbox is probably not running") */
    const _m = String(err.message || "").toLowerCase();
    if (_m.includes("sandbox") || _m.includes("not found") || _m.includes("deadline_exceeded") || _m.includes("unavailable")) {
      console.log("[E2B] Resetting sandbox cache due to error");
      activeSandbox = null;
      playwrightReady = false;
    }
    jsonResp(res, 500, { ok: false, error: err.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[E2B Proxy] Running on port ${PORT}`);
  console.log(`[E2B Proxy] API Key: ${E2B_API_KEY ? "set" : "NOT SET"}`);
});
