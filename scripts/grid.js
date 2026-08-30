// scripts/grid.js — BOT 8.6 (uproszczona wersja)
// ZMIANY vs 8.5:
//   - HALO_SPACING_ALPHA: zakodowane 0.9
//   - GAP_SPACING_SCALE: zakodowane 0 (było 0.1 — dodawało extra spread)
//   - HALO_BUDGET_WEAK_X/STRONG_X: zakodowane 1.0/1.1
//   - SPACING_BUFFER_PCT: usunięte (FEE_GUARD_MODE=actual nie używa go)
import { CONFIG } from "../config.js";

/**
 * Fee-guard: spacing musi pokryć fee + bufor (2x fee bo buy->sell pętla).
 */
export function computeFeeGuardSpacingPct(feeRate) {
  // BOT 8.6: SPACING_BUFFER_PCT removed — FEE_GUARD_MODE="actual" doesn't need it
  const feePct = (feeRate || 0) * 100;
  const mode = String(CONFIG.FEE_GUARD_MODE || "actual").toLowerCase();
  if (mode === "double") {
    return Math.max(0, 2 * feePct);
  }
  return Math.max(0, feePct);
}

function pctToMult(pct) {
  return pct / 100;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function uniqPrices(arr, decimals = 10) {
  const set = new Set();
  const out = [];
  for (const p of arr) {
    const n = Number(p);
    if (!Number.isFinite(n)) continue;
    const k = n.toFixed(decimals);
    if (!set.has(k)) {
      set.add(k);
      out.push(Number(k));
    }
  }
  return out;
}

function sortByPriceAsc(list) {
  return [...list].sort((a, b) => a - b);
}

function mean(arr) {
  if (!arr?.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr, mu) {
  if (!arr?.length) return 0;
  const m = Number.isFinite(mu) ? mu : mean(arr);
  const v = arr.reduce((a, x) => a + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(Math.max(0, v));
}

function isNear(a, b) {
  const x = Number(a),
    y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const tolAbs = CONFIG.CLUSTER_MATCH_TOL_ABS ?? 0.5;
  const tolRel = CONFIG.CLUSTER_MATCH_TOL_REL ?? 0.000002;
  const tol = Math.max(tolAbs, Math.abs(y) * tolRel);
  return Math.abs(x - y) <= tol;
}

/* =========================
   SPACING
   - twarda dolna granica: baseSpacingPct (MICRO + feeGuard)
========================= */
function normStrength(s, sMin, sMax) {
  if (!Number.isFinite(s) || !Number.isFinite(sMin) || !Number.isFinite(sMax)) return 0;
  const span = Math.max(1e-12, sMax - sMin);
  return clamp((s - sMin) / span, 0, 1);
}

// spacingPct = baseSpacingPct * (1 - alpha*S_norm) + gapPct*gapScale, ale >= baseSpacingPct
function computeSpacingPct({ baseSpacingPct, alpha, sNorm, gapPct, gapScale }) {
  const tight = baseSpacingPct * (1 - alpha * sNorm);
  const widened = tight + (gapPct || 0) * (gapScale || 0);
  return Math.max(baseSpacingPct, widened);
}

function haloOrdersCount(sNorm) {
  const minO = CONFIG.HALO_MIN_ORDERS ?? 1;
  const maxO = CONFIG.HALO_MAX_ORDERS ?? 4;
  return Math.round(minO + sNorm * (maxO - minO));
}

function gapPctToNeighbor(list, idx) {
  const cur = list[idx];
  const prev = list[idx - 1];
  const next = list[idx + 1];
  const d1 = prev ? Math.abs(cur.cluster_price - prev.cluster_price) : Infinity;
  const d2 = next ? Math.abs(next.cluster_price - cur.cluster_price) : Infinity;
  const d = Math.min(d1, d2);
  if (!Number.isFinite(d) || d === Infinity) return 0;
  return (d / Math.max(1e-12, cur.cluster_price)) * 100;
}

function buildHaloPricesTowardMid({ clusterPrice, midPrice, side, spacingPct, maxBetween }) {
  const out = [];
  const stepMult = pctToMult(spacingPct);

  if (!Number.isFinite(clusterPrice) || !Number.isFinite(midPrice) || midPrice <= 0) return out;
  if (maxBetween <= 0) return out;

  if (side === "Buy") {
    let p = clusterPrice;
    for (let i = 0; i < maxBetween; i++) {
      p = p * (1 + stepMult);
      if (p >= midPrice) break;
      out.push(p);
    }
  } else {
    let p = clusterPrice;
    for (let i = 0; i < maxBetween; i++) {
      p = p * (1 - stepMult);
      if (p <= midPrice) break;
      out.push(p);
    }
  }
  return out;
}

function ladderFromMid(mid, spacingPct, n, dir) {
  const out = [];
  const stepMult = pctToMult(spacingPct);
  let p = mid;
  for (let i = 0; i < n; i++) {
    p = dir < 0 ? p * (1 - stepMult) : p * (1 + stepMult);
    out.push(p);
  }
  return out;
}

function extendCandidatesIfNeeded({ side, mid, baseSpacingPct, candidatesAsc, needAtLeast }) {
  const out = Array.isArray(candidatesAsc) ? [...candidatesAsc] : [];
  const need = Math.max(0, Number(needAtLeast || 0));
  if (out.length >= need) return out;

  const fallbackN = Math.min(Number(CONFIG.MAX_LEVELS_PER_SIDE ?? 30), 60);
  const mult = Math.max(2, Number(CONFIG.EXTEND_LADDER_MULT ?? 6));
  const minLen = Math.max(10, Number(CONFIG.EXTEND_LADDER_MIN ?? 30));
  const ladderLen = Math.max(minLen, fallbackN * mult);

  const ladder =
    side === "Buy"
      ? ladderFromMid(mid, baseSpacingPct, ladderLen, -1).filter((p) => p < mid)
      : ladderFromMid(mid, baseSpacingPct, ladderLen, +1).filter((p) => p > mid);

  return sortByPriceAsc(uniqPrices([...out, ...ladder]));
}

/* =========================
   MIN GAP enforcement (final safety)
========================= */
function enforceMinStep({ prices, side, baseSpacingPct, mid }) {
  const stepMult = pctToMult(baseSpacingPct);
  if (!Array.isArray(prices) || !prices.length) return [];

  const arr =
    side === "Buy"
      ? [...prices].filter((p) => p < mid).sort((a, b) => b - a)
      : [...prices].filter((p) => p > mid).sort((a, b) => a - b);

  const out = [];
  let prev = null;

  for (const p of arr) {
    if (!Number.isFinite(p) || p <= 0) continue;
    if (prev == null) {
      out.push(p);
      prev = p;
      continue;
    }
    if (side === "Buy") {
      if (p <= prev * (1 - stepMult)) {
        out.push(p);
        prev = p;
      }
    } else {
      if (p >= prev * (1 + stepMult)) {
        out.push(p);
        prev = p;
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/* =========================
   BUDGET BONUS (Twoja specyfikacja)
========================= */
function sigmaInfluence(zAbs) {
  const z = Math.abs(Number(zAbs) || 0);
  if (z <= 1) return 0;
  if (z <= 2) return 0.33;
  if (z <= 3) return 0.66;
  return 1.0;
}

function fieldInfluencePct({ dPct, innerPct, outerPct }) {
  const d = Math.abs(Number(dPct) || 0);
  const inner = Math.max(0, Number(innerPct) || 0);
  const outer = Math.max(inner, Number(outerPct) || inner);

  if (d <= inner) return 1.0;
  if (d >= outer) return 0.0;

  const x = (d - inner) / Math.max(1e-12, outer - inner); // 0..1
  return Math.sqrt(Math.max(0, 1 - x * x)); // ćwiartka koła
}

function nearestCluster(price, clusters) {
  if (!Array.isArray(clusters) || !clusters.length) return null;
  const p = Number(price);
  if (!Number.isFinite(p)) return null;

  let best = null;
  let bestD = Infinity;
  for (const c of clusters) {
    const cp = Number(c?.cluster_price);
    if (!Number.isFinite(cp) || cp <= 0) continue;
    const d = Math.abs(p - cp);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function notionalForLevel({
  side,
  price,
  clustersSide,
  mu,
  sd,
  baseSpacingPct,
  baseNotional,
  minOrder,
}) {
  // BOT 8.6: hardcoded (były w configu jako HALO_BUDGET_WEAK_X/STRONG_X)
  const weakX = 1.0;
  const strongX = 1.0;

  const innerPct = Number(CONFIG.CLUSTER_FIELD_INNER_PCT ?? 0.1);
  const outerMult = Number(CONFIG.CLUSTER_FIELD_OUTER_LADDER_MULT ?? 1.5);
  const outerPct = innerPct + outerMult * Number(baseSpacingPct || 0);

  const c = nearestCluster(price, clustersSide);
  if (!c) return Math.max(minOrder, baseNotional);

  const cp = Number(c.cluster_price);
  const s = Number(c.cluster_strength);

  const dPct = ((Number(price) - cp) / Math.max(1e-12, cp)) * 100;
  const field = fieldInfluencePct({ dPct, innerPct, outerPct });

  let z = 0;
  if (Number.isFinite(sd) && sd > 1e-12 && Number.isFinite(s)) z = (s - mu) / sd;
  const sig = sigmaInfluence(Math.abs(z));

  const influence = field * sig;

  let mult = 1.0;
  if (z > 0) mult = 1 + (strongX - 1) * influence;
  else if (z < 0) mult = 1 + (weakX - 1) * influence;

  const minMult = Math.min(1, weakX);
  const maxMult = Math.max(1, strongX);
  mult = clamp(mult, minMult, maxMult);

  const n = baseNotional * mult;
  return Math.max(minOrder, n);
}

/* =========================
   ADAPTIVE DECAY: blend toward neutral at distance from mid
========================= */
function decayTowardNeutral({ adaptiveNotional, neutralNotional, price, mid, spacingPct }) {
  const distPct = Math.abs(price - mid) / Math.max(1e-12, mid) * 100;
  const startLevels = Math.max(0, Number(CONFIG.GRID_ADAPTIVE_DECAY_START_LEVELS ?? 3));
  const endLevels = Math.max(startLevels + 1, Number(CONFIG.GRID_ADAPTIVE_DECAY_END_LEVELS ?? 12));
  const startPct = startLevels * spacingPct;
  const endPct = endLevels * spacingPct;

  if (distPct <= startPct) return adaptiveNotional;
  if (distPct >= endPct) return neutralNotional;

  const t = (distPct - startPct) / Math.max(1e-12, endPct - startPct);
  return adaptiveNotional * (1 - t) + neutralNotional * t;
}

/* =========================
   PICK LEVELS
========================= */
function key6(x) {
  return Number(x).toFixed(6);
}

function pickLevels({ candidatesAsc, takeN, side, mid, baseSpacingPct, weightFn }) {
  const policy = String(CONFIG.PICK_LEVELS_POLICY || "closest").toLowerCase();
  if (!Array.isArray(candidatesAsc) || takeN <= 0) return [];

  const cands = candidatesAsc
    .filter((p) => Number.isFinite(p) && p > 0)
    .filter((p) => (side === "Buy" ? p < mid : p > mid));

  if (policy === "weighted") {
    const scored = cands.map((p) => ({
      p,
      w: Number.isFinite(weightFn?.(p)) ? Number(weightFn(p)) : 1.0,
      d: Math.abs(p - mid),
    }));

    scored.sort((a, b) => {
      if (b.w !== a.w) return b.w - a.w;
      return a.d - b.d;
    });

    const picked = [];
    for (const it of scored) {
      if (picked.length >= takeN) break;
      let ok = true;
      for (const q of picked) {
        const rel = (Math.abs(it.p - q) / Math.max(1e-12, q)) * 100;
        if (rel < baseSpacingPct * 0.999) {
          ok = false;
          break;
        }
      }
      if (ok) picked.push(it.p);
    }

    const enforced = enforceMinStep({ prices: picked, side, baseSpacingPct, mid });
    return enforced.slice(0, takeN);
  }

  const picked = side === "Buy" ? cands.slice(-takeN) : cands.slice(0, takeN);
  const enforced = enforceMinStep({ prices: picked, side, baseSpacingPct, mid });

  if (enforced.length < takeN) {
    const order = side === "Buy" ? [...cands].sort((a, b) => b - a) : [...cands].sort((a, b) => a - b);
    for (const p of order) {
      if (enforced.length >= takeN) break;
      if (enforced.some((q) => (Math.abs(p - q) / Math.max(1e-12, q)) * 100 < baseSpacingPct * 0.999)) continue;
      enforced.push(p);
    }
  }
  return enforceMinStep({ prices: enforced, side, baseSpacingPct, mid }).slice(0, takeN);
}

/* =========================
   ANCHORS FOR STATE_VIEW
========================= */
function toAnchor(a) {
  const cp = Number(a?.cluster_price);
  const cs = Number(a?.cluster_strength);
  const sz = Number(a?.strength_zone);
  return {
    cluster_price: Number.isFinite(cp) ? cp : null,
    cluster_strength: Number.isFinite(cs) ? cs : undefined,
    strength_zone: Number.isFinite(sz) ? sz : undefined,
  };
}

function pickClosestAnchors(sortedClusters, mid, count) {
  return (sortedClusters || [])
    .filter((c) => Number.isFinite(c.cluster_price) && c.cluster_price > 0)
    .map((c) => ({ ...c, _d: Math.abs(c.cluster_price - mid) }))
    .sort((a, b) => a._d - b._d)
    .slice(0, Math.max(0, count))
    .map((c) => {
      const { _d, ...rest } = c;
      return rest;
    });
}

function pickMajor(list) {
  if (!Array.isArray(list) || !list.length) return null;
  let best = null;
  let bestS = -Infinity;
  for (const c of list) {
    const s = Number(c?.cluster_strength);
    if (!Number.isFinite(s)) continue;
    if (s > bestS) {
      bestS = s;
      best = c;
    }
  }
  return best ? toAnchor(best) : null;
}

/* =========================
   MAIN
========================= */
export function buildGrid({ midPrice, clustersZoned, balances, feeRate, strategyPolicy = null }) {
  const mid = Number(midPrice);
  const feeGuardPct = computeFeeGuardSpacingPct(feeRate);
  if (!Number.isFinite(mid) || mid <= 0) {
    return { feeGuardPct, orders: [], anchorsUsed: [], majorBelow: null, majorAbove: null };
  }

  const policy = strategyPolicy || {};
  const allowNewBuys = policy.allowNewBuys !== false;
  const allowNewSells = policy.allowNewSells !== false;
  const spacingMultBuy = Math.max(0.6, Number(policy.spacingMultBuy ?? 1));
  const spacingMultSell = Math.max(0.6, Number(policy.spacingMultSell ?? 1));
  const orderCountMultBuy = Math.max(0, Number(policy.orderCountMultBuy ?? 1));
  const orderCountMultSell = Math.max(0, Number(policy.orderCountMultSell ?? 1));
  const capitalUsagePct = Math.max(0.1, Math.min(1, Number(policy.capitalUsagePct ?? 1)));

  const micro = CONFIG.MICRO_SPACING_PCT ?? 0.15;
  const baseSpacingPct = micro + feeGuardPct;
  const buyBaseSpacingPct = baseSpacingPct * spacingMultBuy;
  const sellBaseSpacingPct = baseSpacingPct * spacingMultSell;

  const raw = Array.isArray(clustersZoned) ? clustersZoned : [];
  const sorted = raw
    .map((c) => ({
      ...c,
      cluster_price: Number(c.cluster_price),
      cluster_strength: Number(c.cluster_strength),
      strength_zone: Number(c.strength_zone),
    }))
    .filter((c) => Number.isFinite(c.cluster_price) && c.cluster_price > 0)
    .sort((a, b) => a.cluster_price - b.cluster_price);

  const belowAll = sorted.filter((c) => c.cluster_price < mid);
  const aboveAll = sorted.filter((c) => c.cluster_price > mid);

  const legacyN = Number(CONFIG.CLUSTER_GAPS_EACH_SIDE ?? 4);
  const N_BUY = Number(CONFIG.CLUSTER_GAPS_BUY_SIDE ?? legacyN);
  const N_SELL = Number(CONFIG.CLUSTER_GAPS_SELL_SIDE ?? legacyN);

  const below = belowAll.slice(-Math.max(0, N_BUY));
  const above = aboveAll.slice(0, Math.max(0, N_SELL));

  // anchorsUsed
  let anchors = [...below, ...above].sort((a, b) => a.cluster_price - b.cluster_price);
  if (!anchors.length && sorted.length) {
    anchors = pickClosestAnchors(sorted, mid, Math.max(2, 2 * Math.max(N_BUY, N_SELL)));
    anchors.sort((a, b) => a.cluster_price - b.cluster_price);
  }
  const anchorsUsed = anchors.map(toAnchor).filter((a) => Number.isFinite(a.cluster_price));

  // strength stats for sigma (prefer anchors; fallback all)
  const strengthSource = anchors.length ? anchors : sorted;
  const strengths = strengthSource.map((a) => Number(a.cluster_strength)).filter((v) => Number.isFinite(v));
  const mu = strengths.length ? mean(strengths) : 0;
  const sd = strengths.length ? stddev(strengths, mu) : 0;

  // Budżety: bez równoważenia
  const baseFree = Number(balances?.base ?? 0);
  const quoteFree = Number(balances?.quote ?? 0);
  const buyBudgetTotal = allowNewBuys ? Math.max(0, quoteFree * capitalUsagePct) : 0;
  const sellBudgetQuoteEq = allowNewSells ? Math.max(0, baseFree * mid * capitalUsagePct) : 0;

  const perOrder = Number(CONFIG.ORDER_QUOTE_VALUE ?? 5);
  // BOT 8.4: equal sizing for all levels (OVM removed)
  const perOrderBuy = perOrder;
  const perOrderSell = perOrder;
  const minOrderCfg = Number(CONFIG.MIN_ORDER_QUOTE ?? 1.5);
  const effectiveMinOrder = Math.max(0, Number.isFinite(minOrderCfg) ? Math.min(minOrderCfg, perOrder) : perOrder);
  const baseNotionalBuy = Math.max(0, perOrderBuy);
  const baseNotionalSell = Math.max(0, perOrderSell);

  const hardMaxPerSide = Number(CONFIG.MAX_LEVELS_PER_SIDE ?? 30);
  const buyMaxRaw = Math.min(
    Math.floor(buyBudgetTotal / Math.max(1e-12, effectiveMinOrder || perOrder || 1e-12)),
    hardMaxPerSide
  );
  const sellMaxRaw = Math.min(
    Math.floor(sellBudgetQuoteEq / Math.max(1e-12, effectiveMinOrder || perOrder || 1e-12)),
    hardMaxPerSide
  );

  const buyMax = allowNewBuys ? Math.max(0, Math.floor(buyMaxRaw * orderCountMultBuy)) : 0;
  const sellMax = allowNewSells ? Math.max(0, Math.floor(sellMaxRaw * orderCountMultSell)) : 0;

  // local sMin/sMax for halo squeeze
  const locStrengths = (anchors.length ? anchors : sorted)
    .map((a) => Number(a.cluster_strength))
    .filter((v) => Number.isFinite(v));
  const sMin = locStrengths.length ? Math.min(...locStrengths) : 0;
  const sMax = locStrengths.length ? Math.max(...locStrengths) : 1;

  // candidates from halos
  const buyPrices = [];
  const sellPrices = [];

  for (let i = 0; i < below.length; i++) {
    const c = below[i];
    const sNorm = normStrength(Number(c.cluster_strength), sMin, sMax);
    const haloK = haloOrdersCount(sNorm);

    const gapPct = gapPctToNeighbor(below, i);
    // BOT 8.6: HALO_SPACING_ALPHA=0.9, GAP_SPACING_SCALE=0 (hardcoded)
    const spacingPct = computeSpacingPct({
      baseSpacingPct: buyBaseSpacingPct,
      alpha: 0.9,
      sNorm,
      gapPct,
      gapScale: 0,
    });

    buyPrices.push(c.cluster_price);
    const maxBetween = Math.min(CONFIG.MAX_ORDERS_BETWEEN_CLUSTERS ?? 10, haloK);
    buyPrices.push(
      ...buildHaloPricesTowardMid({
        clusterPrice: c.cluster_price,
        midPrice: mid,
        side: "Buy",
        spacingPct,
        maxBetween,
      })
    );
  }

  for (let i = 0; i < above.length; i++) {
    const c = above[i];
    const sNorm = normStrength(Number(c.cluster_strength), sMin, sMax);
    const haloK = haloOrdersCount(sNorm);

    const gapPct = gapPctToNeighbor(above, i);
    // BOT 8.6: HALO_SPACING_ALPHA=0.9, GAP_SPACING_SCALE=0 (hardcoded)
    const spacingPct = computeSpacingPct({
      baseSpacingPct: sellBaseSpacingPct,
      alpha: 0.9,
      sNorm,
      gapPct,
      gapScale: 0,
    });

    sellPrices.push(c.cluster_price);
    const maxBetween = Math.min(CONFIG.MAX_ORDERS_BETWEEN_CLUSTERS ?? 10, haloK);
    sellPrices.push(
      ...buildHaloPricesTowardMid({
        clusterPrice: c.cluster_price,
        midPrice: mid,
        side: "Sell",
        spacingPct,
        maxBetween,
      })
    );
  }

  let buyCandidates = sortByPriceAsc(uniqPrices(buyPrices)).filter((p) => p < mid);
  let sellCandidates = sortByPriceAsc(uniqPrices(sellPrices)).filter((p) => p > mid);

  buyCandidates = extendCandidatesIfNeeded({
    side: "Buy",
    mid,
    baseSpacingPct: buyBaseSpacingPct,
    candidatesAsc: buyCandidates,
    needAtLeast: Math.max(buyMax, 12),
  });

  sellCandidates = extendCandidatesIfNeeded({
    side: "Sell",
    mid,
    baseSpacingPct: sellBaseSpacingPct,
    candidatesAsc: sellCandidates,
    needAtLeast: Math.max(sellMax, 12),
  });

  // neutral (unadapted) notional — used as decay target for distant levels
  const neutralNotional = Math.max(effectiveMinOrder, perOrder);

  // optional weighted picking
  const buyWeightFn = (p) => {
    const decayed = decayTowardNeutral({ adaptiveNotional: baseNotionalBuy, neutralNotional, price: p, mid, spacingPct: buyBaseSpacingPct });
    const n = notionalForLevel({
      side: "Buy",
      price: p,
      clustersSide: below,
      mu,
      sd,
      baseSpacingPct: buyBaseSpacingPct,
      baseNotional: decayed,
      minOrder: effectiveMinOrder,
    });
    return n / Math.max(1e-12, decayed);
  };

  const sellWeightFn = (p) => {
    const decayed = decayTowardNeutral({ adaptiveNotional: baseNotionalSell, neutralNotional, price: p, mid, spacingPct: sellBaseSpacingPct });
    const n = notionalForLevel({
      side: "Sell",
      price: p,
      clustersSide: above,
      mu,
      sd,
      baseSpacingPct: sellBaseSpacingPct,
      baseNotional: decayed,
      minOrder: effectiveMinOrder,
    });
    return n / Math.max(1e-12, decayed);
  };

  const buyFinal = pickLevels({
    candidatesAsc: buyCandidates,
    takeN: Math.min(buyMax, CONFIG.MAX_LEVELS_PER_SIDE ?? 30),
    side: "Buy",
    mid,
    baseSpacingPct: buyBaseSpacingPct,
    weightFn: buyWeightFn,
  });

  const sellFinal = pickLevels({
    candidatesAsc: sellCandidates,
    takeN: Math.min(sellMax, CONFIG.MAX_LEVELS_PER_SIDE ?? 30),
    side: "Sell",
    mid,
    baseSpacingPct: sellBaseSpacingPct,
    weightFn: sellWeightFn,
  });

  const orders = [];
  const usedBuy = new Set();
  const usedSell = new Set();

  // BUY orders
  let remainingQuote = buyBudgetTotal;
  for (const p of buyFinal.sort((a, b) => b - a)) {
    const kk = key6(p);
    if (usedBuy.has(kk)) continue;

    if (remainingQuote <= 0) break;          // no budget -> stop

    const buyDecayed = decayTowardNeutral({ adaptiveNotional: baseNotionalBuy, neutralNotional, price: p, mid, spacingPct: buyBaseSpacingPct });
    let notional = notionalForLevel({
      side: "Buy",
      price: p,
      clustersSide: below,
      mu,
      sd,
      baseSpacingPct: buyBaseSpacingPct,
      baseNotional: buyDecayed,
      minOrder: effectiveMinOrder,
    });

    // if weight formula returns non-positive (possible when minOrder=0)
    if (!Number.isFinite(notional) || notional <= 0) break;

    if (remainingQuote < effectiveMinOrder) break;
    if (notional > remainingQuote) {
      notional = remainingQuote;
      if (notional < effectiveMinOrder) break;
    }

    // if rounding or adjustment shrinks to zero, bail out as well
    if (!(Number.isFinite(notional) && notional > 0)) break;

    orders.push({
      side: "Buy",
      price: p,
      qty: notional / p,
      notionalQuote: notional,
      origin: "GRID",
      clusterPrice: null,
      isCluster: below.some((c) => isNear(c.cluster_price, p)),
    });

    usedBuy.add(kk);
    remainingQuote -= notional;

    const buyCount = orders.reduce((acc, o) => acc + (o.side === "Buy" ? 1 : 0), 0);
    if (buyCount >= (CONFIG.MAX_LEVELS_PER_SIDE ?? 30)) break;
  }

  // SELL orders
  let remainingBase = baseFree;
  for (const p of sellFinal.sort((a, b) => a - b)) {
    const kk = key6(p);
    if (usedSell.has(kk)) continue;

    if (remainingBase <= 0) break;            // budget exhausted

    const sellDecayed = decayTowardNeutral({ adaptiveNotional: baseNotionalSell, neutralNotional, price: p, mid, spacingPct: sellBaseSpacingPct });
    let notional = notionalForLevel({
      side: "Sell",
      price: p,
      clustersSide: above,
      mu,
      sd,
      baseSpacingPct: sellBaseSpacingPct,
      baseNotional: sellDecayed,
      minOrder: effectiveMinOrder,
    });

    if (!Number.isFinite(notional) || notional <= 0) break;

    if (notional < effectiveMinOrder) notional = effectiveMinOrder;

    const qty = notional / p;

    // ✅ KLUCZOWA POPRAWKA:
    // jeśli qty > remainingBase, to NIE "break",
    // bo przy wyższych cenach qty maleje i może się zmieścić.
    if (qty > remainingBase) {
      continue;
    }

    orders.push({
      side: "Sell",
      price: p,
      qty,
      notionalQuote: qty * p,
      origin: "GRID",
      clusterPrice: null,
      isCluster: above.some((c) => isNear(c.cluster_price, p)),
    });

    usedSell.add(kk);
    remainingBase -= qty;

    const sellCount = orders.reduce((acc, o) => acc + (o.side === "Sell" ? 1 : 0), 0);
    if (sellCount >= (CONFIG.MAX_LEVELS_PER_SIDE ?? 30)) break;
    if (remainingBase <= 0) break;
  }

  return {
    feeGuardPct,
    orders,
    policyApplied: {
      allowNewBuys,
      allowNewSells,
      capitalUsagePct,
      spacingMultBuy,
      spacingMultSell,
      orderCountMultBuy,
      orderCountMultSell,
      orderQuoteBase: perOrder,
      orderQuoteBuy: perOrderBuy,
      orderQuoteSell: perOrderSell,
    },
    anchorsUsed,
    majorBelow: pickMajor(belowAll),
    majorAbove: pickMajor(aboveAll),
  };
}

