// 시험 코드 타입 검사용 Node 내장 모듈 선언 (plan.md P6-3 · QA-43, docs/Task_ORDER.md T-224, BENCHMARK B-96)
// frontend는 `@types/node`가 없고, 새 의존성을 넣으려면 잠금 파일을 갱신해야 해서(호스트 npm 금지) 시험이 실제로 쓰는 범위만 적는다.
// 시험에서 새 Node 기능을 쓰면 여기에 선언을 더한다. 실행에는 영향이 없다(타입 검사 전용).

declare module 'node:test' {
  type TestFn = () => void | Promise<void>
  export function test(name: string, fn: TestFn): Promise<void>
  export function beforeEach(fn: TestFn): void

  interface MockFunctionContext {
    callCount(): number
    restore(): void
  }
  interface MockTimers {
    enable(options?: { apis?: ('setInterval' | 'setTimeout' | 'Date')[]; now?: number }): void
    tick(milliseconds: number): void
    reset(): void
  }
  export const mock: {
    timers: MockTimers
    method<T extends object, K extends keyof T>(object: T, methodName: K): T[K] & { mock: MockFunctionContext }
  }
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value
    ok(value: unknown, message?: string): asserts value
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T
    rejects(promise: Promise<unknown> | (() => Promise<unknown>), error?: ((error: unknown) => boolean) | RegExp | object | string, message?: string): Promise<void>
    doesNotThrow(fn: () => unknown, message?: string): void
  }
  const assert: Assert
  export default assert
}
