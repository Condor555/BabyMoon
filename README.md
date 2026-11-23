# BabyMoon 🌙

BabyMoon trasforma due telefoni in un baby monitor privato. Il telefono Baby trasmette fotocamera e microfono al telefono Genitore tramite WebRTC; Socket.IO gestisce pairing e signaling.

## Avvio

```bash
npm install
npm run dev
```

## Deploy HTTPS su Render

1. Crea su GitHub una repository privata chiamata `BabyMoon` e carica questi file.
2. Su Render: **New > Blueprint**, collega la repository `BabyMoon` e usa `render.yaml`.
3. Al primo deploy copia l'URL HTTPS Render e impostalo come variabile `PUBLIC_URL` (senza slash finale), quindi redeploy.
4. Apri lo stesso URL HTTPS su due telefoni.

## Test

Telefono 1: Modalità Baby → consenti camera/microfono → mostra QR/PIN.  
Telefono 2: apri il QR o Modalità Genitore → inserisci PIN → verifica audio/video.

## Nota rete

L'MVP usa STUN pubblico Google. Su NAT restrittivi sarà necessario aggiungere TURN (es. coturn/Twilio) prima dell'uso affidabile fuori casa.
