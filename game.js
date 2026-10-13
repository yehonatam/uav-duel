'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;   // screen size
const WW = 2000, WH = 1250;                    // world size (bigger than the screen)
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
    buy: ['Digit1', 'Digit2', 'Digit3', 'Digit4'], buyLabels: ['1', '2', '3', '4'],
    sell: ['KeyQ', 'KeyW', 'KeyE', 'KeyR'], sellLabels: ['Q', 'W', 'E', 'R'], ready: 'Space', readyLabel: 'SPACE',
    weaponKeys: ['Digit5', 'Digit6', 'Digit7'], weaponLabels: ['5', '6', '7'],
    controls: 'WASD + SPACE' },
  { name: 'Player 2', color: '#ffa94d', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Enter',
    buy: ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4'], buyLabels: ['Num1', 'Num2', 'Num3', 'Num4'],
    sell: ['Numpad5', 'Numpad6', 'Numpad7', 'Numpad8'], sellLabels: ['Num5', 'Num6', 'Num7', 'Num8'], ready: 'Enter', readyLabel: 'ENTER',
    weaponKeys: ['Numpad9', 'NumpadDivide', 'NumpadMultiply'], weaponLabels: ['Num9', 'Num/', 'Num*'],
    controls: 'ARROWS + ENTER' },
];

const WEAPONS = [
  { id: 'blaster', name: 'Blaster',   cost: 0,   desc: 'balanced' },
  { id: 'flare',   name: 'Flare Gun', cost: 120, desc: 'huge close dmg' },
  { id: 'rail',    name: 'Rail Gun',  cost: 150, desc: 'long range' },
];

let WALLS = [];
function genWalls() {
  const spawns = [{ x: 150, y: WH / 2 }, { x: WW - 150, y: WH / 2 }];
  const walls = [];
  for (let tries = 0; tries < 400 && walls.length < 14; tries++) {
    const vertical = Math.random() < 0.5;
    const long = 80 + Math.random() * 130, short = 30 + Math.random() * 40;
    const w = vertical ? short : long, h = vertical ? long : short;
    const r = { x: 80 + Math.random() * (WW - 160 - w), y: 80 + Math.random() * (WH - 160 - h), w, h };
    if (spawns.some(sp => circleRect(sp.x, sp.y, 230, r))) continue;
    const g = 70; // keep gaps between walls so drones can always pass
    if (walls.some(o => r.x < o.x + o.w + g && r.x + r.w + g > o.x && r.y < o.y + o.h + g && r.y + r.h + g > o.y)) continue;
    walls.push(r);
  }
  WALLS = walls;
}


// ---------- State ----------
let state = 'menu'; // menu | countdown | playing | roundEnd | shop | matchEnd
let stateTime = 0;
let paused = false;
let shake = 0;
let roundNo = 1;
let message = '';
let uavs = [], bullets = [], particles = [];
const meta = PLAYERS.map(() => ({ wins: 0, credits: 0, levels: { damage: 0, health: 0, speed: 0, rate: 0 }, ready: false,
  owned: { blaster: true }, weapon: 'blaster' }));
const cam = { x: WW / 2, y: WH / 2, zoom: 1 };

function stat(i, id) {
  const u = UPGRADES.find(x => x.id === id);
  return u.base + u.step * meta[i].levels[id];
}

function spawnUavs() {
  uavs = PLAYERS.map((p, i) => {
    const maxHp = stat(i, 'health');
    return {
      i, x: i === 0 ? 150 : WW - 150, y: WH / 2, speed: VMIN,
      angle: i === 0 ? 0 : Math.PI, hp: maxHp, maxHp, cooldown: 0, flash: 0, alive: true, spin: 0, dealt: 0,
    };
  });
  bullets = [];
}

function setState(s) { state = s; stateTime = 0; }

function resetMatch() {
  meta.forEach(m => { m.wins = 0; m.credits = 0; m.ready = false; for (const k in m.levels) m.levels[k] = 0; m.owned = { blaster: true }; m.weapon = 'blaster'; });
  roundNo = 1;
  startRound();
}

function startRound() {
  genWalls();
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
const UAV_R = 9;
const VMIN = 70;          // stall-free cruise speed: drones never hover
const TURN_RADIUS = 55;   // tightest circle at a given speed: turn rate = speed / radius
const ACCEL = 260, DRAG = 150;

const FIRE = {
  blaster: u => [{ spd: 620, life: 1.6, dmg: stat(u.i, 'damage'), cd: stat(u.i, 'rate'), r: 3, angles: [0], falloff: false }],
  flare:   u => [{ spd: 520, life: 0.3, dmg: stat(u.i, 'damage') * 1.1, cd: stat(u.i, 'rate') * 2.2, r: 4, falloff: true,
                   angles: [-0.3, -0.18, -0.06, 0.06, 0.18, 0.3] }],
  rail:    u => [{ spd: 1300, life: 1.2, dmg: stat(u.i, 'damage') * 3, cd: stat(u.i, 'rate') * 2.4, r: 3, angles: [0], falloff: false }],
};

function updateUav(u, dt) {
  const p = PLAYERS[u.i];
  u.spin += dt * 40;
  u.flash = Math.max(0, u.flash - dt);
  u.cooldown = Math.max(0, u.cooldown - dt);
  if (!u.alive) return;

  const dx = (keys.has(p.right) ? 1 : 0) - (keys.has(p.left) ? 1 : 0);
  const dy = (keys.has(p.down) ? 1 : 0) - (keys.has(p.up) ? 1 : 0);
  const input = dx !== 0 || dy !== 0;
  const vmax = stat(u.i, 'speed');

  // steering: rotate toward the wanted heading, limited by the minimum turn radius
  let turned = 0;
  if (input) {
    let diff = Math.atan2(dy, dx) - u.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const maxTurn = (u.speed / TURN_RADIUS) * dt;
    turned = Math.max(-maxTurn, Math.min(maxTurn, diff));
    u.angle += turned;
  }
  // speed physics: thrust while steering, drag back to cruise otherwise, sharp turns bleed speed
  const target = input ? vmax : VMIN;
  const rate = target > u.speed ? ACCEL : DRAG;
  u.speed += Math.max(-rate * dt, Math.min(rate * dt, target - u.speed));
  u.speed -= Math.abs(turned) * u.speed * 0.2;
  u.speed = Math.max(VMIN, Math.min(vmax, u.speed));

  const vx = Math.cos(u.angle) * u.speed, vy = Math.sin(u.angle) * u.speed;
  let hit = false;
  let nx = u.x + vx * dt;
  if (nx < UAV_R || nx > WW - UAV_R || hitsWall(nx, u.y, UAV_R)) { nx = u.x; u.angle = Math.PI - u.angle; hit = true; }
  u.x = nx;
  let ny = u.y + vy * dt;
  if (ny < UAV_R || ny > WH - UAV_R || hitsWall(u.x, ny, UAV_R)) { ny = u.y; u.angle = -u.angle; hit = true; }
  u.y = ny;
  if (hit) u.speed = Math.max(VMIN, u.speed * 0.5);

  if (state === 'playing' && keys.has(p.fire) && u.cooldown === 0) {
    const w = meta[u.i].weapon;
    for (const f of FIRE[w](u)) {
      u.cooldown = f.cd;
      for (const da of f.angles) {
        const a = u.angle + da + (f.falloff ? (Math.random() - 0.5) * 0.06 : 0);
        const sp = f.spd * (f.falloff ? 0.85 + Math.random() * 0.3 : 1);
        bullets.push({ x: u.x + Math.cos(u.angle) * (UAV_R + 4), y: u.y + Math.sin(u.angle) * (UAV_R + 4),
          vx: Math.cos(a) * sp + Math.cos(u.angle) * u.speed, vy: Math.sin(a) * sp + Math.sin(u.angle) * u.speed,
          owner: u.i, dmg: f.dmg, life: f.life, maxLife: f.life, falloff: f.falloff, r: f.r, kind: w });
      }
    }
    if (w === 'flare') beep(240, 0.18, 'sawtooth', 0.06, -150);
    else if (w === 'rail') beep(1000, 0.15, 'sawtooth', 0.05, -700);
    else beep(u.i ? 520 : 680, 0.08, 'square', 0.04, -300);
  }
}

function updateBullets(dt) {
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.x < 0 || b.x > WW || b.y < 0 || b.y > WH || hitsWall(b.x, b.y, 3)) {
      b.life = 0; burst(b.x, b.y, '#8d96c9', 4, 80, 0.25);
      continue;
    }
    const target = uavs[1 - b.owner];
    if (target.alive && Math.hypot(b.x - target.x, b.y - target.y) < UAV_R + b.r) {
      // flare pellets lose damage with distance travelled (full punch only up close)
      const dmg = b.falloff ? b.dmg * (0.3 + 0.7 * (b.life / b.maxLife)) : b.dmg;
      b.life = 0;
      target.hp = Math.max(0, target.hp - dmg);
      target.flash = 0.12;
      uavs[b.owner].dealt += dmg;
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
      p.sell.forEach((code, k) => {
        if (!pressed.has(code)) return;
        const up = UPGRADES[k];
        const lvl = m.levels[up.id];
        if (lvl > 0) { m.credits += upgradeCost(lvl - 1); m.levels[up.id]--; beep(300, 0.12, 'triangle', 0.07, -100); }
        else beep(120, 0.12, 'square', 0.05);
      });
      p.weaponKeys.forEach((code, k) => {
        if (!pressed.has(code)) return;
        const wp = WEAPONS[k];
        if (m.owned[wp.id]) { m.weapon = wp.id; beep(500, 0.08, 'triangle', 0.06, 200); }
        else if (m.credits >= wp.cost) { m.credits -= wp.cost; m.owned[wp.id] = true; m.weapon = wp.id; beep(700, 0.12, 'triangle', 0.07, 400); }
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
const stars = Array.from({ length: 300 }, () => ({ x: Math.random() * WW, y: Math.random() * WH, r: Math.random() * 1.4 + 0.3 }));

function text(str, x, y, size = 20, color = '#e8ecff', align = 'center', weight = '600') {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

function updateCamera(dt) {
  if (!uavs.length) return;
  const [a, b] = uavs;
  const spanX = Math.abs(a.x - b.x) + 300, spanY = Math.abs(a.y - b.y) + 300;
  const zoom = Math.max(0.5, Math.min(1.25, W / spanX, H / spanY));
  const k = Math.min(1, 6 * dt);
  cam.zoom += (zoom - cam.zoom) * k;
  const vw = W / cam.zoom, vh = H / cam.zoom;
  const clampC = (c, v, world) => v >= world ? world / 2 : Math.max(v / 2, Math.min(world - v / 2, c));
  cam.x += (clampC((a.x + b.x) / 2, vw, WW) - cam.x) * k;
  cam.y += (clampC((a.y + b.y) / 2, vh, WH) - cam.y) * k;
}

function drawBackground() {
  ctx.fillStyle = '#0a0d24'; ctx.fillRect(-10, -10, WW + 20, WH + 20);
  ctx.fillStyle = '#ffffff33';
  stars.forEach(s => ctx.fillRect(s.x, s.y, s.r, s.r));
  ctx.strokeStyle = '#ffffff0d'; ctx.lineWidth = 1;
  for (let x = 0; x <= WW; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WH); ctx.stroke(); }
  for (let y = 0; y <= WH; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WW, y); ctx.stroke(); }
  WALLS.forEach(w => {
    ctx.fillStyle = '#1b2254'; ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = '#4a58b8'; ctx.lineWidth = 2; ctx.strokeRect(w.x, w.y, w.w, w.h);
  });
  ctx.strokeStyle = '#7fd6ff66'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, WW, WH);
}

function drawUav(u) {
  if (!u.alive) return;
  const col = u.flash > 0 ? '#ffffff' : PLAYERS[u.i].color;
  ctx.save();
  ctx.translate(u.x, u.y);
  ctx.scale(0.5, 0.5);
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
  const bw = 28, f = u.hp / u.maxHp;
  ctx.fillStyle = '#00000088'; ctx.fillRect(u.x - bw / 2, u.y - 21, bw, 4);
  ctx.fillStyle = f > 0.5 ? '#5be37d' : f > 0.25 ? '#ffd166' : '#ff5c5c';
  ctx.fillRect(u.x - bw / 2, u.y - 21, bw * f, 4);
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
  uavs.forEach((u, i) => {
    const right = i === 1, bx = right ? W - 20 : 20;
    text(WEAPONS.find(w => w.id === meta[i].weapon).name, bx, 76, 14, '#8d96c9', right ? 'right' : 'left');
  });
}

function drawShop() {
  ctx.fillStyle = '#05060fdd'; ctx.fillRect(0, 0, W, H);
  text('UPGRADE BAY', W / 2, 44, 34, '#7fd6ff');
  text(message, W / 2, 80, 18, '#8d96c9');
  PLAYERS.forEach((p, i) => {
    const m = meta[i], x0 = i === 0 ? 40 : W / 2 + 20, w = W / 2 - 60;
    ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.strokeRect(x0, 110, w, 470);
    text(p.name, x0 + w / 2, 140, 24, p.color);
    text('Credits: ' + m.credits, x0 + w / 2, 172, 20, '#ffd166');
    text('Refunds give back the full price', x0 + w / 2, 535, 13, '#8d96c9');
    text('WEAPONS (optional)', x0 + 16, 430, 16, '#7fd6ff', 'left');
    const cw = (w - 32) / 3;
    WEAPONS.forEach((wp, k) => {
      const cx = x0 + 16 + k * cw, owned = m.owned[wp.id], eq = m.weapon === wp.id;
      ctx.strokeStyle = eq ? p.color : '#ffffff22'; ctx.lineWidth = eq ? 2 : 1; ctx.strokeRect(cx, 445, cw - 8, 62);
      text(wp.name, cx + (cw - 8) / 2, 461, 15, '#e8ecff');
      text(wp.desc, cx + (cw - 8) / 2, 477, 11, '#8d96c9');
      const sub = eq ? 'EQUIPPED' : owned ? `[${p.weaponLabels[k]}] equip` : `[${p.weaponLabels[k]}] ${wp.cost} cr`;
      text(sub, cx + (cw - 8) / 2, 494, 12, eq ? '#5be37d' : owned ? '#8d96c9' : m.credits >= wp.cost ? '#ffd166' : '#ff5c5c');
    });
    UPGRADES.forEach((up, k) => {
      const y = 205 + k * 54, lvl = m.levels[up.id], cost = upgradeCost(lvl);
      const maxed = lvl >= up.max, afford = m.credits >= cost;
      text(`${up.label}`, x0 + 16, y, 18, '#e8ecff', 'left');
      text(`[${p.buyLabels[k]}] buy  [${p.sellLabels[k]}] refund`, x0 + 16 + 130, y, 13, '#8d96c9', 'left');
      text(up.fmt(stat(i, up.id)), x0 + w - 16, y, 18, p.color, 'right');
      for (let l = 0; l < up.max; l++) {
        ctx.fillStyle = l < lvl ? p.color : '#ffffff22';
        ctx.fillRect(x0 + 16 + l * 26, y + 16, 22, 10);
      }
      text(maxed ? 'MAX' : cost + ' cr', x0 + w - 16, y + 21, 14, maxed ? '#5be37d' : afford ? '#ffd166' : '#ff5c5c', 'right');
    });
    text(m.ready ? 'READY!' : `Press ${p.readyLabel} when ready`, x0 + w / 2, 560, 18, m.ready ? '#5be37d' : '#8d96c9');
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
    text('Drones always fly forward and turn in a wide arc - steer with your keys, hold to speed up.', W / 2, 430, 16, '#8d96c9');
    text('Earn credits each round to buy upgrades and weapons. The map changes every round.   P = pause', W / 2, 456, 16, '#8d96c9');
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
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);
  drawBackground();
  if (state !== 'menu' && state !== 'shop') {
    bullets.forEach(b => {
      const col = b.kind === 'flare' ? '#ff8a3d' : b.kind === 'rail' ? '#ffffff' : PLAYERS[b.owner].color;
      ctx.fillStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    });
    uavs.forEach(drawUav);
    particles.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    });
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (state !== 'menu' && state !== 'shop') drawHud();
  drawOverlayScreens();
  ctx.restore();
}

// ---------- Main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  updateCamera(dt);
  pressed.clear();
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
