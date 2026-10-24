# tyche.ai Website

HTML, CSS, and JavaScript website with a native Node.js server for private Groq and ElevenLabs requests. No framework or build step. Node.js 22 or newer is required. The official ElevenLabs browser SDK is the only direct dependency; its prebuilt bundle is served locally and loaded only when starting a voice call.

## Project Structure

```text
index.html                 Main website entry point
assets/css/styles.css      Shared page styles and responsive layouts
assets/js/main.js          Navigation, animations, counters, WhatsApp enquiries
assets/js/chat.js          Chat launcher, dialog, and API requests
assets/js/voice.js         Voice sessions, live transcripts, audio-reactive orb
assets/images/             Images extracted from the original page
assets/icons.svg           Locally bundled Lucide icons
KNOWLEDGE.md               Approved company knowledge used by the chatbot
server/system.md           Company-only scope and grounding instructions
server/voice-system.md     Company-only spoken-response instructions
server/voice.mjs           Private voice session authorization and readiness checks
server/sync-voice.mjs      Sync approved knowledge/settings to the existing agent
server.mjs                 Private AI endpoints and allowlisted static hosting
tests/chat.test.mjs        Dependency-free server and security tests
tests/voice.test.mjs       Voice authorization and knowledge-sync tests
index (3).html             Unchanged original page, kept as a reference
```

Edit `index.html` for content, `assets/css/styles.css` for presentation, and `assets/js/main.js` for browser interactions. Some element-specific styles remain inline to preserve the existing design. Keep relative asset paths intact so the site also works from a subdirectory.

## Preview and Check

Keep your `GROQ_KEY` in the ignored project-root `.env`, or set it as a server environment variable. `.env.example` documents the variable names without a real key. The default model is `openai/gpt-oss-20b`; set `GROQ_MODEL` only to a model enabled for your Groq account that supports JSON output. GPT-OSS uses low reasoning effort and a bounded completion budget. Requests are billable under your Groq plan.

Install dependencies, then start the website:

```sh
npm ci
npm start
```

Open `http://127.0.0.1:3000`. If that port is occupied, use `PORT=3087 npm start` on macOS/Linux. Opening the HTML directly can preview the page, but the chat endpoint and external SVG sprite require HTTP. The Google Fonts stylesheet needs an internet connection.

Run automated tests with `npm test`. Tests mock Groq and ElevenLabs and never require your keys or incur API charges. Check desktop/mobile layouts, navigation, FAQ expansion, counters, and WhatsApp enquiries before publishing.

## Chat Behavior

The floating Chatbot button offers Chat with Us, Talk with Us, and the existing WhatsApp assessment link. Starter questions send real chat requests. The WhatsApp assessment link remains available inside both dialogs. Text chat never requests microphone permission.

`KNOWLEDGE.md` is the sole company knowledge source. The server ranks Markdown sections by keyword overlap with the question and recent questions, then adds core company, services, contact, and unknown-commercial-detail context. Retrieved excerpts and `server/system.md` are supplied to Groq. No embeddings, vector database, or browsing is used. Update approved knowledge manually as the business changes.

The model returns a scope decision, answer, and supporting excerpt IDs. The server replaces out-of-scope answers with a fixed refusal and rejects missing/unknown citations or malformed output. Model-based scope and grounding reduce risk but cannot mathematically guarantee immunity to hallucination or prompt injection; retest after model/prompt changes. Citation validation checks IDs, not whether every sentence is entailed by them.

Conversation context contains only the last six user questions, is kept in browser memory, and is cleared on reset/reload. Assistant replies are not accepted as trusted history. Messages and retrieved company excerpts are sent to Groq, whose own data-handling terms apply. The app does not persist or log conversations; responses render as plain text, never executable HTML.

Abuse controls include 1,000-character messages, bounded request bodies/history, same-origin checks, a 20-second provider timeout, 12 requests per network address per 10 minutes, three concurrent provider requests, and 300 provider requests per UTC day. These counters are in memory, reset on restart, and are not shared across instances. Behind a reverse proxy, addresses may be shared: configure trusted proxy handling at the hosting layer rather than trusting arbitrary forwarded headers. Set Groq account-level spend limits and add durable/shared quotas or a managed rate limiter before scaling public traffic. Origin checks are not authentication or bot protection.

The existing enquiry form still opens WhatsApp. Email links open the visitor's email application; no server email integration is included.

## Voice AI

Set `ELEVENLABS_AGENT_ID` and `ELEVENLABS_API_KEY` in the server's ignored `.env`. The key must have permission to read/edit this agent and authorize conversations. Then run:

```sh
npm run voice:sync
```

This updates the **existing ElevenLabs agent**, not just the local website. Its chosen voice, language, LLM, first message, and speech settings remain unchanged. The sync saves a private configuration backup under ignored `.local/`, replaces the company system context with `server/voice-system.md` plus the complete `KNOWLEDGE.md`, detaches older knowledge references without deleting documents, disables RAG and browser prompt/knowledge overrides, enables partial/final transcript events and signed-session authentication, and caps calls at five minutes. Existing hostname restrictions are preserved. Agents with workflow nodes beyond a start node require manual review before this sync will run. Other sites using this agent must also use signed authorization after sync.

Run `npm run voice:sync` again after editing either knowledge or voice instructions. The session endpoint checks the remote prompt, events, authentication, and call limit before issuing a single-use signed WebSocket URL, pinned to the checked agent version. A mismatch fails closed until resynced. Full company context is short enough to include directly; no vector database or additional knowledge service is needed. Model grounding is a safeguard, not a guarantee against hallucinations or prompt injection.

Visitors open Talk with Us, then explicitly start a call and allow microphone access. HTTPS or localhost is required. A parallel ElevenLabs Scribe v2 Realtime stream supplies genuine while-speaking captions; agent partial-transcript events alone were not emitted in live testing. The same official SDK manages both streams, with separate single-use Scribe authorization issued by the server. Enable the key's speech-to-text access as well as Conversational AI access. **Scribe transcription is billed separately from agent calls.** Scribe captions are provisional; the agent's finalized user turns, replies, and interruption corrections form the conversation transcript without duplicate turns. Both microphone streams mute and close together. If Scribe drops, the call can continue with a visible warning and finalized transcripts. The canvas orb uses actual microphone and playback volume, with separate teal/coral responses, smoothing, and reduced-motion handling. There are microphone/speaker mute controls, elapsed call time, end/retry controls, and cleanup on close, Escape, navigation, or connection failure. Closing during startup cancels authorization and ends any session that resolves late; starting another call stays disabled until startup/cleanup settles. Each new call clears the prior on-screen transcript.

Audio and conversation content go to ElevenLabs, whose recording and retention settings/terms apply, including Scribe's own logging settings. The app does not store audio or persist transcripts. Configure recording/retention, hostname allowlists, account spend limits, daily call limits, and concurrency in the ElevenLabs dashboard before public deployment. Local authorization limits are five attempts per address per ten minutes, 100 per UTC day, and three concurrent authorization requests, not three concurrent calls. In-memory counters reset on restart; direct scripts/bots can still use the public authorization endpoint. Provider-side call/spend limits are essential, including transcription limits: a visitor could reuse their own single-use Scribe authorization for a longer transcription session than the UI permits. The five-minute agent limit applies to every channel using this agent.

## Publish to Hostinger

1. Commit reviewed changes to your GitHub repository. No automated deployment is configured yet.
2. Back up the current live website before replacing files.
3. Confirm your plan supports a persistent Node.js 22 application or a VPS. Run `npm ci`, configure the environment, run `npm run voice:sync`, then run `server.mjs` with the host's process manager and route the site through it over HTTPS. Use the assigned `PORT` and, if required, set `HOST=0.0.0.0`; local development defaults to loopback.
4. Keep the application root, `.env`, `.local/`, `KNOWLEDGE.md`, and `server/` outside any public Apache/Nginx static document root. Set `GROQ_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_AGENT_ID` in the host's server environment, never in GitHub source or browser assets. The Node server serves only `index.html`, approved asset types, and the specific prebuilt browser SDK; it does not publish private files or arbitrary `node_modules` files.
5. If you retain a separate static frontend, publish only `index.html` and `assets/` and configure same-origin reverse proxies for `/api/chat`, `/api/voice/session`, and `/assets/vendor/elevenlabs.js` to Node. Plain HTML upload alone does not enable AI. A PHP-only/shared plan requires an external Node service or a separate backend implementation; neither is configured automatically here. Browser connections must be allowed to ElevenLabs' secure WebSocket endpoints.
6. Confirm the live homepage, icons, images, text/voice chat, mobile navigation, and WhatsApp links over HTTPS. Verify `/.env`, `/.local/`, `/KNOWLEDGE.md`, and `/server/system.md` return 404/403. Check microphone permissions and transcription with a real microphone on target mobile browsers. Preserve existing unrelated files and server configuration.

Do not upload the original reference page, this README, or Git metadata as part of the live site. If an older `index.php` or another default index file exists, check the host's index priority before switching entry points.

Git-based deployment or GitHub Actions can be configured after verifying the Hostinger plan, document root, and available Git/SSH/SFTP support. Updating website files does not require changing the domain's email or DNS records.

## Future Integrations

- Email enquiries need a server-side endpoint, input validation, spam protection, and a transactional email provider.
- Keep provider credentials on the server or in deployment secrets, never in HTML, browser JavaScript, or Git history.
- Confirm the hosting plan's runtime and connection limits before choosing PHP, Node.js, or an external backend service.

Server email integration is not implemented. No deployment or DNS changes have been made.

## Icons

The bundled icons are from Lucide v0.468.0 (https://lucide.dev). Their license is included in `assets/icons.LICENSE.txt`.