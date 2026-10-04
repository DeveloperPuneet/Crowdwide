const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const ejs = require('ejs');
const path = require('node:path');
const { icon } = require('../src/utils/icons');
const { renderMentions, renderRichBody } = require('../src/services/mentions');
const createApp = require('../src/app');

test('Prism core, local grammar autoloader, and code-block controls are served locally', async () => {
  const app = createApp({ port: 3000 });
  const paths = [
    '/vendor/prism/components/prism-core.min.js',
    '/vendor/prism/plugins/autoloader/prism-autoloader.min.js',
    '/vendor/prism/components/prism-javascript.min.js',
    '/js/code-blocks.js',
    '/css/code-blocks.css',
    '/css/chat-ui.css',
    '/css/community-workspace.css'
  ];
  const responses = await Promise.all(paths.map((path) => request(app).get(path)));
  responses.forEach((response, index) => {
    assert.equal(response.status, 200, `${paths[index]} should be served`);
    assert.ok(response.text.length > 0, `${paths[index]} should not be empty`);
  });

  const viewPath = path.join(__dirname, '..', 'src', 'views');
  const html = await ejs.renderFile(path.join(viewPath, 'pages', 'post-compose.ejs'), {
    title: 'Edit post', bodyClass: 'dashboard-page', pagePath: '/posts/p1/edit', noIndex: true,
    icon, renderMentions, renderRichBody, csrfToken: 'tok', appUrl: 'http://localhost',
    currentUser: { id: 'u1', name: 'Member' },
    editorMode: 'edit',
    post: { _id: 'p1', author: { _id: 'u1', name: 'Member' }, body: 'const code = 1;', type: 'post', community: null },
    sourcePost: { _id: 'p1', author: { _id: 'u1', name: 'Member' }, body: 'const code = 1;', type: 'post', community: null },
    wordLimit: 60
  });
  assert.match(html, /\/vendor\/prism\/components\/prism-core\.min\.js/);
  assert.match(html, /\/js\/code-blocks\.js/);
  assert.match(html, /\/css\/code-blocks\.css/);
});
