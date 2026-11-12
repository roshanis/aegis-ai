import { appendAudit, type Connection } from "@aegis/db";
import { ROLES, can, roleConflicts, type Principal, type Role } from "@aegis/domain";
import type { PolicyPack } from "@aegis/frameworks";
import { GovernanceError } from "./errors";
import { UUID, actorId, type Kernel } from "./model";
import { loadSsoSettings, type SsoSettings } from "./sso";

/**
 * The people in a tenant: who they are, what they may do, and whether they
 * may come in at all. Admins manage them; everyone else cannot see this list.
 */

export interface PersonRecord {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly title: string | null;
  readonly roles: readonly Role[];
  readonly reviewDomains: readonly string[];
  readonly active: boolean;
  /** True once they have signed in through the tenant's provider. */
  readonly linked: boolean;
  readonly lastSignInAt: Date | null;
}

export interface PeopleOverview {
  readonly people: readonly PersonRecord[];
  readonly sso: SsoSettings | null;
  /** Review domains people can be given, from the tenant's enabled packs. */
  readonly domains: readonly { readonly id: string; readonly label: string }[];
}

export interface PersonChange {
  readonly roles: readonly Role[];
  readonly reviewDomains: readonly string[];
  readonly active: boolean;
}

function requireAdmin(actor: Principal): void {
  if (!can(actor, "tenant.manage")) throw new GovernanceError("forbidden", "only an admin manages people");
}

async function reviewDomains(tx: Connection): Promise<{ id: string; label: string }[]> {
  const { rows } = await tx.query<{ content: PolicyPack }>("SELECT content FROM policy_packs WHERE enabled");
  const seen = new Map<string, string>();
  for (const { content } of rows) {
    if (content.kind !== "initiative") continue;
    for (const [id, label] of Object.entries(content.domains)) if (!seen.has(id)) seen.set(id, label);
  }
  return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function createPeople(k: Kernel) {
  return {
    /** Everyone in the tenant, with how they sign in. Admins only. */
    people(actor: Principal): Promise<PeopleOverview> {
      return k.inTenant(actor, async (tx) => {
        requireAdmin(actor);
        const { rows } = await tx.query<{
          id: string;
          email: string;
          display_name: string;
          title: string | null;
          roles: Role[];
          review_domains: string[];
          active: boolean;
          sso_subject: string | null;
          last_sign_in_at: Date | null;
        }>(
          `SELECT id, email, display_name, title, roles, review_domains, active, sso_subject, last_sign_in_at
           FROM users ORDER BY active DESC, lower(display_name), id`,
        );
        return {
          people: rows.map((r) => ({
            userId: r.id,
            email: r.email,
            displayName: r.display_name,
            title: r.title,
            roles: r.roles,
            reviewDomains: r.review_domains,
            active: r.active,
            linked: r.sso_subject !== null,
            lastSignInAt: r.last_sign_in_at ? new Date(r.last_sign_in_at) : null,
          })),
          sso: await loadSsoSettings(tx),
          domains: await reviewDomains(tx),
        };
      });
    },

    /**
     * Change what someone may do, or switch them off. Switching someone off
     * ends their sessions at their next request. An admin cannot lock
     * themselves out, and the tenant always keeps one active admin.
     */
    updatePerson(actor: Principal, userId: string, change: PersonChange): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        requireAdmin(actor);
        if (!UUID.test(userId)) throw new GovernanceError("not_found", "no such person");
        const roles = [...new Set(change.roles)];
        const unknown = roles.filter((r) => !ROLES.includes(r));
        if (unknown.length > 0) throw new GovernanceError("invalid", `unknown roles: ${unknown.join(", ")}`);
        if (roles.length === 0) throw new GovernanceError("invalid", "give everyone at least one role");
        const conflicts = roleConflicts(roles);
        if (conflicts.length > 0) throw new GovernanceError("invalid", conflicts.join("; "));
        const known = new Set((await reviewDomains(tx)).map((d) => d.id));
        const domains = [...new Set(change.reviewDomains)];
        const strange = domains.filter((d) => !known.has(d));
        if (strange.length > 0) throw new GovernanceError("invalid", `unknown review domains: ${strange.join(", ")}`);
        // Domains mean nothing without the reviewer role; keep the record honest.
        const reviewDomainsKept = roles.includes("reviewer") ? domains.sort() : [];

        // Lock admins so two admins demoting each other cannot leave nobody in charge.
        const { rows: admins } = await tx.query<{ id: string }>(
          "SELECT id FROM users WHERE active AND 'admin' = ANY(roles) FOR UPDATE",
        );
        const { rows } = await tx.query<{ roles: Role[]; review_domains: string[]; active: boolean }>(
          "SELECT roles, review_domains, active FROM users WHERE id = $1 FOR UPDATE",
          [userId],
        );
        const before = rows[0];
        if (!before) throw new GovernanceError("not_found", "no such person");

        const self = actor.kind === "human" && actor.userId === userId;
        if (self && !change.active) throw new GovernanceError("invalid", "you cannot switch yourself off");
        if (self && !roles.includes("admin")) throw new GovernanceError("invalid", "another admin has to remove your admin role");
        const staysAdmin = change.active && roles.includes("admin");
        if (!staysAdmin && admins.some((a) => a.id === userId) && admins.length === 1) {
          throw new GovernanceError("invalid", "the tenant needs at least one active admin");
        }

        const same =
          before.active === change.active &&
          before.roles.length === roles.length &&
          before.roles.every((r) => roles.includes(r)) &&
          before.review_domains.length === reviewDomainsKept.length &&
          before.review_domains.every((d) => reviewDomainsKept.includes(d));
        if (same) return;

        await tx.query("UPDATE users SET roles = $2, review_domains = $3, active = $4 WHERE id = $1", [
          userId,
          roles,
          reviewDomainsKept,
          change.active,
        ]);
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: before.active && !change.active ? "user.deactivate" : !before.active && change.active ? "user.reactivate" : "user.update",
          payload: {
            userId,
            rolesBefore: before.roles,
            roles,
            reviewDomainsBefore: before.review_domains,
            reviewDomains: reviewDomainsKept,
            active: change.active,
          },
          at: k.now(),
        });
      });
    },
  };
}
