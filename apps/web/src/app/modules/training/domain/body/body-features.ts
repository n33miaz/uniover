/**
 * Interruptores de recurso do corpo. Um recurso só fica ligado depois de a conferência dele estar feita e registrada aqui.
 */

/**
 * Gordura pela fórmula da Marinha dos EUA (Hodgdon e Beckett, 1984).
 *
 * LIGADA depois da conferência das constantes e do ponto de medida em fontes independentes. Os relatórios originais da
 * Marinha (DTIC ADA143890 e ADA146456) estavam fora do ar e não puderam ser lidos; no lugar, conferiu-se em dois artigos
 * revisados por pares, de autores do Instituto de Pesquisa de Medicina Ambiental do Exército dos EUA, que imprimem as mesmas
 * constantes (são publicações, coortes e anos diferentes, mas da mesma instituição):
 * - Foulis e outros (Frontiers in Physiology, 2023), com as duas equações em centímetros e a conversão `÷ 2,54` DENTRO do
 *   logaritmo, como esta função faz; abdômen do homem na altura do umbigo, cintura da mulher no ponto mais estreito do
 *   tronco e quadril no ponto mais largo;
 * - McClung e outros (International Journal of Obesity, 2025; publicado online em 2024), que imprimem as equações de
 *   Hodgdon "do regulamento do Exército de 2019", em polegadas, para homens e mulheres.
 * Um terceiro artigo (Potter e outros, Frontiers in Physiology, 2022) imprime a equação do homem igual, e a da mulher com um
 * erro de digitação (sem o quadril), por isso não vale como conferência da mulher.
 *
 * Limites que a tela precisa dizer: é equação de população militar dos EUA, "método de campo" que não dá medida de
 * pesquisa. Em 609 fuzileiros navais em forma (Potter e outros, 2022), frente ao DXA, o método subestimou o homem em cerca de
 * 2,5 pontos e superestimou a mulher em 1,3 a 2,3 pontos, com desvio de 4 a 5 pontos entre as pessoas; e o Exército trocou
 * de equação em 2023. Desligue aqui se a conferência for contestada.
 */
export const NAVY_BODY_FAT_ENABLED = true;
