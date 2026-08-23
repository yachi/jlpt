# /// script
# requires-python = ">=3.11"
# dependencies = ["fugashi[unidic-lite]"]
# ///
"""Emit a deterministic sample of sentence -> item mappings for human review."""
import json, sys, unicodedata, random
from pathlib import Path
from fugashi import Tagger

SCRATCH = Path(sys.argv[1])
N = int(sys.argv[2]) if len(sys.argv) > 2 else 50
BANK = json.loads((SCRATCH / "bank.json").read_text())
byid = {i["id"]: i for i in BANK}
IGNORE_POS = {"助詞", "助動詞", "補助記号", "空白"}
KATA_TO_HIRA = str.maketrans({chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)})
def norm(s): return unicodedata.normalize("NFKC", s).strip()
def forms(e):
    for part in e.replace("／","/").replace("；",";").split(";"):
        for sub in part.split("/"):
            f = norm(sub).replace("～","").replace("~","")
            if f: yield f
lookup = {}
for it in BANK:
    for f in forms(it["expression"]): lookup.setdefault(f,set()).add(it["id"])
    lookup.setdefault(norm(it["reading"]),set()).add(it["id"])

allow = lambda f: (f.pos1=="名詞" and getattr(f,"pos2","")=="固有名詞") \
                  or getattr(f,"pos2","")=="数詞" or f.pos1=="数詞"
t = Tagger()
def analyse(text):
    ids, unmatched, trace = set(), [], []
    for w in t(text):
        f = w.feature
        if f.pos1 in IGNORE_POS: continue
        ob = norm(getattr(f,"orthBase",None) or w.surface)
        kana = norm((getattr(f,"lForm",None) or "").translate(KATA_TO_HIRA))
        hit = lookup.get(ob) or lookup.get(kana) or lookup.get(norm(w.surface))
        if hit:
            ids |= hit; trace.append(f"{w.surface}->{ob}")
        elif allow(f):
            trace.append(f"{w.surface}[{f.pos1}/{getattr(f,'pos2','')}]")
        else:
            unmatched.append(ob)
    return ids, unmatched, trace

sent = {}
for line in open(SCRATCH/"tatoeba/jpn_sentences.tsv", encoding="utf-8"):
    sid, _l, tx = line.rstrip("\n").split("\t",2); sent[int(sid)] = tx
linked = {int(l.split("\t")[0]) for l in open(SCRATCH/"tatoeba/jpn-eng_links.tsv", encoding="utf-8")}
eng = {}
for line in open(SCRATCH/"tatoeba/eng_sentences.tsv", encoding="utf-8"):
    sid,_l,tx = line.rstrip("\n").split("\t",2); eng[int(sid)] = tx
link = {}
for line in open(SCRATCH/"tatoeba/jpn-eng_links.tsv", encoding="utf-8"):
    a,b = line.rstrip("\n").split("\t"); link.setdefault(int(a),[]).append(int(b))

covered = []
for sid, tx in sent.items():
    if sid not in linked: continue
    ids, un, tr = analyse(tx)
    if not un and ids: covered.append((sid, tx, ids, tr))

random.seed(20260823)
for sid, tx, ids, tr in random.sample(covered, N):
    en = eng.get(sorted(link[sid])[0], "?")
    words = " ".join(f"{byid[i]['expression']}[{byid[i]['reading']}]" for i in sorted(ids))
    print(f"{sid}\t{tx}")
    print(f"\tEN  {en}")
    print(f"\tMAP {words}")
    print(f"\tTOK {' '.join(tr)}")
