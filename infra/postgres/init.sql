-- Extensions used by full-text search (unaccent for Albanian ë/ç), fuzzy title match and case-insensitive emails.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
