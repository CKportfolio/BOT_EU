// scripts/channels_core.js (ESM)
import axios from "axios";

const BYBIT_BASE = (process.env.BYBIT_TRADE_BASE_URL || process.env.BYBIT_BASE_URL || "https://api.bybit.eu").replace(/\/+$/, "");

function safeNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

/** Bybit v5 klines page */
export async function fetchKlinesPage({
  category,
  symbol,
  interval,
  limit = 1000,
  start = undefined,
  end = undefined,
}) {
  const url = `${BYBIT_BASE}/v5/market/kline`;
  const { data } = await axios.get(url, {
    params: {
      category,
      symbol,
      interval,
      limit,
      ...(Number.isFinite(start) ? { start } : {}),
      ...(Number.isFinite(end) ? { end } : {}),
    },
    timeout: 12_000,
  });

  const list = data?.result?.list;
  if (!Array.isArray(list)) return [];

  const out = list
    .map((row) => ({
      t: safeNum(row[0]),
      open: safeNum(row[1]),
      high: safeNum(row[2]),
      low: safeNum(row[3]),
      close: safeNum(row[4]),
      volume: safeNum(row[5]),
    }))
    .filter((x) => x.t > 0 && x.close > 0);

  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Paginacja lookback */
export async function fetchKlinesLookback({
  category,
  symbol,
  interval,
  wantBars,
  endMs = Date.now(),
  pageLimit = 1000,
  maxPages = 40,
}) {
  const out = [];
  let end = endMs;

  for (let page = 0; page < maxPages; page++) {
    if (out.length >= wantBars) break;

    const remain = wantBars - out.length;
    const lim = Math.max(1, Math.min(pageLimit, remain));

    const batch = await fetchKlinesPage({ category, symbol, interval, limit: lim, end });
    if (!batch.length) break;

    out.push(...batch);

    const oldestT = batch[0].t;
    end = oldestT - 1;

    if (batch.length < lim) break;
  }

  // dedupe by t
  const map = new Map();
  for (const c of out) map.set(c.t, c);
  const arr = [...map.values()].sort((a, b) => a.t - b.t);

  if (arr.length > wantBars) return arr.slice(arr.length - wantBars);
  return arr;
}

/** Donchian/range box */
export function computeRangeChannel(candles) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return { ok: false, upper: null, lower: null, mid: null, widthPct: null, n: candles?.length || 0 };
  }

  let upper = -Infinity;
  let lower = Infinity;

  for (const c of candles) {
    if (!Number.isFinite(c.high) || !Number.isFinite(c.low)) continue;
    upper = Math.max(upper, c.high);
    lower = Math.min(lower, c.low);
  }

  if (!Number.isFinite(upper) || !Number.isFinite(lower) || upper <= 0 || lower <= 0 || upper <= lower) {
    return { ok: false, upper: null, lower: null, mid: null, widthPct: null, n: candles.length };
  }

  const mid = (upper + lower) / 2;
  const widthPct = mid > 0 ? ((upper - lower) / mid) * 100 : null;

  return { ok: true, upper, lower, mid, widthPct, n: candles.length };
}

export function mean(nums) {
  const xs = (nums || []).filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/* =========================
   Helpers: stats
========================= */

function median(arr) {
  const xs = (arr || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  if (xs.length % 2) return xs[m];
  return (xs[m - 1] + xs[m]) / 2;
}

function quantile(arr, q) {
  const xs = (arr || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const qq = Math.max(0, Math.min(1, Number(q)));
  const pos = (xs.length - 1) * qq;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  const w = pos - lo;
  return xs[lo] * (1 - w) + xs[hi] * w;
}

function linregSlopeFromPoints(points) {
  if (!points || points.length < 2) return 0;
  const n = points.length;
  let sx = 0,
    sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n,
    my = sy / n;

  let num = 0,
    den = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    num += dx * dy;
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

function linregInterceptFromPoints(points, slope) {
  if (!points || !points.length) return 0;
  let sx = 0,
    sy = 0,
    n = 0;
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    sx += p.x;
    sy += p.y;
    n++;
  }
  if (!n) return 0;
  const mx = sx / n;
  const my = sy / n;
  return my - slope * mx;
}

/* =========================
   ATR / TR
========================= */

function trueRange(c, prevClose) {
  const hi = Number(c?.high);
  const lo = Number(c?.low);
  const pc = Number(prevClose);

  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  if (!Number.isFinite(pc)) return hi - lo;

  return Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
}

export function computeATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) {
    return { ok: false, atr: null, n: candles?.length || 0 };
  }

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1]?.close);
    if (Number.isFinite(tr) && tr > 0) trs.push(tr);
  }
  if (trs.length < period) return { ok: false, atr: null, n: candles.length };

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;

  return { ok: true, atr, n: candles.length };
}

/* =========================
   Extrema
========================= */

export function findLocalExtrema(candles, r = 2) {
  const highs = [];
  const lows = [];
  const n = candles.length;
  const R = Math.max(1, Math.floor(r));

  for (let i = R; i < n - R; i++) {
    const hi = Number(candles[i]?.high);
    const lo = Number(candles[i]?.low);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;

    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= R; k++) {
      const hL = Number(candles[i - k]?.high);
      const hR = Number(candles[i + k]?.high);
      const lL = Number(candles[i - k]?.low);
      const lR = Number(candles[i + k]?.low);

      if (![hL, hR, lL, lR].every(Number.isFinite)) {
        isHigh = false;
        isLow = false;
        break;
      }

      if (!(hi >= hL && hi > hR)) isHigh = false;
      if (!(lo <= lL && lo < lR)) isLow = false;

      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }

  return { highs, lows };
}

/**
 * MAX OVERLAP SET dla stref [c-halfW, c+halfW]
 */
function maxOverlapSet(centers, halfW) {
  const cs = (centers || []).map(Number).filter(Number.isFinite);
  if (!cs.length || !(Number.isFinite(halfW) && halfW > 0)) return { bestPoint: null, idxs: [] };

  const events = [];
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i] - halfW;
    const b = cs[i] + halfW;
    events.push({ x: a, d: +1, i });
    events.push({ x: b, d: -1, i });
  }
  events.sort((p, q) => (p.x - q.x) || (q.d - p.d));

  let cur = 0;
  let best = 0;
  let bestX = null;

  for (const e of events) {
    cur += e.d;
    if (cur > best) {
      best = cur;
      bestX = e.x;
    }
  }

  if (!Number.isFinite(bestX)) return { bestPoint: null, idxs: [] };

  const idxs = [];
  for (let i = 0; i < cs.length; i++) {
    if (bestX >= cs[i] - halfW && bestX <= cs[i] + halfW) idxs.push(i);
  }

  return { bestPoint: bestX, idxs };
}

/**
 * ITERACYJNE "REGIME LEVELS" z odwróceń
 */
export function computeRegimeLevelsMultiFromReversals(candles, opts = {}) {
  const {
    extremaRadius = 3,
    zonePctOfRange = 0.02,
    overrideHalfW = null,
    minSwings = 8,
    levels = 3,
  } = opts;

  if (!Array.isArray(candles) || candles.length < 50) {
    return { ok: false, reason: "too_few", n: candles?.length || 0 };
  }

  const rc = computeRangeChannel(candles);
  if (!rc.ok) return { ok: false, reason: "bad_range", n: candles.length };

  const range = rc.upper - rc.lower;
  const halfW =
    Number.isFinite(overrideHalfW) && overrideHalfW > 0 ? overrideHalfW : Math.max(1, range * zonePctOfRange);

  const ex = findLocalExtrema(candles, extremaRadius);
  let swingHighs = ex.highs.map((i) => Number(candles[i]?.high)).filter(Number.isFinite);
  let swingLows = ex.lows.map((i) => Number(candles[i]?.low)).filter(Number.isFinite);

  if (swingHighs.length < minSwings || swingLows.length < minSwings) {
    return {
      ok: false,
      reason: "too_few_swings",
      n: candles.length,
      rangeUpper: rc.upper,
      rangeLower: rc.lower,
      range,
      halfW,
      swingHighs: swingHighs.length,
      swingLows: swingLows.length,
    };
  }

  const outLevels = [];

  for (let k = 0; k < Math.max(1, Math.floor(levels)); k++) {
    if (swingHighs.length < minSwings || swingLows.length < minSwings) break;

    const hi = maxOverlapSet(swingHighs, halfW);
    const lo = maxOverlapSet(swingLows, halfW);

    const hiCenters = hi.idxs.map((j) => swingHighs[j]).filter(Number.isFinite);
    const loCenters = lo.idxs.map((j) => swingLows[j]).filter(Number.isFinite);

    const upper = median(hiCenters);
    const lower = median(loCenters);

    if (!(Number.isFinite(upper) && Number.isFinite(lower) && upper > lower)) break;

    outLevels.push({
      upper,
      lower,
      countHi: hiCenters.length,
      countLo: loCenters.length,
      bestPointHi: hi.bestPoint,
      bestPointLo: lo.bestPoint,
      halfW,
    });

    const hiUsedSet = new Set(hiCenters.map((x) => Number(x)));
    const loUsedSet = new Set(loCenters.map((x) => Number(x)));

    swingHighs = swingHighs.filter((v) => !hiUsedSet.has(Number(v)));
    swingLows = swingLows.filter((v) => !loUsedSet.has(Number(v)));
  }

  return {
    ok: outLevels.length > 0,
    n: candles.length,
    rangeUpper: rc.upper,
    rangeLower: rc.lower,
    range,
    halfW,
    levels: outLevels,
  };
}

/* =========================
   Dominant wedge (trend channel) — bez zmian
========================= */

export function computeRegimeWedgeChannel(candles, opts = {}) {
  const {
    extremaRadius = 2,
    recentIgnoreFracUpper = 0.12,
    trimHighFrac = 0.10,
    trimLowFrac = 0.10,
    upperQ = 0.82,
    lowerQ = 0.18,
    slopeSteps = 31,
    slopeRangeMult = 1.1,
    slopeFallbackAbs = 4.0,
    touchTolPct = 0.002,
    minTouches = 12,
    minInlierRatio = 0.62,
    wInlier = 40.0,
    wTouches = 1.5,
    wWidth = 0.55,
    wOut = 10.0,
    wRecentHigh = 6.0,
  } = opts;

  if (!Array.isArray(candles) || candles.length < 160) {
    return { ok: false, reason: "too_few", n: candles?.length || 0 };
  }

  const n = candles.length;
  const ext = findLocalExtrema(candles, extremaRadius);
  const hiIdxAll = ext.highs;
  const loIdxAll = ext.lows;

  const cutUpper = Math.floor(n * (1 - Math.max(0, Math.min(0.49, recentIgnoreFracUpper))));
  const hiIdx = hiIdxAll.filter((i) => i < cutUpper);
  const loIdx = loIdxAll;

  const hiPts = hiIdx.map((i) => ({ x: i, y: Number(candles[i].high) })).filter((p) => Number.isFinite(p.y));
  const loPts = loIdx.map((i) => ({ x: i, y: Number(candles[i].low) })).filter((p) => Number.isFinite(p.y));

  const mU0 = hiPts.length >= 2 ? linregSlopeFromPoints(hiPts) : 0;
  const mL0 = loPts.length >= 2 ? linregSlopeFromPoints(loPts) : 0;

  const absBase = Math.max(Math.abs(mU0), Math.abs(mL0));
  const range = absBase > 1e-9 ? absBase * slopeRangeMult : slopeFallbackAbs;

  const steps = Math.max(11, Math.floor(slopeSteps));
  const half = Math.floor(steps / 2);

  function slopeAt(m0, k) {
    return m0 + (k * range) / Math.max(1, half);
  }

  function trimmedQuantile(arr, q, trimLoFrac = 0, trimHiFrac = 0) {
    const xs = (arr || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!xs.length) return null;

    const lo = Math.floor(xs.length * Math.max(0, Math.min(0.49, trimLoFrac)));
    const hi = Math.ceil(xs.length * (1 - Math.max(0, Math.min(0.49, trimHiFrac))));
    const ys = xs.slice(lo, Math.max(lo + 1, hi));
    return quantile(ys, q);
  }

  let best = null;

  const closes = new Array(n);
  for (let i = 0; i < n; i++) closes[i] = Number(candles[i]?.close);

  const recentStart = Math.floor(n * 0.85);
  const recentHighs = [];
  for (let i = recentStart; i < n; i++) {
    const h = Number(candles[i]?.high);
    if (Number.isFinite(h)) recentHighs.push(h);
  }
  const recentHighMax = recentHighs.length ? Math.max(...recentHighs) : null;

  for (let ku = -half; ku <= half; ku++) {
    const mU = slopeAt(mU0, ku);

    const upperArr = [];
    for (const i of hiIdx) {
      const h = Number(candles[i]?.high);
      if (Number.isFinite(h)) upperArr.push(h - mU * i);
    }
    if (upperArr.length < 10) continue;

    const bU = trimmedQuantile(upperArr, upperQ, 0, trimHighFrac);
    if (!Number.isFinite(bU)) continue;

    for (let kl = -half; kl <= half; kl++) {
      const mL = slopeAt(mL0, kl);

      const lowerArr = [];
      for (const i of loIdx) {
        const l = Number(candles[i]?.low);
        if (Number.isFinite(l)) lowerArr.push(l - mL * i);
      }
      if (lowerArr.length < 10) continue;

      const bL = trimmedQuantile(lowerArr, lowerQ, trimLowFrac, 0);
      if (!Number.isFinite(bL)) continue;

      const up0 = mU * 0 + bU;
      const dn0 = mL * 0 + bL;
      const up1 = mU * (n - 1) + bU;
      const dn1 = mL * (n - 1) + bL;

      if (!(up0 > dn0 && up1 > dn1 && up0 > 0 && dn0 > 0 && up1 > 0 && dn1 > 0)) continue;

      let okC = 0;
      let inC = 0;
      let outDist = 0;

      for (let i = 0; i < n; i++) {
        const cl = closes[i];
        if (!Number.isFinite(cl) || cl <= 0) continue;
        okC++;
        const up = mU * i + bU;
        const dn = mL * i + bL;
        if (cl >= dn && cl <= up) {
          inC++;
        } else {
          const d = cl > up ? (cl - up) / cl : (dn - cl) / cl;
          outDist += Math.max(0, d);
        }
      }

      const inlierRatio = okC ? inC / okC : 0;
      if (inlierRatio < minInlierRatio) continue;

      let touches = 0;
      for (const i of hiIdx) {
        const h = Number(candles[i]?.high);
        if (!Number.isFinite(h) || h <= 0) continue;
        const up = mU * i + bU;
        const d = Math.abs(up - h) / h;
        if (d <= touchTolPct) touches++;
      }
      for (const i of loIdx) {
        const l = Number(candles[i]?.low);
        if (!Number.isFinite(l) || l <= 0) continue;
        const dn = mL * i + bL;
        const d = Math.abs(l - dn) / l;
        if (d <= touchTolPct) touches++;
      }
      if (touches < minTouches) continue;

      const midEnd = (up1 + dn1) / 2;
      const widthPct = midEnd > 0 ? ((up1 - dn1) / midEnd) * 100 : null;
      if (!Number.isFinite(widthPct)) continue;

      let recentHighPenalty = 0;
      if (Number.isFinite(recentHighMax)) {
        const upEnd = up1;
        const rel = Math.abs(upEnd - recentHighMax) / recentHighMax;
        recentHighPenalty = Math.max(0, 0.003 - rel) / 0.003;
      }

      const score =
        wInlier * inlierRatio +
        wTouches * touches -
        wWidth * widthPct -
        wOut * outDist -
        wRecentHigh * recentHighPenalty;

      if (!best || score > best.score) {
        best = {
          score,
          upperSlope: mU,
          lowerSlope: mL,
          bUpper: bU,
          bLower: bL,
          touches,
          inlierRatio,
          widthPct,
          outDist,
          recentHighPenalty,
          usedHighs: hiIdx.length,
          usedLows: loIdx.length,
          cutUpper,
        };
      }
    }
  }

  if (!best) return { ok: false, reason: "no_fit", n };

  const mU = best.upperSlope;
  const mL = best.lowerSlope;
  const bU = best.bUpper;
  const bL = best.bLower;

  return {
    ok: true,
    n,
    upperSlope: mU,
    lowerSlope: mL,
    bUpper: bU,
    bLower: bL,
    upper0: mU * 0 + bU,
    upper1: mU * (n - 1) + bU,
    lower0: mL * 0 + bL,
    lower1: mL * (n - 1) + bL,
    widthPct: best.widthPct,
    touches: best.touches,
    inlierRatio: best.inlierRatio,
    outDist: best.outDist,
    recentHighPenalty: best.recentHighPenalty,
    meta: {
      extremaRadius,
      recentIgnoreFracUpper,
      trimHighFrac,
      trimLowFrac,
      upperQ,
      lowerQ,
      usedHighs: best.usedHighs,
      usedLows: best.usedLows,
      cutUpper: best.cutUpper,
    },
  };
}

export function findDominantRegimeWedge(candles, opts = {}) {
  const {
    minBars = 240,
    maxBars = 4032,
    stepBars = 60,
    maxWidthPct = 12.0,
    wedgeOpts = {},
    lowerStartShiftFrac = 0.18,
    lengthPenalty = 6.0,
  } = opts;

  if (!Array.isArray(candles) || candles.length < minBars) {
    return { ok: false, reason: "too_few", n: candles?.length || 0 };
  }

  const nAll = candles.length;
  const maxL = Math.min(maxBars, nAll);

  let best = null;

  for (let L = maxL; L >= minBars; L -= stepBars) {
    const slice = candles.slice(nAll - L);
    const ch = computeRegimeWedgeChannel(slice, wedgeOpts);
    if (!ch.ok) continue;

    const w = Number(ch.widthPct);
    if (!Number.isFinite(w) || w > maxWidthPct) continue;

    const inlier = Number(ch.inlierRatio) || 0;
    const touches = Number(ch.touches) || 0;
    const lenFrac = L / maxL;

    const score = inlier * 100.0 + touches * 1.8 - w * 0.9 - lenFrac * lengthPenalty;

    if (!best || score > best.score) best = { score, L, ch, startIndex: nAll - L, endIndex: nAll - 1 };
  }

  if (!best) return { ok: false, reason: "no_candidate", n: nAll };

  const lowerStartOffsetBars = Math.max(0, Math.floor(best.L * Math.max(0, Math.min(0.49, lowerStartShiftFrac))));

  return {
    ok: true,
    startIndex: best.startIndex,
    endIndex: best.endIndex,
    bars: best.L,
    widthPct: best.ch.widthPct,
    touches: best.ch.touches,
    inlierRatio: best.ch.inlierRatio,
    upperSlope: best.ch.upperSlope,
    lowerSlope: best.ch.lowerSlope,
    bUpper: best.ch.bUpper,
    bLower: best.ch.bLower,
    upper0: best.ch.upper0,
    upper1: best.ch.upper1,
    lower0: best.ch.lower0,
    lower1: best.ch.lower1,
    lowerStartOffsetBars,
    meta: best.ch.meta,
  };
}

/* breakout helpers */

export function detectBreakout({ closeNow, upper, lower, breakoutPct = 0.001 }) {
  if (![closeNow, upper, lower].every((x) => Number.isFinite(x) && x > 0)) {
    return { state: "UNKNOWN", reason: "bad_values" };
  }
  const upThr = upper * (1 + breakoutPct);
  const dnThr = lower * (1 - breakoutPct);

  if (closeNow >= upThr) return { state: "BREAKOUT_UP", upThr, dnThr };
  if (closeNow <= dnThr) return { state: "BREAKOUT_DOWN", upThr, dnThr };
  return { state: "IN_CHANNEL", upThr, dnThr };
}

export function detectWedgeBreakout({ closeNow, x, upperSlope, lowerSlope, bUpper, bLower, breakoutPct = 0.001 }) {
  if (![closeNow, x, upperSlope, lowerSlope, bUpper, bLower].every((v) => Number.isFinite(v))) {
    return { state: "UNKNOWN", reason: "bad_values" };
  }
  const upper = upperSlope * x + bUpper;
  const lower = lowerSlope * x + bLower;
  return detectBreakout({ closeNow, upper, lower, breakoutPct });
}

/* =========================
   NEW: HH/HL pattern detector (3 szczyty + 2 dołki)
========================= */

/**
 * Szuka sekwencji H1-L1-H2-L2-H3 (dla UP) lub L1-H1-L2-H2-L3 (dla DOWN),
 * z warunkami HH/HL (UP) albo LL/LH (DOWN).
 *
 * Zwraca:
 *  { ok, dir, H: [idx...], L:[idx...], reason? }
 */
function detectThreePushStructure(candles, i0, i1, opts = {}) {
  const {
    radius = 4,
    minBarsBetween = 10,
    // tolerancje: żeby nie brać mikro-szumu
    minDeltaAtrMult = 0.35,
    atrPeriod = 14,
  } = opts;

  if (!Array.isArray(candles) || i1 - i0 < 80) return { ok: false, reason: "too_short" };

  const slice = candles.slice(i0, i1 + 1);
  const atrR = computeATR(slice, atrPeriod);
  const atr = atrR.ok ? atrR.atr : null;
  if (!(Number.isFinite(atr) && atr > 0)) return { ok: false, reason: "no_atr" };

  const ex = findLocalExtrema(slice, radius);
  const highs = ex.highs.map((j) => i0 + j);
  const lows = ex.lows.map((j) => i0 + j);
  if (highs.length < 3 || lows.length < 2) return { ok: false, reason: "too_few_extrema" };

  function priceAt(idx, type) {
    if (type === "H") return Number(candles[idx]?.high);
    return Number(candles[idx]?.low);
  }

  function okSep(a, b) {
    return b - a >= minBarsBetween;
  }

  // pomoc: filtrujemy tylko "istotne" ekstrema (odstęp cenowy vs ATR)
  function filterSignificant(extIdxs, type) {
    const out = [];
    let lastKept = null;
    for (const idx of extIdxs) {
      const p = priceAt(idx, type);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (lastKept == null) {
        out.push(idx);
        lastKept = idx;
        continue;
      }
      const pLast = priceAt(lastKept, type);
      if (!Number.isFinite(pLast) || pLast <= 0) continue;
      const dp = Math.abs(p - pLast);
      if (dp >= minDeltaAtrMult * atr) {
        out.push(idx);
        lastKept = idx;
      }
    }
    return out;
  }

  const H = filterSignificant(highs, "H");
  const L = filterSignificant(lows, "L");
  if (H.length < 3 || L.length < 2) return { ok: false, reason: "too_few_sig" };

  // Budujemy listę punktów (index + type) posortowaną po czasie
  const pts = [];
  for (const idx of H) pts.push({ idx, type: "H" });
  for (const idx of L) pts.push({ idx, type: "L" });
  pts.sort((a, b) => a.idx - b.idx);

  // Próbujemy znaleźć najpóźniejszą sekwencję 5-punktową spełniającą HH/HL lub LL/LH
  let best = null;

  // UP: H L H L H
  for (let a = 0; a < pts.length; a++) {
    if (pts[a].type !== "H") continue;
    for (let b = a + 1; b < pts.length; b++) {
      if (pts[b].type !== "L") continue;
      if (!okSep(pts[a].idx, pts[b].idx)) continue;

      for (let c = b + 1; c < pts.length; c++) {
        if (pts[c].type !== "H") continue;
        if (!okSep(pts[b].idx, pts[c].idx)) continue;

        for (let d = c + 1; d < pts.length; d++) {
          if (pts[d].type !== "L") continue;
          if (!okSep(pts[c].idx, pts[d].idx)) continue;

          for (let e = d + 1; e < pts.length; e++) {
            if (pts[e].type !== "H") continue;
            if (!okSep(pts[d].idx, pts[e].idx)) continue;

            const h1 = priceAt(pts[a].idx, "H");
            const l1 = priceAt(pts[b].idx, "L");
            const h2 = priceAt(pts[c].idx, "H");
            const l2 = priceAt(pts[d].idx, "L");
            const h3 = priceAt(pts[e].idx, "H");

            if (![h1, l1, h2, l2, h3].every((x) => Number.isFinite(x) && x > 0)) continue;

            // HH + HL
            if (!(h2 > h1 && h3 > h2)) continue;
            if (!(l2 > l1)) continue;

            // korekty powyżej poprzednich dołków (już mamy l2 > l1),
            // + dodatkowo: dołki nie mogą wchodzić "za daleko" w przeciwną stronę:
            // wymuszamy, żeby dołki były "w pobliżu" trendu (vs ATR)
            if ((h2 - l1) < 1.0 * atr) continue;
            if ((h3 - l2) < 1.0 * atr) continue;

            // wybieramy najpóźniejszy (e.idx największe)
            const cand = {
              ok: true,
              dir: "UP",
              highs: [pts[a].idx, pts[c].idx, pts[e].idx],
              lows: [pts[b].idx, pts[d].idx],
              prices: { h1, h2, h3, l1, l2 },
              endIdx: pts[e].idx,
            };

            if (!best || cand.endIdx > best.endIdx) best = cand;
          }
        }
      }
    }
  }

  // DOWN: L H L H L
  for (let a = 0; a < pts.length; a++) {
    if (pts[a].type !== "L") continue;
    for (let b = a + 1; b < pts.length; b++) {
      if (pts[b].type !== "H") continue;
      if (!okSep(pts[a].idx, pts[b].idx)) continue;

      for (let c = b + 1; c < pts.length; c++) {
        if (pts[c].type !== "L") continue;
        if (!okSep(pts[b].idx, pts[c].idx)) continue;

        for (let d = c + 1; d < pts.length; d++) {
          if (pts[d].type !== "H") continue;
          if (!okSep(pts[c].idx, pts[d].idx)) continue;

          for (let e = d + 1; e < pts.length; e++) {
            if (pts[e].type !== "L") continue;
            if (!okSep(pts[d].idx, pts[e].idx)) continue;

            const l1 = priceAt(pts[a].idx, "L");
            const h1 = priceAt(pts[b].idx, "H");
            const l2 = priceAt(pts[c].idx, "L");
            const h2 = priceAt(pts[d].idx, "H");
            const l3 = priceAt(pts[e].idx, "L");

            if (![l1, h1, l2, h2, l3].every((x) => Number.isFinite(x) && x > 0)) continue;

            // LL + LH
            if (!(l2 < l1 && l3 < l2)) continue;
            if (!(h2 < h1)) continue;

            if ((h1 - l2) < 1.0 * atr) continue;
            if ((h2 - l3) < 1.0 * atr) continue;

            const cand = {
              ok: true,
              dir: "DOWN",
              highs: [pts[b].idx, pts[d].idx],
              lows: [pts[a].idx, pts[c].idx, pts[e].idx],
              prices: { l1, l2, l3, h1, h2 },
              endIdx: pts[e].idx,
            };

            if (!best || cand.endIdx > best.endIdx) best = cand;
          }
        }
      }
    }
  }

  if (!best) return { ok: false, reason: "no_3push" };
  return best;
}

/* =========================
   NEW: BOX → BREAKOUT → 3-PUSH HH/HL detector
   (to jest to, co “kłuje w oczy” na screenie)
========================= */

/**
 * Wybiera NAJPÓŹNIEJSZE zdarzenie (nie najlepszy score),
 * o ile:
 * - jest boczniak (box)
 * - jest breakout
 * - po wybiciu widać “3 szczyty + dołki wyżej” (UP) lub analogicznie DOWN
 */
export function detectBoxBreakoutThreePush(candles, opts = {}) {
  const {
    preBars = 520,
    minInsideFrac = 0.88,
    maxSidewaysWidthPct = 7.5,
    breakoutPct = 0.0012,

    // pattern window po wybiciu
    postMin = 180,
    postMax = 1200,

    // extrema/pattern
    patternRadius = 5,
    patternMinBarsBetween = 10,
    patternMinDeltaAtrMult = 0.35,

    // filtr: ostatnia cena po stronie wybicia
    currentSideAtrMult = 0.8,

    atrPeriod = 14,
    recencyLookbackBars = 1200,
  } = opts;

  if (!Array.isArray(candles) || candles.length < preBars + postMin + 30) {
    return { ok: false, reason: "too_few", n: candles?.length || 0 };
  }

  const n = candles.length;
  const lastIdx = n - 1;
  const lastClose = Number(candles[lastIdx]?.close);
  if (!(Number.isFinite(lastClose) && lastClose > 0)) return { ok: false, reason: "bad_last" };

  // skan: szukamy najpóźniejszego poprawnego zdarzenia
  const scanStart = Math.max(preBars, n - recencyLookbackBars);
  const scanEnd = n - postMin - 2;

  for (let i = scanEnd; i >= scanStart; i--) {
    const b0 = i - preBars;
    const b1 = i - 1;
    if (b0 < 0) continue;

    const boxSlice = candles.slice(b0, b1 + 1);
    const rc = computeRangeChannel(boxSlice);
    if (!rc.ok) continue;

    const widthPct = Number(rc.widthPct);
    if (!Number.isFinite(widthPct) || widthPct > maxSidewaysWidthPct) continue;

    let okC = 0,
      inC = 0;
    for (let k = b0; k <= b1; k++) {
      const cl = Number(candles[k]?.close);
      if (!Number.isFinite(cl) || cl <= 0) continue;
      okC++;
      if (cl >= rc.lower && cl <= rc.upper) inC++;
    }
    const insideFrac = okC ? inC / okC : 0;
    if (insideFrac < minInsideFrac) continue;

    const cNow = Number(candles[i]?.close);
    if (!(Number.isFinite(cNow) && cNow > 0)) continue;

    const upThr = rc.upper * (1 + breakoutPct);
    const dnThr = rc.lower * (1 - breakoutPct);

    let dir = null;
    if (cNow >= upThr) dir = "UP";
    else if (cNow <= dnThr) dir = "DOWN";
    else continue;

    // ATR box
    const atrBox = computeATR(boxSlice, atrPeriod);
    if (!atrBox.ok || !(atrBox.atr > 0)) continue;

    // lastClose musi być po stronie wybicia (i nie “na styk”)
    if (dir === "UP") {
      const side = (lastClose - rc.upper) / atrBox.atr;
      if (side < currentSideAtrMult) continue;
    } else {
      const side = (rc.lower - lastClose) / atrBox.atr;
      if (side < currentSideAtrMult) continue;
    }

    // pattern window: po wybiciu
    const p0 = i;
    const p1 = Math.min(lastIdx, i + postMax);
    const minEnd = Math.min(lastIdx, i + postMin);

    // szukamy 3-push w najdłuższym oknie, ale wymagamy że końcówka jest “świeża”
    // (czyli pattern kończy się relatywnie blisko prawej strony)
    const pat = detectThreePushStructure(candles, p0, p1, {
      radius: patternRadius,
      minBarsBetween: patternMinBarsBetween,
      minDeltaAtrMult: patternMinDeltaAtrMult,
      atrPeriod,
    });
    if (!pat.ok) continue;

    if (pat.dir !== dir) continue;

    // pattern musi się kończyć po minEnd (żeby to był “ten” ruch, a nie wczesny szum)
    if (pat.endIdx < minEnd) continue;

    return {
      ok: true,
      direction: dir,
      box: {
        startIndex: b0,
        endIndex: b1,
        upper: rc.upper,
        lower: rc.lower,
        widthPct,
        insideFrac,
        preBars,
      },
      breakout: {
        index: i,
        close: cNow,
        upThr,
        dnThr,
        atrBox: atrBox.atr,
      },
      pattern: pat,
      meta: {
        lastClose,
        recencyBars: lastIdx - i,
      },
    };
  }

  return { ok: false, reason: "no_event", n };
}

/* =========================
   (opcjonalnie) legacy: wcześniejszy impulseTrend export
   zostawiam jako alias żeby nic Ci się nie rozsypało,
   jeśli gdzieś już to wołasz.
========================= */
export function detectBoxImpulseTrend(candles, opts = {}) {
  return detectBoxBreakoutThreePush(candles, opts);
}

/* =========================
   NEW: Sideways trend frames (np. 4h)
========================= */

export function detectSidewaysTrendFrames(candles, opts = {}) {
  const {
    minBars = 60,
    maxBars = 260,
    lengthStep = 10,
    scanStep = 4,
    maxFrames = 6,

    // dopuszczamy mikro-odchylenia trendowe, ale dalej „boczny”
    maxSlopePctPerBar = 0.0012,
    maxWidthPct = 14.0,
    minInlierRatio = 0.68,

    upperQ = 0.90,
    lowerQ = 0.10,
    touchTolPct = 0.003,

    // zawężenie strefy: nie celujemy w idealne ekstremy
    narrowPct = 0.0035,
  } = opts;

  if (!Array.isArray(candles) || candles.length < minBars + 5) {
    return { ok: false, reason: "too_few", n: candles?.length || 0, frames: [] };
  }

  const n = candles.length;
  const Lmin = Math.max(20, Math.floor(minBars));
  const Lmax = Math.max(Lmin, Math.min(Math.floor(maxBars), n));

  function overlapFrac(a0, a1, b0, b1) {
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    if (hi < lo) return 0;
    const inter = hi - lo + 1;
    const lenA = a1 - a0 + 1;
    const lenB = b1 - b0 + 1;
    return inter / Math.max(1, Math.min(lenA, lenB));
  }

  function fitWindow(startIndex, endIndex) {
    const L = endIndex - startIndex + 1;
    if (L < Lmin) return null;

    const highs = [];
    const lows = [];
    const closes = [];

    for (let gi = startIndex; gi <= endIndex; gi++) {
      const x = gi - startIndex;
      const h = Number(candles[gi]?.high);
      const l = Number(candles[gi]?.low);
      const c = Number(candles[gi]?.close);

      if (Number.isFinite(h) && h > 0) highs.push({ x, y: h });
      if (Number.isFinite(l) && l > 0) lows.push({ x, y: l });
      if (Number.isFinite(c) && c > 0) closes.push(c);
    }

    if (highs.length < Math.max(20, Math.floor(L * 0.55))) return null;
    if (lows.length < Math.max(20, Math.floor(L * 0.55))) return null;
    if (closes.length < Math.max(20, Math.floor(L * 0.60))) return null;

    const mU = linregSlopeFromPoints(highs);
    const mL = linregSlopeFromPoints(lows);

    const medClose = median(closes);
    if (!(Number.isFinite(medClose) && medClose > 0)) return null;

    const slopeUrel = Math.abs(mU) / medClose;
    const slopeLrel = Math.abs(mL) / medClose;
    if (slopeUrel > maxSlopePctPerBar || slopeLrel > maxSlopePctPerBar) return null;

    const buArr = highs.map((p) => p.y - mU * p.x);
    const blArr = lows.map((p) => p.y - mL * p.x);

    const bU0 = quantile(buArr, upperQ);
    const bL0 = quantile(blArr, lowerQ);
    if (!Number.isFinite(bU0) || !Number.isFinite(bL0)) return null;

    // zawężenie: górę obniżamy, dół podnosimy o narrowPct ceny linii
    const bU = bU0 * (1 - narrowPct);
    const bL = bL0 * (1 + narrowPct);

    let okC = 0;
    let inC = 0;
    let touchHi = 0;
    let touchLo = 0;
    let widthAcc = 0;
    let widthN = 0;

    for (let gi = startIndex; gi <= endIndex; gi++) {
      const x = gi - startIndex;

      const up = mU * x + bU;
      const dn = mL * x + bL;
      if (!(Number.isFinite(up) && Number.isFinite(dn) && up > dn && up > 0 && dn > 0)) return null;

      const cl = Number(candles[gi]?.close);
      if (Number.isFinite(cl) && cl > 0) {
        okC++;
        if (cl >= dn && cl <= up) inC++;
      }

      const hh = Number(candles[gi]?.high);
      if (Number.isFinite(hh) && hh > 0) {
        const rel = Math.abs(hh - up) / hh;
        if (rel <= touchTolPct) touchHi++;
      }

      const ll = Number(candles[gi]?.low);
      if (Number.isFinite(ll) && ll > 0) {
        const rel = Math.abs(ll - dn) / ll;
        if (rel <= touchTolPct) touchLo++;
      }

      const mid = (up + dn) / 2;
      if (mid > 0) {
        widthAcc += ((up - dn) / mid) * 100;
        widthN++;
      }
    }

    const inlierRatio = okC ? inC / okC : 0;
    if (inlierRatio < minInlierRatio) return null;

    const widthPct = widthN ? widthAcc / widthN : null;
    if (!(Number.isFinite(widthPct) && widthPct > 0 && widthPct <= maxWidthPct)) return null;

    const slopePenalty = (slopeUrel + slopeLrel) * 10000;
    const score = inlierRatio * 100 + (touchHi + touchLo) * 0.8 - widthPct * 0.9 - slopePenalty;

    const x0 = 0;
    const x1 = L - 1;

    return {
      ok: true,
      startIndex,
      endIndex,
      bars: L,
      upperSlope: mU,
      lowerSlope: mL,
      bUpper: bU,
      bLower: bL,
      upper0: mU * x0 + bU,
      upper1: mU * x1 + bU,
      lower0: mL * x0 + bL,
      lower1: mL * x1 + bL,
      inlierRatio,
      widthPct,
      touches: touchHi + touchLo,
      narrowPct,
      score,
      slopeRelUpper: slopeUrel,
      slopeRelLower: slopeLrel,
    };
  }

  const candidates = [];

  for (let L = Lmax; L >= Lmin; L -= Math.max(1, lengthStep)) {
    for (let end = L - 1; end < n; end += Math.max(1, scanStep)) {
      const start = end - L + 1;
      const fit = fitWindow(start, end);
      if (fit?.ok) candidates.push(fit);
    }
  }

  if (!candidates.length) {
    return { ok: false, reason: "no_fit", n, frames: [] };
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.endIndex - a.endIndex));

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxFrames) break;

    let tooClose = false;
    for (const p of picked) {
      const ov = overlapFrac(c.startIndex, c.endIndex, p.startIndex, p.endIndex);
      if (ov >= 0.55) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) picked.push(c);
  }

  picked.sort((a, b) => a.startIndex - b.startIndex);

  return {
    ok: picked.length > 0,
    n,
    frames: picked,
    params: {
      minBars: Lmin,
      maxBars: Lmax,
      lengthStep,
      scanStep,
      narrowPct,
      maxSlopePctPerBar,
      maxWidthPct,
      minInlierRatio,
    },
  };
}

export function iso(ts) {
  return new Date(ts).toISOString();
}