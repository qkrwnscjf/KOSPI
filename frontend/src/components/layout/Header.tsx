import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { Terminal, Sun, Moon, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { TABS } from '@/constants/tabs'
import { readCollapsed, writeCollapsed } from '@/lib/sidebarState'
import { motion } from 'framer-motion'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { useConnectionStatus, useLatestTick } from '@/hooks/useMarketData'
import { useTheme } from '@/lib/theme'
import { formatNumber } from '@/lib/format'
import type { TickData } from '@/lib/marketSocket'

// 왼쪽 사이드바 (docs/Task_ORDER.md T-68, D-54)
// 데스크톱(lg 이상): 왼쪽에 고정된 세로 메뉴, 아래쪽에 지수 · 연결 상태 · 테마 전환
// 모바일: 위쪽 막대(로고 · 연결 상태 · 테마 전환) + 가로로 스크롤되는 카테고리 탭
// 이전에는 가운데 로고 아래의 가로 탭(알약)이었다.

// 탭 이름·순서·아이콘은 constants/tabs.tsx 한 곳에서 정한다 (plan.md FQA-06, T-202)
const CATEGORIES = TABS

interface SidebarProps {
  activeCategory: string
  onCategoryChange: (id: string) => void
}

// 지수 표시. 색은 등락 기준이다 (T-33: 이전에는 KOSPI는 항상 초록, 원/달러는 항상 빨강이었음).
// 값이 없으면 "로딩중..."을 계속 깜빡이지 않고 "—"로 둔다.
function SidebarQuote({ label, tick }: { label: string; tick: TickData | null }) {
  const color = !tick ? 'text-fg-muted' : tick.changeRate > 0 ? 'text-up' : tick.changeRate < 0 ? 'text-down' : 'text-fg'
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] font-medium text-fg-muted">{label}</span>
      <span className={cn('text-xs font-semibold tabular-nums', color)}>
        {tick ? formatNumber(tick.price, 2) : '—'}
        {tick && (
          <span className="ml-1.5 text-[10px] font-medium">
            {tick.changeRate > 0 ? '+' : ''}{tick.changeRate.toFixed(2)}%
          </span>
        )}
      </span>
    </div>
  )
}

// 실제 WebSocket 연결 상태 (T-33). 연결되면 점이 강조색으로 빛난다 (T-69).
// compact(사이드바 접힘, T-199)이면 점만 보이고 글자는 화면 읽기 프로그램용으로만 남긴다
function ConnectionIndicator({ compact = false }: { compact?: boolean }) {
  const status = useConnectionStatus()
  const label = status === 'connected' ? '실시간' : status === 'disconnected' ? '연결 끊김' : '연결 중'
  return (
    <div className="flex items-center gap-2" title={`실시간 연결: ${label}`}>
      <span className="relative flex h-1.5 w-1.5">
        {status === 'connected' && <span className="absolute inset-0 rounded-full bg-neon opacity-60 motion-safe:animate-ping" />}
        <span
          className={cn(
            'relative h-1.5 w-1.5 rounded-full',
            status === 'connected' ? 'bg-neon shadow-[0_0_6px_rgb(var(--color-neon))]' : status === 'disconnected' ? 'bg-down' : 'bg-fg-muted'
          )}
        />
      </span>
      <span className={cn('text-[11px] font-medium', status === 'disconnected' ? 'text-down' : 'text-fg-muted', compact && 'sr-only')}>{label}</span>
    </div>
  )
}

// 사이드바 열기/접기 버튼 (T-199, 데스크톱만)
function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? '사이드바 펼치기' : '사이드바 접기'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="sidebar-panel"
      title={label}
      className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg transition-colors hover:border-neon/50 hover:text-neon lg:inline-flex"
    >
      {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
    </button>
  )
}

// 라이트·다크 전환 버튼 (T-54). 기본은 라이트.
function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg transition-colors hover:border-neon/50 hover:text-neon"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}

// 설정 창 열기 (15단계 T-112): 파이프라인 상태
function SettingsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="설정 열기 (파이프라인 상태)"
      title="설정 · 파이프라인 상태"
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg transition-colors hover:border-neon/50 hover:text-neon"
    >
      <Settings className="h-4 w-4" />
    </button>
  )
}

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fg shadow-[0_0_18px_-4px_rgb(var(--color-neon)/0.7)] ring-1 ring-neon/40">
        <Terminal className="h-[18px] w-[18px] text-page" />
      </div>
      <div className="flex flex-col">
        <span className="text-base font-bold leading-none tracking-tight text-fg">KOSPI Insight</span>
        <span className="mt-1 text-[10px] font-medium text-fg-muted">실시간 시장 대시보드</span>
      </div>
    </div>
  )
}

export function Sidebar({ activeCategory, onCategoryChange }: SidebarProps) {
  // 공유 소켓으로 최신값만 받는다 (T-24)
  const kospi = useLatestTick('KOSPI')
  const usdKrw = useLatestTick('USD/KRW')
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 데스크톱 사이드바 열기/접기 (T-199, D-95). 접으면 아이콘만 남기고 상태를 브라우저에 저장한다. 모바일(lg 미만)은 영향 없음
  const [collapsed, setCollapsed] = useState(() => readCollapsed(typeof window === 'undefined' ? undefined : window.localStorage))
  useEffect(() => writeCollapsed(window.localStorage, collapsed), [collapsed])

  return (
    <aside className={cn(
      'sticky top-0 z-40 w-full border-b border-line bg-page/90 lg:h-screen lg:shrink-0 lg:self-start lg:border-b-0 lg:border-r lg:bg-surface/60 lg:transition-[width] lg:duration-200',
      collapsed ? 'lg:w-16' : 'lg:w-60'
    )}>
      <div id="sidebar-panel" className={cn('flex h-full flex-col gap-3 px-4 pb-2 pt-3 lg:gap-8 lg:py-7', collapsed ? 'lg:px-2' : 'lg:px-4')}>
        {/* 로고 (모바일에서는 오른쪽에 연결 상태 · 테마 전환). 데스크톱은 접기 버튼, 접히면 로고 대신 버튼만 */}
        <div className={cn('flex items-center justify-between', collapsed ? 'lg:justify-center' : 'lg:px-2')}>
          <div className={cn(collapsed && 'lg:hidden')}><Logo /></div>
          <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(previous => !previous)} />
          <div className="flex items-center gap-3 lg:hidden">
            <ConnectionIndicator />
            <SettingsButton onOpen={() => setSettingsOpen(true)} />
            <ThemeToggle />
          </div>
        </div>

        {/* 카테고리: 선택된 항목은 강조색 면 + 왼쪽 빛 막대 (D-54) */}
        <nav aria-label="카테고리" className="no-scrollbar -mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0">
          <span className={cn('mb-2 hidden px-3 text-[10px] font-semibold tracking-[0.2em] text-fg-muted', !collapsed && 'lg:block')}>메뉴</span>
          <ul className="flex gap-1 lg:flex-col">
            {CATEGORIES.map(item => {
              const Icon = item.icon
              const isActive = activeCategory === item.id
              return (
                <li key={item.id} className="shrink-0">
                  {/* 현재 보고 있는 탭은 aria-current로 알린다 (plan.md FQA-11, T-197). 예전 aria-pressed는 켜고 끄는 버튼이라는 뜻이었다 */}
                  <button
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => onCategoryChange(item.id)}
                    title={collapsed ? item.name : undefined}
                    className={cn(
                      'relative flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left transition-colors duration-200 lg:py-2.5',
                      collapsed && 'lg:justify-center lg:px-0',
                      isActive ? 'text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="sidebar-active"
                        className="pointer-events-none absolute inset-0 rounded-lg bg-neon/10 ring-1 ring-inset ring-neon/30"
                        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <span className="absolute left-0 top-1/2 hidden h-5 w-[3px] -translate-y-1/2 rounded-full bg-neon shadow-[0_0_10px_rgb(var(--color-neon))] lg:block" />
                      </motion.span>
                    )}
                    <Icon className={cn('relative z-10 h-4 w-4 shrink-0', isActive && 'text-neon')} />
                    {/* 접혀도 탭 이름은 화면 읽기 프로그램용으로 남긴다(sr-only) */}
                    <span className={cn('relative z-10 text-sm', isActive ? 'font-semibold' : 'font-medium', collapsed && 'lg:sr-only')}>{item.name}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* 데스크톱 아래쪽: 지수 · 연결 상태 · 테마 전환 */}
        <div className={cn('mt-auto hidden flex-col gap-4 border-t border-line pt-5 lg:flex', collapsed ? 'items-center px-0' : 'px-2')}>
          {!collapsed && (
            <div className="flex flex-col gap-2">
              <SidebarQuote label="KOSPI" tick={kospi} />
              <SidebarQuote label="USD/KRW" tick={usdKrw} />
            </div>
          )}
          <div className={cn('flex items-center justify-between', collapsed && 'flex-col gap-3')}>
            <ConnectionIndicator compact={collapsed} />
            <div className={cn('flex items-center gap-2', collapsed && 'flex-col')}>
              <SettingsButton onOpen={() => setSettingsOpen(true)} />
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </aside>
  )
}
