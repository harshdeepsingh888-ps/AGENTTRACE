import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  console.error("Unhandled request error", error);
  response.status(500).json({ error: "Internal server error" });
};
