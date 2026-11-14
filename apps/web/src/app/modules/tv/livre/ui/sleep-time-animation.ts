/**
 * Qual animação o seletor do tempo do Modo Dormir usa. É a escolha que o dono ainda vai fazer: as três propostas estão na
 * página de decisões (pílula que desliza, anel e selo, cartão de contagem).
 *
 * Fica isolada de propósito. O componente (`livre-sleep-time`) só põe este valor no atributo `data-animation` e o seu CSS
 * (`livre-sleep-time.css`) tem um bloco por animação, todos sob `[data-animation='<nome>']`. Trocar de animação é trocar
 * este valor; acrescentar outra é acrescentar um bloco de CSS com o nome novo. A lógica (toque, envio, confirmação,
 * lápis) é a mesma, e as classes de estado que o CSS recebe são fixas: `go` (acabou de tocar), `sending` (enviando),
 * `applied` (a TV confirmou) e `sel` (é o tempo que vale).
 *
 * Em uso: `ring-seal`, a recomendada na página: o botão pulsa ao toque, uma barra enche enquanto envia e um selo verde
 * confirma que a TV recebeu.
 */
export type SleepTimeAnimation = 'ring-seal';

export const SLEEP_TIME_ANIMATION: SleepTimeAnimation = 'ring-seal';
