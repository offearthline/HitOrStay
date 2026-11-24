'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError, MIN_PLAYERS, MAX_PLAYERS } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const ROUND_END_DELAY_MS = 9000; // 라운드 결과를 보여준 뒤 다음 라운드 자동 시작
const DISCONNECT_GRACE_MS = 20000; // 끊긴 플레이어 차례를 자동 처리하기까지
const ROOM_IDLE_MS = 30 * 60 * 1000; // 전원이 떠난 방 정리

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{id:string, token:string, name:string, socketId:string|null, connected:boolean, disconnectedAt:number|null}} Member
 * @typedef {{code:string, hostId:string, members:Member[], game:Game|null, roundTimer:any, nextRoundAt:number|null, emptySince:number|null}} Room
 */

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 12);
  if (!n) throw new GameError('닉네임을 입력하세요.');
  return n;
}

function roomView(room, meId) {
  return {
    code: room.code,
    hostId: room.hostId,
    meId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    members: room.members.map((m) => ({ id: m.id, name: m.name, connected: m.connected })),
    nextRoundAt: room.nextRoundAt,
    game: room.game ? room.game.viewFor(meId) : null,
  };
}

function broadcast(room) {
  for (const m of room.members) {
    if (m.socketId) io.to(m.socketId).emit('state', roomView(room, m.id));
  }
}

/** 게임 상태가 바뀐 뒤 공통 처리: 라운드 종료 타이머 예약 + 전송 */
function afterChange(room) {
  const g = room.game;
  if (g && g.phase === 'roundEnd' && !room.roundTimer) {
    room.nextRoundAt = Date.now() + ROUND_END_DELAY_MS;
    room.roundTimer = setTimeout(() => {
      room.roundTimer = null;
      room.nextRoundAt = null;
      if (room.game && room.game.phase === 'roundEnd') room.game.nextRound();
      afterChange(room);
    }, ROUND_END_DELAY_MS);
  }
  if (g && g.phase !== 'roundEnd' && room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
    room.nextRoundAt = null;
  }
  broadcast(room);
}

function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new GameError('방을 찾을 수 없습니다.');
  return room;
}

function attach(socket, room, member) {
  // 같은 멤버로 다른 소켓이 붙어 있었다면 끊어 줌
  if (member.socketId && member.socketId !== socket.id) {
    const old = io.sockets.sockets.get(member.socketId);
    if (old) {
      old.data.roomCode = null;
      old.emit('kicked', '다른 창에서 접속하여 연결이 종료되었습니다.');
    }
  }
  member.socketId = socket.id;
  member.connected = true;
  member.disconnectedAt = null;
  room.emptySince = null;
  socket.data.roomCode = room.code;
  socket.data.memberId = member.id;
  socket.join(room.code);
}

function newMember(name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(16).toString('hex'),
    name,
    socketId: null,
    connected: false,
    disconnectedAt: null,
  };
}

function removeMember(room, memberId) {
  room.members = room.members.filter((m) => m.id !== memberId);
  if (room.hostId === memberId && room.members.length) room.hostId = room.members[0].id;
  if (!room.members.length) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    rooms.delete(room.code);
    return false;
  }
  return true;
}

function handler(socket, fn) {
  return (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...(fn(payload || {}) || {}) });
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply({ ok: false, error: err instanceof GameError ? err.message : '서버 오류가 발생했습니다.' });
    }
  };
}

function current(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) throw new GameError('방에 접속해 있지 않습니다.');
  const member = room.members.find((m) => m.id === socket.data.memberId);
  if (!member) throw new GameError('방에 접속해 있지 않습니다.');
  return { room, member };
}

io.on('connection', (socket) => {
  socket.on(
    'room:create',
    handler(socket, ({ name }) => {
      const member = newMember(cleanName(name));
      const room = {
        code: makeCode(),
        hostId: member.id,
        members: [member],
        game: null,
        roundTimer: null,
        nextRoundAt: null,
        emptySince: null,
      };
      rooms.set(room.code, room);
      attach(socket, room, member);
      broadcast(room);
      return { code: room.code, token: member.token };
    }),
  );

  socket.on(
    'room:join',
    handler(socket, ({ code, name }) => {
      const room = getRoom(code);
      const nm = cleanName(name);
      if (room.game) throw new GameError('이미 게임이 진행 중인 방입니다.');
      if (room.members.length >= MAX_PLAYERS) throw new GameError(`방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)`);
      if (room.members.some((m) => m.name === nm)) throw new GameError('같은 닉네임이 이미 있습니다.');
      const member = newMember(nm);
      room.members.push(member);
      attach(socket, room, member);
      broadcast(room);
      return { code: room.code, token: member.token };
    }),
  );

  socket.on(
    'room:resume',
    handler(socket, ({ code, token }) => {
      const room = getRoom(code);
      const member = room.members.find((m) => m.token === token);
      if (!member) throw new GameError('세션이 만료되었습니다.');
      attach(socket, room, member);
      broadcast(room);
      return { code: room.code, token: member.token };
    }),
  );

  socket.on(
    'room:leave',
    handler(socket, () => {
      const { room, member } = current(socket);
      socket.leave(room.code);
      socket.data.roomCode = null;
      if (room.game && room.game.players.some((p) => p.id === member.id)) room.game.leave(member.id);
      if (removeMember(room, member.id)) afterChange(room);
    }),
  );

  socket.on(
    'game:start',
    handler(socket, () => {
      const { room, member } = current(socket);
      if (room.hostId !== member.id) throw new GameError('방장만 게임을 시작할 수 있습니다.');
      if (room.game && room.game.phase !== 'gameOver') throw new GameError('이미 게임이 진행 중입니다.');
      room.game = new Game(room.members.map((m) => ({ id: m.id, name: m.name })));
      room.game.start();
      afterChange(room);
    }),
  );

  socket.on(
    'game:reset',
    handler(socket, () => {
      const { room, member } = current(socket);
      if (room.hostId !== member.id) throw new GameError('방장만 할 수 있습니다.');
      if (room.game && room.game.phase !== 'gameOver') throw new GameError('게임이 아직 끝나지 않았습니다.');
      room.game = null;
      afterChange(room);
    }),
  );

  socket.on(
    'game:action',
    handler(socket, (action) => {
      const { room, member } = current(socket);
      if (!room.game) throw new GameError('게임이 시작되지 않았습니다.');
      const { type } = action;
      const amount = action.amount === undefined ? undefined : Number(action.amount);
      const index = action.index === undefined ? undefined : Number(action.index);
      room.game.act(member.id, { type, amount, index });
      afterChange(room);
    }),
  );

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const member = room.members.find((m) => m.socketId === socket.id);
    if (!member) return;
    member.connected = false;
    member.socketId = null;
    member.disconnectedAt = Date.now();
    if (!room.game) {
      // 대기실에서는 잠시 뒤에도 안 돌아오면 자리 정리 (새로고침은 바로 재접속됨)
      setTimeout(() => {
        if (!member.connected && rooms.get(room.code) === room && !room.game) {
          if (removeMember(room, member.id)) broadcast(room);
        }
      }, DISCONNECT_GRACE_MS);
    }
    if (room.members.every((m) => !m.connected)) room.emptySince = Date.now();
    broadcast(room);
  });
});

// 끊긴 플레이어 자동 처리 + 빈 방 정리
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.emptySince && now - room.emptySince > ROOM_IDLE_MS) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      rooms.delete(room.code);
      continue;
    }
    const g = room.game;
    if (!g) continue;
    let changed = false;
    for (const id of g.pendingIds()) {
      const m = room.members.find((x) => x.id === id);
      const gone = !m || (!m.connected && m.disconnectedAt && now - m.disconnectedAt > DISCONNECT_GRACE_MS);
      if (gone && g.autoAct(id)) changed = true;
    }
    if (changed) afterChange(room);
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`HIT, STAY 서버 실행 중: http://localhost:${PORT}`);
});
