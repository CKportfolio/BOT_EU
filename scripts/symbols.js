// scripts/symbols.js

export function parseSymbol(symbol) {
  const s = String(symbol || "").toUpperCase().trim().replace(/[^A-Z0-9]/g, "");
  const QUOTES = ["USDT", "USDC", "USD", "EUR", "BTC", "ETH"];
  for (const q of QUOTES) {
    if (s.endsWith(q)) {
      return { base: s.slice(0, -q.length), quote: q, symbol: s, pair: `${s.slice(0, -q.length)}/${q}` };
    }
  }
  return { base: s.slice(0, -4), quote: s.slice(-4), symbol: s, pair: `${s.slice(0, -4)}/${s.slice(-4)}` };
}

/**
 * Ile miejsc po przecinku wymaga krok (tickSize / qtyStep).
 * Przykłady:
 *  - 0.1  -> 1
 *  - 0.01 -> 2
 *  - 1    -> 0
 */
export function decimalsFromStep(step) {
  const x = Number(step);
  if (!Number.isFinite(x) || x <= 0) return 10;
  // zamieniamy na string bez wykładniczego zapisu
  const s = x.toString().toLowerCase();
  if (s.includes("e-")) {
    const p = Number(s.split("e-")[1]);
    return Number.isFinite(p) ? p : 10;
  }
  const i = s.indexOf(".");
  return i === -1 ? 0 : (s.length - i - 1);
}

/**
 * Round DOWN do kroku (zawsze na dół).
 * To bezpieczne dla Bybit: nie przekracza limitów przez zaokrąglenie w górę.
 */
export function roundToStepDown(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v) || !Number.isFinite(s) || s <= 0) return v;

  const k = Math.floor(v / s);
  const out = k * s;

  const d = decimalsFromStep(s);
  return Number(out.toFixed(d));
}

export function roundPriceToTick(price, tickSize) {
  return roundToStepDown(price, tickSize);
}

export function roundQtyToStep(qty, qtyStep) {
  return roundToStepDown(qty, qtyStep);
}

// klasyczne formaty (zostają)
export function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}
export function fmt8(n) {
  return Number(n).toFixed(8);
}

/**
 * Format dopasowany do kroku (tick/step) — do logów i CSV.
 */
export function fmtByStep(n, step) {
  const d = decimalsFromStep(step);
  return Number(n).toFixed(d);
}
