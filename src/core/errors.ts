// The error contract (spec 4.3). A tool failure is an MCP tool result with
// `isError: true` and this JSON body; nothing else is ever returned on failure.

export type ErrorCode =
  | "NOT_FOUND"
  | "SITE_CHANGED"
  | "RATE_LIMITED"
  | "BUDGET_PAUSED"
  | "UPSTREAM_TIMEOUT"
  | "INVALID_INPUT";

export interface ToolErrorDetails {
  /** What the caller can do about it. */
  fix?: string;
  retry_after_seconds?: number;
  /** For RATE_LIMITED: this caller's limit, or Falaj's daily cap. */
  scope?: "caller" | "global";
  /** The UAEU page involved. */
  source_url?: string;
  /** For NOT_FOUND: the candidates that were close. */
  near_matches?: string[];
}

const OPTIONAL_FIELDS = ["fix", "retry_after_seconds", "scope", "source_url", "near_matches"] as const;

export class ToolError extends Error {
  code: ErrorCode;
  fix?: string;
  retry_after_seconds?: number;
  scope?: "caller" | "global";
  source_url?: string;
  near_matches?: string[];

  constructor(code: ErrorCode, message: string, details: ToolErrorDetails = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    for (const field of OPTIONAL_FIELDS) {
      if (details[field] !== undefined) (this as Record<string, unknown>)[field] = details[field];
    }
  }

  /** `{code, message, ...the defined optionals}`: the JSON text of the error result. */
  toBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { code: this.code, message: this.message };
    for (const field of OPTIONAL_FIELDS) {
      if (this[field] !== undefined) body[field] = this[field];
    }
    return body;
  }
}
