const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");

Sentry.init({
  dsn: "https://e1fadb57073e187fad7b887ef89e0330@o4511386353139712.ingest.us.sentry.io/4511386371031040",
  integrations: [nodeProfilingIntegration()],
  enableLogs: true,
  tracesSampleRate: 0.1,
  profileSessionSampleRate: 0.1,
  profileLifecycle: "trace",
  sendDefaultPii: false,
});