// 정수 설정값 읽기 (plan.md QA-39 / P5-2 축소, docs/Task_ORDER.md T-225, BENCHMARK B-99)
// 예전에는 서비스마다 readIntEnv를 따로 두어(6벌) 0·음수 처리가 세 가지로 달랐다.
// 수집 주기에 0이 들어가면 쉬지 않고 도는 등(이벤트 루프 굶김) 서비스마다 결과가 달랐다.
// 규칙 하나로 통일한다:
// - 비어 있으면 기본값
// - 정수가 아니거나(소수·글자 섞임) 최솟값보다 작으면 기본값 + 경고 1줄(설정 이름만 남기고 값은 남기지 않음)
// - 최솟값은 기본 1. 0에 뜻이 있는 설정(예: 로그 주기 0 = 끔)만 { min: 0 }으로 연다

export interface IntSettingOptions {
  min?: number;
}

type Source = Readonly<Record<string, string | undefined>>;
type Warn = (message: string) => void;

const INTEGER_PATTERN = /^-?\d+$/;

export function readIntSetting(
  name: string,
  fallback: number,
  options: IntSettingOptions = {},
  source: Source = process.env,
  warn: Warn = message => console.warn(message),
): number {
  const raw = source[name]?.trim() ?? '';
  if (raw === '') return fallback;
  const min = options.min ?? 1;
  const value = INTEGER_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    warn(`Setting ${name} must be an integer >= ${min}; using the default ${fallback}.`);
    return fallback;
  }
  return value;
}
