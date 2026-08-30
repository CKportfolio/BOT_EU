import "dotenv/config";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";
import {
  startMarketSignal,
  stopMarketSignal,
  getMarketSignal,
  getHistoryBuffer,
  getMomentum as getMarketMomentum,
  getMomentumScore as getMarketMomentumScore,
  getRegimeSnapshot as getMarketRegimeSnapshot,
} from "./momentum_regime.js";
import {
  computeRangeChannel,
  mean as meanKanalarz,
  detectBreakout,
  findDominantRegimeWedge,
  detectWedgeBreakout,
  computeRegimeLevelsMultiFromReversals,
  detectBoxImpulseTrend,
  detectSidewaysTrendFrames,
} from "./channels_core.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const JS_DIR = path.resolve(ROOT_DIR, "js");
const LOGS_DIR = path.resolve(ROOT_DIR, "logs");
const CSV_DIR = path.resolve(ROOT_DIR, "..", "CSV");
const RUNS_DIR = path.resolve(LOGS_DIR, "runs");

const DEFAULT_PORT = 8787;
let activePort = DEFAULT_PORT;
const LIVE_DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_ALIAS_PATH = path.resolve(LOGS_DIR, "market_history_5m.csv");
const HISTORY_ALIAS_JSONL_PATH = path.resolve(LOGS_DIR, "market_history.jsonl");
const INDICATOR_HISTORY_JSON_PATH = path.resolve(LOGS_DIR, "indicator_history.json");
const BOT_UI_STATE_JSON_PATH = path.resolve(LOGS_DIR, "bot_ui_state.json");
const BOT_UI_LOGS_PATH = path.resolve(LOGS_DIR, "bot_ui_logs.ndjson");
const BOT_UI_CMD_PATH = path.resolve(LOGS_DIR, "bot_ui_cmd.json");
const UI_PORT_PATH = path.resolve(LOGS_DIR, "ui_port.json");
const FILE_RETENTION_DAYS = Math.max(1, Number(process.env.FILE_RETENTION_DAYS || 21) || 21);
const FILE_CLEANUP_EVERY_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.FILE_CLEANUP_EVERY_MS || 60 * 60 * 1000) || 60 * 60 * 1000
);
const FILE_RETENTION_MS = FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const INDICATOR_KEEP_MS = 24 * 60 * 60 * 1000;

const UI_HOST = String(process.env.UI_HOST || "127.0.0.42").trim() || "127.0.0.42";
const UI_PORT = Math.max(1, Number(process.env.UI_PORT || DEFAULT_PORT) || DEFAULT_PORT);
const UI_REQUIRE_AUTH = Number(process.env.UI_REQUIRE_AUTH ?? 1) !== 0;
const UI_AUTH_USER = String(process.env.UI_AUTH_USER || "").trim();
const UI_AUTH_PASS = String(process.env.UI_AUTH_PASS || "").trim();
const UI_TRUST_PROXY_HEADERS = Number(process.env.UI_TRUST_PROXY_HEADERS ?? 0) !== 0;
const UI_ENFORCE_IP_ALLOWLIST = Number(process.env.UI_ENFORCE_IP_ALLOWLIST ?? 0) !== 0;

const defaultAllowIps = ["127.0.0.1", "127.0.0.42", "::1", "::ffff:127.0.0.1", "::ffff:127.0.0.42"];
const allowIpRaw = String(process.env.UI_ALLOWED_IPS || "").trim();
const ALLOWED_IPS = (allowIpRaw ? allowIpRaw.split(",") : defaultAllowIps)
  .map((x) => normalizeIp(x.trim()))
  .filter(Boolean);
const ALLOWED_IP_SET = new Set(ALLOWED_IPS);

const state = {
  mode: null, // live | history
  symbol: "BTCUSDT",
  category: "linear",
  screensEnabled: false,

  selectedHistoryPath: null,
  selectedHistoryRows: [],
  selectedIndicatorRows: [],

  sessionCsvPath: null,
  lastSessionBucket: null,
  liveCaptureTimer: null,
  indicatorCaptureTimer: null,
  cleanupTimer: null,
  indicatorHistory: [],
  lastIndicatorMinute: null,

  runtimeStarted: false,
};

const analyticsTfFetchCache = {
  key: "",
  perTf: new Map(),
};

const analyticsComputeCache = {
  key: "",
  value: null,
};

function tfBucketNow(tf) {
  const min = Math.max(1, Number(tf) || 1);
  return Math.floor(nowMs() / (min * 60_000));
}

function buildAnalyticsCacheKey({ symbol, category, plotTf, rows, tfCandles }) {
  const lastPlotTs = Number(rows?.[rows.length - 1]?.tsMs || 0);
  const plotLen = Number(rows?.length || 0);

  const tfSig = ["1", "5", "60", "240"]
    .map((tf) => {
      const arr = Array.isArray(tfCandles?.[tf]) ? tfCandles[tf] : [];
      const lastT = Number(arr?.[arr.length - 1]?.t || 0);
      return `${tf}:${arr.length}:${lastT}`;
    })
    .join("|");

  return `${String(symbol || "").toUpperCase()}|${String(category || "").toLowerCase()}|${String(plotTf || "")}|${plotLen}|${lastPlotTs}|${tfSig}`;
}

function parseArg(name) {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function normalizeIp(ip) {
  const s = String(ip || "").trim().replace(/^\[|\]$/g, "");
  if (!s) return "";
  if (s.startsWith("::ffff:")) return s.slice(7);
  return s;
}

function getClientIp(req) {
  if (UI_TRUST_PROXY_HEADERS) {
    const xff = String(req.headers["x-forwarded-for"] || "").trim();
    if (xff) {
      const first = xff.split(",")[0]?.trim() || "";
      if (first) return normalizeIp(first);
    }
    const xrip = String(req.headers["x-real-ip"] || "").trim();
    if (xrip) return normalizeIp(xrip);
  }
  return normalizeIp(req.socket?.remoteAddress || "");
}

function isClientAllowed(req) {
  if (!UI_ENFORCE_IP_ALLOWLIST) return true;
  const ip = getClientIp(req);
  if (!ip) return false;
  return ALLOWED_IP_SET.has(ip);
}

function safeEq(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  try {
    return timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function isBasicAuthValid(req) {
  if (!UI_REQUIRE_AUTH) return true;
  const hdr = String(req.headers.authorization || "");
  if (!hdr.startsWith("Basic ")) return false;
  const b64 = hdr.slice(6).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEq(user, UI_AUTH_USER) && safeEq(pass, UI_AUTH_PASS);
}

function enforceUiSecurity(req, res) {
  if (!isClientAllowed(req)) {
    sendJson(res, 403, { ok: false, error: "ip_forbidden" });
    return false;
  }

  if (!isBasicAuthValid(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="BOT7 UI"');
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return false;
  }

  return true;
}

function pad2(x) {
  return String(x).padStart(2, "0");
}

function nowMs() {
  return Date.now();
}

function safeNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (arr.length - 1));
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || Math.abs(from) < 1e-12) return 0;
  return ((to - from) / from) * 100;
}

function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function buildSignalFromHistoryRow(row) {
  const tsMs = safeNum(row?.tsMs, nowMs());
  return {
    ts: row?.ts || toIso(tsMs),
    tsMs,
    price: safeNum(row?.price, 0),
    regime: row?.regime || "UNKNOWN",
    cci: numOrNull(row?.cci),
    adx14: numOrNull(row?.adx14),
    atrPct: numOrNull(row?.atrPct),
    emaSpreadPct: numOrNull(row?.emaSpreadPct),
    momentum: {
      score: numOrNull(row?.momentumScore),
    },
    derived: {
      pressureScore: numOrNull(row?.pressureScore),
      shockScore: numOrNull(row?.shockScore),
      shockDir: numOrNull(row?.shockDir),
      botSignal: numOrNull(row?.botSignal),
    },
  };
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        data = "";
        resolve({});
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, code, payload) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function sendFile(res, absPath, contentType = "text/plain; charset=utf-8") {
  try {
    const data = await fs.readFile(absPath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildSessionCsvFileName(symbol, date = new Date()) {
  const dd = pad2(date.getDate());
  const mm = pad2(date.getMonth() + 1);
  const rr = String(date.getFullYear()).slice(-2);
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  return `${symbol} ${dd}.${mm}.${rr} godz ${hh}-${mi}.csv`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureSessionCsv(symbol) {
  await ensureDir(LOGS_DIR);
  if (!state.sessionCsvPath) {
    state.sessionCsvPath = path.resolve(LOGS_DIR, buildSessionCsvFileName(symbol));
  }

  try {
    await fs.access(state.sessionCsvPath);
  } catch {
    const header = [
      "ts",
      "tsMs",
      "symbol",
      "category",
      "price",
      "regime",
      "cci",
      "adx14",
      "atrPct",
      "emaSpreadPct",
      "momentumScore",
      "pressureScore",
      "shockScore",
      "botSignal",
    ].join(",");
    await fs.writeFile(state.sessionCsvPath, `${header}\n`, "utf8");
  }

  await syncHistoryAliasCsv();
}

async function loadIndicatorHistory() {
  await ensureDir(LOGS_DIR);
  try {
    const raw = await fs.readFile(INDICATOR_HISTORY_JSON_PATH, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      state.indicatorHistory = [];
      return;
    }
    const minTs = nowMs() - INDICATOR_KEEP_MS;
    state.indicatorHistory = arr
      .filter((r) => safeNum(r?.tsMs, 0) >= minTs)
      .sort((a, b) => safeNum(a.tsMs, 0) - safeNum(b.tsMs, 0));
  } catch {
    state.indicatorHistory = [];
  }
}

async function persistIndicatorHistory() {
  await ensureDir(LOGS_DIR);
  const minTs = nowMs() - INDICATOR_KEEP_MS;
  state.indicatorHistory = state.indicatorHistory
    .filter((r) => safeNum(r?.tsMs, 0) >= minTs)
    .sort((a, b) => safeNum(a.tsMs, 0) - safeNum(b.tsMs, 0));

  await fs.writeFile(INDICATOR_HISTORY_JSON_PATH, JSON.stringify(state.indicatorHistory, null, 2), "utf8");
}

async function syncHistoryAliasCsv() {
  await ensureDir(LOGS_DIR);

  let source = null;
  if (state.mode === "live") {
    source = state.sessionCsvPath;
  } else if (state.mode === "history") {
    source = state.selectedHistoryPath;
  }

  if (!source) return;

  const ext = path.extname(source).toLowerCase();
  if (ext === ".csv") {
    try {
      const raw = await fs.readFile(source, "utf8");
      await fs.writeFile(HISTORY_ALIAS_PATH, raw, "utf8");
    } catch {
      await fs.writeFile(HISTORY_ALIAS_PATH, "", "utf8");
    }
    return;
  }

  // history json/jsonl -> konwersja do csv aliasu
  const rows = await loadHistoryRowsFromFile(source);
  const indicatorRows = buildIndicatorRowsFromHistoryRows(rows, state.symbol, state.category);
  const header = [
    "ts",
    "tsMs",
    "symbol",
    "category",
    "price",
    "regime",
    "cci",
    "adx14",
    "atrPct",
    "emaSpreadPct",
    "momentumScore",
    "pressureScore",
    "shockScore",
    "shockDir",
    "botSignal",
    "buySuggest",
    "sellSuggest",
    "microBuySuggest",
    "microSellSuggest",
  ].join(",");
  const body = indicatorRows
    .map((r) => [
      r.ts,
      r.tsMs,
      r.symbol,
      r.category,
      safeNum(r.price, 0).toFixed(8),
      r.regime,
      safeNum(r.cci, 0).toFixed(6),
      safeNum(r.adx14, 0).toFixed(6),
      safeNum(r.atrPct, 0).toFixed(6),
      safeNum(r.emaSpreadPct, 0).toFixed(6),
      safeNum(r.momentumScore, 0).toFixed(6),
      safeNum(r.pressureScore, 0).toFixed(6),
      safeNum(r.shockScore, 0).toFixed(6),
      safeNum(r.shockDir, 0).toFixed(6),
      safeNum(r.botSignal, 0).toFixed(6),
      safeNum(r?.placements?.buySuggest, 0).toFixed(8),
      safeNum(r?.placements?.sellSuggest, 0).toFixed(8),
      safeNum(r?.placements?.microBuySuggest, 0).toFixed(8),
      safeNum(r?.placements?.microSellSuggest, 0).toFixed(8),
    ].map(csvEscape).join(","))
    .join("\n");
  await fs.writeFile(HISTORY_ALIAS_PATH, body ? `${header}\n${body}\n` : `${header}\n`, "utf8");
}

function parseTsMsLoose(value) {
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = new Date(String(value || "")).getTime();
  if (Number.isFinite(asDate) && asDate > 0) return asDate;
  return NaN;
}

async function pruneCsvByRetention(filePath, minTsMs) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { removed: 0, kept: 0, total: 0 };
  }

  const lines = String(raw || "").split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { removed: 0, kept: 0, total: 0 };

  const header = lines[0];
  const cols = header.split(",").map((x) => String(x || "").trim());
  const idxTsMs = cols.findIndex((c) => c === "tsMs");
  const idxTs = cols.findIndex((c) => c === "ts");

  let removed = 0;
  const keptRows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i];
    const parts = row.split(",");
    const tsMsVal = idxTsMs >= 0 ? parseTsMsLoose(parts[idxTsMs]) : NaN;
    const tsVal = idxTs >= 0 ? parseTsMsLoose(parts[idxTs]) : NaN;
    const ts = Number.isFinite(tsMsVal) ? tsMsVal : tsVal;

    if (Number.isFinite(ts) && ts < minTsMs) {
      removed += 1;
      continue;
    }
    keptRows.push(row);
  }

  if (removed > 0) {
    const out = [header, ...keptRows].join("\n") + "\n";
    await fs.writeFile(filePath, out, "utf8");
  }

  return { removed, kept: keptRows.length, total: Math.max(0, lines.length - 1) };
}

async function pruneJsonlByRetention(filePath, minTsMs) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { removed: 0, kept: 0, total: 0 };
  }

  const lines = String(raw || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  let removed = 0;
  const kept = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const ts = parseTsMsLoose(obj?.tsMs) || parseTsMsLoose(obj?.ts);
      if (Number.isFinite(ts) && ts < minTsMs) {
        removed += 1;
        continue;
      }
      kept.push(JSON.stringify(obj));
    } catch {
      kept.push(line);
    }
  }

  if (removed > 0) {
    const out = kept.length ? `${kept.join("\n")}\n` : "";
    await fs.writeFile(filePath, out, "utf8");
  }

  return { removed, kept: kept.length, total: lines.length };
}

async function pruneIndicatorHistoryByRetention(filePath, minTsMs) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { removed: 0, kept: 0, total: 0 };
  }

  let arr = [];
  try {
    arr = JSON.parse(raw);
  } catch {
    arr = [];
  }

  if (!Array.isArray(arr)) arr = [];
  const total = arr.length;
  const kept = arr.filter((r) => {
    const ts = parseTsMsLoose(r?.tsMs) || parseTsMsLoose(r?.ts);
    if (!Number.isFinite(ts)) return true;
    return ts >= minTsMs;
  });
  const removed = total - kept.length;

  if (removed > 0) {
    await fs.writeFile(filePath, JSON.stringify(kept, null, 2), "utf8");
  }

  return { removed, kept: kept.length, total };
}

async function cleanupOldFilesInDir(dirPath, minTsMs, matcher) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return { removed: 0, scanned: 0 };
  }

  let scanned = 0;
  let removed = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!matcher(ent.name)) continue;
    const abs = path.resolve(dirPath, ent.name);
    scanned += 1;
    try {
      const st = await fs.stat(abs);
      if (Number(st?.mtimeMs || 0) < minTsMs) {
        await fs.unlink(abs);
        removed += 1;
      }
    } catch {
      // ignore single-file errors
    }
  }
  return { removed, scanned };
}

async function cleanupOldRunDirs(minTsMs) {
  let entries = [];
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch {
    return { removed: 0, scanned: 0 };
  }

  let scanned = 0;
  let removed = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const abs = path.resolve(RUNS_DIR, ent.name);
    scanned += 1;
    try {
      const st = await fs.stat(abs);
      if (Number(st?.mtimeMs || 0) < minTsMs) {
        await fs.rm(abs, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // ignore single-dir errors
    }
  }
  return { removed, scanned };
}

async function runFilesystemCleanup() {
  const minTsMs = nowMs() - FILE_RETENTION_MS;

  await ensureDir(LOGS_DIR);
  await ensureDir(CSV_DIR);

  const [csvAlias, jsonlAlias, indicator, candleFiles, tempFiles, runDirs, csvExports] = await Promise.all([
    pruneCsvByRetention(HISTORY_ALIAS_PATH, minTsMs),
    pruneJsonlByRetention(HISTORY_ALIAS_JSONL_PATH, minTsMs),
    pruneIndicatorHistoryByRetention(INDICATOR_HISTORY_JSON_PATH, minTsMs),
    cleanupOldFilesInDir(
      LOGS_DIR,
      minTsMs,
      (name) => name.toLowerCase().endsWith(".csv") && name !== path.basename(HISTORY_ALIAS_PATH)
    ),
    cleanupOldFilesInDir(
      LOGS_DIR,
      minTsMs,
      (name) => /\.(tmp|temp|lock)$/i.test(name)
    ),
    cleanupOldRunDirs(minTsMs),
    cleanupOldFilesInDir(
      CSV_DIR,
      minTsMs,
      (name) => /\.(csv|tsv|jsonl|tmp|temp)$/i.test(name)
    ),
  ]);

  const removedTotal =
    Number(csvAlias.removed || 0) +
    Number(jsonlAlias.removed || 0) +
    Number(indicator.removed || 0) +
    Number(candleFiles.removed || 0) +
    Number(tempFiles.removed || 0) +
    Number(runDirs.removed || 0) +
    Number(csvExports.removed || 0);

  if (removedTotal > 0) {
    console.log(
      `[cleanup] retention=${FILE_RETENTION_DAYS}d removed=${removedTotal} ` +
      `(historyCsv=${csvAlias.removed} historyJsonl=${jsonlAlias.removed} indicator=${indicator.removed} ` +
      `logCsv=${candleFiles.removed} logTmp=${tempFiles.removed} runs=${runDirs.removed} csvDir=${csvExports.removed})`
    );
  }
}

function startFilesystemCleanup() {
  if (state.cleanupTimer) clearInterval(state.cleanupTimer);
  runFilesystemCleanup().catch((e) => {
    console.log(`[cleanup] startup error: ${e?.message || e}`);
  });
  state.cleanupTimer = setInterval(() => {
    runFilesystemCleanup().catch((e) => {
      console.log(`[cleanup] periodic error: ${e?.message || e}`);
    });
  }, FILE_CLEANUP_EVERY_MS);
}

function stopFilesystemCleanup() {
  if (state.cleanupTimer) {
    clearInterval(state.cleanupTimer);
    state.cleanupTimer = null;
  }
}

function normalizeSymbol(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function chooseHistoryFileViaExplorer() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
    "$dlg.Filter = 'History files (*.csv;*.jsonl;*.json)|*.csv;*.jsonl;*.json|All files (*.*)|*.*'",
    "$dlg.Multiselect = $false",
    "$dlg.Title = 'Wybierz plik historii (CSV/JSONL/JSON)'",
    "if($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ Write-Output $dlg.FileName }",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    const selected = String(stdout || "").trim();
    return selected || null;
  } catch {
    return null;
  }
}

async function askStartupMode() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("\n=== momentum_regime server ===");
    const modeRaw = await rl.question("Tryb [live/historia]: ");
    const mode = String(modeRaw || "").trim().toLowerCase();

    if (mode.startsWith("h")) {
      state.mode = "history";

      let selected = await chooseHistoryFileViaExplorer();
      if (!selected) {
        const fallback = await rl.question("Nie wybrano pliku w eksploratorze. Podaj ścieżkę ręcznie: ");
        selected = String(fallback || "").trim();
      }

      if (!selected) {
        throw new Error("Nie wskazano pliku historii.");
      }

      state.selectedHistoryPath = selected;
      state.selectedHistoryRows = await loadHistoryRowsFromFile(selected);
      if (!state.selectedHistoryRows.length) {
        throw new Error("Wybrany plik historii nie zawiera poprawnych rekordów.");
      }

      state.symbol = normalizeSymbol(state.selectedHistoryRows.at(-1)?.symbol || "BTCUSDT") || "BTCUSDT";
      state.category = String(state.selectedHistoryRows.at(-1)?.category || "linear").toLowerCase();
      state.selectedIndicatorRows = buildIndicatorRowsFromHistoryRows(state.selectedHistoryRows, state.symbol, state.category);

      await syncHistoryAliasCsv();

      console.log(`Tryb: historia | rekordy: ${state.selectedHistoryRows.length} | symbol: ${state.symbol}`);
      console.log(`Plik: ${state.selectedHistoryPath}`);
      return;
    }

    state.mode = "live";
    const symbolRaw = await rl.question("Podaj walutę/symbol (np. BTCUSDT): ");
    const symbol = normalizeSymbol(symbolRaw) || "BTCUSDT";
    state.symbol = symbol;
    state.category = "linear";

    await ensureSessionCsv(symbol);

    await startMarketSignal({
      symbol,
      category: state.category,
      pollMs: 10_000,
      silent: true,
      debug: false,
    });

    startLiveCsvCapture();
    console.log(`Tryb: live | symbol: ${symbol}`);
    console.log(`CSV sesji: ${state.sessionCsvPath}`);
  } finally {
    rl.close();
  }
}

async function setupFromArgsIfProvided() {
  const modeRaw = String(parseArg("mode") || "").trim().toLowerCase();
  if (!modeRaw) return false;

  if (modeRaw.startsWith("h")) {
    const historyFile = String(parseArg("historyFile") || "").trim();
    if (!historyFile) {
      throw new Error("Dla --mode history podaj --historyFile <path>");
    }

    state.mode = "history";
    state.selectedHistoryPath = historyFile;
    state.selectedHistoryRows = await loadHistoryRowsFromFile(historyFile);
    if (!state.selectedHistoryRows.length) {
      throw new Error("Wybrany plik historii nie zawiera poprawnych rekordów.");
    }

    state.symbol = normalizeSymbol(parseArg("symbol") || state.selectedHistoryRows.at(-1)?.symbol || "BTCUSDT") || "BTCUSDT";
    state.category = String(parseArg("category") || state.selectedHistoryRows.at(-1)?.category || "linear").toLowerCase();
    state.selectedIndicatorRows = buildIndicatorRowsFromHistoryRows(state.selectedHistoryRows, state.symbol, state.category);

    await syncHistoryAliasCsv();
    console.log(`Tryb: historia | rekordy: ${state.selectedHistoryRows.length} | symbol: ${state.symbol}`);
    console.log(`Plik: ${state.selectedHistoryPath}`);
    return true;
  }

  state.mode = "live";
  state.symbol = normalizeSymbol(parseArg("symbol") || "BTCUSDT") || "BTCUSDT";
  state.category = String(parseArg("category") || "linear").toLowerCase();

  await ensureSessionCsv(state.symbol);
  await startMarketSignal({
    symbol: state.symbol,
    category: state.category,
    pollMs: 10_000,
    silent: true,
    debug: false,
  });

  startLiveCsvCapture();
  console.log(`Tryb: live | symbol: ${state.symbol}`);
  console.log(`CSV sesji: ${state.sessionCsvPath}`);
  return true;
}

function rowsFromCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const idxTs = header.indexOf("ts");
  const idxTsMs = header.indexOf("tsMs");
  const idxSymbol = header.indexOf("symbol");
  const idxCategory = header.indexOf("category");
  const idxPrice = header.indexOf("price");
  const idxRegime = header.indexOf("regime");
  const idxCci = header.indexOf("cci");
  const idxAdx14 = header.indexOf("adx14");
  const idxAtrPct = header.indexOf("atrPct");
  const idxEmaSpreadPct = header.indexOf("emaSpreadPct");
  const idxMomentumScore = header.indexOf("momentumScore");
  const idxPressureScore = header.indexOf("pressureScore");
  const idxShockScore = header.indexOf("shockScore");
  const idxShockDir = header.indexOf("shockDir");
  const idxBotSignal = header.indexOf("botSignal");

  if (idxPrice < 0) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const tsMs = safeNum(cols[idxTsMs], 0);
    const ts = (idxTs >= 0 ? cols[idxTs] : null) || (tsMs > 0 ? toIso(tsMs) : null);
    const price = safeNum(cols[idxPrice], NaN);
    if (!Number.isFinite(price)) continue;

    rows.push({
      ts: ts || toIso(nowMs()),
      tsMs: tsMs > 0 ? tsMs : new Date(ts || Date.now()).getTime(),
      symbol: idxSymbol >= 0 ? String(cols[idxSymbol] || "").trim() : state.symbol,
      category: idxCategory >= 0 ? String(cols[idxCategory] || "").trim() : state.category,
      price,
      regime: idxRegime >= 0 ? String(cols[idxRegime] || "").trim() : null,
      cci: idxCci >= 0 ? numOrNull(cols[idxCci]) : null,
      adx14: idxAdx14 >= 0 ? numOrNull(cols[idxAdx14]) : null,
      atrPct: idxAtrPct >= 0 ? numOrNull(cols[idxAtrPct]) : null,
      emaSpreadPct: idxEmaSpreadPct >= 0 ? numOrNull(cols[idxEmaSpreadPct]) : null,
      momentumScore: idxMomentumScore >= 0 ? numOrNull(cols[idxMomentumScore]) : null,
      pressureScore: idxPressureScore >= 0 ? numOrNull(cols[idxPressureScore]) : null,
      shockScore: idxShockScore >= 0 ? numOrNull(cols[idxShockScore]) : null,
      shockDir: idxShockDir >= 0 ? numOrNull(cols[idxShockDir]) : null,
      botSignal: idxBotSignal >= 0 ? numOrNull(cols[idxBotSignal]) : null,
    });
  }

  rows.sort((a, b) => a.tsMs - b.tsMs);
  return rows;
}

function rowsFromJsonl(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const tsMs = safeNum(r.tsMs, 0);
      const price = safeNum(r.price, NaN);
      if (!Number.isFinite(tsMs) || !Number.isFinite(price)) continue;
      out.push({
        ts: r.ts || toIso(tsMs),
        tsMs,
        symbol: String(r.symbol || state.symbol),
        category: String(r.category || state.category),
        price,
        regime: r.regime ?? null,
        cci: numOrNull(r.cci),
        adx14: numOrNull(r.adx14),
        atrPct: numOrNull(r.atrPct),
        emaSpreadPct: numOrNull(r.emaSpreadPct),
        momentumScore: numOrNull(r.momentumScore),
        pressureScore: numOrNull(r.pressureScore),
        shockScore: numOrNull(r.shockScore),
        shockDir:          numOrNull(r.shockDir),
        botSignal:         numOrNull(r.botSignal),
        impulseDepthScore: numOrNull(r.impulseDepthScore),
        volRatio:          numOrNull(r.volRatio),
        obImbalance:       numOrNull(r.obImbalance),
        ob3Imbalance:      numOrNull(r.ob3Imbalance),
        obSpread:          numOrNull(r.obSpread),
        obBidConc:         numOrNull(r.obBidConc),
        obAskConc:         numOrNull(r.obAskConc),
        obBidWallPct:      numOrNull(r.obBidWallPct),
        obAskWallPct:      numOrNull(r.obAskWallPct),
        obMicroAdj:        numOrNull(r.obMicroAdj),
      });
    } catch {
    }
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

async function listTradeHistoryCsvFiles() {
  try {
    const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = String(ent.name || "");
      // Check for fill_events.tsv directly in this directory
      const abs = path.resolve(RUNS_DIR, name, "fill_events.tsv");
      let st;
      try {
        st = await fs.stat(abs);
        out.push({ name, mtimeMs: Number(st.mtimeMs || 0), size: Number(st.size || 0) });
      } catch {
        // Not found at top level — scan one level deeper (handles "BTC/USDT_PAPER_..." nested runs)
        try {
          const subEntries = await fs.readdir(path.resolve(RUNS_DIR, name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            const subName = `${name}/${String(sub.name || "")}`;
            const subAbs = path.resolve(RUNS_DIR, subName, "fill_events.tsv");
            let subSt;
            try { subSt = await fs.stat(subAbs); } catch { continue; }
            out.push({ name: subName, mtimeMs: Number(subSt.mtimeMs || 0), size: Number(subSt.size || 0) });
          }
        } catch { /* ignore */ }
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch {
    return [];
  }
}

function splitTsvLine(line) {
  return String(line || "").split("\t").map((v) => String(v || "").trim());
}

function parseTradeHistoryCsv(raw) {
  const lines = String(raw || "").split(/\r?\n/).filter((l) => String(l).trim().length > 0);
  if (!lines.length) return { summary: {}, headers: [], rows: [] };

  const headers = splitTsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitTsvLine(lines[i]);
    if (!cols.length) continue;
    const row = {};
    for (let k = 0; k < headers.length; k += 1) {
      const key = String(headers[k] || "").trim();
      if (!key) continue;
      row[key] = cols[k] ?? "";
    }
    rows.push(row);
  }

  const wanted = [
    "ts",
    "market",
    "side",
    "kind",
    "price",
    "qty_base",
    "quote_amount",
    "profit_quote",
    "retain_pct",
    "step_pct",
    "momentum_mult",
    "order_id",
    "order_link_id",
    "mode",
    "zone",
    "regime",
    "counter_status",
    "counter_side",
    "counter_price",
    "counter_qty",
    "counter_order_id",
    "counter_reason",
    "reason_codes",
  ];

  const filteredHeaders = wanted.filter((h) => headers.includes(h));
  const filteredRows = rows.map((r) => {
    const o = {};
    for (const h of filteredHeaders) o[h] = r[h] ?? "";
    return o;
  });

  // ▶ FIX 8.0: compute fill-level summary from actual data
  let totalFills = filteredRows.length;
  let buyFills = 0, sellFills = 0, loopFills = 0, gridFills = 0, counterFills = 0;
  let totalProfitQuote = 0, totalVolumeQuote = 0;
  let profitableLoops = 0, unprofitableLoops = 0;
  
  for (const r of filteredRows) {
    const side = String(r.side || "").toLowerCase();
    if (side === "buy") buyFills++;
    if (side === "sell") sellFills++;
    
    const kind = String(r.kind || "").toUpperCase();
    if (kind.includes("LOOP")) loopFills++;
    else if (kind.includes("COUNTER")) counterFills++;
    else gridFills++;
    
    const profit = Number(r.profit_quote || 0);
    if (Number.isFinite(profit) && profit !== 0) {
      totalProfitQuote += profit;
      if (profit > 0) profitableLoops++;
      else unprofitableLoops++;
    }
    
    const vol = Number(r.quote_amount || 0);
    if (Number.isFinite(vol)) totalVolumeQuote += vol;
  }
  
  const computedSummary = {
    "total_fills": totalFills,
    "buy_fills": buyFills,
    "sell_fills": sellFills,
    "loop_fills": loopFills,
    "grid_fills": gridFills,
    "counter_fills": counterFills,
    "total_profit_quote": totalProfitQuote.toFixed(6),
    "profitable_loops": profitableLoops,
    "unprofitable_loops": unprofitableLoops,
    "total_volume_quote": totalVolumeQuote.toFixed(2),
    "avg_profit_per_loop": loopFills > 0 ? (totalProfitQuote / loopFills).toFixed(6) : "0",
  };

  return { summary: computedSummary, headers: filteredHeaders, rows: filteredRows };
}

async function parseRunSummaryTsv(runName) {
  try {
    const abs = path.resolve(RUNS_DIR, runName, "run_summary.tsv");
    const raw = await fs.readFile(abs, "utf8");
    const lines = String(raw || "").split(/\r?\n/).filter((l) => String(l).trim().length > 0);
    if (lines.length < 2) return {};
    const headers = splitTsvLine(lines[0]);
    const values = splitTsvLine(lines[1]);
    const out = {};
    for (let i = 0; i < headers.length; i += 1) {
      const k = headers[i];
      if (!k) continue;
      out[k] = values[i] ?? "";
    }
    return out;
  } catch {
    return {};
  }
}

function rowsFromJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    const rows = arr
      .map((r) => ({
        ts: r.ts || toIso(safeNum(r.tsMs, nowMs())),
        tsMs: safeNum(r.tsMs, new Date(r.ts || Date.now()).getTime()),
        symbol: String(r.symbol || state.symbol),
        category: String(r.category || state.category),
        price: safeNum(r.price, NaN),
        regime: r.regime ?? null,
        cci: numOrNull(r.cci),
        adx14: numOrNull(r.adx14),
        atrPct: numOrNull(r.atrPct),
        emaSpreadPct: numOrNull(r.emaSpreadPct),
        momentumScore: numOrNull(r.momentumScore),
        pressureScore: numOrNull(r.pressureScore),
        shockScore: numOrNull(r.shockScore),
        shockDir: numOrNull(r.shockDir),
        botSignal: numOrNull(r.botSignal),
      }))
      .filter((r) => Number.isFinite(r.tsMs) && Number.isFinite(r.price));

    rows.sort((a, b) => a.tsMs - b.tsMs);
    return rows;
  } catch {
    return [];
  }
}

async function loadHistoryRowsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = await fs.readFile(filePath, "utf8");

  if (ext === ".csv") return rowsFromCsv(raw);
  if (ext === ".jsonl") return rowsFromJsonl(raw);
  if (ext === ".json") return rowsFromJson(raw);

  // fallback heurystyczny
  if (raw.trim().startsWith("{")) return rowsFromJsonl(raw);
  if (raw.trim().startsWith("[")) return rowsFromJson(raw);
  return rowsFromCsv(raw);
}

function buildIndicatorRowsFromHistoryRows(rows, symbol, category) {
  const sorted = [...rows].sort((a, b) => safeNum(a.tsMs, 0) - safeNum(b.tsMs, 0));
  const out = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const windowRows = sorted
      .slice(Math.max(0, i - 300), i + 1)
      .map((r) => ({ tsMs: r.tsMs, price: r.price }));

    const signal = buildSignalFromHistoryRow(row);
    const analytics = computePlacementAnalytics(windowRows, signal);

    out.push(
      buildIndicatorSnapshot({
        symbol: String(row.symbol || symbol || state.symbol),
        category: String(row.category || category || state.category),
        signal,
        placements: analytics.placements,
        placementComponents: analytics.placementComponents,
      })
    );
  }

  return out;
}

async function fetchBybitKlines({ category, symbol, interval = "5", limit = 1000, startMs = null, endMs = null }) {
  const bybitBase = String(
    process.env.BYBIT_TRADE_BASE_URL || process.env.BYBIT_BASE_URL || "https://api.bybit.eu"
  ).replace(/\/+$/, "");
  const url = new URL(`${bybitBase}/v5/market/kline`);
  url.searchParams.set("category", category);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", String(interval));
  url.searchParams.set("limit", String(limit));
  if (Number.isFinite(startMs)) url.searchParams.set("start", String(Math.floor(startMs)));
  if (Number.isFinite(endMs)) url.searchParams.set("end", String(Math.floor(endMs)));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json?.retCode !== 0) {
    throw new Error(`Bybit retCode=${json?.retCode} ${json?.retMsg || ""}`.trim());
  }

  const rows = Array.isArray(json?.result?.list) ? json.result.list : [];
  return rows
    .map((r) => ({
      startMs: safeNum(r[0], 0),
      open: safeNum(r[1], NaN),
      high: safeNum(r[2], NaN),
      low: safeNum(r[3], NaN),
      close: safeNum(r[4], NaN),
    }))
    .filter((r) => r.startMs > 0 && Number.isFinite(r.close))
    .sort((a, b) => a.startMs - b.startMs);
}

async function fetchBybitKlinesLookback({ category, symbol, interval = "5", lookbackMs = LIVE_DEFAULT_LOOKBACK_MS }) {
  const targetStart = nowMs() - Math.max(60_000, safeNum(lookbackMs, LIVE_DEFAULT_LOOKBACK_MS));
  let cursorEnd = nowMs();
  const out = [];
  const seen = new Set();

  for (let page = 0; page < 8; page++) {
    const batch = await fetchBybitKlines({
      category,
      symbol,
      interval,
      limit: 1000,
      endMs: cursorEnd,
    });

    if (!batch.length) break;

    for (const r of batch) {
      if (r.startMs < targetStart) continue;
      if (seen.has(r.startMs)) continue;
      seen.add(r.startMs);
      out.push(r);
    }

    const earliest = safeNum(batch[0]?.startMs, 0);
    if (!earliest || earliest <= targetStart) break;
    cursorEnd = earliest - 1;
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function barsForLookbackDays(tf, days) {
  const mins = Number(tf);
  const totalMin = Number(days) * 24 * 60;
  if (!Number.isFinite(mins) || mins <= 0) return 0;
  return Math.ceil(totalMin / mins);
}

async function fetchBybitKlinesBars({ category, symbol, interval = "5", wantBars = 1000 }) {
  const out = [];
  const seen = new Set();
  let cursorEnd = nowMs();

  for (let page = 0; page < 60; page += 1) {
    if (out.length >= wantBars) break;
    const remain = Math.max(1, wantBars - out.length);
    const lim = Math.max(1, Math.min(1000, remain));

    const batch = await fetchBybitKlines({
      category,
      symbol,
      interval,
      limit: lim,
      endMs: cursorEnd,
    });

    if (!batch.length) break;

    for (const r of batch) {
      if (seen.has(r.startMs)) continue;
      seen.add(r.startMs);
      out.push(r);
    }

    const oldest = safeNum(batch[0]?.startMs, 0);
    if (!oldest) break;
    cursorEnd = oldest - 1;

    if (batch.length < lim) break;
  }

  out.sort((a, b) => a.startMs - b.startMs);
  if (out.length > wantBars) return out.slice(out.length - wantBars);
  return out;
}

async function fetchBybitKlinesRange({ category, symbol, interval = "5", fromMs, toMs }) {
  const out = [];
  const seen = new Set();
  const from = safeNum(fromMs, NaN);
  const to = safeNum(toMs, NaN);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out;

  let cursorEnd = to;
  for (let page = 0; page < 50; page++) {
    const batch = await fetchBybitKlines({
      category,
      symbol,
      interval,
      limit: 1000,
      endMs: cursorEnd,
    });

    if (!batch.length) break;

    for (const row of batch) {
      if (row.startMs < from || row.startMs > to) continue;
      if (seen.has(row.startMs)) continue;
      seen.add(row.startMs);
      out.push(row);
    }

    const oldest = safeNum(batch[0]?.startMs, 0);
    if (!oldest || oldest <= from) break;
    cursorEnd = oldest - 1;
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function toKanalarzCandles(rows) {
  return (rows || [])
    .map((r) => ({
      t: safeNum(r?.startMs, 0),
      open: safeNum(r?.open, NaN),
      high: safeNum(r?.high, NaN),
      low: safeNum(r?.low, NaN),
      close: safeNum(r?.close, NaN),
    }))
    .filter((r) => r.t > 0 && Number.isFinite(r.close) && Number.isFinite(r.high) && Number.isFinite(r.low));
}

async function fetchTfCandlesForAnalytics({ category, symbol, lookbackDays = 7, side4hDays = 90, hasRange, fromMs, toMs }) {
  const required = ["1", "5", "60"];
  const out = {};
  const cacheKey = `${String(category || "").toLowerCase()}:${String(symbol || "").toUpperCase()}`;

  if (analyticsTfFetchCache.key !== cacheKey) {
    analyticsTfFetchCache.key = cacheKey;
    analyticsTfFetchCache.perTf.clear();
  }

  async function fetchOrReuseTf(tf, wantBars) {
    const bucket = tfBucketNow(tf);
    const cached = analyticsTfFetchCache.perTf.get(tf);
    if (!hasRange && cached && cached.bucket === bucket && cached.wantBars === wantBars && Array.isArray(cached.candles) && cached.candles.length >= 10) {
      return cached.candles;
    }

    const rows = hasRange
      ? await fetchBybitKlinesRange({ category, symbol, interval: tf, fromMs, toMs })
      : await fetchBybitKlinesBars({
          category,
          symbol,
          interval: tf,
          wantBars,
        });
    const candles = toKanalarzCandles(rows);
    if (!hasRange) {
      analyticsTfFetchCache.perTf.set(tf, { bucket, wantBars, candles });
    }
    return candles;
  }

  for (const tf of required) {
    try {
      const wantBars = tf === "1"
        ? Math.min(barsForLookbackDays(tf, lookbackDays), 6000)
        : Math.min(barsForLookbackDays(tf, lookbackDays), 5000);
      const candles = await fetchOrReuseTf(tf, wantBars);
      if (candles.length >= 10) out[tf] = candles;
    } catch {
      // ignore per-TF errors; analytics will fallback
    }
  }

  try {
    const wantBars4h = Math.max(120, barsForLookbackDays("240", side4hDays));
    const c4 = await fetchOrReuseTf("240", wantBars4h);
    if (c4.length >= 10) out["240"] = c4;
  } catch {
    // ignore 4h errors
  }

  return out;
}

function computePlacementAnalytics(rows, signal = null, externalTfCandles = null) {
  const candlesPlot = (rows || [])
    .map((r, i) => {
      const close = safeNum(r?.price, NaN);
      if (!Number.isFinite(close) || close <= 0) return null;
      const high = safeNum(r?.high, close);
      const low = safeNum(r?.low, close);
      const open = safeNum(r?.open, close);
      return {
        t: safeNum(r?.tsMs, nowMs() + i),
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? Math.max(high, close) : close,
        low: Number.isFinite(low) ? Math.min(low, close) : close,
        close,
      };
    })
    .filter(Boolean);

  if (candlesPlot.length < 5) {
    return {
      placements: {},
      placementComponents: {},
      micro: {},
      avg: {},
      box: {},
      tfs: {},
      bigLow: {},
      bigSmall: {},
      dominant: {},
      dominantMid: {},
      impulseTrend: {},
      side4h: {},
    };
  }

  const close = candlesPlot.map((c) => c.close);
  const now = candlesPlot.at(-1)?.t ?? nowMs();

  function toRegimeArr(levels) {
    return (levels || []).map((lv, idx) => ({
      idx: idx + 1,
      upper: lv.upper,
      lower: lv.lower,
      countHi: lv.countHi,
      countLo: lv.countLo,
      halfW: lv.halfW,
      bestPointHi: lv.bestPointHi,
      bestPointLo: lv.bestPointLo,
    }));
  }

  function rangesOverlap(aLow, aHigh, bLow, bHigh) {
    if (![aLow, aHigh, bLow, bHigh].every((v) => Number.isFinite(v))) return false;
    const lo = Math.max(aLow, bLow);
    const hi = Math.min(aHigh, bHigh);
    return hi >= lo;
  }

  function inferBaseTfMinutes(candles) {
    if (!Array.isArray(candles) || candles.length < 3) return 5;
    const diffs = [];
    for (let i = 1; i < candles.length; i += 1) {
      const d = safeNum(candles[i]?.t, 0) - safeNum(candles[i - 1]?.t, 0);
      if (d > 0) diffs.push(d);
    }
    if (!diffs.length) return 5;
    diffs.sort((a, b) => a - b);
    const ms = diffs[Math.floor(diffs.length / 2)] || 300000;
    return Math.max(1, Math.round(ms / 60000));
  }

  function aggregateCandles(candles, targetTfMin, baseTfMin) {
    if (!Array.isArray(candles) || !candles.length) return [];
    if (!(Number.isFinite(targetTfMin) && Number.isFinite(baseTfMin))) return [];
    if (targetTfMin <= baseTfMin) return candles.slice();

    const ratio = targetTfMin / baseTfMin;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) return [];
    const step = Math.max(1, Math.round(ratio));

    const out = [];
    for (let i = 0; i < candles.length; i += step) {
      const chunk = candles.slice(i, i + step);
      if (!chunk.length) continue;
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      let high = -Infinity;
      let low = Infinity;
      for (const c of chunk) {
        if (Number.isFinite(c.high)) high = Math.max(high, c.high);
        if (Number.isFinite(c.low)) low = Math.min(low, c.low);
      }
      if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
      out.push({
        t: first.t,
        open: first.open,
        high,
        low,
        close: last.close,
      });
    }
    return out;
  }

  const tfMap = new Map();

  if (externalTfCandles && typeof externalTfCandles === "object") {
    for (const [tf, arr] of Object.entries(externalTfCandles)) {
      const key = String(tf);
      const candles = Array.isArray(arr) ? arr : [];
      if (candles.length >= 10) tfMap.set(key, candles);
    }
  }

  const baseTfMin = tfMap.size
    ? Number([...tfMap.keys()].sort((a, b) => Number(a) - Number(b))[0])
    : inferBaseTfMinutes(candlesPlot);

  if (!tfMap.size) {
    tfMap.set(String(baseTfMin), candlesPlot);
    for (const tf of [15, 60, 240]) {
      if (tf < baseTfMin) continue;
      const agg = aggregateCandles(candlesPlot, tf, baseTfMin);
      if (agg.length >= 40) tfMap.set(String(tf), agg);
    }
  } else if (!tfMap.has(String(baseTfMin))) {
    tfMap.set(String(baseTfMin), candlesPlot);
  }

  const tfKeys = [...tfMap.keys()].sort((a, b) => Number(a) - Number(b));
  const coreTf = ["1", "5", "60"].filter((tf) => tfMap.has(tf));
  const orderedCore = coreTf.length ? coreTf : tfKeys;
  const bigTf = orderedCore.includes("60") ? "60" : orderedCore[orderedCore.length - 1];
  const lowTf = orderedCore[0];
  const smallTf = orderedCore[Math.min(1, orderedCore.length - 1)] || lowTf;
  const midTf = orderedCore[Math.floor(orderedCore.length / 2)] || bigTf;

  const channels = {};

  for (const tf of tfKeys) {
    const arr = tfMap.get(tf) || [];
    const ch = computeRangeChannel(arr);
    channels[tf] = {
      tf,
      ok: !!ch.ok,
      rangeUpper: ch.upper,
      rangeLower: ch.lower,
      rangeMid: ch.mid,
      rangeWidthPct: ch.widthPct,
      upper: ch.upper,
      lower: ch.lower,
      mid: ch.mid,
      widthPct: ch.widthPct,
      n: ch.n,
      lastClose: arr.at(-1)?.close ?? null,
    };
  }

  const bigArr = tfMap.get(bigTf) || candlesPlot;
  const bigReg = computeRegimeLevelsMultiFromReversals(bigArr, {
    extremaRadius: 3,
    zonePctOfRange: 0.02,
    minSwings: 8,
    levels: 3,
  });
  if (bigReg.ok && channels[bigTf]?.ok) {
    channels[bigTf].regimes = toRegimeArr(bigReg.levels);
    channels[bigTf].regHalfW = bigReg.halfW;
    const lv1 = channels[bigTf].regimes[0];
    if (lv1?.upper && lv1?.lower) {
      channels[bigTf].upper = lv1.upper;
      channels[bigTf].lower = lv1.lower;
      channels[bigTf].mid = (lv1.upper + lv1.lower) / 2;
      channels[bigTf].widthPct = ((lv1.upper - lv1.lower) / Math.max(1e-8, channels[bigTf].mid)) * 100;
    }
  }

  const lowArr = tfMap.get(lowTf) || candlesPlot;
  const lowReg = computeRegimeLevelsMultiFromReversals(lowArr, {
    extremaRadius: 2,
    zonePctOfRange: 0.018,
    minSwings: 10,
    levels: 2,
  });

  const smallArr = tfMap.get(smallTf) || candlesPlot;
  const smallReg = computeRegimeLevelsMultiFromReversals(smallArr, {
    extremaRadius: 2,
    zonePctOfRange: 0.018,
    minSwings: 9,
    levels: 3,
  });

  const microTf = "5";
  const microTfMin = Number(microTf);
  const microBars = Math.max(20, Math.ceil((12 * 60) / microTfMin));
  const microSource = tfMap.get(microTf) || candlesPlot;
  const microCandles = microSource.slice(-microBars);
  const microCh = computeRangeChannel(microCandles);

  const coreUppers = orderedCore
    .map((tf) => channels[tf]?.rangeUpper)
    .filter((v) => Number.isFinite(v));
  const coreLowers = orderedCore
    .map((tf) => channels[tf]?.rangeLower)
    .filter((v) => Number.isFinite(v));
  const upperAvg = meanKanalarz(coreUppers);
  const lowerAvg = meanKanalarz(coreLowers);
  const closeNow = close.at(-1);

  const boxRaw = detectBreakout({
    closeNow,
    upper: channels[bigTf]?.upper,
    lower: channels[bigTf]?.lower,
    breakoutPct: 0.001,
  });

  const box = {
    state: String(boxRaw?.state || "UNKNOWN").replace("BREAKOUT_UP", "UP_BIAS").replace("BREAKOUT_DOWN", "DOWN_BIAS").replace("IN_CHANNEL", "NEUTRAL"),
    upThr: boxRaw?.upThr ?? null,
    dnThr: boxRaw?.dnThr ?? null,
  };

  const dom = findDominantRegimeWedge(candlesPlot, {
    minBars: Math.max(240, Math.floor(candlesPlot.length * 0.22)),
    maxBars: candlesPlot.length,
    stepBars: 60,
    maxWidthPct: 12,
    lowerStartShiftFrac: 0.18,
    lengthPenalty: 6,
    wedgeOpts: {
      extremaRadius: 2,
      recentIgnoreFracUpper: 0.12,
      trimHighFrac: 0.1,
      trimLowFrac: 0.1,
      upperQ: 0.82,
      lowerQ: 0.18,
      slopeSteps: 31,
      slopeRangeMult: 1.1,
      touchTolPct: 0.002,
      minTouches: 12,
      minInlierRatio: 0.62,
    },
  });

  let domBreakout = { state: "UNKNOWN" };
  if (dom.ok) {
    const sliceBars = dom.endIndex - dom.startIndex + 1;
    domBreakout = detectWedgeBreakout({
      closeNow,
      x: sliceBars - 1,
      upperSlope: dom.upperSlope,
      lowerSlope: dom.lowerSlope,
      bUpper: dom.bUpper,
      bLower: dom.bLower,
      breakoutPct: 0.001,
    });
  }
  const dominant = dom.ok ? { ...dom, breakout: domBreakout } : { ok: false, breakout: domBreakout };

  const midArr = tfMap.get(midTf) || candlesPlot;
  const domMidRaw = findDominantRegimeWedge(midArr, {
    minBars: Math.max(120, Math.floor(midArr.length * 0.25)),
    maxBars: midArr.length,
    stepBars: Math.max(10, Math.floor(midArr.length / 30)),
    maxWidthPct: 12,
    lowerStartShiftFrac: 0.18,
    lengthPenalty: 6,
    wedgeOpts: {
      extremaRadius: 2,
      recentIgnoreFracUpper: 0.12,
      trimHighFrac: 0.1,
      trimLowFrac: 0.1,
      upperQ: 0.82,
      lowerQ: 0.18,
      slopeSteps: 31,
      slopeRangeMult: 1.1,
      touchTolPct: 0.002,
      minTouches: 8,
      minInlierRatio: 0.58,
    },
  });
  let domMidBreakout = { state: "UNKNOWN" };
  if (domMidRaw.ok) {
    const sliceBars = domMidRaw.endIndex - domMidRaw.startIndex + 1;
    domMidBreakout = detectWedgeBreakout({
      closeNow: midArr.at(-1)?.close,
      x: sliceBars - 1,
      upperSlope: domMidRaw.upperSlope,
      lowerSlope: domMidRaw.lowerSlope,
      bUpper: domMidRaw.bUpper,
      bLower: domMidRaw.bLower,
      breakoutPct: 0.001,
    });
  }
  const dominantMid = domMidRaw.ok
    ? {
        ...domMidRaw,
        ok: true,
        tf: `${midTf}m`,
        breakout: domMidBreakout,
      }
    : { ok: false, tf: `${midTf}m`, breakout: domMidBreakout };

  const impulseTrend = detectBoxImpulseTrend(candlesPlot, {
    preBars: 520,
    minInsideFrac: 0.84,
    maxSidewaysWidthPct: 8.5,
    breakoutPct: 0.001,
    atrPeriod: 14,
    postMin: 220,
    postMax: 1200,
    recencyLookbackBars: 1200,
  });

  let side4h = { ok: false, tf: "240" };
  const c240 = tfMap.get("240") || [];
  if (c240.length >= 80) {
    const side4hRaw = detectSidewaysTrendFrames(c240, {
      minBars: 70,
      maxBars: 260,
      lengthStep: 10,
      scanStep: 3,
      maxFrames: 7,
      maxSlopePctPerBar: 0.0013,
      maxWidthPct: 14,
      minInlierRatio: 0.67,
      narrowPct: 0.0035,
    });

    if (side4hRaw.ok) {
      const currentRanges = [];
      for (const r of channels[bigTf]?.regimes || []) {
        if (Number.isFinite(r?.lower) && Number.isFinite(r?.upper)) currentRanges.push([r.lower, r.upper]);
      }
      if (Number.isFinite(channels[bigTf]?.lower) && Number.isFinite(channels[bigTf]?.upper)) {
        currentRanges.push([channels[bigTf].lower, channels[bigTf].upper]);
      }
      if (Number.isFinite(microCh?.lower) && Number.isFinite(microCh?.upper)) {
        currentRanges.push([microCh.lower, microCh.upper]);
      }
      if (Number.isFinite(upperAvg) && Number.isFinite(lowerAvg)) {
        currentRanges.push([lowerAvg, upperAvg]);
      }

      side4h = {
        ok: true,
        tf: "240",
        narrowPct: side4hRaw?.params?.narrowPct,
        frames: (side4hRaw.frames || []).map((f, idx) => {
          const cStart = c240[f.startIndex];
          const cEnd = c240[f.endIndex];
          const lowEdge = Math.min(f.lower0, f.lower1);
          const highEdge = Math.max(f.upper0, f.upper1);
          const overlapsCurrent = currentRanges.some(([lo, hi]) => rangesOverlap(lowEdge, highEdge, lo, hi));
          return {
            idx: idx + 1,
            ...f,
            startTs: cStart?.t ?? (now - 4 * 60 * 60 * 1000),
            endTs: cEnd?.t ?? now,
            overlapsCurrent,
          };
        }),
      };
    }
  }

  const edgePct = 0.001;
  const placements = {
    bigTf,
    buySuggest: channels[bigTf]?.lower ? channels[bigTf].lower * (1 + edgePct) : null,
    sellSuggest: channels[bigTf]?.upper ? channels[bigTf].upper * (1 - edgePct) : null,
    microBuySuggest: microCh.lower ? microCh.lower * (1 + edgePct) : null,
    microSellSuggest: microCh.upper ? microCh.upper * (1 - edgePct) : null,
    dominantBuySuggest: null,
    dominantSellSuggest: null,
  };

  if (dominant.ok) {
    const xNow = dominant.endIndex - dominant.startIndex;
    const upNow = dominant.upperSlope * xNow + dominant.bUpper;
    const dnNow = dominant.lowerSlope * xNow + dominant.bLower;
    placements.dominantBuySuggest = dnNow * (1 + edgePct);
    placements.dominantSellSuggest = upNow * (1 - edgePct);
  }

  const placementComponents = {
    buyBig: [
      { label: "Big low", value: channels[bigTf]?.lower ?? null },
      { label: "Range", value: (channels[bigTf]?.upper ?? 0) - (channels[bigTf]?.lower ?? 0) },
      { label: "Trend bias", value: safeNum(signal?.derived?.pressureScore, 0) },
      { label: "Volatility", value: safeNum(signal?.atrPct, 0) },
    ],
    sellBig: [
      { label: "Big high", value: channels[bigTf]?.upper ?? null },
      { label: "Range", value: (channels[bigTf]?.upper ?? 0) - (channels[bigTf]?.lower ?? 0) },
      { label: "Trend bias", value: safeNum(signal?.derived?.pressureScore, 0) },
      { label: "Volatility", value: safeNum(signal?.atrPct, 0) },
    ],
    buyMicro: [
      { label: "Micro low", value: microCh.lower ?? null },
      { label: "Micro range", value: (microCh.upper ?? 0) - (microCh.lower ?? 0) },
      { label: "Momentum", value: safeNum(signal?.momentum?.score, 0) },
      { label: "15m trend %", value: pctChange(close[Math.max(0, close.length - 4)], closeNow) },
    ],
    sellMicro: [
      { label: "Micro high", value: microCh.upper ?? null },
      { label: "Micro range", value: (microCh.upper ?? 0) - (microCh.lower ?? 0) },
      { label: "Momentum", value: safeNum(signal?.momentum?.score, 0) },
      { label: "60m trend %", value: pctChange(close[Math.max(0, close.length - 13)], closeNow) },
    ],
  };

  const micro = {
    tf: `${microTfMin}m`,
    hours: Math.max(1, Math.round((microCandles.length * microTfMin) / 60)),
    upper: microCh.upper,
    lower: microCh.lower,
  };

  const avg = {
    upper: upperAvg,
    lower: lowerAvg,
  };

  const tfs = channels;

  const bigLowPack = lowReg.ok
    ? { ok: true, tf: String(lowTf), regHalfW: lowReg.halfW, regimes: toRegimeArr(lowReg.levels), primary: toRegimeArr(lowReg.levels)[0] || null }
    : { ok: false, tf: String(lowTf), fail: lowReg };

  const bigSmallPack = smallReg.ok
    ? { ok: true, tf: String(smallTf), regHalfW: smallReg.halfW, regimes: toRegimeArr(smallReg.levels), primary: toRegimeArr(smallReg.levels)[0] || null }
    : { ok: false, tf: String(smallTf), fail: smallReg };

  return {
    placements,
    placementComponents,
    micro,
    avg,
    box,
    tfs,
    bigLow: bigLowPack,
    bigSmall: bigSmallPack,
    dominant,
    dominantMid,
    impulseTrend,
    side4h,
  };
}

function buildIndicatorSnapshot({ symbol, category, signal, placements, placementComponents }) {
  const tsMs = safeNum(signal?.tsMs, nowMs());
  return {
    ts: signal?.ts || toIso(tsMs),
    tsMs,
    symbol,
    category,
    price: safeNum(signal?.price, 0),
    regime: String(signal?.regime || "UNKNOWN"),
    cci: safeNum(signal?.cci, 0),
    adx14: safeNum(signal?.adx14, 0),
    atrPct: safeNum(signal?.atrPct, 0),
    emaSpreadPct: safeNum(signal?.emaSpreadPct, 0),
    momentumScore: safeNum(signal?.momentum?.score, 0),
    pressureScore: safeNum(signal?.derived?.pressureScore, 0),
    shockScore: safeNum(signal?.derived?.shockScore, 0),
    shockDir: safeNum(signal?.derived?.shockDir, 0),
    botSignal: safeNum(signal?.derived?.botSignal, 0),
    priceChange1mPct: safeNum(signal?.priceChange1mPct, 0),
    priceChange3mPct: safeNum(signal?.priceChange3mPct, 0),
    momentumDelta1m:  safeNum(signal?.momentumDelta1m,  0),
    momentumDelta3m:  safeNum(signal?.momentumDelta3m,  0),
    placements,
    placementComponents,
  };
}

function buildChartPayloadFromRows({ symbol, category, rows, plotTf = "5", signal = null, tfCandles = null }) {
  const t = rows.map((r) => r.tsMs);
  const close = rows.map((r) => r.price);

  const first = t[0] || nowMs();
  const last = t[t.length - 1] || first;
  const lookbackDays = Math.max(1, Math.ceil((last - first) / (24 * 60 * 60 * 1000)));
  const analyticsKey = buildAnalyticsCacheKey({
    symbol,
    category,
    plotTf,
    rows,
    tfCandles,
  });

  let analytics = null;
  if (analyticsComputeCache.key === analyticsKey && analyticsComputeCache.value) {
    analytics = analyticsComputeCache.value;
  } else {
    analytics = computePlacementAnalytics(rows, signal, tfCandles);
    analyticsComputeCache.key = analyticsKey;
    analyticsComputeCache.value = analytics;
  }

  return {
    symbol,
    category,
    updatedAt: new Date().toISOString(),
    lookbackDays,
    plotTf,
    plot: { t, close },
    placements: analytics.placements,
    placementComponents: analytics.placementComponents,
    tfs: analytics.tfs,
    bigLow: analytics.bigLow,
    bigSmall: analytics.bigSmall,
    micro: analytics.micro,
    avg: analytics.avg,
    box: analytics.box,
    dominant: analytics.dominant,
    dominantMid: analytics.dominantMid,
    impulseTrend: analytics.impulseTrend,
    side4h: analytics.side4h,
  };
}

async function buildDataJson(reqUrl) {
  const symbol = normalizeSymbol(reqUrl.searchParams.get("symbol") || state.symbol) || state.symbol;
  const tf = String(reqUrl.searchParams.get("tf") || reqUrl.searchParams.get("interval") || "5");
  const fromMs = safeNum(reqUrl.searchParams.get("fromMs"), NaN);
  const toMs = safeNum(reqUrl.searchParams.get("toMs"), NaN);
  const hasRange = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;

  if (state.mode === "history") {
    const rows = state.selectedHistoryRows.length ? state.selectedHistoryRows : [];
    if (rows.length < 2) {
      return buildChartPayloadFromRows({
        symbol: state.symbol,
        category: state.category,
        rows: [
          { tsMs: nowMs() - 300_000, price: 0 },
          { tsMs: nowMs(), price: 0 },
        ],
        plotTf: tf,
      });
    }

    const filtered = hasRange
      ? rows.filter((r) => safeNum(r.tsMs, 0) >= fromMs && safeNum(r.tsMs, 0) <= toMs)
      : rows;

    const baseRows = filtered.length >= 2 ? filtered : rows;
    const series = baseRows.map((r) => ({ tsMs: r.tsMs, price: r.price }));
    return buildChartPayloadFromRows({
      symbol: symbol || state.symbol,
      category: state.category,
      rows: series,
      plotTf: tf,
      signal: getMarketSignal(),
    });
  }

  // LIVE
  let bybitRows = [];
  try {
    if (hasRange) {
      bybitRows = await fetchBybitKlinesRange({
        category: state.category,
        symbol,
        interval: tf,
        fromMs,
        toMs,
      });
    } else {
      bybitRows = await fetchBybitKlinesLookback({
        category: state.category,
        symbol,
        interval: tf,
        lookbackMs: LIVE_DEFAULT_LOOKBACK_MS,
      });
    }
  } catch {
    bybitRows = [];
  }

  if (!bybitRows.length) {
    const last = getMarketSignal();
    const fallbackPrice = safeNum(last?.price, 0);
    const now = nowMs();
    const rows = [
      { tsMs: now - 300_000, price: fallbackPrice },
      { tsMs: now, price: fallbackPrice },
    ];
    return buildChartPayloadFromRows({ symbol, category: state.category, rows, plotTf: tf, signal: getMarketSignal() });
  }

  const rows = bybitRows.map((r) => ({ tsMs: r.startMs, price: r.close, high: r.high, low: r.low }));
  const firstTs = rows[0]?.tsMs;
  const lastTs = rows[rows.length - 1]?.tsMs;
  const lookbackDays = Number.isFinite(firstTs) && Number.isFinite(lastTs)
    ? Math.max(1, Math.ceil((lastTs - firstTs) / (24 * 60 * 60 * 1000)))
    : 7;
  const side4hDays = Math.max(lookbackDays * 2, 90);
  let analyticsTfCandles = null;
  try {
    analyticsTfCandles = await fetchTfCandlesForAnalytics({
      category: state.category,
      symbol,
      lookbackDays,
      side4hDays,
      hasRange,
      fromMs,
      toMs,
    });
  } catch {
    analyticsTfCandles = null;
  }

  return buildChartPayloadFromRows({
    symbol,
    category: state.category,
    rows,
    plotTf: tf,
    signal: getMarketSignal(),
    tfCandles: analyticsTfCandles,
  });
}

async function appendLiveCsvSnapshot() {
  if (state.mode !== "live") return;

  const snap = getMarketSignal();
  if (!snap) return;

  const tsMs = safeNum(snap.tsMs, nowMs());
  const bucket = Math.floor(tsMs / (5 * 60 * 1000));
  if (state.lastSessionBucket === bucket) return;

  await ensureSessionCsv(state.symbol);

  const row = [
    snap.ts || toIso(tsMs),
    tsMs,
    snap.symbol || state.symbol,
    snap.category || state.category,
    safeNum(snap.price, 0).toFixed(8),
    snap.regime || "UNKNOWN",
    safeNum(snap.cci, 0).toFixed(4),
    safeNum(snap.adx14, 0).toFixed(4),
    safeNum(snap.atrPct, 0).toFixed(6),
    safeNum(snap.emaSpreadPct, 0).toFixed(6),
    safeNum(snap?.momentum?.score, 0).toFixed(6),
    safeNum(snap?.derived?.pressureScore, 0).toFixed(6),
    safeNum(snap?.derived?.shockScore, 0).toFixed(6),
    safeNum(snap?.derived?.botSignal, 0).toFixed(6),
  ]
    .map(csvEscape)
    .join(",");

  await fs.appendFile(state.sessionCsvPath, `${row}\n`, "utf8");
  state.lastSessionBucket = bucket;
  await syncHistoryAliasCsv();
}

async function captureIndicatorSnapshot() {
  if (state.mode !== "live") return;

  const signal = getMarketSignal();
  if (!signal) return;

  const minuteBucket = Math.floor(safeNum(signal.tsMs, nowMs()) / 60_000);
  if (state.lastIndicatorMinute === minuteBucket) return;

  let bybitRows = [];
  try {
    bybitRows = await fetchBybitKlines({
      category: state.category,
      symbol: state.symbol,
      interval: "5",
      limit: 300,
    });
  } catch {
    bybitRows = [];
  }

  const rows = bybitRows.map((r) => ({ tsMs: r.startMs, price: r.close }));
  const analytics = computePlacementAnalytics(rows, signal);

  const snapshot = buildIndicatorSnapshot({
    symbol: state.symbol,
    category: state.category,
    signal,
    placements: analytics.placements,
    placementComponents: analytics.placementComponents,
  });

  state.indicatorHistory.push(snapshot);
  state.lastIndicatorMinute = minuteBucket;
  await persistIndicatorHistory();
}

function startLiveCsvCapture() {
  if (state.liveCaptureTimer) clearInterval(state.liveCaptureTimer);
  state.liveCaptureTimer = setInterval(() => {
    appendLiveCsvSnapshot().catch(() => {});
  }, 10_000);
}

function startIndicatorCapture() {
  if (state.indicatorCaptureTimer) clearInterval(state.indicatorCaptureTimer);

  captureIndicatorSnapshot().catch(() => {});
  state.indicatorCaptureTimer = setInterval(() => {
    captureIndicatorSnapshot().catch(() => {});
  }, 10_000);
}

function stopLiveCsvCapture() {
  if (state.liveCaptureTimer) {
    clearInterval(state.liveCaptureTimer);
    state.liveCaptureTimer = null;
  }
}

function stopIndicatorCapture() {
  if (state.indicatorCaptureTimer) {
    clearInterval(state.indicatorCaptureTimer);
    state.indicatorCaptureTimer = null;
  }
}

async function requestHandler(req, res) {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${activePort}`}`);
  const pathname = reqUrl.pathname;

  if (pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, mode: state.mode || null, symbol: state.symbol || null });
  }

  if (!enforceUiSecurity(req, res)) {
    return;
  }

  if (pathname === "/" || pathname === "/channels_demo.html") {
    return sendFile(res, path.resolve(JS_DIR, "channels_demo.html"), "text/html; charset=utf-8");
  }

  if (pathname === "/trade_history.html") {
    return sendFile(res, path.resolve(JS_DIR, "trade_history.html"), "text/html; charset=utf-8");
  }

  if (pathname === "/throttling.html") {
    return sendFile(res, path.resolve(JS_DIR, "throttling_demo.html"), "text/html; charset=utf-8");
  }

  if (pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, {
      defaultSymbol: state.symbol,
      screensEnabled: !!state.screensEnabled,
    });
  }

  if (pathname === "/api/config" && req.method === "POST") {
    const body = await parseJsonBody(req);
    if (typeof body?.screensEnabled === "boolean") {
      state.screensEnabled = body.screensEnabled;
    }
    return sendJson(res, 200, {
      ok: true,
      screensEnabled: !!state.screensEnabled,
      defaultSymbol: state.symbol,
    });
  }

  if (pathname === "/api/job-status") {
    return sendJson(res, 200, {
      ok: true,
      state: { phase: "done" },
      mode: state.mode,
      symbol: state.symbol,
    });
  }

  if (pathname === "/api/prepare") {
    return sendJson(res, 200, { ok: true, prepared: true });
  }

  if (pathname === "/data.json") {
    try {
      const payload = await buildDataJson(reqUrl);
      return sendJson(res, 200, payload);
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  if (pathname === "/api/indicator-history") {
    const symbol = normalizeSymbol(reqUrl.searchParams.get("symbol") || state.symbol) || state.symbol;
    const now = nowMs();
    const minTs = now - INDICATOR_KEEP_MS;

    const sourceRows = state.mode === "history" ? state.selectedIndicatorRows : state.indicatorHistory;
    const rows = sourceRows
      .filter((r) => String(r.symbol || "") === symbol && safeNum(r.tsMs, 0) >= minTs)
      .sort((a, b) => safeNum(a.tsMs, 0) - safeNum(b.tsMs, 0));

    return sendJson(res, 200, {
      ok: true,
      symbol,
      mode: state.mode,
      rows,
    });
  }

  if (pathname === "/api/bot-ui") {
    try {
      const raw = await fs.readFile(BOT_UI_STATE_JSON_PATH, "utf8");
      const payload = JSON.parse(raw);
      return sendJson(res, 200, {
        ok: true,
        payload,
      });
    } catch {
      return sendJson(res, 200, {
        ok: true,
        payload: null,
      });
    }
  }

  if (pathname === "/api/bot-logs") {
    const limit = Math.max(20, Math.min(800, Number(reqUrl.searchParams.get("limit") || 220)));
    try {
      const raw = await fs.readFile(BOT_UI_LOGS_PATH, "utf8");
      const lines = String(raw)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { ts: nowMs(), line };
          }
        });
      return sendJson(res, 200, {
        ok: true,
        lines,
      });
    } catch {
      return sendJson(res, 200, {
        ok: true,
        lines: [],
      });
    }
  }

  if (pathname === "/api/bot-command" && req.method === "POST") {
    const body = await parseJsonBody(req);
    const cmd = String(body?.cmd || "").trim().toLowerCase();
    if (!cmd) return sendJson(res, 400, { ok: false, error: "missing_cmd" });

    const ALLOWED = new Set(["c", "clear", "cancel_all", "cancel_one", "replace_price", "replace_quote", "place_order", "r", "regrid", "g", "grid", "reload_config", "gap_patrol_toggle", "clean_session"]);
    if (!ALLOWED.has(cmd)) {
      return sendJson(res, 400, { ok: false, error: "unsupported_cmd" });
    }

    try {
      await ensureDir(LOGS_DIR);
      const payload = { cmd, requestedAt: Date.now(), source: "ui" };

      // forward extra fields for order-level commands
      if (cmd === "cancel_one") {
        payload.orderId = String(body?.orderId || "");
        payload.orderLinkId = String(body?.orderLinkId || "");
      } else if (cmd === "replace_price") {
        payload.orderId = String(body?.orderId || "");
        payload.orderLinkId = String(body?.orderLinkId || "");
        payload.newPrice = Number(body?.newPrice);
      } else if (cmd === "replace_quote") {
        payload.orderId = String(body?.orderId || "");
        payload.orderLinkId = String(body?.orderLinkId || "");
        payload.newQuote = Number(body?.newQuote);
      } else if (cmd === "place_order") {
        payload.side = String(body?.side || "");
        payload.price = Number(body?.price);
        payload.value = Number(body?.value);
      } else if (cmd === "g" || cmd === "grid") {
        payload.cmd = "g";
        payload.orderQuoteValue = Number(body?.orderQuoteValue);
        payload.microSpacingPct = Number(body?.microSpacingPct);
      } else if (cmd === "r" || cmd === "regrid") {
        payload.cmd = "r";
      } else if (cmd === "reload_config") {
        payload.cmd = "reload_config";
      } else if (cmd === "gap_patrol_toggle" || cmd === "clean_session") {
        // pass-through: cmd already set in payload, no extra fields needed
      } else {
        payload.cmd = "c"; // normalise clear variants
      }

      await fs.writeFile(BOT_UI_CMD_PATH, JSON.stringify(payload), "utf8");
      return sendJson(res, 200, { ok: true, queued: true, cmd });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  }

  if (pathname === "/api/trade-history/files") {
    const files = await listTradeHistoryCsvFiles();
    return sendJson(res, 200, { ok: true, files });
  }

  if (pathname === "/api/trade-history") {
    const files = await listTradeHistoryCsvFiles();
    if (!files.length) {
      return sendJson(res, 200, { ok: true, file: null, summary: {}, headers: [], rows: [] });
    }

    const requested = String(reqUrl.searchParams.get("file") || "").trim();

    // ▶ BOT 8.0: prefer the currently active run from bot_ui_state.json
    let activeRunId = "";
    if (!requested) {
      try {
        const stateRaw = await fs.readFile(BOT_UI_STATE_JSON_PATH, "utf8");
        const stateJson = JSON.parse(stateRaw);
        activeRunId = String(stateJson?.runId || "").trim();
      } catch {}
    }

    let selected;
    if (requested) {
      selected = files.find((f) => f.name === requested) || files[0];
    } else if (activeRunId && files.find((f) => f.name === activeRunId)) {
      selected = files.find((f) => f.name === activeRunId);
    } else if (activeRunId && !files.find((f) => f.name === activeRunId)) {
      // Active run exists but has no fill_events.tsv yet — return empty (not stale data)
      let runSummary = {};
      try { runSummary = await parseRunSummaryTsv(activeRunId); } catch {}
      return sendJson(res, 200, {
        ok: true,
        file: activeRunId,
        summary: { ...runSummary, fills_total: 0 },
        headers: [],
        rows: [],
      });
    } else {
      selected = files[0];
    }

    const abs = path.resolve(RUNS_DIR, selected.name, "fill_events.tsv");

    try {
      const raw = await fs.readFile(abs, "utf8");
      const parsed = parseTradeHistoryCsv(raw);
      const runSummary = await parseRunSummaryTsv(selected.name);
      // merge run summary with computed fill summary (computed takes precedence for fill-level stats)
      const summary = { ...runSummary, ...parsed.summary };
      return sendJson(res, 200, {
        ok: true,
        file: selected.name,
        summary,
        headers: parsed.headers,
        rows: parsed.rows,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  }

  if (pathname === "/logs/market_history_5m.csv") {
    await syncHistoryAliasCsv();
    return sendFile(res, HISTORY_ALIAS_PATH, "text/csv; charset=utf-8");
  }

  if (pathname === "/logs/market_history.jsonl") {
    return sendFile(res, HISTORY_ALIAS_JSONL_PATH, "application/x-ndjson; charset=utf-8");
  }

  // statyczne pliki z /js i /logs
  if (pathname.startsWith("/js/")) {
    const abs = path.resolve(ROOT_DIR, pathname.slice(1));
    if (!abs.startsWith(JS_DIR)) return sendJson(res, 403, { ok: false, error: "forbidden" });
    const ext = path.extname(abs).toLowerCase();
    const ct = ext === ".js" ? "text/javascript; charset=utf-8" : ext === ".html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    return sendFile(res, abs, ct);
  }

  if (pathname.startsWith("/logs/")) {
    const abs = path.resolve(ROOT_DIR, pathname.slice(1));
    if (!abs.startsWith(LOGS_DIR)) return sendJson(res, 403, { ok: false, error: "forbidden" });
    const ext = path.extname(abs).toLowerCase();
    const ct = ext === ".csv" ? "text/csv; charset=utf-8" : ext === ".jsonl" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8";
    return sendFile(res, abs, ct);
  }

  return sendJson(res, 404, { ok: false, error: "not_found" });
}

function canListenPort(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", (err) => {
      if (err?.code === "EADDRINUSE") return resolve(false);
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort, host) {
  let port = Number(startPort || DEFAULT_PORT);
  for (let i = 0; i < 50; i += 1) {
    const ok = await canListenPort(port, host);
    if (ok) return port;
    console.log(`⚠️ Port ${port} zajęty, próbuję ${port + 1}...`);
    port += 1;
  }
  throw new Error("Nie udało się znaleźć wolnego portu dla UI server");
}

async function bootstrap() {
  await ensureDir(LOGS_DIR);
  if (UI_REQUIRE_AUTH && (!UI_AUTH_USER || !UI_AUTH_PASS)) {
    throw new Error("UI auth is required: set UI_AUTH_USER and UI_AUTH_PASS in environment");
  }

  if (UI_ENFORCE_IP_ALLOWLIST && !ALLOWED_IPS.length) {
    throw new Error("UI_ALLOWED_IPS resolved to empty allowlist");
  }

  console.log(`[UI] bind host=${UI_HOST} startPort=${UI_PORT}`);
  console.log(`[UI] allowlist=${UI_ENFORCE_IP_ALLOWLIST ? ALLOWED_IPS.join(",") : "disabled"}`);
  console.log(`[UI] auth=${UI_REQUIRE_AUTH ? "basic" : "disabled"} trustProxyHeaders=${UI_TRUST_PROXY_HEADERS ? "1" : "0"}`);
  console.log(`[cleanup] retention=${FILE_RETENTION_DAYS}d intervalMs=${FILE_CLEANUP_EVERY_MS}`);

  startFilesystemCleanup();

  await loadIndicatorHistory();
  const configuredFromArgs = await setupFromArgsIfProvided();
  if (!configuredFromArgs) {
    await askStartupMode();
  }

  if (state.mode === "live") {
    startIndicatorCapture();
  }

  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((err) => {
      console.error(`[UI] request error ${req.method || "?"} ${req.url || "?"}: ${err?.stack || err?.message || err}`);
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    });
  });

  server.on("error", (err) => {
    console.error(`[UI] server error (process kept alive): ${err?.stack || err?.message || err}`);
  });
  server.on("clientError", (err, socket) => {
    console.error(`[UI] client error: ${err?.message || err}`);
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {}
  });
  process.on("uncaughtException", (err) => {
    console.error(`[UI] uncaughtException (process kept alive): ${err?.stack || err?.message || err}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[UI] unhandledRejection (process kept alive): ${reason?.stack || reason?.message || reason}`);
  });

  const selectedPort = await findAvailablePort(UI_PORT, UI_HOST);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(selectedPort, UI_HOST, () => {
      activePort = selectedPort;
      fs.writeFile(UI_PORT_PATH, JSON.stringify({ host: UI_HOST, port: activePort, ts: Date.now() }), "utf8").catch(() => {});
      console.log(`\nSerwer działa: http://${UI_HOST}:${activePort}/channels_demo.html`);
      console.log(`Tryb: ${state.mode}`);
      resolve();
    });
  });

  const shutdown = async () => {
    stopLiveCsvCapture();
    stopIndicatorCapture();
    stopFilesystemCleanup();
    try {
      await appendLiveCsvSnapshot();
    } catch {
    }
    try {
      await captureIndicatorSnapshot();
    } catch {
    }

    try {
      await stopMarketSignal();
    } catch {
    }

    server.close(() => {
      fs.unlink(UI_PORT_PATH).catch(() => {});
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function buildRuntimeRows(limit = 300) {
  const hist = Array.isArray(getHistoryBuffer?.()) ? getHistoryBuffer() : [];
  const rows = hist
    .slice(-Math.max(20, Number(limit) || 300))
    .map((r) => ({
      tsMs: safeNum(r?.tsMs, nowMs()),
      price: safeNum(r?.price, NaN),
    }))
    .filter((r) => Number.isFinite(r.tsMs) && Number.isFinite(r.price) && r.price > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  return rows;
}

export async function startMomentum(opts = {}) {
  const symbol = normalizeSymbol(opts.symbol || state.symbol || "BTCUSDT") || "BTCUSDT";
  const category = String(opts.category || state.category || "linear").toLowerCase();
  const pollMs = Math.max(1_000, safeNum(opts.pollMs, 10_000));

  await startMarketSignal({
    symbol,
    category,
    pollMs,
    silent: opts.silent != null ? Boolean(opts.silent) : true,
    debug: Boolean(opts.debug),
  });

  state.runtimeStarted = true;
  state.symbol = symbol;
  state.category = category;
}

export async function stopMomentum() {
  state.runtimeStarted = false;
  await stopMarketSignal();
}

export function getMomentumScore() {
  return safeNum(getMarketMomentumScore?.(), 0);
}

export function getMomentum() {
  return getMarketMomentum?.() || null;
}

export function getRegimeSnapshot() {
  return getMarketRegimeSnapshot?.() || null;
}

export function getMarketContextSnapshot() {
  const signal = getMarketSignal?.() || null;
  const rows = buildRuntimeRows(360);
  const analytics = computePlacementAnalytics(rows, signal);

  return {
    signal,
    analytics,
    placements: analytics?.placements || {},
    rowsCount: rows.length,
    runtimeStarted: !!state.runtimeStarted,
  };
}

const RUN_AS_CLI = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (RUN_AS_CLI) {
  bootstrap().catch((err) => {
    console.error(`Błąd startu serwera: ${err?.message || err}`);
    process.exit(1);
  });
}
