import { can } from "@aegis/domain";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AddPerson, PersonRow } from "@/components/People";
import { Tag } from "@/components/ds";
import { governance } from "@/lib/db";
import { ROLE, ago } from "@/lib/labels";
import { callbackUrl, publicOrigin } from "@/lib/oidc";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage() {
  const { principal, tenant } = await requireViewer();
  if (!can(principal, "tenant.manage")) redirect("/today");
  const { people, sso, domains } = await (await governance()).people(principal);
  const h = await headers();
  const origin = publicOrigin(`${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`);
  const active = people.filter((p) => p.active).length;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">
            People · {active} can sign in{people.length > active ? ` · ${people.length - active} switched off` : ""}
          </span>
          <h1 className="display-l">People</h1>
        </div>
      </div>

      <section className="panel stack" style={{ gap: 12 }} aria-label="Sign-in">
        <div className="spread">
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Sign-in</span>
            <h2 className="title">
              {tenant.sandboxExpiresAt ? "Sandbox · no sign-in provider" : sso ? "Single sign-on" : "No sign-in provider yet"}
            </h2>
          </div>
          {sso ? <Tag tone="ok">OpenID Connect</Tag> : null}
        </div>
        {sso ? (
          <dl className="facts">
            <div><dt>Provider</dt>
            <dd className="mono-s">{sso.issuer}</dd></div>
            <div><dt>Client</dt>
            <dd className="mono-s">
              {sso.clientId}
              {sso.hasClientSecret ? " · with a secret" : " · public, PKCE"}
            </dd></div>
            <div><dt>Email domains</dt>
            <dd>{sso.emailDomains.join(", ")}</dd></div>
            <div><dt>Who can come in</dt>
            <dd>
              {sso.joinRoles
                ? `Anyone at these domains, joining as ${sso.joinRoles.map((r) => ROLE[r]?.label ?? r).join(" and ")}`
                : "Only people added here"}
            </dd></div>
            <div><dt>Redirect URI</dt>
            <dd className="mono-s">{callbackUrl(origin)}</dd></div>
            <div><dt>Organization name</dt>
            <dd className="mono-s">{tenant.slug}</dd></div>
          </dl>
        ) : tenant.sandboxExpiresAt ? null : (
          <p className="caption muted">Your Aegis contact sets up sign-in with your provider.</p>
        )}
      </section>

      <section className="panel stack" style={{ gap: 12 }} aria-label="Everyone">
        <AddPerson domains={domains} />
        <table className="data people-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Roles</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">
                <span className="visually-hidden">Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <PersonRow
                key={p.userId}
                person={p}
                domains={domains}
                self={p.userId === principal.userId}
                lastSignIn={p.lastSignInAt ? ago(p.lastSignInAt) : p.linked ? "Linked" : "Not yet"}
              />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
