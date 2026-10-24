import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createVoiceService, loadVoicePrompt, buildVoiceConfiguration, voiceEvents } from '../server/voice.mjs';
import { createSiteServer } from '../server/site.mjs';

const request = { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } };

async function agentResponse() {
  return Response.json({ ...buildVoiceConfiguration({}, await loadVoicePrompt()), version_id: 'test-version' });
}

function providerResponse(signed_url) {
  return async url => String(url).includes('/agents/') ? agentResponse() : String(url).includes('/single-use-token/') ? Response.json({ token: 'single-use-transcription-token' }) : Response.json({ signed_url });
}

test('voice authorization keeps the provider key server-side and issues a single-use URL', async () => {
  const authorize = createVoiceService({ apiKey: 'private-test-key', agentId: 'test-agent', fetchImpl: async (url, options) => {
    if (String(url).includes('/agents/')) return agentResponse();
    if (String(url).includes('/single-use-token/')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['xi-api-key'], 'private-test-key');
      return Response.json({ token: 'single-use-transcription-token' });
    }
    assert.equal(url.hostname, 'api.elevenlabs.io');
    assert.equal(url.searchParams.get('agent_id'), 'test-agent');
    assert.equal(url.searchParams.get('include_conversation_id'), 'true');
    assert.equal(url.searchParams.get('version_id'), 'test-version');
    assert.equal(options.headers['xi-api-key'], 'private-test-key');
    return Response.json({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=short-lived' });
  } });
  const result = await authorize(request);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body), ['signedUrl', 'scribeToken']);
  assert.ok(!JSON.stringify(result.body).includes('private-test-key'));
});

test('voice rejects wrong methods, cross-origin requests, and missing credentials', async () => {
  const authorize = createVoiceService({ apiKey: '', fetchImpl: () => assert.fail('Unexpected provider call') });
  assert.equal((await authorize({ ...request, method: 'GET' })).status, 405);
  assert.equal((await authorize({ ...request, headers: { ...request.headers, origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await authorize({ ...request, headers: { ...request.headers, origin: 'null' } })).status, 403);
  assert.equal((await authorize({ ...request, headers: { host: 'localhost' } })).status, 415);
  assert.equal((await authorize(request)).status, 503);
});

test('voice rejects invalid upstream URLs and hides provider errors', async () => {
  for (const signed_url of ['https://api.elevenlabs.io/secret', 'wss://evil.example/session', 'invalid']) {
    const authorize = createVoiceService({ apiKey: 'test', agentId: 'test', fetchImpl: providerResponse(signed_url) });
    assert.notEqual((await authorize(request)).status, 200);
  }
  const authorize = createVoiceService({ apiKey: 'test', agentId: 'test', fetchImpl: async () => new Response('secret provider diagnostic', { status: 401 }) });
  const result = await authorize(request);
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes('secret provider diagnostic'));
});

test('voice limits session issuance per address and per day', async () => {
  const options = { apiKey: 'test', agentId: 'test', fetchImpl: providerResponse('wss://api.elevenlabs.io/session') };
  const authorize = createVoiceService({ ...options, perIpLimit: 1 });
  assert.equal((await authorize(request)).status, 200);
  assert.equal((await authorize(request)).status, 429);
  assert.equal((await createVoiceService({ ...options, dailyLimit: 0 })(request)).status, 429);
});

test('voice endpoint is same-origin, uncached, and does not publish private files', async () => {
  const server = createSiteServer({ voice: { apiKey: 'test', agentId: 'test', fetchImpl: providerResponse('wss://api.elevenlabs.io/session') } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/voice/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/server/voice.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/node_modules/@elevenlabs/client/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/.local/voice-agent.json`)).status, 404);
    const sdk = await fetch(`${base}/assets/vendor/elevenlabs.js`);
    assert.equal(sdk.status, 200);
    assert.match(await sdk.text(), /ElevenLabsClient/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('voice sync changes only company context, events, call length and authentication', async () => {
  const prompt = await loadVoicePrompt();
  const config = buildVoiceConfiguration({ conversation_config: { tts: { voice_id: 'existing-voice' }, conversation: { client_events: ['ping'] } }, platform_settings: { auth: { allowlist: [{ hostname: 'example.com' }] } } }, prompt);
  assert.equal(config.conversation_config.tts, undefined);
  assert.equal(config.conversation_config.agent.prompt.prompt, prompt);
  assert.deepEqual(config.conversation_config.agent.prompt.knowledge_base, []);
  assert.ok(voiceEvents.every(event => config.conversation_config.conversation.client_events.includes(event)));
  assert.equal(config.platform_settings.auth.enable_auth, true);
  assert.equal(config.platform_settings.overrides.conversation_config_override.agent.prompt.prompt, false);
  assert.equal(config.platform_settings.auth.allowlist[0].hostname, 'example.com');
  assert.throws(() => buildVoiceConfiguration({ workflow: { nodes: { custom: { type: 'override_agent' } } } }, prompt));
});

test('voice refuses sessions when remote company knowledge has not been synced', async () => {
  let calls = 0;
  const authorize = createVoiceService({ apiKey: 'test', agentId: 'test', fetchImpl: async () => { calls++; return Response.json({ conversation_config: { agent: { prompt: { prompt: 'stale' } } } }); } });
  assert.equal((await authorize(request)).status, 503);
  assert.equal(calls, 1);
});

test('voice does not publish invalid or failed transcription authorization', async () => {
  for (const token of [undefined, '', 123]) {
    const authorize = createVoiceService({ apiKey: 'test', agentId: 'test', fetchImpl: async url => String(url).includes('/agents/') ? agentResponse() : String(url).includes('/single-use-token/') ? Response.json({ token }) : Response.json({ signed_url: 'wss://api.elevenlabs.io/session' }) });
    const result = await authorize(request);
    assert.equal(result.status, 502);
    assert.equal(result.body.signedUrl, undefined);
  }
});