// Crew-wide status board (/status-board) -- a read-only kiosk view meant for a shared
// display on the station, not a personal dashboard. Outside the normal login gate
// entirely (same idea as /admin, see App.jsx), reusing GET /api/status-board, which is
// itself deliberately unauthenticated but aggregate-only: counts, never a name or an
// individual's own reading -- the whole reason this page can exist without a login at
// all is that the backend already enforces it can't leak anyone's private data.
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api.js";
import { LEVEL_WORD } from "../lib/levels.js";
import { SpaceBackdrop } from "../components/layout/SpaceBackdrop.jsx";
import { Card, Progress, AnimatedNumber } from "../components/ui/index.jsx";
import LogoCrew from "../assets/brand/logo-mark-crew.svg?react";

const LEVEL_ORDER = ["RED", "YELLOW", "GREEN", "GRAY"];
const LEVEL_TEXT_CLASS = { GREEN: "text-good-fg", YELLOW: "text-check-fg", RED: "text-alert-fg", GRAY: "text-muted" };

const hhmm = (s) => {
  const t = ((Math.floor(s / 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function useStatusBoard() {
  return useQuery({
    queryKey: ["status-board"],
    queryFn: () => get("/status-board"),
    refetchInterval: 5000, // a shared screen with nobody at the keyboard to refresh it
  });
}

export default function StatusBoard() {
  const { data, isLoading } = useStatusBoard();

  return (
    <div className="min-h-screen px-10 py-10 text-ink" data-role="crew">
      <SpaceBackdrop />
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <LogoCrew width={40} height={40} aria-hidden="true" />
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-accent-text">Astro Health Station</div>
              <h1 className="font-display text-3xl font-bold">Station status</h1>
            </div>
          </div>
          {data && (
            <div className="text-right">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">Mission day {data.day}</div>
              <div className="font-display text-4xl font-bold tabular-nums">{hhmm(data.day_seconds)}</div>
              <div className="text-sm text-muted">{data.mission.label}</div>
            </div>
          )}
        </header>

        {isLoading && <Card className="p-8 text-center text-muted">Loading station status…</Card>}

        {data && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Card className="p-6">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted">Crew aboard</div>
                <AnimatedNumber value={data.crew_count} className="font-display text-5xl font-bold" />
              </Card>
              {LEVEL_ORDER.map((lvl) => (
                <Card key={lvl} className="p-6">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted">{LEVEL_WORD[lvl]}</div>
                  <AnimatedNumber
                    value={data.levels[lvl] ?? 0}
                    className={`block font-display text-5xl font-bold ${LEVEL_TEXT_CLASS[lvl]}`}
                  />
                </Card>
              ))}
            </div>

            <Card className="p-6">
              <div className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted">
                Today's routine — crew on track
              </div>
              <div className="flex flex-col gap-4">
                {data.tasks.map((t) => (
                  <div key={`${t.time}-${t.text}`} className="flex items-center gap-4">
                    <div className="w-14 shrink-0 font-display text-sm font-bold tabular-nums text-muted">{t.time}</div>
                    <div className="w-48 shrink-0 truncate text-sm">{t.text}</div>
                    <Progress value={t.total ? t.done / t.total : 0} className="flex-1" />
                    <div className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-muted">
                      {t.done}/{t.total}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
