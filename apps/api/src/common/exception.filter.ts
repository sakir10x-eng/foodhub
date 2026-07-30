import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { CrossTenantAccessError } from '../prisma/tenant-guard';

/**
 * One error shape for the whole API: `{ statusCode, code, message, errors? }`.
 *
 * Prisma errors are translated rather than leaked — a raw P2002 tells an attacker which
 * column is unique, and a stack trace tells them the file layout.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let errors: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      code = body?.code ?? httpCode(status);
      message = Array.isArray(body?.message) ? body.message[0] : (body?.message ?? exception.message);
      errors = body?.errors;
    } else if (exception instanceof CrossTenantAccessError) {
      // A missing tenant filter is our bug, never the caller's — surface it loudly in
      // logs but tell the client nothing about the internals.
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = 'TENANT_SCOPE_ERROR';
      this.logger.error(`TENANT SCOPE VIOLATION on ${req?.method} ${req?.url}: ${exception.message}`);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          code = 'DUPLICATE';
          message = 'That value is already taken';
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          code = 'NOT_FOUND';
          message = 'Not found';
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          code = 'INVALID_REFERENCE';
          message = 'That reference does not exist';
          break;
        default:
          this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
      }
    } else if (exception instanceof Error) {
      this.logger.error(`${req?.method} ${req?.url}: ${exception.message}`, exception.stack);
    }

    if (status >= 500) {
      this.logger.error(`${status} ${req?.method} ${req?.url} — ${code}`);
    }

    res.status(status).json({ statusCode: status, code, message, ...(errors ? { errors } : {}) });
  }
}

function httpCode(status: number): string {
  const map: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE',
    429: 'RATE_LIMITED',
  };
  return map[status] ?? 'ERROR';
}
