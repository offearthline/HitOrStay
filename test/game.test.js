'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, buildDeck, STARTING_CHIPS } = require('../src/game');

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const members = (k) => Array.from({ length: k }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const totalChips = (g) => g.players.reduce((s, p) => s + p.chips + p.bet, 0);

function revealAll(g) {
  for (const p of g.inRoundPlayers()) if (!p.revealed) g.act(p.id, { type: 'reveal', index: 0 });
}
function turnId(g) {
  return g.players[g.turnIdx].id;
}
/** 고정 카드로 손패 세팅 */
function setHands(g, hands) {
  g.players.forEach((p, i) => {
    if (hands[i]) p.cards = hands[i].map((v, k) => ({ v, up: p.cards[k] ? p.cards[k].up : true }));
  });
}

test('덱 구성: 35장, 합계 일치', () => {
  const d = buildDeck();
  assert.equal(d.length, 35);
  const count = (v) => d.filter((x) => x === v).length;
  assert.deepEqual([7, 6, 5, 4, 3, 2, 1, -1].map(count), [1, 2, 3, 4, 5, 6, 7, 7]);
});

test('라운드 시작: 기본 베팅, 한계 숫자, 카드 3장', () => {
  const g = new Game(members(3), { rng: seeded(1) });
  g.start();
  assert.equal(g.phase, 'reveal');
  assert.equal(g.round, 1);
  assert.ok(g.limit >= 5 && g.limit <= 12);
  for (const p of g.players) {
    assert.equal(p.cards.length, 3);
    assert.equal(p.chips, STARTING_CHIPS - 1);
    assert.equal(p.bet, 1);
  }
  assert.equal(g.deck.length, 35 - 9);
  assert.equal(g.lottery.filter((l) => l.ball === 1).length, 1);
  assert.equal(g.players[g.firstIdx].id, g.lottery.find((l) => l.ball === 1).id);
});

test('선 플레이어는 매 라운드 왼쪽(다음 좌석)으로 이동', () => {
  const g = new Game(members(3), { rng: seeded(2) });
  g.start();
  const f1 = g.firstIdx;
  revealAll(g);
  // 선 제외 전원 포기 → 라운드 종료
  while (g.phase === 'bet1') {
    const id = turnId(g);
    g.act(id, { type: id === g.players[f1].id ? 'call' : 'fold' });
  }
  assert.equal(g.phase, 'roundEnd');
  g.nextRound();
  assert.equal(g.firstIdx, (f1 + 1) % 3);
});

test('숨김 카드는 다른 플레이어에게 보이지 않음', () => {
  const g = new Game(members(2), { rng: seeded(3) });
  g.start();
  g.act('p0', { type: 'reveal', index: 1 });
  const v = g.viewFor('p1');
  const p0 = v.players.find((p) => p.id === 'p0');
  assert.deepEqual(p0.cards.map((c) => c.v === null), [true, false, true]);
  const own = v.players.find((p) => p.id === 'p1');
  assert.ok(own.cards.every((c) => c.v !== null));
});

test('베팅: 레이즈 후 다른 플레이어가 다시 응답, 한도 초과 불가', () => {
  const g = new Game(members(3), { rng: seeded(4) });
  g.start();
  g.players[0].chips = 4; // 최저 보유자 (ante 후)
  revealAll(g);
  assert.equal(g.phase, 'bet1');
  g.cap = 5; // 라운드 시작 시점 최저 칩
  const a = turnId(g);
  assert.throws(() => g.act(a, { type: 'raise', amount: 5 }), /한도/);
  g.act(a, { type: 'raise', amount: 2 }); // 총 3
  assert.equal(g.currentBet, 3);
  const b = turnId(g);
  assert.notEqual(b, a);
  g.act(b, { type: 'call' });
  const c = turnId(g);
  g.act(c, { type: 'raise', amount: 2 }); // 총 5 = 한도
  assert.equal(g.viewFor(a).me.actions.includes('raise'), false);
  g.act(turnId(g), { type: 'call' });
  g.act(turnId(g), { type: 'call' });
  assert.equal(g.phase, 'hit');
  assert.ok(g.players.every((p) => p.bet === 5));
});

test('힛/스테이: 스테이 전원 → 2차 베팅, 힛 카드는 공개', () => {
  const g = new Game(members(2), { rng: seeded(5) });
  g.start();
  revealAll(g);
  g.act(turnId(g), { type: 'call' });
  g.act(turnId(g), { type: 'call' });
  assert.equal(g.phase, 'hit');
  const a = turnId(g);
  g.act(a, { type: 'hit' });
  assert.equal(g.player(a).cards.length, 4);
  assert.equal(g.player(a).cards[3].up, true);
  const b = turnId(g);
  assert.notEqual(a, b);
  g.act(b, { type: 'stay' });
  assert.equal(turnId(g), a); // 스테이한 사람은 건너뜀
  g.act(a, { type: 'stay' });
  assert.equal(g.phase, 'bet2');
});

test('승부: 한계에 가까운 쪽 승리, 합 같으면 카드 많은 쪽, 초과는 최하위', () => {
  const g = new Game(members(3), { rng: seeded(6) });
  g.start();
  g.limit = 10;
  revealAll(g);
  setHands(g, [[3, 3, 3], [5, 5, 1], [4, 4, 1, -1, 1]]); // 9(3장), 11(초과), 9(5장)
  while (g.phase !== 'roundEnd') {
    const id = turnId(g);
    g.act(id, { type: g.phase === 'hit' ? 'stay' : 'call' });
  }
  const r = g.result;
  assert.equal(r.type, 'showdown');
  assert.equal(r.entries[0].id, 'p2');
  assert.equal(r.entries.find((e) => e.id === 'p1').bust, true);
  assert.equal(g.player('p2').chips, STARTING_CHIPS - 1 + 3);
});

test('무승부: 균등 분배, 나머지는 선 플레이어에 가까운 쪽', () => {
  const g = new Game(members(3), { rng: seeded(7) });
  g.start();
  g.firstIdx = 1;
  g.limit = 12;
  revealAll(g);
  setHands(g, [[4, 4, 2], [4, 4, 2], [1, 1, 1]]);
  // 팟 = 3 (ante). p0과 p1 동률 → 1씩, 나머지 1은 선(p1)에게
  while (g.phase !== 'roundEnd') g.act(turnId(g), { type: g.phase === 'hit' ? 'stay' : 'call' });
  assert.equal(g.result.draw, true);
  assert.equal(g.player('p1').chips, 29 + 2);
  assert.equal(g.player('p0').chips, 29 + 1);
});

test('전원 초과 → 무승부 분배', () => {
  const g = new Game(members(2), { rng: seeded(8) });
  g.start();
  g.limit = 5;
  revealAll(g);
  setHands(g, [[7, 6, 5], [6, 5, 4]]);
  while (g.phase !== 'roundEnd') g.act(turnId(g), { type: g.phase === 'hit' ? 'stay' : 'call' });
  assert.equal(g.result.draw, true);
  assert.equal(g.player('p0').chips + g.player('p1').chips, 60);
});

test('칩 0 → 탈락, 1명 남으면 게임 종료', () => {
  const g = new Game(members(2), { rng: seeded(9) });
  g.start();
  g.players[0].chips = 0; // ante 후 0개 → 한도도 1
  g.cap = 1;
  g.limit = 10;
  revealAll(g);
  setHands(g, [[1, 1, 1], [3, 3, 3]]);
  while (g.phase !== 'roundEnd' && g.phase !== 'gameOver') {
    g.act(turnId(g), { type: g.phase === 'hit' ? 'stay' : 'call' });
  }
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winnerId, 'p1');
  assert.equal(g.player('p0').place, 2);
});

test('기본 베팅은 10라운드마다 1씩 증가', () => {
  const g = new Game(members(2), { rng: seeded(10) });
  g.start();
  for (let r = 1; r <= 11; r++) {
    assert.equal(g.ante, 1 + Math.floor((r - 1) / 10));
    revealAll(g);
    g.act(turnId(g), { type: 'fold' });
    if (g.phase === 'gameOver') break;
    g.nextRound();
  }
  assert.equal(g.round, 12);
  assert.equal(g.ante, 2);
});

test('이탈: 진행 중 포기 처리 후 라운드 종료 시 탈락', () => {
  const g = new Game(members(3), { rng: seeded(11) });
  g.start();
  g.leave('p1');
  assert.equal(g.player('p1').folded, true);
  revealAll(g);
  assert.equal(g.phase, 'bet1');
  g.act(turnId(g), { type: 'fold' });
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.player('p1').alive, false);
});

test('랜덤 시뮬레이션: 칩 보존, 항상 종료, 한도 준수', () => {
  for (let seed = 100; seed < 400; seed++) {
    const rng = seeded(seed);
    const k = 2 + (seed % 7);
    const g = new Game(members(k), { rng });
    g.start();
    const total = totalChips(g);
    let steps = 0;
    while (g.phase !== 'gameOver') {
      assert.ok(++steps < 200000, `seed ${seed} did not finish`);
      if (g.phase === 'roundEnd') {
        assert.equal(totalChips(g), total);
        g.nextRound();
        continue;
      }
      const pending = g.pendingIds();
      assert.ok(pending.length > 0, `seed ${seed} stuck in ${g.phase}`);
      const id = pending[0];
      const v = g.viewFor(id).me;
      const roll = rng();
      if (g.phase === 'reveal') g.act(id, { type: 'reveal', index: Math.floor(roll * 3) });
      else if (g.phase === 'hit') g.act(id, { type: roll < 0.5 ? 'hit' : 'stay' });
      else if (roll < 0.15) g.act(id, { type: 'fold' });
      else if (roll < 0.45 && v.actions.includes('raise')) g.act(id, { type: 'raise', amount: 1 + Math.floor(rng() * v.maxRaise) });
      else g.act(id, { type: 'call' });
      for (const p of g.players) {
        assert.ok(p.chips >= 0, `negative chips seed ${seed}`);
        assert.ok(p.bet <= g.cap || p.bet === 0, `bet over cap seed ${seed}`);
      }
      assert.equal(totalChips(g), total);
    }
    assert.equal(g.alivePlayers().length, 1);
    assert.equal(g.alivePlayers()[0].chips, total);
  }
});
