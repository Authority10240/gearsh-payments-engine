import { HttpException } from '@nestjs/common';
import { ERROR_META, ErrorCode } from './error-codes';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface AppExceptionOptions {
  detail?: string;
  fieldErrors?: FieldError[];
  cause?: unknown;
}

/**
 * Domain exception carrying a canonical ErrorCode. The global ProblemFilter
 * renders it into an RFC 7807 `application/problem+json` envelope.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly fieldErrors?: FieldError[];

  constructor(code: ErrorCode, options: AppExceptionOptions = {}) {
    const meta = ERROR_META[code];
    super(meta.title, meta.status, { cause: options.cause });
    this.code = code;
    this.detail = options.detail;
    this.fieldErrors = options.fieldErrors;
  }

  get title(): string {
    return ERROR_META[this.code].title;
  }
}
