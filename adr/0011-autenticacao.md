# 0011. Autenticação: senha, JWT curto, refresh rotativo em cookie, passkey para ação perigosa, token de dispositivo

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O app controla aparelhos reais da casa, então um acesso indevido tem consequência física. Ao mesmo tempo, é
usado todo dia no celular, e pedir autenticação forte a cada toque o tornaria inutilizável. Os agentes não
são pessoas e precisam de uma credencial própria, revogável.

## Decisão

- **Senha** com hash do Identity (PBKDF2) ou Argon2id.
- **JWT de acesso curto** (5 a 15 minutos), mantido só em memória no PWA.
- **Refresh rotativo** em cookie `HttpOnly; Secure; SameSite=Strict`, com detecção de reuso: reaproveitar um
  refresh já trocado revoga toda a família de sessões.
- **Passkey** usada só para **confirmar ações perigosas**; a confirmação vale minutos, não a sessão.
- **Token de dispositivo** para cada agente, emitido no pareamento, revogável, guardado no Cofre de
  Credenciais do Windows.
- Política de autorização padrão é "autenticado"; rota pública é exceção explícita e listada. Nunca token em
  query string (o SSE autentica por cookie de mesma origem). Rate limit em login, refresh, pareamento e
  comandos, com `429` e `Retry-After`. Comandos a aparelhos geram log de auditoria.

## Consequências

- Roubar um token de acesso rende poucos minutos; reuso de refresh derruba a sessão inteira.
- Ações perigosas exigem presença física do dono (passkey).
- Mais peças para implementar e testar do que uma sessão simples, com testes de integração para cada regra.

## Alternativas consideradas

- **Sessão em cookie simples:** sem a separação entre acesso curto e renovação, e mais frágil a CSRF.
- **JWT longo no `localStorage`:** exposto a XSS e difícil de revogar.
- **Passkey em todo login:** boa segurança, mas atrito alto no uso diário.
- **Provedor externo de identidade:** mais uma dependência e custo para um único usuário.
