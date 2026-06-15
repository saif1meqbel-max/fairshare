/**
 * Tool: getTasks
 * Retrieve tasks for a project with optional filters.
 */

export const definition = {
  type: 'function',
  function: {
    name: 'getTasks',
    description:
      'Get tasks for a project. Optionally filter by status or assignee. ' +
      'Use this when the user asks about what tasks exist, who is working on what, or overdue items.',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID.',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done', 'all'],
          description: 'Filter by task status. Defaults to "all".',
        },
        assignee_name: {
          type: 'string',
          description: 'Filter tasks by an assignee name (partial match).',
        },
        overdue_only: {
          type: 'boolean',
          description: 'If true, return only tasks past their due date that are not done.',
        },
      },
      required: ['project_id'],
    },
  },
};

export async function execute(args, supabase) {
  const { project_id, status = 'all', assignee_name, overdue_only } = args;

  const { data: rows, error } = await supabase
    .from('fs_tasks')
    .select('id, body, created_at')
    .eq('project_id', project_id);

  if (error) return { error: error.message };

  const now = Date.now();
  let tasks = (rows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : r.body || {};
    return {
      id:         r.id,
      title:      b.title      || '(untitled)',
      status:     b.status     || 'todo',
      assignedTo: b.assignedTo || null,
      due:        b.due        || null,
      priority:   b.priority   || 'medium',
      notes:      b.notes      || null,
      createdAt:  r.created_at || null,
      isOverdue:  b.due && b.status !== 'done' ? new Date(b.due).getTime() < now : false,
    };
  });

  if (status !== 'all')     tasks = tasks.filter(t => t.status === status);
  if (assignee_name)        tasks = tasks.filter(t => t.assignedTo?.toLowerCase().includes(assignee_name.toLowerCase()));
  if (overdue_only)         tasks = tasks.filter(t => t.isOverdue);

  // Sort: overdue first, then by due date
  tasks.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.due && b.due) return new Date(a.due) - new Date(b.due);
    return 0;
  });

  return { count: tasks.length, tasks };
}
