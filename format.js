  function format(event, p) {
    const repo = p.repository?.full_name;
    if (!repo) return null;
    const item = p.issue || p.pull_request;
    const actions = { issues:['opened','closed','reopened'], issue_comment:['created'], pull_request:['opened','closed','reopened','review_requested'], pull_request_review:['submitted'], star:['created'] };
    if (actions[event] && !actions[event].includes(p.action)) return null;
    if (event === 'push' && !p.commits?.length) return null;
    if (event === 'check_run' && !(p.action === 'completed' && ['failure','timed_out','cancelled'].includes(p.check_run?.conclusion))) return null;
    if (event === 'workflow_run' && !(p.action === 'completed' && ['failure','timed_out','cancelled'].includes(p.workflow_run?.conclusion))) return null;
    if (!actions[event] && !['push','check_run','workflow_run'].includes(event)) return null;
    const clip = (value, max) => String(value || '').slice(0, max);
    const subject = item ? ` #${item.number} ${clip(item.title, 500)}` : '';
    const detail = event === 'issue_comment' ? p.comment?.body : event === 'pull_request_review' ? p.review?.state : event === 'pull_request' && p.action === 'review_requested' ? p.requested_reviewer?.login || p.requested_team?.name : event === 'push' ? `${clip(p.ref, 200)} (${p.commits.length} commits)\n${p.commits.slice(0, 3).map(c => `${clip(c.id, 7)} ${clip(c.message?.split('\n')[0], 200)}`).join('\n')}` : event === 'check_run' ? p.check_run?.name : event === 'workflow_run' ? p.workflow_run?.name : item?.body;
    const url = p.comment?.html_url || p.review?.html_url || item?.html_url || p.check_run?.html_url || p.workflow_run?.html_url || p.compare || p.repository.html_url || '';
    return `${clip(repo, 200)}${subject}\n${clip(event, 40)}: ${clip(p.action, 40)}\nAuthor: ${clip(p.sender?.login || p.pusher?.name, 200)}\n${clip(detail, 1500)}\n${clip(url, 1000)}`;

  }

module.exports = { format };
