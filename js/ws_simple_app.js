// ============================================================
//  WarSimulation Simple — 画面・操作（PC：マウス／キーボード、スマートフォン：タッチ）
//  描画は既存の render.js（WebGL2）をそのまま使う
// ============================================================
(function () {
  var WS = window.WS, SPEC = WS.SIMPLE_SPEC, M = WS.M4, KIND_NAME = WS.SIMPLE_KIND_NAME;
  var hypot = WS.hypot, clamp = WS.clamp;
  function $(id) { return document.getElementById(id); }
  var canvas = $('view');
  var App = window.SimpleApp = { game: null, phase: 'title', sel: -1, paused: false, pings: [], touch: false, evSeen: 0, lowQ: false };
  App.touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

  function fatal(msg) { $('fatalText').textContent = msg; $('fatal').classList.remove('hidden'); }
  var renderer;
  try { renderer = new WS.Renderer(canvas); }
  catch (e) { fatal('3D表示（WebGL2）を初期化できませんでした: ' + e.message + '\nChrome・Edge・Safari の最新版で開いてください。'); return; }
  renderer.drawSupply = function () {};         // このゲームでは補給地点を使わない
  App.renderer = renderer;

  // ---------------- 効果音 ----------------
  var audio = App.audio = new WS.SimpleAudio();
  function unlockAudio() { audio.unlock(); }
  // iPhoneでは「指を離したとき（touchend・click）」の操作でしか音を出し始められないので、両方で試す
  ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(function (t) { document.addEventListener(t, unlockAudio, true); });
  function sfx(name) { audio.play(name); }
  // 戦場の音：カメラから見た位置で左右に振り分け、画面の中心から遠い音・引いて見ているときの音は小さく
  function battleSfx(name, x, z, team) {
    if (App.phase !== 'battle' || App.paused) return;
    if (name === 'kingFlee') { audio.play(team === 0 ? 'alarm' : 'bell'); return; }
    if (name === 'wipe') { audio.play(team === 0 ? 'wipeOwn' : 'wipeEnemy'); return; }
    var c = renderer.cam, aspect = Math.max(0.6, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    var half = c.dist * 0.483 * aspect, d = hypot(x - c.tx, z - c.tz);
    var gain = 1 / (1 + Math.pow(d / (c.dist * 0.7), 2)) * clamp(70 / c.dist, 0.5, 1.2);
    if (gain < 0.06) return;
    audio.play(name, { pan: clamp((x - c.tx) / half, -1, 1) * 0.8, gain: gain });
  }
  function syncSoundUi() {
    var on = audio.on, t = '効果音：' + (on ? 'オン' : 'オフ');
    $('btnSound').textContent = on ? '🔊' : '🔇'; $('btnSound').classList.toggle('off', !on);
    $('btnSoundT').textContent = t; $('btnSoundP').textContent = t;
    $('volRange').value = Math.round(audio.vol * 100);
    var st = '効果音の状態：' + audio.status() + (WS.SIMPLE_IOS && on ? '　※音が出ないときは、iPhoneの音量ボタンで音量を上げてください' : '');
    // iPhone：今の表示が「ホーム画面のアプリ（全画面）」か「Safari の中」かを出す（全画面にならないときの確認用）
    var mode = standalone() ? '今の表示：ホーム画面のアプリ（全画面）' : WS.SIMPLE_IOS ? '今の表示：Safari の中（タブやアドレスバーが出る表示）' : '';
    if (mode) st += '\n' + mode;
    Array.prototype.forEach.call(document.querySelectorAll('.sndstat'), function (el) { el.textContent = st; });
    if ($('dispMode')) $('dispMode').textContent = mode;
  }
  ['pointerup', 'touchend', 'click'].forEach(function (t) { document.addEventListener(t, function () { setTimeout(syncSoundUi, 250); }, true); });

  // ---------------- 全画面 ----------------
  // PC・Android：ブラウザの全画面機能。iPhone（Safari は未対応）：「ホーム画面に追加」の手順を案内
  var IPHONE = /iPhone|iPod/.test(navigator.userAgent || '');
  function standalone() { return navigator.standalone === true || (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches)); }
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsCan() { var d = document.documentElement; return !IPHONE && !!(d.requestFullscreen || d.webkitRequestFullscreen); }
  function syncFsUi() {
    var hide = standalone() && !fsCan();
    Array.prototype.forEach.call(document.querySelectorAll('.fsbtn'), function (b) { b.classList.toggle('hidden', hide); b.textContent = fsElement() ? '全画面を終了' : '全画面'; });
  }
  function toggleFullscreen() {
    if (!fsCan()) { overlay('a2hs', true); return; }
    try {
      if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      var d = document.documentElement, p = (d.requestFullscreen || d.webkitRequestFullscreen).call(d);
      var after = function () { try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {} };
      if (p && p.then) p.then(after, fsRefused); else after();
    } catch (e) { fsRefused(); }
  }
  function fsRefused() {   // ブラウザが全画面を許可しなかった（iPhone以外）
    if (WS.SIMPLE_IOS) { overlay('a2hs', true); return; }
    var d = document.createElement('div'); d.className = 'toast'; d.textContent = 'このブラウザでは全画面にできませんでした（PCでは F11 キーでも全画面にできます）';
    $('toasts').appendChild(d); setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 4000);
  }
  $('btnFullT').onclick = toggleFullscreen; $('btnFullP').onclick = toggleFullscreen;
  $('btnA2hsClose').onclick = function () { overlay('a2hs', false); };
  document.addEventListener('fullscreenchange', syncFsUi); document.addEventListener('webkitfullscreenchange', syncFsUi);
  syncFsUi();
  // インターネット上（https：GitHub Pages など）で公開しているときは、PCのサーバーを使う案内を出さない
  if (location.protocol === 'https:') Array.prototype.forEach.call(document.querySelectorAll('.lanonly'), function (el) { el.style.display = 'none'; });
  // ホーム画面に追加したときのアプリ情報（file:// で開いたときは読み込まない：エラーになるため）
  if (/^https?:$/.test(location.protocol)) { var ml = document.createElement('link'); ml.rel = 'manifest'; ml.href = 'manifest.json'; document.head.appendChild(ml); }
  function toggleSound() { audio.unlock(); audio.setOn(!audio.on); syncSoundUi(); if (audio.on) sfx('select'); }
  $('btnSound').onclick = toggleSound; $('btnSoundT').onclick = toggleSound; $('btnSoundP').onclick = toggleSound;
  $('volRange').addEventListener('input', function () { audio.unlock(); audio.setVolume(+this.value / 100); if (!audio.on) { audio.setOn(true); syncSoundUi(); } });
  $('volRange').addEventListener('change', function () { sfx('clash'); });
  syncSoundUi();

  // ---------------- 試合の準備 ----------------
  function newGame(keepCamera) {
    App.game = new WS.SimpleGame({ seed: (Math.random() * 1e9) | 0, cpuTeams: [false, true], level: App.level, difficulty: App.diff,
      comps: SPEC.levels[App.level].compose ? [App.myComp, App.enemyComp] : null, terrainSeed: SPEC.levels[App.level].terrain ? App.mapSeed : null });
    // 地面の形はレベル4（丘）だけ違うので、変わったときだけ作り直す
    var tkey = App.game.terrain ? 'map-' + App.game.terrainSeed : 'flat';
    if (App.terrain !== tkey) { renderer.buildTerrain(App.game.sim, false); App.terrain = tkey; App.trees = makeTrees(App.game); }
    App.game.onSfx = battleSfx;
    App.sel = -1; App.pings = []; App.evSeen = 0; App.acc = 0;
    $('toasts').innerHTML = '';
    buildCards(); if (!keepCamera) fitCamera();
  }
  function fitDistance() {   // 両軍の配置（戦場全体）が見える距離
    var a = Math.max(0.6, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    return clamp(Math.max(88, (SPEC.fieldW / 2 + 4) / (0.483 * a)), 60, 150);
  }
  function fitCamera() {
    var c = renderer.cam;
    c.tx = 0; c.tz = 2; c.ty = 0; c.yaw = Math.PI / 2; c.pitch = 0.95;     // 斜め上空から。自軍が左・敵軍が右
    c.dist = App.fitDist = fitDistance();
  }
  function clampCam() {
    var c = renderer.cam, sim = App.game.sim;
    c.dist = clamp(c.dist, 18, Math.max(150, App.fitDist || 150));
    c.tx = clamp(c.tx, -sim.W / 2, sim.W / 2); c.tz = clamp(c.tz, -sim.D / 2, sim.D / 2);   // 戦場の外へ大きく移動しない
  }
  function showHud(on) { ['top', 'cards', 'hint'].forEach(function (id) { $(id).classList.toggle('hidden', !on); }); }
  function overlay(id, on) { $(id).classList.toggle('hidden', !on); }

  function toTitle() {
    App.phase = 'title'; App.paused = false;
    newGame(); showHud(false);
    ['pause', 'result', 'howto', 'countdown', 'compose'].forEach(function (id) { overlay(id, false); });
    overlay('title', true); $('labels').innerHTML = ''; labelPool.length = 0;
    buildLevels();
  }
  function startBattle() {
    newGame();
    ['title', 'pause', 'result', 'howto', 'compose'].forEach(function (id) { overlay(id, false); });
    showHud(true);
    App.phase = 'countdown'; App.cdT = SPEC.countdown; App.paused = false;
    overlay('countdown', true);
    updateHud(true);
  }
  function setPaused(p) {
    if (App.phase !== 'battle' && App.phase !== 'countdown') return;
    App.paused = p; overlay('pause', p);
    if (!p) { overlay('howto', false); App.lastT = performance.now(); }
  }

  // ---------------- 部隊の選択・命令 ----------------
  function select(idx) {
    if (!App.game || idx < 0 || idx >= App.game.nSq || !App.game.alive(0, idx)) return false;
    if (App.sel !== idx) sfx('select');
    App.sel = idx; updateHud(true); return true;
  }
  function command(hit) {
    var g = App.game;
    if (App.phase !== 'battle' || App.paused || App.sel < 0 || !g.alive(0, App.sel)) return false;   // 何も選択していないときは命令にしない
    if (hit.squad && hit.squad.team === 1) {
      if (!g.command(0, App.sel, { type: 'attack', target: hit.squad.idx })) return false;
      App.pings.push({ x: hit.squad.cx, z: hit.squad.cz, t: performance.now(), col: [1, 0.35, 0.2], r: 4, sq: hit.squad });
      sfx('attack');
    } else if (hit.ground) {
      if (!g.command(0, App.sel, { type: 'move', x: hit.ground.x, z: hit.ground.z })) return false;
      var o = g.squads[0][App.sel].order;
      App.pings.push({ x: o.x, z: o.z, t: performance.now(), col: [0.35, 0.8, 1], r: SPEC.arriveR });
      sfx('move');
    } else return false;
    updateHud(true);
    return true;
  }

  // 画面座標 → 地面（平地なので y=0 の平面との交点）
  function planeAt(sx, sy) {
    renderer.updateCamera(canvas.clientWidth, canvas.clientHeight);
    var r = renderer.ray(sx, sy), o = r.o, d = r.d;
    if (d[1] > -1e-4) return null;
    var t = -o[1] / d[1];
    return { x: o[0] + d[0] * t, z: o[2] + d[2] * t };
  }
  // 兵士・部隊の当たり判定（部隊にも選択用の当たり判定を設ける）
  // team を指定するとその軍だけを調べる（乱戦の中の敵を狙いやすくする）
  function pickAt(sx, sy, touch, team) {
    var g = App.game, sim = g.sim, best = null, bd = 1e9, base = touch ? 26 : 15;
    renderer.updateCamera(canvas.clientWidth, canvas.clientHeight);
    for (var i = 0; i < sim.units.length; i++) {
      var u = sim.units[i]; if (!u.alive || (team != null && u.team !== team)) continue;
      var p = renderer.project(u.x, u.y + u.height * 0.5, u.z), p2 = renderer.project(u.x, u.y + u.height, u.z);
      if (!p || !p2) continue;
      var thr = Math.max(base, Math.abs(p.y - p2.y) * 1.1), d = hypot(p.x - sx, p.y - sy);
      if (d < thr && d < bd) { bd = d; best = u; }
    }
    var ground = App.game.terrain ? renderer.groundAt(sim, sx, sy) : planeAt(sx, sy);   // 丘があるときは地面の高さに沿って当たりを取る
    if (best) return { unit: best, squad: g.squads[best.team][best.corps], ground: ground };
    if (!ground) return null;
    var bs = null, bsd = 1e9;
    for (var t = 0; t < 2; t++) for (var k = 0; k < App.game.nSq; k++) {
      var sq = g.squads[t][k]; if (sq.nAlive <= 0 || (team != null && t !== team)) continue;
      var r = 0;
      for (var j = 0; j < sq.units.length; j++) { var v = sq.units[j]; if (v.alive) r = Math.max(r, hypot(v.x - sq.cx, v.z - sq.cz)); }
      r = Math.min(r, 8) + (touch ? 2.2 : 1.4);
      var dd = hypot(ground.x - sq.cx, ground.z - sq.cz);
      if (dd < r && dd < bsd) { bsd = dd; bs = sq; }
    }
    return { squad: bs, ground: ground };
  }
  function onTap(sx, sy) {         // スマートフォン：タップ
    var hit = pickAt(sx, sy, true); if (!hit) return;
    // 部隊を選択中に、選択中の部隊の兵士と敵が重なる乱戦をタップしたときは敵を優先（攻撃命令）
    if (App.sel >= 0 && hit.unit && hit.unit.team === 0 && hit.unit.corps === App.sel) {
      var en = pickAt(sx, sy, true, 1); if (en && en.unit) hit = en;
    }
    if (hit.squad && hit.squad.team === 0) { select(hit.squad.idx); return; }
    command(hit);
  }
  function onLeftClick(sx, sy) {   // PC：左クリック＝選択
    var hit = pickAt(sx, sy, false, 0);
    if (hit && hit.squad) select(hit.squad.idx);
  }
  function onRightClick(sx, sy) {  // PC：右クリック＝移動／攻撃（敵を優先して調べる。味方の上なら地面として扱う）
    var hit = pickAt(sx, sy, false, 1); if (!hit) return;
    command(hit);
  }

  // ---------------- 入力（Pointer Events でマウス・タッチを共通化） ----------------
  var ptrs = {}, gest = null;
  function rel(e) { var b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
  function nPtr() { return Object.keys(ptrs).length; }
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointerdown', function (e) {
    if (!App.game) return;
    if (e.pointerType === 'touch') App.touch = true; else if (e.pointerType === 'mouse') App.touch = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (er) {}
    var p = rel(e);
    ptrs[e.pointerId] = { x: p.x, y: p.y, sx: p.x, sy: p.y, btn: e.button, type: e.pointerType };
    var n = nPtr();
    if (n === 1) gest = { mode: 'press', id: e.pointerId, btn: e.button, type: e.pointerType, sx: p.x, sy: p.y, anchor: null };
    else if (n === 2) startPinch();
    e.preventDefault();
  });
  function pinchInfo() {
    var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]];
    return { span: Math.max(10, hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function startPinch() {
    var pi = pinchInfo();
    gest = { mode: 'pinch', span0: pi.span, dist0: renderer.cam.dist, anchor: planeAt(pi.mx, pi.my) };
  }
  function reanchor(anchor, sx, sy) {
    if (!anchor) return;
    var p = planeAt(sx, sy); if (!p) return;
    renderer.cam.tx += anchor.x - p.x; renderer.cam.tz += anchor.z - p.z; clampCam();
  }
  canvas.addEventListener('pointermove', function (e) {
    var pt = ptrs[e.pointerId]; if (!pt || !gest) return;
    var p = rel(e); pt.x = p.x; pt.y = p.y;
    if (gest.mode === 'pinch' && nPtr() >= 2) {
      var pi = pinchInfo();
      renderer.cam.dist = gest.dist0 * gest.span0 / pi.span; clampCam();
      reanchor(gest.anchor, pi.mx, pi.my);
      return;
    }
    if (gest.mode === 'press' && e.pointerId === gest.id) {
      // タップとドラッグは指（マウス）の移動距離で区別する
      var thr = gest.type === 'touch' ? 12 : 6;
      if (hypot(p.x - gest.sx, p.y - gest.sy) > thr && (gest.type !== 'mouse' || gest.btn === 0)) {
        gest.mode = 'pan'; gest.anchor = planeAt(gest.sx, gest.sy); canvas.classList.add('panning');
      }
    }
    if (gest.mode === 'pan' && e.pointerId === gest.id) reanchor(gest.anchor, p.x, p.y);
  });
  function endPtr(e, cancel) {
    var pt = ptrs[e.pointerId]; if (!pt) return;
    delete ptrs[e.pointerId];
    var n = nPtr();
    if (!gest) return;
    if (gest.mode === 'press' && e.pointerId === gest.id && !cancel) {
      var p = rel(e);
      if (gest.type === 'mouse') { if (gest.btn === 0) onLeftClick(p.x, p.y); else if (gest.btn === 2) onRightClick(p.x, p.y); }
      else onTap(p.x, p.y);
    }
    if (n === 0) { gest = null; canvas.classList.remove('panning'); }
    else if (gest.mode === 'pinch') gest = { mode: 'done' };   // ピンチの後に指が残っても命令にしない
  }
  canvas.addEventListener('pointerup', function (e) { endPtr(e, false); });
  canvas.addEventListener('pointercancel', function (e) { endPtr(e, true); });
  canvas.addEventListener('wheel', function (e) {
    if (!App.game) return;
    e.preventDefault();
    var p = rel(e), anchor = planeAt(p.x, p.y);
    renderer.cam.dist *= Math.exp(clamp(e.deltaY, -200, 200) * 0.0012); clampCam();
    reanchor(anchor, p.x, p.y);
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });   // iOS のページ拡大を防ぐ
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  var keys = {};
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!$('howto').classList.contains('hidden')) { overlay('howto', false); return; }
      if (App.phase === 'battle' || App.phase === 'countdown') setPaused(!App.paused);
      return;
    }
    if (e.key >= '1' && e.key <= '4' && e.key.length === 1) { if (App.phase !== 'title' && App.phase !== 'compose') select(+e.key - 1); return; }
    keys[e.key] = true;
  });
  window.addEventListener('keyup', function (e) { keys[e.key] = false; });
  window.addEventListener('blur', function () { keys = {}; });
  function keyPan(dt) {
    var c = renderer.cam, v = c.dist * 0.9 * dt, dx = 0, dz = 0;
    if (keys.ArrowLeft) dx -= v; if (keys.ArrowRight) dx += v; if (keys.ArrowUp) dz -= v; if (keys.ArrowDown) dz += v;
    if (dx || dz) { c.tx += dx; c.tz += dz; clampCam(); }
  }

  // ---------------- ボタン ----------------
  // ---------------- レベル選択 ----------------
  App.level = 1;
  try { App.level = +localStorage.getItem('wss_level') || 1; } catch (e) {}
  // 難易度（CPUの強さ）。レベルとは別に選ぶ
  App.diff = 'normal';
  try { var sd = localStorage.getItem('wss_diff'); if (SPEC.difficulty[sd]) App.diff = sd; } catch (e) {}
  // ★の記録：「レベル-難易度」ごとの最高の★の数（このブラウザだけに保存）
  function loadStars() { try { return JSON.parse(localStorage.getItem('wss_stars') || '{}') || {}; } catch (e) { return {}; } }
  function starText(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '★' : '<span class="off">★</span>'; return s; }
  function buildLevels() {
    var L = SPEC.levels, stars = loadStars(), h = '';
    $('diffsel').innerHTML = '難易度：' + Object.keys(SPEC.difficulty).map(function (d) {
      return '<button data-d="' + d + '" class="' + (d === App.diff ? 'on' : '') + '">' + SPEC.difficulty[d].name + '</button>';
    }).join('');
    Array.prototype.forEach.call($('diffsel').querySelectorAll('button'), function (b) {
      b.onclick = function () { App.diff = b.getAttribute('data-d'); try { localStorage.setItem('wss_diff', App.diff); } catch (e) {} sfx('select'); buildLevels(); };
    });
    Object.keys(L).forEach(function (k) {
      var lv = L[k], best = stars[k + '-' + App.diff] || 0;
      h += '<button class="lvl' + (+k === App.level ? ' last' : '') + '" data-lv="' + k + '"><span class="lv-name">' + lv.name + '</span><span class="lv-title">' + lv.title +
        ' <span class="lv-stars" title="この難易度での最高の評価">' + starText(best) + '</span></span><span class="lv-desc">' + lv.desc + '</span><span class="lv-go">戦闘開始 ▶</span></button>';
    });
    $('levels').innerHTML = h;
    Array.prototype.forEach.call($('levels').children, function (b) { b.onclick = function () { startLevel(+b.getAttribute('data-lv')); }; });
  }
  function startLevel(lv) {
    App.level = SPEC.levels[lv] ? lv : 1;
    try { localStorage.setItem('wss_level', String(App.level)); } catch (e) {}
    if (SPEC.levels[App.level].compose) { App.enemyPreset = null; openCompose(); return; }    // レベル3・4は編成画面から
    startBattle();
  }

  // ---------------- 部隊編成（レベル3） ----------------
  var PICK = ['infantry', 'archer', 'cavalry', 'none'], DEF_N = { infantry: 10, archer: 10, cavalry: 3 };
  var SHORT = { infantry: '歩兵', archer: '弓兵', cavalry: '騎馬', none: 'なし' };
  function cloneComp(c) { return WS.simpleNormComp(c).map(function (e) { return { kind: e.kind, n: e.n }; }); }
  function loadMyComp() {
    try { var c = JSON.parse(localStorage.getItem('wss_comp') || 'null'); if (WS.simpleCompValid(c)) return cloneComp(c); } catch (e) {}
    return cloneComp(WS.simplePreset('balance').comp);
  }
  function openCompose() {
    if (!App.myComp) App.myComp = loadMyComp();
    if (!App.enemyPreset) {      // 敵の編成（ひな形から1つ）。編成し直すときは同じ敵のまま
      var P = SPEC.presets; App.enemyPreset = P[Math.floor(Math.random() * P.length)];
      App.enemyComp = cloneComp(App.enemyPreset.comp);
      App.mapSeed = newMapSeed();  // 地形（レベル4）も新しく。編成し直す・再戦では同じ地形のまま
    }
    $('btnReroll').classList.toggle('hidden', !SPEC.levels[App.level].terrain);
    $('btnPeek').classList.toggle('hidden', !SPEC.levels[App.level].terrain);
    setPeek(false);
    App.phase = 'compose'; App.paused = false;
    ['title', 'pause', 'result', 'howto', 'countdown'].forEach(function (id) { overlay(id, false); });
    showHud(false); overlay('compose', true);
    renderCompose(true);
  }
  function newMapSeed() { return 1 + Math.floor(Math.random() * 99999); }
  $('btnReroll').onclick = function () { App.mapSeed = newMapSeed(); sfx('select'); renderCompose(false); };
  // 編成画面を一時的に隠して、戦場（地形と両軍の配置）を見回す
  function setPeek(on) {
    $('compose').classList.toggle('peek', on);
    $('btnPeekBack').classList.toggle('hidden', !on); $('peekHint').classList.toggle('hidden', !on);
    if (!on && App.phase === 'compose') fitCamera();
  }
  $('btnPeek').onclick = function () { sfx('select'); setPeek(true); };
  $('btnPeekBack').onclick = function () { sfx('select'); setPeek(false); };
  function cost(e) { return e.kind === 'none' ? 0 : SPEC.cost[e.kind === 'royal' ? 'guard' : e.kind] * e.n; }
  function renderCompose(refit) {
    var c = App.myComp, total = WS.simpleCompCost(c), over = total > SPEC.budget, h = '';
    $('cmpCost').textContent = total; $('cmpBudget').textContent = SPEC.budget;
    $('cmpCost').className = over ? 'over' : '';
    $('cmpBar').style.width = Math.min(100, total / SPEC.budget * 100) + '%'; $('cmpBar').className = over ? 'over' : '';
    c.forEach(function (e, i) {
      var kinds = i === 0 ? '<span class="chip fixed">👑 王＋護衛歩兵</span>' :
        PICK.map(function (k) { return '<button class="chip' + (e.kind === k ? ' on' : '') + '" data-i="' + i + '" data-k="' + k + '">' + SHORT[k] + '</button>'; }).join('');
      var cnt = e.kind === 'none' ? '' : '<button data-i="' + i + '" data-d="-1">−</button><b>' + e.n + '</b><button data-i="' + i + '" data-d="1">＋</button>';
      h += '<div class="crow"><span class="num">' + (i + 1) + '</span><span class="kinds">' + kinds + '</span><span class="cnt">' + cnt + '</span><span class="pts">' + (e.kind === 'none' ? '' : cost(e) + '点') + '</span></div>';
    });
    $('cmpRows').innerHTML = h;
    $('cmpPresets').innerHTML = SPEC.presets.map(function (p) { return '<button class="chip" data-p="' + p.id + '" title="' + p.desc + '">' + p.name + '</button>'; }).join('');
    // 敵の編成
    var ec = App.enemyComp;
    $('enName').textContent = App.enemyPreset.name;
    $('enRows').innerHTML = ec.map(function (e, i) {
      return '<div class="erow' + (e.kind === 'none' ? ' none' : '') + '"><span class="mk enemy"><i>' + (e.kind === 'none' ? '' : KANJI[e.kind]) + '</i></span>第' + (i + 1) + '部隊　' +
        (i === 0 ? '王＋護衛歩兵' : KIND_NAME[e.kind]) + '<b>' + (e.kind === 'none' ? '—' : e.n + '人' + (i === 0 ? '＋王' : '')) + '</b></div>';
    }).join('');
    $('enHint').textContent = counterHint(ec);
    var bad = over || !WS.simpleCompValid(c);
    $('btnCmpGo').disabled = bad; $('btnCmpGo').textContent = over ? '予算オーバー' : bad ? '兵士がいません' : '戦闘開始';
    // 戦場の配置を後ろに表示
    if (!bad) newGame(!refit);
  }
  function counterHint(ec) {
    var n = { infantry: 0, archer: 0, cavalry: 0, guard: 0 };
    ec.forEach(function (e, i) { if (i === 0) n.guard += e.n; else if (e.kind !== 'none') n[e.kind] += e.n; });
    if (n.cavalry >= 6) return '騎馬が多い → 歩兵と盾の護衛を厚くし、弓兵を守ろう';
    if (n.archer >= 18) return '弓兵が多い → 騎馬で弓兵を狩ろう。歩兵だけで近づくと削られる';
    if (n.infantry >= 20) return '歩兵が多い → 弓兵で近づく前に削ろう。騎馬は歩兵に不利';
    if (n.guard >= 15) return '王の守りが堅い → 先に周りの部隊を崩してから王を狙おう';
    return 'バランス型 → 相手の弱いところを騎馬や弓兵で突こう';
  }
  $('cmpRows').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    var i = +b.getAttribute('data-i'), e = App.myComp[i], k = b.getAttribute('data-k'), d = +b.getAttribute('data-d');
    if (k) {
      if (k === e.kind) return;
      e.kind = k;
      if (k === 'none') e.n = 0;
      else {     // 予算に収まる人数で始める
        e.n = Math.min(DEF_N[k], SPEC.maxPerSquad[k]);
        while (e.n > 1 && WS.simpleCompCost(App.myComp) > SPEC.budget) e.n--;
      }
    } else if (d) {
      var nn = e.n + d, mx = SPEC.maxPerSquad[e.kind];
      if (nn < 0 || nn > mx) return;
      if (d > 0 && WS.simpleCompCost(App.myComp) + SPEC.cost[e.kind === 'royal' ? 'guard' : e.kind] > SPEC.budget) { sfx('deny'); return; }   // 予算を超える追加はできない
      e.n = nn;
      if (i > 0 && e.n === 0) e.kind = 'none';
    }
    sfx('tick');
    renderCompose(false);
  });
  $('cmpPresets').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    App.myComp = cloneComp(WS.simplePreset(b.getAttribute('data-p')).comp); sfx('select'); renderCompose(false);
  });
  $('btnCmpBack').onclick = toTitle;
  $('btnCmpGo').onclick = function () {
    if (!WS.simpleCompValid(App.myComp)) return;
    try { localStorage.setItem('wss_comp', JSON.stringify(App.myComp)); } catch (e) {}
    startBattle();
  };
  $('btnRecompose').onclick = openCompose;
  // ★を記録して、これまでの最高を返す
  function saveStars(g, n) {
    var s = loadStars(), key = g.level + '-' + g.difficulty, prev = s[key] || 0;
    if (n > prev) { s[key] = n; try { localStorage.setItem('wss_stars', JSON.stringify(s)); } catch (e) {} }
    return { best: Math.max(n, prev), prev: prev };
  }
  $('btnHowto').onclick = function () { overlay('howto', true); };
  $('btnPauseHowto').onclick = function () { overlay('howto', true); };
  $('btnHowtoClose').onclick = function () { overlay('howto', false); };
  $('btnPause').onclick = function () { setPaused(!App.paused); };
  $('btnResume').onclick = function () { setPaused(false); };
  $('btnQuit').onclick = toTitle;
  $('btnRetry').onclick = startBattle;
  $('btnToTitle').onclick = toTitle;
  // ブラウザが非表示になったら自動で一時停止
  document.addEventListener('visibilitychange', function () { audio.setHidden(document.hidden); if (document.hidden && !App.paused) setPaused(true); });
  // スマートフォンを縦にしたら一時停止（縦画面では回転案内を表示）
  var portraitMQ = window.matchMedia ? matchMedia('(orientation: portrait) and (pointer: coarse)') : null;
  function checkPortrait() { if (portraitMQ && portraitMQ.matches && !App.paused) setPaused(true); }
  if (portraitMQ) { if (portraitMQ.addEventListener) portraitMQ.addEventListener('change', checkPortrait); else if (portraitMQ.addListener) portraitMQ.addListener(checkPortrait); }

  // ---------------- 下部の部隊カード ----------------
  function buildCards() {
    var h = '';
    for (var k = 0; k < App.game.nSq; k++) h += '<div class="card" data-k="' + k + '"><div class="num">' + (k + 1) + '</div><div class="l1"><span class="nm"></span><span class="cnt"></span></div><div class="l2"></div></div>';
    $('cards').innerHTML = h;
    Array.prototype.forEach.call($('cards').children, function (el) {
      el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      el.addEventListener('click', function () { if (App.phase !== 'title') select(+el.getAttribute('data-k')); });
    });
  }
  function orderText(sq) {
    if (sq.n0 === 0) return 'なし';
    if (sq.nAlive <= 0) return '<span class="warn">全滅</span>';
    var o = sq.order, s;
    if (o.type === 'move') s = '<span class="o-move">移動</span>';
    else if (o.type === 'attack') { var ts = App.game.squads[1][o.target]; s = '<span class="o-attack">攻撃：敵' + (o.target + 1) + '（' + KANJI[ts.kind] + '）</span>'; }
    else s = '<span class="o-idle">待機</span>';
    if (sq.retreat && sq.retreat.active) s += ' <span class="warn">王が退避中</span>';
    return s;
  }
  function kingBar(id, k) {
    var el = $(id), hp = k ? Math.max(0, k.hp) : 0, f = hp / SPEC.units.king.hp;
    el.style.width = (f * 100).toFixed(1) + '%';
    el.className = f > 0.6 ? '' : f > 0.3 ? 'mid' : 'low';
    $(id + 'n').textContent = Math.ceil(hp);
  }
  var hudT = 0;
  function updateHud(force) {
    var g = App.game; if (!g) return;
    var sim = g.sim;
    $('aliveB').textContent = sim.aliveCount(0); $('aliveR').textContent = sim.aliveCount(1);
    kingBar('kingB', g.squads[0][0].king); kingBar('kingR', g.squads[1][0].king);
    var tl = App.phase === 'countdown' || App.phase === 'title' ? SPEC.timeLimit : g.timeLeft(), sec = Math.ceil(tl - 1e-6);
    $('clock').textContent = Math.floor(sec / 60) + ':' + ('0' + sec % 60).slice(-2);
    $('clock').classList.toggle('low', sec <= 30);
    if (App.sel >= 0 && !g.alive(0, App.sel)) App.sel = -1;
    var cards = $('cards').children;
    for (var k = 0; k < App.game.nSq; k++) {
      var sq = g.squads[0][k], el = cards[k];
      el.classList.toggle('sel', App.sel === k); el.classList.toggle('dead', sq.nAlive <= 0);
      el.querySelector('.nm').innerHTML = KIND_NAME[sq.kind] + ' <kbd>' + (k + 1) + '</kbd>';
      el.querySelector('.cnt').textContent = sq.nAlive + '/' + sq.n0;
      el.querySelector('.l2').innerHTML = orderText(sq);
    }
    var hint;
    if (App.sel < 0) hint = App.touch ? '味方の兵士か下のカードをタップして部隊を選択' : '味方を左クリック（または数字キー）で部隊を選択';
    else hint = '第' + (App.sel + 1) + '部隊を選択中 — ' + (App.touch ? '地面をタップ：移動　敵をタップ：攻撃' : '右クリック：地面＝移動　敵＝攻撃');
    $('hint').textContent = hint;
  }

  // ---------------- 戦場上の表示 ----------------
  var labelPool = [];
  function label(i, cls, html) {
    var el = labelPool[i];
    if (!el) { el = labelPool[i] = document.createElement('div'); $('labels').appendChild(el); }
    if (el._cls !== cls) { el.className = cls; el._cls = cls; }
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return el;
  }
  var KANJI = { royal: '王', infantry: '歩', archer: '弓', cavalry: '騎' };
  function updateLabels() {
    var g = App.game, sim = g.sim, n = 0, W = canvas.clientWidth, Hh = canvas.clientHeight;
    var selSq = App.sel >= 0 ? g.squads[0][App.sel] : null, tgtIdx = selSq && selSq.order.type === 'attack' ? selSq.order.target : -1;
    for (var t = 0; t < 2; t++) for (var k = 0; k < App.game.nSq; k++) {
      var sq = g.squads[t][k]; if (sq.nAlive <= 0) continue;
      var p = renderer.project(sq.cx, sim.heightAt(sq.cx, sq.cz) + 4.2, sq.cz); if (!p || p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > Hh + 40) continue;
      var el = t === 0 ? label(n++, 'sqm ally' + (App.sel === k ? ' sel' : ''), String(k + 1)) : label(n++, 'sqm enemy' + (tgtIdx === k ? ' tgt' : ''), '<i>' + KANJI[sq.kind] + '</i>');
      el.style.left = p.x.toFixed(1) + 'px'; el.style.top = p.y.toFixed(1) + 'px'; el.style.display = '';
    }
    for (var tm = 0; tm < 2; tm++) {
      var kg = g.squads[tm][0].king; if (!kg || !kg.alive) continue;
      var q = renderer.project(kg.x, kg.y + kg.height + 1.0, kg.z); if (!q) continue;
      var e2 = label(n++, 'crownlbl ' + (tm === 0 ? 'ally' : 'enemy') + (kg.fleeing ? ' flee' : ''), '👑');
      e2.style.left = q.x.toFixed(1) + 'px'; e2.style.top = q.y.toFixed(1) + 'px'; e2.style.display = '';
    }
    // 地形の名前（丘・森）
    if (g.terrain) {
      sim.hills.forEach(function (hl) { var q2 = renderer.project(hl.x, sim.heightAt(hl.x, hl.z) + 0.5, hl.z); if (!q2) return; var e3 = label(n++, 'terrlbl hill', '▲ 丘'); e3.style.left = q2.x.toFixed(1) + 'px'; e3.style.top = q2.y.toFixed(1) + 'px'; e3.style.display = ''; });
      g.forests.forEach(function (f) { var q3 = renderer.project(f.x, sim.heightAt(f.x, f.z) + 0.3, f.z + f.r * 0.15); if (!q3) return; var e4 = label(n++, 'terrlbl forest', '森'); e4.style.left = q3.x.toFixed(1) + 'px'; e4.style.top = q3.y.toFixed(1) + 'px'; e4.style.display = ''; });
    }
    for (var i = n; i < labelPool.length; i++) if (labelPool[i].style.display !== 'none') labelPool[i].style.display = 'none';
  }
  // 地面の輪（丘の上でも地面の高さに沿わせる）
  function ring(r, x, z, rad, col, w) {
    var segs = Math.max(14, Math.min(40, Math.round(rad * 4))), len = 2 * Math.PI * rad / segs * 1.08, sim = App.game.sim;
    for (var i = 0; i < segs; i++) {
      var a = (i + 0.5) / segs * Math.PI * 2, px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
      r.push('box', M.trs(px, sim.heightAt(px, pz) + 0.14, pz, -(a + Math.PI / 2), 0, 0, len, 0.06, w || 0.35), col[0], col[1], col[2], true);
    }
  }
  // 森の木（見た目だけ。兵士が見えるよう、まばらで低めの木にする）
  function makeTrees(g) {
    var out = [];
    g.forests.forEach(function (f, fi) {
      var seed = 17 + fi * 101, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (var gx = -f.r; gx <= f.r; gx += 4.2) for (var gz = -f.r; gz <= f.r; gz += 4.2) {
        var x = f.x + gx + (rnd() - 0.5) * 2.4, z = f.z + gz + (rnd() - 0.5) * 2.4;
        if ((x - f.x) * (x - f.x) + (z - f.z) * (z - f.z) > (f.r - 0.8) * (f.r - 0.8)) continue;
        out.push({ x: x, z: z, y: g.sim.heightAt(x, z), h: 3.6 + rnd() * 1.4, cr: 0.9 + rnd() * 0.4, tint: rnd() * 0.08 });
      }
    });
    return out;
  }
  function drawTerrain(r, sim) {
    var g = App.game; if (!g.terrain) return;
    // 丘の等高線（高さ1mごと。真上に近い視点でも高さが分かるように）
    sim.hills.forEach(function (hl) {
      for (var lv = 1; lv < hl.h; lv++) { var rad = hl.r * Math.sqrt(Math.log(hl.h / lv)); if (rad > 0.8) ring(r, hl.x, hl.z, rad, lv % 2 ? [0.78, 0.68, 0.42] : [0.9, 0.82, 0.55], 0.16); }
    });
    g.forests.forEach(function (f) { r.push('cyl', M.trs(f.x, sim.heightAt(f.x, f.z) + 0.04, f.z, 0, 0, 0, f.r * 2, 0.04, f.r * 2), 0.2, 0.36, 0.16, true); });   // 森の地面
    (App.trees || []).forEach(function (t) {
      r.push('cyl', M.trs(t.x, t.y + t.h * 0.3, t.z, 0, 0, 0, 0.3, t.h * 0.6, 0.3), 0.38, 0.25, 0.13);
      r.push('cone', M.trs(t.x, t.y + t.h * 0.72, t.z, 0, 0, 0, t.cr * 2, t.h * 0.62, t.cr * 2), 0.13 + t.tint, 0.42 + t.tint, 0.17);
    });
  }
  function squadRadius(sq) { var r = 0; for (var j = 0; j < sq.units.length; j++) { var v = sq.units[j]; if (v.alive) r = Math.max(r, hypot(v.x - sq.cx, v.z - sq.cz)); } return Math.min(r, 10) + 1.5; }
  function overlayDraw(r, sim, now) {
    var g = App.game;
    drawTerrain(r, sim);
    for (var k = 0; k < App.game.nSq; k++) {
      var sq = g.squads[0][k]; if (sq.nAlive <= 0) continue;
      var on = App.sel === k, o = sq.order;
      if (on) ring(r, sq.cx, sq.cz, squadRadius(sq), [1, 0.88, 0.25], 0.3);
      if (o.type === 'move') {
        var cb = on ? [0.35, 0.85, 1] : [0.3, 0.5, 0.85];
        if (hypot(o.x - sq.cx, o.z - sq.cz) > 4) r.groundArrow(sim, sq.cx, sq.cz, o.x, o.z, cb, on ? 0.9 : 0.5, !on);
        ring(r, o.x, o.z, SPEC.arriveR, cb, on ? 0.35 : 0.22);
      } else if (o.type === 'attack') {
        var ts = g.squads[1][o.target]; if (ts.nAlive <= 0) continue;
        var cr = on ? [1, 0.38, 0.22] : [0.8, 0.3, 0.25];
        if (hypot(ts.cx - sq.cx, ts.cz - sq.cz) > 5) r.groundArrow(sim, sq.cx, sq.cz, ts.cx, ts.cz, cr, on ? 0.9 : 0.5, !on);
        ring(r, ts.cx, ts.cz, squadRadius(ts), cr, on ? 0.35 : 0.22);
      }
    }
    // 命令した瞬間の目印
    var tnow = performance.now();
    App.pings = App.pings.filter(function (p) {
      var a = (tnow - p.t) / 700; if (a > 1) return false;
      var x = p.sq ? p.sq.cx : p.x, z = p.sq ? p.sq.cz : p.z;
      ring(r, x, z, p.r * (0.6 + a * 0.9), p.col, 0.45 * (1 - a) + 0.1);
      return true;
    });
  }
  function selectedMap() {
    var m = {}, g = App.game; if (App.sel < 0) return m;
    var sq = g.squads[0][App.sel]; for (var i = 0; i < sq.units.length; i++) if (sq.units[i].alive) m[sq.units[i].id] = 1;
    return m;
  }
  function pumpToasts() {
    var ev = App.game.events;
    while (App.evSeen < ev.length) {
      var e = ev[App.evSeen++]; if (e.text === '試合開始') continue;
      var d = document.createElement('div'); d.className = 'toast t' + (e.team === 1 ? 1 : 0); d.textContent = e.text;
      $('toasts').appendChild(d);
      while ($('toasts').children.length > 3) $('toasts').removeChild($('toasts').firstChild);
      (function (el) { setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3500); })(d);
    }
  }
  function showResult() {
    var r = App.game.result; if (!r) return;
    var t = $('resTitle');
    t.textContent = r.winner === 0 ? '勝利' : r.winner === 1 ? '敗北' : '引き分け';
    t.className = r.winner === 0 ? 'win' : r.winner === 1 ? 'lose' : 'draw';
    var g = App.game;
    $('resReason').textContent = SPEC.levels[g.level].name + '（' + SPEC.levels[g.level].title + '）・' + g.diff.name + ' — ' + r.reason;
    // ★の評価：どの条件を満たしたかも表示（負けたときも、次の目標として出す）
    var st = g.stars(), rec = saveStars(g, st.n), conds = ['勝利する', '王のHPを半分以上残して勝つ', '3分以内に勝つ'];
    $('resStars').innerHTML = '<div class="big">' + starText(st.n) + '</div><ul>' + conds.map(function (c, i) {
      return '<li class="' + (st.got[i] ? 'ok' : '') + '">' + (st.got[i] ? '✔ ' : '✖ ') + c + '</li>';
    }).join('') + '</ul>' + (st.n > rec.prev && rec.prev > 0 ? '<div class="best">自己ベストを更新！</div>' : rec.best ? '<div class="best">この難易度の最高：' + rec.best + '個</div>' : '');
    overlay('btnRecompose', !!SPEC.levels[App.game.level].compose);
    var s = Math.round(r.t);
    $('resStats').textContent = '試合時間 ' + Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2) + '　生存：自軍 ' + r.alive[0] + '人・敵軍 ' + r.alive[1] + '人';
    overlay('pause', false); overlay('countdown', false); overlay('result', true);
    sfx(r.winner === 0 ? 'victory' : r.winner === 1 ? 'defeat' : 'draw');
  }
  // 画面サイズ・向きの変更：全体が見える距離を計算し直す
  window.addEventListener('resize', function () {
    if (!App.game) return;
    var c = renderer.cam, old = App.fitDist || c.dist;
    if (App.phase === 'title' || App.phase === 'countdown' || App.phase === 'compose') { fitCamera(); return; }
    App.fitDist = fitDistance(); c.dist = c.dist * App.fitDist / old; clampCam();
  });

  // ---------------- メインループ ----------------
  var fpsAcc = 0, fpsN = 0, fpsSlow = 0;
  App.lastT = performance.now();
  function frame(now) {
    var dt = Math.min(0.1, Math.max(0, (now - App.lastT) / 1000)); App.lastT = now;
    try {
      var g = App.game;
      if (g) {
        if (App.phase === 'countdown' && !App.paused) {
          App.cdT -= dt;
          var cd = $('countdown');
          if (App.cdT > 0) { var cn = Math.ceil(App.cdT); if (cn !== App.lastCd) { App.lastCd = cn; sfx('count'); } cd.textContent = cn; cd.className = ''; }
          else { g.start(); sfx('horn'); App.lastCd = null; App.phase = 'battle'; App.acc = 0; cd.textContent = '開始！'; cd.className = 'go'; setTimeout(function () { if (App.phase !== 'countdown') overlay('countdown', false); }, 700); }
        } else if (App.phase === 'battle' && !App.paused) {
          App.acc += dt; var n = 0;
          while (App.acc >= WS.DT && n < 8 && !g.result) { g.step(); App.acc -= WS.DT; n++; }
          if (n >= 8) App.acc = 0;
          if (g.result) { App.phase = 'over'; updateHud(true); setTimeout(showResult, 1300); }
        }
        keyPan(dt);
        renderer.render(g.sim, { now: now / 1000, selected: selectedMap(), overlay: overlayDraw, markers: [] });
        if (App.phase !== 'title') updateLabels();
        hudT -= dt; if (hudT <= 0 && App.phase !== 'title') { hudT = 0.2; updateHud(); pumpToasts(); }
        // 端末性能が足りないときは表示の解像度を下げる（兵士数・ルールは変えない）
        if (App.phase === 'battle' && !App.paused && !App.lowQ) {
          fpsAcc += dt; fpsN++;
          if (fpsAcc >= 3) { var fps = fpsN / fpsAcc; fpsSlow = fps < 26 ? fpsSlow + 1 : 0; fpsAcc = 0; fpsN = 0; if (fpsSlow >= 2) lowerQuality(); }
        }
      }
    } catch (e) { fatal(e.stack || e.message); return; }
    requestAnimationFrame(frame);
  }
  function lowerQuality() {
    App.lowQ = true;
    try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: function () { return 1; } }); } catch (e) {}
  }

  // テスト・検証用の窓口
  App.api = { select: select, command: command, pickAt: pickAt, onTap: onTap, onLeftClick: onLeftClick, onRightClick: onRightClick, planeAt: planeAt,
    startBattle: startBattle, startLevel: startLevel, toTitle: toTitle, setPaused: setPaused, showResult: showResult,
    project: function (x, y, z) { renderer.updateCamera(canvas.clientWidth, canvas.clientHeight); return renderer.project(x, y, z); },
    skipCountdown: function () { if (App.phase === 'countdown') App.cdT = 0; },
    fastForward: function (sec) { var g = App.game, n = Math.ceil(sec / WS.DT); for (var i = 0; i < n && !g.result; i++) g.step(); } };

  toTitle();
  requestAnimationFrame(frame);
})();
