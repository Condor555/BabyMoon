# Changelog

## 1.2.1

### Fixed
- Parent **Interrompi** ora rimuove soltanto quel Parent.
- Fullscreen Parent corretto con fallback iOS/WebKit/CSS.
- Talkback Parent → Baby con transceiver dedicato.
- PeerConnection Baby separata per ciascun `parentId`.
- Offer/answer, ICE, restart e cleanup isolati per negoziazione.
- Il secondo Parent riceve entrambe le track Baby senza sostituire la connessione del primo.

### Tests
- Contratti statici architetturali e UI.
- Integrazione signaling con due Parent, aggiunta tardiva, uscita isolata e permanenza del primo Parent.
