// One astronaut's history for one indicator, drawn as the banded line chart. Used on
// Overview (compact) and the full Trends page. Bands come from config/health_rules.json.
import { useMemo } from "react";
import { useHealthRules, useHistory } from "../lib/queries.js";
import { bandsFor } from "../lib/levels.js";
import { INDICATORS, numericValue } from "../lib/format.js";
import { BandLegend, LineChart } from "./charts/LineChart.jsx";

export const TREND_INDICATORS = Object.keys(INDICATORS);

export function useTrendSeries(astroId, indicator, days) {
  const history = useHistory(astroId, indicator, days);
  const rules = useHealthRules();
  return useMemo(() => {
    const rows = history.data || [];
    const points = rows
      .map((r) => ({ t: new Date(r.ts), y: numericValue(indicator, r.value), level: r.level }))
      .filter((p) => Number.isFinite(p.y));
    const secondary = indicator === "blood_pressure"
      ? rows.map((r) => ({ t: new Date(r.ts), y: r.value?.diastolic, level: r.level })).filter((p) => Number.isFinite(p.y))
      : null;
    return { points, secondary, bands: bandsFor(rules.data, indicator), loading: history.isLoading, rows };
  }, [history.data, history.isLoading, rules.data, indicator]);
}

const UNIT = { heart_rate: "bpm", blood_pressure: "mmHg", blood_sugar: "mg/dL", temperature: "°C", oxygen_saturation: "%", sleep: "h", exercise: "min", water: "ml", reaction_time: "ms" };

export function TrendChart({ astroId, indicator, days, height = 300 }) {
  const { points, secondary, bands } = useTrendSeries(astroId, indicator, days);
  const label = INDICATORS[indicator]?.label || indicator;
  const latest = points[points.length - 1];
  return (
    <div className="flex flex-col gap-3">
      <LineChart
        points={points}
        secondary={secondary}
        bands={bands}
        height={height}
        unit={UNIT[indicator] || ""}
        seriesKey={`${astroId}-${indicator}-${days}`}
        startLabel={`${days} days ago`}
        formatValue={(v) => (indicator === "temperature" || indicator === "sleep" ? v.toFixed(1) : `${Math.round(v)}`)}
        ariaLabel={
          latest
            ? `${label} over the last ${days} days, ${points.length} readings, latest ${Math.round(latest.y * 10) / 10}`
            : `${label}: no readings in the last ${days} days`
        }
      />
      <div className="flex items-center justify-center">
        <BandLegend bands={bands} unit={indicator === "sleep" ? "h" : ""} />
      </div>
    </div>
  );
}
