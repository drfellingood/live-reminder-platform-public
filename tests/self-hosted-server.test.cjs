const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  configFromEnvironment,
  createSelfHostedServer,
  signObservation
} = require("../server/self-hosted-server.cjs")
const { hashAdminPassword } = require("../server/admin-server.cjs")

const PASSWORD = "correct horse battery staple"
const OBSERVATION_SECRET = "observation-secret-that-is-at-least-32-characters"
const OPERATOR_SECRET = "operator-secret-that-is-distinct-and-at-least-32-characters"
const NOW_MS = Date.parse("2035-01-15T12:00:00.000Z")
const NOW_ISO = new Date(NOW_MS).toISOString()

function testConfig(overrides = {}) {
  return {
    adminPasswordHash: hashAdminPassword(PASSWORD, "fixed-test-salt"),
    sessionSecret: "test-session-secret-that-is-long-enough-123456",
    observationSecret: OBSERVATION_SECRET,
    operatorSecret: OPERATOR_SECRET,
    secureCookies: false,
    now: () => NOW_MS,
    ...overrides
  }
}

async function startRuntime({ core, coreFactory, config, observationCommandFactory } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-reminder-self-hosted-"))
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>Self hosted</title>")
  const server = createSelfHostedServer({
    staticDir,
    core,
    coreFactory,
    config: config || testConfig(),
    observationCommandFactory
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

async function postBearerJson(baseUrl, pathname, body, secret = OPERATOR_SECRET) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  })
}

test("observations require a non-empty id and a valid time inside the server realtime window", async t => {
  const commands = []
  const runtime = await startRuntime({
    core: {
      read: async () => ({}),
      execute: async command => {
        commands.push(command)
        return { accepted: true }
      }
    }
  })
  t.after(runtime.close)

  const valid = {
    broadcasterId: "sample-alpha",
    status: "live",
    observationId: "observation-current",
    observedAt: NOW_ISO
  }
  const invalidBodies = [
    { ...valid, observationId: "" },
    { ...valid, observationId: undefined },
    { ...valid, observationId: "x".repeat(201) },
    { ...valid, broadcasterId: "__proto__" },
    { ...valid, observationId: "constructor" },
    { ...valid, status: "maybe" },
    { ...valid, observedAt: "not-a-date" },
    { ...valid, observedAt: new Date(NOW_MS - 5 * 60 * 1000 - 1).toISOString() },
    { ...valid, observedAt: new Date(NOW_MS + 5 * 60 * 1000 + 1).toISOString() }
  ]

  for (const body of invalidBodies) {
    const response = await postBearerJson(runtime.baseUrl, "/api/v1/observations", body, OBSERVATION_SECRET)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, error: "INVALID_OBSERVATION" })
  }
  assert.deepEqual(commands, [])
})

test("the observation realtime window can only be narrowed from its five-minute maximum", async t => {
  const commands = []
  const runtime = await startRuntime({
    config: testConfig({ observationTimeToleranceMs: 1_000 }),
    core: {
      read: async () => ({}),
      execute: async command => {
        commands.push(command)
        return {}
      }
    }
  })
  t.after(runtime.close)

  const response = await postBearerJson(runtime.baseUrl, "/api/v1/observations", {
    broadcasterId: "sample-alpha",
    status: "offline",
    observationId: "observation-too-old-for-narrow-window",
    observedAt: new Date(NOW_MS - 1_001).toISOString()
  }, OBSERVATION_SECRET)
  assert.equal(response.status, 400)
  assert.deepEqual(commands, [])

  assert.throws(() => createSelfHostedServer({
    core: { read() {}, execute() {} },
    config: testConfig({ observationTimeToleranceMs: 300_001 })
  }), /observationTimeToleranceMs/)
})

test("operator commands dispatch only the four allowlisted command shapes", async t => {
  const commands = []
  const runtime = await startRuntime({
    core: {
      read: async () => ({}),
      execute: async command => {
        commands.push(command)
        return { action: command.kind }
      }
    }
  })
  t.after(runtime.close)

  const allowed = [
    { kind: "register-recipient", recipientId: "person-1", credits: 2, enabled: true },
    { kind: "grant-credits", grantId: "grant-1", recipientId: "person-1", credits: 3 },
    { kind: "subscribe", broadcasterId: "sample-alpha", recipientId: "person-1", active: false },
    {
      kind: "resolve-delivery",
      eventId: "event-1",
      recipientId: "person-1",
      resolutionId: "resolution-1",
      outcome: "accepted",
      providerReference: "provider-1",
      code: "operator-confirmed"
    }
  ]
  for (const command of allowed) {
    const response = await postBearerJson(runtime.baseUrl, "/api/v1/operator/commands", command)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, data: { action: command.kind } })
  }

  for (const forbidden of [
    { kind: "deliver-pending", limit: 1000 },
    { kind: "observe", broadcasterId: "sample-alpha", status: "live" },
    { kind: "register-recipient", recipientId: "person-2", credits: 1, unsafeExtra: true },
    {
      kind: "resolve-delivery",
      eventId: "event-1",
      recipientId: "person-1",
      outcome: "failed",
      code: "operator-confirmed"
    },
    {
      kind: "resolve-delivery",
      resolutionId: "resolution-2",
      eventId: "event-1",
      recipientId: "person-1",
      outcome: "failed"
    }
  ]) {
    const response = await postBearerJson(runtime.baseUrl, "/api/v1/operator/commands", forbidden)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, error: "INVALID_COMMAND" })
  }
  assert.deepEqual(commands, allowed)
})

test("operator queries expose only event or recipient details and authenticate the exact raw body", async t => {
  const reads = []
  const runtime = await startRuntime({
    core: {
      execute: async () => ({}),
      read: async query => {
        reads.push(query)
        return query.kind === "event"
          ? { eventId: query.eventId, receipts: [{ recipientId: "person-1", deliveryStatus: "ambiguous" }] }
          : { recipientId: query.recipientId, availableCredits: 2 }
      }
    }
  })
  t.after(runtime.close)

  const timestamp = String(Math.floor(NOW_MS / 1000))
  const eventBody = JSON.stringify({ kind: "event", eventId: "event-1" })
  const eventHeaders = {
    "content-type": "application/json",
    "x-live-reminder-timestamp": timestamp,
    "x-live-reminder-signature": signObservation({ secret: OPERATOR_SECRET, timestamp, body: eventBody })
  }
  const eventResponse = await fetch(`${runtime.baseUrl}/api/v1/operator/queries`, {
    method: "POST",
    headers: eventHeaders,
    body: eventBody
  })
  assert.equal(eventResponse.status, 200)
  assert.deepEqual(await eventResponse.json(), {
    ok: true,
    data: { eventId: "event-1", receipts: [{ recipientId: "person-1", deliveryStatus: "ambiguous" }] }
  })

  const altered = await fetch(`${runtime.baseUrl}/api/v1/operator/queries`, {
    method: "POST",
    headers: eventHeaders,
    body: `${eventBody} `
  })
  assert.equal(altered.status, 401)

  const recipientResponse = await postBearerJson(runtime.baseUrl, "/api/v1/operator/queries", {
    kind: "recipient",
    recipientId: "person-1"
  })
  assert.equal(recipientResponse.status, 200)
  assert.deepEqual(await recipientResponse.json(), {
    ok: true,
    data: { recipientId: "person-1", availableCredits: 2 }
  })

  for (const invalid of [
    { kind: "dashboard" },
    { kind: "event", eventId: "event-1", includeSecrets: true }
  ]) {
    const response = await postBearerJson(runtime.baseUrl, "/api/v1/operator/queries", invalid)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, error: "INVALID_QUERY" })
  }
  assert.deepEqual(reads, [
    { kind: "event", eventId: "event-1" },
    { kind: "recipient", recipientId: "person-1" }
  ])
})

test("observation and operator credentials cannot be used across privilege levels", async t => {
  const commands = []
  const runtime = await startRuntime({
    core: {
      read: async () => ({}),
      execute: async command => {
        commands.push(command)
        return { accepted: true }
      }
    }
  })
  t.after(runtime.close)

  const operatorCommand = { kind: "register-recipient", recipientId: "person-1", credits: 1 }
  const lowPrivilegeAttempt = await postBearerJson(
    runtime.baseUrl,
    "/api/v1/operator/commands",
    operatorCommand,
    OBSERVATION_SECRET
  )
  assert.equal(lowPrivilegeAttempt.status, 401)

  const operatorAccepted = await postBearerJson(runtime.baseUrl, "/api/v1/operator/commands", operatorCommand)
  assert.equal(operatorAccepted.status, 200)

  const observation = {
    broadcasterId: "sample-alpha",
    status: "offline",
    observationId: "observation-privilege-test",
    observedAt: NOW_ISO
  }
  const elevatedAttempt = await postBearerJson(
    runtime.baseUrl,
    "/api/v1/observations",
    observation,
    OPERATOR_SECRET
  )
  assert.equal(elevatedAttempt.status, 401)

  const observationAccepted = await postBearerJson(
    runtime.baseUrl,
    "/api/v1/observations",
    observation,
    OBSERVATION_SECRET
  )
  assert.equal(observationAccepted.status, 202)
  assert.deepEqual(commands.map(command => command.kind), ["register-recipient", "observe"])
})

test("read-only mode blocks authenticated mutations while operator queries and admin reads remain available", async t => {
  const commands = []
  const reads = []
  const runtime = await startRuntime({
    config: testConfig({ readOnly: true }),
    core: {
      execute: async command => {
        commands.push(command)
        return {}
      },
      read: async query => {
        reads.push(query)
        if (query.kind === "dashboard") {
          return { summary: { broadcasters: 0 }, broadcasters: [], recipients: [], events: [] }
        }
        return { eventId: query.eventId, receipts: [] }
      }
    }
  })
  t.after(runtime.close)

  const observationResponse = await postBearerJson(runtime.baseUrl, "/api/v1/observations", {
    broadcasterId: "sample-alpha",
    status: "live",
    observationId: "observation-read-only",
    observedAt: NOW_ISO
  }, OBSERVATION_SECRET)
  assert.equal(observationResponse.status, 403)
  assert.deepEqual(await observationResponse.json(), { ok: false, error: "READ_ONLY" })

  const commandResponse = await postBearerJson(runtime.baseUrl, "/api/v1/operator/commands", {
    kind: "register-recipient",
    recipientId: "person-1",
    credits: 1
  })
  assert.equal(commandResponse.status, 403)
  assert.deepEqual(await commandResponse.json(), { ok: false, error: "READ_ONLY" })

  const queryResponse = await postBearerJson(runtime.baseUrl, "/api/v1/operator/queries", {
    kind: "event",
    eventId: "event-1"
  })
  assert.equal(queryResponse.status, 200)

  const login = await fetch(`${runtime.baseUrl}/api/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  })
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0]
  const dashboard = await fetch(`${runtime.baseUrl}/api/admin-dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  assert.deepEqual(commands, [])
  assert.deepEqual(reads, [{ kind: "event", eventId: "event-1" }, { kind: "dashboard" }])
})

test("self-hosted root redirects to admin and its dashboard omits per-recipient data", async t => {
  const runtime = await startRuntime({
    core: {
      execute: async () => ({}),
      read: async () => ({
        generatedAt: NOW_ISO,
        semantics: { accepted: "sender accepted" },
        summary: { broadcasters: 1, recipients: 1, events: 1, internalNote: "private-summary" },
        broadcasters: [{
          broadcasterId: "sample-alpha",
          stableStatus: "live",
          recipientIds: ["private-person"]
        }],
        recipients: [{ recipientId: "private-person", availableCredits: 8 }],
        events: [{
          eventId: "event-1",
          denominator: 1,
          receipts: [{ recipientId: "private-person" }]
        }]
      })
    }
  })
  t.after(runtime.close)

  const root = await fetch(`${runtime.baseUrl}/`, { redirect: "manual" })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get("location"), "/admin")
  assert.equal(await root.text(), "")

  const login = await fetch(`${runtime.baseUrl}/api/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  })
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0]
  const dashboard = await fetch(`${runtime.baseUrl}/api/admin-dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  const payload = await dashboard.json()
  assert.deepEqual(Object.keys(payload.data).sort(), ["broadcasters", "events", "summary"])
  assert.deepEqual(payload.data.summary, { broadcasters: 1, recipients: 1, events: 1 })
  assert.equal(JSON.stringify(payload).includes("private-person"), false)
  assert.equal(JSON.stringify(payload).includes("private-summary"), false)
})

test("self-hosted shell reads the dashboard and accepts bearer-authenticated observations through the core", async t => {
  const reads = []
  const commands = []
  const core = {
    async read(query) {
      reads.push(query)
      return { generatedAt: "2035-01-15T08:00:00.000Z", summary: { broadcasters: 0 } }
    },
    async execute(command) {
      commands.push(command)
      return { accepted: true, commandId: "command-1" }
    }
  }
  const runtime = await startRuntime({ core })
  t.after(runtime.close)

  const observation = await fetch(`${runtime.baseUrl}/api/v1/observations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OBSERVATION_SECRET}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      kind: "operator-controlled",
      broadcasterId: "sample-alpha",
      status: "live",
      observationId: "observation-1",
      observedAt: NOW_ISO,
      source: "http-test",
      evidence: { reason: "operator-confirmed" },
      ignored: "not part of the core contract"
    })
  })
  assert.equal(observation.status, 202)
  assert.deepEqual(await observation.json(), {
    ok: true,
    data: { accepted: true, commandId: "command-1" }
  })
  assert.deepEqual(commands, [{
    kind: "observe",
    broadcasterId: "sample-alpha",
    status: "live",
    observationId: "observation-1",
    observedAt: NOW_ISO,
    source: "http-test",
    evidence: { reason: "operator-confirmed" }
  }])

  const login = await fetch(`${runtime.baseUrl}/api/admin-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  })
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0]
  const dashboard = await fetch(`${runtime.baseUrl}/api/admin-dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  assert.equal((await dashboard.json()).data.summary.broadcasters, 0)
  assert.deepEqual(reads, [{ kind: "dashboard" }])
})

test("signed observations authenticate the exact raw JSON body and reject stale or altered requests", async t => {
  const commands = []
  const core = {
    read: async () => ({ ok: true, data: {} }),
    execute: async command => {
      commands.push(command)
      return { accepted: true }
    }
  }
  const runtime = await startRuntime({ core })
  t.after(runtime.close)

  const timestamp = String(Math.floor(NOW_MS / 1000))
  const body = JSON.stringify({
    broadcasterId: "sample-bravo",
    status: "offline",
    observationId: "signed-observation-1",
    observedAt: NOW_ISO
  })
  const signature = signObservation({ secret: OBSERVATION_SECRET, timestamp, body })
  const accepted = await fetch(`${runtime.baseUrl}/api/v1/observations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-live-reminder-timestamp": timestamp,
      "x-live-reminder-signature": signature
    },
    body
  })
  assert.equal(accepted.status, 202)

  const altered = await fetch(`${runtime.baseUrl}/api/v1/observations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-live-reminder-timestamp": timestamp,
      "x-live-reminder-signature": signature
    },
    body: `${body} `
  })
  assert.equal(altered.status, 401)

  const staleTimestamp = String(Math.floor((NOW_MS - 10 * 60 * 1000) / 1000))
  const staleBody = JSON.stringify({
    broadcasterId: "sample-charlie",
    status: "live",
    observationId: "signed-observation-2",
    observedAt: NOW_ISO
  })
  const stale = await fetch(`${runtime.baseUrl}/api/v1/observations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-live-reminder-timestamp": staleTimestamp,
      "x-live-reminder-signature": signObservation({
        secret: OBSERVATION_SECRET,
        timestamp: staleTimestamp,
        body: staleBody
      })
    },
    body: staleBody
  })
  assert.equal(stale.status, 401)
  assert.equal(commands.length, 1)
})

test("self-hosted shell fails closed without a valid core or control secrets", () => {
  assert.throws(() => createSelfHostedServer({ config: testConfig() }), /core|coreFactory/)
  assert.throws(() => createSelfHostedServer({
    core: { read() {}, execute() {} },
    config: testConfig({ observationSecret: "short" })
  }), /OBSERVATION_SECRET/)
  assert.throws(() => createSelfHostedServer({
    core: { read() {}, execute() {} },
    config: testConfig({ operatorSecret: "short" })
  }), /OPERATOR_SECRET/)
  assert.throws(() => createSelfHostedServer({
    core: { read() {}, execute() {} },
    config: testConfig({ operatorSecret: OBSERVATION_SECRET })
  }), /different/)
  assert.throws(() => createSelfHostedServer({
    core: { read() {}, execute() {} },
    config: testConfig({ sessionSecret: OBSERVATION_SECRET })
  }), /different/)
  assert.throws(() => createSelfHostedServer({
    core: { read() {}, execute() {} },
    config: testConfig({ sessionSecret: OPERATOR_SECRET })
  }), /different/)
  assert.throws(() => createSelfHostedServer({
    core: { read() {} },
    config: testConfig()
  }), /execute/)
})

test("coreFactory is resolved once and observation command creation is injectable", async t => {
  let factoryCalls = 0
  const commands = []
  const runtime = await startRuntime({
    coreFactory() {
      factoryCalls += 1
      return {
        read: async () => ({ ok: true, data: {} }),
        execute: async command => {
          commands.push(command)
          return { accepted: true }
        }
      }
    },
    observationCommandFactory(body) {
      return { kind: "observe", normalizedId: String(body.broadcasterId).trim().toLowerCase() }
    }
  })
  t.after(runtime.close)

  const response = await fetch(`${runtime.baseUrl}/api/v1/observations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OBSERVATION_SECRET}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      broadcasterId: " Sample-Alpha ",
      status: "offline",
      observationId: "injected-observation-1",
      observedAt: NOW_ISO
    })
  })
  assert.equal(response.status, 202)
  assert.equal(factoryCalls, 1)
  assert.deepEqual(commands, [{ kind: "observe", normalizedId: "sample-alpha" }])
})

test("environment defaults bind locally and require explicit opt-in for remote exposure", () => {
  const local = configFromEnvironment({
    ADMIN_PASSWORD_HASH: "scrypt$hash",
    ADMIN_SESSION_SECRET: "session-secret",
    OBSERVATION_SECRET,
    OPERATOR_SECRET
  })
  assert.equal(local.host, "127.0.0.1")
  assert.equal(local.allowRemote, false)
  assert.equal(local.readOnly, false)
  assert.equal(local.operatorSecret, OPERATOR_SECRET)

  assert.throws(() => configFromEnvironment({
    ADMIN_PASSWORD_HASH: "scrypt$hash",
    ADMIN_SESSION_SECRET: "session-secret",
    OBSERVATION_SECRET,
    OPERATOR_SECRET,
    SELF_HOSTED_HOST: "0.0.0.0"
  }), /SELF_HOSTED_ALLOW_REMOTE/)

  const remote = configFromEnvironment({
    ADMIN_PASSWORD_HASH: "scrypt$hash",
    ADMIN_SESSION_SECRET: "session-secret",
    OBSERVATION_SECRET,
    OPERATOR_SECRET,
    SELF_HOSTED_HOST: "0.0.0.0",
    SELF_HOSTED_ALLOW_REMOTE: "1"
  })
  assert.equal(remote.host, "0.0.0.0")
  assert.equal(remote.allowRemote, true)

  const readOnly = configFromEnvironment({
    ADMIN_PASSWORD_HASH: "scrypt$hash",
    ADMIN_SESSION_SECRET: "session-secret",
    OBSERVATION_SECRET,
    OPERATOR_SECRET,
    SELF_HOSTED_READ_ONLY: "1"
  })
  assert.equal(readOnly.readOnly, true)
})

test("signObservation uses HMAC-SHA256 over timestamp and the exact body", () => {
  const timestamp = String(Math.floor(NOW_MS / 1000))
  const body = "{\"status\":\"live\"}"
  const expected = crypto
    .createHmac("sha256", OBSERVATION_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex")
  assert.equal(signObservation({ secret: OBSERVATION_SECRET, timestamp, body }), `sha256=${expected}`)
})
