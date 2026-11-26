# contracts

Fonte de verdade entre API (C#), agente (Python) e web (TypeScript). Tipos gerados a partir daqui nunca são
editados à mão.

- `agent/envelope.schema.json`: envelope único (`v`, `id`, `type`, `source`, `target`, `ts`, `correlationId`, `body`).
  Opcionais, só nos comandos `pc.*` da API para o agente: `operationId` (o código do `X-Operation-Id` do pedido HTTP, só a quem declara
  `pc.op.v1`; nunca no movimento do mouse), e `deviceId` + `deviceName` (o aparelho do app, para o dono aprová-lo no PC, só a quem declara
  `pc.device.v1`; também na oferta do canal direto). O esquema de cada mensagem é fechado: um agente anterior recusaria o campo, por isso a
  API só o manda a quem declarou a capacidade (que o agente só declara depois de a API listá-la em `features`).
- `agent/messages/*.schema.json`: um esquema por `type`; fixa o `type` e o `body`.
- `agent/asyncapi.yaml`: AsyncAPI 3.0; WebSocket hoje, MQTT declarado como futuro (mesmo envelope).
- `agent/examples/valid` e `invalid`: exemplos usados pela validação (válido deve passar, inválido deve falhar).
- `http/`: `openapi.json` gerado pela API; não editar à mão.
- `scripts/validate.mjs`: compila os esquemas e confere os exemplos.

## Versionamento de `type`

Formato `<area>.<acao>.v<n>`. Mudança incompatível cria um novo `type` (`.v2`); nunca altere o significado de
um `type` publicado. As duas versões convivem até o agente atualizar.

## Mensagens da TV

`agent.keepalive.v1` e `api.keepalive.v1` são batimentos para atravessar proxies que descartam conexões WebSocket
ociosas: o do agente sai a cada 5 segundos (25 nos agentes anteriores), o da API a cada `ApplicationKeepAliveSeconds`.
O corpo do `agent.keepalive.v1` pode levar `loopLagMs` (o maior atraso do laço principal do agente desde o batimento
anterior, em ms, até 600000); o agente só o manda à API que lista `agent.keepalive.loop_lag` em `features`, porque
uma anterior recusaria o batimento. O agente anuncia a capacidade `transport.keepalive.v1`; enquanto ela não
existe, a API não envia o batimento novo para preservar a compatibilidade durante a atualização.

`transport.restart.v1` é a capacidade de quem entende o fechamento `4411` (motivo `server-restart`): a API que vai parar
(troca de instância na publicação) fecha o canal com esse código para dizer "reconecte agora", e o agente volta em 0,2 a
0,5 s, com jitter, sem somar espera. A API só o usa com o agente que declarou a capacidade; para os demais mantém o
`1012` de sempre. O agente só a declara depois de a API listá-la em `features` (`GET /api/v1/devices/info`), porque uma
API anterior recusa capacidade que não conhece.

| `type` | Direção | Corpo |
|---|---|---|
| `tv.key.v1` | API para agente | `key` (14 teclas). Segue válido e inalterado. |
| `tv.key.v2` | API para agente | `key` (as 14 do `v1` mais `MENU`, `NUM_0` a `NUM_9`, `MEDIA_NEXT`, `MEDIA_PREVIOUS`, `INPUT`) e `direction` opcional (`SHORT`, padrão, `START_LONG`, `END_LONG`). |
| `tv.key.v3` | API para agente | `key` (as do `v2` mais `INFO`, `GUIDE`, `TOOLS`, `CHANNEL_LIST`, `PREVIOUS_CHANNEL`, `EXIT`, `PLAY`, `PAUSE`, `STOP`, `REWIND`, `FAST_FORWARD`, `RED`, `GREEN`, `YELLOW`, `BLUE`, `SUBTITLE`, `ASPECT`, `SLEEP`, `E_MANUAL`) e `direction` opcional. A API só a usa para as teclas que o `v2` não tem, e o agente que a entende declara a capacidade `tv.key.v3`. |
| `tv.power.off.v1` | API para agente | `{}`: desligar de forma segura. O agente lê a energia da TV, só aperta `POWER` se ela estiver ligada e confirma o desligamento; nunca liga a TV. Responde com `command.result.v1`: `ok: true` é `off`; `ok: false` traz `error.code` `already_off`, `uncertain` (não deu para ler ou confirmar; nenhuma tecla foi repetida), `offline` ou `failed`. A API só a usa quando o agente declara a capacidade `tv.power.off.v1`; sem ela segue o `tv.key.v2` com `POWER`. |
| `tv.wake.v1` | API para agente | `{}`: o app está aberto, aqueça a sessão. |
| `tv.presence.v1` | API para agente | `{}`: alguém acabou de tocar na tela da TV no app (a tela, visível, manda o sinal a cada toque ou tecla, no máximo um a cada 5 s, e nunca por tempo; a API repassa no máximo um a cada 10 s por agente). É o único sinal que deixa o agente abrir uma conexão ADB nova por conta própria, e só por 60 s: tecla, texto, atalho do iPhone e desligamento agendado, sozinhos, nunca contam. A API só a envia quando o agente declara a capacidade `tv.presence.v1`. Sem resposta. |
| `tv.app.launch.v1` | API para agente | `target`: `{ kind: "package" | "link", value }`. Pacote: nome Android com pontos (até 255); link: `esquema://...` sem espaços nem controles (até 2048). |
| `tv.settings.open.v1` | API para agente | `screen`: `WIFI` (a tela de rede) ou `SETTINGS` (as configurações da TV). Lista fechada: nada fora dela chega à TV, e o corpo nunca leva uma ação livre. Só sai quando a pessoa toca no botão do app. A API só a usa quando o agente declara a capacidade `tv.settings.open.v1`, que só o agente da Android TV declara (a abertura é uma tela do Android pelo ADB), e só depois de a API listá-la em `features`. Resultado em `command.result.v1`. |
| `tv.state.v1` | agente para API | `power`, `volume`, `app` e `connection`. `adbPermission` é opcional (`granted`: a TV aceitou o UniOver no ADB; `missing`: o agente não consegue usar o ADB sem a pessoa pedir pelo app, e o motivo vai ao diagnóstico `adb.permission.*`; `pending`: o aviso do ADB está na tela da TV esperando o aceite) e some enquanto o ADB não disse nada. `adbPermissionReason` (opcional, só com `missing`; texto curto `[a-z_]`) diz por que falta: `tv_forgot` é a TV que recusou uma chave que já tinha aceitado, e só ele abre a folha de pedido sozinha no app. O agente só os envia depois de a API listar `tv.state.adb_permission` em `features` (uma API anterior recusaria o campo). `wakeHints` (opcional, 1 ou 2 itens, só em TV TCL): `screenless_off` é o "Screenless service" desligado (lido em `settings get secure smart_audio_switch`), e o app diz onde ligá-lo; `replug` é o Wake-on-LAN que saiu sem a TV responder, numa TV que liga sozinha quando a energia volta (`persist.tcl.powerloss`), e o app sugere tirar da tomada e ligar de novo. Some quando não há nada a avisar, e só sai depois de a API listar `tv.state.wake_hints` em `features`. |
| `tv.apps.refresh.v1` | API para agente | `{}`: pede a lista de apps. |
| `tv.apps.v1` | agente para API | `apps`: lista de `{ package, label | null }` (até 500) e `at` (UTC). |
| `tv.apps.v2` | agente para API | Como o `v1`, mais `icon` opcional por app: `{ mime: "image/png" | "image/webp", data }` (base64, até 32768 bytes). A lista é sempre completa; app sem `icon` mantém o que a API já guarda. O `v1` segue válido. |
| `tv.text.v1` | API para agente | `text`: 1 a 200 caracteres, sem caracteres de controle. |
| `tv.watchdog.v1` | agente para API | `kind`, `severity` (`info`, `warn`, `error`), `detail` (até 200), `attempts`, `at`. |
| `tv.cleanup.v1` | API para agente | `requestId` (UUID gerado pela API): fecha os apps abertos na TV e libera memória pelo ADB, sem derrubar o controle remoto. |
| `tv.cleanup.result.v1` | agente para API | O que a limpeza fez: `requestId` (o do pedido), `closedApps`, `memoryBeforeMb`, `memoryAfterMb` e `freedMb` (inteiros, ou `null` quando a memória não pôde ser lida; `freedMb` nunca é negativo), `failedSteps` (etapas que não deram certo, como `force-stop:com.exemplo.app`) e `at`. |
| `tv.pair.v1` | API para agente | Pareamento da Android TV, em passos e só por pedido do dono. Sem `code` nem `cancel`: o agente pede o pareamento e a TV mostra um código de 6 caracteres (0-9 e A-F); responde logo com `command.result.v1`. Com `code` (6 caracteres): o agente responde `ok` assim que a TV aceita o par e só então reabre a sessão (sem tecla, sem contar como uso); o resultado da abertura chega pelo `tv.state.v1`: `not_paired` some, ou continua se a TV recusar de novo. Com `cancel: true`: o app fechou a folha e o agente larga o pareamento que esperava o código (`ok` mesmo sem nada pendente); `cancel` e `code` não vão juntos. O código nunca vai para registro, auditoria nem mensagem de erro. Erros: `tv_unreachable`, `pair_not_started`, `pair_timeout` (o código venceu), `invalid_code`, `pair_closed`, `pair_failed`, `pair_busy`. Capacidade `tv.pair.v1`, só declarada depois de a API listá-la em `features`. |
| `tv.permission.request.v1` | API para agente | `{}`: pede à TV Samsung a permissão do UniOver (o aviso "Permitir" na tela da TV). É o único jeito de o agente fazer esse pedido: ele nunca o repete sozinho. Responde logo com `command.result.v1` (`ok: true` é "o aviso foi pedido"; erros `unsupported`, `tv_unreachable`, `permission_in_progress`) e depois manda `tv.permission.v1`. A API só a usa quando o agente declara a capacidade `tv.permission.v1`. |
| `tv.permission.v1` | agente para API | `state` (`needed`: a TV não reconhece mais o UniOver e o agente parou de tentar sem pedir de novo em silêncio; `granted`: a TV aceitou) e `at`. Sai quando o estado muda e outra vez depois de cada `hello`. |
| `tv.adb.rebind.v1` | API para agente | `{}`: a pessoa confirmou no app que o aparelho que responde agora no endereço da TV é a mesma TV (trocou de Wi-Fi para cabo, por exemplo, e o MAC mudou). O agente refaz o registro da permissão do ADB para o MAC de agora (a permissão volta a `granted`, sem prova) e responde com `command.result.v1` (`ok: true`; erros `adb_identity`, `adb_unreachable`). Não conecta a nada: o pedido de permissão seguinte é o de sempre (`tv.apps.refresh.v1`). Sem este pedido o agente nunca troca o aparelho do registro, e com outro MAC no endereço se recusa a conectar (`adb_device_changed`). Capacidade `tv.adb.rebind.v1`, só declarada depois de a API listá-la em `features`. |
| `tv.discover.v1` | API para agente | `requestId` (UUID gerado pela API): procura as TVs compatíveis na rede local do computador (só leitura de identificação). Responde com `tv.discovery.v1` e depois `command.result.v1`. A API só a usa quando o agente declara a capacidade `tv.discovery.v1`. |
| `tv.discovery.v1` | agente para API | `requestId` (o do pedido), `tvs` (até 50 de `{ id, kind, name | null, controlled }`; `id` é opaco e estável, nunca o IP nem o MAC, e `controlled` diz se é a TV que o agente já controla) e `at`. Sai antes do `command.result.v1` do mesmo comando (`correlationId` = id do comando). |

## Controle do PC

Só o agente que declara a capacidade `pc.control.v1` (no `agent.hello.v1`) recebe estas mensagens; ela só é declarada
quando a pessoa liga o controle no próprio PC (`pc_control` no arquivo de configuração do agente, desligado por
padrão). Todas descem da API para o agente e voltam em `command.result.v1`, exceto `pc.apps.v1`, `pc.volume.state.v1`, `pc.media.state.v1`, `pc.clipboard.v1`, `pc.device.state.v1` e `pc.power.outcome.v1`, que sobem, e `pc.pointer.v1`, que o agente executa sem responder (a API manda o movimento do mouse sem esperar resposta; uma resposta por movimento só encheria o canal). As listas de
teclas e de ações são fechadas: nada fora delas chega ao Windows, e o corpo nunca leva caminho de programa.

Com a capacidade `pc.mouse.v1` (declarada só depois de a API listá-la em `features`), o `agent.hello.v1` leva `pcMouse`: os ajustes do mouse do Windows, só lidos (`acceleration`, o "aprimorar a precisão do ponteiro", e `speed`, de 1 a 20). O Windows já os aplica ao movimento relativo que o agente manda; o app os mostra nos ajustes do touchpad e usa a aceleração do Windows como padrão da aceleração do app enquanto a pessoa não escolheu.

| `type` | Direção | Corpo |
|---|---|---|
| `pc.pointer.v1` | API para agente | `dx`, `dy` (pixels relativos, -2000 a 2000) e `scrollX`/`scrollY` opcionais (unidades de roda: 120 é um clique da roda, -1200 a 1200; sinal do Windows, positivo é direita e cima). O app soma os toques do dedo antes de mandar e o agente limita cada valor. |
| `pc.pointer.zoom.v1` | API para agente | `steps` (-12 a 12, nunca 0): zoom pela roda do mouse com o Ctrl apertado, o que a pinça do app manda. Positivo aproxima (roda para cima), negativo afasta. O agente aperta o Ctrl, gira a roda `|steps|` vezes e solta o Ctrl num lote só do sistema: o Ctrl nunca fica preso (lote aceito em parte, queda do canal direto e queda da conexão com a API o soltam); se um `pc.key.v2` `DOWN` já o segura, ele não é apertado de novo nem solto. `seq` e `epoch` como nas outras entradas da nuvem. Valida no canal direto como as demais entradas (mesma idade, taxa e fila). A API só a usa para o agente que declarou a capacidade `pc.pointer.zoom.v1` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.volume.v1` | API para agente | Volume absoluto: `level` (0 a 100, o volume principal do dispositivo de saída padrão em porcentagem) e/ou `muted` (liga ou desliga o mudo, sem alternar); pelo menos um dos dois, e juntos o nível entra antes do mudo. Mudar o nível não desliga o mudo. `seq` e `epoch` como nas outras entradas da nuvem; no canal direto vale a mesma validação, idade e taxa. A API só a usa para o agente que declarou a capacidade `pc.volume.v1` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. As teclas relativas de `pc.media.v1` seguem valendo. |
| `pc.volume.state.v1` | agente para API | `level` (0 a 100), `muted` e `at`: o volume de agora. O agente só o manda a uma API que listou `pc.volume.v1` em `features` (uma anterior recusaria o tipo): na conexão, quando a API passa a listá-lo, depois de executar `pc.volume.v1` e as teclas de volume e mudo de `pc.media.v1`, e quando uma leitura periódica mostra que o volume mudou por fora (o teclado do próprio PC). A API o guarda em memória e o devolve em `GET /api/v1/pc/status` (`volume`, nulo enquanto não houver leitura ou com o PC desconectado). Sem resposta. |
| `pc.device.state.v1` | agente para API | `deviceId`, `state` (`pending`, `denied`, `approved`) e `at`: a decisão do dono do PC sobre um aparelho do app. A API guarda `pending` e `denied` por agente e aparelho, com validade curta, e responde 403 `pc-device-pending` / `pc-device-denied` também ao movimento do mouse (que o agente descarta sem resposta); `approved` limpa. Só vai a uma API que listou `pc.device.v1` em `features`. Sem resposta. |
| `pc.power.outcome.v1` | agente para API | `countdownId` (o `id` do comando `pc.power` que agendou a contagem), `action` (`SHUTDOWN`, `RESTART`), `outcome` (`refused`, `lost`, `cancelled`), `code` opcional e `at` (quando aconteceu): a contagem de desligar ou reiniciar não terminou no pedido. `refused`: no fim da contagem o Windows recusou (`code` é o código de saída do `shutdown.exe`, quando houve); `lost`: o agente reiniciou no meio da contagem; `cancelled`: quem está no PC cancelou no aviso da tela. A API grava `pc_shutdown_failed`/`pc_restart_failed` (ou `pc_shutdown_cancelled`) uma vez por contagem, com quem pediu quando ainda lembra daquela contagem, e devolve o desfecho por 10 min em `GET /api/v1/pc/status` (`power`) só enquanto for da contagem mais recente; uma contagem nova o apaga. Só vai a uma API que listou `pc.power.outcome.v1` em `features`. Sem resposta. |
| `pc.click.v1` | API para agente | `button` (`LEFT`, `RIGHT`, `MIDDLE`) e `action` opcional (`CLICK`, padrão, `DOUBLE`, `DOWN`, `UP`; os dois últimos são o arrastar). |
| `pc.click.v2` | API para agente | O `pc.click.v1` com `modifiers` opcionais (`CTRL`, `ALT`, `SHIFT`, sem repetir e sem `WIN`, que ao ser solto depois do clique abriria o menu Iniciar: apertados, o clique, soltos na ordem inversa, num lote só) e `gapMs` opcional (0 a 400): o intervalo, medido no aparelho, desde o toque anterior; o agente espera o que faltar desde o último clique que executou para reproduzir esse intervalo (nunca mais que `gapMs`; se o pedido chegou mais tarde, executa na hora) e assim o Windows reconhece o duplo clique mesmo com a rede irregular. `action` só `CLICK` (padrão) ou `DOUBLE`: apertar e soltar o botão (o arrastar) segue no `v1` e nunca leva modificador. A API só a usa quando o pedido leva modificador ou `gapMs` e só para o agente que declarou a capacidade `pc.click.v2` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.key.v1` | API para agente | `key` (Enter, Backspace, Delete, Tab, Escape, Space, setas, Home, End, PageUp/PageDown, `F1` a `F12`, `A` a `Z`) e `modifiers` opcionais (`CTRL`, `ALT`, `SHIFT`, `WIN`, sem repetir). |
| `pc.key.v2` | API para agente | As teclas do `v1` mais os dígitos `D0` a `D9` (a fileira de cima, não o teclado numérico), `MINUS`, `EQUALS`, `COMMA`, `PERIOD` (as quatro pontuações só estáveis nos layouts americano e ABNT2: em outros layouts o caractere pode mudar; o resto da pontuação sai pelo `pc.text`), `INSERT`, `PRINT_SCREEN`, `APPS` (tecla de menu), `WIN` (sozinha), `CAPS_LOCK` e os modificadores como tecla (`CTRL`, `ALT`, `SHIFT`). `modifiers` como no `v1`. `repeat` opcional (1 a 50): aperta e solta a tecla essa quantidade de vezes num lote só, com os modificadores valendo para todas. `action` opcional (`PRESS`, padrão, `DOWN`, `UP`): `DOWN` e `UP` só aceitam `CTRL`, `ALT`, `SHIFT` ou `WIN` como `key`, sem `modifiers` nem `repeat`, e seguram e soltam o modificador entre toques (o Alt do Alt+Tab). O agente guarda o que ficou apertado e o solta ao desconectar, ao encerrar e depois de 30 s sem nenhum comando `pc.*`; um `UP` atrasado nunca é recusado por idade. A API só a usa quando o pedido não cabe no `v1` (tecla nova, repetição ou segurar) e só para o agente que declarou a capacidade `pc.key.v2` (e só depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.text.v1` | API para agente | `text`: 1 a 200 caracteres, sem caracteres de controle; digitado como Unicode, então acentos e símbolos funcionam em qualquer layout. |
| `pc.text.v2` | API para agente | Editar o campo em foco numa mensagem só: `erase` (1 a 200: Backspaces), `text` (1 a 200 caracteres, sem controle) e `key` (`ENTER` ou `TAB`, a tecla apertada no fim), executados nesta ordem no mesmo toque no sistema; pelo menos um dos três. É o que a digitação ao vivo manda (a diferença do campo num pedido só). Cada Backspace e o `key` contam no mesmo limite de teclas do `pc.key.v2`. A API só a usa quando o pedido leva `erase` ou `key` e só para o agente que declarou a capacidade `pc.text.v2` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.text.v3` | API para agente | Igual à `pc.text.v2`, mas `text` aceita quebra de linha (LF) e tabulação: o texto colado com várias linhas chega inteiro (até 200 caracteres por pedido, em ordem) em vez de um pedido por linha. O agente aperta Enter na quebra e Tab na tabulação, cada aperto com a soltura no mesmo lote. CR e os demais controles continuam proibidos (o app troca CRLF e CR por LF). Cada LF, Tab, Backspace e o `key` contam no limite de teclas. A API só a usa quando o texto tem LF ou Tab e só para o agente que declarou a capacidade `pc.text.v3`; sem ela o app manda as quebras como `key` da `pc.text.v2`, como sempre. |
| `pc.media.v1` | API para agente | `action` (`PLAY_PAUSE`, `NEXT`, `PREVIOUS`, `STOP`, `VOLUME_UP`, `VOLUME_DOWN`, `MUTE`) e `steps` opcional (1 a 10, só para o volume). |
| `pc.power.v1` | API para agente | `action`: `LOCK`, `SLEEP`, `SHUTDOWN` (contagem cancelável no agente; ao fim, pede ao Windows sem forçar o fechamento dos programas) ou `CANCEL_SHUTDOWN`. A confirmação com a pessoa é do app e da API. |
| `pc.power.v2` | API para agente | `action`: as quatro do `pc.power.v1` mais `RESTART` (reinício com a mesma contagem do agente, sem forçar o fechamento dos programas; `CANCEL_SHUTDOWN` também o cancela), `LOGOFF` (encerra a sessão do Windows: os programas são chamados a fechar e podem pedir para salvar, e o agente cai com a sessão, só voltando quando alguém entrar de novo), `HIBERNATE` (hiberna; com a hibernação desligada no PC o agente recusa com o código `hibernation_unavailable`, sem fazer nada) e `MONITOR_OFF` (apaga a tela; qualquer toque no mouse a acende). `LOGOFF`, `HIBERNATE` e a suspensão só agem depois de o agente responder. A confirmação com a pessoa (reiniciar, encerrar a sessão, hibernar, suspender e desligar) é do app e da API; para o dono, desligar, reiniciar e encerrar a sessão também pedem a confirmação recente com a passkey. A API só a usa para as quatro ações novas e só para o agente que declarou a capacidade `pc.power.v2` (depois de a API listá-la em `features`); as quatro de antes seguem no `v1`, e para um agente sem a capacidade o pedido das novas volta como 409 `pc-key-unsupported`, sem enviar nada. `HIBERNATE` também exige a capacidade `pc.power.hibernate.v1`, que o agente só declara (depois de a API listá-la em `features`) quando a hibernação está ligada no PC (pergunta só de leitura, feita no primeiro `hello` que precisa dela e guardada até o agente reiniciar); sem ela o app não mostra "Hibernar" e a API responde 409 `pc-key-unsupported`. A conferência do agente na hora (`hibernation_unavailable`) continua, para a hibernação desligada depois do `hello`. |
| `pc.media.query.v1` | API para agente | Sem corpo: pede o que o Windows diz estar tocando (a sessão de mídia do sistema, a mesma da tela de bloqueio). Só leitura. O agente manda `pc.media.state.v1` e só depois responde `command.result.v1` (erros `unsupported`, `failed`), então quando a API vê o resultado o estado já chegou. A API só a usa para o agente que declarou `pc.media.state.v1` (depois de a API listá-la em `features`); sem ela, 409 `pc-key-unsupported`. Rota: `GET /api/v1/pc/now-playing`. |
| `pc.media.state.v1` | agente para API | `status` (`playing`, `paused`, `stopped` ou `none`, sem sessão de mídia), `title`, `artist` e `app` (até 200 caracteres cada, vazios sem faixa) e `at`; `correlationId` é o do pedido. Conteúdo da pessoa: a API o guarda só em memória, por agente, e nunca o registra nem o audita. Sem resposta. |
| `pc.clipboard.query.v1` | API para agente | Sem corpo: lê o texto da área de transferência do PC (outros formatos não passam). O agente manda `pc.clipboard.v1` e só depois responde `command.result.v1` (erros `unsupported`, `failed`). Só para o agente que declarou `pc.clipboard.v1`; sem ela, 409 `pc-key-unsupported`. Rota: `POST /api/v1/pc/clipboard/read`, auditada (sem o texto). |
| `pc.clipboard.v1` | agente para API | `text` (até 5000 caracteres, vazio sem texto) e `at`; `correlationId` é o do pedido. Pode ser uma senha: a API o entrega uma vez a quem fez aquele pedido (pelo `correlationId`) e o esquece, sem registrar, auditar nem guardar. Sem resposta. |
| `pc.clipboard.set.v1` | API para agente | `text`: 1 a 5000 caracteres, sem caracteres de controle além de tabulação e quebras de linha. Troca o texto da área de transferência do PC. Responde `command.result.v1` (erros `unsupported`, `invalid_message`, `failed`). Só para o agente que declarou `pc.clipboard.v1`. Rota: `POST /api/v1/pc/clipboard/write`, auditada (sem o texto). |
| `pc.app.launch.v1` | API para agente | `appId`: o identificador de um favorito que o próprio agente publicou. |
| `pc.apps.v1` | agente para API | `apps`: lista de `{ id, label }` (até 24) dos favoritos configurados no PC, e `at`. A lista é sempre completa; o agente a manda logo depois do `hello`. |
| `pc.rtc.offer.v1` | API para agente | `sessionId`, `sdp` (a oferta WebRTC do app, até 16 KB) e `token` (uso único, que a primeira mensagem do canal precisa apresentar) `tokenTtlSeconds` (a vida dele, contada pelo agente a partir do recebimento) e `maxLifetimeSeconds` (30 a 3600: o teto da vida do canal inteiro; a API o tira do que resta do token de acesso, então o canal nunca vive mais que a sessão que o autorizou, e o app abre outro antes do fim) e `scopes` opcional (`pc` e/ou `tv`; sem ele o canal é só do PC): o que o canal pode levar, que a API confere para a pessoa e para a TV no instante da oferta. `scopes` só vai a quem declara `tv.rtc.v1`. `ticket` (opcional: o bilhete assinado pela API, opaco para o agente) só vai a quem declara `pc.rtc.reconcile.v1`: é o que o agente devolve ao reconciliar. A oferta só vai a quem declara `pc.rtc.v1`, e a API só a envia ao agente do próprio dono do PC ou ao agente de uma TV que a pessoa pode controlar. Responde com `pc.rtc.answer.v1` (mesmo `correlationId`) e `command.result.v1`. |
| `pc.rtc.answer.v1` | agente para API | `sessionId` e `sdp` (a resposta, com a impressão digital DTLS do agente). A API a devolve ao app pela rota autenticada e não a guarda. |
| `pc.rtc.candidate.v1` | API para agente | `sessionId` e um candidato ICE tardio (`candidate`, `sdpMid`, `sdpMLineIndex`). Reservado: o app espera a coleta terminar antes de oferecer. |
| `pc.rtc.close.v1` | API para agente | `sessionId` e `reason` opcional (`requested`, `replaced`, `revoked`, `rescoped`): fechar o canal da sessão e soltar o que o PC segurava. `rescoped`: a pessoa perdeu um dos escopos do canal (o do PC ou o da TV) sem perder o acesso todo, e o app abre outro já com o que ainda vale (só vai a quem declara `tv.rtc.v1`). `replaced`: uma oferta de outro aparelho tomou o lugar (o app que perdeu o canal não tenta de novo sozinho). `revoked`: a sessão, a senha, a conta ou a permissão da pessoa deixou de valer. Sem resposta. |
| `pc.rtc.closed.v1` | agente para API | `sessionId` e `reason` (`requested`, `connect_timeout`, `idle`, `failed`, `replaced`, `shutdown`, `disconnected`, `lifetime`: passou do teto de vida; `revoked`; `cloud`: chegou comando de entrada pela nuvem, e o canal fecha primeiro; `rescoped`): o canal da sessão fechou (a API grava a trilha), com `tvKeys` e `tvTexts` opcionais (só de um canal com o escopo `tv`): quantas teclas e textos da TV ele levou e a TV CONFIRMOU (o recusado, como o descartado pela revogação, não entra), que a API grava na trilha da TV no lugar de uma linha por tecla. Sem resposta. |
| `pc.rtc.reconcile.v1` | agente para API | Logo depois do `hello`, o canal direto que ficou aberto na queda da conexão (a API pode ter reiniciado e perdido o registro dele, e sem ele uma revogação não o acharia). `sessions` (um só, o agente tem um canal): `sessionId` e `ticket`, o bilhete que a API assinou na oferta. Nada mais é declarado pelo agente. A API só reinscreve a sessão se o bilhete é dela (HMAC), não venceu, é deste mesmo agente (o da conexão) e da mesma `sessionId`, e se a sessão de login que abriu o canal ainda existe e não foi revogada; depois reconfere as permissões pelas regras da oferta. O que continua valendo recebe `pc.rtc.reconciled.v1`; sem direito, com um escopo a menos ou com bilhete inválido recebe `pc.rtc.close.v1` (`revoked` ou `rescoped`). Só vai de um canal cuja oferta trouxe `ticket`, e a API só aceita de uma conexão que declarou `pc.rtc.reconcile.v1` (o agente só a declara depois de a API a listar em `features`). Sem resposta em 10 segundos o agente fecha o canal. |
| `pc.rtc.reconciled.v1` | API para agente | `sessionIds` (um): os canais que a API reconheceu e conferiu de novo; seguem abertos. Resposta a `pc.rtc.reconcile.v1`; sem resposta do agente. |
| `pc.screen.get.v1` | API para agente | Pedido de quadro no canal de dados WebRTC `screen` (`k: "s.get"`): `width` (128 a 1920, padrão 1280), `fps` (1 a 10, padrão 5), `marker` (0 a 65535, padrão 0), `reset` (booleano, padrão false) e `monitor` opcional (id de 0 a 2147483647; omitido é o monitor principal). O app emite um pedido por vez; o próximo só sai após a resposta (quadro ou `s.same`). |
| `pc.screen.mon.v1` | agente para API | Lista de monitores no canal de dados WebRTC `screen` (`k: "s.mon"`): `monitors` (1 a 16 itens com `id`, `primary`, `width`, `height`, `x` e `y` em pixels físicos do desktop virtual de -100000 a 100000; `left` e `top` aceitos na leitura como compatibilidade) e `layout` (impressão CRC-32 do arranjo inteiro, 0 a 4294967295, ou `null`). Sai antes do primeiro quadro e quando a lista muda. |
| `pc.screen.same.v1` | agente para API | Quadro inalterado no canal de dados WebRTC `screen` (`k: "s.same"`): `crc` (CRC-32 do quadro, 0 a 4294967295). Enviado quando o CRC-32 do recorte capturado é idêntico ao anterior e sem marca ativa. |
| `pc.screen.cur.v1` | agente para API | Posição física do cursor no desktop virtual no canal de dados WebRTC `screen` (`k: "s.cur"`): `x` e `y` (-100000 a 100000). Descartado quando o canal está ocupado com transmissão de imagem. |
| `pc.screen.state.v1` | agente para API | Estado do desktop no canal de dados WebRTC `screen` (`k: "s.state"`): `state` (`ok`, `locked` ou `elevated`). `locked` fecha o canal após drenar o envio. |
| `pc.screen.stat.v1` | agente para API | Estatísticas da captura no canal de dados WebRTC `screen` (`k: "s.stat"`): `bytes` (tamanho do quadro binário em bytes), `cpu` (porcentagem de CPU consumida, número ou `null`) e `privateMB` (pico de memória privada em MB). Enviado quando o pedido traz marca de medição (`marker` > 0). |

O canal direto (`pc.rtc.v1`) é um acelerador opcional: o app e o PC trocam o mesmo conjunto de comandos por um canal de dados WebRTC, sem passar pela API. Os pedidos de clique, tecla, texto e mídia pela nuvem levam um `seq` opcional, de um contador só e crescente, e uma `epoch` (16 hexadecimais sorteados quando a página abre) que diz de qual página ele vem: o app declara no canal direto a época e o último número que emitiu (`ce` e `cs`), e o agente trata como anterior à troca de caminho o pedido da nuvem com a mesma época e `seq` até esse número (época diferente ou ausente fecha o canal) (ele executa, mas não fecha o canal). O movimento da nuvem (que tem numeração própria) nunca fecha o canal. A API só repassa o `seq` a quem declara `pc.rtc.v1`. A capacidade só é declarada depois de a API listar `pc.rtc.v1` em `features`, e o agente só a declara se a biblioteca está instalada e a configuração `pc_direct` está ligada. Sem o canal, tudo segue pela nuvem.

Falhas voltam em `command.result.v1` com `error.code` estável: `unsupported` (sistema sem suporte), `unknown_app` (favorito
que não existe mais) e `failed` (o Windows recusou).
## TV Livre

Módulo opcional da Android TV e do Google TV (o launcher de `apps/tv-launcher`). O agente anuncia a capacidade
`tv.livre.v1`; sem ela (TV Samsung, ou agente antigo) a API não oferece o módulo e não manda nada destas mensagens.
Cada passo é um comando isolado, reversível e pedido pelo dono; nada roda sozinho.

`tv.livre.v2` é a capacidade dos acréscimos do módulo: o tempo no pedido de dormir, o nível do launcher e o `apply` que
não interrompe o que está na tela. O agente só a declara depois de a API a listar em `features` (o esquema de cada
mensagem é fechado, e uma API anterior recusaria o campo), e a API só manda e lê os campos novos de quem a declara; para
os demais ela tira `builtin.network`, `builtin.inputs` e `builtin.brand` da configuração. O launcher é tolerante: um app
antigo ignora o que não conhece, e o agente descobre o nível dele com `am broadcast ... .action.QUERY` (resposta
`level=N`; sem resposta, nível 1).

`tv.livre.notice.v1` é a capacidade do aviso ao dono num resultado que deu certo (`body.notice` do
`command.result.v1`). É separada de `tv.livre.v2` porque a API que já anuncia `tv.livre.v2` tem o resultado fechado sem
`notice` e recusaria o frame: o agente só a declara, e só manda o aviso, depois de a API a listar em `features`.

`tv.livre.sleep-no-install.v1` (mesmo rollout: só depois de a API a listar) diz que o agente honra `skipInstall` no
`sleep`: confere o launcher na hora e, ausente, recusa com `launcher_required` em vez de instalá-lo. A API manda o campo
no dormir de quem não é o dono, e só a agente que a declara; para os demais mantém só a leitura (`status`) antes.

| `type` | Direção | Corpo |
|---|---|---|
| `tv.livre.v1` | API para agente | `requestId` (UUID gerado pela API) e `action`: `status` (só lê), `install` (captura e ensaia o launcher de fábrica, baixa o APK, confere o hash e a assinatura contra o certificado fixado no agente e instala, conferindo que o app abriu; não o define como padrão), `set-home` (define como padrão e verifica; `disableFactory` opcional desativa o de fábrica depois da verificação), `restore` (Voltar ao Original: reabilita, define o original, verifica e só então desinstala; `uninstall` padrão sim), `apply` (grava a configuração: `configJson`, `revision` e `photoId` opcional), `set-apps` (`disable` e `enable`, `pm disable-user`, reversível, com lista de proteção) e `sleep` (Modo Dormir; `minutes`, de 0 a 720, é o tempo até a TV acordar sozinha, e só vai a agente que declara `tv.livre.v2`; `skipInstall` recusa em vez de instalar o launcher ausente, e só vai a agente que declara `tv.livre.sleep-no-install.v1`). |
| `tv.livre.photo.v1` | API para agente | Um pedaço da foto do fundo: `photoId`, `index` e `total` (até 16), `sha256` da foto inteira e `data` (base64, até 30 KB de bytes). O transporte recusa mensagem acima de 64 KB, por isso a foto vai em pedaços; o agente junta, confere tamanho, JPEG e hash e guarda até o `apply` que cita o `photoId`. |
| `tv.livre.state.v1` | agente para API | O estado depois de cada ação, **antes** do `command.result.v1` do mesmo comando (como o relatório da limpeza): `requestId` (o do pedido), `supported` (Android 9 ou mais com leanback), `installed`, `version`, `isHome`, `factoryLauncher`, `disabledPackages` e `apps` (`package`, `factory`, `disabled`). Com `tv.livre.v2`: `launcherLevel` (o nível do launcher lido na TV, que só cresce quando o app ganha algo que o site usa; um launcher sem a pergunta é o nível 1) e `applyDeferred` (o `apply` só gravou o arquivo porque outro app estava na frente da TV). Com `tv.livre.state.published_version` em `features` (entrada só da lista, sem capacidade no `hello`): `publishedVersion` (`x.y.z`, a versão do launcher publicado agora, com o app instalado; some quando o agente não consegue lê-la), que a tela compara com `version` para oferecer a atualização. |

O agente guarda em disco, antes de cada passo que muda a TV, o launcher de fábrica e o que ele desativou, para o
Voltar ao Original sobreviver a uma queda. Falhas voltam em `command.result.v1` com `error.code` estável
(`unsupported`, `not_installed`, `invalid_config`, `verify_failed`, `protected_package`, `launcher_not_running`, `apk_hash_mismatch`, `apk_signer_mismatch`, `signer_not_pinned` e os
`adb_*`). Um pedido que deu certo pode levar um aviso ao dono em `body.notice` do `command.result.v1` (só com `ok: true`; texto de 1 a 500 caracteres; por exemplo, o pacote da TV TCL restaurado depois do TV Livre): só vai à API que lista `tv.livre.notice.v1` em `features`, do agente que a declara no `hello`, e o `ok: false` continua com `error.message` e sem `notice`. O corpo de `configJson` segue `tv-launcher/config.v1.schema.json` (sem `schema`, `revision` nem o nome da foto,
que o agente acrescenta depois de conferir tudo: campo desconhecido recusa o pedido inteiro).

## Manutenção remota

Só o administrador, e só por agente: ver o registro e pedir ao agente que se atualize ou reinicie. As capacidades
`agent.logs.v1` e `agent.maintenance.v1` (no `agent.hello.v1`) dizem se o agente sabe fazer; sem elas a API não manda
o pedido e a tela diz para atualizar o agente. O `hello` também pode trazer `os` (sistema do PC) e `tv` (`kind` e `host`
da TV que ele controla) e `update` (o estado da auto-atualização, abaixo), todos opcionais.

Na passagem de uma versão do agente para outra o processo novo conecta antes de o antigo sair e diz, no `hello`, `instanceId` (UUID desta execução) e `handover: true`; o agente só envia esses campos depois de ver `agent.handover.v1` entre as funções que a API lista em `/info` (uma API antiga recusaria o `hello`, que é fechado). `handover: true` exige `instanceId` (o esquema o impõe e a API confere os dois). A conexão da versão nova se apresenta como CANDIDATA numa rota própria (`GET /api/v1/devices/agents/{agentId}/ws/handover`, e não um cabeçalho: uma API que ainda não conhece a passagem ignoraria o cabeçalho, trataria a candidata como conexão comum e substituiria a antiga com `4409`, enquanto a rota que ela não tem responde 404 e ninguém sai): até o primeiro quadro ela fica fora do roteamento e não fecha a antiga, que segue a atual e recebe os comandos. Só com um `agent.hello.v1` válido de passagem (`handover: true` e `instanceId`; um hello comum ou com `handover` falso de quem se disse candidata a descarta, sem tocar na antiga) a candidata é promovida (troca atômica), recebe antes de tudo a confirmação `agent.handover.accepted.v1` (com o `instanceId` e o id do hello; é por ela que o agente deixa de ser candidato, e sem ela toda reconexão dele volta como candidata, na rota da candidata) e a antiga recebe `4410` `handover` (encerra sem reconectar), em vez de `4409` `replaced` (o agente que recebe `replaced` espera e reconecta). O `4410` só vai à antiga que declarou a capacidade `agent.handover.v1` no `hello` (o agente só a declara depois de a API a listar em `features`, como as demais); sem ela a antiga sai com `4409`, que toda versão entende. Antes do `4410` a API espera (até `DrainWaitSeconds`) os comandos que a antiga recebeu responderem, e as respostas que ela ainda mandar valem; depois da confirmação o `hello` do agente deixa de trazer `handover` e `instanceId`. Se a candidata cair, ficar muda por poucos segundos, mandar outra coisa ou um hello com `handover` sem `instanceId` válido, é descartada e a antiga não é fechada. Uma conexão comum (rota `.../ws`: reconexão, inclusive depois de um `4411`) substitui a anterior na hora, com `4409`.

| `type` | Direção | Corpo |
|---|---|---|
| `agent.logs.request.v1` | API para agente | `requestId` (UUID gerado pela API) e `lines` (1 a 1000). Nunca leva caminho: o agente lê só o próprio arquivo de registro. |
| `agent.logs.v1` | agente para API | `requestId` (o do pedido), `text` (até 49152 caracteres, já sem tokens, `Authorization`, códigos de pareamento e senhas), `lines`, `truncated` (o agente tirou linhas antigas para caber) e `at`. |
| `agent.maintenance.v1` | API para agente | `action`: `update` (o supervisor roda a auto-atualização agora; o agente só reinicia se houver versão nova) `restart` (o supervisor reinicia o agente) ou `rollback` (o supervisor volta para a versão anterior guardada em `app.previous`, bloqueia a que sai e reinicia; o agente recusa com `no_previous_version` se não houver). |
| `agent.update.status.v1` | agente para API | O estado da auto-atualização, o mesmo objeto de `update` no `hello`: `outcome` (`not_checked`, `updating`, `updated`, `up_to_date`, `failed`, `blocked` ou `rolled_back`), `installedSha` e `installedAt` (a versão instalada), `latestSha` (o commit mais novo que a última checagem viu), `checkedAt`, `nextCheckAt`, `reason` (curto, já sem segredos, até 200 caracteres), `blockedSha` (versão que caiu repetidamente) e `rolledBack` (houve volta à versão anterior). Só `outcome` é obrigatório. O agente manda quando a checagem roda; agente antigo não manda nada e a tela diz "versão desconhecida". |

## Diagnóstico do agente

O agente guarda num arquivo local (limitado, sem duplicar) os erros e as ocorrências dele mesmo (queda do processo, tarefa de fundo que falhou, reparo feito, atualização recusada) e os envia depois do `hello`. A capacidade `agent.diagnostics.v1` diz que ele sabe. O texto já chega sem caminhos, endereços, nomes de usuário e segredos; a API guarda por pouco tempo e só o administrador vê, em Sistema.

| `type` | Direção | Corpo |
|---|---|---|
| `agent.diagnostics.v1` | agente para API | `events` (1 a 20, na ordem em que aconteceram): `id` (UUID, a API ignora repetidos), `at`, `kind` (`a-z`, `0-9`, `_` e `.`, até 48), `severity` (`info`, `warn`, `error`), `component` opcional (até 32), `detail` (1 a 300 caracteres, já sem dados pessoais) e `count` opcional (quantas vezes a mesma ocorrência se repetiu antes do envio). Sem resposta: o agente apaga o que enviou. O agente só declara a capacidade e envia depois de `GET /api/v1/devices/info` listar `agent.diagnostics.v1` em `features`. |

Como na limpeza da TV, `agent.logs.v1` sai **antes** do `command.result.v1` do mesmo comando. `agent.maintenance.v1` só é
respondido com `command.result.v1`, assim que o pedido foi entregue ao supervisor do Windows (o mesmo mecanismo do menu da
bandeja). O agente reinicia por conta do supervisor, nunca por um código de saída do próprio processo.

As teclas opcionais que a TV de fato tem são declaradas no `agent.hello.v1` como `tv.key.<TECLA>` (por exemplo `tv.key.INPUT`,
`tv.key.GUIDE`): é essa lista que o app usa para oferecer os botões extras, e uma TV sem a capacidade não os mostra.

O transporte recusa mensagens acima de 64 KB. Por isso o agente pode mandar a mesma lista de `tv.apps.v2` mais de uma vez, cada mensagem
levando só parte dos ícones.

Os resultados voltam em `command.result.v1` (com `correlationId` igual ao `id` do comando). Nenhum corpo traz segredo.

A limpeza da TV é o único comando cujo resultado carrega dados: o agente manda `tv.cleanup.result.v1` **antes** do
`command.result.v1` do mesmo comando (a API trata os quadros de um agente em ordem) e o `requestId` é o que liga os dois,
porque a API não conhece o `id` do envelope que ela mesma monta. Se o ADB não responde, só sai `command.result.v1`
com `ok: false`.
O formato do `type` aceita dois ou mais segmentos antes da versão (`tv.app.launch.v1`). Os esquemas só fixam o
formato; quem decide o que pode ser aberto (por exemplo, quais esquemas de link) é o agente.

## Como validar

```
npm ci
npm run validate
```

## Configuração do launcher da TV

`tv-launcher/config.v1.schema.json` descreve o `config.json` que o agente grava na TV e que o APK de
`apps/tv-launcher` lê (relógio, papel de parede, apps visíveis e ordem, ícones, Modo Dormir). Não é uma mensagem
do envelope: vive à parte, sem tipos gerados, e o `npm run validate` confere os exemplos de
`tv-launcher/examples/valid` (todos passam) e `examples/invalid` (todos falham). O launcher lê os mesmos exemplos nos
seus testes.

- Versão no próprio arquivo (`"schema": 1`). Mudança incompatível cria `config.v2.schema.json`; o launcher ignora um
  arquivo de versão que não conhece e segue com o que já tinha.
- O esquema é estrito para quem escreve (campo desconhecido é erro). O launcher é tolerante ao ler: ignora campo
  desconhecido e volta ao padrão num valor inválido, para uma home nunca cair por causa de um arquivo mal escrito.
- `revision` cresce a cada escrita; com duas vias de entrega (arquivo e broadcast), vale a maior.

## Geração

`contracts/` é a fonte de verdade: tudo que as três linguagens usam sai daqui, nunca é editado à mão e leva no
topo o cabeçalho "GERADO por `npm --prefix contracts run generate` — não editar".

```
npm --prefix contracts ci
npm --prefix contracts run generate   # valida, gera e grava os arquivos
npm --prefix contracts run check      # gera numa pasta temporária e falha se algo versionado divergir
```

O que o `generate` produz, nesta ordem:

| Alvo | Saída | Ferramenta (versão fixa) |
|---|---|---|
| OpenAPI | `contracts/http/openapi.json` | teste de integração `OpenApiContractTests` (sobe o Host em Development, sem banco; chaves ordenadas, sem servidores, `info.version` fixa) |
| C# | `apps/api/src/UniOver.BuildingBlocks.AgentProtocol/Generated/` | `quicktype` 26.0.0 (SystemTextJson), um arquivo por `type`, mais `AgentMessageTypes` |
| Python | `apps/agent/src/uniover_agent/contracts/` (modelos pydantic, `registry.py`, cópia dos esquemas em `schemas/`) | `datamodel-code-generator` 0.86.0 via `uvx` |
| TypeScript (HTTP) | `apps/web/src/app/core/api/generated/schema.ts` | `openapi-typescript` 7.13.0 |
| TypeScript (mensagens) | `apps/web/src/app/core/api/generated/agent/*.ts` | `json-schema-to-typescript` 16.0.0 |

Regras de uso:

- Mudou um esquema em `agent/` ou um endpoint da API? Rode o `generate` e inclua os arquivos gerados no mesmo commit.
  O `check` roda na esteira (`contracts-sync`) e reprova qualquer diferença, inclusive arquivo que sobrou sem fonte.
- Os esquemas ficam embutidos no assembly `UniOver.BuildingBlocks.AgentProtocol`; o `AgentEnvelopeValidator`
  (JsonSchema.Net) valida por eles. Os modelos pydantic não reproduzem `if/then/else` do JSON Schema: a validação
  completa no agente é a do `jsonschema` sobre `contracts/schemas/`.
- Precisa do .NET (versão do `apps/api/global.json`), Node 24 e `uv`.

### TV pelo canal direto (`tv.rtc.v1`)

O canal direto também leva as **teclas e o texto da TV** que o agente controla, quando a oferta traz o escopo `tv`. O app manda os mesmos `tv.key.v2`, `tv.key.v3` e `tv.text.v1` da nuvem (`{ k: "cmd", t, b }`), o agente os valida pelo mesmo portão de esquema e os entrega ao MESMO caminho das teclas da nuvem (sessão da TV, descarte por idade, junção de repetições): nada de caminho paralelo. A tecla `POWER`, o desligamento, abrir app, limpar e as demais ações da TV continuam só pela nuvem, onde a API confere a permissão de cada uma e grava a trilha. A API só concede o escopo `tv` a quem pode controlar aquela TV (`tv:control` e a TV entre as dela) no instante da oferta, só a agente que declara `tv.rtc.v1`, e fecha o canal (`revoked`) ou o reabre com o que sobrou (`rescoped`) quando a permissão ou a filiação à TV mudam. Um canal com o escopo `tv` e sem o `pc` nunca recebe o ponteiro nem comando `pc.*`, e não pede a aprovação do aparelho no PC. O agente só declara `tv.rtc.v1` depois de a API listá-la em `features`, e só se o canal direto do PC existe neste agente. Sem o canal, a TV segue pela nuvem.

### Reconciliar o canal depois de a API reiniciar (`pc.rtc.reconcile.v1`)

O registro das sessões do canal direto fica em memória na API. Se ela reinicia com um canal aberto, o agente o segue segurando (até 30 s sem API, e depois que ela volta, até a vida máxima), mas uma revogação não o acharia. Por isso a API **assina**, na oferta, um bilhete (`ticket`: HMAC-SHA256 sobre a sessão, quem abriu, a sessão de login, o aparelho, os escopos, a TV, o agente, a emissão e o fim da vida máxima do canal), com uma chave derivada (HKDF, contexto próprio) da chave de assinatura do JWT que ela já tem: nenhum segredo novo. O agente só o guarda. Ao reconectar, o agente que declara `pc.rtc.reconcile.v1` manda `pc.rtc.reconcile.v1` com `sessionId` e `ticket`, e **nada do que ele declare é confiado**. A API só reconstrói a sessão (com o mesmo id) se o bilhete tem a assinatura dela e não venceu, é do mesmo `agentSlug` da conexão autenticada e da mesma `sessionId`, e se a sessão de login do bilhete ainda existe e não foi revogada (sair, "sair de todos", senha trocada, reutilização do token); depois reconfere pelas regras da oferta (`module:pc` e o computador da própria pessoa para o `pc`; a TV que o módulo TV diz que ela controla, e que é deste agente, para o `tv`; e o aparelho não recusado no PC) e, imediatamente antes de confirmar, que a sessão continua no registro e sem revogação pendente. As lápides em memória (sessões que a API já fechou) e a regra de que outra sessão viva no PC vence são só reforço. Tudo de pé: `pc.rtc.reconciled.v1`. Perdeu um escopo: `pc.rtc.close.v1` com `rescoped` (o app abre outro com o que sobrou). Perdeu tudo, ou bilhete inválido: `revoked`. O agente fecha o canal se a confirmação não vem em 10 s (`pc_direct_reconcile_seconds`), e um canal aberto sem bilhete (de antes da capacidade, ou de uma sessão sem sessão de login) não pode ser reconhecido e é reaberto pelo app (`rescoped`). Os dois lados são protegidos por capacidade: o agente só a declara depois de a API a listar em `features`, a oferta só leva o `ticket` a quem a declara, e a API ignora (e registra) um reconcile de uma conexão que não a declarou.

### Protocolo do canal da tela do PC (WebRTC `screen` e cabeçalho binário `UOSF`)

A exibição remota da tela do PC opera via canal direto WebRTC exclusivo com label `"screen"`, configurado como ordenado e confiável (`ordered: true`, sem limite de tempo de vida de pacote ou de retransmissões). O canal transporta mensagens de controle e medição em JSON e os quadros comprimidos em formato binário.

#### Mensagens do canal
- A primeira mensagem do cliente deve ser `{"k": "auth", "token": "..."}`, apresentando o bilhete de uso único emitido na oferta; conexões fora da rede local (LAN) ou com token inválido/expirado são encerradas imediatamente.
- `s.get` (`pc.screen.get.v1`): o cliente pede um quadro por vez; o próximo só sai após a resposta (quadro JPEG ou `s.same`). Limites: `width` (128 a 1920 pixels físicos, padrão 1280), `fps` (1 a 10 quadros/s, padrão 5), `marker` (0 a 65535, padrão 0), `monitor` (0 a 2147483647; omitido é o monitor principal) e `reset` (booleano, padrão false, força envio sem CRC e zera contadores).
- `s.mon` (`pc.screen.mon.v1`): lista de 1 a 16 monitores anunciada antes do primeiro quadro e relida a cada 30 quadros ou quando um monitor pedido não é encontrado. Cada monitor declara `id` (0 a 2147483647), `primary` (booleano), `width` e `height` (1 a 100.000), `x` e `y` (-100.000 a 100.000, coordenadas físicas da origem no desktop virtual; `left` e `top` aceitos como fallback). `layout` é o CRC-32 do arranjo inteiro (0 a 4294967295) ou `null`.
- `s.same` (`pc.screen.same.v1`): resposta a `s.get` quando o CRC-32 do recorte atual (com semente de dimensões) coincide com o anterior e `marker == 0` e `reset == false`. Traz `crc` (0 a 4294967295).
- `s.cur` (`pc.screen.cur.v1`): posição física do cursor (`x`, `y` entre -100.000 e 100.000). Enviado a cada 1/30 s apenas quando o cursor se move e o buffer do canal tem até 64 KiB (`4 * CHUNK_BYTES`), descartando posições intermediárias quando a rede está ocupada com quadros.
- `s.state` (`pc.screen.state.v1`): estado do desktop (`ok`, `locked`, `elevated`), verificado a cada 0,25 s. Na transição para `locked`, o aviso é enviado, o buffer do canal é drenado por até 1 segundo e o canal é fechado.
- `s.stat` (`pc.screen.stat.v1`): métricas de custo (`bytes`, `cpu` em % ou `null`, `privateMB` da memória privada do processo), enviado a cada quadro quando `marker != 0`.

#### Cabeçalho binário `UOSF`
Quadros de tela são transmitidos em mensagens binárias pelo mesmo canal `"screen"`. Cada quadro inicia com um cabeçalho fixo de 16 bytes em ordem big-endian (`>4sBBHHHI`), imediatamente seguido pelo payload da imagem em JPEG:

| Offset | Tamanho | Campo | Tipo | Descrição e Limites |
|---|---|---|---|---|
| 0 | 4 bytes | `magic` | `4s` | Marca mágica ASCII fixa `UOSF` (`0x554f5346`). Mensagens binárias sem essa marca inicial são rejeitadas. |
| 4 | 1 byte | `version` | `uint8` | Versão do protocolo de quadro, fixada em `1`. Versões diferentes são rejeitadas. |
| 5 | 1 byte | `flags` | `uint8` | Flags reservadas para expansões futuras (fixado em `0`). |
| 6 | 2 bytes | `width` | `uint16` | Largura da imagem do quadro em pixels físicos (1 a 16.384; no agente limitada a `width` do `s.get`, máx 1920). |
| 8 | 2 bytes | `height` | `uint16` | Altura da imagem do quadro em pixels físicos (1 a 16.384). |
| 10 | 2 bytes | `sequence` | `uint16` | Número sequencial monotônico do quadro emitido pelo agente (`sequence & 0xFFFF`, 0 a 65535). |
| 12 | 4 bytes | `size` | `uint32` | Tamanho exato em bytes do payload JPEG comprimido (1 a 8.388.608 bytes / 8 MiB). |

- **Fragmentação em pedaços (chunks):** O payload completo (cabeçalho de 16 bytes + `size` bytes do JPEG) é particionado em mensagens de até 16 KiB (`CHUNK_BYTES = 16.384`).
- **Montagem no receptor:** O cliente (`ScreenViewerFrameAssembler`) lê os 16 bytes da primeira mensagem para obter as dimensões, sequência e tamanho total, acumula os pedaços seguintes até somar `size` bytes e devolve o quadro completo para decodificação e exibição. Imagens puras sem o cabeçalho `UOSF`, com tamanho superior a 8 MiB ou com pedaços que ultrapassem `size` são rejeitadas.
