import { createMiddleware } from "hono/factory";
import { logger } from "../logger.js";
import { randomUUID } from "crypto";

/** Adds request ID and logs every request with method, path, status, duration, and user. */
export const requestLogMiddleware = createMiddleware(async (c, next) => {
  const requestId = randomUUID().slice(0, 8);
  c.set("requestId", requestId);

  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  try {
    await next();
  } catch (err: any) {
    const duration = Date.now() - start;
    logger.error({ requestId, method, path, duration, err: err.message, stack: err.stack }, "Request error");
    throw err;
  }

  const duration = Date.now() - start;
  const status = c.res.status;
  const userId = c.get("userId") as string | undefined;

  const logData: Record<string, any> = { requestId, method, path, status, duration };
  if (userId) logData.userId = userId;

  if (status >= 500) {
    logger.error(logData, "Request failed");
  } else if (status >= 400) {
    logger.warn(logData, "Request error");
  } else if (path !== "/health") {
    logger.info(logData, "Request");
  }
});
