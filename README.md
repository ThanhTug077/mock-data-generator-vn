# Mock Data Generator VN

A powerful Vietnamese mock data generator built with Node.js. Generates realistic customer data (names, emails, phones, national IDs, etc.) and sends it to a REST API with retry logic, concurrency control, and comprehensive reporting.

## Features

- **Realistic Vietnamese Data** — full names, emails, phone numbers, national IDs, addresses (uses `@faker-js/faker` with Vietnamese locale)
- **Unique Field Constraints** — ensures uniqueness for fields like email, phone, national ID with collision detection
- **Field Dependencies** — fields can depend on and transform others (e.g., email derived from full name via slugify)
- **Streaming Export** — generates and exports large datasets (tested with 50,000+ records) to JSON without memory issues
- **HTTP API Integration** — sends generated records to a REST API with automatic retry for transient errors (5xx, timeout, DNS failures)
- **Concurrency & Batching** — configurable batch size and concurrency limit using `p-limit`
- **Fatal Error Handling** — stops immediately on 401/403 responses
- **Session Management** — each run creates a timestamped output directory with all artifacts
- **Detailed Reporting** — generates a JSON report with success/failure counts, response times (avg, min, max, p95), throughput, error breakdown
- **Self-Tests** — built-in test suite to verify all components

## Requirements

- Node.js >= 18 (ESM)

## Installation

```bash
git clone <repo-url>
cd mock-data-generator-vn
npm install
```

## Usage

### Generate & Send Data

```bash
node index.js
```

You will be prompted to enter the number of records to generate. The tool will:
1. Generate mock data and export to `outputs/session_<timestamp>/mock_data_export.json`
2. Send each record to the configured API endpoint with retry logic
3. Write success/failure logs and a final report

### Run Self-Tests

```bash
npm test
# or
node index.js --test
```

## Output Structure

```
outputs/
  session_20260609_191530/
    mock_data_export.json   # Raw generated data (JSON Lines)
    success.jsonl            # Successful API requests
    failed.jsonl             # Failed API requests (with error details)
    report.json              # Performance & summary report
```

## Configuration

The default configuration is defined as `demoConfig` in `index.js`. You can modify it directly or extend it:

```js
const config = {
  api: {
    endpoint: 'https://your-api.com/endpoint',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  },
  execution: {
    totalRecords: 100,    // Number of records to generate
    batchSize: 20,        // Records per batch
    concurrency: 5,       // Concurrent API requests
  },
  schema: {
    id:          { type: 'uuid' },
    fullName:    { type: 'vn.fullName' },
    email:       { type: 'vn.email', unique: true, dependsOn: 'fullName', transform: 'slugify', domain: 'gmail.com' },
    phone:       { type: 'vn.phone', unique: true },
    nationalId:  { type: 'vn.nationalId', unique: true },
  },
};
```

### Supported Field Types

| Type              | Description                        | Options                                  |
| ----------------- | ---------------------------------- | ---------------------------------------- |
| `uuid`            | Random UUID                        | —                                        |
| `vn.fullName`     | Vietnamese full name               | —                                        |
| `vn.firstName`    | Vietnamese first name              | —                                        |
| `vn.lastName`     | Vietnamese last name               | —                                        |
| `vn.email`        | Vietnamese email                   | `domain` (default: `gmail.com`)          |
| `vn.phone`        | Vietnamese phone number            | —                                        |
| `vn.nationalId`   | Vietnamese national ID (CCCD)      | —                                        |
| `vn.address.full` | Vietnamese street address          | —                                        |
| `string`          | Random word or dependency value    | —                                        |
| `integer`         | Random integer                     | `min`, `max`                             |
| `float`           | Random float                       | `min`, `max`, `decimals`                 |
| `boolean`         | Random boolean                     | —                                        |
| `date`            | Random date (ISO 8601)             | `startDate`, `endDate`                   |
| `datetime`        | Random datetime (ISO 8601)         | `startDate`, `endDate`                   |
| `null`            | Always `null`                      | —                                        |
| `enum`            | Random pick from array             | `enum: ['value1', 'value2', ...]`        |

### Field Options

- `unique: true` — ensures the generated value is unique across all records
- `dependsOn: '<field>'` — derives value from another field
- `transform: 'slugify' | 'uppercase' | 'lowercase' | 'trim'` — transforms the dependency value

## Architecture

The tool operates in two phases:

1. **Generate Phase** — All mock data is generated and streamed to `mock_data_export.json` before any API call is made. This ensures data integrity and allows inspection before sending.
2. **Send Phase** — Records are read from the exported file and sent to the API in configurable batches with bounded concurrency.

## Retry Logic

| HTTP Status / Error       | Behavior                          |
| ------------------------- | --------------------------------- |
| 401, 403                  | Stop immediately (fatal)          |
| 429, 5xx                  | Retry up to 3 times with 1s delay |
| Timeout / DNS / ECONNRESET| Retry up to 3 times with 1s delay |
| 4xx (non-401/403)         | No retry, log as failed           |

## License

MIT
