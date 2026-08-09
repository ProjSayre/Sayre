/* Fixture: GAP-7 class expressions under the "typescript" grammar — plain
 * and with `extends`, exercising the TS `extends_clause` heritage wrapper
 * (distinct from plain JS's bare `class_heritage` children — both are
 * handled by the shared `_class_heritage_bases()` helper). */

const Registry = class {
  register(): void {}
};

const Extended = class extends Registry {};
