import { HttpContextToken } from '@angular/common/http';

/**
 * Marca o pedido que não alimenta a conectividade nem a telemetria: o envio da própria telemetria. Se ele pudesse acender a faixa
 * de "acordando" ou gerar outro registro, uma queda de rede viraria uma fila de registros sobre a falha de registrar.
 */
export const QUIET_REQUEST = new HttpContextToken<boolean>(() => false);
