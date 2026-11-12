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

  const clip = (value, max) => Array.from(String(value ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�').replace(/[\r\n\u2028\u2029]/g, ' ')).slice(0,max).join('');
  const esc = (value, max) => clip(value,max).replace(/@/g,'@\u200b').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const safeUrl = value => {
    try {
      if (typeof value !== 'string' || value.length > 1000 || /[\s<>"'\u0000-\u001f\\]/u.test(value)) return null;
      const u = new URL(value);
      return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port ? value : null;
    } catch { return null; }
  };
  const login = String(p.sender?.login || p.pusher?.name || 'невідомий користувач');
  const actor = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login) ? `<a href="https://github.com/${login}">${esc(login,60)}</a>` : esc(login,60);
  const number = esc(item?.number, 20);
  const names = {
    issues:{opened:'🐛 новий issue',closed:'✅ issue закрито',reopened:'🔄 issue відкрито знову'},
    pull_request:{opened:'🔀 новий pull request',closed:p.pull_request?.merged?'🎉 pull request змерджено':'✅ pull request закрито',reopened:'🔄 pull request відкрито знову',review_requested:'👀 запит на review'}
  };
  const name = names[event]?.[p.action] || {issue_comment:'💬 новий коментар',pull_request_review:'📝 новий review',push:'📦 нові коміти',star:'⭐ нова зірка',check_run:'❌ помилка перевірки',workflow_run:'❌ помилка workflow'}[event];
  const lines = [`<b>${esc(repo.split('/').pop(),80)} · ${name}${item ? ` #${number}` : ''}</b>`];
  if (item?.title) lines.push(`<b>${esc(item.title,200)}</b>`);
  let detail;
  if (event === 'star') detail = `відзначено репозиторій${p.repository.stargazers_count != null ? ` · <b>${esc(p.repository.stargazers_count,30)} зірок</b>` : ''}`;
  else if (event === 'issue_comment') detail = p.comment?.body;
  else if (event === 'pull_request_review') detail = p.review?.state;
  else if (event === 'pull_request' && p.action === 'review_requested') detail = p.requested_reviewer?.login || p.requested_team?.name;
  else if (event === 'push') detail = `${clip(p.ref,100).replace(/^refs\/heads\//,'')} · ${p.commits.length} комітів · ${p.commits.slice(0,3).map(c=>`${clip(c.id,7)} ${clip(c.message?.split('\n')[0],80)}`).join(' · ')}`;
  else if (event === 'check_run' || event === 'workflow_run') { const check=p.check_run || p.workflow_run; detail=`${clip(check?.name,100)} · ${clip(check?.conclusion,30)}`; }
  else detail = item?.body;
  lines.push(`${actor}${event === 'star' ? ` ${detail}` : detail ? `: «${esc(detail,200)}»` : ''}`);
  const url = safeUrl(p.comment?.html_url || p.review?.html_url || item?.html_url || p.check_run?.html_url || p.workflow_run?.html_url || p.compare || p.repository.html_url);
  const label = item ? `Відкрити ${event.startsWith('pull_request') ? 'pull request' : 'issue'} #${clip(item.number,20)}` : event === 'star' ? 'Переглянути репозиторій' : 'Переглянути на GitHub';
  return {text:lines.join('\n'),button:url ? {text:label,url} : null};
}
module.exports = { format };
