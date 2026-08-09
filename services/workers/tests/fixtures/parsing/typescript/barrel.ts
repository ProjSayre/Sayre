/* Fixture: GAP-5 re-exports under the "typescript" grammar, including the
 * TS-only `export type { … } from` form. */

export * from "./a";
export { b, c as d } from "./b";
export * as ns from "./c";
export type { T } from "./types";
