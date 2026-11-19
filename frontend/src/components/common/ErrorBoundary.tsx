import { Component, type ErrorInfo, type ReactNode } from 'react'
import { fallbackText, type BoundaryScope } from '@/lib/errorBoundary'

// 오류 경계 (plan.md FQA-07, T-200)
// 예전에는 경계가 없어 카드 하나의 렌더 오류(예상 못 한 응답 형식 등)로 앱 전체가 빈 화면이 됐다.
// 탭과 카드 단위로 감싸서, 오류가 난 영역만 안내 문구로 바꾸고 나머지는 계속 그린다. "다시 그리기"로 다시 시도한다.
// 오류 원문은 화면에 보여 주지 않고(내부 정보), 개발자 콘솔에 이름과 메시지만 남긴다.

interface Props {
  scope: BoundaryScope
  label: string
  children: ReactNode
}

interface State {
  failed: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error(`[ui] ${this.props.scope} "${this.props.label}" render failed: ${error.name}: ${error.message.slice(0, 200)}`)
  }

  render() {
    if (!this.state.failed) return this.props.children
    const isCard = this.props.scope === 'card'
    return (
      <div role="alert" className={isCard
        ? 'flex h-[280px] md:h-[340px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line bg-surface px-4 text-center text-xs text-fg-muted'
        : 'flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line px-4 py-16 text-center text-xs text-fg-muted'}>
        <p>{fallbackText(this.props.scope, this.props.label)}</p>
        <button type="button" onClick={() => this.setState({ failed: false })}
          className="rounded-md border border-line px-2 py-1 text-[11px] text-fg transition-colors hover:border-neon/50">
          다시 그리기
        </button>
      </div>
    )
  }
}
