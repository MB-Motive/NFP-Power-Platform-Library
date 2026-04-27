/**
 * branding.js – loaded by every page.
 * Fetches /api/branding and applies colours, text, logo, favicon, footer,
 * and browser title.
 *
 * Exposes window.__portalTagline so report.html can use it when setting
 * the per-report document.title.
 */
(async function applyBranding() {
  try {
    const res = await fetch('/api/branding');
    if (!res.ok) return;
    const b = await res.json();

    if (b.primary_colour) {
      document.documentElement.style.setProperty('--teal', b.primary_colour);
      document.documentElement.style.setProperty('--teal-dim', shiftColour(b.primary_colour, -15));
    }
    if (b.secondary_colour) {
      document.documentElement.style.setProperty('--navy', b.secondary_colour);
      document.documentElement.style.setProperty('--navy-mid', shiftColour(b.secondary_colour, 10));
      document.documentElement.style.setProperty('--navy-soft', shiftColour(b.secondary_colour, 20));
    }
    if (b.text_primary)   document.documentElement.style.setProperty('--text-primary', b.text_primary);
    if (b.text_secondary) document.documentElement.style.setProperty('--text-secondary', b.text_secondary);

    document.querySelectorAll('[data-brand]').forEach(el => {
      const key = el.dataset.brand;
      if (b[key]) el.textContent = b[key];
    });

    if (b.logo_url) {
      document.querySelectorAll('[data-brand-logo]').forEach(el => { el.src = b.logo_url; el.style.display = ''; });
      document.querySelectorAll('[data-brand-logo-mark]').forEach(el => { el.style.display = 'none'; });
    }

    // Favicon
    const faviconUrl = b.favicon_url || 'https://app.powerbi.com/images/PowerBI_Favicon.ico';
    const existingFav = document.querySelector('link[rel="icon"]');
    const favLink = existingFav || document.createElement('link');
    favLink.rel = 'icon'; favLink.href = faviconUrl;
    if (!existingFav) document.head.appendChild(favLink);

    // Footer
    const footerLeft = document.getElementById('footer-left');
    if (footerLeft) {
      if (b.footer_left) {
        footerLeft.textContent = b.footer_left;
      } else {
        footerLeft.innerHTML = 'Built for the <a href="https://github.com/MB-Motive/NFP-Power-Platform-Library" target="_blank">NFP Power Platform Library</a>';
      }
    }

    // Browser title — "{Org Name} – {Tagline}"
    // Store tagline globally so report.html can append the report name.
    const org     = b.org_name     || 'Your Organisation';
    const tagline = b.portal_tagline || 'Insights Portal';
    window.__portalTagline = tagline;
    window.__portalOrg     = org;

    // Only set document.title here on non-report pages.
    // report.html sets its own title once the report name is known.
    if (!document.querySelector('#embed-container')) {
      document.title = org + ' \u2013 ' + tagline;
    }

  } catch (_) {}
})();

function shiftColour(hex, amt) {
  const n = parseInt(hex.replace('#',''), 16);
  const clamp = v => Math.min(255, Math.max(0, v));
  const r = clamp((n >> 16) + amt);
  const g = clamp(((n >> 8) & 0xff) + amt);
  const bv = clamp((n & 0xff) + amt);
  return '#' + [r,g,bv].map(v => v.toString(16).padStart(2,'0')).join('');
}
