const mongoose = require('mongoose');
const Survey = require('../models/Survey');
const SurveyResponse = require('../models/SurveyResponse');

const MAX_QUESTIONS = 30;
const MAX_OPTIONS = 10;
const MAX_TABLE_ROWS = 200; // anonymous-response rows shown in the admin table (the export has all of them)

class SurveyInputError extends Error {}

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || '')) && String(new mongoose.Types.ObjectId(String(value))) === String(value);

// qs turns `questions[0][text]` / `questions[1][options][]` into nested
// arrays or (past 20 items) objects keyed by index - accept both, in index order.
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
  return [];
}

// Turns the admin builder's form fields into clean question objects, or throws
// a SurveyInputError with a message that is safe to show to the admin.
function parseQuestions(rawQuestions) {
  const questions = toList(rawQuestions)
    .map((raw) => ({
      text: String(raw?.text || '').trim().slice(0, 300),
      options: toList(raw?.options).map((option) => String(option || '').trim().slice(0, 150)).filter(Boolean)
    }))
    // A completely empty question block is just an unused "add question" slot.
    .filter((question) => question.text || question.options.length);
  if (!questions.length) throw new SurveyInputError('Add at least one question.');
  if (questions.length > MAX_QUESTIONS) throw new SurveyInputError(`A survey can have at most ${MAX_QUESTIONS} questions.`);
  questions.forEach((question, index) => {
    if (!question.text) throw new SurveyInputError(`Question ${index + 1} needs its question text.`);
    if (question.options.length < 2) throw new SurveyInputError(`Question ${index + 1} needs at least 2 answer options.`);
    if (question.options.length > MAX_OPTIONS) throw new SurveyInputError(`Question ${index + 1} can have at most ${MAX_OPTIONS} options.`);
    const unique = new Set(question.options.map((option) => option.toLowerCase()));
    if (unique.size !== question.options.length) throw new SurveyInputError(`Question ${index + 1} has the same option twice.`);
  });
  return questions.map((question) => ({ text: question.text, options: question.options.map((text) => ({ text })) }));
}

function parseDetails(body = {}) {
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) throw new SurveyInputError('Give the survey a title.');
  return { title, description: String(body.description || '').trim().slice(0, 500) };
}

// Votes per option for the survey's *current* epoch.
async function tally(survey) {
  const rows = await SurveyResponse.aggregate([
    { $match: { survey: survey._id, epoch: survey.epoch } },
    { $unwind: '$answers' },
    { $group: { _id: { question: '$answers.question', option: '$answers.option' }, votes: { $sum: 1 } } }
  ]);
  const votes = new Map(rows.map((row) => [`${row._id.question}:${row._id.option}`, row.votes]));
  return votes;
}

function countResponses(survey) {
  return SurveyResponse.countDocuments({ survey: survey._id, epoch: survey.epoch });
}

// Everything the admin tab and the JSON export need for one survey.
async function buildResults(survey, { includeAllResponses = false } = {}) {
  const [totalResponses, votes] = await Promise.all([countResponses(survey), tally(survey)]);
  const questions = survey.questions.map((question) => {
    const options = question.options.map((option) => ({ id: String(option._id), text: option.text, votes: votes.get(`${question._id}:${option._id}`) || 0 }));
    const answered = options.reduce((sum, option) => sum + option.votes, 0);
    options.forEach((option) => { option.percent = answered ? Math.round((option.votes / answered) * 1000) / 10 : 0; });
    return { id: String(question._id), text: question.text, answered, options };
  });

  let responseRows = [];
  if (totalResponses) {
    const query = SurveyResponse.find({ survey: survey._id, epoch: survey.epoch }).sort({ _id: 1 }).select('answers').lean();
    if (!includeAllResponses) query.skip(Math.max(0, totalResponses - MAX_TABLE_ROWS));
    const offset = includeAllResponses ? 0 : Math.max(0, totalResponses - MAX_TABLE_ROWS);
    const responses = await query;
    const optionText = new Map(survey.questions.flatMap((question) => question.options.map((option) => [`${question._id}:${option._id}`, option.text])));
    responseRows = responses.map((response, index) => {
      const byQuestion = new Map((response.answers || []).map((answer) => [String(answer.question), String(answer.option)]));
      return {
        number: offset + index + 1,
        answers: survey.questions.map((question) => {
          const optionId = byQuestion.get(String(question._id));
          return optionId ? optionText.get(`${question._id}:${optionId}`) || null : null;
        })
      };
    });
  }
  return { totalResponses, questions, responseRows, rowsTruncated: !includeAllResponses && totalResponses > MAX_TABLE_ROWS };
}

async function adminSurveys() {
  const surveys = await Survey.find().sort({ createdAt: -1 }).limit(100);
  return Promise.all(surveys.map(async (survey) => ({
    _id: String(survey._id),
    title: survey.title,
    description: survey.description,
    status: survey.status,
    createdAt: survey.createdAt,
    questions: survey.questions.map((question) => ({ _id: String(question._id), text: question.text, options: question.options.map((option) => ({ _id: String(option._id), text: option.text })) })),
    results: await buildResults(survey)
  })));
}

function exportPayload(survey, results) {
  return {
    survey: { id: String(survey._id), title: survey.title, description: survey.description, status: survey.status },
    exportedAt: new Date().toISOString(),
    totalResponses: results.totalResponses,
    note: 'Responses are anonymous: no names, emails, accounts, IP addresses or timestamps are collected.',
    questions: results.questions.map((question) => ({
      id: question.id,
      text: question.text,
      answered: question.answered,
      options: question.options.map((option) => ({ id: option.id, text: option.text, votes: option.votes, percent: option.percent }))
    })),
    responses: results.responseRows.map((row) => ({
      response: row.number,
      answers: results.questions.map((question, index) => ({ question: question.text, answer: row.answers[index] }))
    }))
  };
}

// Validates a visitor's submission against the survey's own questions: exactly
// one valid option for every question. Returns [{ question, option }].
function parseAnswers(survey, body = {}) {
  const sent = body.answers && typeof body.answers === 'object' ? body.answers : {};
  return survey.questions.map((question, index) => {
    const optionId = String(sent[String(question._id)] || '');
    const option = question.options.find((candidate) => String(candidate._id) === optionId);
    if (!option) throw new SurveyInputError(`Please answer question ${index + 1}.`);
    return { question: question._id, option: option._id };
  });
}

// "Have I already answered?" without identifying anyone: a plain cookie holding
// the survey's epoch. It is not tied to an account and nothing about the
// visitor is written to the database. (A determined person can clear cookies
// and answer again - that is the trade-off of staying anonymous.)
const cookieName = (surveyId) => `cw_sv_${surveyId}`;

function readCookie(req, name) {
  const header = req.headers?.cookie || '';
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function hasAnswered(req, survey) {
  return readCookie(req, cookieName(survey._id)) === String(survey.epoch);
}

function markAnswered(res, survey) {
  res.cookie(cookieName(survey._id), String(survey.epoch), { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', path: '/' });
}

module.exports = { SurveyInputError, MAX_QUESTIONS, MAX_OPTIONS, MAX_TABLE_ROWS, isObjectId, parseQuestions, parseDetails, buildResults, adminSurveys, exportPayload, parseAnswers, hasAnswered, markAnswered, countResponses };
