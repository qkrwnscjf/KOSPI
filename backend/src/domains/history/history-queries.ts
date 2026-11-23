// History API의 집계·일봉 합치기 SQL (docs/Task_ORDER.md T-20, T-104 ③, T-127, T-136, T-151)
// 통합 시험(test-integration/, T-227)이 실제 DB에서 같은 SQL을 돌릴 수 있도록 컨트롤러에서 떼어 냈다(동작 같음).
// 이 파일은 Redis·DB 연결을 만들지 않는다. 실행은 history.controller.ts가 한다.
import type { YahooSymbolKey } from '../../shared/symbols.js';
import type { BarResolution } from '../../shared/yahoo-bars.js';
import { usesOfficialDailyClose } from '../../infrastructure/sink/daily-history.js';

export type Timeframe = '1일' | '1주' | '1개월' | '3개월' | '1년';
export type HistoryPoint = { time: number; value: number };

// DB 집계 조회 (docs/Task_ORDER.md T-20). 집계 이름은 이 고정된 표에서만 고른다 (사용자 입력으로 SQL을 만들지 않음).
export const DB_TIMEFRAMES: Record<Timeframe, { view: string; range: string; fill?: BarResolution }> = {
  '1일': { view: 'market_5m', range: '1 day', fill: '5m' },    // T-21: 이전에는 2일치를 보여 줬다
  '1주': { view: 'market_1h', range: '7 days', fill: '1h' },
  '1개월': { view: 'market_1d', range: '30 days' },
  '3개월': { view: 'market_1d', range: '90 days' },
  '1년': { view: 'market_1d', range: '365 days' },
};

export function historyQuery(ticker: YahooSymbolKey, timeframe: Timeframe): { text: string; values: unknown[] } {
  const { view, range, fill } = DB_TIMEFRAMES[timeframe];
  // 1개월 ~ 1년(1일 봉): 집계에 없는 날짜를 일봉(index_daily)으로 채운다.
  // - 나중에 추가한 지표는 집계가 시작되기 전 날짜(T-104 ③), 모든 지표는 스택이 꺼져 있던 날처럼 집계가 빠진 날(T-127).
  // 일봉 출처는 Yahoo(source 'yahoo') 또는 Yahoo가 주지 않는 지표의 KRX(source 'krx', 코스피 200)다. (symbol, time)이 유일해서 날짜당 1행.
  // - 그 날짜에 집계 버킷이 있으면 집계가 우선이라 같은 날짜가 두 번 나오지 않는다.
  // - 일봉 시각은 집계 버킷과 같은 기준(UTC 자정)으로 맞춘다. 1일·1주(5분·1시간 봉)는 해상도가 달라 붙이지 않는다.
  // 장 시간이 정해진 시장의 지표(T-136, D-81)는 반대로 일봉(공식 종가)을 먼저 쓰고, 일봉이 없는 날(오늘·아직 받지 않은 날)만 집계를 쓴다.
  // 스택이 장의 일부만 떠 있던 날 집계 종가가 틀리는 문제(B-49) 때문. 집계 자체는 바꾸지 않는다.
  if (view === 'market_1d' && usesOfficialDailyClose(ticker)) {
    return {
      text: `WITH daily AS (
         SELECT time_bucket(INTERVAL '1 day', d.time) AS t, d.close
         FROM index_daily d WHERE d.symbol = $1 AND d.time >= now() - $2::interval
       )
       SELECT (extract(epoch FROM t) * 1000)::float8 AS time, close::float8 AS value
       FROM (
         SELECT t, close FROM daily
         UNION ALL
         SELECT a.bucket AS t, a.close FROM market_1d a
         WHERE a.symbol = $1 AND a.bucket >= now() - $2::interval
           AND NOT EXISTS (SELECT 1 FROM daily WHERE daily.t = a.bucket)
       ) merged
       ORDER BY t`,
      values: [ticker, range],
    };
  }
  if (view === 'market_1d') {
    return {
      text: `WITH agg AS (
         SELECT bucket, close FROM market_1d WHERE symbol = $1 AND bucket >= now() - $2::interval
       )
       SELECT (extract(epoch FROM t) * 1000)::float8 AS time, close::float8 AS value
       FROM (
         SELECT time_bucket(INTERVAL '1 day', d.time) AS t, d.close
         FROM index_daily d
         WHERE d.symbol = $1 AND d.time >= now() - $2::interval
           AND NOT EXISTS (SELECT 1 FROM agg WHERE agg.bucket = time_bucket(INTERVAL '1 day', d.time))
         UNION ALL
         SELECT bucket AS t, close FROM agg
       ) merged
       ORDER BY t`,
      values: [ticker, range],
    };
  }
  // 1일·1주(5분·1시간 봉, T-151): 스택이 꺼져 있던 구간처럼 집계에 없는 시각만 Yahoo 봉(market_bars_fill)으로 채운다. 집계가 항상 우선이다.
  return {
    text: `WITH agg AS (
       SELECT bucket, close FROM ${view} WHERE symbol = $1 AND bucket >= now() - $2::interval
     )
     SELECT (extract(epoch FROM t) * 1000)::float8 AS time, close::float8 AS value
     FROM (
       SELECT bucket AS t, close FROM agg
       UNION ALL
       SELECT f.time AS t, f.close FROM market_bars_fill f
       WHERE f.symbol = $1 AND f.resolution = $3 AND f.time >= now() - $2::interval
         AND NOT EXISTS (SELECT 1 FROM agg WHERE agg.bucket = f.time)
     ) merged
     ORDER BY t`,
    values: [ticker, range, fill],
  };
}
