// Every successful tool result says where and how it was read.
import { z } from "zod";
import type { Method } from "./types";

/** Spread into every tool's output shape. */
export const ENVELOPE = {
  source_url: z.string(),
  read_at: z.string(),
  method: z.enum(["fetch", "search", "agent_cached", "status"]),
  cached: z.boolean(),
  ttl_seconds: z.number().optional(),
};

export type Envelope = z.infer<z.ZodObject<typeof ENVELOPE>>;

/** Adds the envelope to a result. `read_at` defaults to now; `ttl_seconds` is set only when given. */
export function stamp<T>(
  data: T,
  meta: { source_url: string; method: Method; cached: boolean; read_at?: Date; ttl_seconds?: number },
): T & Envelope {
  return {
    ...data,
    source_url: meta.source_url,
    read_at: (meta.read_at ?? new Date()).toISOString(),
    method: meta.method,
    cached: meta.cached,
    ...(meta.ttl_seconds !== undefined ? { ttl_seconds: meta.ttl_seconds } : {}),
  };
}
