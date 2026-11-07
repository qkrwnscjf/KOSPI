import { cache, redis } from '../../infrastructure/redis.js';
import { dbPool } from '../../infrastructure/db.js';
import { KRX_DAILY_INDICES, type KrxDailySymbol } from '../../shared/krx-indices.js';
import type { TickData } from '../../shared/types.js';

// 최신 tick 캐시의 만료 시간 (docs/Task_ORDER.md T-23, D-28)
// 수집이 멈추면 오래된 값이 끝없이 "현재가"로 남지 않도록 만료시킨다.
// 주말과 긴 연휴(최대 약 6일)에도 마지막 종가를 보여 줄 수 있도록 7일로 둔다. 값이 언제 것인지는 tick.timestamp(소스 기준 시각)로 화면에 표시한다 (T-27).
const LATEST_TICK_TTL_S = Number.parseInt(process.env.LATEST_TICK_TTL_S ?? '', 10) || 7 * 24 * 60 * 60;

export class MarketService {
  // Redis가 연결되어 있지 않으면 저장하지 않고 false를 돌려준다.
  // 연결이 끊긴 동안 명령이 대기열에 쌓이지 않게 하기 위함이다 (T-23). 다음 tick이 오면 다시 저장된다.
  async saveLatestTick(tick: TickData): Promise<boolean> {
    if (redis.status !== 'ready') return false;
    await redis.set(`latest_tick:${tick.symbol}`, JSON.stringify(tick), 'EX', LATEST_TICK_TTL_S);
    return true;
  }

  async getLatestTick(symbol: string): Promise<TickData | null> {
    const data = await redis.get(`latest_tick:${symbol}`);
    return data ? JSON.parse(data) : null;
  }

  // 구독 첫 값 (T-160): Redis가 끊겨도 오래 기다리지 않고 "값 없음"으로 본다(REST의 T-149와 같은 규칙)
  readLatestTickForSubscribe(symbol: string): Promise<TickData | null> {
    return cache.readJson<TickData>(`latest_tick:${symbol}`);
  }

  // KRX 일별 지수 (T-67): 과거 날짜를 다시 받는 경우가 있어서, 캐시보다 새 날짜일 때만 바꾼다
  async saveLatestTickIfNewer(tick: TickData): Promise<boolean> {
    if (redis.status !== 'ready') return false;
    const current = await this.getLatestTick(tick.symbol);
    if (current && current.timestamp > tick.timestamp) return false;
    return this.saveLatestTick(tick);
  }

  // KRX 일별 지수의 마지막 값 (캐시가 비어 있을 때 DB에서). 찾으면 캐시에도 넣는다.
  async getLatestDailyIndex(symbol: KrxDailySymbol): Promise<TickData | null> {
    const { rows } = await dbPool.query<{ time: number; close: number; change_rate: number; change_price: number | null }>(
      `SELECT (extract(epoch FROM time) * 1000)::float8 AS time, close, change_rate, change_price
       FROM index_daily WHERE symbol = $1 ORDER BY time DESC LIMIT 1`,
      [symbol]
    );
    const row = rows[0];
    if (!row) return null;
    const tick: TickData = { symbol, category: KRX_DAILY_INDICES[symbol].category, price: row.close, changeRate: row.change_rate, timestamp: row.time };
    if (row.change_price !== null) tick.changePrice = row.change_price;
    await this.saveLatestTickIfNewer(tick).catch(() => false);
    return tick;
  }
}

export const marketService = new MarketService();
