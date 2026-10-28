// 증시 자금 흐름 일별 통계 테스트 (11단계 B′ T-95 ~ T-97)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyCloseTime, dailyValues, MARKET_FLOW_METRICS, parseMarketFlow, readDataGoKrResponse } from '../src/shared/market-flows.js';

test('MARKET_FLOW_METRICS: 받은 14개 필드 모두 표시 이름·단위가 있고, 비중만 %다', () => {
  const fields = {
    capital: ['invrDpsgAmt', 'onbdDrvPrdTrRcAdvAmt', 'toCstRpchCndBndSlgBal', 'brkTrdUcolMny', 'brkTrdUcolMnyVsOppsTrdAmt', 'ucolMnyVsOppsTrdRlImpt'],
    credit: ['crdTrFingWhl', 'crdTrFingScrs', 'crdTrFingKosdaq', 'crdTrLndrWhl', 'crdTrLndrScrs', 'crdTrLndrKosdaq', 'sbscCapLn', 'dpsgScrtMogFing'],
  };
  const metrics = Object.entries(fields).flatMap(([dataset, names]) => names.map(name => `${dataset}.${name}`));
  assert.deepEqual(Object.keys(MARKET_FLOW_METRICS).sort(), metrics.sort());
  assert.deepEqual(metrics.filter(metric => MARKET_FLOW_METRICS[metric]?.unit === 'percent'), ['capital.ucolMnyVsOppsTrdRlImpt']);
});

test('readDataGoKrResponse: 결과 코드와 행을 꺼내고, 행이 한 건이면 객체로 와도 받는다', () => {
  const many = readDataGoKrResponse({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { totalCount: 2, items: { item: [{ basDt: '20261026' }, { basDt: '20261027' }] } } } });
  assert.equal(many.resultCode, '00');
  assert.equal(many.rows.length, 2);
  const one = readDataGoKrResponse({ response: { header: { resultCode: '00' }, body: { items: { item: { basDt: '20261027' } } } } });
  assert.equal(one.rows.length, 1);
  assert.deepEqual(readDataGoKrResponse('not-json-object').rows, []);
});

test('dailyValues: 기준일별 숫자 필드만 오래된 순으로, 빈 값은 0으로 채우지 않는다', () => {
  const result = dailyValues([
    { basDt: '20261027', invstDpsAmt: '1,234', rvrsTrdAmt: 5, note: '-', 'bad-name': 1 },
    { basDt: '20261026', invstDpsAmt: '100' },
  ]);
  assert.deepEqual(result.days, [
    { basDt: '20261026', values: { invstDpsAmt: 100 } },
    { basDt: '20261027', values: { invstDpsAmt: 1234, rvrsTrdAmt: 5 } },
  ]);
  assert.equal(result.skippedFields, 2);
  assert.deepEqual(result.problems, []);
});

test('dailyValues: 같은 날짜에 행이 여러 개인 날과 기준일이 없는 행은 저장하지 않는다', () => {
  const result = dailyValues([{ basDt: '20261027', a: 1 }, { basDt: '20261027', a: 2 }, { basDt: '20261028', a: 3 }, { date: '20261027', a: 1 }]);
  assert.deepEqual(result.days, [{ basDt: '20261028', values: { a: 3 } }]);
  assert.deepEqual(result.problems, [{ basDt: '20261027', reason: 'multiple_rows_per_day:2' }]);
  assert.equal(result.rowsWithoutDate, 1);
});

test('parseMarketFlow: 데이터셋·시각·숫자 값만 받는다', () => {
  const time = dailyCloseTime('20261027');
  assert.equal(new Date(time).toISOString(), '2026-10-27T06:30:00.000Z');
  const ok = parseMarketFlow(Buffer.from(JSON.stringify({ time, dataset: 'capital', values: { invstDpsAmt: 1 } })));
  assert.equal(ok.ok, true);
  assert.equal(parseMarketFlow(Buffer.from(JSON.stringify({ time, dataset: 'other', values: { a: 1 } }))).ok, false);
  assert.equal(parseMarketFlow(Buffer.from(JSON.stringify({ time, dataset: 'credit', values: { a: 'x' } }))).ok, false);
  assert.equal(parseMarketFlow(Buffer.from(JSON.stringify({ time, dataset: 'credit', values: {} }))).ok, false);
  assert.deepEqual(parseMarketFlow(Buffer.from('nope')), { ok: false, reason: 'invalid_json' });
});
