/**
 * Typed error hierarchy for the search pipeline.
 * Each error carries a user-safe message and HTTP status code.
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = "INTERNAL_ERROR",
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message },
    };
  }
}

export class AuthError extends AppError {
  constructor(message = "Missing or invalid authorization") {
    super(message, 401, "AUTH_ERROR");
    this.name = "AuthError";
  }
}

export class RateLimitError extends AppError {
  constructor(
    public readonly retryAfter: number,
    public readonly remaining: number = 0,
  ) {
    super("Rate limit exceeded", 429, "RATE_LIMIT_EXCEEDED");
    this.name = "RateLimitError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, statusCode: number, detail: string) {
    super(
      `${service} request failed`,
      502,
      "EXTERNAL_SERVICE_ERROR",
      true,
    );
    this.name = "ExternalServiceError";
    // Detail is logged but not exposed to the client
    this.cause = { service, upstreamStatus: statusCode, detail };
  }
}
