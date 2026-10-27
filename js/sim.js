// ============================================================
//  WarSimulation 検証版 — シミュレーション本体（描画に依存しない）
//  戦場生成 / 経路探索 / 移動・衝突 / 近接戦闘 / 突撃 / 矢の物理 / 勝敗 / 統計
// ============================================================
(function (G) {
  var WS = G.WS = G.WS || {};
  var TYPES = WS.UNIT_TYPES;
  var DT = 1 / 30;
  var GRAV = 9.8;
  var UNIT_HEIGHT = { infantry: 1.8, guard: 2.0, king: 2.2, archer: 1.8, cavalry: 2.6, elephant: 4.4, chariot: 2.3, general: 2.8 };
  var MOUNTED = { cavalry: 1, chariot: 1, elephant: 1, general: 1 };

  // ---------- 乱数（固定シード） ----------
  function RNG(seed) {
    var s = (seed >>> 0) || 1;
    this.next = function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.gauss = function () {
    var u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  RNG.prototype.chance = function (p) { return this.next() < p; };
  WS.RNG = RNG;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function angDiff(a, b) { var d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
  function hypot(x, z) { return Math.sqrt(x * x + z * z); }
  WS.clamp = clamp; WS.angDiff = angDiff; WS.hypot = hypot;
  WS.UNIT_HEIGHT = UNIT_HEIGHT; WS.MOUNTED = MOUNTED; WS.DT = DT;

  // ============================================================
  function Sim(config, opts) {
    opts = opts || {};
    this.cfg = config;
    this.seed = opts.seed != null ? opts.seed : 1;
    this.mode = opts.mode || 'pvc';          // 'pvc' プレイヤー対CPU / 'cvc' CPU対CPU
    this.rng = new RNG(this.seed);
    this.t = 0;
    this.state = 'setup';
    this.units = [];
    this.arrows = [];
    this.events = [];
    this.pendingRecycle = [];
    this.nextId = 1;
    this.winner = null; this.endReason = '';
    this.lastKillT = 0;
    this.stalemateStage = 0;
    this.pathBudget = 0;
    this.stepCount = 0;
    this.commanders = [null, null];
    this.teamStats = [this._emptyTeamStats(), this._emptyTeamStats()];
    this.firstBlood = null;
    this.killMatrix = {};
    // Ciel版：戦闘ログ（結果分析の根拠）
    this.killLog = [];        // {t, kt, kc, ktype, vt, vc, vtype, kind, dir, routing}
    this.routLog = [];        // {t, team, corps, type, id, rally}
    this.corpsDmg = {};       // "攻撃側team-corps>防御側team-corps" → ダメージ
    this.snapshots = [];      // 5秒ごとの部隊ごとの生存・敗走数
    this.surrendered = -1;
    this._moraleAcc = 0; this._snapAcc = 0;
    this.kingHurtFlag = [false, false];
    this.corpsHalfFlag = {};
    this.fort = null;          // 城壁戦の世界（WS.Fortress.World）。城壁戦以外は null
    this.genField();
    this.createArmies();
  }
  WS.Sim = Sim;
  var P = Sim.prototype;

  P._emptyTeamStats = function () {
    return { arrowsFired: 0, arrowsHitEnemy: 0, arrowsHitFriend: 0, arrowsMissed: 0, blocks: 0, dodges: 0, charges: 0, trampleHits: 0, scytheHits: 0, recycled: 0, deviations: 0, retreats: 0, refills: 0, kingDamageTaken: 0 };
  };

  // ---------------- 戦場生成 ----------------
  P.genField = function () {
    if (this.cfg.fortress && this.cfg.fortress.enabled && WS.Fortress) { WS.Fortress.genField(this); return; }
    var f = this.cfg.field, r = this.rng;
    var lin = Math.sqrt(f.areaScale || 1);
    var W = this.W = f.baseWidth * lin, D = this.D = f.baseDepth * lin;
    this.lin = lin;
    var deployW = W * f.deployDepth;
    this.deploy = [ { x0: -W / 2 + 2, x1: -W / 2 + deployW }, { x0: W / 2 - deployW, x1: W / 2 - 2 } ];
    // 補給地点・王の初期位置
    this.supply = [ { x: -W / 2 + deployW * 0.35, z: -D * 0.18 }, { x: W / 2 - deployW * 0.35, z: D * 0.18 } ];
    // 丘
    this.hills = [];
    if (f.hills) {
      var nh = Math.round(4 + 3 * lin);
      for (var i = 0; i < nh; i++) {
        this.hills.push({ x: r.range(-W * 0.42, W * 0.42), z: r.range(-D * 0.45, D * 0.45), r: r.range(8, 20) * Math.sqrt(lin), h: r.range(0.35, 1) * f.hillHeight * (r.chance(0.2) ? -0.4 : 1) });
      }
    }
    // 遮蔽物
    var obs = this.obstacles = [];
    var self = this;
    function freeAt(x, z, rad) {
      for (var s = 0; s < 2; s++) if (hypot(x - self.supply[s].x, z - self.supply[s].z) < rad + f.supplyRadius + 3) return false;
      for (var i = 0; i < obs.length; i++) {
        var o = obs[i]; var or = o.shape === 'circle' ? o.r : Math.max(o.hw, o.hd);
        if (hypot(x - o.x, z - o.z) < rad + or + 2.5) return false;
      }
      return true;
    }
    var dens = f.obstacleDensity * Math.min(lin * lin, 12);
    var counts = { rock: Math.round(9 * dens), tree: Math.round(12 * dens), wall: Math.round(4 * dens), building: Math.round(3 * dens) };
    function place(kind, n) {
      for (var k = 0; k < n; k++) {
        for (var tries = 0; tries < 40; tries++) {
          // 中央寄りに配置（自陣の奥は比較的空ける）
          var x = r.range(-W * 0.4, W * 0.4), z = r.range(-D * 0.46, D * 0.46);
          var o;
          if (kind === 'rock') o = { kind: kind, shape: 'circle', x: x, z: z, r: r.range(1.0, 2.6), h: r.range(1.2, 2.8) };
          else if (kind === 'tree') o = { kind: kind, shape: 'circle', x: x, z: z, r: 0.6, canopyR: r.range(1.6, 2.4), h: r.range(5, 8) };
          else if (kind === 'wall') { var horiz = r.chance(0.5), len = r.range(6, 14); o = { kind: kind, shape: 'box', x: x, z: z, hw: horiz ? len / 2 : 0.5, hd: horiz ? 0.5 : len / 2, h: 2.4 }; }
          else o = { kind: kind, shape: 'box', x: x, z: z, hw: r.range(2.5, 4.5), hd: r.range(2.5, 4.5), h: r.range(4, 6) };
          var rad = o.shape === 'circle' ? (o.canopyR || o.r) : Math.max(o.hw, o.hd);
          // 自陣の後方 2/3 には置かない
          if (x < self.deploy[0].x1 - deployW * 0.35 || x > self.deploy[1].x0 + deployW * 0.35) continue;
          if (!freeAt(x, z, rad)) continue;
          o.y0 = self.heightAt(x, z) - 0.3;
          obs.push(o); break;
        }
      }
    }
    place('building', counts.building); place('wall', counts.wall); place('rock', counts.rock);
    // 木は小さな林としてまとめる
    var groves = Math.max(1, Math.round(counts.tree / 4));
    for (var g = 0; g < groves; g++) {
      var cx = r.range(-W * 0.32, W * 0.32), cz = r.range(-D * 0.42, D * 0.42);
      for (var t = 0; t < 4; t++) {
        var tx = cx + r.range(-6, 6), tz = cz + r.range(-6, 6);
        if (Math.abs(tx) > W * 0.45 || Math.abs(tz) > D * 0.47) continue;
        if (!freeAt(tx, tz, 1.2)) continue;
        obs.push({ kind: 'tree', shape: 'circle', x: tx, z: tz, r: 0.6, canopyR: r.range(1.6, 2.4), h: r.range(5, 8), y0: this.heightAt(tx, tz) - 0.3 });
      }
    }
    this.buildNav();
  };

  P.heightAt = function (x, z) {
    var h = 0, hs = this.hills;
    for (var i = 0; i < hs.length; i++) {
      var dx = x - hs[i].x, dz = z - hs[i].z;
      h += hs[i].h * Math.exp(-(dx * dx + dz * dz) / (hs[i].r * hs[i].r));
    }
    return h;
  };

  // ---------------- 経路探索グリッド ----------------
  // 障害物の空間分割（静的。扉は開いていても登録し、使う側で off を確認する）
  var OGC = 12, OST = 0, ORING = [], OI = 0;
  for (var oi = 0; oi < 12; oi++) ORING.push([]);
  P.buildObsGrid = function () {
    var g = {}, obs = this.obstacles;
    for (var k = 0; k < obs.length; k++) {
      var o = obs[k], rx = o.shape === 'circle' ? (o.canopyR || o.r) : o.hw, rz = o.shape === 'circle' ? rx : o.hd;
      for (var i = Math.floor((o.x - rx) / OGC); i <= Math.floor((o.x + rx) / OGC); i++) for (var j = Math.floor((o.z - rz) / OGC); j <= Math.floor((o.z + rz) / OGC); j++) { var key = i * 4096 + j; (g[key] || (g[key] = [])).push(o); }
    }
    this._og = g;
  };
  // 範囲 [minx..maxx]×[minz..maxz] に重なるかもしれない障害物（重複なし・使い回しの配列）
  P.obsIn = function (minx, minz, maxx, maxz) {
    if (!this._og || this._ogN !== this.obstacles.length) { this.buildObsGrid(); this._ogN = this.obstacles.length; }   // 遮蔽物が増減したら作り直す
    var out = ORING[OI = (OI + 1) % ORING.length], g = this._og; out.length = 0; OST++;
    var i0 = Math.floor(minx / OGC), i1 = Math.floor(maxx / OGC), j0 = Math.floor(minz / OGC), j1 = Math.floor(maxz / OGC);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) { var all = this.obstacles; for (var a = 0; a < all.length; a++) out.push(all[a]); return out; }
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) { var c = g[i * 4096 + j]; if (c) for (var k = 0; k < c.length; k++) { var o = c[k]; if (o._ost !== OST) { o._ost = OST; out.push(o); } } }
    return out;
  };
  P.buildNav = function () {
    this.buildObsGrid();
    var c = this.cfg.field.navCell;
    this.navC = c;
    this.navW = Math.ceil(this.W / c); this.navH = Math.ceil(this.D / c);
    var n = this.navW * this.navH;
    this.nav = new Uint8Array(n);
    var inflate = 0.7;
    for (var j = 0; j < this.navH; j++) for (var i = 0; i < this.navW; i++) {
      var x = -this.W / 2 + (i + 0.5) * c, z = -this.D / 2 + (j + 0.5) * c;
      if (this.pointBlocked(x, z, inflate)) this.nav[j * this.navW + i] = 1;
    }
  };
  P.pointBlocked = function (x, z, inflate) {
    var obs = this.obsIn(x - inflate, z - inflate, x + inflate, z + inflate);
    for (var k = 0; k < obs.length; k++) {
      var o = obs[k]; if (o.off || (o.g && this.fort && this.fort.gatePassable(o.g, null))) continue;   // 開きかけの扉も、通れる幅があれば通れる
      if (o.shape === 'circle') { if (hypot(x - o.x, z - o.z) < o.r + inflate) return true; }
      else if (Math.abs(x - o.x) < o.hw + inflate && Math.abs(z - o.z) < o.hd + inflate) return true;
    }
    return false;
  };
  // 線分が遮蔽物（移動用）と交差しないか
  P.segmentClear = function (x0, z0, x1, z1, inflate) {
    var obs = this.obsIn(Math.min(x0, x1) - inflate, Math.min(z0, z1) - inflate, Math.max(x0, x1) + inflate, Math.max(z0, z1) + inflate), dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz;
    for (var k = 0; k < obs.length; k++) {
      var o = obs[k]; if (o.off || (o.g && this.fort && this.fort.gatePassable(o.g, null))) continue;
      if (o.shape === 'circle') {
        var t = L2 > 0 ? clamp(((o.x - x0) * dx + (o.z - z0) * dz) / L2, 0, 1) : 0;
        if (hypot(x0 + dx * t - o.x, z0 + dz * t - o.z) < o.r + inflate) return false;
      } else if (segAABB(x0, z0, x1, z1, o.x - o.hw - inflate, o.z - o.hd - inflate, o.x + o.hw + inflate, o.z + o.hd + inflate)) return false;
    }
    return true;
  };
  function segAABB(x0, z0, x1, z1, minx, minz, maxx, maxz) { return segAABBt(x0, z0, x1, z1, minx, minz, maxx, maxz) !== null; }
  // 線分と箱の交差区間 [tmin, tmax]（交差しなければ null）
  var _seg = { a: 0, b: 0 };
  function segAABBt(x0, z0, x1, z1, minx, minz, maxx, maxz) {
    var tmin = 0, tmax = 1, dx = x1 - x0, dz = z1 - z0;
    if (Math.abs(dx) < 1e-9) { if (x0 < minx || x0 > maxx) return null; }
    else { var t1 = (minx - x0) / dx, t2 = (maxx - x0) / dx; if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null; }
    if (Math.abs(dz) < 1e-9) { if (z0 < minz || z0 > maxz) return null; }
    else { var t3 = (minz - z0) / dz, t4 = (maxz - z0) / dz; if (t3 > t4) { var t5 = t3; t3 = t4; t4 = t5; } tmin = Math.max(tmin, t3); tmax = Math.min(tmax, t4); if (tmin > tmax) return null; }
    _seg.a = tmin; _seg.b = tmax; return _seg;
  }
  WS.segAABBt = segAABBt;
  // 視線（射線）：高さを考慮した直線が遮蔽物に遮られないか
  P.lineOfSight = function (x0, y0, z0, x1, y1, z1) {
    var obs = this.obsIn(Math.min(x0, x1) - 3, Math.min(z0, z1) - 3, Math.max(x0, x1) + 3, Math.max(z0, z1) + 3), dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz;
    for (var k = 0; k < obs.length; k++) {
      var o = obs[k], t; if (o.off) continue;
      if (o.shape === 'circle') {
        var rr = o.canopyR || o.r;
        t = L2 > 0 ? clamp(((o.x - x0) * dx + (o.z - z0) * dz) / L2, 0, 1) : 0;
        if (hypot(x0 + dx * t - o.x, z0 + dz * t - o.z) < rr) {
          var y = y0 + (y1 - y0) * t;
          if (y < o.y0 + o.h && t > 0.02 && t < 0.98) return false;
        }
      } else {
        // 線分が箱を通る区間で、高さが箱より低ければ遮られる（両端の点は除く）
        var it = segAABBt(x0, z0, x1, z1, o.x - o.hw, o.z - o.hd, o.x + o.hw, o.z + o.hd);
        if (it) {
          var ta = Math.max(it.a, 0.02), tb = Math.min(it.b, 0.98);
          if (ta <= tb && Math.min(y0 + (y1 - y0) * ta, y0 + (y1 - y0) * tb) < o.y0 + o.h) return false;
        }
      }
    }
    return true;
  };

  P.cellOf = function (x, z) {
    var i = clamp(Math.floor((x + this.W / 2) / this.navC), 0, this.navW - 1);
    var j = clamp(Math.floor((z + this.D / 2) / this.navC), 0, this.navH - 1);
    return j * this.navW + i;
  };
  P.cellCenter = function (c) {
    var i = c % this.navW, j = (c / this.navW) | 0;
    return { x: -this.W / 2 + (i + 0.5) * this.navC, z: -this.D / 2 + (j + 0.5) * this.navC };
  };
  P.nearestFreeCell = function (c) {
    if (!this.nav[c]) return c;
    var W = this.navW, H = this.navH, ci = c % W, cj = (c / W) | 0;
    for (var r = 1; r < 12; r++) for (var dj = -r; dj <= r; dj++) for (var di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      var i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      if (!this.nav[j * W + i]) return j * W + i;
    }
    return c;
  };
  // A*（8近傍）→ 簡略化した経由点列を返す
  P.findPath = function (sx, sz, gx, gz) {
    var W = this.navW, H = this.navH, nav = this.nav, N = W * H;
    var s = this.nearestFreeCell(this.cellOf(sx, sz)), g = this.nearestFreeCell(this.cellOf(gx, gz));
    if (s === g) return [{ x: gx, z: gz }];
    if (!this._g || this._g.length !== N) { this._g = new Float32Array(N); this._from = new Int32Array(N); this._mark = new Uint32Array(N); this._stamp = 0; this._closed = new Uint32Array(N); }
    var gs = this._g, from = this._from, mark = this._mark, closed = this._closed, stamp = ++this._stamp;
    var gi = g % W, gj = (g / W) | 0;
    var heap = [], hf = [];
    function push(n, f) { heap.push(n); hf.push(f); var i = heap.length - 1; while (i > 0) { var p = (i - 1) >> 1; if (hf[p] <= hf[i]) break; swap(i, p); i = p; } }
    function swap(a, b) { var t = heap[a]; heap[a] = heap[b]; heap[b] = t; t = hf[a]; hf[a] = hf[b]; hf[b] = t; }
    function pop() { var top = heap[0], lastN = heap.pop(), lastF = hf.pop(); if (heap.length) { heap[0] = lastN; hf[0] = lastF; var i = 0; for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && hf[l] < hf[m]) m = l; if (r < heap.length && hf[r] < hf[m]) m = r; if (m === i) break; swap(i, m); i = m; } } return top; }
    function h(n) { var dx = Math.abs(n % W - gi), dy = Math.abs(((n / W) | 0) - gj); return (dx + dy) + (1.4142 - 2) * Math.min(dx, dy); }
    mark[s] = stamp; gs[s] = 0; from[s] = -1; push(s, h(s));
    var found = false, expanded = 0, maxExp = 25000;
    var DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];
    while (heap.length) {
      var cur = pop();
      if (closed[cur] === stamp) continue;
      closed[cur] = stamp;
      if (cur === g) { found = true; break; }
      if (++expanded > maxExp) break;
      var ci = cur % W, cj = (cur / W) | 0;
      for (var k = 0; k < 8; k++) {
        var ni = ci + DI[k], nj = cj + DJ[k];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        var n = nj * W + ni;
        if (nav[n]) continue;
        if (k >= 4 && (nav[cj * W + ni] || nav[nj * W + ci])) continue; // 角抜け禁止
        var ng = gs[cur] + DC[k];
        if (mark[n] !== stamp || ng < gs[n]) { mark[n] = stamp; gs[n] = ng; from[n] = cur; push(n, ng + h(n)); }
      }
    }
    if (!found) return null;
    var cells = [];
    for (var c = g; c !== -1; c = from[c]) cells.push(c);
    cells.reverse();
    // 経由点の簡略化（見通しの効く点を飛ばす）
    var pts = [], ax = sx, az = sz, i = 0;
    while (i < cells.length - 1) {
      var j = cells.length - 1;
      for (; j > i + 1; j--) { var q = this.cellCenter(cells[j]); if (this.segmentClear(ax, az, q.x, q.z, 0.6)) break; }
      var p = this.cellCenter(cells[j]);
      pts.push(p); ax = p.x; az = p.z; i = j;
    }
    if (pts.length) pts[pts.length - 1] = { x: gx, z: gz };
    else pts.push({ x: gx, z: gz });
    return pts;
  };

  // ---------------- 部隊生成 ----------------
  P.defaultStats = function (type) {
    var d = this.cfg.stats.defaults[type] || [3, 3, 2, 2];
    return { atk: d[0], def: d[1], spd: d[2], int: d[3] };
  };
  P.createUnit = function (team, type, x, z, stats) {
    var T = this.cfg.units[type];
    var u = {
      id: this.nextId++, team: team, type: type, T: T,
      st: stats || this.defaultStats(type),
      x: x, z: z, y: this.heightAt(x, z), heading: team === 0 ? 0 : Math.PI, vx: 0, vz: 0, spd: 0,
      kx: 0, kz: 0, stunT: 0,
      radius: T.radius, mass: T.mass, height: UNIT_HEIGHT[type],
      maxHp: T.hp, hp: T.hp, alive: true, deadT: 0,
      order: { type: type === 'king' ? 'hold' : (type === 'guard' ? 'guardKing' : 'attack') },
      group: 0,
      ai: { mode: 'idle', targetId: 0, thinkT: this.rng.range(0, 0.8), retreatT: 0, retreatCD: 0, path: null, pathGoal: null, pathT: 0, stuckT: 0, lastX: x, lastZ: z, wantX: 0, wantZ: 0, wantSpeed: 0, faceX: 0, faceZ: 0, hasFace: false, note: '' },
      atkCool: this.rng.range(0, 0.5), windT: 0, windTarget: 0, swingT: 0,
      arrows: T.arrows || 0, reloadT: 0, chargeCool: 0, trampleCool: 0, scytheHit: {},
      s: { kills: 0, dmgDealt: 0, dmgTaken: 0, arrowsFired: 0, arrowsHit: 0, friendlyBlocked: 0, blocks: 0, dodges: 0, charges: 0, timeOfDeath: null, killedBy: null, deviations: 0 },
      recycled: false, homeX: x, homeZ: z,
      corps: -1, ace: null, buffs: {}, morale: 100, routing: false, brainBonus: 0,
      // 城壁戦：layer='ground'|'wall'|'climb'、部隊、作戦、角笛、特別命令
      layer: 'ground', squad: 0, strat: null, horn: null, special: null, vis: [true, true]
    };
    u.s.dmgFlank = 0; u.s.routs = 0; u.s.killsWhileBuff = 0;
    u.morale = this.initialMorale(u);
    this.units.push(u);
    return u;
  };

  // 初期配置（兵種別の陣形）
  P.createArmies = function () {
    this.units = []; this.nextId = 1;
    if (this.fort) return;      // 城壁戦は編成画面（またはCPU）が兵士を作る
    for (var team = 0; team < 2; team++) {
      var comp = this.cfg.army[team === 0 ? 'blue' : 'red'];
      var dep = this.deploy[team];
      var dir = team === 0 ? 1 : -1;
      var front = team === 0 ? dep.x1 - 3 : dep.x0 + 3;
      var back = team === 0 ? dep.x0 + 4 : dep.x1 - 4;
      var depth = Math.abs(front - back);
      var D = this.D;
      var self = this;
      var lineSpan = Math.min(D * 0.7, 60 * Math.sqrt(this.lin));
      function line(type, n, xOff, span, rows) {
        rows = rows || 1;
        var perRow = Math.ceil(n / rows), k = 0;
        for (var r = 0; r < rows; r++) for (var i = 0; i < perRow && k < n; i++, k++) {
          var z = perRow === 1 ? 0 : -span / 2 + span * i / (perRow - 1);
          var x = front - dir * (xOff + r * 2.4);
          self.createUnit(team, type, x, z * dir + (team === 0 ? 0 : 0));
        }
      }
      var nInf = comp.infantry || 0, nArc = comp.archer || 0, nCav = comp.cavalry || 0, nEle = comp.elephant || 0, nCh = comp.chariot || 0, nG = comp.guard || 0, nK = comp.king || 0;
      line('infantry', nInf, 1, lineSpan * 0.55, nInf > 12 ? 2 : 1);
      if (nEle) line('elephant', nEle, -2, Math.min(lineSpan * 0.25, 12 * nEle), 1);
      line('archer', nArc, Math.min(10, depth * 0.35), lineSpan * 0.5, 1);
      // 騎馬兵：両翼
      for (var c = 0; c < nCav; c++) {
        var side = c % 2 === 0 ? 1 : -1, idx = Math.floor(c / 2);
        this.createUnit(team, 'cavalry', front - dir * (3 + idx * 3), side * (lineSpan * 0.42 + idx * 1.5));
      }
      for (var h = 0; h < nCh; h++) {
        var sd = h % 2 === 0 ? -1 : 1;
        this.createUnit(team, 'chariot', front - dir * (6 + Math.floor(h / 2) * 4), sd * lineSpan * 0.3);
      }
      // 王と側近：補給地点の近く
      var kp = this.supply[team];
      var kx = kp.x + dir * 6, kz = kp.z;
      for (var k = 0; k < nK; k++) this.createUnit(team, 'king', kx, kz + k * 3);
      for (var gI = 0; gI < nG; gI++) {
        var a = (gI / Math.max(1, nG)) * Math.PI * 2;
        this.createUnit(team, 'guard', kx + Math.cos(a) * 2.5 + dir * 1.5, kz + Math.sin(a) * 2.5);
      }
    }
    for (var i = 0; i < this.units.length; i++) this.clampToDeploy(this.units[i]);
  };

  P.unitY = function (u) { return this.fort ? this.fort.unitY(u) : this.heightAt(u.x, u.z); };
  P.clampToDeploy = function (u) {
    if (this.fort) { this.fort.clampDeploy(u); return; }
    var d = this.deploy[u.team];
    u.x = clamp(u.x, d.x0, d.x1); u.z = clamp(u.z, -this.D / 2 + 2, this.D / 2 - 2);
    this.resolveObstacle(u);
    u.y = this.heightAt(u.x, u.z);
    u.homeX = u.x; u.homeZ = u.z;
  };

  // 配置フェーズ：兵士を指定位置へ置く（自陣内のみ）
  P.placeUnit = function (u, x, z) {
    if (this.state !== 'setup') return;
    u.x = x; u.z = z; this.clampToDeploy(u);
  };

  P.unitById = function (id) {
    if (!this._idx || this._idxN !== this.units.length) { this._idx = {}; for (var i = 0; i < this.units.length; i++) this._idx[this.units[i].id] = this.units[i]; this._idxN = this.units.length; }
    return this._idx[id];
  };
  P.king = function (team) {
    for (var i = 0; i < this.units.length; i++) { var u = this.units[i]; if (u.team === team && u.type === 'king' && u.alive) return u; }
    return null;
  };
  P.anyKing = function (team) { for (var i = 0; i < this.units.length; i++) if (this.units[i].team === team && this.units[i].type === 'king') return this.units[i]; return null; };
  P.aliveCount = function (team) { var n = 0; for (var i = 0; i < this.units.length; i++) if (this.units[i].alive && this.units[i].team === team) n++; return n; };

  // ---------------- 能力値による補正 ----------------
  // エース・号令の補正（Ciel版）
  P.aceLv = function (u, kind) { return u.ace && u.ace.type === kind ? u.ace.lvl : 0; };
  P.buffOn = function (u, kind) { var b = u.buffs && u.buffs[kind]; return b && b > this.t; };
  P.atkMult = function (u) {
    var s = this.cfg.stats, m = s.atkBase + s.atkPerPoint * u.st.atk, sp = this.cfg.simple;
    if (u.ace && u.ace.type === 'power') m *= 1 + sp.ace.power.atkPerPt * u.ace.lvl;
    if (this.buffOn(u, 'charge')) m *= sp.rally.charge.atk;
    return m;
  };
  P.defMult = function (u) {
    var s = this.cfg.stats, m = Math.max(0.3, 1 - s.defPerPoint * u.st.def);
    if (this.buffOn(u, 'iron')) m *= this.cfg.simple.rally.iron.dmgTaken;
    return m;
  };
  P.spdMult = function (u) {
    var s = this.cfg.stats, m = s.spdBase + s.spdPerPoint * u.st.spd, sp = this.cfg.simple;
    if (u.ace && u.ace.type === 'swift') m *= 1 + sp.ace.swift.spdPerPt * u.ace.lvl;
    if (this.buffOn(u, 'charge')) m *= sp.rally.charge.speed;
    if (this.buffOn(u, 'rescue')) m *= sp.rally.rescue.speed;
    return m;
  };
  P.cooldownMult = function (u) {
    var m = Math.max(0.6, 1 - this.cfg.stats.cooldownPerPoint * u.st.spd);
    if (u.ace && u.ace.type === 'swift') m *= Math.max(0.5, 1 - this.cfg.simple.ace.swift.cooldownPerPt * u.ace.lvl);
    return m;
  };
  P.dodgeBonus = function (u) { return u.ace && u.ace.type === 'swift' ? this.cfg.simple.ace.swift.dodgePerPt * u.ace.lvl : 0; };
  P.maxSpeed = function (u) { return u.T.speed * this.spdMult(u); };
  // 頭脳の実効値（影響度を考慮。0〜10）。知将エースは自分と周囲の頭脳を底上げする
  P.brain = function (u) { var bi = this.cfg.stats.brainInfluence; return clamp(5 + (u.st.int + (u.brainBonus || 0) - 5) * bi, 0, 10); };
  // エースの設定（体力など、持続する補正もここで反映）
  P.setAce = function (u, type, lvl) {
    lvl = clamp(Math.round(lvl), 0, this.cfg.simple.aceMaxPerUnit);
    var hpR = u.hp / u.maxHp;
    u.ace = lvl > 0 ? { type: type, lvl: lvl } : null;
    var mh = u.T.hp * (u.ace && type === 'power' ? 1 + this.cfg.simple.ace.power.hpPerPt * lvl : 1);
    u.maxHp = mh; u.hp = mh * hpR;
    u.brainBonus = u.ace && type === 'leader' ? this.cfg.simple.ace.leader.brainPerPt * lvl : 0;
    u.morale = this.initialMorale(u);
  };
  P.initialMorale = function (u) {
    var M = this.cfg.morale;
    var m = M.base + (M.typeBonus[u.type] || 0) + (u.ace ? this.cfg.simple.aceMoraleBonus : 0);
    return clamp(m, 0, 100);
  };

  // ---------------- 開始 ----------------
  P.start = function () {
    if (this.state !== 'setup') return;
    this.state = 'battle';
    this.t = 0; this.lastKillT = 0;
    this.initCount = [0, 0]; this.corpsInit = {};
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i]; u.homeX = u.x; u.homeZ = u.z; u.morale = this.initialMorale(u);
      if (u.type !== 'king') this.initCount[u.team]++;
      var ck = u.team + '-' + u.corps; this.corpsInit[ck] = (this.corpsInit[ck] || 0) + 1;
    }
    this.log('戦闘開始（シード ' + this.seed + '）');
  };

  P.log = function (text, team) { this.events.push({ t: this.t, text: text, team: team }); if (this.events.length > 200) this.events.shift(); };

  // ---------------- 命令 ----------------
  // order: {type:'attack'|'advance'|'hold'|'move'|'attackTarget'|'guardKing'|'defendBase'|'fireAt'|'retreat'|'flank', x,z,targetId,side}
  P.issueOrder = function (ids, order) {
    var us = [], i;
    for (i = 0; i < ids.length; i++) { var u = this.unitById(ids[i]); if (u && u.alive) us.push(u); }
    if (!us.length) return;
    var cx = 0, cz = 0; for (i = 0; i < us.length; i++) { cx += us[i].x; cz += us[i].z; } cx /= us.length; cz /= us.length;
    for (i = 0; i < us.length; i++) {
      var u2 = us[i], o = { type: order.type, issuedT: this.t };
      if (order.type === 'move' || order.type === 'fireAt' && order.x != null) {
        // 隊形を保ったまま移動（広がりすぎは圧縮）
        var ox = u2.x - cx, oz = u2.z - cz, spread = Math.sqrt(ox * ox + oz * oz), maxS = 4 + Math.sqrt(us.length) * 2.2;
        if (spread > maxS) { ox *= maxS / spread; oz *= maxS / spread; }
        if (order.type === 'move') { o.x = clamp(order.x + ox, -this.W / 2 + 1, this.W / 2 - 1); o.z = clamp(order.z + oz, -this.D / 2 + 1, this.D / 2 - 1); }
        else { o.x = order.x; o.z = order.z; o.spreadX = ox * 0.3; o.spreadZ = oz * 0.3; }
      }
      if (order.type === 'fireAt' && order.targetId) o.targetId = order.targetId;
      if (order.type === 'attackTarget') o.targetId = order.targetId;
      if (order.type === 'advance') { var dir = u2.team === 0 ? 1 : -1; o.x = clamp(u2.x + dir * (order.dist || 25), -this.W / 2 + 1, this.W / 2 - 1); o.z = u2.z; }
      if (order.type === 'flank') {
        var side = order.side;
        if (!side) side = this.weakSide(u2.team);
        o.side = side; o.phase = 0;
        o.x = this.flankPoint(u2.team, side).x; o.z = this.flankPoint(u2.team, side).z;
      }
      if (order.type === 'hold') { o.x = u2.x; o.z = u2.z; }
      u2.order = o;
      u2.ai.thinkT = Math.min(u2.ai.thinkT, 0.15 + this.rng.next() * 0.25);
      u2.ai.path = null;
    }
  };
  // 敵の配置が手薄な側（z方向 +1/-1）
  P.weakSide = function (team) {
    var s = 0;
    for (var i = 0; i < this.units.length; i++) { var e = this.units[i]; if (e.alive && e.team !== team) s += e.z; }
    return s > 0 ? -1 : 1;
  };
  P.enemyCenter = function (team) {
    var x = 0, z = 0, n = 0;
    if (this._ecT === this.stepCount && this._ec && this._ec[team]) return this._ec[team];
    for (var i = 0; i < this.units.length; i++) { var e = this.units[i]; if (e.alive && e.team !== team && e.type !== 'king' && (!this.fort || e.vis[team])) { x += e.x; z += e.z; n++; } }
    if (n) { if (this._ecT !== this.stepCount) { this._ec = [null, null]; this._ecT = this.stepCount; } return (this._ec[team] = { x: x / n, z: z / n }); }
    if (this.fort) return this.fort.enemyGuess(team);
    if (!n) { var k = this.king(1 - team); return k ? { x: k.x, z: k.z } : { x: 0, z: 0 }; }
    return { x: x / n, z: z / n };
  };
  P.flankPoint = function (team, side) {
    var ec = this.enemyCenter(team);
    return { x: ec.x, z: clamp(side * this.D * 0.4, -this.D / 2 + 3, this.D / 2 - 3) };
  };

  // ---------------- メインループ ----------------
  P.step = function () {
    if (this.state !== 'battle') return;
    var cfg = this.cfg, units = this.units, i;
    this.t += DT; this.stepCount++;
    this.pathBudget = this.fort ? 14 : 6;
    // 指揮官（CPU）
    this.buildGrid();
    for (var tm = 0; tm < 2; tm++) if (this.commanders[tm]) this.commanders[tm].update(this, DT);
    if (this.corpsSystem) this.corpsSystem.update(DT);
    if (this.fort) this.fort.update(DT);
    if (this.state !== 'battle') return;
    // 膠着防止
    var sinceKill = this.fort ? 0 : this.t - this.lastKillT;     // 城壁戦は角笛と作戦で動くので、旧ルールの強制総攻撃は使わない
    if (this.stalemateStage === 0 && sinceKill > cfg.combat.stalemateTime) { this.stalemateStage = 1; this.log('膠着状態：CPU軍に総攻撃を指示'); this.forceAttack(true); }
    if (this.stalemateStage === 1 && sinceKill > cfg.combat.stalemateTime * 2) { this.stalemateStage = 2; this.log('長期膠着：全軍が総攻撃へ'); this.forceAttack(false); }
    if (sinceKill < 5 && this.stalemateStage > 0) this.stalemateStage = 0;
    // 処理順：毎フレーム交互に入れ替え、青・赤どちらかが常に先に動く不公平をなくす
    var n = units.length, rev = (this.stepCount & 1) === 1, k;
    // 士気（0.5秒ごと）
    if (this.cfg.morale.enabled) { this._moraleAcc += DT; if (this._moraleAcc >= 0.5) { this.updateMorale(this._moraleAcc); this._moraleAcc = 0; } }
    this._snapAcc += DT; if (this._snapAcc >= 5) { this._snapAcc = 0; this.snapshot(); }
    // AI
    for (k = 0; k < n; k++) {
      i = rev ? n - 1 - k : k;
      var u = units[i];
      if (!u.alive) continue;
      u.ai.thinkT -= DT;
      if (u.ai.thinkT <= 0) {
        var b = this.brain(u);
        u.ai.thinkT = Math.max(0.15, cfg.ai.thinkBase - cfg.ai.thinkPerBrain * b) * (0.8 + 0.4 * this.rng.next());
        WS.AI.think(this, u);
      }
      WS.AI.steer(this, u, DT);
    }
    // 移動
    for (k = 0; k < n; k++) { i = rev ? n - 1 - k : k; if (units[i].alive) this.moveUnit(units[i], DT); }
    this.resolveCollisions(rev);
    // 戦闘
    for (k = 0; k < n; k++) { i = rev ? n - 1 - k : k; if (units[i].alive) this.combatUnit(units[i], DT); }
    this.updateArrows(DT);
    // 死体
    for (i = units.length - 1; i >= 0; i--) {
      var d = units[i];
      if (!d.alive) { d.deadT += DT; }
    }
    // 再利用（実験）
    this.updateRecycle();
    this.checkVictory();
  };

  P.forceAttack = function (cpuOnly) {
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (!u.alive) continue;
      if (cpuOnly && this.mode === 'pvc' && u.team === 0) continue;
      if (this.corpsMode && !cpuOnly && this.mode === 'pvc' && u.team === 0) continue;   // シンプルモードのプレイヤー部隊は命令を奪わない
      if (u.type === 'king' && (this.stalemateStage < 2 || (this.mode === 'pvc' && u.team === 0))) continue;
      u.order = { type: 'attack', issuedT: this.t };
    }
  };

  // ---------------- 移動 ----------------
  P.moveUnit = function (u, dt) {
    var T = u.T, maxS = this.maxSpeed(u);
    // 狭所・坂による減速
    if (T.narrowPenalty > 0) {
      if (u._crowdT == null || (this.stepCount + u.id) % 4 === 0) { u._crowd = this.crowdFactor(u); u._crowdT = this.stepCount; }
      var crowd = u._crowd;
      maxS *= 1 - T.narrowPenalty * crowd;
    }
    var slope = u.layer === 'ground' ? this.slopeAlong(u) : 0;
    if (u.layer === 'climb') { u.vx = u.vz = 0; u.spd = 0; if (this.fort) this.fort.climbStep(u, dt); return; }
    if (slope > 0) maxS *= Math.max(0.55, 1 - slope * 0.9);
    else maxS *= Math.min(1.15, 1 - slope * 0.4);
    if (u.stunT > 0) { u.stunT -= dt; maxS *= 0.2; }
    if (u.windT > 0 && !MOUNTED[u.type]) maxS *= 0.35;   // 攻撃中は足が鈍る
    var ai = u.ai;
    var wl = hypot(ai.wantX, ai.wantZ);
    var targetSpeed = wl > 1e-4 ? ai.wantSpeed * maxS : 0;
    if (MOUNTED[u.type]) {
      // 乗り物型：向いている方向にしか進めない／旋回に制限
      if (wl > 1e-4) {
        var want = Math.atan2(ai.wantZ, ai.wantX);
        var da = angDiff(u.heading, want);
        // 高速ほど旋回が鈍い（急旋回が苦手）
        var turnRate = T.turn * (1.2 - 0.6 * clamp(u.spd / (T.speed + 0.01), 0, 1));
        u.heading += clamp(da, -turnRate * dt, turnRate * dt);
        // 大きく向きが違うときは減速して曲がる
        var align = Math.cos(da);
        targetSpeed *= align > 0.3 ? (0.35 + 0.65 * align) : 0.25;
      } else if (ai.hasFace) {
        var fa = angDiff(u.heading, Math.atan2(ai.faceZ, ai.faceX));
        u.heading += clamp(fa, -T.turn * dt, T.turn * dt);
      }
      var acc = targetSpeed > u.spd ? T.accel : T.accel * 1.4;
      u.spd += clamp(targetSpeed - u.spd, -acc * dt, acc * dt);
      u.vx = Math.cos(u.heading) * u.spd; u.vz = Math.sin(u.heading) * u.spd;
    } else {
      // 歩兵型：全方向に移動でき、向きは別に制御（後退しながら敵を向く等）
      var tx = wl > 1e-4 ? ai.wantX / wl * targetSpeed : 0, tz = wl > 1e-4 ? ai.wantZ / wl * targetSpeed : 0;
      // 後退・横移動は遅い
      var fwdx = Math.cos(u.heading), fwdz = Math.sin(u.heading);
      if (targetSpeed > 0) { var dot = (tx * fwdx + tz * fwdz) / targetSpeed; var f = dot < -0.2 ? 0.6 : dot < 0.4 ? 0.8 : 1; tx *= f; tz *= f; }
      var dvx = tx - u.vx, dvz = tz - u.vz, dl = hypot(dvx, dvz), a = T.accel * dt;
      if (dl > a) { dvx *= a / dl; dvz *= a / dl; }
      u.vx += dvx; u.vz += dvz;
      u.spd = hypot(u.vx, u.vz);
      var faceAng;
      if (ai.hasFace) faceAng = Math.atan2(ai.faceZ, ai.faceX);
      else if (u.spd > 0.3) faceAng = Math.atan2(u.vz, u.vx);
      if (faceAng != null) { var d2 = angDiff(u.heading, faceAng); u.heading += clamp(d2, -T.turn * dt, T.turn * dt); }
    }
    // ノックバック
    u.x += (u.vx + u.kx) * dt; u.z += (u.vz + u.kz) * dt;
    var kd = Math.exp(-6 * dt); u.kx *= kd; u.kz *= kd;
    // 戦場の端
    var m = u.radius + 0.5;
    if (u.x < -this.W / 2 + m) { u.x = -this.W / 2 + m; if (MOUNTED[u.type]) u.spd *= 0.5; }
    if (u.x > this.W / 2 - m) { u.x = this.W / 2 - m; if (MOUNTED[u.type]) u.spd *= 0.5; }
    if (u.z < -this.D / 2 + m) { u.z = -this.D / 2 + m; if (MOUNTED[u.type]) u.spd *= 0.5; }
    if (u.z > this.D / 2 - m) { u.z = this.D / 2 - m; if (MOUNTED[u.type]) u.spd *= 0.5; }
    u.heading = angDiff(0, u.heading);
    if (this.fort) this.fort.constrain(u);
  };
  P.slopeAlong = function (u) {
    if (u.spd < 0.1 || !this.hills.length) return 0;
    var dx = u.vx / u.spd, dz = u.vz / u.spd;
    return (this.heightAt(u.x + dx, u.z + dz) - this.heightAt(u.x, u.z));
  };
  // 周囲の混雑度（遮蔽物・他兵士）0〜1
  P.crowdFactor = function (u) {
    var r = u.radius + 2.5, c = 0, obs = this.obsIn(u.x - r - 3, u.z - r - 3, u.x + r + 3, u.z + r + 3), i;
    for (i = 0; i < obs.length; i++) {
      var o = obs[i], d; if (o.off || (o.g && this.fort && this.fort.gatePassable(o.g, u))) continue;
      if (o.shape === 'circle') d = hypot(u.x - o.x, u.z - o.z) - o.r;
      else d = Math.max(Math.abs(u.x - o.x) - o.hw, Math.abs(u.z - o.z) - o.hd);
      if (d < r) c += 0.35 * (1 - Math.max(0, d) / r);
    }
    var us = this.queryNear(u.x, u.z, r + 2);
    for (i = 0; i < us.length; i++) {
      var v = us[i]; if (v === u || !v.alive) continue;
      var dd = hypot(u.x - v.x, u.z - v.z) - v.radius;
      if (dd < r) c += 0.12 * (1 - Math.max(0, dd) / r);
    }
    return clamp(c, 0, 1);
  };

  P.resolveObstacle = function (u) {
    var r = u.radius;
    if (u.layer !== 'ground') return;
    var obs = this.obsIn(u.x - r - 1, u.z - r - 1, u.x + r + 1, u.z + r + 1);
    for (var k = 0; k < obs.length; k++) {
      var o = obs[k]; if (o.off || (o.g && this.fort && this.fort.gatePassable(o.g, u))) continue;
      if (o.shape === 'circle') {
        var dx = u.x - o.x, dz = u.z - o.z, d = hypot(dx, dz), m = o.r + r;
        if (d < m) {
          if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
          u.x = o.x + dx / d * m; u.z = o.z + dz / d * m;
          if (MOUNTED[u.type]) u.spd *= 0.7;
        }
      } else {
        var px = u.x - o.x, pz = u.z - o.z, ex = o.hw + r, ez = o.hd + r;
        if (Math.abs(px) < ex && Math.abs(pz) < ez) {
          var ox = ex - Math.abs(px), oz = ez - Math.abs(pz);
          if (ox < oz) u.x = o.x + (px < 0 ? -ex : ex); else u.z = o.z + (pz < 0 ? -ez : ez);
          if (MOUNTED[u.type]) u.spd *= 0.7;
        }
      }
    }
  };

  P.resolveCollisions = function (rev) {
    var us = this.units, n = us.length, self = this;
    for (var it = 0; it < (n > 150 ? 1 : 2); it++) {
      for (var ii = 0; ii < n; ii++) {
        var i = rev ? n - 1 - ii : ii;
        var a = us[i]; if (!a.alive) continue;
        var cand = this.queryNear(a.x, a.z, a.radius + 2.2);
        for (var jj = 0; jj < cand.length; jj++) {
          var b = cand[jj]; if (!b.alive || b === a) continue;
          if ((rev ? b._gi > a._gi : b._gi < a._gi) || b._gi === a._gi) continue;   // 各組は1回だけ
          if (b.layer !== a.layer) continue;
          var dx = b.x - a.x, dz = b.z - a.z, m = a.radius + b.radius;
          if (Math.abs(dx) > m || Math.abs(dz) > m) continue;
          var d = hypot(dx, dz);
          if (d >= m) continue;
          if (d < 1e-4) { dx = this.rng.next() - 0.5; dz = this.rng.next() - 0.5; d = hypot(dx, dz); }
          var ov = (m - d), nx = dx / d, nz = dz / d, tm = a.mass + b.mass;
          var wa = b.mass / tm, wb = a.mass / tm;
          a.x -= nx * ov * wa; a.z -= nz * ov * wa;
          b.x += nx * ov * wb; b.z += nz * ov * wb;
          // 重い騎乗兵が軽い兵にぶつかると相手を押しのける
          if (a.mass > b.mass * 3 && a.spd > 2) { b.kx += nx * a.spd * 0.25; b.kz += nz * a.spd * 0.25; }
          if (b.mass > a.mass * 3 && b.spd > 2) { a.kx -= nx * b.spd * 0.25; a.kz -= nz * b.spd * 0.25; }
          // チャリオット/騎馬が重い相手に正面衝突すると減速
          if (MOUNTED[a.type] && b.mass >= a.mass) a.spd *= 0.85;
          if (MOUNTED[b.type] && a.mass >= b.mass) b.spd *= 0.85;
        }
      }
    }
    for (var k = 0; k < n; k++) if (us[k].alive) { this.resolveObstacle(us[k]); if (this.fort) this.fort.constrain(us[k]); us[k].y = this.unitY(us[k]); }
  };

  // ---------------- 空間分割（近くの兵士だけを調べて高速化） ----------------
  var GCELL = 8;
  // 平らな配列のグリッド（戦場の外にはみ出す分も余裕を持たせる）
  P.buildGrid = function () {
    var us = this.units, k;
    var nx = this._gnx = Math.ceil((this.W + 40) / GCELL) + 1, nz = this._gnz = Math.ceil((this.D + 40) / GCELL) + 1;
    var g = this._garr;
    if (!g || g.length !== nx * nz) { g = this._garr = []; for (k = 0; k < nx * nz; k++) g.push([]); this._gused = []; }
    var used = this._gused;
    for (k = 0; k < used.length; k++) g[used[k]].length = 0;
    used.length = 0;
    var ox = this.W / 2 + 20, oz = this.D / 2 + 20;
    for (var i = 0; i < us.length; i++) {
      var u = us[i]; u._gi = i; if (!u.alive) continue;
      var ci = Math.floor((u.x + ox) / GCELL), cj = Math.floor((u.z + oz) / GCELL);
      if (ci < 0) ci = 0; else if (ci >= nx) ci = nx - 1;
      if (cj < 0) cj = 0; else if (cj >= nz) cj = nz - 1;
      var idx = ci * nz + cj, cell = g[idx];
      if (!cell.length) used.push(idx);
      cell.push(u);
    }
    this._grid = true;
    // 交戦中の兵士がそれぞれの敵を何体で狙っているか（標的の分散用）
    var cnt = this.atkCount || (this.atkCount = {});
    for (k in cnt) cnt[k] = 0;
    for (var j = 0; j < us.length; j++) { var v = us[j]; if (v.alive && v.ai.mode === 'engage' && v.ai.targetId) cnt[v.team + ':' + v.ai.targetId] = (cnt[v.team + ':' + v.ai.targetId] || 0) + 1; }
    this._gridT = this.stepCount;
  };
  var QRING = [], QI = 0;
  for (var qi = 0; qi < 24; qi++) QRING.push([]);
  // 返す配列は使い回す（呼び出し側は次の数回の呼び出しまでしか保持しないこと）
  P.queryNear = function (x, z, r) {
    if (!this._grid) this.buildGrid();
    var out = QRING[QI = (QI + 1) % QRING.length], g = this._garr, nx = this._gnx, nz = this._gnz; out.length = 0;
    var ox = this.W / 2 + 20, oz = this.D / 2 + 20;
    var i0 = Math.floor((x - r + ox) / GCELL), i1 = Math.floor((x + r + ox) / GCELL), j0 = Math.floor((z - r + oz) / GCELL), j1 = Math.floor((z + r + oz) / GCELL);
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (i1 >= nx) i1 = nx - 1; if (j1 >= nz) j1 = nz - 1;
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) { var c = g[i * nz + j]; for (var k = 0; k < c.length; k++) out.push(c[k]); }
    return out;
  };

  // ---------------- 近接戦闘 ----------------
  P.combatUnit = function (u, dt) {
    var T = u.T;
    if (u.atkCool > 0) u.atkCool -= dt;
    if (u.chargeCool > 0) u.chargeCool -= dt;
    if (u.trampleCool > 0) u.trampleCool -= dt;
    if (u.reloadT > 0) u.reloadT -= dt;
    if (u.swingT > 0) u.swingT -= dt;
    // 補給
    if (u.type === 'archer' && u.arrows < T.arrows && !this.fort) {
      var sp = this.supply[u.team];
      if (hypot(u.x - sp.x, u.z - sp.z) < this.cfg.field.supplyRadius) {
        u.refillAcc = (u.refillAcc || 0) + dt;
        if (u.refillAcc >= T.refillTime) { u.refillAcc = 0; u.arrows++; if (u.arrows === T.arrows) this.teamStats[u.team].refills++; }
      }
    }
    // 振りかぶり → 命中判定
    if (u.windT > 0) {
      u.windT -= dt;
      if (u.windT <= 0) {
        var tg = this.unitById(u.windTarget);
        u.swingT = 0.3;
        if (tg && tg.alive) {
          var reach = T.range + u.radius + tg.radius + 0.35;
          if (hypot(tg.x - u.x, tg.z - u.z) <= reach) this.meleeHit(u, tg, false);
          // 象の攻撃は周囲にも及ぶ
          if (u.type === 'elephant') {
            var nbE = this.queryNear(tg.x, tg.z, 4);
            for (var i = 0; i < nbE.length; i++) {
              var o = nbE[i];
              if (o === tg || !o.alive || o.team === u.team) continue;
              if (hypot(o.x - tg.x, o.z - tg.z) < 2.5 && hypot(o.x - u.x, o.z - u.z) < reach + 1) this.meleeHit(u, o, false, T.splash || 0.5);
            }
          }
        }
      }
    }
    // 突撃（騎馬・チャリオット）：高速で敵に接触すると突撃ダメージ
    if ((u.type === 'cavalry' || u.type === 'chariot') && u.spd >= T.chargeMinSpeed * this.spdMult(u) * 0.9 && u.chargeCool <= 0) {
      var best = null, bd = 1e9, nbC = this.queryNear(u.x, u.z, u.radius + 3);
      for (var j = 0; j < nbC.length; j++) {
        var e = nbC[j];
        if (!e.alive || e.team === u.team || e.layer !== u.layer) continue;
        var dx = e.x - u.x, dz = e.z - u.z, d = hypot(dx, dz);
        if (d > u.radius + e.radius + 0.9) continue;
        // 前方にいる相手のみ
        if ((dx * Math.cos(u.heading) + dz * Math.sin(u.heading)) / (d + 1e-6) < 0.4) continue;
        if (d < bd) { bd = d; best = e; }
      }
      if (best) {
        this.meleeHit(u, best, true);
        u.chargeCool = T.chargeCooldown;
        this.teamStats[u.team].charges++; u.s.charges++;
        // 衝突の衝撃
        var ix = Math.cos(u.heading), iz = Math.sin(u.heading);
        var push = u.spd * Math.min(1.5, u.mass / best.mass) * 0.5;
        best.kx += ix * push; best.kz += iz * push; best.stunT = Math.max(best.stunT, 0.6);
        if (u.type === 'cavalry') u.spd *= 0.55; else u.spd *= 0.8;
      }
    }
    // チャリオットの車輪の刃：通過時に側面の敵を斬る
    if (u.type === 'chariot' && u.spd > 5) {
      for (var k2 in u.scytheHit) if (this.t - u.scytheHit[k2] > 1.2) delete u.scytheHit[k2];
      var hx = Math.cos(u.heading), hz = Math.sin(u.heading);
      var nbS = this.queryNear(u.x, u.z, T.scytheRadius + 3);
      for (var q = 0; q < nbS.length; q++) {
        var v = nbS[q];
        if (!v.alive || v.team === u.team || u.scytheHit[v.id] || v.layer !== u.layer) continue;
        var rx = v.x - u.x, rz = v.z - u.z;
        var along = rx * hx + rz * hz, side = Math.abs(-rx * hz + rz * hx);
        if (along > -1.2 && along < 1.0 && side < T.scytheRadius + v.radius && side > 0.6) {
          u.scytheHit[v.id] = this.t;
          var dmg = T.scytheDamage * (u.spd / T.speed) * this.atkMult(u) * this.matchup(u, v);
          this.applyDamage(u, v, dmg, 'scythe', 1);
          this.teamStats[u.team].scytheHits++;
          v.stunT = Math.max(v.stunT, 0.3);
        }
      }
    }
    // 象の踏みつけ・突進：前方の複数の敵を押しのける
    if (u.type === 'elephant' && u.spd > 1.2 && u.trampleCool <= 0) {
      var fx = Math.cos(u.heading), fz = Math.sin(u.heading), hit = 0;
      var nbT = this.queryNear(u.x, u.z, T.trampleRadius + 3);
      for (var w = 0; w < nbT.length; w++) {
        var z2 = nbT[w];
        if (!z2.alive || z2.team === u.team || z2.mass >= u.mass || z2.layer !== u.layer) continue;
        var ax = z2.x - u.x, az = z2.z - u.z, ad = hypot(ax, az);
        if (ad > T.trampleRadius + z2.radius) continue;
        if ((ax * fx + az * fz) / (ad + 1e-6) < 0.2) continue;
        hit++;
        this.applyDamage(u, z2, T.trampleDamage * this.atkMult(u) * (0.6 + 0.4 * u.spd / T.speed), 'trample');
        var nx = ax / (ad + 1e-6) * 0.6 + fx * 0.4, nz = az / (ad + 1e-6) * 0.6 + fz * 0.4;
        z2.kx += nx * T.trampleKnock; z2.kz += nz * T.trampleKnock; z2.stunT = Math.max(z2.stunT, 0.8);
      }
      if (hit) { u.trampleCool = T.trampleCooldown; this.teamStats[u.team].trampleHits += hit; }
    }
  };

  // 攻撃開始（AIから呼ぶ）
  P.tryMelee = function (u, tg) {
    if (u.windT > 0 || u.atkCool > 0 || u.stunT > 0) return false;
    if (tg.layer !== u.layer || u.layer === 'climb') return false;   // 城壁の上と下では斬り合えない
    var d = hypot(tg.x - u.x, tg.z - u.z);
    if (d > u.T.range + u.radius + tg.radius + 0.2) return false;
    var ang = Math.abs(angDiff(u.heading, Math.atan2(tg.z - u.z, tg.x - u.x)));
    var maxAng = MOUNTED[u.type] ? (u.type === 'elephant' ? 1.3 : 1.6) : 1.0;
    if (ang > maxAng) return false;
    u.windT = u.T.windup; u.windTarget = tg.id;
    u.atkCool = u.T.cooldown * this.cooldownMult(u) * (0.9 + 0.2 * this.rng.next());
    return true;
  };

  P.matchup = function (a, b) {
    var m = this.cfg.matchup[a.type]; return m && m[b.type] != null ? m[b.type] : 1;
  };
  // 攻撃方向：0=正面 1=側面 2=背面
  P.hitDirection = function (att, def) {
    var ax = att.x - def.x, az = att.z - def.z, d = hypot(ax, az) + 1e-6;
    var c = (ax * Math.cos(def.heading) + az * Math.sin(def.heading)) / d;
    return c > 0.35 ? 0 : (c < -0.45 ? 2 : 1);
  };

  P.meleeHit = function (u, tg, isCharge, scale) {
    var T = u.T, S = this.cfg.stats, C = this.cfg.combat, r = this.rng;
    var dir = this.hitDirection(u, tg);
    // 回避
    if (!MOUNTED[tg.type] && tg.stunT <= 0) {
      var dodge = tg.T.dodge + S.dodgePerPoint * tg.st.spd + 0.006 * this.brain(tg) + this.dodgeBonus(tg);
      if (tg.routing) dodge *= 0.4;
      if (dir === 2) dodge *= 0.3;
      if (isCharge) dodge *= 0.5;
      if (r.chance(dodge)) { tg.s.dodges++; this.teamStats[tg.team].dodges++; tg.lastDodgeT = this.t; return; }
    }
    var dmg = T.atk * this.atkMult(u) * this.matchup(u, tg) * (scale || 1);
    if (dir === 2) dmg *= C.backstabMult; else if (dir === 1) dmg *= C.flankMult;
    var dh = u.y - tg.y; if (dh > 0.3) dmg *= 1 + Math.min(0.3, dh * C.heightBonusPerM);
    if (isCharge) dmg *= 1 + T.charge * clamp(u.spd / T.speed, 0, 1.2);
    if (u.type === 'chariot' && !isCharge && u.spd < 3) dmg *= T.slowMeleePenalty;
    // 防御（盾）
    if (!C.blockFrontOnly || dir === 0) {
      var block = tg.T.block + S.blockPerPoint * tg.st.def;
      if (tg.windT > 0) block *= 0.5;
      if (isCharge) block *= 0.6;
      if (r.chance(block)) { dmg *= 0.2; tg.s.blocks++; this.teamStats[tg.team].blocks++; tg.lastBlockT = this.t; }
    }
    this.applyDamage(u, tg, dmg, isCharge ? 'charge' : 'melee', dir);
  };

  P.applyDamage = function (src, tg, raw, kind, dir) {
    if (!tg.alive) return;
    var C = this.cfg.combat;
    var dmg = raw * C.damageScale * tg.T.armor * this.defMult(tg) * (1 - C.damageVariance + 2 * C.damageVariance * this.rng.next());
    dmg = Math.max(0.5, dmg);
    dmg = Math.min(dmg, tg.hp);
    tg.hp -= dmg;
    tg.lastHitT = this.t; tg.lastAttackerId = src ? src.id : 0;
    tg.s.dmgTaken += dmg;
    tg._lastDir = dir || 0;
    if (tg.type === 'king') {
      this.teamStats[tg.team].kingDamageTaken += dmg;
      if (!this.kingHurtFlag[tg.team] && tg.hp < tg.maxHp * 0.5) { this.kingHurtFlag[tg.team] = true; if (this.cfg.morale.enabled) this.moraleTeam(tg.team, -this.cfg.morale.kingHurt); }
    }
    if (src) {
      src.s.dmgDealt += dmg;
      if (dir === 1 || dir === 2) src.s.dmgFlank += dmg;
      var key = src.team + '-' + src.corps + '>' + tg.team + '-' + tg.corps;
      this.corpsDmg[key] = (this.corpsDmg[key] || 0) + dmg;
    }
    // 士気：背後・側面からの攻撃、突撃、踏みつけは心理的にも効く
    if (this.cfg.morale.enabled && tg.type !== 'king') {
      var M = this.cfg.morale, loss = kind === 'arrow' ? M.arrowHit : 0;
      if (dir === 2) loss += M.rearHit; else if (dir === 1) loss += M.flankHit;
      if (kind === 'charge') loss += M.chargeHit; else if (kind === 'trample') loss += M.trampleHit;
      if (loss) this.moraleHit(tg, loss);
    }
    if (tg.hp <= 0.01) this.kill(tg, src, kind);
  };

  // ---------------- 士気・敗走（Ciel版） ----------------
  P.moraleLossMult = function (u) {
    var M = this.cfg.morale, m = u.type === 'guard' ? M.guardLossScale : 1;
    if (u.ace) m *= 0.7;
    if (u.leaderCut) m *= 1 - u.leaderCut;
    return m;
  };
  P.moraleFloor = function (u) { return this.buffOn(u, 'iron') ? this.cfg.simple.rally.iron.moraleFloor : 0; };
  P.moraleHit = function (u, loss) {
    if (!u.alive || u.type === 'king') return;
    u.morale = Math.max(this.moraleFloor(u), u.morale - loss * this.moraleLossMult(u));
  };
  P.moraleTeam = function (team, delta) {
    for (var i = 0; i < this.units.length; i++) { var u = this.units[i]; if (u.alive && u.team === team) { if (delta < 0) this.moraleHit(u, -delta); else u.morale = Math.min(100, u.morale + delta); } }
  };
  P.updateMorale = function (dt) {
    var M = this.cfg.morale, us = this.units, n = us.length, i, j;
    var L = this.cfg.simple.ace.leader;
    // 知将エースのオーラ
    var leaders = [];
    for (i = 0; i < n; i++) if (us[i].alive && us[i].ace && us[i].ace.type === 'leader') leaders.push(us[i]);
    for (i = 0; i < n; i++) {
      var u = us[i]; if (!u.alive) continue;
      var lv = 0;
      for (j = 0; j < leaders.length; j++) { var ld = leaders[j]; if (ld !== u && ld.team === u.team && hypot(ld.x - u.x, ld.z - u.z) < L.auraRadius) lv = Math.max(lv, ld.ace.lvl); }
      u.leaderLv = lv; u.leaderCut = lv * L.auraLossCutPerPt;
      var own = u.ace && u.ace.type === 'leader' ? L.brainPerPt * u.ace.lvl : 0;
      u.brainBonus = Math.max(own, own + lv * L.auraBrainPerPt);
    }
    for (i = 0; i < n; i++) {
      var v = us[i]; if (!v.alive || v.type === 'king') continue;
      var e = 0, a = 0, nearE = 1e9, nearKing = false;
      for (j = 0; j < n; j++) {
        var w = us[j]; if (!w.alive || w === v) continue;
        var d = hypot(w.x - v.x, w.z - v.z);
        if (w.team !== v.team) { if (d < nearE) nearE = d; }
        else if (w.type === 'king' && d < 14) nearKing = true;
        if (d > 10) continue;
        var wt = (w.type === 'elephant' ? 3 : MOUNTED[w.type] ? 1.5 : 1) * (w.routing ? 0.3 : 1);
        if (w.team === v.team) a += wt; else e += wt;
      }
      var rate = 0;
      if (e > 0.5 && e > a * 1.3 + 0.5) rate -= clamp((e - a) / (a + 1), 0.3, 2) * M.outnumberedPerSec;
      else if (e > 0 && a > e) rate += M.winningPerSec;
      if (nearE > 25) rate += M.calmPerSec;
      if (nearKing) rate += M.nearKingPerSec;
      if (v.leaderLv) rate += L.auraMoralePerPt * v.leaderLv;
      if (v.routing) {
        if (nearE > 15) rate += 4;
        var sp = this.supply[v.team]; if (hypot(v.x - sp.x, v.z - sp.z) < 12) rate += 3;
      }
      if (rate < 0) rate *= this.moraleLossMult(v);
      v.morale = clamp(v.morale + rate * dt, this.moraleFloor(v), 100);
      if (!v.routing && v.morale < M.routBelow) {
        v.routing = true; v.s.routs++; v.ai.path = null; v.ai.thinkT = 0; v.windT = 0;
        this.routLog.push({ t: this.t, team: v.team, corps: v.corps, type: v.type, id: v.id, rally: false });
      } else if (v.routing && (v.morale >= M.rallyAbove && nearE > 15 || this.buffOn(v, 'iron'))) {
        v.routing = false; v.morale = Math.max(v.morale, M.rallyAbove); v.ai.thinkT = 0;
        this.routLog.push({ t: this.t, team: v.team, corps: v.corps, type: v.type, id: v.id, rally: true });
      }
    }
  };
  // 戦える兵（王以外・敗走していない）
  P.fightingCount = function (team) { var c = 0; for (var i = 0; i < this.units.length; i++) { var u = this.units[i]; if (u.alive && u.team === team && u.type !== 'king' && !u.routing) c++; } return c; };
  P.snapshot = function () {
    var snap = { t: this.t, c: {} };
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i], k = u.team + '-' + u.corps;
      var o = snap.c[k] || (snap.c[k] = { alive: 0, routing: 0, x: 0, z: 0, hp: 0 });
      if (u.alive) { o.alive++; o.x += u.x; o.z += u.z; o.hp += u.hp; if (u.routing) o.routing++; }
    }
    for (var k2 in snap.c) { var q = snap.c[k2]; if (q.alive) { q.x /= q.alive; q.z /= q.alive; } }
    this.snapshots.push(snap);
  };

  P.kill = function (u, src, kind) {
    var wasRouting = u.routing;
    if (this.fort) this.fort.onKill(u, src);
    u.alive = false; u.hp = 0; u.deadT = 0; u.vx = u.vz = 0; u.spd = 0; u.windT = 0; u.routing = false;
    u.s.timeOfDeath = this.t; u.s.killedBy = src ? src.type : null;
    this.lastKillT = this.t;
    this.killLog.push({ t: this.t, kid: src ? src.id : 0, kt: src ? src.team : -1, kc: src ? src.corps : -1, ktype: src ? src.type : null, kace: !!(src && src.ace), vid: u.id, vt: u.team, vc: u.corps, vtype: u.type, kind: kind, dir: u._lastDir || 0, routing: wasRouting, x: u.x, z: u.z, buff: !!(src && (this.buffOn(src, 'charge') || this.buffOn(src, 'iron') || this.buffOn(src, 'rescue'))) });
    if (src && this.killLog[this.killLog.length - 1].buff) src.s.killsWhileBuff++;
    // 士気：近くの味方の死は動揺を、撃破は勢いを生む
    if (this.cfg.morale.enabled) {
      var M = this.cfg.morale;
      for (var q = 0; q < this.units.length; q++) {
        var w = this.units[q]; if (!w.alive) continue;
        var dd = hypot(w.x - u.x, w.z - u.z);
        if (w.team === u.team && dd < 12) this.moraleHit(w, (M.allyDeath + (w.corps === u.corps && u.corps >= 0 ? M.sameCorpsDeath : 0)) * (wasRouting ? 0.6 : 1));
        else if (w.team !== u.team && dd < 10) w.morale = Math.min(100, w.morale + M.allyKillGain);
      }
      if (src && src.alive) src.morale = Math.min(100, src.morale + M.killGain);
      // 部隊の半数喪失
      var ck = u.team + '-' + u.corps;
      if (u.corps >= 0 && !this.corpsHalfFlag[ck] && this.corpsInit && this.corpsInit[ck]) {
        var dead = 0; for (var r = 0; r < this.units.length; r++) { var x = this.units[r]; if (x.team === u.team && x.corps === u.corps && !x.alive) dead++; }
        if (dead >= this.corpsInit[ck] * 0.5) { this.corpsHalfFlag[ck] = this.t; for (var r2 = 0; r2 < this.units.length; r2++) { var y = this.units[r2]; if (y.alive && y.team === u.team && y.corps === u.corps) this.moraleHit(y, M.corpsHalfLoss); } }
      }
    }
    if (!this.firstBlood) this.firstBlood = { t: this.t, by: src ? src.type : '?' };
    var nm = (u.team === 0 ? '青' : '赤') + 'の' + u.T.name;
    if (src) { var km = this.killMatrix[src.type] = this.killMatrix[src.type] || {}; km[u.type] = (km[u.type] || 0) + 1; }
    if (src) { src.s.kills++; this.log((src.team === 0 ? '青' : '赤') + 'の' + src.T.name + 'が' + nm + 'を撃破' + (kind === 'arrow' ? '（矢）' : kind === 'charge' ? '（突撃）' : kind === 'trample' ? '（踏みつけ）' : kind === 'scythe' ? '（車輪刃）' : ''), src.team); }
    else this.log(nm + 'が倒れた', 1 - u.team);
    if (this.cfg.experimental.recycleDefeated && src && src.team !== u.team && u.type !== 'king') {
      this.pendingRecycle.push({ at: this.t + this.cfg.experimental.recycleDelay, team: src.team, type: u.type, st: u.st, fromId: u.id });
    }
  };

  P.updateRecycle = function () {
    for (var i = this.pendingRecycle.length - 1; i >= 0; i--) {
      var p = this.pendingRecycle[i];
      if (this.t < p.at) continue;
      this.pendingRecycle.splice(i, 1);
      var sp = this.supply[p.team], dir = p.team === 0 ? 1 : -1;
      var nu = this.createUnit(p.team, p.type, sp.x + dir * 4 + this.rng.range(-3, 3), sp.z + this.rng.range(-4, 4), { atk: p.st.atk, def: p.st.def, spd: p.st.spd, int: p.st.int });
      nu.hp = nu.maxHp * this.cfg.experimental.recycleHpRatio;
      nu.recycled = true; nu.order = { type: 'attack', issuedT: this.t };
      this.resolveObstacle(nu);
      this._idx = null;
      // 消えた元の死体は早めに消す
      var old = this.unitById(p.fromId); if (old) old.deadT = Math.max(old.deadT, this.cfg.combat.corpseTime);
      this.teamStats[p.team].recycled++;
      this.log((p.team === 0 ? '青' : '赤') + '軍に' + nu.T.name + 'が加わった（再利用）', p.team);
    }
  };

  // ---------------- 矢 ----------------
  // 指定点を狙って矢を放つ（実際の弾道計算／自動追尾なし）
  // 初速 v で届く2つの角度のうち、high=false なら低い方（通常の射撃）。v を返り値に含める
  P.ballistic = function (fx, fy, fz, tx, ty, tz, v, high) {
    var dx = tx - fx, dz = tz - fz, d = hypot(dx, dz), h = ty - fy;
    var v2 = v * v, disc = v2 * v2 - GRAV * (GRAV * d * d + 2 * h * v2);
    if (disc < 0 || d < 0.1) return null;
    var sq = Math.sqrt(disc);
    var ang = Math.atan((v2 + (high ? sq : -sq)) / (GRAV * d));
    var vh = v * Math.cos(ang);
    return { vx: dx / d * vh, vy: v * Math.sin(ang), vz: dz / d * vh, time: d / vh, ang: ang, v: v };
  };
  // 発射角 ang を決めて、目標に届く初速を逆算する（曲射用）。必要な初速が vmax を超えるなら null
  P.ballisticAtAngle = function (fx, fy, fz, tx, ty, tz, ang, vmax) {
    var dx = tx - fx, dz = tz - fz, d = hypot(dx, dz), h = ty - fy;
    if (d < 0.1) return null;
    var c = Math.cos(ang), den = 2 * c * c * (d * Math.tan(ang) - h);
    if (den <= 0) return null;
    var v = Math.sqrt(GRAV * d * d / den);
    if (!(v <= vmax)) return null;
    var vh = v * c;
    return { vx: dx / d * vh, vy: v * Math.sin(ang), vz: dz / d * vh, time: d / vh, ang: ang, v: v };
  };
  // 弾道上に味方がいないか（高さも見る：頭上を越える曲射なら当たらない）
  P.trajectoryFriendClear = function (u, fx, fy, fz, b) {
    var d = hypot(b.vx, b.vz) * b.time, n = Math.max(8, Math.ceil(d / 0.4));
    // 射線（地面に投影した線分）の近くにいる味方だけを候補にする
    var ex = fx + b.vx * b.time, ez = fz + b.vz * b.time, L2 = (ex - fx) * (ex - fx) + (ez - fz) * (ez - fz);
    var all = this.queryNear((fx + ex) / 2, (fz + ez) / 2, d / 2 + 3), us = [];
    for (var q = 0; q < all.length; q++) {
      var w = all[q]; if (!w.alive || w.team !== u.team || w === u) continue;
      var tt = L2 > 0 ? clamp(((w.x - fx) * (ex - fx) + (w.z - fz) * (ez - fz)) / L2, 0, 1) : 0;
      if (hypot(fx + (ex - fx) * tt - w.x, fz + (ez - fz) * tt - w.z) < w.radius + 0.8) us.push(w);
    }
    if (!us.length) return true;
    for (var i = 1; i < n; i++) {
      var t = b.time * i / n, x = fx + b.vx * t, y = fy + b.vy * t - 0.5 * GRAV * t * t, z = fz + b.vz * t;
      var trav = d * i / n;
      if (trav < 0.8 || trav > d - 0.7) continue;          // 射手の足元と、目標の体そのものは見ない（乱戦では角度を上げて味方の頭越しに落とす）
      for (var k = 0; k < us.length; k++) {
        var v = us[k];
        if (hypot(x - v.x, z - v.z) < v.radius + 0.6 && y < v.y + v.height + 0.6) return false;   // 照準のぶれを見込んで少し余裕を持たせる
      }
    }
    return true;
  };
  // 弾道上に遮蔽物がないか（サンプリング）
  P.trajectoryClear = function (fx, fy, fz, b, stopFrac) {
    // 0.4mごとに調べる（速い矢でも薄い壁を見逃さないように）。弾道の範囲に入る遮蔽物だけを調べる
    var ex = fx + b.vx * b.time, ez = fz + b.vz * b.time, mnx = Math.min(fx, ex) - 1, mxx = Math.max(fx, ex) + 1, mnz = Math.min(fz, ez) - 1, mxz = Math.max(fz, ez) + 1;
    var n = Math.max(6, Math.ceil(hypot(b.vx, b.vz) * b.time / 0.4)), all = this.obsIn(mnx, mnz, mxx, mxz), obs = [];
    for (var q = 0; q < all.length; q++) {
      var ob = all[q]; if (ob.off) continue;
      var rx = ob.shape === 'circle' ? (ob.canopyR || ob.r) : ob.hw, rz = ob.shape === 'circle' ? rx : ob.hd;
      if (ob.x + rx < mnx || ob.x - rx > mxx || ob.z + rz < mnz || ob.z - rz > mxz) continue;
      obs.push(ob);
    }
    var px = fx, py = fy, pz = fz;
    for (var i = 1; i <= n * (stopFrac || 0.97); i++) {
      var t = b.time * i / n;
      var x = fx + b.vx * t, y = fy + b.vy * t - 0.5 * GRAV * t * t, z = fz + b.vz * t;
      if (y < this.heightAt(x, z) - 0.2 && i < n * 0.92) return false;
      for (var k = 0; k < obs.length; k++) {
        var o = obs[k];
        if (y > o.y0 + o.h + 0.3) continue;
        if (o.shape === 'circle') { if (hypot(x - o.x, z - o.z) < (o.canopyR || o.r)) return false; }
        else if (Math.abs(x - o.x) < o.hw && Math.abs(z - o.z) < o.hd) return false;
      }
      px = x; py = y; pz = z;
    }
    return true;
  };
  P.fireArrow = function (u, vx, vy, vz) {
    var T = u.T, h = u.y + 1.5;
    var fx = u.x + Math.cos(u.heading) * 0.5, fz = u.z + Math.sin(u.heading) * 0.5;
    this.arrows.push({ x: fx, y: h, z: fz, vx: vx, vy: vy, vz: vz, team: u.team, owner: u.id, alive: true, t: 0, stuckT: 0, dmg: T.arrowDamage * this.atkMult(u), oy: h });
    if (!(this.fort && u.layer === 'wall')) u.arrows--;   // 城壁の上では矢は無制限
    u.reloadT = T.reload * this.cooldownMult(u) * (0.9 + 0.2 * this.rng.next());
    u.swingT = 0.3;
    u.s.arrowsFired++; this.teamStats[u.team].arrowsFired++;
  };
  P.updateArrows = function (dt) {
    var arrows = this.arrows, units = this.units, obs = this.obstacles;
    var SUB = 3, sdt = dt / SUB;
    for (var a = arrows.length - 1; a >= 0; a--) {
      var ar = arrows[a];
      if (!ar.alive) { ar.stuckT += dt; if (ar.stuckT > 6) arrows.splice(a, 1); continue; }
      for (var s = 0; s < SUB && ar.alive; s++) {
        var ox = ar.x, oy = ar.y, oz = ar.z;
        ar.vy -= GRAV * sdt;
        ar.x += ar.vx * sdt; ar.y += ar.vy * sdt; ar.z += ar.vz * sdt; ar.t += sdt;
        // 兵士との当たり判定（縦長の円柱）
        var hitU = null, hitT = 2, cand = this.queryNear(ar.x, ar.z, 3.5);
        for (var i = 0; i < cand.length; i++) {
          var u = cand[i];
          if (!u.alive || u.id === ar.owner) continue;
          // 線分と円の最近接
          var dx = ar.x - ox, dz = ar.z - oz, L2 = dx * dx + dz * dz;
          var t = L2 > 0 ? clamp(((u.x - ox) * dx + (u.z - oz) * dz) / L2, 0, 1) : 0;
          var cx = ox + dx * t, cz = oz + dz * t;
          var rr = u.radius * (MOUNTED[u.type] ? 1.0 : 0.85) + 0.05;
          if (hypot(cx - u.x, cz - u.z) > rr) continue;
          var y = oy + (ar.y - oy) * t;
          if (y < u.y - 0.1 || y > u.y + u.height) continue;
          if (t < hitT) { hitT = t; hitU = u; }
        }
        if (hitU) {
          ar.alive = false;
          ar.x = ox + (ar.x - ox) * hitT; ar.y = oy + (ar.y - oy) * hitT; ar.z = oz + (ar.z - oz) * hitT;
          ar.stuckOn = hitU.id; ar.relX = ar.x - hitU.x; ar.relY = ar.y - hitU.y; ar.relZ = ar.z - hitU.z;
          var owner = this.unitById(ar.owner);
          if (hitU.team === ar.team) {
            // 味方への直撃は無傷・矢はそこで停止
            this.teamStats[ar.team].arrowsHitFriend++; if (owner) owner.s.friendlyBlocked++;
          } else {
            this.teamStats[ar.team].arrowsHitEnemy++; if (owner) owner.s.arrowsHit++;
            var dmg = ar.dmg * (owner ? this.matchup(owner, hitU) : 1);
            var dir = owner ? this.hitDirection({ x: ar.x - ar.vx, z: ar.z - ar.vz }, hitU) : 0;
            if (dir === 2) dmg *= 1.25;
            // 盾は正面からの矢を防ぐ
            if (dir === 0 && (hitU.type === 'guard' || hitU.type === 'king')) {
              var bl = hitU.T.block * 1.5 + this.cfg.stats.blockPerPoint * hitU.st.def;
              if (this.rng.chance(bl)) { dmg *= 0.15; hitU.s.blocks++; this.teamStats[hitU.team].blocks++; }
            }
            if (ar.oy - hitU.y > 1.5) dmg *= 1 + Math.min(0.25, (ar.oy - hitU.y) * this.cfg.combat.heightBonusPerM * 0.5);
            this.applyDamage(owner || null, hitU, dmg, 'arrow', dir);
          }
          break;
        }
        // 地面・遮蔽物
        var gy = this.heightAt(ar.x, ar.z);
        if (ar.y <= gy) { ar.alive = false; ar.y = gy + 0.05; this.teamStats[ar.team].arrowsMissed++; break; }
        obs = this.obsIn(ar.x - 3, ar.z - 3, ar.x + 3, ar.z + 3);
        for (var k = 0; k < obs.length; k++) {
          var o = obs[k]; if (o.off) continue;
          if (ar.y > o.y0 + o.h) continue;
          var inside = o.shape === 'circle' ? hypot(ar.x - o.x, ar.z - o.z) < (o.canopyR && ar.y > o.y0 + 2 ? o.canopyR : o.r) : (Math.abs(ar.x - o.x) < o.hw && Math.abs(ar.z - o.z) < o.hd);
          if (inside) { ar.alive = false; this.teamStats[ar.team].arrowsMissed++; break; }
        }
        if (Math.abs(ar.x) > this.W / 2 + 20 || Math.abs(ar.z) > this.D / 2 + 20 || ar.t > 15) { ar.alive = false; ar.stuckT = 99; }
      }
    }
  };

  // ---------------- 勝敗 ----------------
  P.checkVictory = function () {
    var kingAlive = [false, false], hasKing = [false, false], alive = [0, 0];
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (u.type === 'king') { hasKing[u.team] = true; if (u.alive) kingAlive[u.team] = true; }
      if (u.alive) alive[u.team]++;
    }
    var w = null, reason = '';
    var dead0 = (hasKing[0] && !kingAlive[0]) || alive[0] === 0;
    var dead1 = (hasKing[1] && !kingAlive[1]) || alive[1] === 0;
    if (dead0 && dead1) { w = -1; reason = '両軍の継続不能（引き分け）'; }
    else if (dead1) { w = 0; reason = (hasKing[1] && !kingAlive[1]) ? '赤軍の王を討ち取った' : '赤軍が全滅'; }
    else if (dead0) { w = 1; reason = (hasKing[0] && !kingAlive[0]) ? '青軍の王を討ち取った' : '青軍が全滅'; }
    else if (this.cfg.morale.enabled && this.t > 15 && this.initCount && this.surrenderCheck()) {
      w = 1 - this.surrendered; reason = (this.surrendered === 0 ? '青軍' : '赤軍') + 'が降伏（戦える兵が尽き、戦意を失った）';
    }
    else if (this.cfg.morale.enabled && this.t > 30 && this.noMeleeCheck()) {
      // 両軍とも近接で戦える兵が尽き、弓兵の撃ち合いだけが続く → 決め手がないので残存戦力で判定
      var sc0 = [this.strength(0), this.strength(1)];
      w = Math.abs(sc0[0] - sc0[1]) < 0.02 * Math.max(sc0[0], sc0[1]) ? -1 : (sc0[0] > sc0[1] ? 0 : 1);
      reason = '両軍とも近接部隊が尽きたため残存戦力で判定（青 ' + sc0[0].toFixed(0) + ' / 赤 ' + sc0[1].toFixed(0) + '）';
    }
    else if (this.t >= this.cfg.combat.timeLimit) {
      var sc = [this.strength(0), this.strength(1)];
      w = Math.abs(sc[0] - sc[1]) < 0.02 * Math.max(sc[0], sc[1]) ? -1 : (sc[0] > sc[1] ? 0 : 1);
      reason = '制限時間到達：残存戦力で判定（青 ' + sc[0].toFixed(0) + ' / 赤 ' + sc[1].toFixed(0) + '）';
    }
    if (w !== null) { this.state = 'over'; this.winner = w; this.endReason = reason; this.log('決着：' + reason); }
  };
  var MELEE_T = { infantry: 1, guard: 1, cavalry: 1, elephant: 1, chariot: 1 };
  P.noMeleeCheck = function () {
    var m = [0, 0];
    for (var i = 0; i < this.units.length; i++) { var u = this.units[i]; if (u.alive && !u.routing && MELEE_T[u.type]) m[u.team]++; }
    if (m[0] === 0 && m[1] === 0) { if (this._noMeleeT == null) this._noMeleeT = this.t; return this.t - this._noMeleeT > 15; }
    this._noMeleeT = null; return false;
  };
  P.surrenderCheck = function () {
    var M = this.cfg.morale, f = [this.fightingCount(0), this.fightingCount(1)];
    for (var tm = 0; tm < 2; tm++) {
      var lim = Math.max(2, Math.ceil(this.initCount[tm] * M.surrenderRatio));
      if (f[tm] <= lim && f[1 - tm] >= f[tm] * M.surrenderEnemyMult + 3) { this.surrendered = tm; return true; }
    }
    return false;
  };
  P.strength = function (team) {
    var s = 0;
    for (var i = 0; i < this.units.length; i++) { var u = this.units[i]; if (u.alive && u.team === team) s += u.hp / u.maxHp * (u.T.hp + u.T.atk * 5); }
    return s;
  };

  // ---------------- 結果集計 ----------------
  P.summary = function () {
    var res = { winner: this.winner, reason: this.endReason, time: this.t, seed: this.seed, teams: [], firstBlood: this.firstBlood, killMatrix: this.killMatrix, surrendered: this.surrendered };
    for (var team = 0; team < 2; team++) {
      var byType = {}, alive = 0, total = 0, dmg = 0, brainAlive = 0, brainDead = 0, nA = 0, nD = 0;
      TYPES.concat(['general']).forEach(function (t) { byType[t] = { total: 0, alive: 0, dead: 0, kills: 0, dmgDealt: 0, dmgTaken: 0 }; });
      for (var i = 0; i < this.units.length; i++) {
        var u = this.units[i]; if (u.team !== team) continue;
        var b = byType[u.type]; b.total++; total++;
        if (u.alive) { b.alive++; alive++; brainAlive += u.st.int; nA++; } else { b.dead++; brainDead += u.st.int; nD++; }
        b.kills += u.s.kills; b.dmgDealt += u.s.dmgDealt; b.dmgTaken += u.s.dmgTaken; dmg += u.s.dmgDealt;
      }
      var ts = this.teamStats[team], routs = 0;
      for (var q = 0; q < this.routLog.length; q++) if (this.routLog[q].team === team && !this.routLog[q].rally) routs++;
      res.teams.push({ alive: alive, total: total, byType: byType, dmgDealt: dmg, stats: ts, routs: routs,
        arrowAccuracy: ts.arrowsFired ? ts.arrowsHitEnemy / ts.arrowsFired : 0,
        avgBrainAlive: nA ? brainAlive / nA : 0, avgBrainDead: nD ? brainDead / nD : 0 });
    }
    return res;
  };
})(typeof window !== 'undefined' ? window : globalThis);
