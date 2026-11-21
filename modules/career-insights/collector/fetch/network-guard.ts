import { ReplayNetworkViolationError } from "./errors.ts";

export interface NetworkGuardHandle {
  readonly restore: () => void;
  readonly violations: () => number;
}

type FetchLike = typeof globalThis.fetch;

interface FetchHolder {
  fetch: FetchLike;
}

export function installNetworkGuard(
  holder: FetchHolder = globalThis as unknown as FetchHolder,
): NetworkGuardHandle {
  const original = holder.fetch;
  let violations = 0;
  holder.fetch = (async () => {
    violations += 1;
    throw new ReplayNetworkViolationError();
  }) as FetchLike;

  return {
    restore: () => {
      holder.fetch = original;
    },
    violations: () => violations,
  };
}