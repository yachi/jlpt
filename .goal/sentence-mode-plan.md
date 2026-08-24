# Plan: sentences in listening practice

Revision 4. Phases 0 and 1 are done and are recorded here as results, not
intentions. What remains is Phase 2, the runtime.

| Rev | What changed |
|-----|--------------|
| 1 | A fifth scheduled mode. Adversarial review found three fatals. |
| 2 | Reframed: better stimulus for the existing listening card. |
| 3 | Second review: hook fired at the wrong event, three correctness gaps. |
| 4 | Phases 0-1 executed. The justification was wrong and is replaced. |

## 0. Two reframes

**Do not generate Japanese, select it.** A template generator produces
grammatical but unnatural Japanese, and training listening on unnatural
prosody teaches the wrong target.

Offline LLM generation constrained to the learner's vocabulary, native-checked
and checked in as static data, remains a legitimate Plan B. Corpus went first
because it is cheaper and licence-clean, not because generation is
illegitimate. The gate passed, so Plan B stays unused.

**This is not a new mode. It is a better stimulus for an existing one.** A
`listening` card plays one word (`quiz.ts:231`). When an eligible sentence
exists for that word, play the sentence and ask the same question. Same card,
same FSRS state, same grading, same mode. That dissolved every fatal revision
1 had — no orphan cards to jam the queue, no `Record<Mode>` churn, no weight
migration, no dilution of the shared new-card limit.

## 0b. Why this works — corrected

Revisions 1-3 justified the design by Krashen's i+1. **That justification is
wrong and has been removed.** The input hypothesis is criticised for lacking
empirical content and falsifiability, and studies of input pitched exactly at
i+1 give mixed results ([Lai, TPLS 9/11](https://www.academypublication.com/issues2/tpls/vol09/11/13.pdf);
[Frontiers in Psychology, 2025](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1636777/full)).
Calling it "the established method" was overclaiming.

The design does not need it. It rests on **measurement validity**: a listening
question is only valid if failure is attributable to the target word rather
than to vocabulary the learner never studied.

van Zeeland & Schmitt (2013), *Applied Linguistics* 34(4), 457-479
([doi:10.1093/applin/ams074](https://academic.oup.com/applij/article-abstract/34/4/457/199564))
put the lexical coverage threshold for adequate listening comprehension near
95%, with comprehension rising 7.35 / 7.65 / 8.22 / 9.62 out of 10 at 90 / 95 /
98 / 100% coverage. This design uses 100% coverage, above the optimum — right
for attribution, and openly easier than the exam.

Honest limits: those thresholds were measured on continuous text, not on
four-word sentences, so the principle transfers but the unit does not.

## 1. Goals / non-goals

Goals
- When a `listening` card is due and an i+1 sentence exists for its item, the
  stimulus is that sentence.
- "Known" means known **by ear**, not merely introduced.
- Sentences are real, externally sourced, licence-clean, checked in. **Done.**
- `stats` reports sentence availability, so the premise stays measured.

Non-goals
- **Training the learner to cope with unknown words.** At 100% coverage,
  comprehension is near ceiling. This trains recognising known words in
  connected speech — one rung, not the destination. The exam is dialogue, with
  distraction and coverage well under 100%.
- A fifth mode. Deferred until data shows word- and sentence-listening
  retention diverge.
- Cloze. Revision 1's version left the target audible while blanking it in
  text. A real cloze is a reading task and belongs to `reading`.
- MC over whole-sentence translations. Random Tatoeba translations are so
  unrelated that one content word solves the item.
- Multi-speaker dialogue. Separate project.

## 2. Known by ear

A context word counts as known only if its `listening` card has **graduated
initial learning** — `introduced = 1 AND state <> 'learning'`.

`relearning` counts as known: the word was parseable once, and excluding
lapsed words would churn hundreds of counter rows per lapse of a common word.

Revision 2 stated this rule and then maintained it at the wrong event. See §4.

## 3. Corpus — DONE

`tools/build_sentences.py`, a PEP 723 uv script mirroring
`tools/gen-fsrs-fixture.py`: run the real analyser offline, check in the
result, keep the runtime dependency-free.

`data/sentences.json` — 43,478 sentences, median 3 content words, 83.2% of
bank words targetable, 61.7% containing a kana homophone (context-only).

`data/CREDITS.md` — 633 named contributors. CC BY 2.0 FR requires credit to the
creator; a source link alone does not satisfy it, contrary to what revision 3
assumed. Sentence ids are kept and resolve to the originals.

Every question revision 3 left open is now answered:

- **Function words.** Particles, auxiliaries and punctuation are ignored.
  The allowlist is proper nouns (katakana only) and numerals, chosen by
  measurement: affixes and non-independent verbs bought 2.1pp of sentences for
  the price of admitting grammar the learner has not studied.
- **Lemma to item.** `orthBase` first, contextual `kana` to disambiguate,
  reading-only matching restricted to kana-written words, counters split from
  standalone nouns by POS.
- **Acceptance test.** 56 hand-verified pairs across seven failure modes,
  locked by `src/sentences.test.ts`.
- **Translation choice.** Lowest linked English id: deterministic, and the
  oldest translation is usually the most reviewed.

Six defects were found by reading sample mappings by hand, every one invisible
in the aggregate numbers: a suffix resolved to the wrong reading, multi-form
readings never matching, a mis-tagged proper noun admitting an out-of-bank
word, a kana token guessing a kanji entry, dual-reading words served as
targets, and a word landing in both the certain and ambiguous lists. Together
they cost 1.2 points of gate coverage.

## 4. Runtime — Phase 2, TO BUILD

```sql
CREATE TABLE sentences (
  id        INTEGER PRIMARY KEY,   -- Tatoeba id: attribution + blacklisting
  ja        TEXT NOT NULL,
  en        TEXT NOT NULL,
  author    TEXT,
  n_items   INTEGER NOT NULL,
  n_unheard INTEGER NOT NULL       -- of those, not yet known by ear
);
CREATE TABLE sentence_items (
  sentence_id INTEGER NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id)     ON DELETE CASCADE,
  ambiguous   INTEGER NOT NULL DEFAULT 0,   -- context-only, never a target
  PRIMARY KEY (sentence_id, item_id)
);
CREATE INDEX idx_sentence_items_item ON sentence_items(item_id, sentence_id);
```

**`n_unheard` is materialised.** A correlated `NOT EXISTS` per candidate is the
shape that caused the 29x regression fixed by `idx_reviews_item`
(`db.ts:77-81`). Pay at write time.

**The decrement fires at graduation, not introduction.** `grade()` sets
`introduced = 1` on the FIRST review, while the card is still walking learning
steps `[1m, 10m]` (`fsrs.ts:69`). Hooking there implements "introduced" — the
predicate §2 exists to reject — and worse, a word the learner keeps failing
never leaves learning, so the words least known by ear would be admitted
first. The correct event is `before.state === 'learning' && after.state ===
'review'`, conditioned on `q.mode === 'listening'`. Safe as a one-way counter:
a lapse goes `review -> relearning` (`fsrs.ts:221-223`), never back to
`learning`.

**Eligibility, without a correlated subquery.** Look up the target's own
known-by-ear status once per call, then

- target known   -> require `n_unheard = 0`
- target unknown -> require `n_unheard = 1`

because target ∈ sentence ∧ target unheard ∧ `n_unheard = 1` entails the one
unheard item is the target.

**`grade()` must become transactional.** It runs `UPDATE cards` and
`INSERT reviews` separately (`quiz.ts:302-309`). A missed decrement on a
monotone counter is permanent, silent drift. Wrap it; make the importer's
recompute the repair path; add an invariant test sampling `n_unheard` against
ground truth.

**Import recomputes, never preserves.** Which command loads the JSON, whether
reload is idempotent, and that `n_unheard` is initialised from the CURRENT
cards state.

**`reviews` needs `sentence_id`.** Without it the Hard-rate check below, the
promote-later criterion and the availability stat are all impossible — the
review log records no stimulus (`quiz.ts:307-309`). This is the repo's first
schema MIGRATION: `openDb` only does `CREATE TABLE IF NOT EXISTS`
(`db.ts:25-82`) and will not add a column to an existing `study.db`. Needs a
guarded `ALTER TABLE` behind `PRAGMA table_info`.

**Choices are NOT unchanged.** With a word stimulus "what did you hear" is
unambiguous; with a sentence the learner must infer which word is the target.
`distractors()` excludes only the target's own meaning (`bank.ts:161`), so
eventually a distractor IS the meaning of a context word — two choices are then
things the learner heard, and perfect comprehension grades as Again. Exclude
the meanings of every item in the sentence, and name the task: "Which of these
did you hear?"

**`reveal` must show the sentence.** It renders only word / reading / meaning
(`quiz.ts:213`). The `en` column exists.

**`ratingFor` must scale with the stimulus.** Any correct answer over 12s is
rated Hard (`quiz.ts:278-282`), and a sentence takes longer than a word; the
TUI's `r` replay counts against the same clock. Verify against the review log
after rollout — which is why `sentence_id` is not optional.

**`cmdExam` must opt out, explicitly.** Exam items flow through the same
`nextQuestion` -> `buildQuestion` path (`cli.ts:205-223`), so mock-exam
listening would silently become sentence listening, changing calibration
mid-history. Deciding by accident is the only wrong option.

## 5. Gate — PASSED

Static coverage answers "for a learner who knows all 1,384 words". The binding
question is coverage conditional on the known set over time, so
`tools/simulate_gate.ts` drives the real engine — `seed`, `nextQuestion`,
`grade` against a simulated clock — rather than reimplementing the policy.

90% accuracy, the user's real configuration:

| day | listening cards | with a sentence | % | distinct sentences |
|-----|-----------------|-----------------|---|--------------------|
| 15  | 81  | 25  | 30.9% | 18  |
| 30  | 162 | 75  | 46.3% | 54  |
| 60  | 324 | 206 | 63.6% | 163 |
| 90  | 486 | 368 | 75.7% | 297 |
| 120 | 648 | 516 | 79.6% | 417 |

Threshold: >=50% by day 60, sustaining >=5 questions/day. **63.6% and 163
sentences. Passed.**

A 50%-accuracy control confirms the simulation exercises the scheduler: the
queue saturates and new-card introduction flatlines at 380 instead of 648. The
100% and 90% runs agree closely because new cards are limit-bound at 12/day.

## 6. Timing

Enable around **day 30-45**, when roughly half of listening cards have a
sentence. The learner is on day 3.

## 7. Risks

| Risk | Severity | Status |
|---|---|---|
| Corpus too thin under the real schedule | killed the feature | **retired** — gate passed |
| Lemma-to-item mapping wrong | serves non-i+1 sentences | **retired** — 56-pair fixture, 6 defects fixed |
| CC BY attribution | legal | **retired** — CREDITS.md, 633 named |
| TTS reads a word differently from our annotation | wrong audio | **retired for single words** (`b047349`); for sentences, dual-reading words cannot be targets |
| Sentence reviews systematically rated Hard | queue floods | open — needs `reviews.sentence_id` |
| Distractor is a context word's meaning | manufactures wrong answers | open — exclude all sentence items |
| Missed `n_unheard` decrement | permanent silent drift | open — transaction + recompute + invariant test |
| Tatoeba sentence quality uneven | medium | open — ids kept, blacklist like `false_friends.txt` |
| TTS quota, ~30-char sentences | low | 0.5M/month is ~15k clips; tracker hard-stops |

## Landed ahead of this plan

- `cf9cb76` — a missing mode is a compile error, not a NaN cascade.
- `f0d74c8` — `tsconfig.json` and `bun run typecheck`; found a live type error
  that had disabled voice rotation in mock exams. Audio playback now asks
  `hasAudioStimulus(q)` instead of comparing mode strings in three places.
- `b047349` — listening cards synthesized the WRITTEN form, so both cards of
  the nine dual-reading entries played identical audio while expecting
  different answers: 開く【あく】 played ひらく. Measured with Azure
  pronunciation assessment, fixed by synthesizing the reading, verified the
  same way.
- `0f25784` — the corpus, credits and fixture above.
