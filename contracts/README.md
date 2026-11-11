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

`agent.keepalive.v1` e `api.keepalive.v1` são batimentos sem corpo, a cada 25 segundos, para atravessar proxies
que descartam conexões WebSocket ociosas. O agente anuncia a capacidade `transport.keepalive.v1`; enquanto ela não
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
| `tv.state.v1` | agente para API | `power`, `volume`, `app` e `connection`. `adbPermission` é opcional (`granted`: a TV aceitou o UniOver no ADB; `missing`: o agente não consegue usar o ADB sem a pessoa pedir pelo app, e o motivo vai ao diagnóstico `adb.permission.*`; `pending`: o aviso do ADB está na tela da TV esperando o aceite) e some enquanto o ADB não disse nada. `adbPermissionReason` (opcional, só com `missing`; texto curto `[a-z_]`) diz por que falta: `tv_forgot` é a TV que recusou uma chave que já tinha aceitado, e só ele abre a folha de pedido sozinha no app. O agente só os envia depois de a API listar `tv.state.adb_permission` em `features` (uma API anterior recusaria o campo). |
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
padrão). Todas descem da API para o agente e voltam em `command.result.v1`, exceto `pc.apps.v1` e `pc.volume.state.v1`, que sobem, e `pc.pointer.v1`, que o agente executa sem responder (a API manda o movimento do mouse sem esperar resposta; uma resposta por movimento só encheria o canal). As listas de
teclas e de ações são fechadas: nada fora delas chega ao Windows, e o corpo nunca leva caminho de programa.

| `type` | Direção | Corpo |
|---|---|---|
| `pc.pointer.v1` | API para agente | `dx`, `dy` (pixels relativos, -2000 a 2000) e `scrollX`/`scrollY` opcionais (unidades de roda: 120 é um clique da roda, -1200 a 1200; sinal do Windows, positivo é direita e cima). O app soma os toques do dedo antes de mandar e o agente limita cada valor. |
| `pc.pointer.zoom.v1` | API para agente | `steps` (-12 a 12, nunca 0): zoom pela roda do mouse com o Ctrl apertado, o que a pinça do app manda. Positivo aproxima (roda para cima), negativo afasta. O agente aperta o Ctrl, gira a roda `|steps|` vezes e solta o Ctrl num lote só do sistema: o Ctrl nunca fica preso (lote aceito em parte, queda do canal direto e queda da conexão com a API o soltam); se um `pc.key.v2` `DOWN` já o segura, ele não é apertado de novo nem solto. `seq` e `epoch` como nas outras entradas da nuvem. Valida no canal direto como as demais entradas (mesma idade, taxa e fila). A API só a usa para o agente que declarou a capacidade `pc.pointer.zoom.v1` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.volume.v1` | API para agente | Volume absoluto: `level` (0 a 100, o volume principal do dispositivo de saída padrão em porcentagem) e/ou `muted` (liga ou desliga o mudo, sem alternar); pelo menos um dos dois, e juntos o nível entra antes do mudo. Mudar o nível não desliga o mudo. `seq` e `epoch` como nas outras entradas da nuvem; no canal direto vale a mesma validação, idade e taxa. A API só a usa para o agente que declarou a capacidade `pc.volume.v1` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. As teclas relativas de `pc.media.v1` seguem valendo. |
| `pc.volume.state.v1` | agente para API | `level` (0 a 100), `muted` e `at`: o volume de agora. O agente só o manda a uma API que listou `pc.volume.v1` em `features` (uma anterior recusaria o tipo): na conexão, quando a API passa a listá-lo, depois de executar `pc.volume.v1` e as teclas de volume e mudo de `pc.media.v1`, e quando uma leitura periódica mostra que o volume mudou por fora (o teclado do próprio PC). A API o guarda em memória e o devolve em `GET /api/v1/pc/status` (`volume`, nulo enquanto não houver leitura ou com o PC desconectado). Sem resposta. |
| `pc.device.state.v1` | agente para API | `deviceId`, `state` (`pending`, `denied`, `approved`) e `at`: a decisão do dono do PC sobre um aparelho do app. A API guarda `pending` e `denied` por agente e aparelho, com validade curta, e responde 403 `pc-device-pending` / `pc-device-denied` também ao movimento do mouse (que o agente descarta sem resposta); `approved` limpa. Só vai a uma API que listou `pc.device.v1` em `features`. Sem resposta. |
| `pc.click.v1` | API para agente | `button` (`LEFT`, `RIGHT`, `MIDDLE`) e `action` opcional (`CLICK`, padrão, `DOUBLE`, `DOWN`, `UP`; os dois últimos são o arrastar). |
| `pc.click.v2` | API para agente | O `pc.click.v1` com `modifiers` opcionais (`CTRL`, `ALT`, `SHIFT`, sem repetir e sem `WIN`, que ao ser solto depois do clique abriria o menu Iniciar: apertados, o clique, soltos na ordem inversa, num lote só) e `gapMs` opcional (0 a 400): o intervalo, medido no aparelho, desde o toque anterior; o agente espera o que faltar desde o último clique que executou para reproduzir esse intervalo (nunca mais que `gapMs`; se o pedido chegou mais tarde, executa na hora) e assim o Windows reconhece o duplo clique mesmo com a rede irregular. `action` só `CLICK` (padrão) ou `DOUBLE`: apertar e soltar o botão (o arrastar) segue no `v1` e nunca leva modificador. A API só a usa quando o pedido leva modificador ou `gapMs` e só para o agente que declarou a capacidade `pc.click.v2` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.key.v1` | API para agente | `key` (Enter, Backspace, Delete, Tab, Escape, Space, setas, Home, End, PageUp/PageDown, `F1` a `F12`, `A` a `Z`) e `modifiers` opcionais (`CTRL`, `ALT`, `SHIFT`, `WIN`, sem repetir). |
| `pc.key.v2` | API para agente | As teclas do `v1` mais os dígitos `D0` a `D9` (a fileira de cima, não o teclado numérico), `MINUS`, `EQUALS`, `COMMA`, `PERIOD` (as quatro pontuações só estáveis nos layouts americano e ABNT2: em outros layouts o caractere pode mudar; o resto da pontuação sai pelo `pc.text`), `INSERT`, `PRINT_SCREEN`, `APPS` (tecla de menu), `WIN` (sozinha), `CAPS_LOCK` e os modificadores como tecla (`CTRL`, `ALT`, `SHIFT`). `modifiers` como no `v1`. `repeat` opcional (1 a 50): aperta e solta a tecla essa quantidade de vezes num lote só, com os modificadores valendo para todas. `action` opcional (`PRESS`, padrão, `DOWN`, `UP`): `DOWN` e `UP` só aceitam `CTRL`, `ALT`, `SHIFT` ou `WIN` como `key`, sem `modifiers` nem `repeat`, e seguram e soltam o modificador entre toques (o Alt do Alt+Tab). O agente guarda o que ficou apertado e o solta ao desconectar, ao encerrar e depois de 30 s sem nenhum comando `pc.*`; um `UP` atrasado nunca é recusado por idade. A API só a usa quando o pedido não cabe no `v1` (tecla nova, repetição ou segurar) e só para o agente que declarou a capacidade `pc.key.v2` (e só depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.text.v1` | API para agente | `text`: 1 a 200 caracteres, sem caracteres de controle; digitado como Unicode, então acentos e símbolos funcionam em qualquer layout. |
| `pc.text.v2` | API para agente | Editar o campo em foco numa mensagem só: `erase` (1 a 200: Backspaces), `text` (1 a 200 caracteres, sem controle) e `key` (`ENTER` ou `TAB`, a tecla apertada no fim), executados nesta ordem no mesmo toque no sistema; pelo menos um dos três. É o que a digitação ao vivo manda (a diferença do campo num pedido só). Cada Backspace e o `key` contam no mesmo limite de teclas do `pc.key.v2`. A API só a usa quando o pedido leva `erase` ou `key` e só para o agente que declarou a capacidade `pc.text.v2` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. |
| `pc.media.v1` | API para agente | `action` (`PLAY_PAUSE`, `NEXT`, `PREVIOUS`, `STOP`, `VOLUME_UP`, `VOLUME_DOWN`, `MUTE`) e `steps` opcional (1 a 10, só para o volume). |
| `pc.power.v1` | API para agente | `action`: `LOCK`, `SLEEP`, `SHUTDOWN` (contagem do Windows, com o aviso na tela do PC) ou `CANCEL_SHUTDOWN`. A confirmação com a pessoa é do app e da API. |
| `pc.app.launch.v1` | API para agente | `appId`: o identificador de um favorito que o próprio agente publicou. |
| `pc.apps.v1` | agente para API | `apps`: lista de `{ id, label }` (até 24) dos favoritos configurados no PC, e `at`. A lista é sempre completa; o agente a manda logo depois do `hello`. |
| `pc.rtc.offer.v1` | API para agente | `sessionId`, `sdp` (a oferta WebRTC do app, até 16 KB) e `token` (uso único, que a primeira mensagem do canal precisa apresentar) `tokenTtlSeconds` (a vida dele, contada pelo agente a partir do recebimento) e `maxLifetimeSeconds` (30 a 3600: o teto da vida do canal inteiro; a API o tira do que resta do token de acesso, então o canal nunca vive mais que a sessão que o autorizou, e o app abre outro antes do fim). Só vai a quem declara `pc.rtc.v1`, e a API só a envia ao agente do próprio dono do PC. Responde com `pc.rtc.answer.v1` (mesmo `correlationId`) e `command.result.v1`. |
| `pc.rtc.answer.v1` | agente para API | `sessionId` e `sdp` (a resposta, com a impressão digital DTLS do agente). A API a devolve ao app pela rota autenticada e não a guarda. |
| `pc.rtc.candidate.v1` | API para agente | `sessionId` e um candidato ICE tardio (`candidate`, `sdpMid`, `sdpMLineIndex`). Reservado: o app espera a coleta terminar antes de oferecer. |
| `pc.rtc.close.v1` | API para agente | `sessionId` e `reason` opcional (`requested`, `replaced`, `revoked`): fechar o canal da sessão e soltar o que o PC segurava. `replaced`: uma oferta de outro aparelho tomou o lugar (o app que perdeu o canal não tenta de novo sozinho). `revoked`: a sessão, a senha, a conta ou a permissão da pessoa deixou de valer. Sem resposta. |
| `pc.rtc.closed.v1` | agente para API | `sessionId` e `reason` (`requested`, `connect_timeout`, `idle`, `failed`, `replaced`, `shutdown`, `disconnected`, `lifetime`: passou do teto de vida; `revoked`; `cloud`: chegou comando de entrada pela nuvem, e o canal fecha primeiro): o canal da sessão fechou (a API grava a trilha). Sem resposta. |

O canal direto (`pc.rtc.v1`) é um acelerador opcional: o app e o PC trocam o mesmo conjunto de comandos por um canal de dados WebRTC, sem passar pela API. Os pedidos de clique, tecla, texto e mídia pela nuvem levam um `seq` opcional, de um contador só e crescente, e uma `epoch` (16 hexadecimais sorteados quando a página abre) que diz de qual página ele vem: o app declara no canal direto a época e o último número que emitiu (`ce` e `cs`), e o agente trata como anterior à troca de caminho o pedido da nuvem com a mesma época e `seq` até esse número (época diferente ou ausente fecha o canal) (ele executa, mas não fecha o canal). O movimento da nuvem (que tem numeração própria) nunca fecha o canal. A API só repassa o `seq` a quem declara `pc.rtc.v1`. A capacidade só é declarada depois de a API listar `pc.rtc.v1` em `features`, e o agente só a declara se a biblioteca está instalada e a configuração `pc_direct` está ligada. Sem o canal, tudo segue pela nuvem.

Falhas voltam em `command.result.v1` com `error.code` estável: `unsupported` (sistema sem suporte), `unknown_app` (favorito
que não existe mais) e `failed` (o Windows recusou).
## TV Livre

Módulo opcional da Android TV e do Google TV (o launcher de `apps/tv-launcher`). O agente anuncia a capacidade
`tv.livre.v1`; sem ela (TV Samsung, ou agente antigo) a API não oferece o módulo e não manda nada destas mensagens.
Cada passo é um comando isolado, reversível e pedido pelo dono; nada roda sozinho.

| `type` | Direção | Corpo |
|---|---|---|
| `tv.livre.v1` | API para agente | `requestId` (UUID gerado pela API) e `action`: `status` (só lê), `install` (captura e ensaia o launcher de fábrica, baixa o APK, confere o hash e a assinatura contra o certificado fixado no agente e instala, conferindo que o app abriu; não o define como padrão), `set-home` (define como padrão e verifica; `disableFactory` opcional desativa o de fábrica depois da verificação), `restore` (Voltar ao Original: reabilita, define o original, verifica e só então desinstala; `uninstall` padrão sim), `apply` (grava a configuração: `configJson`, `revision` e `photoId` opcional), `set-apps` (`disable` e `enable`, `pm disable-user`, reversível, com lista de proteção) e `sleep` (Modo Dormir). |
| `tv.livre.photo.v1` | API para agente | Um pedaço da foto do fundo: `photoId`, `index` e `total` (até 16), `sha256` da foto inteira e `data` (base64, até 30 KB de bytes). O transporte recusa mensagem acima de 64 KB, por isso a foto vai em pedaços; o agente junta, confere tamanho, JPEG e hash e guarda até o `apply` que cita o `photoId`. |
| `tv.livre.state.v1` | agente para API | O estado depois de cada ação, **antes** do `command.result.v1` do mesmo comando (como o relatório da limpeza): `requestId` (o do pedido), `supported` (Android 9 ou mais com leanback), `installed`, `version`, `isHome`, `factoryLauncher`, `disabledPackages` e `apps` (`package`, `factory`, `disabled`). |

O agente guarda em disco, antes de cada passo que muda a TV, o launcher de fábrica e o que ele desativou, para o
Voltar ao Original sobreviver a uma queda. Falhas voltam em `command.result.v1` com `error.code` estável
(`unsupported`, `not_installed`, `invalid_config`, `verify_failed`, `protected_package`, `launcher_not_running`, `apk_hash_mismatch`, `apk_signer_mismatch`, `signer_not_pinned` e os
`adb_*`). O corpo de `configJson` segue `tv-launcher/config.v1.schema.json` (sem `schema`, `revision` nem o nome da foto,
que o agente acrescenta depois de conferir tudo: campo desconhecido recusa o pedido inteiro).

## Manutenção remota

Só o administrador, e só por agente: ver o registro e pedir ao agente que se atualize ou reinicie. As capacidades
`agent.logs.v1` e `agent.maintenance.v1` (no `agent.hello.v1`) dizem se o agente sabe fazer; sem elas a API não manda
o pedido e a tela diz para atualizar o agente. O `hello` também pode trazer `os` (sistema do PC) e `tv` (`kind` e `host`
da TV que ele controla) e `update` (o estado da auto-atualização, abaixo), todos opcionais.

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
