// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchSelect from './SearchSelect';

// Moshe Henig, 2026-11-15: the campaign box on the Donary Machines tab is a clear dropdown: an arrow, the whole list
// on click, still searchable, and a list that floats over the page so the table can't cut it off.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: { unmount(): void }[] = [];
const options = [{ value: '1010', label: 'Sample Alpha - 1010' }, { value: '1012', label: 'Sample Beta - 1012' }, { value: '1013', label: 'Sample Gamma - 1013' }];

function mount(props: Partial<Parameters<typeof SearchSelect>[0]> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onChange = vi.fn();
  const root = createRoot(host);
  act(() => root.render(<SearchSelect value="1012" options={options} onChange={onChange} dropdown floating {...props} />));
  mounted.push(root);
  return { host, onChange, root };
}
const items = () => [...document.querySelectorAll('.ss-list li')].map(li => li.textContent);

describe('SearchSelect as a dropdown', () => {
  afterEach(() => { act(() => { while (mounted.length) mounted.pop()!.unmount(); }); document.body.innerHTML = ''; });

  it('has an arrow that opens the whole list, even with a campaign already chosen', () => {
    const { host } = mount();
    const arrow = host.querySelector('.ss-arrow') as HTMLButtonElement;
    expect(arrow).toBeTruthy();
    act(() => { arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(items()).toEqual(['— none —', 'Sample Alpha - 1010', 'Sample Beta - 1012', 'Sample Gamma - 1013']);
    expect(document.querySelector('.ss-list')?.parentElement).toBe(document.body);   // floating: over the page
  });

  it('opens on a click in the box, still filters as you type, and picks a campaign', () => {
    const { host, onChange } = mount();
    const input = host.querySelector('input') as HTMLInputElement;
    act(() => { input.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(items().length).toBe(4);
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'gam');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(items()).toEqual(['— none —', 'Sample Gamma - 1013']);
    const gamma = [...document.querySelectorAll('.ss-list li')].find(li => li.textContent === 'Sample Gamma - 1013')!;
    act(() => { gamma.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('1013');
  });

  it('is used for the machine campaign picker', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/pages/Machines.tsx', 'utf8')).toContain("placeholder={busy === r.id ? 'Saving…' : 'Choose a campaign'} dropdown floating />");
  });
});
