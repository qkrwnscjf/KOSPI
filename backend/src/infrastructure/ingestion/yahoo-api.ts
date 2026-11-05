import YahooFinance from 'yahoo-finance2';
import type { NormalizedMarketData } from './normalizer.js';
import { Counter } from '../metrics.js';
import { YAHOO_SYMBOLS, YAHOO_CATEGORY as CATEGORY_BY_KEY, YAHOO_KEYS } from '../../shared/symbols.js';
import type { YahooSymbolKey } from '../../shared/symbols.js';
import { isMarketState } from '../../shared/market-state.js';
import { safeLogText } from '../http-json.js';

const yahooFinance = new YahooFinance();

// Yahoo가 응답의 symbol을 요청과 다른 표기로 돌려주는 경우 (docs/pipeline.md P-23)
const YAHOO_SYMBOL_ALIASES: Record<string, string> = {
  'USDKRW=X': 'KRW=X'
};

const KEY_BY_YAHOO_SYMBOL = new Map<string, YahooSymbolKey>(
  YAHOO_KEYS.map(key => [YAHOO_SYMBOLS[key], key])
);

// 측정 지표 (docs/Task_ORDER.md T-30, T-05). 라벨에는 내부 심볼과 고정된 사유만 넣는다.
const symbolAliasTotal = new Counter('kospi_worker_symbol_alias_total', 'Yahoo responses whose symbol was an alias, by internal symbol');
const unmappedSymbolTotal = new Counter('kospi_worker_unmapped_symbol_total', 'Yahoo quotes dropped because the symbol could not be mapped');
const invalidQuoteTotal = new Counter('kospi_worker_invalid_quote_total', 'Yahoo quotes dropped by validation, by symbol and reason');
// 장 상태 값이 없거나 알 수 없는 값이면 그 지표는 시간표로만 판단한다 (T-56)
const missingMarketStateTotal = new Counter('kospi_worker_missing_market_state_total', 'Yahoo quotes without a known marketState, by symbol');

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// 값 검증 (docs/Task_ORDER.md T-05, D-14)
// 이전에는 값이 없으면 0이나 수집 시각으로 대체해서, "값 없음"이 정상값처럼 저장되었다.
// 이제는 버리고 사유를 센다. 등락률·등락폭의 0은 실제로 나올 수 있는 정상값이라 허용한다.
type ValidatedQuote = { price: number; time: Date; changeRate: number; changePrice: number };

function validateQuote(
  price: unknown,
  time: unknown,
  changeRate: unknown,
  changePrice: unknown
): ValidatedQuote | { reason: string } {
  if (!isFiniteNumber(price) || price <= 0) return { reason: 'price' };
  if (!(time instanceof Date) || Number.isNaN(time.getTime())) return { reason: 'timestamp' };
  if (!isFiniteNumber(changeRate)) return { reason: 'change_rate' };
  if (!isFiniteNumber(changePrice)) return { reason: 'change_price' };
  return { price, time, changeRate, changePrice };
}

// 요청 실패는 삼키지 않고 던진다. worker가 result="error"로 집계하고 백오프한다 (docs/Task_ORDER.md T-05).
// keys: 이번에 요청할 지표(T-131, 열린 시장 지표만 요청할 때). 기본은 전체
// signal: 시간 제한 때 요청 자체를 끊는다 (T-156). 라이브러리에는 시간 제한이 없다(T-150에서 확인)
export async function fetchYahooData(keys: readonly YahooSymbolKey[] = YAHOO_KEYS, signal?: AbortSignal): Promise<NormalizedMarketData[]> {
  const symbols = keys.map(key => YAHOO_SYMBOLS[key]);
  if (symbols.length === 0) return [];

  // yahoo-finance2 supports fetching multiple quotes at once
  const quotes = await yahooFinance.quote(symbols, {}, signal ? { fetchOptions: { signal } } : {});
  return mapYahooQuotes(quotes as unknown as readonly YahooQuoteFields[]);
}

// 필드 이름 계약 테스트 대상 (T-123). 응답 항목 → 내부 형식. 맞지 않는 항목은 사유를 세고 버린다
export interface YahooQuoteFields {
  symbol: string;
  regularMarketPrice?: unknown;
  regularMarketTime?: unknown;
  regularMarketChangePercent?: unknown;
  regularMarketChange?: unknown;
  regularMarketVolume?: unknown;
  marketState?: unknown;
}

export function mapYahooQuotes(quotes: readonly YahooQuoteFields[]): NormalizedMarketData[] {
  const results: NormalizedMarketData[] = [];
  const seen = new Set<YahooSymbolKey>();

  for (const quote of quotes) {
    const canonicalSymbol = YAHOO_SYMBOL_ALIASES[quote.symbol] ?? quote.symbol;
    const key = KEY_BY_YAHOO_SYMBOL.get(canonicalSymbol);

    // 매핑할 수 없는 심볼은 그대로 쓰지 않고 버린다. 잘못된 심볼이 Kafka와 DB에 들어가지 않게 하기 위함.
    if (!key) {
      unmappedSymbolTotal.inc();
      // 응답에서 온 문자열이라 제어 문자를 지우고 길이를 잘라 기록한다 (로그 위조 방지, SEC-015)
      console.warn(`Unmapped Yahoo symbol skipped: ${safeLogText(quote.symbol, 30)}`);
      continue;
    }
    if (canonicalSymbol !== quote.symbol) {
      symbolAliasTotal.inc({ symbol: key });
    }
    // 같은 응답에 표준 심볼과 별칭이 함께 오면 먼저 온 하나만 쓴다.
    if (seen.has(key)) continue;
    seen.add(key);

    const validated = validateQuote(
      quote.regularMarketPrice,
      quote.regularMarketTime,
      quote.regularMarketChangePercent,
      quote.regularMarketChange
    );
    if ('reason' in validated) {
      invalidQuoteTotal.inc({ symbol: key, reason: validated.reason });
      console.warn(`Invalid Yahoo quote skipped: ${key} (${validated.reason})`);
      continue;
    }

    const marketState: unknown = quote.marketState;
    if (!isMarketState(marketState)) {
      missingMarketStateTotal.inc({ symbol: key });
    }

    results.push({
      ticker: key,
      category: CATEGORY_BY_KEY[key],
      price: validated.price,
      changeRate: validated.changeRate,
      changePrice: validated.changePrice,
      timestamp: validated.time.getTime(),
      ...(isFiniteNumber(quote.regularMarketVolume) ? { volume: quote.regularMarketVolume } : {}),
      ...(isMarketState(marketState) ? { marketState } : {}),
    });
  }

  return results;
}
