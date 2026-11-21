export const PAGES_FLAG = "--pages";
export const PAGE_LIMIT_MIN = 1;
export const PAGE_LIMIT_MAX = 10;
export const DEFAULT_PAGE_LIMIT = 1;

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const INTEGER_PATTERN = /^\d+$/;
const PAGES_PREFIX = `${PAGES_FLAG}=`;

/**
 * 解析 `--pages N` 与 `--pages=N` 两种写法。缺省返回 DEFAULT_PAGE_LIMIT（保持每源首屏的既有口径）；
 * 显式给出但取值非法时直接抛错，不做静默回退。
 */
export function parsePageLimit(argv: readonly string[]): number {
  const supplied = findPageLimitArgument(argv);
  if (supplied === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  return parsePageLimitValue(supplied);
}

/** 返回调用方给出的原始取值；`undefined` 表示没写 --pages，空串表示写了 `--pages=` 或 `--pages` 后无值。 */
function findPageLimitArgument(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === PAGES_FLAG) {
      const next = argv[index + 1];
      return next === undefined || next.startsWith("--") ? "" : next;
    }
    if (argument.startsWith(PAGES_PREFIX)) {
      return argument.slice(PAGES_PREFIX.length);
    }
  }
  return undefined;
}

function parsePageLimitValue(raw: string): number {
  if (raw === "") {
    throw new CliArgumentError(`${PAGES_FLAG} 需要 ${PAGE_LIMIT_MIN}..${PAGE_LIMIT_MAX} 的整数，但未提供取值`);
  }
  if (!INTEGER_PATTERN.test(raw)) {
    throw new CliArgumentError(`${PAGES_FLAG} 只接受整数，收到 "${raw}"`);
  }
  const value = Number(raw);
  if (value < PAGE_LIMIT_MIN || value > PAGE_LIMIT_MAX) {
    throw new CliArgumentError(`${PAGES_FLAG} 超出范围 ${PAGE_LIMIT_MIN}..${PAGE_LIMIT_MAX}，收到 "${raw}"`);
  }
  return value;
}