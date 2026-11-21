import type {
  DegreeLevel,
  EmploymentType,
  NormalizedJobV1,
  RoleFamily,
  StudentFriendly,
} from "../contracts/index.ts";

export interface ValidationIssueV1 {
  path: string;
  message: string;
}

export type ValidationResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationIssueV1[] };

const ROLE_FAMILIES: readonly RoleFamily[] = [
  "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "unknown",
];
const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  "campus",
  "internship",
  "experienced",
  "other",
  "unknown",
];
const DEGREE_LEVELS: readonly DegreeLevel[] = [
  "any_explicit",
  "bachelor",
  "master",
  "doctor",
  "other",
  "unknown",
];
const STUDENT_FRIENDLY_VALUES: readonly StudentFriendly[] = ["yes", "no", "unknown"];
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const milliseconds = (match[7] ?? "").padEnd(3, "0");
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  return date.toISOString() === normalized;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function addIssue(errors: ValidationIssueV1[], path: string, message: string): void {
  errors.push({ path, message });
}

function validateEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  errors: ValidationIssueV1[],
): void {
  const value = input[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    addIssue(errors, key, `Expected one of: ${allowed.join(", ")}.`);
  }
}

export function validateNormalizedJobV1(value: unknown): ValidationResultV1<NormalizedJobV1> {
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: "", message: "Expected a normalized job object." }] };
  }

  const errors: ValidationIssueV1[] = [];

  if (value.schema_version !== "1.0") {
    addIssue(errors, "schema_version", 'Expected "1.0".');
  }

  for (const key of ["source_key", "job_key", "company_name", "title", "collector_version"]) {
    if (!isNonEmptyString(value[key])) {
      addIssue(errors, key, "Expected a non-empty string.");
    }
  }

  if (typeof value.raw_text !== "string") {
    addIssue(errors, "raw_text", "Expected a string.");
  }

  for (const key of ["degree_raw", "experience_raw", "published_at"]) {
    const field = value[key];
    if (field !== null && typeof field !== "string") {
      addIssue(errors, key, "Expected a string or null.");
    }
  }

  if (!isHttpUrl(value.official_url)) {
    addIssue(errors, "official_url", "Expected an absolute http/https URL.");
  }
  if (!isUtcTimestamp(value.fetched_at)) {
    addIssue(errors, "fetched_at", "Expected a valid UTC ISO 8601 timestamp ending in Z.");
  }
  if (typeof value.content_hash !== "string" || !CONTENT_HASH_PATTERN.test(value.content_hash)) {
    addIssue(errors, "content_hash", "Expected 64 lowercase hexadecimal characters.");
  }

  validateEnum(value, "role_family", ROLE_FAMILIES, errors);
  validateEnum(value, "degree", DEGREE_LEVELS, errors);
  validateEnum(value, "employment_type", EMPLOYMENT_TYPES, errors);
  validateEnum(value, "student_friendly", STUDENT_FRIENDLY_VALUES, errors);

  for (const key of ["experience_min_years", "experience_max_years"]) {
    const field = value[key];
    if (field !== null && (typeof field !== "number" || !Number.isInteger(field) || field < 0)) {
      addIssue(errors, key, "Expected a non-negative integer or null.");
    }
  }
  if (
    typeof value.experience_min_years === "number" &&
    typeof value.experience_max_years === "number" &&
    value.experience_min_years > value.experience_max_years
  ) {
    addIssue(errors, "experience_max_years", "Expected experience_max_years to be at least experience_min_years.");
  }

  if (value.raw_payload !== undefined && !isRecord(value.raw_payload)) {
    addIssue(errors, "raw_payload", "Expected an object when provided.");
  }

  if (!Array.isArray(value.locations)) {
    addIssue(errors, "locations", "Expected an array of non-empty strings.");
  } else {
    value.locations.forEach((location, index) => {
      if (!isNonEmptyString(location)) {
        addIssue(errors, `locations[${index}]`, "Expected a non-empty string.");
      }
    });
  }

  const skillIds = new Set<string>();
  if (!Array.isArray(value.skills)) {
    addIssue(errors, "skills", "Expected an array of non-empty skill IDs.");
  } else {
    value.skills.forEach((skillId, index) => {
      if (!isNonEmptyString(skillId)) {
        addIssue(errors, `skills[${index}]`, "Expected a non-empty skill ID.");
      } else if (skillIds.has(skillId)) {
        addIssue(errors, `skills[${index}]`, `Duplicate skill ID "${skillId}".`);
      } else {
        skillIds.add(skillId);
      }
    });
  }

  const evidenceSkillIds = new Set<string>();
  if (!Array.isArray(value.skill_evidence)) {
    addIssue(errors, "skill_evidence", "Expected an array of skill evidence objects.");
  } else {
    value.skill_evidence.forEach((evidence, index) => {
      if (!isRecord(evidence)) {
        addIssue(errors, `skill_evidence[${index}]`, "Expected a skill evidence object.");
        return;
      }
      if (!isNonEmptyString(evidence.skill_id)) {
        addIssue(errors, `skill_evidence[${index}].skill_id`, "Expected a non-empty skill ID.");
      } else {
        evidenceSkillIds.add(evidence.skill_id);
        if (Array.isArray(value.skills) && !skillIds.has(evidence.skill_id)) {
          addIssue(
            errors,
            `skill_evidence[${index}].skill_id`,
            `Skill ID "${evidence.skill_id}" is not present in skills.`,
          );
        }
      }
      if (!isNonEmptyString(evidence.evidence_text)) {
        addIssue(errors, `skill_evidence[${index}].evidence_text`, "Expected non-empty evidence text.");
      }
    });
  }

  if (Array.isArray(value.skills) && Array.isArray(value.skill_evidence)) {
    skillIds.forEach((skillId) => {
      if (!evidenceSkillIds.has(skillId)) {
        addIssue(errors, "skill_evidence", `Missing evidence for skill ID "${skillId}".`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as unknown as NormalizedJobV1 };
}