// 공시 주기 조회의 쪽 넘김 (plan.md QA-09 / P2-1, T-178, BENCHMARK B-76 ③)
// 500건(5쪽)보다 많이 밀린 상황에서 두 주기 안에 빠짐없이 읽는지 확인한다. 외부 호출 없음(가짜 목록).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLivePages, type LivePage } from '../src/infrastructure/disclosures/dart-disclosures.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

// 접수번호가 큰 것이 최신. 목록은 최신순
const rceptNo = (index: number) => `20261114${String(800000 + index).padStart(6, '0')}`;
const makeSource = (count: number) => Array.from({ length: count }, (_, index) => rceptNo(count - index)); // 최신이 앞

function pager(source: string[]) {
  return async (pageNo: number): Promise<LivePage> => {
    const rows = source.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
    return { rceptNos: rows, rawCount: rows.length, totalPage: Math.ceil(source.length / PAGE_SIZE) };
  };
}

// collector의 pollOnce와 같은 순서: 1쪽부터 읽고, 남은 쪽이 있으면 이어 읽는다
async function poll(source: string[], seen: Set<string>, resumePage: number | null, resume = true) {
  const common = { maxPages: MAX_PAGES, pageSize: PAGE_SIZE, isSeen: (no: string) => seen.has(no) };
  const latest = await readLivePages(pager(source), { ...common, firstPage: 1, stopOnSeen: true });
  const pages = [...latest.pages];
  let nextPage = latest.nextPage;
  if (resume && nextPage === null && resumePage !== null) {
    const resumed = await readLivePages(pager(source), { ...common, firstPage: resumePage, stopOnSeen: false });
    pages.push(...resumed.pages);
    nextPage = resumed.nextPage;
  }
  for (const page of pages) for (const no of page.rceptNos) seen.add(no);
  return nextPage;
}

test('600건이 밀린 뒤 새 공시 3건이 오면, 두 주기 안에 603건을 모두 읽는다', async () => {
  const backlog = makeSource(600);
  const seen = new Set<string>();
  const next = await poll(backlog, seen, null);
  assert.equal(next, 6, '첫 주기는 5쪽(500건)에서 멈추고 6쪽부터 이어 읽기로 남긴다');
  assert.equal(seen.size, 500);

  const withNew = [rceptNo(603), rceptNo(602), rceptNo(601), ...backlog];
  const after = await poll(withNew, seen, next);
  assert.equal(after, null, '끝까지 읽어 이어 읽을 쪽이 없다');
  assert.equal(withNew.filter(no => !seen.has(no)).length, 0, '빠진 공시 0건');
});

test('이전 방식(이어 읽기 없음)은 같은 상황에서 100건을 놓친다 (Before)', async () => {
  const backlog = makeSource(600);
  const seen = new Set<string>();
  await poll(backlog, seen, null, false);
  const withNew = [rceptNo(603), rceptNo(602), rceptNo(601), ...backlog];
  await poll(withNew, seen, null, false);
  assert.equal(withNew.filter(no => !seen.has(no)).length, 100);
});

test('평소(밀린 공시 없음)에는 1쪽만 읽고 멈춘다', async () => {
  const source = makeSource(250);
  const seen = new Set(source.slice(2)); // 새 공시 2건만 안 본 상태
  const calls: number[] = [];
  const result = await readLivePages(async pageNo => { calls.push(pageNo); return pager(source)(pageNo); },
    { firstPage: 1, maxPages: MAX_PAGES, pageSize: PAGE_SIZE, isSeen: no => seen.has(no), stopOnSeen: true });
  assert.deepEqual(calls, [1]);
  assert.equal(result.nextPage, null);
});

test('빈 목록(공시 0건)이면 한 번만 요청하고 끝난다', async () => {
  const result = await readLivePages(pager([]), { firstPage: 1, maxPages: MAX_PAGES, pageSize: PAGE_SIZE, isSeen: () => false, stopOnSeen: true });
  assert.equal(result.pages.length, 1);
  assert.equal(result.nextPage, null);
});
