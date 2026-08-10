const crypto = require('node:crypto');
const path = require('node:path');

const {
  createAdminServer,
  hashAdminPassword,
} = require('./admin-server.cjs');

const DEMO_HOST = '127.0.0.1';
const DEFAULT_DEMO_PORT = 8788;

function createDemoDashboard() {
  return {
    summary: {
      broadcasters: 3,
      recipients: 18,
      events: 2,
      receipts: 24,
      pending: 1,
      inFlight: 0,
      accepted: 22,
      failed: 0,
      ambiguous: 1,
      bookkeepingPending: 1,
    },
    broadcasters: [
      {
        broadcasterId: 'demo-channel-a',
        stableStatus: 'live',
        lastObservedAt: '2035-01-15T08:12:10.000Z',
        lastUnknownAt: null,
        lastEventId: 'demo-event-a',
        lastSource: 'fictional-source-a',
        createdAt: '2035-01-15T07:00:00.000Z',
        updatedAt: '2035-01-15T08:12:10.000Z',
        activeSubscriptions: 12,
        currentlyEligibleRecipients: 12,
      },
      {
        broadcasterId: 'demo-channel-b',
        stableStatus: 'offline',
        lastObservedAt: '2035-01-15T08:11:40.000Z',
        lastUnknownAt: '2035-01-15T07:52:00.000Z',
        lastEventId: 'demo-event-b',
        lastSource: 'fictional-source-b',
        createdAt: '2035-01-15T07:00:00.000Z',
        updatedAt: '2035-01-15T08:11:40.000Z',
        activeSubscriptions: 7,
        currentlyEligibleRecipients: 6,
      },
      {
        broadcasterId: 'demo-channel-c',
        stableStatus: null,
        lastObservedAt: null,
        lastUnknownAt: '2035-01-15T08:10:20.000Z',
        lastEventId: null,
        createdAt: '2035-01-15T07:00:00.000Z',
        activeSubscriptions: 2,
        currentlyEligibleRecipients: 1,
      },
    ],
    events: [
      {
        eventId: 'demo-event-a',
        broadcasterId: 'demo-channel-a',
        status: 'live',
        source: 'fictional-source-a',
        occurredAt: '2035-01-15T08:12:10.000Z',
        denominator: 12,
        counts: {
          denominator: 12,
          pending: 0,
          inFlight: 0,
          accepted: 12,
          failed: 0,
          ambiguous: 0,
          bookkeepingPending: 0,
          accounted: 12,
          countConsistent: true,
          terminal: true,
        },
      },
      {
        eventId: 'demo-event-b',
        broadcasterId: 'demo-channel-b',
        status: 'live',
        source: 'fictional-source-b',
        occurredAt: '2035-01-15T07:40:00.000Z',
        denominator: 12,
        counts: {
          denominator: 12,
          pending: 1,
          inFlight: 0,
          accepted: 10,
          failed: 0,
          ambiguous: 1,
          bookkeepingPending: 1,
          accounted: 12,
          countConsistent: true,
          terminal: false,
        },
      },
    ],
  };
}

function randomDemoPassword() {
  return `demo-${crypto.randomBytes(18).toString('base64url')}`;
}

function createDemoServer({ staticDir, password, now } = {}) {
  const demoPassword = password === undefined ? randomDemoPassword() : String(password);
  const dashboard = createDemoDashboard();
  const server = createAdminServer({
    staticDir: staticDir || path.resolve(__dirname, '..', 'dist'),
    config: {
      adminPasswordHash: hashAdminPassword(demoPassword),
      sessionSecret: crypto.randomBytes(36).toString('base64url'),
      sessionTtlMs: 60 * 60 * 1000,
      secureCookies: false,
      trustProxy: false,
      ...(now ? { now } : {}),
    },
    loadDashboard: async () => structuredClone(dashboard),
  });
  Object.defineProperties(server, {
    demoPassword: { value: demoPassword, enumerable: false },
    demoDashboard: { value: structuredClone(dashboard), enumerable: false },
  });
  return server;
}

function demoPort(environment = process.env) {
  const value = Number(environment.DEMO_PORT || DEFAULT_DEMO_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('DEMO_PORT must be an integer between 1 and 65535');
  }
  return value;
}

if (require.main === module) {
  try {
    const server = createDemoServer({ password: process.env.DEMO_PASSWORD });
    const port = demoPort();
    server.listen(port, DEMO_HOST, () => {
      process.stdout.write(`Fictional interface preview: http://${DEMO_HOST}:${port}/admin\n`);
      process.stdout.write(`Temporary administrator password: ${server.demoPassword}\n`);
      process.stdout.write('The preview is loopback-only, keeps data in memory, and contacts no external service.\n');
    });
  } catch (error) {
    process.stderr.write(`${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createDemoDashboard,
  createDemoServer,
  demoPort,
};
