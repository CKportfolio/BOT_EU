import fs from "fs";
import path from "path";
import crypto from "crypto";

import { CONFIG } from "../config.js";
import { parseSymbol, fmt, fmt8 } from "./symbols.js";
import { getLastClosed1mClose } from "./data.js";
import { buildGrid, computeFeeGuardSpacingPct } from "./grid.js";
import {
  paperInitBalances,
  paperCancelAll,
  paperCancelOne,
  paperCheckFills,
  paperPlaceOneExactQty,
} from "./execution_paper.js";
import {
  getFeeRate,
  getWalletBalances,
  pickCoinBalance,
  pickCoinAvailable,
  cancelAllOrders,
  cancelOneOrder,
  placeLimitOrder,
  getOpenOrders,
  getExecutions,
  __debugGetSpecs,
  applySpecsToOrder,
} from "./live.js";
import { startConsole } from "./console_support.js";

const MODE = String(CONFIG.MODE || "PAPER").toUpperCase();
const IS_LIVE = MODE === "LIVE";
const IS_PAPER = MODE === "PAPER";

const UI_LOG_DIR = path.resolve("./scripts/logs");
const INSTANCE_LOCK_PATH = path.join(UI_LOG_DIR, "bot.instance.lock");
const UI_STATE_PATH = path.join(UI_LOG_DIR, "bot_ui_state.json");
const UI_LOGS_PATH = path.join(UI_LOG_DIR, "bot_ui_logs.ndjson");
const UI_CMD_PATH = path.join(UI_LOG_DIR, "bot_ui_cmd.json");

let instanceLockFd = null;
let consoleWrapped = false;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function color(text, { c = "", b = false } = {}) {
  const cc = ANSI[c] || "";
  const bb = b ? ANSI.bold : "";
  return `${bb}${cc}${text}${ANSI.reset}`;
}

function sideWord(side) {
  if (side === "Buy") return color("buy", { c: "green", b: true });
  if (side === "Sell") return color("sell", { c: "red", b: true });
  return String(side || "").toLowerCase();
}

function deriveReservedFromOpenOrders(state) {
  const open = Array.isArray(state?.openOrders) ? state.openOrders : [];
  let reservedBase = 0;
  let reservedQuote = 0;
  for (const o of open) {
    const side = String(o?.side || "");
    const p = Number(o?.price || 0);
    const q = Number(o?.qty || 0);
    if (!(Number.isFinite(p) && p > 0 && Number.isFinite(q) && q > 0)) continue;
    if (side === "Buy") reservedQuote += p * q;
    if (side === "Sell") reservedBase += q;
  }
  return { base: reservedBase, quote: reservedQuote };
}

function deriveLiveFunds(state) {
  const total = {
    base: Math.max(0, Number(state?.balances?.base || 0)),
    quote: Math.max(0, Number(state?.balances?.quote || 0)),
  };
  const reserved = deriveReservedFromOpenOrders(state);
  return {
    total,
    reserved,
    free: {
      base: Math.max(0, total.base - reserved.base),
      quote: Math.max(0, total.quote - reserved.quote),
    },
  };
}

function nowMs() {
  return Date.now();
}

function statePathFor(ctx) {
  const safeMarket = String(ctx.symbol || "MARKET").replace(/[^A-Za-z0-9_-]/g, "_");
  const safeMode = String(MODE || "PAPER").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(UI_LOG_DIR, `runtime_state_${safeMarket}_${safeMode}.json`);
}

function ensureDir() {
  fs.mkdirSync(UI_LOG_DIR, { recursive: true });
}

function stripAnsi(input) {
  return String(input ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

function ensureUiBridgeFiles() {
  ensureDir();
  try {
    if (!fs.existsSync(UI_LOGS_PATH)) fs.writeFileSync(UI_LOGS_PATH, "", "utf8");
    if (!fs.existsSync(UI_CMD_PATH)) fs.writeFileSync(UI_CMD_PATH, "", "utf8");
  } catch {}
}

function uiAppendLogLine(line) {
  try {
    ensureUiBridgeFiles();
    const payload = { ts: Date.now(), line: stripAnsi(line) };
    fs.appendFileSync(UI_LOGS_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {}
}

function wrapConsoleForUiLogs() {
  if (consoleWrapped) return;
  consoleWrapped = true;

  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;

  console.log = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    uiAppendLogLine(line);
    origLog(...args);
  };
  console.warn = (...args) => {
    const line = "WARN " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    uiAppendLogLine(line);
    origWarn(...args);
  };
  console.error = (...args) => {
    const line = "ERR " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    uiAppendLogLine(line);
    origErr(...args);
  };
}

function buildUiStateSnapshot(state, ctx, currentPrice) {
  const openOrders = Array.isArray(state?.openOrders) ? state.openOrders : [];
  const buyCount = openOrders.filter((o) => o?.side === "Buy").length;
  const sellCount = openOrders.filter((o) => o?.side === "Sell").length;

  const derivedReserved = IS_PAPER
    ? { base: Number(state?.reserved?.base || 0), quote: Number(state?.reserved?.quote || 0) }
    : deriveReservedFromOpenOrders(state);

  const liveFunds = IS_LIVE ? deriveLiveFunds(state) : null;
  const freeBase = IS_PAPER ? Number(state?.balances?.base || 0) : liveFunds.free.base;
  const freeQuote = IS_PAPER ? Number(state?.balances?.quote || 0) : liveFunds.free.quote;
  const reservedBase = IS_PAPER ? Number(derivedReserved.base || 0) : liveFunds.reserved.base;
  const reservedQuote = IS_PAPER ? Number(derivedReserved.quote || 0) : liveFunds.reserved.quote;
  const totalBase = IS_PAPER ? freeBase + reservedBase : liveFunds.total.base;
  const totalQuote = IS_PAPER ? freeQuote + reservedQuote : liveFunds.total.quote;

  const beginPrice = Number(state?.startPrice || currentPrice || 0);
  const spreadPct = beginPrice > 0 ? ((Number(currentPrice || 0) - beginPrice) / beginPrice) * 100 : 0;
  const startBase = Number(state?.startBalances?.base || 0);
  const startQuote = Number(state?.startBalances?.quote || 0);
  const startBudget = startQuote + startBase * beginPrice;
  const equityNow = totalQuote + totalBase * Number(currentPrice || 0);
  const pnlPct = startBudget > 0 ? ((equityNow - startBudget) / startBudget) * 100 : 0;

  const summaryLines = [
    `open: total=${openOrders.length} | buy=${buyCount} | sell=${sellCount}`,
    `fills: buy=${Number(state?.stats?.buyFills || 0)} | sell=${Number(state?.stats?.sellFills || 0)}`,
    `price: ${fmt(Number(currentPrice || 0), 6)} ${ctx.quote} | beginning price: ${fmt(beginPrice, 6)} ${ctx.quote} | spread: ${fmt(spreadPct, 3)}%`,
    `FREE:     ${ctx.base}=${fmt8(freeBase)} | ${ctx.quote}=${fmt8(freeQuote)}`,
    `RESERVED: ${ctx.base}=${fmt8(reservedBase)} | ${ctx.quote}=${fmt8(reservedQuote)}`,
    `TOTAL:    ${ctx.base}=${fmt8(totalBase)} | ${ctx.quote}=${fmt8(totalQuote)}`,
    `FEE: maker=${fmt(Number(state?.fee?.maker || 0) * 100, 4)}% | taker=${fmt(Number(state?.fee?.taker || 0) * 100, 4)}% | effective=${fmt(Number(state?.fee?.effective || 0) * 100, 4)}%`,
    `equity teraz: ${fmt(equityNow, 2)} ${ctx.quote} | ${fmt(pnlPct, 3)}%`,
    `COMPOUND: loops=${Number(state?.loopStats?.loopsTotal || 0)} | profit=${fmt8(Number(state?.loopStats?.profitQuoteTotal || 0))} ${ctx.quote}`,
  ];

  const orders = openOrders
    .map((o) => {
      const price = Number(o?.price || 0);
      const qty = Number(o?.qty || 0);
      return {
        id: String(o?.id || ""),
        linkId: String(o?.linkId || ""),
        side: String(o?.side || ""),
        price,
        qty,
        notional: price * qty,
        status: String(o?.status || "OPEN"),
        gridTag: String(o?.gridTag || "G1"),
      };
    })
    .filter((o) => Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.qty) && o.qty > 0)
    .sort((a, b) => {
      if (a.side !== b.side) return a.side === "Sell" ? -1 : 1;
      return b.price - a.price;
    });

  return {
    ts: Date.now(),
    market: ctx.pair,
    mode: MODE,
    currentPrice: Number(currentPrice || 0),
    runId: String(state?.__runLog?.runId || ""),
    summaryLines,
    orders,
    recentFills: Array.isArray(state?._recentFillsForUi) ? state._recentFillsForUi.slice(-200) : [],
    impulse: null,
    anchors: [],
    gapPatrolPaused: false,
    configSnapshot: {
      orderQuoteValue: Number(CONFIG.ORDER_QUOTE_VALUE || 0),
      microSpacingPct: Number(CONFIG.MICRO_SPACING_PCT || 0),
    },
  };
}

function writeUiStateSnapshot(snapshot) {
  try {
    ensureUiBridgeFiles();
    fs.writeFileSync(UI_STATE_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {}
}

function readUiCommand() {
  try {
    ensureUiBridgeFiles();
    const raw = fs.readFileSync(UI_CMD_PATH, "utf8").trim();
    if (!raw) return null;
    fs.writeFileSync(UI_CMD_PATH, "", "utf8");
    const cmdObj = JSON.parse(raw);
    const cmd = String(cmdObj?.cmd || "").trim().toLowerCase();
    if (!cmd) return null;
    return { ...cmdObj, cmd };
  } catch {
    return null;
  }
}

async function reloadConfig() {
  const url = new URL("../config.js", import.meta.url);
  url.searchParams.set("t", String(Date.now()));
  const fresh = await import(url.href);
  const freshCfg = fresh?.CONFIG;
  if (!freshCfg || typeof freshCfg !== "object") throw new Error("fresh.CONFIG missing");
  Object.assign(CONFIG, freshCfg);
  return Object.keys(freshCfg).length;
}

function isPidRunning(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInstanceLock() {
  ensureDir();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      instanceLockFd = fs.openSync(INSTANCE_LOCK_PATH, "wx");
      fs.writeFileSync(
        instanceLockFd,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: MODE }, null, 2),
        "utf8"
      );
      return;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;

      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
      } catch {}

      const existingPid = Number(existing?.pid || 0);
      if (existingPid === process.pid || !isPidRunning(existingPid)) {
        try {
          fs.unlinkSync(INSTANCE_LOCK_PATH);
          continue;
        } catch (unlinkErr) {
          throw new Error(`stale lock cannot be removed: ${unlinkErr?.message || unlinkErr}`);
        }
      }

      throw new Error(`another bot instance is already running (pid=${existingPid})`);
    }
  }

  throw new Error("failed to acquire instance lock");
}

function releaseInstanceLock() {
  const fd = instanceLockFd;
  instanceLockFd = null;
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  try {
    if (fs.existsSync(INSTANCE_LOCK_PATH)) fs.unlinkSync(INSTANCE_LOCK_PATH);
  } catch {}
}

function defaultState() {
  return {
    balances: { base: 0, quote: 0 },
    available: { base: 0, quote: 0 },
    reserved: IS_PAPER ? { base: 0, quote: 0 } : null,
    openOrders: [],
    fee: { maker: null, taker: null, effective: null },
    stats: { buyFills: 0, sellFills: 0 },
    counterRefs: new Map(),
    loopStats: {
      loopsTotal: 0,
      profitQuoteTotal: 0,
      lastLoopProfit: 0,
      lastLoopAt: 0,
    },
    compoundingStats: {
      fromSellReinvestQuoteTotal: 0,
    },
    liveSeenExecIds: new Set(),
    liveExecCursorMs: 0,
    lastSummaryAt: 0,
    prevClose: 0,
    startPrice: 0,
    startBalances: { base: 0, quote: 0 },
    _recentFillsForUi: [],
    __runLog: null,
  };
}

function serializeState(state) {
  return {
    ts: Date.now(),
    mode: MODE,
    startPrice: Number(state.startPrice || 0),
    startBalances: {
      base: Number(state.startBalances?.base || 0),
      quote: Number(state.startBalances?.quote || 0),
    },
    stats: {
      buyFills: Number(state.stats?.buyFills || 0),
      sellFills: Number(state.stats?.sellFills || 0),
    },
    loopStats: {
      loopsTotal: Number(state.loopStats?.loopsTotal || 0),
      profitQuoteTotal: Number(state.loopStats?.profitQuoteTotal || 0),
      lastLoopProfit: Number(state.loopStats?.lastLoopProfit || 0),
      lastLoopAt: Number(state.loopStats?.lastLoopAt || 0),
    },
    compoundingStats: {
      fromSellReinvestQuoteTotal: Number(state.compoundingStats?.fromSellReinvestQuoteTotal || 0),
    },
    counterRefs: Array.from(state.counterRefs.entries()),
    liveSeenExecIds: Array.from(state.liveSeenExecIds.values()).slice(-4000),
    liveExecCursorMs: Number(state.liveExecCursorMs || 0),
  };
}

function restoreState(state, statePath) {
  if (!CONFIG.RUNTIME_STATE_PERSIST_ENABLED) return;
  const allowRestore = IS_PAPER ? CONFIG.RUNTIME_STATE_RESTORE_IN_PAPER : CONFIG.RUNTIME_STATE_RESTORE_IN_LIVE;
  if (!allowRestore) return;

  try {
    if (!fs.existsSync(statePath)) return;
    const raw = fs.readFileSync(statePath, "utf8");
    if (!raw) return;

    const parsed = JSON.parse(raw);
    const fileMode = String(parsed?.mode || "").toUpperCase();
    if (fileMode && fileMode !== MODE) return;

    if (parsed?.startBalances) {
      state.startBalances = {
        base: Number(parsed.startBalances.base || 0),
        quote: Number(parsed.startBalances.quote || 0),
      };
    }
    state.startPrice = Number(parsed?.startPrice || 0) || state.startPrice;

    if (parsed?.stats) {
      state.stats.buyFills = Number(parsed.stats.buyFills || 0);
      state.stats.sellFills = Number(parsed.stats.sellFills || 0);
    }

    if (parsed?.loopStats) {
      state.loopStats.loopsTotal = Number(parsed.loopStats.loopsTotal || 0);
      state.loopStats.profitQuoteTotal = Number(parsed.loopStats.profitQuoteTotal || 0);
      state.loopStats.lastLoopProfit = Number(parsed.loopStats.lastLoopProfit || 0);
      state.loopStats.lastLoopAt = Number(parsed.loopStats.lastLoopAt || 0);
    }

    if (parsed?.compoundingStats) {
      state.compoundingStats.fromSellReinvestQuoteTotal = Number(
        parsed.compoundingStats.fromSellReinvestQuoteTotal || 0
      );
    }

    if (Array.isArray(parsed?.counterRefs)) {
      state.counterRefs = new Map(parsed.counterRefs);
    }
    if (Array.isArray(parsed?.liveSeenExecIds)) {
      state.liveSeenExecIds = new Set(parsed.liveSeenExecIds.map((x) => String(x)));
    }
    if (Number.isFinite(Number(parsed?.liveExecCursorMs))) {
      state.liveExecCursorMs = Number(parsed.liveExecCursorMs);
    }

    console.log(`♻ state restored from ${statePath}`);
  } catch (e) {
    console.log(`⚠ state restore error: ${e?.message || e}`);
  }
}

function persistState(state, statePath) {
  if (!CONFIG.RUNTIME_STATE_PERSIST_ENABLED) return;
  try {
    ensureDir();
    fs.writeFileSync(statePath, JSON.stringify(serializeState(state), null, 2), "utf8");
  } catch (e) {
    console.log(`⚠ state persist error: ${e?.message || e}`);
  }
}

async function syncBalances(state, base, quote) {
  if (IS_PAPER) return;
  const coins = await getWalletBalances();

  if (!Array.isArray(coins) || coins.length === 0) {
    console.log(`⚠ wallet balance sync returned no coins; keeping previous balances`);
    return false;
  }

  const baseRow = coins.find((coin) => String(coin?.coin || "").toUpperCase() === String(base || "").toUpperCase());
  const quoteRow = coins.find((coin) => String(coin?.coin || "").toUpperCase() === String(quote || "").toUpperCase());
  if (!baseRow && !quoteRow) {
    console.log(`⚠ wallet balance sync missing ${base}/${quote}; received coins=${coins.length}`);
    return false;
  }

  const nextBase = pickCoinBalance(coins, base);
  const nextQuote = pickCoinBalance(coins, quote);
  const nextAvailableBase = pickCoinAvailable(coins, base);
  const nextAvailableQuote = pickCoinAvailable(coins, quote);

  if (baseRow) state.balances.base = nextBase;
  if (quoteRow) state.balances.quote = nextQuote;
  if (baseRow) state.available.base = nextAvailableBase;
  if (quoteRow) state.available.quote = nextAvailableQuote;

  if (!baseRow || !quoteRow) {
    console.log(`⚠ wallet balance sync partial ${base}/${quote}; received coins=${coins.length}`);
  }

  return true;
}

async function refreshOpenOrders(state, ctx) {
  if (IS_PAPER) return;
  const rows = await getOpenOrders(CONFIG.CATEGORY, ctx.symbol);
  const list = [];
  for (const r of rows || []) {
    const side = String(r.side || "");
    const price = Number(r.price || 0);
    const qty = Number(r.qty || 0);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
    list.push({
      id: String(r.orderId || r.id || ""),
      linkId: String(r.orderLinkId || ""),
      side,
      price,
      qty,
      notionalQuote: price * qty,
      status: String(r.orderStatus || "OPEN"),
      placedAt: Number(r.createdTime || nowMs()),
    });
  }
  state.openOrders = list;
}

async function cancelAllUnified(state, ctx) {
  if (IS_PAPER) {
    paperCancelAll(state, "", "REGRID");
    return;
  }
  await cancelAllOrders(CONFIG.CATEGORY, ctx.symbol);
  await refreshOpenOrders(state, ctx);
}

async function cancelOrderByRef(state, ctx, { orderId, orderLinkId } = {}, info = "CANCEL_ONE") {
  const oid = String(orderId || "").trim();
  const olid = String(orderLinkId || "").trim();
  if (!oid && !olid) return false;

  if (IS_PAPER) {
    if (oid) {
      const ok = paperCancelOne(state, "", oid, info);
      if (ok) return true;
    }
    if (olid) {
      const hit = (state.openOrders || []).find((o) => String(o?.linkId || "") === olid);
      if (hit?.id) return paperCancelOne(state, "", String(hit.id), info);
    }
    return false;
  }

  await cancelOneOrder(CONFIG.CATEGORY, ctx.symbol, oid, olid || null);
  state.openOrders = (state.openOrders || []).filter(
    (o) => !(String(o?.id || "") === oid || (olid && String(o?.linkId || "") === olid))
  );
  return true;
}

async function placeOneExact(state, ctx, { side, price, qty, info = "GRID", qtyRoundingMode = "floor" }) {
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(q) || q <= 0) return null;

  if (IS_PAPER) {
    const out = paperPlaceOneExactQty(state, "", { side, price: p, qty: q, info, gridTag: "G1" });
    if (!out) return null;
    out.linkId = out.linkId || "";
    out.id = out.id || crypto.randomUUID();
    return out;
  }

  const linkId = `BOTEU_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const placed = await placeLimitOrder({
    category: CONFIG.CATEGORY,
    symbol: ctx.symbol,
    side,
    qty: q,
    price: p,
    orderLinkId: linkId,
    qtyRoundingMode,
  });

  if (placed?.skipped) return null;

  const orderId = String(placed?.orderId || "");
  let finalPrice = Number(placed?.price || p);
  let finalQty = Number(placed?.qty || q);

  // Exchange can normalize qty/price on create. Try to read back canonical values.
  if (orderId) {
    try {
      const rows = await getOpenOrders(CONFIG.CATEGORY, ctx.symbol);
      const hit = (rows || []).find((r) => String(r?.orderId || "") === orderId);
      if (hit) {
        const hp = Number(hit?.price || 0);
        const hq = Number(hit?.qty || 0);
        if (Number.isFinite(hp) && hp > 0) finalPrice = hp;
        if (Number.isFinite(hq) && hq > 0) finalQty = hq;
      }
    } catch {}
  }

  const local = {
    id: orderId,
    linkId,
    side,
    price: finalPrice,
    qty: finalQty,
    notionalQuote: finalPrice * finalQty,
    status: "OPEN",
    placedAt: nowMs(),
    info,
  };

  state.openOrders.push(local);
  return local;
}

function chooseCounterStepPct() {
  const raw = Number(CONFIG.COUNTER_GRID_STEP_PCT ?? CONFIG.MICRO_SPACING_PCT ?? 0.5);
  if (!Number.isFinite(raw) || raw <= 0) return 0.5;
  return raw;
}

function rememberCounterRef(state, counterOrder, ref) {
  if (!counterOrder) return;
  const id = String(counterOrder.id || "");
  const linkId = String(counterOrder.linkId || "");
  const payload = { ...ref, createdAt: nowMs() };
  if (id) state.counterRefs.set(id, payload);
  if (linkId) state.counterRefs.set(linkId, payload);
}

async function prepareCounterOrder(state, ctx, { side, price, qty }) {
  let out = { price: Number(price), qty: Number(qty) };
  if (!IS_LIVE) return out;

  const specs = await __debugGetSpecs(CONFIG.CATEGORY, ctx.symbol);
  const adjusted = applySpecsToOrder({
    price: out.price,
    qty: out.qty,
    specs,
    side,
    qtyRoundingMode: "round",
  });
  if (!Number.isFinite(adjusted?.price) || adjusted.price <= 0 || !Number.isFinite(adjusted?.qty) || adjusted.qty <= 0) {
    console.log(`⚠ counter ${side} skipped: quantity rounded to zero or below exchange minimum`);
    return null;
  }

  const finalNotional = adjusted.price * adjusted.qty;
  const settleTimeoutMs = Math.max(1000, Number(CONFIG.COUNTER_BALANCE_TIMEOUT_MS || 12000));
  const settlePollMs = Math.max(100, Number(CONFIG.COUNTER_BALANCE_POLL_MS || 300));
  const startedAt = Date.now();
  let freeBase = 0;
  let freeQuote = 0;

  while (true) {
    await syncBalances(state, ctx.base, ctx.quote);
    await refreshOpenOrders(state, ctx);
    const liveFunds = deriveLiveFunds(state);
    freeBase = liveFunds.free.base;
    freeQuote = liveFunds.free.quote;
    const withinFree = side === "Sell"
      ? adjusted.qty <= freeBase + 1e-12
      : finalNotional <= freeQuote + 1e-12;

    if (withinFree) break;
    if (Date.now() - startedAt >= settleTimeoutMs) {
      console.log(
        `⚠ counter ${side} skipped after balance wait: rounded ${side === "Sell" ? "qty" : "notional"} exceeds free ` +
        `${side === "Sell" ? freeBase.toFixed(8) + " " + ctx.base : freeQuote.toFixed(6) + " " + ctx.quote}`
      );
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, settlePollMs));
  }

  console.log(
    `📐 counter ${side} sizing | requested=${out.qty.toFixed(8)} -> rounded=${adjusted.qty.toFixed(8)} ` +
    `diff=${(adjusted.qty - out.qty >= 0 ? "+" : "")}${(adjusted.qty - out.qty).toFixed(8)} ` +
    `price=${adjusted.price} notional=${finalNotional.toFixed(6)} ` +
    `free=${side === "Sell" ? freeBase.toFixed(8) + " " + ctx.base : freeQuote.toFixed(6) + " " + ctx.quote}`
  );

  return { price: adjusted.price, qty: adjusted.qty };
}

function consumeCounterLoop(state, fill) {
  const id = String(fill.orderId || fill.id || "");
  const linkId = String(fill.orderLinkId || fill.linkId || "");
  const ref = (linkId && state.counterRefs.get(linkId)) || (id && state.counterRefs.get(id));
  if (!ref) return { wasCounter: false, profitQuote: 0 };

  const fillPrice = Number(fill.fillPrice || fill.price || 0);
  const fillQty = Number(fill.qty || 0);
  const parentPrice = Number(ref.parentPrice || 0);
  const parentQty = Number(ref.parentQty || 0);

  if (!(fillPrice > 0) || !(fillQty > 0) || !(parentPrice > 0) || !(parentQty > 0)) {
    if (id) state.counterRefs.delete(id);
    if (linkId) state.counterRefs.delete(linkId);
    return { wasCounter: true, profitQuote: 0 };
  }

  const parentNotional = Number(ref.parentNotional || parentPrice * parentQty);
  const counterNotional = Number(fill.notionalQuote || fillPrice * fillQty);
  const parentFee = Number(ref.parentFee || 0);
  const counterFee = Number(fill.fee || 0);
  const parentFeeInQuote = ref.parentFeeInQuote === true;
  const counterFeeInQuote = fill.feeInQuote === true || String(fill.feeCurrency || "").toUpperCase() === "QUOTE";
  const parentBuyCost = parentNotional + (parentFeeInQuote ? parentFee : 0);
  const counterBuyCost = counterNotional + (counterFeeInQuote ? counterFee : 0);
  const parentSellProceeds = parentNotional - (parentFeeInQuote ? parentFee : 0);
  const counterSellProceeds = counterNotional - (counterFeeInQuote ? counterFee : 0);

  let profitQuote = 0;
  if (ref.parentSide === "Buy" && fill.side === "Sell") {
    profitQuote = counterSellProceeds - parentBuyCost;
  } else if (ref.parentSide === "Sell" && fill.side === "Buy") {
    profitQuote = parentSellProceeds - counterBuyCost;
  }

  if (!Number.isFinite(profitQuote)) profitQuote = 0;

  if (id) state.counterRefs.delete(id);
  if (linkId) state.counterRefs.delete(linkId);

  state.loopStats.loopsTotal += 1;
  state.loopStats.profitQuoteTotal += profitQuote;
  state.loopStats.lastLoopProfit = profitQuote;
  state.loopStats.lastLoopAt = nowMs();

  return { wasCounter: true, profitQuote };
}

async function placeCounterFromFill(state, ctx, fill) {
  const side = String(fill.side || "");
  const fillPrice = Number(fill.fillPrice || fill.price || 0);
  const fillQty = Number(fill.qty || 0);
  const fillNotional = Number(fill.notionalQuote || fillPrice * fillQty);
  const fee = Number(fill.fee || 0);
  const feeCurrency = String(fill.feeCurrency || "").toUpperCase();
  const feeInQuote = fill.feeInQuote === true || feeCurrency === "QUOTE";
  const feeInBase = fill.feeInBase === true || feeCurrency === "BASE";
  const netBaseQty = Number(fill.netBaseQty || (
    side === "Buy" && feeInBase ? Math.max(0, fillQty - fee) : fillQty
  ));

  if (!(fillPrice > 0) || !(fillQty > 0)) return null;

  const stepPct = chooseCounterStepPct() / 100;
  if (side === "Buy") {
    const sellPrice = fillPrice * (1 + stepPct);
    const sellQty = netBaseQty;
    if (!(sellQty > 0)) return null;
    const counter = await prepareCounterOrder(state, ctx, { side: "Sell", price: sellPrice, qty: sellQty });
    if (!counter) return null;
    const placed = await placeOneExact(state, ctx, {
      side: "Sell",
      price: counter.price,
      qty: counter.qty,
      info: "COUNTER_FROM_BUY",
      qtyRoundingMode: "round",
    });
    if (placed) {
      placed.counterRequested = {
        side: "Sell",
        price: counter.price,
        qty: counter.qty,
        notionalQuote: counter.price * counter.qty,
      };
      rememberCounterRef(state, placed, {
        parentSide: "Buy",
        parentPrice: fillPrice,
        parentQty: sellQty,
        parentNotional: fillNotional,
        parentFee: fee,
        parentFeeInQuote: feeInQuote,
        qty: counter.qty,
      });
    }
    return placed;
  }

  if (side === "Sell") {
    const buyPrice = fillPrice * (1 - stepPct);
    const proceedsQuote = Math.max(0, fillNotional - (feeInQuote ? fee : 0));

    // Full reinvest from sell proceeds into lower buy counter.
    let buyNotional = proceedsQuote;
    if (CONFIG.STRAT_COUNTER_COMPOUNDING_ENABLED) {
      buyNotional *= Math.max(0, Number(CONFIG.STRAT_COUNTER_COMPOUNDING_FACTOR || 1));
    }
    const buyQty = buyPrice > 0 ? buyNotional / buyPrice : 0;
    if (!(buyQty > 0)) return null;
    const counter = await prepareCounterOrder(state, ctx, { side: "Buy", price: buyPrice, qty: buyQty });
    if (!counter) return null;

    const placed = await placeOneExact(state, ctx, {
      side: "Buy",
      price: counter.price,
      qty: counter.qty,
      info: "COUNTER_FROM_SELL",
      qtyRoundingMode: "round",
    });

    if (placed) {
      placed.counterRequested = {
        side: "Buy",
        price: counter.price,
        qty: counter.qty,
        notionalQuote: counter.price * counter.qty,
        proceedsQuote,
      };
      state.compoundingStats.fromSellReinvestQuoteTotal += proceedsQuote;
      rememberCounterRef(state, placed, {
        parentSide: "Sell",
        parentPrice: fillPrice,
        parentQty: fillQty,
        parentNotional: fillNotional,
        parentFee: fee,
        parentFeeInQuote: feeInQuote,
        qty: Number(placed.qty || counter.qty),
      });
    }

    return placed;
  }

  return null;
}

function liveMinFundsOk(state) {
  const q = Number(state.balances.quote || 0);
  const b = Number(state.balances.base || 0);
  const minQ = Number(CONFIG.LIVE_MIN_QUOTE || 0);
  const minB = Number(CONFIG.LIVE_MIN_BASE || 0);
  return {
    ok: q >= minQ && b >= minB,
    q,
    b,
    minQ,
    minB,
  };
}

function isInvalidApiKeyError(err) {
  const msg = String(err?.message || err || "");
  return (
    /retCode\s*=\s*10003/i.test(msg) ||
    /retCode\s*=\s*10010/i.test(msg) ||
    /status code\s*401/i.test(msg) ||
    /api key is invalid/i.test(msg) ||
    /invalid api key/i.test(msg) ||
    /unmatched ip/i.test(msg)
  );
}

function isPermissionDeniedError(err) {
  const msg = String(err?.message || err || "");
  return /retCode\s*=\s*10005/i.test(msg) || /permission denied/i.test(msg);
}

async function ensureLiveMarketContextStrict(initialCtx) {
  const configured = String(initialCtx?.symbol || "").toUpperCase();
  if (!configured) throw new Error("FATAL_NO_RETRY: missing market symbol");

  const typoHint = configured.endsWith("USTD")
    ? ` Did you mean ${configured.slice(0, -4)}USDT?`
    : "";

  try {
    await __debugGetSpecs(CONFIG.CATEGORY, configured);
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/No instrument info/i.test(msg)) {
      const endpoint = process.env.BYBIT_TRADE_BASE_URL || process.env.BYBIT_BASE_URL || "https://api.bybit.eu";
      let alternatives = [];
      if (configured.endsWith("USDT")) {
        const base = configured.slice(0, -4);
        const probes = [`${base}USDC`, `${base}EUR`, `${base}PLN`];
        for (const s of probes) {
          try {
            await __debugGetSpecs(CONFIG.CATEGORY, s);
            alternatives.push(s);
          } catch {}
        }
      }
      const altHint = alternatives.length
        ? ` Available on this endpoint/category: ${alternatives.join(", ")}.`
        : "";
      throw new Error(
        `FATAL_NO_RETRY: market ${configured} unavailable on ${endpoint} for category=${CONFIG.CATEGORY}. ` +
        `Set BOT_MARKET to a supported symbol for this endpoint.${altHint}${typoHint}`
      );
    }
    throw e;
  }

  const out = parseSymbol(configured);
  return { ...out, pair: `${out.base}/${out.quote}` };
}

async function startupCheckLiveCredentials(ctx) {
  const apiKey = process.env.BYBIT_API_KEY || process.env.BYBIT_KEY || "";
  const apiSecret = process.env.BYBIT_API_SECRET || process.env.BYBIT_SECRET || "";
  if (!apiKey || !apiSecret) {
    throw new Error("FATAL_NO_RETRY: Missing API credentials (BYBIT_API_KEY/BYBIT_API_SECRET or BYBIT_KEY/BYBIT_SECRET)");
  }

  try {
    const [feeRate, coins] = await Promise.all([
      getFeeRate(CONFIG.CATEGORY, ctx.symbol),
      getWalletBalances(),
    ]);
    return { feeRate, coins };
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      throw new Error(
        `FATAL_NO_RETRY: API key lacks required permissions (${err?.message || err}). ` +
        `Enable Wallet read + Spot trading permissions for this key.`
      );
    }
    if (isInvalidApiKeyError(err)) {
      throw new Error(`FATAL_NO_RETRY: API keys invalid for Bybit account/auth (${err?.message || err})`);
    }
    throw err;
  }
}

function applyWalletCoinsToState(state, base, quote, coins) {
  state.balances.base = pickCoinBalance(coins, base);
  state.balances.quote = pickCoinBalance(coins, quote);
  state.available.base = pickCoinAvailable(coins, base);
  state.available.quote = pickCoinAvailable(coins, quote);
}

async function doRegrid(state, ctx, price) {
  await cancelAllUnified(state, ctx);

  const liveFunds = IS_LIVE ? deriveLiveFunds(state) : null;
  const freeBase = IS_PAPER ? Number(state.balances.base || 0) : liveFunds.free.base;
  const freeQuote = IS_PAPER ? Number(state.balances.quote || 0) : liveFunds.free.quote;
  const perOrder = Number(CONFIG.ORDER_QUOTE_VALUE || 0);
  const sellQuoteEq = freeBase * Number(price || 0);

  const grid = buildGrid({
    midPrice: price,
    clustersZoned: [],
    balances: { base: freeBase, quote: freeQuote },
    feeRate: Number(state.fee?.effective || 0),
    strategyPolicy: {
      allowNewBuys: true,
      allowNewSells: true,
      spacingMultBuy: 1,
      spacingMultSell: 1,
      orderCountMultBuy: 1,
      orderCountMultSell: 1,
      capitalUsagePct: 1,
    },
  });

  const orders = Array.isArray(grid.orders) ? grid.orders : [];
  const buyReq = orders.filter((o) => o.side === "Buy").length;
  const sellReq = orders.filter((o) => o.side === "Sell").length;
  let placed = 0;

  for (const o of orders) {
    const out = await placeOneExact(state, ctx, {
      side: o.side,
      price: Number(o.price),
      qty: Number(o.qty),
      info: "REGRID",
    });
    if (out) placed += 1;
  }

  if (IS_LIVE) await refreshOpenOrders(state, ctx);

  console.log(`🔁 regrid completed | requested=${orders.length} placed=${placed}`);
  if (sellReq === 0) {
    console.log(
      `ℹ regrid info: no SELL levels generated | free ${ctx.base}=${fmt8(freeBase)} (~${fmt(sellQuoteEq, 2)} ${ctx.quote}) | ` +
      `orderQuote=${fmt(perOrder, 2)} ${ctx.quote}`
    );
  }
  if (buyReq === 0) {
    console.log(
      `ℹ regrid info: no BUY levels generated | free ${ctx.quote}=${fmt8(freeQuote)} | ` +
      `orderQuote=${fmt(perOrder, 2)} ${ctx.quote}`
    );
  }
}

async function pollLiveFills(state, ctx) {
  const sinceMs = Number(state.liveExecCursorMs || Date.now() - 2 * 60 * 1000);
  const rows = await getExecutions(CONFIG.CATEGORY, ctx.symbol, sinceMs);
  if (!Array.isArray(rows) || rows.length === 0) return [];

  let maxExecTime = sinceMs;
  const fills = [];

  for (const r of rows) {
    const execId = String(r.execId || "");
    if (!execId || state.liveSeenExecIds.has(execId)) continue;
    state.liveSeenExecIds.add(execId);

    const execTime = Number(r.execTime || 0);
    if (Number.isFinite(execTime) && execTime > maxExecTime) maxExecTime = execTime;

    fills.push({
      orderId: String(r.orderId || ""),
      orderLinkId: String(r.orderLinkId || ""),
      side: String(r.side || ""),
      fillPrice: Number(r.execPrice || r.price || 0),
      qty: Number(r.execQty || r.qty || 0),
      notionalQuote: Number(r.execValue || 0),
      fee: Math.abs(Number(r.execFee || 0)),
      feeCurrency: String(r.feeCurrency || r.feeCoin || ""),
      execTime,
      execId,
    });
  }

  state.liveExecCursorMs = Math.max(Number(state.liveExecCursorMs || 0), maxExecTime);

  // Avoid unbounded memory growth.
  if (state.liveSeenExecIds.size > 12000) {
    const tail = Array.from(state.liveSeenExecIds).slice(-6000);
    state.liveSeenExecIds = new Set(tail);
  }

  return fills;
}

function printSummary(state, ctx, price) {
  const buyCount = state.openOrders.filter((o) => o.side === "Buy").length;
  const sellCount = state.openOrders.filter((o) => o.side === "Sell").length;

  const feeGuard = computeFeeGuardSpacingPct(Number(state.fee?.effective || 0));

  const reserved = IS_PAPER
    ? { base: Number(state.reserved?.base || 0), quote: Number(state.reserved?.quote || 0) }
    : deriveReservedFromOpenOrders(state);

  const liveFunds = IS_LIVE ? deriveLiveFunds(state) : null;
  const freeBase = IS_PAPER ? Number(state.balances.base || 0) : liveFunds.free.base;
  const freeQuote = IS_PAPER ? Number(state.balances.quote || 0) : liveFunds.free.quote;
  const totalBase = IS_PAPER ? freeBase + Number(reserved.base || 0) : liveFunds.total.base;
  const totalQuote = IS_PAPER ? freeQuote + Number(reserved.quote || 0) : liveFunds.total.quote;

  const equityNow = totalQuote + totalBase * price;
  const startBudget = Number(state.startBalances.quote || 0) + Number(state.startBalances.base || 0) * Number(state.startPrice || price);
  const pnlPct = startBudget > 0 ? ((equityNow - startBudget) / startBudget) * 100 : 0;

  console.log(`open: total=${state.openOrders.length} | buy=${buyCount} | sell=${sellCount}`);
  console.log(`fills: buy=${state.stats.buyFills} | sell=${state.stats.sellFills}`);
  console.log(`price: ${fmt(price, 6)} ${ctx.quote} | start: ${fmt(Number(state.startPrice || 0), 6)} ${ctx.quote}`);
  console.log(`FREE:     ${ctx.base}=${fmt8(freeBase)} | ${ctx.quote}=${fmt8(freeQuote)}`);
  console.log(`RESERVED: ${ctx.base}=${fmt8(reserved.base)} | ${ctx.quote}=${fmt8(reserved.quote)}`);
  console.log(`TOTAL:    ${ctx.base}=${fmt8(totalBase)} | ${ctx.quote}=${fmt8(totalQuote)}`);
  console.log(`FEE:      maker=${fmt(Number(state.fee?.maker || 0) * 100, 4)}% | taker=${fmt(Number(state.fee?.taker || 0) * 100, 4)}% | effective=${fmt(Number(state.fee?.effective || 0) * 100, 4)}%`);
  console.log(`COMPOUND: sell->buy reinvest total=${fmt8(state.compoundingStats.fromSellReinvestQuoteTotal)} ${ctx.quote}`);
  console.log(`LOOPS:    total=${state.loopStats.loopsTotal} | profit=${fmt8(state.loopStats.profitQuoteTotal)} ${ctx.quote}`);
  console.log(`EQ:       now=${fmt(equityNow, 2)} ${ctx.quote} | pnl=${fmt(pnlPct, 3)}% | feeGuard=${fmt(feeGuard, 4)}%`);
}

async function tickOnce(state, ctx) {
  const close = await getLastClosed1mClose(ctx.symbol);
  state.prevClose = close;

  const fills = IS_PAPER ? paperCheckFills(state, "", close).fills : await pollLiveFills(state, ctx);

  if (!IS_PAPER) {
    await refreshOpenOrders(state, ctx);
    await syncBalances(state, ctx.base, ctx.quote);
  }

  for (const f of fills) {
    if (f.side === "Buy") state.stats.buyFills += 1;
    if (f.side === "Sell") state.stats.sellFills += 1;

    const feeCurrency = String(f.feeCurrency || "").toUpperCase();
    f.feeInQuote = feeCurrency === "QUOTE" || feeCurrency === String(ctx.quote || "").toUpperCase();
    f.feeInBase = feeCurrency === "BASE" || feeCurrency === String(ctx.base || "").toUpperCase();
    f.netBaseQty = Number(f.qty || 0) - (f.side === "Buy" && f.feeInBase ? Number(f.fee || 0) : 0);
    if (!Number.isFinite(f.netBaseQty) || f.netBaseQty < 0) f.netBaseQty = 0;

    const fillTs = Number(f.execTime || f.filledAt || Date.now());
    const fillIso = new Date(fillTs).toLocaleTimeString();
    const fillPrice = Number(f.fillPrice || f.price || 0);
    const fillQty = Number(f.qty || 0);
    const fillNotional = Number(f.notionalQuote || fillPrice * fillQty || 0);
    const fillFee = Number(f.fee || 0);

    console.log(
      `🟡 fill ${String(f.side || "")} | t=${fillIso} | price=${fmt(fillPrice, 6)} | qty=${fmt8(fillQty)} | ` +
      `quote=${fmt(fillNotional, 6)} ${ctx.quote} | fee=${fmt8(fillFee)} ${f.feeCurrency || ctx.quote} | ` +
      `netBase=${fmt8(Number(f.netBaseQty || 0))}`
    );

    state._recentFillsForUi.push({
      ts: Date.now(),
      side: String(f.side || ""),
      price: fillPrice,
      qty: fillQty,
      notional: fillNotional,
      kind: "GRID",
    });
    if (state._recentFillsForUi.length > 400) {
      state._recentFillsForUi = state._recentFillsForUi.slice(-200);
    }

    const loop = consumeCounterLoop(state, f);
    if (loop.wasCounter) {
      console.log(`💹 loop closed | side=${f.side} | profit=${fmt(loop.profitQuote, 6)} ${ctx.quote}`);
    }

    const placed = await placeCounterFromFill(state, ctx, f);
    if (placed) {
      const reqPrice = Number(placed.counterRequested?.price || placed.price || 0);
      const reqQty = Number(placed.counterRequested?.qty || placed.qty || 0);
      const reqNotional = Number(placed.counterRequested?.notionalQuote || reqPrice * reqQty || 0);
      const acceptedPrice = Number(placed.price || 0);
      const acceptedQty = Number(placed.qty || 0);
      const counterNotional = acceptedPrice * acceptedQty;
      const deltaQtyPct = reqQty > 0 ? ((acceptedQty - reqQty) / reqQty) * 100 : 0;
      const deltaNotionalPct = reqNotional > 0 ? ((counterNotional - reqNotional) / reqNotional) * 100 : 0;
      const netAfterFee = Math.max(0, fillNotional - fillFee);
      console.log(
        `↔ counter placed | from=${f.side} fill@${fmt(fillPrice, 6)} t=${fillIso} | ` +
        `fillNet=${fmt(netAfterFee, 6)} ${ctx.quote} | ` +
        `req=${String(placed.side || "")} @${fmt(reqPrice, 6)} qty=${fmt8(reqQty)} (~${fmt(reqNotional, 6)} ${ctx.quote}) | ` +
        `acc=${String(placed.side || "")} @${fmt(acceptedPrice, 6)} qty=${fmt8(acceptedQty)} (~${fmt(counterNotional, 6)} ${ctx.quote}) | ` +
        `dQty=${fmt(deltaQtyPct, 3)}% dQuote=${fmt(deltaNotionalPct, 3)}%`
      );
    }
  }

  return close;
}

function printLadder(state, ctx) {
  const buy = (state.openOrders || []).filter((o) => o.side === "Buy").sort((a, b) => Number(b.price) - Number(a.price));
  const sell = (state.openOrders || []).filter((o) => o.side === "Sell").sort((a, b) => Number(a.price) - Number(b.price));
  const nowPrice = Number(state.prevClose || state.startPrice || 0);
  const baseLadder = Math.max(
    Number(CONFIG.MICRO_SPACING_PCT || 0),
    computeFeeGuardSpacingPct(Number(state.fee?.effective || 0))
  );

  if (!buy.length && !sell.length) {
    console.log("orders: none");
    return;
  }

  console.log(`\nBase ladder: ${fmt(baseLadder, 2)}%`);

  if (sell.length) {
    console.log(color(`SELL(${sell.length}):`, { c: "red", b: true }));
    for (const o of sell.slice(0, 40)) {
      const p = Number(o.price || 0);
      const q = Number(o.qty || 0);
      const n = p * q;
      const dPct = nowPrice > 0 ? ((p - nowPrice) / nowPrice) * 100 : 0;
      console.log(`• ${sideWord("Sell")} @ ${fmt(p, 6)} qty=${fmt8(q)} | ~${fmt(n, 2)} ${color(ctx.quote, { c: "red", b: true })} (${fmt(dPct, 3)}%)`);
    }
  }

  if (Number.isFinite(nowPrice) && nowPrice > 0) {
    console.log("");
    console.log(color(`─── PRICE NOW: ${fmt(nowPrice, 6)} ${ctx.quote} ───`, { c: "cyan", b: true }));
    console.log("");
  }

  if (buy.length) {
    console.log(color(`BUY(${buy.length}):`, { c: "green", b: true }));
    for (const o of buy.slice(0, 40)) {
      const p = Number(o.price || 0);
      const q = Number(o.qty || 0);
      const n = p * q;
      const dPct = nowPrice > 0 ? ((nowPrice - p) / nowPrice) * 100 : 0;
      console.log(`• ${sideWord("Buy")} @ ${fmt(p, 6)} qty=${fmt8(q)} | ~${fmt(n, 2)} ${color(ctx.quote, { c: "green", b: true })} (${fmt(dPct, 3)}%)`);
    }
  }
}

function buildActions(state, ctx) {
  const actions = {
    async regrid() {
      const p = await getLastClosed1mClose(ctx.symbol);
      await doRegrid(state, ctx, p);
    },
    async clear() {
      await cancelAllUnified(state, ctx);
    },
    regridFull: async () => {
      const p = await getLastClosed1mClose(ctx.symbol);
      await doRegrid(state, ctx, p);
    },
    printOrders() {
      const p = Number(state.prevClose || state.startPrice || 0);
      printSummary(state, ctx, p);
      printLadder(state, ctx);
    },
    summary() {
      const p = Number(state.prevClose || state.startPrice || 0);
      printSummary(state, ctx, p);
    },
    getConfig() {
      return {
        ORDER_QUOTE_VALUE: Number(CONFIG.ORDER_QUOTE_VALUE || 0),
        MICRO_SPACING_PCT: Number(CONFIG.MICRO_SPACING_PCT || 0),
      };
    },
    updateGridSettings({ orderQuoteValue, microSpacingPct }) {
      const oqv = Number(orderQuoteValue);
      const msp = Number(microSpacingPct);
      if (Number.isFinite(oqv) && oqv > 0) CONFIG.ORDER_QUOTE_VALUE = oqv;
      if (Number.isFinite(msp) && msp > 0) CONFIG.MICRO_SPACING_PCT = msp;
    },
  };

  actions.orders = actions.printOrders;
  actions.exec = {
    cancelAllOrders: async () => cancelAllUnified(state, ctx),
    refreshOpenOrders: async () => {
      if (!IS_PAPER) await refreshOpenOrders(state, ctx);
    },
    placeOneExact: async (payload) => placeOneExact(state, ctx, payload),
    cancelOrderById: async (orderRef) => cancelOrderByRef(state, ctx, { orderId: String(orderRef || "") }, "CONSOLE_CANCEL_ONE"),
  };

  return actions;
}

export async function startBot() {
  if (!IS_LIVE && !IS_PAPER) {
    throw new Error(`Unsupported MODE=${MODE}. Use PAPER or LIVE.`);
  }

  let { base, quote, symbol, pair } = parseSymbol(CONFIG.MARKET);
  let ctx = { base, quote, symbol, pair };
  const state = defaultState();
  acquireInstanceLock();

  if (IS_LIVE) {
    ctx = await ensureLiveMarketContextStrict(ctx);
  }

  state.__runLog = {
    runId: `${ctx.symbol}_${MODE}_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`,
  };

  const statePath = statePathFor(ctx);
  ensureUiBridgeFiles();
  wrapConsoleForUiLogs();

  process.on("SIGINT", () => {
    persistState(state, statePath);
    releaseInstanceLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    persistState(state, statePath);
    releaseInstanceLock();
    process.exit(0);
  });

  console.log(`🚀 start | MODE=${MODE} | MARKET=${ctx.pair} | CATEGORY=${CONFIG.CATEGORY}`);

  restoreState(state, statePath);

  if (IS_PAPER) {
    try {
      const fr = await getFeeRate(CONFIG.CATEGORY, ctx.symbol);
      state.fee.maker = fr.maker ?? CONFIG.FEE_MAKER;
      state.fee.taker = fr.taker ?? CONFIG.FEE_TAKER;
    } catch {
      state.fee.maker = CONFIG.FEE_MAKER;
      state.fee.taker = CONFIG.FEE_TAKER;
    }
    state.fee.effective = CONFIG.PAPER_ASSUME_MAKER ? state.fee.maker : state.fee.taker;

    paperInitBalances(state, CONFIG.PAPER_START_BASE, CONFIG.PAPER_START_QUOTE);
  } else {
    const startup = await startupCheckLiveCredentials(ctx);
    const fr = startup.feeRate;
    state.fee.maker = fr.maker ?? CONFIG.FEE_MAKER;
    state.fee.taker = fr.taker ?? CONFIG.FEE_TAKER;
    state.fee.effective = state.fee.maker;

    applyWalletCoinsToState(state, ctx.base, ctx.quote, startup.coins);
    await refreshOpenOrders(state, ctx);
    state.liveExecCursorMs = Date.now() - 5_000;

    const chk = liveMinFundsOk(state);
    if (!chk.ok) {
      console.log(
        `⚠ LIVE minimum funds not met | have ${ctx.base}=${fmt8(chk.b)} ${ctx.quote}=${fmt(chk.q, 6)} | ` +
        `need ${ctx.base}>=${fmt8(chk.minB)} ${ctx.quote}>=${fmt(chk.minQ, 6)}`
      );
    }
  }

  const startClose = await getLastClosed1mClose(ctx.symbol);
  state.prevClose = startClose;
  state.startPrice = state.startPrice || startClose;
  if (!(Number(state.startBalances.base) > 0 || Number(state.startBalances.quote) > 0)) {
    state.startBalances = {
      base: Number(state.balances.base || 0),
      quote: Number(state.balances.quote || 0),
    };
  }

  if (!Array.isArray(state.openOrders) || state.openOrders.length === 0) {
    await doRegrid(state, ctx, startClose);
  } else {
    console.log(`ℹ existing open orders detected: ${state.openOrders.length}. Regrid skipped.`);
  }

  writeUiStateSnapshot(buildUiStateSnapshot(state, ctx, startClose));

  const actions = buildActions(state, ctx);
  const isHeadless = String(process.env.BOT_HEADLESS || "").trim() === "1" || !process.stdin.isTTY;
  if (!isHeadless) startConsole({ actions, state, ctx });

  let lastPersistAt = Date.now();
  let tickInFlight = false;
  setInterval(async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const uiCmd = readUiCommand();

      if (uiCmd && (uiCmd.cmd === "r" || uiCmd.cmd === "regrid")) {
        const p = await getLastClosed1mClose(ctx.symbol);
        await doRegrid(state, ctx, p);
        console.log("🔁 UI command executed: regrid");
      }

      if (uiCmd && (uiCmd.cmd === "c" || uiCmd.cmd === "clear" || uiCmd.cmd === "cancel_all")) {
        await cancelAllUnified(state, ctx);
        console.log("🧹 UI command executed: clear all");
      }

      if (uiCmd && (uiCmd.cmd === "g" || uiCmd.cmd === "grid")) {
        const oqvRaw = Number(uiCmd.orderQuoteValue);
        const mspRaw = Number(uiCmd.microSpacingPct);
        if (Number.isFinite(oqvRaw) && oqvRaw > 0) CONFIG.ORDER_QUOTE_VALUE = oqvRaw;
        if (Number.isFinite(mspRaw) && mspRaw > 0) CONFIG.MICRO_SPACING_PCT = mspRaw;
        console.log(
          `⚙ UI grid update: ORDER_QUOTE_VALUE=${fmt(Number(CONFIG.ORDER_QUOTE_VALUE || 0), 6)} ` +
          `MICRO_SPACING_PCT=${fmt(Number(CONFIG.MICRO_SPACING_PCT || 0), 6)}`
        );
      }

      if (uiCmd && uiCmd.cmd === "cancel_one") {
        const oid = String(uiCmd.orderId || "").trim();
        const olid = String(uiCmd.orderLinkId || "").trim();
        if (oid || olid) {
          const ok = await cancelOrderByRef(state, ctx, { orderId: oid, orderLinkId: olid }, "UI_CANCEL_ONE");
          if (!IS_PAPER) await refreshOpenOrders(state, ctx);
          console.log(`🗑 UI cancel_one: ${ok ? "ok" : "not_found"} id=${oid || "-"} link=${olid || "-"}`);
        }
      }

      if (uiCmd && uiCmd.cmd === "replace_price") {
        const oid = String(uiCmd.orderId || "").trim();
        const olid = String(uiCmd.orderLinkId || "").trim();
        const newPrice = Number(uiCmd.newPrice);
        if ((oid || olid) && Number.isFinite(newPrice) && newPrice > 0) {
          const old = (state.openOrders || []).find(
            (o) => (oid && String(o?.id || "") === oid) || (olid && String(o?.linkId || "") === olid)
          );
          if (old) {
            await cancelOrderByRef(
              state,
              ctx,
              { orderId: String(old.id || oid), orderLinkId: String(old.linkId || olid) },
              "UI_REPLACE_PRICE"
            );
            const placed = await placeOneExact(state, ctx, {
              side: old.side,
              price: newPrice,
              qty: Number(old.qty || 0),
              info: "UI_REPLACE_PRICE",
            });
            if (!IS_PAPER) await refreshOpenOrders(state, ctx);
            console.log(
              `✏ UI replace_price: ${placed ? "ok" : "failed"} ${old.side} ${fmt(Number(old.price || 0), 6)} -> ${fmt(newPrice, 6)}`
            );
          } else {
            console.log(`⚠ UI replace_price: order not found id=${oid || "-"} link=${olid || "-"}`);
          }
        }
      }

      if (uiCmd && uiCmd.cmd === "replace_quote") {
        const oid = String(uiCmd.orderId || "").trim();
        const olid = String(uiCmd.orderLinkId || "").trim();
        const newQuote = Number(uiCmd.newQuote);
        if ((oid || olid) && Number.isFinite(newQuote) && newQuote > 0) {
          const old = (state.openOrders || []).find(
            (o) => (oid && String(o?.id || "") === oid) || (olid && String(o?.linkId || "") === olid)
          );
          if (old && Number(old.price || 0) > 0) {
            const newQty = newQuote / Number(old.price);
            await cancelOrderByRef(
              state,
              ctx,
              { orderId: String(old.id || oid), orderLinkId: String(old.linkId || olid) },
              "UI_REPLACE_QUOTE"
            );
            const placed = await placeOneExact(state, ctx, {
              side: old.side,
              price: Number(old.price || 0),
              qty: newQty,
              info: "UI_REPLACE_QUOTE",
            });
            if (!IS_PAPER) await refreshOpenOrders(state, ctx);
            console.log(
              `✏ UI replace_quote: ${placed ? "ok" : "failed"} ${old.side} @${fmt(Number(old.price || 0), 6)} -> value ${fmt(newQuote, 2)}`
            );
          } else {
            console.log(`⚠ UI replace_quote: order not found id=${oid || "-"} link=${olid || "-"}`);
          }
        }
      }

      if (uiCmd && uiCmd.cmd === "place_order") {
        const sideRaw = String(uiCmd.side || "").toLowerCase();
        const side = sideRaw === "sell" ? "Sell" : sideRaw === "buy" ? "Buy" : "";
        const price = Number(uiCmd.price);
        const value = Number(uiCmd.value);
        if (side && Number.isFinite(price) && price > 0 && Number.isFinite(value) && value > 0) {
          if (IS_LIVE) {
            await syncBalances(state, ctx.base, ctx.quote);
            await refreshOpenOrders(state, ctx);
          }
          const qty = value / price;
          const required = side === "Sell" ? qty : value * (1 + Number(state.fee?.effective || 0));
          const available = side === "Sell"
            ? Number(state.available?.base || 0)
            : Number(state.available?.quote || 0);
          if (IS_LIVE && required > available + 1e-12) {
            console.log(
              `⚠ UI place_order rejected locally: ${side} requested=${fmt8(required)} ` +
              `${side === "Sell" ? ctx.base : ctx.quote} available=${fmt8(available)}`
            );
          } else {
            const placed = await placeOneExact(state, ctx, { side, price, qty, info: "UI_PLACE_ORDER" });
            if (!IS_PAPER) await refreshOpenOrders(state, ctx);
            console.log(
              `➕ UI place_order: ${placed ? "ok" : "failed"} ${side} @${fmt(price, 6)} value=${fmt(value, 2)} qty=${fmt8(qty)} ` +
              `availableBefore=${fmt8(available)}`
            );
          }
        }
      }

      if (uiCmd && uiCmd.cmd === "reload_config") {
        try {
          const count = await reloadConfig();
          console.log(`🔄 UI: config.js reloaded (${count} fields)`);
        } catch (e) {
          console.log(`⚠ UI reload_config error: ${e?.message || e}`);
        }
      }

      if (uiCmd && uiCmd.cmd === "clean_session") {
        state.stats = { buyFills: 0, sellFills: 0 };
        state._recentFillsForUi = [];
        state.startBalances = { base: Number(state.balances.base || 0), quote: Number(state.balances.quote || 0) };
      }

      const close = await tickOnce(state, ctx);
      writeUiStateSnapshot(buildUiStateSnapshot(state, ctx, close));
      const flushMs = Math.max(2000, Number(CONFIG.RUNTIME_STATE_FLUSH_MS || 15000));
      if (Date.now() - lastPersistAt >= flushMs) {
        persistState(state, statePath);
        lastPersistAt = Date.now();
      }
    } catch (e) {
      console.log(`⚠ loop error: ${e?.message || e}`);
    } finally {
      tickInFlight = false;
    }
  }, Number(CONFIG.POLL_MS || 3000));
}
