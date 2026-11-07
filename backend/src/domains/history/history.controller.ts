import type { FastifyInstance } from 'fastify';
import { cache, redis } from '../../infrastructure/redis.js';
import { dbPool } from '../../infrastructure/db.js';
import { Latency } from '../../infrastructure/metrics.js';
import { DERIVED_SPREADS, isDerivedSymbol, isSubscribableSymbol, isYahooSymbolKey, YAHOO_KEYS } from '../../shared/symbols.js';
import { isMarketState } from '../../shared/market-state.js';
import { usesOfficialDailyClose } from '../../infrastructure/sink/daily-history.js';
import { BREADTH_MARKETS, type BreadthMarket } from '../../shared/breadth.js';
import type { DerivedSymbol, YahooSymbolKey } from '../../shared/symbols.js';
import { isKrxDailySymbol, KRX_HISTORY_KEYS, KRX_SECTOR_KEYS, type KrxDailySymbol } from '../../shared/krx-indices.js';
import { computeMarketRisk, isRiskRange, RISK_BASE, RISK_RANGES, RISK_TARGETS, type RiskRange } from '../../shared/market-risk.js';
import { isRankingMarket, isRankingType, RANKING_MARKETS, type RankingType } from '../../shared/rankings.js';
import { isCalendarDate } from '../../shared/disclosure-calendar.js';
import type { BarResolution } from '../../shared/yahoo-bars.js';
import { marketService } from '../market/market.service.js';

// 측정 지표 (docs/Task_ORDER.md T-01, BENCHMARK M-11)
const historyDuration = new Latency('kospi_history_request_duration_seconds', 'History API response time by result (cache_hit / cache_miss / not_ready / error)');
const selfCheckDuration = new Latency('kospi_history_self_check_duration_seconds', 'History self-check DB query time (cache bypassed)');
const recentDuration = new Latency('kospi_history_recent_duration_seconds', 'Recent ticks API response time by result (cache_hit / cache_miss / not_ready / error)');

// 실시간 차트의 첫 화면용 최근 tick (docs/Task_ORDER.md T-25, D-29)
// 원본 테이블(market_ticks, 3시간 보관)에서 심볼별 최근 tick을 돌려준다. 실시간 차트와 같은 해상도라 이어 붙여도 섞이지 않는다.
// 개수는 고정이라 요청마다 다른 값으로 캐시나 DB를 부풀릴 수 없다.
const RECENT_TICKS_LIMIT = 50;
const RECENT_CACHE_TTL_S = 5;

type Timeframe = '1일' | '1주' | '1개월' | '3개월' | '1년';
type HistoryPoint = { time: number; value: number };

// DB 집계 조회 (docs/Task_ORDER.md T-20). 집계 이름은 이 고정된 표에서만 고른다 (사용자 입력으로 SQL을 만들지 않음).
const DB_TIMEFRAMES: Record<Timeframe, { view: string; range: string; fill?: BarResolution }> = {
  '1일': { view: 'market_5m', range: '1 day', fill: '5m' },    // T-21: 이전에는 2일치를 보여 줬다
  '1주': { view: 'market_1h', range: '7 days', fill: '1h' },
  '1개월': { view: 'market_1d', range: '30 days' },
  '3개월': { view: 'market_1d', range: '90 days' },
  '1년': { view: 'market_1d', range: '365 days' },
};
const TIMEFRAMES = Object.keys(DB_TIMEFRAMES) as Timeframe[];
const isTimeframe = (value: string): value is Timeframe => Object.prototype.hasOwnProperty.call(DB_TIMEFRAMES, value);

// 검증용 자체 점검 (기본 끔)
const HISTORY_SELF_CHECK = process.env.HISTORY_SELF_CHECK === 'true';
// DB 조회가 p50 약 23ms라서(BENCHMARK B-06) 캐시로 아끼는 시간은 수십 ms다. 그래프가 늦게 반영되지 않도록 30초로 짧게 둔다 (D-24).
// 이전 300초 TTL에서는 그래프가 최대 5분 늦게 반영되었다.
const HISTORY_CACHE_TTL_S = Number.parseInt(process.env.HISTORY_CACHE_TTL_S ?? '', 10) || 30;

// DB 집계 조회 (T-20). B-06에서 Yahoo 직접 호출보다 약 6배 빠르고, "1일" 기간 오류와 0값이 없어서 채택했다.
async function getHistory(ticker: YahooSymbolKey, timeframe: Timeframe): Promise<HistoryPoint[]> {
  const { view, range, fill } = DB_TIMEFRAMES[timeframe];
  // 1개월 ~ 1년(1일 봉): 집계에 없는 날짜를 일봉(index_daily)으로 채운다.
  // - 나중에 추가한 지표는 집계가 시작되기 전 날짜(T-104 ③), 모든 지표는 스택이 꺼져 있던 날처럼 집계가 빠진 날(T-127).
  // 일봉 출처는 Yahoo(source 'yahoo') 또는 Yahoo가 주지 않는 지표의 KRX(source 'krx', 코스피 200)다. (symbol, time)이 유일해서 날짜당 1행.
  // - 그 날짜에 집계 버킷이 있으면 집계가 우선이라 같은 날짜가 두 번 나오지 않는다.
  // - 일봉 시각은 집계 버킷과 같은 기준(UTC 자정)으로 맞춘다. 1일·1주(5분·1시간 봉)는 해상도가 달라 붙이지 않는다.
  // 장 시간이 정해진 시장의 지표(T-136, D-81)는 반대로 일봉(공식 종가)을 먼저 쓰고, 일봉이 없는 날(오늘·아직 받지 않은 날)만 집계를 쓴다.
  // 스택이 장의 일부만 떠 있던 날 집계 종가가 틀리는 문제(B-49) 때문. 집계 자체는 바꾸지 않는다.
  if (view === 'market_1d' && usesOfficialDailyClose(ticker)) {
    const { rows } = await dbPool.query<HistoryPoint>(
      `WITH daily AS (
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
      [ticker, range]
    );
    return rows;
  }
  if (view === 'market_1d') {
    const { rows } = await dbPool.query<HistoryPoint>(
      `WITH agg AS (
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
      [ticker, range]
    );
    return rows;
  }
  // 1일·1주(5분·1시간 봉, T-151): 스택이 꺼져 있던 구간처럼 집계에 없는 시각만 Yahoo 봉(market_bars_fill)으로 채운다. 집계가 항상 우선이다.
  const { rows } = await dbPool.query<HistoryPoint>(
    `WITH agg AS (
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
    [ticker, range, fill]
  );
  return rows;
}

// 두 지표의 차이 (T-107, 미 장단기 금리차). 저장하지 않고 조회할 때 같은 버킷끼리 뺀다. 한쪽에만 있는 시각은 버린다.
// 버킷 경계가 같은 집계(과거 일봉도 UTC 자정으로 맞춤)를 쓰므로 시각이 정확히 맞는다.
async function getSpreadHistory(ticker: DerivedSymbol, timeframe: Timeframe): Promise<HistoryPoint[]> {
  const { long, short } = DERIVED_SPREADS[ticker];
  const [longPoints, shortPoints] = await Promise.all([getHistory(long, timeframe), getHistory(short, timeframe)]);
  const shortByTime = new Map(shortPoints.map(point => [point.time, point.value]));
  return longPoints.flatMap(point => {
    const shortValue = shortByTime.get(point.time);
    return shortValue === undefined ? [] : [{ time: point.time, value: Math.round((point.value - shortValue) * 10000) / 10000 }];
  });
}

// KRX 일별 지수 (T-67): 하루 1개 값이라 1주 ~ 1년만 제공한다. "1일"은 일별 시세로 그릴 수 없어서 daily_only로 알린다.
async function getDailyIndexHistory(ticker: KrxDailySymbol, timeframe: Timeframe): Promise<HistoryPoint[]> {
  const { range } = DB_TIMEFRAMES[timeframe];
  const { rows } = await dbPool.query<HistoryPoint>(
    `SELECT (extract(epoch FROM time) * 1000)::float8 AS time, close::float8 AS value
     FROM index_daily
     WHERE symbol = $1 AND time >= now() - $2::interval
     ORDER BY time`,
    [ticker, range]
  );
  return rows;
}

// 섹터 기간 수익률 (D-66, 화면의 섹터 노드). 섹터마다 기간 안의 첫 종가 대비 마지막 종가.
// 섹터 목록은 고정 표에서만 가져오고, 기간은 고정 표(DB_TIMEFRAMES)에서 고른다.
const SECTOR_RETURNS_CACHE_TTL_S = 60;
interface SectorReturn { symbol: string; returnPct: number | null; last: number; dayChangeRate: number; lastTime: number; points: number }

export async function getSectorReturns(timeframe: Timeframe): Promise<SectorReturn[]> {
  const { range } = DB_TIMEFRAMES[timeframe];
  const { rows } = await dbPool.query<{ symbol: string; first: number; last: number; dayChangeRate: number; lastTime: number; points: number }>(
    `SELECT symbol,
            (array_agg(close ORDER BY time))[1] AS first,
            (array_agg(close ORDER BY time DESC))[1] AS last,
            (array_agg(change_rate ORDER BY time DESC))[1] AS "dayChangeRate",
            (extract(epoch FROM max(time)) * 1000)::float8 AS "lastTime",
            count(*)::int AS points
     FROM index_daily
     WHERE symbol = ANY($1::text[]) AND time >= now() - $2::interval
     GROUP BY symbol`,
    [KRX_SECTOR_KEYS, range]
  );
  // 점이 2개 미만이면 수익률을 0이 아니라 null(계산 불가)로 둔다
  return rows.map(row => ({
    symbol: row.symbol,
    returnPct: row.points >= 2 && row.first > 0 ? (row.last / row.first - 1) * 100 : null,
    last: row.last,
    dayChangeRate: row.dayChangeRate,
    lastTime: row.lastTime,
    points: row.points,
  }));
}

// 시장 폭·거래대금 (T-106): 시장별 일별 상승·하락·보합 종목 수와 거래대금(원). 기간은 고정 표(DB_TIMEFRAMES)에서 고른다.
// coverage는 기간과 상관없이 시장별 저장된 첫·마지막 날짜(서울 기준)로, krx-collector가 빠진 기간만 채우는 데 쓴다 (SEC-014 방식).
const BREADTH_CACHE_TTL_S = 60;
interface BreadthPoint { time: number; advancers: number; decliners: number; unchanged: number; stocks: number; tradingValue: number }

async function getBreadth(timeframe: Timeframe) {
  const { range } = DB_TIMEFRAMES[timeframe];
  const { rows } = await dbPool.query<BreadthPoint & { market: string }>(
    `SELECT market, (extract(epoch FROM time) * 1000)::float8 AS time, advancers, decliners, unchanged, stocks,
            trading_value::float8 AS "tradingValue"
     FROM market_breadth
     WHERE time >= now() - $1::interval
     ORDER BY time`,
    [range]
  );
  const coverageRows = await dbPool.query<{ market: string; since: string; until: string }>(
    `SELECT market,
            to_char(min(time) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS since,
            to_char(max(time) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS until
     FROM market_breadth
     GROUP BY market`
  );
  const data = {} as Record<BreadthMarket, BreadthPoint[]>;
  const coverage = {} as Record<BreadthMarket, { since: string; until: string } | null>;
  for (const market of BREADTH_MARKETS) {
    data[market] = rows.filter(row => row.market === market).map(row => ({
      time: row.time, advancers: row.advancers, decliners: row.decliners, unchanged: row.unchanged, stocks: row.stocks, tradingValue: row.tradingValue,
    }));
    const found = coverageRows.rows.find(row => row.market === market);
    coverage[market] = found ? { since: found.since, until: found.until } : null;
  }
  return { data, coverage };
}

// 시장 연관성·리스크 (15단계 T-110): 코스피와 상대 지표 6종의 1년치 일봉(1년 그래프와 같은 병합 결과)으로 계산한다.
// 저장하지 않는다. 일봉이라 하루에 한 번 바뀌므로 10분 캐시.
const RISK_CACHE_TTL_S = 600;

async function getMarketRisk(range: RiskRange) {
  const symbols = [RISK_BASE, ...RISK_TARGETS.map(target => target.symbol)] as YahooSymbolKey[];
  const histories = await Promise.all(symbols.map(symbol => getHistory(symbol, '1년')));
  const series = Object.fromEntries(symbols.map((symbol, index) => [symbol, histories[index] ?? []]));
  return computeMarketRisk(range, series, Date.now());
}

// 종목 순위 (15단계 T-113): 시장·순위 종류·날짜(서울)별 상위 100개. 날짜를 주지 않으면 그 시장의 가장 최근 날짜.
// 순위 종류는 고정 표에서 칼럼 이름을 고른다(사용자 입력으로 SQL을 만들지 않음). coverage는 수집기의 빠진 기간 채우기용(SEC-014 방식).
const RANKINGS_CACHE_TTL_S = 60;
const RANK_COLUMNS: Record<RankingType, string> = { gain: 'rank_gain', loss: 'rank_loss', value: 'rank_value', cap: 'rank_cap' };

async function getRankings(market: string, type: RankingType, date: string | undefined) {
  const column = RANK_COLUMNS[type];
  const { rows } = await dbPool.query<{ date: string | null }>(
    date
      ? `SELECT to_char($2::date, 'YYYY-MM-DD') AS date WHERE EXISTS (SELECT 1 FROM stock_rankings WHERE market = $1 AND (time AT TIME ZONE 'Asia/Seoul')::date = $2::date)`
      : `SELECT to_char(max(time) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date FROM stock_rankings WHERE market = $1`,
    date ? [market, date] : [market]
  );
  const selected = rows[0]?.date ?? null;
  const items = selected === null ? [] : (await dbPool.query(
    `SELECT ${column}::int AS rank, code, name, close::float8 AS close, change_rate::float8 AS "changeRate",
            trading_value::float8 AS "tradingValue", market_cap::float8 AS "marketCap"
     FROM stock_rankings
     WHERE market = $1 AND (time AT TIME ZONE 'Asia/Seoul')::date = $2::date AND ${column} IS NOT NULL
     ORDER BY ${column}`,
    [market, selected]
  )).rows;
  const coverageRows = await dbPool.query<{ market: string; since: string; until: string }>(
    `SELECT market,
            to_char(min(time) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS since,
            to_char(max(time) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS until
     FROM stock_rankings GROUP BY market`
  );
  const coverage = Object.fromEntries(RANKING_MARKETS.map(name => {
    const found = coverageRows.rows.find(row => row.market === name);
    return [name, found ? { since: found.since, until: found.until } : null];
  }));
  return { market, type, date: selected, items, coverage };
}

// 최근 tick (T-25). 시각은 소스 기준 시각(실시간 tick의 timestamp와 같은 기준)이다.
async function getRecentTicks(ticker: YahooSymbolKey): Promise<HistoryPoint[]> {
  const { rows } = await dbPool.query<HistoryPoint>(
    `SELECT (extract(epoch FROM time) * 1000)::float8 AS time, price::float8 AS value
     FROM market_ticks
     WHERE symbol = $1
     ORDER BY time DESC
     LIMIT $2`,
    [ticker, RECENT_TICKS_LIMIT]
  );
  return rows.reverse();
}

export const historyController = async (fastify: FastifyInstance) => {
  // worker 재시작 중복 방지 (T-133): Yahoo 지표별 마지막 전송 tick(Gateway가 둔 Redis 최신값)의 소스 시각·장 상태만 돌려준다.
  // 입력이 없고 고정 목록(27종)만 읽는다. 가격 등 다른 값은 내보내지 않는다(공개 시세의 시각 정보).
  fastify.get('/api/v1/market/latest-times', async (_request, reply) => {
    if (redis.status !== 'ready') return reply.code(503).send({ error: 'cache unavailable' });
    try {
      const values = await redis.mget(YAHOO_KEYS.map(key => `latest_tick:${key}`));
      const data = YAHOO_KEYS.flatMap((symbol, index) => {
        const raw = values[index];
        if (!raw) return [];
        try {
          const tick = JSON.parse(raw) as { timestamp?: unknown; marketState?: unknown };
          if (typeof tick.timestamp !== 'number' || !Number.isFinite(tick.timestamp)) return [];
          return [isMarketState(tick.marketState) ? { symbol, timestamp: tick.timestamp, marketState: tick.marketState } : { symbol, timestamp: tick.timestamp }];
        } catch {
          return [];
        }
      });
      return { data };
    } catch (err) {
      console.error('Error reading latest tick times:', err instanceof Error ? err.message : String(err));
      return reply.code(500).send({ error: 'Failed to read latest tick times' });
    }
  });

  // 소스 지연 측정값 (T-162): 화면의 "지연 N분" 배지용. 입력이 없고 고정 목록(Yahoo 27종)만 읽는다.
  // Gateway가 장중에 남긴 마지막 측정값이라 주말·연휴에도 직전 장의 값이 나온다. 측정값이 없는 지표는 빠진다.
  fastify.get('/api/v1/market/source-lags', async (_request, reply) => {
    try {
      return { data: await marketService.readSourceLags(YAHOO_KEYS) };
    } catch (err) {
      console.error('Error reading source lags:', err instanceof Error ? err.message : String(err));
      return reply.code(500).send({ error: 'Failed to read source lags' });
    }
  });

  // 코스피 200 등의 빈 날 찾기 (T-155): KRX 표에 저장된 날짜만 돌려준다. 입력이 없고 고정 목록만 읽는다. 값은 내보내지 않는다(공개 날짜 정보)
  fastify.get('/api/v1/market/krx-history-days', async (_request, reply) => {
    try {
      const { rows } = await dbPool.query<{ symbol: string; days: string[] }>(
        `SELECT symbol, array_agg(to_char(time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') ORDER BY time) AS days
         FROM index_daily_krx WHERE symbol = ANY($1::text[]) GROUP BY symbol`,
        [KRX_HISTORY_KEYS]
      );
      return { data: Object.fromEntries(KRX_HISTORY_KEYS.map(symbol => [symbol, rows.find(row => row.symbol === symbol)?.days ?? []])) };
    } catch (err) {
      console.error('Error reading KRX history days:', err instanceof Error ? err.message : String(err));
      return reply.code(500).send({ error: 'Failed to read KRX history days' });
    }
  });

  fastify.get('/api/v1/market/recent', async (request, reply) => {
    const startedAt = Date.now();
    const { ticker } = request.query as { ticker?: string };

    // 알 수 없는 심볼은 받지 않는다. 응답에도 받은 값을 되돌려 쓰지 않는다 (SEC-005와 같은 기준).
    if (!isSubscribableSymbol(ticker)) {
      return reply.code(400).send({ error: 'a known ticker is required' });
    }
    if (!isYahooSymbolKey(ticker)) {
      recentDuration.observe({ result: 'not_ready' }, Date.now() - startedAt);
      return { ticker, data: [], status: 'not_ready' };
    }

    try {
      const cacheKey = `recent:${ticker}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        recentDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }

      const responsePayload = { ticker, data: await getRecentTicks(ticker) };
      cache.writeJson(cacheKey, responsePayload, RECENT_CACHE_TTL_S);
      recentDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return responsePayload;
    } catch (err) {
      recentDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error(`Error fetching recent ticks for ${ticker}:`, err);
      return reply.code(500).send({ error: 'Failed to fetch recent ticks' });
    }
  });

  // 섹터 기간 수익률 (D-66). "1일"은 일별 시세로 계산할 수 없어 받지 않는다.
  fastify.get('/api/v1/market/sector-returns', async (request, reply) => {
    const startedAt = Date.now();
    const { range } = request.query as { range?: string };
    if (!range || range === '1일' || !isTimeframe(range)) {
      return reply.code(400).send({ error: 'a valid range (1주, 1개월, 3개월, 1년) is required' });
    }
    try {
      const cacheKey = `sector-returns:${range}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        historyDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }
      const payload = { range, data: await getSectorReturns(range) };
      cache.writeJson(cacheKey, payload, SECTOR_RETURNS_CACHE_TTL_S);
      historyDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      historyDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching sector returns:', err);
      return reply.code(500).send({ error: 'Failed to fetch sector returns' });
    }
  });

  // 시장 폭·거래대금 (T-106). "1일"은 일별 값이라 받지 않는다.
  fastify.get('/api/v1/market/breadth', async (request, reply) => {
    const startedAt = Date.now();
    const { range } = request.query as { range?: string };
    if (!range || range === '1일' || !isTimeframe(range)) {
      return reply.code(400).send({ error: 'a valid range (1주, 1개월, 3개월, 1년) is required' });
    }
    try {
      const cacheKey = `breadth:${range}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        historyDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }
      const payload = { range, ...(await getBreadth(range)) };
      cache.writeJson(cacheKey, payload, BREADTH_CACHE_TTL_S);
      historyDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      historyDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching market breadth:', err);
      return reply.code(500).send({ error: 'Failed to fetch market breadth' });
    }
  });

  // 종목 순위 (T-113). 시장·종류는 고정 목록, 날짜는 형식과 실제 날짜인지 검사한 뒤 매개변수로만 넘긴다.
  fastify.get('/api/v1/market/rankings', async (request, reply) => {
    const startedAt = Date.now();
    const { market, type, date } = request.query as { market?: string; type?: string; date?: string };
    if (!isRankingMarket(market) || !isRankingType(type) || (date !== undefined && !isCalendarDate(date))) {
      return reply.code(400).send({ error: 'market (KOSPI, KOSDAQ), type (gain, loss, value, cap) and an optional date (YYYY-MM-DD) are required' });
    }
    try {
      const cacheKey = `rankings:${market}:${type}:${date ?? 'latest'}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        historyDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }
      const payload = await getRankings(market, type, date);
      cache.writeJson(cacheKey, payload, RANKINGS_CACHE_TTL_S);
      historyDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      historyDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching stock rankings:', err);
      return reply.code(500).send({ error: 'Failed to fetch stock rankings' });
    }
  });

  // 시장 연관성·리스크 (T-110). 기간은 고정 목록(1개월·3개월·1년)만 받는다.
  fastify.get('/api/v1/market/risk', async (request, reply) => {
    const startedAt = Date.now();
    const { range } = request.query as { range?: string };
    if (!isRiskRange(range)) {
      return reply.code(400).send({ error: 'a valid range (1개월, 3개월, 1년) is required' });
    }
    try {
      const cacheKey = `market-risk:${range}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        historyDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }
      const payload = await getMarketRisk(range);
      cache.writeJson(cacheKey, payload, RISK_CACHE_TTL_S);
      historyDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      historyDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error('Error computing market risk:', err);
      return reply.code(500).send({ error: 'Failed to compute market risk' });
    }
  });

  fastify.get('/api/v1/market/history', async (request, reply) => {
    const startedAt = Date.now();
    const { ticker, timeframe } = request.query as { ticker?: string; timeframe?: string };

    if (!ticker || !timeframe || !isTimeframe(timeframe)) {
      return reply.code(400).send({ error: 'ticker and a valid timeframe are required' });
    }

    // KRX 일별 지수(VKOSPI·섹터 5종, T-67)는 index_daily에서, "1일"은 일별 시세로 그릴 수 없어서 daily_only
    const daily = isKrxDailySymbol(ticker);
    if (daily && timeframe === '1일') {
      historyDuration.observe({ result: 'not_ready' }, Date.now() - startedAt);
      return { ticker, timeframe, data: [], status: 'daily_only' };
    }
    // 그 밖에 Yahoo 심볼이 없는 지표는 mock 대신 "준비 중"을 돌려준다 (R-04, T-20). 계산 지표(T-107)는 아래에서 계산
    const derived = isDerivedSymbol(ticker);
    if (!daily && !derived && !isYahooSymbolKey(ticker)) {
      historyDuration.observe({ result: 'not_ready' }, Date.now() - startedAt);
      return { ticker, timeframe, data: [], status: 'not_ready' };
    }

    try {
      const cacheKey = `history:db:${ticker}:${timeframe}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        historyDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }

      const data = daily
        ? await getDailyIndexHistory(ticker, timeframe)
        : derived
          ? await getSpreadHistory(ticker, timeframe)
          : await getHistory(ticker as YahooSymbolKey, timeframe);
      const responsePayload = { ticker, timeframe, data };
      cache.writeJson(cacheKey, responsePayload, HISTORY_CACHE_TTL_S);

      historyDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return responsePayload;
    } catch (err) {
      historyDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error(`Error fetching historical data for ${ticker}:`, err);
      return reply.code(500).send({ error: 'Failed to fetch historical data' });
    }
  });
};

// 검증용 자체 점검 (기본 끔). 에이전트는 curl이나 브라우저를 쓸 수 없어서, backend가 직접 조회한 결과를 요약 로그로 남긴다.
// 캐시를 거치지 않으므로 조회 시간은 캐시 miss 때의 시간과 같다.
// SAMSUNG·GOLD: 과거 일봉을 이어 붙이는 지표(T-104 ③)의 확인용
const SELF_CHECK_TICKERS: YahooSymbolKey[] = ['KOSPI', 'SP500', 'USD/KRW', 'SAMSUNG', 'GOLD'];

export function startHistorySelfCheck() {
  if (!HISTORY_SELF_CHECK) return;
  console.warn('HISTORY_SELF_CHECK=true: logging history query summaries every 60s (verification only).');

  setInterval(async () => {
    const results: Record<string, unknown>[] = [];
    for (const ticker of SELF_CHECK_TICKERS) {
      for (const timeframe of TIMEFRAMES) {
        const startedAt = Date.now();
        try {
          const data = await getHistory(ticker, timeframe);
          const durationMs = Date.now() - startedAt;
          selfCheckDuration.observe({}, durationMs);
          const first = data[0];
          const last = data[data.length - 1];
          results.push({
            ticker,
            timeframe,
            points: data.length,
            span_h: first && last ? Math.round(((last.time - first.time) / 3600000) * 10) / 10 : 0,
            last_age_s: last ? Math.round((Date.now() - last.time) / 1000) : null,
            non_positive: data.filter(point => point.value <= 0).length,
            ms: durationMs,
          });
        } catch (error) {
          results.push({ ticker, timeframe, error: error instanceof Error ? error.message : String(error) });
        }
      }

      // 최근 tick API (T-25)
      const startedAt = Date.now();
      try {
        const data = await getRecentTicks(ticker);
        const last = data[data.length - 1];
        const ordered = data.every((point, index) => index === 0 || point.time > (data[index - 1]?.time ?? 0));
        results.push({
          ticker,
          timeframe: 'recent',
          points: data.length,
          last_age_s: last ? Math.round((Date.now() - last.time) / 1000) : null,
          ordered,
          non_positive: data.filter(point => point.value <= 0).length,
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        results.push({ ticker, timeframe: 'recent', error: error instanceof Error ? error.message : String(error) });
      }
    }
    // 계산 지표 (T-107): 점 수와 값 범위만 남긴다
    for (const ticker of Object.keys(DERIVED_SPREADS) as DerivedSymbol[]) {
      for (const timeframe of TIMEFRAMES) {
        try {
          const data = await getSpreadHistory(ticker, timeframe);
          const values = data.map(point => point.value);
          results.push({ ticker, timeframe, points: data.length, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null });
        } catch (error) {
          results.push({ ticker, timeframe, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    console.log(`[history-check] ${JSON.stringify({ results })}`);

    // 섹터 수익률 (D-66): 섹터 수, 계산된 수, 최고·최저 수익률만 남긴다
    try {
      const sectors = await getSectorReturns('1개월');
      const valid = sectors.filter(sector => sector.returnPct !== null).sort((a, b) => (b.returnPct ?? 0) - (a.returnPct ?? 0));
      const round = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 100) / 100);
      console.log(`[sector-check] ${JSON.stringify({
        range: '1개월', sectors: sectors.length, withReturn: valid.length,
        top: valid[0] ? { symbol: valid[0].symbol, returnPct: round(valid[0].returnPct) } : null,
        bottom: valid.at(-1) ? { symbol: valid.at(-1)?.symbol, returnPct: round(valid.at(-1)?.returnPct) } : null,
        minPoints: Math.min(...sectors.map(sector => sector.points)),
      })}`);
    } catch (error) {
      console.error(`[sector-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 시장 연관성·리스크 (T-110): 기간별 점·짝 수와 계산값만 남긴다(공개 시세에서 계산한 숫자)
    try {
      for (const range of Object.keys(RISK_RANGES) as RiskRange[]) {
        const startedAt = Date.now();
        const risk = await getMarketRisk(range);
        console.log(`[risk-check] ${JSON.stringify({
          range,
          ms: Date.now() - startedAt,
          base: risk.base.stats,
          targets: risk.targets.map(target => ({
            symbol: target.symbol, points: target.stats.points, periodChange: target.stats.periodChange, volatility: target.stats.volatility,
            same: target.sameDay, lag: target.lagged,
          })),
        })}`);
      }
    } catch (error) {
      console.error(`[risk-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 종목 순위 (T-113): 시장별 최근 날짜의 순위별 개수·1위 종목코드·저장 범위만 남긴다(공개 정보)
    try {
      for (const market of RANKING_MARKETS) {
        const counts: Record<string, unknown> = {};
        let date: string | null = null;
        let coverage: unknown = null;
        for (const type of Object.keys(RANK_COLUMNS) as RankingType[]) {
          const result = await getRankings(market, type, undefined);
          date = result.date;
          coverage = result.coverage[market];
          const ranks = result.items.map(item => (item as { rank: number }).rank);
          counts[type] = { n: ranks.length, first: (result.items[0] as { code?: string } | undefined)?.code ?? null, contiguous: ranks.every((rank, index) => rank === index + 1) };
        }
        console.log(`[rankings-check] ${JSON.stringify({ market, date, coverage, counts })}`);
      }
    } catch (error) {
      console.error(`[rankings-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 1일 봉 종가 점검 (D-80 진단): 국내 지표의 가장 최근 1일 봉 종가와 Redis 최신값(Gateway가 받은 마지막 tick)을 비교한다.
    // 스택이 장의 일부 시간만 떠 있던 날은 1일 봉 종가가 실제 마지막 값과 다를 수 있다(공개 시세 값만 기록)
    try {
      const checks: Record<string, unknown>[] = [];
      for (const ticker of ['KOSPI', 'KOSDAQ', 'SAMSUNG'] as YahooSymbolKey[]) {
        const { rows } = await dbPool.query<{ day: string; close: number }>(
          `SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, close::float8 AS close
           FROM market_1d WHERE symbol = $1 ORDER BY bucket DESC LIMIT 1`,
          [ticker]
        );
        const raw = redis.status === 'ready' ? await redis.get(`latest_tick:${ticker}`) : null;
        const latest = raw ? (JSON.parse(raw) as { price?: number; timestamp?: number }) : null;
        const latestDay = typeof latest?.timestamp === 'number' ? new Date(latest.timestamp).toISOString().slice(0, 10) : null;
        checks.push({
          ticker, barDay: rows[0]?.day ?? null, barClose: rows[0]?.close ?? null,
          latestDay, latestPrice: latest?.price ?? null,
          sameDay: rows[0]?.day === latestDay, matches: rows[0]?.day === latestDay && rows[0]?.close === latest?.price,
        });
      }
      console.log(`[close-check] ${JSON.stringify(checks)}`);
    } catch (error) {
      console.error(`[close-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 공식 종가 보정 점검 (T-136, B-51): 최근 14일, Yahoo 27종 전부(공개 시세 값만)
    // - 장 시간이 정해진 시장 17종: 집계 종가가 공식 종가(Yahoo 일봉)와 다른 날(이전 규칙에서 그래프가 보여 주던 값), 지금 API 값이 공식 종가와 다른 날
    // - 24시간 시장 10종: API 값이 집계와 다른 날(이전 규칙 그대로인지)
    // - 모두: 집계나 일봉이 있는 날인데 API에 없는 날, 두 번 나오는 날
    // KRX로 대조할 수 있는 5종은 날짜별 값을 따로 남긴다([official-close-values] ↔ krx-collector [krx-close-check])
    try {
      const official: Record<string, unknown>[] = [];
      const aggFirst: Record<string, unknown>[] = [];
      const values: Record<string, unknown> = {};
      const differs = (a: number, b: number) => Math.abs(a - b) > 0.005;
      for (const ticker of YAHOO_KEYS) {
        const { rows } = await dbPool.query<{ day: string; agg: number | null; daily: number | null }>(
          `SELECT day, max(agg) AS agg, max(daily) AS daily FROM (
             SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, close::float8 AS agg, NULL::float8 AS daily
             FROM market_1d WHERE symbol = $1 AND bucket >= now() - INTERVAL '14 days'
             UNION ALL
             SELECT to_char(time_bucket(INTERVAL '1 day', time) AT TIME ZONE 'UTC', 'YYYY-MM-DD'), NULL, close::float8
             FROM index_daily WHERE symbol = $1 AND time >= now() - INTERVAL '14 days'
           ) x GROUP BY day ORDER BY day`,
          [ticker]
        );
        const apiPoints = (await getHistory(ticker, '1개월')).map(point => ({ day: new Date(point.time).toISOString().slice(0, 10), value: point.value }));
        const api = new Map(apiPoints.map(point => [point.day, point.value]));
        const missingDays = rows.filter(row => !api.has(row.day)).map(row => row.day);
        const duplicateDays = [...new Set(apiPoints.filter((point, index) => apiPoints.findIndex(other => other.day === point.day) !== index).map(point => point.day))];
        if (usesOfficialDailyClose(ticker)) {
          official.push({
            ticker, days: rows.length, officialDays: rows.filter(row => row.daily !== null).length,
            aggOnlyDays: rows.filter(row => row.agg !== null && row.daily === null).map(row => row.day),
            aggWrong: rows.filter(row => row.agg !== null && row.daily !== null && differs(row.agg, row.daily)).length,
            apiWrongDays: rows.filter(row => row.daily !== null && api.has(row.day) && differs(api.get(row.day) ?? 0, row.daily)).map(row => row.day),
            missingDays, duplicateDays,
          });
          if (['KOSPI', 'KOSPI200', 'SAMSUNG', 'SK_HYNIX', 'HYUNDAI'].includes(ticker)) {
            values[ticker] = Object.fromEntries(rows.map(row => [row.day, { agg: row.agg, daily: row.daily, api: api.get(row.day) ?? null }]));
          }
        } else {
          aggFirst.push({
            ticker, days: rows.length,
            apiNotAggDays: rows.filter(row => row.agg !== null && api.has(row.day) && differs(api.get(row.day) ?? 0, row.agg)).map(row => row.day),
            missingDays, duplicateDays,
          });
        }
      }
      console.log(`[official-close-check] ${JSON.stringify(official)}`);
      console.log(`[official-close-values] ${JSON.stringify(values)}`);
      console.log(`[agg-first-check] ${JSON.stringify(aggFirst)}`);
    } catch (error) {
      console.error(`[official-close-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 1일·1주 공백 채우기 (T-151, B-58): 같은 시점의 집계만 점 수와 합친 뒤 점 수, 집계 값 변화, 같은 시각 중복, 0 이하 값.
    // overlap: 봉과 집계가 둘 다 있는 시각의 수와 차이(%). 봉 시각을 버킷에 맞춘 방식이 맞는지 보는 값이다(공개 시세에서 계산한 숫자)
    try {
      const results: Record<string, unknown>[] = [];
      for (const ticker of YAHOO_KEYS) {
        for (const timeframe of ['1일', '1주'] as const) {
          const { view, range, fill } = DB_TIMEFRAMES[timeframe];
          const agg = await dbPool.query<HistoryPoint>(
            `SELECT (extract(epoch FROM bucket) * 1000)::float8 AS time, close::float8 AS value FROM ${view}
             WHERE symbol = $1 AND bucket >= now() - $2::interval ORDER BY bucket`,
            [ticker, range]
          );
          const merged = await getHistory(ticker, timeframe);
          const mergedByTime = new Map(merged.map(point => [point.time, point.value]));
          const overlap = await dbPool.query<{ n: number; median_pct: number | null; max_pct: number | null }>(
            `SELECT count(*)::int AS n,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(f.close - a.close::float8) / a.close::float8 * 100) AS median_pct,
                    max(abs(f.close - a.close::float8) / a.close::float8 * 100) AS max_pct
             FROM market_bars_fill f JOIN ${view} a ON a.symbol = f.symbol AND a.bucket = f.time
             WHERE f.symbol = $1 AND f.resolution = $2 AND f.time >= now() - $3::interval`,
            [ticker, fill, range]
          );
          const round = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 10000) / 10000);
          results.push({
            ticker, timeframe, agg: agg.rows.length, merged: merged.length,
            aggChanged: agg.rows.filter(point => mergedByTime.get(point.time) !== point.value).length,
            duplicates: merged.length - mergedByTime.size,
            nonPositive: merged.filter(point => point.value <= 0).length,
            overlap: overlap.rows[0]?.n ?? 0, medianPct: round(overlap.rows[0]?.median_pct), maxPct: round(overlap.rows[0]?.max_pct),
          });
        }
      }
      console.log(`[bars-fill-check] ${JSON.stringify(results)}`);
    } catch (error) {
      console.error(`[bars-fill-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 증시 자금 흐름 일별 통계 (11단계 B′): 가장 최근 기준일의 지표별 값. 공식 명세에 단위가 없어
    // 원본 통계 사이트(금융투자협회 종합통계)의 같은 날 숫자와 비교해 단위·이름을 확정하는 데 쓴다(공개 통계 값)
    try {
      const { rows } = await dbPool.query<{ day: string; metric: string; value: number }>(
        `SELECT to_char(time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day, metric, value::float8 AS value
         FROM market_flows WHERE time = (SELECT max(time) FROM market_flows) ORDER BY metric`
      );
      console.log(`[flows-check] ${JSON.stringify({ day: rows[0]?.day ?? null, values: Object.fromEntries(rows.map(row => [row.metric, row.value])) })}`);
    } catch (error) {
      console.error(`[flows-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 60000);
}
