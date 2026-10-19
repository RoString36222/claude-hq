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


def rs_num(path, name, _seen=None):
    """A numeric const (`NAME: f64 = 0.35;`, `HALF: i64 = TILE / 2;`, `V: f64 = 4.5 * SCALE;`):
    a literal, or simple arithmetic over literals and other consts of the same file."""
    m = re.search(r"\bconst\s+%s\s*:\s*([iuf](?:64|32|size))\s*=\s*([^;]+);" % re.escape(name), read(path))
    if not m:
        raise AssertionError("no numeric const %s in %s" % (name, os.path.relpath(path, ROOT)))
    ty, expr = m.group(1), re.sub(r"\bas\s+[iuf](?:64|32|size)\b", "", m.group(2))
    seen = (_seen or set()) | {name}
    env = {}
    for ref in set(re.findall(r"\b[A-Z][A-Z0-9_]*\b", expr)):
        if ref in seen:
            raise AssertionError("const cycle at %s" % ref)
        env[ref] = rs_num(path, ref, seen)
    expr = re.sub(r"(?<=\d)_(?=\d)", "", expr)
    expr = re.sub(r"(\d)(?:f64|f32|i64|i32|u32|u64|usize)\b", r"\1", expr)
    if not re.fullmatch(r"[\s\w.+\-*/()]*", expr):
        raise AssertionError("const %s is not simple arithmetic: %s" % (name, expr))
    if ty.startswith("f"):
        return float(eval(expr, {"__builtins__": {}}, env))
    return int(eval(expr.replace("/", "//"), {"__builtins__": {}}, env))
