# 0017. Instalação por usuário e pastas do agente no Windows

- **Status:** Proposto
- **Data:** 02/11/2026

## Contexto

O UniOver tem um PWA servido pela API e um agente local no Windows. Hoje o instalador usa `%LOCALAPPDATA%\UniOver` como pasta padrão de cada conta. Na primeira instalação a pessoa pode escolher outra pasta de disco local; nesse caso o lançador e `location.txt` continuam na pasta fixa e `app`, `runtime`, `config`, `logs` e `web` ficam na pasta escolhida, sempre dentro de uma subpasta `UniOver`. Reinstalações mantêm a escolha. O agente se atualiza sem administrador e a versão anterior fica em `app.previous` para reversão. Segredos de pareamento ficam no Cofre de Credenciais do Windows, não em arquivo.

O PC do dono ainda contém arquivos de layouts antigos na raiz. Não temos leitura do sistema de arquivos do PC do Raphael; a API só conhece o estado comunicado pelo agente. Atalhos e tarefa agendada ficam fora da pasta de instalação, e nomes antigos podem continuar visíveis se a migração não limpar todos os rastros próprios.

## Decisão proposta

1. **Instalação por conta, sem UAC para atualização.** Manter `%LOCALAPPDATA%\UniOver` como âncora imutável, com `launcher.vbs`, `launcher.ps1` e `location.txt` quando necessário. A tarefa agendada e o atalho de inicialização apontam só para essa âncora. Não usar `Program Files` para o agente que se atualiza por conta própria.
2. **Pasta de dados única por instalação.** Por padrão a própria âncora; em escolha avançada, `<disco local escolhido>\UniOver`. Guardar nela `app` (versão ativa), `app.previous` (reversão), `config`, `runtime`, `logs`, `tv`, `icons` e `web` (página local da instalação). A pasta escolhida pertence à conta do usuário, não é compartilhada entre contas do Windows.
3. **Nome de sistema único.** O rótulo público da tarefa, da entrada de inicialização e do menu Iniciar é `UniOver`. Os valores ficam no manifesto `apps/agent/tools/windows-startup.json`; mudar o manifesto e publicar uma atualização migra os rótulos sem pedir administrador. Limpar só atalhos/tarefas antigos comprovadamente nossos e preservar a opção de inicialização desativada pelo usuário.
4. **Instalação nova guiada.** Começar com uma tela de consentimento e resumo do que será instalado. Escolha principal: “Instalar para minha conta” no caminho padrão. “Escolher outra pasta” é opção avançada com prévia do destino e validação de disco local gravável. A pessoa escolhe iniciar com o Windows. Exibir progresso, pareamento, teste de conexão e conclusão no mesmo fluxo; nenhum passo depende de terminal visível. A elevação única fica restrita aos ajustes de energia/rede que a pessoa autorizou, separada do agente e da atualização.
5. **Reparo e remoção verificáveis.** O diagnóstico mostra caminho ativo, versão, tarefa, atalho, permissão de iniciar e estado do agente. A atualização corrige só itens próprios quebrados; a desinstalação remove tarefa, atalhos e arquivos de código, oferece escolha separada para apagar configuração/logs e revoga o pareamento. Migração de arquivos antigos é idempotente, mantém backup até a versão nova funcionar e nunca apaga credenciais do Cofre sem pedido explícito.

## Consequências

- O mesmo contrato de pastas vale para o dono, Raphael e qualquer novo Windows, mas a pasta personalizada de outro PC só é conhecida localmente por `location.txt`.
- A âncora não pode ser movida. Alterar a pasta de dados depois da instalação requer um fluxo próprio de migração, com parada, cópia verificada, troca atômica do ponteiro e reversão; não é uma edição manual do arquivo.
- O nome `UniOver` não comunica sozinho se a linha do Gerenciador de Tarefas inicia o agente ou só o ícone. A interface de diagnóstico deve explicar a diferença.
- O instalador atual já oferece seleção de pasta e progresso local, mas ainda usa um `.cmd` de entrada e diálogos separados; a tela guiada proposta precisa ser implementada e exercitada no Windows.

## Alternativas consideradas

- **`Program Files` para o código e `%APPDATA%` para dados:** exige administrador a cada atualização do código e dificulta a reversão automática. Guardar os dados duráveis em `%APPDATA%` ainda criaria sincronização/roaming sem necessidade.
- **Uma pasta global em `%PROGRAMDATA%`:** mistura contas, permissões e credenciais de pessoas diferentes, além de exigir elevação para instalar e atualizar.
- **Mover todas as instalações existentes imediatamente:** acrescenta risco ao agente já pareado e distante. O layout atual funciona; a limpeza dos resíduos legados pode ocorrer por etapas verificadas.
