'use client';

/**
 * Root error boundary — catches errors that escape the per-route `error.tsx`
 * files (or anything thrown during the initial render of `app/layout.tsx`).
 * Standalone build: no Sentry. We log to the console and render Next's minimal
 * error UI.
 */

import NextError from 'next/error';
import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
}

export default function GlobalError({ error }: GlobalErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
