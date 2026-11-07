import { QueryClient } from '@tanstack/react-query'
import { resolveApiBase } from '@/lib/api'

// React Query 공용 설정 (docs/Task_ORDER.md T-165, D-92)
// - API 주소는 여기 한 곳에서만 만든다 (VITE_API_URL은 예전 형식도 받음)
// - 창으로 돌아올 때마다 다시 요청하지 않는다(기본값은 다시 요청). 실시간 값은 소켓이 따로 갱신한다
// - 일시 실패는 1번만 다시 시도한다(기본 3번이면 오류 표시가 늦어짐)
// - 데이터마다 다른 갱신 주기는 각 훅에서 정한다(staleTime·refetchInterval). 서버 캐시 시간보다 짧게 두지 않는다
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 10 * 60_000,
    },
  },
})

// 데이터 종류별 캐시 유지 시간 (값이 실제로 바뀌는 주기 기준)
export const STALE_MS = {
  daily: 10 * 60_000,     // 하루 1번 바뀌는 값 (시장 폭, 순위, 섹터, 캘린더, 리스크, 자본 이벤트)
  flows: 60 * 60_000,     // 증시 자금 흐름: 6시간마다 확인, 2 ~ 3일 늦게 공개
  disclosures: 60_000,    // 최근 공시 목록 (새 공시는 소켓으로 붙음)
} as const
