// Lightweight Google Analytics (GA4) wrapper, configured to run **cookieless**
// so the app doesn't need a cookie/consent banner.
//
// Privacy / scope rules baked in here:
//   - Analytics is DISABLED on localhost and on any local dev host, so nothing
//     is reported while developing. It only activates on a real deployment.
//   - We only record coarse product-usage signals: which widgets are used and
//     what genomic coordinates are queried (e.g. "chr6:31972046-32055647").
//     That's data about the pangenome graph, not about the visitor — no name,
//     email, IP-derived location, or other personal data is attached to it.
//   - No cookies, no persistent client-side storage, no cross-site/ad
//     identifiers (see initAnalytics for the specific flags and why).

const GA_MEASUREMENT_ID = 'G-R0F0F8Q251';

let enabled = false;

/* eslint-disable @typescript-eslint/no-explicit-any */
function gtag(...args: any[]) {
	(window as any).dataLayer = (window as any).dataLayer || [];
	(window as any).dataLayer.push(args);
}

function isLocalHost(host: string): boolean {
	return (
		host === '' ||
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host.endsWith('.local')
	);
}

/** Injects the GA script and configures it, unless on localhost. */
export function initAnalytics(): void {
	if (typeof window === 'undefined') return;
	if (isLocalHost(window.location.hostname)) return; // never track in local dev

	const s = document.createElement('script');
	s.async = true;
	s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
	document.head.appendChild(s);

	gtag('js', new Date());

	// Declare Consent Mode defaults as fully denied *before* config. Combined
	// with client_storage: 'none' below, this puts GA4 into "cookieless
	// pings" mode: it measures pageviews/events with a fresh, non-persistent
	// client id per load instead of a stored one, and never writes a cookie.
	// No ad-related storage or signals are used either way.
	gtag('consent', 'default', {
		ad_storage: 'denied',
		ad_user_data: 'denied',
		ad_personalization: 'denied',
		analytics_storage: 'denied'
	});

	gtag('config', GA_MEASUREMENT_ID, {
		anonymize_ip: true,
		client_storage: 'none', // never read/write the _ga cookie or any device storage
		allow_google_signals: false, // no cross-device/remarketing (advertising) data
		allow_ad_personalization_signals: false
	});
	enabled = true;
}

/**
 * Record a product event (e.g. a locus query or a widget interaction). Safe to
 * call always — it's a no-op when analytics isn't enabled.
 */
export function trackEvent(name: string, params: Record<string, unknown> = {}): void {
	if (!enabled) return;
	gtag('event', name, params);
}
