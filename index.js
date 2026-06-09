import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createInterface as createPromisesInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fakerVI as faker } from '@faker-js/faker';
import axios from 'axios';
import pLimit from 'p-limit';

const MAX_UNIQUE_ATTEMPTS = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const LOG_FLUSH_THRESHOLD = 50;
const MOBILE_PREFIXES = ['032', '033', '034', '035', '036', '037', '038', '039', '070', '076', '077', '078', '079', '081', '082', '083', '084', '085', '086', '088', '089', '090', '091', '092', '093', '094', '096', '097', '098', '099'];
const PROVINCE_CODES = ['001', '002', '004', '006', '008', '010', '011', '012', '014', '015', '017', '019', '020', '022', '024', '025', '026', '027', '030', '031', '033', '034', '035', '036', '037', '038', '040', '042', '044', '045', '046', '048', '049', '051', '052', '054', '056', '058', '060', '062', '064', '066', '067', '068', '070', '072', '074', '075', '077', '079', '080', '082', '083', '084', '086', '087', '089', '091', '092', '093', '094', '095', '096'];
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

class UniqueConstraintError extends Error {
  constructor(fieldName, details = {}) {
    const suffix = details.spaceSize === undefined
      ? `sau ${MAX_UNIQUE_ATTEMPTS} lần thử`
      : `vì không gian sinh có ${details.spaceSize} giá trị nhưng yêu cầu ${details.requiredRecords} bản ghi`;
    super(`Không thể đảm bảo unique cho field "${fieldName}" ${suffix}.`);
    this.name = 'UniqueConstraintError';
    this.fieldName = fieldName;
    this.spaceSize = details.spaceSize;
    this.requiredRecords = details.requiredRecords;
  }
}

class FatalHttpError extends Error {
  constructor(status) {
    super(`Dừng khẩn cấp: API trả về HTTP ${status}. Kiểm tra token hoặc quyền truy cập.`);
    this.name = 'FatalHttpError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDigits = (length) => faker.string.numeric({ length, allowLeadingZeros: true });
const serializeUnique = (value) => JSON.stringify(value);

function normalizeVietnamese(value) {
  return String(value)
    .replace(/[đĐ]/g, (character) => (character === 'đ' ? 'd' : 'D'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function slugify(value) {
  const words = normalizeVietnamese(value).split(' ').filter(Boolean);
  if (words.length <= 1) return words[0] ?? '';
  return `${words[0]}.${words.slice(1).join('')}`;
}

function applyTransform(value, transform) {
  if (!transform) return value;
  const transforms = {
    slugify,
    uppercase: (input) => String(input).toUpperCase(),
    lowercase: (input) => String(input).toLowerCase(),
    trim: (input) => String(input).trim(),
  };
  if (!transforms[transform]) throw new Error(`Transform không được hỗ trợ: ${transform}`);
  return transforms[transform](value);
}

function topologicalSort(schema) {
  const order = [];
  const state = new Map();
  const visit = (field) => {
    if (state.get(field) === 'visiting') throw new Error(`Phát hiện circular dependency tại field "${field}".`);
    if (state.get(field) === 'visited') return;
    const definition = schema[field];
    if (!definition) throw new Error(`Field "${field}" không tồn tại trong schema.`);
    state.set(field, 'visiting');
    if (definition.dependsOn) {
      if (!schema[definition.dependsOn]) {
        throw new Error(`Field "${field}" dependsOn "${definition.dependsOn}" nhưng field nguồn không tồn tại.`);
      }
      visit(definition.dependsOn);
    }
    state.set(field, 'visited');
    order.push(field);
  };
  Object.keys(schema).forEach(visit);
  return order;
}

function validateConfiguration(config) {
  const { schema, execution, api } = config;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Cấu hình schema không hợp lệ.');
  if (!execution || !Number.isInteger(execution.totalRecords) || execution.totalRecords <= 0) throw new Error('totalRecords phải là số nguyên dương.');
  if (!Number.isInteger(execution.batchSize) || execution.batchSize <= 0) throw new Error('batchSize phải là số nguyên dương.');
  if (!Number.isInteger(execution.concurrency) || execution.concurrency <= 0) throw new Error('concurrency phải là số nguyên dương.');
  if (!api?.endpoint || String(api.method).toUpperCase() !== 'POST') throw new Error('Giai đoạn 1 yêu cầu API POST và endpoint hợp lệ.');
  for (const [field, definition] of Object.entries(schema)) {
    if (!definition.type) throw new Error(`Field "${field}" thiếu type.`);
    if (definition.unique && Array.isArray(definition.enum) && execution.totalRecords > new Set(definition.enum.map(serializeUnique)).size) {
      throw new UniqueConstraintError(field, {
        spaceSize: new Set(definition.enum.map(serializeUnique)).size,
        requiredRecords: execution.totalRecords,
      });
    }
  }
  return topologicalSort(schema);
}

function generateNationalId() {
  const province = faker.helpers.arrayElement(PROVINCE_CODES);
  const genderCentury = faker.number.int({ min: 0, max: 9 });
  const birthYear = faker.number.int({ min: 0, max: 99 }).toString().padStart(2, '0');
  return `${province}${genderCentury}${birthYear}${randomDigits(6)}`;
}

function generateBaseValue(definition, record) {
  if (definition.enum) return faker.helpers.arrayElement(definition.enum);
  const dependency = definition.dependsOn ? applyTransform(record[definition.dependsOn], definition.transform) : undefined;
  switch (definition.type) {
    case 'uuid': return faker.string.uuid();
    case 'vn.fullName': return faker.person.fullName();
    case 'vn.firstName': return faker.person.firstName();
    case 'vn.lastName': return faker.person.lastName();
    case 'vn.email': return `${dependency || slugify(faker.person.fullName())}@${definition.domain || 'gmail.com'}`;
    case 'vn.phone': return `${faker.helpers.arrayElement(MOBILE_PREFIXES)}${randomDigits(7)}`;
    case 'vn.nationalId': return generateNationalId();
    case 'vn.address.full': return faker.location.streetAddress({ useFullAddress: true });
    case 'integer': return faker.number.int({ min: definition.min ?? 0, max: definition.max ?? 1000 });
    case 'float': return faker.number.float({ min: definition.min ?? 0, max: definition.max ?? 1000, fractionDigits: definition.decimals ?? 2 });
    case 'boolean': return faker.datatype.boolean();
    case 'string': return dependency === undefined ? faker.lorem.word() : String(dependency);
    case 'date': return faker.date.between({ from: definition.startDate ?? '2000-01-01', to: definition.endDate ?? new Date() }).toISOString().slice(0, 10);
    case 'datetime': return faker.date.between({ from: definition.startDate ?? '2000-01-01', to: definition.endDate ?? new Date() }).toISOString();
    case 'null': return null;
    default: throw new Error(`Kiểu dữ liệu không được hỗ trợ: ${definition.type}`);
  }
}

function generateRecord(schema, fieldOrder, uniqueCache = new Map(), uniqueStats = new Map()) {
  const record = {};
  for (const field of fieldOrder) {
    const definition = schema[field];
    if (!definition.unique) {
      record[field] = generateBaseValue(definition, record);
      continue;
    }
    if (!uniqueCache.has(field)) uniqueCache.set(field, new Set());
    if (!uniqueStats.has(field)) uniqueStats.set(field, { generated: 0, collisions: 0, retries: 0 });
    const cache = uniqueCache.get(field);
    const stats = uniqueStats.get(field);
    let accepted = false;
    for (let attempt = 1; attempt <= MAX_UNIQUE_ATTEMPTS; attempt += 1) {
      const value = generateBaseValue(definition, record);
      const key = serializeUnique(value);
      if (!cache.has(key)) {
        cache.add(key);
        record[field] = value;
        stats.generated += 1;
        accepted = true;
        break;
      }
      stats.collisions += 1;
      stats.retries += 1;
    }
    if (!accepted) throw new UniqueConstraintError(field);
  }
  return record;
}

function writeChunk(stream, chunk) {
  if (!chunk) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('error', onError);
      reject(error);
    };
    stream.once('error', onError);
    stream.write(chunk, 'utf8', () => {
      stream.off('error', onError);
      resolve();
    });
  });
}

async function endStream(stream) {
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

function formatSessionTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createSessionDirectory(options = {}) {
  const outputRoot = options.outputRoot ?? path.join(PROJECT_ROOT, 'outputs');
  const timestamp = formatSessionTimestamp(options.date);
  fs.mkdirSync(outputRoot, { recursive: true });
  let suffix = 1;
  while (true) {
    const sessionName = suffix === 1 ? `session_${timestamp}` : `session_${timestamp}_${String(suffix).padStart(3, '0')}`;
    const sessionDir = path.join(outputRoot, sessionName);
    try {
      fs.mkdirSync(sessionDir);
      return sessionDir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      suffix += 1;
    }
  }
}

async function writeWithBackpressure(stream, chunk) {
  if (stream.write(chunk, 'utf8')) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function exportRawData(config, fieldOrder, uniqueCache, uniqueStats, options = {}) {
  const sessionDir = options.sessionDir ?? options.outputDir ?? process.cwd();
  const exportPath = path.join(sessionDir, 'mock_data_export.json');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stream = fs.createWriteStream(exportPath, { flags: 'w', encoding: 'utf8' });
  try {
    for (let offset = 0; offset < config.execution.totalRecords; offset += config.execution.batchSize) {
      const batchCount = Math.min(config.execution.batchSize, config.execution.totalRecords - offset);
      for (let index = 0; index < batchCount; index += 1) {
        const record = generateRecord(config.schema, fieldOrder, uniqueCache, uniqueStats);
        await writeWithBackpressure(stream, `${JSON.stringify(record)}\n`);
      }
    }
    await endStream(stream);
    return exportPath;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function* readRawData(exportPath) {
  const stream = fs.createReadStream(exportPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function promptTotalRecords(options = {}) {
  const readline = options.readline ?? createPromisesInterface({
    input: options.input ?? input,
    output: options.output ?? output,
  });
  const ownsInterface = !options.readline;
  try {
    while (true) {
      const answer = (await readline.question('Nhập số lượng data cần sinh (total records): ')).trim();
      if (/^[1-9]\d*$/.test(answer) && Number.isSafeInteger(Number(answer))) return Number(answer);
      const message = 'Giá trị không hợp lệ. Vui lòng nhập một số nguyên dương.\n';
      if (typeof options.writeError === 'function') options.writeError(message);
      else (options.output ?? output).write(message);
    }
  } finally {
    if (ownsInterface) readline.close();
  }
}

function createLogManager(options = {}) {
  const sessionDir = options.sessionDir ?? options.outputDir ?? process.cwd();
  const flushThreshold = options.flushThreshold ?? LOG_FLUSH_THRESHOLD;
  const writeDelayMs = options.writeDelayMs ?? 0;
  fs.mkdirSync(sessionDir, { recursive: true });
  const successStream = fs.createWriteStream(path.join(sessionDir, 'success.jsonl'), { flags: 'w', encoding: 'utf8' });
  const failedStream = fs.createWriteStream(path.join(sessionDir, 'failed.jsonl'), { flags: 'w', encoding: 'utf8' });
  let logBuffer = [];
  let flushQueue = Promise.resolve();
  let closed = false;

  const flush = () => {
    if (closed) return Promise.reject(new Error('Log manager đã đóng.'));
    const pending = [...logBuffer];
    logBuffer = [];
    if (pending.length === 0) return flushQueue;
    flushQueue = flushQueue.then(async () => {
      if (writeDelayMs > 0) await sleep(writeDelayMs);
      const successChunk = pending.filter((entry) => entry.kind === 'success').map((entry) => JSON.stringify(entry.data)).join('\n');
      const failedChunk = pending.filter((entry) => entry.kind === 'failed').map((entry) => JSON.stringify(entry.data)).join('\n');
      await Promise.all([
        writeChunk(successStream, successChunk ? `${successChunk}\n` : ''),
        writeChunk(failedStream, failedChunk ? `${failedChunk}\n` : ''),
      ]);
    });
    return flushQueue;
  };

  const push = (kind, data) => {
    if (closed) return Promise.reject(new Error('Log manager đã đóng.'));
    logBuffer.push({ kind, data });
    return logBuffer.length >= flushThreshold ? flush() : Promise.resolve();
  };

  const close = async () => {
    await flush();
    await flushQueue;
    closed = true;
    await Promise.all([endStream(successStream), endStream(failedStream)]);
  };

  return { push, flush, close, getBufferedCount: () => logBuffer.length };
}

function errorDetails(error) {
  return {
    status: error.response?.status ?? null,
    code: error.code ?? null,
    message: error.message,
    responseData: error.response?.data ?? null,
  };
}

function isRetryableError(error) {
  const status = error.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code);
}

async function sendWithRetry(record, api, options = {}) {
  const httpClient = options.httpClient ?? axios;
  const delay = options.delay ?? sleep;
  const abortController = options.abortController ?? new AbortController();
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    if (abortController.signal.aborted) throw Object.assign(new Error('Request đã bị hủy.'), { code: 'ERR_CANCELED' });
    try {
      const startedAt = Date.now();
      const response = await httpClient.post(api.endpoint, record, {
        headers: api.headers,
        timeout: api.timeout ?? 10000,
        signal: abortController.signal,
      });
      return { response, durationMs: Date.now() - startedAt, attempts: attempt };
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 || status === 403) throw new FatalHttpError(status);
      if (!isRetryableError(error) || attempt > MAX_RETRIES || abortController.signal.aborted) throw error;
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error('Trạng thái retry không hợp lệ.');
}

async function run(config, options = {}) {
  const fieldOrder = validateConfiguration(config);
  const sessionDir = options.sessionDir ?? createSessionDirectory({
    outputRoot: options.outputRoot ?? (options.outputDir ? path.join(options.outputDir, 'outputs') : undefined),
    date: options.sessionDate,
  });
  const uniqueCache = new Map();
  const uniqueStats = new Map();
  const exportPath = await exportRawData(config, fieldOrder, uniqueCache, uniqueStats, { sessionDir });
  const logs = options.logManager ?? createLogManager({ sessionDir });
  const limit = pLimit(config.execution.concurrency);
  const abortController = new AbortController();
  const startedAt = new Date();
  const responseTimes = [];
  const errorsByStatusCode = {};
  let success = 0;
  let failed = 0;
  let processed = 0;
  let fatalError;

  try {
    let batch = [];
    let offset = 0;
    const sendBatch = async (records, batchOffset) => {
      const tasks = records.map((record, index) => limit(async () => {
        if (abortController.signal.aborted) return;
        const sequence = batchOffset + index + 1;
        try {
          const result = await sendWithRetry(record, config.api, {
            httpClient: options.httpClient,
            delay: options.delay,
            abortController,
          });
          if (abortController.signal.aborted) return;
          success += 1;
          processed += 1;
          responseTimes.push(result.durationMs);
          await logs.push('success', { sequence, status: result.response.status, attempts: result.attempts, durationMs: result.durationMs, record, response: result.response.data });
        } catch (error) {
          if (error instanceof FatalHttpError) {
            fatalError ??= error;
            abortController.abort();
            return;
          }
          if (error.code === 'ERR_CANCELED' || abortController.signal.aborted) return;
          failed += 1;
          processed += 1;
          const details = errorDetails(error);
          const statusKey = String(details.status ?? details.code ?? 'NETWORK_ERROR');
          errorsByStatusCode[statusKey] = (errorsByStatusCode[statusKey] ?? 0) + 1;
          await logs.push('failed', { sequence, record, error: details });
        }
      }));
      await Promise.all(tasks);
      await logs.flush();
    };
    for await (const record of readRawData(exportPath)) {
      if (fatalError) break;
      batch.push(record);
      if (batch.length === config.execution.batchSize) {
        await sendBatch(batch, offset);
        offset += batch.length;
        batch = [];
      }
    }
    if (!fatalError && batch.length > 0) {
      await sendBatch(batch, offset);
    }
  } finally {
    await logs.close();
  }

  const endedAt = new Date();
  const durationMs = endedAt - startedAt;
  const sortedTimes = [...responseTimes].sort((a, b) => a - b);
  const report = {
    startTime: startedAt.toISOString(),
    endTime: endedAt.toISOString(),
    durationMs,
    results: { total: config.execution.totalRecords, processed, success, failed },
    performance: {
      avgResponseTimeMs: responseTimes.length ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length) : 0,
      minResponseTimeMs: sortedTimes[0] ?? 0,
      maxResponseTimeMs: sortedTimes.at(-1) ?? 0,
      p95ResponseTimeMs: sortedTimes.length ? sortedTimes[Math.ceil(sortedTimes.length * 0.95) - 1] : 0,
      throughputPerSecond: durationMs ? Number((processed / (durationMs / 1000)).toFixed(2)) : 0,
    },
    errors: { byStatusCode: errorsByStatusCode },
    uniqueCache: Object.fromEntries(uniqueStats),
    sessionDirectory: sessionDir,
    rawDataExport: exportPath,
    outputFiles: {
      rawData: exportPath,
      successLog: path.join(sessionDir, 'success.jsonl'),
      failedLog: path.join(sessionDir, 'failed.jsonl'),
      report: path.join(sessionDir, 'report.json'),
    },
    fatalError: fatalError?.message ?? null,
  };
  await fs.promises.writeFile(path.join(sessionDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (fatalError) {
    fatalError.report = report;
    throw fatalError;
  }
  return report;
}

function httpError(status, code) {
  const error = new Error(status ? `HTTP ${status}` : code);
  if (status) error.response = { status, data: { message: `Mock HTTP ${status}` } };
  if (code) error.code = code;
  return error;
}

function createSequenceHttpClient(sequence) {
  const calls = [];
  return {
    calls,
    async post(endpoint, record, config) {
      calls.push({ endpoint, record, config });
      const item = sequence[Math.min(calls.length - 1, sequence.length - 1)];
      if (item instanceof Error) throw item;
      if (typeof item === 'function') return item(calls.length);
      return item;
    },
  };
}

function readJsonLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content ? content.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mockgen-test-'));
  try {
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testConfig(totalRecords = 1) {
  return {
    api: { endpoint: 'https://mock.local/posts', method: 'POST', timeout: 1000 },
    execution: { totalRecords, batchSize: Math.min(totalRecords, 5), concurrency: 2 },
    schema: { id: { type: 'uuid' } },
  };
}

async function runSelfTests() {
  const tests = [];
  const test = (name, callback) => tests.push({ name, callback });

  test('Data dependency slugify tiếng Việt', async () => {
    assert.equal(slugify('  Hoàng Nguyễn Phước Trường !!! '), 'hoang.nguyenphuoctruong');
    const schema = {
      fullName: { type: 'string', enum: ['Hoàng Nguyễn Phước Trường'] },
      email: { type: 'vn.email', dependsOn: 'fullName', transform: 'slugify', domain: 'gmail.com' },
    };
    const record = generateRecord(schema, topologicalSort(schema));
    assert.equal(record.email, 'hoang.nguyenphuoctruong@gmail.com');
  });

  test('Unique exhaustion dừng trước HTTP request', async () => {
    const client = createSequenceHttpClient([{ status: 201, data: {} }]);
    const config = testConfig(10);
    config.schema.status = { type: 'string', enum: ['active', 'inactive'], unique: true };
    await assert.rejects(() => run(config, { httpClient: client }), UniqueConstraintError);
    assert.equal(client.calls.length, 0);
  });

  test('Session folder đúng định dạng và chống trùng tên', async () => withTempDir(async (outputRoot) => {
    const date = new Date(2026, 5, 9, 19, 15, 30);
    const first = createSessionDirectory({ outputRoot, date });
    const second = createSessionDirectory({ outputRoot, date });
    assert.equal(path.basename(first), 'session_20260609_191530');
    assert.equal(path.basename(second), 'session_20260609_191530_002');
    assert.equal(fs.statSync(first).isDirectory(), true);
    assert.equal(fs.statSync(second).isDirectory(), true);
  }));

  test('Prompt bắt nhập lại đến khi nhận số nguyên dương', async () => {
    const answers = ['', 'abc', '-1', '0', '1.5', '25'];
    const messages = [];
    const readline = {
      async question() { return answers.shift(); },
    };
    const value = await promptTotalRecords({ readline, writeError: (message) => messages.push(message) });
    assert.equal(value, 25);
    assert.equal(messages.length, 5);
  });

  test('Raw export hoàn tất trước HTTP request đầu tiên', async () => withTempDir(async (outputDir) => {
    const config = testConfig(7);
    let exportedRowsAtFirstRequest;
    const client = {
      calls: 0,
      async post() {
        this.calls += 1;
        if (this.calls === 1) exportedRowsAtFirstRequest = readJsonLines(path.join(outputDir, 'mock_data_export.json')).length;
        return { status: 201, data: { ok: true } };
      },
    };
    const report = await run(config, { sessionDir: outputDir, httpClient: client, delay: async () => {} });
    assert.equal(exportedRowsAtFirstRequest, 7);
    assert.equal(report.results.success, 7);
    assert.equal(readJsonLines(path.join(outputDir, 'mock_data_export.json')).length, 7);
  }));

  test('Run tạo đủ bốn file trong session folder', async () => withTempDir(async (temporaryRoot) => {
    const outputRoot = path.join(temporaryRoot, 'outputs');
    const client = createSequenceHttpClient([{ status: 201, data: { ok: true } }]);
    const report = await run(testConfig(), {
      outputRoot,
      sessionDate: new Date(2026, 5, 9, 19, 15, 30),
      httpClient: client,
      delay: async () => {},
    });
    assert.equal(path.dirname(report.sessionDirectory), outputRoot);
    assert.match(path.basename(report.sessionDirectory), /^session_\d{8}_\d{6}(?:_\d{3})?$/);
    for (const filePath of Object.values(report.outputFiles)) assert.equal(fs.existsSync(filePath), true);
    for (const fileName of ['mock_data_export.json', 'success.jsonl', 'failed.jsonl', 'report.json']) {
      assert.equal(fs.existsSync(path.join(temporaryRoot, fileName)), false);
    }
  }));

  test('Log buffer flush đồng thời không mất hoặc trùng dữ liệu', async () => withTempDir(async (outputDir) => {
    const logs = createLogManager({ outputDir, flushThreshold: 3, writeDelayMs: 25 });
    await logs.push('success', { id: 1 });
    await logs.push('success', { id: 2 });
    const activeFlush = logs.push('success', { id: 3 });
    await logs.push('success', { id: 4 });
    await logs.push('failed', { id: 5 });
    await activeFlush;
    await logs.close();
    const rows = [...readJsonLines(path.join(outputDir, 'success.jsonl')), ...readJsonLines(path.join(outputDir, 'failed.jsonl'))];
    assert.deepEqual(rows.map((row) => row.id).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  }));

  for (const status of [400, 422]) {
    test(`HTTP ${status} không retry`, async () => withTempDir(async (outputDir) => {
      const client = createSequenceHttpClient([httpError(status)]);
      const delays = [];
      const report = await run(testConfig(), { sessionDir: outputDir, httpClient: client, delay: async (ms) => delays.push(ms) });
      assert.equal(client.calls.length, 1);
      assert.deepEqual(delays, []);
      assert.equal(report.results.failed, 1);
      assert.equal(readJsonLines(path.join(outputDir, 'failed.jsonl')).length, 1);
    }));
  }

  for (const status of [401, 403]) {
    test(`HTTP ${status} dừng khẩn cấp`, async () => withTempDir(async (outputDir) => {
      const client = createSequenceHttpClient([httpError(status)]);
      await assert.rejects(() => run(testConfig(), { sessionDir: outputDir, httpClient: client, delay: async () => {} }), FatalHttpError);
      assert.equal(client.calls.length, 1);
      assert.equal(fs.existsSync(path.join(outputDir, 'report.json')), true);
      assert.equal(readJsonLines(path.join(outputDir, 'mock_data_export.json')).length, 1);
    }));
  }

  for (const failure of [httpError(500), httpError(502), httpError(504), httpError(null, 'ETIMEDOUT')]) {
    const label = failure.response?.status ?? failure.code;
    test(`${label} retry đủ 3 lần rồi ghi failed`, async () => withTempDir(async (outputDir) => {
      const client = createSequenceHttpClient([failure]);
      const delays = [];
      const report = await run(testConfig(), { sessionDir: outputDir, httpClient: client, delay: async (ms) => delays.push(ms) });
      assert.equal(client.calls.length, 4);
      assert.deepEqual(delays, [1000, 1000, 1000]);
      assert.equal(report.results.failed, 1);
      assert.equal(readJsonLines(path.join(outputDir, 'failed.jsonl')).length, 1);
    }));
  }

  test('Retry phục hồi chỉ ghi success', async () => withTempDir(async (outputDir) => {
    const client = createSequenceHttpClient([httpError(500), { status: 201, data: { ok: true } }]);
    const report = await run(testConfig(), { sessionDir: outputDir, httpClient: client, delay: async () => {} });
    assert.equal(client.calls.length, 2);
    assert.equal(report.results.success, 1);
    assert.equal(report.results.failed, 0);
    assert.equal(readJsonLines(path.join(outputDir, 'success.jsonl')).length, 1);
    assert.equal(readJsonLines(path.join(outputDir, 'failed.jsonl')).length, 0);
  }));

  test('Streaming raw export xử lý 50.000 bản ghi', async () => withTempDir(async (outputDir) => {
    const config = testConfig(50000);
    config.execution.batchSize = 500;
    config.execution.concurrency = 20;
    let calls = 0;
    const client = { async post() { calls += 1; return { status: 201, data: null }; } };
    const report = await run(config, { sessionDir: outputDir, httpClient: client, delay: async () => {} });
    assert.equal(calls, 50000);
    assert.equal(report.results.success, 50000);
    assert.equal(readJsonLines(path.join(outputDir, 'mock_data_export.json')).length, 50000);
  }));

  const results = [];
  for (const item of tests) {
    const startedAt = Date.now();
    try {
      await item.callback();
      results.push({ Test: item.name, Kết_quả: 'PASS', Thời_gian_ms: Date.now() - startedAt });
    } catch (error) {
      results.push({ Test: item.name, Kết_quả: 'FAIL', Thời_gian_ms: Date.now() - startedAt });
      console.error(`\nFAIL: ${item.name}\n${error.stack}`);
    }
  }
  console.table(results);
  const failed = results.filter((result) => result.Kết_quả === 'FAIL').length;
  console.log(`Kết quả: ${results.length - failed}/${results.length} test PASS.`);
  if (failed > 0) throw new Error(`${failed} test thất bại.`);
}

const demoConfig = {
  api: {
    endpoint: 'https://jsonplaceholder.typicode.com/posts',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  },
  execution: { totalRecords: 100, batchSize: 20, concurrency: 5 },
  schema: {
    id: { type: 'uuid' },
    fullName: { type: 'vn.fullName' },
    email: { type: 'vn.email', unique: true, dependsOn: 'fullName', transform: 'slugify', domain: 'gmail.com' },
    phone: { type: 'vn.phone', unique: true },
    nationalId: { type: 'vn.nationalId', unique: true },
  },
};

async function main() {
  if (process.argv.includes('--test')) return runSelfTests();
  const totalRecords = await promptTotalRecords();
  const config = structuredClone(demoConfig);
  config.execution.totalRecords = totalRecords;
  const report = await run(config);
  console.table([
    { Chỉ_số: 'Tổng số request', Giá_trị: report.results.total },
    { Chỉ_số: 'Thành công', Giá_trị: report.results.success },
    { Chỉ_số: 'Thất bại', Giá_trị: report.results.failed },
    { Chỉ_số: 'Tổng thời gian (ms)', Giá_trị: report.durationMs },
  ]);
  console.log(`Thư mục kết quả: ${report.sessionDirectory}`);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    if (error.report?.sessionDirectory) console.error(`Thư mục kết quả: ${error.report.sessionDirectory}`);
    process.exitCode = 1;
  });
}

export {
  FatalHttpError,
  UniqueConstraintError,
  createLogManager,
  createSessionDirectory,
  demoConfig,
  exportRawData,
  generateRecord,
  isRetryableError,
  promptTotalRecords,
  readRawData,
  run,
  runSelfTests,
  sendWithRetry,
  slugify,
  topologicalSort,
  validateConfiguration,
};
