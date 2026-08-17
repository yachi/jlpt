# /// script
# requires-python = ">=3.10"
# dependencies = ["fsrs"]
# ///
"""Generate a golden fixture from the REFERENCE py-fsrs implementation.
Fuzzing disabled so output is deterministic and portable."""
import json
from datetime import datetime, timedelta, timezone
from fsrs import Scheduler, Card, Rating

sched = Scheduler(enable_fuzzing=False)
START = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Deterministic pseudo-random rating sequences (no RNG: fixed patterns)
SEQS = [
    [3, 3, 3, 3, 3, 3],
    [1, 3, 3, 1, 3, 4],
    [4, 4, 4, 4],
    [2, 2, 3, 1, 2, 3, 4],
    [3, 1, 1, 3, 3, 2, 4, 3],
    [1, 1, 1, 1],
]
# Elapsed days between each successive review (index-aligned to SEQS entries)
GAPS = [
    [0, 1, 3, 10, 30, 90],
    [0, 0, 2, 7, 1, 20],
    [0, 5, 25, 120],
    [0, 0, 1, 4, 0, 6, 15],
    [0, 1, 0, 2, 8, 20, 45, 100],
    [0, 0, 0, 0],
]

out = []
for si, (seq, gaps) in enumerate(zip(SEQS, GAPS)):
    card = Card()
    t = START
    steps = []
    for ri, (rating, gap) in enumerate(zip(seq, gaps)):
        t = t + timedelta(days=gap)
        card, _ = sched.review_card(card, Rating(rating), review_datetime=t)
        steps.append({
            "rating": rating,
            "gap_days": gap,
            "stability": card.stability,
            "difficulty": card.difficulty,
            "state": card.state.name.lower(),
            "step": card.step,
            "due_offset_ms": int((card.due - t).total_seconds() * 1000),
        })
    out.append({"seq": si, "steps": steps})

print(json.dumps({"start_iso": START.isoformat(), "cases": out}, indent=1))
