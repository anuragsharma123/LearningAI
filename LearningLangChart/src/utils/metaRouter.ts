import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { extractionModel } from "../model.js";

const RouterSchema = z.object({
    action: z.enum(["continue", "new_plan", "switch_plan", "list_plans", "delete_plan", "clear_all", "exit"]),
    suggestedName: z.string().optional(),
    description: z.string().optional(),
    planName: z.string().optional(),
});

export type RouterDecision = z.infer<typeof RouterSchema>;

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

const routerModel = (extractionModel as any).withStructuredOutput(RouterSchema);

export async function classifyIntent(
    userMessage: string,
    activePlan: { name: string; description: string } | null,
    allPlans: Array<{ name: string; description: string }>
): Promise<RouterDecision> {
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
