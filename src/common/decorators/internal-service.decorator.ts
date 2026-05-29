import { SetMetadata } from '@nestjs/common';

export const IS_INTERNAL_SERVICE_KEY = 'isInternalService';

/**
 * Marks a route as service-to-service only — it MUST present a valid
 * `X-Internal-Service-Token` header and is NOT reachable with a user JWT.
 * The InternalServiceGuard accepts only these routes; JwtAuthGuard skips them
 * (the route is treated as @Public() to the user-JWT pipeline).
 */
export const InternalService = () => SetMetadata(IS_INTERNAL_SERVICE_KEY, true);
