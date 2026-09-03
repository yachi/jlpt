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

### ~~4. A never-seen word was served as a blind quiz~~ FIXED

Found by the learner, mid-session: a NEW `reading` card for 浴びる was served as
four kana choices for a word never shown. "I don't know" was the only honest
answer and it was recorded as a lapse — *「新既鬼識呀」*.

Fix: `teach_new_first` (default on). A new card comes back with `teachFirst`,
and the caller shows the word, its reading, its meaning and its audio instead
of asking. `introduceCard()` marks it introduced and schedules the first real
test `INTRODUCE_DELAY_MS` (10 min) later — not immediately, because quizzing a
word seconds after showing it measures short-term memory. It writes **no review
row**: nothing was asked, so there is nothing to record.

Three second-order defects the tests caught, each now covered by a mutation
test:
- **The daily budget stopped being enforced.** It counted first *reviews*, and
  an introduction writes none — so a learner taught 5 words and stopping would
  be handed 5 more. Now counted on the new `cards.introduced_at` column.
- **`grade()` did not stamp `introduced_at`**, so with `teach_new_first` off (or
  inside the exam) the limit vanished entirely. Set with `COALESCE`, so it
  records the first exit from the new queue rather than the latest review.
- **The sibling cooldown went blind.** It read only the review log, so a word
  taught as `meaning` could be introduced as `listening` seconds later — the
  exact thing the cooldown exists to prevent. It now takes the later of the last
  review and any sibling's `introduced_at`.

Teaching also always speaks the *reading*: `reading` and `production` cards
carry no audio at all, and `meaning` plays the expression, which is the kanji
the TTS mispronounces (see `speakableReading`).

The mock exam passes `teachNew: false` — an exam measures, and teaching
mid-sitting would leak the answer and drop the question from the score.

Migration verified on the live deck: all 61 introduced cards backfilled from
their first review, 0 disagreements, 16 counted as introduced today.

### ~~5. The こそあど distance grid was erased, and 空く was glossed as 開く~~ FIXED

Verified against Jisho and corrected via `data/gloss-corrections.csv`:

| word | was | now |
|---|---|---|
| あちら | this way (polite) | over there (polite) |
| あっち | over there | over there (casual) |
| そちら | over there | that way near you (polite) |
| そっち | over there | that way near you (casual) |
| 空く【あく】 | to open, to become empty (vacant) | to become empty (vacant), to become free |

あちら, あっち, そちら and そっち all carried the same or a swapped gloss, so the
entire こそあど distance distinction — far from both vs. near the listener — was
invisible on a card. Jisho gives そちら/そっち "direction distant from the
speaker, **close to the listener**".

空く had its senses in the wrong order, and `shortMeaning()` shows only the
first clause — so the card read "to open", which is its homophone 開く's
meaning, for the one word whose entire point is that it is *not* 開く. Jisho's
first sense is "to become less crowded; to thin out; to get empty".

Two things this exposed:

- **Corrections must be written so the FIRST clause distinguishes the word.**
  A first pass used "that way, near you (polite)" — `shortMeaning` cuts at the
  comma, so the card showed "that way", colliding with あちら. Parenthesised
  text does not split, so "over there (polite)" survives whole. Now documented
  in the file's header.
- **`applyGlossCorrections` read the header row as data.** Adding a `#` comment
  block meant `.slice(1)` dropped a comment instead of the header, and every
  seed warned that `expression【reading】` was missing from the bank. Comments
  and the header are now skipped by name.

The stale check earned its keep: it refused to overwrite one correction with
another, which is exactly right. Revising a correction means restoring the item
to its upstream CSV value first.

## Open

### ~~6. shortMeaning truncation erased distinctions on 127 items~~ FIXED

`shortMeaning()` took everything before the first top-level separator, and that
was the only text a multiple-choice card ever showed. 薄い "thin, weak" and 細い
"thin, slender, fine" both displayed **thin**; うち and 家庭 both **home**;
こんな "such, like this" and そんな "such, like that" both **such**. The cards
were answerable — different readings — but what they taught did not identify
the word.

**This was not a new design problem.** `productionPrompt()` already solved
exactly this for production cards, by escalating to the full meaning when the
short gloss named more than one item. Two functions, one problem, opposite
halves of the app. The fix generalises that escalation and deletes the copy:

`displayGloss(db, item)` returns the shortest run of leading clauses that no
other bank item shares. `productionPrompt` lost its own layer 1 and now handles
only what no gloss can express — the part of speech.

Measured on the bank:

| | before | after |
|---|---|---|
| items sharing a display gloss | 157 (11.3%) | **34 (2.5%)** |
| unanswerable production prompts | 0 | **0** |
| glosses that got longer | — | 100 (7.2%) |
| mean gloss length | 10.2 chars | 11.0 chars |
| `nextQuestion(listening)` | 0.74 ms | 0.79 ms |

The 34 that remain have genuinely identical source glosses — 赤/赤い both "red",
ええ/はい both "yes", 明日 read あした or あす. No gloss can separate those;
`productionPrompt` tags the part of speech and accepts every member's reading.

Three things worth keeping:

- **The same rule renders answers AND distractors.** Escalating only the answer
  would make the longest option the correct one. Verified: the answer is
  uniquely the longest option in 22.3% of 2,768 built questions, against 25% by
  chance — no tell.
- **The index is fetched once per call site, not once per item.** The first
  version called `displayGloss` per rival, so the full-bank production test
  issued ~1.9M stamp queries and ran past two minutes. `glossIndex(db)` is
  cached per database behind a 0.069 ms stamp; `sharing()` turns
  `productionPrompt` from 1383 comparisons into one lookup. That test now runs
  in 105 ms.
- **One deliberate behaviour change.** `shortMeaning(", leading comma")` used to
  return the whole string and now returns "leading comma", because
  `glossClauses` drops the empty clause a leading separator makes. No bank gloss
  starts with a separator (checked: 0 of 1384), so this only ever described
  malformed input.

### 7. Carried over from the sentence-mode plan

- **Enable sentence mode** — `bun run cli set sentence_listening 1` around day
  30-45, when coverage reaches ~50%. Currently far below that.
- **Settle `MS_PER_CHAR = 180`** from data once sentences are live; it is an
  estimate, not a measurement.
- **Watch whether sentence reviews flood the queue** — `cli stats` already
  prints word-vs-sentence Hard rates for exactly this.
