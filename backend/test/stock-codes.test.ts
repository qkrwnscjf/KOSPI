// 대형주 종목코드 표 통합 테스트 (docs/Task_ORDER.md T-172)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KRX_STOCK_BY_CODE, KRX_STOCK_CODES, YAHOO_SYMBOLS, type KrxStockSymbol } from '../src/shared/symbols.js';

test('대형주 종목코드는 한 표에서 나오고 Yahoo 심볼·코드 역조회와 맞는다 (T-172)', () => {
  const symbols = Object.keys(KRX_STOCK_CODES) as KrxStockSymbol[];
  assert.equal(symbols.length, 3);
  for (const symbol of symbols) {
    const code = KRX_STOCK_CODES[symbol];
    assert.match(code, /^\d{6}$/);
    assert.equal(YAHOO_SYMBOLS[symbol], `${code}.KS`);
    assert.equal(KRX_STOCK_BY_CODE.get(code), symbol);
  }
  assert.equal(KRX_STOCK_BY_CODE.size, symbols.length);
  // 이전에 세 곳에 적혀 있던 값과 같다
  assert.deepEqual([...KRX_STOCK_BY_CODE.entries()], [['005930', 'SAMSUNG'], ['000660', 'SK_HYNIX'], ['005380', 'HYUNDAI']]);
});
