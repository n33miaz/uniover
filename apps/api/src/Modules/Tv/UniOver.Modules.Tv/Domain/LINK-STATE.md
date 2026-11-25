# Estado do elo da TV (`link`)

Um valor único e explícito para a tela e o agente saberem em que ponto o caminho tela → PC → TV está. É um campo
**aditivo** do estado da TV: quem não o conhece continua lendo `power`, `connection` e `agentOnline` como antes.

## Onde aparece

- `GET /api/v1/tv/state` (campo `link`).
- Fluxo em tempo real `GET /api/v1/tv/events`, nos eventos `tv.state` (o do instantâneo inicial e os de mudança).

```json
{ "power": "on", "connection": "hot", "agentOnline": true, "link": { "version": 1, "state": "ready" } }
```

## Contrato (`link.version` = 1)

| `link.state`      | Significado                                                               |
|-------------------|---------------------------------------------------------------------------|
| `pc_offline`      | PC desligado, sem conexão com a API ou sem relato recente do agente.      |
| `tv_off`          | O PC responde e a TV está desligada.                                      |
| `tv_standby`      | A TV está em standby (ou acordando dele).                                 |
| `tv_sleep`        | A TV está no Modo Dormir do TV Livre.                                     |
| `tv_unresponsive` | O PC responde, mas a TV não responde a ele (ou ainda não foi relatada).   |
| `ready`           | Agente conectado, relato recente e TV pronta para comandos.               |

Os valores são estáveis. `version` só sobe com mudança incompatível (valor removido ou com outro sentido); valor novo
é aditivo, então o cliente deve tratar um `state` desconhecido como "sem elo confirmado".

## Como é derivado (ordem de precedência)

1. Agente sem sessão **ou** sem nenhuma mensagem dentro de `Modules:Tv:LinkStaleSeconds` (90 s por padrão) → `pc_offline`.
   O último estado da TV nunca é mantido: sem relato recente, o elo é do PC.
2. Sem leitura da TV, ou `connection` = `disconnected` / `not_paired` → `tv_unresponsive`.
3. Campo opcional `mode` do `tv.state.v1` (`off`, `standby`, `sleep`) → `tv_off`, `tv_standby`, `tv_sleep`.
   Vale mais que a inferência abaixo; valor fora da lista é ignorado. **Reservado:** o contrato atual do `tv.state.v1`
   (`contracts/agent`) ainda não tem o campo e o validador recusa campos extras; a API já o entende, mas só passa a
   receber (e a anunciar `tv.state.mode` em `features`) depois que o contrato e o agente o adotarem.
4. Sem `mode`: `connection` = `waking` → `tv_standby`; `power` = `off` → `tv_off`.
5. Caso contrário → `ready` (inclui `connection` = `hibernating`: a sessão dorme para poupar a TV, não é TV desligada).

## Consumo

- **Web**: mostrar uma mensagem por `link.state` e usar `connection` / `power` só para detalhe.
- **Agente**: hoje `tv_standby` só sai de `connection` = `waking`, e `tv_sleep` não é alcançável. Para distinguir standby
  e Modo Dormir, o contrato do agente precisa ganhar `mode` (pendência fora de `apps/api`).

O valor é calculado na leitura e na publicação, nunca gravado. Um agente conectado que fica mudo passa a `pc_offline` na
próxima leitura (`GET /state` ou nova conexão ao fluxo); a queda da sessão já é publicada na hora.
