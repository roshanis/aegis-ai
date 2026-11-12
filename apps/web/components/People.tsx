"use client";

import type { PersonRecord } from "@aegis/core";
import { useActionState, useEffect, useState } from "react";
import { addPerson, updatePerson } from "@/app/(console)/people/actions";
import { IDLE } from "@/lib/action-state";
import { ROLE } from "@/lib/labels";
import { ActorMark, Tag } from "./ds";

const ROLE_ORDER = ["requester", "reviewer", "approver", "auditor", "program_office", "admin"] as const;

interface Domain {
  readonly id: string;
  readonly label: string;
}

function RoleFields({ roles, domains, chosen }: { roles: readonly string[]; domains: readonly Domain[]; chosen: readonly string[] }) {
  const [picked, setPicked] = useState<readonly string[]>(roles);
  const toggle = (role: string, on: boolean) => setPicked((now) => (on ? [...now, role] : now.filter((r) => r !== role)));
  return (
    <>
      <fieldset className="stack" style={{ gap: 0 }}>
        <legend className="eyebrow">Roles</legend>
        {ROLE_ORDER.map((role) => (
          <label className="check" key={role}>
            <input
              type="checkbox"
              name="roles"
              value={role}
              checked={picked.includes(role)}
              onChange={(e) => toggle(role, e.currentTarget.checked)}
            />
            <span>
              {ROLE[role]?.label}
              <span className="caption muted" style={{ display: "block" }}>
                {ROLE[role]?.blurb}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {picked.includes("reviewer") ? (
        <fieldset className="stack" style={{ gap: 0 }}>
          <legend className="eyebrow">Signs for</legend>
          {domains.map((d) => (
            <label className="check" key={d.id}>
              <input type="checkbox" name="reviewDomains" value={d.id} defaultChecked={chosen.includes(d.id)} />
              <span>{d.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

/** Close the form once a save goes through; only a new result closes it, so it can be opened again. */
function useCloseOnSuccess(state: typeof IDLE, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!state.error && state !== IDLE) setOpen(false);
  }, [state, setOpen]);
}

export function AddPerson({ domains }: { domains: readonly Domain[] }) {
  const [state, submit, pending] = useActionState(addPerson, IDLE);
  const [open, setOpen] = useState(false);
  useCloseOnSuccess(state, setOpen);
  if (!open) {
    return (
      <div>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setOpen(true)}>
          Add a person
        </button>
      </div>
    );
  }
  return (
    <form action={submit} className="stack raised" style={{ gap: 12 }} aria-label="Add a person">
      <div className="field">
        <label htmlFor="displayName">Name</label>
        <input id="displayName" name="displayName" required autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" required autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="title">Job title</label>
        <input id="title" name="title" autoComplete="off" />
      </div>
      <RoleFields roles={["requester"]} domains={domains} chosen={[]} />
      {state.error ? <p className="error">{state.error}</p> : null}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One person in the table; changing them opens the form in a row of its own beneath. */
export function PersonRow({
  person,
  domains,
  self,
  lastSignIn,
}: {
  person: PersonRecord;
  domains: readonly Domain[];
  self: boolean;
  lastSignIn: string;
}) {
  const [state, submit, pending] = useActionState(updatePerson, IDLE);
  const [open, setOpen] = useState(false);
  useCloseOnSuccess(state, setOpen);
  const label = Object.fromEntries(domains.map((d) => [d.id, d.label]));
  return (
    <>
      <tr data-active={person.active}>
        <td>
          <span className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
            <ActorMark kind="human" name={person.displayName} size={28} />
            <span className="stack" style={{ gap: 0, minWidth: 0 }}>
              <strong>{person.displayName}</strong>
              <span className="caption muted" style={{ overflowWrap: "anywhere" }}>
                {person.email}
              </span>
            </span>
          </span>
        </td>
        <td>
          <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {person.active ? null : <Tag tone="bad">Switched off</Tag>}
            {person.roles.map((r) => (
              <Tag key={r}>{ROLE[r]?.label ?? r}</Tag>
            ))}
          </span>
          {person.reviewDomains.length > 0 ? (
            <span className="caption muted" style={{ display: "block", marginTop: 4 }}>
              Signs for {person.reviewDomains.map((d) => label[d] ?? d).join(", ")}
            </span>
          ) : null}
        </td>
        <td className="caption muted">{lastSignIn}</td>
        <td>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={`Change ${person.displayName}`}
          >
            Change
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="people-editor">
          <td colSpan={4}>
            <form action={submit} className="stack raised" style={{ gap: 12 }} aria-label={`Change ${person.displayName}`}>
              <input type="hidden" name="userId" value={person.userId} />
              <div className="people-editor-grid">
                <RoleFields roles={person.roles} domains={domains} chosen={person.reviewDomains} />
                {self ? (
                  <input type="hidden" name="active" value="true" />
                ) : (
                  <fieldset className="stack" style={{ gap: 0 }}>
                    <legend className="eyebrow">Access</legend>
                    <label className="check">
                      <input type="radio" name="active" value="true" defaultChecked={person.active} />
                      <span>Can sign in</span>
                    </label>
                    <label className="check">
                      <input type="radio" name="active" value="false" defaultChecked={!person.active} />
                      <span>Switched off · signed out at once</span>
                    </label>
                  </fieldset>
                )}
              </div>
              {state.error ? <p className="error">{state.error}</p> : null}
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Save"}
                </button>
                <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}
