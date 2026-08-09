/* Fixture: GAP-6 generator functions/expressions under the "typescript"
 * grammar, including typed generator return types. */

function* plainGen(): Generator<number> {
  yield 1;
}

export function* exportedGen(): Generator<number> {
  yield 2;
}

async function* asyncGen(): AsyncGenerator<number> {
  yield 3;
}

const exprGen = function* (): Generator<number> {
  yield 4;
};
