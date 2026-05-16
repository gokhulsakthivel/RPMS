// Minimal type declaration for the `cors` package.
// The full `@types/cors` was unavailable from the registry at build time.
declare module 'cors' {
  import type { RequestHandler } from 'express';

  interface CorsOptions {
    origin?: string | string[] | boolean | RegExp | (string | RegExp)[];
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    credentials?: boolean;
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
  }

  function cors(options?: CorsOptions): RequestHandler;
  export = cors;
}
