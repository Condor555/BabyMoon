# BabyMoon 🌙

**Sempre vicino, anche durante il sonno.**

BabyMoon trasforma due telefoni in un baby monitor privato nel browser. Il telefono **Baby** acquisisce fotocamera e microfono; il telefono **Parent** riceve il flusso tramite WebRTC. Il server gestisce soltanto pairing e signaling: non registra né archivia audio o video.

## Novità V1.0.4 — riproduzione audio Parent

Questa release mantiene il flusso STUN/P2P della V1.0.3 e corregge la riproduzione audio sul Parent:

- l’audio remoto usa un elemento `<audio>` dedicato, separato dal video sempre silenziato;
- **Attiva audio** invoca `play()` direttamente dal tocco dell’utente, come richiesto da iOS/Safari;
- il pulsante resta in attesa finché non esiste una traccia audio remota live;
- dopo una riconnessione BabyMoon prova a ripristinare l’audio già richiesto dall’utente;
- la diagnostica mostra i byte realmente ricevuti per audio e video;
- il Baby verifica che il browser abbia restituito una traccia microfono valida e attiva;
- cache PWA aggiornata a `babymoon-v1.0.4`.

## Flusso P2P + STUN introdotto in V1.0.3

Questa release riscrive il percorso di negoziazione che poteva lasciare il Parent su `WebRTC: new`:

- il **Baby è l’unico offerer**; non esistono più due offer concorrenti;
- il Parent usa transceiver `recvonly` e **non richiede fotocamera o microfono**;
- ogni negoziazione ha un `negotiationId`, quindi i messaggi di tentativi precedenti vengono ignorati;
- i candidati ICE arrivati in anticipo restano in coda fino a `setRemoteDescription()`;
- viene segnalata anche la fine della raccolta ICE;
- timeout esplicito e nuova negoziazione con ICE restart;
- riconnessione Socket.IO con resume autenticato della sessione;
- STUN pubblico configurato dal backend;
- diagnostica separata per signaling, ICE, candidati e media realmente ricevuti;
- identificazione del percorso selezionato: **Diretta P2P** oppure **Relay TURN**;
- cache PWA versionata per evitare asset obsoleti dopo il deploy.

## Flusso

1. Sul telefono vicino al bambino scegli **Questo telefono resta con il bambino**.
2. Concedi fotocamera e microfono.
3. Sul Parent scansiona il QR oppure inserisci il PIN a 6 cifre.
4. Il Baby crea una sola offerta WebRTC.
5. Entrambi raccolgono candidati host/STUN e cercano un percorso diretto.
6. Se la connessione cade, BabyMoon ritenta con backoff `0 / 2 / 5 / 10 / 30 / 60 s`.

> Il Parent non deve concedere fotocamera o microfono: riceve soltanto. Premi **Attiva audio** dopo che il pulsante diventa disponibile; il tocco sblocca l’uscita sonora su iOS/Safari.

## ICE e STUN

L’endpoint `GET /api/ice-config` fornisce ai client:

```text
stun:stun.cloudflare.com:3478
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
```

STUN aiuta i dispositivi a scoprire i propri indirizzi pubblici, ma non inoltra il video. Il media resta peer-to-peer quando ICE seleziona un candidate pair diretto.

**Limite importante:** STUN non può attraversare ogni NAT o firewall. Se la diagnostica mostra candidati locali/remoti ma ICE termina in `failed`, alcune combinazioni di rete richiedono un relay TURN. La V1.0.4 accetta TURN autenticato tramite variabili d’ambiente, ma non lo abilita né genera costi automaticamente.

## Avvio locale

Prerequisito: Node.js 20 o successivo.

```bash
npm install
npm run verify
npm start
```

Apri `http://localhost:3000`. Fotocamera e microfono funzionano su `localhost`; sui telefoni serve HTTPS.

## Deploy gratuito su Render

1. Pubblica la repository su GitHub.
2. In Render scegli **New → Blueprint** e collega la repository.
3. Render legge `render.yaml` e crea un Web Service Node.
4. Imposta `PUBLIC_URL` sull’origine HTTPS assegnata, senza slash finale, ad esempio:

   ```text
   https://babymoon-xxxx.onrender.com
   ```

5. Esegui il deploy.
6. Dopo l’aggiornamento chiudi completamente pagina/PWA su entrambi i telefoni e crea una **nuova sessione**.

Il piano gratuito di Render può sospendere il servizio quando non è usato; il primo accesso può quindi richiedere tempo.

## Variabili d’ambiente

| Variabile | Obbligatoria | Descrizione |
|---|---:|---|
| `PORT` | no | Porta HTTP, predefinita `3000` |
| `NODE_ENV` | sì in produzione | Usa `production` su Render |
| `PUBLIC_URL` | consigliata | Origine HTTPS usata nel QR |
| `TURN_URLS` | no | URL TURN separati da virgola |
| `TURN_USERNAME` | no | Username TURN |
| `TURN_CREDENTIAL` | no | Password/credenziale TURN |

Non inserire credenziali reali in GitHub. Se in futuro si usa un provider con chiave permanente, il backend deve convertirla in credenziali TURN temporanee; la chiave permanente non deve arrivare al browser.

## Test consigliati

### 1. Hotspot / stessa rete

- Telefono A crea l’hotspot.
- Telefono B si collega all’hotspot.
- Avvia una nuova sessione.
- Verifica la progressione `new → checking → connected/completed`.
- In diagnostica devono comparire candidati locali e remoti.

### 2. Reti diverse

- Baby su Wi-Fi.
- Parent su 4G/5G o un’altra Wi-Fi.
- Crea una nuova sessione.
- Se compare **Diretta P2P**, STUN è sufficiente per quelle reti.
- Se ICE arriva a `failed` nonostante i candidati, serve probabilmente TURN.

### 3. Regressioni

Verifica anche:

- video Parent;
- pulsante **Attiva audio**;
- incremento dei byte `audio` nella sezione **Diagnostica → Media**;
- cambio camera Baby;
- **Oscura** e tocco per riattivare;
- **Termina** da entrambi i dispositivi;
- riconnessione automatica dopo un’interruzione breve;
- **Riprova ora**;
- QR e PIN;
- nessuna richiesta di camera/microfono sul Parent.

## Sicurezza e privacy

- WebRTC cifra il media con DTLS-SRTP.
- PIN e QR scadono dopo 5 minuti e diventano inutilizzabili dopo il pairing.
- QR usa un token casuale da 256 bit.
- Baby e Parent ricevono token di resume distinti.
- Un solo Parent può associarsi.
- Il server autorizza ruolo, sessione e socket per ogni segnale.
- Cinque pairing falliti attivano un blocco temporaneo per IP/sessione.
- **Termina** invalida la sessione per entrambi.
- Header di sicurezza e redirect HTTPS sono abilitati in produzione.
- Le sessioni risiedono in memoria; un riavvio del server le chiude intenzionalmente.

BabyMoon è un progetto sperimentale, non un dispositivo medico o di sicurezza certificato. Non sostituisce la supervisione di un adulto.

## Struttura

```text
.
├── server.js                 # HTTPS redirect, pairing, signaling, ICE config
├── public/
│   ├── index.html            # UI mobile-first
│   ├── app.css
│   ├── app.js                # media, WebRTC, ICE, recovery e diagnostica
│   ├── manifest.json
│   ├── sw.js
│   └── icon.svg
├── test/
│   ├── server.test.js
│   ├── client.contract.test.js
│   └── client.audio.runtime.test.js
├── .github/workflows/ci.yml
├── render.yaml
├── Dockerfile
└── .env.example
```

## Comandi

```bash
npm run check   # controllo sintattico
npm test        # test server + contratti client
npm run verify  # entrambi
```

## Licenza

Uso privato/sperimentale. Aggiungi una licenza esplicita prima di distribuire il progetto pubblicamente.
