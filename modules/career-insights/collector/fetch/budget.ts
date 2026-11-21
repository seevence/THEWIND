import type { ClockPort } from "./clock.ts";
import { BudgetExhaustedError } from "./errors.ts";

export interface SourceBudgetOptions {
  readonly clock: ClockPort;
  readonly totalMs: number;
  readonly sourceKey: string;
  readonly sleep: (ms: number) => Promise<void>;
}

export class SourceBudget {
  private readonly clock: ClockPort;
  private readonly totalMs: number;
  private readonly sourceKey: string;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly deadlineMs: number;

  constructor(options: SourceBudgetOptions) {
    this.clock = options.clock;
    this.totalMs = options.totalMs;
    this.sourceKey = options.sourceKey;
    this.sleepImpl = options.sleep;
    this.deadlineMs = options.clock.monotonicMs() + options.totalMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.clock.monotonicMs());
  }

  assertRemaining(): void {
    if (this.remainingMs() <= 0) {
      throw new BudgetExhaustedError(
        `来源 ${this.sourceKey} 的 ${this.totalMs}ms 预算已耗尽`,
        this.sourceKey,
      );
    }
  }

  async sleepWithin(ms: number): Promise<number> {
    const allowed = Math.min(ms, this.remainingMs());
    if (allowed <= 0) {
      throw new BudgetExhaustedError(`没有剩余预算可用于等待 ${ms}ms`, this.sourceKey);
    }
    await this.sleepImpl(allowed);
    return allowed;
  }
}