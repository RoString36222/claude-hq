"""Work signals (HQ 2.5): classify how you work, locally, from your transcripts.

The transcript scan (dashboard._scan_file_uncached, the single cached pass over
each file) hands every record to observe(); this module turns tool use and file
kinds into per-UTC-day COUNTS. Nothing here keeps or returns a command, a file
name, a path, an extension, a repo or any text -- only integers per category.

Nine keys per day:
  tests       a test-runner Bash command, or an edit to a test file
  tests_green such a test run that came back without an error or fail marker
  refactor    a MultiEdit, or a multi-hunk / replace-all Edit, on code
  docs        an edit to *.md / *.rst / *.txt, or anything under docs/
  review      gh pr view|diff|review|checks, git diff|log|show|blame
  debug       a tool error followed by a retry of that tool, or a traceback
              in a tool result, or a debugger command
  explore     Grep / Glob / Read (and LS)
  build       any other code edit (Edit / Write / MultiEdit / NotebookEdit)
  focus_long  per transcript: each run of activity of 45 min or more with no
              gap over 10 min, credited to the UTC day the run ENDS

The skill tree reports only SKILL_CATS (report_counts); loot reads tests_green
and focus_long. Everything leaves the machine only through ext_skills / ext_loot,
only when the user opted in (config workSignals), and only as these counts.
"""
import difflib
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

SKILL_CATS = ("tests", "refactor", "docs", "review", "debug", "explore", "build")
KEYS = SKILL_CATS + ("tests_green", "focus_long")

# The Arena refuses a count above this for one category on one day.
MAX_N = 200

FOCUS_MIN_SECS = 45 * 60
FOCUS_GAP_SECS = 10 * 60

EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
EXPLORE_TOOLS = ("Grep", "Glob", "Read", "LS")

# A command that runs a test suite. Matched against each shell segment, so
# `cd x && pytest -q` counts, `echo pytest` does not (echo is not the command).
_TEST_CMD_RE = re.compile(
    r"^(?:(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*)"
    r"(?:(?:uv|poetry|pipenv|hatch|pdm)\s+run\s+)?"
    r"(?:"
    r"pytest\b|py\.test\b|tox\b|nox\b|"
    r"python[0-9.]*\s+(?:-[a-zA-Z]\s+)*(?:-m\s+(?:pytest|unittest|nose2?)\b|\S*test\S*\.py\b|manage\.py\s+test\b)|"
    r"cargo\s+(?:\+\S+\s+)?(?:test|nextest)\b|"
    r"go\s+test\b|"
    r"(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?\b|"
    r"(?:npx\s+|bunx\s+)?(?:jest|vitest|mocha|ava|karma|playwright\s+test|cypress\s+run)\b|"
    r"deno\s+test\b|bun\s+test\b|"
    r"(?:\./)?gradlew?\s+(?:\S+\s+)*test\b|mvn\s+(?:\S+\s+)*(?:test|verify)\b|"
    r"rspec\b|bundle\s+exec\s+(?:rspec|rake\s+test)\b|rake\s+test\b|"
    r"phpunit\b|(?:\./)?vendor/bin/phpunit\b|"
    r"dotnet\s+test\b|swift\s+test\b|mix\s+test\b|ctest\b|"
    r"make\s+(?:\S+\s+)*(?:test|check)\b"
    r")"
)

# Shell segment separators (&&, ||, ;, |, newlines).
_SEG_SPLIT_RE = re.compile(r"\s*(?:&&|\|\||;|\||\n)\s*")
_LEAD_STRIP_RE = re.compile(r"^(?:\(|\{|time\s+|timeout\s+\d+\S*\s+|sudo\s+|exec\s+)+")

_REVIEW_CMD_RE = re.compile(
    r"^(?:gh\s+pr\s+(?:view|diff|review|checks)\b|"
    r"git\s+(?:-C\s+\S+\s+|--no-pager\s+|-c\s+\S+\s+)*(?:diff|log|show|blame|range-diff)\b)"
)
_DEBUG_CMD_RE = re.compile(r"^(?:pdb\b|gdb\b|lldb\b|python[0-9.]*\s+-m\s+pdb\b|node\s+inspect\b|strace\b|dtruss\b)")
_DEBUG_ENV_RE = re.compile(r"\b(?:RUST_BACKTRACE=(?:1|full)|PYTHONFAULTHANDLER=1|NODE_DEBUG=)")

# A failing run, in the output of the common runners. "0 failed" is not one.
_FAIL_RE = re.compile(
    r"\bFAILED\b|\bFAIL\b|\bFAILURES?\b|"
    r"\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b|"
    r"\bfailures=[1-9]|\berrors=[1-9]|"
    r"test result: FAILED|Tests?:\s+[1-9]\d*\s+failed|"
    r"Traceback \(most recent call last\)|panicked at|\bERROR:\s"
)
_TRACE_RE = re.compile(
    r"Traceback \(most recent call last\)|panicked at |stack backtrace:|"
    r"Uncaught \w*Error|Segmentation fault|\bat \S+ \(\S+:\d+:\d+\)|Exception in thread "
)

_DOC_EXT = (".md", ".mdx", ".rst", ".txt", ".adoc")
_TEST_FILE_RE = re.compile(
    r"(?:^|/)(?:tests?|__tests__|spec|specs|testing)/|"
    r"(?:^|/)test_[^/]+$|_test\.[a-z0-9]+$|_tests\.[a-z0-9]+$|"
    r"\.(?:test|spec)\.[a-z0-9]+$|(?:^|/)[^/]*Tests?\.[a-zA-Z0-9]+$|conftest\.py$"
)


def _segments(cmd):
    out = []
    for seg in _SEG_SPLIT_RE.split(cmd or ""):
        seg = _LEAD_STRIP_RE.sub("", seg.strip())
        if seg:
            out.append(seg)
    return out


def is_test_command(cmd):
    """True when any segment of a shell command runs a test suite."""
    if not isinstance(cmd, str) or not cmd.strip():
        return False
    return any(_TEST_CMD_RE.match(s) for s in _segments(cmd))


def is_review_command(cmd):
    if not isinstance(cmd, str):
        return False
    return any(_REVIEW_CMD_RE.match(s) for s in _segments(cmd))


def is_debug_command(cmd):
    if not isinstance(cmd, str):
        return False
    if _DEBUG_ENV_RE.search(cmd):
        return True
    return any(_DEBUG_CMD_RE.match(s) for s in _segments(cmd))


def file_kind(path):
    """'test', 'doc' or 'code' for an edited file path ('' when unknown)."""
    if not isinstance(path, str) or not path.strip():
        return ""
    p = path.strip().replace("\\", "/")
    low = p.lower()
    if _TEST_FILE_RE.search(p):
        return "test"
    if low.endswith(_DOC_EXT) or "/docs/" in low or low.startswith("docs/") or "/doc/" in low:
        return "doc"
    return "code"


def _changed_hunks(old, new):
    """How many separate changed regions turn `old` into `new` (by line)."""
    a = (old or "").splitlines()
    b = (new or "").splitlines()
    try:
        ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    except Exception:
        return 1
    return sum(1 for op in ops if op[0] != "equal")


def _is_refactor_edit(name, inp):
    if name == "MultiEdit":
        edits = inp.get("edits")
        return isinstance(edits, list) and len(edits) >= 2
    if name == "Edit":
        if inp.get("replace_all") is True:
            return True
        return _changed_hunks(inp.get("old_string"), inp.get("new_string")) >= 2
    return False


def _result_text(content):
    """Plain text of a tool_result's content (string or list of text blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                parts.append(b["text"])
            elif isinstance(b, str):
                parts.append(b)
        return "\n".join(parts)
    return ""


def new_state():
    """Per-transcript scratch state; never stored past the scan."""
    return {"pending": {}, "errored": {}, "ts": []}


def _bump(day, key, n=1):
    ws = day.setdefault("ws", {})
    ws[key] = ws.get(key, 0) + n


def classify_entry(entry, day, state=None):
    """Classify one transcript record, adding counts to day['ws'].

    `day` is the per-UTC-day bucket of the record (any dict); `state` is the
    per-transcript scratch from new_state(). Tool results are credited to the
    day of the call they answer. Never raises."""
    if not isinstance(entry, dict) or not isinstance(day, dict):
        return
    if state is None:
        state = day.setdefault("_wsstate", new_state())
    try:
        typ = entry.get("type")
        msg = entry.get("message") if isinstance(entry.get("message"), dict) else {}
        content = msg.get("content")
        if typ == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    _classify_use(b, day, state)
        elif typ == "user" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    _classify_result(b, state)
    except Exception:
        return


def _classify_use(b, day, state):
    name = b.get("name") if isinstance(b.get("name"), str) else ""
    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
    tid = b.get("id") if isinstance(b.get("id"), str) else None
    errored = state["errored"]
    # A retry: the same tool again right after one of its calls errored.
    if name and errored.pop(name, None):
        _bump(day, "debug")
    errored.clear()
    is_test_run = False
    if name == "Bash":
        cmd = inp.get("command") if isinstance(inp.get("command"), str) else ""
        if is_test_command(cmd):
            _bump(day, "tests")
            is_test_run = True
        if is_review_command(cmd):
            _bump(day, "review")
        if is_debug_command(cmd):
            _bump(day, "debug")
    elif name in EXPLORE_TOOLS:
        _bump(day, "explore")
    elif name in EDIT_TOOLS:
        p = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
        kind = file_kind(p)
        if kind == "test":
            _bump(day, "tests")
        elif kind == "doc":
            _bump(day, "docs")
        elif kind == "code":
            _bump(day, "refactor" if _is_refactor_edit(name, inp) else "build")
    if tid:
        pend = state["pending"]
        if len(pend) > 500:  # orphans from an interrupted turn
            pend.clear()
        pend[tid] = (name, day, is_test_run)


def _classify_result(b, state):
    tid = b.get("tool_use_id")
    got = state["pending"].pop(tid, None) if isinstance(tid, str) else None
    if got is None:
        return
    name, day, is_test_run = got
    text = _result_text(b.get("content"))
    is_err = b.get("is_error") is True
    if is_err and name:
        state["errored"][name] = True
    if _TRACE_RE.search(text[:20000]):
        _bump(day, "debug")
    if is_test_run and not is_err and not _FAIL_RE.search(text[-20000:]):
        _bump(day, "tests_green")


def focus_spans(timestamps):
    """[(start, end)] epoch-second runs of >= 45 min with no gap over 10 min."""
    ts = sorted(t for t in (timestamps or []) if isinstance(t, (int, float)))
    out = []
    if not ts:
        return out
    start = prev = ts[0]
    for t in ts[1:]:
        if t - prev > FOCUS_GAP_SECS:
            if prev - start >= FOCUS_MIN_SECS:
                out.append((start, prev))
            start = t
        prev = t
    if prev - start >= FOCUS_MIN_SECS:
        out.append((start, prev))
    return out


def _utc_day(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()


def observe(entry, agg, state):
    """The scan hook: classify one record into agg['ws_days'][utc_day]['ws'],
    and remember its time for focus_long. Never raises."""
    try:
        if not isinstance(entry, dict) or not isinstance(agg, dict):
            return
        ts = entry.get("timestamp")
        if not isinstance(ts, str):
            return
        t = ts.strip()
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        dt = datetime.fromisoformat(t)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        if entry.get("type") in ("user", "assistant"):
            state["ts"].append(dt.timestamp())
        day = agg.setdefault("ws_days", {}).setdefault(dt.date().isoformat(), {})
        classify_entry(entry, day, state)
    except Exception:
        return


def finish(agg, state):
    """End of one transcript's scan: credit focus_long and drop the scratch."""
    try:
        days = agg.setdefault("ws_days", {})
        for _start, end in focus_spans(state.get("ts")):
            _bump(days.setdefault(_utc_day(end), {}), "focus_long")
        for d in list(days):
            if not (days[d].get("ws") or {}):
                del days[d]
            else:
                days[d].pop("_wsstate", None)
    except Exception:
        pass
    state["pending"] = {}
    state["errored"] = {}
    state["ts"] = []


# --- aggregation across transcripts --------------------------------------- #

_ctx = {"scan_file": None, "iter_paths": None}
_ctx_lock = threading.Lock()


def init(scan_file, iter_transcript_paths):
    """Wire the scanner in (dashboard.py's scan_file / iter_transcript_paths)."""
    with _ctx_lock:
        _ctx["scan_file"] = scan_file
        _ctx["iter_paths"] = iter_transcript_paths


def last_days(n, now=None):
    """The last n UTC days, oldest first, ending today."""
    now = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    today = now.astimezone(timezone.utc).date()
    n = max(1, min(int(n or 1), 60))
    return [(today - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]


def merge_days(aggs, days):
    """{day: {key: n}} summed over per-file aggregates, every KEY present."""
    want = list(days)
    out = {d: {k: 0 for k in KEYS} for d in want}
    for agg in aggs:
        wd = (agg or {}).get("ws_days") if isinstance(agg, dict) else None
        if not isinstance(wd, dict):
            continue
        for d in want:
            ws = (wd.get(d) or {}).get("ws") or {}
            for k in KEYS:
                v = ws.get(k)
                if isinstance(v, int) and v > 0:
                    out[d][k] += v
    return out


def day_counts(days=7, now=None, paths=None):
    """{day: {key: n}} over all nine KEYS for the last `days` UTC days (an int),
    or for an explicit list of 'YYYY-MM-DD' days, across every transcript."""
    if isinstance(days, (list, tuple, set)):
        want = sorted(d for d in days if isinstance(d, str) and len(d) == 10)
    else:
        want = last_days(days, now)
    with _ctx_lock:
        scan, it = _ctx["scan_file"], _ctx["iter_paths"]
    if scan is None or (it is None and paths is None):
        return {d: {k: 0 for k in KEYS} for d in want}
    oldest = time.time() - (len(want) + 2) * 86400 if not isinstance(days, (list, tuple, set)) else 0
    aggs = []
    try:
        src = list(paths) if paths is not None else list(it())
    except Exception:
        src = []
    for p in src:
        try:
            # A file untouched since before the window can't hold its days.
            if oldest and os.path.getmtime(p) < oldest:
                continue
            aggs.append(scan(p))
        except Exception:
            continue
    return merge_days(aggs, want)


def _clean7(counts):
    out = {}
    for k in SKILL_CATS:
        v = counts.get(k)
        try:
            v = 0 if isinstance(v, bool) else int(v)
        except Exception:
            v = 0
        out[k] = max(0, min(MAX_N, v))
    return out


def report_counts(counts):
    """EXACTLY the seven skill categories, each clamped to 0..MAX_N -- the only
    shape that leaves the machine for the skill tree. Takes one day's
    {key: n}, or day_counts()' {day: {key: n}} (then maps every day)."""
    counts = counts if isinstance(counts, dict) else {}
    if counts and all(isinstance(v, dict) for v in counts.values()):
        return {d: _clean7(v) for d, v in counts.items()}
    return _clean7(counts)
