# Changelog

## 1.0.4 — Parent audio playback fix

- Added a dedicated Parent `<audio>` element instead of relying on the muted video element for sound.
- Kept the remote video permanently muted to prevent duplicate playback and autoplay races.
- Audio unlock now calls `play()` directly from the **Attiva audio** tap, including iOS/Safari.
- The audio button stays disabled until a live remote audio track is available.
- Audio preference is restored after a WebRTC reconnection when the browser allows it.
- Added inbound audio/video byte counters to diagnostics.
- The Baby now verifies that `getUserMedia()` actually returned an enabled microphone track.
- Updated the PWA cache and all asset versions to 1.0.4.

## 1.0.3 — P2P/STUN flow fix

- Baby is the sole WebRTC offerer.
- Parent uses `recvonly` audio/video transceivers.
- Added server-provided public STUN configuration.
- Added per-attempt negotiation IDs and stale-signal rejection.
- Added pre-remote-description ICE candidate queues and end-of-candidates signaling.
- Added connection timeout, ICE restart, bounded retry backoff, and authenticated session resume.
- Added selected candidate-pair diagnostics (direct P2P vs TURN relay).
- Kept the Parent placeholder visible until media is actually unmuted/playing.
- Removed the one-time QR token from the address bar immediately after successful pairing.
- Updated the PWA cache and all asset versions to 1.0.3.
- Added integration and client contract tests.
