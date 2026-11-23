export type SourceKind = "job" | "policy";

export const JOB_MIN_SAMPLES = 5;

export const POLICY_MIN_SAMPLES = 3;

export interface QuotaItem {
  readonly source_key: string;
  readonly kind: SourceKind;
  readonly sample_count: number;
  /** 实测在招条数（Count）；稀疏源的必备份数收缩为 min(JOB_MIN_SAMPLES, max(1, count))，即最低可接受数据页数。 */
  readonly sparse_job_count?: number;
}

export interface QuotaGap {
  readonly source_key: string;
  readonly kind: SourceKind;
  readonly required: number;
  readonly actual: number;
  readonly missing: number;
}

export interface QuotaReport {
  readonly status: "ok" | "insufficient";
  readonly ok: boolean;
  readonly gaps: readonly QuotaGap[];
}

export function requiredSamples(kind: SourceKind): number {
  return kind === "job" ? JOB_MIN_SAMPLES : POLICY_MIN_SAMPLES;
}

export function evaluateQuota(items: readonly QuotaItem[]): QuotaReport {
  const gaps: QuotaGap[] = [];
  for (const item of items) {
    const required =
      item.kind === "job" && item.sparse_job_count !== undefined
        ? Math.min(JOB_MIN_SAMPLES, Math.max(1, item.sparse_job_count))
        : requiredSamples(item.kind);
    if (item.sample_count < required) {
      gaps.push({
        source_key: item.source_key,
        kind: item.kind,
        required,
        actual: item.sample_count,
        missing: required - item.sample_count,
      });
    }
  }
  return { status: gaps.length === 0 ? "ok" : "insufficient", ok: gaps.length === 0, gaps };
}