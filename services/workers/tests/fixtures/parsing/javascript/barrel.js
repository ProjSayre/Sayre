/* Fixture: GAP-5 re-exports under the "javascript" grammar — every
 * `export … from` shape becomes a ParsedImport with the raw, unresolved
 * module string; module resolution itself remains W1-05's job. */

export * from "./a";
export { b, c as d } from "./b";
export * as ns from "./c";
