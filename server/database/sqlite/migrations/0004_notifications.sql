-- Per-device push metadata.
--
-- Subscription rows are already one per browser; these columns let the
-- settings dialog name each device and show when it was last seen. They are
-- optional so old rows keep working.

alter table push_subscriptions add column label text;
alter table push_subscriptions add column user_agent text;
alter table push_subscriptions add column last_seen_at text;
