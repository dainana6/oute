// ============================================================
//  WarSimulation Simple — 効果音（Web Audio API でその場で合成。音声ファイル・外部サービスは使わない）
//  play(名前, {pan, gain})。スマートフォンでは最初のタップ／クリックで音が出せるようになる
// ============================================================
(function (G) {
  var WS = G.WS = G.WS || {};

  // ---------- 合成の部品 ----------
  var noiseBufs = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function noiseBuf(ctx) {
    var b = noiseBufs && noiseBufs.get(ctx);
    if (b) return b;
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate);
    var d = b.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (noiseBufs) noiseBufs.set(ctx, b);
    return b;
  }
  // 音量の包絡（立ち上がり a 秒、減衰 d 秒）
  function env(ctx, t, a, d, peak) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    return g;
  }
  // 音程のある音（f0 → f1 へ変化）。lp を指定すると高音を削る
  function tone(ctx, out, t, type, f0, f1, a, d, peak, lp) {
    var o = ctx.createOscillator(), g = env(ctx, t, a, d, peak), last = g;
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    o.connect(g);
    if (lp) { var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; g.connect(f); last = f; }
    last.connect(out);
    o.start(t); o.stop(t + a + d + 0.05);
    return o;
  }
  // 雑音（金属音・打撃・風切り）。f1 を指定するとフィルターの周波数が動く
  function noise(ctx, out, t, ftype, f0, q, a, d, peak, f1) {
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = env(ctx, t, a, d, peak);
    s.buffer = noiseBuf(ctx); f.type = ftype; f.frequency.setValueAtTime(f0, t); f.Q.value = q || 1;
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    s.connect(f); f.connect(g); g.connect(out);
    var off = Math.random() * 0.5;
    s.start(t, off); s.stop(t + a + d + 0.05);
    return s;
  }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  // ---------- 効果音の定義（どれも短く、同時にたくさん鳴っても耳障りにならない音量） ----------
  var SFX = {
    // 戦闘（戦場の位置で左右・遠近をつける）
    clash: function (c, o, t) { var r = rnd(0.9, 1.1); noise(c, o, t, 'bandpass', 3200 * r, 1.5, 0.002, 0.07, 0.45); tone(c, o, t, 'sine', 2300 * r, 0, 0.001, 0.18, 0.14); tone(c, o, t, 'sine', 3650 * r, 0, 0.001, 0.12, 0.09); },
    block: function (c, o, t) { var r = rnd(0.92, 1.08); tone(c, o, t, 'sine', 4200 * r, 0, 0.001, 0.26, 0.18); tone(c, o, t, 'sine', 6100 * r, 0, 0.001, 0.14, 0.08); noise(c, o, t, 'highpass', 5000, 0.7, 0.001, 0.03, 0.22); },
    hit: function (c, o, t) { noise(c, o, t, 'lowpass', 900, 0.8, 0.002, 0.06, 0.45); tone(c, o, t, 'sine', 150, 70, 0.002, 0.08, 0.28); noise(c, o, t, 'bandpass', 2600, 1.2, 0.001, 0.04, 0.18); },
    dodge: function (c, o, t) { noise(c, o, t, 'bandpass', 700, 1.2, 0.02, 0.12, 0.6, 2400); },
    shoot: function (c, o, t) { var r = rnd(0.9, 1.12); tone(c, o, t, 'triangle', 210 * r, 120 * r, 0.002, 0.12, 0.22); noise(c, o, t + 0.01, 'highpass', 3000, 0.7, 0.01, 0.1, 0.06); },
    arrowHit: function (c, o, t) { noise(c, o, t, 'bandpass', 2000, 1.5, 0.001, 0.03, 0.28); tone(c, o, t, 'sine', 900, 300, 0.001, 0.04, 0.08); },
    charge: function (c, o, t) { tone(c, o, t, 'sine', 90, 40, 0.003, 0.25, 0.6); noise(c, o, t, 'lowpass', 420, 0.8, 0.003, 0.16, 0.5); noise(c, o, t + 0.02, 'bandpass', 2800, 1.4, 0.001, 0.06, 0.25); },
    death: function (c, o, t) { tone(c, o, t, 'sine', 115, 45, 0.004, 0.32, 0.36); noise(c, o, t, 'lowpass', 320, 0.7, 0.004, 0.2, 0.28); },
    // 操作
    select: function (c, o, t) { tone(c, o, t, 'sine', 880, 0, 0.003, 0.06, 0.2); tone(c, o, t + 0.045, 'sine', 1320, 0, 0.003, 0.05, 0.12); },
    move: function (c, o, t) { tone(c, o, t, 'sine', 520, 0, 0.003, 0.06, 0.18); tone(c, o, t + 0.07, 'sine', 780, 0, 0.003, 0.09, 0.18); },
    attack: function (c, o, t) { tone(c, o, t, 'sine', 160, 85, 0.003, 0.16, 0.5); noise(c, o, t, 'lowpass', 1300, 0.8, 0.002, 0.06, 0.32); tone(c, o, t + 0.05, 'triangle', 440, 0, 0.003, 0.12, 0.12); },
    tick: function (c, o, t) { tone(c, o, t, 'sine', 1200, 0, 0.002, 0.03, 0.12); },
    deny: function (c, o, t) { tone(c, o, t, 'square', 170, 150, 0.003, 0.1, 0.08, 1200); },
    // 進行
    count: function (c, o, t) { tone(c, o, t, 'sine', 660, 0, 0.004, 0.16, 0.3); },
    horn: function (c, o, t) {   // 開戦の角笛
      [196, 294, 392].forEach(function (f, i) { tone(c, o, t, 'sawtooth', f, f * 1.01, 0.12, 0.95, [0.16, 0.11, 0.06][i], 1400); });
    },
    alarm: function (c, o, t) {  // 自軍の王が危険
      for (var i = 0; i < 2; i++) { tone(c, o, t + i * 0.3, 'square', 880, 0, 0.004, 0.12, 0.09, 2500); tone(c, o, t + i * 0.3 + 0.15, 'square', 660, 0, 0.004, 0.12, 0.09, 2500); }
    },
    bell: function (c, o, t) { tone(c, o, t, 'triangle', 1046, 0, 0.003, 0.5, 0.16); tone(c, o, t, 'sine', 2093, 0, 0.003, 0.25, 0.05); },   // 敵の王が退いた
    wipeOwn: function (c, o, t) { tone(c, o, t, 'sawtooth', 110, 98, 0.06, 0.8, 0.22, 600); },
    wipeEnemy: function (c, o, t) { tone(c, o, t, 'triangle', 784, 0, 0.003, 0.35, 0.18); tone(c, o, t + 0.12, 'triangle', 1046, 0, 0.003, 0.45, 0.18); },
    victory: function (c, o, t) {
      [523, 659, 784, 1046].forEach(function (f, i) { tone(c, o, t + i * 0.15, 'triangle', f, 0, 0.005, i === 3 ? 0.9 : 0.35, 0.24); });
      tone(c, o, t + 0.45, 'sine', 523, 0, 0.01, 0.9, 0.12);
    },
    defeat: function (c, o, t) { [440, 349, 294].forEach(function (f, i) { tone(c, o, t + i * 0.28, 'triangle', f, f * 0.98, 0.01, i === 2 ? 1.0 : 0.45, 0.22, 2000); }); },
    draw: function (c, o, t) { tone(c, o, t, 'triangle', 392, 0, 0.01, 0.4, 0.2); tone(c, o, t + 0.3, 'triangle', 392, 0, 0.01, 0.6, 0.2); }
  };
  // 同じ音が短い間に重なりすぎないための最短間隔 [秒]（乱戦で80人分の音が一度に鳴らないように）
  var GAP = { clash: 0.04, block: 0.06, hit: 0.05, dodge: 0.1, shoot: 0.035, arrowHit: 0.04, charge: 0.07, death: 0.05, tick: 0.03 };
  var VOICE_MAX = 24;          // 同時に鳴らす数の上限（性能のため）

  function Audio() {
    this.ctx = null; this.master = null; this.on = true; this.vol = 0.7;
    this.last = {}; this.voices = 0; this.played = 0; this.dropped = 0;
    try { var s = JSON.parse(localStorage.getItem('wss_sound') || 'null'); if (s) { this.on = s.on !== false; this.vol = typeof s.vol === 'number' ? s.vol : 0.7; } } catch (e) {}
  }
  WS.SimpleAudio = Audio;
  WS.SIMPLE_SFX = SFX;
  var A = Audio.prototype;
  A.supported = function () { return !!(G.AudioContext || G.webkitAudioContext); };
  var NAV = G.navigator || {};
  var IOS = /iPad|iPhone|iPod/.test(NAV.userAgent || '') || (NAV.platform === 'MacIntel' && NAV.maxTouchPoints > 1);
  WS.SIMPLE_IOS = IOS;
  // 無音のWAV（古いiPhoneで、マナーモードでも効果音を鳴らすために <audio> で流し続ける）
  function silentWavUrl() {
    var n = 4410, buf = new ArrayBuffer(44 + n), v = new DataView(buf), p = 0;
    function str(s) { for (var i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); }
    function u32(x) { v.setUint32(p, x, true); p += 4; } function u16(x) { v.setUint16(p, x, true); p += 2; }
    str('RIFF'); u32(36 + n); str('WAVE'); str('fmt '); u32(16); u16(1); u16(1); u32(44100); u32(44100); u16(1); u16(8); str('data'); u32(n);
    for (var i = 0; i < n; i++) v.setUint8(p++, 128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  // 画面の操作（タップ・クリック・キー）の中で呼ぶ。ブラウザ、特にiPhoneは操作なしに音を出させない
  A.unlock = function () {
    if (!this.supported()) return;
    if (!this.ctx) {
      var C = G.AudioContext || G.webkitAudioContext;
      this.ctx = new C();
      var comp = this.ctx.createDynamicsCompressor();     // たくさん重なっても音割れしない
      comp.threshold.value = -16; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
      this.master = this.ctx.createGain(); this.master.gain.value = this.on ? this.vol : 0;
      this.master.connect(comp); comp.connect(this.ctx.destination);
    }
    var ctx = this.ctx;
    // iPhone（iOS 17以降）：マナーモードでも、ゲーム内の効果音がオンなら鳴らす（オン／オフはゲーム内のボタンで決める）
    try { if (NAV.audioSession && NAV.audioSession.type !== 'playback') NAV.audioSession.type = 'playback'; } catch (e) {}
    // 'suspended' のほか、iPhoneでは電話や他のアプリで 'interrupted' になることがある → 次の操作で再開
    if (ctx.state !== 'running' && !this.hidden) { try { ctx.resume(); } catch (e) {} }
    // 古いiPhone：操作の中で無音を1回鳴らすと、以後は音を出せるようになる
    if (!this.primed) { try { var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); this.primed = true; } catch (e) {} }
    // 古いiPhone（audioSession がない）：無音の <audio> を流しておくと、マナーモードでも Web Audio が鳴る
    if (IOS && !NAV.audioSession) this.keepAlive(this.on && !this.hidden);
  };
  A.keepAlive = function (play) {
    if (!IOS || NAV.audioSession) return;
    try {
      if (!this.silentEl) {
        if (!play) return;
        var el = this.silentEl = document.createElement('audio');
        el.src = silentWavUrl(); el.loop = true; el.setAttribute('playsinline', ''); el.setAttribute('x-webkit-airplay', 'deny');
      }
      if (play) { var pr = this.silentEl.play(); if (pr && pr.catch) pr.catch(function () {}); } else this.silentEl.pause();
    } catch (e) {}
  };
  // 状態（画面の「効果音」欄に表示）
  A.status = function () {
    if (!this.supported()) return 'このブラウザは効果音に対応していません';
    if (!this.on) return 'オフ';
    if (!this.ctx || this.ctx.state !== 'running') return '待機中（画面をタップすると鳴り始めます）';
    return '再生中';
  };
  A.save = function () { try { localStorage.setItem('wss_sound', JSON.stringify({ on: this.on, vol: this.vol })); } catch (e) {} };
  A.setOn = function (on) { this.on = !!on; if (this.master) this.master.gain.setTargetAtTime(this.on ? this.vol : 0, this.ctx.currentTime, 0.02); this.keepAlive(this.on && !this.hidden); this.save(); };
  A.setVolume = function (v) { this.vol = Math.max(0, Math.min(1, v)); if (this.master && this.on) this.master.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.02); this.save(); };
  // ブラウザが非表示の間は止める（表示に戻ったら、次の操作で確実に再開する）
  A.setHidden = function (h) {
    this.hidden = h; if (!this.ctx) return;
    try { if (h) this.ctx.suspend(); else this.ctx.resume(); } catch (e) {}
    this.keepAlive(!h && this.on);
  };
  // opts.pan：-1（左）〜1（右）、opts.gain：0〜1（遠い音は小さく）
  A.play = function (name, opts) {
    var ctx = this.ctx, fn = SFX[name];
    if (!ctx || !fn || !this.on || ctx.state !== 'running') return false;
    opts = opts || {};
    var now = ctx.currentTime, gap = GAP[name] || 0;
    if (gap && this.last[name] != null && now - this.last[name] < gap) { this.dropped++; return false; }
    if (this.voices >= VOICE_MAX && gap) { this.dropped++; return false; }
    this.last[name] = now;
    var g = ctx.createGain(), out = g; g.gain.value = opts.gain == null ? 1 : opts.gain;
    if (opts.pan && ctx.createStereoPanner) { var p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, opts.pan)); g.connect(p); p.connect(this.master); }
    else g.connect(this.master);
    fn(ctx, out, now + 0.005);
    var self = this; self.voices++; self.played++;
    setTimeout(function () { self.voices--; try { g.disconnect(); } catch (e) {} }, gap ? 500 : 1600);   // 戦闘の音は0.3秒ほどで鳴り終わる
    return true;
  };
  // 検証用：音をオフラインで合成し、音の大きさ（RMS）と長さを返す
  WS.simpleSfxRender = function (name) {
    var OC = G.OfflineAudioContext || G.webkitOfflineAudioContext; if (!OC) return Promise.resolve(null);
    var ctx = new OC(1, 44100 * 2, 44100);
    SFX[name](ctx, ctx.destination, 0.01);
    return ctx.startRendering().then(function (buf) {
      var d = buf.getChannelData(0), s = 0, peak = 0, lastLoud = 0;
      for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); s += d[i] * d[i]; if (v > peak) peak = v; if (v > 0.01) lastLoud = i; }
      return { rms: Math.sqrt(s / d.length), peak: peak, len: lastLoud / 44100 };
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
