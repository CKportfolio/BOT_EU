// scripts/live.js (ESM)
// Bybit v5 REST wrapper with:
// ✅ server-time sync (fix retCode=10002)
// ✅ UTA balances (pickCoinBalance prefers availableToTrade/availableBalance)
// ✅ instrument specs cache + rounding (fix retCode=170134 / 170137)

import axios from "axios";
import crypto from "crypto";

/**
 * ENV:
 * - BYBIT_API_KEY
 * - BYBIT_API_SECRET
 * - BYBIT_TRADE_BASE_URL (optional) preferred for trading, e.g. https://api.bybit.eu
 * - BYBIT_BASE_URL (legacy fallback)
 * - BYBIT_RECV_WINDOW (optional) default: 20000
 * - BYBIT_TIME_SYNC_MS (optional) default: 30000
 */

const API_KEY = process.env.BYBIT_API_KEY || process.env.BYBIT_KEY || "";
const API_SECRET = process.env.BYBIT_API_SECRET || process.env.BYBIT_SECRET || "";
const BASE_URL = (
  process.env.BYBIT_TRADE_BASE_URL ||
  process.env.BYBIT_BASE_URL ||
  "https://api.bybit.eu"
).replace(/\/+$/, "");

const DEFAULT_RECV_WINDOW = Number(process.env.BYBIT_RECV_WINDOW ?? 20000);
const TIME_SYNC_MS = Number(process.env.BYBIT_TIME_SYNC_MS ?? 30000);

// instrument cache
const INSTR_TTL_MS = Number(process.env.BYBIT_INSTR_TTL_MS ?? 6 * 60 * 60 * 1000);
const _instrCache = new Map(); // key: `${category}:${symbol}` -> specs

function _keyInstr(category, symbol) {
  return `${String(category || "").toLowerCase()}:${String(symbol || "").toUpperCase()}`;
}

/* =========================
   Time sync (server offset)
========================= */
// offset = serverTime - Date.now()
let _timeOffsetMs = 0;
let _timeLastSyncAt = 0;
let _timeSyncInFlight = null;

function _nowWithOffset() {
  return Date.now() + (_timeOffsetMs || 0);
}

async function _fetchServerTimeMs() {
  const url = `${BASE_URL}/v5/market/time`;
  const res = await axios.get(url, { timeout: 10_000 });

  const rc = res?.data?.retCode;
  if (rc !== 0) throw new Error(`Bybit time error: retCode=${rc} msg=${res?.data?.retMsg}`);

  const r = res.data?.result || {};

  if (r.timeNano != null) {
    const n = Number(r.timeNano);
    if (Number.isFinite(n) && n > 0) return Math.floor(n / 1e6);
    try {
      const bn = BigInt(r.timeNano);
      return Number(bn / 1000000n);
    } catch {}
  }

  const sec = Number(r.timeSecond);
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;

  const t = Number(res?.data?.time);
  if (Number.isFinite(t) && t > 0) return t;

  throw new Error("Bybit time parse error: missing timeSecond/timeNano");
}

async function syncServerTime({ force = false } = {}) {
  const now = Date.now();
  if (!force && _timeLastSyncAt && now - _timeLastSyncAt < TIME_SYNC_MS) {
    return { offsetMs: _timeOffsetMs, syncedAt: _timeLastSyncAt, skipped: true };
  }

  if (_timeSyncInFlight) return _timeSyncInFlight;

  _timeSyncInFlight = (async () => {
    try {
      const t0 = Date.now();
      const serverMs = await _fetchServerTimeMs();
      const t1 = Date.now();
      const rtt = Math.max(0, t1 - t0);
      const midLocal = t0 + rtt / 2;

      _timeOffsetMs = Math.round(serverMs - midLocal);
      _timeLastSyncAt = Date.now();

      return { offsetMs: _timeOffsetMs, syncedAt: _timeLastSyncAt, rtt };
    } finally {
      _timeSyncInFlight = null;
    }
  })();

  return _timeSyncInFlight;
}

/* =========================
   Signing helpers
========================= */
function sign(payload) {
  return crypto.createHmac("sha256", API_SECRET).update(payload).digest("hex");
}

function toQueryString(params) {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null);
  keys.sort();
  return keys.map((k) => `${k}=${encodeURIComponent(String(params[k]))}`).join("&");
}

/**
 * Bybit v5 private signing:
 * signature = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + (queryString | bodyString))
 */
function makePrivateHeaders({ timestamp, recvWindow, signature }) {
  return {
    "X-BAPI-API-KEY": API_KEY,
    "X-BAPI-TIMESTAMP": String(timestamp),
    "X-BAPI-RECV-WINDOW": String(recvWindow),
    "X-BAPI-SIGN": signature,
    "Content-Type": "application/json",
  };
}

/* =========================
   Core HTTP
========================= */
async function bybitPublic(method, endpoint, { params, data } = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await axios({ method, url, timeout: 15_000, params, data });

  const rc = res?.data?.retCode;
  if (rc !== 0) throw new Error(`Bybit error: retCode=${rc} msg=${res?.data?.retMsg}`);

  return res.data;
}

async function bybitPrivate(method, endpoint, { params, data, recvWindow } = {}, _retry = 0) {
  if (!API_KEY || !API_SECRET) throw new Error("Missing BYBIT_API_KEY / BYBIT_API_SECRET in env");

  if (!_timeLastSyncAt) {
    try {
      await syncServerTime({ force: true });
    } catch {}
  } else {
    syncServerTime({ force: false }).catch(() => {});
  }

  const ts = _nowWithOffset();
  const rw = Number.isFinite(Number(recvWindow)) ? Number(recvWindow) : DEFAULT_RECV_WINDOW;

  const queryString = params ? toQueryString(params) : "";
  const bodyString = data ? JSON.stringify(data) : "";

  const payload = String(ts) + API_KEY + String(rw) + (method === "GET" ? queryString : bodyString);
  const signature = sign(payload);

  const url = `${BASE_URL}${endpoint}${method === "GET" && queryString ? `?${queryString}` : ""}`;

  const res = await axios({
    method,
    url,
    timeout: 20_000,
    headers: makePrivateHeaders({ timestamp: ts, recvWindow: rw, signature }),
    data: method === "GET" ? undefined : data,
  });

  const rc = res?.data?.retCode;

  if (rc !== 0) {
    // time drift
    if (rc === 10002 && _retry < 1) {
      try {
        await syncServerTime({ force: true });
      } catch {}
      return await bybitPrivate(method, endpoint, { params, data, recvWindow: Math.max(rw, 20000) }, _retry + 1);
    }
    throw new Error(`Bybit error: retCode=${rc} msg=${res?.data?.retMsg}`);
  }

  return res.data;
}

/* =========================
   Instrument specs + rounding
========================= */
function decimalsFromStep(step) {
  const s = String(step);
  const i = s.indexOf(".");
  if (i === -1) return 0;
  return Math.max(0, s.length - i - 1);
}

function roundToStep(x, step, mode = "floor") {
  const v = Number(x);
  const st = Number(step);
  if (!Number.isFinite(v) || !Number.isFinite(st) || st <= 0) return v;

  const q = v / st;
  let k = q;

  if (mode === "ceil") k = Math.ceil(q);
  else if (mode === "round") k = Math.round(q);
  else k = Math.floor(q);

  const out = k * st;

  // avoid float junk: cut to step decimals
  const d = decimalsFromStep(st);
  const fixed = Number(out.toFixed(d));
  return fixed;
}

// wybiera bardziej restrykcyjny "krok" (mniejszy step -> więcej cyfr),
// ale Bybit czasem wymaga *mniejszej* liczby cyfr (większy step).
// Dlatego bierzemy "większy step" jako bardziej restrykcyjny dla DECIMALS.
function moreRestrictiveStep(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || x <= 0) return Number.isFinite(y) && y > 0 ? y : null;
  if (!Number.isFinite(y) || y <= 0) return x;
  // większy step = mniej miejsc po przecinku => bardziej restrykcyjny na "too many decimals"
  return Math.max(x, y);
}

function formatDecimalByStep(value, step) {
  const v = Number(value);
  const st = Number(step);
  if (!Number.isFinite(v)) return String(value);
  if (!Number.isFinite(st) || st <= 0) return String(v);

  const d = decimalsFromStep(st);
  const s = v.toFixed(d);

  // usuń końcowe zera i kropkę (Bybitowi to nie przeszkadza, a pomaga unikać “dziwnych” formatów)
  return s.replace(/\.?0+$/, "");
}

async function getInstrumentSpecs(category, symbol) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();
  const key = _keyInstr(cat, sym);

  const cached = _instrCache.get(key);
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < INSTR_TTL_MS) {
    return cached;
  }

  const r = await bybitPublic("GET", "/v5/market/instruments-info", {
    params: { category: cat, symbol: sym },
  });

  const row = (r?.result?.list && r.result.list[0]) ? r.result.list[0] : null;
  if (!row) throw new Error(`No instrument info for ${cat}/${sym}`);

  const p = row?.priceFilter || {};
  const l = row?.lotSizeFilter || {};

  const tickSize = Number(p.tickSize);

  // spot: qtyStep + basePrecision potrafią się różnić; Bybit bywa bardziej restrykcyjny na decimals
  const qtyStep = Number(l.qtyStep);
  const basePrecision = Number(l.basePrecision);
  const quotePrecision = Number(l.quotePrecision);

  const minOrderQty = Number(l.minOrderQty);
  const minOrderAmt = Number(l.minOrderAmt);

  // ✅ klucz: efektywny krok qty (bardziej restrykcyjny na “too many decimals”)
  const qtyStepEffective = moreRestrictiveStep(qtyStep, basePrecision);

  const out = {
    fetchedAt: Date.now(),
    tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : null,
    qtyStep: Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep : null,
    basePrecision: Number.isFinite(basePrecision) && basePrecision > 0 ? basePrecision : null,
    quotePrecision: Number.isFinite(quotePrecision) && quotePrecision > 0 ? quotePrecision : null,
    qtyStepEffective: Number.isFinite(qtyStepEffective) && qtyStepEffective > 0 ? qtyStepEffective : null,
    minOrderQty: Number.isFinite(minOrderQty) && minOrderQty > 0 ? minOrderQty : null,
    minOrderAmt: Number.isFinite(minOrderAmt) && minOrderAmt > 0 ? minOrderAmt : null,
    raw: { priceFilter: p, lotSizeFilter: l },
  };

  _instrCache.set(key, out);
  return out;
}

function applySpecsToOrder({ price, qty, specs, side, qtyRoundingMode = "floor" }) {
  let p = Number(price);
  let q = Number(qty);

  // price -> tickSize
  if (specs?.tickSize) {
    const mode = side === "Sell" ? "ceil" : "floor";
    p = roundToStep(p, specs.tickSize, mode);
  }

  // qty -> qtyStepEffective (bardziej restrykcyjny na decimals)
  const qStep = specs?.qtyStepEffective || specs?.qtyStep || specs?.basePrecision || null;
  if (qStep) {
    const mode = (qtyRoundingMode === "ceil" || qtyRoundingMode === "round") ? qtyRoundingMode : "floor";
    q = roundToStep(q, qStep, mode);
  }

  // minima
  if (specs?.minOrderQty && Number.isFinite(q) && q > 0) {
    if (q < specs.minOrderQty) q = 0;
  }

  const notional = (Number.isFinite(p) && Number.isFinite(q)) ? p * q : NaN;

  if (specs?.minOrderAmt && Number.isFinite(notional) && notional > 0) {
    if (notional < specs.minOrderAmt) q = 0;
  }

  return { price: p, qty: q, qtyStepUsed: qStep };
}

/* =========================
   Exports used by bot.js
========================= */

export async function getFeeRate(category, symbol) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();

  const r = await bybitPrivate("GET", "/v5/account/fee-rate", {
    params: { category: cat, symbol: sym },
  });

  const row = r?.result?.list?.[0] || {};
  const maker = Number(row.makerFeeRate);
  const taker = Number(row.takerFeeRate);

  return {
    maker: Number.isFinite(maker) ? maker : null,
    taker: Number.isFinite(taker) ? taker : null,
  };
}

/**
 * Wallet balances (UNIFIED)
 * GET /v5/account/wallet-balance?accountType=UNIFIED
 */
export async function getWalletBalances() {
  const r = await bybitPrivate("GET", "/v5/account/wallet-balance", {
    params: { accountType: "UNIFIED" },
  });

  const list = Array.isArray(r?.result?.list) ? r.result.list : [];
  return list.flatMap((account) => Array.isArray(account?.coin) ? account.coin : []);
}

/**
 * ✅ UTA: prefer availableToTrade/availableBalance; take MAX across relevant fields
 */
export function pickCoinBalance(coins, coin) {
  const want = String(coin || "").toUpperCase();
  const arr = Array.isArray(coins) ? coins : [];

  const row = arr.find((c) => String(c?.coin || "").toUpperCase() === want);
  if (!row) return 0;

  // walletBalance is the total amount of this coin. available* fields are
  // tradable/withdrawable subsets and must not inflate TOTAL.
  const wallet = Number(row.walletBalance);
  if (Number.isFinite(wallet) && wallet >= 0) return wallet;

  for (const field of ["equity", "availableBalance", "availableToTrade", "availableToWithdraw"]) {
    const value = Number(row[field]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

export function pickCoinAvailable(coins, coin) {
  const want = String(coin || "").toUpperCase();
  const arr = Array.isArray(coins) ? coins : [];

  const row = arr.find((c) => String(c?.coin || "").toUpperCase() === want);
  if (!row) return 0;

  // availableToTrade is the only field that directly answers whether a new
  // order can use the balance. Do not take MAX across withdrawal/equity fields.
  for (const field of ["availableToTrade", "availableBalance", "availableToWithdraw"]) {
    const raw = row[field];
    if (raw === "" || raw === null || raw === undefined) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }

  const fallback = Number(row.walletBalance);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

export async function placeLimitOrder({ category, symbol, side, qty, price, orderLinkId, qtyRoundingMode = "floor" }) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();

  const specs = await getInstrumentSpecs(cat, sym);

  const adj = applySpecsToOrder({ price, qty, specs, side, qtyRoundingMode });
  const pAdj = Number(adj.price);
  const qAdj = Number(adj.qty);

  if (!Number.isFinite(pAdj) || pAdj <= 0) throw new Error("placeLimitOrder: invalid price after rounding");
  if (!Number.isFinite(qAdj) || qAdj <= 0) {
    return { skipped: true, reason: "QTY_TOO_SMALL_AFTER_ROUNDING", price: pAdj, qty: qAdj, specs };
  }

  const priceStr = specs?.tickSize ? formatDecimalByStep(pAdj, specs.tickSize) : String(pAdj);

  const qtyStepForFormat =
    specs?.qtyStepEffective || specs?.qtyStep || specs?.basePrecision || null;

  const qtyStr = qtyStepForFormat ? formatDecimalByStep(qAdj, qtyStepForFormat) : String(qAdj);

  const body = {
    category: cat,
    symbol: sym,
    side: side,
    orderType: "Limit",
    qty: qtyStr,
    price: priceStr,
    timeInForce: "GTC",
  };

  if (orderLinkId) body.orderLinkId = String(orderLinkId);

  const r = await bybitPrivate("POST", "/v5/order/create", { data: body });
  return r?.result || {};
}

// expose rounding helper for grid filtering / diagnostics
export { applySpecsToOrder };

/* =========================
  Ticker price + price band helper
========================= */
export async function getTickerPrice(category, symbol) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();
  
  const r = await bybitPublic("GET", "/v5/market/tickers", {
    params: { category: cat, symbol: sym },
  });
  
  const row = r?.result?.list?.[0];
  if (!row) return null;
  
  return {
    lastPrice: Number(row.lastPrice || 0),
    bid1Price: Number(row.bid1Price || 0),
    ask1Price: Number(row.ask1Price || 0),
    highPrice24h: Number(row.highPrice24h || 0),
    lowPrice24h: Number(row.lowPrice24h || 0),
  };
}

/**
 * Clamp order price to Bybit's acceptable range.
 * Bybit spot typically enforces:
 *  - Sell price >= lastPrice * (1 - priceBandPct)
 *  - Buy price <= lastPrice * (1 + priceBandPct)
 * The exact band varies by symbol; we use a conservative default.
 */
export function clampPriceToBand({ price, side, lastPrice, tickSize, bandPct = 0.05 }) {
  let p = Number(price);
  const lp = Number(lastPrice);
  const band = Number(bandPct);
  
  if (!Number.isFinite(p) || !Number.isFinite(lp) || lp <= 0) return { price: p, clamped: false };
  
  let clamped = false;
  let reason = "";
  
  if (side === "Sell") {
    const minSellPrice = lp * (1 - band);
    if (p < minSellPrice) {
      p = minSellPrice;
      clamped = true;
      reason = `sell price clamped up from below band minimum (${minSellPrice.toFixed(6)})`;
    }
  } else if (side === "Buy") {
    const maxBuyPrice = lp * (1 + band);
    if (p > maxBuyPrice) {
      p = maxBuyPrice;
      clamped = true;
      reason = `buy price clamped down from above band maximum (${maxBuyPrice.toFixed(6)})`;
    }
  }
  
  // Round to tick after clamping
  if (clamped && Number.isFinite(tickSize) && tickSize > 0) {
    const mode = side === "Sell" ? "ceil" : "floor";
    p = roundToStep(p, tickSize, mode);
  }
  
  return { price: p, clamped, reason };
}

export async function getOpenOrders(category, symbol) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();

  // Bybit realtime endpoint paginates; default limit is small (≈20) and we
  // historically saw only a subset of open orders.  Request a larger limit and
  // follow cursors until exhaustion so callers always receive the full set.
  const params = { category: cat, symbol: sym, openOnly: 0, limit: 100 };

  let all = [];
  let cursor = null;

  do {
    if (cursor) params.cursor = cursor;
    const r = await bybitPrivate("GET", "/v5/order/realtime", { params });
    const list = r?.result?.list;
    if (Array.isArray(list) && list.length) all.push(...list);
    // nextPageCursor is returned when more pages exist
    cursor = r?.result?.nextPageCursor || null;
    // safety guard to avoid infinite loops
    if (all.length > 1000) break;
  } while (cursor);

  return all;
}

export async function cancelOneOrder(category, symbol, orderId, orderLinkId = null) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();

  const oid = String(orderId || "").trim();
  const olid = String(orderLinkId || "").trim();
  if (!oid && !olid) throw new Error("cancelOneOrder: missing orderId/orderLinkId");

  const body = { category: cat, symbol: sym };
  if (oid) body.orderId = oid;
  if (olid) body.orderLinkId = olid;
  const r = await bybitPrivate("POST", "/v5/order/cancel", { data: body });
  return r?.result || {};
}

export async function cancelAllOrders(category, symbol) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();

  const body = { category: cat, symbol: sym };
  const r = await bybitPrivate("POST", "/v5/order/cancel-all", { data: body });
  return r?.result || {};
}

export async function getExecutions(category, symbol, sinceMs) {
  const cat = String(category || "spot").toLowerCase();
  const sym = String(symbol || "").toUpperCase();

  const params = { category: cat, symbol: sym, limit: 50 };

  const s = Number(sinceMs);
  if (Number.isFinite(s) && s > 0) params.startTime = Math.max(0, Math.floor(s) - 2000);

  const r = await bybitPrivate("GET", "/v5/execution/list", { params });

  const list = r?.result?.list;
  return Array.isArray(list) ? list : [];
}

/* optional debug */
export async function __debugSyncTimeNow() {
  return await syncServerTime({ force: true });
}
export function __debugNowOffsetMs() {
  return _timeOffsetMs;
}
export async function __debugGetSpecs(category, symbol) {
  return await getInstrumentSpecs(category, symbol);
}