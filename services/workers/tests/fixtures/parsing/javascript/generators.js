/* Fixture: GAP-6 generator functions/expressions under the "javascript"
 * grammar — the plain, exported, and async declaration forms, a generator
 * expression bound to a const, and a generator METHOD (which already worked
 * before this ticket and must keep working exactly once alongside the new
 * declaration/expression forms). */

function* plainGen() {
  yield 1;
}

export function* exportedGen() {
  yield 2;
}

async function* asyncGen() {
  yield 3;
}

const exprGen = function* () {
  yield 4;
};

class Counter {
  *increment() {
    yield 1;
  }
}
