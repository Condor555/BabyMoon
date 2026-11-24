# Sicurezza

Per segnalare una vulnerabilità, apri una segnalazione privata al maintainer invece di pubblicare credenziali o dettagli sfruttabili in una issue pubblica.

## Modello attuale

- media WebRTC cifrati in transito;
- signaling tramite HTTPS/WSS;
- token Baby e Parent distinti e casuali;
- autorizzazione server-side per sessione, ruolo e Parent;
- PIN/QR validi 5 minuti;
- limite di tre Parent e rate limit dei tentativi di pairing;
- sessioni solo in memoria;
- nessuna registrazione dei media.

## Limiti

La configurazione inclusa usa STUN senza TURN. BabyMoon è un progetto general-purpose e non un dispositivo di sicurezza o medico certificato.
