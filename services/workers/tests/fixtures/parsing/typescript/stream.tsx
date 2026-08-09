/* Fixture: GAP-5 + GAP-6 + GAP-7 under the "tsx" grammar — `typescript.scm`
 * is executed against BOTH the `typescript` and `tsx` grammars, and nothing
 * before this ticket proved the new patterns actually compile/match under
 * `tsx` too, not just `typescript`. A re-export, a generator function, and a
 * bound class expression, alongside a typed function component returning
 * JSX (mirroring the pre-existing widget.tsx fixture's grammar-selection
 * check). */

import React from "react";
export { helper } from "./helper";

function* streamGen() {
  yield 1;
}

const Panel = class {
  render() {
    return <div className="panel" />;
  }
};

export function View() {
  return <Panel />;
}
