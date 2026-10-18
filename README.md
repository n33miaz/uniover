<div align="center">
  <img width="100%" alt="UniOver" src="https://github-stats-api-rfi2.onrender.com/api/banner?title=UniOver&subtitle=One%20app%20for%20home%20and%20training&title_color=98C4A3&text_color=c9d1d9&v=1" />
</div>

<div align="center">

![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-98C4A3?style=flat-square)
![.NET](https://img.shields.io/badge/.NET-10-98C4A3?style=flat-square)
![Angular](https://img.shields.io/badge/Angular-22-98C4A3?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.14-98C4A3?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-98C4A3?style=flat-square)

</div>

<br/>

<div align="center">
  <h1>UniOver</h1>
  <p><em>Um app só para a casa e o treino: TV, treino, saúde, monitor, rede, backup e avisos.</em></p>
</div>

UniOver é um app pessoal (PWA) que reúne em um lugar o que antes eram vários apps soltos. O celular fala com
uma API na nuvem, e um agente Python nos aparelhos de casa executa os comandos (por exemplo, controlar a TV).
Cada assunto é um **módulo** com fronteiras rígidas, de modo que qualquer um possa virar um deploy separado
no futuro.

O código é **público para leitura e avaliação técnica**, com todos os direitos reservados. Veja
[Licença](#licença).

## Módulos

| Módulo | O que faz | Quando |
|---|---|---|
| Conta (`Identity`) | usuário, sessões, passkey de confirmação | primeira versão |
| Aparelhos (`Devices`) | agentes pareados, tokens e presença | primeira versão |
| TV (`Tv`) | comandos e estado da TV, atalhos | primeira versão |
| Treino (`Training`) | catálogo, fichas, sessões, séries e progresso | em seguida |
| Saúde (`Health`) | saúde dos agentes e da API, linha do tempo | depois |
| Monitor (`Monitor`) | monitor dos serviços na internet | depois |
| Rede (`Network`) | rede da casa | depois |
| Backup (`Backup`) | backup de fotos (Android primeiro) | depois |
| Avisos (`Notifications`) | Web Push e central de avisos | depois |
| PC (`PcControl`) | controle do PC | adiado |

## Arquitetura

- **Monólito modular:** um processo (.NET 10) compõe os módulos e serve o PWA na mesma origem.
- **Fatias verticais e portas e adaptadores** dentro de cada módulo; módulos só se falam pela API pública
  (`*.Contracts`) ou por eventos.
- **Postgres (Neon)** com um schema e um `DbContext` por módulo, sem chave estrangeira entre módulos.
- **Eventos** por uma porta própria, com outbox no Postgres; um broker entra depois, só trocando o adaptador.
- **Agente local** em Python que disca para fora por WebSocket (nunca abre porta); MQTT é um adaptador futuro.
- **Contratos** em `contracts/` (OpenAPI e JSON Schema/AsyncAPI) são a fonte de verdade entre as linguagens.
- **PWA em Angular 22** com Workbox e fila offline, servido pela própria API.
- **Segurança:** senha, JWT curto, refresh rotativo em cookie, passkey para ação perigosa, token por dispositivo.

As decisões e os motivos estão em [`adr/`](adr/README.md).

## Estrutura do monorepo

```
uniover/
├─ apps/
│  ├─ api/      API .NET 10: solução, módulos e testes
│  ├─ web/      PWA Angular 22
│  └─ agent/    agente local Python 3.14
├─ contracts/   contratos entre linguagens (HTTP e agente)
├─ adr/         decisões de arquitetura
├─ assets-third-party/   material de terceiros com licença própria
├─ Dockerfile   imagem única (web + API)
├─ LICENSE  README.md  SECURITY.md
```

## Como rodar

Cada app roda e testa sozinho a partir da raiz do repositório.

```bash
# API (.NET 10)
dotnet test apps/api/UniOver.slnx

# PWA (Angular 22)
npm --prefix apps/web ci && npm --prefix apps/web start

# Agente (Python 3.14, uv)
uv --directory apps/agent run pytest
```

## Segurança

Para reportar uma vulnerabilidade, leia a [política de segurança](SECURITY.md). Não abra issue pública.

## Licença

Proprietária, com código à vista e todos os direitos reservados. Veja [LICENSE](LICENSE). O material em
`assets-third-party/` segue as licenças próprias de cada fonte.
