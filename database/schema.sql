-- Run this SQL on your Northflank PostgreSQL database
-- to create the necessary state table for ThrowBox.

CREATE TABLE IF NOT EXISTS throwbox_state (
  id TEXT PRIMARY KEY,
  game_objects JSONB NOT NULL DEFAULT '[]',
  transfer_history JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Note: You should set up Row Level Security (RLS) 
-- if you plan to access this database directly from the frontend.
-- Since the server currently uses a direct connection with 
-- full privileges, RLS is optional but recommended.
