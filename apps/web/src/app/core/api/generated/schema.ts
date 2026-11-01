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
  '/api/v1/devices/agent-alerts': {
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
            'application/json': components['schemas']['AgentAlert'][];
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
  '/api/v1/devices/agent-alerts/{id}/seen': {
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
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/agent-alerts/seen': {
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
        /** @description Forbidden */
        403: {
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
  '/api/v1/devices/agents/{id}/logs': {
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
          'application/json': null | components['schemas']['AgentLogsRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['AgentLogsResponse'];
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
  '/api/v1/devices/agents/{id}/maintenance': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['AgentMaintenanceRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['AgentMaintenanceResponse'];
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
        /** @description Conflict */
        409: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/agents/diagnostics': {
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
            'application/json': components['schemas']['AgentDiagnosticsResponse'];
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/devices/pairing/approve-own': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['ApproveOwnPairingRequest'];
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
        /** @description Conflict */
        409: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
  '/api/v1/identity/audit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          action?: string[];
          cursor?: string;
          from?: string;
          limit?: number | string;
          module?: string[];
          outcome?: string;
          person?: string;
          to?: string;
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
            'application/json': components['schemas']['AuditPage'];
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
  '/api/v1/identity/audit/export': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          action?: string[];
          from?: string;
          module?: string[];
          outcome?: string;
          person?: string;
          to?: string;
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
        /** @description Forbidden */
        403: {
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
  '/api/v1/identity/audit/sources': {
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
            'application/json': components['schemas']['AuditSourcesResponse'];
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
  '/api/v1/identity/auth/qr/approve': {
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
          'application/json': null | components['schemas']['ApproveQrLoginRequest'];
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
        /** @description Forbidden */
        403: {
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
  '/api/v1/identity/auth/qr/deny': {
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
          'application/json': null | components['schemas']['QrLoginCodeRequest'];
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
  '/api/v1/identity/auth/qr/info': {
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
          'application/json': null | components['schemas']['QrLoginCodeRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['QrLoginInfoResponse'];
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
  '/api/v1/identity/auth/qr/poll': {
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
          'application/json': null | components['schemas']['PollQrLoginRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PollQrLoginResponse'];
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
  '/api/v1/identity/auth/qr/start': {
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
            'application/json': components['schemas']['StartQrLoginResponse'];
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
  '/api/v1/identity/auth/refresh/challenge': {
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
            'application/json': components['schemas']['RefreshChallengeResponse'];
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
  '/api/v1/identity/capacity': {
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
            'application/json': components['schemas']['CapacityResponse'];
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
  '/api/v1/identity/capacity/alerts/seen': {
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
        /** @description Forbidden */
        403: {
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
  '/api/v1/identity/guest-invites': {
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
            'application/json': components['schemas']['GuestInviteSummary'][];
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
      };
    };
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
          'application/json': null | components['schemas']['CreateGuestInviteRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['CreateGuestInviteResponse'];
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
  '/api/v1/identity/guest-invites/{id}/revoke': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Unprocessable Entity */
        422: {
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
  '/api/v1/identity/guest-invites/accept': {
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
          'application/json': null | components['schemas']['AcceptGuestInviteRequest'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/identity/guests': {
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
            'application/json': components['schemas']['GuestSummary'][];
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
  '/api/v1/identity/guests/{guestId}/sessions': {
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
        path: {
          guestId: string;
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
            'application/json': components['schemas']['SessionSummary'][];
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
  '/api/v1/identity/guests/{guestId}/sessions/{id}/revoke': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          guestId: string;
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
        /** @description Conflict */
        409: {
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
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/guests/{id}/pause': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Unprocessable Entity */
        422: {
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
  '/api/v1/identity/guests/{id}/permissions': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['SetGuestPermissionsRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['GuestSummary'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/identity/guests/{id}/resume': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Unprocessable Entity */
        422: {
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
  '/api/v1/identity/guests/{id}/revoke': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Unprocessable Entity */
        422: {
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
    patch: {
      parameters: {
        query?: never;
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpdateProfileRequest'];
        };
      };
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
        /** @description Conflict */
        409: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Unprocessable Entity */
        422: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
  '/api/v1/identity/people-usage': {
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
            'application/json': components['schemas']['PersonUsage'][];
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
  '/api/v1/identity/sessions': {
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
            'application/json': components['schemas']['SessionSummary'][];
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
  '/api/v1/identity/sessions/{id}/revoke': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/sessions/others/revoke': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
  '/api/v1/identity/step-up/password': {
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
          'application/json': null | components['schemas']['ConfirmStepUpWithPasswordRequest'];
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
  '/api/v1/identity/system-settings': {
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
            'application/json': components['schemas']['SystemSettingValue'][];
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
  '/api/v1/identity/system-settings/{key}': {
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
          key: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['SaveSystemSettingRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['SystemSettingValue'];
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
    post?: never;
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          key: string;
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
            'application/json': components['schemas']['SystemSettingValue'];
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
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/identity/system-settings/photo-bucket': {
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
            'application/json': components['schemas']['PhotoBucketStatus'];
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
  '/api/v1/system/dead-letters': {
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
            'application/json': components['schemas']['DeadLetterReport'];
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
  '/api/v1/training/body/entries': {
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
            'application/json': components['schemas']['PullBodyEntriesResponse'];
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
  '/api/v1/training/body/entries/{id}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertBodyEntryRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['BodyEntryResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/body/profile': {
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
            'application/json': components['schemas']['PullBodyProfileResponse'];
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
      };
    };
    put: {
      parameters: {
        query?: never;
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertBodyProfileRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['BodyProfileResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/calendar-entries': {
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
            'application/json': components['schemas']['CalendarEntriesResponse'];
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
  '/api/v1/training/calendar-entries/{dayKey}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          dayKey: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['CalendarEntryRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['CalendarEntryResponse'];
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
        /** @description Conflict */
        409: {
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
        /** @description Forbidden */
        403: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Forbidden */
        403: {
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
        /** @description Forbidden */
        403: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
        /** @description Conflict */
        409: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
  '/api/v1/training/foods': {
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
            'application/json': components['schemas']['PullFoodsResponse'];
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
  '/api/v1/training/foods/{id}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertFoodRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['FoodResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/foods/imports/taco': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
            'application/json': components['schemas']['TacoImportResponse'];
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
        /** @description Conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Payload Too Large */
        413: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/problem+json': components['schemas']['ProblemDetails'];
          };
        };
        /** @description Unsupported Media Type */
        415: {
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
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/training/foods/off/barcode/{barcode}': {
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
        path: {
          barcode: string;
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
            'application/json': components['schemas']['FoodResponse'];
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
  '/api/v1/training/foods/off/search': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          q?: string;
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
            'application/json': components['schemas']['FoodResponse'][];
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
  '/api/v1/training/goals': {
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
            'application/json': components['schemas']['PullGoalsResponse'];
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
  '/api/v1/training/goals/{kind}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          kind: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertGoalRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['GoalResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/meals': {
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
            'application/json': components['schemas']['PullMealsResponse'];
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
  '/api/v1/training/meals/{id}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertMealRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['MealResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/program': {
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
            'application/json': components['schemas']['PullTrainingProgramResponse'];
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
      };
    };
    put: {
      parameters: {
        query?: never;
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['SelectTrainingProgramRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TrainingProgramResponse'];
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
        /** @description Conflict */
        409: {
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
        /** @description Forbidden */
        403: {
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
        /** @description Forbidden */
        403: {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
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
  '/api/v1/training/sessions': {
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
            'application/json': components['schemas']['PullSessionsResponse'];
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
  '/api/v1/training/sessions/{id}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertSessionRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['SessionResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/sessions/{sessionId}/sets/{id}': {
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
        header?: {
          /** @description UUID opcional para repetir uma escrita sem repetir seu efeito. */
          'Idempotency-Key'?: string;
        };
        path: {
          id: string;
          sessionId: string;
        };
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['UpsertSetRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['SetResponse'];
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
        /** @description Conflict */
        409: {
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
  '/api/v1/training/sets': {
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
            'application/json': components['schemas']['PullSetsResponse'];
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
  '/api/v1/tv/cleanup': {
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
            'application/json': components['schemas']['TvCleanupOk'];
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
  '/api/v1/tv/cleanup/latest': {
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
            'application/json': components['schemas']['CleanupReportView'];
          };
        };
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
        /** @description Forbidden */
        403: {
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
  '/api/v1/tv/config': {
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
            'application/json': components['schemas']['TvConfigResponse'];
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
  '/api/v1/tv/config/agent': {
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
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['BindAgentRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvConfigResponse'];
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
  '/api/v1/tv/layout': {
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
            'application/json': components['schemas']['TvLayoutDocument'];
          };
        };
        /** @description No Content */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
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
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          'application/json': components['schemas']['JsonElement'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvLayoutDocument'];
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
      };
    };
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          'application/json': components['schemas']['JsonElement'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvLayoutDocument'];
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
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/permission': {
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
            'application/json': components['schemas']['PermissionPendingResponse'];
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
  '/api/v1/tv/permission/request': {
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
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['PowerOffRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvPowerOffOk'];
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
  '/api/v1/tv/power/schedule': {
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
            'application/json': components['schemas']['PowerScheduleResponse'];
          };
        };
      };
    };
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['SavePowerScheduleRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['PowerScheduleView'];
          };
        };
      };
    };
    post?: never;
    delete: {
      parameters: {
        query: {
          version: number | string;
        };
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
      };
    };
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
  '/api/v1/tv/shortcuts/order': {
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
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': null | components['schemas']['ReorderShortcutsRequest'];
        };
      };
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
    post?: never;
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
  '/api/v1/tv/tvs': {
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
            'application/json': components['schemas']['TvListResponse'];
          };
        };
      };
    };
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
          'application/json': null | components['schemas']['CreateTvRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvSummary'];
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
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tv/tvs/{id}': {
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
          'application/json': null | components['schemas']['UpdateTvRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvSummary'];
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
    trace?: never;
  };
  '/api/v1/tv/tvs/{id}/apps': {
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
            'application/json': components['schemas']['TvAppsResponse'];
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
  '/api/v1/tv/tvs/{id}/cleanup-reports': {
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
            'application/json': components['schemas']['TvCleanupReportsResponse'];
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
  '/api/v1/tv/tvs/{id}/members': {
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
            'application/json': components['schemas']['TvMembersResponse'];
          };
        };
      };
    };
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
          'application/json': null | components['schemas']['UpdateTvMembersRequest'];
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': components['schemas']['TvMembersResponse'];
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
  '/api/v1/tv/tvs/nearby': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: {
          agent?: string;
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
            'application/json': components['schemas']['NearbyTvsResponse'];
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
    put?: never;
    post?: never;
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
  '/health/version': {
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
            'application/json': components['schemas']['DeploymentVersion'];
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
    AcceptGuestInviteRequest: {
      email: null | string;
      password: null | string;
      token: null | string;
    };
    AgentAlert: {
      /** Format: uuid */
      agentId: string;
      agentName: string;
      /** Format: date-time */
      detectedAt: string;
      /** Format: uuid */
      id: string;
      /** Format: date-time */
      lastSeenAt: null | string;
      /** Format: date-time */
      recoveredAt: null | string;
    };
    AgentDiagnosticItem: {
      /** Format: uuid */
      agentId: string;
      agentName: string;
      /** Format: date-time */
      at: string;
      component: null | string;
      /** Format: int32 */
      count: number | string;
      detail: string;
      /** Format: uuid */
      id: string;
      kind: string;
      severity: string;
    };
    AgentDiagnosticsResponse: {
      items: components['schemas']['AgentDiagnosticItem'][];
      /** Format: int32 */
      retentionDays: number | string;
    };
    AgentLogsRequest: {
      /** Format: int32 */
      lines: null | number | string;
    };
    AgentLogsResponse: {
      /** Format: date-time */
      at: string;
      /** Format: int32 */
      lines: number | string;
      text: string;
      truncated: boolean;
    };
    AgentMaintenanceRequest: {
      action: null | string;
    };
    AgentMaintenanceResponse: {
      accepted: boolean;
      action: string;
    };
    AgentSummary: {
      agentBuild?: null | string;
      agentVersion?: null | string;
      /** @default false */
      canMaintain: boolean;
      /** @default false */
      canReadLogs: boolean;
      /** @default false */
      canRollback: boolean;
      /** @default false */
      connected: boolean;
      /** Format: date-time */
      createdAt: string;
      /** Format: uuid */
      id: string;
      /** Format: date-time */
      lastSeenAt: null | string;
      name: string;
      os?: null | string;
      platform: string;
      revoked: boolean;
      slug: string;
      tvHost?: null | string;
      tvKind?: null | string;
      update?: null | components['schemas']['AgentUpdateSummary'];
    };
    AgentUpdateSummary: {
      blockedSha: null | string;
      /** Format: date-time */
      checkedAt: null | string;
      /** Format: date-time */
      installedAt: null | string;
      installedSha: null | string;
      latestSha: null | string;
      /** Format: date-time */
      nextCheckAt: null | string;
      previousSha: null | string;
      reason: null | string;
      rolledBack: boolean;
      state: string;
    };
    ApproveOwnPairingRequest: {
      name: null | string;
      tvName: null | string;
      userCode: null | string;
    };
    ApprovePairingRequest: {
      name: null | string;
      tvMemberIds: null | string[];
      tvName: null | string;
      userCode: null | string;
    };
    ApprovePairingResponse: {
      /** Format: uuid */
      id: string;
      name: string;
      platform: string;
      slug: string;
    };
    ApproveQrLoginRequest: {
      code: null | string;
      password: null | string;
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
    AuditAccount: {
      displayName: null | string;
      /** Format: uuid */
      id: string;
    };
    AuditItem: {
      action: string;
      actor: null | components['schemas']['AuditAccount'];
      detail: null | string;
      /** Format: uuid */
      id: string;
      ip: null | string;
      module: string;
      /** Format: date-time */
      occurredAt: string;
      outcome: string;
      target: null | string;
      targetAccount: null | components['schemas']['AuditAccount'];
      userAgent: null | string;
    };
    AuditPage: {
      items: components['schemas']['AuditItem'][];
      nextCursor: null | string;
    };
    AuditSourcesResponse: {
      outcomes: string[];
      sources: components['schemas']['AuditSourceSummary'][];
    };
    AuditSourceSummary: {
      actions: string[];
      module: string;
      /** Format: int32 */
      retentionDays: number | string;
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
    BindAgentRequest: {
      agentSlug: null | string;
      name: null | string;
    };
    BodyEntryResponse: {
      /** Format: double */
      abdomenCm: null | number | string;
      /** Format: double */
      abdomenSkinfoldMm: null | number | string;
      /** Format: double */
      armCm: null | number | string;
      /** Format: double */
      armLeftCm: null | number | string;
      /** Format: double */
      armRightCm: null | number | string;
      /** Format: double */
      bodyFatPct: null | number | string;
      /** Format: double */
      calfCm: null | number | string;
      /** Format: double */
      calfLeftCm: null | number | string;
      /** Format: double */
      calfRightCm: null | number | string;
      /** Format: double */
      chestCm: null | number | string;
      /** Format: double */
      chestSkinfoldMm: null | number | string;
      /** Format: date-time */
      clientUpdatedAt: string;
      deleted: boolean;
      fatMethod: null | string;
      /** Format: double */
      forearmCm: null | number | string;
      /** Format: double */
      forearmLeftCm: null | number | string;
      /** Format: double */
      forearmRightCm: null | number | string;
      /** Format: double */
      hipCm: null | number | string;
      /** Format: uuid */
      id: string;
      /** Format: date */
      measuredOn: string;
      /** Format: double */
      neckCm: null | number | string;
      note: null | string;
      /** Format: double */
      thighCm: null | number | string;
      /** Format: double */
      thighLeftCm: null | number | string;
      /** Format: double */
      thighRightCm: null | number | string;
      /** Format: double */
      thighSkinfoldMm: null | number | string;
      /** Format: date-time */
      updatedAt: string;
      /** Format: double */
      waistCm: null | number | string;
      /** Format: double */
      weightKg: null | number | string;
    };
    BodyProfileResponse: {
      /** Format: double */
      activityFactor: number | string;
      /** Format: date */
      birthDate: string;
      /** Format: date-time */
      clientUpdatedAt: string;
      /** Format: double */
      heightCm: number | string;
      sex: string;
      /** Format: date-time */
      updatedAt: string;
    };
    CalendarEntriesResponse: {
      items: components['schemas']['CalendarEntryResponse'][];
      nextCursor: null | string;
    };
    CalendarEntryRequest: {
      absent: boolean;
      /** Format: date-time */
      clientUpdatedAt: null | string;
      deleted: boolean;
      note: null | string;
    };
    CalendarEntryResponse: {
      absent: boolean;
      /** Format: date-time */
      clientUpdatedAt: string;
      dayKey: string;
      deleted: boolean;
      /** Format: uuid */
      id: string;
      note: null | string;
      /** Format: date-time */
      updatedAt: string;
    };
    CapacityAlertItem: {
      /** Format: date-time */
      detectedAt: string;
      /** Format: uuid */
      id: string;
      metric: string;
      /** Format: int32 */
      percent: number | string;
    };
    CapacityDatabase: {
      band: string;
      /** Format: int64 */
      bytes: number | string;
      /** Format: int64 */
      limitBytes: number | string;
      /** Format: double */
      percent: number | string;
      tables: components['schemas']['CapacityTable'][];
    };
    CapacityGrowth: {
      /** Format: double */
      bytesPerDay: null | number | string;
      /** Format: double */
      daysToAmber: null | number | string;
      /** Format: double */
      daysToRed: null | number | string;
      points: components['schemas']['CapacityPoint'][];
      state: string;
    };
    CapacityPoint: {
      /** Format: int64 */
      bytes: number | string;
      day: string;
    };
    CapacityResponse: {
      alerts: components['schemas']['CapacityAlertItem'][];
      database: components['schemas']['CapacityDatabase'];
      growth: components['schemas']['CapacityGrowth'];
      /** Format: date-time */
      measuredAt: string;
      server: components['schemas']['CapacityServer'];
    };
    CapacityServer: {
      /** Format: int64 */
      heapBytes: number | string;
      hoursBand: string;
      /** Format: int32 */
      hoursLimit: number | string;
      /** Format: double */
      hoursPercent: number | string;
      memoryBand: string;
      /** Format: int64 */
      memoryLimitBytes: number | string;
      /** Format: double */
      memoryPercent: number | string;
      /** Format: double */
      monthHours: number | string;
      /** Format: date-time */
      startedAt: string;
      /** Format: int64 */
      uptimeSeconds: number | string;
      /** Format: int64 */
      workingSetBytes: number | string;
    };
    CapacityTable: {
      /** Format: int64 */
      bytes: number | string;
      name: string;
      schema: string;
    };
    CatalogCreditsResponse: {
      sources: components['schemas']['CreditSource'][];
      wgerAuthors: components['schemas']['WgerCredit'][];
    };
    CleanupReportView: {
      /** Format: int32 */
      closedApps: number | string;
      /** Format: int32 */
      durationMs: number | string;
      /** Format: int32 */
      freedMb: null | number | string;
      kind: string;
      /** Format: int32 */
      memoryAfterMb: null | number | string;
      /** Format: int32 */
      memoryBeforeMb: null | number | string;
      reason: null | string;
      result: string;
      /** Format: date-time */
      startedAt: string;
      trigger: string;
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
    ConfirmStepUpWithPasswordRequest: {
      action: null | string;
      password: null | string;
    };
    CreateGuestInviteRequest: {
      displayName: null | string;
      permissions?: null | string[];
    };
    CreateGuestInviteResponse: {
      displayName: string;
      /** Format: date-time */
      expiresAt: string;
      /** Format: uuid */
      id: string;
      permissions: string[];
      token: string;
    };
    CreateTvRequest: {
      agentSlug: null | string;
      name: null | string;
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
    DeadLetterItem: {
      /** Format: int32 */
      attempts: number | string;
      /** Format: date-time */
      failedAt: string;
      /** Format: uuid */
      id: string;
      lastError: null | string;
      module: string;
      /** Format: date-time */
      occurredAt: string;
      type: string;
    };
    DeadLetterReport: {
      items: components['schemas']['DeadLetterItem'][];
      /** Format: int32 */
      total: number | string;
      unavailableModules: string[];
    };
    DenyPairingRequest: {
      userCode: null | string;
    };
    DeploymentVersion: {
      commit: null | string;
      version: string;
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
    FoodResponse: {
      attribution: null | string;
      barcode: null | string;
      brand: null | string;
      /** Format: double */
      carbsPer100g: number | string;
      /** Format: date-time */
      clientUpdatedAt: string;
      /** Format: double */
      defaultPortionGrams: null | number | string;
      deleted: boolean;
      /** Format: double */
      fatPer100g: number | string;
      /** Format: uuid */
      id: string;
      /** Format: double */
      kcalPer100g: number | string;
      name: string;
      /** Format: double */
      proteinPer100g: number | string;
      source: string;
      /** Format: date-time */
      updatedAt: string;
    };
    GoalResponse: {
      /** Format: date-time */
      clientUpdatedAt: string;
      deleted: boolean;
      /** Format: uuid */
      exerciseId: null | string;
      /** Format: uuid */
      id: string;
      kind: string;
      /** Format: date-time */
      updatedAt: string;
      /** Format: double */
      value: null | number | string;
    };
    GuestInviteSummary: {
      /** Format: date-time */
      createdAt: string;
      displayName: string;
      /** Format: date-time */
      expiresAt: string;
      /** Format: uuid */
      id: string;
      permissions: string[];
      /** Format: date-time */
      revokedAt: null | string;
      status: string;
      /** Format: date-time */
      usedAt: null | string;
    };
    GuestSummary: {
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      disabledAt: null | string;
      displayName: string;
      email: string;
      /** Format: uuid */
      id: string;
      /** Format: date-time */
      pausedAt: null | string;
      permissions: string[];
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
    MealResponse: {
      /** Format: double */
      carbG: number | string;
      /** Format: date-time */
      clientUpdatedAt: string;
      deleted: boolean;
      /** Format: date-time */
      eatenAt: null | string;
      /** Format: date */
      eatenOn: string;
      /** Format: double */
      fatG: number | string;
      /** Format: uuid */
      foodId: null | string;
      /** Format: uuid */
      id: string;
      /** Format: double */
      kcal: number | string;
      mealType: string;
      name: string;
      note: null | string;
      /** Format: double */
      proteinG: number | string;
      /** Format: double */
      quantityG: number | string;
      /** Format: date-time */
      updatedAt: string;
    };
    MeResponse: {
      displayName: string;
      displayNameConfirmed: boolean;
      email: string;
      /** Format: uuid */
      id: string;
      permissions: string[];
      role: string;
    };
    ModuleInfo: {
      module: string;
      version: string;
    };
    NearbyTv: {
      controlled: boolean;
      id: string;
      kind: string;
      name: null | string;
    };
    NearbyTvsResponse: {
      items: components['schemas']['NearbyTv'][];
      status: string;
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
    PermissionPending: {
      name: string;
      /** Format: uuid */
      tvId: string;
    };
    PermissionPendingResponse: {
      items: components['schemas']['PermissionPending'][];
    };
    PersonUsage: {
      /** Format: int32 */
      activeSessions: number | string;
      /** Format: date-time */
      disabledAt: null | string;
      displayName: string;
      /** Format: uuid */
      id: string;
      /** Format: date-time */
      lastAccessAt: null | string;
      role: string;
      tvCommands: components['schemas']['PersonUsageCounts'];
      workouts: components['schemas']['PersonUsageCounts'];
    };
    PersonUsageCounts: {
      /** Format: int32 */
      last7Days: number | string;
      /** Format: int32 */
      last30Days: number | string;
    };
    PhotoBucketStatus: {
      configured: boolean;
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
    PollQrLoginRequest: {
      secret: null | string;
    };
    PollQrLoginResponse: {
      accessToken?: null | string;
      /** Format: int32 */
      expiresIn?: null | number | string;
      status: string;
    };
    PowerOffRequest: {
      mode: null | string;
    };
    PowerScheduleResponse: {
      active: null | components['schemas']['PowerScheduleView'];
      last: null | components['schemas']['PowerScheduleView'];
    };
    PowerScheduleView: {
      /** Format: date-time */
      dueAtUtc: string;
      /** Format: uuid */
      id: string;
      reason: null | string;
      result: null | string;
      status: string;
      timeZone: string;
      /** Format: int64 */
      version: number | string;
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
    PullBodyEntriesResponse: {
      items: components['schemas']['BodyEntryResponse'][];
      nextCursor: null | string;
    };
    PullBodyProfileResponse: {
      items: components['schemas']['BodyProfileResponse'][];
      nextCursor: null | string;
    };
    PullExercisesResponse: {
      items: components['schemas']['ExerciseResponse'][];
      nextCursor: null | string;
    };
    PullFoodsResponse: {
      items: components['schemas']['FoodResponse'][];
      nextCursor: null | string;
    };
    PullGoalsResponse: {
      items: components['schemas']['GoalResponse'][];
      nextCursor: null | string;
    };
    PullMealsResponse: {
      items: components['schemas']['MealResponse'][];
      nextCursor: null | string;
    };
    PullRoutinesResponse: {
      items: components['schemas']['RoutineResponse'][];
      nextCursor: null | string;
    };
    PullSessionsResponse: {
      items: components['schemas']['SessionResponse'][];
      nextCursor: null | string;
    };
    PullSetsResponse: {
      items: components['schemas']['SetResponse'][];
      nextCursor: null | string;
    };
    PullTrainingProgramResponse: {
      items: components['schemas']['TrainingProgramResponse'][];
      nextCursor: null | string;
    };
    QrLoginCodeRequest: {
      code: null | string;
    };
    QrLoginInfoResponse: {
      /** Format: date-time */
      expiresAt: string;
      sameNetwork: boolean;
      userAgent: null | string;
      verification: string;
    };
    RecentCommand: {
      byMe: boolean;
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
    RefreshChallengeResponse: {
      challenge: null | string;
      /** Format: int32 */
      expiresIn: number;
      familyId: null | string;
    };
    RefreshResponse: {
      accessToken: string;
      /** Format: int32 */
      expiresIn: number;
    };
    RenamePasskeyRequest: {
      name: null | string;
    };
    ReorderShortcutsRequest: {
      ids: null | string[];
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
      programId: null | string;
      /** Format: date-time */
      updatedAt: string;
      weekdays: (number | string)[];
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
      weekdays: null | (number | string)[];
    };
    RoutineTemplatesResponse: {
      items: components['schemas']['RoutineTemplate'][];
    };
    SavePowerScheduleRequest: {
      /** Format: date-time */
      dueAtUtc: string;
      timeZone: null | string;
      /** Format: int64 */
      version: null | number | string;
    };
    SaveSystemSettingRequest: {
      value: components['schemas']['JsonElement'];
    };
    SelectTrainingProgramRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      programId: null | string;
    };
    SendKeyRequest: {
      direction: null | string;
      key: null | string;
    };
    SendTextRequest: {
      text: null | string;
    };
    SessionResponse: {
      /** Format: date-time */
      clientUpdatedAt: string;
      deleted: boolean;
      deviceId: string;
      /** Format: int32 */
      feeling: null | number | string;
      /** Format: date-time */
      finishedAt: null | string;
      /** Format: uuid */
      id: string;
      note: null | string;
      /** Format: uuid */
      routineId: null | string;
      /** Format: date-time */
      startedAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    SessionSummary: {
      /** Format: date-time */
      createdAt: string;
      /** Format: uuid */
      id: string;
      ip: null | string;
      isCurrent: boolean;
      /** Format: date-time */
      lastUsedAt: string;
      userAgent: null | string;
    };
    SetExerciseStepRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      /** Format: double */
      stepKg: null | number | string;
    };
    SetGuestPermissionsRequest: {
      permissions: null | string[];
    };
    SetResponse: {
      /** Format: date-time */
      clientUpdatedAt: string;
      /** Format: date-time */
      completedAt: string;
      deleted: boolean;
      /** Format: int32 */
      durationS: null | number | string;
      /** Format: uuid */
      exerciseId: string;
      /** Format: uuid */
      id: string;
      note: null | string;
      /** Format: int32 */
      position: number | string;
      /** Format: int32 */
      reps: null | number | string;
      /** Format: int32 */
      rir: null | number | string;
      /** Format: double */
      rpe: null | number | string;
      /** Format: uuid */
      sessionId: string;
      setType: string;
      /** Format: date-time */
      updatedAt: string;
      /** Format: double */
      weightKg: null | number | string;
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
    StartQrLoginResponse: {
      code: string;
      /** Format: date-time */
      expiresAt: string;
      /** Format: int32 */
      expiresIn: number;
      pollSecret: string;
    };
    StreamTicketResponse: {
      /** Format: int32 */
      expiresIn: number;
    };
    SystemSettingValue: {
      key: string;
      source: string;
      value: components['schemas']['JsonElement'];
    };
    TacoImportResponse: {
      /** Format: int32 */
      imported: number | string;
      invalidRows: (number | string)[];
    };
    TrainingProgramResponse: {
      /** Format: date-time */
      clientUpdatedAt: string;
      programId: string;
      /** Format: date-time */
      updatedAt: string;
    };
    TvAgentChoice: {
      name: string;
      online: boolean;
      platform: string;
      slug: string;
    };
    TvAppOption: {
      label: string;
      package: string;
    };
    TvAppsResponse: {
      items: components['schemas']['TvAppOption'][];
    };
    TvCleanupOk: {
      /** Format: int32 */
      closedApps: number;
      failedSteps: string[];
      /** Format: int32 */
      freedMb: null | number | string;
      /** Format: int32 */
      latencyMs: number;
      /** Format: int32 */
      memoryAfterMb: null | number | string;
      /** Format: int32 */
      memoryBeforeMb: null | number | string;
      ok: boolean;
    };
    TvCleanupReportItem: {
      /** Format: int32 */
      backgroundProcesses: null | number | string;
      /** Format: int32 */
      closedApps: number | string;
      closedPackages: string[];
      /** Format: int32 */
      durationMs: number | string;
      kind: string;
      /** Format: int32 */
      memoryAfterMb: null | number | string;
      /** Format: int32 */
      memoryBeforeMb: null | number | string;
      reason: null | string;
      result: string;
      /** Format: int32 */
      sessionOpenMs: null | number | string;
      /** Format: date-time */
      startedAt: string;
      trigger: string;
    };
    TvCleanupReportsResponse: {
      items: components['schemas']['TvCleanupReportItem'][];
    };
    TvCommandOk: {
      /** Format: int32 */
      latencyMs: number;
      ok: boolean;
    };
    TvConfigResponse: {
      agentName: null | string;
      agents: components['schemas']['TvAgentChoice'][];
      agentSlug: null | string;
      agentStatus: string;
      name: string;
      source: string;
    };
    TvLayoutDocument: {
      buttonSize: string;
      dismissedSuggestions: string[];
      extraKeys: null | string[];
      name: string;
      padSpeed: string;
      pillLayout: string;
      showChannel: boolean;
      showMedia: boolean;
      startPage: string;
    };
    TvListResponse: {
      items: components['schemas']['TvSummary'][];
    };
    TvMembersResponse: {
      userIds: string[];
    };
    TvPowerOffOk: {
      /** Format: int32 */
      latencyMs: number;
      ok: boolean;
      outcome: string;
    };
    TvShortcut: {
      customLabel: null | string;
      enabled: boolean;
      iconDataUri: null | string;
      /** Format: uuid */
      id: string;
      installed: boolean;
      package: string;
      /** Format: int32 */
      position: number;
      tvLabel: null | string;
    };
    TvState: {
      /** @default true */
      agentLinked: boolean;
      agentOnline: boolean;
      app: null | string;
      connection: string;
      /** Format: date-time */
      offlineSince?: null | string;
      power: string;
      /** Format: date-time */
      updatedAt: null | string;
      /** Format: int32 */
      volume: null | number | string;
    };
    TvSummary: {
      agentSlug: null | string;
      /** @default false */
      allowBackgroundAppClosing: boolean;
      capabilities: string[];
      /** @default false */
      focusClosesBackground: boolean;
      /** @default false */
      focusModeEnabled: boolean;
      /** Format: uuid */
      id: string;
      isDefault: boolean;
      kind: null | string;
      name: string;
      online: boolean;
      /** @default false */
      permissionNeeded: boolean;
      restrictedBackgroundPackages?: null | string[];
      /** @default false */
      shortAnimationsEnabled: boolean;
    };
    UpdateProfileRequest: {
      displayName: null | string;
    };
    UpdateShortcutRequest: {
      customLabel: null | string;
      enabled: null | boolean;
    };
    UpdateTvMembersRequest: {
      userIds: null | string[];
    };
    UpdateTvRequest: {
      agentSlug: null | string;
      allowBackgroundAppClosing?: null | boolean;
      focusClosesBackground?: null | boolean;
      focusModeEnabled?: null | boolean;
      name: null | string;
      restrictedBackgroundPackages?: null | string[];
      shortAnimationsEnabled?: null | boolean;
    };
    UpsertBodyEntryRequest: {
      /** Format: double */
      abdomenCm?: null | number | string;
      /** Format: double */
      abdomenSkinfoldMm?: null | number | string;
      /** Format: double */
      armCm: null | number | string;
      /** Format: double */
      armLeftCm?: null | number | string;
      /** Format: double */
      armRightCm?: null | number | string;
      /** Format: double */
      bodyFatPct: null | number | string;
      /** Format: double */
      calfCm?: null | number | string;
      /** Format: double */
      calfLeftCm?: null | number | string;
      /** Format: double */
      calfRightCm?: null | number | string;
      /** Format: double */
      chestCm?: null | number | string;
      /** Format: double */
      chestSkinfoldMm?: null | number | string;
      /** Format: date-time */
      clientUpdatedAt: null | string;
      deleted: boolean;
      fatMethod: null | string;
      /** Format: double */
      forearmCm?: null | number | string;
      /** Format: double */
      forearmLeftCm?: null | number | string;
      /** Format: double */
      forearmRightCm?: null | number | string;
      /** Format: double */
      hipCm: null | number | string;
      /** Format: date */
      measuredOn: null | string;
      /** Format: double */
      neckCm: null | number | string;
      note: null | string;
      /** Format: double */
      thighCm: null | number | string;
      /** Format: double */
      thighLeftCm?: null | number | string;
      /** Format: double */
      thighRightCm?: null | number | string;
      /** Format: double */
      thighSkinfoldMm?: null | number | string;
      /** Format: double */
      waistCm: null | number | string;
      /** Format: double */
      weightKg: null | number | string;
    };
    UpsertBodyProfileRequest: {
      /** Format: double */
      activityFactor: null | number | string;
      /** Format: date */
      birthDate: null | string;
      /** Format: date-time */
      clientUpdatedAt: null | string;
      /** Format: double */
      heightCm: null | number | string;
      sex: null | string;
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
    UpsertFoodRequest: {
      barcode: null | string;
      brand: null | string;
      /** Format: double */
      carbsPer100g: number | string;
      /** Format: date-time */
      clientUpdatedAt: null | string;
      /** Format: double */
      defaultPortionGrams: null | number | string;
      deleted: boolean;
      /** Format: double */
      fatPer100g: number | string;
      /** Format: double */
      kcalPer100g: number | string;
      name: null | string;
      /** Format: double */
      proteinPer100g: number | string;
    };
    UpsertGoalRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      /** Format: uuid */
      exerciseId: null | string;
      /** Format: double */
      value: null | number | string;
    };
    UpsertMealRequest: {
      /** Format: double */
      carbG: number | string;
      /** Format: date-time */
      clientUpdatedAt: null | string;
      deleted: boolean;
      /** Format: date-time */
      eatenAt: null | string;
      /** Format: date */
      eatenOn: null | string;
      /** Format: double */
      fatG: number | string;
      /** Format: uuid */
      foodId: null | string;
      /** Format: double */
      kcal: number | string;
      mealType: null | string;
      name: null | string;
      note: null | string;
      /** Format: double */
      proteinG: number | string;
      /** Format: double */
      quantityG: number | string;
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
      programId?: null | string;
      weekdays?: null | (number | string)[];
    };
    UpsertSessionRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      deleted: boolean;
      deviceId: null | string;
      /** Format: int32 */
      feeling: null | number | string;
      /** Format: date-time */
      finishedAt: null | string;
      note: null | string;
      /** Format: uuid */
      routineId: null | string;
      /** Format: date-time */
      startedAt: null | string;
    };
    UpsertSetRequest: {
      /** Format: date-time */
      clientUpdatedAt: null | string;
      /** Format: date-time */
      completedAt: null | string;
      deleted: boolean;
      /** Format: int32 */
      durationS: null | number | string;
      /** Format: uuid */
      exerciseId: null | string;
      note: null | string;
      /** Format: int32 */
      position: null | number | string;
      /** Format: int32 */
      reps: null | number | string;
      /** Format: int32 */
      rir: null | number | string;
      /** Format: double */
      rpe: null | number | string;
      setType: null | string;
      /** Format: double */
      weightKg: null | number | string;
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
