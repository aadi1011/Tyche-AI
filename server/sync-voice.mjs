import { mkdir, writeFile } from 'node:fs/promises';
import { buildVoiceConfiguration, loadVoicePrompt } from './voice.mjs';

try {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) throw new Error('Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server.');
  const url = `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`;
  const headers = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Could not read the voice agent (HTTP ${response.status}).`);
  const agent = await response.json();
  const payload = buildVoiceConfiguration(agent, await loadVoicePrompt());
  const backupDirectory = new URL('../.local/', import.meta.url);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await writeFile(new URL(`voice-agent-${Date.now()}.json`, backupDirectory), JSON.stringify(agent, null, 2), { mode: 0o600 });
  const updated = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  if (!updated.ok) {
    const failure = await updated.json().catch(() => ({}));
    const missingWrite = failure.detail?.status === 'missing_permissions' && /\bconvai_write\b/.test(failure.detail?.message || '');
    throw new Error(`Could not sync voice knowledge (HTTP ${updated.status}). ${missingWrite ? 'Enable Conversational AI write (convai_write) for this API key and save the change.' : 'Check agent-edit permissions and agent resource restrictions for this API key.'}`);
  }
  const result = await updated.json();
  if (result.conversation_config?.agent?.prompt?.prompt !== payload.conversation_config.agent.prompt.prompt) throw new Error('The provider did not confirm the updated company prompt.');
  console.log('Voice agent synced: company knowledge, live transcript events, signed-session authentication, and a five-minute call limit. Existing voice and speech settings preserved. Private backup saved under .local/.');
} catch (error) {
  console.error(error.name === 'TypeError' ? 'Unable to connect to ElevenLabs. Check the network and try again.' : error.message);
  process.exitCode = 1;
}