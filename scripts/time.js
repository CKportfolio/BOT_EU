// scripts/time.js
let nowProvider = () => Date.now();

/** Ustaw provider czasu (np. symulacja). Provider ma zwracać epoch ms. */
export function setNowProvider(fn) {
  if (typeof fn === "function") nowProvider = fn;
}

/** Epoch ms */
export function nowMs() {
  return Number(nowProvider());
}

/** Date z providera */
export function nowDate() {
  return new Date(nowMs());
}
