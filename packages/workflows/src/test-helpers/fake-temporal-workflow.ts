/**
 * A minimal in-process fake of the `@temporalio/workflow` APIs that require a
 * live workflow execution context to run (`proxyActivities`, `setHandler`,
 * `condition`) — used to exercise `campaignProductionWorkflow` end-to-end
 * under plain vitest via `vi.mock('@temporalio/workflow', ...)`, without a
 * `TestWorkflowEnvironment` (which needs a native test-server binary this
 * environment cannot download — see
 * `packages/testing/src/temporal-test-environment.ts`).
 *
 * Deliberately placed outside `src/workflows/*` (a sibling of it) — that
 * directory is restricted by CLAUDE.md to deterministic, I/O-free workflow
 * code, and this file exists purely to support tests, not to be bundled into
 * a real workflow.
 */

type AnyFn = (...args: unknown[]) => unknown;

interface HandlerDefinition {
  type: 'signal' | 'query';
  name: string;
}

let signalHandlers = new Map<string, AnyFn>();
let queryHandlers = new Map<string, AnyFn>();
let activityImpls: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

export function resetFakeWorkflowRuntime(): void {
  signalHandlers = new Map();
  queryHandlers = new Map();
  activityImpls = {};
}

export function setFakeActivityImpls(
  impls: Record<string, (...args: unknown[]) => Promise<unknown>>,
): void {
  activityImpls = impls;
}

export function fireSignal(name: string, payload: unknown): void {
  const handler = signalHandlers.get(name);
  if (!handler) {
    throw new Error(`fake-temporal-workflow: no signal handler registered for "${name}"`);
  }
  handler(payload);
}

export function runQuery<T>(name: string, ...args: unknown[]): T {
  const handler = queryHandlers.get(name);
  if (!handler) {
    throw new Error(`fake-temporal-workflow: no query handler registered for "${name}"`);
  }
  return handler(...args) as T;
}

export function fakeProxyActivities(): Record<string, AnyFn> {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        return async (...args: unknown[]) => {
          const impl = activityImpls[prop];
          if (!impl) {
            throw new Error(`fake-temporal-workflow: no activity impl registered for "${prop}"`);
          }
          return impl(...args);
        };
      },
    },
  );
}

export function fakeSetHandler(definition: HandlerDefinition, handler: AnyFn): void {
  if (definition.type === 'signal') {
    signalHandlers.set(definition.name, handler);
  } else {
    queryHandlers.set(definition.name, handler);
  }
}

/**
 * Polls via `setImmediate` rather than `queueMicrotask`: a tight microtask
 * loop never yields to Node's timer phase, which would starve any test that
 * delivers a signal from inside a `setTimeout` callback (the microtask queue
 * runs to exhaustion before timers ever get a turn).
 */
export function fakeCondition(fn: () => boolean): Promise<true> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (fn()) {
        resolve(true);
      } else {
        setImmediate(check);
      }
    };
    check();
  });
}
