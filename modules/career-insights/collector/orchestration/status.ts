import type { CollectorFailureType } from "../fetch/errors.ts";

export type SourceStatus = "success" | "partial" | "failed" | "rejected" | "skipped";

export type BatchStatus = "success" | "partial" | "failed" | "rejected" | "config_error";

export const EXIT_CODES = {
  success: 0,
  unpredicted: 1,
  partial: 2,
  failed: 3,
  rejected: 4,
  config_error: 5,
  replay_mismatch: 6,
} as const;

export interface SourceStatusInput {
  readonly enabled: boolean;
  readonly safetyValveClosed: boolean;
  readonly collected: number;
  readonly invalid: number;
  readonly failure: CollectorFailureType | null;
}

export interface SourceStatusDecision {
  readonly status: SourceStatus;
  readonly failure_type: CollectorFailureType | null;
}

export function decideSourceStatus(input: SourceStatusInput): SourceStatusDecision {
  if (!input.enabled) {
    return { status: "skipped", failure_type: null };
  }
  if (input.safetyValveClosed) {
    return { status: "rejected", failure_type: null };
  }
  if (input.failure === "config_error") {
    return { status: "failed", failure_type: "config_error" };
  }
  if (input.failure !== null && input.collected === 0) {
    return { status: "failed", failure_type: input.failure };
  }
  if (input.invalid > 0 || input.failure !== null) {
    return { status: "partial", failure_type: input.failure };
  }
  if (input.collected === 0) {
    return { status: "failed", failure_type: "empty_result" };
  }
  return { status: "success", failure_type: null };
}

export interface BatchInput {
  readonly enabledSources: number;
  readonly statuses: readonly SourceStatus[];
  readonly anyConfigError: boolean;
}

export function decideBatchStatus(input: BatchInput): BatchStatus {
  if (input.anyConfigError) {
    return "config_error";
  }
  const success = input.statuses.filter((status) => status === "success").length;
  const rejected = input.statuses.filter((status) => status === "rejected").length;
  const failed = input.statuses.filter((status) => status === "failed").length;
  if (input.statuses.length > 0 && rejected === input.statuses.length) {
    return "rejected";
  }
  if (success === input.enabledSources && success > 0) {
    return "success";
  }
  if (success > 0 || input.statuses.includes("partial") || rejected > 0) {
    return "partial";
  }
  if (failed > 0) {
    return "failed";
  }
  return "partial";
}

export function exitCodeFor(status: BatchStatus, replayMismatch = false): number {
  if (replayMismatch) {
    return EXIT_CODES.replay_mismatch;
  }
  return EXIT_CODES[status];
}