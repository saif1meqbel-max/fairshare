/**
 * Tool: getTeamContributions
 * Returns contribution scores and task breakdown per team member.
 */

export const definition = {
  type: 'function',
  function: {
    name: 'getTeamContributions',
    description:
      'Get contribution scores and work breakdown for each member of a project. ' +
      'Use this when asked about who is doing the most work, performance, or team effort.',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID.',
        },
      },
      required: ['project_id'],
    },
  },
};

export async function execute(args, supabase) {
  const { project_id } = args;

  const [{ data: projRow }, { data: taskRows }, { data: actRows }] = await Promise.all([
    supabase.from('fs_projects').select('body').eq('id', project_id).maybeSingle(),
    supabase.from('fs_tasks').select('id, body').eq('project_id', project_id),
    supabase.from('fs_activities').select('body').eq('project_id', project_id),
  ]);

  if (!projRow) return { error: 'Project not found.' };

  const body    = typeof projRow.body === 'string' ? JSON.parse(projRow.body) : projRow.body || {};
  const members = body.members || [];
  const tasks   = (taskRows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : r.body || {};
    return { id: r.id, ...b };
  });
  const acts = (actRows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : r.body || {};
    return b;
  });

  const TASK_PTS     = 10;
  const IN_PROG_PTS  = 3;
  const EDIT_PTS     = 2;

  const scores = members.map(m => {
    const name = m.name || m.email || 'Unknown';
    const myTasks = tasks.filter(t => {
      const a = (t.assignedTo || '').toLowerCase();
      return a === name.toLowerCase() || a === (m.email || '').toLowerCase();
    });
    const done   = myTasks.filter(t => t.status === 'done').length;
    const inProg = myTasks.filter(t => t.status === 'in_progress').length;
    const edits  = acts.filter(a => a.userId === m.inviteUserId && a.type === 'doc_edit').length;
    const score  = done * TASK_PTS + inProg * IN_PROG_PTS + edits * EDIT_PTS;

    return {
      name,
      email:        m.email  || null,
      role:         m.role   || 'member',
      score,
      tasksDone:    done,
      tasksInProg:  inProg,
      tasksTotal:   myTasks.length,
      docEdits:     edits,
    };
  });

  scores.sort((a, b) => b.score - a.score);

  const totalScore = scores.reduce((s, m) => s + m.score, 0);
  scores.forEach(m => {
    m.sharePercent = totalScore ? Math.round((m.score / totalScore) * 100) : 0;
  });

  return { memberCount: scores.length, scores };
}
