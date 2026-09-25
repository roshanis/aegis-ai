import { can } from "@aegis/domain";
import type { InitiativePack } from "@aegis/frameworks";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { IntakeForm } from "@/components/IntakeForm";
import { governance } from "@/lib/db";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Register AI" };

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
          <div className="crumbs">
            <Link href="/registry">Registry</Link> / <span>Register</span>
          </div>
          <h1 style={{ marginTop: 6 }}>Register an AI system</h1>
          <p className="muted">
            Name it, answer six yes-or-no questions, and submit. You&apos;ll see the risk tier and who has to review it
            as you go.
          </p>
        </div>
      </div>
      {pack ? (
        <IntakeForm pack={{ ...pack, goldenSets: undefined }} mode={{ kind: "register" }} assistant={assistant} />
      ) : (
        <div className="banner tone-warn">
          <p>This tenant has no AI policy pack enabled yet. Ask an admin to enable one.</p>
        </div>
      )}
    </>
  );
}
