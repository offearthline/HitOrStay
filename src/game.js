'use strict';

/**
 * HIT, STAY 게임 엔진 (시스템 = 딜러).
 * 네트워크와 무관한 순수 상태 기계. 서버는 act()/leave()/autoAct()/nextRound()만 호출하고
 * viewFor()로 플레이어별(숨김 카드가 가려진) 상태를 내려준다.
 */

// 규칙 4: 7×1, 6×2, 5×3, 4×4, 3×5, 2×6, 1×7, -1×7  (총 35장)
const DECK_SPEC = [[7, 1], [6, 2], [5, 3], [4, 4], [3, 5], [2, 6], [1, 7], [-1, 7]];
const STARTING_CHIPS = 30; // 규칙 5
const HAND_SIZE = 3; // 규칙 8
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8; // 35장 덱에서 3장씩 나눠도 추가 카드가 남도록
const DIE_FACES = [5, 6, 7, 8, 9, 10, 11, 12]; // 규칙 7: 8면체 주사위
const ANTE_STEP_ROUNDS = 10; // 규칙 6
const LOG_LIMIT = 300;

const PHASE_LABEL = {
  reveal: '공개할 카드 선택',
  bet1: '1차 베팅',
  hit: '힛 / 스테이',
  bet2: '2차 베팅',
  roundEnd: '라운드 종료',
  gameOver: '게임 종료',
};

function buildDeck() {
  const deck = [];
  for (const [value, count] of DECK_SPEC) for (let i = 0; i < count; i++) deck.push(value);
  return deck;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class GameError extends Error {}

class Game {
  /**
   * @param {{id:string,name:string}[]} members 좌석 순서 = 시계 방향
   */
  constructor(members, { rng = Math.random, startingChips = STARTING_CHIPS } = {}) {
    if (members.length < MIN_PLAYERS) throw new GameError(`최소 ${MIN_PLAYERS}명이 필요합니다.`);
    if (members.length > MAX_PLAYERS) throw new GameError(`최대 ${MAX_PLAYERS}명까지 가능합니다.`);
    this.rng = rng;
    this.players = members.map((m) => ({
      id: m.id,
      name: m.name,
      chips: startingChips,
      alive: true,
      left: false,
      place: null,
      cards: [],
      folded: false,
      stayed: false,
      revealed: false,
      bet: 0,
      lastAction: null,
    }));
    this.phase = 'lobby';
    this.round = 0;
    this.firstIdx = -1;
    this.turnIdx = -1;
    this.toAct = [];
    this.deck = [];
    this.limit = null;
    this.ante = 0;
    this.cap = 0;
    this.currentBet = 0;
    this.lottery = [];
    this.result = null;
    this.showdownIds = new Set();
    this.winnerId = null;
    this.log = [];
    this.logSeq = 0;
  }

  // ───────────────────────── helpers ─────────────────────────

  get n() {
    return this.players.length;
  }

  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new GameError('플레이어를 찾을 수 없습니다.');
    return p;
  }

  inRound(p) {
    return p.alive && !p.folded;
  }

  inRoundPlayers() {
    return this.players.filter((p) => this.inRound(p));
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  /** firstIdx부터 시계 방향으로 좌석 순서대로 나열 */
  seatOrderFrom(start) {
    const out = [];
    for (let i = 0; i < this.n; i++) out.push(this.players[(start + i) % this.n]);
    return out;
  }

  /** from 다음 좌석부터 시계 방향으로 pred를 만족하는 첫 좌석 (from 자신은 마지막에 검사) */
  nextSeat(from, pred) {
    for (let i = 1; i <= this.n; i++) {
      const idx = (from + i) % this.n;
      if (pred(this.players[idx])) return idx;
    }
    return -1;
  }

  pot() {
    return this.players.reduce((s, p) => s + p.bet, 0);
  }

  addLog(text, kind = 'info') {
    this.log.push({ seq: ++this.logSeq, round: this.round, text, kind });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  static handSum(cards) {
    return cards.reduce((s, c) => s + c.v, 0);
  }

  // ───────────────────────── 게임 흐름 ─────────────────────────

  start() {
    if (this.phase !== 'lobby') throw new GameError('이미 시작된 게임입니다.');
    // 규칙 2: 추첨 볼 → 1번 볼을 뽑은 사람이 선
    const balls = shuffle(this.players.map((_, i) => i + 1), this.rng);
    this.lottery = this.players.map((p, i) => ({ id: p.id, name: p.name, ball: balls[i] }));
    this.firstIdx = balls.indexOf(1);
    this.addLog(
      `추첨 볼: ${this.lottery.map((l) => `${l.name} ${l.ball}번`).join(', ')} → ${this.players[this.firstIdx].name} 님이 선 플레이어`,
      'system',
    );
    this.startRound();
  }

  startRound() {
    this.round += 1;
    // 규칙 3: 이전 선 플레이어의 왼쪽(시계 방향 다음) 생존자가 새 선
    if (this.round > 1) this.firstIdx = this.nextSeat(this.firstIdx, (p) => p.alive);
    else if (!this.players[this.firstIdx].alive) this.firstIdx = this.nextSeat(this.firstIdx, (p) => p.alive);

    const alive = this.alivePlayers();
    // 규칙 6: 기본 베팅 1개, 10라운드마다 +1
    this.ante = 1 + Math.floor((this.round - 1) / ANTE_STEP_ROUNDS);
    // 규칙 9: 베팅 총액은 최저 보유자의 칩 개수를 넘을 수 없음 (라운드 시작 시점 기준)
    this.cap = Math.min(...alive.map((p) => p.chips));
    const ante = Math.min(this.ante, this.cap);

    this.result = null;
    this.showdownIds = new Set();
    for (const p of this.players) {
      p.cards = [];
      p.folded = !p.alive;
      p.stayed = false;
      p.revealed = false;
      p.bet = 0;
      p.lastAction = null;
    }
    for (const p of alive) {
      p.chips -= ante;
      p.bet = ante;
    }
    this.currentBet = ante;

    // 규칙 7: 딜러가 8면체 주사위(5~12)를 굴려 한계 숫자 결정
    this.limit = DIE_FACES[Math.floor(this.rng() * DIE_FACES.length)];

    // 규칙 8: 3장씩 지급 (선 플레이어부터)
    this.deck = shuffle(buildDeck(), this.rng);
    const order = this.seatOrderFrom(this.firstIdx).filter((p) => p.alive);
    for (let k = 0; k < HAND_SIZE; k++) {
      for (const p of order) p.cards.push({ v: this.deck.pop(), up: false });
    }

    this.addLog(`── ${this.round}라운드 시작 · 선: ${this.players[this.firstIdx].name} ──`, 'round');
    const anteNote = ante < this.ante ? ` (최저 보유 칩 한도로 ${ante}개)` : '';
    this.addLog(`기본 베팅 ${ante}개${anteNote} · 베팅 한도 ${this.cap}개`, 'system');
    this.addLog(`딜러가 8면체 주사위를 굴렸습니다 → 한계 숫자 ${this.limit}`, 'dice');
    this.addLog('카드 3장씩 지급. 각자 공개할 카드 1장을 고르세요.', 'system');

    this.phase = 'reveal';
    this.turnIdx = -1;
    this.toAct = [];
  }

  nextRound() {
    if (this.phase !== 'roundEnd') throw new GameError('라운드가 아직 끝나지 않았습니다.');
    this.startRound();
  }

  // ───────────────────────── 액션 ─────────────────────────

  /** 현재 응답을 기다리는 플레이어 id 목록 */
  pendingIds() {
    if (this.phase === 'reveal') return this.inRoundPlayers().filter((p) => !p.revealed).map((p) => p.id);
    if (['bet1', 'bet2', 'hit'].includes(this.phase) && this.turnIdx >= 0) return [this.players[this.turnIdx].id];
    return [];
  }

  act(playerId, action = {}) {
    const p = this.player(playerId);
    if (!this.inRound(p)) throw new GameError('이번 라운드에 참여 중이 아닙니다.');
    switch (this.phase) {
      case 'reveal':
        return this.doReveal(p, action);
      case 'bet1':
      case 'bet2':
        this.assertTurn(p);
        return this.doBet(p, action);
      case 'hit':
        this.assertTurn(p);
        return this.doHit(p, action);
      default:
        throw new GameError('지금은 행동할 수 없습니다.');
    }
  }

  assertTurn(p) {
    if (this.players[this.turnIdx] !== p) throw new GameError('당신의 차례가 아닙니다.');
  }

  doReveal(p, { type, index }) {
    if (type !== 'reveal') throw new GameError('공개할 카드를 선택하세요.');
    if (p.revealed) throw new GameError('이미 카드를 공개했습니다.');
    if (!Number.isInteger(index) || index < 0 || index >= p.cards.length) throw new GameError('잘못된 카드입니다.');
    p.cards[index].up = true;
    p.revealed = true;
    this.addLog(`${p.name} 님이 [${p.cards[index].v}] 카드를 공개했습니다.`);
    this.checkAllRevealed();
  }

  checkAllRevealed() {
    if (this.phase === 'reveal' && this.inRoundPlayers().every((p) => p.revealed)) this.startBetting('bet1');
  }

  startBetting(phase) {
    this.phase = phase;
    this.addLog(`${PHASE_LABEL[phase]} 시작`, 'phase');
    for (const p of this.players) if (this.inRound(p)) p.lastAction = null;
    const order = this.seatOrderFrom(this.firstIdx).filter((p) => this.inRound(p));
    this.toAct = order.map((p) => p.id);
    this.turnIdx = this.players.indexOf(order[0]);
  }

  callAmount(p) {
    return this.currentBet - p.bet;
  }

  /** 레이즈 가능한 추가 금액 상한 (현재 최고 베팅 위로 몇 개까지 올릴 수 있는가) */
  maxRaise(p) {
    return Math.min(this.cap, p.bet + p.chips) - this.currentBet;
  }

  doBet(p, { type, amount }) {
    if (type === 'fold') {
      this.fold(p, '포기했습니다.');
      return;
    }
    if (type === 'call') {
      const need = this.callAmount(p);
      p.chips -= need;
      p.bet += need;
      p.lastAction = need === 0 ? '체크' : `콜 ${need}`;
      this.addLog(need === 0 ? `${p.name} 님 체크` : `${p.name} 님 콜 (+${need}, 총 ${p.bet})`, 'bet');
    } else if (type === 'raise') {
      const max = this.maxRaise(p);
      if (!Number.isInteger(amount) || amount < 1) throw new GameError('레이즈 금액은 1 이상이어야 합니다.');
      if (amount > max) throw new GameError(`베팅 한도(${this.cap}개)를 넘을 수 없습니다. 최대 +${Math.max(max, 0)}`);
      const newTotal = this.currentBet + amount;
      const need = newTotal - p.bet;
      p.chips -= need;
      p.bet = newTotal;
      this.currentBet = newTotal;
      p.lastAction = `레이즈 +${amount}`;
      this.addLog(`${p.name} 님 레이즈 +${amount} (총 ${newTotal})`, 'bet');
      // 레이즈하면 다른 모든 참여자가 다시 응답해야 함
      this.toAct = this.seatOrderFrom(this.turnIdx)
        .filter((x) => x !== p && this.inRound(x))
        .map((x) => x.id);
    } else {
      throw new GameError('콜 / 레이즈 / 포기 중에서 선택하세요.');
    }
    this.toAct = this.toAct.filter((id) => id !== p.id);
    this.advanceBetting();
  }

  advanceBetting() {
    if (this.toAct.length === 0) {
      if (this.phase === 'bet1') this.startHit();
      else this.showdown();
      return;
    }
    this.turnIdx = this.nextSeat(this.turnIdx, (x) => this.toAct.includes(x.id));
  }

  fold(p, reason) {
    const wasTurn = this.players[this.turnIdx] === p;
    p.folded = true;
    p.lastAction = '포기';
    this.toAct = this.toAct.filter((id) => id !== p.id);
    this.addLog(`${p.name} 님이 ${reason}`, 'fold');

    if (this.inRoundPlayers().length === 1) {
      this.finishByFold();
      return;
    }
    if (this.phase === 'reveal') this.checkAllRevealed();
    else if (this.phase === 'bet1' || this.phase === 'bet2') {
      if (wasTurn || this.toAct.length === 0) this.advanceBetting();
    } else if (this.phase === 'hit' && wasTurn) this.advanceHit();
  }

  startHit() {
    this.phase = 'hit';
    this.addLog('추가 카드: 선 플레이어부터 HIT 또는 STAY', 'phase');
    for (const p of this.players) if (this.inRound(p)) p.lastAction = null;
    if (this.deck.length === 0) {
      this.addLog('남은 카드가 없습니다.', 'system');
      this.startBetting('bet2');
      return;
    }
    const first = this.players[this.firstIdx];
    this.turnIdx = this.inRound(first) && !first.stayed
      ? this.firstIdx
      : this.nextSeat(this.firstIdx, (x) => this.inRound(x) && !x.stayed);
  }

  doHit(p, { type }) {
    if (type === 'hit') {
      const v = this.deck.pop();
      p.cards.push({ v, up: true });
      p.lastAction = 'HIT';
      this.addLog(`${p.name} 님 HIT → [${v}]`, 'hit');
      if (this.deck.length === 0) {
        this.addLog('추가 카드가 모두 소진되었습니다.', 'system');
        this.startBetting('bet2');
        return;
      }
    } else if (type === 'stay') {
      p.stayed = true;
      p.lastAction = 'STAY';
      this.addLog(`${p.name} 님 STAY`, 'stay');
    } else {
      throw new GameError('HIT 또는 STAY를 선택하세요.');
    }
    this.advanceHit();
  }

  advanceHit() {
    const next = this.nextSeat(this.turnIdx, (x) => this.inRound(x) && !x.stayed);
    if (next === -1) {
      this.addLog('전원 STAY', 'system');
      this.startBetting('bet2');
      return;
    }
    this.turnIdx = next;
  }

  // ───────────────────────── 승부 ─────────────────────────

  /** 비교 키: 높을수록 좋음. 초과(버스트)는 최하위. */
  scoreKey(p) {
    const sum = Game.handSum(p.cards);
    if (sum > this.limit) return [0, 0, 0];
    return [1, sum, p.cards.length];
  }

  static cmpKey(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  /** 선 플레이어로부터 시계 방향 거리 (선 = 0) */
  distFromFirst(p) {
    return (this.players.indexOf(p) - this.firstIdx + this.n) % this.n;
  }

  /** 팟 분배. 나머지는 선 플레이어에 가장 가까운 승자에게 (규칙 13) */
  distribute(winners) {
    const pot = this.pot();
    const sorted = [...winners].sort((a, b) => this.distFromFirst(a) - this.distFromFirst(b));
    const share = Math.floor(pot / sorted.length);
    const remainder = pot - share * sorted.length;
    const payouts = {};
    sorted.forEach((w, i) => {
      const amt = share + (i === 0 ? remainder : 0);
      w.chips += amt;
      payouts[w.id] = amt;
    });
    // 팟은 지급되었으므로 라운드 베팅 기록을 비움 (결과의 pot에 남아 있음)
    for (const p of this.players) p.bet = 0;
    return { pot, payouts };
  }

  showdown() {
    const contenders = this.inRoundPlayers();
    this.turnIdx = -1;
    this.toAct = [];
    for (const p of contenders) this.showdownIds.add(p.id);

    const ranked = contenders
      .map((p) => ({ p, key: this.scoreKey(p) }))
      .sort((a, b) => Game.cmpKey(b.key, a.key) || this.distFromFirst(a.p) - this.distFromFirst(b.p));
    const best = ranked[0].key;
    const winners = ranked.filter((r) => Game.cmpKey(r.key, best) === 0).map((r) => r.p);
    const { pot, payouts } = this.distribute(winners);

    const entries = ranked.map(({ p, key }) => ({
      id: p.id,
      name: p.name,
      cards: p.cards.map((c) => c.v),
      sum: Game.handSum(p.cards),
      count: p.cards.length,
      bust: key[0] === 0,
      win: winners.includes(p),
      payout: payouts[p.id] || 0,
    }));
    this.result = { type: 'showdown', limit: this.limit, pot, draw: winners.length > 1, entries };

    this.addLog(`카드 공개! 한계 숫자 ${this.limit}`, 'phase');
    for (const e of entries) {
      const tag = e.bust ? ' (초과)' : '';
      this.addLog(`${e.name}: [${e.cards.join(', ')}] = ${e.sum}${tag}`, e.bust ? 'fold' : 'info');
    }
    if (winners.length === 1) {
      this.addLog(`🏆 ${winners[0].name} 님 승리! 칩 ${pot}개 획득`, 'win');
    } else {
      const parts = entries.filter((e) => e.win).map((e) => `${e.name} ${e.payout}개`);
      this.addLog(`무승부 → 칩 ${pot}개 분배: ${parts.join(', ')}`, 'win');
    }
    this.finishRound();
  }

  finishByFold() {
    const winner = this.inRoundPlayers()[0];
    this.turnIdx = -1;
    this.toAct = [];
    const { pot } = this.distribute([winner]);
    this.result = {
      type: 'fold',
      limit: this.limit,
      pot,
      draw: false,
      entries: [{ id: winner.id, name: winner.name, win: true, payout: pot }],
    };
    this.addLog(`나머지 플레이어가 모두 포기 → ${winner.name} 님이 칩 ${pot}개 획득`, 'win');
    this.finishRound();
  }

  finishRound() {
    // 규칙 14: 칩이 0개가 된 플레이어 탈락 (나간 플레이어도 탈락 처리)
    const out = this.players.filter((p) => p.alive && (p.chips <= 0 || p.left));
    for (const p of out) p.alive = false;
    this.assignPlaces(out);
    for (const p of out) {
      this.addLog(p.left ? `${p.name} 님이 게임을 떠났습니다.` : `💀 ${p.name} 님 칩 0개 → 탈락 (${p.place}위)`, 'out');
    }
    this.checkGameOver() || (this.phase = 'roundEnd');
  }

  assignPlaces(out) {
    if (!out.length) return;
    const remaining = this.alivePlayers().length;
    for (const p of out) p.place = remaining + 1;
  }

  checkGameOver() {
    const alive = this.alivePlayers();
    if (alive.length > 1) return false;
    this.phase = 'gameOver';
    this.turnIdx = -1;
    if (alive.length === 1) {
      alive[0].place = 1;
      this.winnerId = alive[0].id;
      this.addLog(`👑 최종 승자: ${alive[0].name} 님!`, 'win');
    }
    return true;
  }

  // ───────────────────────── 이탈 / 자동 처리 ─────────────────────────

  /** 플레이어가 방을 떠남: 진행 중 라운드는 포기 처리, 라운드 종료 시 탈락 */
  leave(playerId) {
    const p = this.player(playerId);
    if (p.left || !p.alive) {
      p.left = true;
      return;
    }
    p.left = true;
    if (['reveal', 'bet1', 'hit', 'bet2'].includes(this.phase) && this.inRound(p)) {
      this.fold(p, '자리를 떠나 포기 처리되었습니다.');
    } else if (this.phase === 'roundEnd') {
      p.alive = false;
      this.assignPlaces([p]);
      this.addLog(`${p.name} 님이 게임을 떠났습니다.`, 'out');
      this.checkGameOver();
    }
  }

  /** 연결이 끊긴 플레이어를 대신해 최소한의 행동 (공개: 첫 장 / 베팅: 체크 또는 포기 / 힛: 스테이) */
  autoAct(playerId) {
    const p = this.player(playerId);
    if (!this.pendingIds().includes(p.id)) return false;
    if (this.phase === 'reveal') this.act(p.id, { type: 'reveal', index: 0 });
    else if (this.phase === 'hit') this.act(p.id, { type: 'stay' });
    else if (this.callAmount(p) === 0) this.act(p.id, { type: 'call' });
    else this.act(p.id, { type: 'fold' });
    return true;
  }

  // ───────────────────────── 뷰 ─────────────────────────

  viewFor(viewerId) {
    const turnId = this.turnIdx >= 0 ? this.players[this.turnIdx].id : null;
    const showAll = (p) => (this.phase === 'roundEnd' || this.phase === 'gameOver') && this.showdownIds.has(p.id);

    const players = this.players.map((p, i) => {
      const mine = p.id === viewerId;
      const cards = p.cards.map((c) => (c.up || mine || showAll(p) ? { v: c.v, up: c.up } : { v: null, up: false }));
      const openSum = p.cards.filter((c) => c.up).reduce((s, c) => s + c.v, 0);
      return {
        id: p.id,
        name: p.name,
        seat: i,
        chips: p.chips,
        bet: p.bet,
        alive: p.alive,
        left: p.left,
        folded: p.alive && p.folded,
        stayed: p.stayed,
        revealed: p.revealed,
        place: p.place,
        lastAction: p.lastAction,
        isFirst: i === this.firstIdx,
        isTurn: p.id === turnId,
        pending: this.pendingIds().includes(p.id),
        cards,
        openSum,
      };
    });

    let me = null;
    const vp = this.players.find((p) => p.id === viewerId);
    if (vp) {
      const actions = [];
      const inRound = this.inRound(vp);
      if (inRound && this.phase === 'reveal' && !vp.revealed) actions.push('reveal');
      if (inRound && (this.phase === 'bet1' || this.phase === 'bet2') && turnId === vp.id) {
        actions.push('call', 'fold');
        if (this.maxRaise(vp) >= 1) actions.push('raise');
      }
      if (inRound && this.phase === 'hit' && turnId === vp.id) actions.push('hit', 'stay');
      me = {
        id: vp.id,
        sum: Game.handSum(vp.cards),
        actions,
        toCall: this.callAmount(vp),
        maxRaise: Math.max(0, this.maxRaise(vp)),
      };
    }

    return {
      phase: this.phase,
      phaseLabel: PHASE_LABEL[this.phase] || '',
      round: this.round,
      ante: this.ante,
      limit: this.limit,
      cap: this.cap,
      pot: this.pot(),
      currentBet: this.currentBet,
      deckCount: this.deck.length,
      turnId,
      firstId: this.firstIdx >= 0 ? this.players[this.firstIdx].id : null,
      lottery: this.lottery,
      players,
      me,
      result: this.result,
      winnerId: this.winnerId,
      log: this.log.slice(-120),
    };
  }
}

module.exports = { Game, GameError, buildDeck, DECK_SPEC, STARTING_CHIPS, MIN_PLAYERS, MAX_PLAYERS, PHASE_LABEL };
