// Teams and sub-campaigns are separate things (Moshe Henig, 2026-11-11). A team raises into the parent's balance
// (balance_mode 'shared'); a sub-campaign has its own balance and payouts ('independent'). Both get the parent's ID
// plus the next letter (1001A, 1001B...), given by the database.
export type ChildKind = 'team' | 'sub';
export const KIND = {
  team: { mode: 'shared', one: 'Team', many: 'Teams', help: 'A team raises into the parent’s balance. It only tracks what it raised, and has no payouts of its own.' },
  sub: { mode: 'independent', one: 'Sub-campaign', many: 'Sub-campaigns', help: 'A sub-campaign has its own balance and payouts, like a separate campaign. It just displays under the parent.' },
} as const;
export const kindOf = (mode: string): ChildKind => (mode === 'shared' ? 'team' : 'sub');
export const modeLabel = (mode: string) => KIND[kindOf(mode)].one;
