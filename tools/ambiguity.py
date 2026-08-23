# /// script
# requires-python = ">=3.11"
# dependencies = ["fugashi[unidic-lite]"]
# ///
"""How often does one token map to more than one bank item?"""
import json, sys, unicodedata
from collections import Counter
from pathlib import Path
from fugashi import Tagger
SCRATCH = Path(sys.argv[1])
BANK = json.loads((SCRATCH/"bank.json").read_text()); byid={i["id"]:i for i in BANK}
IGNORE={"助詞","助動詞","補助記号","空白"}
K2H=str.maketrans({chr(c):chr(c-0x60) for c in range(0x30A1,0x30F7)})
def norm(s): return unicodedata.normalize("NFKC",s).strip()
def forms(e):
    for part in e.replace("／","/").replace("；",";").split(";"):
        for sub in part.split("/"):
            f=norm(sub).strip("\uff5e\u301c\u007e\u3030")
            if f: yield f
# Suffix items ("~nin", "~ji") are a different word from the standalone noun,
# and UniDic already tells us which one a token is. Keep them in separate
# tables so the POS can pick.
TILDES = "\uff5e\u301c\u007e\u3030"
exact, exact_sfx, kana_only, kana_sfx = {}, {}, {}, {}
for it in BANK:
    sfx = it["expression"].lstrip()[:1] in TILDES
    e_tbl, k_tbl = (exact_sfx, kana_sfx) if sfx else (exact, kana_only)
    for f in forms(it["expression"]): e_tbl.setdefault(f,set()).add(it["id"])
    k_tbl.setdefault(norm(it["reading"]).strip("".join(TILDES)),set()).add(it["id"])

READING = {it["id"]: norm(it["reading"]).strip(TILDES) for it in BANK}

KANA = lambda s: s != "" and all(
    "\u3041" <= c <= "\u309f" or "\u30a1" <= c <= "\u30ff" or c == "\u30fc" for c in s)

def resolve(f, surface):
    """Map one token to bank item ids. Empty set = no bank word here."""
    ob = norm(getattr(f, "orthBase", None) or surface)
    is_sfx = f.pos1 in ("接尾辞",) or getattr(f, "pos2", "") == "助数詞"
    e_tbl, k_tbl = (exact_sfx, kana_sfx) if is_sfx else (exact, kana_only)
    hit = e_tbl.get(ob) or e_tbl.get(norm(surface))
    if hit:
        # 明日 is あした or あす; 私 is わたし or わたくし; ~人 is にん or じん.
        # Same kanji, different words to the ear -- and for a LISTENING card
        # that distinction is the whole point. UniDic assigns a reading in
        # context, so use it to pick rather than claiming the sentence teaches
        # both.
        if len(hit) > 1:
            kana = norm((getattr(f, "lForm", None) or "").translate(K2H))
            narrowed = {i for i in hit if READING.get(i) == kana}
            if narrowed: return narrowed
        return hit
    # Reading is only a valid key when the word is WRITTEN in kana. Using it for
    # a kanji token matches unrelated homophones -- it is how 機 reached 木|気.
    if KANA(ob):
        kana = norm((getattr(f, "lForm", None) or "").translate(K2H))
        hit = k_tbl.get(kana) or k_tbl.get(ob)
        if hit: return hit
    # A suffix that is not in the suffix table may still be the plain noun.
    if is_sfx:
        return exact.get(ob) or set()
    return set()

t=Tagger()
# Two bank rows for the same word (N5 and N4 both list it) are not ambiguity.
same_word = {}
for it in BANK:
    same_word.setdefault((norm(it["expression"]), norm(it["reading"])), []).append(it["id"])
dupe_ids = {i for ids in same_word.values() if len(ids) > 1 for i in ids}
canon = {}
for ids in same_word.values():
    for i in ids: canon[i] = min(ids)
amb_by_key=Counter(); tokens=0; amb_tokens=0
真=0; covered=0; per_item=Counter(); ambiguous_only=0
sent={}
for line in open(SCRATCH/"tatoeba/jpn_sentences.tsv",encoding="utf-8"):
    sid,_l,tx=line.rstrip("\n").split("\t",2); sent[int(sid)]=tx
linked={int(l.split("\t")[0]) for l in open(SCRATCH/"tatoeba/jpn-eng_links.tsv",encoding="utf-8")}
for sid,tx in sent.items():
    if sid not in linked: continue
    for w in t(tx):
        f=w.feature
        if f.pos1 in IGNORE: continue
        ob=norm(getattr(f,"orthBase",None) or w.surface)
        hit = resolve(f, w.surface)
        if not hit: continue
        tokens+=1
        if len({canon[i] for i in hit})>1:
            amb_tokens+=1
            amb_by_key[(ob, tuple(sorted(byid[i]["expression"] for i in hit)))]+=1
print(f"duplicate bank rows (same expression+reading): {len(dupe_ids)} ids")
print(f"matched content tokens: {tokens}")
print(f"ambiguous (>1 item):    {amb_tokens}  ({amb_tokens/tokens:.2%})")
print("\ntop 25 ambiguous mappings:")
for (ob,exprs),n in amb_by_key.most_common(25):
    print(f"  {n:>6}  {ob:<8} -> {' | '.join(exprs)}")
