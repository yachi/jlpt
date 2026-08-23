# Plan: sentences in listening practice

Revision 3. Revision 1 proposed a fifth scheduled mode; adversarial review
found three fatal flaws in that shape, and a cheaper design that dissolves all
three rather than fixing them. Revision 2 adopted that design; a second review
found one internal contradiction in it and three correctness gaps. This is the
result. It is considered buildable.

## 0. Two reframes

**Reframe 1 — do not generate Japanese, select it.**
Template-generated sentences are grammatical but unnatural, and training
listening on unnatural prosody teaches the wrong target. Use the established
i+1 / 1T method: serve a real sentence in which exactly one word is the review
target and every other word is already known.

Honest qualification: offline LLM generation, constrained to the learner's exact
vocabulary and spot-checked by a native speaker, is a legitimate Plan B, not a
strawman. JLPT listening material is itself scripted, not corpus-mined, and
Tatoeba's user-submitted sentences are of uneven quality. Corpus goes first
because it is cheaper and licence-clean — not because generation is illegitimate.
If the Phase 0 gate fails, generation is the documented fallback.

**Reframe 2 — this is not a new mode. It is a better stimulus for an existing one.**
The measured weakness is listening. A `listening` card today plays one word
(`quiz.ts:226-229`, `audioText: item.expression`). When an eligible sentence
exists for that word, play the *sentence* instead and ask the same question:
what does the target word mean?

Same card, same FSRS state, same grading, same mode. What this avoids:

| Revision 1 problem | Why it disappears |
|---|---|
| A due `sentence` card with no eligible sentence is re-picked forever (`quiz.ts:145-150` orders by `due ASC`; `grade` keys by `q.mode`, `quiz.ts:293-301`) | No card can lack a stimulus — the word is the fallback, on the same card |
| Seeding ~1,384 sentence cards that are ineligible for months (`bank.ts` loops `MODES`) | No new cards |
| `Record<Mode, …>` exhaustiveness | No new mode |
| Stored `mode_weights` = `listening:45,reading:30,production:15,meaning:10` silently gives a new mode weight 0 (`quiz.ts:37`) | No retune, no migration |
| A fifth mode eats the shared 12/day new-card limit, slowing the vocabulary growth that sentence eligibility depends on | No dilution |

Cost: ~10% of revision 1's surface area. And it measures its own premise —
logging how often a sentence was available IS the corpus-adequacy statistic.

Promote to a separate scheduled mode later only if the data shows
context-listening and word-listening diverge enough to need separate FSRS state.

## 1. Goals / non-goals

Goals
- When a `listening` card comes due and an i+1 sentence exists for its item,
  the stimulus is that sentence.
- "Known" for this purpose means **known by ear**, not merely introduced.
- Sentences are real, externally sourced, licence-clean, checked in.
- `stats` reports sentence availability, so the premise stays measured.

Non-goals
- A fifth mode. Deferred, deliberately, until data justifies it.
- Cloze / fill-in-the-blank. Revision 1 had the target word audible in the
  audio while blanked in the text — the audio gave away the answer. A real
  cloze is a *reading* task and belongs to `reading`, not here.
- MC comprehension over whole-sentence English translations. Revision 1 claimed
  this reused `distractors()` (`bank.ts:138`); it does not — it needs new
  selection over sentence translations, and random Tatoeba translations are so
  unrelated that one content word solves the question. Dropped.
- Multi-speaker dialogue (課題理解 / 即時応答). Separate project.

## 2. The known-by-ear predicate

The single most important correctness decision, and revision 1 got it wrong.

Revision 1: a word counts as known if any mode of it was introduced. That
admits words the learner has only ever *seen*. Under `skip_meaning_for_kanji`
— enabled for this user — that is self-contradictory: the whole premise of that
feature is that recognising 秋 and hearing あき are different skills.

Rule: a context word counts as known only if its **`listening` card has
graduated initial learning** — `introduced = 1 AND state != 'learning'`.
Sentences consolidate words you can already parse from audio; anything looser
destroys the one property the feature exists to provide.

`relearning` counts as known: the word was parseable once, and excluding lapsed
words would churn hundreds of counter rows every time a common word lapses.

Revision 2 said this and then maintained it at the wrong event — see §4.

## 3. Data pipeline

Tatoeba jpn-eng, CC BY 2.0 FR. `tools/build-sentences.py`, a PEP 723 uv script,
mirroring `tools/gen-fsrs-fixture.py`: run the real library offline, check in
the result, keep runtime dependency-free.

Unresolved before building — each must be decided, not discovered:
- **Function words.** `は/が/を/です/ます/た`, counters, numerals, proper nouns
  are not bank items. Without a closed-class allowlist almost no sentence
  passes; with a loose one the i+1 guarantee quietly weakens. The allowlist is
  a design artefact and must be checked in and reviewed, not inferred.
- **Lemma → item mapping.** `食べました` → `食べる`; `勉強する` vs analyser
  `勉強`+`する`; multi-form entries (`足; 脚`); `～` placeholders (`～か月`);
  homograph collisions.
- **Acceptance test.** ~50 hand-verified sentence→item-list pairs, checked in
  as golden data. Per the repo's own rule, this fixture comes from human
  verification, never from the pipeline's own output.
- **Translation choice.** Many jpn sentences link to several eng translations,
  some indirectly. Pick one, deterministically, and record the rule.
- **Attribution.** CC BY is per-author. Sentence ids resolve to authors, so
  keeping ids is likely sufficient — `data/SOURCES.md` must state that
  reasoning explicitly rather than leave it implied.

## 4. Schema

```sql
CREATE TABLE sentences (
  id        INTEGER PRIMARY KEY,   -- Tatoeba id: attribution + blacklisting
  ja        TEXT NOT NULL,
  en        TEXT NOT NULL,
  n_items   INTEGER NOT NULL,      -- bank items it contains
  n_unheard INTEGER NOT NULL       -- of those, how many are not yet known-by-ear
);
CREATE TABLE sentence_items (
  sentence_id INTEGER NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id)     ON DELETE CASCADE,
  PRIMARY KEY (sentence_id, item_id)
);
CREATE INDEX idx_sentence_items_item ON sentence_items(item_id, sentence_id);
CREATE INDEX idx_sentences_ready     ON sentences(n_unheard, n_items);
```

**`n_unheard` is materialised, not computed per query.** A correlated
`NOT EXISTS` over candidate sentences is the exact shape that caused the 29x
regression fixed by `idx_reviews_item` (`db.ts:77-81`). Pay at write time.

**The decrement fires at graduation, not at introduction.** Revision 2 hooked
the `introduced` 0→1 flip — but `grade()` sets `introduced = 1` on the *first*
review, while the card is still in `learning` walking steps `[1m, 10m]`
(`fsrs.ts:69`). Hooking there implements "introduced", which is precisely the
predicate §2 exists to reject: a word heard once, sixty seconds ago, would
count as known by ear. Worse, a word the learner keeps failing never leaves
learning, so the words *least* known by ear would be admitted first.

The correct event is `before.state === 'learning' && after.state === 'review'`,
conditioned on `q.mode === 'listening'`. This is safe as a one-way counter
because FSRS state transitions are monotone here: a lapse goes
`review → relearning` (`fsrs.ts:221-223`), never back to `learning`. So
"has graduated" never un-flips and a single decrement is correct.

Eligibility for target item X, without reintroducing a correlated subquery:
look up X's own known-by-ear status once per call, then

- X known    -> require `n_unheard = 0`
- X unknown  -> require `n_unheard = 1`

because X ∈ sentence ∧ X unheard ∧ `n_unheard = 1` entails the single unheard
item *is* X. Two-case dispatch, both indexable.

**`grade()` must become transactional.** It runs `UPDATE cards` and
`INSERT reviews` as separate statements (`quiz.ts:302-309`); a crash between
them costs one log row today. A missed decrement on a monotone counter is
permanent, silent drift — sentences that never become eligible, invisible to
every test. Wrap it, and make the importer's recompute double as the repair
path with an invariant test sampling `n_unheard` against ground truth.

**Import must recompute, never preserve.** How `data/sentences.json` reaches
SQLite is a real design task, not a detail: which command loads it, whether
reload is idempotent, and that import initialises `n_unheard` from the *current*
cards state. Re-import after a corpus update recomputes.

## 5. Code changes

`src/sentences.ts` (new) — `pickSentence(db, itemId)`, returning the shortest
eligible sentence, deterministic tiebreak by id. Returns null when none.

`src/quiz.ts` — `buildQuestion` case `"listening"` sets `audioText` to the
sentence when one exists, the word otherwise. Add `sentenceId` to `Question`
so it survives `pending` and `--json`, for blacklisting and stats.

**Choices are NOT unchanged.** Revision 2 said they were, and that is a bug.
With a word stimulus, "what did you hear" is unambiguous. With a sentence, the
learner hears five or more words and must infer which one is the target — in
practice, "the choice matching something I heard". `distractors()` excludes
only the target's own meaning (`bank.ts:161`), drawing the rest at random from
the same level, so eventually a distractor *is* the meaning of a context word
in that sentence. Then two choices are things the learner heard, and perfect
comprehension grades as Again — manufacturing wrong answers out of right ones,
corrupting exactly the signal this design exists to protect.

Fix: exclude the meanings of every item in the sentence from the distractor
pool (`sentence_items` is already in hand), and say what the task is:
"Which of these did you hear?"

**`reveal` must show the sentence.** It renders only word【reading】— meaning
(`quiz.ts:213`), so after a sentence stimulus the learner never sees the
sentence or its translation. The `en` column exists; use it.

`src/cli.ts` — already done, ahead of this plan: the three `q.mode ===
"listening"` comparisons are now `hasAudioStimulus(q)`, and the project has a
`tsconfig.json` and `bun run typecheck`, which found a live type error in
`cmdExam` that had been silently disabling voice rotation in mock exams.

**`reviews` needs a `sentence_id` column.** §5's own rollout verification —
"check the Hard rate against the review log" — is impossible without it, and so
is §0's promote-later criterion and §1's availability stat: the review log
(`quiz.ts:307-309`) records no stimulus. This is the repo's first schema
*migration*: `openDb` only does `CREATE TABLE IF NOT EXISTS` (`db.ts:25-82`),
which will not add a column to an existing `data/study.db` with real history.
Needs a guarded `ALTER TABLE` behind a `PRAGMA table_info` check. The new
tables are fine as-is.

**`cmdExam` must opt out, explicitly.** Exam questions flow through the same
`nextQuestion` -> `buildQuestion` path (`cli.ts:205-223`), so mock-exam
listening items would silently become sentence items — changing the exam's
calibration against the official word-level format mid-history and making
scores incomparable across the rollout. Either flag it off for exams or accept
it and say so. Deciding by accident is the only wrong option.

`ratingFor` (`quiz.ts:274-278`) rates any correct answer over 12s as Hard. A
sentence takes longer to process than a word, and in the TUI the `r` replay
counts against the same clock (`cli.ts:163-168`). Sentence-stimulus reviews
would be systematically rated Hard, compressing intervals and flooding the
queue. The threshold must scale with the stimulus, and this must be **verified
against the review log after rollout**, not assumed.

## 6. Phase 0: the gate

The gate metric in revision 1 — "% of the 1,384 bank words with at least one
fully-covered sentence" — measures a learner who already knows all 1,384 words.
It is not the binding constraint. Eligibility requires every *other* word
already known-by-ear, so the real question is coverage **conditional on the
learner's known set over time**.

The spike simulates the actual introduction schedule — N5 list order, the
deficit-driven mode mix, 12 new cards/day, the known-by-ear rule of §2 — and
reports, per day: how many introduced words have an eligible sentence, and how
many distinct eligible sentences exist. Same data, one extra loop. It also
replaces revision 1's guessed "enable at 100-150 words" with a derived date.

**Run the real engine, not a reimplementation.** The simulation has to
reproduce deficit-driven mode mix, sibling cooldown, `skip_meaning_for_kanji`
and graduation timing. Reimplementing that policy in the Python build tool
would drift from `quiz.ts`. Instead: a Bun script, `openDb` on a temp path,
`seed()`, then loop `nextQuestion`/`grade` against a simulated clock — the
repo's own rule of validating with the engine, and cheaper than a faithful
reimplementation.

**State the rating policy.** All-Good inflates known-set growth and biases the
gate optimistic in exactly the direction that passes it. Run a 90%-accuracy
variant alongside.

Gate on the **curve**, not one sample: report day 30 / 60 / 120. Target — at
least half of introduced listening cards have an eligible sentence, and the
pool sustains at least 5 sentence-stimulus questions per day. A corpus that is
thin at day 60 but rich at day 120 should pass with a later enable date, not
die. If no horizon reaches the target, corpus selection has failed on this bank
and Plan B (offline generation, native-checked) is on the table.

**Sequencing correction.** Revision 2 said nothing should be built before this
number exists. That understates it in one direction and overstates it in the
other: the number is only trustworthy *after* §3's tokenizer, allowlist and
50-pair golden fixture exist, because a broken lemma mapping corrupts coverage
silently in either direction. The fixture precedes the gate.

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Corpus too thin under the real schedule | kills the feature | Phase 0 gate, measured conditionally |
| Lemma→item mapping wrong | silently serves non-i+1 sentences | 50-pair hand-verified golden fixture |
| Function-word allowlist too loose | i+1 guarantee weakens invisibly | allowlist checked in and reviewed |
| Sentence reviews systematically rated Hard | queue floods | scale `ratingFor` by stimulus; verify against the review log — needs `reviews.sentence_id` |
| A distractor is a context word's meaning | manufactures wrong answers from right ones | exclude all sentence items from the distractor pool |
| Missed `n_unheard` decrement | permanent silent drift | transaction + recompute-on-import + invariant test |
| Correlated subquery in the selector | repeat of a known 29x regression | materialise `n_unheard`; assert query plan in a test |
| Tatoeba sentence quality uneven | medium | prefer short, high-link-count; keep ids so bad ones blacklist like `false_friends.txt` |
| CC BY attribution | legal | `data/SOURCES.md`, settled before corpus data is committed |
| TTS quota: ~30-char sentences vs ~3-char words | low | 0.5M/month ≈ 15k sentence clips; tracker already hard-stops |

## Already fixed (out of this plan's scope)

Review found that `introducedByMode` used `as Record<Mode, number>`, so adding
any fifth mode would have compiled clean with an undefined count, turning every
deficit into NaN and silently collapsing mode priority to declaration order.
Fixed and mutation-verified in `cf9cb76`. That commit's message overstates the
before-state: `db.ts:14` and `quiz.ts:13` already errored; only
`introducedByMode`'s site was silent. The hazard was the editing flow — fix the
two reported errors, and the cast stays quiet until runtime NaN.

Separately, the project now has `tsconfig.json` and `bun run typecheck`, which
immediately found a live type error disabling voice rotation in mock exams, and
the mode-string audio checks became `hasAudioStimulus(q)`. Both landed ahead of
this plan.
