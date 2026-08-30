// scripts/execution_paper.js
import crypto from "crypto";
import { CONFIG } from "../config.js";
import { nowMs } from "./time.js";

function feeRateForPaper() {
  if (CONFIG.PAPER_ASSUME_MAKER) return CONFIG.FEE_MAKER ?? 0;
  return CONFIG.FEE_TAKER ?? (CONFIG.FEE_MAKER ?? 0);
}

export function paperInitBalances(state, baseStart, quoteStart) {
  state.balances.base = baseStart;
  state.balances.quote = quoteStart;
  state.reserved = { base: 0, quote: 0 };
}

export function paperCancelAll(state, csvPath, reason = "") {
  state.balances.base += state.reserved?.base ?? 0;
  state.balances.quote += state.reserved?.quote ?? 0;
  state.reserved = { base: 0, quote: 0 };
  state.openOrders = [];
}

export function paperCancelOne(state, csvPath, orderId, reason = "CANCEL_ONE") {
  const idx = state.openOrders.findIndex((o) => o.id === orderId);
  if (idx === -1) return false;
  const o = state.openOrders[idx];

  const feeRate = feeRateForPaper();

  if (o.side === "Buy") {
    const needQuote = o.notionalQuote * (1 + feeRate);
    state.balances.quote += needQuote;
    state.reserved.quote -= needQuote;
  } else {
    state.balances.base += o.qty;
    state.reserved.base -= o.qty;
  }

  state.openOrders.splice(idx, 1);

  return true;
}

export function paperPlaceGrid(state, csvPath, grid) {
  const feeRate = feeRateForPaper();
  const orders = [];

  let freeQuote = state.balances.quote;
  let freeBase = state.balances.base;

  let resQuote = 0;
  let resBase = 0;

  for (const o of grid.orders) {
    const info = o.origin ? `GRID_${o.side.toUpperCase()} ${o.origin}` : `GRID_${o.side.toUpperCase()}`;

    if (o.side === "Buy") {
      const needQuote = o.notionalQuote * (1 + feeRate);
      if (freeQuote < needQuote) continue;

      freeQuote -= needQuote;
      resQuote += needQuote;

      orders.push({
        id: crypto.randomUUID(),
        side: "Buy",
        price: o.price,
        qty: o.qty,
        notionalQuote: o.notionalQuote,
        status: "OPEN",
        placedAt: nowMs(),
        origin: o.origin || "",
        clusterPrice: o.clusterPrice ?? null,
        gridTag: o.gridTag || "",
      });
    } else {
      if (freeBase < o.qty) continue;

      freeBase -= o.qty;
      resBase += o.qty;

      orders.push({
        id: crypto.randomUUID(),
        side: "Sell",
        price: o.price,
        qty: o.qty,
        notionalQuote: o.notionalQuote,
        status: "OPEN",
        placedAt: nowMs(),
        origin: o.origin || "",
        clusterPrice: o.clusterPrice ?? null,
        gridTag: o.gridTag || "",
      });
    }
  }

  state.openOrders = orders;
  state.balances.quote = freeQuote;
  state.balances.base = freeBase;
  state.reserved = { base: resBase, quote: resQuote };
}

/**
 * Zwraca eventy fill (orderId) – to jest dalej OK w nowej strategii.
 */
export function paperCheckFills(state, csvPath, closePrice) {
  const feeRate = feeRateForPaper();

  const toFill = [];
  for (const o of state.openOrders) {
    if (o.status !== "OPEN") continue;
    if (o.side === "Buy" && closePrice <= o.price) toFill.push(o);
    if (o.side === "Sell" && closePrice >= o.price) toFill.push(o);
  }

  if (!toFill.length) return { total: 0, buy: 0, sell: 0, fills: [] };

  let buyCount = 0;
  let sellCount = 0;
  const fillEvents = [];

  for (const o of toFill) {
    const notional = o.qty * o.price;
    const fee = notional * feeRate;

    const filledAt = nowMs();
    const fillPrice = o.price;

    o.status = "FILLED";
    o.fillPrice = fillPrice;
    o.filledAt = filledAt;

    if (o.side === "Buy") {
      const reservedQuote = o.notionalQuote * (1 + feeRate);
      state.reserved.quote -= reservedQuote;

      state.balances.base += o.qty;
      buyCount += 1;
    } else {
      state.reserved.base -= o.qty;

      const receive = notional - fee;
      state.balances.quote += receive;
      sellCount += 1;
    }

    fillEvents.push({
      orderId: o.id,
      orderLinkId: String(o.linkId || ""),
      side: o.side,
      fillPrice,
      qty: o.qty,
      notionalQuote: notional,
      fee,
      feeCurrency: "QUOTE",
      netBaseQty: o.qty,
      filledAt,
      origin: o.origin || "",
      clusterPrice: o.clusterPrice ?? null,
    });
  }

  const filledIds = new Set(toFill.map((x) => x.id));
  state.openOrders = state.openOrders.filter((o) => !filledIds.has(o.id));

  return { total: fillEvents.length, buy: buyCount, sell: sellCount, fills: fillEvents };
}

/**
 * Pojedynczy order – nadal przydatne (manual/komendy),
 * ale już bez “ratowania” – po prostu narzędzie.
 */
export function paperPlaceOneExactQty(state, csvPath, { side, price, qty, info = "PLACE_ONE_EXACT", gridTag = "" }) {
  const feeRate = feeRateForPaper();
  const minNotional = CONFIG.MIN_ORDER_QUOTE ?? 1;

  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const notionalQuote = qty * price;
  if (!Number.isFinite(notionalQuote) || notionalQuote < minNotional) return null;

  if (side === "Buy") {
    const needQuote = notionalQuote * (1 + feeRate);
    const deferredQuote = Number(state.deferredPool?.quote ?? 0);
    const effectiveQuote = Number(state.balances.quote ?? 0) - Math.max(0, deferredQuote);
    if (effectiveQuote < needQuote) return null;

    state.balances.quote -= needQuote;
    state.reserved.quote += needQuote;

    const o = {
      id: crypto.randomUUID(),
      linkId: "",
      side: "Buy",
      price,
      qty,
      notionalQuote,
      status: "OPEN",
      placedAt: nowMs(),
      info,
      gridTag: gridTag || "",
    };
    state.openOrders.push(o);

    return o;
  }

  const deferredBase = Number(state.deferredPool?.base ?? 0);
  const effectiveBase = Number(state.balances.base ?? 0) - Math.max(0, deferredBase);
  if (effectiveBase < qty) return null;

  state.balances.base -= qty;
  state.reserved.base += qty;

  const o = {
    id: crypto.randomUUID(),
    linkId: "",
    side: "Sell",
    price,
    qty,
    notionalQuote,
    status: "OPEN",
    placedAt: nowMs(),
    info,
    gridTag: gridTag || "",
  };
  state.openOrders.push(o);

  return o;
}
