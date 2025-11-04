CREATE DATABASE IF NOT EXISTS crm;
USE crm;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dni TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supply_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  cups TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supply_point_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  tariff_code TEXT NOT NULL,
  tariff_name TEXT NOT NULL,
  status TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  FOREIGN KEY (supply_point_id) REFERENCES supply_points(id)
);

CREATE INDEX IF NOT EXISTS idx_customers_dni ON customers(dni);
CREATE INDEX IF NOT EXISTS idx_supply_points_cups ON supply_points(cups);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_order_id ON contracts(order_id);

CREATE DATABASE IF NOT EXISTS billing;
USE billing;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_customer_id INTEGER NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dni TEXT NOT NULL,
  crm_created_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crm_contract_id INTEGER NOT NULL UNIQUE,
  crm_customer_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  tariff_code TEXT NOT NULL,
  tariff_name TEXT NOT NULL,
  crm_status TEXT NOT NULL,
  crm_recorded_at TEXT NOT NULL,
  billing_status TEXT NOT NULL DEFAULT 'pending',
  cups TEXT,
  last_event_at TEXT NOT NULL,
  FOREIGN KEY (crm_customer_id) REFERENCES customers(crm_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_customers_dni ON customers(dni);
CREATE INDEX IF NOT EXISTS idx_billing_contracts_customer ON contracts(crm_customer_id);
