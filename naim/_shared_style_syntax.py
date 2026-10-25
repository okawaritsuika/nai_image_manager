# Adapted from existing dakiMaker style-catalog research helpers and
# NAImakeArtistGroup board-analysis vocabulary; local catalog compatibility.
"""Conservative V5 emphasis reader and canonical writer for style-only prompts.

Numeric closers reset bracket emphasis too (NAI's documented semantics).
Unsupported chunk/randomizer or mid-word emphasis is surfaced, never guessed.
This models tag weights, not NovelAI's tokenizer or visual effect strength.
"""
from dataclasses import dataclass
import math
import re


class UnsupportedPrompt(ValueError):
    pass


@dataclass(frozen=True)
class Term:
    text: str
    weight: float = 1.0


def key(text):
    return ' '.join(text.replace('_', ' ').casefold().split())


def parse(text):
    if not isinstance(text, str):
        raise TypeError('Prompt must be text')
    if '||' in text or '\\' in text:
        raise UnsupportedPrompt('Randomizers, chunks or escaped syntax need an explicit import review')
    terms=[];buf=[];numeric=1.;brackets=0;quoted=False;paren=0;i=0

    def flush():
        value=''.join(buf).strip()
        if value:
            weight=numeric*1.05**brackets
            if not math.isfinite(weight) or abs(weight)>1000:
                raise UnsupportedPrompt('Extreme emphasis weight')
            terms.append(Term(value,round(weight,9)))
        buf.clear()

    while i<len(text):
        ch=text[i]
        if ch=='"':
            quoted=not quoted;buf.append(ch);i+=1;continue
        if quoted:
            buf.append(ch);i+=1;continue
        # A number at the start of a tag is an opener. A number within a tag
        # (year 2025::) belongs to the tag and must not reopen the scope.
        match=re.match(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*::',text[i:]) if not ''.join(buf).strip() else None
        if match:
            if numeric!=1.:
                raise UnsupportedPrompt('Nested numeric emphasis requires import review')
            numeric=float(match[0].split('::')[0]);buf.clear();i+=len(match[0]);continue
        if text.startswith('::',i):
            flush();numeric=1.;brackets=0;i+=2;continue
        if ch in '{}[]':
            if ch in '{[' and ''.join(buf).strip():
                raise UnsupportedPrompt('Emphasis inside a tag requires import review')
            flush();brackets+=1 if ch in '{]' else -1;i+=1;continue
        if ch=='(':paren+=1
        elif ch==')':paren=max(0,paren-1)
        if ch in ',\r\n' and paren==0:
            flush();i+=1;continue
        buf.append(ch);i+=1
    if quoted:
        raise UnsupportedPrompt('Unclosed quote')
    flush()
    if any('::' in t.text or re.search(r'^[-+]\s*:',t.text) for t in terms):
        raise UnsupportedPrompt('Ambiguous emphasis marker')
    return terms


def render(terms):
    """Preserve order/text/weights and combine only consecutive equal weights."""
    runs=[]
    for term in terms:
        if not term.text.strip():continue
        if runs and math.isclose(runs[-1][0],term.weight,abs_tol=1e-9):
            runs[-1][1].append(term.text)
        else:runs.append((term.weight,[term.text]))
    return ', '.join(', '.join(tags) if math.isclose(w,1,abs_tol=1e-9)
                     else f'{w:.9g}::{", ".join(tags)} ::' for w,tags in runs)


def signature(terms):
    return [(key(t.text),round(t.weight,6)) for t in terms]
