import { useEffect, useRef } from 'react';
import { Bold, Italic, Link2, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, RemoveFormatting, Underline } from 'lucide-react';
import { FONTS, isRichText, sanitizeHtml, textToHtml } from '../lib/richText';

// Formatted text for the campaign description (Moshe Henig, 2026-11-11): font, size, bold, italic, underline, lists,
// alignment and links. What's typed is cleaned (sanitizeHtml) before it leaves here.
const SIZE_OPTIONS: [string, string][] = [['2', 'Small'], ['3', 'Normal'], ['4', 'Large'], ['5', 'Larger'], ['6', 'Largest']];

export default function RichTextEditor({ value, onChange, label }: { value: string; onChange: (html: string) => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<string>('');
  // Load the saved description once (and when another one is loaded), not on every keystroke.
  useEffect(() => {
    if (!box.current || value === last.current) return;
    const html = isRichText(value) ? sanitizeHtml(value) : textToHtml(value ?? '');
    box.current.innerHTML = html;
    last.current = value;
  }, [value]);
  const emit = () => {
    if (!box.current) return;
    const html = box.current.textContent?.trim() || box.current.querySelector('li,br') ? sanitizeHtml(box.current.innerHTML) : '';
    last.current = html;
    onChange(html);
  };
  const run = (command: string, arg?: string) => {
    box.current?.focus();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false, arg);
    emit();
  };
  const tool = (title: string, icon: React.ReactNode, command: string, arg?: string) => (
    <button type="button" className="icon-btn" title={title} aria-label={title} onMouseDown={e => { e.preventDefault(); run(command, arg); }}>{icon}</button>
  );
  return (
    <div className="rte">
      <div className="rte-bar" role="toolbar" aria-label={`${label} formatting`}>
        <select aria-label="Font" defaultValue="" onChange={e => { if (e.target.value) run('fontName', e.target.value); e.target.value = ''; }}>
          <option value="">Font</option>
          {FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
        <select aria-label="Size" defaultValue="" onChange={e => { if (e.target.value) run('fontSize', e.target.value); e.target.value = ''; }}>
          <option value="">Size</option>
          {SIZE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {tool('Bold', <Bold size={15} />, 'bold')}
        {tool('Italic', <Italic size={15} />, 'italic')}
        {tool('Underline', <Underline size={15} />, 'underline')}
        {tool('Bulleted list', <List size={15} />, 'insertUnorderedList')}
        {tool('Numbered list', <ListOrdered size={15} />, 'insertOrderedList')}
        {tool('Align left', <AlignLeft size={15} />, 'justifyLeft')}
        {tool('Center', <AlignCenter size={15} />, 'justifyCenter')}
        {tool('Align right', <AlignRight size={15} />, 'justifyRight')}
        <button type="button" className="icon-btn" title="Link" aria-label="Link" onMouseDown={e => {
          e.preventDefault();
          const url = prompt('Link address (starting with https://):', 'https://');
          if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) run('createLink', url.trim());
        }}><Link2 size={15} /></button>
        {tool('Clear formatting', <RemoveFormatting size={15} />, 'removeFormat')}
      </div>
      <div ref={box} className="rte-area give-story rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label}
        dir="auto" onInput={emit} onBlur={emit} />
    </div>
  );
}
