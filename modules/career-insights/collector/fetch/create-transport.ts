import { ConfigError } from "./errors.ts";
import { HttpTransport } from "./http-transport.ts";
import { ReplayTransport } from "./replay-transport.ts";
import type { ReplaySample } from "./replay-transport.ts";
import type { FetchTransport } from "./transport.ts";

export type TransportMode = "live" | "replay" | "dynamic";

export interface TransportFactoryOptions {
  readonly replaySamples?: readonly ReplaySample[];
  readonly anchorIso?: string | null;
}

export const transportFactoryStats = {
  httpConstructed: 0,
  replayConstructed: 0,
  reset(): void {
    this.httpConstructed = 0;
    this.replayConstructed = 0;
  },
};

export function createTransport(
  mode: TransportMode,
  options: TransportFactoryOptions = {},
): FetchTransport {
  if (mode === "replay") {
    transportFactoryStats.replayConstructed += 1;
    return new ReplayTransport(options.replaySamples ?? [], options.anchorIso ?? null);
  }
  if (mode === "live") {
    transportFactoryStats.httpConstructed += 1;
    return new HttpTransport();
  }
  throw new ConfigError("动态页面渲染必须在独立 CLI 子进程中执行，库进程不得启动浏览器");
}