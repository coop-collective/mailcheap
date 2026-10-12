-- JSON documents retain public IDs and optional fields; all queries, counters, joins,
-- filters and uniqueness are enforced in SQLite. Dates are UTC epoch milliseconds.
CREATE TABLE newsletters (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX newsletters_id ON newsletters (json_extract(document, '$._id'));

CREATE TABLE campaigns (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX campaigns_id ON campaigns (json_extract(document, '$._id'));

CREATE TABLE contacts (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX contacts_id ON contacts (json_extract(document, '$._id'));

CREATE TABLE messages (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX messages_id ON messages (json_extract(document, '$._id'));

CREATE TABLE suppressions (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX suppressions_id ON suppressions (json_extract(document, '$._id'));

CREATE TABLE events (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX events_id ON events (json_extract(document, '$._id'));

CREATE TABLE alerts (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX alerts_id ON alerts (json_extract(document, '$._id'));

CREATE TABLE apikeys (document TEXT NOT NULL CHECK (json_valid(document)));
CREATE UNIQUE INDEX apikeys_id ON apikeys (json_extract(document, '$._id'));

CREATE UNIQUE INDEX newsletters_slug ON newsletters (json_extract(document, '$.slug'));
CREATE INDEX newsletters_created ON newsletters (json_extract(document, '$.createdAt'));
CREATE UNIQUE INDEX campaigns_archive_slug ON campaigns (json_extract(document, '$.archiveSlug')) WHERE json_type(document, '$.archiveSlug') = 'text';
CREATE INDEX campaigns_newsletter_created ON campaigns (json_extract(document, '$.newsletterId'), json_extract(document, '$.createdAt') DESC);
CREATE INDEX campaigns_status_schedule ON campaigns (json_extract(document, '$.status'), json_extract(document, '$.scheduledAt'));
CREATE INDEX campaigns_started ON campaigns (json_extract(document, '$.startedAt') DESC);
CREATE INDEX campaigns_newsletter_archive ON campaigns (json_extract(document, '$.newsletterId'), json_extract(document, '$.status'), json_extract(document, '$.sentAt') DESC, json_extract(document, '$.startedAt') DESC);
CREATE UNIQUE INDEX contacts_newsletter_email ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.email'));
CREATE INDEX contacts_email ON contacts (json_extract(document, '$.email'));
CREATE INDEX contacts_subscribed ON contacts (json_extract(document, '$.subscribedAt') DESC, json_extract(document, '$._id') DESC);
CREATE INDEX contacts_status_subscribed ON contacts (json_extract(document, '$.status'), json_extract(document, '$.subscribedAt') DESC, json_extract(document, '$._id') DESC);
CREATE INDEX contacts_newsletterId_subscribed ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.subscribedAt') DESC, json_extract(document, '$._id') DESC);
CREATE INDEX contacts_newsletterId_status_subscribed ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.status'), json_extract(document, '$.subscribedAt') DESC, json_extract(document, '$._id') DESC);
CREATE INDEX contacts_newsletter_created ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.status'), json_extract(document, '$.createdAt') DESC);
CREATE INDEX contacts_cleanup ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.lastChanceAt')) WHERE json_type(document, '$.lastChanceAt') IS NOT NULL;
CREATE INDEX contacts_audience ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.status'), json_extract(document, '$.lastClickAt') DESC, json_extract(document, '$.lastOpenAt') DESC, json_extract(document, '$.imported.clickRate') DESC, json_extract(document, '$.imported.openRate') DESC, json_extract(document, '$.createdAt'), json_extract(document, '$._id'));
CREATE INDEX contacts_joins ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.status'), json_extract(document, '$.subscribedAt'));
CREATE INDEX contacts_leaves ON contacts (json_extract(document, '$.newsletterId'), json_extract(document, '$.unsubscribedAt'));
CREATE UNIQUE INDEX messages_campaign_contact ON messages (json_extract(document, '$.campaignId'), json_extract(document, '$.contactId')) WHERE json_extract(document, '$.kind') = 'campaign';
CREATE UNIQUE INDEX messages_last_chance ON messages (json_extract(document, '$.campaignId'), json_extract(document, '$.contactId'), json_extract(document, '$.kind')) WHERE json_extract(document, '$.kind') = 'last-chance';
CREATE UNIQUE INDEX messages_provider_id ON messages (json_extract(document, '$.providerMessageId')) WHERE json_type(document, '$.providerMessageId') = 'text';
CREATE INDEX messages_kind_created ON messages (json_extract(document, '$.kind'), json_extract(document, '$.createdAt') DESC);
CREATE INDEX messages_newsletter_sent ON messages (json_extract(document, '$.newsletterId'), json_extract(document, '$.sentAt'));
CREATE INDEX messages_campaign_status ON messages (json_extract(document, '$.campaignId'), json_extract(document, '$.status'));
CREATE INDEX messages_queued ON messages (json_extract(document, '$.status'), json_extract(document, '$.createdAt'), json_extract(document, '$._id'));
CREATE INDEX messages_contact_kind ON messages (json_extract(document, '$.contactId'), json_extract(document, '$.kind'), json_extract(document, '$.createdAt') DESC);
CREATE UNIQUE INDEX suppressions_email ON suppressions (json_extract(document, '$.email'));
CREATE INDEX suppressions_created ON suppressions (json_extract(document, '$.createdAt'));
CREATE INDEX events_provider_message ON events (json_extract(document, '$.providerMessageId'));
CREATE UNIQUE INDEX events_provider_event ON events (json_extract(document, '$.providerEventId')) WHERE json_type(document, '$.providerEventId') = 'text';
CREATE INDEX events_campaign_type ON events (json_extract(document, '$.campaignId'), json_extract(document, '$.type'));
CREATE UNIQUE INDEX alerts_key ON alerts (json_extract(document, '$.key'));
CREATE UNIQUE INDEX apikeys_hash ON apikeys (json_extract(document, '$.hash'));
