const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const mongoose = require('mongoose');
const { icon } = require('../src/utils/icons');
const svc = require('../src/services/surveys');
const Survey = require('../src/models/Survey');
const SurveyResponse = require('../src/models/SurveyResponse');

const views = path.join(__dirname, '..', 'src', 'views');
const base = { icon, csrfToken: 'tok', flash: null, currentUser: null, appUrl: 'http://x', cspNonce: '', gifsEnabled: false };
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), { ...base, ...data });
const oid = () => new mongoose.Types.ObjectId();

const goodForm = { 0: { text: ' Favourite colour? ', options: ['Red', ' Blue ', '', 'Green'] }, 1: { text: 'Pets?', options: ['Cat', 'Dog'] } };

test('parseQuestions trims, drops blank options/empty blocks and keeps index order', () => {
  const out = svc.parseQuestions({ 10: { text: 'Second', options: ['a', 'b'] }, 2: { text: 'First', options: ['x', 'y'] }, 5: { text: '', options: [] } });
  assert.deepEqual(out.map((q) => q.text), ['First', 'Second']);
  const parsed = svc.parseQuestions(goodForm);
  assert.equal(parsed[0].text, 'Favourite colour?');
  assert.deepEqual(parsed[0].options.map((o) => o.text), ['Red', 'Blue', 'Green']);
  // qs can also hand us real arrays
  assert.equal(svc.parseQuestions([{ text: 'Q', options: ['a', 'b'] }]).length, 1);
});

test('parseQuestions rejects invalid surveys with a helpful message', () => {
  assert.throws(() => svc.parseQuestions(undefined), /at least one question/);
  assert.throws(() => svc.parseQuestions({ 0: { text: 'Q', options: ['only one'] } }), /Question 1 needs at least 2/);
  assert.throws(() => svc.parseQuestions({ 0: { text: '', options: ['a', 'b'] } }), /Question 1 needs its question text/);
  assert.throws(() => svc.parseQuestions({ 0: { text: 'Q', options: ['Same', 'same'] } }), /same option twice/);
  assert.throws(() => svc.parseQuestions({ 0: { text: 'Q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) } }), /at most 10/);
  assert.throws(() => svc.parseQuestions(Array.from({ length: 31 }, () => ({ text: 'Q', options: ['a', 'b'] }))), /at most 30/);
  assert.throws(() => svc.parseDetails({ title: '   ' }), /title/);
});

test('Survey model validates and defaults to an unpublished, epoch-0 survey', () => {
  const ok = new Survey({ title: 'T', questions: svc.parseQuestions(goodForm) });
  assert.equal(ok.status, 'draft');
  assert.equal(ok.epoch, 0);
  assert.equal(ok.validateSync(), undefined);
  assert.ok(new Survey({ title: 'T', questions: [] }).validateSync());
});

test('SurveyResponse stores no personal data at all', () => {
  const fields = Object.keys(SurveyResponse.schema.paths).filter((key) => !['_id'].includes(key));
  assert.deepEqual(fields.sort(), ['answers', 'epoch', 'survey']);
  assert.equal(SurveyResponse.schema.options.timestamps, false);
});

test('parseAnswers needs exactly one valid option for every question', () => {
  const survey = new Survey({ title: 'T', questions: svc.parseQuestions(goodForm) });
  const [q1, q2] = survey.questions;
  const body = { answers: { [q1._id]: String(q1.options[1]._id), [q2._id]: String(q2.options[0]._id) } };
  const answers = svc.parseAnswers(survey, body);
  assert.equal(answers.length, 2);
  assert.equal(String(answers[0].option), String(q1.options[1]._id));
  assert.throws(() => svc.parseAnswers(survey, { answers: { [q1._id]: String(q1.options[0]._id) } }), /answer question 2/);
  assert.throws(() => svc.parseAnswers(survey, { answers: { [q1._id]: String(oid()), [q2._id]: String(q2.options[0]._id) } }), /answer question 1/);
  // an option from another question is not accepted
  assert.throws(() => svc.parseAnswers(survey, { answers: { [q1._id]: String(q2.options[0]._id), [q2._id]: String(q2.options[0]._id) } }), /answer question 1/);
  assert.throws(() => svc.parseAnswers(survey, {}), /answer question 1/);
});

test('"already answered" is a plain per-survey cookie tied to the epoch, so clearing results lets people answer again', () => {
  const survey = { _id: oid(), epoch: 0 };
  const cookies = [];
  svc.markAnswered({ cookie: (name, value, options) => cookies.push({ name, value, options }) }, survey);
  assert.equal(cookies[0].name, `cw_sv_${survey._id}`);
  assert.equal(cookies[0].value, '0');
  assert.equal(cookies[0].options.httpOnly, true);
  const req = (epoch) => ({ headers: { cookie: `a=1; ${cookies[0].name}=${cookies[0].value}; b=2` }, epoch });
  assert.equal(svc.hasAnswered(req(), survey), true);
  assert.equal(svc.hasAnswered(req(), { ...survey, epoch: 1 }), false, 'after a clear (epoch bumped) the cookie no longer counts');
  assert.equal(svc.hasAnswered({ headers: {} }, survey), false);
});

test('buildResults tallies votes, percentages and anonymous rows for the current epoch; export mirrors them', async () => {
  const survey = new Survey({ title: 'Colours', questions: svc.parseQuestions(goodForm), epoch: 3 });
  const [q1, q2] = survey.questions;
  const pick = (q, i) => ({ question: q._id, option: q.options[i]._id });
  const stored = [
    { answers: [pick(q1, 0), pick(q2, 0)] },
    { answers: [pick(q1, 0), pick(q2, 1)] },
    { answers: [pick(q1, 2), pick(q2, 1)] }
  ];
  const originals = { aggregate: SurveyResponse.aggregate, countDocuments: SurveyResponse.countDocuments, find: SurveyResponse.find };
  let matched;
  SurveyResponse.aggregate = async (pipeline) => {
    matched = pipeline[0].$match;
    const rows = new Map();
    stored.flatMap((r) => r.answers).forEach((a) => { const k = `${a.question}:${a.option}`; rows.set(k, (rows.get(k) || 0) + 1); });
    return Array.from(rows, ([k, votes]) => { const [question, option] = k.split(':'); return { _id: { question: new mongoose.Types.ObjectId(question), option: new mongoose.Types.ObjectId(option) }, votes }; });
  };
  SurveyResponse.countDocuments = async () => stored.length;
  SurveyResponse.find = () => { const chain = { sort: () => chain, select: () => chain, skip: () => chain, lean: () => Promise.resolve(stored) , then: (resolve) => resolve(stored) }; return chain; };
  try {
    const results = await svc.buildResults(survey, { includeAllResponses: true });
    assert.equal(String(matched.survey), String(survey._id));
    assert.equal(matched.epoch, 3, 'only the current epoch is counted');
    assert.equal(results.totalResponses, 3);
    assert.deepEqual(results.questions[0].options.map((o) => [o.text, o.votes, o.percent]), [['Red', 2, 66.7], ['Blue', 0, 0], ['Green', 1, 33.3]]);
    assert.deepEqual(results.questions[1].options.map((o) => o.votes), [1, 2]);
    assert.deepEqual(results.responseRows[0], { number: 1, answers: ['Red', 'Cat'] });
    assert.deepEqual(results.responseRows[2].answers, ['Green', 'Dog']);

    const exported = svc.exportPayload(survey, results);
    assert.equal(exported.totalResponses, 3);
    assert.equal(exported.responses.length, 3);
    assert.deepEqual(exported.responses[1], { response: 2, answers: [{ question: 'Favourite colour?', answer: 'Red' }, { question: 'Pets?', answer: 'Dog' }] });
    const json = JSON.stringify(exported);
    assert.doesNotMatch(json, /"(ipAddress|userAgent|user|email)"/i);
    assert.doesNotThrow(() => JSON.parse(json));
  } finally {
    Object.assign(SurveyResponse, originals);
  }
});

test('admin surveys tab renders: new-survey builder, results tables, export + clear controls, locked editing', async () => {
  const survey = new Survey({ title: 'Colours <b>', description: 'Hi', status: 'published', questions: svc.parseQuestions(goodForm) });
  const q = survey.questions.map((x) => ({ _id: String(x._id), text: x.text, options: x.options.map((o) => ({ _id: String(o._id), text: o.text })) }));
  const results = {
    totalResponses: 2,
    questions: q.map((x) => ({ id: x._id, text: x.text, answered: 2, options: x.options.map((o, i) => ({ id: o._id, text: o.text, votes: i === 0 ? 2 : 0, percent: i === 0 ? 100 : 0 })) })),
    responseRows: [{ number: 1, answers: ['Red', 'Cat'] }, { number: 2, answers: ['Red', null] }],
    rowsTruncated: false
  };
  const html = await render('partials/admin-surveys.ejs', { surveys: [{ _id: String(survey._id), title: survey.title, description: 'Hi', status: 'published', questions: q, results }] });
  assert.match(html, /New survey/);
  assert.match(html, /name="questions\[0\]\[text\]"/);
  assert.match(html, /data-add-question/);
  assert.match(html, /Export JSON/);
  assert.match(html, new RegExp(`/admin/surveys/${survey._id}/export\\.json`));
  assert.match(html, new RegExp(`/admin/surveys/${survey._id}/clear`));
  assert.match(html, /Clear results/);
  assert.match(html, /<table class="admin-table survey-table">/);
  assert.match(html, /All responses \(anonymous\)/);
  assert.match(html, /Colours &lt;b&gt;/, 'titles are escaped');
  assert.match(html, /<fieldset class="survey-questions" data-questions disabled>/, 'questions lock once responses exist');
  assert.match(html, /<template id="survey-q-template">[\s\S]*questions\[__Q__\]\[text\]/);

  const empty = await render('partials/admin-surveys.ejs', { surveys: [] });
  assert.match(empty, /No surveys yet/);
  const draft = await render('partials/admin-surveys.ejs', { surveys: [{ _id: 's1', title: 'D', description: '', status: 'draft', questions: q, results: { totalResponses: 0, questions: [], responseRows: [], rowsTruncated: false } }] });
  assert.match(draft, /No responses yet - publish the survey/);
  assert.match(draft, /<button class="button button-danger button-small" type="submit" disabled>Clear results/);
});

test('public survey pages render for visitors with no account', async () => {
  const survey = new Survey({ title: 'Public one', description: 'Quick', status: 'published', questions: svc.parseQuestions(goodForm) }).toObject();
  const list = await render('pages/surveys.ejs', { title: 'Surveys', description: 'd', pagePath: '/surveys', surveys: [{ ...survey, questionCount: 2, answered: false }] });
  assert.match(list, /Take survey/);
  assert.match(list, /Completely anonymous/);
  assert.match(list, /Join Crowdwide/, 'logged-out header');

  const form = await render('pages/survey.ejs', { title: survey.title, description: 'd', pagePath: '/x', survey, answered: false, justSubmitted: false });
  assert.match(form, /type="radio"/);
  assert.match(form, new RegExp(`action="/surveys/${survey._id}/respond"`));
  assert.match(form, new RegExp(`name="answers\\[${survey.questions[0]._id}\\]"`));
  assert.equal((form.match(/type="radio"/g) || []).length, 5);
  assert.doesNotMatch(form, /name="(name|email)"/);

  assert.match(await render('pages/survey.ejs', { title: 't', description: 'd', pagePath: '/x', survey, answered: true, justSubmitted: false }), /already answered/);
  assert.match(await render('pages/survey.ejs', { title: 't', description: 'd', pagePath: '/x', survey, answered: false, justSubmitted: true }), /Thank you/);
  assert.match(await render('pages/survey.ejs', { title: 't', description: 'd', pagePath: '/x', survey: { ...survey, status: 'closed' }, answered: false, justSubmitted: false }), /survey is closed/);
});

test('Waves currency has a proper colour logo that does not depend on the theme', () => {
  const coin = icon('waves', { size: 20 });
  assert.match(coin, /<svg class="icon icon-waves" width="20" height="20"/);
  assert.match(coin, /fill="#1fb6ee"/);
  assert.doesNotMatch(coin, /currentColor/);
  assert.doesNotMatch(coin, /\bid="/, 'no ids: duplicate ids break inline SVGs inside hidden menus');
  assert.match(icon('waves', { label: 'Waves' }), /role="img" aria-label="Waves"/);
});

// ---- controller flows (models stubbed: this suite runs without a database) ----
const controller = require('../src/controllers/surveyController');
const AuditLog = require('../src/models/AuditLog');

function fakeRes() {
  return { redirected: null, cookies: [], rendered: null, redirect(url) { this.redirected = url; return this; }, cookie(...args) { this.cookies.push(args); return this; }, status(code) { this.statusCode = code; return this; }, render(view, data) { this.rendered = { view, data }; return this; } };
}
function stub(obj, name, fn) { const original = obj[name]; obj[name] = fn; return () => { obj[name] = original; }; }

test('respond stores only the chosen options, sets the answered cookie, and refuses repeats', async () => {
  const survey = new Survey({ title: 'T', status: 'published', epoch: 2, questions: svc.parseQuestions(goodForm) });
  const lean = survey.toObject();
  const [q1, q2] = survey.questions;
  const created = [];
  const restore = [
    stub(Survey, 'findOne', () => ({ lean: async () => lean })),
    stub(SurveyResponse, 'create', async (doc) => { created.push(doc); return doc; })
  ];
  try {
    const body = { answers: { [q1._id]: String(q1.options[0]._id), [q2._id]: String(q2.options[1]._id) } };
    const req = { params: { id: String(survey._id) }, body, headers: {}, session: {}, ip: '9.9.9.9', get: () => 'UA', session_user: null };
    const res = fakeRes();
    await controller.respond(req, res);
    assert.equal(res.redirected, `/surveys/${survey._id}?thanks=1`);
    assert.equal(created.length, 1);
    assert.deepEqual(Object.keys(created[0]).sort(), ['answers', 'epoch', 'survey'], 'nothing identifying is stored');
    assert.equal(created[0].epoch, 2);
    assert.equal(res.cookies[0][1], '2');

    // same browser again -> rejected, nothing stored
    const again = fakeRes();
    await controller.respond({ ...req, session: {}, headers: { cookie: `${res.cookies[0][0]}=${res.cookies[0][1]}` } }, again);
    assert.equal(created.length, 1);

    // missing answer -> rejected with a message
    const bad = { ...req, session: {}, body: { answers: { [q1._id]: String(q1.options[0]._id) } } };
    await controller.respond(bad, fakeRes());
    assert.equal(created.length, 1);
    assert.match(bad.session.flash.message, /answer question 2/);

    // closed survey -> rejected
    lean.status = 'closed';
    const closed = { ...req, session: {} };
    await controller.respond(closed, fakeRes());
    assert.equal(created.length, 1);
    assert.match(closed.session.flash.message, /closed/);
  } finally { restore.forEach((fn) => fn()); }
});

test('draft surveys are not public', async () => {
  const restore = stub(Survey, 'findOne', () => ({ lean: async () => null }));
  try {
    const res = fakeRes();
    await controller.show({ params: { id: String(oid()) }, query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 404);
  } finally { restore(); }
});

test('clear results bumps the epoch first, then deletes only older responses', async () => {
  const survey = new Survey({ title: 'T', epoch: 4, questions: svc.parseQuestions(goodForm) });
  const calls = [];
  const restore = [
    stub(Survey, 'findById', async () => survey),
    stub(Survey, 'findByIdAndUpdate', async (id, update, opts) => { calls.push(['bump', update, opts]); return { ...survey.toObject(), epoch: 5 }; }),
    stub(SurveyResponse, 'deleteMany', async (filter) => { calls.push(['delete', filter]); return { deletedCount: 7 }; }),
    stub(AuditLog, 'create', async (doc) => { calls.push(['audit', doc.action]); return doc; })
  ];
  try {
    const req = { params: { id: String(survey._id) }, session: {}, roleUser: { _id: oid() }, ip: '1.1.1.1', get: () => 'UA' };
    const res = fakeRes();
    await controller.clearResults(req, res);
    assert.deepEqual(calls.map((c) => c[0]), ['bump', 'delete', 'audit']);
    assert.deepEqual(calls[0][1], { $inc: { epoch: 1 } });
    assert.deepEqual(calls[1][1], { survey: survey._id, epoch: { $lt: 5 } });
    assert.equal(calls[2][1], 'clear-survey-results');
    assert.match(req.session.flash.message, /Cleared 7 responses/);
    assert.equal(res.redirected, '/admin#surveys');
  } finally { restore.forEach((fn) => fn()); }
});

test('JSON export is a downloadable attachment', async () => {
  const survey = new Survey({ title: 'My Survey!', epoch: 0, questions: svc.parseQuestions(goodForm) });
  const restore = [
    stub(Survey, 'findById', async () => survey),
    stub(SurveyResponse, 'aggregate', async () => []),
    stub(SurveyResponse, 'countDocuments', async () => 0)
  ];
  try {
    const headers = {};
    let sent;
    const res = { setHeader: (k, v) => { headers[k] = v; }, send: (body) => { sent = body; return res; }, redirect() {} };
    await controller.exportJson({ params: { id: String(survey._id) }, session: {} }, res);
    assert.match(headers['Content-Disposition'], /^attachment; filename="survey-my-survey-\d{4}-\d{2}-\d{2}\.json"$/);
    const parsed = JSON.parse(sent);
    assert.equal(parsed.survey.title, 'My Survey!');
    assert.equal(parsed.totalResponses, 0);
    assert.deepEqual(parsed.responses, []);
  } finally { restore.forEach((fn) => fn()); }
});
