# /// script
# requires-python = ">=3.11"
# dependencies = ["fugashi[unidic-lite]"]
# ///
"""Probe 2: which UniDic feature gives a key that matches the bank?"""
from fugashi import Tagger
t = Tagger()
w = t("ご飯を食べる")[0]
print("available features:", [f for f in w.feature._fields])
print()
for s in ["ご飯", "私", "この", "しています", "面白くない", "足", "会いましょう"]:
    for w in t(s):
        f = w.feature
        print(f"{w.surface:8} lemma={str(getattr(f,'lemma','-')):12} "
              f"orthBase={str(getattr(f,'orthBase','-')):10} "
              f"kana={str(getattr(f,'kana','-')):10} "
              f"lForm={str(getattr(f,'lForm','-')):10} pos1={f.pos1}")
    print()
