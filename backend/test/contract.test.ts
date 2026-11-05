// 외부 API 응답 형식 계약 테스트 (docs/Task_ORDER.md T-123, docs/data_catalog.md)
// 실제 응답의 필드 이름(수집기 로그로 확인, 2026-11-05)을 고정 예시로 둔다. 값은 형식만 맞춘 가짜이고 키·개인정보가 없다.
// 소스가 바꾼 형식을 이 파일에 반영하면 매핑이 깨지는 곳이 빌드에서 드러난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINT_PATHS, FIELDS, mapIndexRows, rowsOf } from '../src/infrastructure/krx/krx-index-daily.js';
import { rankStocks, STOCK_FIELDS, summarizeBreadth } from '../src/infrastructure/krx/krx-breadth.js';
import { mapListItem } from '../src/infrastructure/disclosures/dart-disclosures.js';
import { mapYahooQuotes } from '../src/infrastructure/ingestion/yahoo-api.js';
import { dailyValues, MARKET_FLOW_METRICS, readDataGoKrResponse } from '../src/shared/market-flows.js';
import { mergeRetryDates } from '../src/infrastructure/krx/krx-schedule.js';
import { parseKrxHistoryDays } from '../src/infrastructure/backend-coverage.js';
import { sendToDlq } from '../src/infrastructure/kafka.js';
import { renderMetrics } from '../src/infrastructure/metrics.js';
import type { KafkaMessage, Producer } from 'kafkajs';

const KRX_INDEX_RESPONSE_FIELDS = ['BAS_DD', 'IDX_CLSS', 'IDX_NM', 'CLSPRC_IDX', 'CMPPREVDD_IDX', 'FLUC_RT', 'OPNPRC_IDX', 'HGPRC_IDX', 'LWPRC_IDX', 'ACC_TRDVOL', 'ACC_TRDVAL', 'MKTCAP'];
const KRX_STOCK_RESPONSE_FIELDS = ['BAS_DD', 'ISU_CD', 'ISU_NM', 'MKT_NM', 'SECT_TP_NM', 'TDD_CLSPRC', 'CMPPREVDD_PRC', 'FLUC_RT', 'TDD_OPNPRC', 'TDD_HGPRC', 'TDD_LWPRC', 'ACC_TRDVOL', 'ACC_TRDVAL', 'MKTCAP', 'LIST_SHRS'];
const DART_LIST_RESPONSE_FIELDS = ['corp_code', 'corp_name', 'stock_code', 'corp_cls', 'report_nm', 'rcept_no', 'flr_nm', 'rcept_dt', 'rm'];

const FAKE_DAY = '20261104';

test('KRX 지수 응답: 코드가 읽는 필드가 실제 응답에 있고, 대상 지수가 매핑된다', () => {
  for (const field of Object.values(FIELDS)) assert.ok(KRX_INDEX_RESPONSE_FIELDS.includes(field), field);
  const rows = rowsOf({ OutBlock_1: [
    { BAS_DD: FAKE_DAY, IDX_CLSS: 'KOSPI', IDX_NM: '코스피', CLSPRC_IDX: '5,683.80', CMPPREVDD_IDX: '35.01', FLUC_RT: '0.62' },
    { BAS_DD: FAKE_DAY, IDX_CLSS: 'KOSPI', IDX_NM: '코스피 200', CLSPRC_IDX: '889.25', CMPPREVDD_IDX: '5.00', FLUC_RT: '0.57' },
    { BAS_DD: FAKE_DAY, IDX_CLSS: 'KOSPI', IDX_NM: '코스피 대형주', CLSPRC_IDX: '1.00', CMPPREVDD_IDX: '0', FLUC_RT: '0' },
  ] });
  const { ticks, invalid } = mapIndexRows('kospi', FAKE_DAY, rows);
  assert.deepEqual(ticks.map(tick => [tick.symbol, tick.price]), [['KOSPI', 5683.8], ['KOSPI200', 889.25]]);
  assert.deepEqual(invalid, []);
  assert.equal(ENDPOINT_PATHS.kospi, '/idx/kospi_dd_trd');
});

test('KRX 종목 응답: 코드가 읽는 필드가 실제 응답에 있고, 합계·순위가 만들어진다', () => {
  for (const field of Object.values(STOCK_FIELDS)) assert.ok(KRX_STOCK_RESPONSE_FIELDS.includes(field), field);
  const row = { BAS_DD: FAKE_DAY, ISU_CD: '005930', ISU_NM: '삼성전자', TDD_CLSPRC: '218,000', CMPPREVDD_PRC: '1,000', FLUC_RT: '0.46', ACC_TRDVAL: '1,000,000', MKTCAP: '2,000,000' };
  assert.equal(summarizeBreadth('KOSPI', FAKE_DAY, [row]).breadth?.advancers, 1);
  assert.equal(rankStocks('KOSPI', FAKE_DAY, [row])?.entries[0]?.close, 218000);
});

test('DART 목록 응답: 매핑되고, 개인정보 필드(flr_nm)는 결과에 들어가지 않는다', () => {
  assert.ok(DART_LIST_RESPONSE_FIELDS.includes('flr_nm'));
  const mapped = mapListItem({ corp_code: '00126380', corp_name: '가나다', stock_code: '005930', corp_cls: 'Y', report_nm: '[기재정정]주요사항보고서(자기주식취득결정)', rcept_no: '20261104000001', flr_nm: '홍길동', rcept_dt: FAKE_DAY, rm: '' });
  assert.equal(mapped?.rceptDate, '2026-11-04');
  assert.equal(mapped?.kind, 'buyback');
  assert.equal(mapped?.isCorrection, true);
  assert.equal(JSON.stringify(mapped).includes('홍길동'), false);
});

test('공공데이터포털 응답: 14개 지표 이름이 응답 필드와 맞는다', () => {
  const capital: Record<string, string> = { basDt: FAKE_DAY };
  const credit: Record<string, string> = { basDt: FAKE_DAY };
  for (const metric of Object.keys(MARKET_FLOW_METRICS)) {
    const [dataset, field] = metric.split('.') as [string, string];
    (dataset === 'capital' ? capital : credit)[field] = '1000';
  }
  const parsed = readDataGoKrResponse({ response: { header: { resultCode: '00', resultMsg: 'OK' }, body: { totalCount: 1, items: { item: [capital] } } } });
  assert.equal(parsed.resultCode, '00');
  assert.equal(Object.keys(dailyValues(parsed.rows).days[0]!.values).length, 6);
  assert.equal(Object.keys(dailyValues([credit]).days[0]!.values).length, 8);
});

test('Yahoo 시세 응답: 코드가 읽는 필드로 매핑하고, 값이 빠지면 버린다', () => {
  const quote = { symbol: '^KS11', regularMarketPrice: 5683.8, regularMarketTime: new Date('2026-11-04T06:30:00Z'), regularMarketChangePercent: 0.62, regularMarketChange: 35.01, regularMarketVolume: 1000, marketState: 'CLOSED' };
  const [mapped] = mapYahooQuotes([quote]);
  assert.equal(mapped?.ticker, 'KOSPI');
  assert.equal(mapped?.marketState, 'CLOSED');
  assert.equal(mapYahooQuotes([{ symbol: 'USDKRW=X', regularMarketPrice: 1400, regularMarketTime: new Date(), regularMarketChangePercent: 0, regularMarketChange: 0 }])[0]?.ticker, 'USD/KRW');
  assert.deepEqual(mapYahooQuotes([{ ...quote, regularMarketPrice: undefined }]), []);
  assert.deepEqual(mapYahooQuotes([{ ...quote, symbol: 'NOT_LISTED' }]), []);
});

test('T-159 mergeRetryDates: 받을 날짜와 실패한 날짜를 중복 없이 오래된 순서로 합친다', () => {
  assert.deepEqual(mergeRetryDates(['20261103', '20261104'], new Set(['20261020', '20261104'])), ['20261020', '20261103', '20261104']);
  assert.deepEqual(mergeRetryDates(['20261103'], undefined), ['20261103']);
});

test('T-155 parseKrxHistoryDays: 날짜 형식만 받고, 형식이 다르면 null', () => {
  assert.deepEqual([...(parseKrxHistoryDays({ data: { KOSPI200: ['2026-10-23', 'bad', '2026-10-27'] } })?.get('KOSPI200') ?? [])], ['20261023', '20261027']);
  assert.equal(parseKrxHistoryDays({ data: ['2026-10-23'] }), null);
  assert.equal(parseKrxHistoryDays({ data: { KOSPI200: 'x' } }), null);
});

test('T-157 sendToDlq: 전송이 실패해도 예외를 던지지 않고 지표로 남긴다', async () => {
  const producer = { send: async () => { throw new Error('broker down'); } } as unknown as Producer;
  const message = { key: null, value: Buffer.from('x'), offset: '1', headers: {} } as unknown as KafkaMessage;
  await sendToDlq(producer, { consumer: 'test', topic: 'market-ticks', partition: 0, message, reason: 'test' });
  assert.match(renderMetrics(), /kospi_dlq_send_failed_total\{topic="market-ticks"\} 1/);
});
