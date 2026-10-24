(() => {
  const widget = document.getElementById('assistant-widget');
  const launcher = document.getElementById('assistant-launcher');
  const options = document.getElementById('assistant-options');
  const dialog = document.getElementById('chat-dialog');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');
  const status = document.getElementById('chat-status');
  const suggestions = document.getElementById('chat-suggestions');
  let history = [];
  let pending = null;

  function toggleOptions(open) {
    options.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (open) document.getElementById('open-chat').focus();
  }

  function addMessage(text, role) {
    const message = document.createElement('div');
    message.className = `chat-message chat-message-${role}`;
    message.textContent = text;
    log.append(message);
    log.scrollTop = log.scrollHeight;
    return message;
  }

  function setBusy(busy) {
    send.disabled = busy;
    suggestions.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    form.setAttribute('aria-busy', String(busy));
  }

  async function submitMessage(question) {
    question = question.trim();
    if (!question || pending) return;
    if (location.protocol === 'file:') {
      status.textContent = 'Open the website through its server to chat. You can still contact us on WhatsApp.';
      return;
    }
    addMessage(question, 'user');
    input.value = '';
    status.textContent = '';
    const thinking = addMessage('Thinking...', 'assistant');
    thinking.classList.add('chat-thinking');
    const controller = new AbortController();
    pending = controller;
    setBusy(true);
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch('api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, history }),
        signal: controller.signal
      });
      let result;
      try { result = await response.json(); }
      catch { throw new Error('Chat is unavailable right now. Please try again or use WhatsApp.'); }
      if (!response.ok) throw new Error(result.error || 'Chat is unavailable right now. Please try again or use WhatsApp.');
      if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('We could not get a reply. Please try again.');
      if (pending !== controller) return;
      thinking.textContent = result.answer;
      thinking.classList.remove('chat-thinking');
      history = [...history, question].slice(-6);
    } catch (error) {
      if (pending !== controller) return;
      thinking.remove();
      status.textContent = error.name === 'AbortError' ? 'The reply took too long. Please try again or use WhatsApp.' : error instanceof TypeError ? 'Unable to connect. Please try again or use WhatsApp.' : error.message;
      if (!input.value) input.value = question;
    } finally {
      clearTimeout(timeout);
      if (pending === controller) {
        pending = null;
        setBusy(false);
        log.scrollTop = log.scrollHeight;
        if (dialog.open && window.matchMedia('(min-width: 601px)').matches) input.focus();
      }
    }
  }

  launcher.addEventListener('click', () => toggleOptions(options.hidden));
  document.addEventListener('click', event => { if (!widget.contains(event.target)) toggleOptions(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !options.hidden) { toggleOptions(false); launcher.focus(); }
  });
  document.getElementById('open-chat').addEventListener('click', () => {
    toggleOptions(false);
    dialog.showModal();
  });
  document.getElementById('close-chat').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (pending) {
      pending.abort();
      pending = null;
      log.querySelector('.chat-thinking')?.remove();
      status.textContent = 'Reply cancelled. You can send another message.';
      setBusy(false);
    }
    launcher.focus();
  });
  document.getElementById('reset-chat').addEventListener('click', () => {
    pending?.abort();
    pending = null;
    history = [];
    log.replaceChildren();
    addMessage('Hi! What would you like to know about tyche.ai?', 'assistant');
    status.textContent = '';
    input.value = '';
    setBusy(false);
    input.focus();
  });
  form.addEventListener('submit', event => { event.preventDefault(); submitMessage(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  suggestions.addEventListener('click', event => {
    const button = event.target.closest('[data-chat-prompt]');
    if (button) submitMessage(button.dataset.chatPrompt);
  });
})();