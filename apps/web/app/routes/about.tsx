import { Fragment, useMemo, useState, type ReactNode } from "react";
import { IntentLink } from "../components/ui/IntentLink";
import { Link, useLoaderData } from "react-router";
import type { SiteContact } from "@aihot/contracts/site";
import type { CareerDailyResponseV1, SummaryResponseV1 } from "@aihot/career-insights/contracts";
import { ABOUT, POLICY, SEO_TITLES, SITE, subjectAfter } from "@aihot/site";
import { apiGet, cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { organizationLd, pageMeta } from "../lib/seo";
import { Kicker } from "../components/ui/Kicker";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";
import { SignalRiver, type RiverSource } from "../features/about/SignalRiver";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: "关于" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

/** The career data the figures come from: the latest daily and the summary behind 职业洞察. */
export async function loader({ request }: { request: Request }) {
  const [contact, summary, daily] = await Promise.all([
    apiGet<SiteContact>("/api/site/contact", { signal: request.signal }).catch(() => null),
    apiGet<SummaryResponseV1>("/api/site/career-insights/summary", { signal: request.signal }).catch(() => null),
    apiGet<CareerDailyResponseV1>("/api/site/career-insights/daily", { signal: request.signal }).catch(() => null),
  ]);
  return cachedPage(300, { contact, summary, daily });
}

export function meta() {
  return pageMeta({ title: SEO_TITLES.about, rawTitle: true, description: ABOUT.description, path: "/about", image: "/og/pages/about.png", jsonLd: organizationLd() });
}

/** The river only illustrates; the page's own sources list is not rendered as lines. */
const NO_SOURCES: RiverSource[] = [];

/** 3.6 万 from ten thousand up, digits with separators below. */
function figure(n: number): { value: string; unit: string } {
  return n >= 10_000 ? { value: (n / 10_000).toFixed(1).replace(/\.0$/, ""), unit: "万" } : { value: n.toLocaleString("en-US"), unit: "" };
}

function Figure({ n, unit }: { n: number; unit: string }) {
  const f = figure(n);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="num text-[30px] font-black leading-none tracking-[-0.03em] text-ink xl:text-[36px]">{f.value}</span>
      <span className="text-[13px] text-ink-3">
        {f.unit}
        {unit}
      </span>
    </div>
  );
}

/** What a figure reads while the api has not answered: no made-up number. */
function Unavailable() {
  return <span className="text-[15px] font-semibold text-ink-4">数据更新中</span>;
}

/**
 * The stage columns' rules: one column on phones, two by two from sm, and from lg four in a row whose
 * edges fall on the river's stage boundaries.
 */
const STAGE_CELL = [
  "sm:pr-6 lg:pr-6",
  "border-t sm:border-l sm:border-t-0 sm:pl-6 lg:px-6",
  "border-t sm:pr-6 lg:border-l lg:border-t-0 lg:px-6",
  "border-t sm:border-l sm:pl-6 lg:border-t-0 lg:px-6",
];

interface Stage {
  no: string;
  title: string;
  figure: ReactNode;
  text: string;
  note: ReactNode;
}

/** How many days the data has been observed: the span the summary covers, counted inclusively. */
function observedDays(summary: SummaryResponseV1 | null): number | null {
  if (!summary) return null;
  const first = Date.parse(summary.first_observed_at);
  const last = Date.parse(summary.last_observed_at);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
  return Math.max(1, Math.round((last - first) / 86_400_000) + 1);
}

interface Figures {
  sources: number | null;
  jobs: number | null;
  policies: number | null;
  observedDays: number | null;
  newJobs: number | null;
  newPolicies: number | null;
  dailyDate: string | null;
}

/** The employment figures the page shows; null wherever the api has no data, so the page says so. */
function figuresOf(summary: SummaryResponseV1 | null, daily: CareerDailyResponseV1 | null): Figures {
  return {
    sources: daily?.sources.length ?? summary?.source_count ?? null,
    jobs: daily?.jobs_total ?? summary?.sample_size ?? null,
    policies: daily?.policies_total ?? null,
    observedDays: observedDays(summary),
    newJobs: daily?.new_jobs_today ?? null,
    newPolicies: daily?.new_policies_today ?? null,
    dailyDate: daily?.date ?? null,
  };
}

function stagesOf(figures: Figures): Stage[] {
  const { sources, jobs, policies, observedDays, newJobs, newPolicies, dailyDate } = figures;
  return [
    {
      no: "01",
      title: "采集",
      figure: sources === null ? <Unavailable /> : <Figure n={sources} unit="个来源" />,
      text: ABOUT.steps.collect,
      note: null,
    },
    {
      no: "02",
      title: "收录",
      figure: jobs === null ? <Unavailable /> : <Figure n={jobs} unit="个岗位" />,
      text: ABOUT.steps.store,
      note: newJobs === null ? null : `今日新增 ${newJobs.toLocaleString("en-US")} 个岗位`,
    },
    {
      no: "03",
      title: "政策",
      figure: policies === null ? <Unavailable /> : <Figure n={policies} unit="条政策" />,
      text: ABOUT.steps.select,
      note: newPolicies === null ? null : `今日新增 ${newPolicies.toLocaleString("en-US")} 条政策`,
    },
    {
      no: "04",
      title: "更新",
      figure: observedDays === null ? <Unavailable /> : <Figure n={observedDays} unit="天持续观测" />,
      text: ABOUT.steps.publish,
      note: dailyDate ? `最新就业日报 ${dailyDate}` : "最新就业日报：数据更新中",
    },
  ];
}

/** The maker's round avatar before the greeting; it steps aside if the image fails. */
function MakerFace({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt={`${ABOUT.maker?.name ?? ""}的头像`} width={48} height={48} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-full bg-bg-sunk object-cover ring-1 ring-line xl:size-12" />;
}

function QrCard({ src, kind, title, note }: { src: string; kind: string; title: string; note: string }) {
  return (
    <figure className="card flex items-center gap-5 p-5">
      <img src={src} alt={`${kind}二维码`} width={112} height={112} loading="lazy" className="size-[104px] shrink-0 rounded-tile border border-line bg-white object-contain p-1.5 sm:size-[112px]" />
      <figcaption className="min-w-0">
        <div className="text-[12px] text-ink-4">{kind}</div>
        <div className="mt-1 text-[16px] font-semibold leading-snug text-ink">{title}</div>
        <p className="mt-2 text-[13px] leading-[1.7] text-ink-3">{note}</p>
      </figcaption>
    </figure>
  );
}

/**
 * The optional maker block (ABOUT.maker): a greeting on the left, the contact codes that are set on the
 * right. Without the contact settings (the api did not answer) the codes stay out, as the figures do.
 */
function Maker({ maker, contact }: { maker: NonNullable<typeof ABOUT.maker>; contact: SiteContact | null }) {
  const codes = [
    contact?.wechatQr && maker.wechat ? <QrCard key="wechat" src={contact.wechatQr} kind={maker.wechat.kind} title={maker.wechat.title} note={maker.wechat.note} /> : null,
    contact?.feishuQr && maker.feishu ? <QrCard key="feishu" src={contact.feishuQr} kind={maker.feishu.kind} title={maker.feishu.title} note={maker.feishu.note} /> : null,
  ].filter(Boolean);
  return (
    <section aria-labelledby="maker" className="mt-20 grid gap-10 xl:mt-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div>
        <Kicker>做这个站的人</Kicker>
        <h2 id="maker" className="mt-4 flex items-center gap-3.5 text-[26px] font-black leading-[1.3] tracking-[-0.02em] text-ink xl:gap-4 xl:text-[34px]">
          {contact?.makerAvatar && <MakerFace src={contact.makerAvatar} />}
          <span>
            嗨，我是 <span className="whitespace-nowrap text-accent">{maker.name}</span>
          </span>
        </h2>
        <div className="mt-5 space-y-4 text-[15.5px] leading-[1.9] text-ink-2 xl:text-[16.5px]">
          {maker.greeting.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="text-ink-3">
            它一直在改，改了什么都写在
            <Link viewTransition to="/changelog" className="text-accent hover:underline">
              更新日志
            </Link>
            里；有想法、遇到问题，去
            <Link viewTransition to="/feedback" className="text-accent hover:underline">
              反馈页
            </Link>
            告诉我。
          </p>
        </div>
      </div>
      {codes.length > 0 && (
        <div className="grid content-start gap-3">
          <h3 className="text-[15px] font-semibold text-ink">如果觉得有点用，欢迎加入</h3>
          {codes}
        </div>
      )}
    </section>
  );
}

export default function AboutPage() {
  const { contact, summary, daily } = useLoaderData<typeof loader>();
  const [focus, setFocus] = useState<number | null>(null);
  const sources = useMemo(() => daily?.sources.length ?? summary?.source_count ?? null, [daily, summary]);
  const stages = useMemo(() => stagesOf(figuresOf(summary, daily)), [summary, daily]);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 lg:pt-3">
      <PhoneBar back={{ to: "/more", label: "我的" }} title={`关于 ${SITE.name}`} />
      <header className="grid items-end gap-8 pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:pt-0">
        <div>
          <Kicker>{ABOUT.kicker}</Kicker>
          <h1 data-page-title="" className="mt-5 text-[34px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[46px] xl:text-[56px] 2xl:text-[64px]">
            {ABOUT.headline[0]}
            <br />
            <span className="text-accent">{ABOUT.headline[1]}</span>
          </h1>
          <p className="mt-5 max-w-[36em] text-[15.5px] leading-[1.85] text-ink-3 xl:text-[17px]">
            {ABOUT.lead.split("{sources}").map((part, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <>
                    {" "}
                    <span className="num font-semibold text-ink">{sources ?? ABOUT.sourcesFallback}</span>{" "}
                  </>
                )}
                {part}
              </Fragment>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <IntentLink to="/" className={buttonClass("primary", "lg")}>
            看今天的就业概览 <IconArrowRight size={15} />
          </IntentLink>
          <IntentLink to="/daily" className={buttonClass("secondary", "lg")}>
            读最新日报
          </IntentLink>
        </div>
      </header>

      <section aria-labelledby="how" className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {`${SITE.name} 怎么工作`}
        </h2>
        <SignalRiver sources={NO_SOURCES} focus={focus} className="h-[230px] sm:h-[300px] lg:h-[360px] 2xl:h-[420px]" />
        <p className="sr-only">{`示意图：每条线是一个采集来源；同一岗位或政策的多次观测归到一起，经过归一与筛选，汇入每天的就业日报。`}</p>
        <ol className="mt-4 grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
          {stages.map((s, i) => (
            <li
              key={s.no}
              tabIndex={0}
              onPointerEnter={() => setFocus(i)}
              onPointerLeave={() => setFocus(null)}
              onFocus={() => setFocus(i)}
              onBlur={() => setFocus(null)}
              className={`border-line py-6 outline-none transition-colors ${STAGE_CELL[i]} ${focus === i ? "bg-accent-softer" : ""}`}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[12px] font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-[17px] font-bold text-ink">{s.title}</h3>
              </div>
              {s.figure && <div className="mt-4">{s.figure}</div>}
              <p className="mt-3 text-[14px] leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-[12px] text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      {ABOUT.maker && <Maker maker={ABOUT.maker} contact={contact} />}

      <p className="mt-16 well rounded-card px-5 py-4 text-[13px] leading-[1.85] text-ink-3">
        {ABOUT.copyright[0]}
        <Link viewTransition to="/feedback" className="text-accent hover:underline">
          反馈页
        </Link>
        {ABOUT.copyright[1]}
      </p>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12.5px] text-ink-4">
        <span>{SITE.footerNote}</span>
        <nav className="flex gap-5" aria-label="规则与隐私">
          <Link
            viewTransition
            id={ABOUT.termsAnchor ?? undefined}
            to="/terms"
            className="transition-colors hover:text-accent"
          >
            {POLICY.terms.name}
          </Link>
          <Link viewTransition to="/privacy" className="transition-colors hover:text-accent">
            隐私说明
          </Link>
        </nav>
      </footer>
    </div>
  );
}
