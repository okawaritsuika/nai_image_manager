# Adapted from existing dakiMaker style-catalog research helpers and
# NAImakeArtistGroup board-analysis vocabulary; local catalog compatibility.
"""Explicit import edits for malformed source prompts, kept outside the parser.

The edited prompts are catalog adaptations, not claims about the exact semantics
of malformed original prompts. Every edit and original hash is recorded.
"""
import re
from naim._shared_style_syntax import parse


def reviewed_edit(raw):
    text=raw;edits=[]
    # These source chunks describe random characters / source dialogue. They
    # cannot be included in a fixed-character portrait, regardless of emphasis.
    randoms=re.findall(r'\|\|.*?\|\|',text,re.S)
    for r in randoms:
        if re.search(r'artist\s*:|\(style\)|shading|lineart',r,re.I):
            raise ValueError('Style-bearing randomizer needs a separate recipe')
        text=text.replace(r,'')
        edits.append('Removed source-character randomizer')
    m=re.search(r'\btext\s*:',text,re.I)
    if m and '\\' in text[m.start():]:
        text=text[:m.start()]
        edits.append('Removed source dialogue tail with escaped newlines')
    if '[Base]' in text:
        text=text.split('[Base]')[0]
        edits.append('Removed embedded source scene and character sections')
    # Reviewable typo in UC; no change to the shared rendering block.
    if 'very {bad}' in text:
        text=text.replace('very {bad}','very bad')
        edits.append('Flattened inline emphasis in very bad UC')
    # An incomplete negative marker has no numeric value to preserve. Omit
    # that one source instruction instead of inventing a weight.
    text,n=re.subn(r'(?<![\w.])-\s*::\s*official style\s*::','',text,flags=re.I)
    if n:edits.append('Omitted official style with unspecified negative weight')

    # Canonicalize missing closers before another explicit numeric opener.
    # The new source number is treated as its own stated weight; this is an
    # intentional repair, never silently treated as an unchanged original.
    out=[];pos=0;active=False
    markers=list(re.finditer(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*::|::',text))
    for m in markers:
        gap=text[pos:m.start()]
        out.append(gap)
        marker=m.group()
        numeric=marker!='::'
        prefix=text[:m.start()].rstrip()
        boundary=not prefix or prefix.endswith((',',':','{','[','\n'))
        # Numeric-ending tags such as year 2025:: close a scope.
        if numeric and not boundary:
            out.append(marker);active=False
        elif numeric:
            if active:
                out.append('::, ')
                edits.append('Closed preceding numeric group before explicit '+marker)
            out.append(marker);active=True
        else:
            out.append(marker);active=False
        pos=m.end()
    out.append(text[pos:]);text=''.join(out)
    return parse(text),edits,text
