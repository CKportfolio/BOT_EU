import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../config.js';
import { buildGrid, computeFeeGuardSpacingPct } from '../scripts/grid.js';

function snapshotConfig(keys) {
  return Object.fromEntries(keys.map((key) => [key, CONFIG[key]]));
}
function restoreConfig(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete CONFIG[key];
    else CONFIG[key] = value;
  }
}

const GRID_KEYS = [
  'MICRO_SPACING_PCT', 'ORDER_QUOTE_VALUE', 'MIN_ORDER_QUOTE',
  'MAX_LEVELS_PER_SIDE', 'FEE_GUARD_MODE', 'CLUSTER_GAPS_EACH_SIDE',
  'CLUSTER_GAPS_BUY_SIDE', 'CLUSTER_GAPS_SELL_SIDE',
];

test('fee guard converts fee rate to spacing percentage', () => {
  const snap = snapshotConfig(['FEE_GUARD_MODE']);
  try {
    CONFIG.FEE_GUARD_MODE = 'actual';
    assert.equal(computeFeeGuardSpacingPct(0.001), 0.1);
    CONFIG.FEE_GUARD_MODE = 'double';
    assert.equal(computeFeeGuardSpacingPct(0.001), 0.2);
  } finally {
    restoreConfig(snap);
  }
});

test('invalid market price produces no orders', () => {
  const grid = buildGrid({
    midPrice: 0,
    clustersZoned: [],
    balances: { base: 1, quote: 1000 },
    feeRate: 0.001,
  });
  assert.deepEqual(grid.orders, []);
});

test('regular grid places BUY below and SELL above mid without cluster input', () => {
  const snap = snapshotConfig(GRID_KEYS);
  try {
    CONFIG.MICRO_SPACING_PCT = 0.65;
    CONFIG.ORDER_QUOTE_VALUE = 20;
    CONFIG.MIN_ORDER_QUOTE = 10;
    CONFIG.MAX_LEVELS_PER_SIDE = 4;
    CONFIG.FEE_GUARD_MODE = 'actual';

    const grid = buildGrid({
      midPrice: 100,
      clustersZoned: [],
      balances: { base: 1, quote: 1000 },
      feeRate: 0.001,
    });

    const buys = grid.orders.filter((o) => o.side === 'Buy');
    const sells = grid.orders.filter((o) => o.side === 'Sell');

    assert.ok(buys.length > 0);
    assert.ok(sells.length > 0);
    assert.ok(buys.every((o) => o.price < 100 && o.qty > 0 && o.notionalQuote > 0));
    assert.ok(sells.every((o) => o.price > 100 && o.qty > 0 && o.notionalQuote > 0));
    assert.ok(buys.length <= 4);
    assert.ok(sells.length <= 4);
  } finally {
    restoreConfig(snap);
  }
});

test('strategy policy can disable one side and cap capital usage', () => {
  const snap = snapshotConfig(GRID_KEYS);
  try {
    CONFIG.ORDER_QUOTE_VALUE = 20;
    CONFIG.MIN_ORDER_QUOTE = 10;
    CONFIG.MAX_LEVELS_PER_SIDE = 10;

    const grid = buildGrid({
      midPrice: 100,
      clustersZoned: [],
      balances: { base: 1, quote: 200 },
      feeRate: 0,
      strategyPolicy: {
        allowNewBuys: true,
        allowNewSells: false,
        capitalUsagePct: 0.5,
      },
    });

    assert.ok(grid.orders.length > 0);
    assert.ok(grid.orders.every((o) => o.side === 'Buy'));
    const totalBuyNotional = grid.orders.reduce((sum, o) => sum + o.notionalQuote, 0);
    assert.ok(totalBuyNotional <= 100 + 1e-9);
  } finally {
    restoreConfig(snap);
  }
});

test('cluster-aware engine reports anchors and strongest levels', () => {
  const snap = snapshotConfig(GRID_KEYS);
  try {
    CONFIG.ORDER_QUOTE_VALUE = 20;
    CONFIG.MIN_ORDER_QUOTE = 10;
    CONFIG.MAX_LEVELS_PER_SIDE = 4;
    CONFIG.CLUSTER_GAPS_BUY_SIDE = 2;
    CONFIG.CLUSTER_GAPS_SELL_SIDE = 2;

    const clusters = [
      { cluster_price: 95, cluster_strength: 4, strength_zone: 1 },
      { cluster_price: 98, cluster_strength: 9, strength_zone: 2 },
      { cluster_price: 103, cluster_strength: 7, strength_zone: 2 },
      { cluster_price: 108, cluster_strength: 3, strength_zone: 1 },
    ];

    const grid = buildGrid({
      midPrice: 100,
      clustersZoned: clusters,
      balances: { base: 1, quote: 500 },
      feeRate: 0.001,
    });

    assert.ok(grid.anchorsUsed.length >= 4);
    assert.equal(grid.majorBelow.cluster_price, 98);
    assert.equal(grid.majorAbove.cluster_price, 103);
    assert.ok(grid.orders.some((o) => o.isCluster === true));
  } finally {
    restoreConfig(snap);
  }
});
