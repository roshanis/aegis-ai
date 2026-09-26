import { caseLabel } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { TierText } from "@/components/ds";
import { governance } from "@/lib/db";
import { CASE_STATE, TRIGGER, age, nextStep } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Reviews" };

export default async function ReviewsPage() {
  const { principal } = await requireViewer();
  const views = await (await governance()).listAssetViews(principal);
  const now = new Date();
  const mine = views.flatMap((v) => {
    const step = nextStep(v);
    return step ? [{ v, step }] : [];
  });
  const open = views.filter((v) => v.openCase);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Reviews · what waits on whom</span>
          <h1 className="display-l">
            Waiting for <em>you</em>
          </h1>
          <p>Every review, sign-off, exception and condition that needs this seat. Agents draft; people sign and decide.</p>
        </div>
      </div>

      {mine.length === 0 ? (
        <p className="empty">Nothing is waiting for you.</p>
      ) : (
        <section className="panel panel-xl panel-flush" aria-label="Waiting for you">
          <table className="data responsive">
            <thead>
              <tr>
                <th scope="col">System</th>
                <th scope="col">What to do</th>
                <th scope="col">Tier</th>
                <th scope="col">Case</th>
                <th scope="col" className="num">
                  Waiting
                </th>
              </tr>
            </thead>
            <tbody>
              {mine.map(({ v, step }) => {
                const review = v.openCase ?? v.cases.at(-1) ?? null;
                return (
                  <tr key={v.asset.id}>
                    <td>
                      <div className="system-name">
                        <span className="kind-mark" data-kind={v.asset.kind === "agent" ? "agent" : "system"} />
                        <Link href={`/registry/${v.asset.id}`}>{v.asset.name}</Link>
                      </div>
                    </td>
                    <td data-label="What to do">
                      <Link href={`/registry/${v.asset.id}`} style={{ fontWeight: 600 }}>
                        {step.label}
                      </Link>
                    </td>
                    <td data-label="Tier">
                      <TierText tier={review?.tier ?? null} />
                    </td>
                    <td data-label="Case" className="mono-s">
                      {review ? caseLabel(review.number) : "—"}
                    </td>
                    <td data-label="Waiting" className="num">
                      {age(review?.createdAt ?? v.asset.createdAt, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <div className="page-head" style={{ marginTop: 12 }}>
        <div>
          <span className="eyebrow">Open reviews · {open.length}</span>
          <h2 className="display-m">Every case under way</h2>
        </div>
      </div>
      {open.length === 0 ? (
        <p className="empty">No review is open.</p>
      ) : (
        <section className="panel panel-xl panel-flush" aria-label="Open reviews">
          <table className="data responsive">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">System</th>
                <th scope="col">Tier</th>
                <th scope="col">Where it stands</th>
                <th scope="col">Waiting on</th>
              </tr>
            </thead>
            <tbody>
              {open.map((v) => {
                const c = v.openCase!;
                const reviews = v.assurance.reviews.filter((r) => r.caseId === c.id);
                const unsigned = reviews.filter((r) => r.status !== "signed" && r.status !== "abstained");
                return (
                  <tr key={c.id}>
                    <td className="mono-s">
                      <Link href={`/registry/${v.asset.id}`}>{caseLabel(c.number)}</Link>
                    </td>
                    <td data-label="System">
                      {v.asset.name}
                      <span className="caption muted" style={{ display: "block" }}>
                        {TRIGGER[c.trigger]}
                      </span>
                    </td>
                    <td data-label="Tier">
                      <TierText tier={c.tier} />
                    </td>
                    <td data-label="Where it stands">
                      {reviews.length > 0 ? `${reviews.length - unsigned.length} of ${reviews.length} signed` : (CASE_STATE[c.state]?.label ?? c.state)}
                    </td>
                    <td data-label="Waiting on" className="muted">
                      {c.state === "draft" || c.state === "changes_requested"
                        ? `${v.ownerName ?? "the owner"}'s intake`
                        : unsigned.length > 0
                          ? unsigned.map((r) => r.label).join(", ")
                          : "the approver"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
