import { createHash, randomUUID } from "node:crypto";
import type { Connection } from "@aegis/db";
import {
  MAX_COMMUNICATION,
  checkCommunication,
  type Coverage,
  type CoverageStatus,
  type Finding,
  type Principal,
  type Severity,
  type SystemPrincipal,
  type Verdict,
} from "@aegis/domain";
import type { ContentPack } from "@aegis/frameworks";
import { GovernanceError } from "./errors";
import type { Case, Kernel } from "./model";

/**
 * Member communications review, Cleared's engine on Aegis' registry: the
 * owner submits the text and the markets it is for, Aegis checks it against
 * the case's content pack in code, and a compliance officer approves it,
 * asks for changes, or rejects it. Each submission is a version kept as
 * written, with the check it got.
 */

export interface CriterionView {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly description: string;
  readonly recommendation: string | null;
  /** "uncertain" means no rule could check it: a person has to. */
  readonly status: CoverageStatus;
  /** True when Aegis can check this criterion in code. */
  readonly automatic: boolean;
}

export interface ContentVersionView {
  readonly version: number;
  readonly body: string;
  readonly bodySha256: string;
  readonly markets: readonly string[];
  readonly findings: readonly Finding[];
  readonly coverage: readonly Coverage[];
  readonly verdict: Verdict;
  readonly byMarket: readonly { readonly jurisdiction: string; readonly verdict: Verdict }[];
  readonly submittedBy: { readonly id: string; readonly name: string | null };
  readonly submittedAt: Date;
}

export interface CommunicationView {
  readonly caseId: string;
  readonly pack: { readonly id: string; readonly version: string; readonly title: string; readonly markets: readonly string[] };
  /** Oldest first; the last one is what the officer decides on. */
  readonly versions: readonly ContentVersionView[];
  /** The latest version's criteria, in the pack's order, with how each fared. */
  readonly criteria: readonly CriterionView[];
}

interface VersionRow {
  version: number;
  body: string;
  body_sha256: string;
  markets: string[];
  findings: Finding[];
  coverage: Coverage[];
  verdict: Verdict;
  by_market: { jurisdiction: string; verdict: Verdict }[];
  submitted_by: string;
  submitted_by_name: string | null;
  submitted_at: Date;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function createContent(k: Kernel) {
  async function contentPack(tx: Connection, c: Case): Promise<ContentPack> {
    if (c.kind !== "content_review") throw new GovernanceError("invalid", "this is not a content review");
    const pack = await k.loadPack(tx, c);
    if (pack.kind !== "content") throw new GovernanceError("invalid", "this case's pack is not a content pack");
    return pack;
  }

  async function versions(tx: Connection, caseId: string): Promise<ContentVersionView[]> {
    const { rows } = await tx.query<VersionRow>(
      `SELECT v.version, v.body, v.body_sha256, v.markets, v.findings, v.coverage, v.verdict, v.by_market,
              v.submitted_by, u.display_name AS submitted_by_name, v.submitted_at
       FROM content_versions v LEFT JOIN users u ON u.id = v.submitted_by
       WHERE v.case_id = $1 ORDER BY v.version`,
      [caseId],
    );
    return rows.map((r) => ({
      version: r.version,
      body: r.body,
      bodySha256: r.body_sha256,
      markets: r.markets,
      findings: r.findings,
      coverage: r.coverage,
      verdict: r.verdict,
      byMarket: r.by_market,
      submittedBy: { id: r.submitted_by, name: r.submitted_by_name },
      submittedAt: new Date(r.submitted_at),
    }));
  }

  return {
    /**
     * The owner submits the communication, or a new version after changes
     * were requested. It is checked against the case's pinned pack in the
     * same transaction, and goes to the officer with its findings.
     */
    submitCommunication(
      actor: Principal,
      caseId: string,
      input: { readonly body: string; readonly markets: readonly string[] },
    ): Promise<{ case: Case; version: ContentVersionView }> {
      return k.inTenant(actor, async (tx) => {
        const current = await k.loadCase(tx, actor, caseId);
        if (actor.kind !== "human" || actor.userId !== current.ownerId) {
          throw new GovernanceError("forbidden", "only the case owner can submit it");
        }
        const pack = await contentPack(tx, current);
        const action = current.state === "changes_requested" ? "resubmit" : "submit";

        const body = input.body.replace(/\r\n/g, "\n").trim();
        if (!body) throw new GovernanceError("invalid", "paste the communication's text");
        if (body.length > MAX_COMMUNICATION) {
          throw new GovernanceError("invalid", `keep it under ${MAX_COMMUNICATION.toLocaleString("en-US")} characters`);
        }
        const markets = pack.markets.filter((m) => input.markets.includes(m));
        const unknown = input.markets.filter((m) => !pack.markets.includes(m));
        if (unknown.length > 0) throw new GovernanceError("invalid", `this pack does not cover ${unknown.join(", ")}`);
        if (markets.length === 0) throw new GovernanceError("invalid", "choose who it is for");

        const { rows } = await tx.query<{ last: number | null }>(
          "SELECT max(version) AS last FROM content_versions WHERE case_id = $1",
          [current.id],
        );
        const version = (rows[0]?.last ?? 0) + 1;
        const bodySha256 = sha256(body);
        // Moving first checks the owner may submit from this state; nothing is stored if not.
        const submitted = await k.moveCase(tx, current, action, actor, {}, { version, bodySha256, markets });

        const at = k.now();
        const check = checkCommunication(pack.rubric, body, markets);
        await tx.query(
          `INSERT INTO content_versions (id, tenant_id, case_id, version, body, body_sha256, markets,
             findings, coverage, verdict, by_market, submitted_by, submitted_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            randomUUID(),
            current.id,
            version,
            body,
            bodySha256,
            markets,
            JSON.stringify(check.findings),
            JSON.stringify(check.coverage),
            check.verdict,
            JSON.stringify(check.byMarket),
            actor.userId,
            at.toISOString(),
          ],
        );
        const checker: SystemPrincipal = { kind: "system", tenantId: actor.tenantId, job: "content-check" };
        const checked = await k.moveCase(tx, submitted, "record_ai_review", checker, {}, {
          version,
          packId: pack.id,
          packVersion: pack.version,
          verdict: check.verdict,
          findings: check.findings.map((f) => f.criterionId),
          forPerson: check.coverage.filter((c) => c.status === "uncertain").map((c) => c.criterionId),
        });
        const views = await versions(tx, current.id);
        return { case: checked, version: views.at(-1)! };
      });
    },

    /** The communication under review, every version of it, and the latest version's criteria. */
    communication(actor: Principal, caseId: string): Promise<CommunicationView> {
      return k.inTenant(actor, async (tx) => {
        const c = await k.loadCase(tx, actor, caseId);
        const pack = await contentPack(tx, c);
        const all = await versions(tx, c.id);
        const latest = all.at(-1);
        const status = new Map(latest?.coverage.map((cv) => [cv.criterionId, cv.status]) ?? []);
        const criteria = pack.rubric.criteria
          .filter((cr) => !latest || status.has(cr.id))
          .map((cr) => ({
            id: cr.id,
            title: cr.title ?? cr.id,
            severity: cr.severity,
            description: cr.description,
            recommendation: cr.recommendation ?? null,
            status: status.get(cr.id) ?? ("uncertain" as const),
            automatic: cr.check !== undefined,
          }));
        return {
          caseId: c.id,
          pack: { id: pack.id, version: pack.version, title: pack.title, markets: pack.markets },
          versions: all,
          criteria,
        };
      });
    },
  };
}
