import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEW_TEMPLATE, NEW_TEMPLATE_LABEL } from './templatePick';

// Moshe Henig, 2026-11-11: every list for picking a template offers "create a new template" right there.
const read = (f: string) => readFileSync(f, 'utf8');

describe('create a new template from any template picker', () => {
  it('has one shared option', () => {
    expect(NEW_TEMPLATE).toBe('__new_template__');
    expect(NEW_TEMPLATE_LABEL).toBe('+ Create a new template…');
  });

  it('is offered in every template list, after the existing choices', () => {
    const templates = read('src/pages/Templates.tsx');
    // New campaign ("Start from") and Change template.
    expect(templates).toMatch(/<option value="">Scratch<\/option>[^]*?\{isAdmin && <option value=\{NEW_TEMPLATE\}>\{NEW_TEMPLATE_LABEL\}<\/option>\}/);
    expect(templates).toMatch(/<option value="">Choose…<\/option>[^]*?<option value=\{NEW_TEMPLATE\}>\{NEW_TEMPLATE_LABEL\}<\/option>/);
    // New sub-campaign (admins only: only admins can make campaign templates).
    expect(read('src/pages/SubCampaigns.tsx')).toMatch(/\{isAdmin && <option value=\{NEW_TEMPLATE\}>\{NEW_TEMPLATE_LABEL\}<\/option>\}/);
    // Outreach "Start from a template".
    expect(read('src/pages/Outreach.tsx')).toMatch(/<option value=\{NEW_TEMPLATE\}>\{NEW_TEMPLATE_LABEL\}<\/option>/);
  });

  it('opens the template editor instead of picking the option, and picks the new template once saved', () => {
    const templates = read('src/pages/Templates.tsx');
    expect(templates).toContain('if (id === NEW_TEMPLATE) return setCreating(true);');
    expect(templates).toContain("e.target.value === NEW_TEMPLATE ? setCreating(true) : setPick(e.target.value)");
    expect(templates.match(/<TemplateDialog record=\{null\}[^]*?setCreating\(false\);\s*if \(!saved\) return;/g)?.length).toBe(2);
    expect(templates).toContain('setChosen(saved.id);');
    expect(templates).toContain('setPick(saved.id);');
    expect(templates).toContain(".insert(payload).select().single()");   // the editor hands back the saved template
    expect(read('src/pages/SubCampaigns.tsx')).toContain('setTemplate(saved.id);');
    const outreach = read('src/pages/Outreach.tsx');
    expect(outreach).toContain('e.target.value === NEW_TEMPLATE ? setCreatingTemplate(true) : applyTemplate(e.target.value)');
    expect(outreach).toContain('if (id) applyTemplate(id, (data ?? []) as Row[]);');
  });
});
