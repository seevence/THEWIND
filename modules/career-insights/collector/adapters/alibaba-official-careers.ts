import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type { CareerSourceAdapter } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ConfigError, SchemaChangedError } from "../fetch/errors.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";

const SOURCE_KEY = "alibaba-official-careers";
const PAGE_TIMEOUT_MS = 20_000;

/**
 * 阿里官方招聘采集适配器骨架。
 * 真实列表/详情结构需先完成试抓与字段映射；此前 collect() 只验证传输注入与取消透传，
 * 解析未实现时抛 SchemaChangedError，避免把空页面或占位记录当作成功。
 */
export function createAlibabaOfficialCareersAdapter(transport: FetchTransport): CareerSourceAdapter {
  const definition = CAREER_SOURCE_DEFINITIONS.find((item) => item.source_key === SOURCE_KEY);
  if (definition === undefined) {
    throw new ConfigError(`来源 ${SOURCE_KEY} 未在 CAREER_SOURCE_DEFINITIONS 中登记`);
  }

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<RawCollectedJobV1[]> {
      const request: PageRequest = {
        url: definition.entry_url,
        method: "GET",
        headers: { accept: "text/html" },
        pageTimeoutMs: PAGE_TIMEOUT_MS,
        sourceKey: SOURCE_KEY,
        ...(signal === undefined ? {} : { signal }),
      };
      const response = await transport.fetchPage(request);
      throw new SchemaChangedError(
        `来源 ${SOURCE_KEY} 尚未完成真实页面结构映射（试抓未执行，HTTP ${response.status} 页面未解析）`,
        SOURCE_KEY,
      );
    },
  };
}