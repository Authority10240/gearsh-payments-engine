import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppException, type FieldError } from './app-exception';
import { ERROR_META, ErrorCode, problemType } from './error-codes';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  traceId: string;
  requestId: string;
  fieldErrors?: FieldError[];
}

/**
 * Global filter rendering every thrown error as an RFC 7807
 * `application/problem+json` document (conventions §7). 5xx are logged at
 * error level with the original cause; 4xx at debug.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { code, detail, fieldErrors } = this.classify(exception);
    const { status, title } = ERROR_META[code];

    const body: ProblemBody = {
      type: problemType(code),
      title,
      status,
      code,
      traceId: req.traceparent ?? '',
      requestId: req.requestId ?? '',
      instance: req.originalUrl,
      ...(detail ? { detail } : {}),
      ...(fieldErrors && fieldErrors.length ? { fieldErrors } : {}),
    };

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId: body.requestId, code },
        `${req.method} ${req.originalUrl} → ${status} ${code}`,
      );
    } else {
      this.logger.debug(`${req.method} ${req.originalUrl} → ${status} ${code}`);
    }

    res.status(status).setHeader('Content-Type', 'application/problem+json').json(body);
  }

  private classify(exception: unknown): {
    code: ErrorCode;
    detail?: string;
    fieldErrors?: FieldError[];
  } {
    if (exception instanceof AppException) {
      return { code: exception.code, detail: exception.detail, fieldErrors: exception.fieldErrors };
    }

    if (exception instanceof ThrottlerException) {
      return { code: ErrorCode.RATE_LIMITED };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { code: ErrorCode.CONFLICT, detail: 'A record with these values already exists.' };
      }
      if (exception.code === 'P2025') {
        return { code: ErrorCode.NOT_FOUND };
      }
      return { code: ErrorCode.INTERNAL_ERROR };
    }

    if (exception instanceof SyntaxError && 'body' in (exception as object)) {
      return { code: ErrorCode.INVALID_JSON };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    return { code: ErrorCode.INTERNAL_ERROR };
  }

  private fromHttpException(exception: HttpException): {
    code: ErrorCode;
    detail?: string;
    fieldErrors?: FieldError[];
  } {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const detail =
      typeof response === 'string'
        ? response
        : ((response as { message?: unknown }).message as string | string[] | undefined) &&
            !Array.isArray((response as { message?: unknown }).message)
          ? (response as { message: string }).message
          : undefined;

    const map: Record<number, ErrorCode> = {
      [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
      [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
      [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
      [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
      [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
      [HttpStatus.GONE]: ErrorCode.RESOURCE_GONE,
      [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.BUSINESS_RULE_VIOLATION,
      [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
      [HttpStatus.BAD_GATEWAY]: ErrorCode.UPSTREAM_FAILURE,
      [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
      [HttpStatus.GATEWAY_TIMEOUT]: ErrorCode.UPSTREAM_TIMEOUT,
    };

    return { code: map[status] ?? ErrorCode.INTERNAL_ERROR, detail };
  }
}
