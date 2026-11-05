import pg from 'pg';

const { Pool } = pg;

// 유휴 연결 유지 (docs/Task_ORDER.md T-32). pg의 기본값(10초)이면 60초 간격 조회마다 연결을 다시 맺는다.
// 0이면 유휴 연결을 닫지 않는다. 최대 연결 수(기본 10)는 그대로라 연결이 무한히 늘지는 않는다.
const idleTimeoutValue = Number.parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? '', 10);
const DB_POOL_IDLE_TIMEOUT_MS = Number.isNaN(idleTimeoutValue) ? 0 : idleTimeoutValue;

export const dbPool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'kospi',
  password: process.env.DB_PASSWORD || 'password',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
  keepAlive: true,
});

// 버전별 스키마 마이그레이션 (docs/Task_ORDER.md T-15 ~ T-18)
// 실행한 버전은 schema_migrations에 기록되어 한 번만 실행된다.
// 연속 집계(continuous aggregate) 관련 문장은 트랜잭션 안에서 실행할 수 없어서 문장 단위로 실행한다.
interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'base schema (market_ticks hypertable)',
    statements: [
      `CREATE TABLE IF NOT EXISTS market_ticks (
        time TIMESTAMPTZ NOT NULL,
        symbol TEXT NOT NULL,
        category TEXT NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        change_rate DOUBLE PRECISION NOT NULL,
        change_price DOUBLE PRECISION NOT NULL,
        volume BIGINT
      )`,
      `SELECT create_hypertable('market_ticks', 'time', if_not_exists => TRUE)`,
    ],
  },
  {
    version: 2,
    name: 'T-18 reset, T-15 unique (symbol, time), T-16 hierarchical aggregates, T-17 retention',
    statements: [
      // T-18 (D-22, 2026-10-16 사용자 승인): 중복·잘못된 심볼·0값이 섞인 기존 데이터를 삭제한다.
      // 이 마이그레이션은 한 번만 실행되므로 이후 기동에서는 데이터를 지우지 않는다.
      `TRUNCATE market_ticks`,
      // T-15: 같은 심볼·시각의 중복을 막는다. 심볼별 시간 범위 조회 인덱스도 겸한다 (P-14).
      `CREATE UNIQUE INDEX IF NOT EXISTS market_ticks_symbol_time_key ON market_ticks (symbol, time)`,
      // T-17: 원본은 몇 시간만 보관하므로 청크를 작게 잡아 바로 지울 수 있게 한다 (D-02).
      `SELECT set_chunk_time_interval('market_ticks', INTERVAL '1 hour')`,
      // T-16 (D-23): 원본 → 5분 → 1시간 → 1일 계층형 집계.
      // 1일 봉을 원본에서 바로 만들면, 원본이 3시간 뒤 지워진 상태에서 갱신할 때 하루치 봉이 망가진다.
      `CREATE MATERIALIZED VIEW IF NOT EXISTS market_5m
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket,
              symbol,
              first(price, time) AS open,
              max(price) AS high,
              min(price) AS low,
              last(price, time) AS close,
              count(*) AS ticks
       FROM market_ticks
       GROUP BY time_bucket(INTERVAL '5 minutes', time), symbol
       WITH NO DATA`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS market_1h
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket,
              symbol,
              first(open, bucket) AS open,
              max(high) AS high,
              min(low) AS low,
              last(close, bucket) AS close,
              sum(ticks) AS ticks
       FROM market_5m
       GROUP BY time_bucket(INTERVAL '1 hour', bucket), symbol
       WITH NO DATA`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS market_1d
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket(INTERVAL '1 day', bucket) AS bucket,
              symbol,
              first(open, bucket) AS open,
              max(high) AS high,
              min(low) AS low,
              last(close, bucket) AS close,
              sum(ticks) AS ticks
       FROM market_1h
       GROUP BY time_bucket(INTERVAL '1 day', bucket), symbol
       WITH NO DATA`,
      // 갱신 정책: 각 집계는 바로 아래 단계가 보관하는 범위 안에서만 다시 계산한다.
      `SELECT add_continuous_aggregate_policy('market_5m',
         start_offset => INTERVAL '2 hours', end_offset => INTERVAL '5 minutes',
         schedule_interval => INTERVAL '1 minute', if_not_exists => true)`,
      `SELECT add_continuous_aggregate_policy('market_1h',
         start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
         schedule_interval => INTERVAL '5 minutes', if_not_exists => true)`,
      `SELECT add_continuous_aggregate_policy('market_1d',
         start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 day',
         schedule_interval => INTERVAL '1 hour', if_not_exists => true)`,
      // T-17 보관 정책: 원본 3시간(5분 봉 갱신 범위 2시간보다 길게, D-02), 집계 1년(매일 이동, D-01).
      `SELECT add_retention_policy('market_ticks', drop_after => INTERVAL '3 hours', if_not_exists => true)`,
      `SELECT add_retention_policy('market_5m', drop_after => INTERVAL '1 year', if_not_exists => true)`,
      `SELECT add_retention_policy('market_1h', drop_after => INTERVAL '1 year', if_not_exists => true)`,
      `SELECT add_retention_policy('market_1d', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 3,
    name: 'T-31 recreate aggregates with larger chunk intervals (5m: 7 days, 1h/1d: 30 days)',
    statements: [
      // T-31 (D-26, D-27, 2026-10-17 사용자 승인): 청크 간격은 새 청크에만 적용되므로 집계를 다시 만든다.
      // 지워진 집계 데이터는 과거 데이터 채우기(버전 2)가 다시 채운다. 의존 관계 때문에 1일 → 1시간 → 5분 순서로 지운다.
      `DROP MATERIALIZED VIEW IF EXISTS market_1d`,
      `DROP MATERIALIZED VIEW IF EXISTS market_1h`,
      `DROP MATERIALIZED VIEW IF EXISTS market_5m`,
      `CREATE MATERIALIZED VIEW market_5m
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket,
              symbol,
              first(price, time) AS open,
              max(price) AS high,
              min(price) AS low,
              last(price, time) AS close,
              count(*) AS ticks
       FROM market_ticks
       GROUP BY time_bucket(INTERVAL '5 minutes', time), symbol
       WITH NO DATA`,
      setAggregateChunkInterval('market_5m', '7 days'),
      `CREATE MATERIALIZED VIEW market_1h
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket,
              symbol,
              first(open, bucket) AS open,
              max(high) AS high,
              min(low) AS low,
              last(close, bucket) AS close,
              sum(ticks) AS ticks
       FROM market_5m
       GROUP BY time_bucket(INTERVAL '1 hour', bucket), symbol
       WITH NO DATA`,
      setAggregateChunkInterval('market_1h', '30 days'),
      `CREATE MATERIALIZED VIEW market_1d
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket(INTERVAL '1 day', bucket) AS bucket,
              symbol,
              first(open, bucket) AS open,
              max(high) AS high,
              min(low) AS low,
              last(close, bucket) AS close,
              sum(ticks) AS ticks
       FROM market_1h
       GROUP BY time_bucket(INTERVAL '1 day', bucket), symbol
       WITH NO DATA`,
      setAggregateChunkInterval('market_1d', '30 days'),
      // 집계를 지우면 갱신·보관 정책도 함께 지워지므로 다시 등록한다 (값은 마이그레이션 2와 같음).
      `SELECT add_continuous_aggregate_policy('market_5m',
         start_offset => INTERVAL '2 hours', end_offset => INTERVAL '5 minutes',
         schedule_interval => INTERVAL '1 minute', if_not_exists => true)`,
      `SELECT add_continuous_aggregate_policy('market_1h',
         start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
         schedule_interval => INTERVAL '5 minutes', if_not_exists => true)`,
      `SELECT add_continuous_aggregate_policy('market_1d',
         start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 day',
         schedule_interval => INTERVAL '1 hour', if_not_exists => true)`,
      `SELECT add_retention_policy('market_5m', drop_after => INTERVAL '1 year', if_not_exists => true)`,
      `SELECT add_retention_policy('market_1h', drop_after => INTERVAL '1 year', if_not_exists => true)`,
      `SELECT add_retention_policy('market_1d', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 4,
    name: 'T-48 run raw retention every hour (was 1 day)',
    statements: [
      // T-48 (BENCHMARK B-22): 원본 보관 작업의 기본 주기가 1일이라, 원본이 목표(3시간)보다 최대 하루 넘게 남았다(실측 약 25시간).
      // 주기를 1시간으로 줄이고 바로 한 번 실행되게 한다. 데이터를 지우는 기준(3시간)은 그대로이고, 집계 보관(1년)은 1일 주기 그대로다.
      `SELECT alter_job(job_id, schedule_interval => INTERVAL '1 hour', next_start => now())
       FROM timescaledb_information.jobs
       WHERE proc_name = 'policy_retention' AND hypertable_name = 'market_ticks'`,
    ],
  },
  {
    version: 5,
    name: '11단계 A investor_flows (market net buy by investor type)',
    statements: [
      // 증시 자금 흐름 (docs/Task_ORDER.md 11단계 A, D-47, D-53). 기존 테이블은 건드리지 않는다.
      // 시장별로 한 시점의 외국인·기관계·개인 순매수(백만원). 장중 잠정치는 분 단위, 확정치(B단계)는 같은 키를 덮어쓴다.
      `CREATE TABLE IF NOT EXISTS investor_flows (
        time TIMESTAMPTZ NOT NULL,
        market TEXT NOT NULL,
        foreign_net DOUBLE PRECISION NOT NULL,
        institution_net DOUBLE PRECISION NOT NULL,
        individual_net DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL
      )`,
      // 하루 수백 행 수준이라 청크는 7일
      `SELECT create_hypertable('investor_flows', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS investor_flows_market_time_key ON investor_flows (market, time)`,
      `SELECT add_retention_policy('investor_flows', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 6,
    name: 'T-67 index_daily (KRX daily indices), 12단계 disclosures (DART)',
    statements: [
      // KRX 일별 지수 (docs/Task_ORDER.md T-67, D-60). 기존 테이블·집계는 건드리지 않는다.
      // 하루 1개 값이라 원본(market_ticks, 3시간 보관)·집계와 섞지 않는다. 섞으면 지난 날짜 버킷을 다시 계산할 때
      // 다른 지표의 원본이 이미 지워져 있어 집계가 망가질 수 있다(저장 불변 조건).
      `CREATE TABLE IF NOT EXISTS index_daily (
        time TIMESTAMPTZ NOT NULL,
        symbol TEXT NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        change_rate DOUBLE PRECISION NOT NULL,
        change_price DOUBLE PRECISION,
        source TEXT NOT NULL
      )`,
      `SELECT create_hypertable('index_daily', 'time', chunk_time_interval => INTERVAL '90 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS index_daily_symbol_time_key ON index_daily (symbol, time)`,
      `SELECT add_retention_policy('index_daily', drop_after => INTERVAL '1 year', if_not_exists => true)`,
      // DART 공시 (12단계 T-76, D-59). 개인 이름(제출인)은 저장하지 않는다. 금액이 없으면 NULL.
      `CREATE TABLE IF NOT EXISTS disclosures (
        rcept_date DATE NOT NULL,
        rcept_no TEXT NOT NULL,
        corp_code TEXT NOT NULL,
        stock_code TEXT NOT NULL,
        corp_name TEXT NOT NULL,
        report_name TEXT NOT NULL,
        event_group TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        is_correction BOOLEAN NOT NULL,
        amount DOUBLE PRECISION,
        market TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `SELECT create_hypertable('disclosures', 'rcept_date', chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS disclosures_rcept_key ON disclosures (rcept_no, rcept_date)`,
      `CREATE INDEX IF NOT EXISTS disclosures_group_date_idx ON disclosures (event_group, rcept_date DESC)`,
      `SELECT add_retention_policy('disclosures', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 7,
    name: 'T-106 market_breadth (advancers / decliners / trading value per market per day)',
    statements: [
      // 시장 폭·거래대금 (docs/Task_ORDER.md T-106, D-67). 기존 테이블·집계는 건드리지 않는다.
      // 시장별 하루 1행(종목 행은 저장하지 않음). 기준 시각은 KRX 일별 지수와 같은 15:30 KST.
      `CREATE TABLE IF NOT EXISTS market_breadth (
        time TIMESTAMPTZ NOT NULL,
        market TEXT NOT NULL,
        advancers INTEGER NOT NULL,
        decliners INTEGER NOT NULL,
        unchanged INTEGER NOT NULL,
        stocks INTEGER NOT NULL,
        trading_value DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL
      )`,
      // 1년에 약 500행이라 청크 하나로 충분
      `SELECT create_hypertable('market_breadth', 'time', chunk_time_interval => INTERVAL '365 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS market_breadth_market_time_key ON market_breadth (market, time)`,
      `SELECT add_retention_policy('market_breadth', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 8,
    name: 'T-113 stock_rankings (top 100 by gain / loss / trading value / market cap per market per day)',
    statements: [
      // 종목 순위 (docs/Task_ORDER.md T-113, D-72). 기존 테이블·집계는 건드리지 않는다.
      // 시장·날짜마다 4가지 순위의 상위 100개(합쳐 최대 400행). 순위에 들지 않으면 그 순위 칸은 NULL.
      // 기준 시각은 시장 폭과 같은 15:30 KST. 하루에 최대 약 800행, 1년 약 20만 행(추정)이라 청크 30일.
      `CREATE TABLE IF NOT EXISTS stock_rankings (
        time TIMESTAMPTZ NOT NULL,
        market TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        change_rate DOUBLE PRECISION,
        trading_value DOUBLE PRECISION,
        market_cap DOUBLE PRECISION,
        rank_gain SMALLINT,
        rank_loss SMALLINT,
        rank_value SMALLINT,
        rank_cap SMALLINT,
        source TEXT NOT NULL
      )`,
      `SELECT create_hypertable('stock_rankings', 'time', chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS stock_rankings_market_code_time_key ON stock_rankings (market, code, time)`,
      `CREATE INDEX IF NOT EXISTS stock_rankings_market_time_idx ON stock_rankings (market, time DESC)`,
      `SELECT add_retention_policy('stock_rankings', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 9,
    name: '11단계 B′ T-97 market_flows (KOFIA daily market fund statistics, one row per metric per day)',
    statements: [
      // 증시 자금 흐름 일별 통계 (docs/Task_ORDER.md 11단계 B′ T-95 ~ T-97, D-44, D-65). 기존 테이블은 건드리지 않는다.
      // 지표·날짜·값의 긴 형식: 응답 필드가 바뀌거나 늘어도 스키마를 바꾸지 않는다. metric은 '<데이터셋>.<응답 필드 이름>'.
      // 기준 시각은 KRX 일별 값과 같은 15:30 KST. 하루 수십 행이라 청크 365일.
      `CREATE TABLE IF NOT EXISTS market_flows (
        time TIMESTAMPTZ NOT NULL,
        metric TEXT NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL
      )`,
      `SELECT create_hypertable('market_flows', 'time', chunk_time_interval => INTERVAL '365 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS market_flows_metric_time_key ON market_flows (metric, time)`,
      `SELECT add_retention_policy('market_flows', drop_after => INTERVAL '1 year', if_not_exists => true)`,
    ],
  },
  {
    version: 10,
    name: 'T-151 market_bars_fill (Yahoo 5m/1h closes for periods with no aggregate)',
    statements: [
      // 1일·1주 그래프 공백 채우기 (docs/Task_ORDER.md T-151). 기존 테이블·집계는 건드리지 않는다.
      // 집계에 넣으면 원본이 지워진 구간을 다시 계산할 때 다른 지표의 집계가 지워지므로(저장 불변 조건) 따로 두고, History API가 집계에 없는 시각만 이어 붙인다.
      // 시각은 집계 버킷과 같은 경계다. 가장 긴 1주 그래프에 맞춰 8일 보관한다. 지표당 하루 최대 300행 정도(추정)라 청크 1일.
      `CREATE TABLE IF NOT EXISTS market_bars_fill (
        time TIMESTAMPTZ NOT NULL,
        symbol TEXT NOT NULL,
        resolution TEXT NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL
      )`,
      `SELECT create_hypertable('market_bars_fill', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS market_bars_fill_key ON market_bars_fill (symbol, resolution, time)`,
      `SELECT add_retention_policy('market_bars_fill', drop_after => INTERVAL '8 days', if_not_exists => true)`,
    ],
  },
  {
    version: 11,
    name: 'T-151 market_bars_fill_runs (last Yahoo bar fetch per symbol and resolution)',
    statements: [
      // 지표·해상도마다 Yahoo 봉을 마지막으로 받은 시각. 그때 이미 끝난 빈 칸은 Yahoo에도 없는 칸이라 재시작해도 다시 받지 않는다(B-58). 최대 54행.
      `CREATE TABLE IF NOT EXISTS market_bars_fill_runs (
        symbol TEXT NOT NULL,
        resolution TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (symbol, resolution)
      )`,
    ],
  },
  {
    version: 12,
    name: 'T-122 split index_daily by API (index_daily_krx, index_daily_yahoo), keep the old table, read through a view',
    statements: [
      // D-87: 품질관리를 위해 일별 값을 API별 표로 나눈다. 같은 날의 KRX·Yahoo 값을 함께 둘 수 있어 DB에서 대조할 수 있다.
      // 옛 표는 지우지 않고 index_daily_legacy로 남긴다(삭제는 검증 뒤 사용자 승인으로). 읽는 쪽은 같은 이름의 뷰를 그대로 쓴다.
      // ingested_at: DB에 들어온 시각. 옮겨 온 행은 실제 시각을 알 수 없어 NULL이다.
      ...['index_daily_krx', 'index_daily_yahoo'].flatMap(table => [
        `CREATE TABLE IF NOT EXISTS ${table} (
          time TIMESTAMPTZ NOT NULL,
          symbol TEXT NOT NULL,
          close DOUBLE PRECISION NOT NULL CHECK (close > 0),
          change_rate DOUBLE PRECISION NOT NULL,
          change_price DOUBLE PRECISION,
          ingested_at TIMESTAMPTZ DEFAULT now()
        )`,
        `SELECT create_hypertable('${table}', 'time', chunk_time_interval => INTERVAL '90 days', if_not_exists => TRUE)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_symbol_time_key ON ${table} (symbol, time)`,
        `SELECT add_retention_policy('${table}', drop_after => INTERVAL '1 year', if_not_exists => true)`,
      ]),
      // 복사·이름 변경·뷰 생성을 한 문장(한 트랜잭션)으로 한다. 중간에 실패하면 모두 취소되고 다음 기동에서 다시 시도한다.
      `DO $$
      BEGIN
        IF to_regclass('public.index_daily_legacy') IS NULL THEN
          INSERT INTO index_daily_krx (time, symbol, close, change_rate, change_price, ingested_at)
            SELECT time, symbol, close, change_rate, change_price, NULL FROM index_daily WHERE source = 'krx'
            ON CONFLICT (symbol, time) DO NOTHING;
          INSERT INTO index_daily_yahoo (time, symbol, close, change_rate, change_price, ingested_at)
            SELECT time, symbol, close, change_rate, change_price, NULL FROM index_daily WHERE source = 'yahoo'
            ON CONFLICT (symbol, time) DO NOTHING;
          ALTER TABLE index_daily RENAME TO index_daily_legacy;
          -- 같은 날짜가 양쪽에 있으면 거래소 값(KRX)을 쓴다. 지금까지의 규칙("KRX 행은 Yahoo 값으로 바꾸지 않음")과 같다
          CREATE VIEW index_daily AS
            SELECT time, symbol, close, change_rate, change_price, 'krx'::text AS source, ingested_at FROM index_daily_krx
            UNION ALL
            SELECT y.time, y.symbol, y.close, y.change_rate, y.change_price, 'yahoo'::text AS source, y.ingested_at
            FROM index_daily_yahoo y
            WHERE NOT EXISTS (SELECT 1 FROM index_daily_krx k WHERE k.symbol = y.symbol AND k.time = y.time);
        END IF;
      END
      $$`,
    ],
  },
  {
    version: 13,
    name: 'T-118 ingestion_runs (one row per collection run)',
    statements: [
      // 수집 실행 기록. URL·키·오류 원문은 넣지 않는다(형식 검사는 shared/ingestion-runs.ts). 하루 약 2,500행(추정)이라 30일 보관.
      `CREATE TABLE IF NOT EXISTS ingestion_runs (
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL,
        run_id UUID NOT NULL,
        source TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        target_from DATE,
        target_to DATE,
        received INTEGER NOT NULL,
        sent INTEGER NOT NULL,
        dropped_total INTEGER NOT NULL,
        dropped JSONB NOT NULL,
        status TEXT NOT NULL,
        error_kind TEXT,
        source_total INTEGER,
        covered INTEGER
      )`,
      `SELECT create_hypertable('ingestion_runs', 'started_at', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ingestion_runs_key ON ingestion_runs (run_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS ingestion_runs_source_idx ON ingestion_runs (source, started_at DESC)`,
      `SELECT add_retention_policy('ingestion_runs', drop_after => INTERVAL '30 days', if_not_exists => true)`,
    ],
  },
  {
    version: 14,
    name: 'T-119 dq_results (scheduled data quality check results)',
    statements: [
      // 품질 검사 결과. 검사 1개당 1행(15분마다 약 30행, 하루 약 2,900행 추정)이라 30일 보관.
      `CREATE TABLE IF NOT EXISTS dq_results (
        checked_at TIMESTAMPTZ NOT NULL,
        dataset TEXT NOT NULL,
        check_name TEXT NOT NULL,
        status TEXT NOT NULL,
        observed DOUBLE PRECISION NOT NULL,
        expected DOUBLE PRECISION,
        detail JSONB NOT NULL
      )`,
      `SELECT create_hypertable('dq_results', 'checked_at', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE)`,
      `CREATE INDEX IF NOT EXISTS dq_results_check_idx ON dq_results (dataset, check_name, checked_at DESC)`,
      `SELECT add_retention_policy('dq_results', drop_after => INTERVAL '30 days', if_not_exists => true)`,
    ],
  },
];

// 집계의 실제 저장 테이블(materialization hypertable)을 찾아 청크 간격을 바꾼다 (T-31).
// 데이터가 들어가기 전에 호출해야 모든 청크가 새 간격으로 만들어진다.
function setAggregateChunkInterval(view: string, interval: string) {
  return `DO $$
    DECLARE target regclass;
    BEGIN
      SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
        INTO STRICT target
        FROM timescaledb_information.continuous_aggregates
        WHERE view_name = '${view}';
      PERFORM set_chunk_time_interval(target, INTERVAL '${interval}');
    END
  $$`;
}

// 마이그레이션이 실패하면 예외를 던진다. backend는 스키마 없이 뜨지 않고 종료한다 (restart: on-failure가 다시 시도).
export const initDB = async () => {
  const client = await dbPool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb;');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(row => row.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      console.log(`Applying DB migration ${migration.version}: ${migration.name}`);
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
      console.log(`DB migration ${migration.version} applied.`);
    }

    const extension = await client.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'"
    );
    console.log(`TimescaleDB schema ready (extension ${extension.rows[0]?.extversion ?? 'unknown'}, migrations up to ${MIGRATIONS.length}).`);
  } finally {
    client.release();
  }
};
