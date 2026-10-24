(() => {
  const dialog = document.getElementById('voice-dialog');
  const launcher = document.getElementById('assistant-launcher');
  const start = document.getElementById('start-voice');
  const end = document.getElementById('end-voice');
  const mute = document.getElementById('voice-mute');
  const speaker = document.getElementById('voice-speaker');
  const reset = document.getElementById('reset-voice');
  const status = document.getElementById('voice-state');
  const stage = document.getElementById('voice-stage');
  const error = document.getElementById('voice-error');
  const log = document.getElementById('voice-log');
  const caption = document.getElementById('voice-live-caption');
  const timer = document.getElementById('voice-timer');
  const canvas = document.getElementById('voice-orb');
  const context = canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const turns = new Map();
  let partial = null;
  let attempt = null;
  let starting = false;
  let ending = false;
  let sdkLoading;
  let frame = 0;
  let inputLevel = 0;
  let outputLevel = 0;

  function controls() {
    const connected = Boolean(attempt?.session);
    start.hidden = Boolean(attempt);
    start.disabled = starting || ending;
    end.hidden = !attempt;
    mute.disabled = !connected;
    speaker.disabled = !connected;
    reset.disabled = Boolean(attempt) || starting || ending;
  }

  function setState(text, state) {
    status.textContent = text;
    stage.dataset.state = state;
  }

  function listeningState() {
    if (!attempt?.session) return;
    setState(attempt.mode === 'speaking' ? 'tyche.ai is speaking' : attempt.muted ? 'Microphone muted' : 'Listening to you', attempt.mode === 'speaking' ? 'speaking' : attempt.muted ? 'muted' : 'listening');
  }

  function clearTranscript() {
    log.replaceChildren();
    caption.textContent = '';
    caption.hidden = true;
    turns.clear();
    partial = null;
  }

  function message(text, role, id, provisional = false) {
    if (typeof text !== 'string' || !text.trim()) return;
    document.getElementById('voice-empty')?.remove();
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 70;
    const key = `${role}:${id}`;
    let row = role === 'user' && partial ? partial : turns.get(key);
    if (!row) {
      row = document.createElement('div');
      row.className = `voice-turn voice-turn-${role}`;
      const label = document.createElement('div');
      label.className = 'voice-turn-label';
      const content = document.createElement('div');
      content.className = `chat-message chat-message-${role === 'user' ? 'user' : 'assistant'}`;
      row.append(label, content);
      log.append(row);
    }
    row.dataset.partial = String(provisional);
    row.firstElementChild.textContent = role === 'user' ? provisional ? 'You, speaking' : 'You' : 'tyche.ai';
    row.lastElementChild.textContent = text.slice(0, 6000);
    if (role === 'user') partial = provisional ? row : null;
    if (!provisional) turns.set(key, row);
    while (log.children.length > 100) log.firstElementChild.remove();
    for (const [turnKey, turn] of turns) if (!turn.isConnected) turns.delete(turnKey);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function loadSdk() {
    if (window.ElevenLabsClient?.Conversation) return Promise.resolve(window.ElevenLabsClient.Conversation);
    if (sdkLoading) return sdkLoading;
    sdkLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => { script.remove(); sdkLoading = null; reject(new Error('SDK_UNAVAILABLE')); }, 20000);
      script.src = 'assets/vendor/elevenlabs.js';
      script.onload = () => {
        clearTimeout(timeout);
        if (window.ElevenLabsClient?.Conversation) resolve(window.ElevenLabsClient.Conversation);
        else { sdkLoading = null; script.remove(); reject(new Error('SDK_UNAVAILABLE')); }
      };
      script.onerror = () => { clearTimeout(timeout); sdkLoading = null; script.remove(); reject(new Error('SDK_UNAVAILABLE')); };
      document.head.append(script);
    });
    return sdkLoading;
  }

  async function stop(text = 'Call ended') {
    const previous = attempt;
    attempt = null;
    if (previous) {
      previous.cancelled = true;
      previous.controller.abort();
      previous.scribe?.close();
      clearInterval(previous.clock);
      clearTimeout(previous.deadline);
      previous.stream?.getTracks().forEach(track => track.stop());
    }
    if (partial) { partial.dataset.partial = 'false'; partial.firstElementChild.textContent = 'You, unfinished'; partial = null; }
    caption.hidden = true;
    caption.textContent = '';
    ending = ending || Boolean(previous?.session);
    setState(text, 'idle');
    controls();
    if (previous?.session) {
      try { await previous.session.endSession(); } catch {}
      ending = false;
      controls();
    }
  }

  async function connect() {
    if (attempt || starting || ending) return;
    error.textContent = '';
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || location.protocol === 'file:') {
      error.textContent = 'Voice needs HTTPS or localhost and microphone support. You can still use chat or WhatsApp.';
      return;
    }
    const current = { controller: new AbortController(), cancelled: false, session: null, muted: false, quiet: false, mode: 'listening' };
    attempt = current;
    starting = true;
    clearTranscript();
    timer.textContent = '00:00';
    mute.setAttribute('aria-pressed', 'false');
    mute.setAttribute('aria-label', 'Mute microphone');
    mute.title = 'Mute microphone';
    mute.querySelector('use').setAttribute('href', 'assets/icons.svg#mic');
    speaker.setAttribute('aria-pressed', 'false');
    speaker.setAttribute('aria-label', 'Mute speaker');
    speaker.title = 'Mute speaker';
    speaker.querySelector('use').setAttribute('href', 'assets/icons.svg#volume-2');
    setState('Waiting for microphone', 'connecting');
    controls();
    const alive = () => attempt === current && !current.cancelled && dialog.open;
    try {
      current.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      current.stream.getTracks().forEach(track => track.stop());
      current.stream = null;
      if (!alive()) return;
      setState('Connecting your call', 'connecting');
      const Conversation = await loadSdk();
      if (!alive()) return;
      const response = await fetch('api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(25000)]) });
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
      if (!alive()) return;
      if (!response.ok || !data.signedUrl || !data.scribeToken) {
        error.textContent = data.error || 'Voice is temporarily unavailable. Please try chat or WhatsApp.';
        await stop('Unable to connect');
        return;
      }
      current.scribe = window.ElevenLabsClient.Scribe.connect({ token: data.scribeToken, modelId: 'scribe_v2_realtime', commitStrategy: 'vad', microphone: { echoCancellation: true, noiseSuppression: true } });
      current.scribe.on('session_started', () => { if (alive()) current.scribeReady = true; });
      current.scribe.on('partial_transcript', event => {
        if (!alive() || current.muted || typeof event.text !== 'string' || !event.text.trim()) return;
        caption.textContent = `You, speaking: ${event.text.slice(0, 6000)}`;
        caption.hidden = false;
        caption.scrollTop = caption.scrollHeight;
      });
      const transcriptionUnavailable = () => {
        if (!alive()) return;
        current.scribe?.close();
        current.scribe = null;
        current.scribeReady = false;
        caption.hidden = true;
        error.textContent = 'Live word-by-word transcription is unavailable. Completed turns will still appear.';
      };
      current.scribe.on('error', transcriptionUnavailable);
      current.scribe.on('close', () => { if (current.scribe) transcriptionUnavailable(); });
      current.deadline = setTimeout(() => { if (alive()) void stop('Connection timed out. Please try again.'); }, 30000);
      const session = await Conversation.startSession({
        signedUrl: data.signedUrl,
        connectionType: 'websocket',
        stripAudioTags: true,
        onMessage: event => {
          if (!alive()) return;
          message(event.message, event.role === 'user' ? 'user' : 'agent', event.response_id ?? event.event_id);
          if (event.role === 'user') { caption.hidden = true; caption.textContent = ''; }
        },
        onIncomingEvent: event => {
          if (!alive() || current.scribeReady || event.type !== 'tentative_user_transcript') return;
          const transcript = event.tentative_user_transcription_event;
          if (transcript) message(transcript.user_transcript, 'user', transcript.event_id, true);
        },
        onAgentResponseCorrection: event => {
          if (!alive()) return;
          const row = turns.get(`agent:${event.response_id ?? event.event_id}`) || [...turns.values()].reverse().find(turn => turn.classList.contains('voice-turn-agent') && turn.lastElementChild.textContent === event.original_agent_response);
          if (row && typeof event.corrected_agent_response === 'string') row.lastElementChild.textContent = event.corrected_agent_response.slice(0, 6000);
        },
        onModeChange: ({ mode }) => { if (alive()) { current.mode = mode; listeningState(); } },
        onDisconnect: details => { if (alive()) { if (details.reason === 'error') error.textContent = 'The call disconnected. Please try again or use chat.'; void stop('Call ended'); } },
        onError: () => { if (alive()) { error.textContent = 'The voice connection was interrupted. Please try again or use chat.'; void stop('Call interrupted'); } }
      });
      clearTimeout(current.deadline);
      if (!alive()) { await session.endSession(); return; }
      current.session = session;
      current.started = Date.now();
      current.clock = setInterval(() => {
        if (!alive()) return;
        const elapsed = Math.floor((Date.now() - current.started) / 1000);
        timer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      }, 1000);
      current.deadline = setTimeout(() => { if (alive()) void stop('Five-minute call complete'); }, 300000);
      listeningState();
    } catch (failure) {
      if (alive()) {
        error.textContent = ['NotAllowedError', 'PermissionDeniedError'].includes(failure.name) ? 'Microphone access was denied. Allow microphone access in your browser, then try again.' : failure.name === 'NotFoundError' ? 'No microphone was found. Connect one and try again.' : 'Unable to start voice. Check your microphone and connection, or use chat.';
        await stop('Unable to connect');
      }
    } finally {
      current.stream?.getTracks().forEach(track => track.stop());
      clearTimeout(current.cancelled ? current.deadline : undefined);
      starting = false;
      controls();
    }
  }

  function draw(time) {
    frame = 0;
    if (!dialog.open || !context) return;
    const session = attempt?.session;
    const input = session && !attempt.muted ? session.getInputVolume() : 0;
    const output = session && !attempt.quiet ? session.getOutputVolume() : 0;
    inputLevel += (Math.max(0, Math.min(1, Number(input) || 0)) - inputLevel) * .14;
    outputLevel += (Math.max(0, Math.min(1, Number(output) || 0)) - outputLevel) * .14;
    canvas.dataset.inputLevel = inputLevel.toFixed(3);
    canvas.dataset.outputLevel = outputLevel.toFixed(3);
    const phase = reducedMotion.matches ? 0 : time / 1600;
    context.clearRect(0, 0, 640, 360);
    context.save();
    context.translate(320, 180);
    for (let layer = 3; layer >= 0; layer--) {
      const intensity = layer % 2 ? inputLevel : outputLevel;
      const radius = 99 + layer * 8 + intensity * 22;
      context.beginPath();
      for (let point = 0; point <= 160; point++) {
        const angle = point / 160 * Math.PI * 2;
        const ripple = Math.sin(angle * 3 + phase + layer) * (4 + intensity * 14) + Math.cos(angle * 5 - phase * .7 + layer) * (2 + intensity * 7);
        const distance = radius + ripple;
        const horizontal = Math.cos(angle) * distance;
        const vertical = Math.sin(angle) * distance;
        if (point === 0) context.moveTo(horizontal, vertical); else context.lineTo(horizontal, vertical);
      }
      context.closePath();
      if (layer === 0) {
        const fill = context.createRadialGradient(-35, -38, 8, 16, 22, 135);
        fill.addColorStop(0, '#ffe6b8');
        fill.addColorStop(.34, '#ff9a51');
        fill.addColorStop(.7, '#ef4d14');
        fill.addColorStop(1, '#a42c28');
        context.fillStyle = fill;
        context.fill();
      } else {
        context.fillStyle = layer % 2 ? `rgba(22,140,135,${.08 + intensity * .15})` : `rgba(239,77,20,${.07 + intensity * .15})`;
        context.fill();
        context.strokeStyle = layer % 2 ? '#168c87' : '#ef4d14';
        context.globalAlpha = .2 + intensity * .45;
        context.lineWidth = 1.4;
        context.stroke();
        context.globalAlpha = 1;
      }
    }
    context.beginPath();
    context.ellipse(-25 + Math.sin(phase) * 9, -32, 42, 20, -.6, 0, Math.PI * 2);
    context.fillStyle = '#fff8e630';
    context.fill();
    context.restore();
    frame = requestAnimationFrame(draw);
  }

  document.getElementById('open-voice').addEventListener('click', () => {
    document.getElementById('assistant-options').hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    dialog.showModal();
    if (!frame) frame = requestAnimationFrame(draw);
    start.focus();
  });
  start.addEventListener('click', () => void connect());
  end.addEventListener('click', () => void stop());
  reset.addEventListener('click', () => { clearTranscript(); timer.textContent = '00:00'; error.textContent = ''; setState('Ready to connect', 'idle'); });
  mute.addEventListener('click', () => {
    if (!attempt?.session) return;
    attempt.muted = !attempt.muted;
    try {
      attempt.session.setMicMuted(attempt.muted);
      if (attempt.muted) attempt.scribe?.mute(); else attempt.scribe?.unmute();
    } catch { error.textContent = 'Unable to change microphone access. The call was ended for privacy.'; void stop(); return; }
    if (attempt.muted) { caption.hidden = true; caption.textContent = ''; }
    mute.setAttribute('aria-pressed', String(attempt.muted));
    mute.setAttribute('aria-label', attempt.muted ? 'Unmute microphone' : 'Mute microphone');
    mute.title = mute.getAttribute('aria-label');
    mute.querySelector('use').setAttribute('href', `assets/icons.svg#${attempt.muted ? 'mic-off' : 'mic'}`);
    listeningState();
  });
  speaker.addEventListener('click', () => {
    if (!attempt?.session) return;
    attempt.quiet = !attempt.quiet;
    attempt.session.setVolume({ volume: attempt.quiet ? 0 : 1 });
    speaker.setAttribute('aria-pressed', String(attempt.quiet));
    speaker.setAttribute('aria-label', attempt.quiet ? 'Unmute speaker' : 'Mute speaker');
    speaker.title = speaker.getAttribute('aria-label');
    speaker.querySelector('use').setAttribute('href', `assets/icons.svg#${attempt.quiet ? 'volume-x' : 'volume-2'}`);
  });
  const close = () => { void stop(); dialog.close(); cancelAnimationFrame(frame); frame = 0; launcher.focus(); };
  document.getElementById('close-voice').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) close(); });
  dialog.addEventListener('close', () => { void stop(); cancelAnimationFrame(frame); frame = 0; });
  window.addEventListener('pagehide', () => { void stop(); cancelAnimationFrame(frame); });
})();