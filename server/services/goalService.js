// goalService now lives in `@carelane/core`. Re-exported here as bound functions
// so existing imports of `./goalService.js` (routes, other services, tests) keep working.
import { services } from './_core.js'

export const {
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  restoreGoal,
  addProgressNote,
  deleteProgressNote,
  buildGoalsSummary,
  GOAL_STATUSES
} = services.goal
