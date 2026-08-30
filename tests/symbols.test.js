import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSymbol,
  decimalsFromStep,
  roundToStepDown,
  roundPriceToTick,
  roundQtyToStep,
  fmtByStep,
} from '../scripts/symbols.js';

test('parseSymbol recognizes common Bybit quote currencies', () => {
  assert.deepEqual(parseSymbol('BTCUSDC'), {
    base: 'BTC', quote: 'USDC', symbol: 'BTCUSDC', pair: 'BTC/USDC',
  });
  assert.deepEqual(parseSymbol(' eth-usdt '), {
    base: 'ETH', quote: 'USDT', symbol: 'ETHUSDT', pair: 'ETH/USDT',
  });
});

test('decimalsFromStep handles decimal and exponential steps', () => {
  assert.equal(decimalsFromStep(1), 0);
  assert.equal(decimalsFromStep(0.1), 1);
  assert.equal(decimalsFromStep(0.00001), 5);
  assert.equal(decimalsFromStep(1e-8), 8);
});

test('rounding always rounds down to exchange step', () => {
  assert.equal(roundToStepDown(123.4567, 0.01), 123.45);
  assert.equal(roundPriceToTick(65000.129, 0.1), 65000.1);
  assert.equal(roundQtyToStep(0.001239, 0.00001), 0.00123);
  assert.equal(fmtByStep(0.00123, 0.00001), '0.00123');
});
