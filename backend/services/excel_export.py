"""The crew records as a real Excel workbook (.xlsx), built with XlsxWriter.

Sheets: "Summary" (what's in it and how it was filtered), "Daily" (one row per astronaut per
day), then one sheet per section that has rows (backend/logic/records.py SECTIONS). Every
data sheet has a styled, frozen header row and an autofilter; times are real Excel
date-times, numbers real numbers, and level cells are coloured (Good / Check / Alert).
"""
import io
from datetime import date, datetime

import xlsxwriter

from backend.logic import records

LEVEL_COLORS = {"GREEN": ("#d8f5e6", "#0b6b3a"), "YELLOW": ("#fdf0cc", "#7a5300"), "RED": ("#fbd9dc", "#8a1020"),
                "GRAY": ("#ececf1", "#4a4a5a")}
WIDTH = {"datetime": 17, "date": 12, "text": 18, "number": 11, "level": 10, "long": 48}


def filename(f):
    return f"crew-records_{f.start.isoformat()}_{f.end.isoformat()}.xlsx"


def build(f, names, sections, daily, generated=None):
    """f: records.Filters, names: the astronauts covered, sections: records.collect(),
    daily: records.daily_summary(). Returns the .xlsx bytes."""
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "remove_timezone": True})
    wb.set_properties({"title": "Astro Health Station: crew records", "subject": "Crew health data (placeholder demo data)",
                       "author": "Astro Health Station", "comments": "Demo with placeholder data. Not medical advice."})
    fmt = {
        "title": wb.add_format({"bold": True, "font_size": 16, "font_color": "#1b2a5c"}),
        "label": wb.add_format({"bold": True, "font_color": "#4a4a5a"}),
        "head": wb.add_format({"bold": True, "font_color": "#ffffff", "bg_color": "#2b3f8c", "border": 1, "border_color": "#1b2a5c",
                               "text_wrap": True, "valign": "vcenter"}),
        "datetime": wb.add_format({"num_format": "yyyy-mm-dd hh:mm", "valign": "top"}),
        "date": wb.add_format({"num_format": "yyyy-mm-dd", "valign": "top"}),
        "text": wb.add_format({"valign": "top"}),
        "long": wb.add_format({"text_wrap": True, "valign": "top"}),
        "number": wb.add_format({"num_format": "0.##", "valign": "top"}),
        "note": wb.add_format({"italic": True, "font_color": "#7a5300"}),
    }
    level_fmt = {lv: wb.add_format({"bg_color": bg, "font_color": fg, "bold": True, "align": "center", "valign": "top"})
                 for lv, (bg, fg) in LEVEL_COLORS.items()}

    # ---- Summary ----
    ws = wb.add_worksheet("Summary")
    ws.set_column(0, 0, 24)
    ws.set_column(1, 1, 60)
    ws.write(0, 0, "Astro Health Station: crew records", fmt["title"])
    generated = generated or datetime.now()
    tz = f"UTC{'+' if f.tz_minutes >= 0 else '-'}{abs(f.tz_minutes) // 60:02d}:{abs(f.tz_minutes) % 60:02d}"
    info = [
        ("Generated", generated.strftime("%Y-%m-%d %H:%M")),
        ("Dates", f"{f.start.isoformat()} to {f.end.isoformat()} (local time, {tz})"),
        ("Crew", ", ".join(names) or "none"),
        ("Includes", ", ".join({"vitals": "Vitals & wearable", "checkins": "Daily check-ins", "events": "Health events",
                                "notes": "Private notes"}[c] for c in f.categories)),
        ("Level filter", {"any": "All levels", "YELLOW": "Check or worse", "RED": "Alerts only"}[f.level]),
        ("Search", f.q or "none"),
    ]
    for i, (k, v) in enumerate(info, start=2):
        ws.write(i, 0, k, fmt["label"])
        ws.write(i, 1, v)
    row = len(info) + 3
    ws.write(row, 0, "Sheet", fmt["head"])
    ws.write(row, 1, "Rows", fmt["head"])
    row += 1
    ws.write(row, 0, "Daily")
    ws.write_number(row, 1, len(daily))
    for sid, title, *_ in records.SECTIONS:
        if sid in sections:
            row += 1
            ws.write(row, 0, title)
            ws.write_number(row, 1, len(sections[sid]))
    ws.write(row + 2, 0, "Demo with placeholder data. Not medical advice.", fmt["note"])
    ws.activate()

    # ---- data sheets ----
    def sheet(name, columns, rows):
        ws = wb.add_worksheet(name[:31])
        for c, (_, header, kind) in enumerate(columns):
            ws.set_column(c, c, WIDTH.get(kind, 16))
            ws.write(0, c, header, fmt["head"])
        ws.set_row(0, 30)
        ws.freeze_panes(1, 0)
        for r, item in enumerate(rows, start=1):
            for c, (key, _, kind) in enumerate(columns):
                v = item.get(key)
                if v is None or v == "":
                    ws.write_blank(r, c, None, fmt["text"])
                elif kind == "level":
                    ws.write_string(r, c, records.LEVEL_WORD.get(v, str(v)), level_fmt.get(v, fmt["text"]))
                elif kind in ("datetime", "date") and isinstance(v, (datetime, date)):
                    ws.write_datetime(r, c, v if isinstance(v, datetime) else datetime(v.year, v.month, v.day), fmt[kind])
                elif kind == "number" and isinstance(v, (int, float)) and not isinstance(v, bool):
                    ws.write_number(r, c, v, fmt["number"])
                else:
                    ws.write_string(r, c, str(v), fmt["long" if kind == "long" else "text"])
        ws.autofilter(0, 0, max(1, len(rows)), len(columns) - 1)
        if not rows:
            ws.write(2, 0, "No rows for these filters.", fmt["note"])

    sheet("Daily", records.DAILY_COLUMNS, daily)
    for sid, title, _cat, columns in records.SECTIONS:
        if sid in sections:
            sheet(title, columns, sections[sid])
    wb.close()
    return buf.getvalue()
