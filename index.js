// index.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import { CONFIG } from "./config.js";
import { parseSymbol } from "./scripts/symbols.js";
import { execSync, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   Console title
========================= */
function setConsoleTitle(title) {
  try {
    process.title = title;
    process.stdout.write(`\x1b]0;${title}\x07`);
  } catch {}

  try {
    if (process.platform === "win32") {
      execSync(`title ${title}`, { stdio: "ignore" });
    }
  } catch {}
}


/* =========================
   WAKE LOCK (prevent Windows sleep)
========================= */
function startWakeLock() {

  const ps = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Power { [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f); }'; while ($true) { [Power]::SetThreadExecutionState(0x80000001); Start-Sleep -Seconds 30 }"
    ],
    { detached: false, stdio: "ignore" }
  );
  ps.on("error", () => {}); // ignore if powershell not available
  process.on("exit", () => { try { ps.kill(); } catch {} });
}

startWakeLock();

/* =========================
   MAIN
========================= */
const { pair } = parseSymbol(CONFIG.MARKET);
const folder = path.basename(__dirname);

// lepiej: CONFIG.MODE jeśli jest, fallback na stary PAPER
const mode =
  String(CONFIG.MODE ?? (CONFIG.PAPER ? "PAPER" : "LIVE")).toUpperCase(); // PAPER / TEST / LIVE

setConsoleTitle(`${pair} "${folder}" [${mode}]`);

// UI server removed

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ unhandledRejection:", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.error("⚠️ uncaughtException:", err?.message || err);
});

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrapBot() {
  const mod = await import("./scripts/bot.js");
  if (typeof mod.startBot !== "function") {
    throw new Error("scripts/bot.js: brak eksportu startBot");
  }
  await mod.startBot();
}

while (true) {
  try {
    await bootstrapBot();
    break;
  } catch (err) {
    const msg = String(err?.message || err || "");
    console.error(`⚠️ startBot failed: ${msg}`);
    if (msg.includes("FATAL_NO_RETRY:")) {
      console.error("⛔ Startup aborted (fatal configuration/auth error). Fix credentials/config and restart bot.");
      process.exit(1);
    }
    console.error("↻ retry start in 5s...");
    await sleep(5000);
  }
}
