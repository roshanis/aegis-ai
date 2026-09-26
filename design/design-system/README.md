# Aegis

Aegis is multi-tenant AI governance: people register AI systems, deterministic policy packs triage their risk, reviewers sign off by domain, an approver decides, and a hash-chained audit log records it all. This system is how its screens look and speak.

The one rule behind every screen: **agents draft, people decide.** At any moment a person should be able to tell who acted, under which policy, and why.

## Content fundamentals

- **Plain words for what people do.** Say *sign*, *approve*, *reject*, *review*, *audit log*. Don't invent terms ("seal", "ledger", "thread").
- **Every automated result gives its reason.** A tier, route or verdict shows the rule ID and one sentence: "High, because it can shape care or coverage with a person reviewing each output."
- **Agent output is labelled as a draft.** Use "Draft by privacy-agent" and "Draft only · cannot approve". Never "AI decided" or "recommended by AI".
- **Buttons say exactly what happens.** "Sign with 2 conditions", "Request changes", "Export evidence pack".
- **Short sentences, active voice.** No em-dash asides, no slogans, no "not X but Y".
- **Policy versions and IDs are written exactly**: `healthcare-ai@1.0.0`, `CASE-0142`, `#7c1e`.

## Visual foundations

**Themes.** Dark is the primary theme and light matches it token for token. Screens default to the viewer's system setting. Use tokens, never raw hex.

**Who acted (actor marks).** Shape and colour together, so they read in greyscale:

| Actor | Mark | Tokens |
| --- | --- | --- |
| Person | Filled circle with initials | `seal` fill, `ink-on-seal` text, `seal-edge` edge |
| System job | Filled square, 4px radius | `actor-system` |
| AI agent | Dashed ring; drafts sit in a dashed frame | `actor-agent`, `agent-tint`, `agent-text` |
| Pending person | Ring with a soft glow | `seal-ring` |

A new kind of actor (an MCP tool, an external auditor) gets one new mark. Screens don't change.

**Risk tiers.** Always the tier name in text, coloured `tier-low`…`tier-critical`, plus the rule that set it. The risk dial uses `dial-low`…`dial-critical` with unlit segments in `dial-off`. Tier colours differ in lightness as well as hue.

**Surfaces.** `surface-page` behind everything, `surface-panel` for cards and rails, `surface-raised` for inputs and tracks. Separate with `line` hairlines; borders only on controls (`border-control`). No shadows, no gradients.

**Accent.** The lime `seal` is reserved for people's authority: their marks, the primary action (`action`) and links in dark mode. Don't use it for decoration.

**Layout.** A 60px top bar holds the logo, tenant, deployment badge, a ⌘K search and the signed-in person. An 84px icon rail sits on the left. Main content has `space-6` padding. Panels use `radius-lg` or `radius-xl`, and every control is at least `target` (44px) high.

## Type

- **Instrument Serif** (`display`) for page headings, decisions and "because" reasons. Use the italic for the one emphasised phrase in a heading, coloured `link`.
- **Geist** (`sans`) for everything you operate: forms, tables and buttons.
- **Geist Mono** (`mono`) for IDs, hashes, policy versions, rule IDs and uppercase eyebrows (letter-spacing 0.08em).

All three are hosted on Google Fonts: `family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1`.

## Iconography

Outline icons at 20px, 1.7px stroke, `currentColor`, round caps and joins. The shield logo uses a 1.9px stroke in `brand-mark`. The agent icon is a dashed circle. No emoji and no filled pictograms.

## Accessibility

- Text is 4.5:1 or better on every surface in both themes. Controls, focus rings and dial segments are 3:1 or better.
- Keyboard focus is a 3px `focus` outline.
- Don't fade text with opacity. Show a dismissed item with a strikethrough instead.
- Colour is never the only signal: tiers carry their name, and actors carry their shape.

## Components

- **ActorMark** shows who acted.
- **RiskDial** shows the tier with its reason.
- **AgentDraft** frames an agent's output as a draft.
- **Button** has primary, secondary and segmented forms.
