// Server-enforced permissions (the admin UI only hides what a role cannot do). Mirrors DNN:
// Administrators do everything; Editors manage content and see/edit application results (ViewResultsRole=Editor);
// the English translator edits English translations and English HTML blocks only.
export const PERMISSIONS = [
  "content.edit", // articles, categories, programs, HTML blocks, media, in every language
  "content.translate_en", // English article translations and English HTML blocks
  "applications.view", "applications.edit", "applications.export", "applications.reveal",
  "applications.delete", "forms.manage",
  "contact.view",
  "users.manage", "settings.manage", "redirects.manage", "audit.view", "flags.manage",
  "page.alumni.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  administrator: PERMISSIONS,
  editor: ["content.edit", "content.translate_en", "applications.view", "applications.edit", "applications.export", "applications.reveal", "page.alumni.view"],
  translator_en: ["content.translate_en"],
};

export function permissionsFor(roleKeys: string[], isSuperUser = false): Set<Permission> {
  if (isSuperUser) return new Set(PERMISSIONS);
  return new Set(roleKeys.flatMap(k => ROLE_PERMISSIONS[k] ?? []));
}

/** Feature flags for prototype extras that DNN did not have. All off; the admin hides their screens. */
export const FLAGS: Record<string, string> = {
  "applications.stages": "Application stages / kanban board",
  "applications.scoring": "Scoring and reviewer role",
  "applications.decisionEmails": "Decision emails to applicants",
  "applications.assignment": "Assigning applications to staff",
  "applications.tags": "Tags and stars on applications",
  "sop.generations": "Generation and alumni management",
  "sop.programEditor": "School of Politics program-page editor",
  "careers": "Careers and job applications",
  "newsletter": "Newsletter subscribers and archive",
  "content.homeEditor": "Homepage section editor",
  "content.extraTaxonomies": "Extra taxonomies (topics, tags)",
  "auth.twoFactor": "Two-factor sign-in",
  "dashboard.extras": "Dashboard charts and widgets",
};
