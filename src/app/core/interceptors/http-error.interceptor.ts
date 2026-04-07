import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { throwError, timer } from 'rxjs';
import { catchError, retry, timeout } from 'rxjs';

export const httpErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const requestId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const request = req.clone({
    setHeaders: { 'X-Request-ID': requestId },
  });

  const retryable = request.method === 'GET';

  return next(request).pipe(
    timeout(45000),
    retry({
      count: retryable ? 2 : 0,
      delay: (_error, retryIndex) =>
        timer(Math.min(300 * 2 ** retryIndex, 1500)),
    }),
    catchError((error: unknown) => {
      let normalized: Error;

      if (error instanceof HttpErrorResponse) {
        const serverMessage =
          error?.error?.error ||
          error?.error?.message ||
          error?.message ||
          'Request failed';

        normalized = new Error(
          `[${requestId}] ${request.method} ${request.url} failed (${error.status}): ${serverMessage}`
        );
      } else if (error instanceof Error) {
        normalized = new Error(
          `[${requestId}] ${request.method} ${request.url} failed: ${error.message}`
        );
      } else {
        normalized = new Error(
          `[${requestId}] ${request.method} ${request.url} failed: Unknown error`
        );
      }

      return throwError(() => normalized);
    })
  );
};
