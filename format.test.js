const { test } = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('./format');

test('renders every event in the original readable style with direct links', () => {
  const base = {repository:{full_name:'owner/repo',html_url:'https://github.com/owner/repo',stargazers_count:42},sender:{login:'alice'}};
  const issue = {number:7,title:'A title',body:'Details',html_url:'https://github.com/owner/repo/issues/7'};
  const cases = [
    ['star',{action:'created'},'⭐ NEW STAR','🌟 Total Stars: 42','https://github.com/owner/repo'],
    ['issues',{action:'opened',issue},'🔵 ISSUE OPENED','Details',issue.html_url],
    ['issue_comment',{action:'created',issue,comment:{body:'Comment',html_url:'https://github.com/owner/repo/issues/7#issuecomment-1'}},'💬 NEW COMMENT','Comment','#issuecomment-1'],
    ['pull_request',{action:'opened',pull_request:issue},'🔀 PR OPENED','Details',issue.html_url],
    ['pull_request',{action:'review_requested',pull_request:issue,requested_reviewer:{login:'bob'}},'👀 REVIEW REQUESTED','bob',issue.html_url],
    ['pull_request_review',{action:'submitted',pull_request:issue,review:{state:'approved',html_url:'https://github.com/owner/repo/pull/7#review-1'}},'📝 REVIEW SUBMITTED','approved','#review-1'],
    ['push',{ref:'refs/heads/main',commits:[{id:'abcdef123',message:'commit message'}],compare:'https://github.com/owner/repo/compare/a...b'},'📦 PUSH','abcdef1 commit message','/compare/'],
    ['check_run',{action:'completed',check_run:{name:'build',conclusion:'failure',html_url:'https://github.com/owner/repo/checks/1'}},'❌ CHECK FAILED','build','/checks/1'],
    ['workflow_run',{action:'completed',workflow_run:{name:'ci',conclusion:'failure',html_url:'https://github.com/owner/repo/actions/1'}},'❌ WORKFLOW FAILED','ci','/actions/1']
  ];
  for (const [event,payload,badge,detail,url] of cases) {
    const text = format(event,{...base,...payload});
    for (const part of [badge,'━━━━━━━━━━━━━━━━━━━━━━','📁 owner/repo','alice',detail,url,'🕐']) assert.ok(text.includes(part), `${event}: missing ${part}: ${text}`);
  }
});

test('untrusted markup stays plain text, unsafe links are omitted, and long Unicode fits', () => {
  const text=format('issues',{action:'opened',repository:{full_name:'a/b'},sender:{login:'alice'},issue:{number:1,title:'<b>unsafe</b> & text',body:'😀'.repeat(5000),html_url:'javascript:alert(1)'}});
  assert.ok(text.includes('<b>unsafe</b> & text'));
  assert.ok(!text.includes('javascript:'));
  assert.ok(text.length<=4000);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
});
