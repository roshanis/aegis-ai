import { financialCommunicationsPack } from "./financial-communications";
import { healthcareAiPack } from "./healthcare-ai";
import { healthcareAiGoldenSets } from "./healthcare-ai-golden";
import type { PolicyPack } from "./types";

export * from "./types";
export { financialCommunicationsPack, healthcareAiGoldenSets, healthcareAiPack };

export const BUILT_IN_PACKS: readonly PolicyPack[] = [healthcareAiPack, financialCommunicationsPack];

export function findPack(id: string): PolicyPack | undefined {
  return BUILT_IN_PACKS.find((pack) => pack.id === id);
}
