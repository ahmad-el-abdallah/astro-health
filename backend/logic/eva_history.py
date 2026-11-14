"""Real spacewalk history: NASA's "Extra-vehicular Activity (EVA) - US and Russia" log
(NASA Open Data Portal, data.nasa.gov), as cleaned by the team: backend/eva/nasa_eva.csv,
375 US and Russian/Soviet spacewalks from 1965 to 2013 -- crew, vehicle, date, duration and a
short note on what happened.

It has no suit sensor values (the app's suit readings stay simulated, with PLACEHOLDER limits
in config/health_rules.json). What it does give the app, all real:
  * how long spacewalks actually last -- the live EVA is compared with 368 completed ones
    (typical length, how many ended by now, the record);
  * real suit problems from the log (CO2, suit pressure/leaks, oxygen, cooling/water in the
    helmet), shown next to a matching bad suit reading and given to the AI as context.
"""
import csv
import os
import re
import statistics
from functools import lru_cache

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend", "eva", "nasa_eva.csv")
SOURCE = ("NASA Open Data Portal: Extra-vehicular Activity (EVA) - US and Russia "
          "(375 spacewalks, 1965-2013)")

# Real suit problems from the log, picked by hand (keyword matches alone also caught
# station hardware like "O2 generator"). Each: the problem it matches, a phrase that finds
# the row in the CSV, and the sentence(s) of its note to show.
INCIDENT_PICKS = [
    ("suit_co2", "EV2 CO2 sensor failed", r"EV2 CO2 sensor failed"),
    ("suit_co2", "faulty CO2 readings", r"Started 1 hour late due to faulty CO2 readings"),
    ("suit_co2", "depleted LiOH cans", r"Accidently reused depleted LiOH cans from 1st EVA"),
    ("suit_pressure", "suit leak from damaged CO2 can O-ring", r"Late start due to suit leak from damaged CO2 can O-ring"),
    ("suit_pressure", "reduce suit pressure to turnaround", r"Had to partially reduce suit pressure to turnaround in airlock and close hatch"),
    ("suit_pressure", "coolant leakage from EVA life support", r"Gibson reported coolant leakage from EVA life support system"),
    ("suit_o2", "Suit fan and O2 regulator failures", r"Suit fan and O2 regulator failures prevented first Shuttle EVA"),
    ("suit_o2", "O2 failure in S's suit", r"O2 failure in S's suit stops work"),
    ("suit_o2", "O2 injector lever", r"Fincke's Orlan O2 injector lever not in fully closed position.  EVA attempt terminated early"),
    ("suit_o2", "missed opening of primary O2 bottles", r"EVA delayed 1:43 due to missed opening of primary O2 bottles in both suits"),
    ("cooling", "free water in EV2's helmet", r"EVA terminated early due to free water in EV2's helmet"),
    ("cooling", "Cooling system failure in T's suit", r"Cooling system failure in T's suit shortens EVA"),
    ("cooling", "Contaminated sublimator plate", r"Contaminated sublimator plate reduced cooling at end of EVA"),
    ("cooling", "helmet fogged", r"Gas flow cooling of 25ft umbilical overwhelmed by vehicle ingress work and helmet fogged"),
]
PROBLEM_LABEL = {"suit_co2": "CO2 in the suit", "suit_pressure": "Suit pressure / leaks",
                 "suit_o2": "Suit oxygen", "cooling": "Suit cooling / water in the helmet"}
# Typos in the source file, fixed only for display (the CSV itself is left as NASA published it).
CREW_FIXES = {"Doug Wheellock Tracy Caldwell Dyson": "Doug Wheelock & Tracy Caldwell Dyson"}


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@lru_cache(maxsize=1)
def rows():
    with open(PATH, newline="", encoding="utf-8", errors="replace") as fh:
        out = []
        for r in csv.DictReader(fh):
            out.append({
                "crew": CREW_FIXES.get((r.get("crew") or "").strip(),
                                       " & ".join(c.strip() for c in (r.get("crew") or "").split("|") if c.strip())),
                "country": r.get("country") or "",
                "vehicle": (r.get("vehicle") or "").strip(),
                "date": r.get("date") or "",
                "year": int(r["year"]) if (r.get("year") or "").strip().isdigit() else None,
                "hours": _float(r.get("duration_hours")) or 0.0,
                "cancelled": (r.get("cancelled") or "").strip() == "True",
                "note": re.sub(r"\s+", " ", (r.get("purpose") or "").replace("Â´", "'")).strip(),
            })
        return out


def completed():
    return [r for r in rows() if not r["cancelled"] and r["hours"] > 0]


def _pct(sorted_vals, q):
    return sorted_vals[min(len(sorted_vals) - 1, int(q * len(sorted_vals)))]


@lru_cache(maxsize=1)
def stats():
    done = completed()
    hours = sorted(r["hours"] for r in done)
    years = [r["year"] for r in rows() if r["year"]]
    rec = max(done, key=lambda r: r["hours"])
    decades = {}
    for r in done:
        if r["year"]:
            decades.setdefault(r["year"] // 10 * 10, []).append(r["hours"])
    return {
        "total": len(rows()),
        "completed": len(done),
        "cancelled": sum(r["cancelled"] for r in rows()),
        "first_year": min(years), "last_year": max(years),
        "by_country": {c: sum(r["country"] == c for r in rows()) for c in sorted({r["country"] for r in rows()} - {""})},
        "done_hours": hours,  # every completed spacewalk's length, sorted (the page's live comparison)
        "median_h": round(statistics.median(hours), 2),
        "p90_h": round(_pct(hours, 0.9), 2),
        "record": {"hours": rec["hours"], "crew": rec["crew"], "vehicle": rec["vehicle"], "date": rec["date"]},
        "by_decade": [{"decade": d, "count": len(v), "avg_h": round(statistics.mean(v), 2)} for d, v in sorted(decades.items())],
    }


def compare(hours):
    """How a spacewalk of `hours` compares: the share of real completed spacewalks that were
    shorter, and a short phrase."""
    done = completed()
    shorter = sum(r["hours"] < hours for r in done)
    pct = round(100 * shorter / len(done))
    s = stats()
    if hours > s["record"]["hours"]:
        phrase = f"longer than every spacewalk in the NASA log (record {s['record']['hours']:.1f} h)"
    elif hours >= s["p90_h"]:
        phrase = f"longer than {pct}% of real spacewalks -- most had ended by {s['p90_h']:.1f} h"
    else:
        phrase = f"longer than {pct}% of real spacewalks (typical {s['median_h']:.1f} h)"
    return {"hours": round(hours, 2), "longer_than_pct": pct, "phrase": phrase}


@lru_cache(maxsize=1)
def incidents():
    """{problem: [ {date, vehicle, crew, hours, what} ]} -- real suit problems from the log."""
    out = {k: [] for k in PROBLEM_LABEL}
    for problem, find, sentence in INCIDENT_PICKS:
        row = next((r for r in rows() if find in r["note"]), None)
        if not row:
            continue
        m = re.search(sentence, row["note"])
        what = (m.group(0) if m else find).replace("  ", " ").strip().rstrip(".") + "."
        out[problem].append({"date": row["date"] or (str(row["year"]) if row["year"] else ""), "vehicle": row["vehicle"],
                             "crew": row["crew"], "hours": row["hours"], "what": what})
    return out


def payload():
    return {"stats": stats(), "incidents": incidents(), "labels": PROBLEM_LABEL, "source": SOURCE}


def context_line(minutes, bad_suit=()):
    """For the AI health analysis / Astra while on EVA."""
    s = stats()
    c = compare(minutes / 60)
    line = (f"Real spacewalk history (NASA EVA log, {s['completed']} completed, {s['first_year']}-{s['last_year']}): "
            f"typical length {s['median_h']:.1f} h, 90% ended by {s['p90_h']:.1f} h, record {s['record']['hours']:.1f} h. "
            f"This EVA so far ({minutes / 60:.1f} h) is {c['phrase']}.")
    seen = incidents()
    for p in bad_suit:
        if seen.get(p):
            i = seen[p][0]
            line += f" A real past problem ({PROBLEM_LABEL[p]}): {i['vehicle']} {i['date']}: {i['what']}"
    return line
