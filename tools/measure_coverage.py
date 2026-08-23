# /// script
# requires-python = ">=3.11"
# dependencies = ["fugashi[unidic-lite]"]
# ///
"""
Phase 0 measurement, step 1: how well does the bank cover Tatoeba's Japanese?

Deliberately reports the top UNMATCHED content words rather than assuming a
function-word allowlist. The allowlist is a design artefact that decides
whether the i+1 guarantee holds, so it must be derived from what the corpus
actually contains, not guessed.
"""
import json, sys, unicodedata
from collections import Counter
from pathlib import Path
from fugashi import Tagger

SCRATCH = Path(sys.argv[1])
BANK = json.loads((SCRATCH / "bank.json").read_text())

# Particles, auxiliaries and punctuation carry no lexical content and are never
# bank items. Everything else must resolve to a bank item or the sentence is
# rejected -- no blanket allowlist until the data says which words need one.
IGNORE_POS = {"助詞", "助動詞", "補助記号", "空白"}

# Candidate tiers, each measured separately so the allowlist is a decision
# backed by a number rather than one lump of intuition. Every tier weakens the
# i+1 guarantee slightly -- it lets a word appear that the learner has not
# studied -- so each has to pay for itself.
TIERS = [
    ("proper nouns", lambda f: f.pos1 == "名詞" and getattr(f, "pos2", "") == "固有名詞"),
    ("numerals",     lambda f: getattr(f, "pos2", "") == "数詞" or f.pos1 == "数詞"),
    ("affixes",      lambda f: f.pos1 in ("接尾辞", "接頭辞")),
    ("aux verbs",    lambda f: f.pos1 == "動詞" and getattr(f, "pos2", "") == "非自立可能"),
]

KATA_TO_HIRA = str.maketrans(
    {chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)})

def norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()

def forms(expression: str):
    """Bank entries list alternatives in one field ('足; 脚') and use ~ as a
    placeholder ('~か月'). Yield each usable surface form."""
    for part in expression.replace("／", "/").replace("；", ";").split(";"):
        for sub in part.split("/"):
            f = norm(sub).replace("～", "").replace("~", "")
            if f:
                yield f

lookup: dict[str, set[int]] = {}
def add(key: str, item_id: int):
    if key:
        lookup.setdefault(key, set()).add(item_id)

for it in BANK:
    for f in forms(it["expression"]):
        add(f, it["id"])
    add(norm(it["reading"]), it["id"])

print(f"bank: {len(BANK)} items -> {len(lookup)} lookup keys", file=sys.stderr)

tagger = Tagger()

def analyse(text: str, tiers=()):
    """Return (item_ids, unmatched_surface_forms) for one sentence."""
    ids, unmatched = set(), []
    for w in tagger(text):
        f = w.feature
        if f.pos1 in IGNORE_POS:
            continue
        ob = norm(getattr(f, "orthBase", None) or w.surface)
        kana = norm((getattr(f, "lForm", None) or "").translate(KATA_TO_HIRA))
        hit = lookup.get(ob) or lookup.get(kana) or lookup.get(norm(w.surface))
        if hit:
            ids |= hit
            continue
        # Allowlist is a LAST resort, checked only after the bank lookup fails.
        # Checking it first silently drops bank items that happen to be proper
        # nouns (日本), numerals (一) or non-independent verbs (いる/ある/する),
        # which made relaxing the rules *lower* word coverage -- impossible,
        # and the signal that the order was wrong.
        if any(pred(f) for _, pred in tiers):
            continue
        unmatched.append(ob)
    return ids, unmatched

def main():
    sentences = {}
    with open(SCRATCH / "tatoeba/jpn_sentences.tsv", encoding="utf-8") as fh:
        for line in fh:
            sid, lang, text = line.rstrip("\n").split("\t", 2)
            sentences[int(sid)] = text

    linked = set()
    with open(SCRATCH / "tatoeba/jpn-eng_links.tsv", encoding="utf-8") as fh:
        for line in fh:
            a, _b = line.rstrip("\n").split("\t", 1)
            linked.add(int(a))

    texts = [t for sid, t in sentences.items() if sid in linked]
    print(f"\njpn sentences {len(sentences)}, with eng translation {len(texts)}\n")
    print(f"{'allowlist':<34} {'covered':>9} {'%':>7} {'words w/ >=1':>13} {'%':>7}")
    print("-" * 74)

    last_unmatched = Counter()
    for k in range(len(TIERS) + 1):
        tiers = TIERS[:k]
        label = "none (strictest)" if k == 0 else " + ".join(n for n, _ in tiers)
        covered, per_item, unmatched_counter = 0, Counter(), Counter()
        for text in texts:
            ids, unmatched = analyse(text, tiers)
            unmatched_counter.update(unmatched)
            if not unmatched and ids:
                covered += 1
                for i in ids:
                    per_item[i] += 1
        print(f"{label:<34} {covered:>9} {covered/len(texts):>6.1%} "
              f"{len(per_item):>8}/{len(BANK)} {len(per_item)/len(BANK):>6.1%}")
        last_unmatched = unmatched_counter

    print("\ntop 40 still unmatched with ALL tiers on (real vocabulary gaps):")
    for w, n in last_unmatched.most_common(40):
        print(f"  {n:>7}  {w}")

main()
