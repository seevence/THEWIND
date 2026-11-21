export type CollectorFailureType =
  | "transport_security"
  | "access_blocked"
  | "config_error"
  | "timeout"
  | "schema_changed"
  | "parse_failed"
  | "empty_result";

export class CollectorError extends Error {
  readonly failureType: CollectorFailureType;
  readonly sourceKey: string | undefined;

  constructor(
    failureType: CollectorFailureType,
    message: string,
    sourceKey?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.failureType = failureType;
    this.sourceKey = sourceKey;
  }
}

export class RequestTimeoutError extends CollectorError {
  constructor(message = "单页请求超时", sourceKey?: string) {
    super("timeout", message, sourceKey);
  }
}

export class BudgetExhaustedError extends CollectorError {
  constructor(message = "单来源时间预算耗尽", sourceKey?: string) {
    super("timeout", message, sourceKey);
  }
}

export class AccessBlockedError extends CollectorError {
  readonly limitationType: string;

  constructor(limitationType: string, message: string, sourceKey?: string) {
    super("access_blocked", message, sourceKey);
    this.limitationType = limitationType;
  }
}

export class SchemeDowngradeError extends CollectorError {
  readonly limitationType = "scheme_downgrade";

  constructor(message: string, sourceKey?: string) {
    super("transport_security", message, sourceKey);
  }
}

export class SchemaChangedError extends CollectorError {
  constructor(message = "来源结构发生变化", sourceKey?: string) {
    super("schema_changed", message, sourceKey);
  }
}

export class ParseFailedError extends CollectorError {
  constructor(message = "单条记录解析失败", sourceKey?: string) {
    super("parse_failed", message, sourceKey);
  }
}

export class EmptyResultError extends CollectorError {
  constructor(message = "未产出任何记录", sourceKey?: string) {
    super("empty_result", message, sourceKey);
  }
}

export class ConfigError extends CollectorError {
  constructor(message = "采集配置校验失败", sourceKey?: string) {
    super("config_error", message, sourceKey);
  }
}

export class ReplaySampleMissingError extends CollectorError {
  constructor(message = "回放样本缺失", sourceKey?: string) {
    super("config_error", message, sourceKey);
  }
}

export class ReplayNetworkViolationError extends Error {
  constructor(message = "回放期间禁止访问真实网络") {
    super(message);
    this.name = "ReplayNetworkViolationError";
  }
}

export class SampleRejectedError extends Error {
  constructor(message = "样本被拒绝") {
    super(message);
    this.name = "SampleRejectedError";
  }
}

export const FAILURE_PRIORITY: readonly CollectorFailureType[] = [
  "config_error",
  "transport_security",
  "access_blocked",
  "timeout",
  "schema_changed",
  "parse_failed",
  "empty_result",
];

export function prioritizeFailure(
  failures: readonly CollectorFailureType[],
): CollectorFailureType | null {
  for (const candidate of FAILURE_PRIORITY) {
    if (failures.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}