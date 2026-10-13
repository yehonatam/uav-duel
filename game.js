'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const ROUNDS_TO_WIN = 3;

// ---------- Input ----------
const keys = new Set();
const pressed = new Set(); // keys pressed this frame
window.addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ---------- Audio (tiny WebAudio beeps, created on first key press) ----------
let audio = null;
function beep(freq, dur, type = 'square', vol = 0.05, slide = 0) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
  } catch (_) { /* audio is optional */ }
}

// ---------- Config ----------
const UPGRADES = [
  { id: 'damage', label: 'Damage',   base: 10,  step: 3,   max: 6, fmt: v => v.toFixed(0) },
  { id: 'health', label: 'Max Health', base: 100, step: 20, max: 6, fmt: v => v.toFixed(0) },
  { id: 'speed',  label: 'Speed',    base: 220, step: 25,  max: 6, fmt: v => v.toFixed(0) },
  { id: 'rate',   label: 'Fire Rate', base: 0.45, step: -0.05, max: 6, fmt: v => (1 / v).toFixed(1) + '/s' },
];
const upgradeCost = lvl => 40 + lvl * 30;

const PLAYERS = [
  { name: 'Player 1', color: '#52d6ff', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'Space',
    buy: ['Digit1', 'Digit2', 'Digit3', 'Digit4'], buyLabels: ['1', '2', '3', '4'], ready: 'Space', readyLabel: 'SPACE',
    controls: 'WASD + SPACE' },
  { name: 'Player 2', color: '#ffa94d', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Enter',
    buy: ['Digit7', 'Digit8', 'Digit9', 'Digit0'], buyLabels: ['7', '8', '9', '0'], ready: 'Enter', readyLabel: 'ENTER',
    controls: 'ARROWS + ENTER' },
];

const WALLS = [
  { x: W / 2 - 25, y: 120, w: 50, h: 90 },
  { x: W / 2 - 25, y: H - 210, w: 50, h: 90 },
  { x: 250, y: H / 2 - 40, w: 40, h: 80 },
  { x: W - 290, y: H / 2 - 40, w: 40, h: 80 },
];

// ---------- State ----------
let state = 'menu'; // menu | countdown | playing | roundEnd | shop | matchEnd
let stateTime = 0;
let paused = false;
let shake = 0;
let roundNo = 1;
let message = '';
let uavs = [], bullets = [], particles = [];
const meta = PLAYERS.map(() => ({ wins: 0, credits: 0, levels: { damage: 0, health: 0, speed: 0, rate: 0 }, ready: false }));

function stat(i, id) {
  const u = UPGRADES.find(x => x.id === id);
  return u.base + u.step * meta[i].levels[id];
}

function spawnUavs() {
  uavs = PLAYERS.map((p, i) => {
    const maxHp = stat(i, 'health');
    return {
      i, x: i === 0 ? 90 : W - 90, y: H / 2, vx: 0, vy: 0,
      angle: i === 0 ? 0 : Math.PI, hp: maxHp, maxHp, cooldown: 0, flash: 0, alive: true, spin: 0, dealt: 0,
    };
  });
  bullets = [];
}

function setState(s) { state = s; stateTime = 0; }

function resetMatch() {
  meta.forEach(m => { m.wins = 0; m.credits = 0; m.ready = false; for (const k in m.levels) m.levels[k] = 0; });
  roundNo = 1;
  startRound();
}

function startRound() {
  spawnUavs();
  particles = [];
  setState('countdown');
}

// ---------- Helpers ----------
function circleRect(cx, cy, r, rc) {
  const nx = Math.max(rc.x, Math.min(cx, rc.x + rc.w));
  const ny = Math.max(rc.y, Math.min(cy, rc.y + rc.h));
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
}
const hitsWall = (x, y, r) => WALLS.some(w => circleRect(x, y, r, w));

function burst(x, y, color, n, speed = 160, life = 0.6) {
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2, s = Math.random() * speed;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * (0.5 + Math.random() * 0.5), max: life, color });
  }
}

// ---------- Update ----------
const UAV_R = 18;

function updateUav(u, dt) {
  const p = PLAYERS[u.i];
  u.spin += dt * 40;
  u.flash = Math.max(0, u.flash - dt);
  u.cooldown = Math.max(0, u.cooldown - dt);
  if (!u.alive) return;

  let dx = (keys.has(p.right) ? 1 : 0) - (keys.has(p.left) ? 1 : 0);
  let dy = (keys.has(p.down) ? 1 : 0) - (keys.has(p.up) ? 1 : 0);
  const len = Math.hypot(dx, dy);
  const sp = stat(u.i, 'speed');
  if (len > 0) {
    dx /= len; dy /= len;
    u.angle = Math.atan2(dy, dx);
  }
  // smooth acceleration for a floaty drone feel
  const accel = 10;
  u.vx += (dx * sp - u.vx) * Math.min(1, accel * dt);
  u.vy += (dy * sp - u.vy) * Math.min(1, accel * dt);

  let nx = u.x + u.vx * dt;
  if (nx < UAV_R || nx > W - UAV_R || hitsWall(nx, u.y, UAV_R)) { nx = u.x; u.vx = 0; }
  u.x = nx;
  let ny = u.y + u.vy * dt;
  if (ny < UAV_R || ny > H - UAV_R || hitsWall(u.x, ny, UAV_R)) { ny = u.y; u.vy = 0; }
  u.y = ny;

  if (state === 'playing' && keys.has(p.fire) && u.cooldown === 0) {
    u.cooldown = stat(u.i, 'rate');
    const bx = u.x + Math.cos(u.angle) * (UAV_R + 6), by = u.y + Math.sin(u.angle) * (UAV_R + 6);
    bullets.push({ x: bx, y: by, vx: Math.cos(u.angle) * 620 + u.vx * 0.3, vy: Math.sin(u.angle) * 620 + u.vy * 0.3,
      owner: u.i, dmg: stat(u.i, 'damage'), life: 1.6 });
    beep(u.i ? 520 : 680, 0.08, 'square', 0.04, -300);
  }
}

function updateBullets(dt) {
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H || hitsWall(b.x, b.y, 3)) {
      b.life = 0; burst(b.x, b.y, '#8d96c9', 4, 80, 0.25);
      continue;
    }
    const target = uavs[1 - b.owner];
    if (target.alive && Math.hypot(b.x - target.x, b.y - target.y) < UAV_R + 3) {
      b.life = 0;
      target.hp = Math.max(0, target.hp - b.dmg);
      target.flash = 0.12;
      uavs[b.owner].dealt += b.dmg;
      burst(b.x, b.y, PLAYERS[b.owner].color, 10, 180, 0.4);
      shake = Math.max(shake, 5);
      beep(160, 0.12, 'sawtooth', 0.06, -80);
      if (target.hp <= 0) {
        target.alive = false;
        burst(target.x, target.y, '#ffd166', 50, 320, 0.9);
        burst(target.x, target.y, PLAYERS[target.i].color, 30, 220, 0.9);
        shake = 16;
        beep(110, 0.5, 'sawtooth', 0.1, -80);
      }
    }
  }
  bullets = bullets.filter(b => b.life > 0);
}

function endRoundIfNeeded() {
  const [a, b] = uavs;
  if (a.alive && b.alive) return;
  if (!a.alive && !b.alive) { message = 'Both UAVs down - draw!'; }
  else {
    const w = a.alive ? 0 : 1;
    meta[w].wins++;
    message = PLAYERS[w].name + ' wins the round!';
  }
  // credits: winner earns more; damage dealt adds a bonus
  uavs.forEach((u, i) => { meta[i].credits += (u.alive && !uavs[1 - i].alive ? 100 : 50) + Math.round(u.dealt / 2); });
  setState('roundEnd');
}

function update(dt) {
  if (pressed.has('KeyP') && (state === 'playing' || state === 'countdown')) paused = !paused;
  if (paused) return;

  stateTime += dt;
  shake = Math.max(0, shake - dt * 30);
  particles.forEach(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.97; p.vy *= 0.97; p.life -= dt; });
  particles = particles.filter(p => p.life > 0);

  if (state === 'menu') {
    if (pressed.has('Space') || pressed.has('Enter')) resetMatch();
  } else if (state === 'countdown') {
    uavs.forEach(u => updateUav(u, dt));
    if (stateTime > 3) { setState('playing'); beep(880, 0.25, 'square', 0.06); }
  } else if (state === 'playing') {
    uavs.forEach(u => updateUav(u, dt));
    updateBullets(dt);
    endRoundIfNeeded();
  } else if (state === 'roundEnd') {
    uavs.forEach(u => updateUav(u, dt));
    updateBullets(dt);
    if (stateTime > 1.8) {
      if (meta.some(m => m.wins >= ROUNDS_TO_WIN)) setState('matchEnd');
      else { meta.forEach(m => m.ready = false); setState('shop'); }
    }
  } else if (state === 'shop') {
    PLAYERS.forEach((p, i) => {
      const m = meta[i];
      p.buy.forEach((code, k) => {
        if (!pressed.has(code)) return;
        const up = UPGRADES[k];
        const lvl = m.levels[up.id], cost = upgradeCost(lvl);
        if (lvl < up.max && m.credits >= cost) { m.credits -= cost; m.levels[up.id]++; beep(700, 0.12, 'triangle', 0.07, 400); }
        else beep(120, 0.12, 'square', 0.05);
      });
      if (pressed.has(p.ready)) { m.ready = !m.ready; beep(500, 0.06, 'triangle', 0.05); }
    });
    if (meta.every(m => m.ready)) { roundNo++; startRound(); }
  } else if (state === 'matchEnd') {
    if (stateTime > 1 && (pressed.has('Space') || pressed.has('Enter'))) setState('menu');
  }
}

// ---------- Drawing ----------
const stars = Array.from({ length: 80 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3 }));

function text(str, x, y, size = 20, color = '#e8ecff', align = 'center', weight = '600') {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

function drawBackground() {
  ctx.fillStyle = '#0a0d24'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff33';
  stars.forEach(s => ctx.fillRect(s.x, s.y, s.r, s.r));
  ctx.strokeStyle = '#ffffff0d'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  WALLS.forEach(w => {
    ctx.fillStyle = '#1b2254'; ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = '#4a58b8'; ctx.lineWidth = 2; ctx.strokeRect(w.x, w.y, w.w, w.h);
  });
}

function drawUav(u) {
  if (!u.alive) return;
  const col = u.flash > 0 ? '#ffffff' : PLAYERS[u.i].color;
  ctx.save();
  ctx.translate(u.x, u.y);
  // arms + rotors (not rotated so rotors stay diagonal)
  ctx.strokeStyle = '#3a4070'; ctx.lineWidth = 3;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(sx * 15, sy * 15); ctx.stroke();
    ctx.save(); ctx.translate(sx * 15, sy * 15);
    ctx.fillStyle = col + '44'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(u.spin); ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(9, 0); ctx.stroke();
    ctx.restore();
  }
  // body + nose pointing in aim direction
  ctx.rotate(u.angle);
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0a0d24';
  ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(5, -5); ctx.lineTo(5, 5); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
  // small health bar above drone
  const bw = 40, f = u.hp / u.maxHp;
  ctx.fillStyle = '#00000088'; ctx.fillRect(u.x - bw / 2, u.y - 34, bw, 5);
  ctx.fillStyle = f > 0.5 ? '#5be37d' : f > 0.25 ? '#ffd166' : '#ff5c5c';
  ctx.fillRect(u.x - bw / 2, u.y - 34, bw * f, 5);
}

function drawHud() {
  uavs.forEach((u, i) => {
    const p = PLAYERS[i], right = i === 1;
    const bw = 300, bx = right ? W - 20 - bw : 20, by = 18;
    ctx.fillStyle = '#00000099'; ctx.fillRect(bx, by, bw, 22);
    const f = u.hp / u.maxHp;
    ctx.fillStyle = f > 0.5 ? '#5be37d' : f > 0.25 ? '#ffd166' : '#ff5c5c';
    if (right) ctx.fillRect(bx + bw * (1 - f), by, bw * f, 22); else ctx.fillRect(bx, by, bw * f, 22);
    ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, 22);
    text(`${Math.ceil(u.hp)} / ${u.maxHp}`, bx + bw / 2, by + 11, 14, '#fff');
    text(p.name, right ? bx + bw : bx, by + 40, 16, p.color, right ? 'right' : 'left');
    // win pips
    for (let k = 0; k < ROUNDS_TO_WIN; k++) {
      const px = right ? bx + 8 + k * 20 : bx + bw - 8 - k * 20;
      ctx.beginPath(); ctx.arc(px, by + 40, 6, 0, Math.PI * 2);
      ctx.fillStyle = k < meta[i].wins ? p.color : '#ffffff22'; ctx.fill();
    }
  });
  text('Round ' + roundNo, W / 2, 28, 18, '#8d96c9');
}

function drawShop() {
  ctx.fillStyle = '#05060fdd'; ctx.fillRect(0, 0, W, H);
  text('UPGRADE BAY', W / 2, 44, 34, '#7fd6ff');
  text(message, W / 2, 80, 18, '#8d96c9');
  PLAYERS.forEach((p, i) => {
    const m = meta[i], x0 = i === 0 ? 40 : W / 2 + 20, w = W / 2 - 60;
    ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.strokeRect(x0, 110, w, 440);
    text(p.name, x0 + w / 2, 140, 24, p.color);
    text('Credits: ' + m.credits, x0 + w / 2, 172, 20, '#ffd166');
    UPGRADES.forEach((up, k) => {
      const y = 215 + k * 68, lvl = m.levels[up.id], cost = upgradeCost(lvl);
      const maxed = lvl >= up.max, afford = m.credits >= cost;
      text(`[${p.buyLabels[k]}] ${up.label}`, x0 + 16, y, 18, '#e8ecff', 'left');
      text(up.fmt(stat(i, up.id)), x0 + w - 16, y, 18, p.color, 'right');
      for (let l = 0; l < up.max; l++) {
        ctx.fillStyle = l < lvl ? p.color : '#ffffff22';
        ctx.fillRect(x0 + 16 + l * 26, y + 16, 22, 10);
      }
      text(maxed ? 'MAX' : cost + ' cr', x0 + w - 16, y + 21, 14, maxed ? '#5be37d' : afford ? '#ffd166' : '#ff5c5c', 'right');
    });
    text(m.ready ? 'READY!' : `Press ${p.readyLabel} when ready`, x0 + w / 2, 520, 18, m.ready ? '#5be37d' : '#8d96c9');
  });
}

function drawOverlayScreens() {
  if (state === 'menu') {
    ctx.fillStyle = '#05060fcc'; ctx.fillRect(0, 0, W, H);
    text('UAV DUEL', W / 2, 140, 64, '#7fd6ff');
    text('Knock down your opponent. First to ' + ROUNDS_TO_WIN + ' round wins takes the match.', W / 2, 200, 18, '#8d96c9');
    PLAYERS.forEach((p, i) => {
      const x = i === 0 ? W / 4 : (W * 3) / 4;
      text(p.name, x, 290, 28, p.color);
      text(p.controls, x, 330, 20);
      text(i === 0 ? 'Move: W A S D  ·  Shoot: SPACE' : 'Move: ← ↑ ↓ →  ·  Shoot: ENTER', x, 362, 15, '#8d96c9');
    });
    text('You aim in the direction you last moved.', W / 2, 430, 16, '#8d96c9');
    text('Earn credits each round and spend them on upgrades.   P = pause', W / 2, 456, 16, '#8d96c9');
    if (Math.floor(performance.now() / 500) % 2) text('Press SPACE or ENTER to start', W / 2, 530, 24, '#fff');
  } else if (state === 'countdown') {
    text(String(Math.max(1, 3 - Math.floor(stateTime))), W / 2, H / 2, 120, '#ffffffcc');
    text('Round ' + roundNo, W / 2, H / 2 - 100, 28, '#8d96c9');
  } else if (state === 'playing' && stateTime < 0.8) {
    text('FIGHT!', W / 2, H / 2, 80, '#ffd166');
  } else if (state === 'roundEnd') {
    text(message, W / 2, H / 2, 40, '#fff');
  } else if (state === 'shop') {
    drawShop();
  } else if (state === 'matchEnd') {
    const w = meta[0].wins > meta[1].wins ? 0 : 1;
    ctx.fillStyle = '#05060fdd'; ctx.fillRect(0, 0, W, H);
    text(PLAYERS[w].name + ' WINS!', W / 2, H / 2 - 40, 70, PLAYERS[w].color);
    text(`${meta[0].wins} - ${meta[1].wins}`, W / 2, H / 2 + 30, 36);
    if (stateTime > 1) text('Press SPACE or ENTER for the menu', W / 2, H / 2 + 100, 20, '#8d96c9');
  }
  if (paused) {
    ctx.fillStyle = '#05060fbb'; ctx.fillRect(0, 0, W, H);
    text('PAUSED', W / 2, H / 2, 60);
    text('Press P to resume', W / 2, H / 2 + 50, 18, '#8d96c9');
  }
}

function draw() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground();
  if (state !== 'menu' && state !== 'shop') {
    bullets.forEach(b => {
      ctx.fillStyle = PLAYERS[b.owner].color;
      ctx.shadowColor = PLAYERS[b.owner].color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    });
    uavs.forEach(drawUav);
    particles.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    });
    ctx.globalAlpha = 1;
    drawHud();
  }
  drawOverlayScreens();
  ctx.restore();
}

// ---------- Main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  pressed.clear();
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
