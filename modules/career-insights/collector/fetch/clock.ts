import { ConfigError } from "./errors.ts";

export interface ClockPort {
  nowIso(): string;
  monotonicMs(): number;
}

export class SystemClock implements ClockPort {
  private lastMonotonic = 0;

  nowIso(): string {
    return new Date().toISOString();
  }

  monotonicMs(): number {
    const now = Date.now();
    if (now < this.lastMonotonic) {
      throw new ConfigError("单调时钟回拨");
    }
    this.lastMonotonic = now;
    return now;
  }
}

export class FakeClock implements ClockPort {
  private currentMs: number;

  constructor(startIso: string) {
    this.currentMs = Date.parse(startIso);
    if (!Number.isFinite(this.currentMs)) {
      throw new ConfigError(`非法的假时钟起点：${startIso}`);
    }
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  monotonicMs(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new ConfigError("假时钟不能后退");
    }
    this.currentMs += ms;
  }
}