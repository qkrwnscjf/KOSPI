// 접근성 (plan.md FQA-11, T-197, BENCHMARK B-78 ⑥)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextFocusIndex } from '../src/lib/focusTrap.ts'
import { chartSummary } from '../src/lib/chartSummary.ts'

test('설정 창 Tab 순환: 마지막에서 Tab → 처음, 처음에서 Shift+Tab → 마지막, 창 자체에서 시작하면 처음/마지막', () => {
  assert.equal(nextFocusIndex(4, 5, false), 0)
  assert.equal(nextFocusIndex(0, 5, true), 4)
  assert.equal(nextFocusIndex(-1, 5, false), 0)
  assert.equal(nextFocusIndex(-1, 5, true), 4)
  assert.equal(nextFocusIndex(2, 5, false), null, '가운데는 브라우저 기본 이동')
  assert.equal(nextFocusIndex(-1, 0, false), null, '포커스할 요소가 없으면 그대로')
})

test('그래프 요약 글: 시작·마지막 값과 기간 등락, 점 수', () => {
  const format = (value: number) => value.toFixed(2)
  const points = [{ time: 1, value: 2650 }, { time: 2, value: 2660 }, { time: 3, value: 2700 }]
  assert.equal(chartSummary('코스피 지수', '1일', points, format), '코스피 지수 1일 그래프: 시작 2650.00, 마지막 2700.00 (+1.89%), 점 3개')
  assert.equal(chartSummary('VIX', '실시간', [], format), 'VIX 실시간 그래프: 표시할 데이터 없음')
  assert.equal(chartSummary('금리차', '1주', [{ time: 1, value: 0.5 }], format), '금리차 1주 그래프: 값 0.50, 점 1개')
  assert.equal(chartSummary('금리차', '1주', [{ time: 1, value: 0 }, { time: 2, value: 0.1 }], format), '금리차 1주 그래프: 시작 0.00, 마지막 0.10, 점 2개', '시작이 0이면 등락률을 붙이지 않는다')
})
