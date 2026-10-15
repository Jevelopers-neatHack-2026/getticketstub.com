// The three mode axes of a ticketstub.context/2, derived from server configuration. Pure (no app imports) so
// the unit tests run this exact code. Three questions, answered separately, never folded into one word:
//
//   environment   WHERE it runs                    development | preview | live
//   economicMode  whether REAL MONEY is at stake   none | sandbox | paid_test | live
//   evidenceMode  what KIND of record backs it     fixture | synthetic | live
//
// paid_test is real money spent while testing (a paid provider call from a development or preview deploy).
// It is an actual expense whatever the environment name or the evidence says. A config that cannot be
// mapped honestly throws ModeMappingError: the caller must refuse to issue, never guess.

export type Environment = "development" | "preview" | "live";
export type EconomicMode = "none" | "sandbox" | "paid_test" | "live";
export type EvidenceMode = "fixture" | "synthetic" | "live";

export const ENVIRONMENTS: readonly Environment[] = ["development", "preview", "live"];
export const ECONOMIC_MODES: readonly EconomicMode[] = ["none", "sandbox", "paid_test", "live"];
export const EVIDENCE_MODES: readonly EvidenceMode[] = ["fixture", "synthetic", "live"];

/** Keys that let this server call a paid provider. Present outside live mode, they mean testing spends real money. */
export const PAID_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TICKETSTUB_RESEARCH_OPENROUTER_API_KEY",
  "TICKETSTUB_AGENT_OPENROUTER_API_KEY",
  "TICKETSTUB_ART_OPENROUTER_API_KEY",
  "CREATIVE_ENGINE_OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
] as const;

export class ModeMappingError extends Error {}

type Env = Record<string, string | undefined>;

export interface Modes {
  environment: Environment;
  economicMode: EconomicMode;
  evidenceMode: EvidenceMode;
}

/** Whether an (environment, economicMode) pair is one a verifier may accept. Shared by the issuer and the verifiers. */
export function modesConsistent(environment: string, economicMode: string): boolean {
  if (environment === "live") return economicMode !== "paid_test"; // a paid test is spend from a non-live deploy
  return economicMode !== "live"; // live money from a development or preview deploy is not a mapping we vouch for
}

export function resolveEnvironment(env: Env): Environment {
  if (env.TICKETSTUB_RUNTIME_MODE === "live") return "live";
  return env.NODE_ENV === "production" ? "preview" : "development";
}

/**
 * `hasContextSecret` is whether CONTEXT_SECRET is a usable key: live evidence needs a real issuer key.
 * TICKETSTUB_BILLING_MODE may state the economic mode explicitly; it can say more, never less, than the keys show.
 */
export function resolveModes(env: Env, hasContextSecret: boolean): Modes {
  const environment = resolveEnvironment(env);
  const paidKeys = PAID_PROVIDER_KEYS.some((k) => (env[k] ?? "").trim() !== "");
  const stated = (env.TICKETSTUB_BILLING_MODE ?? "").trim().toLowerCase();
  let economicMode: EconomicMode;
  if (stated === "") {
    // No statement: live is live money; elsewhere it is a paid test only if a paid provider is configured.
    economicMode = environment === "live" ? "live" : paidKeys ? "paid_test" : "none";
  } else if ((ECONOMIC_MODES as readonly string[]).includes(stated)) {
    economicMode = stated as EconomicMode;
  } else {
    throw new ModeMappingError(`TICKETSTUB_BILLING_MODE "${stated}" is not one of ${ECONOMIC_MODES.join(", ")}`);
  }
  if (!modesConsistent(environment, economicMode)) throw new ModeMappingError(`economic mode ${economicMode} cannot be issued from a ${environment} deploy`);
  // A configured paid provider is real spend. A statement of none or sandbox cannot hide it.
  if (paidKeys && (economicMode === "none" || economicMode === "sandbox")) throw new ModeMappingError("a paid provider key is configured, so the economic mode cannot be none or sandbox");
  const evidenceMode: EvidenceMode = environment === "live" && hasContextSecret ? "live" : "synthetic";
  return { environment, economicMode, evidenceMode };
}
