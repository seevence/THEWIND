import type { ApiErrorResponseV1 } from "../contracts/api.ts";

type CareerErrorCode = ApiErrorResponseV1["error"]["code"];

export class CareerApiError extends Error {
  readonly statusCode: number;
  readonly code: CareerErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: CareerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class InvalidParameterError extends CareerApiError {
  constructor(message = "Invalid request parameter.", details?: Record<string, unknown>) {
    super(400, "invalid_parameter", message, details);
  }
}

export class NotFoundError extends CareerApiError {
  constructor(message = "Job not found.") {
    super(404, "not_found", message);
  }
}

export class DataUnavailableError extends CareerApiError {
  constructor(message = "Career data is unavailable.") {
    super(503, "data_unavailable", message);
  }
}