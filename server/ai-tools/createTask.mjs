/**
 * Tool: createTask
 * Create a new task in a project on behalf of the authenticated user.
 */

export const definition = {
  type: 'function',
  function: {
    name: 'createTask',
    description:
      'Create a new task in a project. ' +
      'Always confirm the details with the user before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID.',
        },
        title: {
          type: 'string',
          description: 'The task title.',
        },
        assignedTo: {
          type: 'string',
          description: 'Name or email of the person to assign the task to.',
        },
        due: {
          type: 'string',
          description: 'Due date in ISO 8601 format (YYYY-MM-DD).',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Task priority. Defaults to "medium".',
        },
        notes: {
          type: 'string',
          description: 'Optional notes or description for the task.',
        },
      },
      required: ['project_id', 'title'],
    },
  },
};

export async function execute(args, supabase, userId) {
  const { project_id, title, assignedTo, due, priority = 'medium', notes } = args;

  if (!title?.trim()) return { error: 'Task title is required.' };

  const body = {
    title:      title.trim(),
    status:     'todo',
    assignedTo: assignedTo || null,
    due:        due        || null,
    priority,
    notes:      notes      || null,
    createdBy:  userId,
    createdAt:  Date.now(),
  };

  const { data, error } = await supabase
    .from('fs_tasks')
    .insert({ project_id, body })
    .select('id')
    .single();

  if (error) return { error: error.message };

  // Log activity
  await supabase.from('fs_activities').insert({
    project_id,
    body: {
      type:     'task_created',
      userId,
      detail:   `Created task: "${title}"`,
      ts:       Date.now(),
    },
  }).catch(() => {});

  return { success: true, taskId: data.id, message: `Task "${title}" created successfully.` };
}
