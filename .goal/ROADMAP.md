# Roadmap

Open work, newest first. Each item states how it was found and what evidence
exists, so a later session does not have to re-derive the number.

## Done — 2026-09-03

### ~~1. A listening card could have two correct answers~~ FIXED

A listening card plays the reading alone, so nothing in the stimulus separates
暑い / 熱い / 厚い (all あつい). When a rival's gloss was drawn as a distractor,
two options were correct for what was played and one graded as Again.

**Measured, corrected:** an initial probe reported 4.16%, but that probe counted
the card's own correct answer as a collision. Re-probed excluding it: **31 of
20,000 built questions (0.15%)** had a genuine second correct option, across
**39 items**, peaking at **1.6%** for 日【ひ】 against 火【ひ】. Rare, but each
occurrence is a guaranteed wrong grade for a learner who understood perfectly.

A separate 4 items have a gloss *identical* to a rival's (開く / 空く both
shorten to "to open"). Those are harmless: `distractors()` already dedupes by
string, so only one copy is offered and either reading of it grades correct.

Fix: `homophoneGlosses()` in `src/bank.ts`, fed into the `exclude` parameter
`distractors()` already had, from both listening branches in `buildQuestion`.
`meaning` and `reading` cards deliberately keep homophone glosses — those put
the expression on screen, which is exactly what tells the homophones apart, so
there a rival's gloss is the most instructive distractor in the bank.

Verified: probe re-run on the real bank reports **0**; `src/fixes-2026-09-03.test.ts`
holds a mutation test proving the exclusion is load-bearing.

### ~~2. `data/n5.csv:23` — あちら carried こちら's gloss~~ FIXED

The row reads `あちら,あちら,this way (polite)`. That is こちら's gloss (item 258
carries the identical string). あちら is the あ-series distal demonstrative:
*that way, over there*, polite. As shipped the card taught the opposite.

The CSVs are the external oracle and are never regenerated from code, so this
needed a deliberate override rather than an edit. `data/gloss-corrections.csv`
is that escape hatch: `level,expression,reading,was,now,why`, applied by
`applyGlossCorrections()` after the seed insert (which is `ON CONFLICT DO
NOTHING` and so never updates an existing row).

`was` is the load-bearing column. If upstream later changes the row, the
correction is reported **stale** and skipped rather than silently re-breaking a
fixed gloss. Corrections are also reported when they name a word not in the
bank. Gloss is not part of `bankFingerprint()`, so applying one does not
invalidate the 208,769 sentence links.

Applied to the live database; 43,457 sentences and all links intact.

### ~~3. No first-class "I don't know"~~ FIXED

`cli answer` took a choice number or typed kana only, so recording an honest
"I don't know" meant submitting a knowingly-wrong choice — which writes a
fabricated answer into the review log. Added `DONT_KNOW = "?"`, accepted as
`cli answer ?`, `cli answer --dont-know`, and `?` at the interactive prompt.

Checked explicitly at the top of `checkAnswer` rather than relying on
`Number("?")` being NaN: a sentinel that grades wrong only by accident is one
refactor away from grading right.

## Open

### 4. そちら's gloss is imprecise

`そちら` is glossed "over there", which reads as the あ-series meaning. It is the
そ-series: *that way, near you*. Lower stakes than あちら (it is not the exact
gloss of a different word), but it belongs in `gloss-corrections.csv` once
confirmed against a dictionary.

### 5. Carried over from the sentence-mode plan

- **Enable sentence mode** — `bun run cli set sentence_listening 1` around day
  30-45, when coverage reaches ~50%. Currently far below that.
- **Settle `MS_PER_CHAR = 180`** from data once sentences are live; it is an
  estimate, not a measurement.
- **Watch whether sentence reviews flood the queue** — `cli stats` already
  prints word-vs-sentence Hard rates for exactly this.
