import { createElement, type ReactElement } from "react";

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "short",
});

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
});

export function formatCareerDateTime(value: string): string | null {
  if (!ISO_UTC_PATTERN.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // 日期越界按 JS Date 自然顺延（闰年 2 月 29 天、平年 28 天），与可见文本保持一致
  return dateTimeFormatter.format(date);
}

/** 政策发布日期是纯日期，按北京时间当天解释，与 CareerTime 的日期口径一致。 */
export function formatCareerDate(value: string): string | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  return dateFormatter.format(date);
}

export function CareerDate({ value, className }: { value: string; className?: string }): ReactElement {
  const formatted = formatCareerDate(value);
  if (formatted === null) return createElement("span", { className }, value);
  return createElement("time", { dateTime: value, className }, formatted);
}

export function CareerTime({ value, className }: { value: string; className?: string }): ReactElement {
  const formatted = formatCareerDateTime(value);
  if (formatted === null) return createElement("span", { className }, value);
  return createElement("time", { dateTime: new Date(value).toISOString(), className }, formatted);
}
