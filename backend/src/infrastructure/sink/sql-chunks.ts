// 여러 행 INSERT의 매개변수 한도 (plan.md QA-05 / P1-6, T-185)
// PostgreSQL 한 문장의 바인드 매개변수는 65,535개까지다. db-sink는 Kafka 묶음 전체를 한 문장으로 넣어서,
// db-sink가 오래 멈췄다가 밀린 메시지를 한꺼번에 읽으면(시세는 행당 7개 → 약 9,400행부터) 문장이 실패했다.
// 이 오류는 값 오류(SQLSTATE 21·22·23)가 아니라 묶음을 나눠 다시 시도하지도 않아서, 같은 묶음을 계속 다시 시도하며 모든 토픽 저장이 멈췄다.
// 그래서 행을 나눠 여러 문장으로 넣는다. 각 문장은 ON CONFLICT로 같은 결과라, 중간에 실패해 묶음을 다시 시도해도 값이 바뀌지 않는다.

export const MAX_QUERY_PARAMS = 60_000; // 한도 65,535보다 여유를 둔다

export function chunkForParams<T>(rows: readonly T[], paramsPerRow: number, maxParams = MAX_QUERY_PARAMS): T[][] {
  const size = Math.max(1, Math.floor(maxParams / Math.max(1, paramsPerRow)));
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size) chunks.push(rows.slice(start, start + size));
  return chunks;
}
