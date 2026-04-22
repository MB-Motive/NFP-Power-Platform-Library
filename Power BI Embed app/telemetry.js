/**
 * telemetry.js
 * Azure Application Insights initialisation.
 * Imported at the very top of server.js before any other requires.
 *
 * Set APPLICATIONINSIGHTS_CONNECTION_STRING in Azure App Service
 * Application Settings. If not set, telemetry is silently disabled
 * so local development is unaffected.
 */
let client = null;

function init() {
  const connStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connStr) {
    console.log('Application Insights: not configured (APPLICATIONINSIGHTS_CONNECTION_STRING not set)');
    return;
  }
  try {
    const appInsights = require('applicationinsights');
    appInsights
      .setup(connStr)
      .setAutoDependencyCorrelation(true)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(true, true)
      .setSendLiveMetrics(false)
      .start();
    client = appInsights.defaultClient;
    console.log('Application Insights: connected');
  } catch (err) {
    console.error('Application Insights: failed to initialise', err.message);
  }
}

/**
 * Track a custom event (report views, login events, etc.)
 * Safe to call whether or not AI is configured.
 */
function trackEvent(name, properties) {
  if (!client) return;
  try {
    client.trackEvent({ name, properties });
  } catch (_) {}
}

/**
 * Track an exception explicitly (caught errors that aren't thrown).
 */
function trackException(err, properties) {
  if (!client) return;
  try {
    client.trackException({ exception: err, properties });
  } catch (_) {}
}

module.exports = { init, trackEvent, trackException };
