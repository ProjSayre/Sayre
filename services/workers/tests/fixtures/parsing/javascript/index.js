/* Fixture: every ParsedImport form in one file — default, named, namespace,
 * side-effect, require(), and dynamic import() — plus a plain function-level
 * call into shapes.js's exports (raw/unresolved, per W1-01's boundary). */

import Circle from "./shapes";
import { describe, makeCircle } from "./shapes";
import * as shapes from "./shapes";
import "./polyfill";

const legacy = require("./legacy-shapes");

function loadShapesAsync() {
  return import("./shapes");
}

function main() {
  const circle = makeCircle(2);
  return describe(circle);
}
