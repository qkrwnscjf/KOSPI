// 종료 처리 (docs/Task_ORDER.md T-28, P-15)
// SIGTERM(docker stop, Kubernetes)이나 SIGINT(Ctrl+C)를 받으면 정리 단계를 순서대로 실행하고 종료 코드 0으로 끝낸다.
// - Node는 PID 1로 실행되면 신호 처리기가 없을 때 SIGTERM을 무시한다. 그래서 Docker가 10초 기다린 뒤 강제 종료(137)했다.
// - Kafka 컨슈머가 그룹에서 정상적으로 나가지 못하면, 다시 시작할 때 이전 멤버의 세션 만료를 기다리느라 그룹 참여가 늦어진다.
// 정리가 제한 시간 안에 끝나지 않으면 종료 코드 1로 끝낸다 (Docker 기본 대기 시간 10초보다 짧게).

type ShutdownStep = { name: string; run: () => Promise<unknown> | unknown };

const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '', 10) || 8000;

// 처리되지 않은 오류 (plan.md QA-02 / P1-2, T-175): 어느 서비스에서든 놓친 Promise 거부나 예외는 한 줄로 남기고 종료 코드 1로 끝낸다.
// 살려 두면 상태가 어긋난 채 계속 돌 수 있어 종료는 유지하고, 재시작은 compose 재시작 정책에 맡긴다.
// 오류 이름과 짧은 메시지만 남긴다(수집기 오류는 종류만 담도록 만들어져 있고, 주소·키는 남기지 않는다).
let crashHandlersInstalled = false;
const describeCrash = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : typeof error === 'string' ? error.slice(0, 200) : 'non-error value';

function installCrashHandlers(component: string) {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  process.on('unhandledRejection', reason => {
    console.error(`[crash] ${component}: unhandled promise rejection (${describeCrash(reason)}), exiting with code 1`);
    process.exit(1);
  });
  process.on('uncaughtException', error => {
    console.error(`[crash] ${component}: uncaught exception (${describeCrash(error)}), exiting with code 1`);
    process.exit(1);
  });
}

export function registerShutdown(component: string, steps: ShutdownStep[]) {
  installCrashHandlers(component);
  let started = false;

  const shutdown = async (signal: string) => {
    if (started) return;
    started = true;
    const startedAt = Date.now();
    console.log(`[shutdown] ${component}: ${signal} received, closing ${steps.length} resources...`);

    const timer = setTimeout(() => {
      console.error(`[shutdown] ${component}: not finished within ${SHUTDOWN_TIMEOUT_MS}ms, exiting with code 1`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    // 한 단계가 실패해도 다음 단계는 계속한다 (예: Redis가 이미 끊겨 있어도 DB 연결은 닫는다).
    let failed = 0;
    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        failed += 1;
        console.error(`[shutdown] ${component}: ${step.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(`[shutdown] ${component}: done in ${Date.now() - startedAt}ms (${failed} steps failed)`);
    process.exit(failed > 0 ? 1 : 0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
