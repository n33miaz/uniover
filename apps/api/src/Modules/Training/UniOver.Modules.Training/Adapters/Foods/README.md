# Integração Open Food Facts

`HttpOffClient` centraliza a integração externa: host fixo `world.openfoodfacts.org`, pesquisa textual em `/cgi/search.pl` e consulta de código de barras na API de produto v3.6. Contato institucional configurado em `TRAINING_OFF_CONTACT` é obrigatório; sem ele, os endpoints respondem `503` sem rede. O cliente aplica timeout de oito segundos e identifica a aplicação no `User-Agent`; os limites locais são oito pesquisas e doze leituras por minuto, por processo.

A busca textual permanece no endpoint legado porque a documentação oficial ainda o descreve como a rota suportada para busca completa, enquanto Search-a-licious não documenta disponibilidade pública/limites operacionais suficientes para depender dele. O caminho legado não é recomendado pelo fornecedor e pode mudar ou ser descontinuado; não o espalhe fora deste adapter. A migração para outro serviço deve trocar o adapter e seus testes de contrato, mantendo host fixo, limites, timeout e a política de contato.

Produtos sem kcal ou qualquer macro requerido são descartados: nutrientes ausentes não são convertidos em zero. A API não grava nem registra os termos da busca.
