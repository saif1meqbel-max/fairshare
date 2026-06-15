/**
 * Tool: getActivityLog
 * Retrieve recent activity events for a project.
 */

export const definition = {
  type: 'function',
  function: {
    name: 'getActivityLog',
    description:
      'Get the recent activity log for a project — who did what and when. ' +
      'Use this when the user asks about recent actions, history, or what happened lately.',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID.',
        },
        limit: {
          type: 'number',
          description: 'How many recent events to return. Defaults to 20, max 50.',
        },
        user_name: {
          type: 'string',
          description: 'Filter events by a specific user name (partial match).',
        },
        event_type: {
          type: 'string',
          description: 'Filter by event type, e.g. "task_done", "doc_edit", "member_join".',
        },
      },
      required: ['project_id'],
    },
  },
};

export async function execute(args, supabase) {
  const { project_id, limit = 20, user_name, event_type } = args;
  const safeLimit = Math.min(Number(limit) || 20, 50);

  const { data: rows, error } = await supabase
    .from('fs_activities')
    .select('id, body, created_at')
    .eq('project_id', project_id)
    .order('created_at', { ascending: false })
    .limit(safeLimit * 3); // fetch extra to allow for client-side filtering

  if (error) return { error: error.message };

  let events = (rows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : r.body || {};
    return {
      id:        r.id,
      type:      b.type     || 'unknown',
      userName:  b.userName || 'Unknown',
      detail:    b.detail   || b.text || b.title || null,
      ts:        b.ts       || (r.created_at ? new Date(r.created_at).getTime() : null),
      isoTime:   r.created_at || null,
    };
  });

  if (user_name)   events = events.filter(e => e.userName.toLowerCase().includes(user_name.toLowerCase()));
  if (event_type)  events = events.filter(e => e.type === event_type);

  events = events.slice(0, safeLimit);

  return { count: events.length, events };
}
