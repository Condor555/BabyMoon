# BabyMoon 🌙

> **Sempre vicino, anche durante il sonno**

BabyMoon trasforma due smartphone in un baby monitor privato. Il dispositivo **Baby** acquisisce fotocamera e microfono; il dispositivo **Parent** riceve lo stream audio/video tramite WebRTC. Socket.IO gestisce esclusivamente pairing, presenza, signaling e riconnessione: il server non registra né archivia audio o video.

## Stato del progetto

**Versione:** `1.0.2`  
**Runtime:** Node.js 20+ (Node.js 22 consigliato)  
**Deploy di riferimento:** Render Web Service con HTTPS

> [!IMPORTANT]
> BabyMoon è un progetto software sperimentale, non un dispositivo medico o di sicurezza certificato. Non deve sostituire la supervisione di un adulto né essere l’unico sistema usato per la sicurezza di un bambino.

## Funzioni V1

### Baby

- acquisizione reale di fotocamera e microfono;
- preview locale con indicatori video/audio;
- QR e PIN di pairing;
- cambio fotocamera senza interrompere il microfono;
- modalità **Oscura** con riattivazione affidabile tramite touch, pointer, click o tastiera;
- Screen Wake Lock, quando supportato dal browser;
- rilascio completo di camera e microfono quando la sessione termina.

### Parent

- accesso tramite QR oppure PIN a 6 cifre;
- ricezione robusta delle tracce remote video e audio;
- fallback per le autoplay policy mobili con pulsante **Attiva audio**;
- Audio/Mute, fullscreen dove supportato e stato LIVE;
- stato visibile di attesa/riconnessione e pulsante **Riprova ora**.

### Affidabilità

- un solo initiator WebRTC: il dispositivo Baby;
- protezione contro offerte concorrenti;
- coda degli ICE candidate fino alla `remoteDescription`;
- identificatore univoco per ogni negoziazione, così i candidati ICE di un tentativo precedente non contaminano quello successivo;
- SDP inviato dopo una breve raccolta ICE: i candidati viaggiano sia nell'SDP sia tramite trickle ICE, evitando una dipendenza da un solo percorso di signaling;
- timeout ICE esplicito con conteggio dei candidati locali/remoti e indicazione visibile dello stato TURN;
- ricreazione pulita della `RTCPeerConnection` senza peer sovrapposti;
- riconnessione automatica con backoff `0 s → 2 s → 5 s → 10 s → 30 s → 60 s`;
- recupero su cambio rete, ritorno online e ritorno dell’app in primo piano, entro i limiti del browser mobile;
- watchdog `RTCPeerConnection.getStats()` ogni 5 secondi: se il traffico media non avanza per 20 secondi, viene avviato un recupero controllato;
- diagnostica in-app con stato WebRTC, bitrate, tipo di candidato, protocollo e RTT quando disponibili;
- terminazione volontaria distinta da una perdita temporanea di rete.

## Flusso rapido

1. Sul primo telefono apri BabyMoon e scegli **Modalità Baby**.
2. Concedi i permessi per fotocamera e microfono.
3. Sul secondo telefono:
   - scansiona il QR; oppure
   - apri **Modalità Genitore** e inserisci il PIN.
4. Sul Parent, se il browser blocca l’audio automatico, tocca **Attiva audio**.
5. Premendo **Termina** su uno dei due dispositivi, la sessione viene invalidata e chiusa su entrambi.

## Architettura

```text
Telefono Baby                         Telefono Parent
camera + microfono                    video + audio
       │                                     │
       └──────── WebRTC peer-to-peer ────────┘
                       │
                 STUN / TURN

Entrambi i telefoni ── Socket.IO signaling ── Node.js/Express
```

- **Express 5** serve la PWA e le API minime.
- **Socket.IO** gestisce join autenticato, presenza, signaling, retry e fine sessione.
- **WebRTC** trasporta audio e video direttamente quando la rete lo consente.
- **STUN** Google è configurato come fallback iniziale.
- **TURN autenticato** può essere aggiunto tramite variabili d’ambiente.

## Modello di sicurezza

### Pairing e token

- PIN numerico casuale a 6 cifre, valido per **5 minuti** e utilizzabile solo per il primo pairing;
- QR con token casuale forte da 256 bit, distinto dal PIN e monouso;
- token Baby da 256 bit;
- token Parent da 256 bit emesso solo dopo il primo pairing riuscito;
- il token Parent viene conservato in `sessionStorage` per consentire la riconnessione della stessa scheda senza rendere riutilizzabile il PIN;
- dopo il primo Parent, ulteriori tentativi senza il token Parent corretto vengono rifiutati;
- **Termina** elimina immediatamente sessione e token sul server.

### Protezioni server

- massimo **5 tentativi falliti** per IP/sessione, poi blocco temporaneo di 10 minuti;
- limite di 10 nuove sessioni per IP nella stessa finestra temporale;
- autorizzazione di ogni evento Socket.IO in base a socket, sessione e ruolo;
- destinazione del signaling derivata dal server, mai scelta liberamente dal client;
- validazione di ruolo, codice, token, SDP e ICE candidate;
- payload HTTP e Socket.IO limitati;
- HTTPS obbligatorio quando `NODE_ENV=production`;
- CSP, HSTS/Helmet, `Permissions-Policy`, `Referrer-Policy: no-referrer`, protezione anti-frame e rimozione di `X-Powered-By`;
- endpoint di terminazione HTTP autenticato come fallback al canale Socket.IO.

### Limiti del modello

- il signaling è mantenuto in memoria: il deploy deve usare una singola istanza, oppure un adapter condiviso (per esempio Redis) prima di scalare orizzontalmente;
- il rate limiting è in memoria e per singola istanza;
- un PIN a 6 cifre resta un segreto breve: usare preferibilmente il QR con token forte;
- STUN da solo non attraversa tutte le reti/NAT; per uso affidabile tra Wi‑Fi e rete mobile serve TURN;
- le API mobili possono sospendere una PWA in background nonostante Wake Lock e riconnessione. Effettuare test reali sui dispositivi target;
- BabyMoon non effettua cifratura applicativa aggiuntiva: WebRTC usa DTLS-SRTP per il media transport.

## Requisiti

- Node.js `>=20`;
- npm;
- browser moderno con WebRTC e `getUserMedia()`;
- HTTPS in produzione (`localhost` è ammesso nello sviluppo locale);
- due dispositivi per il collaudo end-to-end.

## Avvio locale

```bash
git clone https://github.com/Condor555/BabyMoon.git
cd BabyMoon
npm ci
npm run dev
```

Apri `http://localhost:3000`.

## Variabili d’ambiente

| Variabile | Obbligatoria | Descrizione |
|---|---:|---|
| `PORT` | No | Porta HTTP; default `3000` |
| `NODE_ENV` | In produzione | Impostare `production` per forzare HTTPS |
| `PUBLIC_URL` | Consigliata | URL pubblico HTTPS senza slash finale, es. `https://babymoon.onrender.com` |
| `TURN_URLS` | No | URL TURN separati da virgola, es. `turn:host:3478?transport=udp,turns:host:5349` |
| `TURN_USERNAME` | Con TURN | Username TURN |
| `TURN_CREDENTIAL` | Con TURN | Credenziale TURN |

Esempio locale senza segreti reali:

```bash
PUBLIC_URL=http://localhost:3000 npm start
```

### Gestione dei segreti TURN

- non inserire credenziali in Git, `.env` versionati, log o screenshot;
- configurarle come secret nella dashboard del provider;
- preferire credenziali TURN temporanee emesse da un servizio dedicato;
- se si usano credenziali statiche, limitarle e ruotarle periodicamente;
- in caso di esposizione, revocare/ruotare immediatamente username e credenziale;
- il client deve ricevere necessariamente una credenziale utilizzabile: non considerare un secret TURN statico inviato al browser come segreto permanente.

## Deploy HTTPS su Render

1. Carica questa repository su GitHub.
2. In Render scegli **New → Blueprint**.
3. Collega `Condor555/BabyMoon` e seleziona `render.yaml`.
4. Imposta `PUBLIC_URL` con l’URL HTTPS pubblico assegnato al servizio.
5. Non configurare TURN finché non hai un server/servizio TURN; quando disponibile, aggiungi le tre variabili TURN come secret nella dashboard.
6. Verifica `GET /api/health`, che deve restituire la versione `1.0.2`.

Il Blueprint usa:

```text
build: npm ci
start: npm start
health: /api/health
```

## Script npm

| Comando | Scopo |
|---|---|
| `npm run dev` | server con watch mode |
| `npm start` | avvio produzione |
| `npm run check` | controllo sintattico server/client |
| `npm test` | test Node.js |
| `npm run validate` | check + test completi |

## Test inclusi

La suite verifica:

- pairing PIN;
- pairing QR con token forte;
- token Parent e rifiuto di Parent aggiuntivi;
- relay offer/answer tramite signaling autorizzato;
- richiesta di riconnessione;
- terminazione bidirezionale via Socket.IO;
- terminazione HTTP autenticata;
- invalidazione della sessione;
- rate limiting;
- header di sicurezza e configurazione TURN;
- contratto client per controlli delegati, audio/video, autoplay fallback, riconnessione, Wake Lock, lifecycle e watchdog.

```bash
npm run validate
```

I test automatici non sostituiscono una prova WebRTC su hardware reale. Prima di considerare una release pronta, eseguire almeno la matrice seguente:

| Scenario | QR | PIN | Video | Audio | Retry | Termina |
|---|---:|---:|---:|---:|---:|---:|
| iPhone Safari ↔ iPhone Safari | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Android Chrome ↔ iPhone Safari | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Wi‑Fi ↔ Wi‑Fi | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Wi‑Fi ↔ 4G/5G con TURN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cambio Wi‑Fi ↔ 4G/5G | ✓ | ✓ | ripristino | ripristino | automatico | ✓ |
| breve background/foreground | ✓ | ✓ | ripristino | ripristino | automatico | ✓ |

## Struttura della repository

```text
BabyMoon/
├── .github/workflows/ci.yml
├── public/
│   ├── app.js
│   ├── icon.svg
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── styles.css
│   └── sw.js
├── test/
│   ├── client.contract.test.js
│   └── server.integration.test.js
├── .gitignore
├── package.json
├── package-lock.json
├── render.yaml
└── server.js
```

## Diagnostica

- `/api/health`: stato e versione del servizio;
- `/api/config`: ICE server pubblici forniti al client e flag `hasTurn` per la diagnostica;
- overlay live: stato WebRTC, bitrate, candidato/protocollo e RTT quando esposti dal browser;
- console browser: errori di autoplay, Wake Lock, `getStats`, signaling e media device;
- log server: errori applicativi senza registrare audio/video.

Se il Parent resta nero:

1. verifica che sul Baby siano presenti sia la traccia video sia quella audio;
2. controlla l’overlay: `Video/Audio negoziato` conferma solo lo scambio SDP, mentre `Video/Audio ricevuto` appare dopo la connessione ICE;
3. controlla se la diagnostica mostra `TURN attivo` oppure `TURN non configurato`;
4. premi **Riprova ora**;
5. configura TURN se i dispositivi sono su reti diverse o la diagnostica resta su `WebRTC new`/`ICE checking`;
6. su iOS tocca **Attiva audio** per soddisfare l’autoplay policy.

## Privacy

BabyMoon non implementa registrazioni, screenshot, storico o upload media. I flussi audio/video viaggiano tramite WebRTC; il server conserva solo dati temporanei di sessione in memoria.

## Release 1.0.2

- fix del Parent fermo su `WebRTC new` con raccolta ICE ibrida (SDP completo + trickle ICE);
- ogni negoziazione usa un ID univoco e ignora candidati ICE obsoleti durante i retry;
- timer di connessione iniziale e diagnostica dei candidati locali/remoti;
- stato `Video/Audio negoziato` distinto da media realmente ricevuto;
- indicazione visibile `TURN attivo/non configurato` e messaggio esplicito quando la sola connessione diretta può non bastare;
- cache PWA aggiornata e asset versionati per evitare che il deploy continui a usare il client 1.0.1.

## Release 1.0.1

- fix completo ricezione video nera sul Parent;
- fix catena audio Baby → Parent e autoplay iOS;
- fix controlli Baby/Parent dopo i rerender;
- fix Oscura/riattiva su mobile;
- terminazione bidirezionale con invalidazione immediata;
- riconnessione automatica, backoff e retry manuale;
- Wake Lock, lifecycle mobile, diagnostica e watchdog `getStats()`;
- pairing monouso con PIN e QR token forte;
- hardening Socket.IO/HTTP, HTTPS e header;
- predisposizione TURN autenticato;
- PWA con service worker network-first;
- test e CI GitHub Actions.

## Licenza

Al momento non è incluso un file di licenza open source. In assenza di licenza, tutti i diritti restano al titolare del repository.
