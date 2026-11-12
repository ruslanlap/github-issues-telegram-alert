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

  // Bound UTF-16 length without splitting surrogate pairs; Telegram receives plain text.
  const clip = (value, max) => {
    const text = String(value ?? '').slice(0, max);
    return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
  };
  const line = (value, max) => clip(value, max).replace(/[\r\n\u2028\u2029]/g, ' ');
  const badges = {
    issues: {opened:'🔵 ISSUE OPENED',closed:'🟢 ISSUE CLOSED',reopened:'🟡 ISSUE REOPENED'},
    pull_request: {opened:'🔀 PR OPENED',closed:p.pull_request?.merged ? '🟣 PR MERGED' : '🔴 PR CLOSED',reopened:'🟡 PR REOPENED',review_requested:'👀 REVIEW REQUESTED'}
  };
  const badge = badges[event]?.[p.action] || {issue_comment:'💬 NEW COMMENT',pull_request_review:'📝 REVIEW SUBMITTED',push:'📦 PUSH',star:'⭐ NEW STAR',check_run:'❌ CHECK FAILED',workflow_run:'❌ WORKFLOW FAILED'}[event];
  const lines = [badge, '━━━━━━━━━━━━━━━━━━━━━━', '', `📁 ${line(repo, 200)}`];
  if (item) lines.push(`#${line(item.number, 40)} — ${line(item.title, 500)}`);
  lines.push(`👤 ${event === 'star' || event === 'issue_comment' ? 'From' : event === 'push' ? 'Pusher' : 'Author'}: ${event === 'push' ? '' : '@'}${line(p.sender?.login || p.pusher?.name, 200)}`);
  if (event === 'star' && p.repository.stargazers_count != null) lines.push(`🌟 Total Stars: ${line(p.repository.stargazers_count, 40)}`);
  let detail;
  if (event === 'issue_comment') detail = p.comment?.body;
  else if (event === 'pull_request_review') detail = p.review?.state;
  else if (event === 'pull_request' && p.action === 'review_requested') detail = p.requested_reviewer?.login || p.requested_team?.name;
  else if (event === 'push') {
    lines.push(`🌿 Branch: ${line(p.ref, 200).replace(/^refs\/heads\//, '')}`, `📝 Commits: ${p.commits.length}`);
    detail = p.commits.slice(0, 3).map(c => `${line(c.id, 7)} ${line(c.message?.split('\n')[0], 200)}`).join('\n');
  } else if (event === 'check_run' || event === 'workflow_run') {
    const check = p.check_run || p.workflow_run;
    detail = `${line(check?.name, 500)} — ${line(check?.conclusion, 40)}`;
  } else detail = item?.body;
  if (detail) lines.push('', `📖 ${clip(detail, 1500)}`);
  const url = p.comment?.html_url || p.review?.html_url || item?.html_url || p.check_run?.html_url || p.workflow_run?.html_url || p.compare || p.repository.html_url || '';
  let link = '';
  try { if (typeof url === 'string' && url.length <= 1000 && !/[\s<>"'\u0000-\u001f]/u.test(url) && new URL(url).protocol === 'https:') link = url; } catch {}
  const time = new Date().toLocaleString('uk-UA', {timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'});
  lines.push('━━━━━━━━━━━━━━━━━━━━━━', ...(link ? [`🔗 ${link}`] : []), `🕐 ${time} (Kyiv)`);
  return lines.join('\n');
}

module.exports = { format };
