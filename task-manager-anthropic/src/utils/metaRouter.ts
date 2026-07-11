import { anthropic, FAST_MODEL } from "../client.js";
import { routerTool } from "../tools/definitions.js";

/**
 * RouterDecision — the classification returned for every user message.
 *
 * In LangGraph this was `z.infer<typeof RouterSchema>` — the type was derived
 * from a Zod schema. Here we define it directly as a TypeScript type since
 * we're not using Zod anywhere in this project.
 *
 * Only new_plan populates suggestedName + description.
 * Only switch_plan and delete_plan populate planName.
 */
export type RouterDecision = {
    action: "continue" | "new_plan" | "switch_plan" | "list_plans" | "delete_plan" | "clear_all" | "exit";
    suggestedName?: string;
    description?: string;
    planName?: string;
};

/**
 * The meta-router system prompt — same rules as LearningLangChart.
 * The critical rule is "Default to continue when unsure" — this prevents a
 * follow-up like "what about cheaper hotels?" from being misclassified as new_plan.
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
 * classifyIntent — classifies a user message into one of 7 session management actions.
 *
 * LangGraph equivalent: `routerModel.invoke(messages)` where routerModel was
 * `extractionModel.withStructuredOutput(RouterSchema)`.
 *
 * The conversion:
 *   - LangGraph: Zod schema → auto-compiled to Anthropic tool → withStructuredOutput forced the call.
 *   - SDK:       routerTool (manual JSON Schema) + `tool_choice: { type: "tool", name: "classify_intent" }`.
 *
 * Context is injected explicitly — the model is told the active plan name and all saved
 * plans so it can resolve references like "the Alaska trip" → plan name "alaska-jul15-20"
 * even when the user didn't say the exact name.
 *
 * Falls back to `{ action: "continue" }` if the model somehow doesn't call the tool —
 * safe default because it lets the message flow into the active agent.
 *
 * @param userMessage  The raw text the user just typed.
 * @param activePlan   The currently active plan, or null if none selected.
 * @param allPlans     All saved plans — used for switch/delete name matching.
 */
export async function classifyIntent(
    userMessage: string,
    activePlan: { name: string; description: string } | null,
    allPlans: Array<{ name: string; description: string }>
): Promise<RouterDecision> {
    // Build a compact context string the model uses to resolve plan references.
    const context = [
        activePlan
            ? `Active plan: "${activePlan.name}" — ${activePlan.description}`
            : "Active plan: none",
        allPlans.length > 0
            ? `All plans:\n${allPlans.map(p => `  - "${p.name}": ${p.description}`).join("\n")}`
            : "All plans: none saved yet",
        `User message: "${userMessage}"`,
    ].join("\n");

    const response = await anthropic.messages.create({
        model: FAST_MODEL,   // routing is pure classification — Haiku is sufficient and cheaper
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        tools: [routerTool],
        // Forced tool call — model must return classify_intent, cannot reply with text.
        // Replaces: extractionModel.withStructuredOutput(RouterSchema)
        tool_choice: { type: "tool", name: "classify_intent" },
        messages: [{ role: "user", content: context }],
    });

    const toolUse = response.content.find(b => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
        return { action: "continue" };
    }

    return toolUse.input as RouterDecision;
}
