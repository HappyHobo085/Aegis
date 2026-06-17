// WebRTC "disable" document-start shim — make RTCPeerConnection construction throw, so
// no peer connection (and thus no IP leak) is possible. Wrapped so a failure to install
// never throws at document-start. Shipped verbatim via include_str! from webrtc_shim.rs.
(function(){
  try {
    function Blocked(){ throw new DOMException('WebRTC disabled by Aegis','NotAllowedError'); }
    window.RTCPeerConnection = Blocked;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Blocked;
  } catch (e) {}
})();
