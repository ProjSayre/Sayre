/* Fixture: GAP-7 class expressions under the "javascript" grammar — bound
 * to a plain identifier, so each qualifies as a ParsedClass (and its methods
 * qualify under it) instead of leaking out as a top-level function; one
 * plain, one with `extends` (base name stays RAW/UNRESOLVED, per this
 * module's boundary). */

const Registry = class {
  register() {}
};

const Extended = class extends Registry {};
