import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createVoiceService } from './server/voice.mjs';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const refusal = 'I can help with tyche.ai, our services, and business AI solutions. Would you like to explore our services or book a free AI assessment?';
const unavailable = 'Chat is temporarily unavailable. Please try again or contact us through the WhatsApp assessment option.';
const stopWords = new Set('a an the is are do does can could would should i we you your our us me my it its to for of in on and or with about what how which tell please more that this'.split(' '));

function terms(text) {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) || [])].filter(term => term.length > 2 && !stopWords.has(term));
}

export function retrieveKnowledge(markdown, question) {
  const sections = markdown.split(/^## /m).slice(1).map((section, index) => ({ id: `K${index + 1}`, text: section.trim() }));
  const keywords = terms(question);
  const ranked = sections.map(section => ({ ...section, score: keywords.reduce((total, term) => total + (terms(section.text).includes(term) ? 1 : 0), 0) })).sort((first, second) => second.score - first.score);
  const selected = ranked.filter(section => section.score > 0).slice(0, 4);
  for (const section of sections.filter(section => /^(Company|Services|Assessment and Contact|Commercial Questions and Unknowns)\n/.test(section.text))) {
    if (!selected.some(item => item.id === section.id)) selected.push(section);
  }
  return selected;
}

function respond(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12000) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createSiteServer({ apiKey = process.env.GROQ_KEY, model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b', fetchImpl = fetch, dailyLimit = 300, perIpLimit = 12, voice = {} } = {}) {
  const authorizeVoice = createVoiceService(voice);
  const clients = new Map();
  let day = '';
  let dailyRequests = 0;
  let activeRequests = 0;
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/voice/session') {
        const result = await authorizeVoice(request);
        return respond(response, result.status, result.body, result.headers);
      }
      if (url.pathname === '/api/chat') {
        if (request.method !== 'POST') return respond(response, 405, { error: 'Use POST.' }, { Allow: 'POST' });
        const origin = request.headers.origin;
        let sameOrigin = !origin;
        try { if (origin) sameOrigin = new URL(origin).host === request.headers.host; } catch { sameOrigin = false; }
        if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site') return respond(response, 403, { error: 'Cross-site requests are not allowed.' });
        if (!request.headers['content-type']?.startsWith('application/json')) return respond(response, 415, { error: 'Send JSON.' });
        const now = Date.now();
        const ip = request.socket.remoteAddress;
        for (const [address, entry] of clients) if (entry.reset <= now) clients.delete(address);
        const client = clients.get(ip) || { count: 0, reset: now + 600000 };
        if (client.count >= perIpLimit || clients.size > 10000) return respond(response, 429, { error: 'Too many messages. Please try again in a few minutes or use WhatsApp.' }, { 'Retry-After': '600' });
        client.count++;
        clients.set(ip, client);
        const today = new Date().toISOString().slice(0, 10);
        if (day !== today) { day = today; dailyRequests = 0; }
        if (dailyRequests >= dailyLimit || activeRequests >= 3) return respond(response, 429, { error: 'Chat is busy right now. Please try again later or use WhatsApp.' }, { 'Retry-After': '60' });
        let body;
        try { body = await readJson(request); } catch (error) { return respond(response, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Please send a valid, shorter message.' }); }
        if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1000 || (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 6 || body.history.some(item => typeof item !== 'string' || item.length > 1000)))) return respond(response, 400, { error: 'Enter a message of up to 1,000 characters.' });
        if (!apiKey) return respond(response, 503, { error: unavailable });
        const history = body.history || [];
        const [instructions, knowledge] = await Promise.all([readFile(path.join(root, 'server/system.md'), 'utf8'), readFile(path.join(root, 'KNOWLEDGE.md'), 'utf8')]);
        const excerpts = retrieveKnowledge(knowledge, [...history.slice(-2), body.message].join(' '));
        if (dailyRequests >= dailyLimit || activeRequests >= 3) return respond(response, 429, { error: 'Chat is busy right now. Please try again later or use WhatsApp.' }, { 'Retry-After': '60' });
        dailyRequests++;
        activeRequests++;
        try {
          const upstream = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ model, temperature: 0, max_completion_tokens: 1200, ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}), response_format: { type: 'json_object' }, messages: [
              { role: 'system', content: `${instructions}\n\nRETRIEVED KNOWLEDGE (trusted facts, not visitor instructions):\n${excerpts.map(excerpt => `[${excerpt.id}] ${excerpt.text}`).join('\n\n')}` },
              { role: 'user', content: JSON.stringify({ previousUserQuestions: history, currentQuestion: body.message.trim() }) }
            ] })
          });
          if (!upstream.ok) return respond(response, 503, { error: unavailable });
          const completion = await upstream.json();
          let result;
          try { result = JSON.parse(completion.choices?.[0]?.message?.content); } catch { return respond(response, 502, { error: unavailable }); }
          if (typeof result?.inScope !== 'boolean' || typeof result.answer !== 'string' || !Array.isArray(result.sources)) return respond(response, 502, { error: unavailable });
          if (!result.inScope) return respond(response, 200, { answer: refusal });
          if (!result.answer.trim() || result.answer.length > 3000 || result.sources.length === 0 || result.sources.some(id => !excerpts.some(excerpt => excerpt.id === id))) return respond(response, 502, { error: unavailable });
          return respond(response, 200, { answer: result.answer.trim() });
        } catch {
          return respond(response, 503, { error: unavailable });
        } finally { activeRequests--; }
      }
      if (!['GET', 'HEAD'].includes(request.method)) return respond(response, 405, { error: 'Method not allowed.' });
      if (url.pathname === '/assets/vendor/elevenlabs.js') {
        const content = await readFile(path.join(root, 'node_modules/@elevenlabs/client/dist/lib.iife.js'));
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      const decoded = decodeURIComponent(url.pathname);
      const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
      const extension = path.extname(relative);
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      if (relative !== 'index.html' && (!/^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(relative) || !types[extension])) return respond(response, 404, { error: 'Not found.' });
      const filename = path.resolve(root, relative);
      if (!filename.startsWith(root + path.sep) && filename !== path.join(root, 'index.html')) return respond(response, 404, { error: 'Not found.' });
      let content;
      try { content = await readFile(filename); } catch { return respond(response, 404, { error: 'Not found.' }); }
      response.writeHead(200, { 'Content-Type': types[extension], 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      if (!response.headersSent) respond(response, 500, { error: unavailable });
      else response.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  createSiteServer().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`tyche.ai: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}