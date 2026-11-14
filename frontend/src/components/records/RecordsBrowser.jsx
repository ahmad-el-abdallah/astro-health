// Crew records (backend/logic/records.py): everything the astronauts logged, filtered by crew
// member, dates, kind of data, level and text, with a one-row-per-day summary, a table per
// section, and "Export to Excel" (backend/services/excel_export.py) of exactly what's
// filtered. Used by the flight surgeon (/doctor/records) and the superuser (/admin). The
// filters live in the URL (lib/records.js), so a view can be reloaded or shared.
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../lib/api.js";
import { apiQuery, CATEGORIES, downloadExcel, LEVELS, parseQuery, PRESETS, toQuery } from "../../lib/records.js";
import { Button, Card, CardTitle, Segmented, Shimmer, StatusChip, cx } from "../ui/index.jsx";
import { Icon } from "../ui/Icon.jsx";

const LEVEL_WORD = { GREEN: "Good", YELLOW: "Check", RED: "Alert", GRAY: "No data" };

function fmtCell(v, kind) {
  if (v === null || v === undefined || v === "") return <span className="text-subtle">–</span>;
  if (kind === "level") return <StatusChip level={v} text={LEVEL_WORD[v] || v} />;
  if (kind === "datetime") {
    const d = new Date(v);
    return <span className="ah-num whitespace-nowrap">{d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>;
  }
  if (kind === "date") return <span className="ah-num whitespace-nowrap">{v}</span>;
  if (kind === "number") return <span className="ah-num">{Number.isInteger(v) ? v : Number(v).toFixed(1)}</span>;
  if (kind === "long") return <span className="line-clamp-2 min-w-[14rem]" title={String(v)}>{String(v)}</span>;
  return <span className="whitespace-nowrap">{String(v)}</span>;
}

function Table({ columns, rows, empty }) {
  if (!rows.length) return <p className="m-0 py-6 text-center text-body text-muted">{empty}</p>;
  return (
    <div className="max-h-[480px] overflow-auto rounded-[var(--radius-inner)] border border-line">
      <table className="w-full border-collapse text-label">
        <thead className="sticky top-0 z-[1] bg-surface">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="border-b border-line px-3 py-2 text-left text-caption font-semibold whitespace-nowrap text-muted uppercase">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top odd:bg-raised/40">
              {columns.map((c) => <td key={c.key} className="border-b border-line/50 px-3 py-2 text-ink-2">{fmtCell(r[c.key], c.kind)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx("min-h-9 cursor-pointer rounded-full border px-3 text-label font-semibold transition-colors",
        on ? "border-accent bg-accent-soft text-accent-text" : "border-line bg-raised text-ink-2 hover:text-ink")}
    >
      {children}
    </button>
  );
}

export function RecordsBrowser({ title = "Crew records" }) {
  const [params, setParams] = useSearchParams();
  const f = useMemo(() => parseQuery(params), [params]);
  const set = (patch) => setParams(toQuery({ ...f, ...patch }), { replace: true });
  const [search, setSearch] = useState(f.q);
  const [tab, setTab] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState("");
  const query = apiQuery(f);
  const data = useQuery({ queryKey: ["records", query], queryFn: () => get(`/records?${query}`), placeholderData: (prev) => prev });

  const crew = data.data?.crew || [];
  const sections = data.data?.sections || [];
  const shown = sections.find((s) => s.id === tab) || sections.find((s) => s.total) || sections[0];
  const totalRows = sections.reduce((n, s) => n + s.total, 0);

  async function exportExcel() {
    setExporting(true);
    setNote("");
    try {
      const name = await downloadExcel(f);
      setNote(`Downloaded ${name}`);
    } catch (err) {
      setNote(`Couldn't export: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }
  const toggleAstro = (id) => set({ astronauts: f.astronauts.includes(id) ? f.astronauts.filter((x) => x !== id) : [...f.astronauts, id] });
  const toggleCat = (id) => {
    const next = f.categories.includes(id) ? f.categories.filter((c) => c !== id) : [...f.categories, id];
    if (next.length) set({ categories: next });
  };

  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <Card className="flex flex-col gap-4">
        <CardTitle
          title={title}
          subtitle="Everything the crew logged, by day. Filter it, then export exactly this to Excel."
          right={
            <Button variant="primary" onClick={exportExcel} busy={exporting} disabled={!data.data}>
              {!exporting && <Icon name="download" size={16} />} Export to Excel
            </Button>
          }
          className="mb-0"
        />
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-label font-semibold text-muted">Crew</span>
            <Chip on={!f.astronauts.length} onClick={() => set({ astronauts: [] })}>All crew</Chip>
            {crew.map((a) => <Chip key={a.id} on={f.astronauts.includes(a.id)} onClick={() => toggleAstro(a.id)}>{a.name}{a.role === "Flight surgeon" ? " (surgeon)" : ""}</Chip>)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-label font-semibold text-muted">Dates</span>
            <Segmented id="rec-range" size="sm" value={f.range} onChange={(range) => set(range === "custom" ? { range, from: f.from, to: f.to } : { range })}
              options={PRESETS.map(([value, label]) => ({ value, label }))} />
            {f.range === "custom" ? (
              <span className="flex flex-wrap items-center gap-2">
                <input type="date" className="ah-input min-h-9 py-1" value={f.from} max={f.to} onChange={(e) => e.target.value && set({ from: e.target.value })} aria-label="From date" />
                <span className="text-muted">to</span>
                <input type="date" className="ah-input min-h-9 py-1" value={f.to} min={f.from} onChange={(e) => e.target.value && set({ to: e.target.value })} aria-label="To date" />
              </span>
            ) : <span className="ah-num text-label text-muted">{f.from} → {f.to}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-label font-semibold text-muted">Include</span>
            {CATEGORIES.map(([id, label]) => <Chip key={id} on={f.categories.includes(id)} onClick={() => toggleCat(id)}>{label}</Chip>)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-label font-semibold text-muted">Level</span>
            <Segmented id="rec-level" size="sm" value={f.level} onChange={(level) => set({ level })} options={LEVELS.map(([value, label]) => ({ value, label }))} />
            <form className="flex min-w-[12rem] flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); set({ q: search }); }}>
              <input className="ah-input min-h-9 flex-1 py-1" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notes, symptoms, alerts…" aria-label="Search" />
              <Button type="submit" className="min-h-9 px-3 text-label">Search</Button>
            </form>
          </div>
        </div>
        <p className="m-0 text-label text-muted" role="status">
          {data.isError ? "Couldn't load the records." : data.data ? `${data.data.daily.rows.length} day rows · ${totalRows} records` : "Loading…"}
          {note && <span className="ml-2 text-accent-text">· {note}</span>}
        </p>
      </Card>

      <Card className="flex min-w-0 flex-col gap-3">
        <CardTitle title="Daily summary" subtitle="One row per crew member per day: averages, the worst level, and what happened." className="mb-0" />
        {data.data ? (
          <Table columns={data.data.daily.columns} rows={data.data.daily.rows} empty="Nothing logged for these filters." />
        ) : <Shimmer className="h-48" />}
      </Card>

      <Card className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Record sections">
          {sections.map((s) => (
            <button key={s.id} role="tab" aria-selected={shown?.id === s.id} onClick={() => setTab(s.id)}
              className={cx("min-h-9 cursor-pointer rounded-full px-3 text-label font-semibold",
                shown?.id === s.id ? "bg-accent text-accent-on" : "bg-raised text-ink-2 hover:text-ink")}>
              {s.title} <span className="ah-num opacity-80">{s.total}</span>
            </button>
          ))}
        </div>
        {shown ? (
          <>
            <Table columns={shown.columns} rows={shown.rows} empty={`No ${shown.title.toLowerCase()} for these filters.`} />
            {shown.total > shown.rows.length && (
              <p className="m-0 text-caption text-muted">Showing the newest {shown.rows.length} of {shown.total}; the Excel file has all of them.</p>
            )}
          </>
        ) : !data.data && <Shimmer className="h-48" />}
      </Card>
      <p className="m-0 px-1 text-caption text-subtle">Demo with placeholder data. Not medical advice.</p>
    </div>
  );
}
