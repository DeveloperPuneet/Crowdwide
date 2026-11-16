const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const ejs = require('ejs');

const homeTemplate = fs.readFileSync('src/views/pages/home.ejs', 'utf8');
const footTemplate = fs.readFileSync('src/views/partials/foot.ejs', 'utf8');
const appSource = fs.readFileSync('src/app.js', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');
const dashboardTemplate = fs.readFileSync('src/views/pages/dashboard.ejs', 'utf8');
const postDetailTemplate = fs.readFileSync('src/views/pages/post-detail.ejs', 'utf8');
const webControllerSource = fs.readFileSync('src/controllers/webController.js', 'utf8');

test('third-party ads are absent from the landing page and attach to feed or comment slots', () => {
  const homepageFoot = ejs.render(footTemplate, { pagePath: '/', asset: (path) => path });

  assert.doesNotMatch(homeTemplate, /ta-ad-container/);
  assert.doesNotMatch(homepageFoot, /cdn\.apitiny\.net/);
  assert.match(dashboardTemplate, /data-ad-after=/);
  assert.match(postDetailTemplate, /commentAdState = locals\.showThirdPartyAds/);
  assert.match(webControllerSource, /crypto\.randomInt\(18, 25\)/);
  assert.match(appJs, /adAfter < 18/);
  assert.match(appJs, /script\.src = 'https:\/\/cdn\.apitiny\.net\/scripts\/v2\.0\/main\.js'/);
  assert.match(appJs, /script\.dataset\.testMode = String\(\['localhost', '127\.0\.0\.1', '::1', '\[::1\]'\]/);
  assert.match(appSource, /'https:\/\/cdn\.apitiny\.net'/);
});
