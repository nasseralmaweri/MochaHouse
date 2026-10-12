-- A parent/child mismatch: a campaign already owned by business A whose
-- image belongs to business B. Fictional data only.
INSERT INTO "Campaign"(id, name, "mediaAssetId", "updatedAt", "tenantId") VALUES ('x-camp-mismatch', 'Mixed', 'b-media', now(), '01a0db02-f800-7000-8000-000000000001');
