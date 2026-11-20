import { cn } from '@/lib/utils'
import { isLoadingText } from '@/lib/ui'

// 데이터 대신 보여 주는 상태 (plan.md FQA-08 · 16, docs/Task_ORDER.md T-221 · T-222)
// - 불러오는 중: 글자 대신 회색 줄 골격. 화면 읽기 프로그램에는 "불러오는 중"을 알린다(role="status").
//   움직임 줄이기 설정이면 깜빡이지 않는다(motion-safe).
// - 그 밖(오류·준비 중·빈 데이터): 가운데 글.
// 높이는 부모가 정한다: 차트 영역처럼 높이가 고정된 곳에 겹치거나(className에 absolute inset-0), 받은 뒤 내용과 같은 높이를 준다.
// 그래야 데이터가 와도 아래 내용이 밀리지 않는다.
const SKELETON_WIDTHS = ['72%', '88%', '64%', '80%']

export function StatusMessage({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null
  if (isLoadingText(message)) {
    return (
      <div role="status" aria-live="polite" className={cn('flex flex-col justify-center gap-2.5 px-4', className)}>
        <span className="sr-only">{message}</span>
        {SKELETON_WIDTHS.map(width => (
          <span key={width} aria-hidden className="h-2.5 rounded-full bg-fg/[0.06] motion-safe:animate-pulse" style={{ width }} />
        ))}
      </div>
    )
  }
  return <div className={cn('flex items-center justify-center px-4 text-center text-xs text-fg-muted', className)}>{message}</div>
}
