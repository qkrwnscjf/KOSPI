import { useCallback, useEffect, useState } from 'react'
import { MotionConfig } from 'framer-motion'
import { Sidebar } from '@/components/layout/Header'
import { AmbientBackground } from '@/components/layout/AmbientBackground'
import { DashboardGrid } from '@/components/dashboard/DashboardGrid'
import { DEFAULT_TAB_ID, TABS, tabById } from '@/constants/tabs'
import { hashFor, tabFromHash } from '@/lib/tabRoute'

// 탭 상태는 URL 해시에 둔다 (plan.md FQA-06, T-202): 새로고침·뒤로가기·링크 공유가 같은 탭으로 열린다
const currentTab = () => tabFromHash(window.location.hash, TABS, DEFAULT_TAB_ID)

function App() {
  const [activeCategory, setActiveCategory] = useState(currentTab)

  useEffect(() => {
    const onHashChange = () => setActiveCategory(currentTab())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const changeCategory = useCallback((id: string) => {
    const tab = tabById(id)
    if (!tab) return
    if (window.location.hash !== hashFor(tab.slug)) window.location.hash = hashFor(tab.slug)
    setActiveCategory(id)
  }, [])

  return (
    // 운영체제에서 "동작 줄이기"를 켠 사용자에게는 등장·전환 애니메이션을 끈다 (T-34)
    <MotionConfig reducedMotion="user">
      {/* overflow-x-clip: hidden과 달리 스크롤 영역을 만들지 않아 사이드바의 sticky가 동작한다 (T-68) */}
      <div className="relative min-h-screen w-full overflow-x-clip font-sans text-fg">
        <AmbientBackground />

        {/* 데스크톱은 왼쪽 사이드바 + 본문, 모바일은 위쪽 메뉴 + 본문 (T-68, D-54) */}
        <div className="relative z-10 flex min-h-screen w-full flex-col lg:flex-row">
          <Sidebar
            activeCategory={activeCategory}
            onCategoryChange={changeCategory}
          />

          <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 px-4 pb-20 md:px-8">
            <DashboardGrid categoryId={activeCategory} />
          </main>
        </div>
      </div>
    </MotionConfig>
  )
}

export default App
