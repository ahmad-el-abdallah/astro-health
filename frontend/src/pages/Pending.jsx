// Placeholder for a page that hasn't been ported to React yet. Every feature stays
// reachable during the migration: this links to the same tab in the old app (/legacy),
// which is deleted once the last page is ported.
import { Card } from "../components/ui/index.jsx";
import { Icon } from "../components/ui/Icon.jsx";

export function Pending({ legacyTab, title }) {
  return (
    <Card className="flex flex-wrap items-center gap-4">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
        <Icon name="schedule" size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 font-display text-lg font-semibold">{title} is being rebuilt</h2>
        <p className="m-0 text-sm text-muted">This page moves to the new design in an upcoming step. Until then, it works in the classic view.</p>
      </div>
      <a
        href={`/legacy#${legacyTab}`}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-strong bg-control px-4 text-sm font-semibold text-ink hover:border-accent-text/60"
      >
        Open in classic view <Icon name="arrow-right" size={16} />
      </a>
    </Card>
  );
}
