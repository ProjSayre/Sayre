"""Extension -> language mapping and per-language adapter singletons.

The only module that knows the mapping between a file path's extension and
which `LanguageAdapter`/tree-sitter grammar handles it — `parser.py` and any
future caller go through `adapter_for_path()`/`language_for_path()` rather
than hardcoding an extension list themselves.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from sayre_workers.parsing.adapters.base import LanguageAdapter
from sayre_workers.parsing.adapters.go import GoAdapter
from sayre_workers.parsing.adapters.javascript import JavaScriptAdapter
from sayre_workers.parsing.adapters.python import PythonAdapter
from sayre_workers.parsing.adapters.typescript import TypeScriptAdapter
from sayre_workers.parsing.models import Language

EXTENSION_LANGUAGE: dict[str, Language] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".go": "go",
}

_ADAPTER_CLASSES: dict[Language, type[LanguageAdapter]] = {
    "python": PythonAdapter,
    "javascript": JavaScriptAdapter,
    "typescript": TypeScriptAdapter,
    "go": GoAdapter,
}

_adapter_singletons: dict[Language, LanguageAdapter] = {}


def language_for_path(path: str) -> Language | None:
    """Case-insensitive extension lookup (`.PY` / `.Go` match the same as
    lowercase); `None` means unsupported."""
    suffix = PurePosixPath(path).suffix.lower()
    return EXTENSION_LANGUAGE.get(suffix)


def get_adapter(language: Language) -> LanguageAdapter:
    """Lazily-constructed, process-wide singleton per language. Adapters are
    stateless pure `Tree -> FileExtract` functions, so sharing one instance
    across every file/call is safe and avoids re-constructing one per file."""
    if language not in _adapter_singletons:
        _adapter_singletons[language] = _ADAPTER_CLASSES[language]()
    return _adapter_singletons[language]


def adapter_for_path(path: str) -> LanguageAdapter | None:
    """`None` for an unsupported extension — callers (`parser.py`) map that
    to `SkippedFile(reason="unsupported_extension")`."""
    language = language_for_path(path)
    if language is None:
        return None
    return get_adapter(language)
