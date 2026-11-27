# BabyMoon 🌙 — v1.2.1

Baby monitor mobile-first e installabile come PWA. Un telefono **Baby** invia audio/video tramite WebRTC a un massimo di tre telefoni **Parent**. Il server Socket.IO gestisce solo associazione e signaling: non registra né inoltra i flussi media.

## Fix v1.2.1

- **Interrompi:** chiude temporaneamente soltanto la connessione del Parent che lo preme e mantiene la finestra di riconnessione di 30 secondi.
- **Termina su questo Parent:** rimuove definitivamente solo quel Parent, senza interrompere il Baby o gli altri Parent. La sessione globale può essere terminata solo dal Baby.
- **Fullscreen robusto:** Fullscreen API standard, prefisso WebKit, `webkitEnterFullscreen()` per il video iOS e fallback CSS.
- **Parla al Baby:** il Parent richiede il proprio microfono solo quando attiva **Parla**. La traccia usa un transceiver audio dedicato Parent → Baby, con echo cancellation, noise suppression e ascolto Baby automaticamente sospeso durante il talkback per ridurre il rimbombo.
- **Multi-Parent reale:** sul Baby esiste una `Map<parentId, PeerContext>`. Ogni Parent ha `RTCPeerConnection`, `negotiationId`, coda ICE, retry, talkback audio e cleanup indipendenti. L’arrivo del secondo Parent non modifica la connessione del primo.

## Architettura WebRTC

Per ciascun Parent il Baby crea una nuova PeerConnection con tre transceiver:

1. audio Baby → Parent (`sendonly`);
2. video Baby → Parent (`sendonly`);
3. talkback Parent → Baby (`recvonly` dal punto di vista Baby).

Tutti i messaggi `offer`, `answer`, `ICE` e `restart` includono `parentId` e `negotiationId`. Il server verifica che il mittente sia il Baby o il Parent autorizzato per quel collegamento e inoltra il payload esclusivamente al socket corrispondente. Answer e candidati appartenenti a una negoziazione precedente vengono ignorati.

## Funzioni

- QR ad alta entropia e PIN a 6 cifre, inviti monouso validi 5 minuti;
- aggiunta di un Parent sia dal Baby sia da un Parent già LIVE;
- fino a 3 Parent contemporanei;
- riconnessione entro 30 secondi, compreso dopo **Interrompi**;
- ascolto locale, controllo del microfono Baby e volume adattivo;
- visione notturna software Auto/On/Off;
- rilevamento locale indicativo di rumore/pianto e movimento;
- diagnostica WebRTC e qualità connessione;
- Wake Lock dove disponibile e modalità schermo Baby oscurato;
- installazione PWA iOS/Android;
- STUN preconfigurato e TURN opzionale via variabili d’ambiente.

> La visione notturna è un filtro software e non sostituisce una fotocamera a infrarossi. Su iOS una PWA in background o con telefono bloccato può essere sospesa: il telefono Baby va tenuto in primo piano, preferibilmente alimentato, usando **Oscura**.

## Avvio locale

Richiede Node.js 20–22.

```bash
npm install
npm start
```

Apri `http://localhost:3000`. Fotocamera e microfono richiedono `localhost` oppure HTTPS.

## Deploy Render

Il repository include `render.yaml`. Crea un Blueprint dalla repository e imposta, se richiesto, `PUBLIC_URL` con l’URL HTTPS del servizio. `SESSION_SECRET` viene generato da Render.

Variabili opzionali:

```text
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:turn.example.com:3478
TURN_USERNAME=temporary-user
TURN_CREDENTIAL=temporary-password
```

Non inserire credenziali TURN reali nel repository.

## Verifica

```bash
npm run check
npm test
```

La suite include un test d’integrazione Socket.IO che verifica:

1. Parent 1 associato e signaling attivo;
2. creazione di un invito da Parent 1;
3. Parent 2 aggiunto quando Parent 1 è già LIVE;
4. offer distinte e non inoltrate all’altro Parent;
5. answer vincolata al `parentId` corretto;
6. uscita di Parent 2;
7. Parent 1 ancora raggiungibile e LIVE.

### Collaudo reale raccomandato

- Baby + Parent 1 → verificare video e audio;
- aggiungere Parent 2 da Parent 1 → verificare audio e video su entrambi;
- attivare **Parla** prima su un Parent e poi sull’altro;
- premere **Interrompi** su Parent 2 → Parent 1 deve restare LIVE;
- provare la riconnessione automatica di Parent 2 entro 30 secondi;
- provare fullscreen su Android/Chrome, iPhone/Safari e PWA;
- terminare dal Baby → entrambi i Parent devono tornare alla Home.

## Privacy e sicurezza

I flussi WebRTC sono protetti da DTLS-SRTP. I token vengono memorizzati sul server solo come HMAC; PIN/QR sono monouso e scadono; ogni evento di signaling viene autorizzato in base a ruolo, sessione e `parentId`. Le sessioni sono in memoria e si perdono al riavvio del server, intenzionalmente.
