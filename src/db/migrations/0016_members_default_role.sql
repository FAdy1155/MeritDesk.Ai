-- Roles without Clerk's custom roles (README "Clerk"): Clerk keeps only its
-- two default organization roles. Its Admin (org:admin) is the app's
-- owner_admin; every other member is a Member (org:member) whose app role
-- (attorney, paralegal or read_only) is memberships.role, set by an
-- owner/admin in the Members section of the Firm page. A member the firm
-- has not given a role yet is read_only, so the column's default follows
-- (it was paralegal). No rows change: every row is written with an explicit
-- role by the org sync, the create-firm action or the Members section.
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'read_only';
