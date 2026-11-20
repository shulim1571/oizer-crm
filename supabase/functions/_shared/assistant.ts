// The help assistant's prompt and request shaping, shared by the assistant function and its tests.
// Version 1 answers how-to questions from the app's guide only: no records reach the model.
import { ASSISTANT_GUIDE } from './assistantGuide.ts';

export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export type AssistantModel = typeof MODELS[number];

export const SYSTEM_PROMPT = `You are the help assistant inside Oizer, a campaign CRM used by a charity's office staff and fundraisers.
Answer how-to questions about using Oizer and its settings, using only the guide below. Give the menu path and the
buttons to press, in short steps. If the guide doesn't cover something, say you don't know and suggest asking an
admin; don't invent screens, settings or features. You can't see or change any records (donors, donations, bank
lines, payouts) and you have no access to the person's data: if asked about specific records or amounts, explain
where in Oizer they can look it up themselves. Keep answers brief and plain; no long introductions.
Formatting: only **bold** for button and menu names, numbered steps, and short bulleted lists. No headings, tables,
links or HTML.

<guide>
${ASSISTANT_GUIDE}
</guide>`;

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export const LIMITS = { turns: 8, questionChars: 1000, turnChars: 4000 };

/** The conversation as the model sees it: the last few turns, trimmed, starting with the person, and the screen they're on. */
export function shapeMessages(turns: unknown, page: unknown): { messages: ChatTurn[] } | { error: string } {
  if (!Array.isArray(turns) || turns.length === 0) return { error: 'Ask a question first.' };
  const clean: ChatTurn[] = turns
    .filter((t): t is ChatTurn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() !== '')
    .map(t => ({ role: t.role, content: t.content.trim().slice(0, LIMITS.turnChars) }))
    .slice(-LIMITS.turns);
  while (clean.length && clean[0].role !== 'user') clean.shift();
  const last = clean[clean.length - 1];
  if (!last || last.role !== 'user') return { error: 'Ask a question first.' };
  if (last.content.length > LIMITS.questionChars) return { error: `Keep the question under ${LIMITS.questionChars} characters.` };
  const screen = typeof page === 'string' ? page.replace(/[^\w/ :-]/g, '').slice(0, 80) : '';
  if (screen) last.content = `(I'm on the screen ${screen})\n${last.content}`;
  return { messages: clean };
}

/** Request settings per model, kept cheap: low effort, and no thinking where the model allows turning it off. */
export function modelOptions(model: string) {
  if (model === 'claude-haiku-5-5') return { thinking: { type: 'disabled' as const }, output_config: { effort: 'low' as const } };
  return { output_config: { effort: 'low' as const } };
}

/** A path with ids taken out, so only the kind of screen is sent: /campaigns/1001/batch -> /campaigns/:id/batch. */
export function screenOf(path: string): string {
  return path.split('?')[0].split('/').map(s => (/\d/.test(s) && s.length > 0 ? ':id' : s)).join('/').slice(0, 80);
}
