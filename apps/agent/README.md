# uniover-agent

Agente local do UniOver (Python 3.14). Roda no PC como processo do usuário e **disca para fora**, para a API:
nunca abre porta.

## Comandos

```
uv sync
uv run uniover-agent pair      # pareia este PC com um código curto
uv run uniover-agent run       # conecta e roda em primeiro plano (é o padrão)
uv run uniover-agent status    # diz se há token no cofre e se a API responde
uv run uniover-agent tv-pair --host <ip-da-tv>   # pareia uma Android TV (código mostrado na tela)
uv run uniover-agent tv-pair --kind samsung --host <ip-da-tv>   # pareia uma Samsung (aviso na TV)
uv run uniover-agent tv-find   # acha a TV na rede e grava tipo, endereço e identificador no agent.toml
uv run uniover-agent self-update   # troca o agente instalado pela versão atual do canal (develop; se mudou)
uv run uniover-agent diagnose      # confere a saúde deste PC (pasta, início automático, API, TV); --repair aplica os reparos seguros
```

Verificação do projeto:

```
uv run ruff check
uv run ruff format --check
uv run mypy src tests
uv run lint-imports
uv run pytest
```

## Pareamento

1. `uniover-agent pair` pede um código à API, **mostra** `XXXX-XXXX`, um **QR** do link
   `<api>/ajustes/dispositivos?codigo=XXXX-XXXX` (o app abre a aprovação já preenchida) e o endereço do app, e
   consulta até o dono aprovar (respeitando o intervalo e o `slow_down`) ou o código vencer. O QR é desenhado com
   meios-blocos (módulos claros preenchidos, para o terminal escuro) e cai para ASCII se o console não escreve
   blocos. `--if-needed` não pareia de novo um PC já pareado.
2. Aprovado, o **token de dispositivo** vai para o **Cofre de Credenciais do Windows** (serviço `uniover-agent`,
   nome = `agentId`) e o `agentId` para a configuração local. Nenhum dos dois vai para o repositório.
3. `uniover-agent run` lê o token do cofre a cada conexão e o envia só no cabeçalho `Authorization` do *upgrade*.
   Nunca em URL, log, argumento de linha de comando ou variável de ambiente.

Cada PC é um agente separado (um pareamento e um `agentId` por PC). Em Linux/macOS (desenvolvimento) usa o
cofre que o `keyring` achar e **recusa** um backend em texto claro (`keyrings.alt`).

Com a API dormindo (Render grátis), acordar leva de 1 a mais de 4 minutos: o pareamento e a conexão esperam e
tentam de novo, sem desistir.

## Configuração

Variáveis de ambiente (vencem o arquivo):

| Variável | Para quê |
|---|---|
| `UNIOVER_API_URL` | endereço da API; precisa ser `https://` |
| `UNIOVER_AGENT_ID` | `agentId` deste PC (o `pair` grava no arquivo) |
| `UNIOVER_LOG_LEVEL` | `DEBUG`, `INFO` (padrão), `WARNING` ou `ERROR` |
| `UNIOVER_ALLOW_INSECURE` | `1` libera `http://`/`ws://` para a API local em desenvolvimento (com aviso) |
| `UNIOVER_CONFIG_FILE` | outro caminho para o arquivo de configuração |
| `UNIOVER_TV_HOST` | endereço (IP) da TV; sem ele o agente não controla TV. O IP não é garantidamente fixo |
| `UNIOVER_TV_KIND` | tipo da TV: `android` (padrão) ou `samsung` |
| `UNIOVER_TV_ID_HINT` | identificador estável da TV (Samsung: `duid` ou MAC Wi-Fi; Android: MAC); o `tv-find` grava e o agente usa para reencontrar a TV se o IP mudar |
| `UNIOVER_LOG_FILE` | também registra neste arquivo (rodízio de 1 MB, 2 cópias); o instalador usa `%LOCALAPPDATA%\UniOver\logs\agent.log` |
| `UNIOVER_TV_CLIENT_NAME` | nome do agente que aparece na TV no pareamento (padrão `UniOver`) |
| `UNIOVER_TV_NAME` | nome da pasta do certificado desta TV (padrão `tv`) |
| `UNIOVER_TV_SAMSUNG_APPS` | IDs Tizen extras a procurar, separados por vírgula (no máximo 32); a TV só publica os instalados |
| `UNIOVER_TV_SAMSUNG_MAINTENANCE_IDLE_SECONDS` | ociosidade antes da manutenção automática da Samsung (padrão 900, de 60 a 3600) |
| `UNIOVER_TV_HIBERNATE_SECONDS` | segundos sem comando até a sessão com a TV hibernar (padrão `300`) |
| `UNIOVER_TV_POWER_OFF_READ_TIMEOUT_SECONDS` | quanto o desligar com leitura espera a TV informar se está ligada, antes de apertar `POWER` (padrão `2`) |
| `UNIOVER_TV_POWER_OFF_CONFIRMATION_TIMEOUT_SECONDS` | quanto espera a confirmação depois da tecla (padrão `5`); sem ela o resultado é `uncertain` e a tecla não é repetida |
| `UNIOVER_ADB_PATH` | caminho do `adb` (padrão: procura no `PATH` e em `%LOCALAPPDATA%\Android\Sdk\platform-tools`); habilita lista de apps, abrir app por pacote e digitação pelo ADB |
| `UNIOVER_TV_WATCHDOG` | `0` desliga o vigia do serviço do controle (padrão: ligado; só age com o `adb` neste PC; ver "Vigia do serviço do controle") |
| `UNIOVER_TV_ADB_PORT` | porta do ADB da TV (padrão `5555`) |
| `UNIOVER_ADB_TIMEOUT_SECONDS` | tempo máximo de cada comando `adb` (padrão `5`) |
| `UNIOVER_ADB_PULL_TIMEOUT_SECONDS` | tempo máximo para copiar o APK de um app da TV (padrão `120`) |
| `UNIOVER_TV_TEXT_BY_KEYS` | `1` digita o acréscimo (só letras minúsculas, dígitos, espaço e `. , - /`) pelas **teclas do controle remoto**, sem o processo `adb` de cada trecho (padrão: desligado; ver "Texto" abaixo) |
| `UNIOVER_TV_TEXT_KEY_PAUSE_MS` | pausa, em milissegundos, entre as teclas da digitação por teclas (padrão `0`; aumente se a TV perder letras) |
| `UNIOVER_AAPT_PATH` | caminho do `aapt2` (padrão: o mais novo em `%LOCALAPPDATA%\Android\Sdk\build-tools`, ou em `ANDROID_HOME`); sem ele a lista de apps segue sem ícones |
| `UNIOVER_ICONS_DIR` | pasta do cache de ícones (padrão `%LOCALAPPDATA%\UniOver\icons`; um arquivo por pacote e versão do app, e o nome leva a versão da regra de escolha do ícone: ao mudar a regra, o que a antiga guardou é ignorado e refeito) |
| `UNIOVER_UPDATE_CHANNEL` | `main` e `develop` são valores legados de produção e seguem `production_ref` publicado em `tools/update-channel.json` na `main`; `homolog` fixa a branch de homologação para um PC. O instalador grava o valor de `-Ref` em `agent.toml` |
| `UNIOVER_SELF_CARE` | `0` desliga o auto-diagnóstico periódico, o auto-reparo e o envio das ocorrências à API (padrão ligado; ver "Auto-diagnóstico") |
| `UNIOVER_HOME` | pasta de instalação (caminho absoluto); sem ela vale a escolhida na instalação (ver "Pasta de instalação") ou `%LOCALAPPDATA%\UniOver` |
| `UNIOVER_TV_CLEANUP_KEEP` | pacotes que a limpeza da TV **nunca** fecha, além dos protegidos de fábrica (ver "Limpeza da TV"): nomes de pacote do Android separados por vírgula (`com.exemplo.app,com.outro.app`); no `agent.toml`, `tv_cleanup_keep` como lista ou como esse mesmo texto. Item fora do formato de pacote é erro de configuração e o agente não sobe |
| `UNIOVER_PC_CONTROL` | `1` liga o controle deste PC pelo app (mouse, teclado, mídia, energia, favoritos). **Desligado por padrão**: sem isto o agente nem declara a capacidade `pc.control.v1` e recusa todo `pc.*`. Mais fácil: `uv run uniover-agent pc-control on` (grava no `agent.toml`; `off` desliga, `status` mostra) e reiniciar o agente |
| `UNIOVER_PC_APPS` | favoritos que o app pode abrir, `Nome=destino` (programa, documento ou endereço), separados por `;`. No `agent.toml`, `pc_apps` como lista (`["Navegador=C:\...\chrome.exe", "Notas=notepad"]`). O app só recebe o nome e um identificador; o destino nunca sai do PC |
| `UNIOVER_PC_SHUTDOWN_DELAY_SECONDS` | contagem do desligamento pedido pelo app, de 10 a 300 (padrão `30`); o Windows avisa na tela durante ela e o app pode cancelar antes do fim |
| `UNIOVER_PC_DIRECT` | `0` desliga o canal direto (WebRTC) deste PC (padrão ligado; ver "Canal direto"). `UNIOVER_PC_DIRECT_CONNECT_TIMEOUT_SECONDS` (padrão `15`), `UNIOVER_PC_DIRECT_IDLE_SECONDS` (padrão `20`) e `UNIOVER_PC_DIRECT_MAX_LIFETIME_SECONDS` (padrão `900`) são o prazo para o app abrir e autenticar o canal, o silêncio que o fecha e a vida máxima dele |
| `UNIOVER_TV_LIVRE` | `0` desliga o módulo TV Livre neste PC (padrão: ligado, sempre opt-in por comando do dono; ver "TV Livre") |
| `UNIOVER_TV_LIVRE_APK_URL` | pasta HTTPS da publicação com `uniover-launcher.apk` e `uniover-launcher.apk.sha256` (padrão: a última publicação do repositório) |
| `UNIOVER_TV_LIVRE_SIGNER_SHA256` | SHA-256 do certificado de assinatura do APK do TV Livre (hexadecimal, com ou sem `:`; vários separados por vírgula). O padrão é o certificado público da chave fixa do projeto; lista vazia = **nada é instalado**, porque o hash da publicação não prova quem assinou. Conferido com o `apksigner` do Android SDK (`UNIOVER_TV_LIVRE_APKSIGNER_PATH` para indicar outro caminho) |

Arquivo local (fora do repositório): `%LOCALAPPDATA%\UniOver\config\agent.toml`, com `api_url` e `agent_id`. Nunca
guarda segredo.

## Pasta de instalação

Na primeira instalação uma janela do Windows pergunta onde guardar o UniOver (`-InstallDir` pula a pergunta; cancelar
usa a pasta padrão). A escolha vira uma subpasta `UniOver` (nunca arquivos soltos numa pasta de uso geral) e é recusada
com uma frase simples se for de rede, de disco removível, protegida pelo Windows, longa demais, sem 1 GB livre ou sem
escrita. Uma reinstalação mantém a pasta que já existe.

`%LOCALAPPDATA%\UniOver` é a pasta **fixa**: guarda só o que o Windows precisa achar sempre no mesmo lugar (`launcher.vbs`
e `launcher.ps1`, que a tarefa agendada abre) e o ponteiro `location.txt` (UTF-8) para a pasta escolhida. O resto vive
na pasta de instalação (a própria pasta fixa, por padrão, então quem já tinha o UniOver instalado não migra nada):

| Pasta | O que guarda |
|---|---|
| `app`, `app.previous` | o código de sempre (o da instalação, que nunca é apagado) e, nas instalações antigas, a versão anterior |
| `app.staging\<sha>` | cada versão preparada por uma atualização, com o ambiente dela em `runtime\venv-<sha>`; ficam só a em uso e a anterior |
| `runtime` | ambiente Python (`venv`), o ponteiro da versão em uso (`current.json`), estado das atualizações, fila de diagnóstico, sinais do supervisor, versões recusadas |
| `config` | `agent.toml` |
| `logs` | `agent.log` (agente), `supervisor.log` (supervisor e lançador), `crash.log` (falha fatal do interpretador), `instalacao.log` |
| `web`, `tv`, `icons` | página de conexão, certificado da TV, ícones dos apps |

Ao subir, o agente arruma a pasta sozinho (`adapters/housekeeping.py`): refaz as pastas que faltam, guarda só as duas
versões recusadas mais novas, apaga restos de atualização com mais de um dia e as versões preparadas que ninguém usa mais.
Nunca toca em `app`, `app.previous`, configuração, certificado nem registros.

### Atualizar sem derrubar o uso (passagem sem queda)

> **A passagem sem queda vem DESLIGADA.** A chave `update_handover` (`config\agent.toml`, ou a variável
> `UNIOVER_UPDATE_HANDOVER=1`, que manda sobre o arquivo) a liga; o supervisor lê a chave a cada tentativa de troca e o
> agente a lê na partida. Desligada, o supervisor nunca sobe `run --handover`, o agente não declara `agent.handover.v1`
> (a API fecha com 4409, que toda versão entende) e a troca é a **reserva** (item 3): versão preparada em segundo plano,
> ponteiro e reinício. A reserva é a que o ensaio prova em todas as fases; só a fase C2 liga a chave, para continuar
> provando a passagem. A API anuncia `agent.handover.v1` por padrão para preservar a compatibilidade atual, mas o
> anúncio global pode ser retirado com `Agent__Handover__Enabled=false` (`Agent:Handover:Enabled`, padrão `true`): todos
> os agentes então usam a reserva, sem mudança de código. A chave vale para a descoberta e para o hub, mas é lida na
> criação dos singletons: desligá-la ou religá-la exige reiniciar a API. A passagem local continua desligada até cumprir o critério de
> ativação ao fim desta seção.

A atualização **prepara** a versão nova com o agente antigo servindo e a troca é gravar um ponteiro, não mover pastas
(o ambiente Python instala o projeto em modo editável, apontando para a pasta onde foi sincronizado: nada de renomear a
pasta de um agente vivo).

1. **Preparar** (`uniover-agent self-update`, o do dia a dia): baixa e confere o pacote, extrai em `app.staging\<sha>`,
   sincroniza o ambiente guardado em `runtime\venv-<sha>` e roda o auto-diagnóstico dele. Termina em `runtime\prepared.json`.
   Preparar não derruba nada, então não espera a TV parar nem a versão atual sair de prova.
   Preparar, aplicar e a passagem tomam a mesma trava de atualização (mutex `Local\UniOver-Update-<hash da pasta>`): um
   `self-update` que chega no meio de uma passagem espera 5 s e desiste sem apagar nada, e a versão em passagem fica marcada
   em `runtime\handover-sha.txt` para a poda nunca a apagar.
2. **Trocar** assim que a versão está preparada, sem esperar ociosidade. Com `update_handover` ligada e a API que lista
   `agent.handover.v1` em `devices/info`, o supervisor faz a **passagem**: sobe `uniover-agent run --handover` da versão nova (com a pasta e o
   ambiente dela, só no processo filho) enquanto a antiga serve. A nova confere o que a API aceita (sem a capacidade, sai
   com 6 e nada foi aberto), conecta como candidata, na **rota própria** `.../ws/handover` (uma API que não a conhece
   responde 404, a candidata desiste com 6 e ninguém é substituído; um cabeçalho seria ignorado por ela e a candidata
   viraria conexão comum), e diz `handover: true` e o `instanceId` no `hello`; só com ele válido a API a faz dona da
   conexão (troca atômica), confirma com `agent.handover.accepted.v1` e fecha a antiga com **4410 `handover`**, que a
   antiga entende como "terminar sem reconectar" (só se ela declarou `agent.handover.v1` no `hello`; senão sai com 4409
   `replaced`): a API espera os comandos que a antiga recebeu responderem (até 5 s, e as respostas dela ainda valem),
   o que estava em curso termina (até 2 s), as teclas seguradas são soltas, a TV e o canal direto fecham (cada passo com
   prazo de 10 s) e ela sai com 0. Depois da confirmação a nova espera a trava pelo prazo que o supervisor deriva do
   pedido de saída, da espera ordenada e da margem (`UNIOVER_HANDOVER_TAKEOVER_SECONDS`, passado pelo supervisor); sem ela sai com o código 5 de adiamento, para o
   supervisor voltar pela reserva. A nova só abre o que é compartilhado ou físico (a trava da instalação, o rastro da
   execução, o diário, a fila de diagnóstico, a TV, o canal direto, o vigia do endereço da TV) **depois** de a antiga
   sair; um comando que chega antes é recusado na hora (`agent_starting`), sem prender a leitura do canal. Pegando a
   trava, ela vira a dona logo: se a antiga foi derrubada solta os modificadores e botões do mouse que ela deixou apertados, abre o diário e
   passa a atender o PC; a arrumação da pasta roda em segundo plano e o preparo da TV (ADB) tem prazo próprio de 20 s
   (depois dele a TV segue e o preparo termina sozinho), e só os comandos `tv.*` seguem recusados até ele acabar. Só
   então o supervisor grava o ponteiro, mantém a versão anterior para voltar atrás e adota o processo novo.
3. **Reserva** (o padrão: a passagem desligada, ou a API sem a capacidade, ou a passagem que não deu): a versão já está
   preparada em segundo plano e `self-update --apply` a aplica **logo**, sem esperar ociosidade (pedido do dono), gravando
   o ponteiro; o agente reinicia e sobe da versão nova (o ambiente já está pronto: nada de `uv sync` com o agente
   parado). Como o reinício derruba o agente por uns 5 a 15 s, com a TV ou o controle do PC em uso naquele instante a
   troca espera: só até haver **60 s sem uso** (`update_tv_idle_seconds`, padrão 60) e **no máximo 10 min** desde que
   começou a esperar (`update_max_defer_seconds`, padrão 600), quando troca mesmo assim. Enquanto há versão preparada
   esperando, o supervisor volta a tentar a cada ~1 min (e não a cada 10), para trocar assim que houver a folga.
4. **Volta atrás**: a prova da versão nova (10 min) é gravada antes de qualquer troca. Se a nova cai ao subir na
   passagem, é encerrada e **bloqueada** (o defeito é dela), e a antiga nunca parou. Se não conecta no prazo
   (`UNIOVER_SUPERVISOR_HANDOVER_SECONDS`, 60 s), a causa é rede ou API lentas, do PC e não da versão: ela é encerrada e
   **adiada** (24 h, 72 h, uma semana), nunca bloqueada. Os prazos do agente novo contam do começo do processo, e o
   supervisor lhe passa o instante absoluto (`UNIOVER_HANDOVER_DEADLINE`, o prazo dele menos 10 s de margem) para ele
   desistir sozinho (saída 5, "adiada") antes de o supervisor agir. Se ela conecta ("conectou" é a confirmação `agent.handover.accepted.v1` da API: só então o
   `runtime\connected.json` dela traz o código da passagem) a API já mandou a antiga sair e ela não reconecta, então daí
   em diante **só a nova pode servir**: mesmo se a antiga sai sozinha, o supervisor exige `readyAt` no prazo derivado antes de
   gravar o ponteiro ou confirmar a prova. Se a antiga não sai sozinha, o supervisor lhe **pede a saída ordenada** (4 s depois da confirmação, ou ao fim dos
   60 s; `UNIOVER_SUPERVISOR_HANDOVER_ASK_SECONDS`) e só depois de mais 10 s (`..._HANDOVER_EXIT_SECONDS`) é a **antiga**
   que ele derruba, sem esperar o prazo geral (a nova pega
   a trava, vira a dona e o ponteiro muda; se ela não assume no prazo derivado, `UNIOVER_HANDOVER_TAKEOVER_SECONDS`, a
   versão fica **adiada** e o agente reinicia pela versão em uso); e se a nova cai depois de conectada, a antiga ganha
   10 s para terminar e é derrubada, e o laço reinicia o agente na hora, pela versão em uso (sem esperar a detecção de
   travamento). A saída 5 ou 7 e a falta de assunção não são culpa da versão nova: ela fica **adiada** (24 h, 72 h, uma
   semana), nunca bloqueada. Depois da troca, três quedas em prova regravam o ponteiro com a anterior e bloqueiam a
   versão nova.
5. **Duas execuções com a mesma identidade** não ficam trocando de lugar: além da trava da instalação, o agente toma uma
   trava por identidade (`Local\UniOver-AgentSlug-<hash do agent_id>`, que vale para a máquina toda e, na passagem, só é
   tomada depois de a antiga sair); duas substituições (`4409`) em 10 minutos fazem o agente sair (código 7) e registrar
   `agent.duplicate`. O supervisor trata o 7 como o 5: espera calma, sem contar como queda da versão em prova.
6. **Medida**: o supervisor registra `update.window` com os tempos (`mode=handover`: do início da nova até conectar
   (`new_start_to_connected_s`) e do ACK da API até a nova virar a dona (`connected_to_ready_s`, `readyAt` menos `connectedAt`,
   sempre maior ou igual a zero); `mode=restart`: do encerramento do agente até a primeira conexão).

**Tratadas** (eram as três pendências de maior risco da 4ª releitura):

- **4409 depois do ACK.** (a) A nova que recebe `ConnectionReplaced` antes de ser dona volta a ser candidata (mesmo
  `instanceId`, rota `/handover`) e reconecta em 0,2 a 0,5 s, sem os 60 s de `replaced_wait` (depois de 5 voltas em 1
  minuto a disputa vale a espera de sempre; já dona, nada muda). A confirmação que já tinha vinha da conexão anterior e
  deixa de valer: o prazo de confirmação recomeça e a nova só tenta a trava, e só vira dona, com a confirmação da
  candidatura de agora. (b) A execução em uso atende o pedido de saída ordenada do supervisor
  (`runtime\handover-exit`): para a conexão em qualquer ponto em que esteja, termina o que tem em curso (`drain`),
  fecha tudo e sai com 0, como no 4410; o supervisor só a derruba depois do prazo do pedido (uma antiga de antes desta
  versão não conhece o pedido, e para ela só vale a derrubada). O arquivo tem formato estrito,
  `handover-exit:<código da passagem, 32 hexadecimais>`, gravado de uma vez (temporário e renomeação); a execução da
  passagem, que tem o mesmo código, o ignora. Vazio, pela metade, de outro formato ou mais velho que a partida da
  execução que o lê é ignorado e registrado uma vez; o `run` comum também vigia (será a "antiga" da próxima passagem),
  nas mesmas regras. O supervisor e o agente apagam o arquivo que sobrar. (c) A nova solta, no laço da entrada, os
  modificadores (Shift, Ctrl, Alt e Win, dos dois lados) e os botões do mouse que o Windows dá por apertados
  (`GetAsyncKeyState`; só manda o que está apertado, para não ativar o menu da janela nem o de contexto) **só quando a
  antiga não saiu de forma ordenada** (o rastro `run-state.json` dela ficou `running`: foi derrubada ou morreu). Numa
  saída ordenada a antiga já soltou o que apertou (`release_all`), e o que estiver apertado depois pode ser de uma
  pessoa de verdade.
- **Capacidades da TV no `hello`.** O preparo da TV virou uma tarefa que, ao terminar, chama `supervisor.hello_now()`:
  o que ele declara (ADB e derivados) chega à API na hora, e não no `hello` de 5 minutos.
- **Janela `agent_starting`.** A dona abre logo depois da trava (`owner.set()`): a arrumação da pasta roda em segundo
  plano e o preparo da TV tem prazo próprio (`HANDOVER_TV_PREPARE_SECONDS`, 20 s; falha ou estouro não derrubam a dona).
  O que depende da TV (os comandos `tv.*`, o vigia do endereço, o anúncio da conexão e as tarefas de fundo da TV)
  espera o preparo ou o prazo; o PC não espera. Sem a passagem (`run` comum) nada disso muda.

**Pendências da passagem** (achados da 4ª releitura que sobram; `update_handover` segue desligada por padrão):

- **[BAIXA]** Se o ACK se perde, a nova segue candidata para sempre (o `hello` periódico leva `handover`/`instanceId` e
  toda reconexão vai à rota `/handover`; com a API revertida isso vira código 6 já sendo dona): zerar
  `_handover_pending` também quando `take_over` pega a trava. E no supervisor o teste do código 6 vem antes da marca de
  conexão.
- **[BAIXA]** A sessão passada só entrega `command.result`: `agent.logs.v1` em curso na antiga é descartado
  (`AgentHub`, aceitar também `AgentLogsV1` de `IsHandedOver`).
- **[BAIXA]** A carência de 10 s da antiga pode ser menor que a soma das etapas de encerramento dela (cada uma com até
  10 s): soltar as teclas logo no começo do `finally` quando o motivo é `STOP_HANDOVER`, ou subir a carência.
- **[BAIXA]** Depois de uma passagem que falhou o reinício não é "na hora": o laço espera `Sleep-Beating` (5 s ou mais),
  envia `child_exit` e registra `process.exited`, um alarme falso de queda. Marcar o fim da passagem e reiniciar sem
  espera e sem esse diagnóstico.
- **[INCERTO]** (a) o código `agent_starting` não é conhecido pela API nem pela web (o texto fixo em pt-BR do agente
  pode chegar à tela: mapear o código na web com `$localize`); (b) `kit.recorder.flush_pending()` e
  `kit.store.flush_appends()` rodam no `finally` mesmo quando a nova nunca virou dona (proteger com `if owner.is_set()`
  se o append em disco não for atômico entre processos); (c) conferir se algum `transport.send` concorrente (uma recusa
  `agent_starting` da conexão anterior) pode sair entre o `connect` e o `hello` da candidata, que a API descarta se o
  primeiro quadro não for o `hello`.

**Critério para ligar.** A chave local continua desligada por padrão. Só ligaremos `update_handover` depois de cinco
passagens seguidas em um PC real, com ACK→`readyAt` em até 3 s (o ensaio reprova a janela de recusa acima de 4 s e só avisa acima de 5 s), zero diagnósticos
`update.handover_forced` ou `update.handover_failed` e nenhuma tecla presa. Para desligar localmente, use
`update_handover = false` no `agent.toml` ou `UNIOVER_UPDATE_HANDOVER=0`; para desligar globalmente, configure
`Agent__Handover__Enabled=false`, que retira a capacidade da API e força a reserva em todos os agentes.

`runtime\current.json` guarda a versão em uso e a anterior (caminhos relativos à pasta da instalação, validados); sem o
arquivo vale o layout de sempre (`app` + `runtime\venv`). O supervisor, o lançador e o agente leem o mesmo formato.

## Auto-diagnóstico, auto-reparo e ocorrências

- **Tarefas de fundo supervisionadas** (`core/supervision.py`): erro numa tarefa é registrado com a pilha, vira ocorrência
  e a tarefa recomeça com espera crescente. O vigia do endereço da TV não confunde um erro dele com "a TV mudou".
- **Rastro de queda** (`adapters/run_state.py`, `adapters/crash_trace.py`): exceção sem tratamento (thread principal,
  threads, tarefas soltas) vai para o registro; falha fatal do interpretador deixa a pilha em `logs\crash.log`. Ao subir,
  o agente diz como a execução anterior terminou: de forma ordenada, de propósito (o supervisor deixa o motivo em
  `runtime\stop-reason.txt`), com o PC reiniciado ou sem se despedir (queda).
- **Pulso**: o agente regrava `runtime\last-alive` a cada minuto de dentro do laço de eventos. O supervisor reinicia um
  agente vivo que ficou mudo por cerca de 5 minutos (e conta como queda para a versão em prova).
- **Nada espera sem prazo** (o travamento de 05/11/2026: disco cheio, um `uv` preso e ninguém reiniciando): o supervisor
  roda cada filho (`self-update`, `uv sync`) com prazo e dá sinal de vida (`runtime\supervisor-alive`) enquanto espera; o
  `self-update` nunca deixa `update-status.json` em "atualizando" e nem começa com menos de 600 MB livres; o ambiente
  Python nunca é apagado com o disco quase cheio. O lançador vigia o supervisor e reinicia o que passa de 15 min mudo
  (e o auto-diagnóstico do agente faz o mesmo, em 20 min). O agente escreve o registro numa thread à parte (console ou
  disco parado não trava o laço de eventos), dá prazo a cada passo da conexão e a cada verificação do auto-diagnóstico, e,
  se o laço de eventos parar, deixa a pilha de todas as threads em `logs\crash.log` (`adapters/loop_watchdog.py`).
  O sinal de vida (`runtime\last-alive`) só é regravado enquanto o laço de conexão anda (cada passo declara seu prazo;
  um que o ignora faz o agente calar e o supervisor o reinicia), e o fechamento do canal também tem prazo. Depois de uma
  suspensão do PC (o relógio salta) o lançador e o auto-diagnóstico dão ao supervisor um novo prazo antes de agir.
  O teto externo do `self-update` (2400 s) passa da soma dos limites internos (`self_update.WORST_CASE_SECONDS`).
  A abertura do canal espera 105 s (o laço desiste aos 120 s: a API dormindo acorda em até ~1 min). Só um supervisor roda
  por instalação (mutex `Local\UniOver-Supervisor-<hash>`; o lançador só sobe outro depois de confirmar que o antigo morreu),
  ele cria o `last-alive` antes de subir o agente (com disco cheio só dá para mudar a data de um arquivo que existe) e dá o
  agente por mudo também se o arquivo nunca aparecer. A prova de uma versão nova é gravada ANTES da troca das pastas: sem
  conseguir gravá-la, a troca não acontece.
  O supervisor recusado pelo mutex sai com 43 (o lançador espera e tenta de novo, sem rodar o fallback); reinícios seguidos
  pelo lançador esperam 5, 10, 20 ... s (até 5 min); um supervisor de versão anterior, que não dá sinal durante a espera, é
  vigiado por 45 min em vez de 15; depois de um update que estourou o prazo a primeira volta sobe o agente sem repeti-lo; a
  volta atrás por não conseguir gravar a prova não bloqueia a versão (a falha foi do PC).
- **Auto-diagnóstico** a cada 10 minutos (`core/self_care.py`, `adapters/self_care_checks.py`): pasta de instalação,
  tarefa de início automático, supervisor, conexão (a API responde por HTTP; nunca abre um segundo canal), TV (só a
  porta, nunca tecla) e tarefas de fundo. Reparo seguro por verificação, com 30 min de espera e no máximo 4 por dia:
  refazer pastas, registrar de novo a tarefa (pela rotina que confere e desfaz), iniciar o lançador pelo Agendador,
  pedir ao supervisor que reinicie (no máximo um a cada 3 h). `uniover-agent diagnose` roda o mesmo exame à mão.
- **Ocorrências para a API** (`agent.diagnostics.v1`): erros e reparos vão para uma fila local limitada
  (`runtime\diagnostics.jsonl`, o supervisor também escreve nela) e são enviados depois do `hello` e a cada 5 minutos.
  O agente só declara a capacidade e só envia depois de `devices/info` da API listar `agent.diagnostics.v1`
  (`features`); até lá a fila fica no disco. Antes de gravar, o texto perde segredos, caminhos, IPs, MAC, e-mails e o nome do usuário e do PC; de uma exceção
  só vão o tipo e o ponto do código, nunca a mensagem. A API guarda por 7 dias e só o administrador vê, em Sistema.

## Controle do PC

Com `pc-control on` o app passa a mexer neste PC: touchpad (mover, clicar, rolar), teclado (texto e teclas especiais),
mídia (tocar, faixa, volume, mudo), energia (bloquear, suspender, desligar com a contagem do Windows e cancelar) e os
favoritos de `pc_apps`. Tudo é a API do Windows pelo `ctypes` (`SendInput`, `LockWorkStation`, `SetSuspendState`,
`shutdown.exe`), sem dependência nova, e só roda no Windows. O agente continua só discando para fora: nada escuta porta.

- **Desligado por padrão.** O agente se atualiza sozinho, e remotear mouse e teclado é poder demais para valer sem o dono
  ligar neste PC. Sem `pc_control` o `hello` não traz `pc.control.v1` e a API nem oferece o módulo.
- **Listas fechadas.** Teclas, botões, ações de mídia e de energia são as do contrato; um favorito só abre pelo
  identificador que este PC publicou (`pc.apps.v1`).
- **O texto digitado nunca vai para o registro** (pode ser senha). Desligar e suspender ficam no registro, sem detalhe.
- **Suspender** responde à API antes de adormecer (o PC leva a conexão junto). Não existe aviso do Windows para a
  suspensão (só para o desligamento): quem confirma é o app.
- O Windows recusa a entrada simulada quando a janela em foco tem mais privilégio (UAC, um app como administrador): o
  comando volta como `failed`.

### Canal direto (WebRTC)

Um acelerador **opcional** do controle do PC: o app e este PC trocam os mesmos comandos por um canal de dados WebRTC, sem
passar pela API (que só faz a sinalização, autenticada). A nuvem segue sendo o caminho de sempre e a reserva automática:
qualquer falha ao abrir, queda ou parada do canal devolve tudo a ela, sem que o app perceba além de um ponto de estado.

- **Só o dono, e só enquanto a sessão dele valer.** A oferta chega pelo canal autenticado com a API, e a API só a entrega ao
  agente de quem pareou o PC (a mesma regra do controle). A impressão digital DTLS da oferta e da resposta passa por ela. A
  primeira mensagem do canal leva um token de uso único e vida curta (30 s, contados aqui) emitido pela API; sem ele o canal
  fecha e o ponteiro não passa. O canal tem **vida máxima** (o que resta do token de acesso da pessoa, no máximo
  `pc_direct_max_lifetime_seconds`, 15 min): o app abre outro um pouco antes do fim, sem ninguém notar. A API fecha o canal na
  hora se a sessão que o abriu acaba (sair, "sair de todos", aparelho revogado), se a senha é trocada ou recuperada, se a
  conta é pausada ou revogada ou se a permissão do módulo é retirada.
- **Os mesmos comandos.** Cliques, teclas, texto e mídia passam pelo mesmo esquema, pela mesma faixa e pelos mesmos
  handlers da nuvem (idade, soltura de botão, texto fora do registro). Energia e favoritos só existem pela nuvem. Todo
  comando de entrada leva `ts` e só vale depois de dois sinais de vida firmarem a escala de relógio do app (soltar `UP`
  passa sempre); o teto de teclas conta cada `repeat` (umas 100 por segundo, como a nuvem), e o texto tem teto de caracteres
  por segundo. Mensagens recusadas (JSON ruim ou conteúdo inválido) se acumulam até 30 e derrubam o canal; só uma mensagem
  aceita zera a conta.
  O ponteiro viaja como total acumulado com número de sequência; cada comando leva o total do instante em que foi dado, e
  o clique nunca passa na frente do movimento que o antecedeu.
- **Fechar solta.** O canal fechado, por qualquer motivo (queda, silêncio de `pc_direct_idle_seconds`, vida máxima, troca por
  outra oferta, a conexão com a API perdida, o agente encerrando), solta o que o PC segurava e tira da faixa o que dele
  esperava (comandos e movimento), como a queda da conexão com a API. No máximo um canal por vez, e o app que o perdeu é
  avisado do motivo (`bye`): quando outro aparelho tomou o lugar (`replaced`) ou a sessão deixou de valer (`revoked`) ele não
  tenta de novo sozinho. **A nuvem vence:** chegando comando de entrada pela API enquanto o canal está em uso, o canal fecha
  ANTES (e solta o que segurava), então um aperto atrasado do canal nunca cai depois de um soltar da nuvem.
  Só os comandos de clique, tecla, texto e mídia fecham o canal; o movimento do mouse da nuvem nunca (ele chega sem espera, então
  um movimento atrasado logo depois da troca de caminho é normal e é só somado). O app declara no `auth` e em cada comando o
  último número (`cs`) do contador comum dos seus pedidos da nuvem: um comando da nuvem com `seq` até esse número é anterior à
  troca (chegou tarde) e roda sem fechar o canal. O agente também lembra por um tempo as sessões que a API mandou fechar e
  recusa (`rtc_closed`) uma oferta delas que chegue depois do fechamento.
- **Sem porta fixa, sem terceiros e só rede local.** O porto UDP é efêmero e fecha com a sessão; nenhum STUN ou TURN. Dos
  dois lados só entram endereços da rede local: da oferta, candidatos privados, de enlace local ou ULA (público, nome e
  `.local` são descartados, e o endereço de onde o app de fato chega é conferido); o que o agente oferece são só os IPv4
  privados e IPv6 ULA de interfaces físicas, sem o IPv6 global (o endereço público do PC), VPN, WSL, Hyper-V, Docker nem
  máquinas virtuais.
- **Firewall (para o dono).** O instalador não muda nada no Firewall. O pacote UDP do celular chega de fora para dentro, então
  na PRIMEIRA vez o Windows pode perguntar se o `python.exe` pode receber conexões: marque "Redes privadas" (a de casa). Com a
  rede de casa marcada como Pública e sem essa regra, ou em Wi-Fi com isolamento de clientes, ou em 5G, o canal não abre e o app
  usa a nuvem (nada quebra, só não há o ganho). Quando o app negocia o canal e nenhum pacote chega em `pc_direct_connect_timeout_seconds`,
  o agente grava o diagnóstico `pc.direct_unreachable` (em Sistema) apontando o Firewall e o perfil da rede; marcar a rede como
  Privada (Configurações, Rede) e aceitar o aviso uma vez resolve. No PC do dono a regra do Python base provavelmente já existe;
  em um PC novo (o do Raphael) o aviso aparece.
- **Dependência.** `aiortc` e `aioice` (versões exatas, de pelo menos 7 dias de publicadas quando entraram; os hashes estão no
  `uv.lock`), sem o `av` (FFmpeg, ~70 MB, com x264 e x265 sob GPL), que o `uv` exclui; um
  módulo pequeno (`adapters/pc_direct_stub_av.py`) faz o papel dele para o `aiortc` poder ser importado. A
  biblioteca só é carregada na primeira oferta, e a capacidade `pc.rtc.v1` só é declarada se ela está instalada, a
  configuração `pc_direct` está ligada e a API a listou em `features`. Atualizar o `aiortc` exige rodar os testes
  (`tests/test_pc_direct_aiortc.py` abre o canal contra o próprio `aiortc`).
- **uv mínimo.** A chave `exclude-dependencies` do `pyproject.toml` e o `[manifest] excludes` do `uv.lock` são entendidos a partir
  do **uv 0.9.8** (medido: a 0.9.7 recusa a chave com um aviso). Um uv anterior ainda sincroniza o lock com `--frozen` (medido de
  0.4.30 a 0.9.7: sem o `av`, só com o aviso), e o ambiente que roda segue de pé; o que ele faria errado é refazer a resolução
  em comandos sem `--frozen` e trazer o `av` de volta. Por isso o instalador e o supervisor rodam todo comando do uv com
  `UV_FROZEN=1`, e o supervisor, com o agente já de pé, confere a versão: se for anterior à 0.9.8, grava o diagnóstico
  `supervisor.old_uv` e, se o uv veio do winget, pede `winget upgrade astral-sh.uv` sem esperar (uma vez por dia).

### Entrada do PC isolada do resto do agente

Medido em produção (agente 0.54.0, com o PC do dono sob pouca memória): o laço de eventos do agente ficou parado mais de 1 s
em quase todos os minutos e até 250 s de uma vez, enquanto o Unified Remote, no mesmo PC, respondia normal. Mouse, teclado,
mídia, zoom, volume e o canal direto dividiam o laço com a TV, a rede, o diagnóstico e a atualização. Agora:

- **Um laço só da entrada** (`adapters/pc_input_thread.py`, ligado por `pc_input_thread`, padrão ligado): uma thread dedicada,
  com prioridade acima do normal (`SetThreadPriority`), roda a faixa dos comandos `pc.*` (`core/pc/lane.py`), o serviço do canal
  direto (e o `aiortc` com ele), os handlers do `SendInput`, o aviso de idade e a pergunta de aparelho novo. O laço principal só
  valida a mensagem e a entrega com `post` (fila sem bloqueio, na ordem de chegada); o resultado volta por um `Sender` que leva o
  envio ao laço do transporte sem nunca prender a entrada. Os dois laços têm o seu medidor de atraso (`laço principal` e `laço
  entrada` no registro). A thread é supervisionada (um erro vai ao registro e o laço segue). A ordem, o `seq`/época, a soltura do
  que o PC segura e os limites de taxa são os de sempre.
- **Memória.** O processo pede ao Windows um conjunto de trabalho mínimo duro (`SetProcessWorkingSetSizeEx`,
  `pc_working_set_min_mb`, padrão 64 MB, 0 desliga). Medido: o Windows aceita sem administrador (32 e 64 MB). Se recusar, o agente
  segue sem a proteção e registra. Medido em 12/11, o mínimo sozinho não basta: com ele em vigor o agente estava em 38 MB, e um
  `EmptyWorkingSet` (o que faz um limpador como o Mem Reduct) esvazia o processo mesmo assim. A causa provável das paradas de
  minutos (medida a prioridade, não ainda a melhora sob carga) é a prioridade herdada da tarefa agendada (prioridade 7): CPU abaixo do normal, memória 2 e E/S 1 no lançador, no supervisor e
  no agente, ou seja, as páginas dele eram as primeiras a sair e voltavam do disco na fila mais lenta. Na partida o agente
  devolve ao normal (nunca acima) CPU, memória e E/S, desliga o EcoQoS, e faz o mesmo nos ancestrais PowerShell (lançador e
  supervisor) que se declararam no ambiente (`UNIOVER_LAUNCHER_PROCESS`/`UNIOVER_SUPERVISOR_PROCESS`, pid e hora de
  criação) e nasceram na hora declarada; um PowerShell interativo ou um pid reaproveitado fica como está. A linha de atraso avisa quando o conjunto de trabalho cai abaixo de metade do mínimo (o agente foi tirado da
  memória). Bancada: `uv run python tools/check_memory_protection.py` confere tudo num processo filho.
- **Suspensão ou parada?** O lançador distingue as duas pelo `QueryUnbiasedInterruptTime` (não anda na suspensão) contra o
  `GetTickCount64` (anda): "o PC ficou suspenso X s" ou "o processo do lançador ficou X s sem rodar (memória/disco)".
- **O que o isolamento NÃO resolve.** As duas threads dividem o mesmo processo e o mesmo GIL: uma chamada em C que segura o
  GIL por muito tempo (a leitura das autoridades de certificado do Windows, por exemplo) para as duas, e o Windows ainda decide
  quem recebe CPU. O contexto TLS já é compartilhado (`ssl_contexts.py`); o resto é a prioridade e o conjunto de trabalho.
- **Diagnóstico das paradas curtas** (só registra, `stall_dump`, padrão ligado). Os dois laços já pararam juntos por 0,3 a 4 s
  algumas vezes por hora, com um processo vizinho sem parar: a causa está dentro do agente. `adapters/stall_dump.py` re-arma, a cada
  250 ms, o `faulthandler.dump_traceback_later(0,65 s)` a partir do laço da entrada; se ele ficar 0,65 s sem voltar, a thread de C do
  `faulthandler` (que não precisa do GIL) grava a pilha de TODAS as threads em `logs/stalls.log` (no máximo 1 a cada 10 min, 20 por
  dia e 2 MB; o arquivo cheio vira `.1` na execução seguinte) e uma linha no `agent.log`. A linha de atraso de cada laço passa a trazer
  também as falhas de página do minuto, o conjunto de trabalho e a maior pausa do GC (`adapters/process_memory.py`, `loop_lag.py`).
- **Movimento atrasado é somado e aplicado** (decisão do dono de 10/11): só o que passa de 5 s é descartado (antes, 2 s). Os
  movimentos vizinhos que já esperam na faixa viram um só (o mesmo caminho: o movimento é relativo), sem atravessar clique nem
  tecla e sem misturar nuvem e canal direto. Um salto grande do ponteiro (acima de `pc_pointer_spread_min_px`, 12 px no maior
  eixo) sai em 2 a 4 passos espalhados em `pc_pointer_spread_ms` (16 ms; 0 desliga), só quando nada espera atrás dele; qualquer
  comando que chega faz o resto sair de uma vez. O Windows acorda temporizadores a cada ~15 ms, então o espaçamento real pode ser
  maior que o pedido.
- **Canal direto sobrevive à queda curta da API.** A conexão com a API cair não fecha o canal: ele segue por
  `pc_direct_api_grace_seconds` (30 s) e fecha se a API não voltar. A revogação continua fechando na hora quando a API está de
  volta, e a API refaz a que não alcançou o agente assim que ele reconecta (o agente manda `pc.apps.v1` a cada conexão). O que o
  canal segura (um arrasto) não é solto pela queda da nuvem.
- **Canal direto depois de a API reiniciar** (`pc.rtc.reconcile.v1`). A API perde em memória o registro dos canais ao
  reiniciar, e uma revogação não acharia o que o agente segue segurando. Na oferta a API dá ao agente um **bilhete
  assinado** (opaco: o agente só o guarda). Ao reconectar, o agente (que só declara a capacidade depois de a API a listar
  em `features`) devolve o id do canal com o bilhete; nada mais é declarado por ele. A API confere a assinatura, a validade,
  o agente e a sessão, e se a sessão de login ainda vale, e responde `pc.rtc.reconciled.v1` (segue) ou manda fechar
  (`revoked`/`rescoped`). Sem resposta em `pc_direct_reconcile_seconds` (10 s) o canal fecha. Um canal aberto sem o bilhete
  (oferta de antes da capacidade) não pode ser reconhecido: é fechado como `rescoped` e o app abre outro.
- **Ciclo do canal direto no `agent.log` (INFO):** `canal direto aberto (sessão xxxxxxxx, escopos pc+tv, negociação n s)` e `canal direto fechado
  (sessão xxxxxxxx): motivo m; escopos pc+tv; aberto por n s; RTT <faixa>; movimentos perdidos n; mensagens n; TV pelo canal: n teclas, n textos, n
  recusados pela TV`, sem IP, SDP, candidato nem token. Nenhuma tecla vai uma a uma ao registro.
- **TV pelo canal direto (`tv.rtc.v1`, `tv_direct = true`).** Quando a oferta traz o escopo `tv` (a API o concede a quem pode controlar a TV deste
  agente, no instante da oferta), o canal leva `tv.key.v2`, `tv.key.v3` e `tv.text.v1`. Não há caminho paralelo: o canal valida o esquema (o
  mesmo portão da nuvem), confere a idade da tecla (mais de 1,5 s no caminho é `expired`, sem tocar na TV) e a entrega, por uma ponte
  (`core/pc/tv_bridge.py`: `call_soon_threadsafe` para o laço principal e `post` na volta, nunca esperando), a
  `ProcessMessage.submit_direct_tv`, que usa a MESMA fila de teclas da nuvem (ordem, descarte por idade de 1,5 s contado desde a chegada ao canal,
  junção de repetições, `on_command` do agendador de limpeza) e só troca a resposta: ela volta pelo `ack` do canal, não pelo transporte. Com o
  laço principal parado, a entrada do PC segue respondendo (sinal de vida, PC) e a ponte recusa com `busy` o que passa de 32 pendentes; a tecla que
  esperou mais que 1,5 s é descartada quando o laço volta. A sessão do canal é conferida no laço principal antes de cada entrega e de novo antes de a tecla ir à TV: fechar o canal descarta as teclas que ainda esperavam (`channel_closed`). `POWER`, desligar, abrir app, limpar e as outras ações da TV só existem pela nuvem
  (a API confere a permissão de cada uma e grava a trilha). Um canal só da TV nunca recebe o ponteiro nem `pc.*`, não pede a aprovação do aparelho
  no PC e, ao fechar, não solta o que o PC segura; um canal só do PC não leva a TV. O `ready` lista os escopos (`sc`) e as mensagens que o canal
  aceita (`caps`). Ao fechar por conta própria o agente soma `tvKeys` e `tvTexts` em `pc.rtc.closed.v1`, e a API grava a soma na trilha da TV. A
  capacidade só é declarada com TV configurada, canal direto do PC e `tv_direct` ligado, e só depois de a API listá-la em `features`.
- **Candidatos ICE tardios só da rede local:** UDP de IP privado (10/8, 172.16/12, 192.168/16), de enlace local (169.254/16,
  fe80::/10) ou ULA (fc00::/7); nome (inclusive `.local`), `relay`, TCP, CGNAT, loopback, `::ffff:` e endereço público são
  recusados no serviço e de novo no par. A conferência final do endereço do par **falha fechada**.
- **`SendInput` recusado com causa.** O erro do Windows é lido na própria thread (`use_last_error`) e, só depois da recusa, o
  agente olha o desktop de entrada (`OpenInputDesktop`) e a integridade da janela em primeiro plano (sem título): `session_locked`
  (tela de bloqueio ou desktop seguro), `elevated_window` (janela com mais privilégio) ou `failed`. O código chega ao app
  ("O PC está bloqueado", "Há uma janela de administrador na frente"). O movimento do mouse recusado vira UMA linha agregada por
  rajada. Os fatos (erro, desktop, níveis de integridade) vão ao registro, nunca o título da janela.
- **Operação ponta a ponta.** O app manda `X-Operation-Id` nos comandos pela nuvem (menos o movimento), a API o repassa no
  envelope (`operationId`, só a um agente que declara `pc.op.v1`) e os dois registram `operação <código>: <tipo> via <nuvem|canal
  direto>; fila n ms; execução n ms; resultado r`. Nunca texto, teclas nem coordenadas. No canal direto o código é o `i` do
  comando do app.
- **Aparelho novo aprovado no PC** (`pc_device_approval`, padrão ligado; capacidade `pc.device.v1`). A API manda no envelope o
  aparelho (`deviceId`: a sessão do app; `deviceName`: "iPhone (Safari)", tirado do navegador). Na primeira vez o agente abre uma
  janela do Windows no PC ("Permitir que <nome> controle este PC?", por cima de tudo, "Não" como padrão); o comando volta
  `device_pending` (403 `pc-device-pending`) até o dono responder. Permitiu: fica guardado por aparelho em
  `runtime\pc-devices.json` (só um resumo do identificador) e não pergunta de novo. Recusou: `device_denied` (403
  `pc-device-denied`) por uma hora, depois pergunta de novo. A oferta do canal direto também passa por isso. **Por que não pela
  bandeja:** o ícone é outro processo (o PowerShell da bandeja só lê o estado e devolve ações de menu); uma pergunta de sim ou não
  ali pediria um protocolo de ida e volta por arquivos e, se a bandeja não estivesse viva, o aparelho ficaria pendente para
  sempre. O agente roda na sessão do usuário (é por isso que o `SendInput` funciona), então ele mesmo mostra a janela.
  Convidados continuam sem `module:pc` por padrão (o modelo "só TV" do convite não o inclui).
  **Falha fechado:** com a aprovação ligada, comando sem `deviceId` só passa se a API RESPONDEU à consulta de `features` e NÃO
  lista `pc.device.v1` (uma API anterior: decisão registrada no log). Com isso desconhecido (partida, consulta que falhou, o
  `hello` ainda negociando) o comando volta `device_unknown` (403 `pc-device-unknown`, "tente de novo"). **O movimento do mouse**
  de um aparelho pendente ou recusado é descartado sem resposta; para o app saber, o agente conta o estado à API
  (`pc.device.state.v1`: `pending`, `denied`, `approved`, no máximo a cada 10 s por aparelho) e a API responde 403 também ao
  ponteiro enquanto o aviso valer (30 s, renovado; apagado por `approved` e pela queda do agente): "Aprove este aparelho no PC".
  **A API nunca "volta" a não ter aprovação:** depois de listar `pc.device.v1` uma vez (gravado em `runtime\pc-devices.json`,
  `apiSeen`), uma resposta "não lista" (instância antiga no deploy, página de manutenção) nunca reabre o modo sem aprovação. Um 200
  sem a lista `features` vale como "não respondeu" (`None`), e ao conectar sem a API ter respondido o agente consulta na hora
  (prazo curto), sem esperar o recuo de até 5 min. **O canal de outro aparelho** nunca cai por uma oferta recusada: a API só
  substitui as sessões antigas depois de o agente aceitar a oferta nova. A pergunta tem prazo de 2 min (fecha como "sem resposta").
  **Sair do `apiSeen`** (por exemplo, voltar para uma API anterior sem a aprovação): desligar `pc_device_approval` no
  `agent.toml` ou apagar `runtime\pc-devices.json` (apaga também as decisões já tomadas, e os aparelhos voltam a ser
  perguntados). Enquanto `apiSeen` valer e a API não listar `pc.device.v1` (instância antiga no deploy), o agente pede nova
  consulta de features a cada 15 s, no máximo, para o `hello` voltar a declarar a capacidade em segundos.
  **Encerramento:** a janela roda numa thread daemon com título único; ao encerrar o agente, ele a acha pelo título e clica em
  "Não" (`WM_COMMAND`; uma caixa Sim/Não ignora `WM_CLOSE`), espera a thread por até 3 s e a resposta assim dada nunca vira
  decisão.

## TV Samsung (Tizen)

Use uma Samsung recente na mesma rede do PC, com o controle por rede liberado:

1. Defina `tv_kind = "samsung"` e `tv_host = "<ip-da-tv>"` no `agent.toml` (ou use as variáveis
   `UNIOVER_TV_KIND=samsung` e `UNIOVER_TV_HOST`).
2. Rode `uv run uniover-agent tv-pair --kind samsung --host <ip-da-tv>` e selecione **Permitir** no aviso da TV
   em até 60 segundos. O token fica no Cofre de Credenciais do Windows, no serviço `uniover-agent` e nome
   `samsung:<nome-da-tv>`; ele não é gravado em arquivo nem mostrado no log.
3. Se o aviso não aparecer, na TV procure **Gerenciador de Conexão do Dispositivo** ou **Notificação de acesso**,
   permita o PC e tente o pareamento outra vez.

### Permissão da TV: um aviso só

A TV liga o "Permitir" ao **nome do cliente** (sempre `UniOver`) e ao token. O nome fica gravado no cofre, em
`samsung-name:<nome-da-tv>`, junto do token: atualizar ou reinstalar o agente não o muda, e a configuração
(`tv_client_name`) deixa de valer para a Samsung. Token guardado antes desta regra mantém o nome com que foi pareado.

Se a TV esquecer o UniOver (permissão revogada ou vencida), o agente **não insiste**: cada tentativa faria o aviso
aparecer na tela sem ninguém ter pedido. Ele grava a marca `samsung-permission:<nome-da-tv>` no cofre (sobrevive a
reiniciar), para de abrir conexões, avisa a API (`tv.permission.v1` com `needed`) e responde `tv_permission_needed` aos
comandos. A pessoa que usa a TV recebe, ao entrar no app, uma folha curta com **Pedir Agora**; só esse pedido
(`tv.permission.request.v1`) volta a falar com a TV, uma vez, com o token guardado: uma TV que ainda o reconhece conecta
sem aviso nenhum. Aceito o aviso, o token novo vai para o cofre, a marca some e a API é avisada (`granted`).

### Procura de TVs na rede

O agente também responde a `tv.discover.v1` com as TVs compatíveis que acha na rede dele (a mesma varredura do
`tv-find`: só leitura de identificação). A lista nunca leva endereço IP nem MAC: cada TV vai com um `id` opaco e estável e
a marca `controlled` (é a que o agente já controla). O app a usa ao adicionar uma TV, mostrando primeiro as achadas
(**Na Sua Rede**).

O agente mantém o WebSocket Samsung aberto enquanto há uso e o hiberna como faz com Android. Lê a energia pelo
REST da TV (`on`, `standby` ou `off`; sem resposta fica `unknown`) e não repete `POWER` em menos de dez segundos.
Teclas, volume, canais, números, mídia e início funcionam pelo canal Samsung. A lista primeiro pede o catálogo pelo
WebSocket (quando o firmware entrega o caminho, o agente busca o ícone e publica `tv.apps.v2`); nos modelos que não
respondem, consulta pelo REST um catálogo de apps conhecidos e os IDs extras em `UNIOVER_TV_SAMSUNG_APPS`. A web tem
ícones locais para os serviços Tizen mais comuns nesse segundo caso. A abertura tenta o mesmo REST antes de recorrer
ao canal Samsung. A lista usa aliases internos válidos no contrato, mas abre o `appId` original Tizen. Não há ADB,
abertura de links ou digitação pelo canal desta TV: esses pedidos retornam `unsupported`, e a limpeza pedida à mão
responde "pulada" (a manutenção é automática, abaixo).

**Manutenção automática (`tv.maintenance.v1`).** Depois de 15 minutos sem uso pelo UniOver (`UNIOVER_TV_SAMSUNG_MAINTENANCE_IDLE_SECONDS`,
de 60 a 3600 s), a Samsung ligada fecha apps de fundo, e **só os que a própria TV prova** estarem rodando e ocultos: o
REST `GET /api/v2/applications/<id>` informa `running` e `visible` por app, e o fechamento é o `DELETE` do mesmo
endereço. Na dúvida nada é fechado e o relatório diz "pulada". Regras, todas com teste:

- nunca abre o canal do controle (é isso que faz a TV mostrar "Permitir") e nunca pede permissão: sem token, ou com a
  marca de permissão pendente, não toca na TV e avisa uma vez (o mesmo aviso que a tela de permissão já usa);
- exige exatamente um app visível na leitura, como prova de que `visible` funciona nesta TV; com zero ou vários
  visíveis, ou `running`/`visible` que não sejam booleanos, pula tudo;
- nunca fecha o app visível, o último aberto pelo UniOver nem o app do estado da sessão;
- lê duas vezes (3 s entre elas) e relê o app logo antes de fechar; a conferência final (uso pelo UniOver, opção
  desligada, app protegido) roda sem `await` até o `DELETE`, então a TV trocar de app, alguém voltar a usá-la ou a
  opção ser desligada cancela o que falta;
- a passada inteira tem prazo de 120 s; passado ele nada novo é fechado e o relatório traz o que já foi;
- só conta o `DELETE` que a TV aceitou;
- só arma com uso pelo UniOver: uma TV usada só com o controle físico nunca dispara a manutenção.

A API manda a preferência desta TV em `tv.cleanup.config.v1` (`maintenanceEnabled`, ligada por padrão); o agente não
faz nada antes de recebê-la. O relatório sai como limpeza `deep` com gatilho `maintenance`.

O canal Samsung só envia teclas e não informa o volume. O agente tenta lê-lo pelo serviço UPnP RenderingControl, por
uma cascata que guarda o caminho que funcionou nesta TV: (1) a descrição do renderizador na porta 9197 (`/dmr`), (2) o
endereço de controle padrão das TVs Tizen, direto, e (3) SSDP (primeiro direto à TV, depois no grupo multicast), que
vai por último porque o multicast falha com várias placas de rede, VPN ou firewall. A consulta `GetVolume` roda uma
vez ao abrir a sessão e uma vez depois de cada tecla de volume ou mudo, nunca por sondagem. Uma primeira falha não é
veredito (o serviço pode subir depois do canal remoto): a cascata se repete com espera crescente (5, 15, 45 e 120 s) e
só depois a TV é dada como sem o serviço, o que vale por 30 min. Na Android TV o nível chega sozinho pelo canal
remoto; só se ele nunca chegar o agente pergunta ao shell (`cmd media_session volume`, depois `dumpsys audio`), que
cobre a saída por soundbar HDMI-ARC. Para ver na TV de verdade o que responde, sem apertar tecla nenhuma:

```
uv run uniover-agent tv-volume
```

Sem nenhum caminho possível o volume fica desconhecido e o app mostra só o retorno do toque. Além das teclas básicas, o agente declara no `hello` as teclas extras que a TV tem (`tv.key.INPUT`,
`tv.key.GUIDE`, `tv.key.RED`...), e a web as oferece como botões extras.

### Instalação em um clique

Para quem não é técnico: baixar e abrir **um** arquivo, `apps/agent/tools/conectar-uniover.cmd`. Ele roda o instalador
sem parâmetros (modo automático), que:

1. instala o `uv` pelo `winget` se faltar e baixa o agente (commit exato da `main`, com `.version`);
2. **acha a TV** na rede (`tv-find`): varre o /24 da interface com rota padrão em menos de 10 s, procurando Samsung
   (`GET http://<ip>:8001/api/v2/` com `device.type` `Samsung SmartTV`) e Android TV (porta 6466). Uma TV achada é
   usada; várias, pergunta qual. Não achando, aceita o IP digitado ou segue sem a TV;
3. **pareia o agente**: mostra o código e o QR para escanear com o celular onde a pessoa usa o UniOver
   (já pareado, não repete);
4. **pareia a TV** (na Samsung, aceitar o aviso na tela; já pareada, não repete);
5. cria a tarefa **UniOver** (ao entrar no Windows, sem janela, sem perguntar) que roda o
   lançador estável `%LOCALAPPDATA%\UniOver\launcher.ps1`. O instalador também deixa um atalho **UniOver** no
   Menu Iniciar. Os rótulos da tarefa e de **Aplicativos de inicialização** ficam em
   `tools/windows-startup.json`; a atualização do agente os aplica na conta do usuário, sem novo UAC.

O lançador chama o `app\tools\run-agent.ps1` que veio com a versão atual e mantém uma cópia conhecida para
recuperação. Assim o supervisor, o ícone e futuras correções também chegam pela atualização. O supervisor fica sem
janela, faz `uv sync` e `run`; se o agente cair, volta com espera crescente (5 s até 5 min, voltando a 5 s depois de
10 min de agente saudável). Se o `uv` ou o ambiente virtual quebrarem numa atualização do Windows, recria
`%LOCALAPPDATA%\UniOver\runtime\venv`. O registro fica em `%LOCALAPPDATA%\UniOver\logs\agent.log`.

**Bandeja.** Perto do relógio aparece o ícone do UniOver: um disco redondo com a marca, cuja cor diz o estado
(verde conectado, laranja reconectando, vermelho sem conexão, azul atualizando). Quando algo pede atenção (hoje, uma
atualização que falhou) um selo vermelho-alaranjado aparece no canto inferior direito, recortando o disco, sem mudar a cor dele. A dica traz o
estado e o nome da TV. O menu tem Abrir UniOver, Status, Ver Registro, Atualizar Agora, Reiniciar e Sair.
O supervisor abre a bandeja em toda instalação Windows, com TV Samsung, Android ou sem TV configurada. O atalho
**UniOver** na pasta Inicializar faz a entrada aparecer no Gerenciador de Tarefas e pede o ícone no logon.
Desabilitar essa entrada impede o ícone no próximo logon; a tarefa do Agendador ainda inicia o supervisor e o
agente para manter o controle disponível. Para interromper o início do agente, use a desinstalação.

- **Sair só fecha o ícone.** O agente e o supervisor continuam rodando. O ícone deixa `runtime\tray-closed`, e o
  supervisor não o reabre enquanto o sinal valer: até o próximo logon (o sinal é velho se foi deixado antes de a sessão
  do Windows atual começar) ou até a pessoa abrir o atalho **UniOver** do menu Iniciar (`tools\tray-open.vbs`,
  que apaga o sinal e chama o lançador; o ícone volta em poucos segundos). O supervisor cria esse atalho ao subir, se
  faltar, para ele chegar também a quem já tinha o UniOver instalado. Uma atualização não traz o ícone de volta.
- **Balão do Windows só em falha de atualização**, uma vez por resultado (`runtime\tray-notified.json`). Atualizar,
  conectar, reiniciar e o resto não abrem balão.
- **Todo erro vai para o diagnóstico.** Falha de atualização (`update.failed`, `update.rejected`, `update.sync_failed`,
  `update.rollback_failed`, em severidade `error`, escritas pelo agente e pelo supervisor) e falhas do próprio ícone
  (componente `tray`) entram na fila `runtime\diagnostics.jsonl`, vão para "Erros dos Agentes" em Sistema e geram o
  alerta "Falha de Atualização" no app do dono.
- **Ícone nítido.** Os `.ico` de `assets\tray` (um por estado, com e sem selo, de 16 a 256 px) saem dos SVGs da mesma
  pasta por `tools\build_tray_icons.mjs` (`node apps/agent/tools/build_tray_icons.mjs [pasta-de-previas]`). 16, 20 e 24
  px têm desenho próprio na grade do pixel; o ícone é carregado no tamanho exato da bandeja na escala atual (o processo
  declara suporte a DPI) em vez de o pystray carregar 32 px e o Windows encolher. O identificador do ícone no Windows
  é fixo (`hID`), para o Windows lembrar onde a pessoa o deixou.
- **Sempre visível, uma vez.** O Windows 11 esconde ícones novos no menu "^". Depois do primeiro registro o ícone
  procura sua linha em `HKCU\Control Panel\NotifyIconSettings\<id>` (a que tem `ExecutablePath` igual ao do próprio
  processo, em geral o `python.exe` do ambiente, `InitialTooltip` começando por "UniOver" e `UID` igual ao do ícone), grava
  `IsPromoted=1` e
  deixa `runtime\tray-promoted.json`. Com a marca, nunca mais escreve: quem esconder o ícone depois não o vê voltar.
  A chave não é documentada pela Microsoft e o Windows pode ignorar a mudança até o próximo registro do ícone; se a
  linha não aparecer em 2 minutos, tenta de novo na próxima abertura do ícone.

O ensaio de atualização não mexe nesse registro. Se a bandeja não estiver disponível, o agente continua normalmente; um ícone que cai logo ao abrir é reaberto com espera
crescente (15 s até 30 min) e a queda vira diagnóstico. A pasta `%LOCALAPPDATA%\UniOver` fica organizada em `app`,
`runtime`, `config`, `logs` e `web`, com um `LEIA-ME.txt`. Instalações antigas são migradas preservando
`agent_id`, configuração e os tokens do Cofre do Windows.

**Reencontro da TV.** Com `tv_id_hint` gravado, o `run` confere a cada minuto se a TV responde (a sessão quente já
prova que sim). Depois de 3 falhas seguidas refaz a varredura, no máximo uma a cada 10 minutos; achando a **mesma**
TV (mesmo `duid`/MAC) em outro endereço, grava o `tv_host` novo no `agent.toml` e reinicia a conexão sozinho
(`run` devolve o código 4 e o `main` recomeça). TV desligada não aparece na varredura e nada muda. O log não traz
endereço nem identificador.

**Auto-atualização com retorno.** A cada início e depois a cada 6 h (com até 45 min de variação), o wrapper
consulta `tools/update-channel.json` na `main` para saber qual branch publica em produção (hoje `develop`), depois consulta o commit dela. O mesmo valor seleciona a branch autorizada no `deploy.yml`. Se a consulta ao arquivo falhar, o agente usa a cópia instalada. A candidata é baixada para `app.new`, passa por `uv sync` e por um import rápido
do agente e do contrato `agent.hello.v1`; só então entra no lugar. A pasta anterior fica em `app.previous`.
Se a versão recém-instalada cair três vezes antes de completar 10 min, o wrapper restaura a anterior e anota o SHA
em `.blocked-versions`, para não tentar o mesmo commit ruim de novo. Falha de rede, limite do GitHub, teste ou pasta
em uso só preserva a versão que está rodando. Para a renomeação funcionar no Windows, o ambiente Python fica fora da
pasta (`UV_PROJECT_ENVIRONMENT=%LOCALAPPDATA%\UniOver\runtime\venv`) e o `uv` roda com `--project`.

**Troca do ramo de produção.** A fonte de verdade é `apps/agent/tools/update-channel.json` na branch `main`:
`production_ref` aceita `develop`, `main` ou `homolog`. O workflow de deploy lê esse valor da `main` e só
publica commits do ramo escolhido; o conectador baixa o instalador desse ramo; os agentes de produção
consultam a mesma escolha ao iniciar e nas verificações periódicas. Antes de trocar o valor, deixe o ramo
de destino com o workflow de deploy, uma versão válida e o código que deve entrar em produção. A mudança
não exige reinstalar os PCs nem pedir administrador outra vez. `homolog` em `agent.toml` permanece um canal
de teste fixo para aquele PC; o ambiente GitHub `production` continua sendo o destino de publicação.

**Início com o PC.** A tarefa usa `AtLogOn`, usuário atual, sem janela, sem parar na bateria e sem limite de 72 h.
É o caminho confiável sem administrador porque a credencial do agente fica no cofre do usuário. Antes de haver
logon não existe esse cofre disponível; uma tarefa `AtStartup` como `SYSTEM` precisaria de elevação e não poderia usar
o pareamento do usuário. No PC configurado para entrar automaticamente, o agente sobe sozinho. Para reparar uma
instalação, abra o mesmo `conectar-uniover.cmd` de novo: o fluxo é idempotente e preserva pareamento e configuração.

### Ensaio de atualização

Antes de publicar qualquer mudança que toque `apps/agent`, rode **um comando** na raiz do repositório:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\agent\tools\upgrade-drill.ps1
```

Ele monta uma instalação **isolada** numa pasta temporária (nada de `%LOCALAPPDATA%\UniOver` real, tarefa agendada
ou Cofre de Credenciais: o ambiente do processo filho é redirecionado e o cofre é falso), instala a versão base
(`origin/main`, ou `-BaseSha`) com as funções do instalador dela, sobe o supervisor com agente e ícone de verdade e
força a atualização para a candidata (a árvore local, empacotada como o zip do GitHub; ou `-CandidateRef`). Confere:
a troca (`app\.version`), o reinício do supervisor, agente e ícone da versão nova de pé por 45 s, nenhum processo
da versão velha, nenhuma janela visível, um segundo ciclo candidata -> candidata+1 (pelo ponteiro, com uma API falsa
que não sabe a passagem: caminho de reserva), uma terceira troca com a API falsa que a sabe (**passagem sem queda**: o
mesmo lançador e supervisor, a API falsa nunca sem agente conectado, o `hello` com `handover` na rota da candidata, a
confirmação `agent.handover.accepted.v1` e o fechamento 4410 da antiga, que antes precisa ter declarado `agent.handover.v1`: o
ensaio espera o agente em uso saber que a API aceita a passagem, o que a consulta periódica dele faz em até 5 minutos), a recusa de uma candidata que não importa (a versão em uso segue rodando) e uma atualização presa na rede, que o
supervisor interrompe no prazo. Termina com `APROVADO` ou `REPROVADO` (e o motivo), apaga a pasta
temporária e só encerra os processos que ele mesmo criou; o código de saída é 0 só se aprovado. Leva de 4 a 8 minutos.

O código publicado na `main` ainda não conhece o modo ensaio do `self_update.py` (`UNIOVER_UPDATE_DRILL=1` e
`UNIOVER_UPDATE_SOURCE_URL=http://127.0.0.1:porta`, que só trocam de onde vêm o commit e o zip); a primeira troca
usa por isso um desvio no processo filho (`tools/upgrade_drill_support`). `-InjectDefect window|crash` planta um
defeito conhecido na candidata para provar que o ensaio reprova.

### Instalador Windows (manual)

No PowerShell, baixe e rode `apps/agent/tools/install-windows.ps1` com, por exemplo:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-windows.ps1 -TvKind samsung -TvHost 192.168.0.11
```

Com `-TvHost` o instalador segue o fluxo manual (sem descoberta e com a pergunta abaixo). Ele instala o `uv` pelo `winget` se necessário, baixa somente `apps/agent` da branch pública `main` em
`%LOCALAPPDATA%\UniOver\app`, prepara as dependências, mostra o código para aprovar o PC no app, pareia a
TV e pergunta explicitamente antes de criar a tarefa **UniOver** para iniciar sem janela ao entrar no Windows.
Para remover só a tarefa: `.\install-windows.ps1 -Uninstall`.

## TV (Android TV Remote v2)

O agente controla a TV pelo protocolo Remote v2 (biblioteca `androidtvremote2` 0.3.2), com a **sessão
quente**: a conexão fica aberta para o app não esperar ao abrir, e **hiberna depois de 300 s sem comando e
sem aviso de "app aberto"** (`tv.wake.v1`). O primeiro comando depois de hibernar reabre a sessão; o tempo de
aquecimento é medido e registrado no log. Se a TV não responder, tenta de novo com espera de 1, 2 e 4 s e
então responde `tv_unreachable`: nunca fica num laço infinito.

A descoberta (`tv-find` e o reencontro da TV) escuta o anúncio mDNS `_androidtvremote2._tcp` por 1,5 s, ao
mesmo tempo da varredura TCP da /24, que continua como reserva.

Texto (`tv.text.v1`): cada mensagem traz o texto completo do campo (0 a 200 caracteres). A TV **insere** o que
recebe, então o agente guarda o que ele mesmo digitou, apaga o excedente com `DEL` (uma tecla por caractere) e
digita só o acréscimo. **Texto vazio apaga tudo o que o agente digitou.** Sem campo em foco a TV ignora em
silêncio. Quando a TV informa o estado do campo em foco (valor e cursor), o agente parte do valor real em
vez do palpite e a troca de campo vem por esse aviso, não pela pausa de 20 s; sem o aviso, nada muda. O
acréscimo vai por um canal só (nunca dividido, para a ordem não depender de dois caminhos):

- **teclas do controle remoto**, se `UNIOVER_TV_TEXT_BY_KEYS=1` e **todos** os caracteres do acréscimo têm tecla
  sem ambiguidade: `a`-`z` minúsculas, `0`-`9`, espaço e `. , - /`. Cada caractere é um pacote no mesmo fluxo do
  `DEL`, sem processo novo. Maiúsculas e `_` precisariam de SHIFT (a biblioteca aceita `SHIFT_LEFT` com
  `START_LONG`/`END_LONG`, mas ninguém mediu se a TV aplica o SHIFT à tecla seguinte, então não se inventa);
  `@` e os demais símbolos dependem do mapa de teclas da TV e entram quando a medição provar;
- **ADB** (`input text`) para ASCII imprimível sem `%`, quando o canal está pronto: um processo `adb` por trecho, e
  no Android TV o `input text` sobe uma JVM a cada chamada (de ~300 ms a mais de 1 s);
- **Remote v2** (`send_text`) para o resto (acentos, emoji, `%`) e quando o ADB não está pronto.

Medir: cada comando de texto deixa **uma** linha `INFO` no log (`%LOCALAPPDATA%\UniOver\logs\agent.err.log`), sem o
texto digitado (pode ser uma senha):

```
texto anterior=5 apagar=0 inserir=1 canal=adb resultado=ok | ms vez=0 adb=412 wake=1 apagar=0 digitar=418 total=420
```

`anterior`, `apagar` e `inserir` são tamanhos; `canal` é `teclas`, `adb`, `remote` ou `nenhum` (nada a fazer);
`resultado` é `ok`, `falha:<código>` ou `interrompido`. Em milissegundos: `vez` é a espera pela vez (a fila das
mensagens e a trava interna), `adb` é quanto o `input text` esperou a trava do ADB (que a lista de apps e as
consultas de ícones também usam; `-` fora do canal ADB), `wake` é abrir a sessão, `apagar` são os `DEL`, `digitar`
é o acréscimo e `total` é tudo. Uma mensagem que chegou e foi descartada porque já havia outra mais nova na fila
deixa `texto descartado: chegou um mais novo | ms vez=<n>`.

Pareamento (uma vez):

1. Deixe a TV ligada. Rode `uv run uniover-agent tv-pair --host <ip-da-tv>`.
2. A TV mostra um código de 6 caracteres; digite-o quando o comando pedir.
3. O par certificado/chave fica em `%LOCALAPPDATA%\UniOver\tv\<nome>\` (`cert.pem` e `key.pem`), numa pasta
   restrita ao seu usuário (`icacls`). **Nunca** vai para o repositório nem para o log.
4. Defina `UNIOVER_TV_HOST` (ou `tv_host` no `agent.toml`) e rode `uniover-agent run`. O agente só declara a
   capacidade `tv.remote` à API se o endereço estiver definido **e** o certificado existir.

Parear de novo pelo app (Android TV): se a TV deixar de aceitar o certificado (por três recusas confirmadas), o
estado vira `not_paired` e o agente para de insistir; o app mostra "Parear de novo" só ao dono. O toque manda
`tv.pair.v1` sem código (a TV mostra o código de 6 caracteres) e, depois que o dono o digita, com `code`. O agente
responde `ok` assim que a TV aceita o par e só então reabre a sessão (sem tecla e sem contar como uso, então não dispara
a limpeza nem a leitura de volume); o resultado da abertura chega pelo estado: `not_paired` some, ou continua se a TV
recusar o certificado outra vez (logo depois de pareada uma recusa já vale, sem esperar três). Fechar a folha com o código
na tela manda `tv.pair.v1` com `cancel: true`, e o agente larga o pareamento (a API ainda espera pelo menos 10 s entre dois
pedidos de código na mesma TV). O agente nunca inicia isto sozinho, o código nunca vai para registro, auditoria nem
mensagem de erro, e o certificado já existente é reaproveitado. A capacidade `tv.pair.v1` e o estado `not_paired` só vão
à API depois de ela os listar em `features` (uma API anterior os recusaria), e o estado é dito de novo quando a lista chega.

Limite conhecido: sem o par certificado/chave ao iniciar o agente, a TV nem é montada (sem `not_paired` e sem o handler
`tv.pair.v1`), então não há como parear pelo app: rode `uniover-agent tv-pair` no computador. O pareamento pelo app
vale para a credencial que se perde com o agente já rodando.

Comportamentos que valem saber:

- **Dormir não é desligar.** Hibernando, o estado publicado é `connection: hibernating` e `power: unknown`; o
  agente nunca afirma "TV desligada" só porque a sessão dormiu.
- **Um dono da conexão por TV.** Só o `TvSessionManager` abre e fecha canais. O vigia legado (tarefa agendada
  do PC que religa o serviço do controle por ADB) **precisa ser desligado quando este agente assumir**: dois
  clientes na mesma TV derrubam um ao outro. O nome da tarefa se descobre no PC de casa com
  `Get-ScheduledTask`, e quem decide quando desligar é o dono.
- **`POWER` passa como as outras teclas.** Quem confirma o desligamento é o app (a folha "Desligar a TV?"); a
  API só o envia pela rota própria de desligar. Sem emissor infravermelho a TV só volta com o controle original,
  então o agente **nunca** a liga sozinho: nada nele envia tecla por conta própria (reabrir a sessão, `tv.wake.v1`
  e a recuperação de uma queda só abrem a conexão; teclas só saem de um comando). Como `POWER` é um interruptor, o
  gerenciador de sessão **não repete** um `POWER` que chega em até 10 s do anterior (toque duplo, ou nova
  tentativa depois de um tempo esgotado): o segundo religaria a TV. Falha de envio não conta, e pressão longa
  (`START_LONG`/`END_LONG`) não passa por essa regra. O mecanismo `blocked_keys` de `tv_key_handler` continua
  disponível para bloquear teclas (resposta `key_blocked`), mas a lista padrão é vazia.
- **Desligar com leitura (`tv.power.off.v1`).** O agente que declara a capacidade `tv.power.off.v1` (Android e Samsung)
  atende o pedido explícito de desligar, e é só a ele que a API o manda. Antes de apertar `POWER` ele **lê a energia
  da TV**: no Android vale o aviso que a TV empurra na conexão aberta agora (um aviso de uma sessão antiga nunca vale), na
  Samsung é uma consulta nova ao REST da TV (`PowerState`, em que `standby` conta como desligada). Só com a TV lida como
  ligada a tecla sai, **uma vez**, direto no driver (sem a repetição que os outros comandos fazem depois de uma queda do
  canal), e o agente espera a confirmação: o aviso de desligada, a consulta que diz desligada, ou a sessão que cai com a TV
  sumindo da rede. O resultado vai no `command.result.v1`: `ok` é `off`; as falhas trazem o código `already_off` (leu a
  TV desligada, nenhuma tecla), `uncertain` (sem leitura, sem confirmação, ou falha no envio: a tecla **não é
  repetida**), `offline` (a TV não atende; nada é enviado) e `failed`. Este caminho **nunca** usa o Wake-on-LAN: desligar
  não pode ligar a TV, ao contrário da tecla `POWER` comum com a TV fora da rede. Dentro dos 60 s de um Wake-on-LAN ou dos
  10 s de um `POWER` anterior, nenhuma tecla é enviada. Os dois tempos de espera acima são valores iniciais, a ajustar
  depois de medir na TV real; agente sem esta capacidade segue com o `POWER` de sempre.
- **Depois do `POWER`** a TV em standby derruba a sessão: se ela avisou antes (`power: off` com `connection: hot`)
  o estado sai assim; em seguida a sessão cai (`disconnected`, `power: unknown`) e o agente tenta reabrir com a
  espera de 1, 2 e 4 s, uma vez, sem laço. A reabertura em segundo plano acontece **uma vez por uso**: se a TV
  aceitar a sessão e a derrubar de novo sem que ninguém tenha usado o controle desde então, o agente não insiste
  e espera o próximo comando ou `tv.wake.v1` (que reabre a sessão e volta a permitir a recuperação). O app pede
  `tv.wake.v1` de tempos em tempos enquanto a tela do controle está aberta: ele só reabre a sessão (a TV em
  standby, sem rede, dá `tv_unreachable`).
- **Links:** `tv.app.launch.v1` com `kind=link` só abre os esquemas `https`, `http`, `market` e `vnd.youtube`
  (`intent://`, `file://` e afins são recusados). `kind=package` abre o app pelo ADB; sem `adb` neste PC responde `unsupported`.
- **Rede e Configurações:** `tv.settings.open.v1` (`screen`: `WIFI` ou `SETTINGS`) abre pelo ADB a tela de rede ou as
  configurações da Android TV, com `am start -a android.settings.WIFI_SETTINGS` ou `android.settings.SETTINGS`. A lista é
  fechada nas duas pontas: o agente recusa (`invalid_target`) qualquer nome fora dela e o adaptador só monta o comando a
  partir da tabela, nunca do texto recebido. O comando só chega quando alguém toca no botão do app (nunca por conta do
  agente, e não é de `user_initiated`: só o "Atualizar lista" pode abrir o aviso do ADB na TV). A capacidade
  `tv.settings.open.v1` é declarada junto com `tv.adb`, só depois de a rota pública `devices/info` listá-la em `features`
  (a mesma regra do pareamento e da presença), e **a Samsung não a declara** (não há canal para isso): o app esconde as
  linhas. "Entradas" não usa isto: é a tecla `INPUT` que o controle já tem.
- A biblioteca não avisa quando a conexão cai e **descarta em silêncio** a tecla enviada depois da queda; por
  isso o adaptador vigia a queda e o gerenciador reabre a sessão (com a mesma espera de 1, 2 e 4 s).
- **TV em standby** desliga a rede e não responde nada: cada comando espera as tentativas (até ~27 s no pior
  caso: 4 tentativas de 5 s mais 1 + 2 + 4 s) e responde `tv_unreachable`. Só uma **recusa ativa** da conexão
  (porta fechada, serviço do controle morto) sinaliza `needs_repair` ao vigia; ficar sem resposta não.
- **Serviço do controle morto** (porta recusada com a TV na rede): o vigia o religa por ADB (seção abaixo).
- Medições na TV real (`tools/measure_tv_session.py`, somente leitura): mortes do serviço por hora com e sem
  sessão, memória e tempo de religação. Nunca envia tecla de energia. **Pare o agente e o vigia antigo antes de
  medir**: a ferramenta usa o mesmo certificado e o ADB aceita um cliente por vez.

### Permissão do ADB: uma vez, por TV, e nunca mais sozinha

O aviso "Permitir depuração USB" da TV é o único que o agente pode provocar sem querer, então a regra é: **o agente
nunca abre uma conexão ADB nova com uma TV que ainda não deu e provou a permissão**. Só um pedido da pessoa no app
o faz (**Atualizar lista** e as ações do TV Livre; ler o estado do TV Livre não conta). A marca do pedido pertence à
tarefa que o recebeu: o que ele deixa rodando em segundo plano não a herda.

- **Só logo depois de alguém tocar na tela da TV no app.** Mesmo com a permissão provada, um caminho automático
  só abre uma conexão ADB **nova** até 60 s depois de um `tv.presence.v1`. A tela da TV o manda **só quando alguém
  toca nela** (toque ou tecla, no máximo um a cada 5 s) e antes de abrir um app ou limpar a TV; **nunca por tempo**,
  então uma aba visível e esquecida num monitor ou num tablet fixo não mantém janela nenhuma aberta. Tecla, texto,
  atalho do iPhone, `tv.wake.v1`, energia agendada e configuração da limpeza, sozinhos, **não** contam: o servidor
  ou um atalho sem pessoa na tela também os manda. Fora da janela (partida do agente, vigia, limpeza e foco
  automáticos, ícones) o ADB só usa um transporte que já está aberto; a recusa tem código próprio, `adb_idle` (não
  é "a TV não deu a permissão"). Os pedidos que levam a marca de pedido da pessoa (**Atualizar lista**, TV Livre)
  abrem a conexão sem depender do sinal. Não há contato periódico: o vencimento de 7 dias é desligado na primeira
  permissão (de novo em cada permissão nova, depois de um reset), e qualquer conexão ADB zera a contagem.
- **A chave.** O `adb` do PC assina com `adbkey`, da pasta `.android` do usuário (no Windows ela não muda por
  variável de ambiente, e o aviso da TV sempre oferece essa chave). Cada chave válida é copiada para
  `tv/.adb-key/<resumo>/`, pasta restrita ao usuário, na instalação (atualização e reinstalação não a tocam).
  Cópias de chaves diferentes convivem; cópia truncada ou adulterada (o resumo não confere com o nome) é ignorada.
  A gravação é segura com vários processos: pasta provisória própria (pid e sufixo aleatório), troca só se o destino
  não existe, e uma cópia que confere nunca é apagada nem substituída.
  Só vale como inválida a chave vazia ou truncada (começa com `-----BEGIN` e não termina); a de formato desconhecido
  é do usuário: não é tocada e nada é registrado em nome dela. Se o `adbkey` sumir ou estiver inválido, a cópia da chave registrada volta **antes** de qualquer chamada ao `adb`
  (senão ele gera outra e a TV pergunta de novo); a chave inválida fica em `adbkey.invalido`. Uma chave válida e
  diferente nunca é sobrescrita. O resumo da chave é tirado **antes** de conectar: se o `adbkey` mudar no meio
  (o Android Studio mexe nele), nada é registrado nem guardado em nome da chave errada.
- **O registro e a identidade da TV.** `tv/<tv>/adb-authorization.json` guarda, por TV, o estado (`granted`,
  `verified` ou `needs_user`), o resumo da chave, o endereço e a porta, o **MAC** (tabela ARP, sem ADB: um TCP
  aberto e fechado na porta 5555 popula a tabela e não inicia aperto de mão) e o serial do aparelho. O agente só
  conecta sozinho com `verified` **e** a mesma chave, o mesmo endereço e o mesmo MAC. Outro `tv_host`, outro
  aparelho no mesmo IP ou outra chave fecham a porta. TV que não atende na rede dá `adb_unreachable` sem chamar o
  `adb`. Se uma conexão automática (dentro dos 60 s do último toque) voltar `unauthorized` (reset de fábrica, permissão
  revogada), o registro vira `needs_user` na hora, em disco: vale **uma** tentativa, com a pessoa diante da TV, e
  depois nenhuma, nem depois de reiniciar o agente, até um toque da pessoa.
- **A capacidade `tv.adb` vai sempre ao `hello`** quando há `adb` neste PC, com ou sem permissão: o app só mostra
  **Atualizar lista** (o único toque que pede a permissão) a quem a tem. Nada fica exposto: toda rota automática por
  trás dela passa pela trava.
- **Sem registro, ou só `granted`:** nenhuma rota automática conecta (partida, lista diária, limpeza, ícones, vigia,
  canal opcional da sessão): só leem o estado com `get-state`, que não abre conexão. Um transporte que já estava
  aberto pode continuar em uso, mas nada é registrado a partir dele (pode ser um "Permitir" de uma vez só).
- **Fluxo de um toque.** O toque conecta e deixa o aviso na TV (o app mostra `adb_unauthorized` e a dica). O agente
  espera o aceite até 90 s **só lendo `get-state`**: nunca reconecta e, enquanto espera, mantém a conexão para ver o
  `device`; ao terminar (aceite, fim da janela ou recusa) a desfaz com `adb disconnect`, salvo se já estiver provada.
  Quando a TV diz `device`, registra `granted`, roda `settings put global adb_allowed_connection_time 0` (confere com `settings get`) e anota o
  serial (`getprop ro.serialno`, uma leitura de shell: em transporte TCP o `adb get-serialno` devolve só `host:porta`;
  não conferido na TV real), tudo sobre o transporte já autorizado. O Android 11+ revoga a permissão do ADB
  que ficou 7 dias sem uso, e `0` desliga esse vencimento (AOSP, `AdbDebuggingManager`); só a resposta da TV conta
  como tentativa (3 recusas dela encerram o ajuste), nunca tempo esgotado ou transporte caído.
- **A prova.** Um "Permitir" sem "Sempre permitir" vale só para aquela conexão. Por isso `granted` ainda não deixa o
  agente conectar sozinho: o **toque seguinte** em **Atualizar lista** abre uma conexão **realmente nova**
  (`connected to`, nunca `already connected`) e, se a TV a atender com `device` e sem aviso, o registro vira
  `verified`: como a espera do aceite já desfez a conexão do `granted`, essa conexão nova é a prova, sem
  reconexão a mais. Sem um `granted` anterior (toque que já encontra um transporte vivo), a prova é um
  `disconnect` e uma `connect` nova. Se vier `already connected` (o `disconnect` não derrubou o transporte) a
  conexão serve, mas nada é dado como provado. Dentro do pedido da pessoa, e só com a permissão já dada, um
  `offline`, `authorizing` ou `connecting` logo depois do `connect` é relido por até ~3 s antes de valer (a
  conexão pode ainda estar subindo).
  **`unauthorized` nunca é relido:** o aviso real aceito sem "Sempre permitir" não deixa a chave gravada, e ler o
  estado não separa isso da autenticação ainda correndo. Um `unauthorized` visto num pedido da pessoa (mesmo com o
  registro `verified`, depois de um reset) rebaixa para `needs_user`; a espera do aceite regrava `granted` sem herdar
  o ajuste do vencimento nem o serial (o passo do vencimento se refaz) e a prova fica para o toque seguinte. Se o aviso voltar, é nesse toque, com a pessoa
  na TV. Sem MAC na ARP (VPN, outra sub-rede) a prova se completa com chave, endereço e MAC vazio e não se repete a
  cada toque; só a conexão automática continua exigindo o MAC.
- **O serial** (`getprop ro.serialno`, leitura de shell) só é lido dentro de um pedido da pessoa, nunca num caminho
  automático. Se o aparelho que responde tem outro serial que o anotado, o agente esquece o serial e o ajuste e
  refaz a prova dentro do mesmo toque, anotando a identidade nova (sem trava eterna, e sem `needs_user`).
- **O registro é relido do disco** quando o arquivo mudou (horário e tamanho) antes de decidir e antes de gravar: o
  agente e o `tv-volume` não sobrescrevem um ao outro. Se uma gravação falhou (disco, arquivo em
  uso por mais de cinco tentativas) e outro processo grava depois, **a mais restritiva vence**: um `needs_user`
  pendente é reaplicado por cima do que foi relido; qualquer outra mudança pendente é descartada com aviso no log.
  A troca do arquivo (`os.replace`) tenta de novo em caso de `PermissionError`, sem dormir dentro do laço de eventos,
  e a gravação que falha não deixa o `.tmp` para trás. `needs_user` também apaga o serial anotado: a leitura
  `getprop ro.serialno` roda de novo na prova seguinte.
- **O vigia e a janela de presença:** com o ADB fora da janela (`adb_idle`) o vigia não insiste: uma tentativa, o
  evento `adb_unreachable` (`info`) diz que o ADB só abre com alguém usando a TV pelo app, e descansa o degrau curto.
  Sem o MAC na ARP (VPN, outra sub-rede) o código é outro, `adb_identity` (`AdbIdentityUnconfirmed`), com mensagem
  própria no app e no evento: a causa é a rede, não a falta de uso.
- **O registro só cai para `needs_user` por uma recusa explícita da TV** (`unauthorized` ou falha de autenticação do
  `adb`). A recusa da trava (sem presença, sem MAC, permissão só `granted`) e o vigia vendo a TV desligada não gravam
  nada nem perdem o ajuste do vencimento.
- **`uniover-agent tv-volume`** monta o `AdbTv` com a mesma trava e roda como pedido de quem o digita.
- **Ao atualizar:** a API anterior recusa o `hello` inteiro que traz uma capacidade que não conhece, então o agente só
  declara `tv.presence.v1` depois de a rota pública `devices/info` listá-la em `features` (a mesma regra do
  diagnóstico). Agente novo diante de API antiga segue funcionando e só não tem a conexão automática; publicar a API
  antes continua sendo o caminho, mas a ordem inversa não derruba o agente. Quem atualiza não tem registro de
  permissão: a lista diária, a limpeza, os ícones e abrir apps pela Siri ficam parados até tocar **uma vez** em
  **Atualizar lista**.
- **Nada não provado fica no servidor do `adb`.** O servidor do `adb` religa sozinho as conexões TCP feitas com
  `adb connect`, e cada religação de uma TV que não guardou a permissão mostraria o aviso sem ninguém ter pedido.
  Por isso todo pedido da pessoa que **não termina em `verified`** (fim da espera de 90 s, recusa, ou parado em
  `granted`) termina com `adb disconnect <host:porta>` antes de responder, e uma recusa num caminho automático
  desfaz a conexão na hora. Provada, a conexão fica.
- **Hibernação.** Com o registro `verified` (mesma chave, endereço e MAC) a hibernação por ociosidade da sessão
  **não** desconecta o canal ADB: a chave gravada não mostra aviso, e é isso que mantém a lista diária, a limpeza, os
  ícones e abrir app pela Siri funcionando fora da janela de presença. Sem `verified`, desconecta como sempre.
  O canal só fica com o vencimento de 7 dias desligado (`timeout_disabled`) além do `verified`: sem isso a TV ainda
  pode revogar a chave por falta de uso, e o servidor do `adb` religaria o canal sozinho depois. **Resíduo
  aceito:** uma revogação deliberada ("Revogar autorizações de depuração USB") ou um reset de fábrica com o canal
  aberto pode mostrar **um** aviso pela religação do próprio servidor do `adb` antes de o agente receber o
  `unauthorized` e rodar o `adb disconnect`; depois disso nada o reabre.
  **Limitação:** isso só vale **enquanto o transporte sobrevive**. Depois que a TV desliga (o servidor do `adb` acaba
  desistindo de religar) ou o PC reinicia, o canal some e uma conexão nova só se abre com alguém usando a TV pelo app
  (a janela de presença) ou num pedido da pessoa: até lá, Siri, agendamentos e limpeza respondem `adb_idle` mesmo com a
  permissão `verified`. É a regra ("nenhum aviso sem ninguém diante da TV"), e custa essa disponibilidade.
- **Revogação com o canal aberto.** Se a TV revoga a permissão (ou é resetada) com o canal mantido, o próximo comando
  automático recebe `unauthorized`: o agente grava `needs_user` e roda `adb disconnect` na hora (também na limpeza, nos
  ícones, no foco e na cópia de APK), senão o servidor do `adb` religaria sozinho e cada religação abriria o aviso. A
  mesma limpeza acontece na partida e no encerramento do agente: transporte sem prova que sobrou de outra execução não
  fica no servidor do `adb`.
- **MAC lido vazio num toque** (ARP vazia) é desconhecido, nunca "outra TV": não apaga o MAC anotado, não perde o
  ajuste do vencimento nem o serial e não refaz a prova. Só dois MACs lidos e diferentes são aparelhos diferentes.
- **Presença atrasada:** o agente ignora um `tv.presence.v1` com mais de 15 s de idade (pelo `ts` do envelope); o
  gateway pode segurar a entrega enquanto o agente reconecta, e a janela de 60 s tem de contar do toque. A idade vale
  de -5 s a +15 s (folga para o relógio do PC estar um pouco atrás do da API); fora disso o sinal é recusado. Só uma
  idade negativa além da folga, ou acima de 120 s, aponta o relógio: então o agente avisa **uma vez** no log e registra
  `tv.presence_clock_skew` (um atraso comum de entrega, de 15 a 120 s, recusa o sinal sem alertar). O registro vai ao
  diagnóstico (`agent.diagnostics.v1`, repetições agrupadas): relógio fora de hora derrubaria a presença sem ninguém ver. O `hello` com
  `tv.presence.v1` sai assim que a API passa a listá-la em `features`, sem esperar os 5 minutos do `hello` repetido.
- **O que o dono faz, uma vez por TV:** tocar em **Atualizar lista**, marcar **Sempre permitir neste computador** no
  aviso da TV e aceitar; depois tocar em **Atualizar lista** mais uma vez (a prova). Um reset de fábrica da TV exige
  repetir. No app, quando um atalho (ou a limpeza, ou o TV Livre) falha por falta de permissão, uma folha curta
  oferece **Pedir na TV** (o mesmo pedido de **Atualizar lista**) e o aceite na TV vira um recado fixo no celular.
- **IP novo da mesma TV:** o registro vale para um endereço **e** um MAC. Depois de uma queda de luz o roteador pode dar
  outro IP à TV (o vigia do endereço a reencontra e o agente recomeça); a permissão do ADB é da chave na TV, não do
  endereço, então o registro acompanha: com o registro `granted` ou `verified`, a mesma chave e **os dois MACs lidos
  e iguais** (ARP, sem ADB e sem aviso na TV), o endereço novo herda tudo. MAC vazio, ou de outro aparelho, nunca
  adota e continua barrado: com permissão dada e outro MAC no endereço (outro aparelho tomou o IP), o agente se recusa
  a conectar, até a pedido da pessoa (`adb_device_changed`, "TV não encontrada no endereço"), sem registrar falta de
  permissão. A sondagem da ARP só acontece quando adotar é possível (permissão dada, mesma chave, MAC anotado). Antes disso, um IP novo fechava o portão e todo atalho dizia `adb_unauthorized` sem a
  TV ter sido consultada.
- **A saída do bloqueio ("É a mesma TV"):** quando o MAC no endereço não é o do registro, o agente se recusa a conectar
  e o app mostra a folha "TV não encontrada no endereço". Se a pessoa confirma (pergunta de confirmação no app) que é a
  mesma TV (trocou de Wi-Fi para cabo, por exemplo), o app manda `tv.adb.rebind.v1` (capacidade `tv.adb.rebind.v1`,
  rota `POST /api/v1/tv/adb/rebind`, na trilha como `tv.adb.rebind`): o agente lê o MAC de agora e refaz o registro
  (`granted`, sem prova; serial e ajuste do vencimento recomeçam). **Não conecta a nada**; o pedido de permissão de
  sempre vem em seguida. Um pareamento novo da Android TV (**Parear de novo**, também pedido pela pessoa) apaga o registro
  do ADB. Nenhum caminho automático troca o aparelho do registro.
- **O que o app fica sabendo (`adbPermission` no `tv.state.v1`):** `granted` (a TV aceitou: conexão aberta, `device`
  visto), `missing` (o agente não usa o ADB sem a pessoa pedir) e `pending` (o aviso está na TV, esperando o
  aceite). Só vai à API que lista `tv.state.adb_permission` em `features`. Cada mudança também vira uma ocorrência de
  diagnóstico `adb.permission.<estado>` com o **motivo** (`never`, `tv_refused`, `tv_forgot` (a TV recusou uma chave
  que já tinha aceitado), `unproven`, `key_changed`, `address_changed`, `device_changed`, `mac_unknown`,
  `prompt_on_tv`, `prompt_expired`, `accepted`, `connected`); nunca IP nem MAC. O motivo de `missing` vai ao app em
  `adbPermissionReason`: só `tv_forgot` abre a folha de pedido sozinha. Um pedido da pessoa (Atualizar lista, TV Livre) não
  fica preso na recusa guardada de 30 s de um caminho automático: conecta de verdade e espera o aceite.
- **Samsung e Remote v2 já seguiam a regra:** o token Samsung e a marca "permissão necessária" ficam no cofre e
  nenhuma rota volta a pedir o "Permitir" sozinha; o par certificado/chave do Remote v2 fica em `tv/<tv>` e só o
  `tv-pair` explícito o cria.

### Vigia do serviço do controle

Algumas TVs matam o serviço do controle remoto (`com.google.android.tv.remote.service`, portas 6466 e 6467) por
falta de memória; sem ele a sessão não abre até alguém religá-lo. O vigia faz isso pelo ADB, no lugar da tarefa
agendada do PC.

- **Sem sondagem própria.** Ele só age quando recebe o aviso de uma porta **recusada** (a TV respondeu e fechou a
  porta): do vigia do endereço, na conferência que já faz a cada minuto sem sessão, e da sessão, se a conexão
  chegar a ser recusada (o teste de vida de 1,5 s antes da conexão não distingue recusa de silêncio: no Windows
  a recusa só aparece depois de ~2 s, e esperar mais atrasaria a resposta de uma TV em standby além do prazo do
  servidor). Na prática o serviço morto é religado em até um minuto. TV em standby não responde nada, não conta como recusa e nada é feito. Cada aviso vira, no máximo, duas
  conexões TCP para confirmar.
- **Reparo limitado.** Confirmadas as portas fechadas, a sessão passa a `repairing` (os comandos recebem
  `tv_unreachable` com a dica "religando o controle da TV"), o agente reconecta o ADB e roda o `reparar` do projeto
  da TV: proteger o serviço do matador de memória (`dumpsys deviceidle whitelist`, `cmd appops set ...
  RUN_ANY_IN_BACKGROUND allow`, `am set-standby-bucket ... active`) e iniciá-lo (`am start-foreground-service`).
  Confere as portas 3 s depois. No máximo **3 tentativas** (na hora, depois de 15 s e de 45 s), com teto de 240 s
  para tudo; falhou, descansa **10 minutos**. A sessão nunca fica presa em `repairing` (`finally` e o teto).
  Sem autorização no ADB ou sem o `adb`, para na primeira tentativa e descansa **1 hora**. Não envia tecla
  nenhuma, nunca a de energia.
- **Eventos `tv.watchdog.v1`** (`repair_started`, `repaired`, `repair_failed`, `adb_unreachable`) com texto fixo,
  sem endereço nem saída de comando: o mesmo tipo não repete em menos de 60 s; sem conexão com a API ficam numa
  fila em memória (até 100) e saem depois do `hello`.
- **Desligue o vigia antigo do PC** (tarefa agendada ou laço oculto que roda `vigiar-tv.ps1`): dois reparadores
  disputando o ADB religam em duplicidade. Na tarefa, `Disable-ScheduledTask -TaskName "ESP32 - vigia da TV"`.
  `UNIOVER_TV_WATCHDOG=0` desliga o vigia do agente, se preferir manter o antigo.
- Não faz parte dele: `am kill-all` e fechar apps antes do reparo (existe a limpeza da TV, por comando), e
  detectar sessão "zumbi" (a biblioteca já fecha a sessão de uma TV que para de pingar, 16 s, e a sessão reabre).

## Limpeza da TV

`tv.cleanup.v1` fecha os apps abertos na TV e libera memória pelo ADB, **sem derrubar a conexão**: nada na
sequência toca no serviço do controle remoto (a sessão Remote v2), no próprio ADB nem na rede. Sem `adb` neste PC o
comando é recusado como qualquer outro que dependa dele. A TV da casa tem pouca RAM e o limpador do fabricante
chegou a matar o serviço do controle quando faltava memória: liberar memória antes ajuda a mantê-lo de pé.

O que o agente roda, nesta ordem, cada um por `argv` em lista (o único dado variável, o nome do pacote, é validado
pelo mesmo padrão de `launch_package` e vai entre aspas simples), com tempo-limite de 5 s e a trava do ADB tomada só
durante cada comando (digitar e abrir app continuam funcionando enquanto a limpeza trabalha):

| # | Comando no shell da TV | Para quê |
|---|---|---|
| 1 | `grep MemAvailable /proc/meminfo` | memória disponível **antes**; também testa o ADB: se falhar, a resposta é um erro com código estável (`adb_unreachable`, `adb_unavailable`, `adb_unauthorized` ou `adb_timeout`) e nada mais roda |
| 2 | `cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER` (e, se vier vazio, `...LAUNCHER`), mais `pm list packages -3` | os apps que a TV mostra para abrir (a mesma fonte da lista de apps da tela) |
| 3 | `cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME` | quem atende a tela inicial: protegido |
| 4 | `settings get secure default_input_method` e `settings get secure enabled_accessibility_services` | o teclado em uso e os serviços de acessibilidade: protegidos |
| 5 | `ps -A` | quais apps estão **rodando**: só esses são fechados e contados |
| 6 | `input keyevent KEYCODE_HOME` | o app da frente passa a ser "de fundo" |
| 7 | `am kill-all` | encerra só processos de fundo e em cache |
| 8 | `am force-stop '<pacote>'` | um por app em execução que não esteja protegido |
| 9 | `grep MemAvailable /proc/meminfo` | memória **depois** (o valor liberado nunca é negativo) |

Nunca: `kill-server`, `disconnect`, `reboot`, `pm clear`, `pm uninstall`, `pm disable`, `drop_caches` (exige root).
`pm trim-caches` também fica de fora: ele libera armazenamento, não memória. Um teste confere que nenhum desses
comandos chega ao `adb`.

**Lista protegida (nunca fechada, mesmo que apareça como app):**

- o serviço do controle remoto, `com.google.android.tv.remote.service` (fonte: o projeto da TV do dono, que o religa
  por esse nome, medido na TV real). As variantes dele não foram confirmadas: por isso **todo pacote com `remote` no
  nome** também é protegido;
- `android` e `com.android.systemui` (framework e interface);
- `com.android.tv.settings` (Configurações, como a TV real lista) e `com.android.settings`;
- `com.google.android.gms` e `com.google.android.gsf` (serviços do Google Play);
- `com.google.android.tvrecommendations` (recomendações do lançador);
- `com.android.providers.` e tudo que começa assim (provedores do sistema);
- o que a lista de apps da tela esconde como peça do sistema da TV: `com.tcl.`, `com.mediatek.`, `com.droidlogic.`,
  assistentes de configuração e de fábrica;
- **lidos da TV a cada limpeza:** todo pacote que atende a tela inicial (HOME), o teclado em uso e os serviços de
  acessibilidade ligados;
- o que o dono listar em `UNIOVER_TV_CLEANUP_KEEP`.

Se qualquer leitura de proteção falhar (tela inicial, teclado, acessibilidade ou processos), **nenhum app é fechado**:
ler errado não pode virar "nada a proteger". Se o ADB some no meio, a limpeza para ali. A limpeza se dá 15 s para
agir; o que passar disso é pulado. Em todos os casos a resposta diz o que não foi feito (`failedSteps`).

A limpeza roda **em tarefa própria**, fora do laço de mensagens: leva vários segundos e, no laço, seguraria todas as
teclas atrás dela. Uma por vez: um segundo pedido com outra em andamento responde `cleanup_in_progress`. O resultado
volta em dois quadros, nesta ordem: `tv.cleanup.result.v1` (apps fechados, memória antes e depois, etapas que
falharam, com o `requestId` do pedido) e `command.result.v1`. O registro (`INFO`) leva só contagens e MB.

A primeira execução deve ser feita com a TV ligada, sabendo que **o app que estiver passando vai fechar**.

## Ligar a TV TCL pela rede: conferência dos ajustes

Ligar a TV pelo app (Wake-on-LAN) depende de ajustes da própria TV. O agente **só lê** um deles e conta ao app quando
está desligado; nunca grava nada na TV e nunca abre o aviso de permissão do ADB (a leitura usa a mesma trava dos outros
caminhos automáticos: só um canal que a pessoa já liberou).

A leitura vai junto da avaliação diária da limpeza (a primeira sessão do dia, e a primeira depois de o agente subir):
nenhum laço novo, um comando fixo por dia, `argv` em lista:

```
echo uniover_maker=$(getprop ro.product.manufacturer); echo uniover_powerloss=$(getprop persist.tcl.powerloss); echo uniover_screenless=$(settings get secure smart_audio_switch)
```

| Ajuste no menu da TV | Onde fica | Como o agente sabe | Certeza |
|---|---|---|---|
| Screenless service | Configurações > Sistema > Energia | `settings get secure smart_audio_switch`: `1` ligado; `0` ou `null` desligado | média: o menu grava essa chave numa TCL C06 (Android TV 11), lido pelo ADB em 09/11; outros modelos TCL não conferidos |
| Networked standby | Configurações > Rede e Internet | não sabe: o serviço próprio da TCL grava (`setNetworkWakeupMode`), sem chave em `settings` | só citado no passo a passo do app |
| Quick Start | Configurações > Sistema > Energia | não sabe: também pelo serviço da TCL (`strSuspendSetStatus`) | só citado no passo a passo do app |
| Liga quando a energia volta | (de fábrica) | `getprop persist.tcl.powerloss` = `true` | média: valor lido na C06; que ela liga sozinha quando a energia volta é o observado em casa, ainda não medido |

Em TV de outra marca (`ro.product.manufacturer` diferente de TCL) nada é avisado. O que sai no `tv.state.v1`
(`wakeHints`, só para a API que lista `tv.state.wake_hints`):

- `screenless_off`: o Screenless service está desligado; o app mostra o caminho no menu para ligá-lo;
- `replug`: o Wake-on-LAN saiu e a TV não respondeu na espera, numa TV com `persist.tcl.powerloss=true`; o app sugere
  tirar da tomada e ligar de novo. Some quando a TV volta a responder.

Leitura que falha (TV fora, ADB sem permissão) não muda nada: vale a última conhecida.

## TV Livre (launcher próprio da Android TV)

Só para Android TV e Google TV com Android 9 ou mais, e só com o `adb` neste PC. O agente anuncia a capacidade
`tv.livre.v1`; a TV Samsung nunca a recebe. **Nada acontece sozinho**: cada passo é um comando do dono, feito pela
tela da web, e todos são reversíveis. A sequência é a do README de `apps/tv-launcher`:

1. **Instalar**: lê a versão do Android, captura o launcher de fábrica e **ensaia a volta**
   (`set-home-activity` do original precisa responder `Success`); sem esse ensaio nada é instalado. Baixa o APK da
   publicação (`UNIOVER_TV_LIVRE_APK_URL`, padrão a última publicação do repositório, só HTTPS), confere o sha256
   publicado ao lado (`uniover-launcher.apk.sha256`, integridade do download) e **a assinatura** contra o
   certificado fixado em `UNIOVER_TV_LIVRE_SIGNER_SHA256` (padrão: a chave do projeto, com o `apksigner` do Android SDK); só então instala e abre o app, conferindo que ele de
   fato iniciou. O launcher de fábrica segue como padrão.
2. **Aplicar a configuração**: envia `config.json` (e `wallpaper.jpg`) como `.tmp` e renomeia, ou, se a pasta do app
   não existir, pelo broadcast (sem foto). A configuração é conferida pelo agente contra o contrato.
3. **Definir como padrão**: antes de tocar na tela inicial confere que a home nova abre e fica de pé; só vale depois
   de verificar com `resolve-activity` e de a Home abrir de verdade (`am start` sem erro e o processo vivo); se
   alguma conferência falha, devolve o original.
   O launcher de fábrica só é desativado se o dono pedir, e depois dessa verificação.
4. **Voltar ao Original**: reabilita, define o original, verifica e **só então** desinstala.
   Se não der para confirmar a tela inicial original, nada é desinstalado.

O que foi desativado e o launcher de fábrica ficam em `tv-livre-<endereço da TV>.json` na pasta de instalação,
gravados antes de cada passo; o mesmo arquivo guarda as últimas 50 ações (auditoria local). Desativar app usa
`pm disable-user` (reversível) com lista de proteção própria: o launcher de fábrica e o novo, o teclado e os serviços de
acessibilidade em uso, o serviço do controle remoto, as Configurações e as peças do sistema.

`UNIOVER_TV_LIVRE=0` desliga o módulo neste PC. Limite honesto: o hash vem do mesmo endereço do APK, então a conferência
protege de download corrompido; a autenticidade vem do certificado fixado (sem ele o agente não instala).

## Ícones dos apps da TV

Com o `aapt2` do Android SDK no PC, a lista de apps (`tv.apps.v2`) leva o ícone de cada app: o agente copia o
APK pelo ADB (sem a trava dos comandos curtos), lê só a imagem de dentro dele e a manda em `data:` URI. Sem
`aapt2` a lista segue sem ícones. Regras da escolha:

- **Só ícone quadrado.** Largura igual à altura, PNG ou WebP, até 32 KB: a tela mostra azulejos quadrados. O
  `banner` 16:9 do lançador da TV **nunca** é usado. App sem imagem quadrada fica sem ícone (a tela mostra a
  inicial) e o motivo vai ao log em `INFO` (`app <pacote> ficou sem ícone: ...`), sem o conteúdo da imagem.
- **Onde procurar.** Nas linhas `application-icon-*` do `aapt2 dump badging`. Ícone adaptativo (XML), que a tela
  não desenha, quase sempre traz o ícone legado em PNG/WebP no **mesmo recurso**, e ele só aparece em
  `aapt2 dump resources` (pedido só quando o `badging` não deu uma imagem quadrada). As camadas do adaptativo
  (`foreground`/`background`) nunca entram: são quadradas, mas não são o ícone.
- **Tamanho padronizado.** Não há biblioteca de imagem para reduzir; por isso, entre as imagens quadradas do APK
  que cabem no teto, vale a **maior de até 192 px** de lado (o ícone de lançador `xxxhdpi`). Se todas passam de
  192 px, vale a menor delas.
- **APK dividido.** O ícone sai do `base.apk` (ou do único APK de um app de sistema). Só se o principal não tiver a
  imagem o agente olha o APK de densidade (`split_config.<densidade>.apk`); os de idioma e de arquitetura não são
  copiados.
- **Cache** por pacote e versão do app, inclusive "esta versão não tem ícone" (para não baixar dezenas de MB a
  cada atualização da lista). Uma mensagem sem `icon` quer dizer "mantenha o que já tem": app que ficou sem ícone
  não apaga o que a API já guardava.

## Manutenção remota

Só o administrador, pela tela de Aparelhos do app, sem a pessoa do PC fazer nada. O agente anuncia as capacidades
`agent.logs.v1` e `agent.maintenance.v1` no `hello` (que também traz o commit instalado, o sistema e a TV controlada).

- **Ver registro** (`agent.logs.request.v1`). O agente lê o fim do **próprio** arquivo de registro (o da
  configuração local, `logs\agent.log`; nunca um caminho vindo da rede), tira o que parece segredo e responde
  `agent.logs.v1`. A higienização (`core/redaction.py`) vem **antes** do corte por tamanho e troca por `[removido]`:
  `Bearer ...`, o cabeçalho `Authorization` inteiro, JWT, `uo_dev_...`, campos `token`, `access_token`,
  `refresh_token`, `device_code`, `password`, `senha`, `secret`, `codigo`..., o código curto do pareamento
  (`ABCD-EFGH`), o `deviceCode` (43 caracteres em base64url) e o token deste agente por igualdade. O quadro cabe nos
  64 KB do canal: linhas antigas saem até caber (`truncated`). Lê no máximo os últimos 512 KB do arquivo.
- **Atualizar agora** e **Reiniciar o agente** (`agent.maintenance.v1`). O agente cria `runtime\update-now` ou
  `runtime\restart-now`, os mesmos arquivos do menu da bandeja, e responde. Quem age é o supervisor (`run-agent.ps1`,
  a cada 15 s): atualizar só reinicia se houver versão nova; reiniciar mata e sobe o agente. O agente **não sai por
  conta própria**: uma saída passaria pela contagem de quedas do supervisor, que pode reverter uma atualização em
  teste e aumenta a espera. Rodando em um terminal, sem supervisor, o arquivo fica esperando um.
- **Voltar para a versão anterior** (`agent.maintenance.v1`, `rollback`). Só vale se `app.previous` existe (a última
  atualização o guarda): o agente cria `runtime\rollback-now` e o supervisor, se o pedido tem menos de 10 minutos,
  encerra o agente, troca `app` por `app.previous`, guarda a versão que saiu em `app.rejected-*` e em
  `runtime\.blocked-versions` (a auto-atualização não a instala de novo) e reinicia.
- **Estado da atualização** (`runtime\update-status.json`). O `self-update` grava `updating` ao começar e o resultado
  ao terminar (`updated`, `up_to_date`, `failed` com o motivo, `blocked`); o supervisor grava a próxima checagem, a falha
  do próprio processo de atualização e a volta à versão anterior. O agente conectado manda esse estado no `hello`
  (`update`), relê o arquivo a cada 30 s e avisa a API com `agent.update.status.v1` quando muda, além de repetir o
  `hello` a cada 5 minutos. Tudo isso é informativo: arquivo ausente, corrompido ou recusado pelo contrato nunca
  impede o agente de subir, conectar nem de se atualizar.

## Atualização

O canal de produção segue o ramo em `tools/update-channel.json` na `main`; `main` e `develop` no arquivo local são valores legados desse canal. Antes de trocar a pasta, a candidata passa por:
manifesto Ed25519 do Release (quando a assinatura está ativa, ver abaixo), hash SHA-256 do zip autenticado nesse manifesto, zip inteiro e do commit pedido, e
arquivos conferidos contra a árvore do commit no GitHub. Sem assinatura ativa a árvore é obrigatória (indisponível ou
divergente, o pacote é recusado, sem seguir "só com o zip"); com manifesto válido ela é conferência extra: a consulta
falhar só gera aviso, mas divergir recusa. O manifesto traz um número crescente (`sequence`): o agente guarda o maior
em `runtime\manifest-sequence.txt` e recusa manifesto de outro commit com número menor ou igual (rebaixamento). Só então roda
`uv sync --frozen` (as versões do `uv.lock`, sem reescrevê-lo) num ambiente descartável e o auto-diagnóstico dela
(`python -m uniover_agent.selfcheck`, que lê o `agent.toml` real com as regras novas). Versão em prova (menos de 10
minutos estável) não é substituída; atualização que falha tenta de novo em 30 min, 1 h, 2 h... até 6 h. Detalhes e
limites em `adr/0018-manifesto-assinado-do-agente.md`.

### Assinatura do manifesto: ativação em dois passos

Se o manifesto é obrigatório depende da lista de chaves públicas embutida no agente (`MANIFEST_PUBLIC_KEYS` em
`src/uniover_agent/adapters/self_update.py`), nunca de o Release trazer ou não o arquivo. Quem controlasse o Release
poderia simplesmente omitir o manifesto.

1. **Sem chave embutida (estado atual).** A lista está vazia: o agente não consulta o manifesto, segue com o zip e a
   árvore do commit conferida (falha da árvore recusa) e registra uma vez por execução que a assinatura ainda não está
   ativa. No `deploy.yml`, sem o segredo `AGENT_SIGNING_KEY` o job `sign-agent-manifest` apenas emite `::warning::` e a
   publicação segue; com o segredo, ele assina e anexa `uniover-agent-manifest.json` ao Release. Se o commit publicado
   já embute chave e o segredo falta, o job **falha**: versão com chave não sai sem manifesto. Para chegar ao passo 2:
   o dono gera o par, cadastra a privada como segredo e a pública entra no código, numa versão publicada.
2. **Com chave embutida (a partir dessa versão).** Manifesto válido para o commit é obrigatório: sem ele, com assinatura
   que nenhuma chave da lista confere, ou com hash do zip diferente, nada é baixado nem instalado e a instalação em uso
   fica como está. O `deploy.yml` passa a falhar se a chave do segredo não estiver na lista.

Para gerar o par, em uma máquina confiável:

```
uv run --project apps/agent python apps/agent/tools/sign_agent_manifest.py generate-key
```

Guarde `AGENT_SIGNING_KEY` somente como segredo desse nome no ambiente protegido `production` do GitHub. Copie a linha
`AGENT_SIGNING_PUBLIC_KEY` para a lista `MANIFEST_PUBLIC_KEYS` (não existe chave provisória: a lista vazia é o estado
sem assinatura). Para rotacionar, publique primeiro uma versão que contenha as duas públicas, passe a assinar com a
nova privada e só remova a antiga depois que todos os PCs tiverem atualizado.

## Conexão

- `wss://<api>/api/v1/devices/agents/<agentId>/ws`, `ping` a cada 20 s, mensagens de texto JSON de até 64 KB.
- Ao conectar envia `agent.hello.v1` (versão e capacidades: `tv.remote` com a TV configurada e pareada, senão
  nenhuma) e, em seguida, `tv.state.v1` com o estado atual da TV.
- A API aceita o `agent.hello.v1` mínimo da versão `0.1.0`, inclusive sem capacidades. Novas capacidades e campos
  de mensagens precisam ser aditivos: nunca se exige que um agente antigo anuncie algo que ele não conhece.
- Reconexão com espera exponencial e variação aleatória (1 s, 2, 4 ... teto de 30 s), **sem limite de
  tentativas**; a espera volta ao início depois de 60 s de conexão estável.
- Credencial recusada (401/403 na abertura ou fechamento 4403 `revoked`): **para**, avisa para rodar
  `uniover-agent pair` e mantém o token no cofre até o usuário decidir. Fechamento 4409 `replaced` (outra instância do
  mesmo agente assumiu): espera 60 s antes de tentar de novo.
- Fechamento 1012/1001 (a API está trocando de instância): volta em 0,25 a 0,75 s, sem somar à espera crescente. Fechamento
  4411 `server-restart` (a API que vai parar pede "reconecte agora"): volta em 0,2 a 0,5 s, também com jitter. O agente só
  declara a capacidade `transport.restart.v1` (e portanto só recebe o 4411) depois de a API listá-la em `features`; sem ela
  a API usa o 1012 de sempre.
- `status` não abre o canal (uma segunda conexão derrubaria a do agente em execução): confere só se a API responde.

## O que é validado

Toda mensagem recebida passa pelo `EnvelopeGate` **antes de qualquer efeito**: JSON válido, envelope e corpo
contra o JSON Schema do `type` (cópias em `contracts/schemas/`), modelo tipado, `source` igual a `api` e `target`
igual a este agente. Mensagem inválida, de `type` desconhecido ou de versão não suportada **nunca é executada**: vai
para o log (agente, `type` e motivo, sem o corpo) e, se houver `correlationId`, a API recebe `command.result.v1`
com `ok:false` e `error.code = "invalid_message"`. O que o agente envia também é validado antes de sair. Os logs
nunca trazem token, `deviceCode`, cabeçalhos nem corpo completo (as bibliotecas de rede ficam em `WARNING`).

## Arquitetura

- `core/`: casos de uso (`HandleCommand`, `ProcessMessage`, `ConnectionSupervisor`, `PairAgent`) e o `EnvelopeGate`;
  em `core/tv/`, o `TvSessionManager` (sessão quente, hibernação, reconexão), os handlers dos comandos da TV e o
  publicador de `tv.state.v1`, o vigia do serviço do controle (`TvWatchdog`) e a fila dos seus eventos.
- `ports/`: `Transport`, `SecretStore`, `PairingClient`, `Clock`, `TvChannel`, `TvRemote`, `TvAdb`, `TvAdbCleanup` como `typing.Protocol`.
- `adapters/`: `transport_ws`, `secret_store_keyring`, `pairing_http`, `system_clock`, `local_config`,
  `tv_remote_v2`, `tv_pairing` e dublês de teste.
- `contracts/`: modelos e esquemas gerados, não editar.
- `composition/`: a montagem dos adaptadores em `system`, `tv`, `pc`, `pairing`, `connection` e `maintenance`.
- `main.py`: ponto de entrada e linha de comando.

Trocar de transporte (MQTT, depois) é trocar o adaptador: o núcleo não sabe que existe WebSocket.

## Regra do núcleo

`core/` e `ports/` nunca importam `adapters/` nem biblioteca de rede, de cofre ou de TV. O `import-linter`
(`uv run lint-imports`) falha se isso acontecer.

## Ainda fora daqui

Empacotar como instalador nativo; atualização com o agente já rodando (hoje só no início); adaptador MQTT.
