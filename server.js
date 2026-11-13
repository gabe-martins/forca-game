'use strict';

const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { networkInterfaces } = require('node:os');
const { randomUUID, randomInt } = require('node:crypto');

const port = Number(process.env.PORT || 3000);
const maxErrors = 6;
const maxPlayers = 16;
const disconnectGrace = 12000;
const sessionLifetime = 30 * 60 * 1000;
const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
const isLetter = (char) => /^[A-Z]$/.test(fold(char));
const lanUrls = (serverPort) => Object.values(networkInterfaces()).flat()
  .filter(({ family, internal, address }) => family === 'IPv4' && !internal && !address.startsWith('169.254.'))
  .map(({ address }) => `http://${address}:${serverPort}`);

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
].map(([route, [file, type]]) => [route, { data: readFileSync(join(__dirname, 'public', file)), type }]));

const players = new Map();
const sessions = new Map();
let hostId = null;
let round = null;
let roundNumber = 0;
let version = 0;

function connectedPlayers() {
  return [...players.values()].filter((player) => player.online);
}

function snapshot(viewer) {
  let game = null;
  if (round) {
    const { id, number, phase, chooserId, chooserName, order, turnId, hint, word, guesses, errors, result } = round;
    const canSeeWord = phase === 'finished' || viewer.id === chooserId;
    game = {
      id, number, phase, chooserId, chooserName, order, turnId, hint, guesses, errors, result,
      letters: Array.from(word, (char) => {
        if (!isLetter(char) || canSeeWord || guesses.includes(fold(char))) return char;
        return null;
      }),
    };
  }
  return {
    version, hostId, maxErrors, maxPlayers,
    me: viewer.id,
    players: [...players.values()]
      .filter((player) => player.online || player.id === viewer.id || game?.order.includes(player.id) || game?.chooserId === player.id)
      .map(({ id, name, online }) => ({ id, name, online })),
    urls: lanUrls(server.address().port),
    round: game,
  };
}

function sendState(player, connection) {
  if (!connection.destroyed && !connection.writableEnded) {
    connection.write(`event: sala\ndata: ${JSON.stringify(snapshot(player))}\n\n`);
  }
}

function broadcast() {
  version += 1;
  for (const player of players.values()) {
    for (const connection of player.connections) sendState(player, connection);
  }
}

function markFinished(result) {
  round.phase = 'finished';
  round.turnId = null;
  round.result = result;
}

function nextTurn(afterId) {
  const start = round.order.indexOf(afterId) + 1;
  return [...round.order.slice(start), ...round.order.slice(0, start)]
    .find((id) => players.get(id)?.online) || null;
}

function onOffline(player) {
  if (hostId === player.id) hostId = connectedPlayers()[0]?.id || null;
  if (round?.phase === 'choosing') {
    if (round.chooserId === player.id || !nextTurn(null)) markFinished('cancelled');
  }
  if (round?.phase === 'playing' && round.turnId === player.id) {
    round.turnId = nextTurn(player.id);
    if (!round.turnId) markFinished('cancelled');
  }
}

function listenToRoom(player, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  clearTimeout(player.disconnectTimer);
  player.connections.add(res);
  if (player.online) {
    sendState(player, res);
  } else {
    player.online = true;
    hostId ||= player.id;
    broadcast();
  }
  res.on('close', () => {
    player.connections.delete(res);
    if (player.connections.size || !players.has(player.id)) return;
    player.disconnectTimer = setTimeout(() => {
      player.online = false;
      player.lastSeen = Date.now();
      onOffline(player);
      broadcast();
    }, disconnectGrace);
    player.disconnectTimer.unref();
  });
}

const maintenance = setInterval(() => {
  const cutoff = Date.now() - sessionLifetime;
  for (const [id, player] of players) {
    if (!player.online && player.lastSeen < cutoff) {
      players.delete(id);
      sessions.delete(player.token);
    }
    for (const connection of player.connections) {
      if (connection.writableLength > 65536) connection.destroy();
      else connection.write(': heartbeat\n\n');
    }
  }
}, 15000);
maintenance.unref();

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function joinRoom(nameInput) {
  const name = typeof nameInput === 'string' ? nameInput.replace(/\s+/gu, ' ').trim() : '';
  if (!name || [...name].length > 24 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw problem(400, 'Digite um nome de 1 a 24 caracteres.');
  }
  const taken = [...players.values()].some((player) => fold(player.name) === fold(name));
  if (taken) throw problem(409, 'Esse nome já está em uso. Escolha outro.');
  if (players.size >= maxPlayers) {
    const available = [...players.values()]
      .filter((player) => !player.online && Date.now() - player.lastSeen >= disconnectGrace)
      .sort((first, second) => first.lastSeen - second.lastSeen)[0];
    if (!available) throw problem(409, 'A sala está cheia.');
    players.delete(available.id);
    sessions.delete(available.token);
  }
  const token = randomUUID();
  const player = { id: randomUUID(), token, name, online: false, connections: new Set(), lastSeen: Date.now() };
  players.set(player.id, player);
  sessions.set(token, player);
  return { token };
}

function authorize(token) {
  const player = sessions.get(token);
  if (!player || !players.has(player.id)) {
    sessions.delete(token);
    throw problem(401, 'Sua sessão expirou. Entre na sala novamente.');
  }
  return player;
}

function startRound(player, previousId) {
  if (player.id !== hostId) throw problem(403, 'Só o anfitrião pode iniciar a rodada.');
  if ((round?.id || null) !== previousId || (round && round.phase !== 'finished')) {
    throw problem(409, 'A rodada atual já começou.');
  }
  const roster = connectedPlayers();
  if (roster.length < 2) throw problem(409, 'A sala precisa de pelo menos dois jogadores.');
  const chooser = roster[randomInt(roster.length)];
  round = {
    id: randomUUID(), number: ++roundNumber, phase: 'choosing', chooserId: chooser.id, chooserName: chooser.name,
    order: roster.filter(({ id }) => id !== chooser.id).map(({ id }) => id),
    turnId: null, word: '', hint: '', guesses: [], errors: 0, result: null,
  };
}

function setWord(player, body) {
  if (round.phase !== 'choosing' || round.chooserId !== player.id) {
    throw problem(403, 'Somente a pessoa sorteada pode definir a palavra.');
  }
  const word = typeof body.word === 'string' ? body.word.trim().normalize('NFC').replace(/ +/g, ' ') : '';
  const hint = typeof body.hint === 'string' ? body.hint.trim() : '';
  const letters = Array.from(word).filter(isLetter).length;
  if (letters < 2 || word.length > 24 || !/^[\p{Script=Latin}]+(?:[ -][\p{Script=Latin}]+)*$/u.test(word)
      || Array.from(word).some((char) => char !== ' ' && char !== '-' && !isLetter(char))) {
    throw problem(400, 'Use de 2 a 24 caracteres, com letras, espaços ou hífens.');
  }
  if ([...hint].length > 80) throw problem(400, 'A dica pode ter até 80 caracteres.');
  const first = nextTurn(null);
  if (!first) throw problem(409, 'A rodada precisa de um jogador para adivinhar.');
  Object.assign(round, { word, hint, turnId: first, phase: 'playing' });
}

function guess(player, body) {
  if (round.phase !== 'playing' || round.turnId !== player.id) {
    throw problem(403, 'Aguarde a sua vez para jogar.');
  }
  const letter = typeof body.letter === 'string' ? fold(body.letter.trim()) : '';
  if (!/^[A-Z]$/.test(letter)) throw problem(400, 'Escolha uma letra de A a Z.');
  if (round.guesses.includes(letter)) throw problem(409, 'Essa letra já foi escolhida.');
  round.guesses.push(letter);
  const letters = Array.from(round.word).filter(isLetter).map(fold);
  if (!letters.includes(letter)) round.errors += 1;
  if (letters.every((char) => round.guesses.includes(char))) markFinished('won');
  else if (round.errors >= maxErrors) markFinished('lost');
  else round.turnId = nextTurn(player.id);
}

function leaveRoom(player) {
  clearTimeout(player.disconnectTimer);
  players.delete(player.id);
  sessions.delete(player.token);
  for (const connection of player.connections) connection.end();
  onOffline(player);
  if (players.size === 0) {
    round = null;
    roundNumber = 0;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    req.resume();
    throw problem(415, 'Use o formulário do jogo para enviar os dados.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      req.resume();
      throw problem(413, 'Os dados enviados excedem o limite.');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw problem(400, 'Os dados enviados são inválidos.');
  }
}

const actions = new Map([
  ['/api/start', (player, body) => startRound(player, body.roundId)],
  ['/api/word', setWord],
  ['/api/guess', guess],
]);

const server = http.createServer(async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const asset = assets.get(route);
    if ((req.method === 'GET' || req.method === 'HEAD') && asset) {
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
      });
      return res.end(req.method === 'HEAD' ? undefined : asset.data);
    }
    if (req.method === 'GET' && route === '/api/events') return listenToRoom(authorize(url.searchParams.get('token')), res);
    if (req.method === 'GET' && route === '/api/state') {
      return json(res, 200, snapshot(authorize(req.headers.authorization?.slice(7))));
    }
    if (req.method !== 'POST') throw problem(404, 'Página não encontrada.');
    const body = await readJson(req);
    if (route === '/api/join') return json(res, 201, joinRoom(body.name));
    const player = authorize(req.headers.authorization?.slice(7));
    if (route === '/api/leave') {
      leaveRoom(player);
      broadcast();
      return json(res, 200, {});
    }
    const action = actions.get(route);
    if (!action) throw problem(404, 'Ação não encontrada.');
    if (!player.online) throw problem(409, 'Aguarde a reconexão com a sala.');
    if (route !== '/api/start' && (!round || round.id !== body.roundId)) {
      throw problem(409, 'A rodada mudou. Aguarde a atualização da sala.');
    }
    action(player, body);
    broadcast();
    return json(res, 200, snapshot(player));
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'O servidor encontrou um erro.' });
    else res.end();
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`A porta ${port} já está em uso. Feche a instância anterior ou escolha outra porta.`);
  else console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => {
  const activePort = server.address().port;
  console.log(`\nForca em Rede\nNeste computador: http://localhost:${activePort}`);
  for (const url of lanUrls(activePort)) console.log(`Na rede local:     ${url}`);
  console.log('\nPressione Ctrl+C para encerrar.\n');
});
