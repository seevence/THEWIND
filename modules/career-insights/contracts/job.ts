export const CAREER_CONTRACT_VERSION = "0.1";
export const CAREER_SCHEMA_VERSION = "1.0";

export type RoleFamily =
  | "ai_algorithm"
  | "ai_application_development"
  | "data"
  | "ai_product_operations"
  | "unknown";
export type EmploymentType = "campus" | "internship" | "experienced" | "other" | "unknown";
export type DegreeLevel = "any_explicit" | "bachelor" | "master" | "doctor" | "other" | "unknown";
export type StudentFriendly = "yes" | "no" | "unknown";
export type DataOrigin = "live" | "verified_import" | "synthetic_fixture";

export interface RawCollectedJobV1 {
  schema_version: "1.0";
  source_key: string;
  source_job_id: string | null;
  company_name: string;
  title: string;
  official_url: string;
  raw_text: string;
  raw_payload?: Record<string, unknown>;
  published_at: string | null;
  fetched_at: string;
  collector_version: string;
  hints: {
    role_family?: RoleFamily;
    locations?: string[];
    degree_raw?: string | null;
    experience_raw?: string | null;
    employment_type?: EmploymentType;
    skill_terms?: string[];
  };
}

export interface NormalizedJobV1 {
  schema_version: "1.0";
  normalizer_version: string;
  source_key: string;
  job_key: string;
  company_name: string;
  title: string;
  official_url: string;
  role_family: RoleFamily;
  locations: string[];
  degree: DegreeLevel;
  degree_raw: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  experience_raw: string | null;
  employment_type: EmploymentType;
  student_friendly: StudentFriendly;
  skills: string[];
  skill_evidence: Array<{ skill_id: string; evidence_text: string }>;
  published_at: string | null;
  fetched_at: string;
  collector_version: string;
  content_hash: string;
  raw_text: string;
  raw_payload?: Record<string, unknown>;
}

export interface MetricSpecV1 {
  metric_id:
    | "job_family_share"
    | "skill_demand_share"
    | "student_friendly_share"
    | "observed_new_jobs"
    | "policy_job_shared_themes";
  version: "1.0";
  label: string;
  definition: string;
  unit: "count" | "ratio" | "theme_list";
  numerator: string;
  denominator: string | null;
  window: string;
  dedupe: string;
  null_policy: string;
  evidence_type: "job" | "observation" | "policy" | "mixed";
  disclaimer: string;
}

export interface PolicyEvidenceRefV1 {
  policy_item_id: string;
  title: string;
  issuer: string;
  published_at: string;
  official_url: string;
  source_tier: string;
  theme_ids: string[];
  evidence_excerpt: string;
}