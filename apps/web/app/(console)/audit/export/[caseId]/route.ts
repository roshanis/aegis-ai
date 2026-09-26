import { governance } from "@/lib/db";
import { refusal } from "@/lib/errors";
import { getViewer } from "@/lib/viewer";

/** An auditor's evidence pack for one case, as a JSON download. The export is itself recorded in the audit log. */
export async function GET(_: Request, { params }: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in first.", { status: 401 });
  const { caseId } = await params;
  try {
    const { filename, body } = await (await governance()).exportEvidencePack(viewer.principal, caseId);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const refused = refusal(error);
    if (!refused) throw error;
    return new Response(refused.message, { status: refused.code === "not_found" ? 404 : 403 });
  }
}
