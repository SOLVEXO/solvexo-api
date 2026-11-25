/* eslint-disable prettier/prettier */
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Error as MongooseError } from 'mongoose';

/**
 * A value that isn't a valid id (e.g. `/api/public/selling-plans/S1`) makes Mongoose throw a CastError before any query
 * runs. That is a bad request from the caller, not a server fault, so it answers 400 "Invalid id" instead of a bare 500.
 * Only CastError is caught here; every other error keeps Nest's default handling. Still logged (one line) so a cast
 * that comes from our own data, not the caller, stays visible.
 */
@Catch(MongooseError.CastError)
export class CastErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('CastError');

  catch(err: MongooseError.CastError, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw err;
    const http = host.switchToHttp();
    const req = http.getRequest<{ method?: string; originalUrl?: string; url?: string }>();
    const res = http.getResponse<{ headersSent?: boolean; status: (n: number) => { json: (b: unknown) => void } }>();
    const field = err.path === '_id' ? 'id' : err.path;
    this.log.warn(`${req?.method ?? ''} ${req?.originalUrl ?? req?.url ?? ''}: ${field} "${String(err.value)}" is not a valid ${err.kind}`);
    if (res?.headersSent) return;
    res.status(400).json({ statusCode: 400, error: 'Bad Request', message: `Invalid ${field}: "${String(err.value)}"` });
  }
}
