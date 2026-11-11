/**
 * O canal direto (WebRTC) é do aparelho e mora em `core/direct/`: a tela do PC e a da TV o dividem, e um módulo nunca importa de outro.
 * Este arquivo só mantém, para o módulo do PC, os nomes de quando o canal era só dele.
 */
export {
  ACK_TIMEOUT_MS,
  CLOCK_TIMEOUT_MS,
  DIRECT_BACKOFF_MS,
  DIRECT_POINTER_INTERVAL_MS,
  DirectChannel as PcDirect,
  DirectNotSent,
  DirectSignaling as PcDirectSignaling,
  GATHER_TIMEOUT_MS,
  MAX_CLOUD_IDLE_MS,
  OPEN_TIMEOUT_MS,
  PC_RTC_CAPABILITY,
  PC_RTC_FACTORY,
  PING_MS,
  POINTER_TAIL_MS,
  RENEW_MARGIN_MS,
  STABLE_MS,
  STALL_CONFIRMATIONS,
  STALL_MS,
  STALLED_FIRST_RETRY_MS,
  newCloudEpoch,
} from '../../../core/direct/direct-channel';
export type {
  DirectAnswer as PcDirectAnswer,
  DirectCommandType,
} from '../../../core/direct/direct-channel';
