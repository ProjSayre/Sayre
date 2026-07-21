"""Per-language `LanguageAdapter` implementations (see `base.py`'s ABC).

Each module here is a pure `Tree -> FileExtract` function for one grammar:
`python.py`, `javascript.py`, `typescript.py` (composes/extends
`javascript.py`), `go.py`. None of them select a grammar or touch a
`tree_sitter.Parser` — that happens in `parser.py`.
"""
