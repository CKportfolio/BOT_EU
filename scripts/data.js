// scripts/data.js
import { CONFIG } from "../config.js";

export async function getLastClosed1mClose(symbol) {
  const category = CONFIG.CATEGORY || "spot";
  const baseUrl = String(
    process.env.BYBIT_TRADE_BASE_URL || process.env.BYBIT_BASE_URL || "https://api.bybit.eu"
  ).replace(/\/+$/, "");
  const url =
    `${baseUrl}/v5/market/kline` +
    `?category=${encodeURIComponent(category)}` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=1&limit=2`;

  const timeoutMs = Number(CONFIG.KLINE_FETCH_TIMEOUT_MS ?? 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: "GET", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();

  if (json?.retCode !== 0) {
    throw new Error(`Bybit kline error retCode=${json?.retCode} retMsg=${json?.retMsg}`);
  }

  const list = json?.result?.list;
  if (!Array.isArray(list) || list.length < 2) {
    throw new Error("Bybit kline invalid response (need 2 candles).");
  }

  const candleClosed = list[1];
  const close = Number(candleClosed[4]);

  if (!Number.isFinite(close) || close <= 0) {
    throw new Error("Nie udało się pobrać last closed closePrice.");
  }

  return close;
}
