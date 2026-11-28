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
   Vale mais que a inferência abaixo. O contrato de `tv.state.v1` aceita apenas esses três valores para o campo.
4. Sem `mode`: `connection` = `waking` → `tv_standby`; `power` = `off` → `tv_off`.
5. Caso contrário → `ready` (inclui `connection` = `hibernating`: a sessão dorme para poupar a TV, não é TV desligada).

## Consumo

- **Web**: mostrar uma mensagem por `link.state` e usar `connection` / `power` só para detalhe.
- **Agente**: envia `mode` quando confirma o modo e a API lista `tv.state.mode` em `features` de `devices/info`.
  O instante da publicação vem de `ts` no envelope. Falhas de alcance ou resposta são refletidas em `connection`.
  O motivo detalhado fica no registro do agente. Relatos sem `mode` continuam usando a inferência por `connection`
  e `power`.

O agente publica nas mudanças de estado e a cada conferência do endereço da TV. Uma sessão aberta já confirma a
presença. Com o controle hibernando, o agente aproveita a resposta da sondagem existente. Na Samsung, verifica a
identidade antes de usar o `PowerState` do mesmo retorno REST. Na Android TV, o Modo Dormir é observado quando o
TV Livre abre a tela preta. A perda de contato por si só deixa o modo desconhecido, inclusive após a tecla de energia.

O elo é calculado na leitura e na publicação. Se um agente conectado fica mudo, o fluxo também publica
`pc_offline` quando o vigia detecta que o relato venceu. A queda da sessão é publicada na hora.
