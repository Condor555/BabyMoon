# Changelog

## 1.2.0

### Aggiunto

- visione notturna software Auto/On/Off con stima locale della luminanza;
- scansione QR live e da immagine nel flusso Parent;
- invito di un nuovo Parent dal Baby o da Parent → Impostazioni → Dispositivi;
- credenziali di invito temporanee, monouso e revocabili, separate dai token privati;
- conteggio `n/3`, slot disponibili e diagnostica inviti;
- UI Parent riorganizzata intorno a video, stato, azioni principali e impostazioni secondarie;
- manifest PWA completo, icone installabili/maskable e Apple touch icon;
- install prompt Android/Chromium e istruzioni contestuali iOS/iPadOS;
- supporto standalone e safe area.

### Sicurezza

- rate limiting per creazione e consumo degli inviti;
- controllo autorizzazione per creator Baby/Parent;
- consumo atomico e revoca degli inviti;
- header HSTS, Permissions-Policy, no-referrer e nosniff;
- esclusione di API e Socket.IO dalla cache del service worker.

### Mantenuto

- multi-Parent fino a 3 peer indipendenti;
- riconnessione di 30 secondi anche dopo Interrompi;
- audio separato per compatibilità iOS, ascolto locale, controllo microfono Baby e volume adattivo;
- rilevamento locale di possibile pianto e movimento;
- modalità Oscura, Wake Lock, terminazione sincronizzata, QR/PIN e HTTPS.
