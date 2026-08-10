const crypto = require("node:crypto")
const http = require("node:http")
const path = require("node:path")

const {
  configFromEnvironment: adminConfigFromEnvironment,
  createAdminRequestHandler
} = require("./admin-server.cjs")

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8787
const MAX_OBSERVATION_BODY_BYTES = 64 * 1024
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000
const DEFAULT_OBSERVATION_TOLERANCE_MS = 5 * 60 * 1000
const RESERVED_OBJECT_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype))
const OBSERVATION_FIELDS = [
  "broadcasterId",
  "status",
  "observationId",
  "observedAt",
  "source",
  "evidence"
]
const OPERATOR_COMMAND_FIELDS = Object.freeze({
  "register-recipient": ["kind", "recipientId", "credits", "enabled"],
  "grant-credits": ["kind", "grantId", "recipientId", "credits"],
  subscribe: ["kind", "broadcasterId", "recipientId", "active"],
  "resolve-delivery": [
    "kind",
    "resolutionId",
    "eventId",
    "recipientId",
    "outcome",
    "providerReference",
    "code"
  ]
})
const OPERATOR_QUERY_FIELDS = Object.freeze({
  event: ["kind", "eventId"],
  recipient: ["kind", "recipientId"]
})
const DASHBOARD_SUMMARY_FIELDS = [
  "broadcasters",
  "recipients",
  "events",
  "receipts",
  "pending",
  "inFlight",
  "accepted",
  "failed",
  "ambiguous",
  "bookkeepingPending"
]
const DASHBOARD_BROADCASTER_FIELDS = [
  "broadcasterId",
  "stableStatus",
  "lastObservedAt",
  "lastUnknownAt",
  "lastEventId",
  "lastSource",
  "activeSubscriptions",
  "currentlyEligibleRecipients",
  "createdAt",
  "updatedAt"
]
const DASHBOARD_EVENT_FIELDS = [
  "eventId",
  "broadcasterId",
  "status",
  "source",
  "occurredAt",
  "denominator"
]
const DASHBOARD_EVENT_COUNT_FIELDS = [
  "denominator",
  "pending",
  "inFlight",
  "accepted",
  "failed",
  "ambiguous",
  "bookkeepingPending",
  "accounted",
  "countConsistent",
  "terminal"
]

function jsonHeaders() {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  }
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    ...jsonHeaders(),
    "content-length": Buffer.byteLength(body)
  })
  response.end(body)
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    request.on("data", chunk => {
      size += chunk.length
      if (size > MAX_OBSERVATION_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) {
        chunks.push(chunk)
      }
    })
    request.on("end", () => {
      if (tooLarge) return reject(new Error("REQUEST_TOO_LARGE"))
      resolve(Buffer.concat(chunks))
    })
    request.on("error", reject)
  })
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""))
  const rightBuffer = Buffer.from(String(right || ""))
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function signObservation({ secret, timestamp, body }) {
  const signature = crypto
    .createHmac("sha256", String(secret || ""))
    .update(`${String(timestamp)}.${String(body)}`)
    .digest("hex")
  return `sha256=${signature}`
}

function hasValidBearer(request, secret) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i)
  return Boolean(match && timingSafeTextEqual(match[1], secret))
}

function hasValidSignature(request, rawBody, secret, nowMs) {
  const timestamp = String(request.headers["x-live-reminder-timestamp"] || "")
  const supplied = String(request.headers["x-live-reminder-signature"] || "")
  if (!/^\d+$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/i.test(supplied)) return false
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Number(nowMs) - timestampMs) > SIGNATURE_TOLERANCE_MS) {
    return false
  }
  const expected = signObservation({ secret, timestamp, body: rawBody.toString("utf8") })
  return timingSafeTextEqual(supplied.toLowerCase(), expected)
}

async function readAuthenticatedJsonBody({ request, response, secret, now }) {
  if (request.method !== "POST") {
    response.writeHead(405, { ...jsonHeaders(), allow: "POST" })
    response.end()
    return null
  }
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { ok: false, error: "JSON_REQUIRED" })
    return null
  }

  let rawBody
  try {
    rawBody = await readRawBody(request)
  } catch (error) {
    sendJson(response, error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400, {
      ok: false,
      error: error && error.message === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST"
    })
    return null
  }

  const authenticated = hasValidBearer(request, secret) || hasValidSignature(request, rawBody, secret, now())
  if (!authenticated) {
    sendJson(response, 401, { ok: false, error: "AUTH_REQUIRED" })
    return null
  }
  return rawBody
}

function defaultObservationCommandFactory(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("observation must be a JSON object")
  }
  const command = { kind: "observe" }
  for (const field of OBSERVATION_FIELDS) {
    if (!Object.hasOwn(observation, field) || observation[field] === undefined) continue
    command[field] = observation[field]
  }
  return command
}

function requireRealtimeObservation(observation, nowMs, toleranceMs = DEFAULT_OBSERVATION_TOLERANCE_MS) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("invalid observation")
  }
  if (!requiredOperatorId(observation.broadcasterId) || !requiredOperatorId(observation.observationId)) {
    throw new Error("invalid observation")
  }
  if (typeof observation.status !== "string" ||
    !["live", "offline", "unknown"].includes(observation.status.toLowerCase())) {
    throw new Error("invalid observation")
  }
  if (typeof observation.observedAt !== "string" || observation.observedAt.trim() === "") {
    throw new Error("invalid observation")
  }
  const observedAtMs = Date.parse(observation.observedAt)
  const serverNowMs = Number(nowMs)
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(serverNowMs)) {
    throw new Error("invalid observation")
  }
  if (Math.abs(serverNowMs - observedAtMs) > toleranceMs) {
    throw new Error("invalid observation")
  }
}

function requiredOperatorId(value) {
  if (typeof value !== "string") return false
  const normalized = value.trim()
  return normalized !== "" && normalized.length <= 200 && !RESERVED_OBJECT_KEYS.has(normalized)
}

function optionalOperatorText(value) {
  return value === undefined || (typeof value === "string" && value.length <= 500)
}

function hasOnlyFields(input, allowedFields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const allowed = new Set(allowedFields)
  return Object.keys(input).every(field => allowed.has(field))
}

function operatorCommandFromInput(input) {
  const kind = input && input.kind
  const allowedFields = OPERATOR_COMMAND_FIELDS[kind]
  if (!allowedFields || !hasOnlyFields(input, allowedFields)) throw new Error("invalid command")

  if (kind === "register-recipient") {
    if (!requiredOperatorId(input.recipientId)) throw new Error("invalid command")
    if (input.credits !== undefined && (!Number.isSafeInteger(input.credits) || input.credits < 0)) {
      throw new Error("invalid command")
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("invalid command")
  } else if (kind === "grant-credits") {
    if (!requiredOperatorId(input.grantId) || !requiredOperatorId(input.recipientId) ||
      !Number.isSafeInteger(input.credits) || input.credits <= 0) throw new Error("invalid command")
  } else if (kind === "subscribe") {
    if (!requiredOperatorId(input.broadcasterId) || !requiredOperatorId(input.recipientId)) {
      throw new Error("invalid command")
    }
    if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("invalid command")
  } else if (kind === "resolve-delivery") {
    const hasEvidence = requiredOperatorId(input.providerReference) || requiredOperatorId(input.code)
    if (!requiredOperatorId(input.resolutionId) || !requiredOperatorId(input.eventId) ||
      !requiredOperatorId(input.recipientId) ||
      !["accepted", "failed"].includes(input.outcome) ||
      !optionalOperatorText(input.providerReference) || !optionalOperatorText(input.code) || !hasEvidence) {
      throw new Error("invalid command")
    }
  }

  const command = {}
  for (const field of allowedFields) {
    if (Object.hasOwn(input, field)) command[field] = input[field]
  }
  return command
}

function operatorQueryFromInput(input) {
  const kind = input && input.kind
  const allowedFields = OPERATOR_QUERY_FIELDS[kind]
  if (!allowedFields || !hasOnlyFields(input, allowedFields)) throw new Error("invalid query")
  const idField = kind === "event" ? "eventId" : "recipientId"
  if (!requiredOperatorId(input[idField])) throw new Error("invalid query")
  return { kind, [idField]: input[idField] }
}

function projectFields(input, fields) {
  const projected = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return projected
  for (const field of fields) {
    if (Object.hasOwn(input, field)) projected[field] = input[field]
  }
  return projected
}

function projectAdminDashboard(dashboardResult) {
  const dashboard = dashboardResult && dashboardResult.ok === true && dashboardResult.data
    ? dashboardResult.data
    : dashboardResult
  const source = dashboard && typeof dashboard === "object" && !Array.isArray(dashboard) ? dashboard : {}
  return {
    summary: projectFields(source.summary, DASHBOARD_SUMMARY_FIELDS),
    broadcasters: Array.isArray(source.broadcasters)
      ? source.broadcasters.map(item => projectFields(item, DASHBOARD_BROADCASTER_FIELDS))
      : [],
    events: Array.isArray(source.events)
      ? source.events.map(item => ({
          ...projectFields(item, DASHBOARD_EVENT_FIELDS),
          ...(item && item.counts !== undefined
            ? { counts: projectFields(item.counts, DASHBOARD_EVENT_COUNT_FIELDS) }
            : {})
        }))
      : []
  }
}

function resolveCore({ core, coreFactory }) {
  if (core && coreFactory) throw new Error("provide core or coreFactory, not both")
  const resolved = core || (typeof coreFactory === "function" ? coreFactory() : null)
  if (!resolved) throw new Error("core or coreFactory is required")
  if (typeof resolved.execute !== "function") throw new Error("core.execute must be a function")
  if (typeof resolved.read !== "function") throw new Error("core.read must be a function")
  return resolved
}

function observationTimeTolerance(value) {
  const resolved = value === undefined ? DEFAULT_OBSERVATION_TOLERANCE_MS : Number(value)
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > DEFAULT_OBSERVATION_TOLERANCE_MS) {
    throw new Error("config.observationTimeToleranceMs must be an integer from 0 through 300000")
  }
  return resolved
}

function validateSelfHostedConfig(config) {
  if (String(config && config.observationSecret || "").length < 32) {
    throw new Error("OBSERVATION_SECRET must contain at least 32 characters")
  }
  if (String(config && config.operatorSecret || "").length < 32) {
    throw new Error("OPERATOR_SECRET must contain at least 32 characters")
  }
  if (timingSafeTextEqual(config && config.observationSecret, config && config.operatorSecret)) {
    throw new Error("OBSERVATION_SECRET and OPERATOR_SECRET must be different")
  }
  if (timingSafeTextEqual(config && config.sessionSecret, config && config.observationSecret) ||
    timingSafeTextEqual(config && config.sessionSecret, config && config.operatorSecret)) {
    throw new Error("ADMIN_SESSION_SECRET, OBSERVATION_SECRET, and OPERATOR_SECRET must be different")
  }
  if (config && config.now !== undefined && typeof config.now !== "function") {
    throw new Error("config.now must be a function")
  }
  if (config && config.readOnly !== undefined && typeof config.readOnly !== "boolean") {
    throw new Error("config.readOnly must be a boolean")
  }
  observationTimeTolerance(config && config.observationTimeToleranceMs)
}

function createSelfHostedServer({
  staticDir = path.resolve(__dirname, "..", "dist"),
  core,
  coreFactory,
  config,
  observationCommandFactory = defaultObservationCommandFactory
} = {}) {
  validateSelfHostedConfig(config)
  if (typeof observationCommandFactory !== "function") {
    throw new Error("observationCommandFactory must be a function")
  }
  const resolvedCore = resolveCore({ core, coreFactory })
  const now = config && config.now || Date.now
  const realtimeToleranceMs = observationTimeTolerance(config && config.observationTimeToleranceMs)
  const adminHandler = createAdminRequestHandler({
    staticDir,
    config,
    loadDashboard: async () => {
      const dashboard = await resolvedCore.read({ kind: "dashboard" })
      return { ok: true, data: projectAdminDashboard(dashboard) }
    }
  })

  async function handleObservation(request, response) {
    const rawBody = await readAuthenticatedJsonBody({
      request,
      response,
      secret: config.observationSecret,
      now
    })
    if (!rawBody) return
    if (config.readOnly === true) return sendJson(response, 403, { ok: false, error: "READ_ONLY" })

    let observation
    let command
    try {
      observation = JSON.parse(rawBody.toString("utf8"))
      requireRealtimeObservation(observation, now(), realtimeToleranceMs)
      command = observationCommandFactory(observation)
      if (!command || typeof command !== "object" || Array.isArray(command) || command.kind !== "observe") {
        throw new Error("observation command must have kind observe")
      }
    } catch {
      return sendJson(response, 400, { ok: false, error: "INVALID_OBSERVATION" })
    }

    try {
      const result = await resolvedCore.execute(command)
      return sendJson(response, 202, { ok: true, data: result === undefined ? null : result })
    } catch (error) {
      const publicStatus = Number(error && error.publicStatus)
      const statusCode = Number.isInteger(publicStatus) && publicStatus >= 400 && publicStatus < 500
        ? publicStatus
        : 500
      return sendJson(response, statusCode, {
        ok: false,
        error: String(error && error.publicCode || "OBSERVATION_REJECTED")
      })
    }
  }

  async function handleOperatorCommand(request, response) {
    const rawBody = await readAuthenticatedJsonBody({
      request,
      response,
      secret: config.operatorSecret,
      now
    })
    if (!rawBody) return
    if (config.readOnly === true) return sendJson(response, 403, { ok: false, error: "READ_ONLY" })

    let command
    try {
      command = operatorCommandFromInput(JSON.parse(rawBody.toString("utf8")))
    } catch {
      return sendJson(response, 400, { ok: false, error: "INVALID_COMMAND" })
    }

    try {
      const result = await resolvedCore.execute(command)
      return sendJson(response, 200, { ok: true, data: result === undefined ? null : result })
    } catch (error) {
      const publicStatus = Number(error && error.publicStatus)
      const statusCode = Number.isInteger(publicStatus) && publicStatus >= 400 && publicStatus < 500
        ? publicStatus
        : 400
      return sendJson(response, statusCode, {
        ok: false,
        error: String(error && error.publicCode || "COMMAND_REJECTED")
      })
    }
  }

  async function handleOperatorQuery(request, response) {
    const rawBody = await readAuthenticatedJsonBody({
      request,
      response,
      secret: config.operatorSecret,
      now
    })
    if (!rawBody) return

    let query
    try {
      query = operatorQueryFromInput(JSON.parse(rawBody.toString("utf8")))
    } catch {
      return sendJson(response, 400, { ok: false, error: "INVALID_QUERY" })
    }

    try {
      const result = await resolvedCore.read(query)
      return sendJson(response, 200, { ok: true, data: result === undefined ? null : result })
    } catch {
      return sendJson(response, 400, { ok: false, error: "QUERY_REJECTED" })
    }
  }

  const server = http.createServer((request, response) => {
    let url
    try {
      url = new URL(request.url || "/", "http://localhost")
    } catch {
      return sendJson(response, 400, { ok: false, error: "INVALID_REQUEST" })
    }
    if (url.pathname === "/" && ["GET", "HEAD"].includes(request.method)) {
      response.writeHead(302, {
        "cache-control": "no-store",
        "content-length": "0",
        location: "/admin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff"
      })
      return response.end()
    }
    if (url.pathname === "/api/v1/observations") {
      Promise.resolve(handleObservation(request, response))
        .catch(() => sendJson(response, 500, { ok: false, error: "INTERNAL_ERROR" }))
      return
    }
    if (url.pathname === "/api/v1/operator/commands") {
      Promise.resolve(handleOperatorCommand(request, response))
        .catch(() => sendJson(response, 500, { ok: false, error: "INTERNAL_ERROR" }))
      return
    }
    if (url.pathname === "/api/v1/operator/queries") {
      Promise.resolve(handleOperatorQuery(request, response))
        .catch(() => sendJson(response, 500, { ok: false, error: "INTERNAL_ERROR" }))
      return
    }
    adminHandler(request, response)
  })

  Object.defineProperty(server, "core", {
    configurable: false,
    enumerable: false,
    value: resolvedCore,
    writable: false
  })
  return server
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase()
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "localhost"
}

function configFromEnvironment(environment = process.env) {
  const host = String(environment.SELF_HOSTED_HOST || DEFAULT_HOST).trim()
  const port = Number(environment.SELF_HOSTED_PORT || DEFAULT_PORT)
  const allowRemote = environment.SELF_HOSTED_ALLOW_REMOTE === "1"
  const realtimeToleranceMs = observationTimeTolerance(environment.OBSERVATION_TIME_TOLERANCE_MS)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SELF_HOSTED_PORT must be an integer between 1 and 65535")
  }
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error("non-loopback SELF_HOSTED_HOST requires SELF_HOSTED_ALLOW_REMOTE=1")
  }
  return {
    ...adminConfigFromEnvironment(environment),
    allowRemote,
    host,
    observationSecret: environment.OBSERVATION_SECRET,
    observationTimeToleranceMs: realtimeToleranceMs,
    operatorSecret: environment.OPERATOR_SECRET,
    port,
    readOnly: environment.SELF_HOSTED_READ_ONLY === "1"
  }
}

function resolveCoreModule(modulePath, workingDirectory = process.cwd()) {
  if (!String(modulePath || "").trim()) {
    throw new Error("SELF_HOSTED_CORE_MODULE is required")
  }
  const loaded = require(path.resolve(workingDirectory, modulePath))
  if (loaded && typeof loaded.execute === "function" && typeof loaded.read === "function") {
    return { core: loaded }
  }
  if (loaded && loaded.core) return { core: loaded.core }
  const factory = loaded && (loaded.createCore || loaded.coreFactory)
  if (typeof factory === "function") return { coreFactory: () => factory() }
  throw new Error("SELF_HOSTED_CORE_MODULE must export a core, createCore, or coreFactory")
}

if (require.main === module) {
  try {
    const config = configFromEnvironment()
    const coreOptions = resolveCoreModule(process.env.SELF_HOSTED_CORE_MODULE)
    const server = createSelfHostedServer({ config, ...coreOptions })
    server.listen(config.port, config.host, () => {
      process.stdout.write(`self-hosted server listening on http://${config.host}:${config.port}\n`)
    })
  } catch (error) {
    process.stderr.write(`${String(error && error.message || error)}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  configFromEnvironment,
  createSelfHostedServer,
  defaultObservationCommandFactory,
  resolveCoreModule,
  signObservation
}
