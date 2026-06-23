// WebRTC "public-only" document-start shim — wraps RTCPeerConnection to drop local/
// private ICE candidates (keeping TURN/relay + public reflexive) so a page can't read
// the user's LAN/loopback IP, while calls still work. FAIL-OPEN throughout: any error
// keeps the candidate / returns data unchanged, so a shim bug never breaks a page's JS.
//
// This file is the SHIPPED artifact: Rust includes it verbatim via include_str! and the
// vitest runtime test (src/lib/webrtcShim.test.ts) executes it against a fake
// RTCPeerConnection. The Rust fns in webrtc_shim.rs are a parallel reference (also tested)
// — isLocalAddr below MUST match Rust is_local_address.
(function(){
  try {
    var OrigPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!OrigPC) return;
    function isLocalAddr(a){
      if(!a) return false;
      a = String(a).toLowerCase();
      if(a.endsWith('.local')) return true;                 // mDNS host (suffix, matches Rust)
      if(a.indexOf(':') >= 0){                               // IPv6
        if(a === '::1') return true;                         // loopback
        return a.indexOf('fc')===0||a.indexOf('fd')===0||a.indexOf('fe8')===0||a.indexOf('fe9')===0||a.indexOf('fea')===0||a.indexOf('feb')===0;
      }
      var p = a.split('.');                                  // IPv4 dotted-quad
      if(p.length !== 4) return false;
      var n0 = parseInt(p[0],10), n1 = parseInt(p[1],10);
      if(isNaN(n0)||isNaN(n1)) return false;
      if(n0===10) return true;                               // 10/8
      if(n0===127) return true;                              // loopback 127/8
      if(n0===192 && n1===168) return true;                  // 192.168/16
      if(n0===169 && n1===254) return true;                  // link-local 169.254/16
      if(n0===172 && n1>=16 && n1<=31) return true;          // 172.16/12
      return false;
    }
    function keepCand(c){
      try {
        if(!c) return true;
        var s = String(c); var i = s.indexOf('candidate:');
        if(i < 0) return true;
        var t = s.slice(i).split(/\s+/);
        if(t.length < 8) return true;
        var ti = t.indexOf('typ');
        if(ti < 0 || ti+1 >= t.length) return true;
        if(t[ti+1] === 'relay') return true;                 // TURN relay → keep
        return !isLocalAddr(t[4]);                           // drop local host/srflx
      } catch (e) { return true; }
    }
    function filterSdp(sdp){
      try {
        if(!sdp) return sdp;
        var nl = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
        return sdp.split(/\r\n|\n/).filter(function(line){
          if(line.indexOf('a=candidate:')===0 || line.indexOf('candidate:')===0) return keepCand(line);
          return true;
        }).map(function(line){
          if(line.indexOf('c=IN IP4 ')===0){ return isLocalAddr(line.slice(9).trim()) ? 'c=IN IP4 0.0.0.0' : line; }
          if(line.indexOf('c=IN IP6 ')===0){ return isLocalAddr(line.slice(9).trim()) ? 'c=IN IP6 ::' : line; }
          if(line.indexOf('o=')===0){
            var parts = line.split(' ');
            if(parts.length===6 && isLocalAddr(parts[5])){ parts[5] = parts[4]==='IP6' ? '::' : '0.0.0.0'; return parts.join(' '); }
          }
          return line;
        }).join(nl);
      } catch (e) { return sdp; }
    }
    function wrap(pc){
      try {
        var realAddEL = pc.addEventListener.bind(pc);
        var realRemoveEL = (typeof pc.removeEventListener === 'function') ? pc.removeEventListener.bind(pc) : function(){};
        function filteredIce(fn){
          return function(ev){
            try { if(ev && ev.candidate && ev.candidate.candidate && !keepCand(ev.candidate.candidate)) return; } catch (e) {}
            return fn.call(this, ev);
          };
        }
        // addEventListener/removeEventListener: filter 'icecandidate', remember the wrapper
        // so removeEventListener(fn) can find and detach the closure it actually registered.
        pc.addEventListener = function(type, fn, opts){
          if(type === 'icecandidate' && typeof fn === 'function'){
            var w = filteredIce(fn);
            try { Object.defineProperty(fn, '__aegisIceWrap', { value: w, configurable: true }); } catch (e) {}
            return realAddEL(type, w, opts);
          }
          return realAddEL(type, fn, opts);
        };
        pc.removeEventListener = function(type, fn, opts){
          if(type === 'icecandidate' && fn && fn.__aegisIceWrap){
            return realRemoveEL(type, fn.__aegisIceWrap, opts);
          }
          return realRemoveEL(type, fn, opts);
        };
        // onicecandidate: EventHandler REPLACE semantics — detach the prior wrapper before
        // attaching a new one; assigning null detaches (no accumulation, no zombie listener).
        try {
          Object.defineProperty(pc, 'onicecandidate', {
            configurable: true,
            get: function(){ return this.__aegisOnIce || null; },
            set: function(fn){
              if(this.__aegisOnIceWrap){ try { realRemoveEL('icecandidate', this.__aegisOnIceWrap); } catch (e) {} this.__aegisOnIceWrap = null; }
              this.__aegisOnIce = (typeof fn === 'function') ? fn : null;
              if(typeof fn === 'function'){ var w = filteredIce(fn); this.__aegisOnIceWrap = w; realAddEL('icecandidate', w); }
            }
          });
        } catch (e) {}
        // createOffer/createAnswer: filter the returned SDP (belt-and-suspenders).
        ['createOffer','createAnswer'].forEach(function(m){
          var orig = pc[m];
          if(typeof orig !== 'function') return;
          pc[m] = function(){
            var r = orig.apply(this, arguments);
            if(r && typeof r.then === 'function'){
              return r.then(function(desc){ try { if(desc && desc.sdp) return { type: desc.type, sdp: filterSdp(desc.sdp) }; } catch (e) {} return desc; });
            }
            return r;
          };
        });
        // localDescription getters: filter SDP on read (closes the direct-read bypass).
        ['localDescription','currentLocalDescription','pendingLocalDescription'].forEach(function(p){
          try {
            var d = Object.getOwnPropertyDescriptor(OrigPC.prototype, p);
            if(!d || !d.get) return;
            Object.defineProperty(pc, p, { configurable: true, get: function(){
              var v = d.get.call(this);
              try { if(v && v.sdp) return { type: v.type, sdp: filterSdp(v.sdp) }; } catch (e) {}
              return v;
            }});
          } catch (e) {}
        });
        // getStats: the stats report's local/remote-candidate entries carry .address/.ip,
        // exposing the LAN IP even when the event + SDP are filtered. Return a sanitized
        // copy (a Map, which mirrors RTCStatsReport's forEach/get/iteration) with private
        // host/srflx addresses nulled; keep relay. Fail-open: any error → original report.
        try {
          var origStats = pc.getStats;
          if(typeof origStats === 'function'){
            pc.getStats = function(){
              var r = origStats.apply(this, arguments);
              if(r && typeof r.then === 'function'){
                return r.then(function(report){
                  try {
                    if(!report || typeof report.forEach !== 'function') return report;
                    var out = new Map();
                    report.forEach(function(stat, id){
                      var s = stat;
                      try {
                        if(stat && (stat.type === 'local-candidate' || stat.type === 'remote-candidate') && stat.candidateType !== 'relay'){
                          s = Object.assign({}, stat);
                          if(s.address && isLocalAddr(s.address)) s.address = null;
                          if(s.ip && isLocalAddr(s.ip)) s.ip = null;
                          if(s.relatedAddress && isLocalAddr(s.relatedAddress)) s.relatedAddress = null;
                        }
                      } catch (e) { s = stat; }
                      out.set(id, s);
                    });
                    return out;
                  } catch (e) { return report; }
                });
              }
              return r;
            };
          }
        } catch (e) {}
      } catch (e) {}
      return pc;
    }
    function Patched(){ return wrap(new OrigPC(...arguments)); }
    Patched.prototype = OrigPC.prototype;
    try { Patched.prototype.constructor = Patched; } catch (e) {}
    // Preserve the original constructor's static methods (generateCertificate, etc.) so a
    // page that calls them doesn't throw (FAIL-OPEN: a wrapped constructor must not break JS).
    try {
      Object.getOwnPropertyNames(OrigPC).forEach(function(k){
        if(!(k in Patched)){
          try { Object.defineProperty(Patched, k, Object.getOwnPropertyDescriptor(OrigPC, k)); } catch (e) {}
        }
      });
    } catch (e) {}
    window.RTCPeerConnection = Patched;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
  } catch (e) {}
})();
