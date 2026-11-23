# BabyMoon 🌙

> **Sempre vicino, anche durante il sonno.**

BabyMoon trasforma due telefoni in un baby monitor PWA: il dispositivo **Baby** acquisisce fotocamera e microfono, il dispositivo **Parent** riceve il flusso tramite WebRTC e mostra avvisi locali di possibile pianto e movimento.

## V1.1

- pairing monouso con QR ad alta entropia o PIN a 6 cifre;
- video e audio Baby → Parent tramite WebRTC cifrato in transito;
- STUN e collegamento P2P diretto, con TURN opzionale;
- riproduzione audio Parent separata e sblocco esplicito per iOS/Safari;
- rilevamento locale di **possibile pianto**;
- rilevamento locale di movimento a bassa risoluzione;
- sensibilità e cooldown configurabili dal Parent;
- avvisi in-app, vibrazione e tono dopo lo sblocco audio;
- timeline temporanea degli ultimi 50 eventi;
- riconnessione automatica, Wake Lock, modalità Oscura e diagnostica WebRTC;
- terminazione sincronizzata da entrambi i dispositivi;
- PWA installabile e deploy gratuito su Render.

## Privacy by design

BabyMoon non crea account e non registra audio, video, fotografie o clip.

- Audio e video viaggiano tra i due dispositivi tramite WebRTC.
- L'analisi di pianto e movimento avviene **nel browser del telefono Baby**.
- Il server riceve soltanto un piccolo evento (`cry` o `motion`), un timestamp e un punteggio tecnico.
- La timeline vive esclusivamente nella memoria del Parent e viene cancellata con `Termina` o al ricaricamento.
- Le sessioni e i token restano in memoria nel processo Node e vengono invalidati alla fine della sessione.

> **Avvertenza:** “Possibile pianto” è una stima acustica euristica, non una diagnosi. Rumori, televisione, voci o altri bambini possono generare falsi positivi o falsi negativi. BabyMoon non sostituisce la supervisione di un adulto né un dispositivo medico o di sicurezza certificato.

## Come funziona

```text
Telefono Baby                         Server signaling                    Telefono Parent
camera + microfono ───── WebRTC P2P cifrato ─────────────────────────▶ video + audio
       │                               Socket.IO                              │
       ├─ analisi audio locale ───── evento "cry" ──────────────────────────▶ avviso
       └─ differenza frame locale ─── evento "motion" ──────────────────────▶ timeline
```

Il Baby è l'unico creatore dell'offerta WebRTC. Il Parent è ricevitore e non chiede accesso alla propria fotocamera o al microfono.

## Rilevamenti V1.1

### Possibile pianto

Il browser analizza finestre audio di 250 ms usando energia RMS e distribuzione spettrale nella banda vocale. Per ridurre gli impulsi isolati, l'evento richiede più finestre consecutive coerenti. I livelli `Bassa`, `Media` e `Alta` modificano soglie e persistenza.

### Movimento

Il Baby confronta frame consecutivi ridotti a **160×90 px**, circa 3 volte al secondo. I frame non vengono memorizzati né trasmessi. Il cooldown evita notifiche continue per lo stesso movimento.

## Requisiti

- Node.js 20 o successivo;
- due browser moderni;
- HTTPS in produzione (`localhost` è ammesso in sviluppo);
- il telefono Baby deve restare con BabyMoon in primo piano; su iPhone è preferibile usare **Oscura** invece di bloccare il dispositivo.

## Avvio locale

```bash
npm install
npm run dev
```

Apri `http://localhost:3000` su due schede o dispositivi. Fotocamera e microfono funzionano su `localhost`; per telefoni reali usa HTTPS.

## Deploy su Render a 0 €

1. Carica il contenuto della repository su GitHub.
2. In Render scegli **New → Blueprint**.
3. Seleziona la repository: `render.yaml` crea il Web Service.
4. Imposta `PUBLIC_URL` con l'URL HTTPS definitivo, ad esempio `https://nome-servizio.onrender.com`.
5. Lascia vuote le variabili TURN per mantenere il funzionamento STUN/P2P senza costi.
6. Dopo il deploy, chiudi completamente la vecchia PWA sui due telefoni e riaprila per aggiornare la cache.

La build usa `npm install --omit=dev`, quindi non richiede un lockfile preesistente.

## TURN opzionale

STUN/P2P non può attraversare ogni NAT o firewall. Per usare un relay TURN configura in Render:

```text
TURN_URLS=turn:host:3478?transport=udp,turns:host:5349?transport=tcp
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Non inserire credenziali TURN in `public/app.js` o nel repository. La configurazione corrente invia al client le credenziali impostate sul server; per un servizio pubblico o multiutente è raccomandato sostituirle con credenziali TURN temporanee.

## Test

```bash
npm test
npm run check
```

La suite verifica:

- soglie e persistenza del rilevamento acustico;
- rilevamento movimento e sensibilità;
- normalizzazione sicura delle impostazioni;
- contratti critici del client;
- sintassi di server, client, detector e service worker.

### Matrice manuale minima

1. QR e PIN;
2. iPhone ↔ iPhone e Android ↔ iPhone;
3. hotspot e Wi-Fi ↔ rete mobile;
4. video, `Attiva audio` e contatori diagnostici;
5. pianto simulato e movimento con tre sensibilità;
6. cooldown e timeline;
7. perdita rete, ritorno online e `Riprova ora`;
8. `Termina` da Baby e da Parent;
9. `Oscura` e riattivazione toccando qualsiasi punto;
10. cambio fotocamera senza perdere l'audio.

## Struttura

```text
server.js                 Express + Socket.IO, sessioni e signaling
public/app.js             UX e WebRTC
public/detectors.js       analisi locale pianto/movimento
public/sw.js              cache PWA versionata
public/styles.css         interfaccia mobile-first
public/manifest.webmanifest
tests/                    test Node senza browser esterno
render.yaml               deploy Render
```

## Sicurezza

- QR con token casuale a 256 bit;
- PIN a 6 cifre, monouso, valido 5 minuti;
- massimo 5 tentativi di pairing per IP/identificativo;
- token separati Baby e Parent;
- autorizzazione di ruolo per signaling, impostazioni ed eventi;
- payload Socket.IO limitati;
- una sola connessione Parent;
- header di sicurezza con Helmet;
- sessioni invalidate da `Termina` o dopo 5 ore.

## Limiti noti

- senza TURN alcune coppie di reti non possono collegarsi;
- Render free può sospendere il servizio e perde le sessioni in memoria a ogni riavvio;
- iOS può sospendere una PWA in background o con schermo bloccato;
- i rilevamenti V1.1 sono euristici e richiedono taratura nell'ambiente reale;
- non sono presenti notifiche push: gli avvisi funzionano mentre il Parent è aperto.

## Licenza

MIT. Vedi [LICENSE](LICENSE).
