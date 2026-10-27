// ============================================================
//  WarSimulation 検証版 — 兵士AI / CPU指揮官
//  think(): 状況判断（頭脳に応じて精度・考慮要素が変わる）
//  steer(): 判断結果を移動・攻撃・射撃に変換（毎フレーム）
// ============================================================
(function (G) {
  var WS = G.WS = G.WS || {};
  var clamp = WS.clamp, angDiff = WS.angDiff, hypot = WS.hypot, MOUNTED = WS.MOUNTED;

  // 兵種ごとの標的の好み（頭脳が高いほど強く反映）
  var PREF = {
    infantry: { archer: 0.6, king: 1.6, infantry: 0.3, guard: 0.0, cavalry: -0.1, elephant: -0.6, chariot: -0.1 },
    guard:    { archer: 0.2, king: 1.2, infantry: 0.3, guard: 0.1, cavalry: 0.3, elephant: -0.3, chariot: 0.2 },
    king:     { archer: 0.3, king: 1.0, infantry: 0.2, guard: 0.0, cavalry: 0.0, elephant: -1.0, chariot: 0.0 },
    archer:   { archer: 0.5, king: 1.4, infantry: 0.2, guard: -0.3, cavalry: 0.5, elephant: 0.3, chariot: 0.3 },
    cavalry:  { archer: 1.6, king: 1.4, infantry: 0.0, guard: -0.5, cavalry: 0.2, elephant: -1.6, chariot: 0.3 },
    chariot:  { archer: 1.2, king: 1.1, infantry: 0.9, guard: -0.4, cavalry: -0.4, elephant: -2.0, chariot: 0.0 },
    elephant: { archer: 0.3, king: 1.2, infantry: 0.8, guard: 0.5, cavalry: 0.8, elephant: 0.0, chariot: 0.6 }
  };

  var AI = WS.AI = {};
  AI._h = {};   // 城壁戦（fortress.js）から使う内部関数

  // 主目標（シンプルモードの部隊作戦）で優先する兵種
  var FOCUS = {
    archer: { archer: 1 },
    mounted: { cavalry: 1, chariot: 1 },
    infantry: { infantry: 1 },
    elephant: { elephant: 1 },
    king: { king: 1 }
  };
  AI.FOCUS = FOCUS;
  function isFocus(ctx, e) { return ctx.focusType && FOCUS[ctx.focusType] && FOCUS[ctx.focusType][e.type]; }

  // ---------- 知覚 ----------
  function perceive(sim, u) {
    var enemies = [], allies = [], sight = u.T.sight * (1 + 0.04 * (sim.brain(u) - 5));
    var nearE = 0, nearA = 0, ne = null, neD = 1e9, fort = sim.fort;
    // 城壁戦（大人数）は近くの兵士だけを調べる（空間分割）。見えていない敵は知覚しない。旧ルールは従来どおり全員を調べる
    var us = fort ? sim.queryNear(u.x, u.z, Math.max(sight, 40)) : sim.units;
    for (var i = 0; i < us.length; i++) {
      var v = us[i]; if (!v.alive || v === u) continue;
      if (fort && v.team !== u.team && !v.vis[u.team]) continue;
      var d = hypot(v.x - u.x, v.z - u.z);
      if (v.team !== u.team) {
        if (d < sight) enemies.push({ u: v, d: d });
        if (d < 10) nearE += v.type === 'elephant' ? 3 : MOUNTED[v.type] ? 1.5 : 1;
        if (d < neD) { neD = d; ne = v; }
      } else {
        allies.push({ u: v, d: d });
        if (d < 10) nearA += v.type === 'elephant' ? 3 : MOUNTED[v.type] ? 1.5 : 1;
      }
    }
    if (fort && !ne) {
      // 近くに敵がいなければ、見えている敵の中で最も近い敵（遠くの敵の方向を知るため）
      var all = sim.units;
      for (var j = 0; j < all.length; j++) { var w = all[j]; if (!w.alive || w.team === u.team || !w.vis[u.team]) continue; var dd = hypot(w.x - u.x, w.z - u.z); if (dd < neD) { neD = dd; ne = w; } }
    }
    return { enemies: enemies, allies: allies, nearE: nearE, nearA: nearA + 1, nearest: ne, nearestD: neD };
  }
  AI.perceive = perceive;
  AI._h.perceive = perceive;

  // 何人の味方がその敵を狙っているか
  function attackersOn(sim, e, team) {
    return (sim.atkCount && sim.atkCount[team + ':' + e.id]) || 0;   // 毎フレームまとめて数えた値（sim.buildGrid）
  }
  // 敵の周囲の敵味方の数（数的不利の判定用）
  function localBalance(sim, x, z, team, r) {
    var a = 0, e = 0, us = sim.queryNear(x, z, r);
    for (var i = 0; i < us.length; i++) {
      var v = us[i]; if (!v.alive) continue;
      if (hypot(v.x - x, v.z - z) > r) continue;
      var w = v.type === 'elephant' ? 3 : MOUNTED[v.type] ? 1.5 : 1;
      if (v.team === team) a += w; else e += w;
    }
    return { a: a, e: e };
  }

  // ---------- 標的評価（単純な「最寄り」ではない） ----------
  function scoreTarget(sim, u, e, d, b, ctx) {
    var bf = b / 10;                    // 頭脳による考慮の重み
    if (ctx.nearest) {
      // 城壁戦の「攻撃」作戦：最も近い敵を優先（目標の切り替えすぎと群がりすぎだけ避ける）
      var sn = -d + (u.ai.targetId === e.id ? 3 : 0) + (ctx.prefer && ctx.prefer(e) || 0);
      if (!MOUNTED[u.type] && u.type !== 'archer') { var na = attackersOn(sim, e, u.team), cp = e.type === 'elephant' ? 6 : MOUNTED[e.type] ? 4 : 3; if (na >= cp) sn -= (na - cp + 1) * 3; }
      return sn + sim.rng.gauss() * 0.8;
    }
    var pref = PREF[u.type] || PREF.infantry;
    var s = -d * (u.type === 'cavalry' || u.type === 'chariot' ? 0.35 : 1.0);
    s += (pref[e.type] || 0) * 10 * (0.3 + 0.7 * bf);
    s += (1 - e.hp / e.maxHp) * 8 * bf;                          // 弱った敵を仕留める
    if (ctx.myKing) {
      var kd = hypot(e.x - ctx.myKing.x, e.z - ctx.myKing.z);
      if (kd < 18) s += (18 - kd) * 1.2 * bf;                    // 王に迫る敵を優先
    }
    if (e.type === 'king') s += 6 * bf;
    if (u.ai.targetId === e.id) s += 6;                          // 目標の切り替えすぎ防止
    if (!MOUNTED[u.type] && u.type !== 'archer') {
      var n = attackersOn(sim, e, u.team);
      var cap = e.type === 'elephant' ? 6 : MOUNTED[e.type] ? 4 : 3;
      if (n >= cap) s -= (n - cap + 1) * 7 * bf;                  // 群がりすぎず分散・包囲
    }
    if (b >= 3) {
      var lb = localBalance(sim, e.x, e.z, u.team, 8);
      s -= Math.max(0, lb.e - lb.a - 1) * 2.5 * bf;               // 敵の密集地に単独で突っ込まない
    }
    if (u.type === 'elephant') { var lbE = localBalance(sim, e.x, e.z, u.team, 5); s += lbE.e * 1.2 * bf; }
    if (u.type === 'cavalry' || u.type === 'chariot') {
      if (sim.crowdFactor(e) > 0.5) s -= 6 * bf;                 // 狭い場所の敵は避ける
    }
    if (ctx.flankBonus) {                                         // 回り込み中：敵後方の目標を優先
      var dir = e.team === 0 ? 1 : -1, ec = ctx.enemyCenter;
      s += clamp((ec.x - e.x) * dir, -10, 15) * 0.8;
    }
    // 部隊作戦の主目標：頭脳が高いほど、命令どおりの相手を的確に選ぶ
    if (isFocus(ctx, e)) s += (e.type === 'king' ? 22 : 16) * (0.45 + 0.55 * bf);
    // 担当の戦線（左翼・中央・右翼）から大きく外れた敵は追わない
    if (ctx.laneZ != null) s -= Math.max(0, Math.abs(e.z - ctx.laneZ) - (ctx.laneW || 20)) * 0.3 * (0.4 + 0.6 * bf);
    if (e.routing) s -= 3 * bf;                                   // 逃げる敵より、戦っている敵を優先
    s += sim.rng.gauss() * Math.max(0.5, 7 - 0.6 * b);           // 頭脳が低いと判断がぶれる
    return s;
  }

  function pickMeleeTarget(sim, u, P, b, maxD, ctx, filterFn) {
    var best = null, bs = -1e9;
    for (var i = 0; i < P.enemies.length; i++) {
      var en = P.enemies[i];
      if (en.d > maxD) continue;
      if (filterFn && !filterFn(en.u)) continue;
      if (ctx.reach && !ctx.reach(en.u)) continue;     // 城壁戦：城壁の上や閉じた扉の向こうの敵は近接では狙えない
      var s = scoreTarget(sim, u, en.u, en.d, b, ctx);
      if (s > bs) { bs = s; best = en.u; }
    }
    return best;
  }

  AI._h.setGoal = function (u, x, z, speed, mode) { setGoal(u, x, z, speed, mode); };
  AI._h.setEngage = function (u, e) { setEngage(u, e); };
  AI._h.localBalance = function (sim, x, z, team, r) { return localBalance(sim, x, z, team, r); };
  function setGoal(u, x, z, speed, mode) {
    u.ai.mode = mode || 'move'; u.ai.goalX = x; u.ai.goalZ = z; u.ai.goalSpeed = speed == null ? 1 : speed; u.ai.targetId = 0;
  }
  function setEngage(u, e) { u.ai.mode = 'engage'; u.ai.targetId = e.id; u.ai.goalSpeed = 1; }

  // 遮蔽物の陰（敵弓兵の射線を避ける位置）を探す
  function findCover(sim, u, fromX, fromZ, nearX, nearZ, maxR) {
    var best = null, bd = 1e9, obs = sim.obstacles;
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      if (o.kind === 'rock' && o.h < 1.8) continue;
      var d = hypot(o.x - nearX, o.z - nearZ);
      if (d > maxR) continue;
      var dx = o.x - fromX, dz = o.z - fromZ, L = hypot(dx, dz) + 1e-6;
      var size = o.shape === 'circle' ? (o.canopyR ? o.r : o.r) : Math.max(o.hw, o.hd) * 0.7;
      var px = o.x + dx / L * (size + u.radius + 0.8), pz = o.z + dz / L * (size + u.radius + 0.8);
      if (sim.pointBlocked(px, pz, u.radius)) continue;
      if (d < bd) { bd = d; best = { x: px, z: pz }; }
    }
    return best;
  }
  function enemyArcherCenter(sim, team) {
    var x = 0, z = 0, n = 0;
    for (var i = 0; i < sim.units.length; i++) { var v = sim.units[i]; if (v.alive && v.team !== team && v.type === 'archer' && v.arrows > 0) { x += v.x; z += v.z; n++; } }
    return n ? { x: x / n, z: z / n, n: n } : null;
  }

  // ============================================================
  AI.think = function (sim, u) {
    thinkCore(sim, u);
    if (sim.fort) sim.fort.postThink(sim, u);
  };
  function thinkCore(sim, u) {
    var cfg = sim.cfg, b = sim.brain(u), ai = u.ai;
    if (ai.retreatCD > 0) ai.retreatCD -= 1;
    var P = perceive(sim, u);
    var myKing = sim.king(u.team);
    var ctx = { myKing: myKing, enemyCenter: sim.enemyCenter(u.team) };
    if (sim.fort && sim.fort.think(sim, u, P, ctx)) return;    // 城壁戦：角笛・特別命令・作戦をここで兵士の命令に変換（自分で処理したら true）
    var order = u.order || { type: 'attack' };
    if (u.routing) return thinkRout(sim, u, P, b);
    ctx.focusType = order.focusType; ctx.laneZ = order.laneZ; ctx.laneW = order.laneW;
    ctx.nearest = !!order.nearest;
    // 指定目標が死んだら総攻撃へ
    if (order.type === 'attackTarget') { var tt = sim.unitById(order.targetId); if (!tt || !tt.alive) { order = u.order = { type: 'attack', issuedT: sim.t }; } }
    if ((order.type === 'guardKing') && !myKing) order = u.order = { type: 'attack', issuedT: sim.t };

    // ---- 命令からの逸脱（頭脳が低いほど起こりやすい）----
    if (ai.deviateT > 0) ai.deviateT -= 1;
    var devP = Math.max(0, cfg.ai.orderDeviationBase - cfg.ai.orderDeviationPerBrain * b) * (cfg.ai.deviationScale != null ? cfg.ai.deviationScale : 1);
    if (u.type !== 'king' && order.type !== 'attack' && !(ai.deviateT > 0) && P.nearestD < 25 && sim.rng.chance(devP * 0.3 * clamp(ai.thinkT / 0.6, 0.3, 2))) {   // 判断の回数ではなく時間あたりの確率にする（頭の良い兵は判断が速い分、回数が多いため）
      ai.deviateT = 3 + Math.round(sim.rng.next() * 4); u.s.deviations++; sim.teamStats[u.team].deviations++;
    }
    if (ai.deviateT > 0 && P.nearest) { ai.note = '命令逸脱（独断で突撃）'; setEngage(u, P.nearest); return; }

    if (u.type === 'king') return thinkKing(sim, u, P, b, order, ctx);
    if (u.type === 'archer') return thinkArcher(sim, u, P, b, order, ctx);
    if (order.type === 'guardKing') return thinkGuard(sim, u, P, b, order, ctx, myKing);
    return thinkFighter(sim, u, P, b, order, ctx);
  }

  // ---------- 敗走（士気崩壊）：本陣へ逃げる。追い詰められたときだけ抵抗 ----------
  function thinkRout(sim, u, P, b) {
    var ai = u.ai, sp = sim.supply[u.team];
    ai.note = '敗走中（士気 ' + Math.round(u.morale) + '）';
    if (P.nearest && P.nearestD < 1.6 + P.nearest.radius && sim.rng.chance(0.25)) { setEngage(u, P.nearest); ai.note = '敗走中：追いつかれて抵抗'; return; }
    var ox = ((u.id * 7) % 11 - 5) * 1.6, oz = ((u.id * 13) % 9 - 4) * 1.6;
    var dir = u.team === 0 ? 1 : -1;
    setGoal(u, sp.x + dir * 3 + ox, sp.z + oz, 1, 'rout');
  }
  // ---------- 騎馬兵：消耗したら乱戦を離れて再集結し、息を整えてから再突撃 ----------
  function considerRegroup(sim, u, P, b, order) {
    var ai = u.ai;
    if (u.type !== 'cavalry') return false;
    if (ai.mode === 'regroup') {
      var done = u.hp >= u.maxHp * 0.62 || sim.t - ai.regroupStart > 14;
      if (!done) {
        // 安全な場所では少しずつ回復（息を整える）
        if (P.nearestD > 22 && u.hp < u.maxHp * 0.62) u.hp = Math.min(u.maxHp * 0.62, u.hp + 2.2 * (ai.lastThink ? sim.t - ai.lastThink : 0.5));
        ai.lastThink = sim.t;
        if (P.nearest && P.nearestD < 3 + P.nearest.radius && P.nearest.type !== 'archer') { /* 追いつかれたら駆け抜けて逃げる */ }
        ai.note = '再集結中（体力回復）';
        return true;
      }
      ai.mode = 'idle'; ai.regroupCD = sim.t + 22; ai.note = '再集結完了・再突撃';
      return false;
    }
    if (ai.regroupCD && sim.t < ai.regroupCD) return false;
    if (order.type === 'attackTarget' || order.type === 'guardKing') return false;
    if (u.hp > u.maxHp * (0.24 + 0.02 * b)) return false;          // 頭脳が高いほど早めに見切る
    // 味方の後方（自陣側）の集結点へ
    var dirHome = u.team === 0 ? -1 : 1;
    var rx = clamp(u.x + dirHome * (26 + b), -sim.W / 2 + 4, sim.W / 2 - 4);
    var rz = clamp(u.z * 0.85, -sim.D / 2 + 4, sim.D / 2 - 4);
    setGoal(u, rx, rz, 1, 'regroup'); ai.regroupStart = sim.t; ai.lastThink = sim.t; ai.note = '乱戦から離脱して再集結';
    return true;
  }

  // ---------- 一時後退の判断 ----------
  function considerRetreat(sim, u, P, b) {
    var cfg = sim.cfg, ai = u.ai;
    if (ai.mode === 'retreat') {
      if (sim.t - ai.retreatStart > cfg.ai.maxRetreatTime || P.nearestD > 12) { ai.mode = 'idle'; ai.retreatCD = 10 + 10 * (1 - b / 10); return false; }
      return true;
    }
    if (b < 3 || ai.retreatCD > 0 || u.type === 'elephant') return false;
    var ratio = u.hp / u.maxHp;
    if (ratio > cfg.ai.retreatHpRatio) return false;
    if (P.nearE <= P.nearA + 0.5) return false;                 // 数的に互角以上なら踏みとどまる
    // 味方のいる方向へ下がる
    var ax = 0, az = 0, n = 0;
    for (var i = 0; i < P.allies.length; i++) if (P.allies[i].d < 30) { ax += P.allies[i].u.x; az += P.allies[i].u.z; n++; }
    var dir = u.team === 0 ? -1 : 1;
    var gx = n ? ax / n : u.x + dir * 12, gz = n ? az / n : u.z;
    if (hypot(gx - u.x, gz - u.z) < 4) { gx = u.x + dir * 10; gz = u.z; }
    setGoal(u, clamp(gx, -sim.W / 2 + 2, sim.W / 2 - 2), gz, 1, 'retreat');
    ai.retreatStart = sim.t; ai.note = '劣勢のため一時後退';
    sim.teamStats[u.team].retreats++;
    return true;
  }

  // ---------- 歩兵・側近・騎馬・象・チャリオット ----------
  function thinkFighter(sim, u, P, b, order, ctx) {
    var cfg = sim.cfg, ai = u.ai, type = order.type;
    if (considerRegroup(sim, u, P, b, order)) return;
    if (considerRetreat(sim, u, P, b)) return;
    // 主目標が視界外にいる場合：指揮官の情報で目標へ向かう（目前の敵には対処）
    if (type === 'attack' && ctx.focusType) {
      var hasFocus = false;
      for (var fi = 0; fi < P.enemies.length; fi++) if (isFocus(ctx, P.enemies[fi].u)) { hasFocus = true; break; }
      if (!hasFocus && !(P.nearest && P.nearestD < 9)) {
        var fbest = null, fbd = ctx.focusType === 'king' ? 1e9 : 130;
        for (var fj = 0; fj < sim.units.length; fj++) { var fe = sim.units[fj]; if (!fe.alive || fe.team === u.team || !isFocus(ctx, fe)) continue; var fdd = hypot(fe.x - u.x, fe.z - u.z); if (fdd < fbd) { fbd = fdd; fbest = fe; } }
        if (fbest) { setGoal(u, fbest.x, fbest.z, 1, 'move'); ai.note = '主目標（' + fbest.T.name + '）へ向かう'; return; }
      }
    }
    var leash = cfg.ai.overpursuitBase + cfg.ai.overpursuitPerBrain * b;   // 追撃距離（頭脳が低いと深追い）
    var anchor = null, engageR = u.T.sight, keepTarget = true;

    if (type === 'hold') { anchor = { x: order.x != null ? order.x : u.homeX, z: order.z != null ? order.z : u.homeZ }; engageR = order.engageR != null ? order.engageR + (MOUNTED[u.type] ? 4 : 0) : 7 + 0.6 * b + (MOUNTED[u.type] ? 8 : 0); }
    else if (type === 'move') { anchor = { x: order.x, z: order.z }; engageR = 3.5 + 0.15 * b; }
    else if (type === 'advance') { anchor = { x: order.x, z: order.z }; engageR = 12 + 0.6 * b; }
    else if (type === 'advanceTo') { anchor = { x: order.x, z: order.z }; engageR = order.engageR || 10; }   // 城壁戦：目的地へ向かいながら近くの敵と戦う
    else if (type === 'defendBase') {
      var sp = sim.supply[u.team], k = ctx.myKing || sp; var dir = u.team === 0 ? 1 : -1;
      anchor = { x: (k.x + sp.x) / 2 + dir * 10, z: (k.z + sp.z) / 2 };
      engageR = 22;
    } else if (type === 'retreat') {
      var sp2 = sim.supply[u.team];
      anchor = { x: sp2.x + (u.team === 0 ? 6 : -6), z: sp2.z + ((u.id % 7) - 3) * 2 };
      engageR = 3;
    } else if (type === 'attackTarget') {
      var tg = sim.unitById(order.targetId);
      // 頭脳が高い兵は、自分が攻撃されていればまず目の前の敵に対処
      if (b >= 6 && P.nearest && P.nearestD < 2.5 && P.nearest !== tg && u.lastHitT && sim.t - u.lastHitT < 1.5 && !MOUNTED[u.type]) { setEngage(u, P.nearest); ai.note = '目前の敵に対処'; return; }
      setEngage(u, tg); ai.note = '指定目標を攻撃'; return;
    } else if (type === 'flank') {
      if (order.phase === 0) {
        var fp = sim.flankPoint(u.team, order.side);
        order.x = fp.x; order.z = fp.z;
        // 自軍側から大きく回り込む経由点
        var dist = hypot(fp.x - u.x, fp.z - u.z);
        var nearFlank = P.nearestD < (MOUNTED[u.type] ? 6 : 5);
        if (dist < 10 || nearFlank || Math.abs(u.z - fp.z) < 6) { order.phase = 1; }
        else {
          // まず横へ、それから前へ（頭脳が低いと真っ直ぐ突っ込みがち）
          var sideFirst = b >= 3 && Math.abs(u.z - fp.z) > 8;
          var gx = sideFirst ? u.x + (fp.x - u.x) * 0.3 : fp.x;
          setGoal(u, gx, fp.z, 1, 'move'); ai.note = '側面へ回り込み中'; return;
        }
      }
      ctx.flankBonus = true; engageR = u.T.sight;
    }

    // 命令の基準点から離れすぎていれば戻る（深追い抑制）
    if (anchor && ai.mode === 'engage' && ai.targetId) {
      var ct = sim.unitById(ai.targetId);
      if (ct && ct.alive && hypot(ct.x - anchor.x, ct.z - anchor.z) > Math.max(engageR + 6, leash * (type === 'move' ? 0.3 : 0.6))) keepTarget = false;
    }

    var filter = null;
    if (anchor) filter = function (e) { return hypot(e.x - anchor.x, e.z - anchor.z) < engageR + 4 || hypot(e.x - u.x, e.z - u.z) < engageR; };
    var t = pickMeleeTarget(sim, u, P, b, type === 'attack' || type === 'flank' ? u.T.sight : engageR + 6, ctx, filter);
    if (t && (keepTarget || t.id !== ai.targetId)) { setEngage(u, t); ai.note = type === 'flank' ? '回り込んで攻撃' : '交戦'; return; }

    // 交戦相手なし：命令に従って移動
    if (anchor) {
      var ac = enemyArcherCenter(sim, u.team);
      var gx2 = anchor.x, gz2 = anchor.z;
      // 頭脳の高い兵は、待機中に敵弓兵の射線を遮蔽物で避ける
      if ((type === 'hold' || type === 'defendBase') && ac && b >= 6 && hypot(ac.x - u.x, ac.z - u.z) < 60) {
        var cv = findCover(sim, u, ac.x, ac.z, anchor.x, anchor.z, 8 + b * 0.6);
        if (cv) { gx2 = cv.x; gz2 = cv.z; ai.note = '遮蔽物の陰で待機'; }
      }
      if (type === 'advance' && hypot(anchor.x - u.x, anchor.z - u.z) < 3) { order.type = 'hold'; order.x = anchor.x; order.z = anchor.z; }
      if (type === 'retreat' && hypot(anchor.x - u.x, anchor.z - u.z) < 4) { order.type = 'defendBase'; }
      setGoal(u, gx2, gz2, order.speed != null ? order.speed : type === 'retreat' ? 1 : (type === 'hold' ? 0.6 : 1), 'move');
      if (!ai.note || ai.mode === 'move') ai.note = order.note || { hold: '待機', move: '指定地点へ移動', advance: '前進', advanceTo: '目的地へ前進', defendBase: '自陣防衛', retreat: '撤退' }[type] || '移動';
      return;
    }
    // 城壁戦：たどり着ける敵がいなければ、敵の城壁（開いた扉から中へ／閉じていれば扉を攻撃）へ
    if (sim.fort && !ctx.fortFallback) { ctx.fortFallback = true; if (sim.fort.goEnemyGate(u)) return; return thinkFighter(sim, u, P, b, u.order, ctx); }
    // 総攻撃：視界内に敵がいなければ敵本隊・敵王の方向へ
    var ek = sim.king(1 - u.team), ec = ctx.enemyCenter;
    var goal = ec;
    // 部隊の進軍目標が指定されていれば、まずそこへ
    if (order.gx != null && hypot(order.gx - u.x, order.gz - u.z) > 12 && !order.gxDone) { setGoal(u, order.gx, order.gz, 1, 'move'); ai.note = '進軍目標へ'; return; }
    if (order.gx != null) order.gxDone = true;
    if (ctx.laneZ != null && !(ek && sim.aliveCount(1 - u.team) < 8)) {
      // 担当戦線の敵の中心へ
      var lx = 0, lz = 0, ln = 0;
      for (var li = 0; li < sim.units.length; li++) { var le = sim.units[li]; if (le.alive && le.team !== u.team && le.type !== 'king' && Math.abs(le.z - ctx.laneZ) < (ctx.laneW || 20) + 10) { lx += le.x; lz += le.z; ln++; } }
      if (ln) goal = { x: lx / ln, z: lz / ln };
    }
    if (ek && (b >= 6 || sim.aliveCount(1 - u.team) < 6)) {
      // 頭脳の高い兵は戦況を見て敵王に向かう
      var lb = localBalance(sim, ek.x, ek.z, u.team, 15);
      if (lb.e < 4 || sim.aliveCount(1 - u.team) < 8) goal = ek;
    }
    setGoal(u, goal.x, goal.z, 1, 'move'); ai.note = '敵を探して前進';
  }

  // ---------- 護衛（側近の基本行動 / 「王を護衛」命令） ----------
  function thinkGuard(sim, u, P, b, order, ctx, k) {
    var cfg = sim.cfg, ai = u.ai;
    var gR = cfg.ai.guardRadius + 0.4 * b, leash = cfg.ai.guardLeash + (10 - b) * 1.5;   // 頭脳が低いと深追い
    var isGuard = u.type === 'guard';
    // 王に迫る敵を迎撃
    var best = null, bs = -1e9;
    for (var i = 0; i < P.enemies.length; i++) {
      var e = P.enemies[i].u, kd = hypot(e.x - k.x, e.z - k.z);
      if (kd > gR + (ai.mode === 'engage' && ai.targetId === e.id ? 6 : 0)) continue;
      // 頭脳が高い：王に最も近い敵を優先／低い：自分に近い敵
      var s = -(b >= 4 ? kd * (b / 10) * 2 + P.enemies[i].d * 0.3 : P.enemies[i].d) + sim.rng.gauss() * (6 - 0.5 * b);
      if (ai.targetId === e.id) s += 3;
      if (e.type === 'archer') s -= 2;
      if (s > bs) { bs = s; best = e; }
    }
    var myD = hypot(u.x - k.x, u.z - k.z);
    if (best && myD < leash) { setEngage(u, best); ai.note = '王に迫る敵を迎撃'; return; }
    // 隊形：王の周りに展開し、脅威の方向を向く
    var ec = ctx.enemyCenter, threatAng = Math.atan2(ec.z - k.z, ec.x - k.x);
    var ac = enemyArcherCenter(sim, u.team);
    var guards = [], idx = 0;
    for (var j = 0; j < sim.units.length; j++) { var g = sim.units[j]; if (g.alive && g.team === u.team && g.order && g.order.type === 'guardKing') { if (g === u) idx = guards.length; guards.push(g); } }
    var n = guards.length;
    var near = P.nearestD < 30;
    var R = (isGuard ? (near ? 2.2 : 3.0) : 5) + (n > 6 ? 1.5 : 0);
    var spread = Math.min(Math.PI * 1.6, n * 0.7);
    var ang = threatAng + (n > 1 ? -spread / 2 + spread * idx / (n - 1) : 0);
    // 頭脳の高い側近は敵弓兵と王の間に立って盾になる
    if (ac && isGuard && b >= 5 && idx === 0 && hypot(ac.x - k.x, ac.z - k.z) < 70) ang = Math.atan2(ac.z - k.z, ac.x - k.x);
    var gx = k.x + Math.cos(ang) * R, gz = k.z + Math.sin(ang) * R;
    setGoal(u, gx, gz, myD > 6 ? 1 : 0.7, 'guard');
    ai.faceAng = ang; ai.note = near ? '王の周囲で防御陣形' : '王を護衛';
  }

  // ---------- 王 ----------
  function thinkKing(sim, u, P, b, order, ctx) {
    var cfg = sim.cfg, ai = u.ai;
    var danger = 0, cx = 0, cz = 0, nThreat = 0;
    for (var i = 0; i < P.enemies.length; i++) {
      var en = P.enemies[i];
      if (en.d < cfg.ai.kingSafeDistance) { danger += (cfg.ai.kingSafeDistance - en.d) * (MOUNTED[en.u.type] ? 1.6 : 1); cx += en.u.x; cz += en.u.z; nThreat++; }
    }
    var guardsNear = 0;
    for (var j = 0; j < P.allies.length; j++) if (P.allies[j].d < 8 && P.allies[j].u.type !== 'archer') guardsNear++;
    var hpR = u.hp / u.maxHp;
    // 目の前の敵とは戦う
    if (P.nearest && P.nearestD < 2.6 + P.nearest.radius) {
      // 頭脳が高い王は、包囲されそうなら離脱を試みる
      if (!(b >= 5 && nThreat >= 3 && guardsNear < 2 && hpR < 0.6 && !ai.cornered)) { setEngage(u, P.nearest); ai.note = '王が応戦'; return; }
    }
    // 脅威の戦力と、自分＋周囲の味方の戦力を比べる（弱い相手から逃げ続けない）
    var thrPow = 0, myPow = u.hp * u.T.atk;
    for (var q = 0; q < P.enemies.length; q++) if (P.enemies[q].d < cfg.ai.kingSafeDistance) thrPow += P.enemies[q].u.hp * P.enemies[q].u.T.atk;
    for (var q2 = 0; q2 < P.allies.length; q2++) if (P.allies[q2].d < 10) myPow += P.allies[q2].u.hp * P.allies[q2].u.T.atk * 0.8;
    var outmatched = thrPow > myPow * (0.6 + 0.04 * (10 - b));
    if (nThreat > 0 && outmatched && (nThreat > guardsNear || hpR < 0.5)) {
      cx /= nThreat; cz /= nThreat;
      var ax = u.x - cx, az = u.z - cz, L = hypot(ax, az) + 1e-6;
      // 味方の方向へ退避（頭脳が高いほど味方を重視）
      var mx = 0, mz = 0, n = 0;
      for (var a = 0; a < P.allies.length; a++) { var al = P.allies[a]; if (al.d < 40 && al.u.type !== 'archer') { mx += al.u.x; mz += al.u.z; n++; } }
      var dx = ax / L, dz = az / L;
      if (n && b >= 3) { mx = mx / n - u.x; mz = mz / n - u.z; var ml = hypot(mx, mz) + 1e-6; var w = 0.3 + 0.05 * b; dx = dx * (1 - w) + mx / ml * w; dz = dz * (1 - w) + mz / ml * w; }
      var gx = clamp(u.x + dx * 10, -sim.W / 2 + 3, sim.W / 2 - 3), gz = clamp(u.z + dz * 10, -sim.D / 2 + 3, sim.D / 2 - 3);
      // 追い詰められた（端・遮蔽物で進めない）ら戦う
      var moved = hypot(u.x - (ai.lastFleeX || 0), u.z - (ai.lastFleeZ || 0));
      ai.cornered = ai.mode === 'flee' && moved < 1.0;
      ai.lastFleeX = u.x; ai.lastFleeZ = u.z;
      if (ai.cornered && P.nearest) { setEngage(u, P.nearest); ai.note = '追い詰められ応戦'; return; }
      setGoal(u, gx, gz, 1, 'flee'); ai.note = '王が退避'; return;
    }
    ai.cornered = false;
    var ox = order.x != null ? order.x : u.homeX, oz = order.z != null ? order.z : u.homeZ;
    if (order.type === 'move' || order.type === 'hold') { setGoal(u, ox, oz, 0.8, 'move'); ai.note = order.type === 'move' ? '王が移動' : '王は後方で待機'; return; }
    if (order.type === 'retreat' || order.type === 'defendBase') { var sp = sim.supply[u.team]; setGoal(u, sp.x + (u.team ? -4 : 4), sp.z, 1, 'move'); ai.note = '王は本陣へ'; return; }
    if (order.type === 'attack' || order.type === 'advance' || order.type === 'attackTarget' || order.type === 'flank') {
      // 王が攻撃命令を受けた場合：自軍の後方からついていく
      var t = order.type === 'attackTarget' ? sim.unitById(order.targetId) : pickMeleeTarget(sim, u, P, b, 20, ctx);
      if (t && t.alive) { setEngage(u, t); ai.note = '王が出陣'; return; }
      var c = ctx.enemyCenter; setGoal(u, c.x, c.z, 0.7, 'move'); ai.note = '王が前進'; return;
    }
    setGoal(u, u.homeX, u.homeZ, 0.7, 'move');
  }

  // ---------- 弓兵 ----------
  function thinkArcher(sim, u, P, b, order, ctx) {
    var cfg = sim.cfg, ai = u.ai, T = u.T;
    var nearest = P.nearest, nd = P.nearestD;
    // 城壁戦：城壁の上と下、閉じた扉の向こうなど、自分に届かない敵からは逃げない・斬り合わない
    if (sim.fort && nearest && !sim.fort.reachable(nearest, u)) { nearest = null; nd = 1e9; }
    // 近接された：後退 or 短剣
    var kite = 5 + 0.8 * b;
    if (nearest && nd < 2.4 + nearest.radius) { setEngage(u, nearest); ai.note = '短剣で応戦'; ai.dagger = true; return; }
    ai.dagger = false;
    if (nearest && nd < kite && b >= 2 && u.arrows > 0 && !(ai.kiteStart && sim.t - ai.kiteStart > 6)) {
      // 騎兵相手に頭脳の高い弓兵は味方の陰・遮蔽物へ逃げる
      var ax = u.x - nearest.x, az = u.z - nearest.z, L = hypot(ax, az) + 1e-6;
      var dirHome = u.team === 0 ? -1 : 1;
      var gx = u.x + ax / L * 8 + dirHome * 3, gz = u.z + az / L * 8;
      if (b >= 5) {
        var best = null, bd = 1e9;
        for (var i = 0; i < P.allies.length; i++) { var al = P.allies[i]; if (al.u.type === 'archer' || al.u.type === 'king') continue; var dd = hypot(al.u.x - u.x, al.u.z - u.z); if (dd < 20 && dd < bd && hypot(al.u.x - nearest.x, al.u.z - nearest.z) < hypot(u.x - nearest.x, u.z - nearest.z) + 6) { bd = dd; best = al.u; } }
        if (best) { var bx = best.x - nearest.x, bz = best.z - nearest.z, bl = hypot(bx, bz) + 1e-6; gx = best.x + bx / bl * 3; gz = best.z + bz / bl * 3; }
      }
      if (!ai.kiteStart || ai.mode !== 'kite') ai.kiteStart = sim.t;
      setGoal(u, clamp(gx, -sim.W / 2 + 2, sim.W / 2 - 2), clamp(gz, -sim.D / 2 + 2, sim.D / 2 - 2), 1, 'kite');
      ai.faceTarget = nearest.id; ai.note = '距離を取りつつ射撃'; ai.shootTarget = nearest.id;
      return;
    }
    if (!(nearest && nd < kite)) ai.kiteStart = 0;
    // 矢切れ：補給へ
    if (u.arrows <= 0 || (ai.mode === 'refill' && u.arrows < T.arrows)) {
      var sp = sim.fort ? sim.fort.refillPoint(u) : sim.supply[u.team];
      if (sp && sp.here) { setGoal(u, u.x, u.z, 0, 'refill'); ai.note = '矢を補給中（' + u.arrows + '/' + T.arrows + '）'; if (u.arrows >= T.arrows) ai.mode = 'idle'; return; }
      // 補給を優先。ただし目の前の敵、攻撃されている時、補給先が遠く近くの戦いが互角以上の時は短剣で応戦する
      var fight = nearest && (nd < 6 || (nd < 12 && u.lastHitT && sim.t - u.lastHitT < 2.5) ||
        (sim.fort && u.arrows <= 0 && nd < 9 && hypot(sp.x - u.x, sp.z - u.z) > 40 && P.nearE <= P.nearA));
      if (!fight) { setGoal(u, sp.x + ((u.id % 5) - 2) * 1.5, sp.z + ((u.id % 3) - 1) * 1.5, 1, 'refill'); ai.note = (sp.note || '矢を補充') + '（残り' + u.arrows + '）'; return; }
      setEngage(u, nearest); ai.note = '矢切れ：短剣で応戦'; return;
    }
    // 頭脳の高い弓兵は矢が少なく戦闘が落ち着いていれば早めに補充
    // 城壁戦：移動命令（個別命令・出動・救援など）は、着くまで射撃より移動を優先
    if (sim.fort && order.type === 'move' && hypot(order.x - u.x, order.z - u.z) > 2) { setGoal(u, order.x, order.z, 1, 'move'); ai.note = order.note || '移動'; return; }
    if (u.arrows <= 3 && b >= 6 && !(nearest && nd < 25) && !sim.fort) { ai.mode = 'refill'; setGoal(u, sim.supply[u.team].x, sim.supply[u.team].z, 1, 'refill'); ai.note = '早めに補充'; return; }

    var range = T.bowRange;
    // 射撃目標
    var focus = null;
    if (order.type === 'fireAt') {
      if (order.targetId) { focus = sim.unitById(order.targetId); if (focus && !focus.alive) focus = null; }
    } else if (order.type === 'attackTarget') { focus = sim.unitById(order.targetId); if (focus && !focus.alive) focus = null; }
    if (!focus && order.focusType === 'king') focus = sim.king(1 - u.team);   // 主目標「敵の王」：王を射程に入れに行く
    var best2 = null, bs = -1e9;
    for (var j = 0; j < P.enemies.length; j++) {
      var en = P.enemies[j], e = en.u;
      var hb = 1 + Math.max(0, u.y - e.y) * cfg.combat.heightRangeBonusPerM;
      if (en.d > range * hb || en.d < T.minRange) continue;
      var s = -en.d * 0.5 + scoreArcher(sim, u, e, b, ctx);
      if (order.type === 'fireAt' && order.x != null) s -= hypot(e.x - order.x, e.z - order.z) * 1.5;
      if (focus && e === focus) s += 100;
      if (s > bs) { bs = s; best2 = e; }
    }
    if (best2) {
      ai.mode = 'shoot'; ai.shootTarget = best2.id; ai.targetId = 0; ai.note = '射撃：' + best2.T.name;
      // 射撃位置：待機系の命令でなければ、近すぎる場合は少し下がる
      ai.goalX = u.x; ai.goalZ = u.z; ai.goalSpeed = 0;
      if (b >= 4 && hypot(best2.x - u.x, best2.z - u.z) < range * 0.4 && order.type !== 'hold') {
        var dirB = u.team === 0 ? -1 : 1; ai.goalX = u.x + dirB * 4; ai.goalSpeed = 0.6;
      }
      return;
    }
    // 地点への射撃命令（敵がいない場所でも撃ち込む）
    if (order.type === 'fireAt' && order.x != null && hypot(order.x - u.x, order.z - u.z) < range * 1.1 && hypot(order.x - u.x, order.z - u.z) > T.minRange) {
      ai.mode = 'shootPoint'; ai.goalSpeed = 0; ai.goalX = u.x; ai.goalZ = u.z; ai.note = '指定地点へ射撃'; return;
    }
    ai.shootTarget = 0;
    // 射程外：命令に応じて移動
    if (order.type === 'hold') { setGoal(u, order.x != null ? order.x : u.homeX, order.z != null ? order.z : u.homeZ, 0.6, 'move'); ai.note = '待機（射程外）'; return; }
    if (order.type === 'move' || order.type === 'advance' || order.type === 'advanceTo') { if (hypot(order.x - u.x, order.z - u.z) > 2) { setGoal(u, order.x, order.z, 1, 'move'); ai.note = '移動'; return; } setGoal(u, u.x, u.z, 0, 'move'); ai.note = '待機'; return; }
    if (order.type === 'retreat' || order.type === 'defendBase' || order.type === 'guardKing') {
      var k = ctx.myKing || sim.supply[u.team], dir2 = u.team === 0 ? 1 : -1;
      setGoal(u, k.x + dir2 * 6 + ((u.id % 5) - 2) * 0.8, k.z + ((u.id % 7) - 3) * 2.2, 1, 'move'); ai.note = '本陣近くで射撃待機'; return;
    }
    // 総攻撃・射撃命令：味方前線の後ろを保ちながら敵へ近づく
    var target = (order.type === 'fireAt' && order.x != null) ? { x: order.x, z: order.z } : (focus || ctx.enemyCenter);
    var dx = target.x - u.x, dz = target.z - u.z, L2 = hypot(dx, dz) + 1e-6;
    var stand = range * (0.75 + 0.02 * b);
    var gx2 = target.x - dx / L2 * stand, gz2 = target.z - dz / L2 * stand;
    if (b >= 4) {
      // 味方の前線より前に出すぎない
      var front = frontLine(sim, u.team);
      var dirF = u.team === 0 ? 1 : -1;
      if (front != null && (gx2 - front) * dirF > -6) gx2 = front - dirF * 6;
      if ((gx2 - u.x) * dirF < 0 && L2 < range) gx2 = u.x;
    }
    setGoal(u, gx2, gz2 + ((u.id % 7) - 3) * 1.2, 1, 'move'); ai.note = '射程まで前進';
  }
  function scoreArcher(sim, u, e, b, ctx) {
    var bf = b / 10, s = 0;
    s += (PREF.archer[e.type] || 0) * 8 * bf;
    s += (1 - e.hp / e.maxHp) * 6 * bf;
    // 射線が通るか（頭脳が高いほど重視）
    var clear = sim.lineOfSight(u.x, u.y + 1.5, u.z, e.x, e.y + e.height * 0.5, e.z);
    if (!clear) s -= 12 * bf;
    // 味方と乱戦中の敵は誤射（味方に当たって止まる）のおそれ
    var mel = 0;
    for (var i = 0; i < sim.units.length; i++) { var v = sim.units[i]; if (v.alive && v.team === u.team && v !== u && hypot(v.x - e.x, v.z - e.z) < 2.5) mel++; }
    s -= mel * 3 * bf;
    // 速い敵は当てにくい
    s -= Math.min(10, e.spd) * 0.4 * bf;
    if (ctx.myKing) { var kd = hypot(e.x - ctx.myKing.x, e.z - ctx.myKing.z); if (kd < 20) s += (20 - kd) * 0.8 * bf; }
    if (u.ai.shootTarget === e.id) s += 3;
    if (isFocus(ctx, e)) s += 12 * (0.45 + 0.55 * bf);
    if (ctx.laneZ != null) s -= Math.max(0, Math.abs(e.z - ctx.laneZ) - (ctx.laneW || 20) - 10) * 0.2 * bf;
    s += sim.rng.gauss() * Math.max(0.5, 6 - 0.5 * b);
    return s;
  }
  function frontLine(sim, team) {
    var dir = team === 0 ? 1 : -1, best = null;
    var xs = [];
    for (var i = 0; i < sim.units.length; i++) { var v = sim.units[i]; if (v.alive && v.team === team && (v.type === 'infantry' || v.type === 'elephant' || v.type === 'guard') && !(v.order && v.order.type === 'guardKing')) xs.push(v.x * dir); }
    if (xs.length < 3) return null;
    xs.sort(function (a, b) { return a - b; });
    return xs[Math.floor(xs.length * 0.6)] * dir;
  }

  // ============================================================
  //  steer: 毎フレーム、判断結果を移動入力と攻撃に変換
  // ============================================================
  AI.steer = function (sim, u, dt) {
    var ai = u.ai, T = u.T, b = sim.brain(u);
    ai.hasFace = false;
    if (sim.fort && u.general && sim.fort.playerCtrl[u.team]) return sim.fort.steerPlayer(u, dt);   // 城壁戦：プレイヤーが操作する総大将
    var gx = null, gz = null, speed = 0;
    var tg = ai.targetId ? sim.unitById(ai.targetId) : null;
    if (tg && !tg.alive) { tg = null; ai.targetId = 0; ai.thinkT = Math.min(ai.thinkT, 0.1); }

    if (ai.mode === 'engage' && tg) {
      var dx = tg.x - u.x, dz = tg.z - u.z, d = hypot(dx, dz);
      var reach = T.range + u.radius + tg.radius;
      if (MOUNTED[u.type] && u.type !== 'elephant') {
        var r = steerMounted(sim, u, tg, d, dx, dz, b);
        gx = r.x; gz = r.z; speed = r.speed;
      } else if (d > reach - 0.15) {
        // 包囲：頭脳が高い兵は空いている方向・背後へ回り込む
        var ap = d > reach + 2 ? approachPoint(sim, u, tg, b, reach) : { x: tg.x, z: tg.z };
        gx = ap.x; gz = ap.z; speed = 1;
        // 目標の未来位置へ（頭脳依存）
        var lead = Math.min(1.5, d / 6) * (b / 10);
        gx += tg.vx * lead; gz += tg.vz * lead;
      } else {
        // 間合い内：向きを合わせて攻撃、適度に間合いを保つ
        gx = u.x; gz = u.z; speed = 0;
        if (d < reach * 0.55 && !MOUNTED[u.type]) { gx = u.x - dx / d; gz = u.z - dz / d; speed = 0.4; }
        if (u.type === 'elephant') { gx = tg.x; gz = tg.z; speed = 0.5; }
        // 回避：敵が振りかぶっていたら素早さ・頭脳の高い兵は一歩引く
        if (tg.windT > 0 && tg.windTarget === u.id && !MOUNTED[u.type] && sim.rng.chance(0.02 * (u.st.spd + b) * dt * 30 * 0.25)) { gx = u.x - dx / d * 2; gz = u.z - dz / d * 2; speed = 1; }
      }
      ai.hasFace = true; ai.faceX = dx; ai.faceZ = dz;
      sim.tryMelee(u, tg);
    } else if (ai.mode === 'shoot' || ai.mode === 'kite' || ai.mode === 'shootPoint') {
      gx = ai.goalX; gz = ai.goalZ; speed = ai.goalSpeed;
      var st = ai.shootTarget ? sim.unitById(ai.shootTarget) : null;
      if (st && !st.alive) st = null;
      if (st) { ai.hasFace = true; ai.faceX = st.x - u.x; ai.faceZ = st.z - u.z; }
      else if (ai.mode === 'shootPoint') { ai.hasFace = true; ai.faceX = u.order.x - u.x; ai.faceZ = u.order.z - u.z; }
      if (u.reloadT <= 0 && u.arrows > 0 && u.stunT <= 0) {
        if (st) tryShoot(sim, u, st, b);
        else if (ai.mode === 'shootPoint') shootAtPoint(sim, u, u.order.x + (u.order.spreadX || 0), u.order.z + (u.order.spreadZ || 0), b);
      }
      if (ai.mode === 'kite' && ai.goalX != null) { gx = ai.goalX; gz = ai.goalZ; speed = 1; }
    } else if (ai.goalX != null) {
      gx = ai.goalX; gz = ai.goalZ; speed = ai.goalSpeed;
      if (ai.mode === 'guard' && hypot(gx - u.x, gz - u.z) < 0.8) { speed = 0; ai.hasFace = true; ai.faceX = Math.cos(ai.faceAng || 0); ai.faceZ = Math.sin(ai.faceAng || 0); }
    }
    // 移動中でも目の前の敵には手を出す（騎乗突撃中を除く）
    if (ai.mode !== 'engage' && ai.mode !== 'rout' && ai.mode !== 'regroup' && !(MOUNTED[u.type] && u.spd > 4) && (u.atkCool <= 0 && u.windT <= 0) && ((sim.stepCount + u.id) % 2 === 0)) {
      var P = nearestEnemy(sim, u, T.range + u.radius + 1.2);
      if (P && (ai.mode !== 'retreat' || sim.rng.chance(0.3))) { sim.tryMelee(u, P); if (u.windT > 0) { ai.hasFace = true; ai.faceX = P.x - u.x; ai.faceZ = P.z - u.z; } }
    }

    // ---- 城壁戦：城壁をまたぐ移動は扉を通る／城壁の上へは階段を使う ----
    if (sim.fort && gx != null && speed > 0) {
      var rt = sim.fort.route(u, gx, gz);
      if (rt) { gx = rt.x; gz = rt.z; if (rt.stop) speed = hypot(gx - u.x, gz - u.z) > 1.2 ? speed : 0; if (rt.speed != null) speed = Math.min(speed, rt.speed); }
    }
    // ---- 目標地点への経路（遮蔽物を避ける） ----
    if (gx == null || speed <= 0) { ai.wantX = 0; ai.wantZ = 0; ai.wantSpeed = 0; if (gx != null && hypot(gx - u.x, gz - u.z) > 0.5 && speed <= 0 && ai.mode === 'shoot') {} return finishSteer(sim, u, dt); }
    var dist = hypot(gx - u.x, gz - u.z);
    if (dist < 0.4 && !MOUNTED[u.type]) { ai.wantX = 0; ai.wantZ = 0; ai.wantSpeed = 0; return finishSteer(sim, u, dt); }
    var wx = gx, wz = gz;
    var inflate = Math.min(1.2, u.radius * 0.6 + 0.3);
    // 直進できるかの判定は4フレームに1回（目的地が大きく変わったときは即時）
    var segKey = Math.round(gx) * 10007 + Math.round(gz);
    if (u.layer !== 'ground') ai.segBlocked = false;      // 城壁の上の通路はまっすぐ進める
    else if (dist > 3 && ((sim.stepCount + u.id) % 4 === 0 || ai.segKey !== segKey)) { ai.segKey = segKey; ai.segBlocked = !sim.segmentClear(u.x, u.z, gx, gz, inflate); }
    if (dist > 3 && ai.segBlocked) {
      var needNew = !ai.path || !ai.pathGoal || hypot(ai.pathGoal.x - gx, ai.pathGoal.z - gz) > 4 || sim.t - ai.pathT > 4 || ai.stuckT > 1.5;
      if (needNew && sim.pathBudget > 0) {
        sim.pathBudget--;
        ai.path = sim.findPath(u.x, u.z, gx, gz); ai.pathGoal = { x: gx, z: gz }; ai.pathT = sim.t; ai.pathI = 0; ai.stuckT = 0;
      }
      if (ai.path && ai.path.length) {
        while (ai.pathI < ai.path.length - 1 && (hypot(ai.path[ai.pathI].x - u.x, ai.path[ai.pathI].z - u.z) < 1.6 + u.radius || sim.segmentClear(u.x, u.z, ai.path[ai.pathI + 1].x, ai.path[ai.pathI + 1].z, inflate))) ai.pathI++;
        wx = ai.path[ai.pathI].x; wz = ai.path[ai.pathI].z;
      }
    } else { ai.path = null; }
    var mx = wx - u.x, mz = wz - u.z, ml = hypot(mx, mz) + 1e-6;
    mx /= ml; mz /= ml;
    // 到着時の減速
    var arrive = MOUNTED[u.type] ? 1 : clamp(dist / 2.5, 0.25, 1);
    // 味方との間隔（分離）
    if (!MOUNTED[u.type] || u.spd < 3) {
      // 周りとの間隔は2フレームに1回計算して使い回す（大人数での負荷軽減）
      if ((sim.stepCount + u.id) % 2 === 0 || ai.sepX == null) {
        var sx = 0, sz = 0, nb = sim.queryNear(u.x, u.z, u.radius + 3);
        for (var i = 0; i < nb.length; i++) {
          var v = nb[i]; if (v === u || !v.alive || v.layer !== u.layer) continue;
          var ddx = u.x - v.x, ddz = u.z - v.z, dd = hypot(ddx, ddz), want = u.radius + v.radius + (v.team === u.team ? 0.7 : 0.1);
          if (dd < want && dd > 1e-4) { var w = (want - dd) / want; sx += ddx / dd * w; sz += ddz / dd * w; }
        }
        ai.sepX = sx; ai.sepZ = sz;
      }
      mx += ai.sepX * 1.2; mz += ai.sepZ * 1.2;
    }
    // 近くの遮蔽物を滑らかに避ける
    var look = u.radius + 1.5 + u.spd * 0.4;
    var obs = sim.obsIn(u.x - look - 3, u.z - look - 3, u.x + look + 3, u.z + look + 3);
    for (var k = 0; k < obs.length; k++) {
      var o = obs[k], ox, oz, orad;
      if (o.off || u.layer !== 'ground' || (o.g && sim.fort.gatePassable(o.g, u))) continue;
      if (o.shape === 'circle') { ox = o.x; oz = o.z; orad = o.r; }
      else { ox = clamp(u.x, o.x - o.hw, o.x + o.hw); oz = clamp(u.z, o.z - o.hd, o.z + o.hd); orad = 0; }
      var rx = ox - u.x, rz = oz - u.z, rd = hypot(rx, rz) - orad - u.radius;
      if (rd > look || rd < -0.5) continue;
      var ahead = (rx * mx + rz * mz);
      if (ahead <= 0) continue;
      // 障害物が進行方向の左にあれば右へ、右にあれば左へそらす
      var cross = mx * rz - mz * rx;           // >0: 障害物は左側
      var lat = hypot(rx - ahead * mx, rz - ahead * mz);
      if (lat > orad + u.radius + 0.6) continue;
      var str = (1 - Math.max(0, rd) / look) * 0.9;
      var s2 = cross > 0 ? 1 : -1;            // 右手方向 = (mz, -mx)
      var nmx = mx + mz * s2 * str, nmz = mz - mx * s2 * str; mx = nmx; mz = nmz;
    }
    ai.wantX = mx; ai.wantZ = mz; ai.wantSpeed = speed * arrive;
    // 詰まり検知
    finishSteer(sim, u, dt);
  };

  function finishSteer(sim, u, dt) {
    var ai = u.ai;
    ai.stuckClock = (ai.stuckClock || 0) + dt;
    if (ai.stuckClock > 1.0) {
      var moved = hypot(u.x - ai.lastX, u.z - ai.lastZ);
      if (ai.wantSpeed > 0.3 && moved < 0.35 && ai.mode !== 'engage') ai.stuckT += ai.stuckClock; else ai.stuckT = Math.max(0, ai.stuckT - 0.5);
      ai.lastX = u.x; ai.lastZ = u.z; ai.stuckClock = 0;
      if (ai.stuckT > 3) {
        // 詰まったら横へ回避し、経路を引き直す
        ai.path = null; ai.stuckT = 0;
        var a = sim.rng.next() * Math.PI * 2;
        ai.goalX = u.x + Math.cos(a) * 4; ai.goalZ = u.z + Math.sin(a) * 4;
        ai.thinkT = 1.2;
      }
    }
  }

  function nearestEnemy(sim, u, maxD) {
    var best = null, bd = maxD, us = sim.queryNear(u.x, u.z, maxD + 3);
    for (var i = 0; i < us.length; i++) {
      var v = us[i]; if (!v.alive || v.team === u.team || v.layer !== u.layer) continue;
      var d = hypot(v.x - u.x, v.z - u.z) - v.radius;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // 包囲の接近点
  function approachPoint(sim, u, tg, b, reach) {
    var dx = u.x - tg.x, dz = u.z - tg.z, d = hypot(dx, dz) + 1e-6;
    if (b < 4 || d > 18) return { x: tg.x, z: tg.z };
    var base = Math.atan2(dz, dx), best = base, bc = 1e9;
    var occ = new Array(8).fill(0);
    for (var i = 0; i < sim.units.length; i++) {
      var v = sim.units[i]; if (!v.alive || v === u || v === tg) continue;
      var vx = v.x - tg.x, vz = v.z - tg.z, vd = hypot(vx, vz);
      if (vd > reach + 1.5) continue;
      var sec = Math.floor(((Math.atan2(vz, vx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      occ[sec] += v.team === u.team ? 1 : 0.5;
    }
    for (var s = 0; s < 8; s++) {
      var a = s * Math.PI / 4 + Math.PI / 8;
      var turn = Math.abs(angDiff(base, a));
      var back = Math.cos(angDiff(tg.heading, a));     // -1 = 背後
      var c = occ[s] * 3 * (b / 10) + turn * 2.2 + back * 1.2 * (b / 10);
      if (turn > 2.2) c += 6;
      if (c < bc) { bc = c; best = a; }
    }
    var R = reach * 0.85;
    var px = tg.x + Math.cos(best) * R, pz = tg.z + Math.sin(best) * R;
    // 回り込みの途中はやや外側を通る
    if (Math.abs(angDiff(base, best)) > 0.8 && d < reach * 3) { var mid = base + angDiff(base, best) * 0.5; px = tg.x + Math.cos(mid) * (R + 1.5); pz = tg.z + Math.sin(mid) * (R + 1.5); }
    return { x: px, z: pz };
  }

  // 騎馬・チャリオット：突撃 → 駆け抜け → 旋回して再突撃
  function steerMounted(sim, u, tg, d, dx, dz, b) {
    var ai = u.ai, T = u.T;
    if (ai.rideOutT > 0) {
      ai.rideOutT -= WS.DT;
      if (ai.rideX != null) return { x: ai.rideX, z: ai.rideZ, speed: 1 };
      return { x: u.x + Math.cos(u.heading) * 10, z: u.z + Math.sin(u.heading) * 10, speed: 1 };
    }
    ai.rideX = null;
    // 突撃が当たった直後：駆け抜けて再突撃（城壁戦では騎兵は常に一撃離脱）
    if (u.chargeCool > T.chargeCooldown - 0.2 && u.chargeCool > 0) {
      var crowd = localBalance(sim, u.x, u.z, u.team, 6);
      if (u.type === 'chariot' || sim.fort || (b >= 4 && crowd.e >= 2) || sim.crowdFactor(u) > 0.5) startRideOut(sim, u, u.type === 'chariot' ? 2.2 : 1.6 + 0.1 * b);
    }
    var needRun = T.chargeMinSpeed * sim.spdMult(u);
    // 乱戦で足が止まった騎兵は、頭脳に応じた早さで離脱して助走をつけ直す
    if (u.type === 'cavalry') {
      if (u.spd < needRun * 0.5 && d < 4) ai.boggedT = (ai.boggedT || 0) + WS.DT; else ai.boggedT = 0;
      // 城壁戦：その場の殴り合いは極力避け、1撃したら（足が止まって1秒前後で）離脱して有利な向きから再突撃
      var limit = sim.fort ? (u.order && u.order.type === 'hold' && (u.order.engageR || 9) < 8 ? 2.2 : 1.0) : 2.6 - 0.15 * b;
      if (ai.boggedT > limit) { var lb2 = localBalance(sim, u.x, u.z, u.team, 5); if (sim.fort || lb2.e >= 1.5) { startRideOut(sim, u, 1.8); ai.boggedT = 0; } }
    }
    // 目標が近く、速度が出ていない → 一度距離を取って助走（頭脳が高いほど判断できる）
    if (d < 7 && u.spd < needRun * 0.7 && (u.type === 'chariot' || sim.fort || (b >= 5 && u.chargeCool <= 0 && !(u.lastHitT && sim.t - u.lastHitT < 0.5)))) {
      if (u.type === 'chariot' || d > 3) startRideOut(sim, u, 1.4);
    }
    // 未来位置を狙って突っ込む
    var tt = d / Math.max(4, u.spd + 0.1);
    var lead = clamp(tt, 0, 2) * (0.3 + 0.07 * b);
    return { x: tg.x + tg.vx * lead, z: tg.z + tg.vz * lead, speed: 1 };
  }

  // 離脱の向き：まっすぐ前が城壁・障害物・敵の密集なら、左右に少しずらした向きを選ぶ
  function startRideOut(sim, u, time) {
    var ai = u.ai; ai.rideOutT = time; ai.rideX = null;
    if (!sim.fort) return;
    var dist = 12 + u.spd, best = null, bs = -1e9;
    var offs = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
    for (var i = 0; i < offs.length; i++) {
      var a = u.heading + offs[i], px = u.x + Math.cos(a) * dist, pz = u.z + Math.sin(a) * dist;
      if (Math.abs(px) > sim.W / 2 - 4 || Math.abs(pz) > sim.D / 2 - 4) continue;
      if (!sim.segmentClear(u.x, u.z, px, pz, u.radius + 0.3)) continue;
      var lb = localBalance(sim, px, pz, u.team, 5);
      var sc = -Math.abs(offs[i]) * 2 - lb.e * 3;
      if (sc > bs) { bs = sc; best = { x: px, z: pz }; }
    }
    if (best) { ai.rideX = best.x; ai.rideZ = best.z; }
  }

  // ---------- 射撃（未来位置予測・弾道の選択・照準誤差） ----------
  // 弾道の選び方：
  //  1) 弓の初速で届く「低い方」の弾道（近距離ではほぼ直線、遠いほど少し角度が上がる）を優先する
  //  2) それが遮蔽物・味方に遮られるときだけ曲射にする。曲射は「越えられる最も低い角度」を
  //     14°〜50°の範囲で探し、その角度で届く初速を逆算する（真上に打ち上げる軌道は使わない）
  //  3) どれでも越えられなければ blocked（頭脳が高い兵は撃たない）
  var D2R = Math.PI / 180, LOB_MIN = 14 * D2R, LOB_MAX = 50 * D2R, LOB_STEP = 3 * D2R;
  function planShot(sim, u, tx, ty, tz, tg, leadF, checkFriends) {
    var fy = u.y + 1.5, vmax = u.T.arrowSpeed;
    // 未来位置予測をしながら弾道を解く（飛行時間が変わると狙う位置も変わる）
    function aim(solve) {
      var px = tx, pz = tz, s = null;
      for (var it = 0; it < 3; it++) {
        s = solve(px, pz); if (!s) return null;
        if (!tg) break;
        px = tg.x + tg.vx * s.time * leadF; pz = tg.z + tg.vz * s.time * leadF;
      }
      return s;
    }
    function clear(s) { return sim.trajectoryClear(u.x, fy, u.z, s, 0.95) && (!checkFriends || sim.trajectoryFriendClear(u, u.x, fy, u.z, s)); }
    var low = aim(function (px, pz) { return sim.ballistic(u.x, fy, u.z, px, ty, pz, vmax, false); });
    if (!low) return null;
    if (clear(low)) return { sol: low, high: false };
    for (var ang = Math.max(LOB_MIN, low.ang + 4 * D2R); ang <= LOB_MAX + 1e-6; ang += LOB_STEP) {
      var a = ang, s = aim(function (px, pz) { return sim.ballisticAtAngle(u.x, fy, u.z, px, ty, pz, a, vmax); });
      if (s && clear(s)) return { sol: s, high: true };
    }
    return { sol: low, high: false, blocked: true };
  }
  function tryShoot(sim, u, tg, b) {
    var dx = tg.x - u.x, dz = tg.z - u.z;
    if (Math.abs(angDiff(u.heading, Math.atan2(dz, dx))) > 0.35) return;   // 向きが合うまで待つ
    // 未来位置予測：頭脳が高いほど相手の速度を正確に織り込む
    var leadF = clamp(0.15 + 0.085 * b, 0, 1.0);
    var shot = planShot(sim, u, tg.x, tg.y + tg.height * 0.55, tg.z, tg, leadF, b >= 3);
    if (!shot) return;
    if (shot.blocked && b >= 4) { u.ai.blockedShots = (u.ai.blockedShots || 0) + 1; if (u.ai.blockedShots > 3) { u.ai.blockedShots = 0; u.ai.thinkT = 0; u.ai.shootTarget = 0; } return; }   // 頭脳が高いと無駄撃ちしない
    u.ai.blockedShots = 0;
    launch(sim, u, shot.sol, b, shot.high);
  }
  function shootAtPoint(sim, u, x, z, b) {
    var shot = planShot(sim, u, x, sim.heightAt(x, z) + 1, z, null, 0, true);
    if (!shot) return;
    launch(sim, u, shot.sol, b, shot.high);
  }
  function launch(sim, u, sol, b, high) {
    var T = u.T, r = sim.rng;
    var sigma = Math.max(0.8, T.baseSpreadDeg - T.spreadPerBrainDeg * b) * Math.PI / 180;
    if (u.st.atk >= 6) sigma *= 0.9;
    if (high) sigma *= 1.8;          // 曲射は直射より狙いが不正確
    if (u.spd > 1) sigma *= 1.6;      // 移動しながらの射撃は不正確
    var yaw = Math.atan2(sol.vz, sol.vx) + r.gauss() * sigma;
    var pitch = sol.ang + r.gauss() * sigma * 0.7;
    if (high) pitch = Math.min(pitch, LOB_MAX + 5 * D2R);   // ぶれても過剰な打ち上げにはしない
    u.ai._lastHigh = high;            // テスト・表示用：直前の射撃が曲射だったか
    var v = (sol.v || T.arrowSpeed) * (1 + r.gauss() * 0.015);   // 曲射は逆算した初速で放つ
    var vh = v * Math.cos(pitch);
    sim.fireArrow(u, Math.cos(yaw) * vh, v * Math.sin(pitch), Math.sin(yaw) * vh);
  }
  function friendlyInPath(sim, u, tx, tz) {
    var dx = tx - u.x, dz = tz - u.z, L2 = dx * dx + dz * dz;
    for (var i = 0; i < sim.units.length; i++) {
      var v = sim.units[i]; if (!v.alive || v.team !== u.team || v === u) continue;
      var t = ((v.x - u.x) * dx + (v.z - u.z) * dz) / (L2 + 1e-6);
      if (t < 0.03 || t > 0.85) continue;
      if (hypot(u.x + dx * t - v.x, u.z + dz * t - v.z) < v.radius + 0.4) return true;
    }
    return false;
  }

  // ============================================================
  //  CPU指揮官：全体の作戦を決め、兵士に命令を出す（兵士は個別AIで動く）
  // ============================================================
  function Commander(team, sim, personality) {
    this.team = team;
    this.timer = 1.0;
    this.phase = 'open';
    var r = sim.rng;
    this.style = personality || ['aggressive', 'balanced', 'flanker', 'defensive'][Math.floor(r.next() * 4)];
    this.flankSide = r.chance(0.5) ? 1 : -1;
    this.lastKey = {};
    this.idleT = 0;
  }
  WS.Commander = Commander;
  Commander.prototype.order = function (sim, units, order) {
    var ids = [];
    var key = JSON.stringify(order);
    for (var i = 0; i < units.length; i++) { if (this.lastKey[units[i].id] !== key) { ids.push(units[i].id); this.lastKey[units[i].id] = key; } }
    if (ids.length) sim.issueOrder(ids, order);
  };
  Commander.prototype.update = function (sim, dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = sim.cfg.ai.commanderInterval;
    var team = this.team, enemy = 1 - team, i;
    var mine = [], byType = {};
    for (i = 0; i < sim.units.length; i++) { var u = sim.units[i]; if (u.alive && u.team === team) { mine.push(u); (byType[u.type] = byType[u.type] || []).push(u); } }
    var get = function (t) { return byType[t] || []; };
    var myKing = sim.king(team), enKing = sim.king(enemy);
    if (!myKing) return;
    var sMe = sim.strength(team), sEn = sim.strength(enemy), ratio = sMe / Math.max(1, sEn);
    // 両軍の最短距離（接敵したか）
    var minD = 1e9, threatsToKing = 0;
    for (i = 0; i < sim.units.length; i++) {
      var e = sim.units[i]; if (!e.alive || e.team !== enemy) continue;
      if (hypot(e.x - myKing.x, e.z - myKing.z) < 22) threatsToKing += MOUNTED[e.type] ? 2 : 1;
      for (var j = 0; j < mine.length; j++) { var dd = hypot(e.x - mine[j].x, e.z - mine[j].z); if (dd < minD) minD = dd; }
    }
    var dirX = team === 0 ? 1 : -1;
    var t = sim.t;
    if (this.phase === 'open' && (minD < 30 || t > (this.style === 'defensive' ? 45 : 20))) this.phase = 'battle';
    if (this.style === 'defensive' && this.phase === 'open' && t > 8 && minD > 60) this.idleT += sim.cfg.ai.commanderInterval;

    // --- 膠着打開：総攻撃 ---
    if (sim.stalemateStage >= 1) {
      this.order(sim, mine.filter(function (u) { return u.type !== 'king'; }), { type: 'attack' });
      this.order(sim, get('king'), { type: sim.stalemateStage >= 2 ? 'attack' : 'hold' });
      return;
    }
    // --- 終盤：野戦兵力が尽きたら側近も攻勢に出る ---
    var field = function (tm) { var n = 0; for (var q = 0; q < sim.units.length; q++) { var v = sim.units[q]; if (v.alive && v.team === tm && v.type !== 'king' && v.type !== 'guard') n++; } return n; };
    var fMe = field(team), fEn = field(enemy);
    if ((fMe <= 2 || fEn <= 2) && enKing) {
      if (ratio >= 1.0) {
        this.order(sim, mine.filter(function (u) { return u.type !== 'king'; }), { type: 'attackTarget', targetId: enKing.id });
        this.order(sim, get('king'), { type: ratio > 1.6 ? 'attack' : 'hold' });
      } else {
        this.order(sim, get('guard'), { type: 'guardKing' });
        this.order(sim, mine.filter(function (u) { return u.type !== 'king' && u.type !== 'guard'; }), { type: 'defendBase' });
        this.order(sim, get('king'), { type: 'hold' });
      }
      return;
    }
    // --- 王の護衛は常に側近 ---
    this.order(sim, get('guard'), { type: 'guardKing' });
    this.order(sim, get('king'), { type: 'hold' });

    // --- 王の危機：近くの部隊を呼び戻す ---
    if (threatsToKing >= 2) {
      var defenders = mine.filter(function (u) { return (u.type === 'infantry' || u.type === 'cavalry') && hypot(u.x - myKing.x, u.z - myKing.z) < 45; });
      defenders.sort(function (a, b) { return hypot(a.x - myKing.x, a.z - myKing.z) - hypot(b.x - myKing.x, b.z - myKing.z); });
      this.order(sim, defenders.slice(0, Math.min(defenders.length, 2 + threatsToKing)), { type: 'guardKing' });
      if (threatsToKing >= 4) this.order(sim, get('archer'), { type: 'defendBase' });
    }
    var busy = {}; mine.forEach(function (u) { if (u.order && u.order.type === 'guardKing' && u.type !== 'guard') busy[u.id] = 1; });
    var free = function (arr) { return arr.filter(function (u) { return !busy[u.id] || threatsToKing < 1; }); };
    if (threatsToKing < 1) for (var id in busy) delete busy[id];

    if (this.phase === 'open') {
      var adv = this.style === 'defensive' ? 10 : 22;
      this.order(sim, free(get('infantry')), this.style === 'defensive' ? { type: 'hold' } : { type: 'advance', dist: adv });
      this.order(sim, get('elephant'), this.style === 'defensive' ? { type: 'hold' } : { type: 'advance', dist: adv });
      this.order(sim, get('archer'), { type: this.style === 'defensive' ? 'hold' : 'attack' });
      if (this.style === 'flanker' || this.style === 'balanced') this.order(sim, free(get('cavalry')), { type: 'flank', side: this.flankSide });
      else this.order(sim, free(get('cavalry')), { type: this.style === 'defensive' ? 'hold' : 'attack' });
      this.order(sim, get('chariot'), { type: t > 6 && this.style !== 'defensive' ? 'attack' : 'hold' });
      if (this.idleT > 30) this.phase = 'battle';
      return;
    }
    // --- 戦闘段階 ---
    if (ratio < 0.55 && this.style !== 'aggressive' && mine.length > 4) {
      // 劣勢：本陣へ引いて防御、弓兵で迎え撃つ
      this.order(sim, free(get('infantry')), { type: 'defendBase' });
      this.order(sim, get('elephant'), { type: 'defendBase' });
      this.order(sim, get('archer'), { type: 'defendBase' });
      this.order(sim, free(get('cavalry')), { type: 'defendBase' });
      this.order(sim, get('chariot'), { type: 'attack' });
      this.phase = 'defend';
      return;
    }
    this.order(sim, free(get('infantry')), { type: 'attack' });
    this.order(sim, get('elephant'), { type: 'attack' });
    this.order(sim, get('archer'), { type: 'attack' });
    this.order(sim, get('chariot'), { type: 'attack' });
    // 敵王が手薄なら騎兵で急襲
    var cav = free(get('cavalry'));
    if (enKing && cav.length) {
      var lb = localBalance(sim, enKing.x, enKing.z, team, 14);
      if (lb.e <= 2.5 || (ratio > 1.6 && lb.e <= 5)) { this.order(sim, cav, { type: 'attackTarget', targetId: enKing.id }); return; }
    }
    // 敵弓兵が健在なら騎兵は回り込んで弓兵を狙う
    var enemyArchers = 0; for (i = 0; i < sim.units.length; i++) if (sim.units[i].alive && sim.units[i].team === enemy && sim.units[i].type === 'archer') enemyArchers++;
    if (enemyArchers >= 2 && this.style !== 'aggressive') this.order(sim, cav, { type: 'flank', side: this.flankSide });
    else this.order(sim, cav, { type: 'attack' });
  };
})(typeof window !== 'undefined' ? window : globalThis);
