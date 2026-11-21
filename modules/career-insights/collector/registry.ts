import type { FetchTransport } from "./fetch/transport.ts";
import { ConfigError } from "./fetch/errors.ts";
import type { CareerSourceAdapter } from "./index.ts";
import {
  createGovPolicySourceAdapter,
  createMoePolicySourceAdapter,
  createNdrcPolicySourceAdapter,
} from "./adapters/policy-sources.ts";
import type { PolicySourceAdapter } from "./adapters/policy-sources.ts";
import { createChangshaRsjPolicyAdapter } from "./adapters/changsha-rsj-policy.ts";
import { createHunanJytPolicyAdapter } from "./adapters/hunan-jyt-policy.ts";
import { createBaiduOfficialCareersAdapter } from "./adapters/baidu-official-careers.ts";
import { createCscecOfficialCareersAdapter } from "./adapters/cscec-official-careers.ts";
import { createDidiOfficialCareersAdapter } from "./adapters/didi-official-careers.ts";
import { createHonorOfficialCareersAdapter } from "./adapters/honor-official-careers.ts";
import { createHuaweiOfficialCareersAdapter } from "./adapters/huawei-official-careers.ts";
import { createNetEaseOfficialCareersAdapter } from "./adapters/netease-official-careers.ts";
import { createMeituanOfficialCareersAdapter } from "./adapters/meituan-official-careers.ts";
import { createMohrssPolicyAdapter } from "./adapters/mohrss-policy.ts";
import { createTencentOfficialCareersAdapter } from "./adapters/tencent-official-careers.ts";
import { CAREER_SOURCE_DEFINITIONS } from "./sources.ts";

export interface CareerAdapterSet {
  readonly jobs: readonly CareerSourceAdapter[];
  readonly policies: readonly PolicySourceAdapter[];
}

/**
 * 只为 definition.enabled 为 true 的来源构造适配器。
 * job 与 policy 分属两张表：job 产出 RawCollectedJobV1[]，policy 产出 PolicyEvidenceRefV1[]，
 * 两者不得混入同一个注册表或同一个 runner。
 */
export function createCareerAdapters(transport: FetchTransport): CareerAdapterSet {
  const jobs: CareerSourceAdapter[] = [];
  const policies: PolicySourceAdapter[] = [];
  for (const definition of CAREER_SOURCE_DEFINITIONS) {
    if (!definition.enabled) {
      continue;
    }
    switch (definition.source_key) {
      case "tencent-official-careers":
        jobs.push(createTencentOfficialCareersAdapter(transport));
        break;
      case "meituan-official-careers":
        jobs.push(createMeituanOfficialCareersAdapter(transport));
        break;
      case "baidu-official-careers":
        jobs.push(createBaiduOfficialCareersAdapter(transport));
        break;
      case "huawei-official-careers":
        jobs.push(createHuaweiOfficialCareersAdapter(transport));
        break;
      case "netease-official-careers":
        jobs.push(createNetEaseOfficialCareersAdapter(transport));
        break;
      case "didi-official-careers":
        jobs.push(createDidiOfficialCareersAdapter(transport));
        break;
      case "honor-official-careers":
        jobs.push(createHonorOfficialCareersAdapter(transport));
        break;
      case "cscec-official-careers":
        jobs.push(createCscecOfficialCareersAdapter(transport));
        break;
      case "ndrc-policy":
        policies.push(createNdrcPolicySourceAdapter(transport));
        break;
      case "moe-policy":
        policies.push(createMoePolicySourceAdapter(transport));
        break;
      case "state-council-policy":
        policies.push(createGovPolicySourceAdapter(transport));
        break;
      case "mohrss-policy":
        policies.push(createMohrssPolicyAdapter(transport));
        break;
      case "changsha-rsj-policy":
        policies.push(createChangshaRsjPolicyAdapter(transport));
        break;
      case "hunan-jyt-policy":
        policies.push(createHunanJytPolicyAdapter(transport));
        break;
      default:
        throw new ConfigError(`来源 ${definition.source_key} 已启用但没有对应适配器实现`);
    }
  }
  return { jobs, policies };
}