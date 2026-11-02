"""Turns a reading into a GREEN / YELLOW / RED level, using thresholds from
config/health_rules.json (all PLACEHOLDER general-adult ranges, not real
mission rules -- see docs/build-prompt.md section 8).

Nothing in here is hard-coded: every number comes from the config file, so
the thresholds can be replaced later without touching this module.
"""
from backend.config import health_rules as load_rules

GREEN, YELLOW, RED = "GREEN", "YELLOW", "RED"
_LEVEL_RANK = {GREEN: 0, YELLOW: 1, RED: 2}


def worse(a, b):
    """Returns whichever level is worse (RED > YELLOW > GREEN)."""
    return a if _LEVEL_RANK[a] >= _LEVEL_RANK[b] else b


def _in_range(value, lo_hi):
    lo, hi = lo_hi
    return lo <= value <= hi


def _in_any_range(value, ranges):
    return any(_in_range(value, r) for r in ranges)


def evaluate_simple(cfg, value):
    """Indicator shaped like {"green":[lo,hi], "yellow":[[lo,hi],...]}."""
    if _in_range(value, cfg["green"]):
        return GREEN
    if _in_any_range(value, cfg["yellow"]):
        return YELLOW
    return RED


def evaluate_min(cfg, value):
    """Indicator shaped like {"green_min":x, "yellow_min":y} -- higher is better."""
    if value >= cfg["green_min"]:
        return GREEN
    if value >= cfg["yellow_min"]:
        return YELLOW
    return RED


def evaluate_blood_pressure(cfg, systolic, diastolic):
    if systolic >= cfg["systolic_red_high"] or systolic <= cfg["systolic_red_low"] or diastolic >= cfg["diastolic_red_high"]:
        return RED
    sys_ok = _in_range(systolic, cfg["systolic_green"])
    dia_ok = _in_range(diastolic, cfg["diastolic_green"])
    if sys_ok and dia_ok:
        return GREEN
    sys_yellow = _in_any_range(systolic, cfg["systolic_yellow"])
    dia_yellow = _in_range(diastolic, cfg["diastolic_yellow"])
    if sys_yellow or dia_yellow or not sys_ok or not dia_ok:
        return YELLOW
    return GREEN


def evaluate_reaction_time(cfg, avg_ms, baseline_ms, lapses):
    if lapses >= cfg["red_lapses"]:
        return RED
    if baseline_ms <= 0:
        return GREEN
    pct_slower = (avg_ms - baseline_ms) / baseline_ms * 100
    if pct_slower <= cfg["green_pct"]:
        return GREEN
    if pct_slower <= cfg["yellow_pct"]:
        return YELLOW
    return RED


def evaluate(indicator, value, baseline_reaction_ms=None, rules=None):
    """value: a number, except 'blood_pressure' -> (systolic, diastolic),
    and 'reaction_time' -> (avg_ms, lapses).
    Returns the level string.
    """
    rules = rules or load_rules()
    cfg = rules["indicators"][indicator]
    if indicator == "blood_pressure":
        systolic, diastolic = value
        return evaluate_blood_pressure(cfg, systolic, diastolic)
    if indicator == "reaction_time":
        avg_ms, lapses = value
        return evaluate_reaction_time(cfg, avg_ms, baseline_reaction_ms or 350, lapses)
    if indicator in ("sleep", "exercise", "water"):
        return evaluate_min(cfg, value)
    return evaluate_simple(cfg, value)


def symptom_level(items, rules=None):
    """Any symptom = YELLOW; a red-flag symptom (blurry vision, chest pain,
    shortness of breath) = RED."""
    rules = rules or load_rules()
    scfg = rules["symptom_levels"]
    if not items:
        return GREEN
    if any(item in scfg["red_symptoms"] for item in items):
        return RED
    return scfg["default"]


def apply_trend(level_today, last_n_levels, rules=None):
    """If an indicator got worse on each of the last trend_days days in a
    row, raise today's level by one step even if today looks normal."""
    rules = rules or load_rules()
    n = rules.get("trend_days", 3)
    if len(last_n_levels) < n:
        return level_today
    recent = last_n_levels[-n:]
    worsening = all(_LEVEL_RANK[recent[i]] <= _LEVEL_RANK[recent[i + 1]] for i in range(len(recent) - 1))
    getting_worse_overall = _LEVEL_RANK[recent[-1]] > _LEVEL_RANK[recent[0]]
    if worsening and getting_worse_overall:
        bumped = min(_LEVEL_RANK[level_today] + 1, _LEVEL_RANK[RED])
        for lvl, rank in _LEVEL_RANK.items():
            if rank == bumped:
                return lvl
    return level_today


def overall_level(levels):
    """The worst level among a day's indicators (empty -> GREEN)."""
    result = GREEN
    for lvl in levels:
        result = worse(result, lvl)
    return result


def body_part_for(indicator, rules=None):
    rules = rules or load_rules()
    return rules["indicators"].get(indicator, {}).get("body_part")


def hazards_for(indicator, rules=None):
    rules = rules or load_rules()
    return rules["indicators"].get(indicator, {}).get("hazards", [])
