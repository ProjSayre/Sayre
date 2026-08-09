/* Fixture: GAP-7 TS import-equals under the "typescript" grammar, mixed with
 * an ordinary import and a namespace alias with no module string — the
 * latter parses as a different node type (`import_alias`, not
 * `import_require_clause`) and must NOT become a ParsedImport (EC-8). */

import { A } from "./a";
import fs = require("fs");
import util = require("./util");
import NS = A.Nested;
