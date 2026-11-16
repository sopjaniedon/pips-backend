import { usersStep, settingsStep } from "./01-02-users-settings.js";
import { categoriesStep, programsStep } from "./03-04-taxonomy.js";
import { articlesStep, linksStep, documentsStep, galleryStep, revisionsStep } from "./08-12-articles.js";
import { htmlBlocksStep, pagesStep } from "./13-14-pages.js";
import { contactStep, finalizeStep, verifyStep } from "./17-19-contact-finalize.js";
import { fileIndexStep, fileCopyStep, variantsStep, fileVerifyStep } from "./05-07-files.js";
import { formsStep, submissionsStep, formsVerifyStep } from "./15-16-forms.js";
import type { Step } from "./types.js";

// Ordered import. File steps (05–07) run after the content they link to; submissions (16) after files.
export const STEPS: Step[] = [
  usersStep, settingsStep, categoriesStep, programsStep,
  articlesStep, linksStep, documentsStep, galleryStep, revisionsStep,
  htmlBlocksStep,
  fileIndexStep, fileCopyStep, variantsStep,
  formsStep, submissionsStep,
  pagesStep, contactStep, finalizeStep, verifyStep, fileVerifyStep, formsVerifyStep,
];
