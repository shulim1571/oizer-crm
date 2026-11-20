import { supabase } from './supabase';

/**
 * Moves an alias's gifts to its method in batches (Shulim, 2026-11-19): one big move timed out on "Credit Card VISA"
 * (~8,000 gifts). Each batch is a few hundred gifts, well inside the time limit; fees stay as recorded. A job every
 * minute finishes the move if the page is closed partway, so stopping here never leaves anything half-done for good.
 */
export interface MoveProgress { moved: number; remaining: number; done: boolean }

export async function runAliasMove(aliasId: string, onProgress: (p: MoveProgress) => void, batch = 400): Promise<MoveProgress> {
  let last: MoveProgress = { moved: 0, remaining: 0, done: false };
  for (let i = 0; i < 10000; i++) {
    const { data, error } = await supabase.rpc('move_alias_gifts', { p_alias: aliasId, p_limit: batch });
    if (error) throw new Error(error.message);
    const r = ((data ?? []) as { total_moved: number; remaining: number; done: boolean }[])[0];
    last = { moved: Number(r?.total_moved ?? 0), remaining: Number(r?.remaining ?? 0), done: !!r?.done };
    onProgress(last);
    if (last.done) break;
  }
  return last;
}

/** "Moving gifts: 2,000 of 7,973 done" */
export const progressText = (p: MoveProgress) =>
  p.done ? `${p.moved.toLocaleString()} gift${p.moved === 1 ? '' : 's'} moved; fees kept as recorded.`
         : `Moving gifts: ${p.moved.toLocaleString()} of ${(p.moved + p.remaining).toLocaleString()} done…`;
