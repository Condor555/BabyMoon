# Changelog

## 1.1.0

- Rilevamento locale e non persistente di **possibile pianto** mediante analisi acustica nel browser.
- Rilevamento locale di movimento tramite differenza tra frame a 160×90 px.
- Sensibilità `Bassa / Media / Alta` configurabile dal Parent.
- Cooldown anti-ripetizione configurabile: 30–60 secondi per il pianto e 10–20 secondi per il movimento.
- Avvisi Parent visivi, vibrazione e tono quando l'audio è stato sbloccato dall'utente.
- Timeline in memoria limitata agli ultimi 50 eventi e cancellata con la sessione.
- Nessuna registrazione, immagine o clip inviata al server.
- Baseline WebRTC V1.0.4 mantenuta: Baby offerer, Parent receiver, STUN/P2P, audio Parent separato, riconnessione e terminazione sincronizzata.
- Cache PWA aggiornata a `babymoon-v1.1.0`.

## 1.0.4

- Riproduzione audio Parent compatibile con le restrizioni autoplay iOS/Safari.
- Diagnostica byte audio/video ricevuti.
