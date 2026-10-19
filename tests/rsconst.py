"""Read constants out of Rust source, for the *_sync tests that keep hand-made
mirrors in step (the Python server is gone; its constants now live in
dashboard-rs/src and backend-rs/src). Stdlib only, no Rust toolchain needed."""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rs_path(*parts):
    return os.path.join(ROOT, *parts)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def rs_block(path, name):
    """The text inside the brackets of `NAME: <type> = [ ... ];` (comments removed)."""
    src = re.sub(r"(?m)^\s*//[^\n]*", "", read(path))   # whole-line comments
    m = re.search(r"\b%s\s*:[^=]*=\s*&?\[" % re.escape(name), src)
    if not m:
        raise AssertionError("no %s in %s" % (name, os.path.relpath(path, ROOT)))
    depth, i = 1, m.end()
    while depth:
        c = src[i]
        if c == '"':
            i = src.index('"', i + 1)
            while src[i - 1] == "\\":
                i = src.index('"', i + 1)
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
        i += 1
    return src[m.end():i - 1]


def rs_strings(path, name):
    """The string literals of a const/static array, in order (escapes left as written)."""
    return re.findall(r'"((?:[^"\\]|\\.)*)"', rs_block(path, name))


def rs_int(path, name):
    m = re.search(r"\b%s\s*:\s*[iu](?:64|32|size)\s*=\s*(-?[\d_]+)\s*;" % re.escape(name), read(path))
    if not m:
        raise AssertionError("no integer %s in %s" % (name, os.path.relpath(path, ROOT)))
    return int(m.group(1).replace("_", ""))
