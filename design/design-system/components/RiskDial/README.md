# RiskDial

RiskDial shows a system's risk tier as a four-segment half dial, with the tier name, the rule that set it and a one-sentence reason.

## Anatomy

- **Dial**: four 16px arcs from `dial-low` to `dial-critical`. Segments up to and including the current tier are lit; the rest use `dial-off`.
- **Tier name**: in `display` at 54px, coloured with the matching `tier-*` token.
- **Rule**: in `mono` caps, for example `RISK TIER · RULE CARE-WITH-HUMAN`.
- **Reason**: in `display` italic at 20px, starting with "because it…".

## Rules

- Never show the dial without the tier name in text.
- The reason comes from the policy pack's rule, word for word. It is never written by an agent.
- Use it on intake and case headers. In tables, show the tier as coloured `mono` text instead.
