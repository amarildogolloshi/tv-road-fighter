
/* Road Runner TV – simple Road Fighter–style game for TV remotes
   Controls: Arrow keys | OK/Enter: Boost | Back/Esc: Pause
   Designed for TV browsers: Samsung Tizen, LG webOS, Android TV, Fire TV.
*/

(() => {
  // ---------- Canvas & Scaling ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  // Make canvas focusable so TV remotes send key events to it
  canvas.tabIndex = 0;

  const DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  let viewW = 1920, viewH = 1080;        // Virtual resolution
  let road = { x: 560, w: 800 };         // Road area (centered)
  let scaleX = 1, scaleY = 1;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * DPR);
    canvas.height = Math.floor(rect.height * DPR);

    // Keep a 16:9 virtual layout; scale drawing to canvas
    const aspect = rect.width / rect.height;
    if (aspect >= 16/9) {
      viewH = 1080;
      viewW = Math.round(viewH * aspect);
    } else {
      viewW = 1920;
      viewH = Math.round(viewW / aspect);
    }
    scaleX = canvas.width / viewW;
    scaleY = canvas.height / viewH;

    // Recenter road
    road.w = Math.min(900, Math.max(700, viewW * 0.42));
    road.x = (viewW - road.w) / 2;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- DOM: HUD & Overlays ----------
  const overlay = document.getElementById('overlay');
  const panelMenu = document.getElementById('menu');
  const panelPause = document.getElementById('pause');
  const panelOver  = document.getElementById('gameover');
  const finalStats = document.getElementById('final-stats');
  const fuelEl  = document.getElementById('fuel');
  const speedEl = document.getElementById('speed');
  const distEl  = document.getElementById('distance');
  const livesEl = document.getElementById('lives');

  // ---------- Helpers ----------
  const rnd = (min, max) => Math.random() * (max - min) + min;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const aabb = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // === Vector drawing helpers (for nicer car visuals) ===
  function drawRoundedRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }
  function shade(hex, amt) {
    const n = hex.startsWith('#') ? hex.slice(1) : hex;
    const num = parseInt(n, 16);
    let r = (num >> 16) & 255;
    let g = (num >> 8)  & 255;
    let b = num & 255;
    const pos = amt > 0;
    const factor = Math.abs(amt);
    const mix = pos ? 255 : 0;
    r = Math.round(r + (mix - r) * factor);
    g = Math.round(g + (mix - g) * factor);
    b = Math.round(b + (mix - b) * factor);
    return `rgb(${r},${g},${b})`;
  }
  function drawWheel(ctx, x, y, w, h) {
    ctx.fillStyle = '#20262b';
    drawRoundedRectPath(ctx, x, y, w, h, Math.min(w, h) * 0.3);
    ctx.fill();
    ctx.fillStyle = '#3a424a';
    drawRoundedRectPath(ctx, x + w*0.18, y + h*0.2, w*0.64, h*0.6, Math.min(w, h) * 0.22);
    ctx.fill();
  }

  // ---------- Game State ----------
  const STATE = { MENU: 0, PLAY: 1, PAUSE: 2, OVER: 3 };
  let state = STATE.MENU;

  // Global speed knob (lower = slower)
  const GAME_SPEED = 0.10; // very slow; raise to 0.20–0.50 if you want faster later

  // Traffic density & spacing
  const MAX_CARS = 8;       // hard cap on simultaneous traffic
  const SPAWN_BASE = 1100;  // avg spacing between waves (px)
  const MIN_GAP_Y = 480;    // min vertical gap between cars
  const LANE_SEGMENT = 420; // per-lane segment height to avoid stacking

  // Steering responsiveness (independent of slow motion)
  const STEER_GAIN = 0.25;  // try 0.22–0.30 to taste

  // ----- Crash/slowdown behavior -----
  const CRASH_SLOWDOWN_KMH     = 70;   // how much speed to drop on impact (km/h)
  const CRASH_MIN_SPEED_KMH    = 40;   // never drop below this
  const CRASH_FUEL_LOSS        = 10;   // % fuel lost on impact
  const CRASH_SHAKE_MS         = 250;  // subtle shake duration
  const CRASH_SIDE_PUSH_PX     = 28;   // slight lateral push L/R
  const CRASH_INVULN_MS        = 600;  // brief invulnerability after hit
  const CRASH_TRUCK_MULTIPLIER = 1.4;  // trucks hit harder

  // Initialize to safe defaults (so first frame on menu doesn't crash)
  let player = null;
  let cars = [];
  let slicks = [];
  let fuelCars = [];
  let particles = [];

  let distance = 0;
  let baseSpeed = 0;
  let scroll = 0;
  let fuel = 0;
  let lives = 0;
  let time = 0;
  let difficulty = 1;
  let shakeT = 0;

  function reset() {
    player = {
      x: road.x + road.w * 0.5 - 32,
      y: viewH - 280,
      w: 64, h: 128,
      vx: 0, vy: 0,

      // Cruise-control model values
      speed: 0,            // actual current speed
      targetSpeed: 120,    // what player wants (Up/Down adjust)
      maxSpeed: 200,       // very slow top speed

      // Handling
      accel: 80,
      turn: 7,
      slip: 0,
      boost: 0,
      hurt: 0              // ms of post-hit invulnerability
    };

    cars = [];       // traffic
    slicks = [];     // oil slicks
    fuelCars = [];   // rainbow fuel cars
    particles = [];  // simple effects

    distance = 0;
    baseSpeed = 120; // slower baseline
    scroll = 0;
    fuel = 100;      // percentage
    lives = 3;
    time = 0;
    difficulty = 1;
    shakeT = 0;

    spawnInitial();
    updateHUD();
  }

  function spawnInitial() {
    for (let i = 0; i < 6; i++) spawnCar(-i * 700); // fewer cars pre-populated
  }

  function spawnCar(yOverride) {
    const lanes = 4;
    const laneW = road.w / lanes;

    // Try a few times to find a safe lane & Y
    for (let attempts = 0; attempts < 6; attempts++) {
      const laneIndex = Math.floor(rnd(0, lanes));
      const x = road.x + laneIndex * laneW + laneW * 0.1;
      const w = laneW * 0.8;
      const h = 120;

      // Proposed Y (spawn above the screen unless yOverride provided)
      const baseY = (yOverride ?? -rnd(300, 1000));

      // 1) Global min vertical gap from all cars
      const tooCloseY = cars.some(c => Math.abs(c.y - baseY) < MIN_GAP_Y);
      if (tooCloseY) continue;

      // 2) Per-lane segment anti-stacking
      const seg = Math.floor(baseY / LANE_SEGMENT);
      const laneHasCarInSegment = cars.some(c =>
        Math.floor(c.y / LANE_SEGMENT) === seg && c.laneIndex === laneIndex
      );
      if (laneHasCarInSegment) continue;

      // Types: yellow (0), red (1), blue (2/3), truck (4) — calmer distribution
      const r = Math.random();
      let type = 0;
      if (r < 0.60) type = 0;
      else if (r < 0.78) type = 1;
      else if (r < 0.96) type = 2;
      else type = 4;

      const speed = rnd(90, 150) * (0.80 + (difficulty - 1) * 0.25) * (type === 4 ? 0.70 : 1);

      cars.push({
        x, y: baseY, w, h, type, speed,
        laneIndex, laneTimer: rnd(1.1, 2.6)
      });

      // Oil slicks & fuel cars (rarer)
      if (Math.random() < 0.12) {
        slicks.push({ x: x + rnd(-20, 20), y: baseY + rnd(240, 720), w: w * 0.5, h: 16 });
      }
      if (Math.random() < 0.10) {
        fuelCars.push({ x: x + rnd(-10, 10), y: baseY - rnd(300, 800), w: w * 0.8, h: 24, t: 0 });
      }

      return; // success
    }
    // No safe spot after attempts: skip this spawn
  }

  function spawnWave() {
    const count = 1 + Math.floor(rnd(0, 2)); // 1–2 cars per wave
    for (let i = 0; i < count; i++) {
      const y = -rnd(SPAWN_BASE * 0.7, SPAWN_BASE * 1.3);
      spawnCar(y);
    }
  }

  // ---------- Input ----------
  const input = { left: false, right: false, up: false, down: false, boost: false };

  function handleKey(e, isDown) {
    const k = (e.key || '').toLowerCase();
    const kc = e.keyCode;

    if (k === 'arrowleft'  || kc === 37) input.left  = isDown;
    if (k === 'arrowright' || kc === 39) input.right = isDown;
    if (k === 'arrowup'    || kc === 38) input.up    = isDown;
    if (k === 'arrowdown'  || kc === 40) input.down  = isDown;

    // OK/Enter maps to 13 on many TVs; Space works on desktop
    if (k === 'enter' || kc === 13 || k === 'ok' || k === ' ') input.boost = isDown;

    // Back/Esc to pause
    if (isDown && (kc === 8 || kc === 27)) {
      if (state === STATE.PLAY) pauseGame();
      else if (state === STATE.PAUSE) resumeGame();
      e.preventDefault();
    }
    e.preventDefault(); // avoid scroll on some TV browsers
  }

  canvas.addEventListener('keydown', (e) => {
    if (state === STATE.MENU  && (e.key === 'Enter' || e.keyCode === 13)) { startGame(); return e.preventDefault(); }
    if (state === STATE.OVER  && (e.key === 'Enter' || e.keyCode === 13)) { startGame(); return e.preventDefault(); }
    if (state === STATE.PAUSE && (e.key === 'Enter' || e.keyCode === 13)) { resumeGame(); return e.preventDefault(); }
    handleKey(e, true);
  });
  canvas.addEventListener('keyup', (e) => handleKey(e, false));

  function ensureFocus() {
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
  }
  window.addEventListener('pointerdown', ensureFocus);
  window.addEventListener('click', ensureFocus);
  window.addEventListener('load', () => setTimeout(ensureFocus, 0));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === STATE.PLAY) pauseGame();
  });

  // ---------- State Transitions ----------
  function showOverlay(idToShow) {
    overlay.classList.add('show');
    [panelMenu, panelPause, panelOver].forEach(p => p.classList.add('hidden'));
    idToShow.classList.remove('hidden');
  }
  function hideOverlay() { overlay.classList.remove('show'); }

  function startGame() {
    reset();
    state = STATE.PLAY;
    hideOverlay();
    ensureFocus();
  }
  function pauseGame() {
    state = STATE.PAUSE;
    showOverlay(panelPause);
  }
  function resumeGame() {
    state = STATE.PLAY;
    hideOverlay();
    ensureFocus();
  }
  function gameOver() {
    state = STATE.OVER;
    finalStats.textContent = `Distance: ${Math.floor(distance)} m • Top speed: ${Math.round(topSpeed)} km/h`;
    showOverlay(panelOver);
  }

  // ---------- Draw ----------
  function drawRoad() {
    ctx.save();
    ctx.scale(scaleX, scaleY);

    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.fillStyle = '#15202b';
    ctx.fillRect(road.x, 0, road.w, viewH);

    ctx.strokeStyle = '#cfd8dc';
    ctx.lineWidth = 6;
    ctx.setLineDash([40, 40]);
    const lanes = 4;
    for (let i = 1; i < lanes; i++) {
      const lx = road.x + (road.w / lanes) * i;
      ctx.beginPath();
      ctx.moveTo(lx, (scroll % 80) - 80);
      ctx.lineTo(lx, viewH);
      ctx.stroke();
    }

    ctx.fillStyle = '#546e7a';
    ctx.fillRect(road.x - 12, 0, 12, viewH);
    ctx.fillRect(road.x + road.w, 0, 12, viewH);

    ctx.restore();
  }

  // --- Stylized cars (rounded body, wheels, windows, lights) ---
  function drawCar(c, baseColor, opts = {}) {
    if (!c) return;
    const isPlayer = !!opts.isPlayer;
    const blink    = !!opts.blink;

    const bodyX = c.x, bodyY = c.y, bodyW = c.w, bodyH = c.h;
    const corner = Math.min(bodyW, bodyH) * 0.18;

    const bodyColor = blink ? shade(baseColor, 0.35) : baseColor;
    const shadow    = shade(baseColor, -0.45);
    const highlight = shade(baseColor,  0.25);

    ctx.save();
    ctx.scale(scaleX, scaleY);

    // Wheels (left/right, front/back)
    const wheelW = bodyW * 0.22;
    const wheelH = bodyH * 0.18;
    const wxL = bodyX - wheelW * 0.35;
    const wxR = bodyX + bodyW - wheelW * 0.65;
    const wyF = bodyY + bodyH * 0.12;
    const wyR = bodyY + bodyH * 0.70;
    drawWheel(ctx, wxL, wyF, wheelW, wheelH);
    drawWheel(ctx, wxR, wyF, wheelW, wheelH);
    drawWheel(ctx, wxL, wyR, wheelW, wheelH);
    drawWheel(ctx, wxR, wyR, wheelW, wheelH);

    // Body base
    ctx.fillStyle = bodyColor;
    drawRoundedRectPath(ctx, bodyX, bodyY, bodyW, bodyH, corner);
    ctx.fill();

    // Center stripe
    ctx.fillStyle = shade(baseColor, 0.55);
    ctx.fillRect(bodyX + bodyW * 0.41, bodyY + bodyH * 0.08, bodyW * 0.036, bodyH * 0.84);

    // Roof / cabin
    ctx.fillStyle = highlight;
    const roofX = bodyX + bodyW * 0.14;
    const roofY = bodyY + bodyH * 0.20;
    const roofW = bodyW * 0.72;
    const roofH = bodyH * 0.46;
    drawRoundedRectPath(ctx, roofX, roofY, roofW, roofH, corner * 0.55);
    ctx.fill();

    // Windshield (front)
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    const windX = roofX + bodyW * 0.04;
    const windY = roofY + bodyH * 0.04;
    const windW = roofW - bodyW * 0.08;
    const windH = roofH * 0.42;
    drawRoundedRectPath(ctx, windX, windY, windW, windH, corner * 0.35);
    ctx.fill();

    // Rear window (smaller)
    const rearY = roofY + roofH * 0.56;
    const rearH = roofH * 0.28;
    drawRoundedRectPath(ctx, windX, rearY, windW, rearH, corner * 0.30);
    ctx.fill();

    // Headlights / taillights
    const lightW = bodyW * 0.20, lightH = bodyH * 0.06;
    // Headlights (top/front)
    ctx.fillStyle = isPlayer ? '#ffe082' : '#ffd54f';
    ctx.fillRect(bodyX + bodyW * 0.14, bodyY + bodyH * 0.02, lightW, lightH);
    ctx.fillRect(bodyX + bodyW * 0.66, bodyY + bodyH * 0.02, lightW, lightH);
    // Taillights (bottom/rear)
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(bodyX + bodyW * 0.14, bodyY + bodyH * 0.92, lightW, lightH);
    ctx.fillRect(bodyX + bodyW * 0.66, bodyY + bodyH * 0.92, lightW, lightH);

    // Side skirts shadow
    ctx.fillStyle = shadow;
    ctx.fillRect(bodyX + bodyW * 0.04, bodyY + bodyH * 0.15, bodyW * 0.04, bodyH * 0.70);
    ctx.fillRect(bodyX + bodyW * 0.92, bodyY + bodyH * 0.15, bodyW * 0.04, bodyH * 0.70);

    ctx.restore();
  }

  function drawTruck(c) {
    if (!c) return;
    const baseTrailer = '#8d6e63';
    const cabColor    = '#6d4c41';

    ctx.save();
    ctx.scale(scaleX, scaleY);

    // Sizes
    const trailerH = c.h * 0.68;
    const trailerY = c.y + c.h * 0.08;
    const cabH     = c.h * 0.28;
    const cabY     = c.y + c.h * 0.70;

    // Trailer
    ctx.fillStyle = baseTrailer;
    drawRoundedRectPath(ctx, c.x + c.w * 0.06, trailerY, c.w * 0.88, trailerH, Math.min(c.w, c.h) * 0.12);
    ctx.fill();

    // Rear doors line
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x + c.w * 0.50, trailerY + trailerH * 0.05);
    ctx.lineTo(c.x + c.w * 0.50, trailerY + trailerH * 0.95);
    ctx.stroke();

    // Cab
    ctx.fillStyle = cabColor;
    drawRoundedRectPath(ctx, c.x + c.w * 0.18, cabY, c.w * 0.64, cabH, Math.min(c.w, c.h) * 0.10);
    ctx.fill();

    // Windows on cab
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    drawRoundedRectPath(ctx, c.x + c.w * 0.24, cabY + cabH * 0.18, c.w * 0.52, cabH * 0.52, Math.min(c.w, c.h) * 0.07);
    ctx.fill();

    // Wheels
    const wheelW = c.w * 0.20, wheelH = c.h * 0.15;
    drawWheel(ctx, c.x + c.w * 0.10, trailerY + trailerH * 0.72, wheelW, wheelH);
    drawWheel(ctx, c.x + c.w * 0.70, trailerY + trailerH * 0.72, wheelW, wheelH);
    drawWheel(ctx, c.x + c.w * 0.20, cabY + cabH * 0.05, wheelW, wheelH);
    drawWheel(ctx, c.x + c.w * 0.60, cabY + cabH * 0.05, wheelW, wheelH);

    // Lights
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(c.x + c.w * 0.12, trailerY + trailerH * 0.94, c.w * 0.18, c.h * 0.05);
    ctx.fillRect(c.x + c.w * 0.70, trailerY + trailerH * 0.94, c.w * 0.18, c.h * 0.05);

    ctx.restore();
  }

  // --- Oil slick (glossy, rounded) ---
  function drawSlick(s) {
    if (!s) return;
    ctx.save();
    ctx.scale(scaleX, scaleY);

    const x = s.x, y = s.y, w = s.w, h = s.h;
    const r = Math.min(w, h) * 0.5;

    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0.0, '#1a1a1a');
    g.addColorStop(1.0, '#0f1114');
    ctx.fillStyle = g;
    drawRoundedRectPath(ctx, x, y, w, h, r * 0.6);
    ctx.fill();

    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ffffff';
    drawRoundedRectPath(ctx, x + w * 0.10, y + h * 0.15, w * 0.80, h * 0.30, r * 0.4);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // --- Fuel pickup (rainbow capsule) ---
  function drawFuelCar(f) {
    if (!f) return;
    ctx.save();
    ctx.scale(scaleX, scaleY);

    const x = f.x, y = f.y, w = f.w, h = f.h;
    const r = Math.min(w, h) * 0.5;

    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0.00, '#ff5252');
    grad.addColorStop(0.33, '#ffd54f');
    grad.addColorStop(0.66, '#4dd0e1');
    grad.addColorStop(1.00, '#66bb6a');

    ctx.fillStyle = grad;
    drawRoundedRectPath(ctx, x, y, w, h, r);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
    ctx.stroke();

    ctx.restore();
  }

  function shake(amount) {
    if (shakeT <= 0) return;
    const sx = rnd(-amount, amount) * scaleX;
    const sy = rnd(-amount, amount) * scaleY;
    ctx.translate(sx, sy);
  }

  // ---------- Update ----------
  let last = performance.now();
  let topSpeed = 0;

  function update(dt) {
    time += dt;
    // Difficulty slowly increases (and capped)
    difficulty = Math.min(1.6, 1 + time * 0.006);

    // ===== Cruise-control speed model =====
    const dtSec = dt / 1000;

    // Adjust targetSpeed only when holding Up/Down
    const accelRate = 70;  // km/h per second when holding Up
    const decelRate = 90;  // km/h per second when holding Down
    if (input.up)   player.targetSpeed = Math.min(player.maxSpeed, player.targetSpeed + accelRate * dtSec);
    if (input.down) player.targetSpeed = Math.max(40,               player.targetSpeed - decelRate * dtSec);

    // Small temporary uplift when boosting (not huge)
    const boostFactor = (player.boost > 0 ? 1.06 : 1.0);
    const desired = Math.min(player.maxSpeed, player.targetSpeed * boostFactor);

    // Ease actual speed toward desired at a limited rate (prevents rapid surge)
    const approachPerSec = 60; // km/h per second
    const delta = desired - player.speed;
    const step  = Math.sign(delta) * approachPerSec * dtSec;
    if (Math.abs(delta) <= Math.abs(step)) player.speed = desired;
    else player.speed += step;
    topSpeed = Math.max(topSpeed, player.speed);

    // Base road scroll speed (gentle; boost toned down)
    const scrollSpeed = (baseSpeed + player.speed * 0.16) * (1 + (player.boost > 0 ? 0.08 : 0)) * (dt / 16.666);
    scroll += scrollSpeed;

    // Fuel drain (per ms; already very slow overall due to GAME_SPEED)
    const drain = 0.006 + (player.speed / player.maxSpeed) * 0.010 + (input.boost ? 0.008 : 0);
    fuel = Math.max(0, fuel - drain * dt);
    if (fuel <= 0 && lives > 0) {
      lives--;
      fuel = 60; // refuel partial
      shakeT = 400;
    } else if (fuel <= 0 && lives <= 0) {
      gameOver();
    }

    // Steering (responsive even at GAME_SPEED = 0.10)
    // multiply by (1 / GAME_SPEED) so steering stays snappy.
    let turn = player.turn;
    if (player.slip > 0) turn *= 0.35;
    const steerScale = (STEER_GAIN / Math.max(0.1, GAME_SPEED)) * (1 + player.speed / 300);
    if (input.left)  player.x -= turn * dt * steerScale;
    if (input.right) player.x += turn * dt * steerScale;
    player.x = clamp(player.x, road.x + 8, road.x + road.w - player.w - 8);

    // Boost, slip, and invulnerability timers
    if (input.boost) player.boost = 90; // shorter burst
    if (player.boost > 0) player.boost -= dt;
    if (player.slip  > 0) player.slip  -= dt;
    if (player.hurt  > 0) player.hurt  -= dt;

    // Move world objects downward (simulate forward motion) — toned down heavily
    const worldScroll = (player.speed * dt) * 0.28;
    for (const c of cars) c.y += worldScroll;
    for (const s of slicks) s.y += worldScroll;
    for (const f of fuelCars) f.y += worldScroll;

    // AI for traffic (calmer)
    const lanes = 4;
    const laneW = road.w / lanes;
    for (const c of cars) {
      c.laneTimer -= dt * 0.001;

      if (c.type === 1 && c.laneTimer < 0) { // red: single block (imperfect)
        const targetLane = Math.floor((player.x - road.x) / laneW);
        if (Math.random() < 0.65 && targetLane !== c.laneIndex) {
          c.laneIndex += targetLane > c.laneIndex ? 1 : -1;
          c.x = road.x + c.laneIndex * laneW + laneW * 0.1;
        }
        c.laneTimer = 9999; // only once
      } else if ((c.type === 2 || c.type === 3) && c.laneTimer < 0) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const nextLane = clamp(c.laneIndex + dir, 0, lanes - 1);

        // Avoid switching if another car is close ahead in the target lane
        const blocked = cars.some(o =>
          o !== c && o.laneIndex === nextLane && Math.abs(o.y - c.y) < MIN_GAP_Y * 0.8
        );

        if (!blocked && Math.random() < 0.6) {
          c.laneIndex = nextLane;
          c.x = road.x + c.laneIndex * laneW + laneW * 0.1;
        }
        c.laneTimer = rnd(1.1, 2.4) / Math.sqrt(difficulty); // calmer frequency
      }
    }

    // Despawn & spawn (respect MAX_CARS)
    cars = cars.filter(c => c.y < viewH + 220);
    slicks = slicks.filter(s => s.y < viewH + 60);
    fuelCars = fuelCars.filter(f => f.y < viewH + 60);

    if (cars.length < MAX_CARS) spawnWave();

    // ---- Collisions ----

    // Oil slicks -> short slip
    for (const s of slicks) {
      if (aabb(player, s)) {
        player.slip = 700; // mild skid on oil
      }
    }

    // Fuel pickups
    for (const f of fuelCars) {
      if (aabb(player, f)) {
        fuel = Math.min(100, fuel + 28);
        f.y = viewH + 1000; // remove
      }
    }

    // Traffic collisions -> slow down, don't end the game
    for (const c of cars) {
      if (!aabb(player, c)) continue;

      // If we're in invulnerability window, ignore further hits
      if (player.hurt > 0) continue;

      // Trucks hit harder; others normal
      const hitMult = (c.type === 4) ? CRASH_TRUCK_MULTIPLIER : 1.0;

      // 1) Speed drop (graceful)
      const drop = CRASH_SLOWDOWN_KMH * hitMult;
      const targetAfterHit = Math.max(CRASH_MIN_SPEED_KMH, player.speed - drop);

      // Apply an immediate clamp to *actual* speed…
      player.speed = Math.max(targetAfterHit, CRASH_MIN_SPEED_KMH);

      // …and bring the targetSpeed down too so cruise-control doesn't yank us back up immediately
      player.targetSpeed = Math.max(targetAfterHit, player.targetSpeed - drop * 0.6);

      // 2) Fuel penalty (scaled for trucks)
      fuel = Math.max(0, fuel - CRASH_FUEL_LOSS * hitMult);

      // 3) Feedback: a small shake + lateral nudge + brief "slip"
      shakeT = Math.max(shakeT, CRASH_SHAKE_MS);
      player.slip = Math.max(player.slip, 250);
      player.x += (player.x < c.x ? -CRASH_SIDE_PUSH_PX : CRASH_SIDE_PUSH_PX);

      // 4) Brief invulnerability so we don't chain-hit instantly
      player.hurt = CRASH_INVULN_MS;

      // 5) Keep within road bounds
      player.x = clamp(player.x, road.x + 8, road.x + road.w - player.w - 8);
    }

    // Distance accumulation (very slow)
    distance += (player.speed * dt) * 0.15;

    // Update HUD
    updateHUD();
  }

  function updateHUD() {
    fuelEl.textContent = `Fuel: ${Math.round(fuel)}%`;
    fuelEl.classList.toggle('low', fuel <= 25);
    fuelEl.classList.toggle('warn', fuel > 25 && fuel <= 45);
    speedEl.textContent = `Speed: ${Math.round(player.speed)} km/h`;
    distEl.textContent = `Distance: ${Math.floor(distance)} m`;
    livesEl.textContent = `Lives: ${lives}`;
  }

  // ---------- Main Loop ----------
  function frame(t) {
    const dtRaw = t - last;
    const dt = Math.min(32, dtRaw) * GAME_SPEED; // clamp & scale once
    last = t;

    if (state === STATE.PLAY) update(dt);

    // Render
    ctx.save();
    if (shakeT > 0) { shake(6); shakeT -= dt; }

    drawRoad();

    // Draw oil slicks
    for (const s of slicks) drawSlick(s);

    // Draw fuel cars
    for (const f of fuelCars) drawFuelCar(f);

    // Draw traffic (stylized)
    for (const c of cars) {
      if (c.type === 4) {
        drawTruck(c);
      } else {
        let color = '#f6e05e'; // yellow
        if (c.type === 1) color = '#ff6b6b';              // red
        else if (c.type === 2 || c.type === 3) color = '#64b5f6'; // blue
        drawCar(c, color, { isPlayer: false });
      }
    }

    // Draw player (blink while hurt)
    if (player) {
      const blinking = player.hurt > 0 && ((performance.now() / 50) % 2 | 0) === 0; // 10Hz
      const color = '#66bb6a';
      drawCar(player, color, { isPlayer: true, blink: blinking });
    }

    ctx.restore();
    requestAnimationFrame(frame);
  }

  // ---------- Boot ----------
  showOverlay(panelMenu);
  requestAnimationFrame(frame);

  // Expose for console tweaks on TV dev
  window.__RR = { startGame, pauseGame, resumeGame };

})();
