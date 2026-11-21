import type { SourceStatus } from "./status.ts";

export interface RunSummaryInput {
  readonly enabledSources: number;
  readonly statuses: readonly SourceStatus[];
  readonly collected: number;
  readonly invalid: number;
  readonly jobTarget: number;
}

export interface RunSummary {
  readonly enabled_sources: number;
  readonly success_sources: number;
  readonly partial_sources: number;
  readonly failed_sources: number;
  readonly rejected_sources: number;
  readonly skipped_sources: number;
  readonly success_rate: number;
  readonly collected: number;
  readonly invalid: number;
  readonly job_target_gap: number;
}

export function buildRunSummary(input: RunSummaryInput): RunSummary {
  const count = (status: SourceStatus): number => input.statuses.filter((value) => value === status).length;
  const success = count("success");
  const partial = count("partial");
  const failed = count("failed");
  const rejected = count("rejected");
  const skipped = count("skipped");

  const classified = success + partial + failed + rejected + skipped;
  if (input.statuses.length > input.enabledSources) {
    throw new Error(`状态数量 ${input.statuses.length} 超过启用来源数 ${input.enabledSources}`);
  }
  if (classified !== input.statuses.length) {
    throw new Error("来源状态必须互斥且可完全分类");
  }

  const denominator = input.enabledSources - rejected - skipped;
  return {
    enabled_sources: input.enabledSources,
    success_sources: success,
    partial_sources: partial,
    failed_sources: failed,
    rejected_sources: rejected,
    skipped_sources: skipped,
    success_rate: denominator <= 0 ? 0 : success / denominator,
    collected: input.collected,
    invalid: input.invalid,
    job_target_gap: Math.max(0, input.jobTarget - input.collected),
  };
}