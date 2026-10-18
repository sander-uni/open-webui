r"""Read and edit KEY=value settings files the way bash `source` reads them, keeping everything
else in the file (comments, blank lines, `export`, quoting style and inline `# notes`).

The same file ships in ctxproxy, agentlog and the Open WebUI fork (a test checks the copies are
identical). Supported: `KEY=value`, `export KEY=value`, 'single quoted' (literal, may span lines),
"double quoted" (backslash escapes \\ \" \$ \` and a backslash-newline), unquoted values with
backslash escapes, and a `# comment` after whitespace. `$VAR` expansion is not supported: values
are taken literally, and values this module writes are quoted so bash takes them literally too.
For a key assigned twice the last assignment wins, as in bash.
"""
from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass

_ASSIGN = re.compile(r"[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=")
_SAFE = re.compile(r"[A-Za-z0-9_./:,@%+=-]+")
ADDED_HEADER = "# ---- set in Open WebUI"


@dataclass
class Assignment:
    key: str
    value: str
    line_start: int     # offset of the first character of the line
    value_start: int    # offset of the value text (after "=")
    value_end: int      # offset just after the value text
    line_end: int       # offset just after the statement's line, including its newline


def _scan_value(text: str, i: int) -> tuple[str, int]:
    """Parse a bash word starting at i (stopping at unquoted whitespace or end of line).
    Returns (value, end offset)."""
    out = []
    n = len(text)
    while i < n:
        c = text[i]
        if c in " \t\n" or (c == "\r" and text[i + 1:i + 2] == "\n"):
            break
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise ValueError("unterminated single quote")
            out.append(text[i + 1:j])
            i = j + 1
        elif c == '"':
            i += 1
            while True:
                if i >= n:
                    raise ValueError("unterminated double quote")
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\" and i + 1 < n and text[i + 1] in '\\"$`\n':
                    if text[i + 1] != "\n":
                        out.append(text[i + 1])
                    i += 2
                    continue
                out.append(c)
                i += 1
        elif c == "\\":
            if i + 1 < n and text[i + 1] != "\n":
                out.append(text[i + 1])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out), i


def assignments(text: str) -> list[Assignment]:
    """Every KEY=value statement in the file, in order. Lines that are not assignments are
    skipped; a quoted value may run over several lines."""
    found = []
    i, n = 0, len(text)
    while i < n:
        line_end = text.find("\n", i)
        line_end = n if line_end < 0 else line_end + 1
        m = _ASSIGN.match(text, i, line_end)
        if not m:
            i = line_end
            continue
        try:
            value, vend = _scan_value(text, m.end())
        except ValueError:
            i = line_end
            continue
        end = text.find("\n", vend)
        end = n if end < 0 else end + 1
        found.append(Assignment(m.group(1), value, i, m.end(), vend, end))
        i = end
    return found


def parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for a in assignments(text):
        out[a.key] = a.value
    return out


def quote(value: str) -> str:
    """The value as bash reads it back literally."""
    if _SAFE.fullmatch(value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def edit(text: str, changes: dict[str, str | None]) -> str:
    """Apply {KEY: new value} (None removes every assignment of KEY). An existing assignment
    keeps its line, `export`, and inline comment; only the value text changes (the last one
    when a key is assigned twice). New keys go at the end, under one header line."""
    found = assignments(text)
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
    return text


def read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", newline="") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def write(path: str, text: str) -> None:
    """Replace the file in one step (a reader never sees half a file), keeping its mode."""
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    try:
        mode = os.stat(path).st_mode & 0o7777
    except FileNotFoundError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def stamp(path: str) -> tuple:
    """Changes whenever the file is replaced or written (for the watcher)."""
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size, st.st_ino)
    except FileNotFoundError:
        return ()
