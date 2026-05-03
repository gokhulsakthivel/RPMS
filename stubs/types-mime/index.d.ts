// Local stub for @types/mime. Walmart's npm proxy blocks the real package.
// We never call mime.* in this project — Express's static-file path is unused
// (the SPA build is served by Vite preview or by Express at /, with no
// dependency on mime APIs from our code). The shape below satisfies the
// transitive @types/serve-static signature.

declare module 'mime' {
  export function lookup(path: string): string | false;
  export function extension(mimeType: string): string | false;
  export function getType(path: string): string | null;
  export function getExtension(mimeType: string): string | null;
  export const types: Record<string, string>;
  export const extensions: Record<string, string>;
  export function define(mimes: Record<string, string[]>, force?: boolean): void;
}
