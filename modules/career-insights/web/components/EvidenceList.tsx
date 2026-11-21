import { Link } from "react-router";
import type { EvidenceLinkV1 } from "@aihot/career-insights/contracts";

export function EvidenceList({ evidence }: { evidence: EvidenceLinkV1[] }) {
  if (evidence.length === 0) return null;

  return (
    <ul className="mt-3 space-y-2">
      {evidence.map((ev) => (
        <li key={`${ev.kind}:${ev.id}`} className="rounded-card border border-line bg-bg-sunk px-3 py-2">
          {ev.kind === "job" ? (
            <Link to={`/career-insights/jobs/${encodeURIComponent(ev.id)}`} className="text-[13px] text-accent hover:underline">
              {ev.title}
            </Link>
          ) : (
            <a
              href={ev.official_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-accent hover:underline"
            >
              {ev.title}
            </a>
          )}
          <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-4">{ev.kind}</div>
        </li>
      ))}
    </ul>
  );
}