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
    DenyPairingRequest: {
      userCode: null | string;
    };
    DevicesModuleInfo: {
      module: string;
      version: string;
    };
    IdentityModuleInfo: {
      dependsOn: string[];
      module: string;
      version: string;
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
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
