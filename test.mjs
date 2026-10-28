import assert from 'node:assert/strict';
import {
  authValueForEndpoint,
  chooseEndpoint,
  endpointCandidates,
  explicitUserCancellation,
  modelCatalog,
} from './lib/transport.js';

{
  const values = endpointCandidates({ endpoint: 'auto' });
  assert.deepEqual(values, [
    'http://127.0.0.1:1601/v1/chat/completions',
    'http://127.0.0.1:8787/v1/chat/completions',
  ]);
}

{
  const values = endpointCandidates({
    endpoint: 'http://127.0.0.1:8787/v1',
  });
  assert.equal(values[0], 'http://127.0.0.1:8787/v1/chat/completions');
  assert.ok(values.includes('http://127.0.0.1:1601/v1/chat/completions'));
}

assert.equal(
  authValueForEndpoint('http://127.0.0.1:1601/v1/chat/completions', ''),
  'Bearer dsh-local',
);
assert.equal(
  authValueForEndpoint('http://127.0.0.1:8787/v1/chat/completions', 'abc'),
  'Bearer abc',
);
assert.equal(
  authValueForEndpoint('https://gateway.example/v1/chat/completions', ''),
  '',
);

{
  const generic = new AbortController();
  generic.abort(new Error('client_disconnected'));
  assert.equal(explicitUserCancellation(generic.signal), false);

  const explicit = new AbortController();
  explicit.abort(new Error('user cancelled generation'));
  assert.equal(explicitUserCancellation(explicit.signal), true);
}

{
  const calls = [];
  const fakeFetch = async url => {
    calls.push(String(url));
    if (String(url).includes(':1601/')) throw new Error('ECONNREFUSED');
    return { ok: false, status: 404 };
  };
  const selected = await chooseEndpoint(
    fakeFetch,
    endpointCandidates({ endpoint: 'auto' }),
    '',
    50,
  );
  assert.equal(selected, 'http://127.0.0.1:8787/v1/chat/completions');
  assert.equal(calls.length, 2);
}

{
  const ids = modelCatalog({}).map(x => x.id);
  assert.deepEqual(ids, [
    'deepseek-chat',
    'chatgpt-web',
    'grok-web-fast',
    'glm-web-flash',
  ]);
}

console.log('wet transport tests: PASS');
