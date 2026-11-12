import { can } from "@aegis/domain";
import type { ContentPack } from "@aegis/frameworks";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CommunicationForm } from "@/components/CommunicationForm";
import { governance } from "@/lib/db";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "File a communication" };

export default async function RegisterCommunicationPage() {
  const { principal } = await requireViewer();
  if (!can(principal, "asset.register")) redirect("/registry");
  const gov = await governance();
  const pack = (await gov.policyPack(principal, { caseKind: "content_review" })) as ContentPack | null;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="crumbs">
            <Link href="/registry">Registry</Link> / file a communication
          </span>
          <h1 className="display-l">
            Send a <em>member communication</em> for review
          </h1>
        </div>
      </div>
      {pack ? (
        <CommunicationForm pack={{ id: pack.id, version: pack.version, markets: pack.markets, rubric: pack.rubric }} mode={{ kind: "register" }} />
      ) : (
        <p className="notice" data-tone="warn">
          This organization has no member communications pack enabled yet. Ask an admin to enable one.
        </p>
      )}
    </>
  );
}
