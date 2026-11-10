-- 1. جدول إعدادات المتجر المركزية
CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. جدول الكتالوج التجاري المستقل (يفصل بيانات المورد Zfour عن البيانات التسويقية)
CREATE TABLE IF NOT EXISTS products_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_product_id TEXT NOT NULL UNIQUE,
  supplier_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  features TEXT DEFAULT '[]',
  image_url TEXT DEFAULT NULL,
  category_name TEXT DEFAULT 'اشتراكات رقمية',
  badge_text TEXT DEFAULT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  promotional_price REAL DEFAULT NULL,
  currency TEXT NOT NULL DEFAULT 'YER',
  stock INTEGER NOT NULL DEFAULT 0,
  min_qty INTEGER NOT NULL DEFAULT 1,
  max_qty INTEGER NOT NULL DEFAULT 500,
  bulk_discounts_json TEXT DEFAULT '[]',
  supplier_status TEXT NOT NULL DEFAULT 'active',
  publish_status TEXT NOT NULL DEFAULT 'draft',
  display_order INTEGER NOT NULL DEFAULT 0,
  margin_alert INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. جدول الطلبات والمدفوعات والتوريد
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_contact TEXT NOT NULL,
  customer_notes TEXT DEFAULT '',
  items_snapshot TEXT NOT NULL,
  total_amount_yer REAL NOT NULL,
  confirmed_amount_yer REAL DEFAULT NULL,
  payment_currency TEXT NOT NULL DEFAULT 'YER',
  exchange_rate_snapshot REAL NOT NULL DEFAULT 2050,
  expected_cost_usdt REAL NOT NULL DEFAULT 0,
  supplier_cost_usdt REAL DEFAULT 0,
  supplier_cost_yer REAL DEFAULT 0,
  net_profit_yer REAL DEFAULT 0,
  esaalat_intent_id TEXT UNIQUE,
  esaalat_code TEXT DEFAULT NULL,
  esaalat_status TEXT DEFAULT 'PENDING',
  payment_reference TEXT DEFAULT NULL,
  wallet_id TEXT NOT NULL,
  wallet_name TEXT DEFAULT '',
  wallet_account TEXT DEFAULT '',
  pay_url TEXT DEFAULT NULL,
  order_status TEXT NOT NULL DEFAULT 'pending_payment',
  fulfillment_lock INTEGER NOT NULL DEFAULT 0,
  zfour_order_id TEXT DEFAULT NULL,
  delivered_items TEXT DEFAULT NULL,
  fulfillment_error TEXT DEFAULT NULL,
  customer_message TEXT DEFAULT '',
  payment_verified_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(payment_reference, wallet_id);
CREATE INDEX IF NOT EXISTS idx_orders_intent ON orders(esaalat_intent_id);

-- 4. دفتر أستاذ أرباح المنتجات التفصيلي
CREATE TABLE IF NOT EXISTS order_items_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  catalog_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  revenue_yer REAL NOT NULL,
  cost_usdt REAL NOT NULL,
  cost_yer REAL NOT NULL,
  net_profit_yer REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. جدول منع تكرار معالجة Webhooks
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  intent_id TEXT DEFAULT NULL,
  order_id TEXT DEFAULT NULL,
  raw_payload TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. جدول المصروفات التشغيلية
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  amount_yer REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'YER',
  category TEXT NOT NULL DEFAULT 'admin',
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. سجل التدقيق والعمليات الحساسة (Audit Log)
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
