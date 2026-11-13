'use strict';

const $ = (id) => document.getElementById(id);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const tokenKey = 'forca-session';
const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
const board = document.querySelector('.board');
const illustration = document.querySelector('.illustration');
const compactScreen = matchMedia('(max-width: 730px)');
const keyButtons = new Map();
let token = sessionStorage.getItem(tokenKey);
let stream = null;
let state = null;
let connected = false;
let pending = false;
let pendingLetter = null;
let wordFormRound = null;

for (const letter of alphabet) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'key';
  button.textContent = letter;
  button.addEventListener('click', () => playLetter(letter));
  $('keyboard').append(button);
  keyButtons.set(letter, button);
}

for (let i = 0; i < 6; i += 1) {
  const strike = document.createElement('span');
  strike.className = 'strike';
  $('strikes').append(strike);
}

async function request(action, data, session = token) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  if (data) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/${action}`, {
    method: data ? 'POST' : 'GET', headers, body: data && JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function showError(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function acceptState(nextState) {
  if (state && nextState.version < state.version) return;
  state = nextState;
  render();
}

function openStream() {
  stream?.close();
  const connection = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  const session = token;
  stream = connection;
  connection.addEventListener('sala', (event) => {
    if (stream !== connection) return;
    connected = true;
    acceptState(JSON.parse(event.data));
  });
  connection.addEventListener('error', async () => {
    if (stream !== connection) return;
    connected = false;
    render();
    if (connection.readyState !== EventSource.CLOSED) return;
    try {
      await request('state', undefined, session);
    } catch (error) {
      if (stream === connection && error.status === 401) {
        resetSession();
        showError('entry-error', error.message);
        return;
      }
    }
    if (stream === connection) setTimeout(() => {
      if (stream === connection) openStream();
    }, 2000);
  });
  render();
}

function resetSession() {
  stream?.close();
  stream = null;
  token = null;
  state = null;
  connected = false;
  sessionStorage.removeItem(tokenKey);
  render();
  $('name').focus();
}

async function runAction(action, data) {
  if (pending) return;
  pending = true;
  pendingLetter = action === 'guess' ? data.letter : null;
  const errorId = state ? 'board-error' : 'entry-error';
  showError(errorId);
  render();
  try {
    const result = await request(action, data);
    if (action === 'join') {
      token = result.token;
      sessionStorage.setItem(tokenKey, token);
      openStream();
    } else if (action === 'leave') {
      resetSession();
    } else {
      acceptState(result);
    }
  } catch (error) {
    if (error.status === 401) {
      resetSession();
      showError('entry-error', error.message);
    } else {
      showError(errorId, error.status ? error.message : 'Falha na conexão. Tente novamente.');
    }
  } finally {
    pending = false;
    pendingLetter = null;
    render();
  }
}

function canPlay() {
  return connected && !pending && state?.round?.phase === 'playing' && state.round.turnId === state.me;
}

function playLetter(letter) {
  if (canPlay() && !state.round.guesses.includes(letter)) {
    runAction('guess', { roundId: state.round.id, letter });
  }
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function render() {
  $('entry').hidden = Boolean(state);
  board.hidden = !state;
  $('room').hidden = !state;
  $('leave').hidden = !token;
  $('leave').disabled = pending;
  const restoring = Boolean(token) && !state;
  $('name').disabled = restoring;
  $('join-form').querySelector('button').disabled = pending || restoring;
  document.body.classList.toggle('in-room', Boolean(state));
  $('connection-dot').classList.toggle('waiting', Boolean(token) && !connected);
  setText($('connection-label'), token ? (connected ? 'Conectado' : 'Conectando…') : 'Rede local');

  const round = state?.round;
  placeIllustration(round);
  const errors = round?.errors || 0;
  const maxErrors = state?.maxErrors || 6;
  setText($('error-counter'), `${errors} / ${maxErrors} erros`);
  for (const [i, strike] of [...$('strikes').children].entries()) strike.classList.toggle('used', i < errors);
  drawGallows(errors);
  if (!state) return;

  const isHost = state.me === state.hostId;
  const isChooser = state.me === round?.chooserId;
  const inRound = round?.phase === 'choosing' || round?.phase === 'playing';
  const isSpectator = inRound && !isChooser && !round.order.includes(state.me);
  const playerCount = state.players.filter(({ online }) => online).length;
  renderBoard(round, { isHost, isChooser, isSpectator, playerCount });
  renderPlayers(round, playerCount);
}

function placeIllustration(round) {
  const insideBoard = compactScreen.matches && Boolean(round?.letters.length);
  if (insideBoard && illustration.parentNode !== board) board.insertBefore(illustration, $('word-display'));
  if (!insideBoard && illustration.parentNode === board) $('room').before(illustration);
}

function renderBoard(round, { isHost, isChooser, isSpectator, playerCount }) {
  const choosing = round?.phase === 'choosing';
  const playing = round?.phase === 'playing';
  const finished = round?.phase === 'finished';
  const wordVisible = Boolean(round?.letters.length);
  const turn = state.players.find(({ id }) => id === round?.turnId);
  let phase = 'Sala de espera';
  let title = 'Sala de espera';
  let description = playerCount < 2 ? 'Convide mais uma pessoa para poder iniciar.' : 'A rodada começa quando o anfitrião estiver pronto.';
  if (isHost && playerCount >= 2) description = 'Tudo pronto para sortear quem escolhe a primeira palavra.';

  if (choosing) {
    phase = 'Escolha da palavra';
    title = isChooser ? 'Você foi sorteado' : 'Aguardando a palavra';
    description = isChooser ? 'Digite a palavra que o grupo vai tentar adivinhar.' : `${round.chooserName} está escolhendo a palavra.`;
  }
  if (playing) {
    phase = 'Rodada em andamento';
    title = round.turnId === state.me ? 'Sua vez!' : `Vez de ${turn?.name || 'outro jogador'}`;
    description = round.turnId === state.me ? 'Escolha uma letra no teclado abaixo.' : 'Aguarde sua vez.';
    if (isChooser) description = 'Acompanhe os palpites do grupo. A palavra completa aparece só para você.';
  }
  if (isSpectator) description = `${description} Você entra na próxima rodada.`;
  if (finished) {
    phase = 'Fim da rodada';
    title = { won: 'O grupo acertou!', lost: 'A forca venceu', cancelled: 'Rodada interrompida' }[round.result];
    description = round.result === 'cancelled'
      ? 'Uma pessoa necessária para continuar saiu da sala.'
      : (round.result === 'won' ? 'O grupo descobriu a palavra.' : 'O grupo chegou ao limite de erros.');
    if (playerCount < 2) description += ' São necessárias duas pessoas para jogar de novo.';
  }

  setText($('phase-label'), phase);
  setText($('board-title'), title);
  setText($('board-description'), description);
  $('round-number').hidden = !round;
  if (round) setText($('round-number'), `Rodada ${round.number}`);
  const start = $('start');
  start.hidden = !isHost || choosing || playing;
  start.disabled = !connected || pending || playerCount < 2;
  setText(start, finished ? 'Nova rodada →' : 'Iniciar rodada →');

  const wordForm = $('word-form');
  wordForm.hidden = !choosing || !isChooser;
  if (!wordForm.hidden && wordFormRound !== round.id) {
    wordForm.reset();
    wordFormRound = round.id;
    $('word').focus();
  }
  wordForm.querySelector('button').disabled = !connected || pending;
  $('word-display').hidden = !wordVisible;
  $('hint-display').hidden = !wordVisible || !round.hint;
  if (!$('hint-display').hidden) setText($('hint-display'), `Dica · ${round.hint}`);
  if (wordVisible) renderLetters(round.letters);
  $('key-area').hidden = !wordVisible;
  if (wordVisible) renderKeys(round);
}

function renderLetters(letters) {
  const container = $('letters');
  const label = letters.map((letter) => letter ?? '_').join('');
  if (container.getAttribute('aria-label') === label) return;
  container.setAttribute('aria-label', label);
  const groups = [];
  let group = null;
  for (const letter of letters) {
    if (letter === ' ') {
      group = null;
      continue;
    }
    if (!group) {
      group = document.createElement('span');
      group.className = 'word-group';
      groups.push(group);
    }
    const tile = document.createElement('span');
    tile.className = `letter${letter === '-' ? ' separator' : letter ? ' revealed' : ''}`;
    tile.textContent = letter ?? '';
    tile.setAttribute('aria-hidden', 'true');
    group.append(tile);
  }
  container.replaceChildren(...groups);
}

function renderKeys(round) {
  const shown = round.letters.filter(Boolean).map(fold);
  for (const [letter, button] of keyButtons) {
    const used = round.guesses.includes(letter);
    const hit = used && shown.includes(letter);
    button.className = `key${used ? (hit ? ' hit' : ' miss') : ''}${pendingLetter === letter ? ' pending' : ''}`;
    button.disabled = used || !canPlay();
    button.setAttribute('aria-label', used ? `${letter}, ${hit ? 'acerto' : 'erro'}` : letter);
  }
}

function renderPlayers(round, playerCount) {
  setText($('player-count'), `${playerCount} / ${state.maxPlayers}`);
  const players = state.players.map((player) => {
    const current = round?.turnId === player.id;
    const item = document.createElement('li');
    item.className = `player${current ? ' current' : ''}`;
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = Array.from(player.name)[0].toLocaleUpperCase('pt-BR');
    avatar.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.id === state.me ? `${player.name} (você)` : player.name;
    const meta = document.createElement('span');
    meta.className = 'player-meta';
    const roles = [];
    if (player.id === state.hostId) roles.push('Anfitrião');
    if (round?.phase !== 'finished' && player.id === round?.chooserId) roles.push('Escolhe');
    if (current) roles.push('Da vez');
    if (!player.online) roles.push('Saiu');
    meta.textContent = roles.join(' · ');
    item.append(avatar, name, meta);
    return item;
  });
  $('players').replaceChildren(...players);
  const onLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const shareUrl = onLocalhost ? state.urls[0] : location.origin;
  $('share').hidden = !shareUrl;
  if (shareUrl) $('share-url').value = shareUrl;
}

function drawGallows(errors) {
  const canvas = $('gallows');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#d9cebb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(256, 153, 144, 125, 0, 0, Math.PI * 2);
  ctx.stroke();

  function line(...points) {
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.stroke();
  }

  ctx.strokeStyle = '#59463a';
  ctx.lineWidth = 9;
  line([98, 290], [421, 290]);
  line([156, 289], [156, 57], [334, 57]);
  ctx.lineWidth = 6;
  line([156, 115], [213, 57]);
  ctx.strokeStyle = '#806757';
  line([334, 57], [334, 102]);

  ctx.strokeStyle = '#a4422b';
  ctx.lineWidth = 7;
  if (errors >= 1) {
    ctx.beginPath();
    ctx.arc(334, 125, 23, 0, Math.PI * 2);
    ctx.stroke();
  }
  const body = [
    [[334, 149], [334, 211]], [[334, 165], [300, 189]], [[334, 165], [368, 189]],
    [[334, 211], [303, 252]], [[334, 211], [365, 252]],
  ];
  for (const part of body.slice(0, Math.max(0, errors - 1))) line(...part);
}

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction('join', { name: $('name').value });
});
$('start').addEventListener('click', () => runAction('start', { roundId: state.round?.id || null }));
$('word-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction('word', { roundId: state.round.id, word: $('word').value, hint: $('hint').value });
});
$('leave').addEventListener('click', () => runAction('leave', {}));
$('copy').addEventListener('click', async () => {
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText($('share-url').value);
    else {
      $('share-url').select();
      if (!document.execCommand('copy')) throw new Error();
    }
    setText($('copy-status'), 'Endereço copiado.');
  } catch {
    $('share-url').select();
    setText($('copy-status'), 'Copie o endereço selecionado.');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.closest?.('input, textarea')) return;
  const letter = fold(event.key);
  if (/^[A-Z]$/.test(letter)) playLetter(letter);
});
compactScreen.addEventListener('change', () => placeIllustration(state?.round));

if (token) openStream();
else render();
