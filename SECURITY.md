# Modello di sicurezza BabyMoon 1.2

## Confini e dati

BabyMoon usa il server per sessioni temporanee e signaling. Audio e video viaggiano tramite WebRTC tra Baby e ciascun Parent. Il server non salva contenuti multimediali, fotogrammi o timeline. I rilevatori analizzano localmente il media del Baby e inviano solo tipo, confidenza e timestamp dell'evento.

## Identità della sessione

- Il Baby riceve un token casuale dedicato alla sessione.
- Ogni Parent riceve un `parentId` e un token casuale distinti.
- Un token Parent autorizza solo quel peer e non viene riutilizzato per aggiungerne altri.
- I confronti dei token usano `crypto.timingSafeEqual`.
- I comandi remoti vengono accettati solo dal socket associato al Parent autenticato.

Il token Parent è conservato localmente soltanto per la finestra di riconnessione di 30 secondi. Non viene inserito nel manifest, nell'HTML, nel QR, nel PIN, nel link condiviso o nella diagnostica.

## Inviti di pairing

Baby e Parent autenticati richiedono al server una **nuova credenziale di invito**, separata dai rispettivi token privati.

- Scadenza: 5 minuti.
- Uso: una sola volta; il consumo è atomico.
- Revoca: esplicita prima del consumo.
- QR/link: `inviteId.secret` ad alta entropia.
- Fallback PIN: 6 cifre, con rate limiting dei tentativi.
- Creazione: massimo 4 richieste per socket/sessione al minuto.
- Consumo: massimo 12 tentativi per socket/IP al minuto.
- Capacità: massimo 3 Parent; un Parent in finestra di riconnessione conserva lo slot.

Il server ricontrolla la capacità al consumo. Perciò più inviti contemporanei non possono superare il limite.

## Multi-Parent

Ogni Parent ha:

- PeerConnection e negotiation ID indipendenti;
- signaling e ICE instradati soltanto al proprio socket;
- ascolto e volume adattivo locali;
- token e finestra di riconnessione indipendenti.

Il microfono Baby e le impostazioni dei rilevatori sono globali e vengono sincronizzati. L'uscita o il guasto di un Parent non chiude gli altri peer.

## Trasporto e browser

In produzione devono essere usati HTTPS e WSS. BabyMoon invia HSTS in `NODE_ENV=production`, `X-Content-Type-Options`, `Referrer-Policy` e una `Permissions-Policy` limitata alla stessa origine. Il service worker non intercetta `/socket.io/` o `/api/`.

STUN aiuta a stabilire il percorso P2P ma non garantisce connettività su ogni rete. Una distribuzione pubblica affidabile dovrebbe aggiungere un TURN autenticato e con credenziali a scadenza.

## Limiti dichiarati

- Un PIN a 6 cifre ha entropia limitata; scadenza breve, monouso e rate limiting riducono il rischio ma il QR ad alta entropia è preferibile.
- I token in `localStorage` sono accessibili a eventuale JavaScript eseguito dalla stessa origine; per questo la UI non carica script applicativi da CDN e usa header restrittivi. Una futura versione può passare a storage cifrato/isolato nativo.
- La visione notturna è un filtro software, non infrarossi.
- Rilevamento di pianto e movimento sono stime locali, non funzioni di sicurezza certificate.
