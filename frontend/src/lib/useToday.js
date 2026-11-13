// Today's daily check-ins for one astronaut, live on the mission clock: the routine with each
// task's status, plus the summary the sidebar badge, the Overview card and the Today page use.
// The server's statuses are refreshed by useSchedule; between refreshes the clock moves tasks
// from upcoming to due to missed locally (lib/schedule.js), checked every 15 s.
import { useEffect, useMemo, useState } from "react";
import { useSchedule } from "./queries.js";
import { missionDaySeconds, todaySummary, withLiveStatus } from "./schedule.js";

export function useToday(astroId, { tickMs = 15000 } = {}) {
  const q = useSchedule(astroId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!astroId) return undefined;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [astroId, tickMs]);
  return useMemo(() => {
    const entries = q.data ? withLiveStatus(q.data.entries || [], missionDaySeconds(q.data, q.dataUpdatedAt, now)) : [];
    return { ...todaySummary(entries), entries, tracking: q.data?.tracking || {}, ready: !!q.data };
  }, [q.data, q.dataUpdatedAt, now]);
}
