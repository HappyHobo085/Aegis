// Farble "standard" document-start shim — perturbs canvas/audio/navigator-UA-CH reads with
// deterministic per-frame-origin, per-session noise. FAIL-OPEN: any error leaves the original
// value, and nothing throws at document-start. Seed literal `__aegisFarbleSeed` (hex) is
// prepended by Rust; it is HKDF(salt) — one-way, never the raw salt. Per-FRAME-origin: a
// cross-origin iframe seeds on its own location.origin (window.top is unreadable cross-origin).
//
// This file is the SHIPPED artifact: Rust includes it verbatim via include_str! and the
// vitest runtime test (src/lib/farbleShim.test.ts) executes it — catching behavioral bugs
// that a string-assertion (the Rust marker test) cannot.
(function () {
  try {
    var SEEDHEX = typeof __aegisFarbleSeed === 'string' ? __aegisFarbleSeed : '';
    if (!SEEDHEX) return; // no seed → no-op (fail-open)

    // ---- hex → byte array ----
    function hexToBytes(h) {
      var a = [];
      for (var i = 0; i < h.length; i += 2) a.push(parseInt(h.substr(i, 2), 16));
      return a;
    }

    // ---- tiny self-contained SHA-256 (sync, no Web Crypto async dependency) ----
    // Standard 64-round SHA-256 over a byte array → 32-byte array.
    function sha256(bytes) {
      var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
      ];
      var H = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
      ];
      var msgLen = bytes.length;
      var bitLen = msgLen * 8;
      bytes = bytes.slice();
      bytes.push(0x80);
      while (bytes.length % 64 !== 56) bytes.push(0);
      // big-endian 64-bit length (hi=0 since msgLen < 2^29)
      bytes.push(0, 0, 0, 0);
      bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
      for (var chunk = 0; chunk < bytes.length; chunk += 64) {
        var w = [];
        for (var i = 0; i < 16; i++) {
          w[i] =
            (bytes[chunk + i * 4] << 24) |
            (bytes[chunk + i * 4 + 1] << 16) |
            (bytes[chunk + i * 4 + 2] << 8) |
            bytes[chunk + i * 4 + 3];
        }
        for (var i = 16; i < 64; i++) {
          var s0 =
            (((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
              ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
              (w[i - 15] >>> 3)) >>>
            0;
          var s1 =
            (((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
              ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
              (w[i - 2] >>> 10)) >>>
            0;
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        var a = H[0],
          b = H[1],
          c = H[2],
          d = H[3],
          e = H[4],
          f = H[5],
          g = H[6],
          h = H[7];
        for (var i = 0; i < 64; i++) {
          var S1 =
            (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
          var ch = ((e & f) ^ (~e & g)) >>> 0;
          var temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
          var S0 =
            (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
          var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
          var temp2 = (S0 + maj) >>> 0;
          h = g;
          g = f;
          f = e;
          e = (d + temp1) >>> 0;
          d = c;
          c = b;
          b = a;
          a = (temp1 + temp2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0;
        H[1] = (H[1] + b) >>> 0;
        H[2] = (H[2] + c) >>> 0;
        H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0;
        H[5] = (H[5] + f) >>> 0;
        H[6] = (H[6] + g) >>> 0;
        H[7] = (H[7] + h) >>> 0;
      }
      var out = [];
      for (var i = 0; i < 8; i++) {
        out.push(
          (H[i] >>> 24) & 0xff,
          (H[i] >>> 16) & 0xff,
          (H[i] >>> 8) & 0xff,
          H[i] & 0xff,
        );
      }
      return out;
    }

    // ---- per-ORIGIN one-way sub-seed ----
    // sub = SHA-256(SEED_bytes ++ origin_bytes)[..8]
    // One-way: observing sub reveals nothing about SEED (HKDF-derived one-way input).
    var origin = '';
    try {
      origin = String(location.origin || '');
    } catch (e) {}
    var seedBytes = hexToBytes(SEEDHEX);
    var originBytes = [];
    for (var _oi = 0; _oi < origin.length; _oi++) {
      originBytes.push(origin.charCodeAt(_oi) & 0xff);
    }
    var sub = sha256(seedBytes.concat(originBytes)).slice(0, 8);

    // ---- xoshiro128** PRNG seeded from sub (deterministic noise stream) ----
    var _s0 = (sub[0] | (sub[1] << 8) | (sub[2] << 16) | (sub[3] << 24)) >>> 0;
    var _s1 = (sub[4] | (sub[5] << 8) | (sub[6] << 16) | (sub[7] << 24)) >>> 0;
    var _s2 = 0x9e3779b9;
    var _s3 = 0x243f6a88;
    function _rotl(x, k) {
      return ((x << k) | (x >>> (32 - k))) >>> 0;
    }
    function _next() {
      var r = (_rotl((_s1 * 5) >>> 0, 7) * 9) >>> 0;
      var t = (_s1 << 9) >>> 0;
      _s2 ^= _s0;
      _s3 ^= _s1;
      _s1 ^= _s2;
      _s0 ^= _s3;
      _s2 ^= t;
      _s3 = _rotl(_s3, 11);
      return r;
    }
    function _noiseByte() {
      return (_next() % 3) - 1;
    } // -1, 0, +1 (single LSB step)
    function _noiseFloat() {
      return (_next() / 4294967296) * 2e-7 - 1e-7;
    } // [-1e-7, +1e-7)

    // ---- PRNG snapshot for deterministic per-call replay ----
    // Canvas getImageData / toDataURL must return IDENTICAL values on repeated calls
    // within the same session+origin (no per-call jitter). We snapshot the PRNG state
    // after seeding and replay from the SAME snapshot for every read of a given canvas.
    // Approach: save the initial PRNG state; derive a deterministic per-canvas noise
    // stream by resetting from the snapshot + a canvas-specific counter per pixel read.
    // Simpler approach used here: for getImageData, we add noise driven by pixel INDEX
    // (not PRNG stream advancement), so the noise is index-deterministic and identical
    // every call regardless of call order or PRNG position.
    //
    // Implementation: noiseByte for pixel index i = ((sub[i%8] & 1) ? +1 : -1) * ((sub[(i+1)%8] >> 1) % 2)
    // → too complex. Instead: store PRNG snapshots per canvas by WeakMap, replay each.
    var _canvasNoise = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

    function _getCanvasNoise(canvas, count) {
      // Return an array of `count` noise bytes, DETERMINISTIC for this canvas object.
      // Uses a WeakMap so the noise is stable across repeated getImageData calls.
      if (_canvasNoise) {
        var cached = _canvasNoise.get(canvas);
        if (cached && cached.length >= count) return cached;
        // Generate enough noise for this canvas (up to count bytes).
        // Snapshot PRNG state before generation, restore after, so other surfaces
        // don't consume from the canvas noise stream.
        var save0 = _s0,
          save1 = _s1,
          save2 = _s2,
          save3 = _s3;
        var noise = [];
        for (var i = 0; i < count; i++) noise.push(_noiseByte());
        _s0 = save0;
        _s1 = save1;
        _s2 = save2;
        _s3 = save3;
        _canvasNoise.set(canvas, noise);
        return noise;
      }
      // No WeakMap: fall back to index-based noise (still deterministic per-call).
      var noise = [];
      for (var i = 0; i < count; i++) noise.push((sub[i % 8] & 1) ? 1 : -1);
      return noise;
    }

    // ---- markNative: make patched fns report [native code] via toString override ----
    // We override Function.prototype.toString (once) to intercept calls on our registered
    // patched functions, which are stored in a WeakSet. This is the approach that survives
    // `Function.prototype.toString.call(fn)` checks from page code (the instance-level
    // toString override is bypassed by such calls; the prototype-level override is not).
    var _nativeFns = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var _nativeNames = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    try {
      var _origFnToString = Function.prototype.toString;
      Function.prototype.toString = function () {
        if (_nativeFns && _nativeFns.has(this)) {
          var n = (_nativeNames && _nativeNames.get(this)) || this.name || '';
          return 'function ' + n + '() { [native code] }';
        }
        return _origFnToString.call(this);
      };
    } catch (e) {}
    function _markNative(fn, name) {
      try {
        if (_nativeFns) _nativeFns.add(fn);
        if (_nativeNames && name) _nativeNames.set(fn, name);
      } catch (e) {}
      return fn;
    }

    // ---- CANVAS: getImageData ----
    try {
      var _origGID = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = _markNative(function getImageData() {
        var img;
        try {
          img = _origGID.apply(this, arguments);
        } catch (e) {
          return _origGID.apply(this, arguments);
        }
        try {
          var d = img.data;
          var canvas = this.canvas;
          var noise = _getCanvasNoise(canvas, d.length / 4);
          for (var i = 0; i < d.length; i += 4) {
            var nb = noise[i / 4];
            d[i] = Math.max(0, Math.min(255, d[i] + nb));
            // alpha channel (i+3) unchanged — alpha perturbation breaks compositing
          }
        } catch (e) {}
        return img;
      }, 'getImageData');
    } catch (e) {}

    // ---- CANVAS: toDataURL / toBlob ----
    // These serialize the canvas. We perturb via a getImageData+putImageData on a temp
    // context before serializing, using the SAME deterministic noise as above.
    try {
      var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = _markNative(function toDataURL() {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            // getImageData is already patched → will apply deterministic noise.
            var idata = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
            ctx.putImageData(idata, 0, 0);
          }
        } catch (e) {}
        return _origToDataURL.apply(this, arguments);
      }, 'toDataURL');
    } catch (e) {}

    try {
      var _origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (typeof _origToBlob === 'function') {
        HTMLCanvasElement.prototype.toBlob = _markNative(function toBlob() {
          try {
            var ctx = this.getContext('2d');
            if (ctx) {
              var idata = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
              ctx.putImageData(idata, 0, 0);
            }
          } catch (e) {}
          return _origToBlob.apply(this, arguments);
        }, 'toBlob');
      }
    } catch (e) {}

    // ---- AUDIO: AnalyserNode.getFloatFrequencyData ----
    try {
      if (typeof AnalyserNode !== 'undefined') {
        var _origGFFD = AnalyserNode.prototype.getFloatFrequencyData;
        if (typeof _origGFFD === 'function') {
          AnalyserNode.prototype.getFloatFrequencyData = _markNative(
            function getFloatFrequencyData(arr) {
              try {
                _origGFFD.call(this, arr);
              } catch (e) {
                return;
              }
              try {
                for (var i = 0; i < arr.length; i++) {
                  if (isFinite(arr[i])) arr[i] += _noiseFloat();
                }
              } catch (e) {}
            },
            'getFloatFrequencyData',
          );
        }
      }
    } catch (e) {}

    // ---- AUDIO: AudioBuffer.getChannelData ----
    try {
      if (typeof AudioBuffer !== 'undefined') {
        var _origGCD = AudioBuffer.prototype.getChannelData;
        if (typeof _origGCD === 'function') {
          AudioBuffer.prototype.getChannelData = _markNative(function getChannelData() {
            var buf;
            try {
              buf = _origGCD.apply(this, arguments);
            } catch (e) {
              return _origGCD.apply(this, arguments);
            }
            try {
              for (var i = 0; i < buf.length; i++) {
                buf[i] = Math.max(-1, Math.min(1, buf[i] + _noiseFloat()));
              }
            } catch (e) {}
            return buf;
          }, 'getChannelData');
        }
      }
    } catch (e) {}

    // ---- NAVIGATOR: hardwareConcurrency ----
    // Clamp to {2,4,8} — removes the exact-core-count fingerprint tell.
    try {
      var _realHC =
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency != null
          ? navigator.hardwareConcurrency
          : 4;
      var _hcOptions = [2, 4, 8];
      // Pick the largest value that is <= real concurrency (never inflates).
      var _hcVal = 2;
      for (var _hci = 0; _hci < _hcOptions.length; _hci++) {
        if (_hcOptions[_hci] <= _realHC) _hcVal = _hcOptions[_hci];
      }
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
        get: function () {
          return _hcVal;
        },
        configurable: true,
      });
    } catch (e) {}

    // ---- NAVIGATOR: userAgentData.brands ----
    // Normalize brands to the Chrome-148 set so UA-CH can't expose engine version.
    // Only patch if the platform exposes NavigatorUAData (Chromium-based).
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.userAgentData &&
        typeof navigator.userAgentData === 'object'
      ) {
        var _ua = navigator.userAgentData;
        var _chromeBrands = [
          { brand: 'Not/A)Brand', version: '8' },
          { brand: 'Chromium', version: '148' },
          { brand: 'Google Chrome', version: '148' },
        ];
        try {
          Object.defineProperty(_ua, 'brands', {
            get: function () {
              return _chromeBrands;
            },
            configurable: true,
          });
        } catch (e) {}
        // getHighEntropyValues: normalize brands in result; pass through rest.
        try {
          var _origGHEV = _ua.getHighEntropyValues;
          if (typeof _origGHEV === 'function') {
            _ua.getHighEntropyValues = _markNative(function getHighEntropyValues(hints) {
              var p;
              try {
                p = _origGHEV.call(_ua, hints);
              } catch (e) {
                return Promise.resolve({});
              }
              if (p && typeof p.then === 'function') {
                return p.then(function (res) {
                  try {
                    if (res && res.brands) res = Object.assign({}, res, { brands: _chromeBrands });
                    if (res && res.fullVersionList)
                      res = Object.assign({}, res, { fullVersionList: _chromeBrands });
                  } catch (e) {}
                  return res;
                });
              }
              return p;
            }, 'getHighEntropyValues');
          }
        } catch (e) {}
      }
    } catch (e) {}
  } catch (e) {}
})();
