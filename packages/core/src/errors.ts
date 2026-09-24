export type GovernanceErrorCode = "not_found" | "forbidden" | "invalid" | "conflict";

/**
 * A request the service refuses. Lifecycle violations surface as the
 * domain's IllegalTransitionError instead. Records the caller cannot see
 * are reported as not_found, so their existence never leaks.
 */
export class GovernanceError extends Error {
  constructor(
    readonly code: GovernanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}
