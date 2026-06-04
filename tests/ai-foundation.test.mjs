import assert from 'assert';
import { parseJsonFromModelText } from '../server/ai-foundation.mjs';

function run() {
  const direct = parseJsonFromModelText('{"a":1}', {});
  assert.equal(direct.a, 1);

  const wrapped = parseJsonFromModelText('noise before {"ok":true,"n":2} noise after', {});
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.n, 2);

  const fallback = parseJsonFromModelText('not-json', { fallback: true });
  assert.equal(fallback.fallback, true);

  console.log('ai-foundation tests passed');
}

run();
