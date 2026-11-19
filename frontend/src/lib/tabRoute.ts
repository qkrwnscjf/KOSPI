// 탭과 URL 해시 (plan.md FQA-06, T-202)
// 예전에는 탭 상태가 URL에 없어 새로고침·뒤로가기 때 첫 탭으로 돌아가고 탭 링크를 공유할 수 없었다.
// 해시(`#/domestic`)를 쓰면 서버(nginx) 설정 없이 동작한다. 모르는 해시는 첫 탭으로 연다.
// 테스트할 수 있도록 React와 분리한 순수 함수다(`@/` 별칭 없음).

export interface TabRoute { id: string; slug: string }

export const hashFor = (slug: string) => `#/${slug}`

export function tabFromHash(hash: string, tabs: readonly TabRoute[], fallbackId: string): string {
  const slug = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? ''
  return tabs.find(tab => tab.slug === slug)?.id ?? fallbackId
}
