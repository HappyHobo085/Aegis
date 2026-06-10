// If fetched/executed, ad B was NOT blocked. The swap test asserts this stays false
// after the refreshed engine (which blocks /ads/tracker.js) takes effect.
window.__trackerLoaded = true;
