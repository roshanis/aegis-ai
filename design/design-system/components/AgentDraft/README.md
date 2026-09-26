# AgentDraft

AgentDraft frames anything an AI agent wrote so no one mistakes it for a decision.

## Anatomy

- **Frame**: a 2px dashed `actor-agent` border with `radius-lg` corners on `surface-panel`.
- **Header**: an `agent-tint` band holding the agent ActorMark, "Draft by <agent>", a `mono` tag "DRAFT ONLY · CANNOT APPROVE" in `agent-text`, and on the right its coverage and eval status.
- **Body**: the draft itself. Each finding sits in a `surface-raised` row with a severity tag and Keep / Dismiss controls.

## Rules

- Every agent output uses this frame, including short suggestions.
- Show dismissed findings with a strikethrough, never faded with opacity.
- The frame never contains approve or sign buttons. Those sit outside it, with the person.
- Show whether the agent passed its evaluation gate. If it hasn't, don't show the draft.
