const Survey = require('../models/Survey');
const SurveyResponse = require('../models/SurveyResponse');
const AuditLog = require('../models/AuditLog');
const svc = require('../services/surveys');

const backToSurveys = (res) => res.redirect('/admin#surveys');

function flash(req, type, message) {
  req.session.flash = { type, message };
}

const audit = (req, action, target, details = {}) => AuditLog.create({
  actor: req.roleUser._id, action, targetType: 'survey', target, details, ipAddress: req.ip, userAgent: req.get('user-agent')
});

async function loadSurvey(req, res) {
  if (!svc.isObjectId(req.params.id)) { backToSurveys(res); return null; }
  const survey = await Survey.findById(req.params.id);
  if (!survey) {
    flash(req, 'error', 'That survey no longer exists.');
    backToSurveys(res);
    return null;
  }
  return survey;
}

// ---------------------------------------------------------------- admin ----

exports.create = async (req, res) => {
  try {
    const details = svc.parseDetails(req.body);
    const questions = svc.parseQuestions(req.body.questions);
    const survey = await Survey.create({ ...details, questions, status: req.body.publish === 'on' ? 'published' : 'draft', createdBy: req.roleUser._id });
    await audit(req, 'create-survey', survey._id, { title: survey.title, questions: questions.length });
    flash(req, 'success', survey.status === 'published' ? 'Survey created and published.' : 'Survey saved as a draft. Publish it when you are ready.');
  } catch (error) {
    if (!(error instanceof svc.SurveyInputError) && error.name !== 'ValidationError') throw error;
    flash(req, 'error', error.message);
  }
  return backToSurveys(res);
};

exports.update = async (req, res) => {
  const survey = await loadSurvey(req, res);
  if (!survey) return undefined;
  try {
    const details = svc.parseDetails(req.body);
    survey.title = details.title;
    survey.description = details.description;
    // Questions can only change while nothing has been collected: editing them
    // afterwards would make the stored answers meaningless. Clear the results first.
    const responses = await svc.countResponses(survey);
    let questionsChanged = false;
    if (req.body.questions && !responses) {
      survey.questions = svc.parseQuestions(req.body.questions);
      questionsChanged = true;
    }
    await survey.save();
    await audit(req, 'update-survey', survey._id, { title: survey.title, questionsChanged });
    flash(req, 'success', 'Survey updated.');
  } catch (error) {
    if (!(error instanceof svc.SurveyInputError) && error.name !== 'ValidationError') throw error;
    flash(req, 'error', error.message);
  }
  return backToSurveys(res);
};

exports.setStatus = async (req, res) => {
  const survey = await loadSurvey(req, res);
  if (!survey) return undefined;
  const status = String(req.body.status || '');
  if (!['draft', 'published', 'closed'].includes(status)) {
    flash(req, 'error', 'Unknown survey status.');
    return backToSurveys(res);
  }
  survey.status = status;
  await survey.save();
  await audit(req, `survey-${status}`, survey._id, { title: survey.title });
  flash(req, 'success', { published: 'Survey is live.', closed: 'Survey closed - no new answers will be accepted.', draft: 'Survey moved back to draft and hidden from visitors.' }[status]);
  return backToSurveys(res);
};

exports.clearResults = async (req, res) => {
  const survey = await loadSurvey(req, res);
  if (!survey) return undefined;
  // Bump the epoch first: the old answers disappear from every view at once,
  // and anyone who answered before is allowed to answer again.
  const updated = await Survey.findByIdAndUpdate(survey._id, { $inc: { epoch: 1 } }, { new: true });
  const removed = await SurveyResponse.deleteMany({ survey: survey._id, epoch: { $lt: updated.epoch } });
  await audit(req, 'clear-survey-results', survey._id, { title: survey.title, removed: removed.deletedCount });
  flash(req, 'success', `Cleared ${removed.deletedCount.toLocaleString()} response${removed.deletedCount === 1 ? '' : 's'} from "${survey.title}".`);
  return backToSurveys(res);
};

exports.remove = async (req, res) => {
  const survey = await loadSurvey(req, res);
  if (!survey) return undefined;
  await SurveyResponse.deleteMany({ survey: survey._id });
  await Survey.deleteOne({ _id: survey._id });
  await audit(req, 'delete-survey', survey._id, { title: survey.title });
  flash(req, 'success', `Deleted "${survey.title}" and all of its responses.`);
  return backToSurveys(res);
};

exports.exportJson = async (req, res) => {
  const survey = await loadSurvey(req, res);
  if (!survey) return undefined;
  const results = await svc.buildResults(survey, { includeAllResponses: true });
  const slug = survey.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'survey';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="survey-${slug}-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.send(JSON.stringify(svc.exportPayload(survey, results), null, 2));
};

// --------------------------------------------------------------- public ----

exports.list = async (req, res) => {
  const surveys = await Survey.find({ status: { $in: ['published', 'closed'] } }).sort({ createdAt: -1 }).limit(50).select('title description status questions epoch').lean();
  res.render('pages/surveys', {
    title: 'Surveys',
    pagePath: '/surveys',
    description: 'Share your opinion in short anonymous Crowdwide surveys. No name, email or account details are collected.',
    surveys: surveys.map((survey) => ({ ...survey, answered: svc.hasAnswered(req, survey), questionCount: survey.questions.length }))
  });
};

async function findPublicSurvey(req) {
  if (!svc.isObjectId(req.params.id)) return null;
  const survey = await Survey.findOne({ _id: req.params.id, status: { $in: ['published', 'closed'] } }).lean();
  return survey || null;
}

exports.show = async (req, res) => {
  const survey = await findPublicSurvey(req);
  if (!survey) return res.status(404).render('pages/not-found', { title: 'Survey not found' });
  return res.render('pages/survey', {
    title: survey.title,
    pagePath: `/surveys/${survey._id}`,
    description: survey.description || 'A short anonymous survey on Crowdwide.',
    survey,
    answered: svc.hasAnswered(req, survey),
    justSubmitted: req.query.thanks === '1'
  });
};

exports.respond = async (req, res) => {
  const survey = await findPublicSurvey(req);
  if (!survey) return res.status(404).render('pages/not-found', { title: 'Survey not found' });
  const back = `/surveys/${survey._id}`;
  if (survey.status !== 'published') {
    req.session.flash = { type: 'error', message: 'This survey is closed and no longer takes answers.' };
    return res.redirect(back);
  }
  if (svc.hasAnswered(req, survey)) {
    req.session.flash = { type: 'info', message: 'You have already answered this survey. Thank you!' };
    return res.redirect(back);
  }
  let answers;
  try {
    answers = svc.parseAnswers(survey, req.body);
  } catch (error) {
    if (!(error instanceof svc.SurveyInputError)) throw error;
    req.session.flash = { type: 'error', message: error.message };
    return res.redirect(back);
  }
  // Only the chosen options are stored - nothing about who sent them.
  await SurveyResponse.create({ survey: survey._id, epoch: survey.epoch, answers });
  svc.markAnswered(res, survey);
  return res.redirect(`${back}?thanks=1`);
};
