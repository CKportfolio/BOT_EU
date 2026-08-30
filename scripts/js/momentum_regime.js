import axios from "axios";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BYBIT_BASE = (process.env.BYBIT_TRADE_BASE_URL || process.env.BYBIT_BASE_URL || "https://api.bybit.eu").replace(/\/+$/, "");

const SAMPLE_KEEP_MS = 35_000;
const SCORE_WINDOW_MS = 8_000;
const MOMENTUM_HALF_LIFE_MS = 8_000;  // TESTER-LAG gen175: was 4_000
const HISTORY_KEEP_MS = 14 * 24 * 60 * 60 * 1000; // 2 tygodnie

const MOMENTUM_WEIGHTS = {
  avg: 0.45,
  ema: 0.35,
  consistency: 0.2,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.resolve(__dirname, "../logs");
const HISTORY_JSONL_PATH = path.resolve(LOGS_DIR, "market_history.jsonl");
const HISTORY_CSV_5M_PATH = path.resolve(LOGS_DIR, "market_history_5m.csv");
const CSV_SAMPLE_MS = 5 * 60 * 1000;
const CSV_HEADERS = [
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
  "impulseDepthScore",
  "volRatio",
  "obImbalance",
  "ob3Imbalance",
  "obSpread",
  "obBidConc",
  "obAskConc",
  "obBidWallPct",
  "obAskWallPct",
  "obMicroAdj",
];

const state = {
  running: false,
  timer: null,
  pollMs: 10_000,
  symbol: "BTCUSDT",
  category: "linear",
  interval1mLimit: 240,
  interval15mLimit: 240,
  silent: true,
  debug: false,

  micro: {
    bySec: new Map(),
    lastTradeTsMs: 0,
    lookbackSec: 240,
    slopeWindowSec: 25,  // TESTER-LAG gen175: was 45
  },

  momentumSmoothing: {
    samples: [],
    ema: null,
    lastEmaTsMs: null,
  },

  history: [],
  tickCount: 0,
  lastCsvBucket: null,

  last: null,
  depthCfg: {},
};

function safeNum(x, d = 0) {
  if (x === null || x === undefined) return d;
  if (typeof x === "string" && x.trim() === "") return d;
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
  let sum = 0;
  for (const x of arr) {
    sum += (x - m) * (x - m);
  }
  return Math.sqrt(sum / (arr.length - 1));
}

function logReturn(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  return Math.log(b / a);
}

function zToUnit(z, k = 3) {
  return Math.tanh(safeNum(z, 0) / k);
}

function nowMs() {
  return Date.now();
}

function sign(value) {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function norm(x, scale) {
  return clamp(safeNum(x, 0) / scale, -1, 1);
}

function normAbs(x, scale) {
  return clamp(Math.abs(safeNum(x, 0)) / scale, 0, 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  if (state.silent) return;
  console.log(...args);
}

function dbg(...args) {
  if (state.silent || !state.debug) return;
  console.log("[momentum_regime]", ...args);
}

function slopePerSecond(points) {
  const n = points.length;
  if (n < 2) return 0;

  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;

  for (const p of points) {
    sumT += p.tSec;
    sumY += p.y;
    sumTT += p.tSec * p.tSec;
    sumTY += p.tSec * p.y;
  }

  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-12) return 0;

  return (n * sumTY - sumT * sumY) / denom;
}

function parseSymbolFromMarket(market) {
  const raw = String(market || "").toUpperCase().trim();
  if (!raw) return null;

  const direct = raw.match(/[A-Z0-9]{6,15}/g);
  if (direct && direct.length) return direct[0];

  return raw.replace(/[^A-Z0-9]/g, "") || null;
}

async function resolveConfigDefaults() {
  let cfgSymbol = null;
  let cfgCategory = null;
  const depth = {};

  try {
    const mod = await import("../config.js");
    const config = mod?.CONFIG;

    if (config?.MARKET) {
      cfgSymbol = parseSymbolFromMarket(config.MARKET);
    }

    if (config?.CATEGORY) {
      cfgCategory = String(config.CATEGORY).toLowerCase();
    }

    // Depth signal weights — kalibrowane przez tester_lag_depth2.mjs
    if (config?.STRAT_IMPULSE_DEPTH_W_VOL != null) {
      depth.W_VOL    = safeNum(config.STRAT_IMPULSE_DEPTH_W_VOL,    0.55);
      depth.W_ATR    = safeNum(config.STRAT_IMPULSE_DEPTH_W_ATR,    0.20);
      depth.W_OB     = safeNum(config.STRAT_IMPULSE_DEPTH_W_OB,     0.25);
      depth.VOL_NORM = safeNum(config.STRAT_IMPULSE_DEPTH_VOL_NORM, 3.0);
      depth.ATR_NORM = safeNum(config.STRAT_IMPULSE_DEPTH_ATR_NORM, 2.0);
      depth.OB_NORM  = safeNum(config.STRAT_IMPULSE_DEPTH_OB_NORM,  1.0);
    }
  } catch {
    // brak config.js w tym workspace -> fallback do domyślnych
  }

  return {
    symbol:   cfgSymbol   || "BTCUSDT",
    category: cfgCategory || "linear",
    depth,
  };
}

async function fetchRecentTrades({ category, symbol, limit = 1000 }) {
  const { data } = await axios.get(`${BYBIT_BASE}/v5/market/recent-trade`, {
    params: { category, symbol, limit },
    timeout: 8_000,
  });

  const rows = data?.result?.list;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => ({
      price: safeNum(row.price),
      size: safeNum(row.size),
      tsMs: safeNum(row.time),
    }))
    .filter((t) => t.price > 0 && t.tsMs > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
}

async function fetchKlines({ category, symbol, interval, limit }) {
  const { data } = await axios.get(`${BYBIT_BASE}/v5/market/kline`, {
    params: { category, symbol, interval, limit },
    timeout: 8_000,
  });

  const list = data?.result?.list;
  if (!Array.isArray(list)) return [];

  return list
    .map((row) => ({
      startMs: safeNum(row[0]),
      open: safeNum(row[1]),
      high: safeNum(row[2]),
      low: safeNum(row[3]),
      close: safeNum(row[4]),
      volume: safeNum(row[5]),
      turnover: safeNum(row[6]),
    }))
    .filter((c) => c.startMs > 0 && c.close > 0)
    .sort((a, b) => a.startMs - b.startMs);
}

function emptyOB() {
  return {
    bidTotal: 0, askTotal: 0,
    obImbalance: 0, ob3Imbalance: 0,
    obSpread: 0,
    obBidConc: 0, obAskConc: 0,
    obBidWallPct: 0, obAskWallPct: 0,
    obMicroAdj: 0,
  };
}

async function fetchOrderBook({ category, symbol, limit = 25 }) {
  try {
    const { data } = await axios.get(`${BYBIT_BASE}/v5/market/orderbook`, {
      params: { category, symbol, limit },
      timeout: 5_000,
    });
    const b = data?.result?.b ?? [];  // bids: [[price, qty], ...] malejące po cenie
    const a = data?.result?.a ?? [];  // asks: [[price, qty], ...] rosnące po cenie
    if (!b.length || !a.length) return emptyOB();

    const bids = b.map(r => [safeNum(r[0]), safeNum(r[1])]);
    const asks = a.map(r => [safeNum(r[0]), safeNum(r[1])]);
    const bestBid = bids[0][0];
    const bestAsk = asks[0][0];
    const mid     = (bestBid + bestAsk) / 2;

    // Sumaryczne ilości (top 25)
    const bidTotal = bids.reduce((s, r) => s + r[1], 0);
    const askTotal = asks.reduce((s, r) => s + r[1], 0);
    const total    = bidTotal + askTotal;

    // obImbalance top-25 (główny, backward compat)
    const obImbalance = total > 1e-9 ? (bidTotal - askTotal) / total : 0;

    // ob3Imbalance: tylko top-3 poziomy (silniej skorelowane z chwilową ceną)
    const bid3   = bids.slice(0, 3).reduce((s, r) => s + r[1], 0);
    const ask3   = asks.slice(0, 3).reduce((s, r) => s + r[1], 0);
    const total3 = bid3 + ask3;
    const ob3Imbalance = total3 > 1e-9 ? (bid3 - ask3) / total3 : 0;

    // Spread bid-ask [% od mid]
    const obSpread = mid > 1e-9 ? (bestAsk - bestBid) / mid * 100 : 0;

    // Koncentracja ściany: max_pojedynczy_poziom / całość [0,1]
    const maxBid    = Math.max(...bids.map(r => r[1]));
    const maxAsk    = Math.max(...asks.map(r => r[1]));
    const obBidConc = bidTotal > 1e-9 ? maxBid / bidTotal : 0;
    const obAskConc = askTotal > 1e-9 ? maxAsk / askTotal : 0;

    // Odległość największej ściany od mid [%]
    const biggestBidPrice = (bids.find(r => r[1] === maxBid) ?? bids[0])[0];
    const biggestAskPrice = (asks.find(r => r[1] === maxAsk) ?? asks[0])[0];
    const obBidWallPct    = mid > 1e-9 ? (mid - biggestBidPrice) / mid * 100 : 0;
    const obAskWallPct    = mid > 1e-9 ? (biggestAskPrice - mid) / mid * 100 : 0;

    // Microprice: mid ważone wolumenem top-3 → bias kierunkowy OB [% od mid]
    const microprice = total3 > 1e-9 ? (bestAsk * bid3 + bestBid * ask3) / total3 : mid;
    const obMicroAdj = mid > 1e-9 ? (microprice - mid) / mid * 100 : 0;

    return {
      bidTotal, askTotal,
      obImbalance, ob3Imbalance,
      obSpread,
      obBidConc, obAskConc,
      obBidWallPct, obAskWallPct,
      obMicroAdj,
    };
  } catch {
    return emptyOB();
  }
}

async function fetchTickMarketData() {
  const params = {
    category: state.category,
    symbol: state.symbol,
  };

  const [tradesRes, k1Res, k15Res, obRes] = await Promise.allSettled([
    fetchRecentTrades({ ...params, limit: 1000 }),
    fetchKlines({ ...params, interval: "1", limit: state.interval1mLimit }),
    fetchKlines({ ...params, interval: "15", limit: state.interval15mLimit }),
    fetchOrderBook({ ...params, limit: 10 }),
  ]);

  const errors = [];

  const trades = tradesRes.status === "fulfilled" ? tradesRes.value : [];
  if (tradesRes.status === "rejected") errors.push(`recent-trade: ${tradesRes.reason?.message || tradesRes.reason}`);

  const k1 = k1Res.status === "fulfilled" ? k1Res.value : [];
  if (k1Res.status === "rejected") errors.push(`kline-1m: ${k1Res.reason?.message || k1Res.reason}`);

  const k15 = k15Res.status === "fulfilled" ? k15Res.value : [];
  if (k15Res.status === "rejected") errors.push(`kline-15m: ${k15Res.reason?.message || k15Res.reason}`);

  const ob = obRes.status === "fulfilled" ? obRes.value : emptyOB();

  return { trades, k1, k15, ob, errors };
}

function ingestTradesToMicro(trades) {
  if (!trades.length) return 0;

  const fresh = trades.filter((t) => t.tsMs > state.micro.lastTradeTsMs);
  if (!fresh.length) return 0;

  for (const tr of fresh) {
    const sec = Math.floor(tr.tsMs / 1000);
    const prev = state.micro.bySec.get(sec);

    if (!prev) {
      state.micro.bySec.set(sec, {
        t: sec,
        open: tr.price,
        high: tr.price,
        low: tr.price,
        close: tr.price,
        volQuote: tr.price * tr.size,
        n: 1,
      });
    } else {
      prev.high = Math.max(prev.high, tr.price);
      prev.low = Math.min(prev.low, tr.price);
      prev.close = tr.price;
      prev.volQuote += tr.price * tr.size;
      prev.n += 1;
    }
  }

  state.micro.lastTradeTsMs = fresh[fresh.length - 1].tsMs;

  const minSec = Math.floor(nowMs() / 1000) - state.micro.lookbackSec;
  for (const [key, candle] of state.micro.bySec.entries()) {
    if (candle.t < minSec) state.micro.bySec.delete(key);
  }

  return fresh.length;
}

function computeFastFromMicro() {
  const nowSec = Math.floor(nowMs() / 1000);
  const fromSec = nowSec - state.micro.slopeWindowSec;

  const points = [];
  for (const candle of state.micro.bySec.values()) {
    if (candle.t >= fromSec && candle.close > 0) {
      points.push({ tSec: candle.t, y: Math.log(candle.close) });
    }
  }
  points.sort((a, b) => a.tSec - b.tSec);

  const minPts = Math.max(10, Math.floor(state.micro.slopeWindowSec * 0.3));
  if (points.length < minPts) {
    return { z: 0, conf: clamp(points.length / minPts, 0, 1), ok: false };
  }

  const slope = slopePerSecond(points);
  const returns = [];
  for (let i = 1; i < points.length; i++) {
    returns.push(points[i].y - points[i - 1].y);
  }

  const vol = stdev(returns);
  const z = vol > 1e-12 ? slope / vol : 0;

  return { z, conf: clamp(points.length / (state.micro.slopeWindowSec * 0.8), 0, 1), ok: true };
}

function computeZFromKlines(klines, windowBars) {
  if (!Array.isArray(klines) || klines.length < windowBars + 2) {
    return { z: 0, conf: 0, ok: false };
  }

  const bars = klines.slice(-windowBars - 1);
  const closes = bars.map((b) => b.close).filter((v) => v > 0);
  if (closes.length < windowBars + 1) {
    return { z: 0, conf: 0, ok: false };
  }

  const r = logReturn(closes[0], closes[closes.length - 1]);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(logReturn(closes[i - 1], closes[i]));
  }

  const vol = stdev(returns);
  const z = vol > 1e-12 ? r / vol : 0;

  return { z, conf: clamp(closes.length / (windowBars + 1), 0, 1), ok: true };
}

function composeRawMomentumScore({ fast, mid, slow }) {
  const fastU = zToUnit(fast.z, 3);
  const midU = zToUnit(mid.z, 3);
  const slowU = zToUnit(slow.z, 3);

  const scoreRaw = clamp(0.7983 * fastU * fast.conf + 0.1015 * midU * mid.conf + 0.1001 * slowU * slow.conf, -1, 1);  // TESTER-LAG gen175: was 0.5/0.3/0.2

  return {
    scoreRaw,
    components: { fast: fastU, mid: midU, slow: slowU },
    confidence: { fast: fast.conf, mid: mid.conf, slow: slow.conf },
  };
}

function updateMomentumSmoothing({ tsMs, close, m }) {
  const samples = state.momentumSmoothing.samples;
  samples.push({ t: tsMs, close, m });

  const minKeep = tsMs - SAMPLE_KEEP_MS;
  while (samples.length && samples[0].t < minKeep) samples.shift();

  if (state.momentumSmoothing.ema == null || state.momentumSmoothing.lastEmaTsMs == null) {
    state.momentumSmoothing.ema = m;
    state.momentumSmoothing.lastEmaTsMs = tsMs;
  } else {
    const dt = Math.max(1, tsMs - state.momentumSmoothing.lastEmaTsMs);
    const alpha = 1 - Math.exp(-dt / MOMENTUM_HALF_LIFE_MS);
    state.momentumSmoothing.ema = state.momentumSmoothing.ema + alpha * (m - state.momentumSmoothing.ema);
    state.momentumSmoothing.lastEmaTsMs = tsMs;
  }

  const scoreSamples = samples.filter((s) => s.t >= tsMs - SCORE_WINDOW_MS);
  const avg = mean(scoreSamples.map((s) => s.m));

  let consistency = 0;
  const avgSign = sign(avg);
  if (scoreSamples.length > 0 && avgSign !== 0) {
    let same = 0;
    for (const s of scoreSamples) {
      if (sign(s.m) === avgSign) same += 1;
    }
    consistency = same / scoreSamples.length;
  }

  const score = clamp(
    MOMENTUM_WEIGHTS.avg * avg +
      MOMENTUM_WEIGHTS.ema * safeNum(state.momentumSmoothing.ema, 0) +
      MOMENTUM_WEIGHTS.consistency * (avgSign * consistency),
    -1,
    1
  );

  return {
    score,
    avg,
    ema: safeNum(state.momentumSmoothing.ema, 0),
    consistency,
  };
}

function sma(values, period) {
  if (values.length < period) return null;
  return mean(values.slice(values.length - period));
}

function emaSeries(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const out = [];
  let prev = mean(values.slice(0, period));
  out.push(prev);

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function typicalPrice(candle) {
  return (candle.high + candle.low + candle.close) / 3;
}

function meanDeviation(values) {
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += Math.abs(v - m);
  return { mean: m, dev: values.length ? sum / values.length : 0 };
}

function calcCCI(candles, period = 20) {
  if (candles.length < period) return null;
  const tps = candles.map(typicalPrice);
  const window = tps.slice(-period);
  const { mean: m, dev } = meanDeviation(window);
  if (dev === 0) return 0;
  const lastTp = window[window.length - 1];
  return (lastTp - m) / (0.015 * dev);
}

function calcTrueRange(current, prevClose) {
  if (prevClose == null) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - prevClose),
    Math.abs(current.low - prevClose)
  );
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1].close : null;
    trs.push(calcTrueRange(candles[i], prevClose));
  }

  return sma(trs, period);
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return null;

  const plusDM = [];
  const minusDM = [];
  const trList = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trList.push(calcTrueRange(curr, prev.close));
  }

  if (trList.length < period) return null;

  let trN = trList.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMN = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMN = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxs = [];

  for (let i = period; i < trList.length; i++) {
    trN = trN - trN / period + trList[i];
    plusDMN = plusDMN - plusDMN / period + plusDM[i];
    minusDMN = minusDMN - minusDMN / period + minusDM[i];

    const plusDI = trN === 0 ? 0 : (100 * plusDMN) / trN;
    const minusDI = trN === 0 ? 0 : (100 * minusDMN) / trN;

    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;
    dxs.push(dx);
  }

  if (dxs.length < period) return null;

  let adx = mean(dxs.slice(0, period));
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }

  return adx;
}

function calcRegimeFromCandles(candles) {
  if (candles.length < 60) {
    return {
      regime: "UNKNOWN",
      cci: null,
      adx14: null,
      atrPct: null,
      emaSpreadPct: null,
    };
  }

  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];

  const ema20 = emaSeries(closes, 20).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const atr14 = calcATR(candles, 14);
  const adx14 = calcADX(candles, 14);
  const cci = calcCCI(candles, 20);

  if (
    !Number.isFinite(ema20) ||
    !Number.isFinite(ema50) ||
    !Number.isFinite(atr14) ||
    !Number.isFinite(adx14) ||
    !Number.isFinite(lastClose) ||
    lastClose <= 0
  ) {
    return {
      regime: "UNKNOWN",
      cci,
      adx14,
      atrPct: null,
      emaSpreadPct: null,
    };
  }

  const emaSpreadPct = ((ema20 - ema50) / ema50) * 100;
  const atrPct = (atr14 / lastClose) * 100;

  let regime = "RANGE";

  if (adx14 >= 25) {
    if (ema20 > ema50) regime = "TREND_UP";
    else if (ema20 < ema50) regime = "TREND_DOWN";
    else regime = "TREND";
  } else if (adx14 < 20) {
    regime = atrPct > 1.8 ? "VOLATILE_RANGE" : "RANGE";
  } else {
    regime = atrPct > 1.8 ? "VOLATILE_TRANSITION" : "TRANSITION";
  }

  return {
    regime,
    cci,
    adx14,
    atrPct,
    emaSpreadPct,
  };
}

function findRecordAtOrBefore(records, targetMs) {
  if (!records.length) return null;

  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].tsMs <= targetMs) return records[i];
  }

  return null;
}

function pctChange(current, past) {
  if (!Number.isFinite(current) || !Number.isFinite(past) || past === 0) return 0;
  return ((current - past) / past) * 100;
}

function getPastMetric(records, nowTsMs, minutes, field) {
  const rec = findRecordAtOrBefore(records, nowTsMs - minutes * 60_000);
  if (!rec) return null;
  return safeNum(rec[field], 0);
}

function countRegimeFlips(records, nowTsMs, windowMs) {
  const fromMs = nowTsMs - windowMs;
  const inWindow = records.filter((r) => r.tsMs >= fromMs);
  if (inWindow.length < 2) return 0;

  let flips = 0;
  for (let i = 1; i < inWindow.length; i++) {
    if (inWindow[i].regime !== inWindow[i - 1].regime) flips += 1;
  }

  return flips;
}

function computeRegimeAgeSec(records, currentRegime, nowTsMs) {
  if (!records.length) return 0;

  let earliestTs = nowTsMs;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].regime !== currentRegime) break;
    earliestTs = records[i].tsMs;
  }

  return Math.max(0, Math.round((nowTsMs - earliestTs) / 1000));
}

function computeHistoryContext(records, current) {
  const tsMs = current.tsMs;

  const rec1m = findRecordAtOrBefore(records, tsMs - 60_000);
  const rec3m = findRecordAtOrBefore(records, tsMs - 3 * 60_000);
  const rec5m = findRecordAtOrBefore(records, tsMs - 5 * 60_000);
  const rec15m = findRecordAtOrBefore(records, tsMs - 15 * 60_000);
  const rec60m = findRecordAtOrBefore(records, tsMs - 60 * 60_000);

  const priceChange1mPct = pctChange(current.price, rec1m?.price);
  const priceChange3mPct = pctChange(current.price, rec3m?.price);
  const priceChange5mPct = pctChange(current.price, rec5m?.price);
  const priceChange15mPct = pctChange(current.price, rec15m?.price);
  const priceChange60mPct = pctChange(current.price, rec60m?.price);

  const momentumDelta1m = current.momentumScore - safeNum(rec1m?.momentumScore, current.momentumScore);
  const momentumDelta3m = current.momentumScore - safeNum(rec3m?.momentumScore, current.momentumScore);
  const momentumDelta5m = current.momentumScore - safeNum(rec5m?.momentumScore, current.momentumScore);

  const cciDelta3m = current.cci - safeNum(rec3m?.cci, current.cci);
  const cciDelta5m = current.cci - safeNum(rec5m?.cci, current.cci);
  const cciDelta15m = current.cci - safeNum(rec15m?.cci, current.cci);

  const adxDelta15m = current.adx14 - safeNum(rec15m?.adx14, current.adx14);
  const adxDelta60m = current.adx14 - safeNum(rec60m?.adx14, current.adx14);
  const emaSpreadDelta15m = current.emaSpreadPct - safeNum(rec15m?.emaSpreadPct, current.emaSpreadPct);

  const momentumSlope5m = rec5m ? (current.momentumScore - safeNum(rec5m.momentumScore, current.momentumScore)) / 5 : 0;
  const cciSlope5m = rec5m ? (current.cci - safeNum(rec5m.cci, current.cci)) / 5 : 0;
  const adxSlope15m = rec15m ? (current.adx14 - safeNum(rec15m.adx14, current.adx14)) / 15 : 0;

  const merged = [...records, { tsMs, regime: current.regime }];
  const regimeAgeSec = computeRegimeAgeSec(merged, current.regime, tsMs);
  const regimeFlips15m = countRegimeFlips(merged, tsMs, 15 * 60_000);
  const regimeFlips60m = countRegimeFlips(merged, tsMs, 60 * 60_000);

  return {
    priceChange1mPct,
    priceChange3mPct,
    priceChange5mPct,
    priceChange15mPct,
    priceChange60mPct,
    momentumDelta1m,
    momentumDelta3m,
    momentumDelta5m,
    cciDelta3m,
    cciDelta5m,
    cciDelta15m,
    adxDelta15m,
    adxDelta60m,
    emaSpreadDelta15m,
    momentumSlope5m,
    cciSlope5m,
    adxSlope15m,
    regimeAgeSec,
    regimeFlips15m,
    regimeFlips60m,
  };
}

function computeDerived(current, history) {
  let pressureScore = clamp(
    0.3 * norm(current.momentumScore, 1) +
      0.2 * norm(current.cci, 200) +
      0.2 * norm(current.emaSpreadPct, 0.5) +
      0.10 * norm(history.priceChange5mPct, 1.5),  // TESTER-LAG gen175: fast=5m w=0.10, slow=15m w=0.00 (dropped)
    -1,
    1
  );

  if (current.adx14 > 20) {
    const boost = 1 + clamp((current.adx14 - 20) / 60, 0, 0.2);
    pressureScore = clamp(pressureScore * boost, -1, 1);
  }

  const shockScore = clamp(
    0.27 * normAbs(history.priceChange1mPct, 0.3) +
      0.23 * normAbs(history.priceChange3mPct, 0.6) +
      0.18 * normAbs(history.momentumDelta1m, 0.25) +
      0.12 * normAbs(history.momentumDelta3m, 0.4) +
      0.1 * normAbs(history.cciDelta3m, 50) +
      0.1 * normAbs(current.momentumScore, 1),
    0,
    1
  );

  const shockDirRaw = 0.3085 * history.priceChange1mPct + 0.5582 * history.momentumDelta1m + 0.1332 * current.momentumScore;  // TESTER-LAG gen175: was 0.45/0.35/0.20
  const shockDir = Math.abs(shockDirRaw) < 0.02 ? 0 : sign(shockDirRaw);

  const botSignal = clamp(
    10 * (0.65 * pressureScore + 0.2 * current.momentumScore + 0.15 * sign(pressureScore) * (1 - shockScore)),
    -10,
    10
  );

  return {
    pressureScore,
    shockScore,
    shockDir,
    botSignal,
    botSignalAbs: Math.abs(botSignal),
  };
}

// ─── DETEKCJA GŁĘBOKOŚCI IMPULSU ───────────────────────────────────────────────────
// Odpowiada na pytanie: "jak głęboki będzie ten swing?"
// volRatio:          bieżąca świąċka / średni vol z 20 świączek  (duży = instytucje)
// obImbalance:       (bid-ask)/(bid+ask) ∈ [-1,+1]  (neg = ściana sprzedających)
// impulseDepthScore: kompozyt ∈ [0,1]  (0=płytki ruch, 1=głęboki impuls)

function computeVolumeRatio(k1, lookback = 20) {
  if (!Array.isArray(k1) || k1.length < 2) return 1;
  const bars = k1.slice(-Math.min(lookback + 1, k1.length));
  const current = bars.at(-1);
  const past = bars.slice(0, -1);
  const avgVol = past.reduce((s, c) => s + c.volume, 0) / Math.max(1, past.length);
  return avgVol > 1e-9 ? current.volume / avgVol : 1;
}

function computeDepthSignal({ volRatio, obImbalance, atrPct, shockDir }) {
  const clamp01  = (v) => Math.max(0, Math.min(1, v));
  const cfg      = state.depthCfg;
  const W_VOL    = cfg.W_VOL    ?? 0.55;
  const W_ATR    = cfg.W_ATR    ?? 0.20;
  const W_OB     = cfg.W_OB     ?? 0.25;
  const VOL_NORM = cfg.VOL_NORM ?? 3.0;
  const ATR_NORM = cfg.ATR_NORM ?? 2.0;
  const OB_NORM  = cfg.OB_NORM  ?? 1.0;
  const sumW     = W_VOL + W_ATR + W_OB;
  const wVol = W_VOL / sumW, wAtr = W_ATR / sumW, wOb = W_OB / sumW;
  // Nadwyżka wolumenu: nasycenie przy VOL_NORM × średniej
  const volN    = clamp01(Math.abs(volRatio - 1) / Math.max(VOL_NORM, 1e-9));
  // OB imbalance w kierunku aktualnego szoku
  const dirOB   = shockDir < 0 ? Math.max(0, -obImbalance)
                : shockDir > 0 ? Math.max(0, obImbalance)
                : Math.abs(obImbalance);
  const obN     = clamp01(dirOB / Math.max(OB_NORM, 1e-9));
  // Reżim zmienności: ATR
  const atrN    = clamp01(Math.abs(atrPct) / Math.max(ATR_NORM, 1e-9));
  const score   = clamp01(wVol * volN + wOb * obN + wAtr * atrN);
  return { impulseDepthScore: score, volRatio, obImbalance };
}

function pruneHistoryInMemory(nowTsMs = nowMs()) {
  const minTs = nowTsMs - HISTORY_KEEP_MS;
  while (state.history.length && state.history[0].tsMs < minTs) {
    state.history.shift();
  }
}

async function ensureLogsDir() {
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

async function loadHistoryFromDisk() {
  await ensureLogsDir();

  let raw = "";
  try {
    raw = await fs.readFile(HISTORY_JSONL_PATH, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      state.history = [];
      return;
    }
    throw err;
  }

  const now = nowMs();
  const minTs = now - HISTORY_KEEP_MS;

  const loaded = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const row = JSON.parse(line);
      if (safeNum(row.tsMs, 0) >= minTs) loaded.push(row);
    } catch {
      // pomijamy uszkodzone linie
    }
  }

  loaded.sort((a, b) => a.tsMs - b.tsMs);
  state.history = loaded;

  await compactHistoryFile();
}

async function compactHistoryFile() {
  await ensureLogsDir();
  pruneHistoryInMemory();

  const body = state.history.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(HISTORY_JSONL_PATH, body ? `${body}\n` : "", "utf8");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function ensureCsv5mFile() {
  await ensureLogsDir();

  try {
    await fs.access(HISTORY_CSV_5M_PATH);
  } catch (err) {
    if (err?.code === "ENOENT") {
      await fs.writeFile(HISTORY_CSV_5M_PATH, `${CSV_HEADERS.join(",")}\n`, "utf8");
      return;
    }
    throw err;
  }

  try {
    const raw = await fs.readFile(HISTORY_CSV_5M_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) {
      await fs.writeFile(HISTORY_CSV_5M_PATH, `${CSV_HEADERS.join(",")}\n`, "utf8");
      return;
    }

    const last = lines[lines.length - 1];
    if (last && last !== CSV_HEADERS.join(",")) {
      const cols = last.split(",");
      const tsMs = safeNum(cols[1], 0);
      if (tsMs > 0) {
        state.lastCsvBucket = Math.floor(tsMs / CSV_SAMPLE_MS);
      }
    }
  } catch {
    await fs.writeFile(HISTORY_CSV_5M_PATH, `${CSV_HEADERS.join(",")}\n`, "utf8");
  }
}

async function appendCsv5mRecord(record) {
  const bucket = Math.floor(safeNum(record.tsMs, 0) / CSV_SAMPLE_MS);
  if (!Number.isFinite(bucket) || bucket < 0) return;
  if (state.lastCsvBucket === bucket) return;

  const row = [
    record.ts,
    record.tsMs,
    record.symbol,
    record.category,
    safeNum(record.price, 0).toFixed(8),
    record.regime,
    safeNum(record.cci, 0).toFixed(4),
    safeNum(record.adx14, 0).toFixed(4),
    safeNum(record.atrPct, 0).toFixed(6),
    safeNum(record.emaSpreadPct, 0).toFixed(6),
    safeNum(record.momentumScore, 0).toFixed(6),
    safeNum(record.pressureScore, 0).toFixed(6),
    safeNum(record.shockScore, 0).toFixed(6),
    safeNum(record.botSignal, 0).toFixed(6),
    safeNum(record.impulseDepthScore, 0).toFixed(6),
    safeNum(record.volRatio, 1).toFixed(4),
    safeNum(record.obImbalance, 0).toFixed(6),
    safeNum(record.ob3Imbalance, 0).toFixed(6),
    safeNum(record.obSpread, 0).toFixed(6),
    safeNum(record.obBidConc, 0).toFixed(6),
    safeNum(record.obAskConc, 0).toFixed(6),
    safeNum(record.obBidWallPct, 0).toFixed(6),
    safeNum(record.obAskWallPct, 0).toFixed(6),
    safeNum(record.obMicroAdj, 0).toFixed(6),
  ]
    .map(csvEscape)
    .join(",");

  await ensureCsv5mFile();
  await fs.appendFile(HISTORY_CSV_5M_PATH, `${row}\n`, "utf8");
  state.lastCsvBucket = bucket;
}

async function appendHistoryRecord(record) {
  state.history.push(record);
  pruneHistoryInMemory(record.tsMs);

  await ensureLogsDir();
  await fs.appendFile(HISTORY_JSONL_PATH, `${JSON.stringify(record)}\n`, "utf8");
  await appendCsv5mRecord(record);

  state.tickCount += 1;
  if (state.tickCount % 60 === 0) {
    await compactHistoryFile();
  }
}

function buildStorageRecord(snapshot) {
  return {
    ts: snapshot.ts,
    tsMs: snapshot.tsMs,
    symbol: snapshot.symbol,
    category: snapshot.category,
    price: snapshot.price,
    regime: snapshot.regime,
    cci: snapshot.cci,
    adx14: snapshot.adx14,
    atrPct: snapshot.atrPct,
    emaSpreadPct: snapshot.emaSpreadPct,
    momentumScoreRaw: snapshot.momentum.scoreRaw,
    momentumAvg: snapshot.momentum.avg,
    momentumEma: snapshot.momentum.ema,
    momentumConsistency: snapshot.momentum.consistency,
    momentumScore: snapshot.momentum.score,
    pressureScore: snapshot.derived.pressureScore,
    shockScore: snapshot.derived.shockScore,
    shockDir: snapshot.derived.shockDir,
    botSignal: snapshot.derived.botSignal,
    impulseDepthScore: snapshot.derived.impulseDepthScore,
    volRatio:      snapshot.derived.volRatio,
    obImbalance:   snapshot.derived.obImbalance,
    ob3Imbalance:  snapshot.derived.ob3Imbalance,
    obSpread:      snapshot.derived.obSpread,
    obBidConc:     snapshot.derived.obBidConc,
    obAskConc:     snapshot.derived.obAskConc,
    obBidWallPct:  snapshot.derived.obBidWallPct,
    obAskWallPct:  snapshot.derived.obAskWallPct,
    obMicroAdj:    snapshot.derived.obMicroAdj,
  };
}

async function pollOnce() {
  const tsMs = nowMs();
  const ts = new Date(tsMs).toISOString();

  const market = await fetchTickMarketData();
  const { trades, k1, k15, ob, errors } = market;

  ingestTradesToMicro(trades);

  const fast = computeFastFromMicro();
  const mid = computeZFromKlines(k1, 10);   // TESTER-LAG gen175: was 60
  const slow = computeZFromKlines(k15, 16);  // TESTER-LAG gen175: was 32

  const rawMomentum = composeRawMomentumScore({ fast, mid, slow });

  const rawPrice = safeNum(k1.at(-1)?.close, safeNum(k15.at(-1)?.close, 0));
  const lastPrice = safeNum(state.last?.price, 0);
  // Odrzuć tick z price=0 lub ekstremalnym skokiem (>15%) — sygnatura błędu API/reconnect
  if (rawPrice <= 0 || (lastPrice > 0 && (rawPrice > lastPrice * 1.15 || rawPrice < lastPrice * 0.85))) {
    dbg(`[pollOnce] SKIP — invalid price rawPrice=${rawPrice} lastPrice=${lastPrice}`);
    return state.last ?? null;
  }
  const price = rawPrice;

  const smoothed = updateMomentumSmoothing({
    tsMs,
    close: price,
    m: rawMomentum.scoreRaw,
  });

  const regimeData = calcRegimeFromCandles(k15);

  const baseCurrent = {
    ts,
    tsMs,
    symbol: state.symbol,
    category: state.category,
    price,
    regime: regimeData.regime,
    cci: safeNum(regimeData.cci, 0),
    adx14: safeNum(regimeData.adx14, 0),
    atrPct: safeNum(regimeData.atrPct, 0),
    emaSpreadPct: safeNum(regimeData.emaSpreadPct, 0),
    momentumScore: smoothed.score,
  };

  const historyCtx = computeHistoryContext(state.history, baseCurrent);
  const baseDir = computeDerived(baseCurrent, historyCtx);

  // Głębokość impulsu: vol spike + OB imbalance + ATR
  const volRatio = computeVolumeRatio(k1);
  const depthSig = computeDepthSignal({
    volRatio,
    obImbalance: ob.obImbalance,
    atrPct: safeNum(regimeData.atrPct, 0),
    shockDir: baseDir.shockDir,
  });
  const derived = {
    ...baseDir,
    ...depthSig,
    ob3Imbalance: ob.ob3Imbalance,
    obSpread:     ob.obSpread,
    obBidConc:    ob.obBidConc,
    obAskConc:    ob.obAskConc,
    obBidWallPct: ob.obBidWallPct,
    obAskWallPct: ob.obAskWallPct,
    obMicroAdj:   ob.obMicroAdj,
  };

  const snapshot = {
    ts,
    tsMs,
    symbol: state.symbol,
    category: state.category,
    price,

    regime: regimeData.regime,
    cci: safeNum(regimeData.cci, 0),
    adx14: safeNum(regimeData.adx14, 0),
    atrPct: safeNum(regimeData.atrPct, 0),
    emaSpreadPct: safeNum(regimeData.emaSpreadPct, 0),

    momentum: {
      scoreRaw: rawMomentum.scoreRaw,
      avg: smoothed.avg,
      ema: smoothed.ema,
      consistency: smoothed.consistency,
      score: smoothed.score,
    },

    history: historyCtx,
    derived,

    meta: {
      counts: {
        trades: trades.length,
        k1: k1.length,
        k15: k15.length,
        obBidTotal: ob.bidTotal,
        obAskTotal: ob.askTotal,
      },
      errors,
      confidence: rawMomentum.confidence,
      components: rawMomentum.components,
    },
  };

  await appendHistoryRecord(buildStorageRecord(snapshot));

  state.last = snapshot;

  dbg(
    `score=${snapshot.momentum.score.toFixed(3)} raw=${snapshot.momentum.scoreRaw.toFixed(3)} ` +
      `regime=${snapshot.regime} cci=${snapshot.cci.toFixed(2)} ` +
      `pressure=${snapshot.derived.pressureScore.toFixed(3)} shock=${snapshot.derived.shockScore.toFixed(3)} ` +
      `bot=${snapshot.derived.botSignal.toFixed(2)} errs=${errors.length}`
  );

  return snapshot;
}

function parseArg(name) {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function startMarketSignal(opts = {}) {
  if (state.running) return;

  const defaults = await resolveConfigDefaults();

  // Depth signal config — z config.js, kalibrowane przez tester_lag_depth2.mjs
  if (defaults.depth && Object.keys(defaults.depth).length) {
    state.depthCfg = defaults.depth;
  }

  state.symbol = String(opts.symbol || defaults.symbol || "BTCUSDT").toUpperCase();
  state.category = String(opts.category || defaults.category || "linear").toLowerCase();
  state.pollMs = Math.max(1_000, safeNum(opts.pollMs, 10_000));
  state.silent = opts.silent != null ? Boolean(opts.silent) : true;
  state.debug = Boolean(opts.debug);

  if (Number.isFinite(opts.k1Limit)) state.interval1mLimit = safeNum(opts.k1Limit, state.interval1mLimit);
  if (Number.isFinite(opts.k15Limit)) state.interval15mLimit = safeNum(opts.k15Limit, state.interval15mLimit);

  await ensureCsv5mFile();
  await loadHistoryFromDisk();

  state.running = true;

  log(`▶ market signal start | symbol=${state.symbol} category=${state.category} poll=${state.pollMs}ms`);

  try {
    await pollOnce();
  } catch (err) {
    log(`first poll error: ${err?.message || err}`);
  }

  state.timer = setInterval(async () => {
    try {
      await pollOnce();
    } catch (err) {
      log(`poll error: ${err?.message || err}`);
    }
  }, state.pollMs);
}

export async function stopMarketSignal() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  await compactHistoryFile();
}

export function getMarketSignal() {
  return state.last;
}

export function getMomentum() {
  return state.last?.momentum ?? null;
}

export function getMomentumScore() {
  return safeNum(state.last?.momentum?.score, 0);
}

export function getRegimeSnapshot() {
  if (!state.last) return null;
  return {
    regime: state.last.regime,
    cci: state.last.cci,
    adx14: state.last.adx14,
    atrPct: state.last.atrPct,
    emaSpreadPct: state.last.emaSpreadPct,
  };
}

export function getHistoryBuffer() {
  return [...state.history];
}

export async function runOnce(opts = {}) {
  const defaults = await resolveConfigDefaults();
  state.symbol = String(opts.symbol || defaults.symbol || state.symbol || "BTCUSDT").toUpperCase();
  state.category = String(opts.category || defaults.category || state.category || "linear").toLowerCase();
  state.silent = opts.silent != null ? Boolean(opts.silent) : state.silent;
  state.debug = Boolean(opts.debug ?? state.debug);

  if (!state.history.length) {
    await loadHistoryFromDisk();
  }

  return pollOnce();
}

export async function startMomentum(opts = {}) {
  return startMarketSignal(opts);
}

export async function stopMomentum() {
  return stopMarketSignal();
}

const RUN_AS_CLI = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (RUN_AS_CLI) {
  const bootstrap = async () => {
    const defaults = await resolveConfigDefaults();

    const symbol = String(parseArg("symbol") || defaults.symbol || "BTCUSDT").toUpperCase();
    const category = String(parseArg("category") || defaults.category || "linear").toLowerCase();
    const pollMs = Math.max(1_000, safeNum(parseArg("pollMs"), 10_000));
    const debug = hasFlag("debug");

    await startMarketSignal({
      symbol,
      category,
      pollMs,
      silent: false,
      debug,
    });

    while (true) {
      const data = getMarketSignal();
      if (data) {
        const msg =
          `[${new Date().toLocaleString("pl-PL")}] ${data.symbol} ` +
          `regime: ${data.regime} ` +
          `CCI: ${data.cci.toFixed(2)} ` +
          `momentum: ${data.momentum.score.toFixed(3)} ` +
          `raw: ${data.momentum.scoreRaw.toFixed(3)} ` +
          `adx14: ${data.adx14.toFixed(2)} ` +
          `atrPct: ${data.atrPct.toFixed(3)}% ` +
          `emaSpreadPct: ${data.emaSpreadPct.toFixed(3)}% ` +
          `pressure: ${data.derived.pressureScore.toFixed(3)} ` +
          `shock: ${data.derived.shockScore.toFixed(3)} ` +
          `botSignal: ${data.derived.botSignal.toFixed(2)}`;

        console.log(msg);
      }
      await sleep(pollMs);
    }
  };

  bootstrap().catch((err) => {
    console.error(`Błąd startu: ${err?.message || err}`);
    process.exit(1);
  });
}
