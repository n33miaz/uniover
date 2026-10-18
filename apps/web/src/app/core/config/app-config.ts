/** Configuração fixa do cliente. O proxy de dev e a API em produção atendem a mesma origem. */
export const APP_CONFIG = {
  apiBase: '/api',
  healthPath: '/health',
} as const;
