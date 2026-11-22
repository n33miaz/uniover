# 0019. Fluxo de produção pela `develop`

- **Status:** Proposto
- **Data:** 21/11/2026
- **Substitui:** [ADR 0013](0013-fluxo-de-git.md)

## Contexto

A publicação passou a sair da `develop`. A versão identifica quais commits chegam ao ambiente de
produção, enquanto entregas sem incremento de versão podem ser integradas para uma publicação futura.

## Decisão

- A `develop` é a branch protegida de produção. A `main` fica parada para entregas. Ela hospeda o
  [seletor do canal](../apps/agent/tools/update-channel.json), cujo `production_ref` aponta para `develop`.
  A promoção por PR de `develop` para `main` foi descontinuada.
- Abra um PR por entrega para `develop`, a partir de uma branch curta `feature/<subject>` ou `fix/<subject>`.
  Use Conventional Commits, integre por **rebase and merge** após os checks exigidos e remova a branch
  de trabalho após o merge.
- Antes de preparar uma publicação, confirme uma execução completa e bem-sucedida da
  [Nightly](../.github/workflows/nightly.yml) no commit que está na ponta da `develop`. Confira o SHA
  fixado pela rodada. Na execução manual, selecione `develop`. Quando o agendamento está disponível na
  branch padrão, o workflow programado faz checkout explícito da `develop`. A confirmação da Nightly
  é uma etapa operacional anterior ao PR de versão.
- No PR de versão, use o [script de versão](../scripts/release-version.mjs) para incrementar o SemVer em
  [`VERSION`](../VERSION) no nível `patch`, `minor` ou `major`, conforme a mudança. A preparação sincroniza
  os metadados do web, do agente e da API, atualiza as versões dos módulos afetados em
  [`modules.json`](../modules.json) e acrescenta a entrada ao [`CHANGELOG.md`](../CHANGELOG.md).
  Valide a preparação com o mesmo script, reúna as alterações em um commit `chore: release x.y.z`
  e integre o PR por rebase.
- O [Deploy](../.github/workflows/deploy.yml) só segue no merge de versão: o job `gate` confere se o
  assunto do commit de head do push é exatamente `chore: release x.y.z`. Nos outros merges ele encerra
  a execução com sucesso, sem migrar, publicar nem notificar. A execução manual (`workflow_dispatch`,
  inclusive o ensaio do alerta) passa sempre pelo `gate`. Como segunda proteção, se `VERSION` coincide
  com a maior tag `v*` e ela aponta para outro commit, o workflow encerra com sucesso, sem publicar
  nem migrar o banco. Para uma publicação, `version` roda `--verify` antes das
  migrações. A versão precisa superar a maior tag de versão. A igualdade é permitida para republicar o
  mesmo commit. Versões inválidas, inferiores ou divergentes dos metadados falham nessa etapa.
- O Deploy aplica migrações retrocompatíveis no Neon antes de acionar o Render para o commit da
  execução. Após `/health/version` confirmar o SHA e as verificações do PWA e da API passarem, o job
  `release` cria automaticamente a tag `vX.Y.Z` no commit publicado e o GitHub Release com a entrada do
  changelog. Uma nova execução para o mesmo commit pode completar a publicação usando a tag existente.

## Consequências

- O histórico de entregas fica linear. Cada versão publicada vincula o código no ar às notas da versão.
- Durante a troca no Render, a API anterior ainda usa o esquema já migrado. Mudanças incompatíveis
  no banco precisam ser feitas em etapas.

## Alternativas consideradas

- Manter a promoção para `main` acrescentaria uma segunda integração para cada publicação.
- Criar tags e releases manualmente exigiria conferir à parte se o commit marcado corresponde ao código no ar.
