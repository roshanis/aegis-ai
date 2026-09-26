/**
 * A refusal from the governance service, recognised by name rather than
 * instanceof: Next.js can load a workspace package once per server layer,
 * and an error thrown by one copy is not an instance of another copy's class.
 */
export function refusal(error: unknown): { readonly code: string; readonly message: string } | null {
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || typeof e.message !== "string") return null;
  if (e.name === "GovernanceError") return { code: String(e.code), message: e.message };
  if (e.name === "IllegalTransitionError") return { code: "invalid", message: e.message.replace(/^Illegal transition: /, "") };
  return null;
}
