import type { FastifyInstance } from 'fastify';
import { cache } from '../../infrastructure/redis.js';
import { dbPool } from '../../infrastructure/db.js';
import { Latency } from '../../infrastructure/metrics.js';
import { DISCLOSURE_SCOPE, isDisclosureGroup, targetStockCodes } from '../../shared/disclosures.js';
import { KOSPI100 } from '../../shared/disclosure-targets.js';
import { isCalendarDate, isCalendarMonth, nextDay, nextMonthStart } from '../../shared/disclosure-calendar.js';

// 공시·자본 이벤트 조회 API (docs/Task_ORDER.md 12단계 T-77)
// GET /api/v1/disclosures/recent?group=all|dilution|...      최근 공시 100건 (개수 고정)
// GET /api/v1/disclosures/capital-events?range=1주|1개월|3개월|1년   기간별 희석·주주환원·자사주 처분 금액과 건수
// 그룹·기간은 고정된 표에서만 고르고, 값은 매개변수로만 SQL에 넘긴다. KOSPI 100 명단이 있으면 그 종목만 조회한다.

const requestDuration = new Latency('kospi_disclosures_request_duration_seconds', 'Disclosures API response time by endpoint and result');

const RECENT_LIMIT = 100;
const RECENT_CACHE_TTL_S = 10;
const EVENTS_CACHE_TTL_S = 60;
// 기간 → 조회 범위(일)와 묶음 단위
const RANGES: Record<string, { days: number; bucket: 'day' | 'week' }> = {
  '1주': { days: 7, bucket: 'day' },
  '1개월': { days: 30, bucket: 'day' },
  '3개월': { days: 90, bucket: 'week' },
  '1년': { days: 365, bucket: 'week' },
};
const CAPITAL_GROUPS = ['dilution', 'shareholder_return', 'treasury_disposal'];

// 대상 종목 조건 (명단이 없으면 조건 없음). 종목코드 배열은 매개변수로 넘긴다.
const targetCodes = targetStockCodes();
const targetClause = (param: number) => (targetCodes.length > 0 ? `AND stock_code = ANY($${param}::text[])` : '');
const targetParams = () => (targetCodes.length > 0 ? [targetCodes] : []);

const scopeInfo = () => ({ scope: DISCLOSURE_SCOPE, scopeAsOf: KOSPI100.asOf });

async function getRecent(group: string) {
  const groupClause = group === 'all' ? '' : 'AND event_group = $2';
  const params: unknown[] = [RECENT_LIMIT];
  if (group !== 'all') params.push(group);
  const { rows } = await dbPool.query(
    `SELECT rcept_no AS "rceptNo", to_char(rcept_date, 'YYYY-MM-DD') AS "rceptDate", stock_code AS "stockCode",
            corp_name AS "corpName", report_name AS "reportName", event_group AS "group", event_kind AS "kind",
            is_correction AS "isCorrection", amount
     FROM disclosures
     WHERE rcept_date >= current_date - 30 ${groupClause} ${targetClause(params.length + 1)}
     ORDER BY rcept_no DESC
     LIMIT $1`,
    [...params, ...targetParams()]
  );
  return rows;
}

// 저장된 전체 범위(첫·마지막 접수일). 수집기가 시작할 때 빠진 기간만 채우는 데 쓴다 (docs/security.md SEC-014).
// 날짜 두 개만 돌려주며, 대상 범위와 상관없이 테이블 전체 기준이다.
async function getCoverage() {
  const { rows } = await dbPool.query<{ since: string | null; until: string | null }>(
    `SELECT to_char(min(rcept_date), 'YYYY-MM-DD') AS since, to_char(max(rcept_date), 'YYYY-MM-DD') AS until FROM disclosures`
  );
  return { since: rows[0]?.since ?? null, until: rows[0]?.until ?? null };
}

// 정정 사슬 묶기 (docs/Task_ORDER.md T-82, BENCHMARK B-30·B-34)
// 같은 회사·같은 종류의 공시를 접수번호 순서로 놓고 "원 공시 1건 + 뒤따르는 정정 공시"를 한 사건으로 묶는다
// (원 공시가 나올 때마다 사건 번호가 1 늘어남). 사건마다 금액이 있는 가장 늦은 공시(최종본)의 금액을 한 번만 센다.
// 이유(B-30): 정정이 생기면 금액 API는 최종본만 돌려줘서 원 공시·중간 정정본은 금액이 비고, 최종본은 정정 공시라
// 이전 규칙("정정 공시 제외")에서는 그 사건의 금액이 합계에서 통째로 빠졌다.
// 사건 날짜는 사건의 첫 공시 접수일. 기간 경계에 걸친 사건을 바르게 묶으려고 CHAIN_LOOKBACK_DAYS만큼 더 앞에서부터 읽는다.
const CHAIN_LOOKBACK_DAYS = 120;
const eventsCte = (targetParam: number) => `
  WITH base AS (
    SELECT rcept_no, rcept_date, corp_code, corp_name, report_name, event_group, event_kind, is_correction, amount,
           sum(CASE WHEN is_correction THEN 0 ELSE 1 END)
             OVER (PARTITION BY corp_code, event_kind ORDER BY rcept_no ROWS UNBOUNDED PRECEDING) AS chain
    FROM disclosures
    WHERE event_group = ANY($2::text[]) AND rcept_date >= current_date - ($1::int + ${CHAIN_LOOKBACK_DAYS}) ${targetClause(targetParam)}
  ),
  events AS (
    SELECT event_kind, min(event_group) AS event_group, min(rcept_date) AS event_date,
           (array_agg(amount ORDER BY rcept_no DESC) FILTER (WHERE amount IS NOT NULL))[1] AS amount,
           (array_agg(rcept_no ORDER BY rcept_no DESC))[1] AS latest_rcept_no,
           (array_agg(rcept_date ORDER BY rcept_no DESC))[1] AS latest_date,
           (array_agg(corp_name ORDER BY rcept_no DESC))[1] AS corp_name,
           (array_agg(report_name ORDER BY rcept_no DESC))[1] AS report_name,
           count(*)::int AS filings,
           bool_or(is_correction) AS corrected
    FROM base
    GROUP BY corp_code, event_kind, chain
  )`;

async function getCapitalEvents(days: number, bucket: 'day' | 'week') {
  const bucketExpr = bucket === 'day' ? 'event_date' : `time_bucket(INTERVAL '1 week', event_date)`;
  const params = [days, CAPITAL_GROUPS, ...targetParams()];

  const buckets = await dbPool.query(
    `${eventsCte(3)}
     SELECT to_char(${bucketExpr}, 'YYYY-MM-DD') AS "date",
            COALESCE(sum(amount) FILTER (WHERE event_group = 'dilution'), 0)::float8 AS "dilution",
            COALESCE(sum(amount) FILTER (WHERE event_group = 'shareholder_return'), 0)::float8 AS "shareholderReturn",
            COALESCE(sum(amount) FILTER (WHERE event_group = 'treasury_disposal'), 0)::float8 AS "treasuryDisposal",
            count(*) FILTER (WHERE event_group = 'dilution')::int AS "dilutionCount",
            count(*) FILTER (WHERE event_group = 'shareholder_return')::int AS "shareholderReturnCount",
            count(*) FILTER (WHERE event_group = 'treasury_disposal')::int AS "treasuryDisposalCount",
            count(*) FILTER (WHERE amount IS NULL)::int AS "missingAmountCount"
     FROM events WHERE event_date >= current_date - $1::int
     GROUP BY 1 ORDER BY 1`,
    params
  );
  // 원문 링크는 사건의 최종본으로
  const top = await dbPool.query(
    `${eventsCte(3)}
     SELECT latest_rcept_no AS "rceptNo", to_char(latest_date, 'YYYY-MM-DD') AS "rceptDate", corp_name AS "corpName",
            report_name AS "reportName", event_group AS "group", event_kind AS "kind", amount, corrected AS "isCorrection"
     FROM events WHERE event_date >= current_date - $1::int AND amount IS NOT NULL
     ORDER BY amount DESC LIMIT 5`,
    params
  );
  // 이 기간 중 언제부터 데이터가 있는지 (수집 시작 이후만 정확함)
  const coverage = await dbPool.query<{ since: string | null }>(
    `SELECT to_char(min(rcept_date), 'YYYY-MM-DD') AS since FROM disclosures WHERE rcept_date >= current_date - $1::int`,
    [days]
  );
  return { buckets: buckets.rows, top: top.rows, since: coverage.rows[0]?.since ?? null };
}

// 실적·배당 캘린더 (docs/Task_ORDER.md 15단계 T-111, D-72)
// 이미 저장된 공시에서 잠정실적(earnings)·정기보고서(report)·배당 결정(dividend)을 날짜별로 모은다. 정정 공시는 빼고 원 공시만 센다.
// 배당은 수집 때 따로 분류하지 않았으므로(기존 행은 'other') 조회할 때 제목으로 고른다. 다시 수집하지 않아도 1년치가 모두 보인다.
// 예정 일정(앞으로의 실적 발표일 등)은 공시 본문에 있어서 다루지 않는다(본문 읽기는 D-63으로 중단).
const CALENDAR_CACHE_TTL_S = 60;
const CALENDAR_DAY_LIMIT = 1000;   // 정기보고서 마감일에는 하루 수백 건이라 상한을 둔다
const CALENDAR_HIGHLIGHTS = 4;     // 달력 칸에 보여 줄 회사 수

// 종류: 잠정실적 → earnings, 정기보고서 → report, 배당 결정(종속·자회사 제외) → dividend. 정정 제외
const calendarTypeExpr = `CASE
    WHEN event_kind = 'earnings' THEN 'earnings'
    WHEN event_kind = 'periodic_report' THEN 'report'
    WHEN regexp_replace(report_name, '\\s', '', 'g') LIKE '%배당결정%'
         AND regexp_replace(report_name, '\\s', '', 'g') NOT LIKE '%자회사%'
         AND regexp_replace(report_name, '\\s', '', 'g') NOT LIKE '%종속회사%' THEN 'dividend'
  END`;
const calendarBase = (targetParam: number) => `
  SELECT rcept_no, rcept_date, stock_code, corp_name, report_name, ${calendarTypeExpr} AS cal_type
  FROM disclosures
  WHERE rcept_date >= $1::date AND rcept_date < $2::date AND NOT is_correction ${targetClause(targetParam)}`;

// 달력의 한 달: 날짜별 종류별 건수와 대표 회사 몇 곳 (실적·배당을 정기보고서보다 먼저)
async function getCalendarMonth(month: string) {
  const start = `${month}-01`;
  const { rows } = await dbPool.query(
    `WITH base AS (${calendarBase(3)}),
     typed AS (SELECT * FROM base WHERE cal_type IS NOT NULL),
     ranked AS (
       SELECT *, row_number() OVER (PARTITION BY rcept_date ORDER BY CASE cal_type WHEN 'report' THEN 1 ELSE 0 END, rcept_no) AS n
       FROM typed
     )
     SELECT to_char(rcept_date, 'YYYY-MM-DD') AS "date",
            count(*) FILTER (WHERE cal_type = 'earnings')::int AS earnings,
            count(*) FILTER (WHERE cal_type = 'report')::int AS report,
            count(*) FILTER (WHERE cal_type = 'dividend')::int AS dividend,
            COALESCE(json_agg(json_build_object('corpName', corp_name, 'type', cal_type) ORDER BY n) FILTER (WHERE n <= ${CALENDAR_HIGHLIGHTS}), '[]') AS highlights
     FROM ranked
     GROUP BY rcept_date
     ORDER BY rcept_date`,
    [start, nextMonthStart(month), ...targetParams()]
  );
  return rows;
}

// 하루치 목록 (원문 링크용 접수번호 포함)
async function getCalendarDay(date: string) {
  const { rows } = await dbPool.query(
    `WITH base AS (${calendarBase(3)})
     SELECT rcept_no AS "rceptNo", stock_code AS "stockCode", corp_name AS "corpName", report_name AS "reportName", cal_type AS "type"
     FROM base WHERE cal_type IS NOT NULL
     ORDER BY CASE cal_type WHEN 'earnings' THEN 0 WHEN 'dividend' THEN 1 ELSE 2 END, rcept_no
     LIMIT ${CALENDAR_DAY_LIMIT}`,
    [date, nextDay(date), ...targetParams()]
  );
  return rows;
}

// 검증용 자체 점검 (기존 스위치 HISTORY_SELF_CHECK=true일 때만, 기본 끔). T-82의 Before/After(B-34)를 같은 데이터로 비교한다.
// 이전 규칙: 정정 공시를 빼고 공시 단위로 합산 / 새 규칙: 사건 단위로 최종본 금액 한 번. 로그에는 건수와 합계만 남긴다.
export function startDisclosureSelfCheck() {
  if (process.env.HISTORY_SELF_CHECK !== 'true') return;
  const days = 365;
  const params = [days, CAPITAL_GROUPS, ...targetParams()];
  setInterval(async () => {
    try {
      const legacy = await dbPool.query(
        `SELECT count(*)::int AS filings, count(amount)::int AS "withAmount",
                COALESCE(sum(amount) FILTER (WHERE event_group = 'dilution'), 0)::float8 AS dilution,
                COALESCE(sum(amount) FILTER (WHERE event_group = 'shareholder_return'), 0)::float8 AS "shareholderReturn",
                COALESCE(sum(amount) FILTER (WHERE event_group = 'treasury_disposal'), 0)::float8 AS "treasuryDisposal"
         FROM disclosures
         WHERE rcept_date >= current_date - $1::int AND event_group = ANY($2::text[]) AND NOT is_correction ${targetClause(3)}`,
        params
      );
      const events = await dbPool.query(
        `${eventsCte(3)}
         SELECT count(*)::int AS events, count(amount)::int AS "withAmount", count(*) FILTER (WHERE corrected)::int AS corrected,
                sum(filings)::int AS filings,
                COALESCE(sum(amount) FILTER (WHERE event_group = 'dilution'), 0)::float8 AS dilution,
                COALESCE(sum(amount) FILTER (WHERE event_group = 'shareholder_return'), 0)::float8 AS "shareholderReturn",
                COALESCE(sum(amount) FILTER (WHERE event_group = 'treasury_disposal'), 0)::float8 AS "treasuryDisposal",
                count(*) FILTER (WHERE amount IS NULL AND event_kind = 'cancellation')::int AS "missingCancellation"
         FROM events WHERE event_date >= current_date - $1::int`,
        params
      );
      // 합계를 크게 바꾼 사건 확인용: 희석 금액 상위 5건(공개 회사명·최종 접수번호·금액·사건의 공시 수)
      const topDilution = await dbPool.query(
        `${eventsCte(3)}
         SELECT latest_rcept_no AS "rceptNo", corp_name AS "corpName", event_kind AS kind, amount, filings, corrected
         FROM events WHERE event_date >= current_date - $1::int AND event_group = 'dilution' AND amount IS NOT NULL
         ORDER BY amount DESC LIMIT 5`,
        params
      );
      console.log(`[disclosure-check] ${JSON.stringify({ range: '1년', legacy: legacy.rows[0], events: events.rows[0], topDilution: topDilution.rows })}`);
    } catch (error) {
      console.error(`[disclosure-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 실적·배당 캘린더 (T-111): 최근 12개월의 월별 종류별 합계와 조회 시간, 이번 달 가장 많은 날의 하루 목록 건수만 남긴다
    try {
      const months: Record<string, unknown>[] = [];
      const now = new Date();
      for (let back = 0; back < 12; back += 1) {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
        const month = date.toISOString().slice(0, 7);
        const startedAt = Date.now();
        const days = await getCalendarMonth(month) as { date: string; earnings: number; dividend: number; report: number }[];
        const sum = (key: 'earnings' | 'dividend' | 'report') => days.reduce((total, day) => total + day[key], 0);
        months.push({ month, days: days.length, earnings: sum('earnings'), dividend: sum('dividend'), report: sum('report'), ms: Date.now() - startedAt });
      }
      const current = await getCalendarMonth(new Date().toISOString().slice(0, 7)) as { date: string; earnings: number; dividend: number; report: number }[];
      const busiest = [...current].sort((a, b) => (b.earnings + b.dividend + b.report) - (a.earnings + a.dividend + a.report))[0];
      const dayItems = busiest ? await getCalendarDay(busiest.date) : [];
      console.log(`[calendar-check] ${JSON.stringify({ months, busiest: busiest ? { date: busiest.date, items: dayItems.length } : null })}`);
    } catch (error) {
      console.error(`[calendar-check] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 60_000);
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const hit = await cache.readJson<T>(key);
  if (hit) return { value: hit, hit: true };
  const value = await load();
  cache.writeJson(key, value, ttl);
  return { value, hit: false };
}

export const disclosuresController = async (fastify: FastifyInstance) => {
  fastify.get('/api/v1/disclosures/recent', async (request, reply) => {
    const startedAt = Date.now();
    const { group = 'all' } = request.query as { group?: string };
    if (group !== 'all' && !isDisclosureGroup(group)) {
      return reply.code(400).send({ error: 'a known group is required' });
    }
    try {
      const { value, hit } = await cached(`disclosures:recent:${group}`, RECENT_CACHE_TTL_S, async () => ({
        group, ...scopeInfo(), coverage: await getCoverage(), data: await getRecent(group),
      }));
      requestDuration.observe({ endpoint: 'recent', result: hit ? 'cache_hit' : 'cache_miss' }, Date.now() - startedAt);
      return value;
    } catch (err) {
      requestDuration.observe({ endpoint: 'recent', result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching recent disclosures:', err);
      return reply.code(500).send({ error: 'Failed to fetch disclosures' });
    }
  });

  // 실적·배당 캘린더 (T-111): 한 달 요약 / 하루 목록. 월·날짜는 형식과 실제 날짜인지 검사한 뒤 매개변수로만 넘긴다.
  fastify.get('/api/v1/disclosures/calendar', async (request, reply) => {
    const startedAt = Date.now();
    const { month, date } = request.query as { month?: string; date?: string };
    if (date !== undefined) {
      if (!isCalendarDate(date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    } else if (!isCalendarMonth(month)) {
      return reply.code(400).send({ error: 'month must be YYYY-MM' });
    }
    try {
      const key = date !== undefined ? `disclosures:calendar:day:${date}` : `disclosures:calendar:month:${month}`;
      const { value, hit } = await cached(key, CALENDAR_CACHE_TTL_S, async () => (date !== undefined
        ? { date, limit: CALENDAR_DAY_LIMIT, ...scopeInfo(), items: await getCalendarDay(date) }
        : { month, ...scopeInfo(), coverage: await getCoverage(), days: await getCalendarMonth(month!) }));
      requestDuration.observe({ endpoint: date !== undefined ? 'calendar_day' : 'calendar_month', result: hit ? 'cache_hit' : 'cache_miss' }, Date.now() - startedAt);
      return value;
    } catch (err) {
      requestDuration.observe({ endpoint: 'calendar', result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching disclosure calendar:', err);
      return reply.code(500).send({ error: 'Failed to fetch disclosure calendar' });
    }
  });

  fastify.get('/api/v1/disclosures/capital-events', async (request, reply) => {
    const startedAt = Date.now();
    const { range } = request.query as { range?: string };
    const config = range ? RANGES[range] : undefined;
    if (!range || !config) {
      return reply.code(400).send({ error: 'a known range is required' });
    }
    try {
      const { value, hit } = await cached(`disclosures:events:${range}`, EVENTS_CACHE_TTL_S, async () => ({
        range, unit: 'krw', bucket: config.bucket, ...scopeInfo(), ...(await getCapitalEvents(config.days, config.bucket)),
      }));
      requestDuration.observe({ endpoint: 'capital_events', result: hit ? 'cache_hit' : 'cache_miss' }, Date.now() - startedAt);
      return value;
    } catch (err) {
      requestDuration.observe({ endpoint: 'capital_events', result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching capital events:', err);
      return reply.code(500).send({ error: 'Failed to fetch capital events' });
    }
  });
};
