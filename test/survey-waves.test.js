const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('survey reward is wired into waves, settings, admin form and controller', () => {
  assert.match(fs.readFileSync('src/services/waves.js', 'utf8'), /survey: \{ configKey: 'wavesSurveyReward'/);
  assert.match(fs.readFileSync('src/models/SiteSetting.js', 'utf8'), /wavesSurveyReward/);
  assert.match(fs.readFileSync('src/controllers/adminController.js', 'utf8'), /'wavesSurveyReward', 'survey'/);
  assert.match(fs.readFileSync('src/views/pages/admin.ejs', 'utf8'), /wavesSurveyRewardMinimum/);
  const c = fs.readFileSync('src/controllers/surveyController.js', 'utf8');
  assert.match(c, /action: 'survey'/);
  // answers stay anonymous: no user reference stored on the response
  assert.doesNotMatch(fs.readFileSync('src/models/SurveyResponse.js', 'utf8'), /user:/);
});
