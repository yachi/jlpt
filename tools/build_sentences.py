# /// script
# requires-python = ">=3.11"
# dependencies = ["fugashi[unidic-lite]"]
# ///
"""
Build the sentence corpus for i+1 listening practice.

Emits, for every Tatoeba jpn sentence that (a) has an English translation and
(b) contains no content word outside the N5/N4 bank:

    {id, ja, en, items[], ambiguous[]}

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
BANK = json.loads((SCRATCH / "bank.json").read_text())

TILDES = "～〜~〰"
# Particles, auxiliaries and punctuation are never bank items and carry no
# lexical burden.
IGNORE_POS = {"助詞", "助動詞", "補助記号", "空白"}
K2H = str.maketrans({chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)})

def norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()

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
    r = norm(it["reading"]).strip(TILDES)
    k_tbl.setdefault(r, set()).add(it["id"])
    READING[it["id"]] = r

# Allowlist, chosen by measurement (tools/measure_coverage.py): proper nouns and
# numerals are not a vocabulary burden -- a name or a number is not a word you
# have to have studied. Affixes and non-independent verbs were measured and
# rejected: +2.1pp of sentences for the price of admitting real grammar.
def allowlisted(f) -> bool:
    return (f.pos1 == "名詞" and getattr(f, "pos2", "") == "固有名詞") \
        or getattr(f, "pos2", "") == "数詞" or f.pos1 == "数詞"

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
                lf = norm((getattr(f, "lForm", None) or "").translate(K2H))
                narrowed = {i for i in hit if READING.get(i) == lf}
                hit = narrowed or hit
            (certain if len(hit) == 1 else ambiguous).update(hit)
            continue

        if is_kana(ob):
            # Reading is a valid key only when the word is written in kana.
            # Applying it to kanji matches unrelated homophones (機 -> 木, 気).
            lf = norm((getattr(f, "lForm", None) or "").translate(K2H))
            hit = k_tbl.get(lf) or k_tbl.get(ob)
            if hit:
                (certain if len(hit) == 1 else ambiguous).update(hit)
                continue

        if is_sfx and (hit := exact.get(ob)):
            (certain if len(hit) == 1 else ambiguous).update(hit)
            continue

        if allowlisted(f):
            continue
        unmatched.append(ob)
    return certain, ambiguous, unmatched

def load_tsv(path, sep="\t", n=2):
    for line in open(path, encoding="utf-8"):
        yield line.rstrip("\n").split(sep, n)

def main():
    jpn = {int(a): c for a, _b, c in load_tsv(SCRATCH / "tatoeba/jpn_sentences.tsv")}
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
        out.append({
            "id": sid, "ja": ja, "en": eng[en_id], "enId": en_id,
            "items": sorted(certain), "ambiguous": sorted(ambiguous),
        })

    out.sort(key=lambda s: (len(s["items"]) + len(s["ambiguous"]), s["id"]))
    OUT.write_text(json.dumps(out, ensure_ascii=False))

    tot = len(out)
    with_amb = sum(1 for s in out if s["ambiguous"])
    items = {i for s in out for i in s["items"]}
    print(f"sentences kept          {tot}")
    print(f"  containing ambiguity  {with_amb} ({with_amb/tot:.1%})")
    print(f"bank words targetable   {len(items)}/{len(BANK)} ({len(items)/len(BANK):.1%})")
    print(f"median items/sentence   "
          f"{sorted(len(s['items']) for s in out)[tot//2]}")
    print(f"written to {OUT} ({OUT.stat().st_size/1048576:.1f} MB)")

main()
