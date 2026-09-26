# ActorMark

ActorMark shows who acted, using shape and colour together, so a reader can tell a person from a system job or an AI agent at a glance.

## Variants

- **person**: a filled `seal` circle with 1–2 initials in `ink-on-seal`, plus a 1px `seal-edge` edge. This is the only mark that can stand next to a decision.
- **system**: a filled `actor-system` square with a 4px radius. Use it for deterministic jobs such as triage and routing.
- **agent**: a 2px dashed `actor-agent` ring with nothing inside. Agents never get initials or a fill.
- **pending**: a 2px `seal-ring` ring with a 5px glow. It marks a person whose action is waiting.
- **future**: a 2px `border-control` ring for a step that hasn't started.

## Sizes

Use 22px in dense chains, 28px in history lists, 32px in the top bar and 84–120px on a decision or sign-off card.

## Rules

- Always pair a mark with the actor's name or role as text. The mark supports the name and never replaces it.
- A new kind of actor gets a new shape, never just a new colour.
