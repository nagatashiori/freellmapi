import type { Request, Response, NextFunction } from 'express';

interface BodyParseError extends Error {
  status?: number;
  type?: string;
  body?: unknown;
}

function isJsonBodyParseError(err: unknown): err is BodyParseError {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as BodyParseError;
  return candidate.type === 'entity.parse.failed'
    || (candidate.name === 'SyntaxError' && candidate.status === 400 && 'body' in candidate);
}

function containsHttpRequestLine(body: unknown): boolean {
  return typeof body === 'string'
    && /^\s*(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+https?:\/\/\S+/i.test(body);
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const typedError = err as BodyParseError;

  if (isJsonBodyParseError(err) && (typedError.status ?? 400) === 400) {
    const userAgent = String(req.get('user-agent') ?? '').slice(0, 120);
    console.warn(
      `[Error] invalid JSON body ${req.method} ${req.path}`
      + ` content-type=${String(req.get('content-type') ?? 'unknown')}`
      + (userAgent ? ` user-agent=${userAgent}` : ''),
    );

    const message = containsHttpRequestLine(typedError.body)
      ? 'Request body is not valid JSON: the client sent an HTTP request line as the body. '
        + `Send a JSON body to ${req.path}; for Anthropic clients, set Base URL to the server root without /v1 and let the SDK call /v1/messages.`
      : 'Request body is not valid JSON. Send a JSON object with Content-Type: application/json.';

    res.status(400).json({
      error: { message, type: 'invalid_request_error', code: 'invalid_json_body' },
    });
    return;
  }

  console.error('[Error]', err.message);

  if (res.headersSent) return next(err);

  const status = typedError.status ?? 500;
  res.status(status).json({
    error: {
      message: err.message,
      type: err.name ?? 'server_error',
    },
  });
}
