-- Link applicant answers to their stored files (the column existed; the constraint makes the relation explicit).
ALTER TABLE "SubmissionValue" ADD CONSTRAINT "SubmissionValue_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SubmissionValue_fileId_idx" ON "SubmissionValue"("fileId");
