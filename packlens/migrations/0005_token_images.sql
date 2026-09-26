-- Token logos for display only (never read by detection, patterns, or Smart
-- Money). Live mode resolves them in the background from the token's pump.fun
-- metadata URI and stores a small raster image, so pages never contact
-- creator-chosen hosts. state: ok (bytes stored), missing (no usable image;
-- not retried), failed (transient error; retried with backoff).
CREATE TABLE token_images (
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'missing', 'failed')),
  source_url TEXT,
  content_type TEXT CHECK (content_type IS NULL OR content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif')),
  bytes BLOB,
  sha256 TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  checked_at_ms INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (namespace, chain, mint),
  CHECK ((state = 'ok') = (bytes IS NOT NULL AND content_type IS NOT NULL AND sha256 IS NOT NULL))
);
