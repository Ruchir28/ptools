export const requestOrigin = (request: Request): string =>
  new URL(request.url).origin;
