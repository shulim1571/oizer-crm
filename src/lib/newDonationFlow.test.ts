import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('New Donation (Moshe Henig, 2026-11-11)', () => {
  // Moshe Henig, #54 (2026-11-15): from the top New Donation button it goes to Transactions; started from a campaign
  // page, the campaign is filled in and it goes back to that campaign. Either one says what was saved.
  it('goes to Transactions after recording, or back to the campaign it was started from, saying what was saved', () => {
    const d = src('pages', 'Donations.tsx');
    expect(d).toContain("const fromCampaign = new URLSearchParams(useLocation().search).get('campaign');");
    expect(d).toContain("nav(fromCampaign ? `/campaigns/${encodeURIComponent(fromCampaign)}` : '/donations/all', { state: { notice } });");
    expect(d).toContain('...(fromCampaign ? { campaign_id: fromCampaign } : {})');
    expect(d).toContain('useState<string | null>(arrived)');
    const c = src('pages', 'CampaignDetail.tsx');
    expect(c).toContain('? nav(`/donations/new?campaign=${encodeURIComponent(id)}`)');
    expect(c).toContain('{arrivedNotice && <div className="notice">{arrivedNotice}</div>}');
  });

  // Fundraisers have it too since Moshe Henig, 2026-11-12 (card payments; manual ones with the permission).
  it('has a button in the header bar on every page, just before the bell, for admins and fundraisers', () => {
    const l = src('components', 'Layout.tsx');
    const header = l.slice(l.indexOf('<header className="topbar">'), l.indexOf('</header>'));
    const button = header.indexOf("nav('/donations/new')");
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(header.indexOf('className="icon-btn outlined bell"'));
    expect(header).toContain("{canWork && <button className=\"btn primary small header-new-donation\"");
  });

  it("gives fundraisers their own page: a card payment only, through the server's fundraiser check", () => {
    const app = src('App.tsx');
    expect(app).toContain('element={isAdmin ? <NewDonation /> : <FundraiserNewDonation />}');
    const pay = src('pages', 'Payments.tsx');
    expect(pay).toContain("{ action: 'sale', as_fundraiser: true, campaign_id: campaign, amount: Number(amount), name, email, notes, zip, ...pay }");
    expect(pay).toContain('{!fundraiser && <MethodTabs');
    expect(pay).toContain("const canRepeat = !fundraiser &&");
    const fn = readFileSync(join(process.cwd(), 'supabase', 'functions', 'payments', 'index.ts'), 'utf8');
    expect(fn).toContain("b.method = 'card'; b.card_id = null; b.save_card = false; b.donor_id = null;");
    expect(fn).toContain("rpc('begin_fundraiser_card_sale'");
  });
});

describe('sidebar (Moshe Henig, 2026-11-11)', () => {
  it('leaves New Donation off the menu, while its page keeps its tabs', () => {
    const l = src('components', 'Layout.tsx');
    expect(l).toContain("{ to: '/donations/new', label: 'New Donation', icon: <PlusCircle size={I} />, admin: true, offMenu: true,");
    expect(l).toContain('section.items.filter(n => visible(n) && !n.offMenu)');
    // Page tabs and breadcrumbs still come from every visible entry, including off-menu ones.
    expect(l).toContain('MENU.flatMap(s => s.items.filter(visible)');
  });
});
