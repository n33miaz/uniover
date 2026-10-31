# TV Livre (launcher da TV)

Tela inicial própria para TVs Android e Google TV: relógio grande no centro, uma fileira centrada de apps em
círculos, fundo em degradê (ou foto), e o Modo Dormir (tela preta). É o que o módulo avançado da TV instala; o
agente do PC configura tudo por ADB.

- Funciona em qualquer marca com Android TV ou Google TV (Android 9 em diante), e também em caixas Android.
- Nenhuma permissão, nenhum serviço em segundo plano, nenhuma rede. A tela só é montada quando a home está à
  vista.
- Quem manda é o agente: o app lê um arquivo `config.json` (contrato em
  [`contracts/tv-launcher`](../../contracts/tv-launcher/config.v1.schema.json)) e se desenha de novo.
- A TV da casa tem pouca memória livre: a regra do projeto é só framework do Android (sem AndroidX, sem Compose).

## Decisões técnicas

| Escolha | Por quê |
|---|---|
| Views do framework, sem Compose nem AndroidX | O runtime do Compose for TV acrescentaria, pela estimativa do plano (não medida aqui), uns 10 a 20 MB de memória e vários MB ao APK. A home é uma tela estática: um `TextClock`, uma `HorizontalScrollView` e uns poucos círculos. Sem dependência nenhuma de execução, o APK de release fica em dezenas de KB. |
| `minSdk` 28 (Android 9) | Piso combinado para o módulo. O código não usa nada acima da API 26, mas só a partir da 28 o caminho de instalação (`cmd package set-home-activity`) está documentado e foi ensaiado. Descer para 26 é trocar uma linha em `app/build.gradle.kts`, depois de ensaiar numa TV Android 8. |
| `targetSdk` 35 | Atual. Não muda nada visível: a home é tela cheia na horizontal. |
| Tamanhos em fração da altura da tela | As TVs variam de densidade e de resolução; a proporção do desenho aprovado é a mesma em qualquer uma. |
| Sem foto na memória além de uma | O fundo em foto é um único bitmap em RGB_565 reduzido (`inSampleSize`) ao tamanho da tela, decodificado fora da thread principal. |
| Apps visíveis por `<queries>`, não `QUERY_ALL_PACKAGES` | Vemos exatamente os apps que têm ícone de TV ou de celular, que é tudo o que a home lista. |

### Tamanho e memória medidos

- **APK de release: 74 KB** (`app-release.apk`, com R8 e recursos reduzidos; nenhuma biblioteca de terceiros).
- **Memória** (`dumpsys meminfo`, emulador x86_64 com Android 15 em 1920x1080, release, fileira de 6 apps, parado na
  home): **Private Dirty 17 MB** e **Private Clean 36 MB** (este quase todo é o driver gráfico do emulador, que em TV
  é compartilhado). O launcher do próprio emulador (Pixel Launcher) ficou em 28 MB de Private Dirty. O PSS total
  (60 a 83 MB, conforme o estado do emulador) conta bibliotecas do sistema compartilhadas com todos os apps: não é
  o custo do app.
- Com `-PhwAccel=false` (renderização por software, só uma chave de build) o Private Dirty cai uns 2 MB (15 MB) e o
  Private Clean para 2 MB. Não é o padrão: a animação de foco depende da GPU para ficar fluida numa TV fraca.
  Para medir na TV de verdade (o que importa), o agente roda `dumpsys meminfo br.uniover.launcher` com a home na tela;
  sem esse número a meta de memória fica como estimativa.

## Compilar e testar

Precisa de JDK 21 e do Android SDK (`ANDROID_HOME` ou `local.properties` com `sdk.dir`).

```
cd apps/tv-launcher
./gradlew testDebugUnitTest      # testes de unidade e de tela (Robolectric), sem emulador
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk
```

O wrapper fixa o Gradle 8.13. A versão do app é a do arquivo `VERSION` da raiz do repositório (`versionName`), e o
`versionCode` é `maior*10000 + menor*100 + correção`: o release da plataforma já a mantém em dia.

### Assinatura

O launcher é assinado com uma **chave fixa do projeto** (PKCS12, RSA 4096, alias `uniover-tv`, válida até 2056).
Todo build oficial, local ou do runner, sai com o mesmo certificado, e por isso a TV aceita a atualização por cima
do app instalado, sem desinstalar.

- **Certificado (público), SHA-256:**
  `F7:82:15:1A:18:E6:BC:3F:F2:2A:20:1F:F5:58:FD:83:3F:EB:21:20:18:20:34:A3:DE:C6:AE:AB:41:B1:2B:FC`
  (também em `signing-cert.sha256`, que o script local e a esteira usam para conferir o APK).
- **Build local:** `pwsh -NoProfile -File apps/tv-launcher/tools/build-release.ps1`. O script lê a chave de
  `.secrets/tv-launcher/` na raiz do repositório principal (também numa worktree), monta o release, confere com o
  `apksigner` que o certificado é o da chave do projeto e falha se não for. `-Destino <pasta>` copia o APK como
  `uniover-launcher.apk`.
- **Esteira (job `tv-launcher`):** lê os segredos do repositório `UNIOVER_TV_KEYSTORE_BASE64`,
  `UNIOVER_TV_KEYSTORE_PASSWORD`, `UNIOVER_TV_KEY_ALIAS` e `UNIOVER_TV_KEY_PASSWORD`, decodifica o keystore num arquivo
  temporário do runner, assina o release, confere o certificado contra `signing-cert.sha256` e apaga o arquivo ao
  sair do passo. Evento sem segredos (PR de fora ou de robô) assina com a chave de depuração do runner: serve para
  provar que o build monta, mas esse APK não é o oficial.
- **Onde fica a chave:** fora do git. `.secrets/tv-launcher/uniover-tv.p12` e `senha.txt` (pasta no `.gitignore`),
  mais um backup cifrado pelo Windows (DPAPI) em `Documents\UniOver-chaves` com o script
  `restaurar-tv-launcher.ps1`, que só abre na mesma conta e na mesma máquina. Quem perder a chave e o backup perde
  também a atualização por cima: só resta desinstalar e instalar de novo na TV. Guarde uma cópia do `.p12` e da senha
  num cofre de senhas.
- **Sem a chave** (por exemplo, ao compilar sem as propriedades), o release sai com a chave de depuração da máquina e
  **não atualiza** um APK oficial instalado: o ADB responde `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. O agente deve
  instalar sempre o APK oficial que ele próprio carrega.
- Para assinar à mão com outra chave, passe as quatro propriedades (por `-P` ou variável de ambiente):
  `UNIOVER_TV_STORE_FILE`, `UNIOVER_TV_STORE_PASSWORD`, `UNIOVER_TV_KEY_ALIAS`, `UNIOVER_TV_KEY_PASSWORD`.
- A TV que já tem um APK assinado com a chave de depuração antiga precisa de **uma** desinstalação ("Voltar ao
  original" até o fim) para trocar para a chave do projeto; dali em diante as atualizações entram por cima.

## Configuração

O contrato é `contracts/tv-launcher/config.v1.schema.json` (com exemplos em `examples/valid`). Resumo:

```json
{
  "schema": 1,
  "revision": 42,
  "clock": { "size": "large", "format": "24h", "seconds": false, "date": true },
  "wallpaper": { "type": "gradient", "colors": ["#1B2440", "#3A2D5C"], "angle": 315 },
  "apps": { "mode": "listed", "items": ["com.netflix.ninja", "com.google.android.youtube.tv"] },
  "builtin": { "settings": true, "sleep": false }
}
```

- Sem arquivo, a home abre com os padrões: todos os apps instalados que **não** são de fábrica, em ordem alfabética,
  mais o ícone de Configurações. Apps de fábrica (de sistema e nunca atualizados) ficam ocultos por padrão e voltam
  com `apps.showFactory` ou citados em `apps.items`.
- `apps.items` define a ordem. `listed` mostra só eles; `all` mostra eles primeiro e depois o resto. `apps.hidden`
  vence tudo.
- Rede de segurança: se a lista pedida ficar vazia, a home mostra todos os apps; o ícone de Configurações da TV é a
  saída de emergência e só some se `builtin.settings` for `false`.
- O leitor é tolerante: campo desconhecido é ignorado e valor inválido volta ao padrão. Só se recusa o arquivo
  inteiro se não for JSON, se não tiver `schema` ou se `schema` não for 1. Um arquivo recusado nunca troca a
  configuração que já estava valendo.
- Duas vias de entrega; vale a de maior `revision` (empate fica com o arquivo):

**1. Arquivo na pasta do app** (a via principal, e a única que leva foto):

```
/sdcard/Android/data/br.uniover.launcher/files/config.json
/sdcard/Android/data/br.uniover.launcher/files/wallpaper.jpg     (nome citado em wallpaper.photo)
```

A pasta só existe depois que o app abriu uma vez (passo 3 abaixo). Escreva sempre num arquivo temporário e renomeie,
para o app nunca ler um JSON pela metade: `config.json.tmp` é ignorado.

**2. Broadcast** (sem foto; serve se a pasta externa não existir ou não aceitar escrita):

```
adb shell am broadcast -n br.uniover.launcher/.ConfigReceiver \
  -a br.uniover.launcher.action.APPLY_CONFIG --es config_b64 "$(base64 -w0 config.json)"
```

A resposta vem na própria saída do `am`: `result=1, data="revision=42 avisos=0"` quando foi aceita e `result=2` com
o motivo quando foi recusada. O receptor exige a permissão `DUMP`, que só o ADB (usuário shell) e o sistema têm:
nenhum app instalado consegue mudar a configuração.

A home relê a configuração ao voltar para a frente e, se estiver na tela, no instante em que o broadcast chega.
Depois de enviar o arquivo, `adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME`
redesenha na hora.

Foto: o agente envia já reduzida (1920x1080, JPEG abaixo de 400 KB). O app recusa arquivo vazio ou maior que 4 MB e
cai para o degradê.

## Instalar e definir como padrão

> A ordem importa: **nunca** desative o launcher de fábrica antes de a home nova estar instalada, abrindo e
> definida como padrão. Sem nenhum launcher habilitado a TV fica em tela preta.

`TV` abaixo é o destino do ADB (`-s 192.168.0.10:5555`). Todos os comandos são `adb -s TV shell ...`.

1. **Conferir a versão do Android** (precisa ser 28 ou mais):
   `getprop ro.build.version.sdk`

2. **Descobrir e guardar o launcher de fábrica.** Nunca fixe o nome: o Google TV usa
   `com.google.android.apps.tv.launcherx`, o Android TV puro usa `com.google.android.tvlauncher`, e há marcas com o
   próprio.
   ```
   cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME
   cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME
   ```
   A última linha do primeiro comando é o componente atual (`pacote/.Atividade`). Guarde-o em arquivo, junto com os
   pacotes que o segundo comando listar (todo manipulador de HOME que o sistema conhece). Sem esse registro a
   volta ao original fica por dedução.

   **Ensaie a volta antes de tocar em qualquer coisa:** `cmd package set-home-activity <componente guardado>`
   precisa responder `Success`. É inofensivo (reaplica o que já é o padrão) e prova que o componente é um launcher
   de verdade. Se responder `Error: Failed to set default home`, esse componente não serve (no emulador, o primeiro
   resultado foi uma atividade de configuração inicial, não o launcher): guarde outro candidato da lista e repita.
   Sem um original que passe neste ensaio, não siga adiante.

3. **Instalar e abrir uma vez** (cria a pasta de configuração; o launcher de fábrica continua sendo o padrão):
   ```
   adb -s TV install -r uniover-launcher.apk
   adb -s TV shell am start -n br.uniover.launcher/.HomeActivity
   ```
   A TV mostra a home nova por cima. O botão Home volta para a de fábrica, porque nada mudou ainda.

4. **Enviar a configuração e conferir** que a tela mostra o que se espera (relógio, apps, fundo): via arquivo ou via
   broadcast, como acima. Se a tela não estiver boa, pare aqui: nada foi alterado na TV além de um app instalado.

5. **Definir como padrão:**
   ```
   cmd package set-home-activity br.uniover.launcher/.HomeActivity
   ```
   Se o sistema reclamar do usuário, repita com `--user 0` (`cmd package set-home-activity --user 0 ...`).

6. **Verificar:** o mesmo `resolve-activity --brief ... HOME` do passo 2 deve devolver
   `br.uniover.launcher/.HomeActivity`, e `am start -a android.intent.action.MAIN -c android.intent.category.HOME`
   deve abrir a home nova. Só aqui o launcher novo é "o padrão".

7. **Opcional, só depois do passo 6 verificado:** desativar o launcher de fábrica (libera a memória dele e impede
   que o botão Home da TV o reabra, o que acontece em algumas Google TV):
   `pm disable-user --user 0 <pacote do launcher de fábrica>`.
   Reversível com `pm enable --user 0 <pacote>`. Uma atualização de firmware pode reabilitá-lo: o agente confere.

## Voltar ao original

Esta é a ordem que nunca deixa a TV sem tela inicial:

1. **Reabilitar** todo launcher que foi desativado: `pm enable --user 0 <pacote do launcher de fábrica>`.
2. **Definir o original como padrão:** `cmd package set-home-activity <componente guardado no passo 2>`.
3. **Verificar:** `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME`
   devolve o original, e `am start -a android.intent.action.MAIN -c android.intent.category.HOME` abre a home de
   fábrica. Se não abrir, **pare**: não desinstale nada; volte ao passo 1 com o outro pacote da lista guardada.
4. **Só então** remover a nossa: `adb -s TV uninstall br.uniover.launcher` (apaga também `config.json` e a foto).

Sem o registro do componente original: `cmd package query-activities --brief -a android.intent.action.MAIN -c
android.intent.category.HOME` lista os candidatos (o nosso aparece como `br.uniover.launcher`); habilite o de fábrica
(`pm list packages -s` mostra os de sistema) e defina-o com `set-home-activity`. Como último recurso,
`pm clear-package-preferred-activities br.uniover.launcher` tira a preferência da nossa home e o sistema volta a
escolher entre os manipuladores de HOME habilitados.

Nunca: desinstalar a home nova enquanto ela é a padrão e o original está desativado, ou desativar o original sem
ter verificado o passo 6 da instalação. Mantenha a conexão ADB aberta durante todo o processo: ela não depende de
launcher nenhum.

## Modo Dormir

```
adb -s TV shell am start -n br.uniover.launcher/.SleepActivity
```

Tela cheia e preta, sem nenhum elemento, com a tela mantida ligada (nada de protetor de tela do sistema) e o brilho
da janela no mínimo. **Qualquer tecla** do controle acorda (a tecla é consumida: não aperta nada por baixo), e
também um toque. O áudio continua tocando e o agente continua conectado, porque a TV não desliga.
`sleep.maxMinutes` na configuração faz o Modo Dormir sair sozinho depois do tempo dado (0 = só com tecla).
Para acordar pelo ADB: `adb -s TV shell input keyevent KEYCODE_DPAD_CENTER`.

Limite honesto: num painel LCD o backlight continua aceso; os pixels pretos reduzem a luz, mas há um brilho
residual. Em OLED o preto é total. Apagar só o backlight depende da TV e não está garantido por ADB.

## Segurança

- O APK não pede permissão nenhuma. A configuração e a foto ficam na pasta do próprio app.
- `SleepActivity` é exportada (o `am start` do ADB precisa); o pior que um app de fora consegue com ela é mostrar tela
  preta, que sai com qualquer tecla.
- `ConfigReceiver` exige a permissão `DUMP`: só o ADB e o sistema conseguem mudar a configuração.
- `wallpaper.photo` aceita só um nome de arquivo (sem pasta), com extensão de imagem: nada de caminhos.
- Falha de leitura, JSON pela metade, foto estragada ou lista de apps vazia nunca derrubam a home nem a deixam em
  branco: o app mantém a última configuração boa ou volta aos padrões.

## Estrutura

```
app/src/main/kotlin/br/uniover/launcher/
  HomeActivity.kt        a home (monta a tela em código, atualiza só o que mudou)
  SleepActivity.kt       Modo Dormir
  ConfigReceiver.kt      via de entrega por broadcast (só ADB)
  config/                modelo, leitor tolerante e armazenamento da configuração
  apps/                  seleção (ordem, ocultar, fábrica) e leitura dos apps instalados
  ui/                    medidas, papel de parede e o tile de cada app
app/src/test/            testes de unidade e de tela (Robolectric); leem os exemplos de contracts/tv-launcher
```
