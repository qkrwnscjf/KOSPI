// 소스 지연 측정 테스트 (docs/Task_ORDER.md T-162, BENCHMARK B-66)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLagSample, LAG_WINDOW, MAX_LAG_MS, median, parseSourceLag, pushLagSample, summarizeLag } from '../src/shared/source-lag.js';

const NOW = 1_794_000_000_000;

test('장이 열려 있을 때의 0 ~ 3시간 지연만 표본으로 쓴다', () => {
  assert.equal(isLagSample(1_200_000, true), true);          // 국내 약 20분
  assert.equal(isLagSample(0, true), true);
  assert.equal(isLagSample(1_200_000, false), false);        // 장 마감 뒤 늦게 들어온 틱
  assert.equal(isLagSample(MAX_LAG_MS + 1, true), false);    // 공휴일·장 상태 변경으로 다시 보낸 지난 틱
  assert.equal(isLagSample(-1, true), false);                // 시계가 거꾸로인 값
  assert.equal(isLagSample(Number.NaN, true), false);
});

test('표본은 최근 LAG_WINDOW개만 남긴다', () => {
  let samples: number[] = [];
  for (let i = 0; i < LAG_WINDOW + 5; i += 1) samples = pushLagSample(samples, i);
  assert.equal(samples.length, LAG_WINDOW);
  assert.equal(samples[0], 5);
});

test('중앙값은 튀는 값에 흔들리지 않는다', () => {
  assert.equal(median([]), null);
  assert.equal(median([1_200_000, 1_201_000, 9_000_000]), 1_201_000);
  assert.equal(median([1, 3]), 2);
});

test('표본이 적으면 측정값을 만들지 않고, 충분하면 초 단위로 반올림한다', () => {
  assert.equal(summarizeLag([1_200_000, 1_200_000], NOW), null);
  assert.deepEqual(summarizeLag([1_199_600, 1_200_400, 1_201_000, 1_202_000, 1_203_000], NOW), { lagSeconds: 1201, samples: 5, measuredAt: NOW });
});

test('캐시에서 읽은 값은 형식이 맞을 때만 쓴다', () => {
  assert.deepEqual(parseSourceLag({ lagSeconds: 1201, samples: 30, measuredAt: NOW }), { lagSeconds: 1201, samples: 30, measuredAt: NOW });
  assert.equal(parseSourceLag({ lagSeconds: '1201', samples: 30, measuredAt: NOW }), null);
  assert.equal(parseSourceLag({ lagSeconds: -1, samples: 30, measuredAt: NOW }), null);
  assert.equal(parseSourceLag(null), null);
});
