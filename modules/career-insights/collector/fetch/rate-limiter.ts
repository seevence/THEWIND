import type { ClockPort } from "./clock.ts";

export interface RateLimiterOptions {
  readonly minIntervalMs: number;
  readonly clock: ClockPort;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface HostStats {
  readonly requests: number;
  readonly peakInFlight: number;
  readonly lastFinishedAtMs: number | null;
}

export class HostRateLimiter {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastFinishedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly requestCount = new Map<string, number>();
  private readonly peak = new Map<string, number>();
  private readonly options: RateLimiterOptions;

  constructor(options: RateLimiterOptions) {
    this.options = options;
  }

  async schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.tails.set(
      host,
      previous.then(
        () => current,
        () => current,
      ),
    );

    await previous.then(
      () => undefined,
      () => undefined,
    );

    try {
      const last = this.lastFinishedAt.get(host);
      if (last !== undefined) {
        const waitMs = this.options.minIntervalMs - (this.options.clock.monotonicMs() - last);
        if (waitMs > 0) {
          await this.options.sleep(waitMs);
        }
      }

      const active = (this.inFlight.get(host) ?? 0) + 1;
      this.inFlight.set(host, active);
      this.peak.set(host, Math.max(this.peak.get(host) ?? 0, active));
      this.requestCount.set(host, (this.requestCount.get(host) ?? 0) + 1);

      try {
        return await task();
      } finally {
        this.inFlight.set(host, (this.inFlight.get(host) ?? 1) - 1);
        this.lastFinishedAt.set(host, this.options.clock.monotonicMs());
      }
    } finally {
      releaseCurrent();
    }
  }

  stats(host: string): HostStats {
    return {
      requests: this.requestCount.get(host) ?? 0,
      peakInFlight: this.peak.get(host) ?? 0,
      lastFinishedAtMs: this.lastFinishedAt.get(host) ?? null,
    };
  }
}