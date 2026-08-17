const $ = (id) => document.getElementById(id);
const KEY = 'la.token';

let token = localStorage.getItem(KEY) || '';
let pendingEmail = '';
let ended = false;
let countdownTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function show(which) {
  for (const id of ['login', 'consent', 'locked', 'session']) $(id).classList.toggle('hidden', id !== which);
}

let healthCache = null;
async function health() {
  if (healthCache) return healthCache;
  const res = await fetch('/api/health');
  healthCache = await res.json().catch(() => ({}));
  return healthCache;
}

// ---------- login ----------

$('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  pendingEmail = $('email').value.trim().toLowerCase();
  const { status, body } = await api('/api/auth/request', {
    method: 'POST',
    body: JSON.stringify({ email: pendingEmail }),
  });
  if (status !== 200) {
    $('login-err').textContent = 'That address did not work.';
    return;
  }
  $('email-form').classList.add('hidden');
  $('code-form').classList.remove('hidden');
  $('code-hint').textContent =
    body.delivery === 'console'
      ? 'Running locally: the code was printed to the server console.'
      : 'A code was sent to that address.';
  $('code').focus();
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  const { status, body } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email: pendingEmail, code: $('code').value.trim() }),
  });
  if (status !== 200) {
    $('login-err').textContent = 'That code did not work.';
    return;
  }
  token = body.token;
  localStorage.setItem(KEY, token);
  await boot();
});

// ---------- consent ----------

$('consent-checkbox').addEventListener('change', (e) => {
  $('consent-submit').disabled = !e.target.checked;
});

$('consent-submit').addEventListener('click', async () => {
  $('consent-err').textContent = '';
  const { status } = await api('/api/auth/consent', {
    method: 'POST',
    body: JSON.stringify({ agree: true }),
  });
  if (status !== 200) {
    $('consent-err').textContent = 'That did not go through — try again.';
    return;
  }
  await boot();
});

async function renderConsent(text) {
  show('consent');
  $('consent-text').textContent = text;
  $('consent-checkbox').checked = false;
  $('consent-submit').disabled = true;
  const h = await health();
  $('consent-crisis').textContent = h.crisisResourcesText || 'No verified crisis line is configured for this build.';
}

// ---------- the door ----------

function renderLock(until) {
  show('locked');
  clearInterval(countdownTimer);
  const tick = () => {
    const ms = until - Date.now();
    if (ms <= 0) {
      clearInterval(countdownTimer);
      boot();
      return;
    }
    const h = Math.floor(ms / 3.6e6);
    const m = Math.floor((ms % 3.6e6) / 6e4);
    const s = Math.floor((ms % 6e4) / 1000);
    $('countdown').textContent =
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ---------- session ----------

function addTurn(role, text, isGate = false) {
  const el = document.createElement('div');
  el.className = `turn ${role}${isGate ? ' gate' : ''}`;
  el.textContent = text;
  $('thread').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

function setComposerEnabled(on) {
  $('say').disabled = !on;
  $('send').disabled = !on;
}

$('say').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${e.target.scrollHeight}px`;
});

$('say').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('say-form').requestSubmit();
  }
});

$('say-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (ended) return;
  const text = $('say').value.trim();
  if (!text) return;

  addTurn('user', text);
  $('say').value = '';
  $('say').style.height = 'auto';
  setComposerEnabled(false);

  const waiting = addTurn('analyst waiting', '…');

  const { status, body } = await api('/api/session/say', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });

  waiting.remove();

  if (status === 423) {
    renderLock(body.until);
    return;
  }
  if (status !== 200) {
    addTurn('analyst', '[the connection failed — nothing was said]');
    setComposerEnabled(true);
    return;
  }

  addTurn('analyst', body.say, body.gateLatched);

  if (body.ended) {
    ended = true;
    setComposerEnabled(false);
    $('say-form').classList.add('hidden');
    $('ended').classList.remove('hidden');
    $('ended-note').textContent = body.locked
      ? 'The session is over. It will not reopen for a while.'
      : 'The session is over. You can start again whenever you want to.';
    if (body.locked && body.until) setTimeout(() => renderLock(body.until), 2500);
  } else {
    setComposerEnabled(true);
    $('say').focus();
  }
});

// ---------- boot ----------

async function boot() {
  if (!token) {
    show('login');
    return;
  }
  const { status, body } = await api('/api/session/state');
  if (status === 401) {
    localStorage.removeItem(KEY);
    token = '';
    show('login');
    return;
  }
  if (status === 403 && body.error === 'consent_required') {
    await renderConsent(body.text);
    return;
  }
  if (body.locked) {
    renderLock(body.until);
    return;
  }

  ended = false;
  show('session');
  $('thread').innerHTML = '';
  for (const t of body.turns || []) addTurn(t.role, t.text, body.gateLatched);

  $('say-form').classList.remove('hidden');
  $('ended').classList.add('hidden');
  setComposerEnabled(true);

  if (!(body.turns || []).length) {
    // The opening belongs to the analyst; nudge the first turn without speaking for it.
    const { body: first } = await api('/api/session/say', {
      method: 'POST',
      body: JSON.stringify({ text: '(begins)' }),
    });
    $('thread').innerHTML = '';
    if (first && first.say) addTurn('analyst', first.say);
  }

  $('say').focus();
}

boot();
