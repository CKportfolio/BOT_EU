#!/usr/bin/env node
/**
 * scripts/smoke_bybit_eu.mjs
 * ─────────────────────────
 * Smoke-test dla migracji Bybit Global → Bybit.eu
 *
 * Co sprawdza:
 *   1. Endpoint /v5/market/time   → czas serwera, offset do localhost
 *   2. Endpoint /v5/market/instruments-info → dostępność symbolu (SPOT)
 *   3. Endpoint /v5/market/orderbook        → publiczny order book
 *   4. Endpoint /v5/account/wallet-balance  → auth + saldo UNIFIED (wymaga kluczy)
 *   5. Endpoint /v5/account/fee-rate        → rzeczywiste fee z bybit.eu
 *
 * ❌ NIE składa żadnych zleceń.
 *
 * Uruchomienie:
 *   npm run bybit:smoke
 *   -- lub --
 *   BOT_MARKET=BTCUSDT BOT_CATEGORY=spot node scripts/smoke_bybit_eu.mjs
 *
 * Zmienne env (z .env lub podane ręcznie):
 *   BYBIT_TRADE_BASE_URL   (domyślnie https://api.bybit.eu)
 *   BYBIT_BASE_URL         (legacy, fallback)
 *   BYBIT_API_KEY / BYBIT_KEY
 *   BYBIT_API_SECRET / BYBIT_SECRET
 *   BOT_MARKET             (domyślnie BTCUSDC — bybit.eu nie ma BTCUSDT)
 *   BOT_CATEGORY           (domyślnie spot)
 */

import "dotenv/config";
import axios from "axios";
import crypto from "crypto";

// ─────────────────────────────────────────────
// Config from env
// ─────────────────────────────────────────────
const TRADE_BASE = (
  process.env.BYBIT_TRADE_BASE_URL ||
  process.env.BYBIT_BASE_URL ||
  "https://api.bybit.eu"
).replace(/\/+$/, "");

const MARKET_DATA_BASE = "https://api.bybit.com";

const API_KEY    = process.env.BYBIT_API_KEY    || process.env.BYBIT_KEY    || "";
const API_SECRET = process.env.BYBIT_API_SECRET || process.env.BYBIT_SECRET || "";
const SYMBOL     = (process.env.BOT_MARKET   || "BTCUSDC").toUpperCase();
const CATEGORY   = (process.env.BOT_CATEGORY || "spot").toLowerCase();
const RECV_WIN   = Number(process.env.BYBIT_RECV_WINDOW ?? 20000);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const OK   = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[36mℹ\x1b[0m";

let _pass = 0;
let _fail = 0;

function pass(label, detail = "") {
  _pass++;
  console.log(`  ${OK}  ${label}${detail ? `  — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  _fail++;
  console.error(`  ${FAIL}  ${label}${detail ? `  — ${detail}` : ""}`);
}

function sign(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function toQS(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join("&");
}

let _timeOffsetMs = 0;
let _timeSynced = false;

async function syncPrivateTimeOffset() {
  const r = await publicGet(TRADE_BASE, "/v5/market/time");
  if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
  const sec = Number(r?.result?.timeSecond || 0);
  if (!(sec > 0)) throw new Error("invalid server time");
  const serverMs = sec * 1000;
  _timeOffsetMs = serverMs - Date.now();
  _timeSynced = true;
}

async function privateGet(url, params = {}) {
  if (!_timeSynced) {
    try {
      await syncPrivateTimeOffset();
    } catch {}
  }

  const ts = Date.now() + _timeOffsetMs;
  const qs = toQS(params);
  const sig = sign(API_SECRET, `${ts}${API_KEY}${RECV_WIN}${qs}`);
  const endpoint = `${url}${qs ? "?" + qs : ""}`;
  const req = async () => axios.get(endpoint, {
    timeout: 15_000,
    headers: {
      "X-BAPI-API-KEY":      API_KEY,
      "X-BAPI-TIMESTAMP":    String(ts),
      "X-BAPI-RECV-WINDOW":  String(RECV_WIN),
      "X-BAPI-SIGN":         sig,
    },
  });

  try {
    const { data } = await req();
    return data;
  } catch (e) {
    const code = Number(e?.response?.data?.retCode ?? NaN);
    if (code === 10002) {
      await syncPrivateTimeOffset();
      const ts2 = Date.now() + _timeOffsetMs;
      const sig2 = sign(API_SECRET, `${ts2}${API_KEY}${RECV_WIN}${qs}`);
      const { data } = await axios.get(endpoint, {
        timeout: 15_000,
        headers: {
          "X-BAPI-API-KEY":      API_KEY,
          "X-BAPI-TIMESTAMP":    String(ts2),
          "X-BAPI-RECV-WINDOW":  String(RECV_WIN),
          "X-BAPI-SIGN":         sig2,
        },
      });
      return data;
    }
    throw e;
  }
}

async function publicGet(base, path, params = {}) {
  const { data } = await axios.get(`${base}${path}`, { params, timeout: 15_000 });
  return data;
}

// ─────────────────────────────────────────────
// Smoke checks
// ─────────────────────────────────────────────
async function checkServerTime() {
  console.log(`\n${INFO}  [1/5] Server time (trading endpoint)`);
  try {
    const r = await publicGet(TRADE_BASE, "/v5/market/time");
    if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
    const sec = Number(r?.result?.timeSecond);
    const offsetMs = Date.now() - sec * 1000;
    pass("server time OK", `server=${sec} offset≈${Math.abs(Math.round(offsetMs))}ms`);
  } catch (e) {
    fail("server time FAILED", e?.message || String(e));
  }
}

async function checkInstruments() {
  console.log(`\n${INFO}  [2/5] Instruments-info (${SYMBOL} / ${CATEGORY})`);
  try {
    const r = await publicGet(TRADE_BASE, "/v5/market/instruments-info", {
      category: CATEGORY,
      symbol: SYMBOL,
    });
    if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
    const row = r?.result?.list?.[0];
    if (!row) throw new Error("No instrument returned for symbol");
    const status = row?.status || row?.quoteCoin;
    pass(`${SYMBOL} available`, `status=${status} quoteCoin=${row.quoteCoin} baseCoin=${row.baseCoin}`);

    // Log fee filter if present
    const priceFilter = row?.priceFilter || {};
    const lotFilter   = row?.lotSizeFilter || {};
    console.log(
      `       tickSize=${priceFilter.tickSize ?? "?"} ` +
      `minQty=${lotFilter.minOrderQty ?? "?"} ` +
      `minAmt=${lotFilter.minOrderAmt ?? "?"}`
    );
  } catch (e) {
    fail(`instruments FAILED`, e?.message || String(e));
  }
}

async function checkOrderbook() {
  console.log(`\n${INFO}  [3/5] Orderbook (public)`);
  try {
    const r = await publicGet(TRADE_BASE, "/v5/market/orderbook", {
      category: CATEGORY,
      symbol: SYMBOL,
      limit: 5,
    });
    if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
    const bids = r?.result?.b;
    const asks = r?.result?.a;
    if (!Array.isArray(bids) || !bids.length) throw new Error("No bids returned");
    if (!Array.isArray(asks) || !asks.length) throw new Error("No asks returned");
    const topBid  = Number(bids[0][0]);
    const topAsk  = Number(asks[0][0]);
    const spread  = topAsk - topBid;
    const spreadP = topBid > 0 ? ((spread / topBid) * 100).toFixed(4) : "?";
    pass("orderbook OK", `bid=${topBid} ask=${topAsk} spread=${spread.toFixed(2)} (${spreadP}%)`);
  } catch (e) {
    fail("orderbook FAILED", e?.message || String(e));
  }
}

async function checkWalletBalance() {
  console.log(`\n${INFO}  [4/5] Wallet balance (auth required)`);
  if (!API_KEY || !API_SECRET) {
    console.log(`       \x1b[33m⚠ BYBIT_API_KEY / BYBIT_API_SECRET not set — skipping auth check\x1b[0m`);
    return;
  }
  try {
    const r = await privateGet(`${TRADE_BASE}/v5/account/wallet-balance`, {
      accountType: "UNIFIED",
    });
    if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
    const coins = r?.result?.list?.[0]?.coin || [];
    const usdt  = coins.find(c => c.coin === "USDT");
    const btc   = coins.find(c => c.coin === "BTC");
    pass("wallet balance OK (auth valid)", `USDT=${usdt?.walletBalance ?? "n/a"} BTC=${btc?.walletBalance ?? "n/a"}`);
  } catch (e) {
    fail("wallet balance / auth FAILED", e?.message || String(e));
  }
}

async function checkFeeRate() {
  console.log(`\n${INFO}  [5/5] Fee rate (from bybit.eu)`);
  if (!API_KEY || !API_SECRET) {
    console.log(`       \x1b[33m⚠ BYBIT_API_KEY / BYBIT_API_SECRET not set — skipping fee check\x1b[0m`);
    return;
  }
  try {
    const r = await privateGet(`${TRADE_BASE}/v5/account/fee-rate`, {
      category: CATEGORY,
      symbol: SYMBOL,
    });
    if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
    const row = r?.result?.list?.[0] || {};
    const maker = Number(row.makerFeeRate);
    const taker = Number(row.takerFeeRate);
    pass(
      "fee rate OK",
      `maker=${Number.isFinite(maker) ? (maker * 100).toFixed(4) + "%" : "n/a"} ` +
      `taker=${Number.isFinite(taker) ? (taker * 100).toFixed(4) + "%" : "n/a"}`
    );
    if (Number.isFinite(maker) && maker !== 0.001) {
      console.log(`       \x1b[33m⚠ EU maker fee (${(maker*100).toFixed(4)}%) differs from config FEE_MAKER (0.1%) — LIVE mode uses exchange value automatically\x1b[0m`);
    }
    if (Number.isFinite(taker) && taker !== 0.001) {
      console.log(`       \x1b[33m⚠ EU taker fee (${(taker*100).toFixed(4)}%) differs from config FEE_TAKER (0.1%) — LIVE mode uses exchange value automatically\x1b[0m`);
    }
  } catch (e) {
    fail("fee rate FAILED", e?.message || String(e));
  }
}

async function checkMarketDataBase() {
  console.log(`\n${INFO}  [bonus] Market-data endpoint (should remain api.bybit.com)`);
  try {
    const r = await publicGet(MARKET_DATA_BASE, "/v5/market/time");
    if (r?.retCode !== 0) throw new Error(`retCode=${r?.retCode} ${r?.retMsg}`);
    pass("api.bybit.com market-data reachable (indicators/divergence/momentum)");
  } catch (e) {
    fail("api.bybit.com market-data FAILED", e?.message || String(e));
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Bybit.eu Smoke Test — BOT 8.7");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  trading endpoint : \x1b[1m${TRADE_BASE}\x1b[0m`);
  console.log(`  market-data base : \x1b[1m${MARKET_DATA_BASE}\x1b[0m  (indicators only)`);
  console.log(`  symbol           : ${SYMBOL}  category=${CATEGORY}`);
  console.log(`  auth             : key=${API_KEY ? API_KEY.slice(0, 6) + "…" : "NOT SET"}`);
  console.log("───────────────────────────────────────────────────────");

  await checkServerTime();
  await checkInstruments();
  await checkOrderbook();
  await checkWalletBalance();
  await checkFeeRate();
  await checkMarketDataBase();

  console.log("\n═══════════════════════════════════════════════════════");
  if (_fail === 0) {
    console.log(`  \x1b[32m\x1b[1mALL ${_pass} checks PASSED\x1b[0m`);
  } else {
    console.log(`  \x1b[32m${_pass} passed\x1b[0m  \x1b[31m${_fail} FAILED\x1b[0m`);
  }
  console.log("═══════════════════════════════════════════════════════\n");

  if (_fail > 0) process.exit(1);
}

main().catch(e => {
  console.error("\x1b[31m[smoke] fatal error:\x1b[0m", e?.message || e);
  process.exit(1);
});
