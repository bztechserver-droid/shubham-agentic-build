// "Goals on mobile: use the API". On a phone the overlay Assistant adds, changes and lists CRM goals with the app's own tools
// (crm_goals, crm_goal_add, crm_goal_update), never by moving the CRM's Goals page: watching a whole page move on a small
// screen is pointless. The agent refuses what it can tell from the call (agent/agentic/goals-on-phone.ts) and the page refuses
// the rest while its CRM is on the Goals page (src/overlay/driver.ts); both give this answer. The PC keeps the old way.

export const GOALS_ON_PHONE_WHY =
  'This screen is a phone, and on a phone the CRM Goals page is not driven (setting "Goals on mobile: use the API"). Nothing was opened or changed. Use crm_goal_add to add a goal, crm_goal_update to change one and crm_goals to list them.'

/** The CRM route (no leading slash; its own aliases included) of the Goals page: "goals", "goals/123", "tasks", "goals-2". */
export const isGoalsRoute = (route: string): boolean => /^(goals|goals-2|tasks)(\/|\?|$)/i.test(route.replace(/^\/+/, '').trim())

export interface AssistantSettings {
  /** On (the default): the phone's Assistant uses the goal tools and may not drive the CRM Goals page. Off: it may, as before. */
  goalsOnMobile: boolean
}
export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = { goalsOnMobile: true }
