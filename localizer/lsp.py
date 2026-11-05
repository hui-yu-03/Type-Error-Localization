"""A minimal language server: type-error localization in an editor.

    python -m localizer.lsp            (speaks the Language Server Protocol on stdin/stdout)

When a JavaScript document is opened, changed or saved, the server localizes
its type error and publishes diagnostics: the likely missing code (hints)
first, then the most suspicious lines in rank order, each with the
explanation of localizer/explain.py.  Results are cached by the text of the
document, so switching between files or saving without changes costs nothing.

Editor set-up, e.g. Neovim:
    vim.lsp.start({ name = "localizer", cmd = { "python", "-m", "localizer.lsp" } })
VS Code needs a small client extension that starts the same command.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

import z3

from . import rank
from .constraints import program_from_json, run_infer
from .encode import encode
from .explain import explain
from .mcs import HardConflict

TOP = 5
_cache: dict[str, list[dict]] = {}


def _line_range(text: str, line: int) -> dict:
    lines = text.split("\n")
    body = lines[line - 1] if 0 < line <= len(lines) else ""
    start = len(body) - len(body.lstrip())
    return {"start": {"line": line - 1, "character": start}, "end": {"line": line - 1, "character": len(body)}}


def diagnostics(text: str, name: str = "document.js", timeout: float = 30.0) -> list[dict]:
    """LSP diagnostics for a JavaScript text (cached by its content)."""
    key = hashlib.sha256(text.encode()).hexdigest()
    if key in _cache:
        return _cache[key]
    out: list[dict] = []
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / name
        path.write_text(text)
        try:
            data = run_infer(path)
        except Exception as e:  # noqa: BLE001 - a syntax error, an unsupported construct
            return [{"range": _line_range(text, 1), "severity": 4, "source": "localizer", "message": f"not analysed: {e}"}]
        if not data.get("parsed", True):
            return []
        program = program_from_json(data, text, str(path))
        enc = encode(program)
        if enc.check(timeout_ms=int(timeout * 1000)) != z3.unsat:
            _cache[key] = out
            return out
        try:
            ranking = rank.rank(enc, "card-late", "oll", timeout=timeout, path=path, hints=True)
        except HardConflict:
            return out
        for h in ranking.hints:
            out.append({"range": _line_range(text, h.line), "severity": 1, "source": "localizer",
                        "message": f"type error: likely missing code here: {h.description}"})
        ranks = rank.line_ranks(ranking.candidates)
        seen = {h.line for h in ranking.hints}
        for g in ranking.groups:
            line = enc.line_of(g)
            if line in seen:
                continue
            seen.add(line)
            cand = next(c for c in ranking.candidates if g in c.lines)
            why = explain(enc, cand.lines, timeout_ms=3000, limit=1)
            first = len(out) == 0
            out.append({"range": _line_range(text, line), "severity": 1 if first else 2, "source": "localizer",
                        "message": (f"type error, most likely here (rank {ranks[g]})" if first
                                    else f"type error may also be here (rank {ranks[g]})")
                        + (f": {why[0]}" if why else "")})
            if len(out) >= TOP:
                break
    _cache[key] = out
    return out


# -- JSON-RPC over stdin/stdout (Content-Length framing) ----------------------
def _read(stream) -> Optional[dict]:
    length = None
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.decode("ascii").strip()
        if not line:
            break
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1])
    return json.loads(stream.read(length)) if length else None


def _write(stream, message: dict) -> None:
    body = json.dumps(message).encode()
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    stream.flush()


def serve(inp=None, out=None) -> None:
    inp = inp or sys.stdin.buffer
    out = out or sys.stdout.buffer
    texts: dict[str, str] = {}

    def publish(uri: str) -> None:
        name = Path(unquote(urlparse(uri).path)).name or "document.js"
        _write(out, {"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                     "params": {"uri": uri, "diagnostics": diagnostics(texts[uri], name)}})

    while True:
        msg = _read(inp)
        if msg is None:
            return
        method, params = msg.get("method"), msg.get("params") or {}
        if method == "initialize":
            _write(out, {"jsonrpc": "2.0", "id": msg["id"], "result": {
                "capabilities": {"textDocumentSync": {"openClose": True, "change": 1, "save": True}},
                "serverInfo": {"name": "type-error-localizer"}}})
        elif method == "shutdown":
            _write(out, {"jsonrpc": "2.0", "id": msg["id"], "result": None})
        elif method == "exit":
            return
        elif method == "textDocument/didOpen":
            doc = params["textDocument"]
            texts[doc["uri"]] = doc["text"]
            publish(doc["uri"])
        elif method == "textDocument/didChange":
            uri = params["textDocument"]["uri"]
            texts[uri] = params["contentChanges"][-1]["text"]  # full synchronization
            publish(uri)
        elif method == "textDocument/didSave":
            uri = params["textDocument"]["uri"]
            if "text" in params:
                texts[uri] = params["text"]
            if uri in texts:
                publish(uri)
        elif method == "textDocument/didClose":
            texts.pop(params["textDocument"]["uri"], None)
        elif "id" in msg:  # a request we do not support
            _write(out, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "not supported"}})


if __name__ == "__main__":
    serve()
