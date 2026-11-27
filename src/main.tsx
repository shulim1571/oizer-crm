import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { warmIfields } from './lib/ifields';
import { giveCampaignId } from './lib/publicRoute';
import App from './App';
import GivePage from './pages/Give';
import './fundbase-tokens.css';   // the FundBase kit's --fb- tokens (data/brand-fundbase/tokens.css)
import './trubase-tokens.css';   // the shared Trubase UI design system's tokens (2026-11-27); the app's styles follow them
import './styles.css';

// A public payment page is shown without the sign-in machinery (Shulim, 2026-11-22): donors aren't signed in, so it
// skipped nothing but cost an extra organization lookup and two security checks that could only fail. Sola's card
// fields start loading right away, alongside the page's own data.
if (giveCampaignId) warmIfields();

// HashRouter works on any static host (GitHub Pages, Netlify, S3) without rewrite rules.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      {giveCampaignId
        ? <GivePage campaignId={giveCampaignId} />
        : <AuthProvider><App /></AuthProvider>}
    </HashRouter>
  </StrictMode>,
);
