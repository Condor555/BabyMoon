# BabyMoon 1.2.0 🌙

BabyMoon trasforma due telefoni in un baby monitor privato. Il telefono **Baby** acquisisce camera e microfono; fino a **3 Parent** ricevono flussi WebRTC indipendenti. Il server gestisce solo sessioni, inviti e signaling: non registra audio, video o fotogrammi.

> BabyMoon non è un dispositivo medico o di sicurezza certificato e non sostituisce la supervisione di un adulto. I rilevatori locali possono produrre falsi positivi o negativi.

## Novità V1.2

- interfaccia Parent riprogettata: video centrale, stato LIVE leggibile, controlli principali separati dalle impostazioni;
- visione notturna software **Auto / Attiva / Disattiva**, basata sulla luminanza stimata dal Baby;
- pairing tramite **QR inquadrato nell'app** o PIN a 6 cifre;
- «Aggiungi Parent» disponibile sia sul Baby sia in **Parent → Impostazioni → Dispositivi**;
- inviti temporanei di 5 minuti, monouso e revocabili, con rate limiting;
- token privato distinto per ogni Parent e mai inserito nel QR/PIN di invito;
- indicatore `n di 3 Parent` e slot disponibili;
- installazione PWA completa su Android/Chromium e iPhone/iPad;
- manifest completo, icone 192/512 normali e maskable, Apple touch icon, safe area e avvio standalone;
- onboarding installazione non invasivo;
- service worker aggiornabile che non intercetta signaling, API o WebRTC;
- diagnostica estesa per peer, media, trasporto, inviti e luce.

Sono mantenute le funzioni V1.1: audio Baby→Parent, Ascolto Parent, volume adattivo, controllo del microfono Baby, rilevamento locale di possibile pianto e movimento, timeline, multi-Parent, riconnessione entro 30 secondi, Wake Lock, modalità Oscura e terminazione sincronizzata.

## Avvio locale

Richiede Node.js 20 o successivo.

```bash
npm install
npm start
```

Apri `http://localhost:3000`. Camera, microfono, service worker e installazione PWA richiedono un **secure context**: localhost è ammesso per sviluppo, su rete o produzione serve HTTPS.

Controlli:

```bash
npm run check
```

## Deploy su Render

Il file `render.yaml` crea un Web Service Node:

1. carica tutti i file nella root della repository GitHub;
2. in Render scegli **New → Blueprint** e collega la repository;
3. lascia `render.yaml` nella root e avvia il deploy;
4. Render esegue `npm install` e `npm start`, quindi verifica `/api/health`;
5. apri l'URL HTTPS assegnato.

`PUBLIC_URL` è opzionale. Se non impostata, i QR usano automaticamente protocollo e host della richiesta; in presenza di proxy inverso viene rispettato `X-Forwarded-Proto`.

## Flussi principali

### Avviare il Baby

1. Apri BabyMoon e scegli **Resta con il bambino**.
2. Consenti camera e microfono.
3. Tocca **Aggiungi Parent** per mostrare QR e PIN.
4. Dopo il collegamento puoi cambiare camera o oscurare lo schermo.

### Collegare un Parent

1. Scegli **Resta con me**.
2. Tocca **Scansiona il QR** e inquadra il codice; se la scansione live non è disponibile, scegli una foto del QR o usa il PIN.
3. Attiva l'audio con un tocco quando iOS/Safari lo richiede.

Il QR contiene solo una credenziale di invito ad alta entropia, temporanea e monouso. Il PIN è il fallback breve. Dopo il consumo il server crea un nuovo `parentId` e un nuovo token privato per quel dispositivo.

### Invitare da un Parent già collegato

1. Apri **⚙ Impostazioni**.
2. Vai a **Dispositivi**.
3. Tocca **Aggiungi Parent**.
4. Mostra il QR o condividi l'invito.

Questa operazione non interrompe il Baby o gli altri Parent. Il pulsante viene disabilitato a 3/3. La credenziale privata del Parent che crea l'invito serve solo ad autenticare la richiesta Socket.IO e non compare nel QR, nel PIN o nel link condiviso.

### Interrompere e riconnettere

**Interrompi** chiude il peer di quel Parent e conserva per 30 secondi il diritto di riconnessione con lo stesso token. **Termina sessione**, disponibile sul Baby, invalida l'intera sessione e tutti gli inviti.

## Visione notturna

La modalità Auto misura sul Baby la luminanza di un fotogramma ridotto, senza salvarlo o inviarlo. Il Parent riceve solo il valore numerico e applica un filtro locale di luminosità/contrasto quando l'ambiente è buio.

È un miglioramento software: non crea dettagli che il sensore non ha catturato e non equivale a una camera a infrarossi. Evitiamo di attivare automaticamente la torcia per non illuminare il bambino.

## Installazione PWA

### Android / Chrome / Edge

Quando il browser rende l'app installabile e BabyMoon non è già standalone, appare un banner discreto **Installa BabyMoon**. Il pulsante usa `beforeinstallprompt`; `appinstalled` rimuove il banner. Se chiuso, il banner non ricompare per 7 giorni.

### iPhone / iPad

Apri BabyMoon in Safari, tocca **Condividi → Aggiungi alla schermata Home**. Le istruzioni appaiono solo su iOS/iPadOS, solo fuori dalla modalità standalone e senza prompt bloccanti.

### Aggiornamenti

Il service worker usa:

- network-first per le navigazioni, con fallback alla shell offline;
- stale-while-revalidate per asset statici versionati;
- nessuna cache per `/socket.io/` e `/api/`;
- pulizia automatica delle cache BabyMoon precedenti.

Dopo una release, chiudi e riapri la PWA per usare la nuova shell. Camera/microfono, Socket.IO e WebRTC restano sempre online e non vengono simulati dalla cache.

## Privacy e sicurezza

Vedi [SECURITY.md](SECURITY.md). In sintesi:

- nessuna registrazione server-side;
- una `RTCPeerConnection` separata per ogni Parent;
- massimo 3 Parent, inclusi quelli nella finestra di riconnessione;
- token Baby e Parent casuali e confrontati in tempo costante;
- inviti separati dai token di sessione, validi 5 minuti, monouso e revocabili;
- rate limit su creazione e consumo degli inviti;
- comandi audio/rilevatori e signaling autorizzati per sessione e socket;
- HTTPS/HSTS in produzione, Permissions-Policy e header di sicurezza.

## Struttura

```text
server.js                 Express, Socket.IO, sessioni e inviti
public/index.html         UI mobile-first e meta PWA/iOS
public/styles.css         baseline visuale V1.1 + redesign Parent
public/app.js             WebRTC, media, scanner QR, rilevatori e PWA
public/sw.js              cache applicativa versionata
public/manifest.webmanifest
public/icons/             icone installabili e Apple touch icon
tests/                    test contrattuali, PWA e sicurezza
```

## Diagnostica

Nel Parent apri **Impostazioni → Diagnostica**. Sono mostrati versione, stato WebRTC, contatori media, trasporto Socket.IO, Parent/slot, inviti attivi e luminanza. Non vengono mostrati token o segreti.
