/**
 * RFC 9457 Problem Details. Every error response in the API is an `application/problem+json`
 * document built from this class, so clients can branch on the stable `type` slug.
 */
export interface FieldError {
  /** JSON Pointer (RFC 6901) into the request, e.g. `#/items/0/quantity`. */
  pointer: string;
  detail: string;
}

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }

  get type(): string {
    return `/problems/${this.slug}`;
  }
}

export const problems = {
  malformedJson: () => new Problem(400, 'malformed-json', 'Malformed JSON body'),
  badRequest: (detail: string) => new Problem(400, 'bad-request', 'Bad request', detail),
  unauthorized: () =>
    new Problem(401, 'unauthorized', 'Authentication required', 'Provide a valid bearer token.'),
  forbidden: () =>
    new Problem(403, 'forbidden', 'Forbidden', 'This token is not allowed to perform the action.'),
  notFound: (what = 'Resource') => new Problem(404, 'not-found', `${what} not found`),
  conflict: (slug: string, title: string, detail?: string, ext?: Record<string, unknown>) =>
    new Problem(409, slug, title, detail, ext),
  payloadTooLarge: () => new Problem(413, 'payload-too-large', 'Request body too large'),
  unsupportedMediaType: () =>
    new Problem(415, 'unsupported-media-type', 'Unsupported media type', 'Use application/json.'),
  validation: (errors: FieldError[], detail = 'The request failed validation.') =>
    new Problem(422, 'validation-failed', 'Validation failed', detail, { errors }),
  tooManyRequests: () => new Problem(429, 'rate-limited', 'Too many requests'),
};
