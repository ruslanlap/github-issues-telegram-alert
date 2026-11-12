const { test } = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('./format');

test('all supported events render compact HTML with safe buttons', () => {
  const base={repository:{full_name:'owner/repo',html_url:'https://github.com/owner/repo',stargazers_count:42},sender:{login:'alice'}};
  const issue={number:7,title:'<script> & title',body:'Details',html_url:'https://github.com/owner/repo/issues/7'};
  const cases=[['star',{action:'created'}],['issues',{action:'opened',issue}],['issue_comment',{action:'created',issue,comment:{body:'Comment',html_url:issue.html_url}}],['pull_request',{action:'opened',pull_request:issue}],['pull_request',{action:'review_requested',pull_request:issue,requested_reviewer:{login:'bob'}}],['pull_request_review',{action:'submitted',pull_request:issue,review:{state:'approved',html_url:issue.html_url}}],['push',{ref:'refs/heads/main',commits:[{id:'abcdef123',message:'commit message'}],compare:issue.html_url}],['check_run',{action:'completed',check_run:{name:'build',conclusion:'failure',html_url:issue.html_url}}],['workflow_run',{action:'completed',workflow_run:{name:'ci',conclusion:'failure',html_url:issue.html_url}}]];
  for(const [event,payload] of cases) { const result=format(event,{...base,...payload}); assert.match(result.text,/<b>/); assert.doesNotMatch(result.text,/━━━━━━━━|<script>|@alice/); assert.ok(result.button.url.startsWith('https://github.com/')); }
  assert.match(format('issues',{...base,action:'opened',issue}).text,/&lt;script&gt; &amp; title/);
});

test('hostile URLs and enormous escaped Unicode remain safe and bounded', () => {
  const result=format('issues',{action:'opened',repository:{full_name:'a/<b>'},sender:{login:'bad" onclick="x'},issue:{number:1,title:'<&😀'.repeat(3000),body:'<&😀'.repeat(3000),html_url:'https://github.com.evil.test/x'}});
  assert.equal(result.button,null); assert.doesNotMatch(result.text,/<script|onclick="|github.com.evil/); assert.ok(result.text.length<=4000); assert.doesNotMatch(result.text,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});
