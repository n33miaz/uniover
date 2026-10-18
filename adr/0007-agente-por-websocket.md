# 0007. Agente local que disca para fora por WebSocket; MQTT como adaptador futuro

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

Os aparelhos de casa ficam atrás do roteador, sem IP público. Abrir portas para a internet seria uma
superfície de ataque grande e frágil (IP dinâmico, CGNAT). A API precisa mandar comandos ao agente em tempo
real e saber se ele está vivo. Mais adiante, interruptores e outros dispositivos pequenos vão preferir MQTT.

## Decisão

O agente **disca para fora** e mantém uma conexão **WebSocket** aberta com a API, um canal por agente. Ele
nunca abre porta de entrada. O token de dispositivo fica no Cofre de Credenciais do Windows.

O transporte é uma **porta** nos dois lados: na API, `Devices.Transport.*`; no agente, `adapters/transport_*`.
O WebSocket é o primeiro adaptador. **MQTT** entra depois como adaptador irmão (tópicos
`uniover/<agente>/cmd` e `.../evt`), com o mesmo envelope de mensagem (ver ADR 0008).

Em repouso, o agente mantém a sessão com a TV quente e hiberna após 5 minutos sem uso, reconectando no
primeiro comando.

## Consequências

- Nenhuma porta aberta na casa; funciona atrás de NAT e de CGNAT.
- Trocar de transporte é trocar um adaptador, sem tocar nas regras de negócio.
- A API precisa tratar presença, reconexão e mensagens duplicadas.
- Com uma conexão longa por agente, o plano gratuito de hospedagem que hiberna a instância exige cuidado.

## Alternativas consideradas

- **API chamando o agente por HTTP:** exige porta aberta ou túnel na casa.
- **VPN ou túnel de terceiros:** mais uma peça para manter e confiar.
- **MQTT desde já:** exige broker pago ou operado por nós antes de haver necessidade medida.
- **Polling HTTP do agente:** latência alta para um controle remoto.
