import { Form, Link } from "react-router";
import type { EmploymentType, JobFiltersV1, RoleFamily, StudentFriendly } from "@aihot/career-insights/contracts";
import type { DashboardView } from "../filters";
import { serializeJobFilters } from "../filters";
import { EMPLOYMENT_TYPE_LABELS, ROLE_FAMILY_LABELS, SKILL_LABELS, STUDENT_FRIENDLY_LABELS } from "../labels";

const ROLE_FAMILY_VALUES: readonly RoleFamily[] = ["ai_algorithm", "ai_application_development", "data", "ai_product_operations", "unknown"];
const EMPLOYMENT_TYPE_VALUES: readonly EmploymentType[] = ["campus", "internship", "experienced", "other", "unknown"];
const STUDENT_FRIENDLY_VALUES: readonly StudentFriendly[] = ["yes", "no", "unknown"];

const ROLE_FAMILY_OPTIONS = ROLE_FAMILY_VALUES.map((value) => ({ value, label: ROLE_FAMILY_LABELS[value] }));
const EMPLOYMENT_TYPE_OPTIONS = EMPLOYMENT_TYPE_VALUES.map((value) => ({ value, label: EMPLOYMENT_TYPE_LABELS[value] }));
const STUDENT_FRIENDLY_OPTIONS = STUDENT_FRIENDLY_VALUES.map((value) => ({ value, label: STUDENT_FRIENDLY_LABELS[value] }));

const FIELD_CLASS = "mt-1 h-9 w-full min-w-0 rounded-control border border-line bg-surface px-2 text-[13px] text-ink-2 focus:border-line-strong focus:outline-none";
const LABEL_CLASS = "block text-[12px] text-ink-4";

export function CareerFilters({ filters, view }: { filters: JobFiltersV1; view?: DashboardView }) {
  const directionRoleFamily = view === "direction" ? filters.role_family : undefined;
  const directionView = directionRoleFamily !== undefined;

  return (
    <section aria-labelledby="career-filters" className="rounded-card border border-line bg-surface p-4">
      <h2 id="career-filters" className="text-[16px] font-semibold text-ink">筛选职位</h2>
      <Form key={serializeJobFilters(filters)} method="get" action="/career-insights" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {directionView && <input type="hidden" name="view" value="direction" />}
        {directionView && <input type="hidden" name="role_family" value={filters.role_family ?? ""} />}
        <input type="hidden" name="page" value="1" />
        <input type="hidden" name="page_size" value={filters.page_size} />

        {directionView ? (
          <div className="text-[12px] text-ink-4 break-words">方向：{ROLE_FAMILY_LABELS[directionRoleFamily]}</div>
        ) : (
          <div>
            <label htmlFor="career-role-family" className={LABEL_CLASS}>方向</label>
            <select id="career-role-family" name="role_family" defaultValue={filters.role_family ?? ""} className={FIELD_CLASS}>
              <option value="">全部</option>
              {ROLE_FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="career-company" className={LABEL_CLASS}>公司</label>
          <input id="career-company" type="text" name="company" defaultValue={filters.company ?? ""} placeholder="公司全称" className={FIELD_CLASS} />
        </div>

        <div>
          <label htmlFor="career-city" className={LABEL_CLASS}>城市</label>
          <input id="career-city" type="text" name="city" defaultValue={filters.city ?? ""} placeholder="城市名" className={FIELD_CLASS} />
        </div>

        <div>
          <label htmlFor="career-employment-type" className={LABEL_CLASS}>用工类型</label>
          <select id="career-employment-type" name="employment_type" defaultValue={filters.employment_type ?? ""} className={FIELD_CLASS}>
            <option value="">全部</option>
            {EMPLOYMENT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="career-student-friendly" className={LABEL_CLASS}>学生友好</label>
          <select id="career-student-friendly" name="student_friendly" defaultValue={filters.student_friendly ?? ""} className={FIELD_CLASS}>
            <option value="">全部</option>
            {STUDENT_FRIENDLY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="career-skill" className={LABEL_CLASS}>技能</label>
          <input id="career-skill" type="text" name="skill" list="career-skill-options" defaultValue={filters.skill ?? ""} placeholder="技能标识，如 python" className={FIELD_CLASS} />
        </div>

        <datalist id="career-skill-options">
          {Object.entries(SKILL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </datalist>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button type="submit" className="h-9 w-full rounded-full bg-accent px-5 text-[13px] font-medium text-accent-contrast sm:w-auto">
            应用
          </button>
          <Link to="/career-insights" className="inline-flex h-9 w-full items-center justify-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2 sm:w-auto">
            清除
          </Link>
        </div>
      </Form>
    </section>
  );
}
