/* global io */
'use strict';

const socket = io();
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

let state = null; // 서버가 보낸 방 상태
let pendingRaise = 0; // 칩 트레이로 쌓는 중인 레이즈 금액
let fxPrev = null; // 칩 애니메이션용 직전 상태 { round, phase, bets }
let lastLogSeq = 0;
let logOpen = false; // 딜러 기록 팝오버 열림 여부
let seenCards = {}; // 카드 딜 애니메이션용: { round, counts: {playerId: n} }

// 탭마다 다른 플레이어로 접속할 수 있도록 세션은 sessionStorage에 보관
const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem('hitstay.session'));
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem('hitstay.session', JSON.stringify(v));
    } catch {}
  },
  clear() {
    try {
      sessionStorage.removeItem('hitstay.session');
    } catch {}
  },
};
const savedName = {
  get: () => {
    try {
      return localStorage.getItem('hitstay.name') || '';
    } catch {
      return '';
    }
  },
  set: (v) => {
    try {
      localStorage.setItem('hitstay.name', v);
    } catch {}
  },
};

// ───────── socket ─────────
socket.on('connect', () => {
  const s = session.get();
  if (s) {
    socket.emit('room:resume', s, (res) => {
      if (!res.ok) {
        session.clear();
        state = null;
        render();
        toast(res.error);
      }
    });
  } else render();
});
socket.on('state', (s) => {
  state = s;
  render();
});
socket.on('kicked', (msg) => {
  session.clear();
  state = null;
  render();
  toast(msg);
});
socket.on('disconnect', () => toast('서버와 연결이 끊겼습니다. 재연결 중…'));

function emit(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => {
      if (!res || !res.ok) toast(res ? res.error : '응답이 없습니다.');
      resolve(res || { ok: false });
    });
  });
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 3200);
}

// ───────── helpers ─────────
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtV = (v) => (v < 0 ? `−${Math.abs(v)}` : String(v));
const initial = (name) => Array.from(String(name).trim())[0]?.toUpperCase() || '?';

const ICON = {
  // 실제 테이블 신호: HIT = 테이블 톡톡, STAY = 손 흔들기
  tap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 12V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M13 10.5a1.5 1.5 0 0 1 3 0V12"/><path d="M16 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.2a5 5 0 0 1-4.1-2.2L5.3 15.3a1.6 1.6 0 0 1 2.6-1.9L10 15.5"/><path d="M5 4.5 6.5 6M3.5 9H5.5M9.5 1.5V3"/></svg>`,
  wave: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V7a1.5 1.5 0 0 1 3 0v4.5"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7 6 6 0 0 1-5-2.7l-2-3.3a1.6 1.6 0 0 1 2.7-1.7L8 15"/><path d="M19.5 3.5a6 6 0 0 1 1.5 4"/><path d="M3 7.5a6 6 0 0 1 1.3-3.8"/></svg>`,
};

function cardHtml(c, { lg = false, secret = false, pick = false, idx = null, isNew = false, rot = null } = {}) {
  const size = lg ? 'lg' : '';
  const anim = isNew ? 'new' : '';
  const style = rot == null ? '' : `style="--rot:${rot.toFixed(1)}deg"`;
  if (c.v === null) return `<div class="card back ${size} ${anim}" ${style}></div>`;
  const tone = c.v < 0 ? 'neg' : c.v === 7 ? 'seven' : '';
  const attrs = pick ? `data-act="reveal" data-index="${idx}" title="이 카드를 공개"` : '';
  return `<div class="card face ${tone} ${size} ${anim} ${secret ? 'secret' : ''} ${pick ? 'pick' : ''}" ${attrs} ${style}>
      <span class="corner tl">${fmtV(c.v)}</span><span class="val">${fmtV(c.v)}</span><span class="corner br">${fmtV(c.v)}</span>
    </div>`;
}

function newFlags(g, p) {
  if (seenCards.round !== g.round) return p.cards.map(() => false);
  const prev = seenCards.counts[p.id] ?? p.cards.length;
  return p.cards.map((_, i) => i >= prev);
}

// ───────── render ─────────
function render() {
  if (!state) return renderHome();
  if (!state.game) return renderLobby();
  renderGame();
}

function renderHome() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase();
  $app.innerHTML = `
    <div class="home">
      <div class="home-box">
        <h1 class="logo"><span class="hit">HIT</span><span class="comma">,</span> <span class="stay">STAY</span></h1>
        <p class="tagline">숫자 카드의 합을 한계 숫자에 맞춰 살아남아라</p>
        <div class="field">
          <label for="name">닉네임</label>
          <input id="name" maxlength="12" placeholder="닉네임 (최대 12자)" value="${esc(savedName.get())}" />
        </div>
        <button class="full big" data-act="create">새 방 만들기</button>
        <div class="divider">또는 코드로 입장</div>
        <div class="row">
          <input id="code" maxlength="4" placeholder="방 코드 4자리" value="${esc(code)}" style="text-transform:uppercase;letter-spacing:.2em" />
          <button class="blue" data-act="join">입장</button>
        </div>
        <details class="rules">
          <summary>게임 규칙 요약</summary>
          <ol>
            <li>숫자 카드 35장: 7×1, 6×2, 5×3, 4×4, 3×5, 2×6, 1×7, −1×7</li>
            <li>시작 칩 30개. 기본 베팅 1개 (10라운드마다 +1)</li>
            <li>딜러가 8면체 주사위(5~12)로 한계 숫자를 정함</li>
            <li>3장씩 받고 1장을 골라 공개 → 1차 베팅 (콜/레이즈/포기)</li>
            <li>선 플레이어부터 HIT(공개 카드 1장 추가) 또는 STAY</li>
            <li>전원 STAY 또는 카드 소진 시 2차 베팅 후 공개</li>
            <li>한계 숫자에 가장 가까운 합이 승리. 같으면 카드 많은 쪽. 초과는 최하위</li>
            <li>베팅 총액은 최저 보유자의 칩 수를 넘을 수 없음</li>
            <li>칩 0개 → 탈락. 마지막 1명이 최종 승자</li>
          </ol>
        </details>
      </div>
    </div>`;
  const $code = document.getElementById('code');
  $code.addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
  document.getElementById('name').addEventListener('keydown', (e) => e.key === 'Enter' && (code ? doJoin() : doCreate()));
}

function renderLobby() {
  const s = state;
  const isHost = s.hostId === s.meId;
  const link = `${location.origin}/?room=${s.code}`;
  const canStart = s.members.length >= s.minPlayers;
  $app.innerHTML = `
    <div class="lobby">
      <div class="home-box" style="width:100%">
        <h1 class="logo" style="font-size:30px;margin-bottom:28px"><span class="hit">HIT</span><span class="comma">,</span> <span class="stay">STAY</span></h1>
        <p class="eyebrow">대기실 · 방 코드</p>
        <div class="room-code">${s.code}</div>
        <div class="row">
          <input readonly value="${esc(link)}" id="link" />
          <button class="ghost" data-act="copy">링크 복사</button>
        </div>
        <ul class="member-list">
          ${s.members
            .map(
              (m) => `<li>
                <span class="avatar">${esc(initial(m.name))}<span class="dot ${m.connected ? '' : 'off'}"></span></span>
                <b>${esc(m.name)}</b>${m.id === s.meId ? ' <span class="muted">(나)</span>' : ''}
                <span class="tag">${m.id === s.hostId ? '<span class="badge first">방장</span>' : ''}</span>
              </li>`,
            )
            .join('')}
        </ul>
        <p class="muted" style="font-size:13px">${s.members.length} / ${s.maxPlayers}명 · 최소 ${s.minPlayers}명부터 시작할 수 있어요.</p>
        <div class="actions" style="margin-top:16px">
          ${
            isHost
              ? `<button class="big" data-act="start" ${canStart ? '' : 'disabled'}>게임 시작</button>`
              : '<span class="muted">방장이 게임을 시작하길 기다리는 중…</span>'
          }
          <span style="flex:1"></span>
          <button class="ghost" data-act="leave">나가기</button>
        </div>
      </div>
    </div>`;
}

function renderGame() {
  const s = state;
  const g = s.game;
  const me = g.players.find((p) => p.id === s.meId);
  const prevScroll = document.querySelector('.log-list');
  const stickBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 40;
  const memberById = Object.fromEntries(s.members.map((m) => [m.id, m]));

  // 내 자리 기준으로 시계 방향 순서로 다른 플레이어 배치
  const myIdx = g.players.findIndex((p) => p.id === s.meId);
  const others = [];
  for (let i = 1; i < g.players.length; i++) others.push(g.players[(myIdx + i) % g.players.length]);

  const winners = new Set((g.result?.entries || []).filter((e) => e.win).map((e) => e.id));
  const showResult = g.phase === 'roundEnd' || g.phase === 'gameOver';
  const turnPlayer = g.players.find((p) => p.isTurn);
  const pot = showResult && g.result ? g.result.pot : g.pot;
  if (!g.me?.actions.includes('raise')) pendingRaise = 0;

  $app.innerHTML = `
    <div class="game tablegame">
      <div class="main">
        <div class="topbar">
          <span class="logo-sm"><span class="hit">HIT</span><span class="comma">,</span> <span class="stay">STAY</span></span>
          <span class="pill room">방 ${s.code}</span>
          <span class="pill">${g.round}라운드</span>
          <span class="pill phase">${esc(g.phaseLabel)}</span>
          <span class="spacer"></span>
          <div class="log-wrap">
            <button class="log-ticker ghost" data-act="log-toggle" aria-expanded="${logOpen}" title="딜러 기록 보기">
              <span class="log-label">딜러</span><span class="log-last ${g.log.at(-1)?.kind || ''}">${esc(g.log.at(-1)?.text || '')}</span><span class="log-caret">${logOpen ? '▴' : '▾'}</span>
            </button>
            <div class="log log-pop" ${logOpen ? '' : 'hidden'}>
              <div class="log-list">
                ${g.log.map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('')}
              </div>
            </div>
          </div>
          <button class="ghost" data-act="leave">나가기</button>
        </div>

        ${tableHtml(s, g, { me, others, memberById, winners, showResult, turnPlayer, pot })}
      </div>
    </div>`;

  const list = document.querySelector('.log-list');
  if (list && (stickBottom || g.log.at(-1)?.seq !== lastLogSeq)) list.scrollTop = list.scrollHeight;
  lastLogSeq = g.log.at(-1)?.seq ?? 0;

  seenCards = { round: g.round, counts: Object.fromEntries(g.players.map((p) => [p.id, p.cards.length])) };
  tickCountdown();
  fitTable();
  tableFx(g);
}

// ───────── 테이블 레이아웃 ─────────
const MIN_TABLE_W = 220;
/**
 * 창 높이에 맞춰 테이블 폭을 줄여 스크롤 없이 한 화면에 들어오게 한다.
 * (테이블은 가로세로 비율이 고정이라 폭이 곧 높이를 정함. 3D 기울기는 레이아웃 높이에 영향 없음)
 */
function fitTable() {
  const table = document.querySelector('.table');
  if (!table) return;
  table.style.maxWidth = '';
  for (let i = 0; i < 3; i++) {
    const over = document.documentElement.scrollHeight - innerHeight;
    if (over <= 0) return;
    const w = table.offsetWidth;
    const h = table.offsetHeight;
    const next = Math.max(MIN_TABLE_W, Math.floor((w * (h - over - 1)) / h));
    if (next >= w) return;
    table.style.maxWidth = `${next}px`;
  }
}
let fitQueued = false;
addEventListener('resize', () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitTable();
  });
});


/** 타원 테이블 위 좌표. deg는 화면 기준 각도(90 = 아래 = 내 자리, 시계 방향으로 증가), r은 0(중앙)~1(테두리) */
function tpos(deg, r) {
  const a = (deg * Math.PI) / 180;
  return `left:${(50 + 50 * r * Math.cos(a)).toFixed(2)}%;top:${(50 + 50 * r * Math.sin(a)).toFixed(2)}%`;
}

const CHIP_DENOMS = [25, 5, 1];
/** n을 칩 단위(25/5/1)로 쪼갬 */
function chipBreakdown(n) {
  const out = [];
  for (const d of CHIP_DENOMS) while (n >= d) out.push(d), (n -= d);
  return out;
}
/** 3D 칩 더미: 단위별로 쌓고, perStack개씩 옆으로 무더기를 나눔 */
function chipPileHtml(n, { perStack = 6, maxStacks = 4 } = {}) {
  if (!n || n <= 0) return '';
  const chips = chipBreakdown(n);
  const stacks = [];
  for (let i = 0; i < chips.length && stacks.length < maxStacks; i += perStack) stacks.push(chips.slice(i, i + perStack));
  return `<span class="chip-pile">${stacks
    .map((st) => `<span class="chip-stack" style="--k:${st.length}">${st.map((d, i) => `<i class="chip3d d${d}" style="--i:${i}"></i>`).join('')}</span>`)
    .join('')}</span>`;
}

const D8_SVG = `<svg class="d8-svg" viewBox="0 0 100 100" aria-hidden="true">
  <polygon class="f1" points="50,3 6,47 50,60"/><polygon class="f2" points="50,3 50,60 94,47"/>
  <polygon class="f3" points="6,47 50,97 50,60"/><polygon class="f4" points="50,60 50,97 94,47"/>
</svg>`;

function tableHtml(s, g, { me, others, memberById, winners, showResult, turnPlayer, pot }) {
  const k = others.length;
  const parts = others.map((p, i) =>
    tableSeatHtml(g, p, memberById[p.id], winners.has(p.id) && showResult, 150 + (240 * (i + 0.5)) / Math.max(1, k), false),
  );
  if (me) parts.push(tableSeatHtml(g, me, memberById[me.id], winners.has(me.id) && showResult, 90, true));
  return `
    ${g.round === 1 && g.phase === 'reveal' ? lotteryHtml(g) : ''}
    <div class="table-rules">${showResult ? '' : `현재 베팅 <b>${g.currentBet}</b> · `}베팅 한도 <b>${g.cap}</b> · 기본 베팅 <b>${g.ante}</b></div>
    <div class="table-wrap">
      <div class="table ${g.players.length > 5 ? 'crowded' : ''}">
        <div class="felt"><div class="felt-line"></div></div>
        <div class="table-center">
          <div class="shoe" title="남은 카드">
            <div class="shoe-cards"><i></i><i></i><i></i></div>
            <span class="shoe-n">${g.deckCount}</span><span class="shoe-k">남은 카드</span>
          </div>
          <div class="d8" title="한계 숫자 · 8면체 주사위 (5~12)">
            ${D8_SVG}
            <span class="d8-num">${g.limit ?? '?'}</span>
            <span class="d8-k">한계 숫자</span>
          </div>
          <div class="pot" title="팟">
            <div class="pot-chips">${chipPileHtml(pot, { perStack: 5, maxStacks: 5 })}</div>
            <span class="pot-v">${pot}</span><span class="pot-k">팟</span>
          </div>
        </div>
        ${parts.join('')}
        ${me ? `<div class="t-stage" style="${tpos(56, 0.52)}">${stageHtml()}</div>` : ''}
      </div>
      ${showResult ? `<div class="table-result">${resultHtml(s, g)}</div>` : ''}
    </div>
    ${me ? dockHtml(g, me, turnPlayer) : ''}`;
}

function tableSeatHtml(g, p, member, isWinner, deg, mine) {
  const flags = newFlags(g, p);
  const ended = g.phase === 'roundEnd' || g.phase === 'gameOver';
  const canPick = mine && g.me.actions.includes('reveal');
  const n = p.cards.length;
  const spread = mine ? 4 : 6;
  const cards = p.cards
    .map((c, i) =>
      cardHtml(c, { lg: mine, secret: mine && !c.up && !ended, pick: canPick, idx: i, isNew: flags[i], rot: (i - (n - 1) / 2) * spread }),
    )
    .join('');

  const cls = ['t-seat'];
  if (mine) cls.push('me');
  if (p.isTurn || canPick) cls.push('turn');
  if (p.folded) cls.push('folded');
  if (!p.alive) cls.push('dead');
  if (isWinner) cls.push('winner');
  if (Math.cos((deg * Math.PI) / 180) > 0.25) cls.push('east'); // 오른쪽 자리: 배지를 테이블 안쪽(왼쪽)에

  const badges = [];
  if (mine) badges.push('<span class="badge me">나</span>');
  if (p.stayed && !p.folded) badges.push('<span class="badge stay">STAY</span>');
  if (p.folded) badges.push('<span class="badge fold">포기</span>');
  if (!p.alive) badges.push(`<span class="badge fold">${p.left ? '퇴장' : '탈락'}${p.place ? ` ${p.place}위` : ''}</span>`);
  if (member && !member.connected && !p.left) badges.push('<span class="badge off">연결 끊김</span>');

  let bubble = '';
  if (!ended) {
    if (g.phase === 'reveal' && p.alive && !p.folded) bubble = p.revealed ? '공개 완료' : '고르는 중…';
    else if (p.isTurn && !mine) bubble = '생각 중…';
    else if (p.lastAction) bubble = esc(p.lastAction);
  }

  const handPos = tpos(deg, mine ? 0.5 : 0.66);
  const betPos = mine ? tpos(124, 0.52) : tpos(deg - 17, 0.42);
  const puckPos = mine ? tpos(150, 0.7) : tpos(deg + 17, 0.42);
  const payout = isWinner ? (g.result?.entries || []).find((e) => e.id === p.id)?.payout : 0;

  return `
    <div class="${cls.join(' ')}" data-pid="${p.id}" style="${tpos(deg, mine ? 1.06 : 1.02)}">
      ${payout ? `<span class="t-win">+${payout}</span>` : ''}
      ${bubble ? `<span class="t-bubble ${p.isTurn ? 'live' : ''}">${bubble}</span>` : ''}
      ${mine ? '' : personHtml(p.name)}
      <div class="t-plate">
        ${mine ? `<span class="t-avatar">${esc(initial(p.name))}</span>` : ''}
        <span class="t-info"><span class="t-name">${esc(p.name)}</span><span class="t-chips"><i class="chip-ico"></i><b>${p.chips}</b></span></span>
        ${badges.length ? `<span class="t-badges">${badges.join('')}</span>` : ''}
      </div>
    </div>
    <div class="t-hand ${mine ? 't-mine' : ''} ${p.folded ? 'folded' : ''}" style="${handPos}">
      <div class="cards">${cards}</div>
      ${!mine && p.alive && !ended && p.cards.some((c) => c.up) ? `<span class="t-open">공개 합 ${p.openSum}</span>` : ''}
    </div>
    ${p.bet > 0 && !ended ? `<div class="t-bet" data-pid="${p.id}" style="${betPos}">${chipPileHtml(p.bet, { perStack: 5, maxStacks: 3 })}<b>${p.bet}</b></div>` : ''}
    ${p.isFirst && p.alive ? `<div class="t-puck" style="${puckPos}" title="선 플레이어">선</div>` : ''}`;
}

/** 레이즈 대기 칩 (펠트 위, 내 자리 옆) */
function stageHtml() {
  return pendingRaise > 0 ? `${chipPileHtml(pendingRaise, { perStack: 5, maxStacks: 3 })}<b>+${pendingRaise}</b>` : '';
}

/** 베팅: 몇 개를 걸지 직접 정하거나(슬라이더·숫자·빠른 선택), 칩 트레이에서 칩을 던져 쌓는다 */
function chipBetHtml(g, a) {
  const toCall = g.me.toCall;
  const maxR = a.includes('raise') ? g.me.maxRaise : 0;
  pendingRaise = Math.min(pendingRaise, maxR);
  const left = maxR - pendingRaise;
  const presets = [
    ['최소', 1],
    ['팟 ½', Math.ceil(g.pot / 2)],
    ['팟', g.pot],
    ['최대', maxR],
  ];
  return `<div class="action-area chip-bet">
      <div class="bet-head">
        <div class="prompt">${g.phase === 'bet1' ? '1차' : '2차'} 베팅 <span class="muted">— ${toCall > 0 ? `${toCall}개를 더 내야 콜` : '체크하거나 레이즈할 칩 수를 정하세요'}</span></div>
        <div class="bet-summary" id="bet-summary">${betSummary()}</div>
      </div>
      ${
        maxR > 0
          ? `<div class="amount-row">
              <span class="amount-k">레이즈</span>
              <div class="amount-step">
                <button class="ghost" data-act="amt-dec" aria-label="1개 줄이기">−</button>
                <input id="raise-num" type="number" inputmode="numeric" min="0" max="${maxR}" value="${pendingRaise}" aria-label="레이즈할 칩 수" />
                <button class="ghost" data-act="amt-inc" aria-label="1개 늘리기">+</button>
              </div>
              <span class="amount-unit">개 <span class="muted">/ 최대 ${maxR}</span></span>
              <div class="amount-presets">
                ${presets.map(([label, v]) => `<button class="ghost" data-act="amt-set" data-v="${Math.min(v, maxR)}">${label}</button>`).join('')}
                <button class="ghost tray-clear" data-act="chip-clear" ${pendingRaise ? '' : 'disabled'}>0으로</button>
              </div>
            </div>
            <div class="amount-line">
              <input id="raise-range" class="amount-range" type="range" min="0" max="${maxR}" step="1" value="${pendingRaise}" style="--p:${(pendingRaise / maxR) * 100}%" aria-label="레이즈할 칩 수" />
              <div class="tray" title="칩을 눌러 던져서 올리기">
                ${[1, 5, 25]
                  .filter((d) => d <= maxR || d === 1)
                  .map((d) => `<button class="tchip d${d}" data-act="chip" data-v="${d}" ${d > left ? 'disabled' : ''} aria-label="칩 ${d}개 던지기"><span>${d}</span></button>`)
                  .join('')}
              </div>
            </div>`
          : `<div class="bet-note">베팅 한도(${g.cap}) 도달 · 레이즈 불가</div>`
      }
      <div class="bet-bar">
        <button class="call" data-act="call">${toCall > 0 ? `콜 +${toCall}` : '체크'}</button>
        ${maxR > 0 ? `<button class="raise-go" data-act="raise" ${pendingRaise ? '' : 'disabled'}>${raiseLabel()}</button>` : ''}
        <span class="spacer"></span>
        <button class="danger-ghost" data-act="fold">포기<span class="long"> · 카드 덮기</span></button>
      </div>
    </div>`;
}

/** 이번에 실제로 내는 칩 = 콜 금액 + 레이즈 금액 */
function betSummary() {
  const g = state?.game;
  if (!g?.me) return '';
  const me = g.players.find((p) => p.id === g.me.id);
  const toCall = g.me.toCall;
  const pay = toCall + pendingRaise;
  const parts = [];
  if (toCall) parts.push(`콜 ${toCall}`);
  if (pendingRaise) parts.push(`레이즈 ${pendingRaise}`);
  const how = parts.length > 1 ? `${parts.join(' + ')} = ` : '';
  return pay
    ? `이번에 낼 칩 <span class="muted">${how}</span><b>${pay}개</b> · 내 베팅 총 ${me.bet + pay}개 · 남는 칩 ${me.chips - pay}개`
    : `칩을 내지 않고 체크 · 보유 칩 ${me.chips}개`;
}

function raiseLabel() {
  return pendingRaise ? `레이즈 +${pendingRaise}` : '칩을 골라 레이즈';
}

/** 다시 그리지 않고 레이즈 대기 금액만 갱신 */
function setPending(v) {
  const g = state?.game;
  const max = g?.me?.maxRaise ?? 0;
  pendingRaise = Math.max(0, Math.min(v, max));
  const left = max - pendingRaise;
  const go = document.querySelector('[data-act="raise"].raise-go');
  if (go) {
    go.disabled = !pendingRaise;
    go.textContent = raiseLabel();
  }
  const clr = document.querySelector('[data-act="chip-clear"]');
  if (clr) clr.disabled = !pendingRaise;
  document.querySelectorAll('.tchip').forEach((b) => (b.disabled = Number(b.dataset.v) > left));
  const range = document.getElementById('raise-range');
  if (range) {
    range.value = pendingRaise;
    range.style.setProperty('--p', `${max ? (pendingRaise / max) * 100 : 0}%`);
  }
  const num = document.getElementById('raise-num');
  if (num && document.activeElement !== num) num.value = pendingRaise;
  const sum = document.getElementById('bet-summary');
  if (sum) sum.innerHTML = betSummary();
  const stage = document.querySelector('.t-stage');
  if (stage) stage.innerHTML = stageHtml();
}

// ───────── 칩 날리기 애니메이션 ─────────
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function fxLayer() {
  let l = document.getElementById('fx');
  if (!l) {
    l = document.createElement('div');
    l.id = 'fx';
    document.body.appendChild(l);
  }
  return l;
}
const FLY_MS = 560;
const FLY_GAP = 80;
/** fromEl → toEl 로 칩들을 포물선으로 던진다 (화면 좌표 기준, 3D 기울기와 무관) */
function flyChips(fromEl, toEl, denoms, delay = 0) {
  if (!fromEl || !toEl || !denoms.length || reduceMotion()) return;
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  if (!b.width || !a.width) return; // 숨겨진 대상이면 (0,0)으로 날아가지 않게
  const x0 = a.left + a.width / 2;
  const y0 = a.top + a.height / 2;
  const dx = b.left + b.width / 2 - x0;
  const dy = b.top + b.height / 2 - 8 - y0;
  const lift = Math.min(150, 50 + Math.hypot(dx, dy) * 0.25);
  denoms.forEach((d, i) => {
    const el = document.createElement('span');
    el.className = `chip3d fly d${d}`;
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    fxLayer().appendChild(el);
    const jx = (Math.random() - 0.5) * 10;
    const anim = el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.9) rotateX(0deg)', opacity: 0, filter: 'drop-shadow(0 2px 1px rgba(0,0,0,.5))' },
        { opacity: 1, offset: 0.08 },
        {
          transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - lift}px)) scale(1.45) rotateX(200deg)`,
          filter: `drop-shadow(0 ${Math.round(lift * 0.45)}px 6px rgba(0,0,0,.35))`,
          offset: 0.5,
        },
        { transform: `translate(calc(-50% + ${dx + jx}px), calc(-50% + ${dy}px)) scale(1) rotateX(360deg)`, opacity: 1, filter: 'drop-shadow(0 2px 1px rgba(0,0,0,.5))' },
      ],
      { duration: FLY_MS, delay: delay + i * FLY_GAP, easing: 'cubic-bezier(.25,.8,.35,1)', fill: 'both' },
    );
    anim.onfinish = () => el.remove();
  });
}

/** 상태가 바뀔 때: 늘어난 베팅은 자리 → 베팅 위치로, 라운드 종료 시 팟 → 승자로 칩을 날린다 */
function tableFx(g) {
  const prev = fxPrev;
  fxPrev = { round: g.round, phase: g.phase, bets: Object.fromEntries(g.players.map((p) => [p.id, p.bet])) };
  if (!prev) return;
  const ended = g.phase === 'roundEnd' || g.phase === 'gameOver';
  const q = (sel) => document.querySelector(sel);
  if (!ended) {
    for (const p of g.players) {
      const before = prev.round === g.round ? (prev.bets[p.id] ?? 0) : 0;
      const d = p.bet - before;
      if (d <= 0) continue;
      const to = q(`.t-bet[data-pid="${p.id}"]`);
      const chips = chipBreakdown(d).slice(0, 6);
      if (to && !reduceMotion()) {
        to.style.setProperty('--land', `${FLY_MS + (chips.length - 1) * FLY_GAP - 60}ms`);
        to.classList.add('landing');
      }
      flyChips(q(`.t-seat[data-pid="${p.id}"]`), to, chips);
    }
  }
  if (g.phase === 'roundEnd' && prev.phase !== 'roundEnd' && g.result) {
    g.result.entries
      .filter((e) => e.win && e.payout)
      .forEach((e, j) => flyChips(q('.pot'), q(`.t-seat[data-pid="${e.id}"]`), chipBreakdown(e.payout).slice(0, 8), j * 160));
  }
}

// ───────── 자리에 앉은 사람 (CSS 3D 피규어) ─────────
const SKINS = ['#f3d2b5', '#e8b58f', '#c98e66', '#9a6646', '#6e4630', '#f6dcc6'];
const HAIRS = ['#1d1612', '#3b2618', '#6b4226', '#a8743f', '#d8b36a', '#7a2f2a', '#2b2f3a', '#9aa0a8'];
const SHIRTS = ['#2f5d8a', '#8a2f3f', '#2f7a5a', '#6b4b9a', '#b8742a', '#3a3f4a', '#c2a46a', '#2a6f7a', '#8f5a3c', '#5a6b2f'];
const HAIR_STYLES = ['short', 'long', 'bun', 'cap', 'curly', 'side'];
function hashStr(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}
/** 이름으로 고정된 외형(피부·머리·옷)을 가진 상반신 피규어 */
function personHtml(name) {
  const h = hashStr(name);
  const pick = (arr, shift) => arr[(h >>> shift) % arr.length];
  const style = `--skin:${pick(SKINS, 0)};--hair:${pick(HAIRS, 5)};--shirt:${pick(SHIRTS, 10)}`;
  return `<span class="t-person hair-${pick(HAIR_STYLES, 15)}" style="${style}" aria-hidden="true">
      <i class="p-chair"></i>
      <i class="p-backhair"></i>
      <i class="p-body"><i class="p-collar"></i></i>
      <i class="p-arm l"></i><i class="p-arm r"></i>
      <i class="p-neck"></i>
      <i class="p-head"><i class="p-hair"></i><i class="p-face"></i></i>
    </span>`;
}

/** 테이블 아래 내 손 패널: 합계 게이지 + 행동 */
function dockHtml(g, me, turnPlayer) {
  const myTurn = g.me.actions.length > 0;
  const hasSecret = me.cards.some((c) => !c.up) && g.phase !== 'roundEnd' && g.phase !== 'gameOver';
  return `<section class="dock ${myTurn ? 'turn' : ''}">
      <div class="dock-meter">
        ${meterHtml(g, me)}
        ${hasSecret ? '<div class="bet-note">점선 테두리 카드는 나만 볼 수 있어요.</div>' : ''}
      </div>
      <div class="dock-actions">${actionHtml(g, me, turnPlayer)}</div>
    </section>`;
}

function lotteryHtml(g) {
  const sorted = [...g.lottery].sort((a, b) => a.ball - b.ball);
  return `<div class="stat lottery">
      <b>추첨 볼</b>
      ${sorted.map((l) => `<span><span class="ball ${l.ball === 1 ? 'one' : ''}">${l.ball}</span>${esc(l.name)}</span>`).join('')}
      <span class="muted">→ 1번 볼이 선 플레이어</span>
    </div>`;
}

/** 내 합계 vs 한계 숫자 게이지 (1칸 = 1점) */
function meterHtml(g, me) {
  const sum = g.me.sum;
  const limit = g.limit;
  const has = me.cards.length > 0;
  if (limit == null) {
    return `<div class="meter"><div class="meter-top"><span class="meter-k">내 합계</span><span class="meter-sum">${has ? sum : '-'}</span></div></div>`;
  }
  const bust = has && sum > limit;
  const perfect = has && sum === limit;
  const pct = bust ? 100 : Math.max(0, Math.min(100, (sum / limit) * 100));
  const note = !has ? '' : bust ? `${sum - limit} 초과` : perfect ? '딱 맞음!' : `여유 ${limit - sum}`;
  return `<div class="meter ${bust ? 'bust' : perfect ? 'perfect' : ''}">
      <div class="meter-top">
        <span class="meter-k">내 합계</span>
        <span class="meter-sum">${has ? sum : '-'}</span>
        <span class="meter-limit">/ ${limit}</span>
        ${note ? `<span class="meter-note">${note}</span>` : ''}
      </div>
      <div class="meter-track" style="--n:${limit}"><div class="meter-fill" style="--p:${has ? pct : 0}%"></div></div>
      ${bust ? '<div class="bet-note">공개 전까지 −1 카드로 되돌릴 수 있어요.</div>' : ''}
    </div>`;
}

function waitingHtml(text) {
  return `<div class="waiting"><span class="spinner"></span>${text}</div>`;
}

function actionHtml(g, me, turnPlayer) {
  const a = g.me.actions;
  if (!me.alive) {
    return `<div class="prompt muted">${me.left ? '게임에서 나갔습니다.' : `탈락했습니다 (${me.place}위). 관전 중…`}</div>`;
  }
  if (g.phase === 'roundEnd' || g.phase === 'gameOver') return '';
  if (me.folded) return '<div class="prompt muted">이번 라운드는 포기했습니다. 다음 라운드를 기다리는 중…</div>';

  if (g.phase === 'reveal') {
    return a.includes('reveal')
      ? '<div class="prompt">👆 모두에게 공개할 카드 1장을 클릭하세요.</div>'
      : waitingHtml('다른 플레이어가 공개할 카드를 고르는 중…');
  }

  if (!a.length) {
    if (g.phase === 'hit' && me.stayed) return waitingHtml('STAY 완료 — 다른 플레이어를 기다리는 중…');
    return waitingHtml(turnPlayer ? `<b style="color:var(--text)">${esc(turnPlayer.name)}</b> 님의 차례입니다` : '잠시 기다려 주세요…');
  }

  if (g.phase === 'hit') {
    return `<div class="action-area">
        <div class="choice-hint"><span class="prompt">카드를 더 받을까요?</span><span>받은 카드는 모두에게 공개돼요 · STAY하면 이번 라운드는 더 받지 않아요</span></div>
        <div class="choice">
          <button class="choice-btn hit" data-act="hit" aria-keyshortcuts="H">
            <span class="choice-icon">${ICON.tap}</span>
            <span class="choice-text"><span class="choice-label">HIT</span><span class="choice-sub">테이블 톡톡 · 1장 더</span></span>
            <kbd>H</kbd>
          </button>
          <button class="choice-btn stay" data-act="stay" aria-keyshortcuts="S">
            <span class="choice-icon">${ICON.wave}</span>
            <span class="choice-text"><span class="choice-label">STAY</span><span class="choice-sub">손 흔들기 · 여기까지</span></span>
            <kbd>S</kbd>
          </button>
        </div>
      </div>`;
  }

  // 베팅
  return chipBetHtml(g, a);
}

function resultHtml(s, g) {
  const isHost = s.hostId === s.meId;
  if (g.phase === 'gameOver') {
    const ranked = [...g.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    const winner = g.players.find((p) => p.id === g.winnerId);
    return `<div class="result">
        <h3>👑 최종 승자: ${winner ? esc(winner.name) : '없음'}</h3>
        <ul class="ranking">
          ${ranked.map((p) => `<li><span class="place">${p.place ?? '-'}위</span><b>${esc(p.name)}</b><span class="muted">칩 ${p.chips}</span></li>`).join('')}
        </ul>
        <div class="actions">
          ${isHost ? '<button data-act="reset">대기실로 돌아가기</button>' : '<span class="muted">방장이 새 게임을 준비할 수 있어요.</span>'}
        </div>
      </div>`;
  }
  const r = g.result;
  if (!r) return '';
  const countdown = s.nextRoundAt ? `<div class="foot">다음 라운드까지 <b id="countdown"></b>초</div>` : '';
  if (r.type === 'fold') {
    return `<div class="result"><h3>🏳️ 나머지 모두 포기 → ${esc(r.entries[0].name)} 님이 칩 ${r.pot}개 획득</h3>${countdown}</div>`;
  }
  const winners = r.entries.filter((e) => e.win);
  const title = r.draw ? `🤝 무승부 — 칩 ${r.pot}개 분배` : `🏆 ${esc(winners[0].name)} 님 승리! 칩 ${r.pot}개 획득`;
  return `<div class="result">
      <h3>${title}</h3>
      <table>
        <tr><th>플레이어</th><th>카드</th><th>합계 (한계 ${r.limit})</th><th>장수</th><th>획득</th></tr>
        ${r.entries
          .map(
            (e) => `<tr class="${e.win ? 'win' : e.bust ? 'bust' : ''}">
              <td>${esc(e.name)}</td>
              <td>${e.cards.map(fmtV).join(', ')}</td>
              <td>${e.sum}${e.bust ? ' 초과' : ''}</td>
              <td>${e.count}</td>
              <td>${e.payout ? `+${e.payout}` : ''}</td>
            </tr>`,
          )
          .join('')}
      </table>
      ${countdown}
    </div>`;
}

function tickCountdown() {
  const el = document.getElementById('countdown');
  if (el && state?.nextRoundAt) el.textContent = Math.max(0, Math.ceil((state.nextRoundAt - Date.now()) / 1000));
}
setInterval(tickCountdown, 250);

// ───────── actions ─────────
async function doCreate() {
  const name = document.getElementById('name').value.trim();
  if (!name) return toast('닉네임을 입력하세요.');
  savedName.set(name);
  const res = await emit('room:create', { name });
  if (res.ok) {
    session.set({ code: res.code, token: res.token });
    history.replaceState(null, '', `/?room=${res.code}`);
  }
}

async function doJoin() {
  const name = document.getElementById('name').value.trim();
  const code = document.getElementById('code').value.trim().toUpperCase();
  if (!name) return toast('닉네임을 입력하세요.');
  if (code.length !== 4) return toast('방 코드 4자리를 입력하세요.');
  savedName.set(name);
  const res = await emit('room:join', { code, name });
  if (res.ok) {
    session.set({ code: res.code, token: res.token });
    history.replaceState(null, '', `/?room=${res.code}`);
  }
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  switch (act) {
    case 'create':
      return doCreate();
    case 'join':
      return doJoin();
    case 'copy': {
      const link = document.getElementById('link');
      try {
        await navigator.clipboard.writeText(link.value);
        el.textContent = '복사됨!';
      } catch {
        link.select();
      }
      return;
    }
    case 'start':
      return emit('game:start');
    case 'reset':
      return emit('game:reset');
    case 'leave': {
      if (state?.game && state.game.phase !== 'gameOver' && state.game.players.find((p) => p.id === state.meId)?.alive && !confirm('게임 중에 나가면 탈락 처리됩니다. 나갈까요?')) return;
      await emit('room:leave');
      session.clear();
      state = null;
      history.replaceState(null, '', '/');
      return render();
    }
    case 'reveal':
      return emit('game:action', { type: 'reveal', index: Number(el.dataset.index) });
    case 'call':
    case 'fold':
    case 'hit':
    case 'stay':
      return emit('game:action', { type: act });
    case 'raise': {
      const amount = pendingRaise;
      if (amount < 1) return;
      pendingRaise = 0;
      return emit('game:action', { type: 'raise', amount });
    }
    case 'chip': {
      const v = Number(el.dataset.v);
      const max = state?.game?.me?.maxRaise ?? 0;
      if (pendingRaise + v > max) return;
      setPending(pendingRaise + v); // 대상 위치가 먼저 보여야 좌표를 잡을 수 있음
      const stage = document.querySelector('.t-stage');
      if (stage && !reduceMotion()) {
        stage.style.setProperty('--land', `${FLY_MS - 60}ms`);
        stage.classList.remove('landing');
        void stage.offsetWidth; // 착지 애니메이션 재시작
        stage.classList.add('landing');
      }
      return flyChips(el, stage, [v]);
    }
    case 'chip-clear':
      return setPending(0);
    case 'amt-inc':
      return setPending(pendingRaise + 1);
    case 'amt-dec':
      return setPending(pendingRaise - 1);
    case 'amt-set':
      return setPending(Number(el.dataset.v));
    case 'log-toggle': {
      logOpen = !logOpen;
      const pop = document.querySelector('.log-pop');
      if (pop) pop.hidden = !logOpen;
      el.setAttribute('aria-expanded', String(logOpen));
      el.querySelector('.log-caret').textContent = logOpen ? '▴' : '▾';
      const list = document.querySelector('.log-list');
      if (logOpen && list) list.scrollTop = list.scrollHeight;
      return;
    }
  }
});

// HIT / STAY 키보드 단축키
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea')) return;
  const acts = state?.game?.me?.actions || [];
  if (state?.game?.phase !== 'hit') return;
  const k = e.key.toLowerCase();
  if (k === 'h' && acts.includes('hit')) emit('game:action', { type: 'hit' });
  else if (k === 's' && acts.includes('stay')) emit('game:action', { type: 'stay' });
});

// 레이즈 칩 수: 슬라이더·숫자 입력
document.addEventListener('input', (e) => {
  if (e.target.id === 'raise-range') setPending(Number(e.target.value));
  else if (e.target.id === 'raise-num' && e.target.value !== '') setPending(Number(e.target.value));
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'raise-num') e.target.value = pendingRaise; // 범위 밖 값은 보정해서 표시
});
// 바깥을 누르면 딜러 기록 닫기
document.addEventListener('pointerdown', (e) => {
  if (!logOpen || e.target.closest('.log-wrap')) return;
  logOpen = false;
  const pop = document.querySelector('.log-pop');
  if (pop) pop.hidden = true;
  const t = document.querySelector('.log-ticker');
  if (t) {
    t.setAttribute('aria-expanded', 'false');
    t.querySelector('.log-caret').textContent = '▾';
  }
});
