CREATE DATABASE IF NOT EXISTS test_metrics;
USE test_metrics;

CREATE TABLE IF NOT EXISTS message_metrics (
  source TEXT NOT NULL PRIMARY KEY,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
