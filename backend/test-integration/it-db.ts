// 통합 시험 공용: 시험 전용 DB 만들기·지우기 (docs/Task_ORDER.md T-227 · T-230)
// 같은 TimescaleDB 안에 DB_NAME(이름이 *_it여야 함)을 새로 만들고 마이그레이션을 적용한다. 실제 DB(IT_ADMIN_DB)에는
// 시험 DB를 만들고 지우는 명령만 보낸다. 시험 파일은 차례로 실행된다(compose 명령의 --test-concurrency=1)
import pg from 'pg';

const IT_DB = process.env.DB_NAME ?? '';
const ADMIN_DB = process.env.IT_ADMIN_DB ?? '';
// 실수로 실제 DB를 지우지 않도록 이름을 검사한다(식별자는 매개변수로 넘길 수 없어 형식을 제한한 뒤에만 문장에 넣음)
if (!/^[a-z][a-z0-9_]{0,40}_it$/.test(IT_DB) || ADMIN_DB === '' || ADMIN_DB === IT_DB) {
  throw new Error('integration tests need DB_NAME=<name>_it and a different IT_ADMIN_DB');
}

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

export type TestDb = typeof import('../src/infrastructure/db.js');

// 빈 시험 DB → 마이그레이션 → 보관·갱신 정책 멈춤(시험이 직접 다시 계산·삭제한다). 풀은 DB_NAME = 시험 DB로 만들어짐
export async function createTestDb(): Promise<TestDb> {
  await admin(`DROP DATABASE IF EXISTS ${IT_DB} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${IT_DB}`);
  const db = await import('../src/infrastructure/db.js');
  await db.initDB();
  await db.dbPool.query(`SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE job_id >= 1000`);
  return db;
}

export async function dropTestDb(db: TestDb | undefined) {
  await db?.dbPool.end().catch(() => undefined);
  await admin(`DROP DATABASE IF EXISTS ${IT_DB} WITH (FORCE)`);
}
