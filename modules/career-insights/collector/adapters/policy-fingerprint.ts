import { createHash } from "node:crypto";

const EXCERPT_LIMIT = 200;

export interface PolicyFingerprintInputV1 {
  source_key: string;
  policy_item_id: string;
  title: string;
  published_at: string | null;
  excerpt: string;
}

/**
 * One fingerprint for both write paths: the collector CLI and the draft import. The input is only
 * raw content facts, so the same policy produces the same hash no matter which path wrote it last.
 * `data_origin` and normalizer versions are deliberately excluded: switching those must not make the
 * same policy look updated on every run.
 */
export function policyContentHash(input: PolicyFingerprintInputV1): string {
  const excerpt = input.excerpt.replace(/\s+/g, " ").slice(0, EXCERPT_LIMIT).trim();
  return createHash("sha256")
    .update(
      JSON.stringify({
        source_key: input.source_key,
        policy_item_id: input.policy_item_id,
        title: input.title.replace(/\s+/g, " ").trim(),
        published_at: input.published_at,
        excerpt,
      }),
    )
    .digest("hex");
}