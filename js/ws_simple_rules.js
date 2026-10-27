// ============================================================
//  WarSimulation Simple — ルール・部隊AI・CPU（描画・画面に依存しない）
//  既存の sim.js（移動・衝突・近接戦闘・矢の物理）と ai.js（兵士の操舵・射撃）を
//  そのまま使い、兵士の「判断」だけを部隊単位の命令に合わせて差し替える。
//  既存ファイルは変更しない（必要な差し替えはこのゲームの Sim インスタンスにだけ行う）。
// ============================================================
(function (G) {
  var WS = G.WS = G.WS || {};
  var clamp = WS.clamp, hypot = WS.hypot, angDiff = WS.angDiff;
  var H = WS.AI._h;

  // ---------------- 仕様書 v1.0 の初期パラメータ ----------------
  var SPEC = WS.SIMPLE_SPEC = {
    fieldW: 120, fieldD: 80,
    timeLimit: 300, countdown: 3,
    // 兵士の能力値（9.1）。range は「攻撃射程」（中心間の距離の目安）
    units: {
      king:     { name: '王',       hp: 200, dmg: 8,  interval: 2.0, speed: 3.8, range: 1.8 },
      guard:    { name: '護衛歩兵', hp: 130, dmg: 9,  interval: 1.8, speed: 3.6, range: 2.0 },
      infantry: { name: '歩兵',     hp: 115, dmg: 10, interval: 1.6, speed: 3.9, range: 2.0 },
      archer:   { name: '弓兵',     hp: 80,  dmg: 8,  interval: 2.5, speed: 4.1, range: 26 },
      // レベル2で追加：少数精鋭の切り札。速く、突撃（速度に応じて威力が増す）で弓兵に強い
      cavalry:  { name: '騎馬兵',   hp: 160, dmg: 12, interval: 1.6, speed: 7.5, range: 2.4, charge: 2.0 }
    },
    // 兵種の相性（攻撃側 → 防御側のダメージ倍率。書いていない組み合わせは1.0）
    // 騎馬 ＞ 弓兵 ＞ 歩兵、護衛（盾）・歩兵 ＞ 騎馬。王の部隊の護衛は騎馬の天敵
    matchup: {
      cavalry: { archer: 1.8, guard: 0.6 },
      guard: { cavalry: 1.6 },
      infantry: { cavalry: 1.3 },
      archer: { infantry: 1.2, cavalry: 0.7 }       // 速く動く騎馬には矢が効きにくい
    },
    // レベル（ルールの段階）。squads は部隊の種類の並び
    levels: {
      1: { name: 'レベル1', title: '基本', squads: ['royal', 'infantry', 'archer'],
           desc: '王・護衛／歩兵／弓兵の3部隊。移動と攻撃の命令だけで戦う' },
      2: { name: 'レベル2', title: '騎馬兵', squads: ['royal', 'infantry', 'archer', 'cavalry'],
           desc: '騎馬兵5体の第4部隊が加わる。騎馬は弓兵に強く、盾の護衛と歩兵に弱い' },
      3: { name: 'レベル3', title: '部隊編成', squads: null, compose: true,
           desc: '予算の中で4部隊の兵種と人数を決める。戦闘前に敵の編成が見える' },
      4: { name: 'レベル4', title: '地形', squads: null, compose: true, terrain: true,
           desc: '丘と森のある戦場で編成して戦う。高所が有利、森は矢が通りにくく騎馬が遅い' }
    },
    // レベル4の地形（左右対称）。丘：x,z,半径r,高さh（既存の高低差の仕組み）。森：円形の範囲
    terrain: {
      hills: [{ x: 0, z: -22, r: 13, h: 5 }, { x: -33, z: 27, r: 8, h: 3 }, { x: 33, z: 27, r: 8, h: 3 }],
      forests: [{ x: 0, z: 25, r: 11 }, { x: -24, z: -28, r: 8 }, { x: 24, z: -28, r: 8 }],
      forestSpeed: { cavalry: 0.5, other: 0.85 },   // 森の中の移動速度の倍率
      arrowBlockPerM: 0.1,                            // 森の中を矢が1m進むごとに枝に当たって止まる割合（10m通ると約6割が止まる）
      canopyH: 7,                                     // この高さより上を飛ぶ矢は枝に当たらない
      heightBonusPerM: 0.08,                          // 高い所からの攻撃：高低差1mあたり +8%（最大+30%）
      heightRangePerM: 0.03                           // 高い所の弓兵：高低差1mあたり射程 +3%
    },
    // 難易度（CPUの指揮の上手さ。兵士の能力値の補正はしない）
    //  interval：CPUの判断の間隔、threatR：自軍の王への脅威に気づく距離、brain：CPUの兵の頭脳（判断の速さ・射撃の予測）
    //  smart：兵種の相性や弱った王を考えて目標を選ぶ、opportunist：手薄な弓兵・敵王の隙を突く
    difficulty: {
      easy:   { name: 'やさしい', interval: 4.0, threatR: 12, brain: 4, smart: false, opportunist: false },
      normal: { name: 'ふつう',   interval: 2.0, threatR: 22, brain: 6, smart: true,  opportunist: true },
      hard:   { name: 'つよい',   interval: 1.0, threatR: 28, brain: 9, smart: true,  opportunist: true }
    },
    // ★の評価：勝利で★1、王のHPを半分以上残して★2、3分以内の勝利で★3
    stars: { kingHp: 0.5, fastWin: 180 },
    // レベル3：予算制の編成。第1部隊は王＋護衛歩兵（人数だけ決める）、第2〜4部隊は兵種1つと人数
    // コストは「体力×毎秒のダメージ」（弓兵は遠くから撃てる分、騎馬は突撃の分を上乗せ）がほぼ釣り合うように決めた
    budget: 300,
    cost: { guard: 6, infantry: 8, archer: 6, cavalry: 17 },
    maxPerSquad: { royal: 16, infantry: 20, archer: 20, cavalry: 10 },
    // 編成のひな形（CPUもこの中から選ぶ。どれも予算内）
    presets: [
      { id: 'balance', name: 'バランス', desc: '全兵種をそろえた標準の編成', comp: [['royal', 12], ['infantry', 12], ['archer', 12], ['cavalry', 3]] },
      { id: 'infantry', name: '歩兵の大軍', desc: '歩兵を2部隊。数で押す', comp: [['royal', 10], ['infantry', 20], ['infantry', 6], ['archer', 5]] },
      { id: 'archer', name: '弓兵重視', desc: '大きな弓兵部隊で遠くから削る', comp: [['royal', 12], ['infantry', 9], ['archer', 20], ['archer', 5]] },
      { id: 'cavalry', name: '騎馬重視', desc: '騎馬7体で弓兵と王を狙う', comp: [['royal', 10], ['infantry', 8], ['cavalry', 7], ['archer', 9]] },
      { id: 'defense', name: '守り重視', desc: '護衛を厚くして王を守り、弓兵で迎え撃つ', comp: [['royal', 16], ['infantry', 13], ['archer', 16], ['none', 0]] }
    ],
    kingFleeSpeed: 4.6,
    // AI・移動（9.2）
    autoEngage: 6,        // 近接兵の自動迎撃開始距離
    idleLeash: 8,         // 待機中の自動追跡範囲（待機位置から）
    arriveR: 3,           // 移動先の到達判定
    spacing: 1.8,         // 部隊の兵士間隔
    lagR: 8,              // 遅れている兵士の判定
    kingDanger: 10, kingSafe: 15, kingSafeTime: 4,
    archerBackoff: 8, archerIdeal: 18, archerMax: 26,
    cpuInterval: 2.0,
    // 技術的な細部（仕様書にない値）
    attackEngageR: 16,    // 攻撃命令：この距離まで部隊でまとまって近づき、そこから各自が相手を選ぶ
    selfDefenseT: 2.5,    // 自衛（一時的な割り込み）の長さ
    cavalryEngageR: 28,   // 騎馬：攻撃命令で各自が突撃を始める距離（助走が要る）
    cavalryAutoEngage: 10, cavalryLeash: 14,   // 騎馬：待機中の自動迎撃（速いので歩兵より少し広い）
    heavyHit: 0.1         // 最大HPのこの割合以上の被弾でよろめく
  };

  var KIND_NAME = { royal: '王・護衛', infantry: '歩兵', archer: '弓兵', cavalry: '騎馬兵', none: 'なし' };
  var KIND_UNITS = { royal: ['guard', 12], infantry: ['infantry', 13], archer: ['archer', 14], cavalry: ['cavalry', 5] };
  var MOUNTED = WS.MOUNTED;
  WS.SIMPLE_KIND_NAME = KIND_NAME;

  // ---------------- 編成（レベル3） ----------------
  // comp：4部隊の [{kind, n}]。第1部隊は royal（n＝護衛歩兵の人数、王は別に1人）。n=0 の部隊は kind 'none'
  function normComp(c) {
    return c.map(function (e, i) {
      var kind = Array.isArray(e) ? e[0] : e.kind, n = Math.round(+(Array.isArray(e) ? e[1] : e.n) || 0);
      if (i === 0) kind = 'royal';
      else if (kind === 'royal' || !SPEC.maxPerSquad[kind] || n <= 0) kind = 'none';
      if (n < 0) n = 0;
      if (kind === 'none') n = 0;
      return { kind: kind, n: n };
    });
  }
  WS.simpleCompCost = function (comp) {
    var c = 0; normComp(comp).forEach(function (e) { if (e.kind !== 'none') c += SPEC.cost[e.kind === 'royal' ? 'guard' : e.kind] * e.n; });
    return c;
  };
  WS.simpleCompValid = function (comp) {
    if (!comp || comp.length !== 4) return false;
    var cc = normComp(comp), ok = true, soldiers = 0;
    cc.forEach(function (e) { if (e.kind !== 'none') { if (e.n < 0 || e.n > SPEC.maxPerSquad[e.kind]) ok = false; soldiers += e.n; } });
    return ok && soldiers > 0 && WS.simpleCompCost(cc) <= SPEC.budget;
  };
  WS.simplePreset = function (id) { for (var i = 0; i < SPEC.presets.length; i++) if (SPEC.presets[i].id === id) return SPEC.presets[i]; return SPEC.presets[0]; };
  WS.simpleNormComp = normComp;
  // ---------------- 地形のランダム生成（レベル4） ----------------
  // 同じ番号（seed）なら同じ地形。左右対称（x=0 の線で鏡写し）なので、どちらの軍にも有利・不利がない
  // ・中央の線上に1つ（丘か森）＋左右対称の組を2〜3組（丘か森）
  // ・森は開始位置に重ならない。丘も開始位置の真上には置かない（すそ野はかかってよい）。丘と森は重ねない
  var SPAWN_PTS = (function () {
    var p = [[50, 0], [30, 0], [41, 0], [30, 14], [30, -14], [41, 14], [41, -14], [40, 20], [40, -20], [45, 0]], out = [];
    p.forEach(function (q) { out.push({ x: q[0], z: q[1] }, { x: -q[0], z: q[1] }); });
    return out;
  })();
  WS.simpleTerrainGen = function (seed) {
    var r = new WS.RNG(((seed >>> 0) * 7919 + 13) >>> 0), hills = [], forests = [];
    var near = function (x, z, list, pad) { for (var i = 0; i < list.length; i++) { var o = list[i]; if (hypot(x - o.x, z - o.z) < pad(o)) return true; } return false; };
    function ok(kind, x, z, rad) {
      if (Math.abs(z) + rad * 0.6 > SPEC.fieldD / 2 - 2 || Math.abs(x) + rad * 0.6 > SPEC.fieldW / 2 - 4) return false;
      if (kind === 'forest' && near(x, z, SPAWN_PTS, function () { return rad + 5; })) return false;
      if (kind === 'hill' && near(x, z, SPAWN_PTS, function () { return rad * 0.8 + 3; })) return false;
      if (near(x, z, hills, function (o) { return o.r * 0.9 + rad * 0.9; })) return false;
      if (near(x, z, forests, function (o) { return o.r + rad * 0.9 + 2; })) return false;
      return true;
    }
    function add(kind, x, z, rad, h) {
      var mirror = Math.abs(x) > 0.01, list = kind === 'hill' ? hills : forests;
      var o = kind === 'hill' ? { x: x, z: z, r: rad, h: h } : { x: x, z: z, r: rad };
      list.push(o); if (mirror) { var m = WS.deepClone(o); m.x = -x; list.push(m); }
    }
    function tryPlace(kind, center) {
      for (var t = 0; t < 60; t++) {
        var rad = kind === 'hill' ? r.range(7, 13) : r.range(6, 11), h = r.range(2.5, 5.5);
        var x = center ? 0 : r.range(rad * 0.9 + 1, 36), z = r.range(-32, 32);
        if (!ok(kind, x, z, rad) || (!center && !ok(kind, -x, z, rad))) continue;
        add(kind, x, z, rad, h); return true;
      }
      return false;
    }
    tryPlace(r.chance(0.5) ? 'hill' : 'forest', true);
    var pairs = 2 + (r.chance(0.5) ? 1 : 0);
    for (var i = 0; i < pairs; i++) tryPlace(r.chance(0.5) ? 'hill' : 'forest', false);
    if (!hills.length) tryPlace('hill', false) || tryPlace('hill', true);       // 丘と森は少なくとも1つずつ
    if (!forests.length) tryPlace('forest', false) || tryPlace('forest', true);
    return { seed: seed, hills: hills, forests: forests };
  };
  WS.SIMPLE_SPAWN_PTS = SPAWN_PTS;

  function levelComp(level) { return SPEC.levels[level].squads.map(function (k) { return { kind: k, n: KIND_UNITS[k][1] }; }); }

  // ---------------- 設定（既存の config.js の構造を使う） ----------------
  WS.simpleConfig = function () {
    var U = SPEC.units, B = WS.DEFAULT_CONFIG.units, units = {};
    ['king', 'guard', 'infantry', 'archer', 'cavalry'].forEach(function (t) {
      var s = U[t], b = B[t];
      units[t] = { name: s.name, hp: s.hp, atk: s.dmg, armor: 1, speed: s.speed, accel: b.accel, turn: b.turn, radius: b.radius, mass: b.mass,
        range: Math.max(0.5, s.range - 0.9),          // sim.js の射程は「体の縁から」なので、中心間の距離から体の半径ぶんを引く
        cooldown: s.interval, windup: b.windup, sight: 40, block: b.block, dodge: b.dodge, charge: 0, narrowPenalty: 0 };
    });
    // 弓兵：近接は既存の短剣（弱い）。矢は無制限、自然な放物線（初速30m/s：26mで発射角は約8°、頂点は1m弱）
    var a = units.archer;
    a.atk = 4; a.range = 0.6; a.cooldown = 1.4;
    a.arrows = 1e9; a.arrowDamage = U.archer.dmg; a.bowRange = SPEC.archerMax; a.minRange = 2.5; a.reload = U.archer.interval;
    a.arrowSpeed = 30; a.baseSpreadDeg = 4.0; a.spreadPerBrainDeg = 0.3; a.refillTime = 1;
    // 騎馬兵：既存の突撃・駆け抜け（ai.js の steerMounted）を使う。突撃の倍率と間隔だけこのゲーム用に
    var c = units.cavalry;
    c.charge = U.cavalry.charge; c.chargeMinSpeed = 4.5; c.chargeCooldown = 4; c.narrowPenalty = 0; c.turn = B.cavalry.turn * 1.2;
    var zero = { infantry: 0, guard: 0, king: 0, archer: 0, cavalry: 0, elephant: 0, chariot: 0 };
    var cfg = WS.mergeConfig(WS.DEFAULT_CONFIG, {
      field: { baseWidth: SPEC.fieldW, baseDepth: SPEC.fieldD, areaScale: 1, hills: false, obstacleDensity: 0, supplyRadius: 0, deployDepth: 0.2 },
      army: { blue: zero, red: zero },
      // 能力値の割り振りは使わない（倍率がすべて1になるようにする）。頭脳は全員6（判断の速さ・射撃の予測）
      stats: { atkBase: 1, atkPerPoint: 0, defPerPoint: 0, blockPerPoint: 0, spdBase: 1, spdPerPoint: 0, dodgePerPoint: 0, cooldownPerPoint: 0,
        defaults: { infantry: [0, 0, 0, 6], guard: [0, 0, 0, 6], king: [0, 0, 0, 6], archer: [0, 0, 0, 6], cavalry: [0, 0, 0, 6] } },
      units: units,
      combat: { damageScale: 1, damageVariance: 0.15, timeLimit: 1e9, stalemateTime: 1e9, corpseTime: 30 },
      morale: { enabled: false },
      ai: { thinkBase: 0.55, thinkPerBrain: 0.02, orderDeviationBase: 0, orderDeviationPerBrain: 0 }
    });
    cfg.matchup = WS.deepClone(SPEC.matchup);     // 既存の相性表は使わず、このゲームの相性に置き換える
    return cfg;
  };

  // ---------------- 隊形 ----------------
  // 3〜4列程度のコンパクトな隊列。f：前方向、s：横方向のずれ
  function gridOffsets(n, sp) {
    var rows = n <= 4 ? 1 : Math.min(4, Math.ceil(n / 5)), cols = Math.ceil(n / rows), out = [];
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / cols), c = i % cols, inRow = Math.min(cols, n - r * cols);
      out.push({ f: ((rows - 1) / 2 - r) * sp, s: (c - (inRow - 1) / 2) * sp });
    }
    return { list: out, back: -((rows - 1) / 2) * sp };
  }

  // ============================================================
  function Game(opts) {
    opts = opts || {};
    this.cfg = WS.simpleConfig();
    this.level = SPEC.levels[opts.level] ? +opts.level : 1;
    if (this.level === 1) this.cfg.matchup = {};      // レベル1は仕様書 v1.0 のまま（兵種の相性なし）
    // 各軍の編成。レベル1・2は固定、レベル3は指定された編成（予算を超えるなど不正なら「バランス」）
    this.comps = [0, 1].map(function (t) {
      if (!SPEC.levels[this.level].compose) return levelComp(this.level);
      var c = opts.comps && opts.comps[t];
      return WS.simpleCompValid(c) ? normComp(c) : normComp(WS.simplePreset('balance').comp);
    }, this);
    this.cpuTeams = opts.cpuTeams || [false, true];
    this.difficulty = SPEC.difficulty[opts.difficulty] ? opts.difficulty : 'normal';
    this.diff = SPEC.difficulty[this.difficulty];
    // 軍ごとの難易度（通常はどちらも同じ。検証で「ふつうのCPU 対 つよいCPU」などを比べるときに軍ごとに指定する）
    this.diffs = [0, 1].map(function (t) { var d = opts.teamDifficulty && opts.teamDifficulty[t]; return SPEC.difficulty[d] || this.diff; }, this);
    var sim = this.sim = new WS.Sim(this.cfg, { seed: opts.seed != null ? opts.seed : 1, mode: 'pvc' });
    sim.obstacles = []; sim.hills = []; sim.buildNav();     // 障害物のない平地
    // レベル4：丘（既存の高低差の仕組み）と森（このゲームの範囲効果）
    var TR = SPEC.terrain;
    this.terrain = !!SPEC.levels[this.level].terrain;
    // terrainSeed を指定すると、その番号のランダムな地形（左右対称）。指定がなければ標準の地形
    this.terrainSeed = this.terrain && opts.terrainSeed != null ? opts.terrainSeed : null;
    var map = !this.terrain ? null : this.terrainSeed != null ? WS.simpleTerrainGen(this.terrainSeed) : { hills: TR.hills, forests: TR.forests };
    this.forests = this.terrain ? WS.deepClone(map.forests) : [];
    if (this.terrain) {
      sim.hills = WS.deepClone(map.hills);
      this.cfg.combat.heightBonusPerM = TR.heightBonusPerM; this.cfg.combat.heightRangeBonusPerM = TR.heightRangePerM;
    }
    sim.squadGame = this; sim.corpsSystem = this;            // 毎フレーム this.update(dt) が呼ばれる
    // このゲームの Sim にだけ行う差し替え
    var game = this;
    sim.maxSpeed = function (u) {
      var v = (u.fleeing ? SPEC.kingFleeSpeed : u.T.speed) * this.spdMult(u);
      if (game.forests.length && game.forestAt(u.x, u.z)) v *= u.type === 'cavalry' ? TR.forestSpeed.cavalry : TR.forestSpeed.other;   // 森の中は遅い
      return v;
    };
    if (this.forests.length) {
      // 森の中を飛ぶ矢は、進んだ距離に応じて枝に当たって止まる（矢の物理は既存のまま）
      var baseArrows = sim.updateArrows;
      sim.updateArrows = function (dt) {
        baseArrows.call(this, dt);
        for (var i = 0; i < this.arrows.length; i++) {
          var a = this.arrows[i]; if (!a.alive) continue;
          if (a.y > this.heightAt(a.x, a.z) + TR.canopyH || !game.forestAt(a.x, a.z)) continue;
          var step = hypot(a.vx, a.vz) * dt;
          if (this.rng.next() < 1 - Math.exp(-TR.arrowBlockPerM * step)) { a.alive = false; a.stuckT = 0; a.inTree = true; this.teamStats[a.team].arrowsMissed++; }
        }
      };
    }
    var baseDamage = sim.applyDamage, self = this;
    sim.applyDamage = function (src, tg, raw, kind, dir) {
      var before = tg.hp, wasAlive = tg.alive;
      baseDamage.call(this, src, tg, raw, kind, dir);
      if (src && src.team === tg.team) return;
      if (wasAlive && !tg.alive) self.sfx('death', tg.x, tg.z, tg.team);
      else if (kind === 'arrow') self.sfx('arrowHit', tg.x, tg.z, tg.team);
      if (tg.alive && before - tg.hp >= tg.maxHp * SPEC.heavyHit) tg.stunT = Math.max(tg.stunT, 0.4);   // 重い被弾：短時間よろめく
    };
    // 効果音のための通知（近接の一撃：防御・回避・突撃・命中、矢の発射）。聞き手（onSfx）がいなければ何もしない
    var baseMelee = sim.meleeHit;
    sim.meleeHit = function (u, tg, isCharge, scale) {
      if (!self.onSfx) return baseMelee.call(this, u, tg, isCharge, scale);
      var b0 = tg.s.blocks, d0 = tg.s.dodges;
      baseMelee.call(this, u, tg, isCharge, scale);
      self.sfx(tg.s.dodges > d0 ? 'dodge' : tg.s.blocks > b0 ? 'block' : isCharge ? 'charge' : u.type === 'archer' ? 'hit' : 'clash', tg.x, tg.z, tg.team);
    };
    var baseFire = sim.fireArrow;
    sim.fireArrow = function (u, vx, vy, vz) { baseFire.call(this, u, vx, vy, vz); self.sfx('shoot', u.x, u.z, u.team); };
    this.onSfx = opts.onSfx || null;
    this.result = null; this.cmdSeq = 0; this.events = [];
    this.squads = [[], []];
    for (var team = 0; team < 2; team++) for (var k = 0; k < this.comps[team].length; k++) this.squads[team].push(this.makeSquad(team, k));
    this.nSq = this.comps[0].length;
    this.cpu = [this.cpuTeams[0] ? new CPU(this, 0) : null, this.cpuTeams[1] ? new CPU(this, 1) : null];
  }
  WS.SimpleGame = Game;
  var P = Game.prototype;

  // 初期配置：自軍は左（-x）、敵軍は右（+x）。左右対称
  // 第1部隊（中央寄りの後方）、第2部隊（前方）、第3部隊（第2部隊より後方）、第4部隊（騎馬：片翼）
  var SPAWN = { royal: { x: -50, z: 0 }, infantry: { x: -30, z: 0 }, archer: { x: -41, z: 0 }, cavalry: { x: -40, z: 20 }, none: { x: -45, z: 0 } };
  // 同じ兵種の部隊が複数あるときは横にずらす（2つ目・3つ目）
  var SPAWN_Z = { infantry: [0, 14, -14], archer: [0, 14, -14], cavalry: [20, -20, 0], royal: [0], none: [0] };
  function spacingOf(kind) { return kind === 'cavalry' ? 2.8 : SPEC.spacing; }     // 馬は体が大きいので間隔を広く
  P.makeSquad = function (team, idx) {
    var sim = this.sim, comp = this.comps[team], e = comp[idx], kind = e.kind, dir = team === 0 ? 1 : -1, same = 0;
    for (var j = 0; j < idx; j++) if (comp[j].kind === kind) same++;
    var sz = SPAWN_Z[kind][Math.min(same, SPAWN_Z[kind].length - 1)];
    var sq = { team: team, idx: idx, kind: kind, name: '第' + (idx + 1) + '部隊', units: [], king: null,
      order: { type: 'idle' }, face: team === 0 ? 0 : Math.PI, ax: SPAWN[kind].x * dir, az: sz, lpx: 0, lpz: 0, nAlive: 0,
      retreat: null, cx: SPAWN[kind].x * dir, cz: sz, spacing: spacingOf(kind) };
    sq.lpx = sq.ax; sq.lpz = sq.az;
    var types = kind === 'none' ? [] : repeat(KIND_UNITS[kind][0], e.n);
    var g = gridOffsets(types.length, sq.spacing);
    for (var i = 0; i < types.length; i++) {
      var p = this.slotXY(sq, g.list[i], sq.ax, sq.az), u = sim.createUnit(team, types[i], p.x, p.z);
      u.corps = idx; u.order = { type: 'squad' }; u.slot = g.list[i]; u.heading = sq.face;
      if (this.cpuTeams[team]) u.st.int = this.diffs[team].brain;      // 難易度：CPUの兵の頭脳
      sq.units.push(u);
    }
    if (kind === 'royal') {
      var ks = { f: g.back - 2.4, s: 0 }, kp = this.slotXY(sq, ks, sq.ax, sq.az);
      var kg = sim.createUnit(team, 'king', kp.x, kp.z);
      kg.corps = idx; kg.order = { type: 'squad' }; kg.slot = ks; kg.heading = sq.face;
      if (this.cpuTeams[team]) kg.st.int = this.diffs[team].brain;
      sq.units.push(kg); sq.king = kg;
    }
    sq.nAlive = sq.units.length; sq.n0 = sq.units.length;
    this.centroid(sq);
    return sq;
  };
  function repeat(v, n) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

  P.slotXY = function (sq, sl, cx, cz) {
    var c = Math.cos(sq.face), s = Math.sin(sq.face);
    return { x: cx + c * sl.f - s * sl.s, z: cz + s * sl.f + c * sl.s };
  };
  P.slotPoint = function (sq, u) {
    var p = this.slotXY(sq, u.slot || { f: 0, s: 0 }, sq.lpx, sq.lpz);
    p.x = clamp(p.x, -this.sim.W / 2 + 1.5, this.sim.W / 2 - 1.5); p.z = clamp(p.z, -this.sim.D / 2 + 1.5, this.sim.D / 2 - 1.5);
    return p;
  };
  P.centroid = function (sq) {
    var x = 0, z = 0, n = 0;
    for (var i = 0; i < sq.units.length; i++) { var u = sq.units[i]; if (u.alive) { x += u.x; z += u.z; n++; } }
    if (n) { sq.cx = x / n; sq.cz = z / n; }
    sq.nAlive = n;
    return n;
  };
  // 生存者で隊形を組み直す（前後・左右の並びを保ち、交差を少なくする）
  P.assignSlots = function (sq) {
    var mem = [], i, k = null;
    for (i = 0; i < sq.units.length; i++) { var u = sq.units[i]; if (!u.alive) continue; if (u.type === 'king') k = u; else mem.push(u); }
    var g = gridOffsets(mem.length, sq.spacing), c = Math.cos(sq.face), s = Math.sin(sq.face);
    var proj = function (u) { var dx = u.x - sq.lpx, dz = u.z - sq.lpz; return { f: dx * c + dz * s, s: -dx * s + dz * c }; };
    mem.sort(function (a, b) { return proj(b).f - proj(a).f; });
    // 行ごとに横方向で並べる
    var slots = g.list.slice(), used = 0;
    while (used < mem.length) {
      var f0 = slots[used].f, j = used; while (j < slots.length && Math.abs(slots[j].f - f0) < 1e-6) j++;
      var row = mem.slice(used, j).sort(function (a, b) { return proj(a).s - proj(b).s; });
      for (var q = 0; q < row.length; q++) row[q].slot = slots[used + q];
      used = j;
    }
    if (k) k.slot = { f: g.back - 2.4, s: 0 };
    sq.slotN = mem.length + (k ? 1 : 0);
  };

  P.alive = function (team, idx) { var sq = this.squads[team][idx]; return sq && sq.nAlive > 0; };
  P.aliveCount = function (team) { return this.sim.aliveCount(team); };
  // 地形の問い合わせ
  P.forestAt = function (x, z) {
    for (var i = 0; i < this.forests.length; i++) { var f = this.forests[i]; if ((x - f.x) * (x - f.x) + (z - f.z) * (z - f.z) < f.r * f.r) return f; }
    return null;
  };
  // 2点を結ぶ線が森の中を通る長さ [m]（弓兵が射線を選ぶため）
  P.forestCover = function (x0, z0, x1, z1) {
    if (!this.forests.length) return 0;
    var L = hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L)), c = 0;
    for (var i = 1; i < n; i++) { var t = i / n; if (this.forestAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) c += L / n; }
    return c;
  };
  // (x,z) の近くで「高く、森でない」場所を探す（高所を取るため）。地形がなければそのまま
  P.highGround = function (x, z, r) {
    if (!this.terrain) return { x: x, z: z };
    var sim = this.sim, best = { x: x, z: z }, bs = -1e9;
    for (var ring = 0; ring <= 2; ring++) for (var a = 0; a < (ring ? 8 : 1); a++) {
      var ang = a / 8 * Math.PI * 2, px = clamp(x + Math.cos(ang) * r * ring / 2, -sim.W / 2 + 3, sim.W / 2 - 3), pz = clamp(z + Math.sin(ang) * r * ring / 2, -sim.D / 2 + 3, sim.D / 2 - 3);
      var s = sim.heightAt(px, pz) * 2 - (this.forestAt(px, pz) ? 4 : 0) - hypot(px - x, pz - z) * 0.08;
      if (s > bs) { bs = s; best = { x: px, z: pz }; }
    }
    return best;
  };
  P.sfx = function (name, x, z, team) { if (this.onSfx) this.onSfx(name, x, z, team); };
  P.ev = function (text, team) { this.events.push({ t: this.sim.t, text: text, team: team }); if (this.events.length > 60) this.events.shift(); };

  // ---------------- 命令（部隊単位） ----------------
  // cmd: { type:'move', x, z } | { type:'attack', target: 敵部隊の番号 0..2 }
  P.command = function (team, idx, cmd) {
    var sim = this.sim, sq = this.squads[team][idx];
    if (!sq || sq.nAlive <= 0 || this.result) return false;
    var o;
    if (cmd.type === 'move') {
      var x = clamp(cmd.x, -sim.W / 2 + 2, sim.W / 2 - 2), z = clamp(cmd.z, -sim.D / 2 + 2, sim.D / 2 - 2);
      o = { type: 'move', x: x, z: z };
      this.centroid(sq); sq.lpx = sq.cx; sq.lpz = sq.cz;
      if (hypot(x - sq.cx, z - sq.cz) > 3) sq.face = Math.atan2(z - sq.cz, x - sq.cx);
    } else if (cmd.type === 'attack') {
      if (!this.alive(1 - team, cmd.target)) return false;
      o = { type: 'attack', target: cmd.target };
      this.centroid(sq); sq.lpx = sq.cx; sq.lpz = sq.cz;
    } else return false;
    o.t = sim.t; o.id = ++this.cmdSeq; o.arrivedT = null;
    sq.order = o;                           // 新しい命令は前の命令を上書きする
    this.assignSlots(sq);
    for (var i = 0; i < sq.units.length; i++) {
      var u = sq.units[i]; if (!u.alive) continue;
      u.ai.sdUntil = 0; u.ai.path = null;
      u.ai.thinkT = Math.min(u.ai.thinkT, 0.05 + 0.2 * sim.rng.next());
    }
    return true;
  };

  // ---------------- 毎フレーム（sim.step から呼ばれる） ----------------
  P.update = function (dt) {
    var sim = this.sim;
    for (var team = 0; team < 2; team++) {
      for (var k = 0; k < this.nSq; k++) {
        var sq = this.squads[team][k], before = sq.nAlive, n = this.centroid(sq);
        if (!n) { if (before) { this.ev((team === 0 ? '自軍' : '敵軍') + 'の' + sq.name + '（' + KIND_NAME[sq.kind] + '）が全滅', team); this.sfx('wipe', sq.cx, sq.cz, team); } sq.order = { type: 'idle' }; continue; }
        if (n !== sq.slotN) this.assignSlots(sq);
        this.updateOrder(sq, dt);
        if (sq.king) this.updateKing(sq, dt);
      }
      if (this.cpu[team]) this.cpu[team].update(dt);
    }
  };

  P.squadSpeed = function (sq) {
    var v = 1e9;
    for (var i = 0; i < sq.units.length; i++) { var u = sq.units[i]; if (u.alive && u.ai.mode !== 'engage' && u.type !== 'king') v = Math.min(v, u.T.speed); }
    if (v > 1e8) v = sq.king ? sq.king.T.speed : 3.6;
    return v;
  };
  // 隊形の位置に近い兵の割合（戦闘中の兵は数えない）
  P.cohesion = function (sq, r) {
    var n = 0, ok = 0;
    for (var i = 0; i < sq.units.length; i++) {
      var u = sq.units[i]; if (!u.alive || u.ai.mode === 'engage' || (u.type === 'king' && u.fleeing)) continue;
      n++; var p = this.slotPoint(sq, u); if (hypot(p.x - u.x, p.z - u.z) < r) ok++;
    }
    return n ? ok / n : 1;
  };
  P.updateOrder = function (sq, dt) {
    var sim = this.sim, o = sq.order;
    if (o.type === 'idle') { sq.lpx = sq.ax; sq.lpz = sq.az; sq.lpMoving = false; return; }
    var tx, tz, stopShort = 0;
    if (o.type === 'move') {
      tx = o.x; tz = o.z;
      var wp = this.detour(sq, tx, tz);       // 敵部隊に進路を塞がれていれば迂回する
      if (wp) { tx = wp.x; tz = wp.z; }
      o.detour = wp;
    }
    else {
      var ts = this.squads[1 - sq.team][o.target];
      if (!ts || ts.nAlive <= 0) {          // 対象が全滅：その付近で待機・防衛へ
        sq.order = { type: 'idle' }; sq.ax = clamp(sq.cx, -sim.W / 2 + 3, sim.W / 2 - 3); sq.az = clamp(sq.cz, -sim.D / 2 + 3, sim.D / 2 - 3);
        sq.lpx = sq.ax; sq.lpz = sq.az; this.assignSlots(sq); return;
      }
      tx = ts.cx; tz = ts.cz; stopShort = sq.kind === 'archer' ? SPEC.archerIdeal : 5;
      var fa = Math.atan2(tz - sq.lpz, tx - sq.lpx); if (Math.abs(angDiff(sq.face, fa)) > 0.5) sq.face = fa;
    }
    // 仮想の部隊中心（lp）を部隊の遅い兵の速さで進める。隊形が崩れていれば待つ
    var dx = tx - sq.lpx, dz = tz - sq.lpz, d = hypot(dx, dz) - stopShort;
    sq.lpMoving = d > 0.05;
    if (d > 0.05) {
      var coh = this.cohesion(sq, 3.5), v = this.squadSpeed(sq) * (coh >= 0.5 ? 0.95 : 0.35);
      // 実際の兵の中心より先へ行きすぎない
      var ahead = (sq.lpx - sq.cx) * dx / (d + stopShort + 1e-6) + (sq.lpz - sq.cz) * dz / (d + stopShort + 1e-6);
      if (ahead > 6) v *= 0.2;
      var stp = Math.min(d, v * dt), L = d + stopShort;
      sq.lpx += dx / L * stp; sq.lpz += dz / L * stp;
    }
    if (o.type === 'move') {
      var fm = Math.atan2(tz - sq.lpz, tx - sq.lpx);
      if (hypot(tx - sq.lpx, tz - sq.lpz) > 3 && Math.abs(angDiff(sq.face, fm)) > 0.35) { sq.face = fm; this.assignSlots(sq); }
      if (hypot(o.x - sq.lpx, o.z - sq.lpz) < 0.1) {
        if (o.arrivedT == null) o.arrivedT = sim.t;
        // 部隊の大半が到着したら待機・防衛へ（遅れている兵は到着後に合流）
        if (this.cohesion(sq, SPEC.arriveR) >= 0.6 || sim.t - o.arrivedT > 8) { sq.order = { type: 'idle' }; sq.ax = o.x; sq.az = o.z; }
      }
    }
  };

  // 部隊の進路（仮想の中心 → 目的地）上にいる敵部隊を避ける経由点。塞がれていなければ null
  P.detour = function (sq, tx, tz) {
    var sim = this.sim, dx = tx - sq.lpx, dz = tz - sq.lpz, L = hypot(dx, dz);
    if (L < 6) return null;
    dx /= L; dz /= L;
    var best = null, bAh = 1e9, E = this.squads[1 - sq.team];
    for (var k = 0; k < E.length; k++) {
      var es = E[k]; if (es.nAlive <= 0) continue;
      var r = 0;
      for (var i = 0; i < es.units.length; i++) { var u = es.units[i]; if (u.alive) r = Math.max(r, hypot(u.x - es.cx, u.z - es.cz)); }
      r = Math.min(r, 12) + 3.5;                                  // 敵部隊の広がり＋余裕
      var rx = es.cx - sq.lpx, rz = es.cz - sq.lpz, ah = rx * dx + rz * dz, lat = -rx * dz + rz * dx;
      if (ah < -2 || ah > L - 2 || Math.abs(lat) > r + 3) continue;   // 進路の前方・目的地の手前にいる敵だけ
      if (hypot(tx - es.cx, tz - es.cz) < r) continue;               // 目的地そのものが敵の中なら迂回しない
      if (ah < bAh) { bAh = ah; best = { es: es, r: r, lat: lat }; }
    }
    if (!best) return null;
    // 敵部隊の横を回る（今いる側を優先。戦場の外になる側は避ける）
    var es2 = best.es, side = best.lat > 0 ? -1 : 1, off = best.r + sq.spacing * 3 + 2;
    var W = sim.W / 2 - 4, D = sim.D / 2 - 4;
    for (var tryN = 0; tryN < 2; tryN++) {
      var px = es2.cx - dz * side * off, pz = es2.cz + dx * side * off;
      if (Math.abs(px) <= W && Math.abs(pz) <= D) return { x: px, z: pz };
      side = -side;
    }
    return null;                                                  // 迂回できない：そのまま進み、塞がれたら一時的に自衛
  };

  // ---------------- 王の緊急退避（6.2 / 6.3） ----------------
  P.updateKing = function (sq, dt) {
    var sim = this.sim, k = sq.king;
    if (!k || !k.alive) { sq.retreat = null; return; }
    var near = this.enemiesNear(k, SPEC.kingSafe + 2), nd = 1e9, cx = 0, cz = 0, nThreat = 0;
    for (var i = 0; i < near.length; i++) {
      var e = near[i]; if (e.d < nd) nd = e.d;
      if (e.d < SPEC.kingSafe) { cx += e.u.x; cz += e.u.z; nThreat++; }
    }
    var R = sq.retreat;
    if (!R || !R.active) {
      if (nd <= SPEC.kingDanger) {
        cx /= nThreat; cz /= nThreat;
        R = sq.retreat = { active: true, t: sim.t, safeT: 0, roles: {}, tx: cx, tz: cz };
        // 足止め地点：王と脅威の間
        R.bx = k.x + (cx - k.x) * 0.45; R.bz = k.z + (cz - k.z) * 0.45;
        // 護衛を足止めと同行に分ける（全員生存なら6人ずつ。少ないときは王への同行を優先）
        var gs = [];
        for (var j = 0; j < sq.units.length; j++) { var g = sq.units[j]; if (g.alive && g.type === 'guard') gs.push(g); }
        gs.sort(function (a, b) { return hypot(a.x - cx, a.z - cz) - hypot(b.x - cx, b.z - cz); });
        var nb = gs.length >= 4 ? Math.floor(gs.length / 2) : gs.length === 3 ? 1 : 0;
        for (var q = 0; q < gs.length; q++) { R.roles[gs[q].id] = q < nb ? 'block' : 'escort'; gs[q].ai.thinkT = Math.min(gs[q].ai.thinkT, 0.05); }
        R.nBlock = nb; R.nEscort = gs.length - nb;
        k.ai.thinkT = 0;
        this.sfx('kingFlee', k.x, k.z, sq.team);
        this.ev((sq.team === 0 ? '自軍' : '敵軍') + 'の王が退避' + (gs.length ? '（足止め ' + nb + '・護衛 ' + (gs.length - nb) + '）' : '（護衛なし）'), sq.team);
      }
      return;
    }
    if (nThreat) { R.tx = cx / nThreat; R.tz = cz / nThreat; }
    if (nd >= SPEC.kingSafe) R.safeT += dt; else R.safeT = 0;
    if (R.safeT >= SPEC.kingSafeTime) {                // 安全を確認：部隊へ再合流（元の命令は保持）
      R.active = false; k.fleeing = false; k.ai.thinkT = 0;
      for (var m = 0; m < sq.units.length; m++) if (sq.units[m].alive) sq.units[m].ai.thinkT = Math.min(sq.units[m].ai.thinkT, 0.1);
      this.ev((sq.team === 0 ? '自軍' : '敵軍') + 'の王が安全を確認し部隊へ戻る', sq.team);
    }
  };
  P.kingRetreating = function (team) { var R = this.squads[team][0].retreat; return !!(R && R.active); };

  // ---------------- 知覚 ----------------
  var NEAR_BUF = [];
  P.enemiesNear = function (u, r) {
    var us = this.sim.queryNear(u.x, u.z, r), out = [];
    for (var i = 0; i < us.length; i++) {
      var v = us[i]; if (!v.alive || v.team === u.team) continue;
      var d = hypot(v.x - u.x, v.z - u.z); if (d <= r) out.push({ u: v, d: d });
    }
    return out;
  };
  function attackersOn(sim, e, team) { return (sim.atkCount && sim.atkCount[team + ':' + e.id]) || 0; }
  // 近接の相手の評価：近さ＋群がりすぎない（分散）＋相手の切り替えすぎ防止
  function meleeScore(sim, u, e, d) {
    var s = -d, n = attackersOn(sim, e, u.team) - (u.ai.targetId === e.id && u.ai.mode === 'engage' ? 1 : 0);
    if (n >= 2) s -= (n - 1) * 3;
    if (u.ai.targetId === e.id) s += 2.5;
    s += (1 - e.hp / e.maxHp) * 2;
    return s + sim.rng.gauss() * 0.4;
  }
  // 進路をふさぐ敵（迂回用）
  function blocker(u, list, gx, gz) {
    var dx = gx - u.x, dz = gz - u.z, L = hypot(dx, dz); if (L < 2) return null;
    dx /= L; dz /= L;
    var best = null, bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var e = list[i].u, rx = e.x - u.x, rz = e.z - u.z, ah = rx * dx + rz * dz, lat = -rx * dz + rz * dx;
      if (ah > 0 && ah < 3.5 && Math.abs(lat) < u.radius + e.radius + 0.6 && ah < bd) { bd = ah; best = { e: e, lat: lat, dx: dx, dz: dz }; }
    }
    return best;
  }
  // 移動が進んでいないか（詰まり）
  function stuck(sim, u) {
    var ai = u.ai;
    if (ai.pT == null || sim.t - ai.pT > 1.2) {
      var moved = ai.pT == null ? 9 : hypot(u.x - ai.pX, u.z - ai.pZ);
      ai.stuckNow = moved < 0.6 && ai.wantSpeed > 0.25;
      ai.pX = u.x; ai.pZ = u.z; ai.pT = sim.t;
    }
    return !!ai.stuckNow;
  }

  // ============================================================
  //  兵士の判断（ai.js の think を置き換え。操舵・攻撃・射撃は ai.js の steer が行う）
  // ============================================================
  P.think = function (u) {
    var sq = this.squads[u.team][u.corps];
    u.ai.dagger = false;
    if (u.type === 'king') return this.thinkKing(u, sq);
    if (u.type === 'archer') return this.thinkArcher(u, sq);
    if (u.type === 'guard' && sq.retreat && sq.retreat.active && sq.king && sq.king.alive) {
      return sq.retreat.roles[u.id] === 'block' ? this.thinkBlocker(u, sq, sq.retreat) : this.thinkEscort(u, sq, sq.retreat);
    }
    return this.thinkFighter(u, sq);
  };
  var baseThink = WS.AI.think;
  WS.AI.think = function (sim, u) { if (sim.squadGame) return sim.squadGame.think(u); return baseThink(sim, u); };

  // 自衛（一時的な割り込み）中なら継続
  P.selfDefense = function (u, maxD) {
    var ai = u.ai, sim = this.sim;
    if (!(ai.sdUntil > sim.t)) return false;
    var e = sim.unitById(ai.sdId);
    if (e && e.alive && hypot(e.x - u.x, e.z - u.z) < maxD) { H.setEngage(u, e); ai.note = '自衛'; return true; }
    ai.sdUntil = 0; return false;
  };
  P.startSelfDefense = function (u, e) { u.ai.sdUntil = this.sim.t + SPEC.selfDefenseT; u.ai.sdId = e.id; H.setEngage(u, e); u.ai.note = '自衛'; };

  // 移動命令中の共通処理：目的地（隊形の位置）へ。進路をふさがれたら迂回、迂回できなければ一時的に自衛
  // 騎馬は向いている方向にしか進めず急には止まれないので、隊形の位置の手前で減速して止まる（その場で回り続けない）
  function mountedSpeed(dist, sp) { return dist < 1.2 ? 0 : dist < 7 ? Math.min(sp, Math.max(0.2, dist / 7)) : sp; }
  P.moveStep = function (u, sq, p, near, mode) {
    var sim = this.sim, ai = u.ai, gx = p.x, gz = p.z, dist = hypot(gx - u.x, gz - u.z);
    var sv = this.squadSpeed(sq), sp = dist > 2.5 ? 1 : clamp(sv / u.T.speed, 0.6, 1);
    if (MOUNTED[u.type]) {
      // 部隊が進んでいる間は、動いている隊形の位置の少し先を狙って同じ速さで走る（手前で減速すると置いていかれる）
      if (sq.lpMoving) { gx += Math.cos(sq.face) * 5; gz += Math.sin(sq.face) * 5; sp = dist > 3 ? 1 : 0.95; }
      else sp = mountedSpeed(dist, dist > 4 ? 1 : sp);
    }
    var blk = blocker(u, near, gx, gz);
    if (blk) {
      if (stuck(sim, u) && hypot(blk.e.x - u.x, blk.e.z - u.z) < u.radius + blk.e.radius + 1.6) { this.startSelfDefense(u, blk.e); return; }
      var side = blk.lat > 0 ? -1 : 1;           // 敵の反対側へよける
      gx = u.x + blk.dx * 3 - blk.dz * side * 2.6; gz = u.z + blk.dz * 3 + blk.dx * side * 2.6;
      sp = 1; ai.note = '迂回';
    } else ai.note = '移動';
    H.setGoal(u, gx, gz, sp, mode || 'move');
  };

  // ---------- 歩兵・護衛歩兵 ----------
  P.thinkFighter = function (u, sq) {
    var sim = this.sim, ai = u.ai, o = sq.order, p = this.slotPoint(sq, u);
    var near = this.enemiesNear(u, 20), i;
    if (this.selfDefense(u, 4)) return;
    if (o.type === 'move') { stuck(sim, u); return this.moveStep(u, sq, p, near); }
    if (o.type === 'attack') {
      var ts = this.squads[1 - u.team][o.target];
      // 別の敵から攻撃されたら自衛し、その後は元の対象へ戻る
      var la = u.lastAttackerId ? sim.unitById(u.lastAttackerId) : null;
      if (la && la.alive && la.corps !== o.target && sim.t - u.lastHitT < 1.5 && hypot(la.x - u.x, la.z - u.z) < 3) { this.startSelfDefense(u, la); return; }
      var best = null, bs = -1e9, nearestD = 1e9;
      for (i = 0; i < ts.units.length; i++) {
        var e = ts.units[i]; if (!e.alive) continue;
        var d = hypot(e.x - u.x, e.z - u.z); if (d < nearestD) nearestD = d;
        var s = meleeScore(sim, u, e, d) - (e.type === 'king' && d > 6 ? 4 : 0);
        if (s > bs) { bs = s; best = e; }
      }
      // 騎馬は助走をつけて突撃するため、遠めから各自で突っ込む
      if (best && (nearestD < (MOUNTED[u.type] ? SPEC.cavalryEngageR : SPEC.attackEngageR) || ai.mode === 'engage')) { H.setEngage(u, best); ai.note = '攻撃（' + ts.name + '）'; return; }
      stuck(sim, u); return this.moveStep(u, sq, p, near);
    }
    // ---- 待機・防衛 ----
    var mounted = !!MOUNTED[u.type], autoR = mounted ? SPEC.cavalryAutoEngage : SPEC.autoEngage, leash = mounted ? SPEC.cavalryLeash : SPEC.idleLeash;
    // 護衛歩兵：王に迫る敵を優先
    if (u.type === 'guard' && sq.king && sq.king.alive) {
      var kb = null, kbd = 1e9;
      for (i = 0; i < near.length; i++) { var kd = hypot(near[i].u.x - sq.king.x, near[i].u.z - sq.king.z); if (kd < SPEC.autoEngage && kd < kbd) { kbd = kd; kb = near[i].u; } }
      if (kb && hypot(u.x - sq.king.x, u.z - sq.king.z) < 12) { H.setEngage(u, kb); ai.note = '王に迫る敵を迎撃'; return; }
    }
    var cur = ai.mode === 'engage' && ai.targetId ? sim.unitById(ai.targetId) : null;
    if (cur && cur.alive && hypot(cur.x - p.x, cur.z - p.z) <= leash + 1 && hypot(cur.x - u.x, cur.z - u.z) < leash + (mounted ? 8 : 2)) { H.setEngage(u, cur); return; }
    var tb = null, tbs = -1e9;
    for (i = 0; i < near.length; i++) {
      var en = near[i];
      var attacking = en.u.id === u.lastAttackerId && sim.t - u.lastHitT < 1.5 && en.d < 3;
      if (!attacking && (en.d > autoR || hypot(en.u.x - p.x, en.u.z - p.z) > leash)) continue;
      var sc = meleeScore(sim, u, en.u, en.d); if (sc > tbs) { tbs = sc; tb = en.u; }
    }
    if (tb) { H.setEngage(u, tb); ai.note = '自動迎撃'; return; }
    // 敵がいなければ待機位置へ戻る（再集合）
    var dd = hypot(p.x - u.x, p.z - u.z), spd = dd > 3 ? 1 : 0.7;
    if (mounted) spd = mountedSpeed(dd, 1);
    H.setGoal(u, p.x, p.z, spd, 'guard'); ai.faceAng = sq.face; ai.note = dd > SPEC.lagR ? '合流中' : '待機';
  };

  // ---------- 護衛：足止め担当 ----------
  P.thinkBlocker = function (u, sq, R) {
    var sim = this.sim, ai = u.ai, k = sq.king, near = this.enemiesNear(u, 18), best = null, bs = -1e9;
    for (var i = 0; i < near.length; i++) {
      var e = near[i].u, db = hypot(e.x - R.bx, e.z - R.bz);
      if (db > SPEC.idleLeash + 2) continue;          // 必要以上に遠くまで追わない
      var s = -hypot(e.x - k.x, e.z - k.z) * 1.0 - near[i].d * 0.5 + (ai.targetId === e.id ? 2 : 0);
      var n = attackersOn(sim, e, u.team); if (n >= 3) s -= (n - 2) * 2;
      if (s > bs) { bs = s; best = e; }
    }
    if (best) { H.setEngage(u, best); ai.note = '足止め'; return; }
    var a = Math.atan2(R.tz - R.bz, R.tx - R.bx), off = ((u.id % 6) - 2.5) * 1.8;
    H.setGoal(u, R.bx - Math.sin(a) * off, R.bz + Math.cos(a) * off, 1, 'guard'); ai.faceAng = a; ai.note = '足止め（待ち構え）';
  };
  // ---------- 護衛：王に同行 ----------
  P.thinkEscort = function (u, sq, R) {
    var sim = this.sim, ai = u.ai, k = sq.king, near = this.enemiesNear(k, 7), best = null, bd = 1e9;
    var myD = hypot(u.x - k.x, u.z - k.z);
    for (var i = 0; i < near.length; i++) if (near[i].d < 5 && near[i].d < bd) { bd = near[i].d; best = near[i].u; }
    if (best && myD < 7) { H.setEngage(u, best); ai.note = '王を護衛（迎撃）'; return; }
    // 王の周り（脅威の側）を固める
    var idx = 0, n = 0;
    for (var j = 0; j < sq.units.length; j++) { var g = sq.units[j]; if (g.alive && g.type === 'guard' && R.roles[g.id] === 'escort') { if (g === u) idx = n; n++; } }
    var ta = Math.atan2(R.tz - k.z, R.tx - k.x), spread = Math.min(Math.PI * 1.7, n * 0.75);
    var a = ta + (n > 1 ? -spread / 2 + spread * idx / (n - 1) : 0);
    var lead = k.fleeing ? 1.2 : 0;                       // 王の進む先を見越す
    var gx = k.x + Math.cos(a) * 2.6 + k.vx * lead, gz = k.z + Math.sin(a) * 2.6 + k.vz * lead;
    H.setGoal(u, gx, gz, 1, 'guard'); ai.faceAng = ta; ai.note = '王に同行';
  };

  // ---------- 王 ----------
  P.thinkKing = function (u, sq) {
    var sim = this.sim, ai = u.ai, R = sq.retreat, near = this.enemiesNear(u, 25), nd = 1e9, ne = null, i;
    for (i = 0; i < near.length; i++) if (near[i].d < nd) { nd = near[i].d; ne = near[i].u; }
    if (R && R.active) {
      u.fleeing = true;
      // 追い詰められた（進めない）ときは反撃
      if (ne && nd < u.radius + ne.radius + 1.3 && stuck(sim, u)) { H.setEngage(u, ne); ai.note = '王が応戦'; return; }
      stuck(sim, u);
      var best = null, bs = -1e9, home = u.team === 0 ? -1 : 1, W = sim.W / 2 - 2.5, D = sim.D / 2 - 2.5;
      for (var a = 0; a < 16; a++) {
        var ang = a / 16 * Math.PI * 2, px = u.x + Math.cos(ang) * 7, pz = u.z + Math.sin(ang) * 7;
        var cpx = clamp(px, -W, W), cpz = clamp(pz, -D, D), md = 1e9;
        for (i = 0; i < near.length; i++) md = Math.min(md, hypot(near[i].u.x - cpx, near[i].u.z - cpz));
        var s = Math.min(md, 30) + home * Math.cos(ang) * 1.5 - hypot(px - cpx, pz - cpz) * 2.5;
        if (s > bs) { bs = s; best = { x: cpx, z: cpz }; }
      }
      H.setGoal(u, best.x, best.z, 1, 'flee'); ai.note = '王が退避';     // 退避中は 4.6m/s
      return;
    }
    u.fleeing = false;
    // 接近された：防御・回避は自動、反撃する
    if (ne && nd < u.radius + ne.radius + 1.6) { H.setEngage(u, ne); ai.note = '王が反撃'; return; }
    var p = this.slotPoint(sq, u), o = sq.order;
    if (o.type === 'attack') {
      // 自分から積極的に敵へ接近しない：護衛の後方に控える
      var gx = 0, gz = 0, gn = 0;
      for (i = 0; i < sq.units.length; i++) { var g = sq.units[i]; if (g.alive && g.type === 'guard') { gx += g.x; gz += g.z; gn++; } }
      if (gn) { var ts = this.squads[1 - u.team][o.target], ex = ts.cx - gx / gn, ez = ts.cz - gz / gn, el = hypot(ex, ez) + 1e-6; p = { x: gx / gn - ex / el * 6, z: gz / gn - ez / el * 6 }; }
      else p = { x: u.x, z: u.z };
    }
    // 戻る先に敵がいるなら、そちらへは近づかずに待つ
    var blockedHome = false;
    if (o.type !== 'move') { var nb = this.sim.queryNear(p.x, p.z, SPEC.kingDanger); for (i = 0; i < nb.length; i++) if (nb[i].alive && nb[i].team !== u.team && hypot(nb[i].x - p.x, nb[i].z - p.z) < SPEC.kingDanger) { blockedHome = true; break; } }
    if (blockedHome) { H.setGoal(u, u.x, u.z, 0, 'guard'); ai.faceAng = sq.face; ai.note = '王は後方で待機'; return; }
    var dd = hypot(p.x - u.x, p.z - u.z);
    H.setGoal(u, p.x, p.z, o.type === 'move' ? (dd > 2.5 ? 1 : 0.9) : (dd > 3 ? 1 : 0.7), o.type === 'move' ? 'move' : 'guard'); ai.faceAng = sq.face; ai.note = '王';
  };

  // ---------- 弓兵 ----------
  P.archerTarget = function (u, sq, near, onlyAhead) {
    var sim = this.sim, o = sq.order, k = sq.king || this.squads[u.team][0].king, best = null, bs = -1e9;
    for (var i = 0; i < near.length; i++) {
      var e = near[i].u, d = near[i].d;
      var maxR = SPEC.archerMax * (1 + Math.max(0, u.y - e.y) * sim.cfg.combat.heightRangeBonusPerM);   // 高い所からは遠くまで届く
      if (d > maxR || d < u.T.minRange) continue;
      if (onlyAhead && Math.abs(angDiff(onlyAhead, Math.atan2(e.z - u.z, e.x - u.x))) > 1.6) continue;
      var s = -d * 0.4;
      if (o.type === 'attack' && e.corps === o.target) s += 40;
      if (k && k.alive) { var kd = hypot(e.x - k.x, e.z - k.z); if (kd < 15) s += (15 - kd) * 0.8; }
      if (u.ai.shootTarget === e.id) s += 4;
      s += (1 - e.hp / e.maxHp) * 3;
      // 味方と乱戦中の敵は狙いにくい（味方に当たった矢は消えるだけだが、無駄撃ちを減らす）
      var fr = sim.queryNear(e.x, e.z, 2.2);
      for (var j = 0; j < fr.length; j++) if (fr[j].alive && fr[j].team === u.team && hypot(fr[j].x - e.x, fr[j].z - e.z) < 1.9) s -= 4;
      if (this.forests.length) s -= this.forestCover(u.x, u.z, e.x, e.z) * 1.2;   // 森越しの射撃は枝に当たりやすい
      s += sim.rng.gauss() * 0.8;
      if (s > bs) { bs = s; best = e; }
    }
    return best;
  };
  P.thinkArcher = function (u, sq) {
    var sim = this.sim, ai = u.ai, o = sq.order, near = this.enemiesNear(u, SPEC.archerMax + 4), i;
    var ne = null, nd = 1e9;
    for (i = 0; i < near.length; i++) if (near[i].d < nd) { nd = near[i].d; ne = near[i].u; }
    var contact = ne && nd < u.radius + ne.radius + 1.0;
    if (this.selfDefense(u, 3)) { ai.dagger = true; return; }
    var p = this.slotPoint(sq, u);
    // ---- 移動命令中：移動を優先。移動を大きく妨げずに撃てるときだけ撃つ ----
    if (o.type === 'move') {
      var st = stuck(sim, u);
      if (contact && st) { this.startSelfDefense(u, ne); ai.dagger = true; return; }
      var mdir = Math.atan2(p.z - u.z, p.x - u.x), far = hypot(p.x - u.x, p.z - u.z) > 1.5;
      var tg = this.archerTarget(u, sq, near, far ? mdir : null);
      this.moveStep(u, sq, p, near);
      if (tg && ai.mode === 'move') { ai.mode = 'shoot'; ai.shootTarget = tg.id; ai.note = '移動しながら射撃'; }
      return;
    }
    // ---- 近接された：後退を優先 ----
    if (ne && nd < SPEC.archerBackoff) {
      var ax = u.x - ne.x, az = u.z - ne.z, L = hypot(ax, az) + 1e-6, home = u.team === 0 ? -1 : 1;
      var dx = ax / L + home * 0.35, dz = az / L, dl = hypot(dx, dz) + 1e-6;
      var W = sim.W / 2 - 2, D = sim.D / 2 - 2, gx = clamp(u.x + dx / dl * 7, -W, W), gz = clamp(u.z + dz / dl * 7, -D, D);
      var room = hypot(gx - u.x, gz - u.z) > 2.5;
      // 待機中は待機位置から離れすぎない（際限なく逃げない）
      if (o.type === 'idle' && hypot(gx - p.x, gz - p.z) > SPEC.idleLeash + 6) room = false;
      if (!room || stuck(sim, u) && contact) {
        if (contact) { H.setEngage(u, ne); ai.dagger = true; ai.note = '後退できず短剣で防御'; return; }
        ai.mode = 'shoot'; ai.shootTarget = ne.id; ai.goalX = u.x; ai.goalZ = u.z; ai.goalSpeed = 0; ai.note = '後退できず射撃'; return;
      }
      if (nd < 4.5) { H.setGoal(u, gx, gz, 1, 'move'); ai.note = '後退'; return; }
      ai.mode = 'kite'; ai.targetId = 0; ai.goalX = gx; ai.goalZ = gz; ai.goalSpeed = 1; ai.shootTarget = ne.id; ai.note = '距離を取りつつ射撃';
      return;
    }
    var tgt = this.archerTarget(u, sq, near, null);
    if (o.type === 'attack') {
      var ts = this.squads[1 - u.team][o.target], tn = null, td = 1e9;
      for (i = 0; i < ts.units.length; i++) { var e = ts.units[i]; if (!e.alive) continue; var d = hypot(e.x - u.x, e.z - u.z); if (d < td) { td = d; tn = e; } }
      var gx2 = u.x, gz2 = u.z, sp = 0;
      if (tn) {
        var vx = tn.x - u.x, vz = tn.z - u.z, vl = hypot(vx, vz) + 1e-6, spread = ((u.id % 7) - 3) * 1.6;
        if (td > SPEC.archerIdeal + 4 || td < SPEC.archerIdeal - 4) {
          gx2 = tn.x - vx / vl * SPEC.archerIdeal - vz / vl * spread; gz2 = tn.z - vz / vl * SPEC.archerIdeal + vx / vl * spread;
          gx2 = clamp(gx2, -sim.W / 2 + 2, sim.W / 2 - 2); gz2 = clamp(gz2, -sim.D / 2 + 2, sim.D / 2 - 2);
          var hg = this.highGround(gx2, gz2, 5); gx2 = hg.x; gz2 = hg.z;     // 射撃位置は少しでも高い所・森の外を選ぶ
          sp = td > SPEC.archerIdeal ? 1 : 0.6;
        }
      }
      if (tgt) { ai.mode = 'shoot'; ai.targetId = 0; ai.shootTarget = tgt.id; ai.goalX = gx2; ai.goalZ = gz2; ai.goalSpeed = sp; ai.note = '射撃（' + ts.name + '）'; return; }
      H.setGoal(u, gx2, gz2, sp || 1, 'move'); ai.note = '射撃位置へ'; return;
    }
    // ---- 待機・防衛：射程内の敵を射撃 ----
    var dd = hypot(p.x - u.x, p.z - u.z);
    if (tgt) { ai.mode = 'shoot'; ai.targetId = 0; ai.shootTarget = tgt.id; ai.goalX = p.x; ai.goalZ = p.z; ai.goalSpeed = dd > 1.5 ? 0.7 : 0; ai.note = '射撃'; return; }
    H.setGoal(u, p.x, p.z, dd > 3 ? 1 : 0.7, 'guard'); ai.faceAng = sq.face; ai.note = dd > SPEC.lagR ? '合流中' : '待機';
  };

  // ============================================================
  //  進行（勝敗・制限時間）
  // ============================================================
  P.start = function () { this.sim.start(); this.ev('試合開始'); };
  P.step = function () {
    var sim = this.sim;
    if (sim.state !== 'battle') return;
    sim.step();
    // 味方に当たった矢はダメージを与えず消える
    var ar = sim.arrows;
    for (var i = ar.length - 1; i >= 0; i--) { var a = ar[i]; if (!a.alive && a.stuckOn && !a._chk) { a._chk = 1; var su = sim.unitById(a.stuckOn); if (su && su.team === a.team) ar.splice(i, 1); } }
    if (sim.state === 'battle' && sim.t >= SPEC.timeLimit) { sim.state = 'over'; sim.winner = -1; sim.endReason = '制限時間（300秒）'; }
    if (sim.state === 'over' && !this.result) {
      var k0 = sim.king(0), k1 = sim.king(1), why;
      if (sim.winner === -1) why = !k0 && !k1 ? '両軍の王が同時に倒れた' : '制限時間（' + SPEC.timeLimit + '秒）が経過';
      else why = sim.winner === 0 ? '敵の王を倒した' : '自軍の王が倒された';
      this.result = { winner: sim.winner, reason: why, t: Math.min(sim.t, SPEC.timeLimit), alive: [sim.aliveCount(0), sim.aliveCount(1)] };
    }
  };
  P.timeLeft = function () { return Math.max(0, SPEC.timeLimit - this.sim.t); };
  // ★の評価（自軍＝team 0 が勝ったときだけ）：勝利★1、王のHPが半分以上★2、3分以内★3
  P.stars = function () {
    var r = this.result; if (!r || r.winner !== 0) return { n: 0, got: [false, false, false] };
    var k = this.squads[0][0].king, got = [true, !!(k && k.alive && k.hp >= k.maxHp * SPEC.stars.kingHp), r.t <= SPEC.stars.fastWin];
    return { n: got.filter(Boolean).length, got: got };
  };

  // ============================================================
  //  敵CPU：約2秒ごとに3部隊へ移動・攻撃を指示（兵士の細かな判断は兵士AI）
  //  プレイヤーと同じ命令・同じ能力値。見ている情報は戦場の兵士の位置と残存数だけ
  // ============================================================
  function CPU(game, team) { this.g = game; this.team = team; this.timer = 0.6; this.cur = []; }
  WS.SimpleCPU = CPU;
  CPU.prototype.update = function (dt) {
    this.timer -= dt; if (this.timer > 0) return;
    this.timer = this.g.diffs[this.team].interval;
    this.think();
  };
  function dist(a, b) { return hypot(a.cx - b.cx, a.cz - b.cz); }
  CPU.prototype.issue = function (idx, cmd) {
    var key = cmd.type === 'attack' ? 'a' + cmd.target : 'm' + Math.round(cmd.x / 6) + ',' + Math.round(cmd.z / 6);
    var sq = this.g.squads[this.team][idx];
    if (this.cur[idx] === key && sq.order.type !== 'idle') return;    // 同じ命令は出し直さない
    if (cmd.type === 'move' && sq.order.type === 'idle' && hypot(sq.ax - cmd.x, sq.az - cmd.z) < 6) return;
    if (this.g.command(this.team, idx, cmd)) this.cur[idx] = key;
  };
  // 部隊の番号ではなく兵種で判断する（レベル3では同じ兵種の部隊が複数あったり、ない兵種があったりする）
  CPU.prototype.think = function () {
    var g = this.g, sim = g.sim, me = this.team, en = 1 - me, S = g.squads[me], E = g.squads[en];
    var R = S[0], k = R.king, home = me === 0 ? -1 : 1, self = this;
    if (!k || !k.alive) return;
    var alive = function (s) { return s.nAlive > 0; };
    var grp = function (list, kind) { return list.filter(function (s) { return s.kind === kind && s.nAlive > 0; }); };
    var enemies = E.filter(alive);
    if (!enemies.length) return;
    var myI = grp(S, 'infantry'), myA = grp(S, 'archer'), myC = grp(S, 'cavalry');
    var eI = grp(E, 'infantry'), eA = grp(E, 'archer'), eC = grp(E, 'cavalry');
    var nearestUnit = function (s, x, z) { var md = 1e9; for (var j = 0; j < s.units.length; j++) { var u = s.units[j]; if (u.alive) md = Math.min(md, hypot(u.x - x, u.z - z)); } return md; };
    var nearestSq = function (list, ref) { var b = null, bd = 1e9; list.forEach(function (s) { var d = dist(ref, s); if (d < bd) { bd = d; b = s; } }); return b; };
    var biggest = function (list) { var b = null; list.forEach(function (s) { if (!b || s.nAlive > b.nAlive) b = s; }); return b; };
    var sum = function (list) { var n = 0; list.forEach(function (s) { n += s.nAlive; }); return n; };
    // 自軍の王への脅威（王の近くにいる敵部隊）
    var D = g.diffs[me], threat = null, thrD = 1e9;
    enemies.forEach(function (s) { var md = nearestUnit(s, k.x, k.z); if (md < D.threatR && md < thrD) { thrD = md; threat = s; } });
    var eKing = E[0].king, eGuards = 0, myGuards = 0, i;
    for (i = 0; i < E[0].units.length; i++) if (E[0].units[i].alive && E[0].units[i].type === 'guard') eGuards++;
    for (i = 0; i < R.units.length; i++) if (R.units[i].alive && R.units[i].type === 'guard') myGuards++;
    // ---- 歩兵：進軍の主力（足の速い騎馬は追いかけない） ----
    myI.forEach(function (I) {
      var tI;
      if (threat && dist(I, threat) < 45 && (threat.kind !== 'cavalry' || dist(I, threat) < 18)) tI = threat;
      else {
        var best = null, bs = -1e9;
        enemies.forEach(function (s) {
          var sc = -dist(I, s);
          if (!D.smart) { if (self.cur[I.idx] === 'a' + s.idx) sc += 8; if (sc > bs) { bs = sc; best = s; } return; }   // やさしい：近い部隊へ向かうだけ
          if (s.kind === 'cavalry') sc -= dist(I, s) < 12 ? 0 : 30;
          if (s.kind === 'archer') sc += 10;
          if (s.kind === 'royal') sc += eGuards <= 4 ? 22 : -10;
          if (s.kind === 'royal' && eKing && eKing.alive && eKing.hp < eKing.maxHp * 0.5) sc += 12;
          if (myA.some(function (a) { return dist(a, s) < 16; })) sc += 15;      // 自軍の弓兵を襲っている部隊
          sc += (s.n0 - s.nAlive) * 0.6;
          if (self.cur[I.idx] === 'a' + s.idx) sc += 8;                          // 目標を頻繁に変えない
          if (sc > bs) { bs = sc; best = s; }
        });
        tI = best;
      }
      if (tI) self.issue(I.idx, { type: 'attack', target: tI.idx });
    });
    // ---- 弓兵：王の防衛、襲ってくる騎馬、歩兵の支援（歩兵が戦っている相手） ----
    myA.forEach(function (A) {
      var tA = null;
      if (threat) tA = threat;
      else {
        eC.forEach(function (c) { if (!tA && nearestUnit(c, A.cx, A.cz) < 16) tA = c; });
        if (!tA) { var I = nearestSq(myI, A); if (I && I.order.type === 'attack' && alive(E[I.order.target])) tA = E[I.order.target]; }
        if (!tA) tA = nearestSq(enemies, A);
      }
      if (tA) self.issue(A.idx, { type: 'attack', target: tA.idx });
    });
    // ---- 騎馬兵：王の防衛、無防備な弓兵狩り、手薄な敵王、自軍の弓兵を襲う敵騎馬、交戦中の敵歩兵の側面 ----
    var guarded = function (s) {      // その部隊の近くにいる敵の歩兵・護衛の数
      var n = 0; [E[0]].concat(eI).forEach(function (gs) { for (var j = 0; j < gs.units.length; j++) { var u = gs.units[j]; if (u.alive && u.type !== 'king' && hypot(u.x - s.cx, u.z - s.cz) < 10) n++; } }); return n;
    };
    myC.forEach(function (C) {
      var tC = null;
      if (threat && threat.kind !== 'royal') tC = threat;
      if (!D.opportunist && !tC) tC = nearestSq(enemies, C);           // やさしい：隙を狙わず近い部隊へ
      if (!tC) tC = nearestSq(eA.filter(function (a) { return guarded(a) < 4 && !g.forestAt(a.cx, a.cz); }), C);   // 森の中の弓兵は狙わない（騎馬が遅くなる）
      if (!tC && eKing && eKing.alive && eGuards <= 3 && C.nAlive >= 3) tC = E[0];
      if (!tC) eC.forEach(function (c) { if (!tC && myA.some(function (a) { return dist(c, a) < 24; })) tC = c; });
      if (!tC) eI.forEach(function (ei) { if (!tC && myI.some(function (I) { return dist(I, ei) < 14; })) tC = ei; });
      if (tC) self.issue(C.idx, { type: 'attack', target: tC.idx });
      else {
        // 機会を待つ：味方の前線の横（片翼）に控える
        var ref2 = nearestSq(myI, C) || nearestSq(myA, C) || R, side = C.az >= 0 ? 1 : -1;
        var wp = g.highGround(clamp(ref2.cx + home * 4, -sim.W / 2 + 6, sim.W / 2 - 6), clamp(ref2.cz + side * 18, -sim.D / 2 + 6, sim.D / 2 - 6), 8);
        self.issue(C.idx, { type: 'move', x: wp.x, z: wp.z });
      }
    });
    // ---- 第1部隊（王・護衛）：王を危険にさらしすぎない。機会があれば敵王を討つ ----
    var eField = sum(eI) + sum(eA) + sum(eC), mine = sum(myI) + sum(myA) + sum(myC);
    if (threat) {
      // 騎馬は足が速く、追っても王から離れるだけ：その場で構え、王に迫った騎馬を盾の護衛が迎え撃つ（待機中の自動迎撃）
      if (threat.kind === 'cavalry' && myGuards >= 3) return;
      if ((myGuards >= 5 && threat.nAlive <= myGuards + 3) || (threat.kind === 'archer' && myGuards >= 3 && !eI.length)) this.issue(0, { type: 'attack', target: threat.idx });
      else {
        // 脅威から離れた自陣側へ
        var ax = k.x - threat.cx, az = k.z - threat.cz, al = hypot(ax, az) + 1e-6;
        this.issue(0, { type: 'move', x: clamp(k.x + ax / al * 14 + home * 6, -sim.W / 2 + 6, sim.W / 2 - 6), z: clamp(k.z + az / al * 14, -sim.D / 2 + 6, sim.D / 2 - 6) });
      }
      return;
    }
    if (D.opportunist && eKing && eKing.alive && myGuards >= 6 && (eGuards <= 2 || (eGuards <= 4 && myI.some(function (I) { return I.order.type === 'attack' && I.order.target === 0 && dist(I, E[0]) < 20; }))) && dist(R, E[0]) < 60) {
      this.issue(0, { type: 'attack', target: 0 }); return;
    }
    // 終盤：敵の兵が尽きた（または自軍が十分に優勢）なら、護衛も出して敵王を討ちに行く
    if (eKing && eKing.alive && myGuards >= 3 && (eField === 0 && myGuards + mine >= eGuards || mine >= eField + 8 && myGuards >= eGuards)) {
      this.issue(0, { type: 'attack', target: 0 }); return;
    }
    // 自軍の歩兵が尽き、敵の弓兵だけが残っている：護衛で弓兵を追い払う
    if (!myI.length && !eI.length && eA.length && myGuards >= 4) {
      var tg = nearestSq(eA.filter(function (a) { return a.nAlive <= myGuards + 4; }), R);
      if (tg) { this.issue(0, { type: 'attack', target: tg.idx }); return; }
    }
    // 通常：自軍の弓兵（いなければ歩兵）の後方に控える。ただし自陣側の半分から出すぎない
    var ref = biggest(myA) || biggest(myI);
    var gx = ref ? ref.cx + home * 12 : R.ax, gz = ref ? ref.cz * 0.6 : R.az;
    gx = me === 0 ? clamp(gx, -sim.W / 2 + 6, 6) : clamp(gx, -6, sim.W / 2 - 6);
    gz = clamp(gz, -sim.D / 2 + 8, sim.D / 2 - 8);
    var hgR = g.highGround(gx, gz, 10);       // 地形があれば、近くの高い所（森の外）に構える
    this.issue(0, { type: 'move', x: hgR.x, z: hgR.z });
  };
})(typeof window !== 'undefined' ? window : globalThis);
