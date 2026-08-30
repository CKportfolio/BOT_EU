import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../config.js';
import {
  paperInitBalances,
  paperCancelAll,
  paperCancelOne,
  paperPlaceGrid,
  paperCheckFills,
  paperPlaceOneExactQty,
} from '../scripts/execution_paper.js';

function makeState() {
  return {
    balances: { base: 0, quote: 0 },
    reserved: { base: 0, quote: 0 },
    openOrders: [],
    deferredPool: { base: 0, quote: 0 },
  };
}

function snapshotConfig(keys) {
  return Object.fromEntries(keys.map((key) => [key, CONFIG[key]]));
}
function restoreConfig(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete CONFIG[key];
    else CONFIG[key] = value;
  }
}

test('paperInitBalances initializes free and reserved balances', () => {
  const state = makeState();
  paperInitBalances(state, 0.5, 1000);
  assert.deepEqual(state.balances, { base: 0.5, quote: 1000 });
  assert.deepEqual(state.reserved, { base: 0, quote: 0 });
});

test('placing PAPER grid reserves quote for BUY and base for SELL', () => {
  const snap = snapshotConfig(['PAPER_ASSUME_MAKER', 'FEE_MAKER']);
  try {
    CONFIG.PAPER_ASSUME_MAKER = true;
    CONFIG.FEE_MAKER = 0.001;

    const state = makeState();
    paperInitBalances(state, 1, 1000);
    paperPlaceGrid(state, '', {
      orders: [
        { side: 'Buy', price: 100, qty: 1, notionalQuote: 100 },
        { side: 'Sell', price: 110, qty: 0.5, notionalQuote: 55 },
      ],
    });

    assert.equal(state.openOrders.length, 2);
    assert.ok(Math.abs(state.reserved.quote - 100.1) < 1e-9);
    assert.ok(Math.abs(state.balances.quote - 899.9) < 1e-9);
    assert.equal(state.reserved.base, 0.5);
    assert.equal(state.balances.base, 0.5);
  } finally {
    restoreConfig(snap);
  }
});

test('BUY fill releases reserved quote and credits acquired base', () => {
  const snap = snapshotConfig(['PAPER_ASSUME_MAKER', 'FEE_MAKER']);
  try {
    CONFIG.PAPER_ASSUME_MAKER = true;
    CONFIG.FEE_MAKER = 0.001;

    const state = makeState();
    paperInitBalances(state, 0, 1000);
    paperPlaceGrid(state, '', {
      orders: [{ side: 'Buy', price: 100, qty: 1, notionalQuote: 100 }],
    });

    const result = paperCheckFills(state, '', 99);
    assert.equal(result.total, 1);
    assert.equal(result.buy, 1);
    assert.equal(state.openOrders.length, 0);
    assert.ok(Math.abs(state.reserved.quote) < 1e-9);
    assert.equal(state.balances.base, 1);
    assert.ok(Math.abs(result.fills[0].fee - 0.1) < 1e-9);
  } finally {
    restoreConfig(snap);
  }
});

test('SELL fill credits quote proceeds after fee', () => {
  const snap = snapshotConfig(['PAPER_ASSUME_MAKER', 'FEE_MAKER']);
  try {
    CONFIG.PAPER_ASSUME_MAKER = true;
    CONFIG.FEE_MAKER = 0.001;

    const state = makeState();
    paperInitBalances(state, 1, 0);
    paperPlaceGrid(state, '', {
      orders: [{ side: 'Sell', price: 110, qty: 0.5, notionalQuote: 55 }],
    });

    const result = paperCheckFills(state, '', 111);
    assert.equal(result.sell, 1);
    assert.ok(Math.abs(state.balances.quote - 54.945) < 1e-9);
    assert.ok(Math.abs(state.reserved.base) < 1e-9);
  } finally {
    restoreConfig(snap);
  }
});

test('cancelling one PAPER order refunds the reservation', () => {
  const snap = snapshotConfig(['PAPER_ASSUME_MAKER', 'FEE_MAKER']);
  try {
    CONFIG.PAPER_ASSUME_MAKER = true;
    CONFIG.FEE_MAKER = 0.001;

    const state = makeState();
    paperInitBalances(state, 0, 1000);
    paperPlaceGrid(state, '', {
      orders: [{ side: 'Buy', price: 100, qty: 1, notionalQuote: 100 }],
    });
    const id = state.openOrders[0].id;

    assert.equal(paperCancelOne(state, '', id), true);
    assert.equal(state.openOrders.length, 0);
    assert.ok(Math.abs(state.balances.quote - 1000) < 1e-9);
    assert.ok(Math.abs(state.reserved.quote) < 1e-9);
  } finally {
    restoreConfig(snap);
  }
});

test('paperCancelAll returns all reserved funds', () => {
  const state = makeState();
  state.balances = { base: 0.25, quote: 400 };
  state.reserved = { base: 0.75, quote: 600 };
  state.openOrders = [{ id: 'a' }, { id: 'b' }];

  paperCancelAll(state, '');

  assert.deepEqual(state.balances, { base: 1, quote: 1000 });
  assert.deepEqual(state.reserved, { base: 0, quote: 0 });
  assert.deepEqual(state.openOrders, []);
});

test('exact PAPER order rejects too-small and unavailable orders', () => {
  const snap = snapshotConfig(['MIN_ORDER_QUOTE', 'PAPER_ASSUME_MAKER', 'FEE_MAKER']);
  try {
    CONFIG.MIN_ORDER_QUOTE = 18;
    CONFIG.PAPER_ASSUME_MAKER = true;
    CONFIG.FEE_MAKER = 0.001;

    const state = makeState();
    paperInitBalances(state, 0.1, 20);

    assert.equal(
      paperPlaceOneExactQty(state, '', { side: 'Buy', price: 100, qty: 0.1 }),
      null,
      'notional below MIN_ORDER_QUOTE must be rejected'
    );
    assert.equal(
      paperPlaceOneExactQty(state, '', { side: 'Buy', price: 100, qty: 0.2 }),
      null,
      'balance must also cover trading fee'
    );
    assert.equal(
      paperPlaceOneExactQty(state, '', { side: 'Sell', price: 100, qty: 0.2 }),
      null,
      'cannot sell more base than available'
    );
  } finally {
    restoreConfig(snap);
  }
});

test('deferred pool is excluded from funds available for new exact order', () => {
  const snap = snapshotConfig(['MIN_ORDER_QUOTE', 'PAPER_ASSUME_MAKER', 'FEE_MAKER']);
  try {
    CONFIG.MIN_ORDER_QUOTE = 1;
    CONFIG.PAPER_ASSUME_MAKER = true;
    CONFIG.FEE_MAKER = 0;

    const state = makeState();
    paperInitBalances(state, 1, 100);
    state.deferredPool.quote = 90;

    const rejected = paperPlaceOneExactQty(state, '', {
      side: 'Buy', price: 100, qty: 0.2,
    });
    assert.equal(rejected, null);
  } finally {
    restoreConfig(snap);
  }
});
