import type { PolicyDetailDraft } from "../collector/index.ts";
import type { DataOrigin } from "../contracts/index.ts";
import { policyItemIdFromUrl, policyItemPathSegment } from "../collector/adapters/policy-id.ts";
import { policyContentHash } from "../collector/adapters/policy-fingerprint.ts";
import { THEME_KEYWORDS } from "../data/dictionaries.ts";
import { InvalidParameterError } from "./errors.ts";
import type { PolicyBatchInputV1, PolicyItemInputV1 } from "./policy-repository.ts";

const EXCERPT_LIMIT = 500;

/**
 * Envelope fields the collector does not carry. `source_issuer` is the real issuing authority for
 * sources whose detail pages omit it (NDRC list pages do), never a guessed organisation.
 */
export interface PolicyImportEnvelopeV1 {
  source_key: string;
  source_tier: PolicyItemInputV1["source_tier"];
  source_issuer: string;
  fetched_at: string;
  collector_version: string;
  data_origin?: DataOrigin;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.search = "";
  return url.toString();
}

/**
 * The collector path writes `policy_item_id` from the URL, so an imported draft must produce the
 * same id for the same policy; the document number is not part of the identity and stays on the
 * draft only. A URL without a last path segment falls back to the canonical URL.
 */
export function policyItemIdFromDraft(draft: PolicyDetailDraft): string {
  if (policyItemPathSegment(draft.url) === null) return `url:${canonicalUrl(draft.url)}`;
  return policyItemIdFromUrl(draft.url);
}

export function detectPolicyThemes(text: string): string[] {
  const haystack = text.toLowerCase();
  return Object.entries(THEME_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => haystack.includes(keyword.toLowerCase())))
    .map(([theme]) => theme);
}

export function policyItemFromDraft(draft: PolicyDetailDraft, envelope: PolicyImportEnvelopeV1): PolicyItemInputV1 {
  if (draft.sourceKey !== envelope.source_key) {
    throw new InvalidParameterError(`Draft source ${draft.sourceKey} does not match ${envelope.source_key}.`, {
      parameter: "source_key",
    });
  }

  const title = normalizedText(draft.title);
  const body = normalizedText(draft.bodyRaw);
  const policyItemId = policyItemIdFromDraft(draft);
  const publishedAt = draft.publishedAt === null ? null : draft.publishedAt.slice(0, 10);
  const draftIssuer = draft.issuingAuthority?.trim();
  const issuer = draftIssuer === undefined || draftIssuer === "" ? envelope.source_issuer : draftIssuer;

  return {
    policy_item_id: policyItemId,
    source_key: envelope.source_key,
    source_tier: envelope.source_tier,
    title,
    issuer: normalizedText(issuer),
    published_at: publishedAt,
    official_url: draft.url,
    theme_ids: detectPolicyThemes(`${title}\n${body}`),
    evidence_excerpt: body.slice(0, EXCERPT_LIMIT),
    content_hash: policyContentHash({
      source_key: envelope.source_key,
      policy_item_id: policyItemId,
      title,
      published_at: publishedAt,
      excerpt: body,
    }),
    collector_version: envelope.collector_version,
    fetched_at: envelope.fetched_at,
  };
}

/** Drafts from one collector run become one policy batch, ready for writePolicyBatch. */
export function policyBatchFromDrafts(
  drafts: readonly PolicyDetailDraft[],
  envelope: PolicyImportEnvelopeV1,
): PolicyBatchInputV1 {
  return {
    source_key: envelope.source_key,
    fetched_at: envelope.fetched_at,
    collector_version: envelope.collector_version,
    data_origin: envelope.data_origin ?? "live",
    policies: drafts.map((draft) => policyItemFromDraft(draft, envelope)),
  };
}