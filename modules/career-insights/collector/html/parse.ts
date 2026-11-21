import * as cheerio from "cheerio";

/**
 * 受限 HTML 解析端口：只暴露采集需要的读操作，不把 cheerio 类型泄漏到适配器与契约层。
 * 依赖说明：cheerio 1.2.0 由 packages/backend 声明并经 workspace hoist 可用；
 * modules/career-insights/package.json 的显式声明需由角色A 补，本目录未修改该文件。
 */
export interface HtmlEntry {
  /** 容器内首个链接的文本（折叠空白）。 */
  readonly text: string;
  /** 容器内首个链接的绝对地址。 */
  readonly href: string;
  /** 容器整项文本（折叠空白），用于同项内的日期等附属信息。 */
  readonly fullText: string;
}

export interface HtmlDocument {
  /** 原文文本（仅去除首尾空白），用于 raw_text 保真。 */
  text(selector: string): string | null;
  /** 折叠连续空白的展示文本，用于标题/机关名等短字段。 */
  normalizedText(selector: string): string | null;
  /** 选择器命中的全部文本，保持文档顺序。 */
  texts(selector: string): string[];
  /** 选择器首个命中的属性值。 */
  attr(selector: string, name: string): string | null;
  /** 选择器命中的链接，按 baseUrl 绝对化，仅保留 http(s)。 */
  hrefs(selector: string): string[];
  /** 选择器首个命中的内部 HTML（未改写原文）。 */
  html(selector: string): string | null;
  /** 列表容器逐项解析；无链接的项被跳过。 */
  entries(containerSelector: string): HtmlEntry[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimOnly(value: string): string {
  return value.replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, "");
}

export function loadHtmlDocument(html: string, baseUrl: string): HtmlDocument {
  const $ = cheerio.load(html, null, false);

  const text = (selector: string): string | null => {
    const node = $(selector).first();
    if (node.length === 0) return null;
    const value = trimOnly(node.text());
    return value.length > 0 ? value : null;
  };

  return {
    text,
    normalizedText(selector) {
      const value = text(selector);
      return value === null ? null : collapseWhitespace(value);
    },
    texts(selector) {
      return $(selector)
        .toArray()
        .map((node) => trimOnly($(node).text()))
        .filter((value) => value.length > 0);
    },
    attr(selector, name) {
      const value = $(selector).first().attr(name);
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    hrefs(selector) {
      const out: string[] = [];
      $(selector).each((_index, node) => {
        const href = $(node).attr("href");
        if (typeof href !== "string" || href.length === 0) return;
        try {
          const absolute = new URL(href, baseUrl);
          if (absolute.protocol === "http:" || absolute.protocol === "https:") {
            out.push(absolute.toString());
          }
        } catch {
          // 相对基准无法解析的链接按缺失处理，不编造地址
        }
      });
      return out;
    },
    html(selector) {
      const node = $(selector).first();
      return node.length === 0 ? null : (node.html() ?? "");
    },
    entries(containerSelector) {
      const out: HtmlEntry[] = [];
      $(containerSelector).each((_index, node) => {
        const link = $(node).find("a[href]").first();
        const text = collapseWhitespace(link.text());
        const href = link.attr("href");
        if (text.length === 0 || typeof href !== "string" || href.length === 0) return;
        try {
          const absolute = new URL(href, baseUrl);
          if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return;
          out.push({
            text,
            href: absolute.toString(),
            fullText: collapseWhitespace($(node).text()),
          });
        } catch {
          // 无法绝对化的链接按缺失处理
        }
      });
      return out;
    },
  };
}