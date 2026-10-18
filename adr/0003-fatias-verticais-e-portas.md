# 0003. Fatias verticais com portas e adaptadores dentro de cada módulo

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

Dentro de um módulo, organizar por tipo técnico (controllers, services, repositories) espalha cada caso de
uso por várias pastas e faz toda mudança tocar muitos lugares. Ao mesmo tempo, as regras de negócio precisam
ficar livres de EF, ASP.NET e transporte para serem testáveis e para os adaptadores serem trocáveis (por
exemplo, WebSocket hoje e MQTT amanhã).

## Decisão

Cada módulo se organiza assim:

- `Features/`: uma pasta por caso de uso (fatia vertical), com endpoint, comando, validador e handler juntos.
- `Domain/`: entidades, objetos de valor e regras puras, sem EF, sem ASP.NET, sem `HttpClient`.
- `Ports/`: interfaces que o módulo precisa do mundo externo.
- `Adapters/`: implementações das portas (EF, clientes externos, transporte).
- `Persistence/`: o `DbContext` do módulo, configurações e migrations.

Handlers são classes simples injetadas, sem biblioteca de mediação. A entrada é validada na borda e o erro
vira `ProblemDetails` (RFC 9457). Comentários explicam o porquê, em pt-BR; identificadores ficam em inglês.

## Consequências

- Mudar ou apagar um caso de uso mexe numa pasta só.
- `Domain/` é testado sem rede nem disco; trocar um adaptador não toca nas regras.
- Um teste de arquitetura impede `Domain/` de referenciar infraestrutura e handlers de usarem o `DbContext`
  de outro módulo.
- Algumas fatias terão um pouco de repetição; compartilhar só via `Domain/` ou `Ports/`.

## Alternativas consideradas

- **Camadas clássicas (controller, service, repository):** espalha cada caso de uso e favorece o acoplamento
  entre eles.
- **MediatR e similares:** acrescenta indireção e dependência sem ganho para o tamanho do projeto.
- **Arquitetura hexagonal completa por módulo, sem fatias:** pesada demais para casos de uso pequenos.
