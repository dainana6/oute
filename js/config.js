// ============================================================
//  WarSimulation 検証版  — ゲームバランス設定ファイル
//  ここの数値を変更するだけでバランスを調整できます。
//  （ゲーム内「バランス調整」画面からも一時的に変更可能）
// ============================================================
(function (G) {
  var WS = G.WS = G.WS || {};

  WS.DEFAULT_CONFIG = {
    // ---------------- 戦場 ----------------
    field: {
      baseWidth: 200,          // 基準(1倍)の戦場の横幅 [m]（X方向：両軍が向かい合う方向）
      baseDepth: 120,          // 基準(1倍)の戦場の奥行 [m]
      areaScale: 1,            // 面積倍率 1 / 4 / 10 / 25
      deployDepth: 0.22,       // 自陣（配置可能範囲）の幅：戦場横幅に対する割合
      obstacleDensity: 1.0,    // 遮蔽物の量（1.0=標準）
      hills: true,             // 高低差を作るか
      hillHeight: 4.0,         // 丘の最大高さ [m]
      supplyRadius: 6,         // 補給地点の有効半径 [m]
      navCell: 2.0             // 経路探索グリッドの1マス [m]
    },

    // ---------------- 編成（各軍） ----------------
    army: {
      blue: { infantry: 20, guard: 3, king: 1, archer: 8, cavalry: 5, elephant: 1, chariot: 2 },
      red:  { infantry: 20, guard: 3, king: 1, archer: 8, cavalry: 5, elephant: 1, chariot: 2 }
    },

    // ---------------- 能力値 ----------------
    stats: {
      totalPoints: 10,         // 1兵士あたりの割り振りポイント
      maxPerStat: 10,
      // 兵種ごとの初期配分 [攻撃, 守備, 素早さ, 頭脳]
      defaults: {
        infantry: [3, 3, 2, 2], guard: [2, 4, 1, 3], king: [2, 3, 2, 3], general: [2, 4, 1, 3],
        archer:   [3, 1, 2, 4], cavalry: [3, 2, 3, 2], elephant: [4, 3, 1, 2], chariot: [4, 2, 2, 2]
      },
      atkPerPoint: 0.07,       // 攻撃1ポイントあたり与ダメージ +7%（基準は0.8倍+）
      atkBase: 0.8,
      defPerPoint: 0.045,      // 守備1ポイントあたり被ダメージ -4.5%
      blockPerPoint: 0.02,     // 守備1ポイントあたり防御(ブロック)率 +2%
      spdPerPoint: 0.035,      // 素早さ1ポイントあたり移動速度 +3.5%（基準0.9倍+）
      spdBase: 0.9,
      dodgePerPoint: 0.015,    // 素早さ1ポイントあたり回避率 +1.5%
      cooldownPerPoint: 0.025, // 素早さ1ポイントあたり攻撃間隔 -2.5%
      brainInfluence: 1.0      // 頭脳の影響度（0=頭脳無効, 1=標準, 2=影響大）
    },

    // ---------------- 兵種 ----------------
    // hp: 体力 / atk: 攻撃力 / armor: 被ダメージ倍率 / speed: 最高速 m/s / accel: 加速度
    // turn: 旋回速度 rad/s / radius: 当たり判定半径 / mass: 押し合いの重さ
    // range: 近接射程 / cooldown: 攻撃間隔 s / windup: 振りかぶり s / sight: 視界 m
    // block: 基本防御率 / dodge: 基本回避率
    // charge: 突撃倍率（速度に比例して加算） / narrowPenalty: 狭所での減速率
    units: {
      infantry: { name: '歩兵',   hp: 100, atk: 14, armor: 1.0, speed: 4.2, accel: 9,  turn: 7.0, radius: 0.45, mass: 1,  range: 1.4, cooldown: 1.1, windup: 0.35, sight: 45, block: 0.08, dodge: 0.10, charge: 0,   narrowPenalty: 0 },
      guard:    { name: '側近',   hp: 150, atk: 15, armor: 0.75,speed: 4.0, accel: 8,  turn: 6.0, radius: 0.55, mass: 1.6,range: 1.5, cooldown: 1.2, windup: 0.35, sight: 45, block: 0.30, dodge: 0.05, charge: 0,   narrowPenalty: 0 },
      king:     { name: '王',     hp: 340, atk: 18, armor: 0.8, speed: 3.9, accel: 8,  turn: 6.0, radius: 0.6,  mass: 2,  range: 1.6, cooldown: 1.2, windup: 0.4,  sight: 50, block: 0.20, dodge: 0.06, charge: 0,   narrowPenalty: 0 },
      archer:   { name: '弓兵',   hp: 70,  atk: 7,  armor: 1.1, speed: 4.4, accel: 10, turn: 7.5, radius: 0.42, mass: 0.9,range: 1.2, cooldown: 1.0, windup: 0.3,  sight: 60, block: 0.0,  dodge: 0.12, charge: 0,   narrowPenalty: 0,
                  arrows: 20, arrowDamage: 22, bowRange: 52, minRange: 4, reload: 1.7, arrowSpeed: 50, baseSpreadDeg: 4.5, spreadPerBrainDeg: 0.35, refillTime: 0.6 },
      cavalry:  { name: '騎馬兵', hp: 190, atk: 16, armor: 0.85, speed: 10.5,accel: 7,  turn: 2.4, radius: 0.9,  mass: 4,  range: 1.9, cooldown: 1.3, windup: 0.3,  sight: 60, block: 0.06, dodge: 0.08, charge: 3.8, narrowPenalty: 0.45,
                  chargeMinSpeed: 6.0, chargeCooldown: 5 },
      elephant: { name: '象兵',   hp: 480, atk: 18, armor: 0.8, speed: 3.6, accel: 2.5,turn: 0.9, radius: 1.9,  mass: 30, range: 3.0, cooldown: 1.8, windup: 0.5,  sight: 55, block: 0.0,  dodge: 0.0,  charge: 1.5, narrowPenalty: 0.3,
                  trampleRadius: 3.0, trampleDamage: 7,  trampleKnock: 5.0, trampleCooldown: 2.0, splash: 0.3 },
      chariot:  { name: 'チャリオット', hp: 260, atk: 13, armor: 0.8,  speed: 12.5, accel: 5, turn: 1.3, radius: 1.3, mass: 8, range: 1.9, cooldown: 1.4, windup: 0.3, sight: 60, block: 0.05, dodge: 0.03, charge: 2.6, narrowPenalty: 0.6,
                  chargeMinSpeed: 7.0, chargeCooldown: 1.0, scytheDamage: 16, scytheRadius: 2.1, slowMeleePenalty: 0.5 },
      // 総大将（城壁戦のみ）：騎乗。体力・攻撃・防御は側近と同等（城壁戦の開始時に側近の値で上書き）、移動は騎馬兵並み
      general:  { name: '総大将', hp: 150, atk: 15, armor: 0.75, speed: 10.5, accel: 8, turn: 4.0, radius: 0.9, mass: 4, range: 1.9, cooldown: 1.2, windup: 0.35, sight: 60, block: 0.30, dodge: 0.05, charge: 0, narrowPenalty: 0.3,
                  chargeMinSpeed: 99, chargeCooldown: 5 }
    },

    // 兵種相性：[攻撃側][防御側] のダメージ倍率（記載なし=1.0）
    matchup: {
      infantry: { elephant: 2.1, chariot: 1.3 },
      guard:    { cavalry: 1.2, elephant: 1.2 },
      cavalry:  { archer: 1.6, infantry: 1.0, chariot: 1.2 },
      chariot:  { infantry: 1.25, archer: 1.4, elephant: 0.6 },
      elephant: { infantry: 1.2, cavalry: 1.4, chariot: 1.5 },
      archer:   { cavalry: 0.85, chariot: 0.8, elephant: 1.3 }
    },

    // ---------------- 戦闘ルール ----------------
    combat: {
      damageScale: 0.45,       // 全ダメージの倍率（戦闘の長さの調整用）
      backstabMult: 1.5,       // 背後からの攻撃倍率
      flankMult: 1.2,          // 側面からの攻撃倍率
      blockFrontOnly: true,    // 盾の防御は正面のみ有効
      heightBonusPerM: 0.05,   // 高所から攻撃時、1m あたり +5%
      heightRangeBonusPerM: 0.03, // 高所からの射程ボーナス
      damageVariance: 0.2,     // ダメージのばらつき ±20%
      friendlyArrowStops: true,// 味方に当たった矢はそこで停止（無傷）
      corpseTime: 25,          // 死体が消えるまでの秒数
      stalemateTime: 55,       // この秒数撃破がなければCPU軍に総攻撃（2倍で全軍）を強制
      timeLimit: 900           // 制限時間 [s]（超えたら残存戦力で判定）
    },

    // ---------------- AI ----------------
    ai: {
      thinkBase: 0.9,          // 判断間隔 [s]（頭脳が高いほど短い）
      thinkPerBrain: 0.06,
      orderDeviationBase: 0.22,// 頭脳0の兵が命令を逸脱する確率（1回の判断あたり）
      orderDeviationPerBrain: 0.022,
      overpursuitBase: 40,     // 頭脳0の兵の追撃距離 [m]
      overpursuitPerBrain: -2.6,
      retreatHpRatio: 0.3,     // この体力割合以下で後退を検討（頭脳3以上）
      maxRetreatTime: 4,       // 一時後退の最大時間（無限逃走防止）
      guardRadius: 9,          // 護衛：王からこの距離以内の敵を迎撃
      guardLeash: 22,          // 護衛：王からこれ以上離れたら戻る
      kingSafeDistance: 18,    // 王：この距離に敵が来たら退避/応戦を判断
      commanderInterval: 3.0   // CPU指揮官の判断間隔 [s]
    },

    // ---------------- 実験機能 ----------------
    experimental: {
      recycleDefeated: false,  // 倒した敵を自軍兵士として再利用する（初期OFF）
      recycleDelay: 60,        // 再利用までの秒数
      recycleHpRatio: 0.7      // 再利用時の体力割合
    },

    // ---------------- 士気・敗走・降伏（Ciel版で追加） ----------------
    // シンプルモードでは常にON。詳細モードでは設定画面で切り替え（初期OFF＝従来どおり）
    morale: {
      enabled: false,
      base: 62,                // 開始時の士気（0〜100）
      typeBonus: { guard: 30, elephant: 12, cavalry: 6, chariot: 6, archer: -4, infantry: 0, king: 0 },
      routBelow: 16,           // この値を下回ると敗走
      rallyAbove: 42,          // 敗走中の兵がこの値まで回復し、近くに敵がいなければ立ち直る
      allyDeath: 6.5,          // 近く(12m)の味方が倒れたとき
      sameCorpsDeath: 2.5,     // 同じ部隊の味方なら追加
      rearHit: 2.6, flankHit: 1.0, chargeHit: 5, trampleHit: 4, arrowHit: 0.6,
      killGain: 6, allyKillGain: 2,
      outnumberedPerSec: 2.4,  // 局所的に数で負けているとき（毎秒・最大）
      winningPerSec: 1.2,      // 局所的に優勢なとき
      calmPerSec: 3,           // 25m以内に敵がいないとき
      nearKingPerSec: 1.0,     // 自軍の王の近く
      corpsHalfLoss: 8,        // 所属部隊が半数を失ったとき（1回）
      kingHurt: 8,             // 自軍の王の体力が半分を切ったとき（1回・全軍）
      guardLossScale: 0.45,    // 側近の士気は下がりにくい
      surrenderRatio: 0.1,     // 戦える兵がこの割合以下（最低2体）になり、
      surrenderEnemyMult: 3    // 敵の戦える兵がその3倍＋3以上なら降伏
    },

    // ---------------- 城壁戦（2026年10月の大規模改修で追加） ----------------
    fortress: {
      enabled: false,          // 城壁戦の戦闘で true（buildFortressBattle が設定）
      // 戦場の寸法 [m]（x：両軍が向かい合う方向、z：横幅）
      width: 300,              // 戦場全体（城壁の内側を含む）
      depth: 150,              // 横幅（城壁はこの幅いっぱいに伸びる）
      innerDepth: 24,          // 城壁の内側の奥行き
      wallThick: 3, wallHeight: 6,
      gateWidth: 9,            // 扉の幅（象兵も通れる）
      gateZ: 0.27,             // 扉の位置（横幅に対する割合、±）
      stairZ: 0.1,             // 階段の位置（±）
      gateHp: 4500,            // 扉の耐久力
      gateTime: 10,            // 扉の開閉にかかる秒数
      gateDmgMult: { elephant: 3, chariot: 0.6, cavalry: 0.8, infantry: 1, guard: 1, king: 1, general: 1 },
      outerDeploy: 0.15,       // 城壁外の配置範囲：城壁から、城壁間の距離のこの割合まで
      hpMult: 1.5,             // 全兵種の最大HP倍率
      // 編成ポイントのコスト（歩兵=1）。王・側近・総大将は編成ポイントを使わない固定枠
      power: { infantry: 1, archer: 2, guard: 0, cavalry: 4, chariot: 6, elephant: 10, king: 0, general: 0 },
      budget: 380,             // 各軍の編成ポイントの上限（252の約1.5倍を切りのよい数に）
      guards: 2,               // 側近の数（固定。城壁内に配置）
      guardMult: 3,            // 側近（と総大将）の体力・攻撃力・防御の倍率
      innerMinShare: 0.4,      // 戦闘開始時、城壁内に「上限のこの割合」以上のコストの兵を置く
      commandRadius: 30,       // 総大将からこの距離の兵士には戦闘中も命令できる
      wallSupplyDist: 15,      // 城壁の外側でも、自軍の城壁からこの距離までは矢を補給できる
      healPerSec: 0.02,        // 回復：最大HPの2%/秒
      arrowRefillTime: 2,      // 矢の補給：2秒で1本
      lowHp: 0.2, healUntil: 0.75, braveRate: 0.05,
      visionNear: 14,          // 城壁内の敵を「近くで見つける」距離
      campPower: 20,           // 陣地設営に必要な部隊のコスト合計（編成ポイント）
      campCluster: 13,         // 設営時に部隊長からこの距離内に密集していること
      campBuildTime: 15,
      campRadius: 16,
      flagTouch: 2.6,          // 旗に接触とみなす距離
      flagCaptureTime: 10,
      hornCooldown: 60,
      timeLimit: 1200,
      sortieTimeout: 60        // 出撃が終わらない場合でも、この秒数で扉を閉め始める
    },

    // ---------------- シンプルモード（Ciel版で追加） ----------------
    simple: {
      timeLimit: 240,          // 制限時間 [s]（超えたら残存戦力で判定）。通常は2〜3分で決着
      acePoints: 0,            // エース強化ポイント（全軍で）。エース制度は廃止したため 0
      aceMaxPerUnit: 5,        // 1体に振れる上限（1体で全てが決まらないように）
      ace: {
        power:  { atkPerPt: 0.09, hpPerPt: 0.06 },                               // 攻撃型
        swift:  { spdPerPt: 0.06, cooldownPerPt: 0.05, dodgePerPt: 0.025 },     // 俊足型
        leader: { brainPerPt: 1, auraRadius: 16, auraBrainPerPt: 0.5, auraMoralePerPt: 0.35, auraLossCutPerPt: 0.07 } // 知将型
      },
      aceMoraleBonus: 18,
      rallies: 3,              // 1戦で使える号令の回数
      rallyCooldown: 15,       // 号令どうしの最短間隔 [s]
      rally: {
        charge: { time: 12, atk: 1.3, speed: 1.2, morale: 25 },             // 突撃：攻撃力・速さが上がり士気回復
        iron:   { time: 15, dmgTaken: 0.6, moraleFloor: 45 },                // 鉄壁：被ダメージ減・敗走しない
        rescue: { time: 15, speed: 1.35, morale: 15 }                        // 救援：本陣へ急行して王を守る
      },
      deviationScale: 0.15,    // 命令逸脱の起こりやすさ（従来比。頭脳は「実行の賢さ」に効く）
      difficulty: {
        easy:   { acePoints: 0,  think: 4.0, rallySkill: 0.3 },
        normal: { acePoints: 0, think: 2.5, rallySkill: 0.7 },
        hard:   { acePoints: 0,  think: 1.5, rallySkill: 1.0 }
      }
    }
  };

  WS.UNIT_TYPES = ['infantry', 'guard', 'king', 'archer', 'cavalry', 'elephant', 'chariot'];

  WS.deepClone = function (o) { return JSON.parse(JSON.stringify(o)); };
  // 上書き設定(partial)を既定値へマージ
  WS.mergeConfig = function (base, over) {
    var out = WS.deepClone(base);
    (function m(a, b) {
      for (var k in b) {
        if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') m(a[k], b[k]);
        else a[k] = b[k];
      }
    })(out, over || {});
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
