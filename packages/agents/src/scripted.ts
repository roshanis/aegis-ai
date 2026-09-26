import { Usage, type Model, type ModelRequest, type ModelResponse } from "@openai/agents-core";
import type { IntakeAnswer, IntakeSuggestion, ReviewDraft } from "@aegis/domain";
import type { DraftContext } from "./drafter";

/**
 * A deterministic stand-in for a language model, used by sandboxes,
 * development and tests. It runs through the same Agents SDK path as a
 * real model and its output passes the same checks, but it is keyword
 * rules and templates: there is no AI in it, and nothing leaves Aegis.
 */

type Rule = { readonly yes?: RegExp; readonly no?: RegExp };

// Negative evidence wins over positive: "no member data" is a no, not a yes.
const INTAKE_RULES: Readonly<Record<string, Rule>> = {
  phi: {
    no: /\b(no member data|never sees production data)\b/i,
    yes: /\b(clinical|claims?|medical|diagnos\w*|ehr|health records?|phi|member service calls|prior auth\w*|discharged members)\b/i,
  },
  memberFacing: {
    yes: /\b(member portal|members'? questions|to members|to the member|sent to members|mailed|chat assistant|marketing emails?)\b/i,
    no: /\b(internal|engineers|analysts|staff meetings|nurse reviewer|investigators|care managers|supervisors|examiner queue)\b/i,
  },
  careCoverageInfluence: {
    no: /\b(internal tools|staff meetings|sql|marketing|transcrib\w*)\b/i,
    yes: /\b(prior auth\w*|auto-payment|care[- ]management|care managers|coverage|eligib\w*|readmission)\b/i,
  },
  humanInLoop: {
    no: /\b(automatically|straight to the member|no one reviews|sample)\b/i,
    yes: /\b(reads every|reviews? every|approves every|before deciding|before any action|decide whom)\b/i,
  },
  vendorHosted: {
    no: /\b(in-house|our own servers|self-hosted)\b/i,
    yes: /\b(vendor'?s?|saas|hosted|azure openai|microsoft|third-party|api)\b/i,
  },
  individualImpact: {
    no: /\b(internal|staff meetings|engineers|analysts|marketing)\b/i,
    yes: /\b(claims|prior auth\w*|eligib\w*|appeal|readmission|benefits)\b/i,
  },
};

function suggestAnswers(questions: readonly { field: string }[], description: string): IntakeSuggestion[] {
  return questions.map(({ field }) => {
    const rule = INTAKE_RULES[field] ?? {};
    const no = rule.no && description.match(rule.no);
    const yes = rule.yes && description.match(rule.yes);
    const answer: IntakeAnswer = no ? "no" : yes ? "yes" : "unsure";
    const why = no
      ? `The description says "${no[0]}".`
      : yes
        ? `The description mentions "${yes[0]}".`
        : "The description does not say.";
    return { field, answer, why };
  });
}

const KIND: Record<string, string> = { ai_system: "AI system", agent: "agent", vendor_model: "vendor model", content_item: "member communication" };
/** "Lineage document" reads as "lineage document" mid-sentence; "DPIA and BAA" stays as it is. */
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);

function draft(context: DraftContext): ReviewDraft {
  const covered = context.controls.filter((c) => c.evidence.length > 0 || c.exception === "approved");
  const findings: ReviewDraft["findings"][number][] = [];
  const questions: string[] = [];
  const conditions: string[] = [];
  for (const control of context.controls) {
    if (control.evidence.length > 0) continue;
    if (control.exception === "approved") {
      findings.push({
        controlId: control.id,
        concern: "risk",
        text: `${control.name} rests on an approved exception rather than evidence; check it will be closed before it expires.`,
      });
    } else if (control.enforcement === "gate") {
      findings.push({
        controlId: control.id,
        concern: "missing_evidence",
        text: `${control.name}: no ${lowerFirst(control.requiredEvidence)} on file. This gate needs evidence or an approved exception before the review can be signed.`,
      });
      questions.push(`Can you attach the ${lowerFirst(control.requiredEvidence)} for ${control.id} ${control.name}?`);
    } else {
      findings.push({
        controlId: control.id,
        concern: "missing_evidence",
        text: `${control.name} (${lowerFirst(control.cadence)}): no ${lowerFirst(control.requiredEvidence)} on file yet.`,
      });
      conditions.push(`Provide the ${lowerFirst(control.requiredEvidence)} for ${control.id} ${control.name} (${lowerFirst(control.cadence)}).`);
    }
  }
  const summary = [
    `${context.domain.label} review of ${context.asset.name}, a ${context.tier}-tier ${KIND[context.asset.kind] ?? context.asset.kind}.`,
    `${covered.length} of ${context.controls.length} ${context.domain.label} controls have evidence or an approved exception on file.`,
    context.thread ? "The owner has answered the latest question on this review." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { summary, findings, questionsForOwner: questions, proposedConditions: conditions };
}

export class ScriptedModel implements Model {
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const last = typeof request.input === "string" ? request.input : request.input.at(-1);
    const content = typeof last === "object" && last !== null && "content" in last ? last.content : last;
    const text = typeof content === "string" ? content : "";
    const task = JSON.parse(text) as
      | { task: "intake"; questions: { field: string }[]; description: string }
      | { task: "draft-review"; context: DraftContext };
    const output =
      task.task === "intake" ? { answers: suggestAnswers(task.questions, task.description) } : draft(task.context);
    return {
      usage: new Usage({ requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(output) }],
        },
      ],
    };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error("the scripted model does not stream");
  }
}
