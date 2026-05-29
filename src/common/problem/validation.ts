import { ValidationError } from 'class-validator';
import { AppException, type FieldError } from './app-exception';
import { ErrorCode } from './error-codes';

/** Flatten nested class-validator errors into RFC 7807 fieldErrors. */
function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const err of errors) {
    const path = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      for (const [rule, message] of Object.entries(err.constraints)) {
        out.push({ field: path, code: rule.toUpperCase(), message });
      }
    }
    if (err.children && err.children.length) {
      out.push(...flatten(err.children, path));
    }
  }
  return out;
}

/** ValidationPipe exceptionFactory → typed VALIDATION_FAILED AppException. */
export function validationExceptionFactory(errors: ValidationError[]): AppException {
  return new AppException(ErrorCode.VALIDATION_FAILED, {
    detail: 'One or more fields are invalid.',
    fieldErrors: flatten(errors),
  });
}
