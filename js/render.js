// ============================================================
//  WarSimulation 検証版 — 依存ライブラリなしの簡易3D描画（WebGL2）
//  兵種ごとのシルエットを単純な立体の組み合わせで表現
// ============================================================
(function (G) {
  var WS = G.WS = G.WS || {};

  // ---------- 行列 ----------
  var M = WS.M4 = {
    ident: function () { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
    mul: function (a, b) {
      var o = new Array(16);
      for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    persp: function (fov, asp, n, f) { var t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; },
    lookAt: function (e, c, up) {
      var zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
      var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx, xl = Math.hypot(xx, xy, xz); xx /= xl; xy /= xl; xz /= xl;
      var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
    },
    // 平行移動 * Y回転 * X回転 * Z回転 * 拡大
    trs: function (tx, ty, tz, ry, rx, rz, sx, sy, sz) {
      var cy = Math.cos(ry), syn = Math.sin(ry), cx = Math.cos(rx || 0), sxn = Math.sin(rx || 0), cz = Math.cos(rz || 0), szn = Math.sin(rz || 0);
      // R = Ry * Rx * Rz
      var r00 = cy * cz + syn * sxn * szn, r01 = -cy * szn + syn * sxn * cz, r02 = syn * cx;
      var r10 = cx * szn, r11 = cx * cz, r12 = -sxn;
      var r20 = -syn * cz + cy * sxn * szn, r21 = syn * szn + cy * sxn * cz, r22 = cy * cx;
      return [r00 * sx, r10 * sx, r20 * sx, 0, r01 * sy, r11 * sy, r21 * sy, 0, r02 * sz, r12 * sz, r22 * sz, 0, tx, ty, tz, 1];
    },
    invert: function (m) {
      var inv = new Array(16), det;
      inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
      inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
      inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
      inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
      inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
      inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
      inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
      inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
      inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
      inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
      inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
      inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
      inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
      inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
      inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
      inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
      det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
      det = 1 / det; for (var i = 0; i < 16; i++) inv[i] *= det; return inv;
    }
  };

  // ---------- 基本形状 ----------
  function boxMesh() {
    var p = [], n = [];
    var F = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    F.forEach(function (f) {
      var u = f[1] ? [1, 0, 0] : [0, 1, 0], v = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
      var c = [f[0] * 0.5, f[1] * 0.5, f[2] * 0.5];
      var q = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      q.forEach(function (s) { p.push(c[0] + (u[0] * s[0] + v[0] * s[1]) * 0.5, c[1] + (u[1] * s[0] + v[1] * s[1]) * 0.5, c[2] + (u[2] * s[0] + v[2] * s[1]) * 0.5); n.push(f[0], f[1], f[2]); });
    });
    return fixWinding(p, n);
  }
  function cylMesh(seg, top, bot) {
    var p = [], n = [];
    top = top == null ? 0.5 : top; bot = bot == null ? 0.5 : bot;
    for (var i = 0; i < seg; i++) {
      var a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      var ny = (bot - top);
      // 側面
      p.push(c0 * bot, -0.5, s0 * bot, c1 * bot, -0.5, s1 * bot, c1 * top, 0.5, s1 * top, c0 * bot, -0.5, s0 * bot, c1 * top, 0.5, s1 * top, c0 * top, 0.5, s0 * top);
      n.push(c0, ny, s0, c1, ny, s1, c1, ny, s1, c0, ny, s0, c1, ny, s1, c0, ny, s0);
      // 上下
      if (top > 0) { p.push(0, 0.5, 0, c1 * top, 0.5, s1 * top, c0 * top, 0.5, s0 * top); n.push(0, 1, 0, 0, 1, 0, 0, 1, 0); }
      if (bot > 0) { p.push(0, -0.5, 0, c0 * bot, -0.5, s0 * bot, c1 * bot, -0.5, s1 * bot); n.push(0, -1, 0, 0, -1, 0, 0, -1, 0); }
    }
    return fixWinding(p, n);
  }
  function sphereMesh(seg, rings) {
    var p = [], n = [];
    function pt(i, j) { var th = j / rings * Math.PI, ph = i / seg * Math.PI * 2; return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; }
    for (var j = 0; j < rings; j++) for (var i = 0; i < seg; i++) {
      var a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      [a, b, c, a, c, d].forEach(function (v) { p.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5); n.push(v[0], v[1], v[2]); });
    }
    return fixWinding(p, n);
  }
  // 法線の向きに合わせて三角形の巻き方向をそろえる（カリングなしでも安全に）
  function fixWinding(p, n) { return { p: new Float32Array(p), n: new Float32Array(n) }; }

  // ============================================================
  function Renderer(canvas) {
    this.canvas = canvas;
    var gl = this.gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 が使えません');
    var vs = '#version 300 es\n' +
      'in vec3 a_pos; in vec3 a_nrm; in vec4 a_vcol; in vec4 i_m0; in vec4 i_m1; in vec4 i_m2; in vec4 i_m3; in vec4 i_col;\n' +
      'uniform mat4 u_vp; out vec3 v_n; out vec4 v_c; out vec3 v_w;\n' +
      'void main(){ mat4 m = mat4(i_m0,i_m1,i_m2,i_m3); vec4 w = m*vec4(a_pos,1.0); v_w=w.xyz; v_n = normalize(mat3(m)*a_nrm); v_c = a_vcol*i_col; gl_Position = u_vp*w; }';
    var fs = '#version 300 es\nprecision highp float;\n' +
      'in vec3 v_n; in vec4 v_c; in vec3 v_w; uniform vec3 u_eye; uniform float u_fog; out vec4 o;\n' +
      'void main(){ vec3 n = normalize(v_n); vec3 L = normalize(vec3(0.45,0.8,0.35));\n' +
      ' float d = max(dot(n,L),0.0); float hemi = 0.5+0.5*n.y; vec3 c = v_c.rgb*(0.42*hemi+0.3+0.6*d);\n' +
      ' if (v_c.a > 1.5) c = v_c.rgb; float dist = length(v_w-u_eye); float f = clamp((dist-u_fog*0.55)/(u_fog*1.2),0.0,0.7);\n' +
      ' o = vec4(mix(c, vec3(0.70,0.80,0.90), f),1.0); }';
    this.prog = this.makeProg(vs, fs);
    var P = this.prog;
    this.loc = {};
    ['a_pos', 'a_nrm', 'a_vcol', 'i_m0', 'i_m1', 'i_m2', 'i_m3', 'i_col'].forEach(function (k) { this.loc[k] = gl.getAttribLocation(P, k); }, this);
    this.uvp = gl.getUniformLocation(P, 'u_vp'); this.ueye = gl.getUniformLocation(P, 'u_eye'); this.ufog = gl.getUniformLocation(P, 'u_fog');
    this.meshes = {};
    this.addMesh('box', boxMesh());
    this.addMesh('cyl', cylMesh(14));
    this.addMesh('cone', cylMesh(14, 0, 0.5));
    this.addMesh('pyr', cylMesh(4, 0, 0.7071));
    this.addMesh('sph', sphereMesh(14, 9));
    this.instBuf = gl.createBuffer();
    this.batches = {};
    this.cam = { tx: 0, tz: 0, yaw: -Math.PI / 2, pitch: 0.95, dist: 120, follow: 0 };
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }
  WS.Renderer = Renderer;
  var R = Renderer.prototype;

  R.makeProg = function (vs, fs) {
    var gl = this.gl;
    function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }
    var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  R.addMesh = function (name, m) {
    var gl = this.gl, vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, m.p, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.loc.a_pos); gl.vertexAttribPointer(this.loc.a_pos, 3, gl.FLOAT, false, 0, 0);
    var nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, m.n, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.loc.a_nrm); gl.vertexAttribPointer(this.loc.a_nrm, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(this.loc.a_vcol); gl.vertexAttrib4f(this.loc.a_vcol, 1, 1, 1, 1);
    gl.bindVertexArray(null);
    this.meshes[name] = { vao: vao, count: m.p.length / 3 };
  };

  // 地形メッシュ（頂点色つき）
  R.buildTerrain = function (sim, setupTint) {
    var gl = this.gl, W = sim.W, D = sim.D;
    var res = Math.max(1.5, Math.sqrt(W * D / 9000));
    var nx = Math.ceil(W / res), nz = Math.ceil(D / res);
    var p = [], n = [], c = [];
    function H(x, z) { return sim.heightAt(x, z); }
    function col(x, z, h) {
      var g = 0.6 + h * 0.025 + 0.04 * Math.sin(x * 0.31) * Math.cos(z * 0.27);
      var r = 0.5 + h * 0.02, b = 0.32;
      if (sim.fort) {
        // 城壁戦：城壁の内側は石畳の中庭。配置フェーズは配置範囲（城壁内・城壁外の近く）を明るく
        var fw = sim.fort;
        for (var tt = 0; tt < 2; tt++) {
          if (fw.insideX(x, tt)) { r = 0.6 + (tt ? 0.06 : 0); g = 0.56; b = 0.5 + (tt ? 0 : 0.07); }
          if (setupTint) { var zr = fw.deployZone(tt); if (x >= zr.outer.x0 && x <= zr.outer.x1) { if (tt === 0) { b += 0.2; r -= 0.08; } else { r += 0.2; g -= 0.06; } } }
        }
        return [r, g, b];
      }
      for (var t = 0; t < 2; t++) {
        var d = sim.deploy[t];
        if (x >= d.x0 && x <= d.x1) { var k = setupTint ? 0.22 : 0.07; if (t === 0) { b += k; r -= k * 0.4; } else { r += k; g -= k * 0.3; } }
        var s = sim.supply[t]; var sd = Math.hypot(x - s.x, z - s.z);
        if (sd < sim.cfg.field.supplyRadius) { r += 0.12; g += 0.08; b -= 0.02; }
      }
      return [r, g, b];
    }
    for (var j = 0; j < nz; j++) for (var i = 0; i < nx; i++) {
      var x0 = -W / 2 + i * res, x1 = Math.min(W / 2, x0 + res), z0 = -D / 2 + j * res, z1 = Math.min(D / 2, z0 + res);
      var v = [[x0, z0], [x1, z0], [x1, z1], [x0, z0], [x1, z1], [x0, z1]];
      for (var k2 = 0; k2 < 6; k2++) {
        var x = v[k2][0], z = v[k2][1], h = H(x, z);
        p.push(x, h, z);
        var hx = H(x + 0.5, z) - H(x - 0.5, z), hz = H(x, z + 0.5) - H(x, z - 0.5);
        var nl = Math.hypot(hx, 1, hz); n.push(-hx / nl, 1 / nl, -hz / nl);
        var cc = col(x, z, h); c.push(cc[0], cc[1], cc[2], 1);
      }
    }
    if (this.terrain) { gl.deleteVertexArray(this.terrain.vao); this.terrain.bufs.forEach(function (b) { gl.deleteBuffer(b); }); }
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    var bufs = [];
    var self = this;
    function attr(loc, data, sz) { var b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, sz, gl.FLOAT, false, 0, 0); }
    attr(this.loc.a_pos, p, 3); attr(this.loc.a_nrm, n, 3); attr(this.loc.a_vcol, c, 4);
    gl.bindVertexArray(null);
    this.terrain = { vao: vao, count: p.length / 3, bufs: bufs };
  };

  // ---------- インスタンスの登録 ----------
  R.begin = function () { for (var k in this.batches) this.batches[k].n = 0; };
  R.push = function (mesh, m, r, g, b, flat) {
    var bt = this.batches[mesh];
    if (!bt) bt = this.batches[mesh] = { data: new Float32Array(20 * 512), n: 0 };
    if ((bt.n + 1) * 20 > bt.data.length) { var nd = new Float32Array(bt.data.length * 2); nd.set(bt.data); bt.data = nd; }
    var o = bt.n * 20, d = bt.data;
    for (var i = 0; i < 16; i++) d[o + i] = m[i];
    d[o + 16] = r; d[o + 17] = g; d[o + 18] = b; d[o + 19] = flat ? 2 : 1;
    bt.n++;
  };
  // 親行列 × 部品の局所変換
  R.part = function (parent, mesh, x, y, z, sx, sy, sz, col, ry, rx, rz) {
    var m = M.mul(parent, M.trs(x, y, z, ry || 0, rx || 0, rz || 0, sx, sy, sz));
    this.push(mesh, m, col[0], col[1], col[2]);
  };

  // ---------- カメラ ----------
  R.updateCamera = function (W, H) {
    var c = this.cam;
    var cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    var ty = c.ty || 0;
    this.eye = [c.tx + Math.cos(c.yaw) * cp * c.dist, ty + sp * c.dist, c.tz + Math.sin(c.yaw) * cp * c.dist];
    var up = c.pitch > 1.5 ? [Math.cos(c.yaw + Math.PI), 0, Math.sin(c.yaw + Math.PI)] : [0, 1, 0];
    this.view = M.lookAt(this.eye, [c.tx, ty, c.tz], up);
    this.proj = M.persp(0.9, W / H, 0.5, Math.max(600, c.dist * 6));
    this.vp = M.mul(this.proj, this.view);
    this.ivp = M.invert(this.vp);
  };
  R.project = function (x, y, z) {
    var m = this.vp, w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0.01) return null;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * this.canvas.clientWidth, y: (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5 + 0.5)) * this.canvas.clientHeight, w: w };
  };
  R.ray = function (sx, sy) {
    var W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    var nx = sx / W * 2 - 1, ny = 1 - sy / H * 2, m = this.ivp;
    function un(z) { var x = m[0] * nx + m[4] * ny + m[8] * z + m[12], y = m[1] * nx + m[5] * ny + m[9] * z + m[13], zz = m[2] * nx + m[6] * ny + m[10] * z + m[14], w = m[3] * nx + m[7] * ny + m[11] * z + m[15]; return [x / w, y / w, zz / w]; }
    var a = un(-1), b = un(1), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]);
    return { o: a, d: [d[0] / l, d[1] / l, d[2] / l] };
  };
  // 画面座標 → 地面の点
  R.groundAt = function (sim, sx, sy) {
    var r = this.ray(sx, sy), o = r.o, d = r.d;
    var step = 1.0, t = 0, prev = null, maxT = this.cam.dist * 8 + 500;
    for (; t < maxT; t += step) {
      var x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      var h = sim.heightAt(x, z);
      if (y <= h) {
        var lo = t - step, hi = t;
        for (var k = 0; k < 12; k++) { var mid = (lo + hi) / 2; var mx = o[0] + d[0] * mid, my = o[1] + d[1] * mid, mz = o[2] + d[2] * mid; if (my <= sim.heightAt(mx, mz)) hi = mid; else lo = mid; }
        return { x: o[0] + d[0] * hi, z: o[2] + d[2] * hi };
      }
      step = Math.min(4, 0.5 + t * 0.01);
    }
    // 平面との交差（フォールバック）
    if (Math.abs(d[1]) > 1e-4) { var tt = -o[1] / d[1]; if (tt > 0) return { x: o[0] + d[0] * tt, z: o[2] + d[2] * tt }; }
    return null;
  };

  // ---------- 描画 ----------
  var TEAMC = [[0.16, 0.38, 0.95], [0.9, 0.16, 0.14]];
  var TEAMD = [[0.08, 0.2, 0.55], [0.55, 0.08, 0.07]];
  var SKIN = [0.93, 0.78, 0.62], STEEL = [0.78, 0.8, 0.86], WOOD = [0.48, 0.31, 0.16], HORSE = [0.42, 0.27, 0.15], HORSE2 = [0.85, 0.82, 0.76];
  var GRAY = [0.55, 0.55, 0.58], GOLD = [1, 0.8, 0.15], DARK = [0.15, 0.13, 0.12], PURPLE = [0.5, 0.15, 0.65], WHITE = [0.96, 0.95, 0.9];

  var BUFFC = { charge: [1, 0.45, 0.1], iron: [0.55, 0.8, 1], rescue: [0.85, 0.45, 1] };
  R.drawUnit = function (sim, u, sel, now, st) {
    var tc = TEAMC[u.team], td = TEAMD[u.team];
    var dead = !u.alive;
    if (dead) {
      var k = 0.45; tc = [tc[0] * k + 0.2, tc[1] * k + 0.2, tc[2] * k + 0.2]; td = tc;
    }
    var sink = dead ? Math.max(0, u.deadT - sim.cfg.combat.corpseTime + 3) * 0.6 : 0;
    if (dead && sink > 3) return;
    var fall = dead ? Math.min(1, u.deadT * 2.5) * (Math.PI / 2 - 0.15) : 0;
    var base = M.trs(u.x, u.y - sink, u.z, -u.heading, 0, 0, 1, 1, 1);
    if (fall) base = M.mul(base, M.trs(0, 0, 0, 0, fall * (u.id % 2 ? 1 : -1), 0, 1, 1, 1));
    var swing = u.swingT > 0 ? Math.sin((0.3 - u.swingT) / 0.3 * Math.PI) : (u.windT > 0 ? -0.6 : 0);
    var walk = u.alive ? Math.sin(now * 9 + u.id) * Math.min(1, u.spd / 3) * 0.6 : 0;
    var type = u.type;
    if (type === 'cavalry' || type === 'general' || type === 'chariot' || type === 'elephant') walk = u.alive ? Math.sin(now * 11 + u.id) * Math.min(1, u.spd / 4) * 0.5 : 0;

    if (type === 'infantry' || type === 'guard' || type === 'king' || type === 'archer') {
      var s = type === 'guard' ? 1.18 : type === 'king' ? 1.3 : type === 'archer' ? 0.96 : 1.0;
      var b = M.mul(base, M.trs(0, 0, 0, 0, 0, 0, s, s, s));
      this.humanoid(b, tc, td, walk, swing, type, u);
    } else if (type === 'cavalry' || type === 'general') {
      this.horse(base, 0, 0, type === 'general' ? 1.1 : 1.0, walk, type === 'general' ? HORSE2 : HORSE);   // 総大将は白馬
      var rider = M.mul(base, M.trs(-0.1, 1.15, 0, 0, 0, 0, 0.95, 0.95, 0.95));
      this.humanoid(rider, tc, td, 0, swing, 'rider', u);
      // 槍のような長い剣
    } else if (type === 'elephant') {
      this.elephant(base, walk, tc, td, swing);
      var r2 = M.mul(base, M.trs(-0.6, 3.75, 0, 0, 0, 0, 0.9, 0.9, 0.9));
      this.humanoid(r2, tc, td, 0, swing, 'rider', u);
    } else if (type === 'chariot') {
      this.chariot(base, u, tc, td, walk, swing, now);
    }
    // 選択リング・体力バー
    if (u.alive) {
      if (sel) this.part(M.trs(u.x, u.y + 0.06, u.z, 0, 0, 0, 1, 1, 1), 'cyl', 0, 0, 0, u.radius * 2.6 + 0.5, 0.06, u.radius * 2.6 + 0.5, sel === 2 ? [1, 0.55, 0.1] : [1, 0.95, 0.2]);
      // 地面のチーム色マーカー（遠くからでも識別しやすく）。シンプルモードでは自軍は部隊の色
      var rc = st && st.ringColor ? st.ringColor(u) : null, se = st && st.squadEdge ? st.squadEdge(u) : null;
      if (se) this.part(M.trs(u.x, u.y + 0.02, u.z, 0, 0, 0, 1, 1, 1), 'cyl', 0, 0, 0, u.radius * 2.1 + 0.55, 0.035, u.radius * 2.1 + 0.55, se);   // 部隊の色の縁取り
      this.part(M.trs(u.x, u.y + 0.03, u.z, 0, 0, 0, 1, 1, 1), 'cyl', 0, 0, 0, u.radius * 2.1, 0.04, u.radius * 2.1, rc || tc);
      // 号令の効果中：色つきの輪
      if (u.buffs) for (var bk in u.buffs) if (u.buffs[bk] > sim.t) {
        var pul = 1 + 0.12 * Math.sin(now * 6 + u.id);
        this.push('cyl', M.trs(u.x, u.y + 0.05, u.z, 0, 0, 0, (u.radius * 2.1 + 1.0) * pul, 0.05, (u.radius * 2.1 + 1.0) * pul), BUFFC[bk][0], BUFFC[bk][1], BUFFC[bk][2], true);
        break;
      }
      // 敗走中：白旗
      if (u.routing) {
        var fy = u.y + u.height + 0.3;
        this.part(M.ident(), 'box', u.x, fy + 0.6, u.z, 0.06, 1.4, 0.06, WOOD);
        this.push('box', M.trs(u.x + 0.35, fy + 1.05, u.z, -this.cam.yaw + Math.PI / 2, 0, 0, 0.6, 0.45, 0.04), 1, 1, 1, true);
      }
      // エース：頭上の金の星
      if (u.ace) {
        var ay = u.y + u.height + (u.routing ? 2.2 : 0.9) + 0.15 * Math.sin(now * 3 + u.id), sp2 = now * 2;
        this.push('pyr', M.trs(u.x, ay + 0.35, u.z, sp2, 0, 0, 0.55, 0.5, 0.55), 1, 0.82, 0.1, true);
        this.push('pyr', M.trs(u.x, ay - 0.15, u.z, sp2, Math.PI, 0, 0.55, 0.5, 0.55), 1, 0.7, 0.05, true);
      }
      if (u.hp < u.maxHp || sel) {
        var hy = u.y + u.height + 0.7, yaw = this.cam.yaw;
        var bw = Math.max(1.2, u.radius * 2.2), frac = u.hp / u.maxHp;
        var bm = M.trs(u.x, hy, u.z, -yaw + Math.PI / 2, 0, 0, 1, 1, 1);
        this.part(bm, 'box', 0, 0, 0, bw + 0.1, 0.22, 0.06, [0.05, 0.05, 0.05]);
        var fc = frac > 0.6 ? [0.2, 0.9, 0.25] : frac > 0.3 ? [0.95, 0.8, 0.15] : [0.95, 0.2, 0.15];
        var mm = M.mul(bm, M.trs(-bw / 2 + bw * frac / 2, 0, 0.05, 0, 0, 0, bw * frac, 0.16, 0.06));
        this.push('box', mm, fc[0], fc[1], fc[2], true);
      }
    }
  };

  // 人型（兵種別の装備）
  R.humanoid = function (b, tc, td, walk, swing, kind, u) {
    var mounted = kind === 'rider';
    var type = u.type;
    if (!mounted) {
      this.part(b, 'box', 0, 0.45, 0.17, 0.2, 0.9, 0.18, td, 0, 0, walk);
      this.part(b, 'box', 0, 0.45, -0.17, 0.2, 0.9, 0.18, td, 0, 0, -walk);
    }
    var by = mounted ? 0 : 0.9;
    // 胴体
    if (type === 'king') { this.part(b, 'cyl', 0, by + 0.45, 0, 0.62, 0.95, 0.62, PURPLE); this.part(b, 'box', -0.22, by + 0.35, 0, 0.08, 1.0, 0.7, [0.75, 0.1, 0.15]); }
    else this.part(b, 'cyl', 0, by + 0.42, 0, 0.5, 0.85, 0.5, tc);
    // 頭
    this.part(b, 'sph', 0, by + 1.08, 0, 0.36, 0.38, 0.36, SKIN);
    if (type === 'king') {
      // 大きな冠
      this.part(b, 'cyl', 0, by + 1.33, 0, 0.46, 0.18, 0.46, GOLD);
      for (var i = 0; i < 5; i++) { var a = i / 5 * Math.PI * 2; this.part(b, 'cone', Math.cos(a) * 0.19, by + 1.55, Math.sin(a) * 0.19, 0.14, 0.3, 0.14, GOLD); }
      this.part(b, 'sph', 0.21, by + 1.38, 0, 0.1, 0.1, 0.1, [0.9, 0.1, 0.2]);
      this.part(b, 'box', 0.0, by + 0.75, 0, 0.66, 0.08, 0.66, GOLD);
    } else if (type === 'guard') {
      this.part(b, 'sph', 0, by + 1.2, 0, 0.42, 0.3, 0.42, STEEL);
      this.part(b, 'cone', 0, by + 1.42, 0, 0.12, 0.25, 0.12, td);
    } else if (type === 'archer') {
      this.part(b, 'cone', -0.03, by + 1.3, 0, 0.42, 0.4, 0.42, [0.3, 0.42, 0.18]);
    } else if (mounted) {
      this.part(b, 'sph', 0, by + 1.2, 0, 0.38, 0.22, 0.38, STEEL);
    }
    // 腕と武器
    var armR = M.mul(b, M.trs(0, by + 0.75, 0.33, 0, 0, -0.4 - swing * 1.6, 1, 1, 1));
    this.part(armR, 'box', 0.25, 0, 0, 0.5, 0.13, 0.13, SKIN);
    if (type === 'archer' && !(u.ai && u.ai.dagger)) {
      // 弓（左手で前に構える）と矢筒
      var bow = M.mul(b, M.trs(0.42, by + 0.7, -0.15, 0, 0, 0, 1, 1, 1));
      this.part(bow, 'box', 0, 0, 0, 0.06, 1.25, 0.06, WOOD);
      this.part(bow, 'box', -0.1, 0.55, 0, 0.06, 0.25, 0.06, WOOD, 0, 0, 0.7);
      this.part(bow, 'box', -0.1, -0.55, 0, 0.06, 0.25, 0.06, WOOD, 0, 0, -0.7);
      this.part(bow, 'box', -0.17, 0, 0, 0.015, 1.4, 0.015, WHITE);
      this.part(b, 'cyl', -0.3, by + 0.6, 0.12, 0.2, 0.75, 0.2, [0.45, 0.25, 0.1], 0, 0, 0.3);
      var ar = Math.max(0, Math.min(4, Math.ceil((u.arrows || 0) / 5)));
      for (var q = 0; q < ar; q++) this.part(b, 'box', -0.4, by + 1.05, 0.05 + q * 0.05, 0.03, 0.35, 0.03, WHITE, 0, 0, 0.3);
      this.part(b, 'box', 0.15, by + 0.75, -0.25, 0.4, 0.12, 0.12, SKIN);
    } else if (type === 'archer') {
      this.part(armR, 'box', 0.65, 0, 0, 0.45, 0.05, 0.08, STEEL); // 短剣
    } else {
      var swordLen = type === 'king' ? 1.25 : mounted ? 1.35 : 1.05;
      this.part(armR, 'box', 0.5 + swordLen / 2, 0, 0, swordLen, 0.07, 0.12, STEEL);
      this.part(armR, 'box', 0.52, 0, 0, 0.06, 0.08, 0.38, type === 'king' ? GOLD : DARK);
    }
    if (type === 'guard' || type === 'king') {
      // 盾（左手）
      var sh = M.mul(b, M.trs(0.3, by + 0.55, -0.42, 0, 0, 0, 1, 1, 1));
      this.part(sh, 'box', 0, 0, 0, 0.12, 0.95, 0.75, td);
      this.part(sh, 'box', 0.07, 0, 0, 0.04, 0.8, 0.6, type === 'king' ? GOLD : STEEL);
      this.part(sh, 'sph', 0.1, 0, 0, 0.2, 0.2, 0.2, tc);
    } else if (type !== 'archer') {
      this.part(b, 'box', 0.15, by + 0.75, -0.33, 0.35, 0.13, 0.13, SKIN);
    }
  };

  R.horse = function (b, ox, oz, s, walk, col) {
    var h = M.mul(b, M.trs(ox, 0, oz, 0, 0, 0, s, s, s));
    this.part(h, 'box', 0, 1.15, 0, 1.9, 0.75, 0.62, col);
    this.part(h, 'box', 1.05, 1.55, 0, 0.55, 0.85, 0.36, col, 0, 0, -0.6);
    this.part(h, 'box', 1.42, 1.85, 0, 0.6, 0.32, 0.3, col);
    this.part(h, 'box', 0.95, 1.95, 0, 0.5, 0.16, 0.1, DARK, 0, 0, -0.6);
    this.part(h, 'box', -1.05, 1.15, 0, 0.12, 0.7, 0.12, DARK, 0, 0, 0.5);
    var L = [[0.7, 0.25], [0.7, -0.25], [-0.7, 0.25], [-0.7, -0.25]];
    for (var i = 0; i < 4; i++) {
      var sw = (i % 3 === 0 ? 1 : -1) * walk;
      var leg = M.mul(h, M.trs(L[i][0], 0.85, L[i][1], 0, 0, sw, 1, 1, 1));
      this.part(leg, 'box', 0, -0.42, 0, 0.17, 0.85, 0.17, col);
    }
  };

  R.elephant = function (b, walk, tc, td, swing) {
    this.part(b, 'sph', 0, 2.3, 0, 4.2, 2.6, 2.7, GRAY);
    this.part(b, 'sph', 2.0, 2.7, 0, 1.6, 1.6, 1.5, GRAY);
    // 耳
    this.part(b, 'box', 1.7, 2.8, 0.85, 0.15, 1.3, 1.0, [0.5, 0.5, 0.53], 0.3);
    this.part(b, 'box', 1.7, 2.8, -0.85, 0.15, 1.3, 1.0, [0.5, 0.5, 0.53], -0.3);
    // 鼻
    var tr = M.mul(b, M.trs(2.75, 2.4, 0, 0, 0, -0.25 + swing * 0.8, 1, 1, 1));
    this.part(tr, 'cyl', 0, -0.8, 0, 0.42, 1.7, 0.42, GRAY);
    this.part(tr, 'cyl', 0.15, -1.75, 0, 0.32, 0.5, 0.32, GRAY, 0, 0, 0.5);
    // 牙
    this.part(b, 'cone', 2.9, 1.95, 0.4, 0.18, 1.1, 0.18, WHITE, 0, 0, -1.6);
    this.part(b, 'cone', 2.9, 1.95, -0.4, 0.18, 1.1, 0.18, WHITE, 0, 0, -1.6);
    var L = [[1.2, 0.75], [1.2, -0.75], [-1.2, 0.75], [-1.2, -0.75]];
    for (var i = 0; i < 4; i++) {
      var sw = (i % 3 === 0 ? 1 : -1) * walk * 0.5;
      var leg = M.mul(b, M.trs(L[i][0], 1.4, L[i][1], 0, 0, sw, 1, 1, 1));
      this.part(leg, 'cyl', 0, -0.7, 0, 0.75, 1.5, 0.75, GRAY);
    }
    // 背中の輿（こし）と布
    this.part(b, 'box', -0.3, 3.55, 0, 2.6, 0.12, 2.1, tc);
    this.part(b, 'box', -0.3, 3.85, 0, 1.6, 0.5, 1.4, WOOD);
    this.part(b, 'box', -0.3, 3.2, 1.05, 2.2, 0.9, 0.05, td);
    this.part(b, 'box', -0.3, 3.2, -1.05, 2.2, 0.9, 0.05, td);
  };

  R.chariot = function (b, u, tc, td, walk, swing, now) {
    // 2頭の馬
    this.horse(b, 2.0, 0.55, 0.85, walk, HORSE2);
    this.horse(b, 2.0, -0.55, 0.85, walk, HORSE2);
    this.part(b, 'box', 1.3, 1.0, 0, 2.2, 0.1, 0.1, WOOD);                 // 轅（ながえ）
    // 車体
    this.part(b, 'box', -0.4, 0.95, 0, 1.3, 0.12, 1.6, WOOD);
    this.part(b, 'box', 0.2, 1.35, 0, 0.1, 0.8, 1.6, tc);
    this.part(b, 'box', -0.4, 1.3, 0.78, 1.2, 0.7, 0.08, td);
    this.part(b, 'box', -0.4, 1.3, -0.78, 1.2, 0.7, 0.08, td);
    // 車輪（回転）と刃
    var rot = u.alive ? (u._wheel = (u._wheel || 0) + u.spd * 0.03) : 0;
    for (var s = -1; s <= 1; s += 2) {
      var wh = M.mul(b, M.trs(-0.4, 0.75, s * 0.95, 0, Math.PI / 2, rot, 1, 1, 1));
      this.part(wh, 'cyl', 0, 0, 0, 1.5, 0.12, 1.5, [0.32, 0.2, 0.1]);
      this.part(wh, 'box', 0, 0, 0, 1.4, 0.15, 0.1, DARK);
      this.part(wh, 'box', 0, 0, 0, 0.1, 0.15, 1.4, DARK);
      this.part(b, 'box', -0.4, 0.75, s * 1.35, 0.1, 0.1, 0.8, STEEL);      // 車軸の刃
    }
    var rider = M.mul(b, M.trs(-0.45, 1.0, 0, 0, 0, 0, 1, 1, 1));
    this.humanoid(rider, tc, td, 0, swing, 'rider', u);
  };

  R.drawObstacle = function (o, now) {
    var base = M.ident();
    if (o.kind === 'fwall') {
      // 城壁：石の壁と胸壁（城壁の上の通路の外側）
      var STONE = [0.6, 0.58, 0.54];
      this.part(base, 'box', o.x, o.y0 + o.h / 2, o.z, o.hw * 2, o.h, o.hd * 2, STONE);
      var outer = o.team === 0 ? 1 : -1, n = Math.floor(o.hd * 2 / 3);
      for (var i = 0; i < n; i++) this.part(base, 'box', o.x + outer * (o.hw - 0.3), o.y0 + o.h + 0.5, o.z - o.hd + (i + 0.5) * (o.hd * 2 / n), 0.5, 1.0, 1.4, [0.55, 0.53, 0.5]);
      return;
    }
    if (o.kind === 'gate') {
      var gt = o.g, x = o.x, zc = o.z, H = o.h;
      // 門の上の梁と柱
      this.part(base, 'box', x, H + 0.4, zc, o.hw * 2 + 0.4, 1.6, o.hd * 2 + 0.6, [0.5, 0.48, 0.45]);
      if (gt && gt.state === 'broken') {
        for (var k = 0; k < 6; k++) this.part(base, 'box', x + ((k * 37) % 5 - 2) * 0.6, 0.25, zc + ((k * 53) % 9 - 4) * 0.9, 1.2, 0.5, 0.9, [0.42, 0.3, 0.18], k * 0.7);
        return;
      }
      var open = gt ? gt.prog : 0, WOOD2 = gt && gt.hp < gt.maxHp * 0.35 ? [0.35, 0.22, 0.12] : [0.5, 0.32, 0.16];
      // 2枚の扉が城壁の内側へ回って開く
      var inward = o.team === 0 ? -1 : 1;
      for (var s = -1; s <= 1; s += 2) {
        var hinge = zc + s * o.hd, ang = -open * Math.PI / 2 * s * inward;
        var dm = M.mul(M.trs(x, 0, hinge, ang, 0, 0, 1, 1, 1), M.trs(0, H / 2, -s * o.hd / 2, 0, 0, 0, 0.5, H, o.hd));
        this.push('box', dm, WOOD2[0], WOOD2[1], WOOD2[2]);
      }
      return;
    }
    if (o.kind === 'rock') this.part(base, 'sph', o.x, o.y0 + o.h * 0.5, o.z, o.r * 2.1, o.h * 1.3, o.r * 1.9, [0.5, 0.49, 0.47]);
    else if (o.kind === 'tree') {
      this.part(base, 'cyl', o.x, o.y0 + o.h * 0.3, o.z, o.r * 1.2, o.h * 0.6, o.r * 1.2, [0.38, 0.25, 0.13]);
      this.part(base, 'cone', o.x, o.y0 + o.h * 0.7, o.z, o.canopyR * 2.1, o.h * 0.7, o.canopyR * 2.1, [0.16, 0.42, 0.18]);
    } else if (o.kind === 'wall') {
      this.part(base, 'box', o.x, o.y0 + o.h / 2, o.z, o.hw * 2, o.h + 0.6, o.hd * 2, [0.62, 0.58, 0.5]);
    } else {
      this.part(base, 'box', o.x, o.y0 + o.h / 2, o.z, o.hw * 2, o.h + 0.6, o.hd * 2, [0.78, 0.7, 0.55]);
      var roof = M.trs(o.x, o.y0 + o.h + 0.3 + 1.0, o.z, Math.PI / 4, 0, 0, o.hw * 2.0, 2.0, o.hd * 2.0);
      this.push('pyr', roof, 0.6, 0.25, 0.18);
      this.part(base, 'box', o.x + o.hw, o.y0 + 1.0, o.z, 0.1, 2.0, 1.2, [0.3, 0.2, 0.12]);
    }
  };

  R.drawSupply = function (sim, team) {
    var s = sim.supply[team], y = sim.heightAt(s.x, s.z), base = M.ident(), tc = TEAMC[team];
    this.part(base, 'cyl', s.x, y + 0.05, s.z, sim.cfg.field.supplyRadius * 2, 0.08, sim.cfg.field.supplyRadius * 2, [tc[0] * 0.5 + 0.4, tc[1] * 0.5 + 0.4, tc[2] * 0.5 + 0.4]);
    for (var i = 0; i < 4; i++) this.part(base, 'box', s.x + (i % 2) * 1.2 - 0.6, y + 0.4 + (i > 1 ? 0.8 : 0), s.z + 1.5, 1.0, 0.8, 1.0, WOOD);
    // 矢の束
    for (var k = 0; k < 6; k++) this.part(base, 'box', s.x - 1.5 + k * 0.12, y + 0.8, s.z - 1.5, 0.05, 1.6, 0.05, WHITE, 0, 0.15 * (k - 3), 0);
    this.part(base, 'cyl', s.x + 2, y + 3, s.z, 0.12, 6, 0.12, WOOD);
    this.part(base, 'box', s.x + 2.8, y + 5.3, s.z, 1.5, 1.0, 0.05, tc);
  };

  R.drawArrow = function (a, sim) {
    var x = a.x, y = a.y, z = a.z, vx = a.vx, vy = a.vy, vz = a.vz;
    if (!a.alive && a.stuckOn) {
      var su = sim.unitById(a.stuckOn);
      if (su) { if (!su.alive && su.deadT > 1.5) return; x = su.x + a.relX; y = su.y + a.relY; z = su.z + a.relZ; }
    }
    var l = Math.hypot(vx, vy, vz) || 1;
    var yaw = Math.atan2(vz, vx), pitch = Math.asin(vy / l);
    var m = M.trs(x - vx / l * 0.4, y - vy / l * 0.4, z - vz / l * 0.4, -yaw, 0, pitch, 0.9, 0.05, 0.05);
    this.push('box', m, 0.25, 0.18, 0.1);
    var m2 = M.trs(x - vx / l * 0.82, y - vy / l * 0.82, z - vz / l * 0.82, -yaw, 0, pitch, 0.14, 0.14, 0.03);
    this.push('box', m2, a.team === 0 ? 0.5 : 1, 0.95, a.team === 0 ? 1 : 0.5, true);
  };

  // 地面の矢印（作戦の進軍先などを表示）
  R.groundArrow = function (sim, x0, z0, x1, z1, col, w, dash) {
    var dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz); if (L < 1) return;
    var ux = dx / L, uz = dz / L, yaw = -Math.atan2(dz, dx), step = dash ? 3.2 : 2.0, seg = dash ? 1.8 : 2.1;
    w = w || 1.0;
    for (var t = 0; t < L - 3; t += step) {
      var cx = x0 + ux * (t + seg / 2), cz = z0 + uz * (t + seg / 2);
      this.push('box', M.trs(cx, sim.heightAt(cx, cz) + 0.18, cz, yaw, 0, 0, seg, 0.08, w), col[0], col[1], col[2], true);
    }
    var hx = x1 - ux * 1.6, hz = z1 - uz * 1.6;
    this.push('pyr', M.trs(hx, sim.heightAt(hx, hz) + 0.25, hz, yaw, Math.PI / 4, -Math.PI / 2, w * 2.4, 3.2, w * 2.4), col[0], col[1], col[2], true);
  };
  // 部隊の旗（作戦画面の配置位置）
  R.flag = function (sim, x, z, col, big) {
    var y = sim.heightAt(x, z), s = big ? 1.4 : 1;
    this.part(M.ident(), 'cyl', x, y + 3 * s, z, 0.18 * s, 6 * s, 0.18 * s, [0.35, 0.25, 0.15]);
    this.push('box', M.trs(x, y + 5.2 * s, z + 1.1 * s, -this.cam.yaw + Math.PI / 2, 0, 0, 2.2 * s, 1.4 * s, 0.08), col[0], col[1], col[2], true);
    this.push('cyl', M.trs(x, y + 0.1, z, 0, 0, 0, 7 * s, 0.06, 7 * s), col[0] * 0.6, col[1] * 0.6, col[2] * 0.6, true);
  };
  R.disc = function (sim, x, z, r, col) { this.push('cyl', M.trs(x, sim.heightAt(x, z) + 0.12, z, 0, 0, 0, r * 2, 0.06, r * 2), col[0], col[1], col[2], true); };
  // 城壁戦：階段・見えない敵の城壁内（霧）
  R.drawFortress = function (sim, state) {
    var w = sim.fort, c = sim.cfg.fortress, base = M.ident();
    for (var t = 0; t < 2; t++) {
      w.stairs[t].forEach(function (st) {
        var len = Math.abs(st.base.x - st.top.x) + 1.5, mx = (st.base.x + w.innerFace[t]) / 2;
        var ang = Math.atan2(c.wallHeight, len) * (t === 0 ? -1 : 1);
        this.part(base, 'box', mx, c.wallHeight / 2, st.z, len, 0.4, 2.4, [0.5, 0.47, 0.42], 0, 0, ang);
      }, this);
      if (state.fogTeam != null && state.fogTeam !== t && !w.broken[t]) {
        var x0 = t === 0 ? -c.width / 2 : w.innerFace[1], x1 = t === 0 ? w.innerFace[0] : c.width / 2;
        this.push('box', M.trs((x0 + x1) / 2, 0.35, 0, 0, 0, 0, Math.abs(x1 - x0), 0.5, c.depth), 0.2, 0.22, 0.26, true);
      }
    }
  };
  R.marker = function (x, y, z, col, r) { this.part(M.ident(), 'cyl', x, y + 0.08, z, r || 1.2, 0.08, r || 1.2, col); this.part(M.ident(), 'cyl', x, y + 1.0, z, 0.1, 2.0, 0.1, col); };

  R.render = function (sim, state) {
    var gl = this.gl, cv = this.canvas;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0.7, 0.8, 0.9, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.updateCamera(W, H);
    this.begin();
    var now = state.now, i;
    var sel = state.selected || {};
    for (i = 0; i < sim.obstacles.length; i++) this.drawObstacle(sim.obstacles[i], now);
    if (!sim.fort) { this.drawSupply(sim, 0); this.drawSupply(sim, 1); }
    if (sim.fort) this.drawFortress(sim, state);
    for (i = 0; i < sim.units.length; i++) { var u = sim.units[i]; if (state.hide && state.hide(u)) continue; this.drawUnit(sim, u, sel[u.id] ? 1 : (state.hoverTarget === u.id ? 2 : 0), now, state); }
    if (state.overlay) state.overlay(this, sim, now);
    for (i = 0; i < sim.arrows.length; i++) this.drawArrow(sim.arrows[i], sim);
    if (state.markers) state.markers.forEach(function (mk) { this.marker(mk.x, sim.heightAt(mk.x, mk.z), mk.z, mk.col, mk.r); }, this);
    if (state.dragBox3D) {} // 範囲選択は画面上の枠で表示
    // 描画
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uvp, false, new Float32Array(this.vp));
    gl.uniform3fv(this.ueye, new Float32Array(this.eye));
    gl.uniform1f(this.ufog, Math.max(220, Math.max(sim.W, sim.D) * 1.1));
    // 地形（インスタンス属性は定数で単位行列）
    var L = this.loc;
    gl.bindVertexArray(this.terrain.vao);
    [L.i_m0, L.i_m1, L.i_m2, L.i_m3, L.i_col].forEach(function (l) { gl.disableVertexAttribArray(l); });
    gl.vertexAttrib4f(L.i_m0, 1, 0, 0, 0); gl.vertexAttrib4f(L.i_m1, 0, 1, 0, 0); gl.vertexAttrib4f(L.i_m2, 0, 0, 1, 0); gl.vertexAttrib4f(L.i_m3, 0, 0, 0, 1); gl.vertexAttrib4f(L.i_col, 1, 1, 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, this.terrain.count);
    // インスタンス
    for (var name in this.batches) {
      var bt = this.batches[name]; if (!bt.n) continue;
      var mesh = this.meshes[name];
      gl.bindVertexArray(mesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, bt.data.subarray(0, bt.n * 20), gl.DYNAMIC_DRAW);
      var locs = [L.i_m0, L.i_m1, L.i_m2, L.i_m3, L.i_col];
      for (var k = 0; k < 5; k++) { gl.enableVertexAttribArray(locs[k]); gl.vertexAttribPointer(locs[k], 4, gl.FLOAT, false, 80, k * 16); gl.vertexAttribDivisor(locs[k], 1); }
      gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, bt.n);
      for (k = 0; k < 5; k++) { gl.vertexAttribDivisor(locs[k], 0); gl.disableVertexAttribArray(locs[k]); }
    }
    gl.bindVertexArray(null);
  };
})(typeof window !== 'undefined' ? window : globalThis);
