# uniover-agent

Agente local do UniOver (Python 3.14). Roda no PC como processo do usuário e **disca para fora**, para a API:
nunca abre porta.

## Comandos

```
uv sync
uv run uniover-agent pair      # pareia este PC com um código curto
uv run uniover-agent run       # conecta e roda em primeiro plano (é o padrão)
uv run uniover-agent status    # diz se há token no cofre e se a API responde
uv run uniover-agent tv-pair --host <ip-da-tv>   # pareia o agente com a TV (código mostrado na tela)
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

1. `uniover-agent pair` pede um código à API, **mostra** `XXXX-XXXX` e o endereço do app e consulta até o dono
   aprovar (respeitando o intervalo e o `slow_down`) ou o código vencer.
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
| `UNIOVER_TV_CLIENT_NAME` | nome do agente que aparece na TV no pareamento (padrão `UniOver`) |
| `UNIOVER_TV_NAME` | nome da pasta do certificado desta TV (padrão `tv`) |
| `UNIOVER_TV_HIBERNATE_SECONDS` | segundos sem comando até a sessão com a TV hibernar (padrão `300`) |
| `UNIOVER_ADB_PATH` | caminho do `adb` (padrão: procura no `PATH` e em `%LOCALAPPDATA%\Android\Sdk\platform-tools`); habilita lista de apps, abrir app por pacote e digitação pelo ADB |
| `UNIOVER_TV_ADB_PORT` | porta do ADB da TV (padrão `5555`) |
| `UNIOVER_ADB_TIMEOUT_SECONDS` | tempo máximo de cada comando `adb` (padrão `5`) |
| `UNIOVER_ADB_PULL_TIMEOUT_SECONDS` | tempo máximo para copiar o APK de um app da TV (padrão `120`) |
| `UNIOVER_TV_TEXT_BY_KEYS` | `1` digita o acréscimo (só letras minúsculas, dígitos, espaço e `. , - /`) pelas **teclas do controle remoto**, sem o processo `adb` de cada trecho (padrão: desligado; ver "Texto" abaixo) |
| `UNIOVER_TV_TEXT_KEY_PAUSE_MS` | pausa, em milissegundos, entre as teclas da digitação por teclas (padrão `0`; aumente se a TV perder letras) |
| `UNIOVER_AAPT_PATH` | caminho do `aapt2` (padrão: o mais novo em `%LOCALAPPDATA%\Android\Sdk\build-tools`, ou em `ANDROID_HOME`); sem ele a lista de apps segue sem ícones |
| `UNIOVER_ICONS_DIR` | pasta do cache de ícones (padrão `%LOCALAPPDATA%\UniOver\icons`; um arquivo por pacote e versão do app, e o nome leva a versão da regra de escolha do ícone: ao mudar a regra, o que a antiga guardou é ignorado e refeito) |
| `UNIOVER_TV_CLEANUP_KEEP` | pacotes que a limpeza da TV **nunca** fecha, além dos protegidos de fábrica (ver "Limpeza da TV"): nomes de pacote do Android separados por vírgula (`com.exemplo.app,com.outro.app`); no `agent.toml`, `tv_cleanup_keep` como lista ou como esse mesmo texto. Item fora do formato de pacote é erro de configuração e o agente não sobe |

Arquivo local (fora do repositório): `%LOCALAPPDATA%\UniOver\agent.toml`, com `api_url` e `agent_id`. Nunca
guarda segredo.

## TV (Android TV Remote v2)

O agente controla a TV pelo protocolo Remote v2 (biblioteca `androidtvremote2` 0.3.2), com a **sessão
quente**: a conexão fica aberta para o app não esperar ao abrir, e **hiberna depois de 300 s sem comando e
sem aviso de "app aberto"** (`tv.wake.v1`). O primeiro comando depois de hibernar reabre a sessão; o tempo de
aquecimento é medido e registrado no log. Se a TV não responder, tenta de novo com espera de 1, 2 e 4 s e
então responde `tv_unreachable`: nunca fica num laço infinito.

Texto (`tv.text.v1`): cada mensagem traz o texto completo do campo (0 a 200 caracteres). A TV **insere** o que
recebe, então o agente guarda o que ele mesmo digitou, apaga o excedente com `DEL` (uma tecla por caractere) e
digita só o acréscimo. **Texto vazio apaga tudo o que o agente digitou.** Sem campo em foco a TV ignora em
silêncio. O acréscimo vai por um canal só (nunca dividido, para a ordem não depender de dois caminhos):

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
- **Depois do `POWER`** a TV em standby derruba a sessão: se ela avisou antes (`power: off` com `connection: hot`)
  o estado sai assim; em seguida a sessão cai (`disconnected`, `power: unknown`) e o agente tenta reabrir com a
  espera de 1, 2 e 4 s, uma vez, sem laço. A reabertura em segundo plano acontece **uma vez por uso**: se a TV
  aceitar a sessão e a derrubar de novo sem que ninguém tenha usado o controle desde então, o agente não insiste
  e espera o próximo comando ou `tv.wake.v1` (que reabre a sessão e volta a permitir a recuperação). O app pede
  `tv.wake.v1` de tempos em tempos enquanto a tela do controle está aberta: ele só reabre a sessão (a TV em
  standby, sem rede, dá `tv_unreachable`).
- **Links:** `tv.app.launch.v1` com `kind=link` só abre os esquemas `https`, `http`, `market` e `vnd.youtube`
  (`intent://`, `file://` e afins são recusados). `kind=package` abre o app pelo ADB; sem `adb` neste PC responde `unsupported`.
- A biblioteca não avisa quando a conexão cai e **descarta em silêncio** a tecla enviada depois da queda; por
  isso o adaptador vigia a queda e o gerenciador reabre a sessão (com a mesma espera de 1, 2 e 4 s).
- **TV em standby** desliga a rede e não responde nada: cada comando espera as tentativas (até ~27 s no pior
  caso: 4 tentativas de 5 s mais 1 + 2 + 4 s) e responde `tv_unreachable`. Só uma **recusa ativa** da conexão
  (porta fechada, serviço do controle morto) sinaliza `needs_repair` ao vigia; ficar sem resposta não.
- Medições na TV real (`tools/measure_tv_session.py`, somente leitura): mortes do serviço por hora com e sem
  sessão, memória e tempo de religação. Nunca envia tecla de energia. **Pare o agente e o vigia antigo antes de
  medir**: a ferramenta usa o mesmo certificado e o ADB aceita um cliente por vez.

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

## Conexão

- `wss://<api>/api/v1/devices/agents/<agentId>/ws`, `ping` a cada 20 s, mensagens de texto JSON de até 64 KB.
- Ao conectar envia `agent.hello.v1` (versão e capacidades: `tv.remote` com a TV configurada e pareada, senão
  nenhuma) e, em seguida, `tv.state.v1` com o estado atual da TV.
- Reconexão com espera exponencial e variação aleatória (1 s, 2, 4 ... teto de 30 s), **sem limite de
  tentativas**; a espera volta ao início depois de 60 s de conexão estável.
- Credencial recusada (401/403 na abertura ou fechamento 4403 `revoked`): **para**, avisa para rodar
  `uniover-agent pair` e mantém o token no cofre até o usuário decidir. Fechamento 4409 `replaced` (outra instância do
  mesmo agente assumiu): espera 60 s antes de tentar de novo.
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
  publicador de `tv.state.v1`.
- `ports/`: `Transport`, `SecretStore`, `PairingClient`, `Clock`, `TvChannel`, `TvRemote`, `TvAdb`, `TvAdbCleanup` como `typing.Protocol`.
- `adapters/`: `transport_ws`, `secret_store_keyring`, `pairing_http`, `system_clock`, `local_config`,
  `tv_remote_v2`, `tv_pairing` e dublês de teste.
- `contracts/`: modelos e esquemas gerados, não editar.
- `main.py`: composição e linha de comando.

Trocar de transporte (MQTT, depois) é trocar o adaptador: o núcleo não sabe que existe WebSocket.

## Regra do núcleo

`core/` e `ports/` nunca importam `adapters/` nem biblioteca de rede, de cofre ou de TV. O `import-linter`
(`uv run lint-imports`) falha se isso acontecer.

## Ainda fora daqui

Iniciar sozinho com o Windows e empacotar; teclas e apps pelo canal ADB; vigia da TV; adaptador MQTT.
