// Playground presets. Each scenario pairs a contract with an upstream payload.

const payments = {
  id: 'payments.v1',
  schema: {
    type: 'object',
    required: ['event', 'customer', 'amount'],
    additionalProperties: false,
    properties: {
      event: { type: 'string' },
      amount: { type: 'number', minimum: 0 },
      currency: { type: 'string' },
      customer: {
        type: 'object',
        required: ['email', 'id'],
        properties: { email: { type: 'string' }, id: { type: 'string' } },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku'],
          properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
        },
      },
    },
  },
  mapHints: ['/metadata'],
};

const customers = {
  id: 'customers.v1',
  schema: {
    type: 'object',
    required: ['customers'],
    properties: {
      customers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'email'],
          properties: {
            id: { type: 'integer' },
            email: { type: 'string' },
            postal_code: { type: 'string' },
            lifetime_value: { type: 'number' },
          },
        },
      },
    },
  },
};

const sms = {
  id: 'sms.v1',
  schema: {
    type: 'object',
    required: ['from', 'to', 'body'],
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      body: { type: 'string' },
      media: { type: 'array', items: { type: 'string' } },
    },
  },
};

const v1 = {
  event: 'payment_success',
  customer: { email: 'ana@example.com', id: 'cus_8812' },
  amount: 49.5,
  currency: 'INR',
  items: [{ sku: 'sku_tee_blk', quantity: 2 }],
};

const json = (v) => JSON.stringify(v, null, 2);

export const scenarios = [
  {
    key: 'baseline', label: 'Baseline v1', contract: payments, type: 'application/json', body: json(v1),
    explain: 'First sighting of this structure. The matcher maps it exactly and the rule activates. Send it again to see a cache hit.',
  },
  {
    key: 'added', label: 'Field added', contract: payments, type: 'application/json',
    body: json({ ...v1, livemode: true, metadata: { campaign: 'diwali', utm_source: 'hn' } }),
    explain: 'New fields appeared, but none the rule reads changed. The new fingerprint is absorbed into the existing rule. (Run Baseline first.)',
  },
  {
    key: 'null', label: 'Optional → null', contract: payments, type: 'application/json', body: json({ ...v1, items: null }),
    explain: 'An optional field started arriving as null. Null counts as absent, so this is absorbed too.',
  },
  {
    key: 'renamed', label: 'Renamed (v2 API)', contract: payments, type: 'application/json',
    body: json({
      event_type: 'payment_success',
      buyer: { email_addr: 'ana@example.com', id: 8812 },
      subtotal: 49.5,
      currency_code: 'INR',
      line_items: [{ sku: 'sku_tee_blk', qty: 2 }],
    }),
    explain: 'The upstream shipped a new version: six renames and a number where a string used to be. Healed deterministically, with no model.',
  },
  {
    key: 'retyped', label: 'Type change', contract: payments, type: 'application/json',
    body: json({ ...v1, customer: { email: 'ana@example.com', id: 8812 } }),
    explain: 'customer.id became a number. Absorption refuses type drift, so a new rule is synthesized with cast: "string".',
  },
  {
    key: 'risky', label: 'Risky cast → review', contract: payments, type: 'application/json',
    body: json({
      event_type: 'payment_success',
      buyer: { email_addr: 'ana@example.com', id: 8812 },
      subtotal: 49.5,
      line_items: [{ sku: 'sku_tee_blk', qty: '2' }],
    }),
    explain: 'Quantity arrives as a string. String→integer is risky, so confidence falls below 0.8. The rule goes to shadow and the payload is held until you approve it.',
  },
  {
    key: 'broken', label: 'Breaking change', contract: payments, type: 'application/json',
    body: json({ event_type: 'payment_success', buyer: { id: 8812 } }),
    explain: 'Required fields are gone. Nothing valid can be produced, so the payload is quarantined, never delivered half-formed.',
  },
  {
    key: 'map', label: 'Dynamic keys', contract: payments, type: 'application/json',
    body: json({ ...v1, metadata: { order_9f3a: 'x', 'ana@example.com': 'vip' } }),
    explain: 'metadata has a mapHint, so its keys — even an email address — never enter the shape. Edit the keys: the fingerprint will not change.',
  },
  {
    key: 'csv', label: 'CSV drop', contract: customers, type: 'text/csv',
    body: 'ID,Email Address,ZIP,Lifetime Value\n101,ana@example.com,560001,1499.00\n102,"li, wei@example.org",01234,0\n',
    explain: 'A partner sends CSV. Every cell is a string (so ZIP 01234 survives); casts are explicit. Moderate name matches → held for review.',
  },
  {
    key: 'form', label: 'Form-encoded SMS', contract: sms, type: 'application/x-www-form-urlencoded',
    body: 'From=%2B919800000001&To=%2B919800000002&Body=Order+shipped&MediaUrl[]=https%3A%2F%2Fexample.com%2Fa.jpg',
    explain: 'A legacy form-urlencoded webhook, normalized to a JSON contract.',
  },
];

export const contracts = { payments, customers, sms };
