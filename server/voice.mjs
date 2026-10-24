import { readFile } from 'node:fs/promises';

const unavailable = 'Voice is temporarily unavailable. Please try chat or WhatsApp instead.';
export const voiceEvents = ['audio', 'interruption', 'user_transcript', 'tentative_user_transcript', 'agent_response', 'agent_response_correction', 'vad_score'];

export async function loadVoicePrompt() {
  const [instructions, knowledge] = await Promise.all([
    readFile(new URL('./voice-system.md', import.meta.url), 'utf8'),
    readFile(new URL('../KNOWLEDGE.md', import.meta.url), 'utf8')
  ]);
  return `${instructions.trim()}\n\nCOMPANY KNOWLEDGE:\n${knowledge.trim()}`;
}

export function buildVoiceConfiguration(agent, prompt) {
  const nodes = Object.values(agent.workflow?.nodes || {});
  if (nodes.some(node => node.type !== 'start')) throw new Error('Review the agent workflow before syncing company knowledge.');
  return {
    conversation_config: {
      agent: { prompt: { prompt, knowledge_base: [], rag: { enabled: false } } },
      conversation: { max_duration_seconds: 300, client_events: [...new Set([...(agent.conversation_config?.conversation?.client_events || []), ...voiceEvents])] }
    },
    platform_settings: {
      auth: { ...agent.platform_settings?.auth, enable_auth: true },
      overrides: { conversation_config_override: { agent: { prompt: { prompt: false, knowledge_base: false } } } }
    }
  };
}

export function createVoiceService({ apiKey = process.env.ELEVENLABS_API_KEY, agentId = process.env.ELEVENLABS_AGENT_ID, fetchImpl = fetch, perIpLimit = 5, dailyLimit = 100 } = {}) {
  const clients = new Map();
  let day = '';
  let issued = 0;
  let active = 0;
  return async function authorize(request) {
    if (request.method !== 'POST') return { status: 405, body: { error: 'Use POST.' }, headers: { Allow: 'POST' } };
    let sameOrigin = !request.headers.origin;
    try { if (request.headers.origin) sameOrigin = new URL(request.headers.origin).host === request.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site') return { status: 403, body: { error: 'Cross-site requests are not allowed.' } };
    if (!request.headers['content-type']?.startsWith('application/json')) return { status: 415, body: { error: 'Send JSON.' } };
    if (!apiKey || !agentId) return { status: 503, body: { error: unavailable } };
    const now = Date.now();
    for (const [address, entry] of clients) if (entry.reset <= now) clients.delete(address);
    const ip = request.socket.remoteAddress;
    const client = clients.get(ip) || { count: 0, reset: now + 600000 };
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) { day = today; issued = 0; }
    if (client.count >= perIpLimit || issued >= dailyLimit || active >= 3 || clients.size > 10000) return { status: 429, body: { error: 'Voice is busy. Please try again later or use chat.' }, headers: { 'Retry-After': '600' } };
    client.count++;
    clients.set(ip, client);
    issued++;
    active++;
    try {
      const agentResponse = await fetchImpl(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(15000) });
      if (!agentResponse.ok) return { status: 503, body: { error: unavailable } };
      const agent = await agentResponse.json();
      const config = agent.conversation_config;
      const expectedPrompt = await loadVoicePrompt();
      const overrides = agent.platform_settings?.overrides?.conversation_config_override?.agent?.prompt;
      if (config?.agent?.prompt?.prompt !== expectedPrompt || config.agent.prompt.knowledge_base?.length || overrides?.prompt || overrides?.knowledge_base || !voiceEvents.every(event => config.conversation?.client_events?.includes(event)) || !agent.platform_settings?.auth?.enable_auth || !config.conversation.max_duration_seconds || config.conversation.max_duration_seconds > 300 || Object.values(agent.workflow?.nodes || {}).some(node => node.type !== 'start')) return { status: 503, body: { error: unavailable } };
      const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
      url.searchParams.set('agent_id', agentId);
      url.searchParams.set('include_conversation_id', 'true');
      if (agent.version_id) url.searchParams.set('version_id', agent.version_id);
      const [response, transcription] = await Promise.all([
        fetchImpl(url, { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(15000) }),
        fetchImpl('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', { method: 'POST', headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(15000) })
      ]);
      if (!response.ok || !transcription.ok) return { status: 503, body: { error: unavailable } };
      const [result, scribe] = await Promise.all([response.json(), transcription.json()]);
      if (typeof scribe.token !== 'string' || !scribe.token || scribe.token.length > 4096) return { status: 502, body: { error: unavailable } };
      const signed = new URL(result.signed_url);
      if (signed.protocol !== 'wss:' || signed.hostname !== 'api.elevenlabs.io' || signed.username || signed.password) return { status: 502, body: { error: unavailable } };
      return { status: 200, body: { signedUrl: signed.href, scribeToken: scribe.token } };
    } catch {
      return { status: 503, body: { error: unavailable } };
    } finally { active--; }
  };
}