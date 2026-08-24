export const CONVERSATIONS_PROJECT_TITLE = "Conversations";

export function isConversationsProject(project: { title: string } | null | undefined): boolean {
  if (!project) return false;
  return project.title === CONVERSATIONS_PROJECT_TITLE;
}
