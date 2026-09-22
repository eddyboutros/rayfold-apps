/**
 * The shapes this service's own clients send, registered at start: the workspace panels' and the field client's.
 *
 * In development any shape is served. With TRUSTED_SHAPES=1 (spec 02 section 3) only these are: a client that asks
 * for a shape not on this list is refused, whoever it is and whatever token it holds, which is the production
 * setting for a service whose clients are known. Keep this in step with the panels; the test that starts a trusted
 * instance is what tells you when it has drifted.
 */
export const WORKSPACE_SHAPES: readonly string[] = [
  // web/workspace-ui
  "{ items { id title state version updatedAt priority labels dueOn description assignee { id name } } }",
  "{ items { labels } }",
  "{ id name }",
  "{ items { id body at by { name } } }",
  "{ items { id source kind text at by { id name } } }",
  "{ items { id body at by { id name } } }",
  "{ items { id kind text projectId issueId at readAt } }",
  "{ member { id name title email } open doing done overdue }",
  "{ id by { id } }",
  "{ id title version }",
  "{ id }",
  // clients/field
  "{ id title state version }",
  "{ items { id title state version } }",
  "{ id title state version @defer(label: \"thread\") { comments { items { body by { name } } } } }",
];
