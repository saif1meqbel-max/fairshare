/**
 * Tool: getProjectOverview
 * Returns summary info for a project the authenticated user has access to.
 */

export const definition = {
  type: 'function',
  function: {
    name: 'getProjectOverview',
    description:
      'Retrieve a summary of a project: name, deadline, members, task counts, and overall progress. ' +
      'Call this first when the user asks about a project or its team.',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID to retrieve. Use the current project if not specified by the user.',
        },
      },
      required: ['project_id'],
    },
  },
};

/**
 * @param {object} args        - Tool arguments from OpenAI
 * @param {object} supabase    - Supabase client scoped to the authenticated user
 */
export async function execute(args, supabase) {
  const { project_id } = args;

  const { data: proj, error } = await supabase
    .from('fs_projects')
    .select('*')
    .eq('id', project_id)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!proj)  return { error: 'Project not found or you do not have access.' };

  const body = typeof proj.body === 'string' ? JSON.parse(proj.body) : proj.body || {};

  const { data: tasks } = await supabase
    .from('fs_tasks')
    .select('id, body')
    .eq('project_id', project_id);

  const taskList = (tasks || []).map(t => {
    const b = typeof t.body === 'string' ? JSON.parse(t.body) : t.body || {};
    return { id: t.id, status: b.status || 'todo', title: b.title || '' };
  });

  const total   = taskList.length;
  const done    = taskList.filter(t => t.status === 'done').length;
  const inProg  = taskList.filter(t => t.status === 'in_progress').length;
  const todo    = taskList.filter(t => t.status === 'todo').length;
  const pct     = total ? Math.round((done / total) * 100) : 0;

  return {
    id:          proj.id,
    name:        body.name        || proj.id,
    description: body.description || null,
    deadline:    body.deadline    || null,
    createdAt:   proj.created_at  || null,
    owner:       body.ownerName   || null,
    members:     (body.members || []).map(m => ({
      name:   m.name   || m.email || 'Unknown',
      email:  m.email  || null,
      role:   m.role   || 'member',
      status: m.inviteUserId ? 'joined' : 'pending',
    })),
    tasks: { total, done, inProgress: inProg, todo, completionPct: pct },
  };
}
