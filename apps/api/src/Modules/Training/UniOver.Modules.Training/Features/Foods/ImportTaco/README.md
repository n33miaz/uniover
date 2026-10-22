# Importação CSV de alimentos TACO

O módulo não distribui nem inclui dados da TACO. O endpoint, restrito ao proprietário, recebe o CSV fornecido por ele em UTF-8, `text/csv`, limitado a 1.000.000 bytes, usando `POST /api/v1/training/foods/imports/taco` com `Idempotency-Key`. As linhas são gravadas no catálogo global como origem `taco`; não são dados privados do proprietário.

O cabeçalho obrigatório, nesta ordem, é:

```csv
code,name,kcal_100g,protein_g,carb_g,fat_g
```

`code` é a chave estável de origem; `name` é o nome do alimento; macros usam ponto decimal e são por 100 g. Linhas inválidas são relatadas em `invalidRows` (número da linha, começando em 1) e as demais continuam. O proprietário deve importar somente arquivo TACO obtido legitimamente e verificar as condições de uso/reprodução. O serviço não valida procedência nem aplica atribuição oficial: cada linha registra que o CSV foi fornecido pelo proprietário e que origem/licença não foram verificadas. Não envie dados sintéticos ou de outra origem por este endpoint.
