# /// script
# requires-python = ">=3.11"
# dependencies = ["fugashi[unidic-lite]"]
# ///
"""
Build the sentence corpus for i+1 listening practice.

Emits, for every Tatoeba jpn sentence that (a) has an English translation,
(b) contains no content word outside the N5/N4 bank, and (c) carries at least
MIN_ITEMS content words:

    {id, ja, en, author, items[], ambiguous[]}

MIN_ITEMS exists because ordering by shortest-eligible otherwise selects
one-word sentences -- "Aki desu ne." for the target 秋 -- which carry no
context and teach nothing the single-word stimulus did not. Measured: the
floor costs coverage at day 30 (66.7% -> 46.3%) and almost nothing by day 120
(82.3% -> 81.6%).

`author` is the Tatoeba contributor, required by CC BY 2.0 FR: appropriate
credit means the creator's name, and a source link alone does not satisfy it.
None means the sentence has no recorded owner; credit goes to Tatoeba.

`items` are bank ids the sentence definitely contains. `ambiguous` are ids
reached through a kana-written homophone (いる = 居る or 要る): the learner
needs one of them to parse the audio, but the sentence cannot be said to
teach any particular one, so they may serve as context and never as a target.

Usage: uv run tools/build_sentences.py <scratch-dir> <out.json>
"""
import json, sys, unicodedata
from pathlib import Path
from fugashi import Tagger

SCRATCH, OUT = Path(sys.argv[1]), Path(sys.argv[2])
MIN_ITEMS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
CREDITS = OUT.parent / "CREDITS.md"
BANK = json.loads((SCRATCH / "bank.json").read_text())

TILDES = "～〜~〰"
# Particles, auxiliaries and punctuation are never bank items and carry no
# lexical burden.
IGNORE_POS = {"助詞", "助動詞", "補助記号", "空白"}
K2H = str.maketrans({chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)})

def norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()

def is_katakana(s: str) -> bool:
    return s != "" and all("ァ" <= c <= "ヿ" or c in "ー・" for c in s)

def is_kana(s: str) -> bool:
    return s != "" and all(
        "ぁ" <= c <= "ゟ" or "ァ" <= c <= "ヿ" or c == "ー"
        for c in s)

def forms(expression: str):
    """'足; 脚' lists two writings of one word; '~か月' uses a placeholder."""
    for part in expression.replace("／", "/").replace("；", ";").split(";"):
        for sub in part.split("/"):
            f = norm(sub).strip(TILDES)
            if f:
                yield f

# Counters and suffixes are different words from the standalone noun and UniDic
# labels which one a token is, so they get their own tables.
exact, exact_sfx, kana, kana_sfx = {}, {}, {}, {}
READING = {}
for it in BANK:
    sfx = it["expression"].lstrip()[:1] in TILDES
    e_tbl, k_tbl = (exact_sfx, kana_sfx) if sfx else (exact, kana)
    for f in forms(it["expression"]):
        e_tbl.setdefault(f, set()).add(it["id"])
    # Readings are lists too ("なん; なに", "いく; ゆく"). Index every form, and
    # keep the whole set for disambiguation -- comparing against the joined
    # string never matches, so the narrowing silently did nothing.
    rs = {norm(x).strip(TILDES) for x in it["reading"].replace("／","/").replace("；",";").split(";")
          for x in x.split("/") if norm(x).strip(TILDES)}
    for r in rs:
        k_tbl.setdefault(r, set()).add(it["id"])
    READING[it["id"]] = rs

# Allowlist, chosen by measurement (tools/measure_coverage.py): proper nouns and
# numerals are not a vocabulary burden -- a name or a number is not a word you
# have to have studied. Affixes and non-independent verbs were measured and
# rejected: +2.1pp of sentences for the price of admitting real grammar.
def allowlisted(f, surface: str) -> bool:
    """Words that are not a vocabulary burden even though they are not studied.

    Proper nouns must ALSO be written in katakana. unidic-lite tags plain
    common nouns as proper: 蝶々 (butterfly) comes back 固有名詞-人名, and the
    pos3 subtype does not separate it from トム. A katakana proper noun is
    transparently a foreign name to any learner; a kanji one may just be a
    mis-tagged word the learner has never seen, which is exactly what the i+1
    filter exists to exclude.
    """
    if f.pos1 == "名詞" and getattr(f, "pos2", "") == "固有名詞":
        return is_katakana(surface)
    return getattr(f, "pos2", "") == "数詞" or f.pos1 == "数詞"

# Written forms with more than one reading in the bank (開く = あく/ひらく).
# The TTS picks one, so these can never be a sentence's target word.
_by_expr: dict[str, set[int]] = {}
for it in BANK:
    _by_expr.setdefault(norm(it["expression"]), set()).add(it["id"])
MULTI_READ = {i for ids in _by_expr.values() if len(ids) > 1 for i in ids}

FORMS = {it["id"]: list(forms(it["expression"])) for it in BANK}

tagger = Tagger()

def analyse(text: str):
    """-> (certain_ids, ambiguous_ids, unmatched) for one sentence."""
    certain, ambiguous, unmatched = set(), set(), []
    for w in tagger(text):
        f = w.feature
        if f.pos1 in IGNORE_POS:
            continue
        ob = norm(getattr(f, "orthBase", None) or w.surface)
        is_sfx = f.pos1 == "接尾辞" or getattr(f, "pos2", "") == "助数詞"
        e_tbl, k_tbl = (exact_sfx, kana_sfx) if is_sfx else (exact, kana)

        hit = e_tbl.get(ob) or e_tbl.get(norm(w.surface))
        if hit:
            if len(hit) > 1:
                # 明日 is あした or あす; same kanji, different words by ear.
                # `kana` is the reading IN CONTEXT, `lForm` the dictionary
                # form's. Context wins: 外国人's 人 has lForm ニン but kana
                # ジン, and がいこくじん is what is actually said.
                ctx = norm((getattr(f, "kana", None) or "").translate(K2H))
                dict_form = norm((getattr(f, "lForm", None) or "").translate(K2H))
                narrowed = {i for i in hit if ctx in READING.get(i, ())} \
                    or {i for i in hit if dict_form in READING.get(i, ())}
                hit = narrowed or hit
            (certain if len(hit) == 1 else ambiguous).update(hit)
            continue

        if is_kana(ob):
            # Reading is a valid key only when the word is written in kana.
            # Applying it to kanji matches unrelated homophones (機 -> 木, 気).
            lf = norm((getattr(f, "lForm", None) or "").translate(K2H))
            hit = k_tbl.get(lf) or k_tbl.get(ob)
            if hit:
                # A kana token reaching a bank item that is normally written in
                # KANJI is a guess, not a match: せい in 私のせいじゃない is
                # 所為, not 背【せい】. Such hits are context-only.
                sure = {i for i in hit if any(is_kana(f2) for f2 in FORMS[i])}
                if sure and len(sure) == 1:
                    certain.update(sure)
                else:
                    ambiguous.update(hit)
                continue

        if is_sfx and (hit := exact.get(ob)):
            (certain if len(hit) == 1 else ambiguous).update(hit)
            continue

        if allowlisted(f, w.surface):
            continue
        unmatched.append(ob)
    # A word can appear twice, once written in kanji and once in kana (行く and
    # いく). The kanji occurrence settles it, so certainty wins over the guess.
    return certain, ambiguous - certain, unmatched

def load_tsv(path, sep="\t", n=2):
    for line in open(path, encoding="utf-8"):
        yield line.rstrip("\n").split(sep, n)

def main():
    # The detailed export carries the contributor name; the plain one does not.
    jpn, author = {}, {}
    for row in load_tsv(SCRATCH / "tatoeba/jpn_detailed.tsv", n=5):
        sid, _lang, text, owner = int(row[0]), row[1], row[2], row[3]
        jpn[sid] = text
        if owner and owner != "\\N":
            author[sid] = owner
    eng = {int(a): c for a, _b, c in load_tsv(SCRATCH / "tatoeba/eng_sentences.tsv")}

    # A jpn sentence often links to several English translations. Take the
    # lowest eng id: deterministic, and the oldest translation is usually the
    # most reviewed.
    link: dict[int, int] = {}
    for a, b in load_tsv(SCRATCH / "tatoeba/jpn-eng_links.tsv", n=1):
        a, b = int(a), int(b)
        if b in eng and (a not in link or b < link[a]):
            link[a] = b

    out = []
    for sid, ja in jpn.items():
        en_id = link.get(sid)
        if en_id is None:
            continue
        certain, ambiguous, unmatched = analyse(ja)
        if unmatched or not certain:
            continue
        if len(certain) + len(ambiguous) < MIN_ITEMS:
            continue
        # An item whose written form maps to more than one reading cannot be
        # the TARGET of a sentence: Azure renders 明日 as あした regardless of
        # UniDic reading it あす here, so the audio would not say the word the
        # card is asking about. Such items stay as context, where any of the
        # readings serves.
        certain, ambiguous = ({i for i in certain if i not in MULTI_READ},
                              ambiguous | {i for i in certain if i in MULTI_READ})
        if not certain:
            continue
        out.append({
            "id": sid, "ja": ja, "en": eng[en_id], "enId": en_id,
            "author": author.get(sid),
            "items": sorted(certain), "ambiguous": sorted(ambiguous),
        })

    out.sort(key=lambda s: (len(s["items"]) + len(s["ambiguous"]), s["id"]))
    OUT.write_text(json.dumps(out, ensure_ascii=False))

    tot = len(out)
    with_amb = sum(1 for s in out if s["ambiguous"])
    items = {i for s in out for i in s["items"]}

    names = sorted({s["author"] for s in out if s["author"]}, key=str.lower)
    anon = sum(1 for s in out if not s["author"])
    CREDITS.write_text(
        "# Sentence corpus credits\n\n"
        f"`sentences.json` contains {tot} Japanese sentences with English\n"
        "translations, taken from [Tatoeba](https://tatoeba.org) and filtered to\n"
        "those whose every content word is in this project's N5/N4 bank.\n\n"
        "Tatoeba's exports are released under\n"
        "[CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/deed.en),\n"
        "which requires appropriate credit to the creator - a source link alone\n"
        "does not satisfy it - so every contributor whose sentence appears is\n"
        "named below. Each sentence also keeps its Tatoeba id, which resolves to\n"
        "the original at `https://tatoeba.org/en/sentences/show/<id>`.\n\n"
        f"{anon} sentences have no recorded contributor in Tatoeba's export;\n"
        "credit for those goes to Tatoeba and its community.\n\n"
        f"## Contributors ({len(names)})\n\n"
        + ", ".join(names) + "\n")

    print(f"min content words       {MIN_ITEMS}")
    print(f"sentences kept          {tot}")
    print(f"  with named author     {tot - anon} ({(tot-anon)/tot:.1%})")
    print(f"  distinct contributors {len(names)}")
    print(f"  containing ambiguity  {with_amb} ({with_amb/tot:.1%})")
    print(f"bank words targetable   {len(items)}/{len(BANK)} ({len(items)/len(BANK):.1%})")
    print(f"median items/sentence   "
          f"{sorted(len(s['items']) for s in out)[tot//2]}")
    print(f"written to {OUT} ({OUT.stat().st_size/1048576:.1f} MB)")

main()
