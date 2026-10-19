/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

export interface paths {
  '/': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/{path}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
      };
    };
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/agents': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['AgentSummary'][];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/agents/{id}/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['RevokeAgentRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['RevokeAgentResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/info': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['DevicesModuleInfo'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/pairing/approve': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['ApprovePairingRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['ApprovePairingResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Forbidden */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/pairing/deny': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['DenyPairingRequest'];
        };
      };
      responses: {
        /** @description No Content */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/pairing/poll': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['PollPairingRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PollPairingResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Forbidden */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Gone */
        410: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/pairing/start': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['StartPairingRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['StartPairingResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['LoginRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['LoginResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description No Content */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/auth/refresh': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['RefreshResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/auth/stream-ticket': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['StreamTicketResponse'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/info': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['IdentityModuleInfo'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/me': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['MeResponse'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/passkeys': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PasskeySummary'][];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/passkeys/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description No Content */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Forbidden */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['RenamePasskeyRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PasskeySummary'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    trace?: never;
  };
  '/api/v1/identity/passkeys/registration/complete': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['CompletePasskeyRegistrationRequest'];
        };
      };
      responses: {
        /** @description Created */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PasskeySummary'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/passkeys/registration/options': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['BeginPasskeyRegistrationRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['BeginPasskeyRegistrationResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Forbidden */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/step-up/complete': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['ConfirmStepUpRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['ConfirmStepUpResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Forbidden */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/step-up/options': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['RequestStepUpRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['RequestStepUpResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/catalog/credits': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['CatalogCreditsResponse'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/catalog/imports/wger': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: {
          dryRun?: boolean;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['ImportWgerResponse'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Bad Gateway */
        502: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/exercises': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          after?: string;
          limit?: number | string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PullExercisesResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/exercises/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertCustomExerciseRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['ExerciseResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Forbidden */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unprocessable Entity */
        422: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/exercises/{id}/step': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['SetExerciseStepRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['ExerciseResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unprocessable Entity */
        422: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/routine-templates': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['RoutineTemplatesResponse'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/routines': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          after?: string;
          limit?: number | string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PullRoutinesResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/routines/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertRoutineRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['RoutineResponse'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unprocessable Entity */
        422: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/commands/recent': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          limit?: number | string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['RecentCommand'][];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/info': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['ModuleInfo'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/keys': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          'application/json': components['schemas']['SendKeyRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvCommandOk'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Bad Gateway */
        502: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Service Unavailable */
        503: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Gateway Timeout */
        504: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/power/off': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvCommandOk'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Bad Gateway */
        502: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Service Unavailable */
        503: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Gateway Timeout */
        504: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/shortcuts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvShortcut'][];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/shortcuts/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpdateShortcutRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvShortcut'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    trace?: never;
  };
  '/api/v1/tv/shortcuts/{id}/launch': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvCommandOk'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Not Found */
        404: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Bad Gateway */
        502: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Service Unavailable */
        503: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Gateway Timeout */
        504: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/shortcuts/refresh': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvCommandOk'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Bad Gateway */
        502: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Service Unavailable */
        503: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Gateway Timeout */
        504: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/state': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvState'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/text': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          'application/json': components['schemas']['SendTextRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvCommandOk'];
          };
        };
        /** @description Bad Request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Bad Gateway */
        502: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Service Unavailable */
        503: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Gateway Timeout */
        504: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/wake': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Accepted */
        202: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description Unauthorized */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Too Many Requests */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Service Unavailable */
        503: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/index.html': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    AgentSummary: {
      /** Format: date-time */
      createdAt: string;
      /** Format: uuid */
      id: string;
      /** Format: date-time */
      lastSeenAt: null | string;
      name: string;
      platform: string;
      revoked: boolean;
      slug: string;
    };
    ApprovePairingRequest: {
      name: null | string;
      userCode: null | string;
    };
    ApprovePairingResponse: {
      /** Format: uuid */
      id: string;
      name: string;
      platform: string;
      slug: string;
    };
    AssertionResponse: {
      /** Format: byte */
      authenticatorData: unknown;
      /** Format: byte */
      clientDataJSON: unknown;
      /** Format: byte */
      signature: unknown;
      /** Format: byte */
      userHandle?: unknown;
    };
    AttestationResponse: {
      /** Format: byte */
      attestationObject: unknown;
      /** Format: byte */
      clientDataJSON: unknown;
      transports: null | components['schemas']['AuthenticatorTransport'][];
    };
    AuthenticationExtensionsClientOutputs: {
      appid?: boolean;
      credProps?: null | components['schemas']['CredentialPropertiesOutput'];
      credProtect?: null | components['schemas']['CredentialProtectionPolicy'];
      'example.extension.bool'?: null | boolean;
      exts?: null | string[];
      largeBlob?: null | components['schemas']['AuthenticationExtensionsLargeBlobOutputs'];
      prf?: null | components['schemas']['AuthenticationExtensionsPRFOutputs'];
      uvm?: null | (number | string)[][];
    };
    AuthenticationExtensionsLargeBlobOutputs: {
      /** Format: byte */
      blob?: unknown;
      supported?: boolean;
      written?: boolean;
    };
    AuthenticationExtensionsPRFOutputs: {
      enabled?: boolean;
      results?: components['schemas']['AuthenticationExtensionsPRFValues'];
    };
    AuthenticationExtensionsPRFValues: {
      /** Format: byte */
      first: unknown;
      /** Format: byte */
      second?: unknown;
    };
    AuthenticatorAssertionRawResponse: {
      clientExtensionResults: components['schemas']['AuthenticationExtensionsClientOutputs'];
      extensions?: components['schemas']['AuthenticationExtensionsClientOutputs'];
      id: null | string;
      /** Format: byte */
      rawId: unknown;
      response?: components['schemas']['AssertionResponse'];
      type: null | components['schemas']['PublicKeyCredentialType'];
    };
    AuthenticatorAttestationRawResponse: {
      clientExtensionResults: components['schemas']['AuthenticationExtensionsClientOutputs'];
      extensions?: components['schemas']['AuthenticationExtensionsClientOutputs'];
      id: null | string;
      /** Format: byte */
      rawId: unknown;
      response: components['schemas']['AttestationResponse'];
      type: null | components['schemas']['PublicKeyCredentialType'];
    };
    /** @enum {unknown} */
    AuthenticatorTransport: 'usb' | 'nfc' | 'ble' | 'smart-card' | 'hybrid' | 'internal';
    BeginPasskeyRegistrationRequest: {
      password: null | string;
    };
    BeginPasskeyRegistrationResponse: {
      /** Format: uuid */
      challengeId: string;
      options: components['schemas']['JsonElement'];
    };
    CatalogCreditsResponse: {
      sources: components['schemas']['CreditSource'][];
      wgerAuthors: components['schemas']['WgerCredit'][];
    };
    CompletePasskeyRegistrationRequest: {
      /** Format: uuid */
      challengeId: null | string;
      credential: null | components['schemas']['AuthenticatorAttestationRawResponse'];
      name: null | string;
    };
    ConfirmStepUpRequest: {
      /** Format: uuid */
      challengeId: null | string;
      credential: null | components['schemas']['AuthenticatorAssertionRawResponse'];
    };
    ConfirmStepUpResponse: {
      action: string;
      /** Format: date-time */
      expiresAt: string;
    };
    CredentialPropertiesOutput: {
      authenticatorDisplayName?: null | string;
      rk?: boolean;
    };
    /** @enum {unknown} */
    CredentialProtectionPolicy:
      | 'userVerificationOptional'
      | 'userVerificationOptionalWithCredentialIDList'
      | 'userVerificationRequired'
      | null;
    CreditSource: {
      /** Format: int32 */
      count: number | string;
      license: null | string;
      licenseUrl: null | string;
      source: string;
    };
    DenyPairingRequest: {
      userCode: null | string;
    };
    DevicesModuleInfo: {
      module: string;
      version: string;
    };
    ExerciseResponse: {
      category: null | string;
      /** Format: date-time */
      clientUpdatedAt: string;
      deleted: boolean;
      equipment: string;
      /** Format: uuid */
      id: string;
      instructions: string[];
      level: null | string;
      license: null | string;
      licenseAuthor: null | string;
      licenseUrl: null | string;
      mechanic: null | string;
      name: string;
      primaryMuscles: string[];
      recordType: string;
      reviewed: boolean;
      secondaryMuscles: string[];
      slug: string;
      source: string;
      sourceRef: null | string;
      /** Format: date-time */
      stepClientUpdatedAt: null | string;
      /** Format: double */
      stepKg: null | number | string;
      /** Format: date-time */
      updatedAt: string;
    };
    IdentityModuleInfo: {
      dependsOn: string[];
      module: string;
      version: string;
    };
    ImportWgerResponse: {
      /** Format: int32 */
      alreadyImported: number | string;
      dryRun: boolean;
      /** Format: int32 */
      duplicates: number | string;
      /** Format: int32 */
      importable: number | string;
      /** Format: int32 */
      imported: number | string;
      /** Format: int32 */
      scanned: number | string;
      /** Format: int32 */
      unmappable: number | string;
      /** Format: int32 */
      withAuthor: number | string;
      /** Format: int32 */
      withLicense: number | string;
      /** Format: int32 */
      withPortuguese: number | string;
    };
    JsonElement: unknown;
    LoginRequest: {
      email: null | string;
      password: null | string;
    };
    LoginResponse: {
      accessToken: string;
      /** Format: int32 */
      expiresIn: number;
    };
    MeResponse: {
      displayName: string;
      email: string;
      /** Format: uuid */
      id: string;
    };
    ModuleInfo: {
      module: string;
      version: string;
    };
    PasskeySummary: {
      /** Format: date-time */
      createdAt: string;
      /** Format: uuid */
      id: string;
      /** Format: date-time */
      lastUsedAt: null | string;
      name: string;
    };
    PollPairingRequest: {
      deviceCode: null | string;
      /** Format: uuid */
      pairingId: null | string;
    };
    PollPairingResponse: {
      agentId?: null | string;
      deviceToken?: null | string;
      /** Format: int32 */
      interval?: null | number | string;
      status: string;
    };
    ProblemDetails: {
      detail?: null | string;
      instance?: null | string;
      /** Format: int32 */
      status?: null | number | string;
      title?: null | string;
      type?: null | string;
    };
    /** @enum {unknown} */
    PublicKeyCredentialType: 'public-key' | 'invalid' | null;
    PullExercisesResponse: {
      items: components['schemas']['ExerciseResponse'][];
      nextCursor: null | string;
    };
    PullRoutinesResponse: {
      items: components['schemas']['RoutineResponse'][];
      nextCursor: null | string;
    };
    RecentCommand: {
      command: string;
      detail: null | string;
      errorCode: null | string;
      /** Format: uuid */
      id: string;
      /** Format: int32 */
      latencyMs: null | number | string;
      /** Format: date-time */
      occurredAt: string;
      ok: boolean;
    };
    RefreshResponse: {
      accessToken: string;
      /** Format: int32 */
      expiresIn: number;
    };
    RenamePasskeyRequest: {
      name: null | string;
    };
    RequestStepUpRequest: {
      action: null | string;
    };
    RequestStepUpResponse: {
      /** Format: uuid */
      challengeId: string;
      options: components['schemas']['JsonElement'];
    };
    RevokeAgentRequest: {
      reason: null | string;
    };
    RevokeAgentResponse: {
      /** Format: uuid */
      id: string;
      revoked: boolean;
    };
    RoutineItemResponse: {
      /** Format: uuid */
      exerciseId: string;
      /** Format: uuid */
      id: string;
      note: null | string;
      /** Format: int32 */
      position: number | string;
      /** Format: int32 */
      repMax: number | string;
      /** Format: int32 */
      repMin: number | string;
      /** Format: int32 */
      restSeconds: number | string;
      /** Format: int32 */
      supersetGroup: null | number | string;
      /** Format: int32 */
      targetSets: number | string;
    };
    RoutineResponse: {
      active: boolean;
      /** Format: date-time */
      clientUpdatedAt: string;
      deleted: boolean;
      /** Format: uuid */
      id: string;
      items: components['schemas']['RoutineItemResponse'][];
      name: string;
      note: null | string;
      /** Format: int32 */
      position: number | string;
      /** Format: date-time */
      updatedAt: string;
    };
    RoutineTemplate: {
      description: string;
      id: string;
      name: string;
      routines: components['schemas']['RoutineTemplateRoutine'][];
    };
    RoutineTemplateItem: {
      exerciseSlug: string;
      /** Format: int32 */
      repMax: number | string;
      /** Format: int32 */
      repMin: number | string;
      /** Format: int32 */
      restSeconds: number | string;
      /** Format: int32 */
      supersetGroup: null | number | string;
      /** Format: int32 */
      targetSets: number | string;
    };
    RoutineTemplateRoutine: {
      items: components['schemas']['RoutineTemplateItem'][];
      name: string;
    };
    RoutineTemplatesResponse: {
      items: components['schemas']['RoutineTemplate'][];
    };
    SendKeyRequest: {
      direction: null | string;
      key: null | string;
    };
    SendTextRequest: {
      text: null | string;
    };
    SetExerciseStepRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      /** Format: double */
      stepKg: null | number | string;
    };
    StartPairingRequest: {
      agentName: null | string;
      agentVersion: null | string;
      platform: null | string;
    };
    StartPairingResponse: {
      deviceCode: string;
      /** Format: int32 */
      expiresIn: number;
      /** Format: int32 */
      interval: number;
      /** Format: uuid */
      pairingId: string;
      userCode: string;
    };
    StreamTicketResponse: {
      /** Format: int32 */
      expiresIn: number;
    };
    TvCommandOk: {
      /** Format: int32 */
      latencyMs: number;
      ok: boolean;
    };
    TvShortcut: {
      customLabel: null | string;
      enabled: boolean;
      /** Format: uuid */
      id: string;
      package: string;
      /** Format: int32 */
      position: number;
      tvLabel: null | string;
    };
    TvState: {
      agentOnline: boolean;
      app: null | string;
      connection: string;
      power: string;
      /** Format: date-time */
      updatedAt: null | string;
      /** Format: int32 */
      volume: null | number | string;
    };
    UpdateShortcutRequest: {
      customLabel: null | string;
      enabled: null | boolean;
    };
    UpsertCustomExerciseRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      deleted: boolean;
      equipment: null | string;
      instructions: null | string[];
      name: null | string;
      primaryMuscles: null | string[];
      recordType: null | string;
      secondaryMuscles: null | string[];
      /** Format: double */
      stepKg: null | number | string;
    };
    UpsertRoutineItemRequest: {
      /** Format: uuid */
      exerciseId: null | string;
      /** Format: uuid */
      id: null | string;
      note: null | string;
      /** Format: int32 */
      position: null | number | string;
      /** Format: int32 */
      repMax: null | number | string;
      /** Format: int32 */
      repMin: null | number | string;
      /** Format: int32 */
      restSeconds: null | number | string;
      /** Format: int32 */
      supersetGroup: null | number | string;
      /** Format: int32 */
      targetSets: null | number | string;
    };
    UpsertRoutineRequest: {
      active: null | boolean;
      /** Format: date-time */
      clientUpdatedAt: null | string;
      deleted: boolean;
      items: null | components['schemas']['UpsertRoutineItemRequest'][];
      name: null | string;
      note: null | string;
      /** Format: int32 */
      position: null | number | string;
    };
    WgerCredit: {
      author: string;
      /** Format: int32 */
      count: number | string;
      license: string;
      licenseUrl: null | string;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
