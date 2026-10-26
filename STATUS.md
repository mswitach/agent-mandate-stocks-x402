# STATUS · 26/10/2026

- [x] Fork de Base: depósito de AAPLc como colateral en Aave v4 Coinbase Stocks bajo mandato (on-chain)
- [x] Préstamo de 5 USDC bajo mandato, al destino firmado. Pedir más del tope revierte (`CapExceeded`)
- [x] HF 3,17 y precio de liquidación ≈ US$108 (AAPL US$343,43 en el oráculo del fork)
- [x] Pago x402 en el fork con facilitador local (EIP-3009 sobre USDC real forkeado)
- [x] Pago x402 real en Base Sepolia: 0x55f966b0ab4c195cd5cf142b7522f4fee7bcd88a71cd265f34d1db24ab3024e8
- [x] Recibo unificado con 7 firmas verificadas + 3 capturas para X
- [ ] Mainnet: sin probar y sin auditar. En el fork el contrato se habilitó escribiendo storage del spoke (atajo). Los position managers nativos de v4 ya están activos en el spoke Coinbase Stocks y un mandato podría montarse encima, sin probar
- [ ] Legal: elegibilidad Reg S de AAPLc desde Argentina sin confirmar
- [ ] Mandato de pago on-chain (hoy es off-chain en el runtime del agente)
