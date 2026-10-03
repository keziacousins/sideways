/**
 * Shared by the internal RPC endpoints under `pages/op/`, which forward a
 * request to the API server with `Authorization: Bearer ...`.
 *
 * The token comes from `locals.accessToken`: the middleware has already
 * refreshed it, and is the only place allowed to.
 */

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

export { API_URL };
