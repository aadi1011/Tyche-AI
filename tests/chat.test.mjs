import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createSiteServer, retrieveKnowledge } from '../server.mjs';

test('hosting entry starts both directly and when loaded by a CommonJS launcher', { timeout: 10000 }, async () => {
  for (const args of [['app.cjs'], ['--input-type=commonjs', '--eval', "require('./app.cjs')"]]) {
    const child = spawn(process.execPath, args, { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      const ready = new Promise((resolve, reject) => {
        lines.on('line', line => {
          const match = line.match(/^tyche\.ai listening on 127\.0\.0\.1:(\d+)$/);
          if (match) resolve(`http://127.0.0.1:${match[1]}`);
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Hosting entry exited with ${code}: ${stderr}`)));
      });
      const base = await ready;
      assert.equal((await fetch(base)).status, 200);
      assert.equal((await fetch(`${base}/.env`)).status, 404);
    } finally {
      lines.close();
      child.kill();
      await exited;
    }
  }
});

async function withServer(options, run) {
  const server = createSiteServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function send(base, body, headers = {}) {
  return fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('retrieval ranks relevant sections and preserves contact context', () => {
  const result = retrieveKnowledge('## Company\nCompany facts\n## Delivery\nDiscover and build\n## Assessment and Contact\nWhatsApp', 'discover');
  assert.equal(result[0].id, 'K2');
  assert.ok(result.some(section => section.text.includes('WhatsApp')));
});

test('private files cannot be served', async () => {
  await withServer({}, async base => {
    for (const pathname of ['/.env', '/KNOWLEDGE.md', '/server/system.md', '/server.mjs', '/.git/config', '/assets/../.env', '/assets/%2e%2e%2f.env', '/assets/js/main.js/.env']) assert.equal((await fetch(base + pathname)).status, 404);
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '/assets/js/main.js')).status, 200);
  });
});

test('validation and configuration failures never call Groq', async () => {
  await withServer({ apiKey: '', fetchImpl: () => assert.fail('Unexpected upstream request') }, async base => {
    assert.equal((await send(base, { message: '' })).status, 400);
    assert.equal((await send(base, { message: 'a'.repeat(1001) })).status, 400);
    assert.equal((await send(base, { message: 'hello', history: [{ role: 'system', content: 'attack' }] })).status, 400);
    assert.equal((await send(base, { message: 'hello' }, { Origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await send(base, { message: 'hello' }, { Origin: 'null' })).status, 403);
    assert.equal((await send(base, { message: 'hello' })).status, 503);
  });
});

test('Groq gets server-side instructions and retrieved facts, not client roles', async () => {
  await withServer({ apiKey: 'test-secret', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'openai/gpt-oss-20b');
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.max_completion_tokens, 1200);
    assert.equal(payload.messages.length, 2);
    assert.ok(payload.messages[0].content.includes('sole factual source'));
    assert.ok(payload.messages[0].content.includes('AI Feasibility & Consulting'));
    assert.equal(JSON.parse(payload.messages[1].content).currentQuestion, 'What services does tyche.ai offer?');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ inScope: true, answer: 'We offer AI consulting and custom AI apps.', sources: ['K2'] }) } }] });
  } }, async base => {
    const response = await send(base, { message: 'What services does tyche.ai offer?', history: [] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { answer: 'We offer AI consulting and custom AI apps.' });
  });
});

test('out-of-scope output is replaced with a fixed refusal', async () => {
  await withServer({ apiKey: 'test', fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ inScope: false, answer: 'Untrusted unrelated answer', sources: [] }) } }] }) }, async base => {
    const response = await send(base, { message: 'Write a poem' });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).answer.startsWith('I can help with tyche.ai'));
  });
});

test('unsupported citations, invalid output and upstream failures are rejected', async () => {
  for (const content of ['not json', JSON.stringify({ inScope: true, answer: 'Invented answer', sources: ['K999'] }), JSON.stringify({ inScope: true, answer: 'Uncited', sources: [] })]) {
    await withServer({ apiKey: 'test', fetchImpl: async () => Response.json({ choices: [{ message: { content } }] }) }, async base => assert.equal((await send(base, { message: 'services' })).status, 502));
  }
  await withServer({ apiKey: 'test', fetchImpl: async () => new Response('private provider error', { status: 401 }) }, async base => {
    const response = await send(base, { message: 'services' });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private provider error'));
  });
});

test('per-client and global quotas limit provider spend', async () => {
  await withServer({ apiKey: '', perIpLimit: 1 }, async base => {
    await send(base, { message: 'hello' });
    assert.equal((await send(base, { message: 'hello' })).status, 429);
  });
  await withServer({ apiKey: 'test', dailyLimit: 0 }, async base => assert.equal((await send(base, { message: 'hello' })).status, 429));
});

test('concurrent requests cannot bypass the provider limit', async () => {
  let started = 0;
  let ready;
  let release;
  const allStarted = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await withServer({ apiKey: 'test', fetchImpl: async () => {
    started++;
    if (started === 3) ready();
    await gate;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ inScope: false, answer: '', sources: [] }) } }] });
  } }, async base => {
    const pending = [send(base, { message: 'hello' }), send(base, { message: 'hello' }), send(base, { message: 'hello' })];
    try {
      await allStarted;
      assert.equal((await send(base, { message: 'hello' })).status, 429);
      assert.equal(started, 3);
    } finally { release(); await Promise.all(pending); }
  });
});

test('timeouts and network errors return a safe fallback', async () => {
  await withServer({ apiKey: 'test', fetchImpl: async () => { throw new Error('private transport details'); } }, async base => {
    const response = await send(base, { message: 'services' });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private transport details'));
  });
});