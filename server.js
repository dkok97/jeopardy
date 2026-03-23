const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use('/assets', express.static('assets'));
app.use(express.json());

// Load game data from data.json
function loadGameData() {
  const dataPath = path.join(__dirname, 'data.json');
  if (fs.existsSync(dataPath)) {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  }
  return { categories: [] };
}
const gameData = loadGameData();

// Game state
let game = {
  phase: 'setup', // setup | board | question | answer
  round: 0,       // current round index
  totalRounds: 0,  // total number of rounds
  roundName: '',
  categories: [],
  teams: {},       // { teamName: { score: 0, members: 0 } }
  done: {},        // { "cat-val": true }
  current: null,   // { catIndex, valIndex, question, answer, answerMedia, value }
  buzzerQueue: [], // [{ team, time }]
  buzzerOpen: false,
  awardedTeams: {},  // { teamName: true } — tracks which teams got points this question
};

// --- REST endpoints ---

app.get('/buzzer', (_req, res) => {
  res.sendFile(__dirname + '/public/buzzer.html');
});

app.get('/api/state', (_req, res) => {
  res.json(game);
});

// --- Socket.IO ---

io.on('connection', (socket) => {
  // Send current state on connect
  socket.emit('state', game);

  // Host starts game — loads round 1 from data.json
  socket.on('start-game', () => {
    const rounds = gameData.rounds || [{ name: 'Round 1', categories: gameData.categories || [] }];
    game.round = 0;
    game.totalRounds = rounds.length;
    game.roundName = rounds[0].name;
    game.categories = rounds[0].categories;
    game.phase = 'board';
    game.done = {};
    game.current = null;
    game.buzzerQueue = [];
    game.buzzerOpen = false;
    io.emit('state', game);
  });

  // Host advances to next round
  socket.on('next-round', () => {
    const rounds = gameData.rounds || [{ name: 'Round 1', categories: gameData.categories || [] }];
    const nextRound = game.round + 1;
    if (nextRound >= rounds.length) return;
    game.round = nextRound;
    game.roundName = rounds[nextRound].name;
    game.categories = rounds[nextRound].categories;
    game.phase = 'board';
    game.done = {};
    game.current = null;
    game.buzzerQueue = [];
    game.buzzerOpen = false;
    io.emit('state', game);
  });

  // Host adds a team
  socket.on('add-team', (name) => {
    if (name && !game.teams[name]) {
      game.teams[name] = { score: 0, members: 0 };
      io.emit('state', game);
    }
  });

  // Buzzer client joins a team
  socket.on('join-team', (name) => {
    if (game.teams[name]) {
      socket.team = name;
      game.teams[name].members++;
      io.emit('state', game);
    }
  });

  // Host selects a question
  socket.on('select-question', ({ catIndex, valIndex }) => {
    const cat = game.categories[catIndex];
    if (!cat) return;
    const q = cat.questions[valIndex];
    if (!q) return;
    const key = `${catIndex}-${valIndex}`;
    if (game.done[key]) return;

    game.current = { catIndex, valIndex, question: q.question, answer: q.answer, questionMedia: q.questionMedia || null, answerMedia: q.answerMedia || null, value: q.value };
    game.awardedTeams = {};
    game.phase = 'question';
    game.buzzerQueue = [];
    game.buzzerOpen = true;
    io.emit('state', game);
  });

  // Player buzzes in
  socket.on('buzz', () => {
    if (!game.buzzerOpen || !socket.team) return;
    // Prevent duplicate buzzes from same team
    if (game.buzzerQueue.some(b => b.team === socket.team)) return;
    game.buzzerQueue.push({ team: socket.team, time: Date.now() });
    io.emit('state', game);
  });

  // Host shows answer
  socket.on('show-answer', () => {
    game.phase = 'answer';
    game.buzzerOpen = false;
    io.emit('state', game);
  });

  // Host awards points (positive or negative) — per team per question
  socket.on('award-points', ({ team, correct }) => {
    if (!game.current || !game.teams[team] || game.awardedTeams[team]) return;
    const pts = game.current.value;
    game.teams[team].score += correct ? pts : -pts;
    game.awardedTeams[team] = true;
    io.emit('state', game);
  });

  // Host closes current question (back to board)
  socket.on('close-question', () => {
    if (game.current) {
      const key = `${game.current.catIndex}-${game.current.valIndex}`;
      game.done[key] = true;
    }
    game.current = null;
    game.phase = 'board';
    game.buzzerQueue = [];
    game.buzzerOpen = false;
    io.emit('state', game);
  });

  // Reset scores
  socket.on('reset-scores', () => {
    for (const t of Object.keys(game.teams)) {
      game.teams[t].score = 0;
    }
    io.emit('state', game);
  });

  // Reset entire game
  socket.on('reset-game', () => {
    game.phase = 'setup';
    game.categories = [];
    game.done = {};
    game.current = null;
    game.buzzerQueue = [];
    game.buzzerOpen = false;
    // Keep teams but reset scores
    for (const t of Object.keys(game.teams)) {
      game.teams[t].score = 0;
    }
    io.emit('state', game);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    if (socket.team && game.teams[socket.team]) {
      game.teams[socket.team].members = Math.max(0, game.teams[socket.team].members - 1);
      io.emit('state', game);
    }
  });
});

// Find local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log(`\n  Jeopardy server running!\n`);
  console.log(`  Board (host):  http://${ip}:${PORT}`);
  console.log(`  Buzzer (players): http://${ip}:${PORT}/buzzer\n`);
});
