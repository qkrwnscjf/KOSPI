import { cn } from '@/lib/utils'
import type { SegmentOption } from '@/lib/ui'

// 기간·분류 선택 버튼 묶음 (plan.md FQA-08, T-205)
// 예전에는 카드·섹터·공시·자본 이벤트·순위(시장·기준) 6곳에 같은 버튼 묶음을 복사해 썼고, 순위 기준만 선택 색이 달랐다.
// 선택된 항목은 흑백 반전(D-35). tone="soft"는 한 화면에 선택 묶음이 둘일 때 두 번째를 옅게 구분할 때만 쓴다.
// 항목 형식(SegmentOption)과 목록 만들기(segmentsOf)는 lib/ui.ts에 둔다. 부품 파일이 부품만 내보내야 개발 중 즉시 갱신이 유지된다 (lint, T-224)

interface Props<T extends string> {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  tone?: 'strong' | 'soft'
  scroll?: boolean // 항목이 많아 좁은 화면에서 가로로 넘길 때
  wrap?: boolean
  className?: string
}

export function SegmentedControl<T extends string>({ options, value, onChange, label, tone = 'strong', scroll = false, wrap = false, className }: Props<T>) {
  return (
    <div role="group" aria-label={label} className={cn('flex gap-1', scroll && 'no-scrollbar -mx-1 overflow-x-auto px-1', wrap && 'flex-wrap', className)}>
      {options.map(option => {
        const selected = option.key === value
        return (
          <button key={option.key} type="button" aria-pressed={selected} onClick={() => onChange(option.key)}
            className={cn('rounded-md px-2 py-1 text-[11px] transition-colors duration-150', scroll && 'shrink-0',
              selected
                ? tone === 'strong' ? 'bg-fg font-medium text-page' : 'bg-fg/10 font-medium text-fg'
                : 'text-fg-muted hover:bg-fg/5 hover:text-fg')}>
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
