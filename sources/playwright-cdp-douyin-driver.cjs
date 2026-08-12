'use strict';

function createPlaywrightCdpDouyinDriver(options = {}) {
  const endpoint = parseLoopbackEndpoint(options.endpoint);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const playwright = options.playwright;
  const connectTimeoutMs = timerInteger(options.connectTimeoutMs ?? 10_000, 'connectTimeoutMs');
  const minimumReadSpacingMs = timerInteger(
    options.minimumReadSpacingMs ?? 12_000,
    'minimumReadSpacingMs',
  );
  const clock = requireClock(options.clock);
  const pageInspector = options.pageInspector ?? safeDefaultPageInspector;
  let browser = null;
  let startPromise = null;
  let inspectionTail = Promise.resolve();
  let lastInspectionStartedAt = null;
  let closed = false;
  let attachmentEpoch = 0;
  const targetPages = new Map();

  if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
  if (typeof pageInspector !== 'function') throw new TypeError('pageInspector must be a function');

  async function start() {
    if (closed) throw new Error('CDP driver is closed');
    if (browser) return;
    if (startPromise) return startPromise;
    const epoch = attachmentEpoch;
    const pending = attach(epoch)
      .catch(() => {
        throw new Error('could not attach to the local visible Chromium browser');
      })
      .finally(() => {
        if (startPromise === pending) startPromise = null;
      });
    startPromise = pending;
    await pending;
  }

  async function attach(epoch) {
    const websocketEndpoint = await discoverWebsocketEndpoint(
      endpoint,
      fetchImpl,
      connectTimeoutMs,
    );
    const chromium = resolveChromium(playwright);
    const connected = await chromium.connectOverCDP(websocketEndpoint, {
      timeout: connectTimeoutMs,
    });
    if (!connected || typeof connected.contexts !== 'function') throw new Error('invalid browser');
    if (closed || epoch !== attachmentEpoch) {
      await connected.close?.().catch(() => {});
      throw new Error('stale browser attachment');
    }
    browser = connected;
  }

  function inspectDouyinPage(input = {}) {
    if (closed) return Promise.resolve(unknownReading());
    const target = parseTarget(input);
    const queued = inspectionTail.then(
      () => inspectSerially(target),
      () => inspectSerially(target),
    );
    const run = queued.then(result => result.value);
    inspectionTail = queued.then(
      result => result.drain,
      () => undefined,
    );
    return run;
  }

  async function inspectSerially(target) {
    try {
      if (closed) return { value: unknownReading(), drain: Promise.resolve() };
      await enforceReadSpacing(clock, minimumReadSpacingMs, lastInspectionStartedAt);
      if (closed) return { value: unknownReading(), drain: Promise.resolve() };
      lastInspectionStartedAt = clock.now();
      const outcome = await inspectOperationWithTimeout(
        () => inspectTarget(target),
        target.timeoutMs,
        detachTimedOutTransport,
      );
      return {
        value: enforceTargetContract(normalizeReading(outcome.value), target.expectedIdentity),
        drain: outcome.drain,
      };
    } catch {
      return { value: unknownReading(), drain: Promise.resolve() };
    }
  }

  async function inspectTarget(target) {
    if (!browser || (typeof browser.isConnected === 'function' && !browser.isConnected())) {
      attachmentEpoch += 1;
      browser = null;
      startPromise = null;
      targetPages.clear();
      try {
        await start();
      } catch {
        return unknownReading();
      }
      if (!browser || (typeof browser.isConnected === 'function' && !browser.isConnected())) {
        return unknownReading();
      }
    }
    const page = await acquireTargetPage(browser, targetPages, target);
    if (!page) return unknownReading();
    await page.bringToFront?.();
    if (page.url() !== target.url) return unknownReading();
    return pageInspector({
      page,
      url: target.url,
      expectedIdentity: target.expectedIdentity,
      timeoutMs: target.timeoutMs,
      fetch: fetchImpl,
    });
  }

  async function detachTimedOutTransport() {
    attachmentEpoch += 1;
    const attachedBrowser = browser;
    browser = null;
    targetPages.clear();
    if (attachedBrowser && typeof attachedBrowser.close === 'function') {
      await attachedBrowser.close().catch(() => {});
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    attachmentEpoch += 1;
    const pendingStart = startPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    await inspectionTail;
    const attachedBrowser = browser;
    targetPages.clear();
    browser = null;
    startPromise = null;
    if (attachedBrowser && typeof attachedBrowser.close === 'function') {
      await attachedBrowser.close().catch(() => {});
    }
  }

  return Object.freeze({ start, inspectDouyinPage, close });
}

async function acquireTargetPage(browser, targetPages, target) {
  const cached = targetPages.get(target.url);
  if (isUsablePage(cached)) {
    if (cached.url() !== target.url) {
      await cached.goto(target.url, { waitUntil: 'domcontentloaded', timeout: target.timeoutMs });
    }
    return cached;
  }

  const contexts = browser.contexts();
  if (!Array.isArray(contexts) || contexts.length === 0) return null;
  for (const context of contexts) {
    const existing = context.pages?.().find(page => isUsablePage(page) && page.url() === target.url);
    if (existing) {
      targetPages.set(target.url, existing);
      return existing;
    }
  }

  const page = await contexts[0].newPage();
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: target.timeoutMs });
  targetPages.set(target.url, page);
  return page;
}

function isUsablePage(page) {
  return Boolean(page)
    && typeof page.url === 'function'
    && typeof page.goto === 'function'
    && (typeof page.isClosed !== 'function' || !page.isClosed());
}

async function inspectOperationWithTimeout(operation, timeoutMs, onTimeout) {
  let timeout;
  const operationPromise = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      operationPromise.then(value => ({ value, drain: Promise.resolve() })),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          operationPromise.catch(() => {});
          const detached = Promise.resolve()
            .then(onTimeout)
            .catch(() => {});
          const drain = detached.then(() => operationPromise.then(() => undefined, () => undefined));
          resolve({ value: unknownReading(), drain });
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function enforceReadSpacing(clock, minimumReadSpacingMs, previousStartedAt) {
  if (previousStartedAt === null) return;
  const elapsed = clock.now() - previousStartedAt;
  if (elapsed < minimumReadSpacingMs) {
    await clock.sleep(minimumReadSpacingMs - Math.max(0, elapsed));
  }
}

function parseTarget(input) {
  const expectedIdentity = typeof input.expectedIdentity === 'string'
    ? input.expectedIdentity
    : '';
  const url = typeof input.url === 'string' ? input.url : '';
  const canonicalUrl = `https://www.douyin.com/user/${expectedIdentity}`;
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(expectedIdentity) || url !== canonicalUrl) {
    throw new TypeError('target must be a canonical Douyin profile matching expectedIdentity');
  }
  return {
    url,
    expectedIdentity,
    timeoutMs: timerInteger(input.timeoutMs ?? 30_000, 'timeoutMs'),
  };
}

function normalizeReading(value) {
  return {
    httpStatus: Number.isInteger(value?.httpStatus)
      && value.httpStatus >= 100
      && value.httpStatus <= 599
      ? value.httpStatus
      : 0,
    verificationRequired: value?.verificationRequired === true,
    identity: typeof value?.identity === 'string'
      && /^[A-Za-z0-9._~-]{1,256}$/.test(value.identity)
      ? value.identity
      : null,
    status: ['live', 'offline', 'unknown'].includes(value?.status) ? value.status : 'unknown',
    roomId: typeof value?.roomId === 'string' && /^[1-9][0-9]{0,39}$/.test(value.roomId)
      ? value.roomId
      : null,
  };
}

function enforceTargetContract(reading, expectedIdentity) {
  if (reading.status === 'live') {
    if (reading.httpStatus === 200
      && reading.verificationRequired === false
      && reading.identity === expectedIdentity
      && reading.roomId !== null) {
      return reading;
    }
    return { ...reading, status: 'unknown', roomId: null };
  }
  if (reading.status === 'offline') {
    if (reading.httpStatus === 200
      && reading.verificationRequired === false
      && reading.identity === expectedIdentity
      && reading.roomId === null) {
      return reading;
    }
    return { ...reading, status: 'unknown', roomId: null };
  }
  return { ...reading, status: 'unknown', roomId: null };
}

function unknownReading() {
  return {
    httpStatus: 0,
    verificationRequired: false,
    identity: null,
    status: 'unknown',
    roomId: null,
  };
}

async function safeDefaultPageInspector(input) {
  if (!input?.page || typeof input.page.evaluate !== 'function') return unknownReading();
  const result = await input.page.evaluate(async ({ expectedIdentity, timeoutMs }) => {
    const unknown = (extra = {}) => ({
      httpStatus: 0,
      verificationRequired: false,
      identity: null,
      status: 'unknown',
      roomId: null,
      ...extra,
    });
    const readBoundedResponseText = async (response, limit) => {
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) {
              await reader.cancel().catch(() => {});
              return null;
            }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
          return text;
        } finally {
          reader.releaseLock?.();
        }
      }
      if (typeof response.text !== 'function') return null;
      const text = await response.text();
      return new TextEncoder().encode(text).byteLength <= limit ? text : null;
    };
    if (location.origin !== 'https://www.douyin.com'
      || location.pathname !== `/user/${expectedIdentity}`
      || location.search !== ''
      || location.hash !== '') {
      return unknown();
    }
    const challengePattern = /(?:captcha|verify|verification|challenge|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u6ed1\u5757)/i;
    const titleText = String(document.title || '').slice(0, 500);
    const bodyText = String(document.body?.innerText || '').slice(0, 10_000);
    const pageText = `${titleText}\n${bodyText}`;
    if (challengePattern.test(pageText)) return unknown({ verificationRequired: true });
    if (!titleText.trim() && !bodyText.trim()) {
      const pageHtml = String(document.documentElement?.innerHTML || '').slice(0, 20_000);
      if (pageHtml.includes('_$jsvmprt') && pageHtml.includes('__ac_nonce')) {
        return unknown({ verificationRequired: true });
      }
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const endpoint = new URL('/aweme/v1/web/user/profile/other/', location.origin);
      endpoint.searchParams.set('sec_user_id', expectedIdentity);
      endpoint.searchParams.set('_ts', String(Date.now()));
      const response = await fetch(endpoint.href, {
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: abortController.signal,
      });
      if (response.status === 429) {
        return unknown({ httpStatus: 429, verificationRequired: true });
      }
      if (!response.ok || response.redirected) return unknown({ httpStatus: response.status });
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
        return unknown({ httpStatus: response.status });
      }
      const responseText = await readBoundedResponseText(response, 256 * 1024);
      if (responseText === null) return unknown({ httpStatus: response.status });
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        return unknown({ httpStatus: response.status });
      }
      if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'status_code')
        && ![0, '0'].includes(payload.status_code)) {
        return unknown({ httpStatus: response.status });
      }
      const profile = payload?.user;
      const identity = typeof profile?.sec_uid === 'string' ? profile.sec_uid : null;
      const rawLiveStatus = profile?.live_status;
      const liveStatus = typeof rawLiveStatus === 'string' && /^[012]$/.test(rawLiveStatus)
        ? Number(rawLiveStatus)
        : rawLiveStatus;
      if (!identity || ![0, 1, 2].includes(liveStatus)) {
        return unknown({ httpStatus: response.status, identity });
      }

      let roomData = null;
      const hasRoomData = Object.prototype.hasOwnProperty.call(profile, 'room_data');
      const rawRoomData = profile.room_data;
      if (typeof rawRoomData === 'string' && rawRoomData.trim() !== '') {
        try {
          roomData = JSON.parse(rawRoomData);
        } catch {
          return unknown({ httpStatus: response.status, identity });
        }
      } else if (rawRoomData && typeof rawRoomData === 'object') {
        roomData = rawRoomData;
      } else if (hasRoomData
        && rawRoomData !== null
        && !(typeof rawRoomData === 'string' && rawRoomData.trim() === '')) {
        return unknown({ httpStatus: response.status, identity });
      }
      if (hasRoomData
        && roomData !== null
        && (typeof roomData !== 'object' || Array.isArray(roomData))) {
        return unknown({ httpStatus: response.status, identity });
      }
      for (const field of ['status', 'live_status']) {
        if (roomData && Object.prototype.hasOwnProperty.call(roomData, field)
          && ![0, 1, 2, 4, '0', '1', '2', '4'].includes(roomData[field])) {
          return unknown({ httpStatus: response.status, identity });
        }
      }
      const roomDataLive = [1, 2, '1', '2'].includes(roomData?.status)
        || [1, 2, '1', '2'].includes(roomData?.live_status);
      const roomDataId = [
        roomData?.id_str,
        roomData?.room_id_str,
        roomData?.room_id,
        roomData?.roomId,
        roomData?.id,
      ]
        .map((value) => {
          if (typeof value === 'string') return value;
          if (typeof value === 'bigint' && value > 0n) return value.toString();
          if (Number.isSafeInteger(value) && value > 0) return String(value);
          return '';
        })
        .find(value => /^[1-9][0-9]{0,39}$/.test(value)) ?? null;
      const profileRoomId = [profile?.room_id_str, profile?.room_id, profile?.roomId]
        .map((value) => {
          if (typeof value === 'string') return value;
          if (typeof value === 'bigint' && value > 0n) return value.toString();
          if (Number.isSafeInteger(value) && value > 0) return String(value);
          return '';
        })
        .find(value => /^[1-9][0-9]{0,39}$/.test(value)) ?? null;
      const activeRoomId = roomDataLive ? roomDataId : null;

      if ((liveStatus === 1 || liveStatus === 2) && (activeRoomId || profileRoomId)) {
        return {
          httpStatus: response.status,
          verificationRequired: false,
          identity,
          status: 'live',
          roomId: activeRoomId || profileRoomId,
        };
      }
      if (liveStatus === 0 && hasRoomData && !roomDataLive && !activeRoomId) {
        return {
          httpStatus: response.status,
          verificationRequired: false,
          identity,
          status: 'offline',
          roomId: null,
        };
      }
      return unknown({ httpStatus: response.status, identity, roomId: activeRoomId });
    } catch {
      return unknown();
    } finally {
      clearTimeout(timeout);
    }
  }, {
    expectedIdentity: input.expectedIdentity,
    timeoutMs: input.timeoutMs,
  });
  return normalizeReading(result);
}

function requireClock(value) {
  const clock = value ?? {
    now: Date.now,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  };
  if (typeof clock.now !== 'function' || typeof clock.sleep !== 'function') {
    throw new TypeError('clock must provide now and sleep');
  }
  return clock;
}

async function discoverWebsocketEndpoint(endpoint, fetchImpl, timeoutMs) {
  const versionUrl = new URL(endpoint.href);
  versionUrl.protocol = ['ws:', 'http:'].includes(versionUrl.protocol) ? 'http:' : 'https:';
  versionUrl.pathname = '/json/version';
  versionUrl.search = '';
  versionUrl.hash = '';

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(versionUrl.href, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: abortController.signal,
    });
    if (!response?.ok
      || response.status !== 200
      || response.redirected === true
      || (response.url && response.url !== versionUrl.href)) {
      throw new Error('preflight failed');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 16 * 1024) throw new Error('preflight too large');
    const payload = JSON.parse(text);
    const product = typeof payload?.Browser === 'string' ? payload.Browser : '';
    const userAgent = typeof payload?.['User-Agent'] === 'string' ? payload['User-Agent'] : '';
    if (product.startsWith('Headless')
      || /HeadlessChrome/i.test(userAgent)
      || !/^(?:Chrome|Chromium|Edg)\//.test(product)) {
      throw new Error('browser is not visible Chromium');
    }
    const websocket = parseLoopbackEndpoint(payload.webSocketDebuggerUrl);
    if (!['ws:', 'wss:'].includes(websocket.protocol)) throw new Error('invalid websocket');
    return websocket.href;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveChromium(injectedPlaywright) {
  const candidate = injectedPlaywright ?? require('playwright-core');
  if (!candidate?.chromium || typeof candidate.chromium.connectOverCDP !== 'function') {
    throw new TypeError('Playwright Chromium support is unavailable');
  }
  return candidate.chromium;
}

function timerInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be an integer from 1 to 2147483647`);
  }
  return value;
}

function parseLoopbackEndpoint(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('CDP endpoint must be a non-empty loopback URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('CDP endpoint must be a valid loopback URL');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !isLoopbackHost(url.hostname)) {
    throw new TypeError('CDP endpoint must be a credential-free loopback URL');
  }
  return url;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map(Number);
  return octets.length === 4
    && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 127;
}

module.exports = { createPlaywrightCdpDouyinDriver };
