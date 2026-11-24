# BabyMoon 🌙

**Sempre vicino, anche durante il sonno.**

BabyMoon trasforma un telefono Baby e fino a **3 telefoni Parent** in un baby monitor PWA. Il Baby è l'unica sorgente audio/video; ogni Parent riceve lo stream tramite una RTCPeerConnection WebRTC separata e autenticata.

> BabyMoon non sostituisce la supervisione di un adulto né un dispositivo medico o di sicurezza certificato. Il rilevamento del “possibile pianto” è euristico e può produrre falsi positivi o negativi.

## Novità V1.1.2 cumulativa

### Audio e anti-rimbombo (V1.1.1)

- **Ascolto Parent ON/OFF** locale: silenzia solo quel Parent senza interrompere WebRTC.
- **Microfono Baby ON/OFF** remoto e globale: lo stato è sincronizzato su tutti i Parent.
- Se il microfono Baby è spento, il rilevamento del possibile pianto viene sospeso.
- Vincoli audio richiesti al browser: `echoCancellation`, `noiseSuppression`, `autoGainControl`, mono.

### Volume adattivo (V1.1.2)

- Parte circa dal 55%.
- Scende gradualmente fino al 22% durante audio continuativo.
- Recupera lentamente fino al 70% quando il segnale si stabilizza.
- È indipendente per ogni Parent e può essere disattivato tornando al volume normale.

### Più Parent

- Fino a **3 Parent autorizzati** nella stessa sessione.
- QR/PIN accettano più Parent entro 5 minuti dalla creazione.
- Token Parent distinti e crittograficamente casuali.
- Una PeerConnection, negotiation ID, coda ICE, retry e cleanup separati per Parent.
- L'ingresso, l'uscita o la riconnessione di un Parent non ricrea le connessioni degli altri.
- Il Baby mostra il numero di Parent collegati.

### Interruzione e riconnessione

- **Interrompi** chiude solo il monitoraggio del Parent corrente.
- Il Baby e gli altri Parent restano attivi.
- Quel Parent può premere **Riconnetti** entro 30 secondi; in caso di perdita involontaria i tentativi sono automatici e controllati.
- Non vengono mantenute PeerConnection sovrapposte.
- Dopo il riaggancio tornano video, stato LIVE, ascolto precedente e volume adattivo.
- Scaduti i 30 secondi, viene invalidato solo quel Parent.
- **Termina sessione** è distinta e chiude definitivamente Baby e tutti i Parent, senza retry.

## Funzioni

- pairing QR o PIN;
- WebRTC STUN/P2P con Baby unico offerer;
- video e audio Baby → Parent;
- riconnessione Socket.IO/WebRTC;
- cambio fotocamera, modalità Oscura e Wake Lock;
- rilevamento locale di possibile pianto e movimento;
- sensibilità Bassa/Media/Alta, cooldown e timeline temporanea;
- diagnostica ICE, WebRTC, percorso e byte ricevuti;
- nessuna registrazione audio, video o immagine.

## Architettura

```text
Baby (camera + mic + rilevatori)
 ├─ RTCPeerConnection dedicata ─ Parent 1
 ├─ RTCPeerConnection dedicata ─ Parent 2
 └─ RTCPeerConnection dedicata ─ Parent 3

Node.js + Socket.IO: pairing autenticato, signaling e controlli
WebRTC: media cifrati end-to-end sul percorso P2P
```

Il server conserva le sessioni solo in memoria. Un riavvio del servizio Render invalida le sessioni correnti.

## Avvio locale

Richiede Node.js 20 o successivo.

```bash
npm install
npm run check
npm start
```

Apri `http://localhost:3000`. Fotocamera e microfono richiedono `localhost` oppure HTTPS.

## Deploy su Render

Il repository include `render.yaml`:

1. collega la repository GitHub a un Blueprint Render;
2. imposta `PUBLIC_URL` con l'URL HTTPS effettivo;
3. esegui il deploy;
4. dopo ogni aggiornamento chiudi e riapri la PWA sui telefoni per sostituire la cache.

La configurazione usa STUN/P2P e non include TURN. Alcune combinazioni di NAT/firewall possono richiedere in futuro un relay TURN.

## Test

```bash
npm run check
```

La suite verifica sintassi, versione/cache PWA, contratti audio, separazione Interrompi/Termina, routing multi-Parent, limite di 3 Parent, stato globale del microfono, riconnessione e cleanup indipendente.

## Privacy e sicurezza

- PIN di 6 cifre valido 5 minuti;
- massimo 5 tentativi errati prima del blocco temporaneo;
- token Baby e Parent casuali e distinti;
- signaling autorizzato per sessione/ruolo/Parent;
- HTTPS obbligatorio in produzione;
- header di sicurezza e CSP;
- nessun segreto reale nel repository;
- nessuna registrazione dei media.

## Licenza

MIT. Vedi [LICENSE](LICENSE).
