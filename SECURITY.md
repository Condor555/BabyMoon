# Sicurezza

Non pubblicare vulnerabilità in una issue pubblica. Revoca immediatamente eventuali credenziali TURN esposte.

## Modello

- media P2P cifrati da WebRTC (DTLS-SRTP);
- signaling su HTTPS/WSS in produzione;
- token casuali separati per Baby, Parent e inviti;
- token conservati server-side solo come HMAC;
- PIN monouso, scadenza 5 minuti e rate limit;
- massimo tre Parent e sessione massima 12 ore;
- autorizzazione per ruolo, sessione, `parentId` e socket;
- limiti ai payload Socket.IO e header Helmet/CSP.

## Limiti

Le sessioni in memoria non sono condivise tra più istanze. Configurare Render con una singola istanza oppure introdurre un adapter Socket.IO e uno store condiviso prima di scalare orizzontalmente. TURN è necessario per alcune reti; usare credenziali temporanee in produzione.
