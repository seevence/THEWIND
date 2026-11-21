import type {
  CareerObservationBatchV1,
  IngestResultV1,
  JobDetailResponseV1,
  JobFiltersV1,
  JobListResponseV1,
  SummaryResponseV1,
} from "../contracts/api.ts";
import type {
  CareerBriefV1,
  CareerCatalogResponseV1,
  CareerDailyCommentResponseV1,
  CareerDailyResponseV1,
  CareerHotResponseV1,
  CareerSignalsResponseV1,
  JobAvailabilityResponseV1,
} from "../contracts/insights.ts";
import type { HotCompanyOptions } from "./career-analytics.ts";
import type { CareerCatalogOptions } from "./career-catalog.ts";
import type { CareerSignalsOptions } from "./career-signals.ts";
import type { PolicyFiltersV1, PolicyListResponseV1 } from "./policy-read.ts";

export interface CareerRepository {
  summary(): Promise<SummaryResponseV1>;
  listJobs(filters: JobFiltersV1): Promise<JobListResponseV1>;
  jobDetail(id: string): Promise<JobDetailResponseV1 | null>;
  /** 收藏页批量探测：每个 id 返回 visible/missing，未知 id 记 missing。 */
  jobAvailability(ids: string[]): Promise<JobAvailabilityResponseV1>;
  listPolicies(filters: PolicyFiltersV1): Promise<PolicyListResponseV1>;
  hotCompanies(options: HotCompanyOptions): Promise<CareerHotResponseV1>;
  dailySummary(): Promise<CareerDailyResponseV1>;
  careerSignals(options: CareerSignalsOptions): Promise<CareerSignalsResponseV1>;
  careerCatalog(options: CareerCatalogOptions): Promise<CareerCatalogResponseV1>;
  careerBrief(): Promise<CareerBriefV1 | null>;
  careerDailyComment(date: string): Promise<CareerDailyCommentResponseV1 | null>;
  writeBatch(batch: CareerObservationBatchV1): Promise<IngestResultV1>;
}