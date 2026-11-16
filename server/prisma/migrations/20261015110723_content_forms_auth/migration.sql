-- Extensions (also created by infra/postgres/init.sql; needed here for fresh and shadow databases)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('sq', 'en', 'sr');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('PUBLISHED', 'DRAFT');

-- CreateEnum
CREATE TYPE "DetailType" AS ENUM ('TEXT', 'NONE', 'LINK');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "RevisionSource" AS ENUM ('LEGACY', 'APP');

-- CreateEnum
CREATE TYPE "Bucket" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('DATE', 'TEXT', 'TEXTAREA', 'DROPDOWN', 'EMAIL', 'FILE', 'RADIO', 'HEADING');

-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('NONE', 'PII', 'ENCRYPTED');

-- CreateEnum
CREATE TYPE "EmailActionKind" AS ENUM ('NOTIFY', 'CONFIRM');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('NONE_LEGACY', 'FORM');

-- CreateEnum
CREATE TYPE "RedirectSource" AS ENUM ('TAB', 'PAGE', 'MANUAL');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "username" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "isSuperUser" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legacyId" INTEGER,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" INTEGER NOT NULL,
    "roleId" INTEGER NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" INTEGER NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permission")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "parentId" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryTranslation" (
    "categoryId" INTEGER NOT NULL,
    "lang" "Lang" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "CategoryTranslation_pkey" PRIMARY KEY ("categoryId","lang")
);

-- CreateTable
CREATE TABLE "Program" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramTranslation" (
    "programId" INTEGER NOT NULL,
    "lang" "Lang" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ProgramTranslation_pkey" PRIMARY KEY ("programId","lang")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "status" "ArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "publishAt" TIMESTAMP(3) NOT NULL,
    "expireAt" TIMESTAMP(3),
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "detailType" "DetailType" NOT NULL DEFAULT 'TEXT',
    "linkUrl" TEXT,
    "linkTarget" TEXT,
    "coverFileId" INTEGER,
    "legacyCoverPath" TEXT,
    "showCover" BOOLEAN NOT NULL DEFAULT true,
    "showGallery" BOOLEAN NOT NULL DEFAULT true,
    "publicationYear" INTEGER,
    "analyticalType" TEXT,
    "hideDefaultLocale" BOOLEAN NOT NULL DEFAULT false,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "authorId" INTEGER,
    "legacyGalleryId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleTranslation" (
    "articleId" INTEGER NOT NULL,
    "lang" "Lang" NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "summary" TEXT,
    "bodyHtml" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "slug" TEXT NOT NULL,
    "legacySlug" TEXT,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "metaKeywords" TEXT,
    "ogJson" JSONB,
    "coverTitle" TEXT,
    "coverDescription" TEXT,
    "documentTitles" TEXT NOT NULL DEFAULT '',
    "search" tsvector,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleTranslation_pkey" PRIMARY KEY ("articleId","lang")
);

-- CreateTable
CREATE TABLE "ArticleCategory" (
    "articleId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,

    CONSTRAINT "ArticleCategory_pkey" PRIMARY KEY ("articleId","categoryId")
);

-- CreateTable
CREATE TABLE "ArticleProgram" (
    "articleId" INTEGER NOT NULL,
    "programId" INTEGER NOT NULL,

    CONSTRAINT "ArticleProgram_pkey" PRIMARY KEY ("articleId","programId")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "fileId" INTEGER,
    "legacyPath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "allLanguages" BOOLEAN NOT NULL DEFAULT true,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "openInNewTab" BOOLEAN NOT NULL DEFAULT false,
    "uploadedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleDocument" (
    "articleId" INTEGER NOT NULL,
    "documentId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArticleDocument_pkey" PRIMARY KEY ("articleId","documentId")
);

-- CreateTable
CREATE TABLE "GalleryItem" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "articleId" INTEGER,
    "legacyGalleryId" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE',
    "fileId" INTEGER,
    "legacyPath" TEXT,
    "embedUrl" TEXT,
    "title" TEXT,
    "description" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "isCoverCopy" BOOLEAN NOT NULL DEFAULT false,
    "uploadedAt" TIMESTAMP(3),

    CONSTRAINT "GalleryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleRevision" (
    "id" SERIAL NOT NULL,
    "articleId" INTEGER NOT NULL,
    "legacyId" INTEGER,
    "source" "RevisionSource" NOT NULL DEFAULT 'APP',
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,

    CONSTRAINT "ArticleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "File" (
    "id" SERIAL NOT NULL,
    "bucket" "Bucket" NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mime" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileVariant" (
    "id" SERIAL NOT NULL,
    "fileId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,

    CONSTRAINT "FileVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyPath" (
    "path" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "fileId" INTEGER,
    "found" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LegacyPath_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "HtmlBlock" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "lang" "Lang" NOT NULL,
    "html" TEXT NOT NULL DEFAULT '',
    "title" TEXT,
    "pageKey" TEXT,
    "pane" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isLive" BOOLEAN NOT NULL DEFAULT true,
    "legacyModuleId" INTEGER,
    "legacyTabId" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HtmlBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HtmlBlockRevision" (
    "id" SERIAL NOT NULL,
    "blockId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "html" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "legacyItemId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,

    CONSTRAINT "HtmlBlockRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageMeta" (
    "id" SERIAL NOT NULL,
    "routeKey" TEXT NOT NULL,
    "lang" "Lang" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "keywords" TEXT,
    "headHtml" TEXT,
    "externalUrl" TEXT,
    "inMenu" BOOLEAN NOT NULL DEFAULT true,
    "requiredPermission" TEXT,
    "legacyTabId" INTEGER,
    "legacyName" TEXT,

    CONSTRAINT "PageMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Form" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "lang" "Lang" NOT NULL,
    "title" TEXT NOT NULL,
    "legacyModuleId" INTEGER,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "isBackup" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormField" (
    "id" SERIAL NOT NULL,
    "formId" INTEGER NOT NULL,
    "legacyFieldId" INTEGER,
    "code" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "help" TEXT,
    "info" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB,
    "properties" JSONB,
    "sensitivity" "Sensitivity" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "FormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormEmailAction" (
    "id" SERIAL NOT NULL,
    "formId" INTEGER NOT NULL,
    "legacyId" INTEGER,
    "kind" "EmailActionKind" NOT NULL,
    "toAddresses" TEXT,
    "toFieldCode" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FormEmailAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentNotice" (
    "id" SERIAL NOT NULL,
    "formId" INTEGER NOT NULL,
    "lang" "Lang" NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" SERIAL NOT NULL,
    "formId" INTEGER NOT NULL,
    "legacyItemId" INTEGER,
    "lang" "Lang" NOT NULL,
    "attachmentKey" TEXT,
    "consentNoticeId" INTEGER,
    "consentAt" TIMESTAMP(3),
    "consentSource" "ConsentSource" NOT NULL DEFAULT 'FORM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" INTEGER,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionValue" (
    "id" SERIAL NOT NULL,
    "submissionId" INTEGER NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "valueText" TEXT,
    "valueDate" TIMESTAMP(3),
    "valueNumber" DECIMAL(65,30),
    "valueEnc" BYTEA,
    "encKid" TEXT,
    "fileId" INTEGER,

    CONSTRAINT "SubmissionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactMessage" (
    "id" SERIAL NOT NULL,
    "legacyId" INTEGER,
    "lang" "Lang" NOT NULL,
    "legacyModuleId" INTEGER,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "street" TEXT,
    "city" TEXT,
    "country" TEXT,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "legacyStatus" INTEGER,
    "spamFlag" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redirect" (
    "id" SERIAL NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT,
    "code" INTEGER NOT NULL DEFAULT 301,
    "source" "RedirectSource" NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyUrl" (
    "id" INTEGER NOT NULL,
    "linkType" INTEGER NOT NULL,
    "tabId" INTEGER NOT NULL,
    "moduleId" INTEGER,
    "articleId" INTEGER,
    "categoryId" INTEGER,
    "authorId" INTEGER,
    "slug" TEXT NOT NULL,

    CONSTRAINT "LegacyUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" INTEGER,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "meta" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" SERIAL NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "counts" JSONB,
    "message" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_legacyId_key" ON "User"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Role_legacyId_key" ON "Role"("legacyId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Category_legacyId_key" ON "Category"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Program_legacyId_key" ON "Program"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Program_key_key" ON "Program"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Article_legacyId_key" ON "Article"("legacyId");

-- CreateIndex
CREATE INDEX "Article_status_publishAt_idx" ON "Article"("status", "publishAt");

-- CreateIndex
CREATE INDEX "Article_featured_idx" ON "Article"("featured");

-- CreateIndex
CREATE INDEX "ArticleTranslation_lang_slug_idx" ON "ArticleTranslation"("lang", "slug");

-- CreateIndex
CREATE INDEX "ArticleCategory_categoryId_idx" ON "ArticleCategory"("categoryId");

-- CreateIndex
CREATE INDEX "ArticleProgram_programId_idx" ON "ArticleProgram"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_legacyId_key" ON "Document"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "GalleryItem_legacyId_key" ON "GalleryItem"("legacyId");

-- CreateIndex
CREATE INDEX "GalleryItem_articleId_position_idx" ON "GalleryItem"("articleId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleRevision_legacyId_key" ON "ArticleRevision"("legacyId");

-- CreateIndex
CREATE INDEX "ArticleRevision_articleId_createdAt_idx" ON "ArticleRevision"("articleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "File_storageKey_key" ON "File"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "File_bucket_sha256_key" ON "File"("bucket", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "FileVariant_storageKey_key" ON "FileVariant"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "FileVariant_fileId_kind_key" ON "FileVariant"("fileId", "kind");

-- CreateIndex
CREATE INDEX "HtmlBlock_pageKey_lang_idx" ON "HtmlBlock"("pageKey", "lang");

-- CreateIndex
CREATE UNIQUE INDEX "HtmlBlock_key_lang_key" ON "HtmlBlock"("key", "lang");

-- CreateIndex
CREATE UNIQUE INDEX "HtmlBlockRevision_legacyItemId_key" ON "HtmlBlockRevision"("legacyItemId");

-- CreateIndex
CREATE INDEX "HtmlBlockRevision_blockId_version_idx" ON "HtmlBlockRevision"("blockId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PageMeta_legacyTabId_key" ON "PageMeta"("legacyTabId");

-- CreateIndex
CREATE UNIQUE INDEX "PageMeta_routeKey_lang_key" ON "PageMeta"("routeKey", "lang");

-- CreateIndex
CREATE UNIQUE INDEX "Form_key_key" ON "Form"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Form_legacyModuleId_key" ON "Form"("legacyModuleId");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_legacyFieldId_key" ON "FormField"("legacyFieldId");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_formId_code_key" ON "FormField"("formId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "FormEmailAction_legacyId_key" ON "FormEmailAction"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentNotice_formId_lang_version_key" ON "ConsentNotice"("formId", "lang", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_legacyItemId_key" ON "Submission"("legacyItemId");

-- CreateIndex
CREATE INDEX "Submission_formId_createdAt_idx" ON "Submission"("formId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionValue_submissionId_fieldId_key" ON "SubmissionValue"("submissionId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactMessage_legacyId_key" ON "ContactMessage"("legacyId");

-- CreateIndex
CREATE INDEX "ContactMessage_createdAt_idx" ON "ContactMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_fromPath_key" ON "Redirect"("fromPath");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryTranslation" ADD CONSTRAINT "CategoryTranslation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramTranslation" ADD CONSTRAINT "ProgramTranslation_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_coverFileId_fkey" FOREIGN KEY ("coverFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleTranslation" ADD CONSTRAINT "ArticleTranslation_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCategory" ADD CONSTRAINT "ArticleCategory_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCategory" ADD CONSTRAINT "ArticleCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleProgram" ADD CONSTRAINT "ArticleProgram_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleProgram" ADD CONSTRAINT "ArticleProgram_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleDocument" ADD CONSTRAINT "ArticleDocument_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleDocument" ADD CONSTRAINT "ArticleDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GalleryItem" ADD CONSTRAINT "GalleryItem_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GalleryItem" ADD CONSTRAINT "GalleryItem_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRevision" ADD CONSTRAINT "ArticleRevision_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVariant" ADD CONSTRAINT "FileVariant_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyPath" ADD CONSTRAINT "LegacyPath_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HtmlBlockRevision" ADD CONSTRAINT "HtmlBlockRevision_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "HtmlBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormField" ADD CONSTRAINT "FormField_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormEmailAction" ADD CONSTRAINT "FormEmailAction_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentNotice" ADD CONSTRAINT "ConsentNotice_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_consentNoticeId_fkey" FOREIGN KEY ("consentNoticeId") REFERENCES "ConsentNotice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionValue" ADD CONSTRAINT "SubmissionValue_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionValue" ADD CONSTRAINT "SubmissionValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "FormField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Full-text search on article translations ───────────────────────────────
-- Albanian has no Postgres dictionary: use 'simple' + unaccent (ë→e, ç→c). English uses stemming.
-- Weights: title A, subtitle/summary B, body C, attached document titles D.
CREATE OR REPLACE FUNCTION article_translation_search() RETURNS trigger AS $$
DECLARE cfg regconfig := CASE WHEN NEW.lang = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END;
BEGIN
  NEW.search :=
      setweight(to_tsvector(cfg, unaccent(coalesce(NEW.title, ''))), 'A')
   || setweight(to_tsvector(cfg, unaccent(coalesce(NEW.subtitle, '') || ' ' || coalesce(NEW.summary, ''))), 'B')
   || setweight(to_tsvector(cfg, unaccent(coalesce(NEW."bodyText", ''))), 'C')
   || setweight(to_tsvector(cfg, unaccent(coalesce(NEW."documentTitles", ''))), 'D');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER article_translation_search_trg
  BEFORE INSERT OR UPDATE OF title, subtitle, summary, "bodyText", "documentTitles", lang
  ON "ArticleTranslation" FOR EACH ROW EXECUTE FUNCTION article_translation_search();

CREATE INDEX "ArticleTranslation_search_idx" ON "ArticleTranslation" USING GIN (search);
CREATE INDEX "ArticleTranslation_title_trgm_idx" ON "ArticleTranslation" USING GIN (title gin_trgm_ops);

-- ─── Audit log is append-only ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
