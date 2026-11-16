const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const ejs = require('ejs');

const homeTemplate = fs.readFileSync('src/views/pages/home.ejs', 'utf8');
const footTemplate = fs.readFileSync('src/views/partials/foot.ejs', 'utf8');
const appSource = fs.readFileSync('src/app.js', 'utf8');

test('third-party ads load on the homepage where the ad container is present', () => {
  const homepageFoot = ejs.render(footTemplate, { pagePath: '/', asset: (path) => path });
  const dashboardFoot = ejs.render(footTemplate, { pagePath: '/dashboard', asset: (path) => path });

  assert.match(homeTemplate, /<div ta-ad-container><\/div>/);
  assert.match(homepageFoot, /<script src="https:\/\/cdn\.apitiny\.net\/scripts\/v2\.0\/main\.js" data-site-id="6afab90572e32d7989c230ed" data-test-mode="false" async><\/script>\s*<\/body>/);
  assert.doesNotMatch(dashboardFoot, /cdn\.apitiny\.net/);
  assert.match(appSource, /'https:\/\/cdn\.apitiny\.net'/);
});
