import type { CareerWarningV1 } from "../contracts/api.ts";
import type { DataOrigin } from "../contracts/index.ts";

export interface OriginCounts {
  live: number;
  verified_import: number;
  synthetic_fixture: number;
}

export function resolveDataOrigin(counts: OriginCounts, warnings?: CareerWarningV1[]): DataOrigin {
  if (counts.synthetic_fixture > 0) {
    throw new Error("career tables contain synthetic_fixture rows; refusing to publish them as real data");
  }
  if (counts.verified_import === 0) return "live";
  if (counts.live > 0 && warnings !== undefined) {
    warnings.push({
      code: "unknown_fields",
      message: "样本混合自动采集与人工核验导入（verified_import），整体按较保守口径标注。",
    });
  }
  return "verified_import";
}