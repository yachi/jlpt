# JLPT N5 → N4 study CLI

A terminal study program for JLPT N5/N4: FSRS-6 scheduling, JLPT-format multiple choice,
Japanese listening practice via Azure neural TTS (free tier) with an offline macOS fallback,
and mock exams scored against the **real** sectional pass floors.

## Why this exists

The JLPT has published **no syllabus since 2010**. The *Test Content Specification* (出題基準,
1994, revised 2004) was withdrawn, and JLPT explicitly declines to publish kanji/vocabulary/grammar
lists ([FAQ](https://www.jlpt.jp/e/faq/index.html)). Every "N4 word list" — including the one this
program ships — is a reconstruction of that dead document, which itself admitted **~20% of any exam
came from outside its own lists**.

So this tool optimizes for the two things that *are* officially specified and that actually decide
pass/fail:

| | N5 | N4 |
|---|---|---|
| Pass mark | 80/180 | 90/180 |
| Language Knowledge + Reading | 0–120, **floor 38** | 0–120, **floor 38** |
| Listening | 0–60, **floor 19** | 0–60, **floor 19** |

Both floors must be cleared *and* the total met. **120/120 on reading with 18/60 on listening = 138
points = fail.** That is the single most common way candidates lose N4, so listening is a first-class
mode here, not an afterthought.

## Quick start

```fish
cd ~/codes/jlpt
bun run seed          # load the item bank (once) — 1,384 words, 5,257 cards
bun run study         # go
```

No dependencies to install to study. No API key required — it falls back to the installed macOS
Japanese voices. (`bun install` is only needed for `bun run typecheck`.)

A new word is **taught before it is tested**: the first time a card comes up it shows (and speaks)
the word with its reading and meaning, and the first real question lands about ten minutes later.
Asking a never-seen word measures nothing — "I don't know" is the only honest answer — so it is
not a review. Turn this off with `bun run cli set teach_new_first 0`; mock exams never teach.

## Commands

```fish
bun run study --level n5 --mode listening --n 20
bun run cli next                  # show the next due card
bun run cli answer 3              # answer it (1-4, or type kana/romaji for production cards)
bun run cli answer --dont-know    # "I don't know" — also `answer '?'`, or `?` at the study prompt
bun run cli seen                  # acknowledge a new word that was taught rather than asked
bun run cli exam --level n5       # mock exam scored against the real floors
bun run cli stats                 # progress, weakest mode, TTS quota used
bun run cli tts "おはようございます"
bun run cli set new_per_day 8     # daily new-card limit (default 5)
bun run cli import-sentences      # load the sentence corpus (--check verifies without writing)
bun test                          # the full suite; offline, no key needed
bun run typecheck                 # tsc --noEmit
```

### Studying with Claude in this repo

`next` and `answer` accept `--json`, and `next --json` **withholds the answer key**, so Claude can
serve you questions conversationally without seeing the answer:

```fish
bun run cli next --json
bun run cli answer 2 --json
```

"I don't know" is a first-class answer (`--dont-know`), graded as Again, so admitting it never means
submitting a knowingly-wrong choice into the review log.

## The four modes

Each `(word, mode)` pair is scheduled as its own FSRS card, so your listening can be weak while your
reading is strong and the scheduler responds to each independently.

| Mode | Question | Mirrors | Section |
|---|---|---|---|
| `meaning` | word → 4 English choices | 語彙 | Knowledge |
| `reading` | kanji → 4 kana readings | 漢字読み | Knowledge |
| `listening` | **audio only** → 4 meanings | 聴解 | Listening |
| `production` | English → type the kana | (none — deeper encoding) | Knowledge |

`production` accepts Hepburn romaji as well as kana (`taberu`, `gakkou`), because without a Japanese
IME a quarter of the bank would be unanswerable. Any accepted written form of the answer counts.

### If you already read Chinese

80% of the N5/N4 bank is written with kanji, and for a Chinese/Cantonese reader
"what does 秋 mean?" is a free point. Turn those cards off:

```fish
bun run cli set skip_meaning_for_kanji 1
```

New `meaning` cards are then skipped for kanji words — **1,067 of 5,257 cards, about
7 months of study at 5 cards/day** — while `reading`, `listening` and `production` are
kept, because a kanji background does nothing for those.

Two exceptions stay on:

- **Kana-only words** (ああ, すっと) — no kanji to lean on.
- **Sino-Japanese false friends**, listed in `data/false-friends.txt` — 手紙 (letter, not
  廁紙), 娘 (daughter, not mother), 走る (to run, not to walk), 湯 (hot water, not soup),
  丈夫 (sturdy, not husband)… Here the kanji background actively misleads, so the meaning
  card earns its place.

Add to that file whenever a word tricks you. A test asserts every line matches a real
item, so a typo fails the suite instead of silently doing nothing.

Multiple choice is the dominant format on purpose: the JLPT is 100% multiple choice, and the largest
meta-analysis of practice testing (Adesope, Trevisan & Sundararajan 2017, *Review of Educational
Research* 87, 659–701; 188 experiments, 272 effect sizes) found MC practice tests produce a **larger**
effect (*d* = +0.70) than short-answer (*d* = +0.48). `production` exists because format variety and
generation still add encoding depth that pure recognition misses.

## Scheduling

FSRS-6, ported directly from the reference implementation
([open-spaced-repetition/py-fsrs](https://github.com/open-spaced-repetition/py-fsrs), MIT).

The port is **differentially tested against the real Python package**: `data/fsrs-golden.json` is
generated by running py-fsrs itself over six rating sequences, and `src/fsrs.test.ts` asserts this
port reproduces stability, difficulty, state, step and interval exactly at every step.

```fish
uv run tools/gen-fsrs-fixture.py > data/fsrs-golden.json   # regenerate from upstream
bun test                                                    # must stay green
```

> Ported from source, not from prose. Multiple third-party write-ups of FSRS-6 state the stability
> formulas incorrectly — the golden fixture is what makes this trustworthy.

Ratings are derived from your answer, so there is no self-grading step:

| Outcome | FSRS rating |
|---|---|
| Wrong | 1 Again |
| Right but slow (>12 s) | 2 Hard |
| Right | 3 Good |
| Right, `--easy` | 4 Easy |

## Azure Speech (optional)

Without a key the CLI rotates the installed macOS ja_JP voices (`Kyoko,Eddy,Flo,Reed,Sandy,Shelley`;
override with `MACOS_JA_VOICES=...`). With one you get ja-JP neural voices.

```fish
cp .env.example .env
# then edit .env:
#   AZURE_SPEECH_KEY=<your key>
#   AZURE_SPEECH_REGION=japaneast
#   AZURE_SPEECH_VOICE=ja-JP-NanamiNeural
```

Free (F0) tier limits, all enforced client-side:

| Limit | Value | Handling |
|---|---|---|
| Neural TTS | 500,000 chars/month | tracked in `data/tts-usage.json`; falls back to macOS at the cap |
| TTS requests | 20 per 60 s (not adjustable) | token bucket |
| Batch synthesis | unavailable on F0 | uses the real-time endpoint |

Every clip is cached to `audio/`, so a word costs characters exactly **once**. Practical effect: the
entire 1,384-word bank is roughly 4,000 characters — under **1%** of one month's free quota.

Voices rotate per card, Azure included: by default eight ja-JP neural voices, four female and four
male (`NanamiNeural`, `AoiNeural`, `MayuNeural`, `ShioriNeural`, `KeitaNeural`, `DaichiNeural`,
`NaokiNeural`, `MasaruMultilingualNeural`; override with `AZURE_SPEECH_VOICES=a,b,c`). One speaker
trains recall of a waveform, not discrimination of phonemes, and the real exam is multi-speaker.
Setting `AZURE_SPEECH_VOICE` pins a single voice.

## Sentences in listening (off by default)

A `listening` card can play a whole Tatoeba sentence instead of the bare word, when every other word
in that sentence is one you already know by ear (i+1). Same card, same FSRS state, same question —
only the stimulus changes. The corpus is selected, never generated, and is attributed in
`data/CREDITS.md`.

```fish
bun run cli import-sentences          # load data/sentences.json
bun run cli set sentence_listening 1  # turn it on
```

It stays off until your known-by-ear vocabulary is deep enough for most cards to find a sentence.
Once about half your introduced listening cards have one, `stats` and `study` print a one-time
reminder to turn it on. Design, measurements and the review history: `.goal/sentence-mode-plan.md`.

## Calibrating against reality

This program's mock exam is an *estimate* built on an unofficial word list. The only ground truth is
the free official material. Download both official practice workbooks:

```fish
mkdir -p official; cd official
for lvl in N5 N4
    for part in V G R L
        curl -sSLO "https://www.jlpt.jp/samples/sample2018/pdf/$lvl$part.pdf"
    end
    for q in 1 2 3 4
        curl -sSLO "https://www.jlpt.jp/samples/sample2018/mp3/$lvl"Q"$q.mp3"
    end
end
```

Swap `sample2018` for `sample2012` to get the second set. There are only two — don't burn them early.

## Fixing bad data

The CSVs are the external oracle and are never edited or regenerated from code. Corrections live
beside them, each checked rather than trusted:

- `data/gloss-corrections.csv` — overrides a wrong upstream gloss. Its `was` column names the
  upstream value, so if upstream changes the row is reported **stale** and skipped instead of
  silently re-breaking a fixed gloss.
- `data/sentence-blacklist.txt` — Tatoeba sentence ids to drop; re-run `bun run cli import-sentences`.
- `data/false-friends.txt` — see above.

## Development

```fish
bun test             # whole suite, offline
bun run typecheck    # needs `bun install` once, for typescript
```

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs typecheck and the tests on every push
and pull request. It sets no Azure key, and the TTS tests that need macOS `say` skip on Linux, so CI
runs fully offline.

Open work, and the evidence behind each fix already made, is in `.goal/ROADMAP.md`.

## Data & licences

- Vocabulary: [open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks) (MIT),
  derived from tanos.co.uk lists reconstructing the withdrawn 2004 出題基準. **Unofficial.**
- Scheduler: FSRS-6 ported from [py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) (MIT).
- Sentences: [Tatoeba](https://tatoeba.org) (CC BY 2.0 FR); contributors are named in `data/CREDITS.md`.

## Layout

```
src/fsrs.ts        FSRS-6 scheduler (port; differentially tested)
src/db.ts          SQLite schema (bun:sqlite)
src/bank.ts        CSV loading, distractor selection, gloss corrections
src/tts.ts         Azure TTS + quota ledger + rate limit + voice rotation + macOS fallback
src/quiz.ts        question generation, teach-first, grading, scheduling glue
src/romaji.ts      romaji -> kana for production answers
src/sentences.ts   sentence-stimulus import, selection and the turn-on reminder
src/cli.ts         commands
src/*.test.ts      tests (fsrs.test.ts is the golden-fixture test vs the reference)
tools/             uv/bun scripts: FSRS fixture, sentence corpus build, coverage
                   measurement and the phase-0 schedule simulation
data/              item bank, corrections, false friends, sentence corpus + blacklist,
                   golden fixtures, CREDITS.md, study.db (gitignored)
.goal/             ROADMAP.md (open work, newest first) and the sentence-mode plan
.github/           CI workflow
audio/             TTS cache (gitignored)
```
