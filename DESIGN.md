# DESIGN.md — UniOver (PWA)

Sistema de design do app web (`apps/web`, Angular). Escrito para qualquer ferramenta de design ou de código (Stitch, Figma, agentes de código): os valores abaixo foram copiados do código e cada um cita o arquivo de origem.

## 1. Como usar

**Autoridade.** O código vence este arquivo. Se um valor aqui divergir do arquivo citado, vale o arquivo. Nada foi inventado: o que não existe no código aparece como "não definido no código".

**Como consumir.**

| Seção deste arquivo | Vira, na ferramenta |
| --- | --- |
| 3. Tokens | Variáveis / estilos (cor, espaço, raio, tipografia, sombra, movimento). Nome do token = nome da custom property CSS. |
| 5. Componentes | Componentes / primitivas. Nome = classe CSS (`.ui-btn`, `.ui-card`...). |
| 2, 4, 6, 8 | Restrições: regras que toda tela nova precisa cumprir. |

**Regerar e verificar.**

- `npm run lint` em `apps/web` roda `scripts/check-css-vars.mjs`: falha se um `var(--x)` sem fallback usa uma variável nunca definida (`apps/web/scripts/check-css-vars.mjs:1-8`). Usos com fallback não são verificados (ver seção 9).
- Referência visual: o catálogo de telas (`npm run catalog` em `apps/web`; código em `apps/web/e2e/catalog`) abre cada rota do app com a API simulada do e2e, no iPhone 12 (390 x 664), e escreve um HTML único com todas as telas e estados, agrupado por módulo. Ele mostra o que o app é hoje; este arquivo diz o que ele deve ser.
- Os tokens vivem em `apps/web/src/styles.css`; os esqueletos de abertura em `apps/web/src/boot-skeleton.css` e no `<style>` de `apps/web/src/index.html`.

## 2. Princípios

Regras imperativas, na ordem de importância.

1. **Pouco texto.** Sem subtítulo ou frase de apoio que explique o óbvio. Manter só o que protege a pessoa (limite de caracteres, "não existe recuperação de senha"). Exemplos de tom: "Criar conta", "Continuar".
2. **Título em UMA linha** de 360 a 430 px. Usar tipografia fluida (`clamp()` com `vw`, mínimo legível, teto) e nunca tamanho fixo. `text-wrap: balance` é só reserva para janelas ainda mais estreitas (`apps/web/src/app/core/auth/auth-state.css:58-64`, `apps/web/src/app/core/auth/welcome.page.css:1-13`).
3. **Sem palavra órfã.** Nunca deixar uma palavra sozinha na última linha (`text-wrap: balance` em títulos, `text-wrap: pretty` em parágrafos: `auth-state.css:66-81`).
4. **Centralizar o que ficar harmônico** (títulos e frases curtas, estados vazios, nome do módulo). Rótulos e campos ficam à esquerda, em largura total. Dentro de uma família de telas, o mesmo critério.
5. **Usar a largura toda.** Elementos de uma linha (barra de força da senha, botões de rodapé) vão de ponta a ponta, sem sobrar meia linha vazia. Colunas de leitura têm teto e ficam centradas (ver seção 4).
6. **Sem slogan.** A marca é o logo mais o nome "UniOver", nada além disso.
7. **Uma ação principal por tela.** Informação secundária fica atrás de um toque (folha, "Ver ...", recolher).
8. **Texto em pt-BR.** Datas, números e rótulos em português do Brasil; o `<html>` declara `lang="pt-BR"` (`apps/web/src/index.html:2`).
9. **Caixa das iniciais (Title Case): botões de ação e títulos de tela ou de seção levam iniciais maiúsculas no app todo (decisão do dono); o resto fica em caixa de frase.**
   - Title Case (iniciais maiúsculas, conectivos em minúscula: de, do, da, em, à, os, a, para, como) em: botões de ação e títulos de tela ou de seção, em todos os módulos (Entrada, Ajustes, Dispositivos, Compras e Treino); a TV segue a frente própria dela. Exemplos reais: "Tentar de Novo" (`apps/web/src/app/shared/ui/skeleton/loading-frame.ts:55`), "Nenhum Exercício Achado", "Limpar Filtros", "Mostrar Mais" (`apps/web/src/app/modules/training/exercises/library/library.page.html:141-172`), "Concluir Série", "Definir Como Padrão", "Capacidade em Risco", "Adicionar à Tela de Início", "Ver Todos os N Passos" (`apps/web/src/app/modules/training/exercises/detail/detail.page.html:86`), "Em Breve" (`apps/web/src/app/modules/home/home-soon-badge.ts:9`).
   - Caixa de frase (só a primeira letra) em: rótulos de campo ("Data de nascimento", "Código do computador", "Altura (cm)"), frases e dicas ("Tente outra palavra ou tire algum filtro."), textos de status com reticências ("Carregando…", "Aplicando…"), perguntas ("Como devemos te chamar?") e botões de uma palavra ("Cancelar", "Continuar"). Botões de duas palavras ou mais usam Title Case ("Criar Conta", "Copiar Link", "Conectar Este PC", "Convidar Alguém").
   - `.ui-section-label` força MAIÚSCULAS por CSS (`apps/web/src/styles.css:318-326`): a caixa do texto-fonte não importa ali.
   - Tela nova: Title Case em títulos e botões; rótulos de campo, dicas e status em caixa de frase.
10. **Estado nunca só por cor.** Cada fase de estado tem cor e forma próprias (ver 5.9).

**Evitar:** subtítulos explicativos; slogan; título que quebra em duas linhas; tamanho de fonte fixo em título; cor hexadecimal fora da paleta; mais de uma ação primária; informação demais acima da dobra; alvo de toque menor que 44 px; animação longa ou com rebote.

## 3. Tokens

Todos são custom properties em `:root` de `apps/web/src/styles.css`. Tema claro é o padrão; o escuro é aplicado por `data-theme="dark"` na raiz ou, se não houver `data-theme="light"`, pela preferência do sistema.

### 3.1 Como o tema é aplicado

| Mecanismo | Detalhe | Fonte |
| --- | --- | --- |
| Padrão | Claro (`color-scheme: light`) | `apps/web/src/styles.css:2-3` |
| Sistema | `@media (prefers-color-scheme: dark)` com `:root:not([data-theme='light'])` | `apps/web/src/styles.css:116-138` |
| Atributo | `:root[data-theme='dark']` repete a mesma paleta | `apps/web/src/styles.css:140-160` |
| Quem grava o atributo | `ThemeService` (segue o sistema) e `AppearanceService` (preferência `auto`, `light`, `dark`, guardada no aparelho) | `apps/web/src/app/core/theme/theme.service.ts:26-28`, `apps/web/src/app/core/session/appearance.service.ts:6-9,58-62` |
| Escolha na tela | Três opções: Claro, Escuro, Automático | `apps/web/src/app/modules/settings/appearance.page.ts:28-32` |
| `<meta name="color-scheme">` | `light dark` | `apps/web/src/index.html:11` |
| Cor da barra do sistema | `<meta name="theme-color">` por tema com o fundo (`#f2f5f1` claro, `#101512` escuro); com o tema fixado no app, o `AppearanceService` põe a cor dele nas duas. O manifesto guarda uma cor só e é o fundo claro (`theme_color` e `background_color` `#F2F5F1`), o que o Chrome do Android lê para a barra do app instalado; o escuro só chega pelas metas | `apps/web/src/index.html`, `appearance.service.ts` |

Regra para tokens novos: definir os dois temas; nunca trocar o valor de um token existente (telas dependem deles: `apps/web/src/styles.css:21-24`).

### 3.2 Cor

| Token | Claro | Escuro | Uso | Fonte |
| --- | --- | --- | --- | --- |
| `--a-bg` | `#f2f5f1` | `#101512` | Fundo da página | `styles.css:4`, `119` |
| `--a-surface` | `#ffffff` | `#181f1a` | Cartão, barra, campo de botão | `styles.css:5`, `120` |
| `--a-elev` | `#e5ebe4` | `#222b24` | Chip neutro, estado pressionado, esqueleto | `styles.css:6`, `121` |
| `--a-ink` | `#17201a` | `#e9efea` | Texto principal | `styles.css:7`, `122` |
| `--a-ink2` | `#46544a` | `#b0bdb3` | Texto de apoio | `styles.css:8`, `123` |
| `--a-ink3` | `#5c6c60` | `#8fa093` | Texto terciário, contorno de campo, ícone discreto | `styles.css:9`, `124` |
| `--a-line` | `#d0dad0` | `#2f3b33` | Fios e bordas | `styles.css:10`, `125` |
| `--a-accent` | `#3b6b4b` | `#98c4a3` | Acento (verde-sálvia) | `styles.css:11`, `126` |
| `--a-accent-soft` | `#dcebdf` | `#243a2b` | Fundo suave do acento | `styles.css:12`, `127` |
| `--a-on-accent` | `#ffffff` | `#0a160d` | Texto sobre acento ou perigo | `styles.css:13`, `128` |
| `--a-ok` | `#0e7a5c` | `#3fc7a3` | Sucesso | `styles.css:14`, `129` |
| `--a-warn` | `#8a5200` | `#e8a63c` | Atenção | `styles.css:15`, `130` |
| `--a-bad` | `#b3261e` | `#f0736b` | Erro, perigo | `styles.css:16`, `131` |
| `--a-surface-2` | `#f6f8f5` | `#131914` | Poço: campo, trilho, hover de linha | `styles.css:82`, `135` |
| `--a-surface-raised` | `#ffffff` | `#1e2820` | Folha e diálogo | `styles.css:83`, `136` |
| `--a-highlight` | `rgb(255 255 255 / 0.7)` | `rgb(255 255 255 / 0.05)` | Brilho fino no topo de cartão | `styles.css:79`, `134` |

Derivados (valem nos dois temas, calculados a partir dos de cima; `apps/web/src/styles.css:96-104`):

| Token | Fórmula |
| --- | --- |
| `--a-ok-soft` | `color-mix(in srgb, var(--a-ok) 14%, var(--a-surface))` |
| `--a-warn-soft` | `color-mix(in srgb, var(--a-warn) 14%, var(--a-surface))` |
| `--a-bad-soft` | `color-mix(in srgb, var(--a-bad) 12%, var(--a-surface))` |
| `--a-ok-ink` | `color-mix(in srgb, var(--a-ok) 70%, var(--a-ink))` |
| `--a-warn-ink` | `color-mix(in srgb, var(--a-warn) 70%, var(--a-ink))` |
| `--a-bad-ink` | `color-mix(in srgb, var(--a-bad) 72%, var(--a-ink))` |
| `--a-accent-ink` | `color-mix(in srgb, var(--a-accent) 78%, var(--a-ink))` |
| `--a-ring` | `0 0 0 4px color-mix(in srgb, var(--a-accent) 28%, transparent)` (anel de foco de campo) |
| `--a-hero` | gradiente `150deg`: acento 17% sobre superfície em 0%, acento 5% em 62%, superfície em 100% (`styles.css:107-112`) |

Regras de uso: texto de aviso fica em `--a-ink` (o tom só colore fundo e borda); texto colorido usa a variante `-ink`; fundo suave usa `-soft`. Cores fixas de propósito (não obedecem ao tema): amostras de tema em Ajustes (`apps/web/src/app/modules/settings/appearance.page.css:116`), quadro claro das fotos de exercício (`apps/web/src/app/modules/training/today/workout-day.css:60-72`), teclas coloridas do controle de TV (vermelho `#d93a3a`, verde `#2e9d4b`, amarelo `#e6b422`, azul `#2f6fdb`: `apps/web/src/app/modules/tv/pages/control.page.css:296-299`).

Cor local fora do arquivo global: `--dot-sleep` (azul-acinzentado do estado "dormindo"), `#3f5f8a` no claro e `#8fb3d9` no escuro, definida só em `apps/web/src/app/modules/tv/ui/status-dot.css:11-21`.

### 3.3 Espaço

Múltiplos de 4 (`apps/web/src/styles.css:26-33`).

| Token | Valor |
| --- | --- |
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--gutter` | 16px (margem lateral da página; `styles.css:19`) |
| `--tap` | 44px (tamanho mínimo de toque; `styles.css:53`) |
| `--key` / `--key-tile` / `--key-lg` | 52px / 60px / 64px (tecla comum, azulejo e tecla grande dos controles da TV e do PC) |

### 3.4 Raios

| Token | Valor | Uso | Fonte |
| --- | --- | --- | --- |
| `--radius-xs` | 8px | Esqueleto | `styles.css:36` |
| `--radius-sm` | 12px | Ladrilho, campo de módulo, osso grande | `styles.css:37` |
| `--radius` | 14px | Raio médio dos controles (botão, campo, aviso) | `styles.css:18` |
| `--radius-lg` | 20px | Cartão e grupo, inclusive em Ajustes | `styles.css:38` |
| `--radius-xl` | 28px | Folha inferior, faixa da Início, cartão de entrada | `styles.css:39` |
| `--radius-pill` | 999px | Chip, pílula, trilho | `styles.css:40` |

Colunas com teto (3.10): `--col-read` 40rem e `--col-control` 36rem, em `styles.css`.

### 3.5 Tipografia

- Família: `--font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` (`styles.css:17`). Só fontes do sistema (a CSP não admite fonte web: seção 6.5). Monoespaçada onde há código: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (`apps/web/src/app/modules/devices/pair-sheet.css:93`).
- Base: `font-size: 16px; line-height: 1.4` (`styles.css:175-176`); `h1, h2`: `line-height: 1.2` (`styles.css:228-232`).

| Token | Valor | Uso | Fonte |
| --- | --- | --- | --- |
| `--fs-label` | 0.75rem | Rótulo de seção | `styles.css:43` |
| `--fs-small` | 0.875rem | Apoio, rótulo de campo, subtítulo de linha | `styles.css:44` |
| `--fs-body` | 1rem | Corpo | `styles.css:45` |
| `--fs-title` | 1.25rem | Título de folha e de seção | `styles.css:46` |
| `--fs-display` | 1.75rem | Destaque | `styles.css:47` |

Pesos em uso: 600 (data, aviso), 650 (título de linha, botão, rótulo de campo, chip), 700 (ação de texto, nome de módulo), 750 (títulos: `apps/web/src/app/modules/home/home-page.css:167`), 800 (marca "UniOver": `home-page.css:28`). Letter-spacing de títulos: `-0.02em`; rótulo de seção `0.08em`; marca `0.06em`. Números que mudam usam `font-variant-numeric: tabular-nums` (`home-page.css:178`).

**Tipografia fluida** (`clamp(mínimo, vw, teto)`), fórmulas reais:

| Elemento | Fórmula | Fonte |
| --- | --- | --- |
| Título de estado de entrada | `clamp(1.25rem, 6.4vw, 1.5rem)` | `apps/web/src/app/core/auth/auth-state.css:60` |
| Título de boas-vindas | `clamp(1.25rem, 5.9vw, 1.75rem)` | `apps/web/src/app/core/auth/welcome.page.css:8` |
| Marca na Início | `clamp(1.5rem, 7vw, 2rem)` | `home-page.css:27` |
| Saudação na Início | `clamp(1.125rem, 5.5vw, 2rem)` | `home-page.css:166` |
| Hora na Início | `clamp(2rem, 5vw, 2.5rem)` | `home-page.css:174` |
| Nome do módulo (cartão) | `clamp(0.8125rem, 3.7vw, 1.0625rem)` | `home-page.css:313` |
| Título do Treino (hoje) | `clamp(1.125rem, 5.6vw, 1.375rem)` | `apps/web/src/app/modules/training/today/today-home.css:102` |
| Título do dia de treino | `clamp(1.125rem, 5.6vw, 1.5rem)` | `apps/web/src/app/modules/training/today/workout-day.css:33` |
| Título de exercício | `clamp(1.0625rem, 5.2vw, 1.375rem)` | `apps/web/src/app/modules/training/exercises/detail/detail.page.css:45` |
| Título de folha de permissão | `clamp(1.1rem, 5.4vw, var(--fs-title))` | `apps/web/src/app/core/tv-permission/tv-permission-sheet.css:70` |

Exceção que não é fluida: o título da barra superior das páginas de módulo é `1.35rem` fixo, em uma linha com reticências (`apps/web/src/app/shared/ui/page-top-bar.ts:144-153`).

### 3.6 Sombras

Cor e força mudam com o tema: `--a-shadow: 23 32 26` e `--shadow-k: 1` no claro; `0 0 0` e `2.4` no escuro (`styles.css:77-78`, `132-133`).

| Token | Valor | Uso |
| --- | --- | --- |
| `--shadow-1` | `0 1px 2px rgb(var(--a-shadow) / calc(0.07 * var(--shadow-k))), 0 1px 1px rgb(var(--a-shadow) / calc(0.04 * var(--shadow-k)))` | Repouso (`styles.css:86-88`) |
| `--shadow-2` | `0 6px 16px -4px rgb(... 0.12 * k), 0 2px 4px rgb(... 0.06 * k)` | Cartão em destaque, hover (`styles.css:89-91`) |
| `--shadow-3` | `0 -12px 40px -8px rgb(... 0.28 * k), 0 -2px 8px rgb(... 0.1 * k)` | Folha e diálogo (`styles.css:92-94`) |

Cartões somam `inset 0 1px 0 var(--a-highlight)` à sombra de repouso (`styles.css:337-339`, `850-852`).

### 3.7 Movimento

| Token | Valor | Fonte |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.22, 0.8, 0.24, 1)` (sem rebote) | `styles.css:65` |
| `--dur-fast` | 120ms | `styles.css:66` |
| `--dur-base` | 200ms | `styles.css:67` |
| `--dur-slow` | 360ms | `styles.css:68` |
| `--dur-exit` | 160ms (saída mais curta que a entrada) | `styles.css:70` |
| `--shift-1/2/3` | 6px / 12px / 24px (deslocamento de entrada, sempre vertical) | `styles.css:72-74` |

Keyframes e tempos (`apps/web/src/styles.css`):

| Nome | Efeito | Linhas |
| --- | --- | --- |
| `ui-rise` | entra deslizando 10px na vertical, sem partir da transparência; `--dur-slow` | `666-668`, `704-708` |
| `ui-shimmer` | brilho que corre no fundo (`background-position` de 110% a -110%); 2s `ease-in-out` infinito; `background-size: 260% 100%` | `640-652`, `710-717` |
| `ui-pulse` | pulsação de opacidade até 0.55; 2.2s (usada no lugar do brilho em movimento reduzido) | `719-725`, `762-765` |
| `ui-spin` | giro do `.ui-spinner` (16px, borda 2px); 0.8s linear | `654-663`, `727-731` |
| `ui-wait-in` | revela a espera depois de `--wait-delay` (padrão 200ms; 0ms sob `html.has-boot-skeleton`) | `733-754` |
| `ui-collapse-in/out` | abre e fecha empurrando o conteúdo (trilha de grade 0fr a 1fr); entrada `--dur-base`, saída `--dur-exit` | `908-935` |
| `.ui-stagger` | atraso de 50ms por filho (2º a 4º), 200ms do 5º em diante | `676-690` |

Pressionar: `.ui-btn:active` escala 0.98; `.ui-tap:active` 0.94; `.ui-press:active` 0.985; todo botão, link, `role=button`, `role=tab` ativo ganha `filter: brightness(0.96)` e `scale(0.98)` (`styles.css:507-509`, `899-901`, `864-866`, `1106-1109`). O controle de TV (`app-tv-control`) fica de fora e define os próprios estados (`styles.css:1073-1077`).

**Movimento reduzido** (`@media (prefers-reduced-motion: reduce)`, `styles.css:756-782`, `834-843`, `877-885`, `989-1009`, `1122-1149`): `ui-rise` e `ui-spinner` sem animação; o brilho vira pulsação de opacidade (`ui-pulse`); transições de botão, linha, interruptor, cartão e diálogo desligadas; escalas de pressionar viram `none`; só o `filter` de pressionar permanece. Toda animação nova precisa de saída equivalente neste bloco.

Diálogo e folha (`.ui-dialog`): entrada por `@starting-style` (opacidade 0 e `translate` de `--dialog-shift`, padrão `--shift-3`), saída pela classe `closing` com `--dur-exit`; o tempo-limite da saída é 300ms (`styles.css:942-987`; `apps/web/src/app/shared/ui/dialog-motion.ts:2`).

### 3.8 Camadas (z-index)

Não há tokens de z-index. Principais camadas em uso (lista parcial: há também valores locais como `-1`, `1`, `2` e `20`; procure no código antes de criar uma camada nova):

| Camada | Valor | Fonte |
| --- | --- | --- |
| Esqueleto estático de abertura | 999 | `apps/web/src/index.html:28-35`, `apps/web/src/boot-skeleton.css:20-22` |
| Esqueleto do Angular | 1000 | `boot-skeleton.css:12` |
| Aviso de abertura demorada | 1001 | `boot-skeleton.css:49` |
| Barra superior fixa do Treino | 5 | `apps/web/src/app/modules/training/shell/training.page.ts:140-145` |
| Aviso passageiro da TV | 5 | `apps/web/src/app/modules/tv/tv-page.css:334` |
| Indicador de estado da TV | 4 | `apps/web/src/app/modules/tv/ui/status-indicator.css:29` |
| Barra de ação fixa | 2 | `styles.css:554` |

Diálogos e folhas usam a camada superior nativa do `<dialog>` modal, sem z-index.

### 3.9 Pontos de quebra, área segura, viewport

- Não há tokens de breakpoint. Principais quebras em uso (lista parcial: há ajustes locais como `max-width: 350px/359px/360px`, `min-width: 560px` e `max-height: 480px/500px/520px`): `min-width: 600px` / `max-width: 599px` (grade da Início: `home-page.css:238-267`), `min-width: 640px` (folha vira cartão centrado: `apps/web/src/app/modules/devices/pair-sheet.css:21-26`), `min-width: 520px` (nome da TV: `tv-page.css:193-197`), `max-height: 700px` (entrada compacta: `apps/web/src/app/core/auth/auth-layout.css:76-90`), `min-aspect-ratio: 6/5` (TV deitada: `tv-page.css:384-401`).
- Meta viewport: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` (`apps/web/src/index.html:6-9`).
- Área segura de baixo, num lugar só: `--safe-inset: env(safe-area-inset-bottom, 0px)`, `--safe-floor: 0px` (8px no app instalado com ponteiro de toque), `--safe-bottom: max(var(--safe-inset), var(--safe-floor))`, `--kb-inset: 0px` (altura que o teclado virtual cobre; posto por `apps/web/src/app/core/layout/keyboard-inset.ts`). Todo rodapé, folha, aviso ou botão fixo embaixo usa `--safe-bottom`, nunca `env(safe-area-inset-bottom)` solto (`styles.css:52-62`, `248-253`). Exceção conhecida a corrigir: a folha de Créditos do Treino (`apps/web/src/app/modules/training/credits/credits.page.css:7-9`) usa `90dvh` e `env(safe-area-inset-bottom)` direto.
- Laterais e topo: `max(var(--gutter), env(safe-area-inset-left|right))` e `env(safe-area-inset-top)` (`apps/web/src/app/shared/ui/page-top-bar.ts:51-57`, `styles.css:555-556`).

### 3.10 Regra única de tamanho

Uma regra só, usada por todas as telas. Ela vale para tela nova e para toda tela que for mexida; as outras entram quando forem tocadas (não há obra de uma vez).

| Faixa de largura | Largura útil | Uso |
| --- | --- | --- |
| Estreito | até 359px | Telefones pequenos: nada pode quebrar nem encolher abaixo do alvo de toque |
| Celular | 360px a 599px | Faixa de referência (iPhone 12 em 390px, Galaxy S23 FE em 411px) |
| Largo | 600px ou mais | Tablet e computador: a coluna não estica |

- **Altura:** "tela baixa" é menos de 560px úteis (a tela menos a barra do navegador e as bordas do aparelho). Nela o topo encolhe e a tela rola, em vez de espremer botão. A altura útil é uma só conta, feita num lugar e usada por TV, PC e Treino.
- **Alvo de toque:** nunca menor que 44px (`--tap`). Texto e botões crescem com a tela até um teto.
- **Coluna com teto, centrada:** leitura até `--col-read` (40rem, 640px); controles (TV e PC) até `--col-control` (36rem, 576px). Os dois são tokens em `styles.css`; use-os no lugar de `rem` solto.
- Pontos de corte novos só nestas fronteiras (359/360 e 599/600 de largura; 560 de altura). Os cortes antigos (350, 520, 640, 700...) saem à medida que cada tela é tocada.

## 4. Layout

**Alvos de verificação** (`apps/web/playwright.config.ts:26-39`):

| Alvo | Viewport útil | Motor | Papel |
| --- | --- | --- | --- |
| iPhone 12, Safari, com a barra do navegador visível | 390 x 664 | WebKit | Principal |
| Android (Galaxy S23 FE, Chrome) | 411 x 800 | Chromium | Secundário |

O que cabe acima de 664 px de altura é o que se vê sem rolar: a hierarquia precisa caber ali. Ao rolar, a barra do Safari recolhe e a altura útil sobe para cerca de 734 px (medido; sem fonte no código, não é token).

**Regras.**

- Página: `main` com `padding: var(--gutter)` e `padding-bottom: calc(var(--gutter) + var(--safe-bottom))` (`styles.css:255-258`). Casca: coluna flex com `min-height: 100dvh` (`app-shell.ts:60-64`). Sem cabeçalho (Início), o topo soma `env(safe-area-inset-top)` (`app-shell.ts:73-75`).
- Sem rolagem horizontal, nunca: `overflow-x: hidden` com reserva e `overflow-x: clip` em `html, body` (`clip` não cria contêiner de rolagem, o que preserva o `position: sticky`: `styles.css:177-184`).
- Largura toda no telefone; em tablet e computador a coluna tem teto e fica centrada (`margin-inline: auto`):

| Tela | Teto | Fonte |
| --- | --- | --- |
| Início | 46rem | `home-page.css:10` |
| Ajustes, Dispositivos, Hoje do Treino | 40rem (`--col-read`) | `apps/web/src/app/modules/settings/settings.page.css:10`, `devices.page.css:5` |
| Barra de ação fixa (conteúdo) | 40rem | `styles.css:565` |
| Controle da TV | 36rem (60rem deitado) | `tv-page.css:19`, `386-391` |
| Cartão de entrada | `min(100%, 26rem)` | `auth-layout.css:63-73` |
| Folha em tela larga | `min(100%, 34rem)` | `pair-sheet.css:21-26` |

- Barra de abas embaixo (`position: sticky; bottom: var(--kb-inset)`), só nos módulos que a declaram (`app-shell.ts:83-86`). Telas de edição do Treino não têm a barra (cobriria o teclado) e usam `.ui-action-bar` (`apps/web/src/app/modules/training/training.routes.ts:25-27`).
- Rolagem: a página rola, a barra de abas e as barras fixas ficam; diálogos usam `overscroll-behavior: contain`. A barra de rolagem estilizada só vale onde há mouse (`@media (hover: hover) and (pointer: fine)`: 10px, polegar `--a-ink3`, `styles.css:188-226`); no toque vale a do sistema.
- Seleção de texto desligada fora de campos (`user-select: none`); campos de texto e `.ui-selectable` restauram (`styles.css:267-303`).
- Teclado virtual: folhas sobem com `margin-bottom: var(--kb-inset)` e `max-height: min(88dvh, calc(100dvh - var(--kb-inset) - var(--space-6)))` (`styles.css:1157-1160`).

## 5. Componentes (primitivas)

Prefixo `ui-` global (`apps/web/src/styles.css`). Classes locais (`.card`, `.row`, `.primary`) ficam encapsuladas em cada componente e não fazem parte do sistema (`styles.css:305-309`).

### 5.1 Botão `.ui-btn`

| Variante | Classe | Aparência | Linhas |
| --- | --- | --- | --- |
| Neutra (padrão) | `.ui-btn` | Fundo `--a-surface`, borda 1px `--a-line`, texto `--a-ink`, raio `--radius` | `483-505` |
| Secundária | `.ui-btn.secondary` | Igual à neutra no repouso; só tem estilo de hover (`--a-elev`) | `534-537` |
| Primária | `.ui-btn.primary` | Fundo e borda `--a-accent`, texto `--a-on-accent`, `--shadow-1`; hover `--shadow-2` | `511-516`, `539-541` |
| Perigo | `.ui-btn.danger` | Fundo e borda `--a-bad`, texto `--a-on-accent` | `518-522` |
| Linha toda | `.ui-btn.block` | `display: flex; width: 100%` | `524-527` |

Tamanho: `min-width` e `min-height` `--tap` (44px), padding horizontal `--space-4`, peso 650, `gap: --space-2`. Rodapé de folha pode subir para `min-height: 48px` (`apps/web/src/app/modules/pc/ui/confirm-sheet.css:67-70`). Desabilitado: `opacity: 0.55`. Sem transição de cor de fundo (evita meio-termo ao trocar de tema: `styles.css:500`). Uma primária por tela.

Círculo de 44px (voltar, energia, mais): borda `--a-line`, fundo `--a-surface`, `border-radius: 50%`, hover borda `--a-accent`, desabilitado `opacity: 0.4` (`apps/web/src/app/modules/tv/tv-page.css:55-79`, `page-top-bar.ts:66-95`). Pílula: vários controles no mesmo contorno, cada um com alvo de 44px (`page-top-bar.ts:104-110`).

### 5.2 Cartão e grupo

| Classe | Aparência | Linhas |
| --- | --- | --- |
| `.ui-card` | Borda 1px `--a-line`, raio `--radius-lg`, fundo `--a-surface`, `--shadow-1` + brilho interno | `846-853` |
| `.ui-card.calm` | Afundado: fundo `--a-surface-2`, sem sombra (módulo sem tela) | `1012-1020` |
| `.ui-press` | Cartão tocável: afunda (scale 0.985), hover realça borda (acento 38% sobre `--a-line`) e `--shadow-2` | `856-875` |
| `.ui-group` | Cartão que reúne linhas separadas por fio; `overflow: hidden`, raio `--radius-lg` | `329-340`, `352-355` |

Cartão de módulo na Início: centrado, `min-height: clamp(160px, 42vw, 176px)`, padding `16px 12px`; planejado: borda tracejada 2px `--a-line`, fundo transparente, sem sombra (`home-page.css:269-296`).

### 5.3 Linha e lista `.ui-row`

`display: flex`, `gap: --space-3`, `min-height: 60px`, padding `--space-3 --space-4` (`styles.css:342-350`). Partes: `.ui-row-text` (coluna, `gap: 2px`), `.ui-row-title` (peso 650), `.ui-row-sub` (`--a-ink2`, `--fs-small`). Como link ou botão (`a.ui-row`, `button.ui-row`): largura total, pressionado `--a-elev`, hover `--a-surface-2` (`375-399`). Ladrilho de ícone `.ui-tile` 40x40, raio `--radius-sm`, fundo `--a-accent-soft`, tinta `--a-accent-ink`, glifo 22px; tons `.ok`, `.warn`, `.bad`; `.lg` 48x48, raio 16px, glifo 28px (`401-431`, `1058-1071`). Seta de navegação: glifo 20px, `--a-ink3`, à direita (`settings.page.css:25-29`). Lista sem marcador: `.ui-plain` (`312-316`). Rótulo de seção: `.ui-section-label` (`318-326`).

### 5.4 Campo e entrada

- `.ui-field`: coluna, `gap: --space-2`; rótulo `--fs-small`, peso 650, em cima (`580-589`).
- `.ui-input`: largura total, `min-height: 48px`, padding horizontal `--space-3`, borda 1px `--a-ink3` (contorno de contraste suficiente), raio `--radius`, fundo `--a-surface-2` (`591-603`). Foco: borda `--a-accent` e `--a-ring` (`605-608`); nas telas de entrada o foco é um contorno de 2px `--a-accent` afastado 2px, sem anel de sombra (`apps/web/src/app/core/auth/auth-field.css:29-33`). Inválido: borda `--a-bad` (`auth-field.css:25-27`).
- Interruptor `.ui-switch` (`<input type="checkbox" role="switch">`): 52x32, raio 16px, pino 26px; ligado: fundo `--a-accent`, pino `--a-on-accent`, desloca 20px (`785-832`).
- Opção de tema em Ajustes: cartão de borda 2px `--a-line`; marcado: borda `--a-accent`, fundo `--a-accent-soft`, `--a-ring` (`appearance.page.css:67-103`).
- Barra de ação fixa `.ui-action-bar`: fixa embaixo, sobe com `--kb-inset`, borda superior `--a-line`, fundo `--a-surface`, `z-index: 2`; o formulário reserva espaço com `.ui-has-action-bar` (`styles.css:550-577`).
- Código de pareamento: monoespaçado 1.25rem, `letter-spacing: 0.12em`, maiúsculas (`pair-sheet.css:92-97`).

### 5.5 Folha e diálogo

`<dialog class="sheet ui-dialog">` modal, colado ao rodapé, largura total (`pair-sheet.css:1-30`, `training-sheet.css:1-35`):

| Propriedade | Valor padrão |
| --- | --- |
| Altura máxima | `88dvh` (com teclado: ver 4) |
| Margem | `auto 0 0` |
| Raio | `--radius-xl --radius-xl 0 0` |
| Fundo / sombra | `--a-surface-raised` / `--shadow-3` |
| Padding | `--space-2 --gutter`, embaixo `calc(--space-5 + --safe-bottom)` |
| Fundo atrás (`::backdrop`) | `rgb(8 16 10 / 0.52)` |
| Alça | 40x5, raio pílula, `--a-line` |
| Título | `--fs-title`, peso 750, `-0.01em` |
| Entrada | sobe `--dialog-shift` (40px nestas folhas) |
| Tela larga (>= 640px) | cartão de 34rem centrado, ainda colado ao rodapé |

Rodapé de ação é `sticky` dentro da folha. Fechar: toque no fundo só vale se o toque começou e terminou no fundo (`dialog-motion.ts:15-29`). Diálogo de confirmação central: `.box.ui-dialog` (`apps/web/src/app/core/auth/step-up/step-up-dialog.html:3`).

### 5.6 Barra superior de módulo `app-page-top-bar`

`apps/web/src/app/shared/ui/page-top-bar.ts:40-153`. Grade de 3 colunas `minmax(44px, 1fr) minmax(0, auto) minmax(44px, 1fr)` com `column-gap: 4px`: o título fica no centro real da tela mesmo sem ação. Altura mínima `calc(44px + 12px + 4px + env(safe-area-inset-top))`; padding superior `12px + inset`, laterais `max(--gutter, inset)`, embaixo 4px; fundo transparente. À esquerda, a seta de voltar (círculo 44px com fundo, ícone 22px, traço 2.2); ao centro `h1` de `1.35rem`, centrado, uma linha, reticências; à direita, as outras ações como ícones soltos (sem fundo nem contorno, alvo de 44px). Regra do topo: "voltar" é sempre o círculo com fundo; as outras ações são ícones soltos; "mais opções" é sempre o mesmo desenho de três pontos em pé (`dots`, no Treino). Foco por código no `h1` (sem anel). A casca soma `padding-top: var(--gutter)` (`app-shell.ts:65-68`). O botão de Configurações existe só no topo da Início; nenhum módulo tem atalho para Ajustes (`app-shell.ts:34-35`).

### 5.7 Barra de abas `app-tab-bar`

`apps/web/src/app/shared/ui/tab-bar/tab-bar.ts:90-195`. Embaixo, `position: sticky` (casca), fundo `--a-surface`, borda superior 1px `--a-line`, `padding-bottom: --safe-bottom`. Itens `flex: 1 1 0`.

| Variante | Item | Ativo |
| --- | --- | --- |
| Só texto | Para abas sem ícone: `min-height: 56px`, peso 600, `--a-ink2` | Texto `--a-accent` e borda superior 3px `--a-accent` |
| Ícone e nome (Treino e PC) | Vale para qualquer módulo cujas abas declaram `icon` (Treino: hoje, exercícios, progresso; PC: mouse, atalhos, mídia, mais): ícone 20px + rótulo `0.75rem`, `min-height: 64px`, coluna, sombra `0 -5px 18px` | Pílula de 64x30 `--a-accent-soft` atrás do ícone; o rótulo nunca some |

Ativo marcado por `aria-current="page"`, calculado pelo caminho (`nested`, `also`).

### 5.8 Esqueleto e carregamento

- **`.ui-skeleton`** (`styles.css:640-652`): `min-height: 18px`, raio `--radius-xs`, gradiente `100deg` de `--skeleton-base` (padrão `--a-elev`) com realce `--skeleton-glint` no meio, animação `ui-shimmer`. Superfícies tingidas (faixa da Início) trocam só essas duas variáveis (`home-page.css:129-135`). É o único desenho de espera do app. Diretiva: `[appSkeleton]` põe `ui-skeleton` e `aria-hidden` (`apps/web/src/app/shared/ui/skeleton/skeleton.ts`).
- **`.ui-wait`**: forma ocupa o lugar desde o primeiro quadro, mas só aparece após `--wait-delay` (200ms); `0ms` com `html.has-boot-skeleton` (`styles.css:733-748`).
- **`app-loading-frame`** (`loading-frame.ts:47-114`): moldura de toda espera por dado. Tem `aria-busy="true"`, texto `role="status"` só para leitor de tela (`.ui-visually-hidden`), formas em `aria-hidden`. Depois de 20s (`giveUpAfterMs`, `loading-frame.ts:19-22`) o brilho para e vira `.ui-notice.bad` com `role="alert"`, "Está demorando mais do que o normal." e botão "Tentar de Novo".
- **Esqueleto de abertura** `.bs-root` / `.bone` (`index.html:21-80`, `boot-skeleton.css`): cobre a tela antes de qualquer JavaScript. Fundo `#f2f5f1` (claro) / `#101512` (escuro); osso `#d8e0d7` / `#2f3b33`, `min-height: 14px`, raio 8px (`index.html:22-79`). O desenho do Angular (`z-index: 1000`, fundo `--a-bg`) assume por cima do estático (999) sem pulo; sai com `bs-fade-out` em `--dur-exit` (`boot-skeleton.css:9-31`). A variante vem de `html[data-boot]` (início, tv, pc, treino-*, ajustes...: `boot-skeleton.css:56-72`). Medidas dos ossos seguem as da tela real em 390px. Passado muito tempo sem o app subir, o desenho some e entra um aviso com ação (`.bs-boot-timeout`, `boot-skeleton.css:36-54`).
- **`.ui-spinner`**: 16px, anel de 2px (`--a-line`, topo `--a-accent`), `ui-spin` (`styles.css:654-663`).

### 5.9 Estado: ponto, chip, aviso

- **`.ui-chip`**: pílula `min-height: 26px`, padding `2px 10px`, fundo `--a-elev`, `0.8125rem`, peso 650; tons `.accent`, `.ok`, `.warn`, `.bad` (fundo `-soft`, texto `-ink`) (`434-467`).
- **`.ui-dot`**: 8px, cor `currentColor` (`469-480`). Estado nunca só por cor: o ponto vem com texto ou forma.
- **Ponto de estado do agente na Início**: 9px; `--a-ok`, `--a-warn`, `--a-ink3` (neutro); conectando usa `--a-accent` com halo leve de 1.8s (`home-page.css:98-126`); tem `role="status"` e rótulo.
- **Ponto de estado da TV `app-status-dot`**: 24px (`1.5rem`), cada fase com cor e forma: conectada (cheio, `--a-ok`), dormindo (anel, `--dot-sleep`), conectando (alvo que pulsa, `--a-ok`), sem resposta (cheio com exclamação, `--a-warn`), agente desligado (anel com traço, `--a-ink3`), PC desligado (monitor dormindo, `--a-ink3`), sem rede (círculo cortado, `--a-bad`), atenção (exclamação, `--a-bad`) (`apps/web/src/app/modules/tv/ui/status-dot.css:55-93`, `status-dot.ts:6-14`). Pulso só sem movimento reduzido.
- **Faixa de conexão do app (`app-connectivity-banner`)**: ponto de 10px à esquerda da linha; cheio e pulsando no tom de atenção enquanto o servidor acorda, vazado quando não há conexão.
- **Pílula de estado do PC**: verde primeiro, estado antes de tudo; pronto usa `--a-ok-soft`/`--a-ok-ink`, desconectado usa ponto vazado (`apps/web/src/app/modules/pc/pc-page.css:15-60`).
- **`.ui-notice`** (aviso em linha): tom por `--tone` (padrão `--a-accent`; `.ok`, `.warn`, `.bad`), fundo 10% do tom sobre `--a-surface`, borda 1px 32% do tom sobre `--a-line`, raio `--radius`, padding `--space-3 --space-4`, `--fs-small`, peso 600, texto em `--a-ink` (`611-636`). Variante de entrada: fundo 9%, borda 34%, ícone 22px (`auth-notice.css:1-40`).
- **Toast / aviso passageiro**: não definido globalmente. Existe só na TV: fixo embaixo (`bottom: gutter + safe-bottom + kb-inset`), até 36rem, borda esquerda 4px `--a-accent` (`--a-bad` no erro), sombra `0 6px 20px rgb(0 0 0 / 0.18)`, entra por `@starting-style` (`tv-page.css:328-348`, `349-380`). Sem toque (`pointer-events: none`).

### 5.10 Os cinco estados: carregando, sem conexão, erro que passa, erro que bloqueia, vazio

Uma forma por estado, igual em toda tela; a pessoa aprende uma vez.

- **Carregando:** o desenho de espera da tela (`app-loading-frame` com `.ui-skeleton`).
- **Sem conexão:** o ponto de estado (vazado, no tom de atenção) e uma linha curta; a faixa de topo do app (`app-connectivity-banner`) é o modelo. Com ação possível, a linha traz o botão "Tentar de Novo".
- **Erro que passa:** aviso passageiro no mesmo lugar da tela (hoje só existe na TV), some sozinho ou ao toque.
- **Erro que bloqueia:** caixa em linha (`.ui-notice.bad`) com o botão "Tentar de Novo"; é o único nome do botão de repetir (nada de "Tentar Novamente" nem "Tentar de novo").
- **Vazio:** desenho, título curto e um botão.

Vazio e erro, no detalhe:

- Vazio: ícone ou desenho, título curto centrado (Title Case no Treino: "Nenhum Exercício Achado"), uma frase em caixa de frase com o próximo passo, e uma ação ("Limpar Filtros"). Exemplo: `library.page.html:141-146`. Na Início, vazio ocupa a linha toda (`home-page.css:246-248`).
- Erro de leitura: frase curta ("O aparelho não conseguiu ler o catálogo.") e "Tentar de Novo" (`library.page.html:106-109`).
- Erro de formulário: `.ui-notice.bad`, e o foco vai para o aviso depois de um envio recusado (`auth-notice.css`).

### 5.11 Outros

`.ui-collapse` / `.ui-collapse-inner` (faixa que abre e fecha), `.ui-rise` / `.ui-stagger` (entrada), `.ui-tap` (controle pequeno), `.ui-visually-hidden` (texto só para leitor de tela, `styles.css:692-702`), `.ui-selectable` (texto copiável).

## 6. Conteúdo e acessibilidade

### 6.1 Texto

Ver seção 2. Mensagens de erro dizem o que fazer, não o que quebrou. Texto de estado tem duas versões quando útil: visível curto, `aria-label` completo (ex.: TV: nome completo no rótulo do botão).

### 6.2 Alvo de toque

44px é o mínimo (`--tap`). O teste `smallTargets` reprova qualquer `a[href], button, input, select, textarea, [role=switch], [role=radio]` visível com `min(largura, altura) < 43.5`; caixas de marcar e rádios são medidas pelo `label` ou `li` que as envolve (`apps/web/e2e/screens/screen-helpers.ts:39-65`). O desenho pode ser menor que o alvo (ponto de 9px dentro de um botão de 44px; engrenagem de 21px com alvo de 44px: `home-page.css:81-90`).

### 6.3 Contraste e cor

- Não há limiares numéricos de contraste no código; o árbitro é o axe-core. `expectNoA11yViolations` falha com QUALQUER violação, inclusive leve e moderada (`screen-helpers.ts:29-37`).
- Decisões que protegem o contraste: texto de aviso em `--a-ink` (`styles.css:610`); `.ui-rise` não parte da transparência, então o contraste vale desde o primeiro quadro (`styles.css:665`); contorno de campo em `--a-ink3`; texto colorido usa `-ink`; verde claro do tema escuro não serve para o desenho branco dentro do ícone de módulo (por isso o fundo do ícone é recolorido: `home-page.css:338-348`).
- Cor nunca é a única pista (5.9).

### 6.4 Foco, movimento, ARIA

- Foco de teclado: contorno de 3px `--a-accent`, `outline-offset: 2px` (`styles.css:238-241`); o clique e o toque não deixam anel (`:focus:not(:focus-visible)`, `243-246`). Campos de entrada usam 2px afastado (5.4). Título recebido por código não ganha anel.
- Movimento reduzido: seção 3.7.
- Padrões usados: `aria-busy` na moldura de espera; `role="status"` para estado e texto de espera; `role="alert"` para falha; `aria-current="page"` na aba e na seção ativa; `aria-label` em botões só de ícone; `aria-hidden` em ícones e formas de esqueleto; `<dialog>` modal com `aria-labelledby`; rádio e interruptor reais (`role="switch"`). Em Ajustes, cada tela nova move o foco para o `h1` (`app-shell.ts:120-136`, `151-157`).

### 6.5 Restrições de CSP que afetam o estilo

A política é `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-{nonce}'; img-src 'self' data:; font-src 'self'; ...` (`apps/api/src/UniOver.BuildingBlocks.Web/Security/SecurityHeaders.cs:29-32`).

- Sem `style=""` em elementos: valor dinâmico entra por variável CSS (`[style.--x]`) ou CSSOM; `<style>` em linha só com `nonce` (`apps/web/src/index.html:21`). O teste `csp-strict.spec.ts` fecha esta porta.
- Sem fonte web (`font-src 'self'`, sem arquivo de fonte no app): usar a pilha do sistema.
- Sem imagem remota (`img-src 'self' data:`).

## 7. Notas por módulo

- **Início** (`apps/web/src/app/modules/home/`): sem barra de módulo nem abas. Topo próprio em grade `44px | 1fr | 44px`: engrenagem à esquerda, marca "UniOver" centrada (800, fluida, `nowrap`), ponto de estado do agente à direita (`home-page.css:14-44`). Faixa de saudação `--a-hero` com raio `--radius-xl` e `--shadow-2` (`47-62`). Cabeçalho de seção "Módulos" + "Editar". Grade de 2 colunas (6 colunas, cartões de span 2, a partir de 600px); com número ímpar, o último centraliza (`225-267`). Ícone de módulo `clamp(72px, 19vw, 80px)` (`299-304`). Módulo sem tela: cartão calmo tracejado com "Em Breve".
- **TV** (`apps/web/src/app/modules/tv/`): sem barra de abas; o controle usa a altura útil inteira (`--tv-avail`, mínimo `--tv-min: 500px`) e só rola abaixo dela (`tv-page.css:1-22`). Cabeçalho em uma linha, grade `minmax(side,1fr) auto minmax(side,1fr)`: voltar e três pontos à esquerda, nome ao centro (reduz por tamanho do nome; até 2 linhas), ponto de estado e energia (`--a-bad`) à direita (`43-52`, `85-87`, `120-200`). Anel direcional 220px (`directional-ring.css:8`), teclado numérico, folhas Personalizar, Desligar, Limpeza. Deitado (`min-aspect-ratio: 6/5`): duas colunas (`384-401`).
- **Treino** (`apps/web/src/app/modules/training/`, rota com `data: { shellStyle: 'training' }`, `training.routes.ts:38`): a casca NÃO desenha a barra superior; `main` fica sem padding (`app-shell.ts:41,80-82`) e `TrainingPage` desenha a própria `app-page-top-bar` fixa (`sticky`, `z-index: 5`, fundo `--a-bg`) com pílula de ações (anel de sincronização + "•••") (`training.page.ts:57-80`, `140-146`). Abas inferiores na variante `training` (Exercício, Início, Progresso, com ícone). Seletor segmentado Treinos | Corpo: fundo `--a-elev`, item ativo `--a-surface` (`training.page.ts:180-203`). Telas de edição sem abas, com `.ui-action-bar`. Títulos fluidos e Title Case dominante (seção 2). Ilustração de exercício em quadro branco fixo nos dois temas.
- **PC** (`apps/web/src/app/modules/pc/`): barra superior padrão com título "Controle do PC" e abas de texto (Touchpad, Teclado, Mídia, Energia). Primeiro o estado (pílula centralizada, verde primeiro), depois a área ativa; touchpad `min-height: 260px`, raio 24px (`touchpad.page.css:18-20`); a tela cabe entre o topo e as abas (`pc-page.css:5-12`). Ações destrutivas (desligar) passam por `confirm-sheet`.
- **Ajustes** (`apps/web/src/app/modules/settings/`): título "Configurações", rota com `settings: true`; cartões usam raio `--radius` (14px) em vez de `--radius-lg`; foco vai ao `h1` a cada tela. Coluna de 40rem, seções de `.ui-section-label` + `.ui-group` de `.ui-row` com seta à direita (`settings.page.css`). Aparência: três opções com amostra. Telas internas (pessoas, auditoria, sistema, TV) seguem o mesmo padrão e usam folhas para edição e filtros.
- **Dispositivos** (`apps/web/src/app/modules/devices/`): coluna de 40rem; cada item é cartão com resumo de estado em grade de 2 colunas (`devices.page.css:20-50`); computador desconectado com pista de partida ganha uma linha curta abaixo do resumo ("Não conseguiu iniciar: o antivírus bloqueou", "Credencial recusada"), com marca redonda "!" além da cor (`.startup`, `devices.page.css`); pareamento, conexão e registro do agente em folhas (`pair-sheet.css`, `connect-sheet.css`, `agent-log-sheet.css`, registro em monoespaçada).
- **Entrada e login** (`apps/web/src/app/core/auth/`): sem casca de módulo. Palco alinhado ao topo, respiro `--stage-top: clamp(16px, calc((100dvh - 664px) * 0.6 + 16px), 7rem)` e brilho radial do acento a 13% (`auth-layout.css:14-31`); marca de 60px (48px abaixo de 700px de altura) e nome 1.5rem (`33-61`, `75-90`); cartão central de 26rem, padding 24px, raio `--radius-xl`, `--shadow-2` (`63-73`). Título fluido centralizado; campos em largura total; ação primária em linha toda. Outras telas: convite, boas-vindas ("Como devemos te chamar?"), login por QR, confirmação com senha.

## 8. Verificação

- **Poucas capturas.** Capturar só o que mudou, no iPhone 12 (390 x 664), em um tema; o segundo tema só quando cor ou contraste é o ponto. Nunca refazer captura de tela que não mudou. Testes continuam completos.
- **Rodar** (em `apps/web`): `npm run lint` (variáveis CSS e ESLint), `npm test`, `npm run e2e` (projetos `iphone-12` e `s23-fe`, `playwright.config.ts:26-39`).
- **Checar em cada tela nova:** alvos de 44px (`smallTargets`), axe sem violação alguma (`expectNoA11yViolations`), sem rolagem horizontal, título em uma linha em 360 a 430px, `prefers-reduced-motion` coberto, dois temas legíveis, estado de espera com forma própria da tela (sem esqueleto genérico), distância do topo (`apps/web/e2e/screens/top-bar-spacing.spec.ts`) e área segura de baixo (`apps/web/e2e/screens/bottom-safe-area.spec.ts`).
- **Depois de publicar**, conferir a tela em produção, não só no ambiente local.

## 9. O que evitar (lista de conferência) e inconsistências conhecidas

Antes de entregar uma tela:

- [ ] Nenhum subtítulo explicativo, nenhum slogan.
- [ ] Título em uma linha, com `clamp()`; sem palavra órfã.
- [ ] Uma só ação primária (`.ui-btn.primary`); o resto é secundário ou fica atrás de um toque.
- [ ] Só tokens (`--a-*`, `--space-*`, `--radius-*`, `--fs-*`); nada de hexadecimal novo (exceção documentada na seção 3.2).
- [ ] Os dois temas definidos; nada colorido só por cor.
- [ ] `--safe-bottom` em vez de `env(safe-area-inset-bottom)`; `--kb-inset` em rodapés fixos.
- [ ] Sem `style=""`, sem fonte web, sem imagem remota.
- [ ] Alvo de toque >= 44px; foco visível por teclado.
- [ ] Toda animação tem saída em `prefers-reduced-motion`; duração entre 120 e 360ms, sem rebote.
- [ ] Espera usa `.ui-skeleton` dentro de `app-loading-frame`, não spinner solto nem esqueleto genérico.

Inconsistências encontradas no código (reportar ao corrigir; o código atual manda):

1. `--a-danger` é usado (com fallback `#a32929`) em nove arquivos e nunca é definido; renderiza vermelho fixo nos dois temas em vez de `--a-bad`. `check-css-vars` ignora usos com fallback. Ex.: `apps/web/src/app/modules/training/foods/food-diary.page.css:114`, `apps/web/src/app/modules/training/body/weight/weight-sheet.css:15`. O mesmo vale para `--a-accent` com fallback `#276749` (token existe; o fallback nunca vale).
2. Osso do esqueleto de abertura `#d8e0d7` (`index.html:56`) difere de `--a-elev` `#e5ebe4` (`styles.css:6`).
3. (Resolvida) Raio e fundo atrás da folha agora são `--radius-xl` e `rgb(8 16 10 / 0.52)` também na confirmação do PC e nas folhas da TV.
4. (Resolvida) Ver o item 3.
5. Título da barra superior fixo em `1.35rem` (`page-top-bar.ts:148`), contra a regra de título fluido.
6. Paleta escura duplicada (`styles.css:116-138` e `140-160`): alterar sempre os dois blocos.
7. Dois serviços gravam `data-theme` (`ThemeService` e `AppearanceService`).
8. `.ui-btn.secondary` só tem hover; no repouso é igual a `.ui-btn`.
9. O fundo dos ícones de módulo da Início vem dos tokens `--a-module-app` e `--a-module-app-planned` do próprio ícone (`module-app-icon.ts`), com a mesma guarda da paleta do `styles.css`: o tema fixado no app vale mais que o do sistema.
10. O manifesto aceita uma cor de barra só (`theme_color`, igual ao fundo claro); a cor por tema vem das `<meta name="theme-color">` do `index.html`. O Android instalado pode seguir só o manifesto na barra de navegação (sem fonte primária), então no tema escuro dessa barra o app não garante a cor. O indicador de início do iPhone não tem cor: mostra o que a página pinta atrás dele. Com o teclado aberto (`--kb-inset` ≥ 80 px) `--safe-bottom` vale 0, pela conta em `styles.css`.
11. (Parcial) A aba do Treino que se chamava "Início" agora se chama "Treino" (`training.routes.ts`). O título oculto da tela (`h2` em `today-home.html`) ainda diz "Início"; trocar pede acertar os testes que o procuram.
12. Não há toast global nem tokens de z-index e de breakpoint.
