// A section the site is rebuilding: it says so plainly, keeps the way into the pages that do have
// content, and asks search engines to stay away while it holds nothing of its own.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { IconChevronRight } from "../icons";
import { Kicker } from "./Kicker";

/** One way on from the page: where it goes, what it is called, and one line about what is there. */
export interface PlaceholderEntry {
  to: string;
  label: string;
  note: string;
}

/**
 * The page shell for a section under rebuild: a kicker and heading, the reason it is empty, the ways on,
 * and an optional note under them. Pages pass whatever else they need as children.
 */
export function SectionPlaceholder({
  kicker,
  title,
  titleId,
  lead,
  entries = [],
  reportLinks,
  note,
  children,
}: {
  kicker: string;
  title: ReactNode;
  titleId?: string;
  lead: ReactNode;
  entries?: PlaceholderEntry[];
  /** The report entry row (日报/周报/月报/往期): one link each, the page it is on marked current. */
  reportLinks?: Array<{ to: string; label: string; current?: boolean }>;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 lg:pt-3">
      <div className="mx-auto max-w-[760px]">
        <header className="pt-4 lg:pt-0">
          <Kicker>{kicker}</Kicker>
          <h1
            id={titleId}
            data-page-title=""
            className="mt-4 text-[30px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[38px]"
          >
            {title}
          </h1>
          <p className="mt-4 text-[15.5px] leading-[1.9] text-ink-3">{lead}</p>
        </header>

        {reportLinks && (
          <nav aria-label="报告入口" className="mt-6 flex flex-wrap gap-2">
            {reportLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                viewTransition
                aria-current={link.current ? "page" : undefined}
                className={`rounded-full px-3.5 py-2.5 text-[13px] transition-colors sm:py-1.5 ${
                  link.current
                    ? "bg-accent-soft font-semibold text-accent"
                    : "border border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        )}

        {entries.length > 0 && (
          <section aria-label="可以去这里" className="mt-8">
            <ul className="grid gap-3 sm:grid-cols-3">
              {entries.map((entry) => (
                <li key={entry.to}>
                  <Link
                    to={entry.to}
                    viewTransition
                    className="group flex h-full items-start gap-2 rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-ink transition-colors group-hover:text-accent">{entry.label}</span>
                      <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-4">{entry.note}</span>
                    </span>
                    <IconChevronRight size={16} className="mt-1 shrink-0 text-ink-4" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {children}

        {note && <p className="mt-10 border-t border-line pt-4 text-[12.5px] leading-relaxed text-ink-4">{note}</p>}
      </div>
    </div>
  );
}
