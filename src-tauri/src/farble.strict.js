// Farble "strict" document-start shim — perturbs canvas/audio/navigator-UA-CH reads (same
// as standard) PLUS WebGL fingerprint surfaces: getParameter (VENDOR/RENDERER/UNMASKED_*/
// precision params), readPixels (LSB noise), getSupportedExtensions (stable shuffle), and
// getShaderPrecisionFormat (range/precision nudge). FAIL-OPEN everywhere: any error leaves
// the original value; nothing throws at document-start. The seed (hex) is baked into the
// IIFE parameter call by Rust (placeholder substitution of `__AEGIS_FARBLE_SEED__`), so
// SEEDHEX is a closure-local parameter — NEVER a top-level var, NEVER window.*. After the
// shim runs, window.__aegisFarbleSeed is undefined.
// Same one-way, per-origin-sub-seed, xoshiro128** PRNG design as the standard shim.
//
// This file is the SHIPPED artifact: Rust includes it verbatim via include_str! and the
// vitest runtime test (src/lib/farbleShim.test.ts) executes it — catching behavioral bugs
// that a string-assertion (the Rust marker test) cannot.
(function (SEEDHEX) {
  try {
    if (typeof SEEDHEX !== 'string' || !SEEDHEX) return; // no seed → no-op (fail-open)

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

    // ============================================================

    // ---- Plugins fingerprinting protection ----
    if (typeof navigator !== 'undefined' && navigator.plugins && typeof navigator.plugins.length === 'number') {
      try {
        const pluginsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'plugins');
        if (pluginsDescriptor && pluginsDescriptor.configurable) {
          const seedBytes = hexToBytes(SEEDHEX);
          let seedNum = 0;
          for (let i = 0; i < Math.min(seedBytes.length, 4); i++) {
            seedNum = (seedNum << 8) | seedBytes[i];
          }
          // Combine with origin for per-origin variation
          const originStr = typeof location !== 'undefined' && location ? location.href : '';
          let originHash = 0;
          for (let i = 0; i < originStr.length; i++) {
            originHash = (originHash << 5) - originHash + originStr.charCodeAt(i);
            originHash |= 0; // Convert to 32bit integer
          }
          const combinedSeed = seedNum ^ originHash;
          const fakeLength = ((combinedSeed & 0xFF) % 7) + 1; // Range 1-7
          
          Object.defineProperty(navigator, 'plugins', {
            configurable: true,
            get: function() {
              // Return a plugin-like object with the masked length
              const fakePlugins = {
                length: fakeLength,
                item: function(index) {
                  return null || undefined;
                },
                namedItem: function(name) {
                  return null || undefined;
                }
              };
              // Make it array-like
              for (let i = 0; i < fakeLength; i++) {
                this[i] = null;
              }
              return fakePlugins;
            }
          });
        }
      } catch (e) {
        // Fail-open: if we can't protect plugins, continue without breaking
      }
    }
    // STRICT-ONLY: WebGL fingerprint perturbation
    // ============================================================
    // Plausible strings returned for string params (VENDOR/RENDERER/UNMASKED_*).
    // These are stable for a given (seed, origin) pair — deterministic, not random.
    var _webglVendors = ['Intel Inc.', 'Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Intel'];
    var _webglRenderers = [
      'Intel Iris OpenGL Engine',
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ];

    // Pick a deterministic index from sub bytes.
    var _wglVendorIdx = sub[0] % _webglVendors.length;
    var _wglRendererIdx = sub[1] % _webglRenderers.length;
    var _wglVendorStr = _webglVendors[_wglVendorIdx];
    var _wglRendererStr = _webglRenderers[_wglRendererIdx];

    // WebGL numeric parameter constants (must match WebGL spec values).
    var _VENDOR = 0x1f00;
    var _RENDERER = 0x1f01;
    var _UNMASKED_VENDOR_WEBGL = 0x9245;
    var _UNMASKED_RENDERER_WEBGL = 0x9246;

    // Precision params: parameter constants used with getParameter for precision info.
    // These return numbers we can nudge slightly (within valid range) for fingerprint noise.
    // We recognize them by pname being in the "precision-adjacent" range and add a tiny
    // deterministic tweak to the returned integer.
    // Max texture size / max viewport dims / max vertex attribs etc. — standard getParameter
    // integer params. We shift by sub[2]%3 - 1 (-1,0,+1) for plausibility.
    var _PRECISION_INT_PARAMS = {
      0x0d33: true, // MAX_TEXTURE_SIZE
      0x8869: true, // MAX_VERTEX_ATTRIBS
      0x8b4c: true, // MAX_VERTEX_UNIFORM_VECTORS
      0x8b4d: true, // MAX_VARYING_VECTORS
      0x8b4e: true, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
      0x8b4f: true, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
      0x8872: true, // MAX_TEXTURE_IMAGE_UNITS
      0x8b49: true, // MAX_FRAGMENT_UNIFORM_VECTORS
      0x0d3a: true, // MAX_VIEWPORT_DIMS (returns Int32Array — we skip for safety)
    };

    // Helper: patch getParameter on a WebGL context constructor.
    function _patchWebGLGetParameter(CtorProto, ctorName) {
      try {
        if (!CtorProto || typeof CtorProto.getParameter !== 'function') return;
        var _origGP = CtorProto.getParameter;
        CtorProto.getParameter = _markNative(function getParameter(pname) {
          var orig;
          try {
            orig = _origGP.call(this, pname);
          } catch (e) {
            // FAIL-OPEN: return whatever the original would have returned.
            try { return _origGP.call(this, pname); } catch (e2) { return null; }
          }
          try {
            if (pname === _VENDOR || pname === _UNMASKED_VENDOR_WEBGL) {
              return _wglVendorStr;
            }
            if (pname === _RENDERER || pname === _UNMASKED_RENDERER_WEBGL) {
              return _wglRendererStr;
            }
            // For integer params: nudge by -1/0/+1 deterministically, never below 1.
            if (_PRECISION_INT_PARAMS[pname] && typeof orig === 'number' && isFinite(orig)) {
              var nudge = (sub[2] % 3) - 1; // -1, 0, or +1
              return Math.max(1, orig + nudge);
            }
          } catch (e) {}
          return orig;
        }, 'getParameter');
      } catch (e) {}
    }

    // ---- WebGL: WebGLRenderingContext.getParameter ----
    try {
      if (typeof WebGLRenderingContext !== 'undefined') {
        _patchWebGLGetParameter(WebGLRenderingContext.prototype, 'WebGLRenderingContext');
      }
    } catch (e) {}

    // ---- WebGL2: WebGL2RenderingContext.getParameter ----
    try {
      if (typeof WebGL2RenderingContext !== 'undefined') {
        _patchWebGLGetParameter(WebGL2RenderingContext.prototype, 'WebGL2RenderingContext');
      }
    } catch (e) {}

    // ---- WebGL: readPixels (LSB noise on RGBA output) ----
    // readPixels writes into a caller-supplied ArrayBufferView. We add ±1 noise on the
    // R channel of each pixel (same approach as canvas getImageData). FAIL-OPEN.
    // Only modify when format=RGBA and type=UNSIGNED_BYTE to avoid memory corruption.
    function _patchReadPixels(CtorProto) {
      try {
        if (!CtorProto || typeof CtorProto.readPixels !== 'function') return;
        var _origRP = CtorProto.readPixels;
        CtorProto.readPixels = _markNative(function readPixels(x, y, w, h, format, type, pixels) {
          try {
            _origRP.call(this, x, y, w, h, format, type, pixels);
          } catch (e) {
            // FAIL-OPEN: attempt call regardless; if it throws, leave pixels as-is.
            try { _origRP.call(this, x, y, w, h, format, type, pixels); } catch (e2) {}
            return;
          }
          try {
            // Only perturb UInt8Array/UInt8ClampedArray output when format=RGBA and type=UNSIGNED_BYTE
            // Format: 0x1908 = GL_RGBA, Type: 0x1401 = GL_UNSIGNED_BYTE
            if (pixels &&
                (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) &&
                format === 0x1908 &&
                type === 0x1401) {
              for (var i = 0; i < pixels.length; i += 4) {
                var nb = _noiseByte();
                pixels[i] = Math.max(0, Math.min(255, pixels[i] + nb));
                // alpha (i+3) unchanged — see canvas getImageData comment.
              }
            }
          } catch (e) {}
        }, 'readPixels');
      } catch (e) {}
    }

    try {
      if (typeof WebGLRenderingContext !== 'undefined') {
        _patchReadPixels(WebGLRenderingContext.prototype);
      }
    } catch (e) {}

    try {
      if (typeof WebGL2RenderingContext !== 'undefined') {
        _patchReadPixels(WebGL2RenderingContext.prototype);
      }
    } catch (e) {}

    // ---- WebGL: getSupportedExtensions (stable per-origin shuffle) ----
    // Return the real list but in a deterministic per-origin order so the
    // extension count and members are unchanged but the fingerprint-by-order differs.
    // FAIL-OPEN: if the real call fails, return null (WebGL spec says that's valid).
    function _patchGetSupportedExtensions(CtorProto) {
      try {
        if (!CtorProto || typeof CtorProto.getSupportedExtensions !== 'function') return;
        var _origGSE = CtorProto.getSupportedExtensions;
        CtorProto.getSupportedExtensions = _markNative(function getSupportedExtensions() {
          var exts;
          try {
            exts = _origGSE.call(this);
          } catch (e) {
            return null; // FAIL-OPEN
          }
          try {
            if (!exts || !exts.length) return exts;
            // Fisher-Yates shuffle seeded from sub — deterministic per origin.
            exts = exts.slice(); // don't mutate the original
            for (var i = exts.length - 1; i > 0; i--) {
              var j = ((sub[i % 8] ^ sub[(i + 1) % 8]) + i) % (i + 1);
              var tmp = exts[i]; exts[i] = exts[j]; exts[j] = tmp;
            }
          } catch (e) {}
          return exts;
        }, 'getSupportedExtensions');
      } catch (e) {}
    }

    try {
      if (typeof WebGLRenderingContext !== 'undefined') {
        _patchGetSupportedExtensions(WebGLRenderingContext.prototype);
      }
    } catch (e) {}

    try {
      if (typeof WebGL2RenderingContext !== 'undefined') {
        _patchGetSupportedExtensions(WebGL2RenderingContext.prototype);
      }
    } catch (e) {}

    // ---- WebGL: getShaderPrecisionFormat (range/precision nudge) ----
    // Returns a WebGLShaderPrecisionFormat with {rangeMin, rangeMax, precision}.
    // We nudge rangeMin/rangeMax by sub[3]%3-1 and precision by sub[4]%3-1
    // (within the spec: values are powers-of-two exponents, nudging ±1 is plausible).
    // FAIL-OPEN: return original on any error.
    function _patchGetShaderPrecisionFormat(CtorProto) {
      try {
        if (!CtorProto || typeof CtorProto.getShaderPrecisionFormat !== 'function') return;
        var _origGSPF = CtorProto.getShaderPrecisionFormat;
        CtorProto.getShaderPrecisionFormat = _markNative(function getShaderPrecisionFormat(shaderType, precisionType) {
          var fmt;
          try {
            fmt = _origGSPF.call(this, shaderType, precisionType);
          } catch (e) {
            try { return _origGSPF.call(this, shaderType, precisionType); } catch (e2) { return null; }
          }
          try {
            if (fmt && typeof fmt.rangeMin === 'number' && typeof fmt.rangeMax === 'number' && typeof fmt.precision === 'number') {
              var dRange = (sub[3] % 3) - 1; // -1, 0, or +1
              var dPrec = (sub[4] % 3) - 1;  // -1, 0, or +1
              // Return a plain object with nudged values — WebGLShaderPrecisionFormat
              // objects may not be constructable from JS, so we return a compatible duck.
              return {
                rangeMin: Math.max(0, fmt.rangeMin + dRange),
                rangeMax: Math.max(0, fmt.rangeMax + dRange),
                precision: Math.max(0, fmt.precision + dPrec),
              };
            }
          } catch (e) {}
          return fmt;
        }, 'getShaderPrecisionFormat');
      } catch (e) {}
    }

    try {
      if (typeof WebGLRenderingContext !== 'undefined') {
        _patchGetShaderPrecisionFormat(WebGLRenderingContext.prototype);
      }
    } catch (e) {}

    try {
      if (typeof WebGL2RenderingContext !== 'undefined') {
        _patchGetShaderPrecisionFormat(WebGL2RenderingContext.prototype);
      }
    } catch (e) {}

  } catch (e) {}
})('__AEGIS_FARBLE_SEED__');
