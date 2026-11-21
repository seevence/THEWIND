import {
  AccessBlockedError,
  BudgetExhaustedError,
  RequestTimeoutError,
} from "./errors.ts";

export interface RetryOptions {
  readonly maxRetries: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly retryAfter?: (error: unknown) => number | null;
  readonly assertBudget?: () => void;
}

export interface RetryOutcome<T> {
  readonly value: T;
  readonly attempts: number;
  readonly retried: number;
  readonly delaysMs: readonly number[];
}

const BASE_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

export function isRetryable(error: unknown): boolean {
  return error instanceof RequestTimeoutError;
}

export async function runWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const maxRetries = Math.min(options.maxRetries, 3);
  const delaysMs: number[] = [];
  let retried = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt, retried, delaysMs };
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        throw error;
      }

      if (error instanceof AccessBlockedError && error.limitationType === "rate_limited") {
        const retryAfter = options.retryAfter?.(error) ?? null;
        if (retried === 0 && retryAfter !== null && retryAfter <= 30_000) {
          retried += 1;
          delaysMs.push(retryAfter);
          options.assertBudget?.();
          await options.sleep(retryAfter);
          continue;
        }
        throw error;
      }

      if (!isRetryable(error) || retried >= maxRetries) {
        throw error;
      }

      const delay = BASE_DELAYS_MS[retried] ?? 4_000;
      retried += 1;
      delaysMs.push(delay);
      options.assertBudget?.();
      await options.sleep(delay);
    }
  }

  throw new Error("重试循环未产生结果");
}