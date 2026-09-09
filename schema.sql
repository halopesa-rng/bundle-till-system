CREATE TABLE IF NOT EXISTS bundles (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL CHECK (price > 0),
  network TEXT NOT NULL DEFAULT 'Safaricom',
  provider_code TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sold_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  order_reference TEXT UNIQUE NOT NULL,
  bundle_id UUID REFERENCES bundles(id),
  bundle_name TEXT,
  phone TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  delivery_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  transaction_id UUID,
  provider_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  phone TEXT,
  amount NUMERIC(12,2) NOT NULL,
  account_reference TEXT,
  payment_status TEXT NOT NULL DEFAULT 'SUCCESS',
  raw_payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'SUCCESS',
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(order_reference);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(payment_status, delivery_status);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_received ON transactions(received_at DESC);
