import 'express';
import type { AuthUser } from '../common/auth-user';

// Make Passport's `Express.User` our AuthUser so `req.user` is fully typed.
declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthUser {}

    interface Request {
      /** Per-request UUID (X-Request-Id or generated). Echoed on the response. */
      requestId: string;
      /** W3C traceparent (incoming or synthesised). Echoed in error envelopes. */
      traceparent: string;
    }
  }
}

export {};
