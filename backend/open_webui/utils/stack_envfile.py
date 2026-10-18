r"""Read and edit KEY=value settings files that bash later `source`s, keeping everything else in the
file (comments, blank lines, `export`, quoting style and inline `# notes`).

The same file ships in ctxproxy, agentlog and the Open WebUI fork (a test checks the copies are
identical).

The supported grammar is a strict subset of bash in which every value is literal, so this module and
bash always agree (review R01/R05): per line, a blank line, a `# comment`, or one assignment
`[export ]KEY=value [# comment]`. A value is a sequence of
- 'single quoted' text (literal, may span lines),
- "double quoted" text without `$` or backticks (backslash escapes \\ \" \$ \` and a backslash-newline),
- unquoted characters other than whitespace and `$ ` ; & | < > ( )`, with backslash escapes (and no `~`
  at the start or after a `:`, where bash would put the home folder).
Anything else (expansions, several commands on a line, `+=`, Windows line endings, a NUL, an unclosed
quote) is reported with its line number by `problems()`; `edit()` refuses to change a file that has
one, and checks its own result before returning it. Values written here are single-quoted when needed,
so bash reads them back literally.
"""
from __future__ import annotations

import os
import re
import stat
import tempfile
from dataclasses import dataclass

_KEY_START = re.compile(r"[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=")
_SAFE = re.compile(r"[A-Za-z0-9_./:,@%+=-]+")
_UNQUOTED_BAD = set("$`;&|<>()")
ADDED_HEADER = "# ---- set in Open WebUI"


@dataclass
class Assignment:
    key: str
    value: str
    line_start: int     # offset of the first character of the line
    value_start: int    # offset of the value text (after "=")
    value_end: int      # offset just after the value text
    line_end: int       # offset just after the statement's line, including its newline
    line_no: int        # 1-based line number of the statement's first line


class Problem(ValueError):
    def __init__(self, line_no: int, message: str):
        super().__init__(f"line {line_no}: {message}")
        self.line_no, self.message = line_no, message


def _scan_value(text: str, i: int, line_no: int) -> tuple[str, int]:
    """Parse one value starting at i. Returns (value, end offset); raises Problem."""
    out = []
    n = len(text)
    start = i
    while i < n:
        c = text[i]
        if c in " \t\n":
            break
        if c == "~" and (i == start or text[i - 1] == ":"):
            raise Problem(line_no, "an unquoted ~ would become your home folder in bash; write the full path or quote it")
        if c == "\r":
            raise Problem(line_no, "Windows line ending (CR); convert the file with dos2unix")
        if c == "\0":
            raise Problem(line_no, "contains a NUL character")
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise Problem(line_no, "a ' quote is never closed")
            part = text[i + 1:j]
            if "\r" in part or "\0" in part:
                raise Problem(line_no, "a carriage return or NUL inside quotes")
            out.append(part)
            i = j + 1
        elif c == '"':
            i += 1
            while True:
                if i >= n:
                    raise Problem(line_no, 'a " quote is never closed')
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\" and i + 1 < n and text[i + 1] in '\\"$`\n':
                    if text[i + 1] != "\n":
                        out.append(text[i + 1])
                    i += 2
                    continue
                if c in "$`":
                    raise Problem(line_no, f"{c} inside double quotes would be expanded by bash; use single quotes")
                if c in "\r\0":
                    raise Problem(line_no, "a carriage return or NUL inside quotes")
                out.append(c)
                i += 1
        elif c == "\\":
            if i + 1 >= n:
                raise Problem(line_no, "a backslash at the end of the file")
            nxt = text[i + 1]
            if nxt == "\n":
                raise Problem(line_no, "a line continuation (backslash-newline) outside quotes")
            if nxt in "\r\0":
                raise Problem(line_no, "a carriage return or NUL after a backslash")
            out.append(nxt)
            i += 2
        elif c in _UNQUOTED_BAD:
            raise Problem(line_no, f"unquoted {c!r} means something special to bash; put the value in single quotes")
        else:
            out.append(c)
            i += 1
    return "".join(out), i


def scan(text: str) -> tuple[list[Assignment], list[Problem]]:
    """Every assignment, and every line this module can't read exactly as bash would."""
    found: list[Assignment] = []
    problems: list[Problem] = []
    i, n, line_no = 0, len(text), 1
    while i < n:
        line_end = text.find("\n", i)
        line_end = n if line_end < 0 else line_end + 1
        line = text[i:line_end].rstrip("\n")
        stripped = line.strip(" \t")
        if stripped == "" or stripped.startswith("#"):
            if "\r" in line or "\0" in line:
                problems.append(Problem(line_no, "Windows line ending (CR) or NUL; convert the file with dos2unix"))
            i, line_no = line_end, line_no + 1
            continue
        m = _KEY_START.match(text, i, line_end)
        if not m:
            problems.append(Problem(line_no, "not a KEY=value line (the settings page can only read KEY=value lines)"))
            i, line_no = line_end, line_no + 1
            continue
        try:
            value, vend = _scan_value(text, m.end(), line_no)
        except Problem as p:
            problems.append(p)
            # skip to the end of this physical line; an unclosed quote poisons the rest of the file
            if "never closed" in p.message:
                break
            i, line_no = line_end, line_no + 1
            continue
        end = text.find("\n", vend)
        end = n if end < 0 else end + 1
        rest = text[vend:end].rstrip("\n")
        tail = rest.lstrip(" \t")
        if tail and not (tail.startswith("#") and rest != tail):
            problems.append(Problem(line_no + text.count("\n", m.end(), vend),
                                    "only one KEY=value per line (and a # comment needs a space before it)"))
        elif "\r" in rest or "\0" in rest:
            problems.append(Problem(line_no, "Windows line ending (CR) or NUL; convert the file with dos2unix"))
        else:
            found.append(Assignment(m.group(1), value, i, m.end(), vend, end, line_no))
        line_no += text.count("\n", i, end)
        i = end
    return found, problems


def assignments(text: str) -> list[Assignment]:
    return scan(text)[0]


def problems(text: str) -> list[Problem]:
    return scan(text)[1]


def parse(text: str) -> dict[str, str]:
    """The values of the readable assignments (last one wins, as in bash). Check problems() too:
    with a problem the file means something else to bash."""
    out: dict[str, str] = {}
    for a in assignments(text):
        out[a.key] = a.value
    return out


def check_value(value: str, multiline: bool = False) -> str | None:
    """None, or why this value can't be written so that bash reads it back literally."""
    if "\0" in value:
        return "contains a NUL character"
    if "\r" in value:
        return "contains a carriage return"
    if "\n" in value and not multiline:
        return "must be one line"
    return None


def quote(value: str) -> str:
    """The value as bash reads it back literally."""
    if _SAFE.fullmatch(value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def edit(text: str, changes: dict[str, str | None]) -> str:
    """Apply {KEY: new value} (None removes every assignment of KEY). An existing assignment keeps its
    line, `export`, and inline comment; only the value text changes (the last one when a key is
    assigned twice). New keys go at the end, under one header line. Raises ValueError when the file
    has a problem (see scan) or a value can't be written literally, and checks the result."""
    found, probs = scan(text)
    if probs:
        raise ValueError("the file has lines bash would read differently: " + "; ".join(map(str, probs)))
    for key, value in changes.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError(f"not a setting name: {key!r}")
        if value is not None:
            msg = check_value(value, multiline=True)
            if msg:
                raise ValueError(f"{key}: {msg}")
    before = {a.key: a.value for a in found}
    last = {a.key: a for a in found}
    cuts: list[tuple[int, int, str]] = []
    added: list[str] = []
    for key, value in changes.items():
        if value is None:
            cuts += [(a.line_start, a.line_end, "") for a in found if a.key == key]
        elif key in last:
            a = last[key]
            cuts.append((a.value_start, a.value_end, quote(value)))
        else:
            added.append(f"{key}={quote(value)}")
    for start, end, new in sorted(cuts, reverse=True):
        text = text[:start] + new + text[end:]
    if added:
        if text and not text.endswith("\n"):
            text += "\n"
        if ADDED_HEADER not in text.splitlines():
            text += ("\n" if text.strip() else "") + ADDED_HEADER + "\n"
        text += "\n".join(added) + "\n"
    # The result must read back exactly as intended, and nothing else may have changed.
    after_found, after_probs = scan(text)
    after = {a.key: a.value for a in after_found}
    expected = {k: v for k, v in before.items() if changes.get(k, v) is not None}
    expected.update({k: v for k, v in changes.items() if v is not None})
    if after_probs or after != expected:
        raise ValueError("internal check failed: the edited file would not read back as intended")
    return text


def read(path: str) -> str:
    """The file's text ("" when it doesn't exist). Raises OSError / UnicodeDecodeError otherwise."""
    try:
        with open(path, encoding="utf-8", newline="") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def write(path: str, text: str) -> None:
    """Replace the file in one step (a reader never sees half a file). A symlink stays a symlink: its
    target is replaced. An existing file keeps its mode; a new file is created 0600 (it may hold a key)."""
    target = os.path.realpath(path)
    folder = os.path.dirname(target)
    os.makedirs(folder, exist_ok=True)
    try:
        st = os.stat(target)
        if not stat.S_ISREG(st.st_mode):
            raise IsADirectoryError(f"{target} is not a regular file")
        mode, owner = st.st_mode & 0o7777, (st.st_uid, st.st_gid)
    except FileNotFoundError:
        mode, owner = 0o600, None
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(target) + ".", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        if owner is not None and hasattr(os, "chown"):
            try:
                os.chown(tmp, *owner)
            except PermissionError:
                pass            # not ours to give away; the file stays ours
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def stamp(path: str) -> tuple:
    """Changes whenever the file is replaced or written (for the watcher). Follows symlinks."""
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size, st.st_ino, st.st_ctime_ns)
    except FileNotFoundError:
        return ()
