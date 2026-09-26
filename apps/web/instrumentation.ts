/** Boot the runtime when the server starts, so agent jobs a previous process left behind resume. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { runtime } = await import("./lib/runtime");
  await runtime();
}
