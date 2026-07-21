"""Fixture: imports (plain, from-import, relative, aliased), a module-level
function calling into models.py's constructs, and a conditional import
inside a function — exercises ParsedImport (multiple forms) and cross-file
raw (unresolved) call/import strings."""

import os  # noqa: F401 -- deliberately unused; fixture exercises import extraction, not usage
import sys as system  # noqa: F401
from .models import Dog, make_dog  # noqa: F401
from . import models as pkg_models  # noqa: F401


def run():
    dog = make_dog("Rex")
    dog.speak()
    return dog


def run_conditionally(flag):
    if flag:
        import json

        return json.dumps({"ok": True})
    return None
