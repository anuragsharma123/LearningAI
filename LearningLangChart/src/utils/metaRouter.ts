import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { extractionModel } from "../model.js";

/**
 * RouterSchema defines every possible action the meta-router can classify a message into.
 * Zod enforces the exact enum values — the model cannot return anything outside this set.
 *
 * Optional fields (suggestedName, description, planName) are only populated for actions
 * that need them:
 *   - new_plan:    suggestedName (kebab-case slug) + description (human label)
 *   - switch_plan: planName (matches an existing plan name)
 *   - delete_plan: planName
 */
const RouterSchema = z.object({
    action: z.enum(["continue", "new_plan", "switch_plan", "list_plans", "delete_plan", "clear_all", "exit"]),
    suggestedName: z.string().optional(),
    description: z.string().optional(),
    planName: z.string().optional(),
});

export type RouterDecision = z.infer<typeof RouterSchema>;

/**
 * The meta-router system prompt. This is the "intelligence" of the router — the rules
 * that tell the model when to create a new plan vs. continue the current one.
 *
 * The critical rule: "Default to 'continue' when unsure."
 * This prevents false positives where a follow-up question ("what about cheaper hotels?")
 * is mistakenly classified as a new trip.
 */
const SYSTEM_PROMPT = `You are a travel planning session router. Given a user message, classify their intent into one of these actions:

- "continue": User is continuing or asking about the ACTIVE plan (follow-up questions, refinements, more details about current trip).
- "new_plan": User is describing a DIFFERENT trip (different destination or clearly different dates than the active plan). Set suggestedName as a kebab-case slug (e.g. "new-york-jul24") and description as a short human label (e.g. "New York, Jul 24–30").
- "switch_plan": User references one of the EXISTING plans by destination, name, or dates — and it's NOT the active one.
- "list_plans": User wants to see their saved plans ("what trips", "show plans", "list", etc.).
- "delete_plan": User wants to remove a specific plan. Set planName to the matching plan name.
- "clear_all": User wants to delete ALL plans and start fresh.
- "exit": User wants to quit ("exit", "quit", "bye", "done").

When there is NO active plan, any trip description is always "new_plan".
When there is an active plan, only classify as "new_plan" if the destination or dates are clearly different.
Default to "continue" when unsure.`;

/**
 * `withStructuredOutput(RouterSchema)` compiles the Zod schema into an Anthropic tool call,
 * forcing the model to respond with valid JSON matching RouterSchema every time.
 * The `as any` cast bridges a minor type mismatch between LangChain's internal types —
 * the runtime behaviour is correct.
 */
const routerModel = (extractionModel as any).withStructuredOutput(RouterSchema);

/**
 * classifyIntent — the meta-router: classifies a user message into one of 7 actions.
 *
 * This is the "meta" layer that sits ABOVE the travel agent. Before every user message
 * reaches the LangGraph agent, this function intercepts it and decides:
 *   - Does this start a new plan? (new_plan)
 *   - Does this refer to an existing plan? (switch_plan)
 *   - Is it a management command? (list, delete, clear, exit)
 *   - Or should it just flow into the active agent? (continue)
 *
 * Context is injected explicitly — the model is told the active plan name/description
 * AND all other saved plan names/descriptions. This lets it match "the Alaska trip" to
 * the actual plan key "alaska-jul15-20" even though the user never said the exact name.
 *
 * @param userMessage  The raw text the user just typed
 * @param activePlan   The currently active plan, or null if none
 * @param allPlans     All saved plans (for switch/delete matching)
 */
export async function classifyIntent(
    userMessage: string,
    activePlan: { name: string; description: string } | null,
    allPlans: Array<{ name: string; description: string }>
): Promise<RouterDecision> {
    // Build a compact context string that fits in a short prompt.
    // The model uses this to resolve references like "the Alaska trip" → plan name.
    const context = [
        activePlan
            ? `Active plan: "${activePlan.name}" — ${activePlan.description}`
            : "Active plan: none",
        allPlans.length > 0
            ? `All plans:\n${allPlans.map(p => `  - "${p.name}": ${p.description}`).join("\n")}`
            : "All plans: none saved yet",
        `User message: "${userMessage}"`,
    ].join("\n");

    const result = await routerModel.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(context),
    ]);

    return result as RouterDecision;
}
