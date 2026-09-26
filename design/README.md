# Design

UI/UX work for Aegis, kept next to the code so it can be reviewed and versioned.

The live, editable versions are Claude artifacts:

- Design system: https://claude.ai/artifact/VEHgC5bWZyfbcxPNUfc1dx
- Screens canvas: https://claude.ai/artifact/HX2KRgJSKpSsMHkaVpf9Zn

Both are private until shared from their Share menu. The files here are a snapshot
of those artifacts; the artifacts are the source of truth until the screens are
built into the app.

## design-system/

The Aegis design system.

- `tokens.json`: colours (dark and light), type, spacing and radii. Every colour
  carries a usage note. Text pairs meet WCAG AA 4.5:1 and controls 3:1 in both
  themes.
- `README.md`: the brand book: writing rules, actor marks, risk tiers, surfaces,
  type, icons and accessibility.
- `components/`: guidelines and HTML previews for ActorMark, RiskDial,
  AgentDraft and Button, plus the cover. The previews expect the CSS variables
  compiled from `tokens.json` (`--surface-page`, `--ink`, `--font-sans`, and so
  on) and are not standalone pages.

## screens/

Artboards from the screens canvas, in the Design canvas `.dc.html` format. Each
holds one screen's markup and a small logic class; they are not standalone HTML
pages and need the canvas runtime to render.

Two sets, laid out by `canvas.json`:

- Three directions: `Table` (each review is a seat), `Docket` (a daily
  governance digest), `Sentence` (intake as one sentence).
- Previous (v2): `Language` (design language), `Main` (intake with live
  triage), `Review` (agent draft and sign-off), `Audit` (audit log), `Registry`.

Every screen follows the rule in `docs/PLAN.md`: agents draft, people decide.
Triage on the intake screens runs the `healthcare-ai` pack's rules from
`packages/frameworks` as written, so the example tiers and review domains match
what the domain code would return. People, cases and vendor findings on the
screens are made-up examples.
