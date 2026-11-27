import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Moshe Henig, 2026-11-11: the check register's More did nothing; its menu was cut off by the list's scrolling box.
const menu = readFileSync('src/components/RowMenu.tsx', 'utf8');
describe('row menus', () => {
  it('are drawn over the page, next to their button, so a list can’t cut them off', () => {
    expect(menu).toContain('{open && createPortal(');
    expect(menu).toContain("setPlace({ position: 'fixed', top: Math.max(8, top), left, right: 'auto' });");
    expect(readFileSync('src/styles.css', 'utf8')).toContain('.menu-pop.row-menu-pop { z-index: 1000;');
  });
  it('follow their button on scroll instead of closing, and clicks inside never open the row', () => {
    expect(menu).toContain("window.addEventListener('scroll', follow, true);");
    expect(menu).toContain('role="menu" ref={pop} style={place} onClick={e => e.stopPropagation()}');
    expect(menu).toContain('!box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)');
  });
});
