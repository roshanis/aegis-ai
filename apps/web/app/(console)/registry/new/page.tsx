import { can } from "@aegis/domain";
import type { InitiativePack } from "@aegis/frameworks";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Intake } from "@/components/Intake";
import { governance } from "@/lib/db";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Register a system" };

export default async function RegisterPage() {
  const { principal } = await requireViewer();
  if (!can(principal, "asset.register")) redirect("/registry");
  const gov = await governance();
  const pack = (await gov.policyPack(principal, { caseKind: "risk_review" })) as InitiativePack | null;
  const assistant = await gov.agentOn(principal, "intake");

  return (
    <>
      <div className="page-head">
        <div>
          <span className="crumbs">
            <Link href="/registry">Registry</Link> / register a system
          </span>
          <h1 className="display-l">
            File a new <em>AI system</em>
          </h1>
          <p>Name it, say what it does, and settle six phrases. You see the risk tier and who has to review it as you go.</p>
        </div>
      </div>
      {pack ? (
        <Intake pack={{ ...pack, goldenSets: undefined }} mode={{ kind: "register" }} assistant={assistant} />
      ) : (
        <p className="notice" data-tone="warn">
          This organization has no AI policy pack enabled yet. Ask an admin to enable one.
        </p>
      )}
    </>
  );
}
