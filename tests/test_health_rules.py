from backend import health_rules as hr


def test_heart_rate_green_yellow_red():
    assert hr.evaluate("heart_rate", 75) == hr.GREEN
    assert hr.evaluate("heart_rate", 55) == hr.YELLOW
    assert hr.evaluate("heart_rate", 110) == hr.YELLOW
    assert hr.evaluate("heart_rate", 130) == hr.RED
    assert hr.evaluate("heart_rate", 40) == hr.RED


def test_blood_pressure_combines_systolic_and_diastolic():
    assert hr.evaluate("blood_pressure", (115, 75)) == hr.GREEN
    assert hr.evaluate("blood_pressure", (135, 75)) == hr.YELLOW
    assert hr.evaluate("blood_pressure", (145, 75)) == hr.RED
    assert hr.evaluate("blood_pressure", (115, 92)) == hr.RED
    assert hr.evaluate("blood_pressure", (80, 75)) == hr.RED  # systolic below 85


def test_sleep_uses_minimum_thresholds():
    assert hr.evaluate("sleep", 7.5) == hr.GREEN
    assert hr.evaluate("sleep", 6.2) == hr.YELLOW
    assert hr.evaluate("sleep", 5.0) == hr.RED


def test_mood_low_is_bad():
    assert hr.evaluate("mood", 5) == hr.GREEN
    assert hr.evaluate("mood", 3) == hr.YELLOW
    assert hr.evaluate("mood", 1) == hr.RED


def test_reaction_time_relative_to_baseline():
    baseline = 340
    assert hr.evaluate("reaction_time", (350, 0), baseline_reaction_ms=baseline) == hr.GREEN
    assert hr.evaluate("reaction_time", (410, 0), baseline_reaction_ms=baseline) == hr.YELLOW
    assert hr.evaluate("reaction_time", (500, 0), baseline_reaction_ms=baseline) == hr.RED
    assert hr.evaluate("reaction_time", (350, 3), baseline_reaction_ms=baseline) == hr.RED  # 3+ lapses


def test_symptom_level():
    assert hr.symptom_level([]) == hr.GREEN
    assert hr.symptom_level(["headache"]) == hr.YELLOW
    assert hr.symptom_level(["chest_pain"]) == hr.RED
    assert hr.symptom_level(["headache", "blurry_vision"]) == hr.RED


def test_overall_level_is_the_worst():
    assert hr.overall_level(["GREEN", "GREEN"]) == hr.GREEN
    assert hr.overall_level(["GREEN", "YELLOW"]) == hr.YELLOW
    assert hr.overall_level(["GREEN", "YELLOW", "RED"]) == hr.RED
    assert hr.overall_level([]) == hr.GREEN


def test_trend_raises_level_on_three_day_worsening():
    # Normal today, but the last 3 days have been sliding worse each day -> bumped to YELLOW.
    assert hr.apply_trend(hr.GREEN, [hr.GREEN, hr.YELLOW, hr.YELLOW]) == hr.YELLOW
    # Flat GREEN for days: no bump.
    assert hr.apply_trend(hr.GREEN, [hr.GREEN, hr.GREEN, hr.GREEN]) == hr.GREEN
    # Already RED stays RED (can't bump past RED).
    assert hr.apply_trend(hr.RED, [hr.YELLOW, hr.YELLOW, hr.RED]) == hr.RED
