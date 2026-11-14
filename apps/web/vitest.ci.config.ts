import { defineConfig } from 'vitest/config';

// Só para a CI (`npm run test:ci`): o executor do GitHub tem 2 núcleos e, com os arquivos de teste em paralelo,
// testes de tempo e de medida de tela falham ao acaso. Um trabalhador por vez deixa a execução previsível.
export default defineConfig({
  test: { maxWorkers: 1, fileParallelism: false },
});
