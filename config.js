// config.js - BOT EU SIMPLE
export const CONFIG = {
  // === QUICK START (primary runtime controls) ===
  // MODE: LIVE or PAPER
  MODE: String(process.env.BOT_MODE || process.env.MODE || "PAPER").toUpperCase(),
  // MARKET example: BTCUSDC, ETHUSDC
    MARKET: process.env.BOT_MARKET || "BTCUSDC",
  CATEGORY: process.env.BOT_CATEGORY || "spot",
  ORDER_QUOTE_VALUE: Number(process.env.ORDER_QUOTE_VALUE || 24),
  MICRO_SPACING_PCT: Number(process.env.MICRO_SPACING_PCT || 0.65),

  // === LOOP TIMING ===
  POLL_MS: Number(process.env.BOT_POLL_MS || 3000),

  // === START BUDGETS ===
  PAPER_START_QUOTE: Number(process.env.PAPER_START_QUOTE || 300),
  PAPER_START_BASE: Number(process.env.PAPER_START_BASE || 0.0045),
  LIVE_MIN_QUOTE: Number(process.env.LIVE_MIN_QUOTE || 20),
  LIVE_MIN_BASE: Number(process.env.LIVE_MIN_BASE || 0),

  // === GRID ===
  MIN_ORDER_QUOTE: Number(process.env.MIN_ORDER_QUOTE || 18),
  MAX_LEVELS_PER_SIDE: Number(process.env.MAX_LEVELS_PER_SIDE || 26),

  // === COUNTER / COMPOUND ===
  COUNTER_GRID_STEP_PCT: Number(process.env.COUNTER_GRID_STEP_PCT || 0.65),
  STRAT_COUNTER_COMPOUNDING_ENABLED: Number(process.env.STRAT_COUNTER_COMPOUNDING_ENABLED || 1) === 1,
  STRAT_COUNTER_COMPOUNDING_FACTOR: Number(process.env.STRAT_COUNTER_COMPOUNDING_FACTOR || 1),

  // === FEES ===
  // Effective live fee is fetched from Bybit endpoint in runtime.
  FEE_MAKER: Number(process.env.FEE_MAKER || 0.001),
  FEE_TAKER: Number(process.env.FEE_TAKER || 0.001),
  PAPER_ASSUME_MAKER: Number(process.env.PAPER_ASSUME_MAKER || 1) === 1,

  // === CSV / STATE ===
  CSV_DIR: process.env.CSV_DIR || "./CSV",
  RUNTIME_STATE_PERSIST_ENABLED: Number(process.env.RUNTIME_STATE_PERSIST_ENABLED || 1) === 1,
  RUNTIME_STATE_FLUSH_MS: Number(process.env.RUNTIME_STATE_FLUSH_MS || 15000),
  RUNTIME_STATE_RESTORE_IN_PAPER: Number(process.env.RUNTIME_STATE_RESTORE_IN_PAPER || 0) === 1,
  RUNTIME_STATE_RESTORE_IN_LIVE: Number(process.env.RUNTIME_STATE_RESTORE_IN_LIVE || 1) === 1,

  // === SYSTEM ===
  KEEP_SYSTEM_AWAKE_WHILE_BOT: Number(process.env.KEEP_SYSTEM_AWAKE_WHILE_BOT || 1) === 1,
  KEEP_SYSTEM_AWAKE_HEARTBEAT_SEC: Number(process.env.KEEP_SYSTEM_AWAKE_HEARTBEAT_SEC || 45),
};