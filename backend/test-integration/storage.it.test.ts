// DB 통합 시험 최소안 (plan.md P6-1 · QA-41, docs/Task_ORDER.md T-227, BENCHMARK B-101, A안)
// 실행: docker-compose의 integration-test 서비스(평소에는 뜨지 않음, 이름을 지정해 `up -d integration-test`). 결과는 docker logs의 # pass / # fail.
// 같은 TimescaleDB 안에 시험 전용 DB(DB_NAME, 이름이 *_it여야 함)를 새로 만들고, 끝나면 지운다. 실제 DB(IT_ADMIN_DB)에는
// 시험 DB를 만들고 지우는 명령만 보낸다(표를 읽거나 쓰지 않음). 새 의존성 없음: pg · tsx · node:test.
// 시나리오: ① 빈 DB 마이그레이션 ② History 합치기 SQL(T-136) ③ 늦은 데이터 보정과 저장 불변 조건(옛 T-128)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { clampWindow, planLateRefresh } from '../src/infrastructure/sink/late-refresh.js';

const IT_DB = process.env.DB_NAME ?? '';
const ADMIN_DB = process.env.IT_ADMIN_DB ?? '';
// 실수로 실제 DB를 지우지 않도록 이름을 검사한다(식별자는 매개변수로 넘길 수 없어 형식을 제한한 뒤에만 문장에 넣음)
if (!/^[a-z][a-z0-9_]{0,40}_it$/.test(IT_DB) || ADMIN_DB === '' || ADMIN_DB === IT_DB) {
  throw new Error('integration tests need DB_NAME=<name>_it and a different IT_ADMIN_DB');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const floor5 = (ms: number) => Math.floor(ms / (5 * MINUTE)) * 5 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

async function admin(sql: string) {
  const client = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: ADMIN_DB,
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// 시험 DB를 만든 뒤에 불러온다(풀은 DB_NAME = 시험 DB로 만들어짐)
let db: typeof import('../src/infrastructure/db.js');
let pool: pg.Pool;

// 시각은 코드가 만든 ISO 문자열만 넣는다(외부 입력 없음)
const refresh = (view: string, startMs: number, endMs: number) =>
  pool.query(`CALL refresh_continuous_aggregate('${view}', '${iso(startMs)}', '${iso(endMs)}')`);

async function insertTick(symbol: string, timeMs: number, price: number) {
  await pool.query(
    `INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price) VALUES ($1, $2, 'it', $3, 0, 0)`,
    [new Date(timeMs), symbol, price]
  );
}

before(async () => {
  await admin(`DROP DATABASE IF EXISTS ${IT_DB} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${IT_DB}`);
  db = await import('../src/infrastructure/db.js');
  pool = db.dbPool;
  await db.initDB();
  // 보관·갱신 정책이 시험 중에 스스로 돌지 않게 멈춘다(시험이 직접 다시 계산·청크 삭제를 한다)
  await pool.query(`SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE job_id >= 1000`);
});

after(async () => {
  await pool?.end().catch(() => undefined);
  await admin(`DROP DATABASE IF EXISTS ${IT_DB} WITH (FORCE)`);
});

test('① 빈 DB에 마이그레이션 전부 적용, 다시 실행하면 새로 적용 0', async () => {
  const versions = async () => (await pool.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version);
  const first = await versions();
  for (const version of db.REQUIRED_MIGRATION_VERSIONS) assert.ok(first.includes(version), `필수 마이그레이션 ${version}`);
  assert.ok(first.includes(15) && first.includes(16), '빈 DB에서는 정리용 15 · 16도 성공');
  const { rows: objects } = await pool.query<{ name: string; found: boolean }>(
    `SELECT name, to_regclass(name) IS NOT NULL AS found
     FROM unnest(ARRAY['market_ticks','market_5m','market_1h','market_1d','index_daily','index_daily_krx','index_daily_yahoo',
                       'market_bars_fill','market_flows','disclosures','market_breadth','ingestion_runs','dq_results']) AS name`
  );
  assert.deepEqual(objects.filter(row => !row.found).map(row => row.name), []);

  await db.initDB();
  assert.deepEqual(await versions(), first, '두 번째 실행에서 바뀐 기록 없음');
});

test('② History 합치기: 같은 날짜에 일봉·집계가 다 있으면 장 시간 지표는 일봉, 24시간 지표는 집계, 날짜당 1행', async () => {
  const { historyQuery } = await import('../src/domains/history/history-queries.js');
  const today = Math.floor(Date.now() / DAY) * DAY;
  const [d1, d2, d3] = [today - 5 * DAY, today - 4 * DAY, today - 3 * DAY];
  for (const symbol of ['SP500', 'USD/KRW']) {
    // 일봉: D1, D2 (15:30 KST = 06:30 UTC, 실제 일봉과 같은 기준 시각)
    for (const [day, close] of [[d1, 101], [d2, 102]] as const) {
      await pool.query(
        `INSERT INTO index_daily_yahoo (time, symbol, close, change_rate, change_price) VALUES ($1, $2, $3, 0, 0)`,
        [new Date(day + 6.5 * HOUR), symbol, close]
      );
    }
    // 집계: D2, D3 (원본 tick → 5분 → 1시간 → 1일)
    await insertTick(symbol, d2 + 3 * HOUR, 202);
    await insertTick(symbol, d3 + 3 * HOUR, 203);
  }
  await refresh('market_5m', d2, d3 + DAY);
  await refresh('market_1h', d2, d3 + DAY);
  await refresh('market_1d', d2, d3 + DAY);

  // 겹침이 실제로 있는지(D2에 일봉과 집계가 모두 있음) 먼저 확인한다. 없으면 이 시험은 아무것도 검사하지 못한다
  const { rows: [overlap] } = await pool.query<{ agg: number; daily: number }>(
    `SELECT (SELECT count(*)::int FROM market_1d WHERE bucket = $1 AND symbol IN ('SP500','USD/KRW')) AS agg,
            (SELECT count(*)::int FROM index_daily WHERE time_bucket(INTERVAL '1 day', time) = $1 AND symbol IN ('SP500','USD/KRW')) AS daily`,
    [new Date(d2)]
  );
  assert.deepEqual(overlap, { agg: 2, daily: 2 });

  const run = async (symbol: 'SP500' | 'USD/KRW') => {
    const { text, values } = historyQuery(symbol, '1개월');
    return (await pool.query<{ time: number; value: number }>(text, values)).rows.map(row => [row.time, row.value]);
  };
  assert.deepEqual(await run('SP500'), [[d1, 101], [d2, 102], [d3, 203]], '장 시간 지표: 겹치는 날은 일봉(공식 종가)');
  assert.deepEqual(await run('USD/KRW'), [[d1, 101], [d2, 202], [d3, 203]], '24시간 지표: 겹치는 날은 집계');
});

test('③ 늦은 데이터 보정(옛 T-128): 잘라 낸 범위로 다시 계산하면 원본이 지워진 옛 5분 봉이 남고, 자르지 않으면 지워진다', async () => {
  const now = Date.now();
  const other = 'IT_OTHER';
  const late = 'IT_LATE';
  // 다른 지표: 5시간 전 ~ 30분 전 5분마다 원본 → 5분 봉으로 만든다
  for (let time = floor5(now - 5 * HOUR); time <= now - 30 * MINUTE; time += 5 * MINUTE) await insertTick(other, time, 1);
  await refresh('market_5m', floor5(now - 6 * HOUR), floor5(now - 10 * MINUTE));

  // 원본 보관 작업과 같은 방식(보관 3시간, 청크 단위 삭제)으로 원본을 지운다. 집계는 남는다
  await pool.query(`SELECT drop_chunks('market_ticks', older_than => now() - INTERVAL '3 hours')`);
  const oldRange = [new Date(now - 5 * HOUR), new Date(now - 4 * HOUR)];
  const countOld = async () => (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM market_5m WHERE symbol = $1 AND bucket >= $2 AND bucket < $3`, [other, ...oldRange]
  )).rows[0]?.n ?? 0;
  const { rows: [raw] } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM market_ticks WHERE symbol = $1 AND time >= $2 AND time < $3`, [other, ...oldRange]
  );
  assert.equal(raw?.n, 0, '옛 구간 원본은 지워짐');
  const oldBuckets = await countOld();
  assert.ok(oldBuckets >= 11, `옛 구간 5분 봉이 남아 있음 (${oldBuckets})`);

  // 늦게 온 tick: 원본 보관 범위 밖(4시간 30분 전, 되살릴 수 없음)과 안(2시간 30분 전, 갱신 정책 범위 2시간 밖)
  const unrecoverableAt = floor5(now - 4.5 * HOUR) + MINUTE;
  const recoverableAt = floor5(now - 2.5 * HOUR) + MINUTE;
  await insertTick(late, unrecoverableAt, 9);
  await insertTick(late, recoverableAt, 9);

  // db-sink와 같은 판단: 가장 오래된 늦은 tick으로 구간을 정하고, 실행 직전에 원본이 남은 범위로 자른다
  const plan = planLateRefresh(unrecoverableAt, now);
  assert.equal(plan.unrecoverable, true);
  assert.ok(plan.window);
  const window = clampWindow(plan.window, Date.now());
  assert.ok(window && window.start >= now - (2 * 60 + 50) * MINUTE, '구간 시작이 원본이 남은 범위 안');
  await refresh('market_5m', window.start, window.end);

  assert.equal(await countOld(), oldBuckets, '잘라 낸 범위: 다른 지표의 옛 5분 봉 그대로');
  const { rows: [recovered] } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM market_5m WHERE symbol = $1 AND bucket = $2`, [late, new Date(floor5(recoverableAt))]
  );
  assert.equal(recovered?.n, 1, '원본이 남은 늦은 tick은 5분 봉에 반영');

  // 대조: 자르지 않은 범위로 다시 계산하면 원본이 없는 옛 버킷이 다시 계산되어 다른 지표의 봉이 지워진다(시험이 위험을 실제로 잡는지 확인)
  // 원인을 가르려고 두 단계로 본다: (가) 늦은 tick 버킷을 뺀 옛 구간만 → (나) 전체. (가)에서도 줄면 원본 청크 삭제 자체가 재계산 대상이 된 것
  await refresh('market_5m', floor5(now - 5 * HOUR), floor5(unrecoverableAt));
  const afterExcludingLate = await countOld();
  await refresh('market_5m', floor5(now - 6 * HOUR), floor5(now - 10 * MINUTE));
  const afterFull = await countOld();
  console.log(`[it-late-refresh] old 5m buckets of another symbol: ${oldBuckets} -> clamped ${oldBuckets} -> excluding late bucket ${afterExcludingLate} -> full ${afterFull}`);
  assert.ok(afterFull < oldBuckets, `자르지 않은 범위: 원본이 지워진 구간의 다른 지표 봉이 사라짐 (${oldBuckets} → ${afterFull})`);
});
