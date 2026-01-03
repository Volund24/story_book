-- Drop tables if they exist (optional, use with caution)
-- DROP TABLE IF EXISTS users;
-- DROP TABLE IF EXISTS config;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tokens INTEGER DEFAULT 3,
    last_generation BIGINT DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    wallet_address TEXT,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    matches_played INTEGER DEFAULT 0
);

-- Create config table
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Insert default cooldown if not exists
INSERT INTO config (key, value) VALUES ('cooldown_ms', '86400000') ON CONFLICT (key) DO NOTHING;
