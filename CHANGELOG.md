# Changelog

## 1.1.2

- Aggiunto volume adattivo Parent (55% iniziale, 22–70% dinamico), indipendente per dispositivo.
- Aggiunto supporto fino a 3 Parent contemporanei.
- Aggiunti token Parent distinti e pairing QR/PIN multi-Parent entro la finestra di validità.
- Separati PeerConnection, negotiation ID, ICE, retry e cleanup per ogni Parent.
- Aggiunto contatore Parent sul Baby e diagnostica Parent.
- `Interrompi` ora scollega solo quel Parent e conserva una finestra di riaggancio di 30 secondi.
- Aggiunto `Riconnetti` esplicito e retry automatico per perdite involontarie.
- Ripristinati dopo il riaggancio video, stato LIVE, ascolto precedente e volume adattivo.
- `Termina sessione` resta definitiva per Baby e tutti i Parent e non avvia retry.
- Aggiornati test, documentazione, cache PWA e configurazione CI/Render.

## 1.1.1

- Aggiunti Ascolto Parent ON/OFF e Microfono Baby ON/OFF remoto.
- Sincronizzato lo stato globale del microfono Baby.
- Sospeso il rilevamento del possibile pianto quando il microfono Baby è spento.
- Richiesti cancellazione eco, riduzione rumore, guadagno automatico e audio mono.

## 1.1.0

- Aggiunti rilevamento locale di possibile pianto e movimento.
- Aggiunti sensibilità, cooldown, avvisi e timeline temporanea.
- Mantenuta la baseline WebRTC STUN/P2P della V1.0.4.
