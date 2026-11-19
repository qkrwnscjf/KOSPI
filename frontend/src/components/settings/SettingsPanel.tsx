import { useEffect, useRef, type ReactNode } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClock } from '@/lib/format'
import { DATASET_LABELS, formatAge, formatBytes, jobState, SERVICE_LABELS } from '@/lib/pipeline'
import { usePipelineStatus } from '@/hooks/useAnalytics'
import { FOCUSABLE_SELECTOR, nextFocusIndex } from '@/lib/focusTrap'

// 설정 창 (docs/Task_ORDER.md 15단계 T-112, D-72)
// 사이드바 아래 톱니바퀴 버튼으로 연다. "파이프라인 상태"(서비스·데이터 신선도·Kafka·수집기·DB)를 보여 준다(테마 전환은 사이드바 버튼).
// 파이프라인 상태는 backend가 Prometheus에서 읽은 값이고, 같은 지표를 Grafana 대시보드에서 자세히 볼 수 있다(새 탭 링크).
// Grafana를 이 화면에 끼워 넣지 않는다(삽입 허용·익명 접근을 켜야 해서 보안 설정을 바꾸지 않음).

const GRAFANA_URL = import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3000/d/kospi-pipeline'

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold tracking-wide text-fg-muted">{title}</h3>
      {children}
      {note && <p className="text-[10px] leading-relaxed text-fg-muted">{note}</p>}
    </section>
  )
}

function Row({ label, value, state = 'neutral' }: { label: string; value: string; state?: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 text-[12px] last:border-b-0">
      <span className="flex min-w-0 items-center gap-2 text-fg">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
          state === 'ok' ? 'bg-up' : state === 'bad' ? 'bg-down' : state === 'warn' ? 'bg-fg-muted' : 'bg-fg/20')} aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 tabular-nums text-fg-muted">{value}</span>
    </div>
  )
}

function PipelineStatusView() {
  const { data, status } = usePipelineStatus(true)
  if (status === 'loading' && !data) return <p className="py-6 text-center text-xs text-fg-muted">불러오는 중</p>
  if (!data) return <p className="py-6 text-center text-xs text-fg-muted">상태를 불러오지 못했습니다</p>
  if (data.prometheus === 'unavailable') return <p className="py-6 text-center text-xs text-fg-muted">Prometheus에 연결되지 않아 상태를 확인할 수 없습니다</p>

  const yahooOk = data.yahoo15m.success ?? 0
  const yahooFail = Object.entries(data.yahoo15m).filter(([key]) => key !== 'success').reduce((sum, [, value]) => sum + value, 0)
  return (
    <div className="flex flex-col gap-5">
      <Section title="서비스">
        <div>{data.services.map(service => (
          <Row key={service.job} label={SERVICE_LABELS[service.job] ?? service.job} value={service.up ? '정상' : '응답 없음'} state={service.up ? 'ok' : 'bad'} />
        ))}</div>
      </Section>

      <Section title="데이터 신선도 (마지막 값 이후)" note="일별 데이터(KRX·시장 폭·종목 순위)는 장 마감 후 하루 1번 갱신되어 주말·휴일에는 수십 시간이 정상입니다.">
        <div>{data.datasets.map(item => (
          <Row key={item.dataset} label={DATASET_LABELS[item.dataset] ?? item.dataset} value={formatAge(item.ageSeconds)} />
        ))}</div>
      </Section>

      <Section title="Kafka">
        <div>
          <Row label="실시간 전송(Gateway) 연결" value={data.gatewayConnected ? '연결됨' : '끊김'} state={data.gatewayConnected ? 'ok' : 'bad'} />
          {data.consumerLag.map(item => (
            <Row key={item.group} label={`처리 대기 · ${item.group}`} value={`${item.lag.toLocaleString('ko-KR')}건`} state={item.lag > 100 ? 'warn' : 'ok'} />
          ))}
          {data.dlq.map(item => (
            <Row key={item.topic} label={`격리된 메시지 · ${item.topic}`} value={`${item.messages.toLocaleString('ko-KR')}건`} state={item.messages > 0 ? 'warn' : 'ok'} />
          ))}
        </div>
      </Section>

      <Section title="수집기">
        <div>
          <Row label="Yahoo 최근 15분" value={`성공 ${yahooOk} · 실패 ${yahooFail}`} state={yahooFail > 0 ? 'warn' : yahooOk > 0 ? 'ok' : 'neutral'} />
          {data.krxLastSuccessAge.map(item => (
            <Row key={item.endpoint} label={`KRX ${item.endpoint} 마지막 성공`} value={`${formatAge(item.seconds)} 전`} />
          ))}
          <Row label="DART 마지막 성공" value={data.dartLastSuccessAge === null ? '—' : `${formatAge(data.dartLastSuccessAge)} 전`} />
          <Row label="브라우저 실시간 연결" value={data.wsConnections === null ? '—' : `${data.wsConnections}개`} />
        </div>
      </Section>

      <Section title={`DB (용량 ${formatBytes(data.dbSizeBytes)})`} note="지연 배수 = 마지막 성공 후 경과 ÷ 작업 주기. 3을 넘으면 Grafana 알림이 울립니다.">
        <div>{data.dbJobs.map(job => {
          const state = jobState(job.failures, job.delayRatio)
          return (
            <Row key={job.job} label={job.job} state={state === 'stalled' ? 'bad' : state === 'failed_before' ? 'warn' : 'ok'}
              value={`지연 ${job.delayRatio === null ? '—' : job.delayRatio.toFixed(2)} · 실패 누적 ${job.failures}`} />
          )
        })}</div>
      </Section>

      {data.checkedAt !== null && <p className="text-[10px] text-fg-muted">확인 시각 {formatClock(data.checkedAt)} · 30초마다 갱신</p>}
    </div>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc로 닫기, 열릴 때 창으로 포커스 이동.
  // Tab은 창 안에서만 돌고, 닫으면 창을 연 버튼으로 포커스를 돌려준다 (plan.md FQA-11, T-197).
  // onClose는 사이드바가 그릴 때마다(현재가 tick마다) 새로 만들어져서, 이전에는 그때마다 이 효과가 다시 돌며 포커스가 창으로 되돌아갔다.
  // 그래서 최신 onClose는 ref로 읽고 효과는 열릴 때 한 번만 실행한다
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onClose = () => onCloseRef.current()
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusables = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      const next = nextFocusIndex(focusables.indexOf(document.activeElement as HTMLElement), focusables.length, event.shiftKey)
      if (next === null) return
      event.preventDefault()
      focusables[next]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-page/60 backdrop-blur-[2px]" onClick={onClose}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="설정"
        onClick={event => event.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto border-l border-line bg-surface p-6 outline-none">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight text-fg">설정</h2>
          <button type="button" onClick={onClose} aria-label="설정 닫기"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-neon/50 hover:text-neon">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-fg">파이프라인 상태</h3>
          <a href={GRAFANA_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-fg transition-colors hover:border-neon/50">
            Grafana에서 자세히 보기 <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
        <PipelineStatusView />
      </div>
    </div>
  )
}
