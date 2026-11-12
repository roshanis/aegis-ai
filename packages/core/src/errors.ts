export type GovernanceErrorCode = "not_found" | "forbidden" | "invalid" | "conflict" | "unavailable" | "rate_limited";

/**
 * A request the service refuses. Lifecycle violations surface as the
 * domain's IllegalTransitionError instead. Records the caller cannot see
 * are reported as not_found, so their existence never leaks. `unavailable`
 * means a model the request depended on failed; trying again may work.
 * `rate_limited` means too many requests; `retryAfter` says when to try again.
 */
export class GovernanceError extends Error {
  constructor(
    readonly code: GovernanceErrorCode,
    message: string,
    /** Seconds to wait, for rate_limited. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}
